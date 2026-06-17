// 房间协调者（运行在自己窗口 label "main"）。
//
// 独占 Supabase 订阅（presence / messages / interactions，由 roomManager 喂进来），
// 把每只在线远程成员映射成一个独立的 pet 窗口（label pet-<userId>）：
// presence 变化 → spawn / close 窗口；状态/消息/互动用 emit_to 定向转发给各窗口。
// 远程窗口是「哑呈现者」，不碰网络。见 docs/superpowers/specs/2026-06-17-多窗口独立桌宠-phaseB-design.md。
import { INTERACTIONS, durationFromManifest, loadPetManifest } from "./animationCatalog.js";
import { sendInteraction } from "./interactions.js";
import { orderRemotePetIds, getPetWindowSize } from "./petLayout.js";
import { computeSemiFreeLayout } from "./petAutoLayout.js";
import { readRemotePos, writeRemotePos, readSelfPos, writeSelfPos } from "./petPositionStore.js";
import { readStoredMode, writeStoredMode, type PetMode } from "./preferences.js";
import {
  petWindowLabel,
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
  type PetMovedPayload,
  type PetInteractRequestPayload,
} from "./petWindowEvents.js";
import type { PetPresenter } from "./petPresenter.js";
import type { InteractionPayload, LocalMessage, PresenceUser, WindowPoint } from "../../types";

const ROOM_CACHE_LIMIT = 200;
const LEAVE_FALLBACK_MS = 600;

type InteractionDef = { actorState: string; targetState: string; mirror?: string; holdMs?: number };

