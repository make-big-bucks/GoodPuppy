import type { EventSubscription } from "../../shared/eventSubscription.js";
import { createWindowReadiness } from "./windowReadiness.js";
import { createRemoteWindowQueue } from "./remoteWindowQueue.js";
// 房间协调者（运行在自己窗口 label "main"）。
//
// 独占 Supabase 订阅（presence / messages / interactions，由 roomManager 喂进来），
// 把每只在线远程成员映射成一个独立的 pet 窗口（label pet-<userId>）：
// presence 变化 → spawn / close 窗口；状态/消息/互动用 emit_to 定向转发给各窗口。
// 远程窗口是「哑呈现者」，不碰网络。见 docs/superpowers/specs/2026-06-17-多窗口独立桌宠-phaseB-design.md。
import { INTERACTIONS, durationFromManifest, loadPetManifest } from "./animationCatalog.js";
import { sendInteraction } from "./interactions.js";
import {
  orderRemotePetIds,
  getPetWindowSize,
  getBubbleWindowSize,
  computeBubbleWindowPosition,
  isWindowPositionVisible,
} from "./petLayout.js";
import { computeSemiFreeLayout } from "./petAutoLayout.js";
import { readRemotePos, writeRemotePos, clearRemotePos, readSelfPos, writeSelfPos } from "./petPositionStore.js";
import { readStoredMode, writeStoredMode, type PetMode } from "./preferences.js";
import {
  petWindowLabel,
  bubbleWindowLabel,
  BUBBLE_SELF_LABEL,
  COORDINATOR_LABEL,
  PET_STATE,
  PET_HISTORY,
  PET_MESSAGE,
  PET_INTERACTION,
  PET_LEAVE,
  PET_MODE,
  PET_ARRANGE,
  PET_MOVED,
  PET_INTERACT_REQUEST,
  PET_BUBBLE_SHOW_REQUEST,
  BUBBLE_PLACEMENT,
  type PetMovedPayload,
  type PetInteractRequestPayload,
  type BubblePlacementPayload,
} from "./petWindowEvents.js";
import type { PetPresenter } from "./petPresenter.js";
import type { InteractionPayload, LocalMessage, PresenceUser, WindowPoint } from "../../types";

const ROOM_CACHE_LIMIT = 200;
const LEAVE_FALLBACK_MS = 600;

type InteractionDef = { actorState: string; targetState: string; mirror?: string; holdMs?: number };

type RemoteEntry = {
  instanceId: string;
  roomId: string;
  signal: AbortSignal;
  cancelCreation: AbortController;
  ready: boolean;
  info: PresenceUser;
  pos: WindowPoint;
  leaving: boolean;
  removeTimer: ReturnType<typeof setTimeout> | null;
  leaveDurationMs: number;
};

export type RoomCoordinatorDeps = {
  selfPresenter: PetPresenter;
  getSelfAuthId: () => string | null;
  getCurrentRoomId: () => string | null;
  getScale: () => number;
};

