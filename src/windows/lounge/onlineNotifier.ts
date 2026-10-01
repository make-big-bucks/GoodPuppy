import { createNotificationScheduler } from "./notificationScheduler.js";
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

const listeners: Array<{ ready: Promise<void> }> = [];
const scheduler = createNotificationScheduler<OnlineNotifyPayload>({
  key: (payload) => `${payload.roomId}|${payload.userId}`,
  valid: (payload) => Boolean(deps?.getSelfId() && deps.getSelfId() !== payload.userId
    && deps.getActiveRoomId() !== payload.roomId && subscribed.has(payload.roomId)
    && deps.getRooms().some((room) => room.id === payload.roomId)),
  create: async (label, instanceId, slot, _payload, signal) => {
    await Promise.all(listeners.map((listener) => listener.ready));
    const workArea = await window.goodPuppy.getCursorMonitorWorkArea();
    if (signal.aborted) return;
    const pos = computeToastPosition({ workArea, platform: platform(), index: slot, card: { width: TOAST_W, height: TOAST_H } });
    await window.goodPuppy.spawnToastWindow({ label, instanceId, ...pos, width: TOAST_W, height: TOAST_H });
  },
  close: (label, instanceId) => window.goodPuppy.closeToastWindow(label, instanceId),
  deliver: (label, instanceId, payload) => window.goodPuppy.emitToWindow(label, "toast-data", { instanceId, payload }),
  maxVisible: MAX_VISIBLE,
});
function showOrQueue(payload: OnlineNotifyPayload) { scheduler.enqueue(payload); }
export function dismissAllToasts() { scheduler.clear(); }
export function isCurrentToast(label: string, instanceId: string, roomId: string) {
  return scheduler.matches(label, instanceId, (payload) => payload.roomId === roomId);
}
function bindListeners() {
  if (listenersBound) return;
  listenersBound = true;
  listeners.push(window.goodPuppy.onAppEvent<{ label?: string; instanceId?: string }>("toast-ready", (payload) => {
    if (payload?.label && payload.instanceId) void scheduler.ready(payload.label, payload.instanceId);
  }));
  listeners.push(window.goodPuppy.onAppEvent<{ label?: string; instanceId?: string }>("toast-dismiss", (payload) => {
    if (payload?.label && payload.instanceId) scheduler.dismiss(payload.label, payload.instanceId);
  }));
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
