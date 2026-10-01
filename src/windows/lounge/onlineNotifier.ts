// 房间上线提醒的有副作用编排层（运行在常驻 Lounge webview）：订阅开关持久化、
// 复用 DB presence 订阅做上线检测、按槽位 spawn/回收 toast 窗口。纯逻辑见
// `onlineNotifierCore.ts`（单测覆盖）。见
// `docs/superpowers/specs/2026-06-23-room-online-notification-design.md`。

import type { LoungePresenceRow, LoungeRoom, OnlineNotifyPayload } from "../../types";
import { getDisplayName } from "./loungeViewModels.js";
import {
  computeToastPosition,
  decideOnlineNotification,
  isWithinDedupeWindow,
  nextPresenceRoom,
  readSubscribedRooms,
  writeSubscribedRooms,
  type PresenceRowLike,
} from "./onlineNotifierCore.js";

const MAX_VISIBLE = 3;
const TOAST_W = 340;
const TOAST_H = 104;
const AUTO_DISMISS_MS = 8000;
const DEDUPE_MS = 10_000;

interface OnlineNotifierDeps {
  getSelfId: () => string | null;
  getRooms: () => LoungeRoom[];
  getActiveRoomId: () => string | null;
}

let deps: OnlineNotifierDeps | null = null;
let subscribed = new Set<string>();
const snapshot = new Map<string, string | null>(); // userId -> roomId|null
const lastNotifiedAt = new Map<string, number>(); // `${roomId}|${userId}` -> ts
const slots: (string | null)[] = new Array(MAX_VISIBLE).fill(null); // slot -> toast label
const pendingByLabel = new Map<string, OnlineNotifyPayload>(); // awaiting toast-ready
const queue: OnlineNotifyPayload[] = [];
let seq = 0;
let listenersBound = false;

function platform(): "macos" | "windows" {
  return navigator.platform.startsWith("Win") ? "windows" : "macos";
}

function dedupeKey(roomId: string, userId: string) {
  return `${roomId}|${userId}`;
}

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function isRoomSubscribed(roomId: string): boolean {
  return subscribed.has(roomId);
}

export function setRoomSubscribed(roomId: string, on: boolean): void {
  if (on) subscribed.add(roomId);
  else subscribed.delete(roomId);
  const selfId = deps?.getSelfId() ?? null;
  const store = storage();
  if (selfId && store) writeSubscribedRooms(store, selfId, subscribed);
}

/** 用 Lounge 已拉取的 presence 行重置快照基线（避免把已在线的人当作刚上线）。 */
export function seedSnapshot(rows: LoungePresenceRow[]): void {
  snapshot.clear();
  for (const row of rows) {
    snapshot.set(row.user_id, nextPresenceRoom(row as PresenceRowLike));
  }
}

/** 房间列表变化后，清除已不属于自己的房间的订阅开关。 */
export function syncRooms(): void {
  const ids = new Set((deps?.getRooms() ?? []).map((r) => r.id));
  let changed = false;
  for (const id of [...subscribed]) {
    if (!ids.has(id)) {
      subscribed.delete(id);
      changed = true;
    }
  }
  const selfId = deps?.getSelfId() ?? null;
  const store = storage();
  if (changed && selfId && store) writeSubscribedRooms(store, selfId, subscribed);
}

/** DB presence 行变更入口（由 Lounge 的 postgres_changes 回调转发）。 */
export function onPresenceChange(row: LoungePresenceRow): void {
  if (!deps || !row?.user_id) return;
  const selfId = deps.getSelfId();
  if (!selfId) return;

  const decision = decideOnlineNotification({
    prevRoom: snapshot.get(row.user_id),
    row: row as PresenceRowLike,
    selfId,
    activeRoomId: deps.getActiveRoomId(),
    isSubscribed: (roomId) => subscribed.has(roomId),
    isDeduped: (roomId, userId) =>
      isWithinDedupeWindow(lastNotifiedAt.get(dedupeKey(roomId, userId)), Date.now(), DEDUPE_MS),
  });

  console.warn(
    "[online-notify] presence",
    row.user_id,
    "→ room",
    decision.roomId,
    "notify?",
    decision.shouldNotify,
  );
  snapshot.set(row.user_id, decision.roomId);

  if (!decision.shouldNotify || !decision.roomId) return;
  const payload = buildPayload(decision.roomId, row.user_id);
  if (!payload) return;
  lastNotifiedAt.set(dedupeKey(decision.roomId, row.user_id), Date.now());
  showOrQueue(payload);
}