export function createRoomCoordinator(deps: RoomCoordinatorDeps) {
  const remotes = new Map<string, RemoteEntry>();
  let roomMessageCache: LocalMessage[] = [];
  let mode: PetMode = readStoredMode();

  let disposed = false;
  const subscriptions: EventSubscription[] = [];
  const bridge = window.goodPuppy;
  function listen<T>(event: string, callback: (payload: T) => void) {
    const subscription = bridge.onAppEvent(event, callback);
    subscriptions.push(subscription);
    return subscription;
  }
  const controllerId = bridge.getWindowInstance();
  const lifecycle = createRemoteWindowQueue();
  let arrangementRevision = 0;
  let presenceRevision = 0;
  let desiredUsers = new Map<string, PresenceUser>();
  const readiness = createWindowReadiness({ controllerId,
    listen: (event, handler) => bridge.onAppEvent(event, handler),
    send: (label, event, payload) => bridge.emitToWindow(label, event, payload),
  });
  let sequence = 0;
  const deliveries = new Map<string, Promise<void>>();
  function deliver(label: string, instanceId: string, event: string, payload?: unknown) {
    const key = `${label}|${instanceId}`;
    const envelope = { instanceId, controllerId, sequence: ++sequence, payload };
    const result = (deliveries.get(key) ?? Promise.resolve()).catch(() => {}).then(() =>
      bridge.emitToWindow(label, event, envelope));
    deliveries.set(key, result);
    const clean = () => { if (deliveries.get(key) === result) deliveries.delete(key); };
    void result.then(clean, clean);
    return result;
  }

  function emitTo(userId: string, event: string, payload?: unknown) {
    const entry = remotes.get(userId);
    return entry && !entry.signal.aborted && entry.roomId === deps.getCurrentRoomId() ? deliver(petWindowLabel(userId), entry.instanceId, event, payload) : Promise.resolve();
  }

  /** 定向到某成员的气泡子窗口（label bubble-<userId>）。消息渲染住在气泡窗口里。 */
  function emitToBubble(userId: string, event: string, payload?: unknown) {
    const entry = remotes.get(userId);
    return entry && !entry.signal.aborted && entry.roomId === deps.getCurrentRoomId() ? deliver(bubbleWindowLabel(userId), entry.instanceId, event, payload) : Promise.resolve();
  }

  /** 定向到自己的气泡子窗口（bubble-self，整会话只隐藏不销毁）。 */
  function emitToSelfBubble(event: string, payload?: unknown) {
    return selfBubbleInstance ? deliver(BUBBLE_SELF_LABEL, selfBubbleInstance, event, payload) : Promise.resolve();
  }

  // ── Bubble placement（独立气泡窗口的上/下避让，纯函数驱动）─────────────────
  /** 按目标宠物中心选择屏幕，再用可用区计算气泡几何与朝向。 */
  async function computeBubble(petPos: WindowPoint, petSize: { width: number; height: number }): Promise<BubblePlacementPayload> {
    const work = await bridge.getMonitorWorkArea({ x: petPos.x + petSize.width / 2, y: petPos.y + petSize.height / 2 });
    const size = getBubbleWindowSize();
    const r = computeBubbleWindowPosition({
      pet: { x: petPos.x, y: petPos.y, width: petSize.width, height: petSize.height },
      bubble: size,
      workArea: work,
    });
    return { x: r.x, y: r.y, width: size.width, height: size.height, placement: r.placement };
  }

  /** 重新摆放某成员的气泡窗口（pet 移动/重排后）。气泡窗口收到后自行 setWindowBounds。 */
  async function placeRemoteBubble(userId: string, petPos: WindowPoint) {
    const entry = remotes.get(userId);
    if (!entry) return;
    const b = await computeBubble(petPos, getPetWindowSize());
    if (remotes.get(userId) !== entry || entry.signal.aborted) return;
    void emitToBubble(userId, BUBBLE_PLACEMENT, b);
  }

  /** 重新摆放自己的气泡窗口（self 移动/缩放后）。 */
  async function placeSelfBubble(petPos: WindowPoint) {
    const signal = lifecycle.signal;
    const b = await computeBubble(petPos, getPetWindowSize(deps.getScale()));
    if (signal.aborted) return;
    void emitToSelfBubble(BUBBLE_PLACEMENT, b);
  }

  /** 自己的气泡子窗口：main 的子窗口，整会话只隐藏不销毁（panel，承载记号棒）。
   * 首次进房间时按需创建一次；之后随 main 显隐跟随，位置由 OS 维护。 */
  let selfBubbleInstance: string | null = null;
  async function ensureSelfBubble() {
    if (!deps.getCurrentRoomId()) return;
    const signal = lifecycle.signal;
    await readiness.ready;
    selfBubbleInstance ??= await bridge.getManagedWindowInstance(BUBBLE_SELF_LABEL) ?? crypto.randomUUID();
    const base = readSelfPos() ?? (await selfBounds()).pos;
    const b = await computeBubble(base, getPetWindowSize(deps.getScale()));
    if (signal.aborted || !deps.getCurrentRoomId()) return;
    const instanceId = selfBubbleInstance;
    const cancel = new AbortController();
    const abort = () => cancel.abort();
    signal.addEventListener("abort", abort, { once: true });
    const ready = readiness.wait(BUBBLE_SELF_LABEL, instanceId, cancel.signal);
    void ready.catch(() => {});
    try {
      await bridge.spawnBubbleWindow({ instanceId, label: BUBBLE_SELF_LABEL, parentLabel: COORDINATOR_LABEL,
        isSelf: true, x: b.x, y: b.y, width: b.width, height: b.height });
      await readiness.ping(BUBBLE_SELF_LABEL, instanceId);
      await ready;
      if (signal.aborted) return;
      await emitToSelfBubble(BUBBLE_PLACEMENT, b);
      const selfId = deps.getSelfAuthId();
      await emitToSelfBubble(PET_HISTORY, { messages: roomMessageCache.filter((m) => m.from === selfId), scope: selfId ? messageScope(selfId) : null });
    } finally { signal.removeEventListener("abort", abort); cancel.abort(); }
  }

  /** self 窗口缩放后重排自己的气泡窗口（renderer 缩放路径调用）。 */
  async function refreshSelfBubble() {
    if (!selfBubbleInstance) return;
    await placeSelfBubble((await selfBounds()).pos);
  }

  /** 自己是否有消息（决定右键「查看对话」vs「写消息」；消息已搬到 bubble-self，
   * 用协调者缓存判断即可，避免跨窗口查询）。 */
  function selfHasMessages() {
    const selfId = deps.getSelfAuthId();
    return roomMessageCache.some((m) => m.from === selfId);
  }

  // ── Positioning ──────────────────────────────────────────────────────────
  async function selfBounds(): Promise<{ pos: WindowPoint; size: { width: number; height: number } }> {
    const [pos, size] = await Promise.all([bridge.getWindowPosition(), bridge.getWindowSize()]);
    return { pos, size };
  }

  /** 计算每只在线远程 pet 的目标窗口左上角。
   * - 半自由：一律自动一字排开。
   * - 完全自由：有存档用存档，否则退化到自动排布的槽位。 */
  async function desiredLayout(roomId: string, orderedIds: string[]): Promise<Map<string, WindowPoint>> {
    const { pos, size } = await selfBounds();
    const petSize = getPetWindowSize();
    const auto = computeSemiFreeLayout({
      selfPos: pos,
      selfSize: size,
      remoteIds: orderedIds,
      petWindowWidth: petSize.width,
      petWindowHeight: petSize.height,
    });
    if (mode === "semi") return auto;
    // 完全自由：用存档位置，但存档必须仍落在某块已连接屏幕的可见区内——外接屏
    // 断开后旧坐标会整窗落在屏外，pet 看不见。越界则清掉坏存档、退回自动槽位。
    const monitors = await bridge.getMonitors();
    const result = new Map<string, WindowPoint>();
    for (const userId of orderedIds) {
      const stored = readRemotePos(roomId, userId);
      if (stored && isWindowPositionVisible(stored, petSize, monitors)) {
        result.set(userId, stored);
      } else {
        if (stored) clearRemotePos(roomId, userId);
        result.set(userId, auto.get(userId) ?? pos);
      }
    }
    return result;
  }

  async function stableLayout(roomId: string, ids: () => string[], signal: AbortSignal) {
    while (!signal.aborted && roomId === deps.getCurrentRoomId()) {
      const version = arrangementRevision;
      const orderedIds = ids();
      const layout = await desiredLayout(roomId, orderedIds);
      if (version === arrangementRevision) return { orderedIds, layout };
    }
    return null;
  }

  function isDraggableForRemote() {
    return mode === "free";
  }

  // ── Presence diff → spawn / close ─────────────────────────────────────────
  async function closeEntry(userId: string, entry: RemoteEntry) {
    if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
    // 子窗先销毁，完成回执后才移除父窗并允许同名重建。
    const failures: unknown[] = [];
    await bridge.closeBubbleWindow(bubbleWindowLabel(userId), entry.instanceId).catch((error) => failures.push(error));
    await bridge.closePetWindow(petWindowLabel(userId), entry.instanceId).catch((error) => failures.push(error));
    if (failures.length) throw new AggregateError(failures, "远程窗口清理失败");
    if (remotes.get(userId) === entry) remotes.delete(userId);
  }

  async function applyPresence(signal: AbortSignal, roomId: string) {
    if (signal.aborted || roomId !== deps.getCurrentRoomId()) return;
    for (const [userId, entry] of remotes) {
      if (desiredUsers.has(userId) || entry.leaving) continue;
      entry.leaving = true;
      void emitTo(userId, PET_LEAVE, {});
      entry.removeTimer = setTimeout(() => {
        void lifecycle.run(async () => {
          if (remotes.get(userId) === entry && !desiredUsers.has(userId)) await closeEntry(userId, entry);
        }).catch(console.error);
      }, entry.leaveDurationMs || LEAVE_FALLBACK_MS);
    }
    const result = await stableLayout(roomId, () => orderRemotePetIds([...desiredUsers.keys()]), signal);
    if (!result || signal.aborted || roomId !== deps.getCurrentRoomId()) return;
    const { orderedIds: ids, layout } = result;
    for (const userId of ids) {
      const info = desiredUsers.get(userId);
      if (!info || signal.aborted) continue;
      const pos = layout.get(userId) ?? (await selfBounds()).pos;
      if (signal.aborted || !desiredUsers.has(userId)) continue;
      let created = false;
      let entry = remotes.get(userId);
      if (entry && (entry.signal !== signal || !entry.ready)) { await closeEntry(userId, entry); entry = undefined; }
      if (!entry) {
        await readiness.ready;
        const oldPet = await bridge.getManagedWindowInstance(petWindowLabel(userId));
        const oldBubble = await bridge.getManagedWindowInstance(bubbleWindowLabel(userId));
        if (oldBubble) await bridge.closeBubbleWindow(bubbleWindowLabel(userId), oldBubble);
        if (oldPet) await bridge.closePetWindow(petWindowLabel(userId), oldPet);
        if (signal.aborted || !desiredUsers.has(userId)) continue;
        created = true;
        entry = { instanceId: crypto.randomUUID(), roomId, signal, cancelCreation: new AbortController(), ready: false, info, pos, leaving: false,
          removeTimer: null, leaveDurationMs: LEAVE_FALLBACK_MS };
        remotes.set(userId, entry);
        if (signal.aborted) { await closeEntry(userId, entry); continue; }
        const cancel = entry.cancelCreation;
        const abort = () => cancel.abort();
        signal.addEventListener("abort", abort, { once: true });
        const readyPet = readiness.wait(petWindowLabel(userId), entry.instanceId, cancel.signal);
        const readyBubble = readiness.wait(bubbleWindowLabel(userId), entry.instanceId, cancel.signal);
        void readyPet.catch(() => {}); void readyBubble.catch(() => {});
        try {
          const petSize = getPetWindowSize();
          await bridge.spawnPetWindow({ instanceId: entry.instanceId, label: petWindowLabel(userId), ...pos, ...petSize });
          if (signal.aborted || !desiredUsers.has(userId)) { await closeEntry(userId, entry); continue; }
          const b = await computeBubble(pos, petSize);
          if (signal.aborted || !desiredUsers.has(userId)) { await closeEntry(userId, entry); continue; }
          await bridge.spawnBubbleWindow({ instanceId: entry.instanceId, label: bubbleWindowLabel(userId),
            parentLabel: petWindowLabel(userId), isSelf: false, x: b.x, y: b.y, width: b.width, height: b.height });
          await Promise.all([readiness.ping(petWindowLabel(userId), entry.instanceId), readiness.ping(bubbleWindowLabel(userId), entry.instanceId)]);
          await Promise.all([readyPet, readyBubble]);
          if (signal.aborted || !desiredUsers.has(userId)) { await closeEntry(userId, entry); continue; }
          entry.ready = true;
          void resolveLeaveDuration(userId, info.petId, entry);
        } catch (error) {
          await closeEntry(userId, entry).catch(console.error);
          throw error;
        } finally { signal.removeEventListener("abort", abort); cancel.abort(); }
      }
      const latest = desiredUsers.get(userId);
      if (!latest || signal.aborted) continue;
      if (entry.removeTimer != null) { clearTimeout(entry.removeTimer); entry.removeTimer = null; }
      const returning = entry.leaving;
      const changed = entry.info.petId !== latest.petId || entry.info.skin !== latest.skin || entry.info.status !== latest.status;
      entry.leaving = false;
      entry.info = latest;
      if (mode === "semi") entry.pos = pos;
      if (created) await pushStateAndHistory(userId, entry);
      else {
        if (changed) await emitTo(userId, PET_STATE, { petId: latest.petId, skin: latest.skin, status: latest.status });
        if (returning) await emitTo(userId, PET_INTERACTION, { state: "enter", mirrored: false });
        if (mode === "semi") { await emitTo(userId, PET_ARRANGE, entry.pos); await placeRemoteBubble(userId, entry.pos); }
      }
    }
  }

  async function pushStateAndHistory(userId: string, entry: RemoteEntry) {
    if (!entry.ready || remotes.get(userId) !== entry) return;
    const info = entry.info;
    await emitTo(userId, PET_STATE, { petId: info.petId, skin: info.skin, status: info.status });
    await emitTo(userId, PET_MODE, { draggable: isDraggableForRemote() });
    await emitTo(userId, PET_ARRANGE, entry.pos);
    await emitToBubble(userId, PET_HISTORY, { messages: roomMessageCache.filter((m) => m.from === userId), scope: messageScope(userId) });
    await placeRemoteBubble(userId, entry.pos);
  }

  async function resolveLeaveDuration(userId: string, petId: string, expected: RemoteEntry) {
    try {
      const manifest = await loadPetManifest(petId);
      const ms = durationFromManifest(manifest?.states?.["leave"]);
      const entry = remotes.get(userId);
      if (entry === expected) entry.leaveDurationMs = ms || LEAVE_FALLBACK_MS;
    } catch {
      // 用兜底时长即可。
    }
  }

  function messageScope(senderId: string) {
    const viewerId = deps.getSelfAuthId(); const roomId = deps.getCurrentRoomId();
    return viewerId && roomId ? { viewerId, roomId, senderId } : null;
  }

  // ── Messages ──────────────────────────────────────────────────────────────
  function cacheMessage(msg: LocalMessage) {
    if (roomMessageCache.some((m) => m.id === msg.id)) return;
    roomMessageCache.push(msg);
    if (roomMessageCache.length > ROOM_CACHE_LIMIT) {
      roomMessageCache = roomMessageCache.slice(roomMessageCache.length - ROOM_CACHE_LIMIT);
    }
  }

  function routeMessage(msg: LocalMessage) {
    cacheMessage(msg);
    if (msg.from === deps.getSelfAuthId()) {
      // 自己消息渲染在自己的气泡窗口 bubble-self（记号棒亦在那里）。
      void emitToSelfBubble(PET_MESSAGE, { message: msg, scope: messageScope(msg.from) });
    } else if (remotes.has(msg.from)) {
      // 远程消息渲染在气泡窗口，pet 窗口仅弹跳一下（复用互动动画通道）。
      void emitToBubble(msg.from, PET_MESSAGE, { message: msg, scope: messageScope(msg.from) });
      void emitTo(msg.from, PET_INTERACTION, { state: "message", mirrored: false });
    }
  }

  function loadRoomMessages(messages: LocalMessage[]) {
    roomMessageCache = messages.slice(-ROOM_CACHE_LIMIT);
    const selfId = deps.getSelfAuthId();
    const bySender = new Map<string, LocalMessage[]>();
    for (const m of messages) {
      const list = bySender.get(m.from) ?? [];
      list.push(m);
      bySender.set(m.from, list);
    }
    // 没有自己消息时也要清空 bubble-self（切房间残留）。
    void emitToSelfBubble(PET_HISTORY, { messages: bySender.get(selfId ?? "") ?? [], scope: selfId ? messageScope(selfId) : null });
    for (const [sender, list] of bySender) {
      if (sender === selfId) continue;
      if (remotes.has(sender)) void emitToBubble(sender, PET_HISTORY, { messages: list, scope: messageScope(sender) });
    }
  }

  // ── Interactions ────────────────────────────────────────────────────────
  async function xForUser(userId: string): Promise<number> {
    if (userId === deps.getSelfAuthId()) return (await bridge.getWindowPosition()).x;
    return remotes.get(userId)?.pos.x ?? 0;
  }

  async function playRole(def: InteractionDef, state: string, userId: string, partnerId: string) {
    if (!state) return;
    const signal = lifecycle.signal;
    let mirrored = false;
    if (def.mirror === "facing") {
      const [own, partner] = await Promise.all([xForUser(userId), xForUser(partnerId)]);
      mirrored = partner < own;
    }
    if (signal.aborted) return;
    if (userId === deps.getSelfAuthId()) {
      deps.selfPresenter.animator.playTransient(state, { durationMs: def.holdMs, mirrored });
    } else if (remotes.has(userId)) {
      void emitTo(userId, PET_INTERACTION, { state, mirrored, durationMs: def.holdMs });
    }
  }

  function applyInteraction({ action, actorId, targetId }: InteractionPayload) {
    const def = (INTERACTIONS as Record<string, InteractionDef>)[action];
    if (!def) return;
    void playRole(def, def.actorState, actorId, targetId).catch(console.error);
    void playRole(def, def.targetState, targetId, actorId).catch(console.error);
  }

  /** 由远程窗口的右键「戳」或自己菜单触发：协调者补全 actor=自己，统一经 Supabase 广播 + 本地立即播放。 */
  function triggerInteraction(action: string, targetId: string) {
    const selfId = deps.getSelfAuthId();
    if (!Object.prototype.hasOwnProperty.call(INTERACTIONS, action) || !selfId || !desiredUsers.has(targetId)) return;
    const payload: InteractionPayload = { action, actorId: selfId, targetId };
    // 服务端广播包含真实 actorId，自己与远程成员共用这一条播放路径。
    void sendInteraction(payload).catch(console.error);
  }

  // ── Mode switching ────────────────────────────────────────────────────────
  async function relayoutAll(signal: AbortSignal) {
    const roomId = deps.getCurrentRoomId();
    if (!roomId || signal.aborted) return;
    const result = await stableLayout(roomId,
      () => orderRemotePetIds([...remotes.keys()].filter((id) => !remotes.get(id)?.leaving)), signal);
    if (!result || signal.aborted) return;
    for (const userId of result.orderedIds) {
      const pos = result.layout.get(userId);
      const entry = remotes.get(userId);
      if (!pos || !entry || entry.signal.aborted) continue;
      entry.pos = pos;
      await emitTo(userId, PET_ARRANGE, pos);
      await emitTo(userId, PET_MODE, { draggable: isDraggableForRemote() });
      await placeRemoteBubble(userId, pos);
    }
  }
  function requestArrangement() {
    const version = ++arrangementRevision;
    const signal = lifecycle.signal;
    void lifecycle.run(async () => { if (version === arrangementRevision) await relayoutAll(signal); }).catch(console.error);
  }

  function setMode(next: PetMode) {
    if (next === mode) return;
    mode = next;
    writeStoredMode(mode);
    requestArrangement();
  }

  function clearRemotes() {
    lifecycle.invalidate();
    desiredUsers.clear();
    const oldEntries = [...remotes.entries()];
    for (const [, entry] of oldEntries) if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
    void lifecycle.run(async () => {
      const results = await Promise.allSettled(oldEntries.filter(([id, entry]) => remotes.get(id) === entry).map(([id, entry]) => closeEntry(id, entry)));
      for (const result of results) if (result.status === "rejected") console.error(result.reason);
    }).catch(console.error);
    roomMessageCache = [];
    void emitToSelfBubble(PET_HISTORY, { messages: [], scope: null });
  }

  // ── Inbound events from presenters ────────────────────────────────────────
  listen<PetMovedPayload>(PET_MOVED, (payload) => {
    if (!payload || typeof payload.userId !== "string") return;
    const roomId = deps.getCurrentRoomId();
    const entry = remotes.get(payload.userId);
    if (!entry || entry.signal.aborted || entry.instanceId !== payload.instanceId || !Number.isFinite(payload.x) || !Number.isFinite(payload.y)) return;
    if (entry) entry.pos = { x: payload.x, y: payload.y };
    if (roomId && mode === "free") writeRemotePos(roomId, payload.userId, { x: payload.x, y: payload.y });
    // 拖动跨阈值可能让气泡需上↔下翻面；macOS 子窗口已跟手平移，这里只在翻面时纠正。
    void placeRemoteBubble(payload.userId, { x: payload.x, y: payload.y });
  });

  listen<PetInteractRequestPayload>(PET_INTERACT_REQUEST, (payload) => {
    if (!payload || typeof payload.targetId !== "string" || typeof payload.action !== "string") return;
    const entry = remotes.get(payload.targetId);
    if (entry && !entry.signal.aborted && entry.instanceId === payload.instanceId) triggerInteraction(payload.action, payload.targetId);
  });

  listen<{ userId: string; instanceId: string }>(PET_BUBBLE_SHOW_REQUEST, (payload) => {
    const entry = remotes.get(payload?.userId);
    if (entry && !entry.signal.aborted && entry.instanceId === payload.instanceId) void emitToBubble(payload.userId, "bubble-show");
  });

  // Self window position memory (global). Moving self in semi-free mode also
  // re-arranges the remote row (it's anchored beside the self window).
  const storedSelf = readSelfPos();
  function handleSelfMoved(pos: WindowPoint) {
    writeSelfPos(pos);
    void placeSelfBubble(pos);
    if (mode === "semi") requestArrangement();
  }

  /** Scale / other changes that move the self window's footprint: keep the row aligned. */
  function refreshArrangement() {
    if (mode === "semi") requestArrangement();
  }

  return {
    onPresenceChange: (users: PresenceUser[]) => {
      if (disposed) return;
      const version = ++presenceRevision;
      arrangementRevision += 1;
      desiredUsers = new Map(users.map((user) => [user.userId, user]));
      for (const [id, entry] of remotes) if (!entry.ready && !desiredUsers.has(id)) entry.cancelCreation.abort();
      const roomId = deps.getCurrentRoomId();
      const signal = lifecycle.signal;
      if (roomId) void lifecycle.run(async () => { if (version === presenceRevision) await applyPresence(signal, roomId); }).catch((error) => { if (!(error instanceof DOMException && error.name === "AbortError")) console.error(error); });
    },
    whenIdle: () => lifecycle.idle(),
    dispose: () => { disposed = true; subscriptions.forEach((subscription) => subscription()); clearRemotes(); readiness.dispose(); },
    onInteraction: applyInteraction,
    onMessagesLoaded: loadRoomMessages,
    onNewMessage: routeMessage,
    onClearRemotePets: clearRemotes,
    triggerInteraction,
    setMode,
    getMode: () => mode,
    handleSelfMoved,
    refreshArrangement,
    ensureSelfBubble,
    refreshSelfBubble,
    openSelfCompose: () => deps.getCurrentRoomId() ? emitToSelfBubble("self-open-compose", { roomId: deps.getCurrentRoomId() }) : Promise.resolve(),
    selfHasMessages,
    storedSelfPos: storedSelf,
  };
}