type RemoteEntry = {
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

  const bridge = window.goodPuppy;

  function emitTo(userId: string, event: string, payload?: unknown) {
    return bridge.emitToWindow(petWindowLabel(userId), event, payload);
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
    const result = new Map<string, WindowPoint>();
    for (const userId of orderedIds) {
      result.set(userId, readRemotePos(roomId, userId) ?? auto.get(userId) ?? pos);
    }
    return result;
  }

  function isDraggableForRemote() {
    return mode === "free";
  }

  // ── Presence diff → spawn / close ─────────────────────────────────────────
  async function applyPresence(users: PresenceUser[]) {
    const roomId = deps.getCurrentRoomId();
    if (!roomId) return;
    const byId = new Map(users.map((u) => [u.userId, u]));
    const onlineSet = new Set(byId.keys());

    // Leavers: play leave in-window, then close after the leave animation.
    for (const [userId, entry] of remotes) {
      if (onlineSet.has(userId) || entry.leaving) continue;
      entry.leaving = true;
      void emitTo(userId, PET_LEAVE, {});
      entry.removeTimer = setTimeout(() => {
        void bridge.closePetWindow(petWindowLabel(userId));
        remotes.delete(userId);
      }, entry.leaveDurationMs || LEAVE_FALLBACK_MS);
    }

    const orderedIds = orderRemotePetIds([...onlineSet]);
    const layout = await desiredLayout(roomId, orderedIds);

    for (const userId of orderedIds) {
      const info = byId.get(userId);
      if (!info) continue;
      const pos = layout.get(userId) ?? (await selfBounds()).pos;
      let entry = remotes.get(userId);

      if (!entry) {
        const petSize = getPetWindowSize();
        entry = { info, pos, leaving: false, removeTimer: null, leaveDurationMs: LEAVE_FALLBACK_MS };
        remotes.set(userId, entry);
        await bridge.spawnPetWindow({
          label: petWindowLabel(userId),
          x: pos.x,
          y: pos.y,
          width: petSize.width,
          height: petSize.height,
        });
        void resolveLeaveDuration(userId, info.petId);
        // Forward identity/state + history once the window has booted its listeners.
        void pushStateAndHistory(userId, info);
      } else {
        if (entry.leaving) {
          entry.leaving = false;
          if (entry.removeTimer != null) {
            clearTimeout(entry.removeTimer);
            entry.removeTimer = null;
          }
        }
        entry.info = info;
        void emitTo(userId, PET_STATE, { petId: info.petId, skin: info.skin, status: info.status });
        // Re-arrange existing windows in semi-free mode (and keep free-mode stored spots).
        if (mode === "semi" && (entry.pos.x !== pos.x || entry.pos.y !== pos.y)) {
          entry.pos = pos;
          void emitTo(userId, PET_ARRANGE, pos);
        }
      }
    }
  }

  /** New window may not have its listeners ready instantly; retry the initial
   * state + history a few times so the first frame and backlog aren't dropped. */
  async function pushStateAndHistory(userId: string, info: PresenceUser) {
    const history = roomMessageCache.filter((m) => m.from === userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      await emitTo(userId, PET_STATE, { petId: info.petId, skin: info.skin, status: info.status });
      await emitTo(userId, PET_MODE, { draggable: isDraggableForRemote() });
      if (history.length) await emitTo(userId, PET_HISTORY, { messages: history });
      await new Promise((r) => setTimeout(r, 120));
      if (!remotes.has(userId)) return;
    }
  }

  async function resolveLeaveDuration(userId: string, petId: string) {
    try {
      const manifest = await loadPetManifest(petId);
      const ms = durationFromManifest(manifest?.states?.["leave"]);
      const entry = remotes.get(userId);
      if (entry) entry.leaveDurationMs = ms || LEAVE_FALLBACK_MS;
    } catch {
      // 用兜底时长即可。
    }
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
      deps.selfPresenter.addMessage(msg);
    } else if (remotes.has(msg.from)) {
      void emitTo(msg.from, PET_MESSAGE, { message: msg });
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
    for (const [sender, list] of bySender) {
      if (sender === selfId) deps.selfPresenter.setMessages(list);
      else if (remotes.has(sender)) void emitTo(sender, PET_HISTORY, { messages: list });
    }
  }

  // ── Interactions ────────────────────────────────────────────────────────
  async function xForUser(userId: string): Promise<number> {
    if (userId === deps.getSelfAuthId()) return (await bridge.getWindowPosition()).x;
    return remotes.get(userId)?.pos.x ?? 0;
  }

  async function playRole(def: InteractionDef, state: string, userId: string, partnerId: string) {
    if (!state) return;
    let mirrored = false;
    if (def.mirror === "facing") {
      const [own, partner] = await Promise.all([xForUser(userId), xForUser(partnerId)]);
      mirrored = partner < own;
    }
    if (userId === deps.getSelfAuthId()) {
      deps.selfPresenter.animator.playTransient(state, { durationMs: def.holdMs, mirrored });
    } else if (remotes.has(userId)) {
      void emitTo(userId, PET_INTERACTION, { state, mirrored, durationMs: def.holdMs });
    }
  }

  function applyInteraction({ action, actorId, targetId }: InteractionPayload) {
    const def = (INTERACTIONS as Record<string, InteractionDef>)[action];
    if (!def) return;
    void playRole(def, def.actorState, actorId, targetId);
    void playRole(def, def.targetState, targetId, actorId);
  }

  /** 由远程窗口的右键「戳」或自己菜单触发：协调者补全 actor=自己，统一经 Supabase 广播 + 本地立即播放。 */
  function triggerInteraction(action: string, targetId: string) {
    const selfId = deps.getSelfAuthId();
    if (!(action in INTERACTIONS) || !selfId) return;
    const payload: InteractionPayload = { action, actorId: selfId, targetId };
    sendInteraction(payload);
    applyInteraction(payload);
  }

  // ── Mode switching ────────────────────────────────────────────────────────
  async function relayoutAll() {
    const roomId = deps.getCurrentRoomId();
    if (!roomId) return;
    const orderedIds = orderRemotePetIds([...remotes.keys()].filter((id) => !remotes.get(id)?.leaving));
    const layout = await desiredLayout(roomId, orderedIds);
    for (const userId of orderedIds) {
      const pos = layout.get(userId);
      const entry = remotes.get(userId);
      if (!pos || !entry) continue;
      entry.pos = pos;
      void emitTo(userId, PET_ARRANGE, pos);
      void emitTo(userId, PET_MODE, { draggable: isDraggableForRemote() });
    }
  }

  function setMode(next: PetMode) {
    if (next === mode) return;
    mode = next;
    writeStoredMode(mode);
    void relayoutAll();
  }

  function clearRemotes() {
    for (const [userId, entry] of remotes) {
      if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
      void bridge.closePetWindow(petWindowLabel(userId));
    }
    remotes.clear();
    roomMessageCache = [];
  }

  // ── Inbound events from presenters ────────────────────────────────────────
  bridge.onAppEvent<PetMovedPayload>(PET_MOVED, (payload) => {
    const roomId = deps.getCurrentRoomId();
    const entry = remotes.get(payload.userId);
    if (entry) entry.pos = { x: payload.x, y: payload.y };
    if (roomId && mode === "free") writeRemotePos(roomId, payload.userId, { x: payload.x, y: payload.y });
  });

  bridge.onAppEvent<PetInteractRequestPayload>(PET_INTERACT_REQUEST, (payload) => {
    triggerInteraction(payload.action, payload.targetId);
  });

  // Self window position memory (global). Moving self in semi-free mode also
  // re-arranges the remote row (it's anchored beside the self window).
  const storedSelf = readSelfPos();
  function handleSelfMoved(pos: WindowPoint) {
    writeSelfPos(pos);
    if (mode === "semi") void relayoutAll();
  }

  /** Scale / other changes that move the self window's footprint: keep the row aligned. */
  function refreshArrangement() {
    if (mode === "semi") void relayoutAll();
  }

  return {
    onPresenceChange: (users: PresenceUser[]) => void applyPresence(users),
    onInteraction: applyInteraction,
    onMessagesLoaded: loadRoomMessages,
    onNewMessage: routeMessage,
    onClearRemotePets: clearRemotes,
    triggerInteraction,
    setMode,
    getMode: () => mode,
    handleSelfMoved,
    refreshArrangement,
    storedSelfPos: storedSelf,
  };
}