function buildPayload(roomId: string, userId: string): OnlineNotifyPayload | null {
  const room = (deps?.getRooms() ?? []).find((r) => r.id === roomId);
  if (!room) return null;
  const member = room.members.find((m) => m.userId === userId);
  return {
    roomId,
    roomName: room.room_name || "未命名房间",
    userId,
    displayName: member?.displayName || getDisplayName({}),
    petId: member?.petId || "default",
    skin: member?.skin || "default",
    autoDismissMs: AUTO_DISMISS_MS,
  };
}

function showOrQueue(payload: OnlineNotifyPayload): void {
  const slot = slots.indexOf(null);
  if (slot === -1) {
    queue.push(payload);
    return;
  }
  void allocate(slot, payload);
}

async function allocate(slot: number, payload: OnlineNotifyPayload): Promise<void> {
  const label = `toast-${seq++}`;
  console.warn("[online-notify] spawn", label, "slot", slot, "room", payload.roomId);
  slots[slot] = label;
  pendingByLabel.set(label, payload);

  try {
    const workArea = await window.goodPuppy.getCursorMonitorWorkArea();
    if (slots[slot] !== label || !pendingByLabel.has(label)) return;
    const pos = computeToastPosition({
      workArea,
      platform: platform(),
      index: slot,
      card: { width: TOAST_W, height: TOAST_H },
    });
    await window.goodPuppy.spawnToastWindow({ label, x: pos.x, y: pos.y, width: TOAST_W, height: TOAST_H });
    if (slots[slot] !== label || !pendingByLabel.has(label)) await window.goodPuppy.closeToastWindow(label);
  } catch (error) {
    console.error("online notification failed:", error);
    if (slots[slot] === label) freeSlot(label);
  }
}

function freeSlot(label: string): void {
  console.warn("[online-notify] freeSlot/close", label);
  const slot = slots.indexOf(label);
  if (slot !== -1) slots[slot] = null;
  pendingByLabel.delete(label);
  void window.goodPuppy.closeToastWindow(label);

  const next = queue.shift();
  if (next) {
    const free = slots.indexOf(null);
    if (free !== -1) void allocate(free, next);
    else queue.unshift(next);
  }
}

export function dismissAllToasts(): void {
  console.warn("[online-notify] dismissAllToasts", slots.filter(Boolean));
  queue.length = 0;
  for (let i = 0; i < slots.length; i += 1) {
    const label = slots[i];
    if (label) {
      pendingByLabel.delete(label);
      void window.goodPuppy.closeToastWindow(label);
      slots[i] = null;
    }
  }
}

// toast 回传监听器整会话只绑定一次（与 lounge 的 toast-enter-room 监听同理），
// 引用的是模块级状态，登入登出间一直有效；不再随每次 init 重绑（那样会因 lounge
// 缺 allow-unlisten 而抛错并泄漏监听器）。
function bindListeners(): void {
  if (listenersBound) return;
  listenersBound = true;
  const bridge = window.goodPuppy;
  bridge.onAppEvent<{ label?: string }>("toast-ready", ({ label }) => {
    console.warn("[online-notify] toast-ready recv", label);
    if (!label) return;
    const payload = pendingByLabel.get(label);
    if (payload) void bridge.emitToWindow(label, "toast-data", payload);
  });
  bridge.onAppEvent<{ label?: string; reason?: string }>("toast-dismiss", ({ label, reason }) => {
    console.warn("[online-notify] toast-dismiss recv", label, "reason", reason);
    if (label) freeSlot(label);
  });
}

export function initOnlineNotifier(nextDeps: OnlineNotifierDeps): void {
  console.warn("[online-notify] initOnlineNotifier");
  deps = nextDeps;
  const selfId = deps.getSelfId();
  const store = storage();
  subscribed = selfId && store ? readSubscribedRooms(store, selfId) : new Set();
  bindListeners();
}

export function disposeOnlineNotifier(): void {
  dismissAllToasts();
  snapshot.clear();
  lastNotifiedAt.clear();
  subscribed = new Set();
  deps = null;
  // 监听器常驻（绑定一次、不 unlisten）：登出后无 pending toast，回调为 no-op。
}
