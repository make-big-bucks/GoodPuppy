import * as presence from "./presence.js";
import { compareMessagePosition } from "../../shared/messageOrder.js";
import { retryTask } from "../../shared/retryTask.js";
import { recordLifecycle } from "../../shared/diagnostics.js";
import { joinInteractions, leaveInteractions } from "./interactions.js";
import {
  fetchRoomMessages,
  subscribeToRoomMessages,
  unsubscribeRoomMessages,
} from "./roomMessages.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@supabase/supabase-js";
import type { InteractionPayload, LocalMessage, PetStatus, PresenceUser } from "../../types";
import type { PetAnimator } from "./petState.js";

type RoomCallbacks = {
  onPresenceChange: (users: PresenceUser[]) => void;
  onInteraction: (payload: InteractionPayload) => void;
  onMessagesLoaded: (messages: LocalMessage[]) => void;
  onNewMessage: (msg: LocalMessage) => void;
  onRoomReady: () => void;
  onEnterRoom: () => void;
  onClearRemotePets: () => void;
  onPetIdResolved: (petId: string) => void;
  onSkinResolved?: (skin: string) => void;
  onSessionChanged?: () => void;
  getSelfAnimator: () => PetAnimator;
  getSelfPetId: () => string;
  getSelfSkin: () => string;
  getSelfStatus: () => PetStatus;
};

type StartPetAppOptions = {
  supabase?: SupabaseClient;
  session?: Session | null;
};

type SessionContext = { client: SupabaseClient; userId: string };
let context: SessionContext | null = null;
let currentRoomId: string | null = null;
let callbacks: RoomCallbacks | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let revision = 0;
let pending = Promise.resolve();
let initialization: Promise<void> | null = null;
let resumeRecovery: { abort: AbortController; result: Promise<void> } | null = null;

export function initRoomManager(cbs: RoomCallbacks) { callbacks = cbs; }
export function getRoomRevision() { return revision; }
export function getCurrentRoomId() { return currentRoomId; }
export function getActiveSupabase() { return context?.client ?? null; }
export function getSelfAuthId() { return context?.userId ?? null; }

function stopHeartbeat() {
  if (heartbeatTimer != null) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function invalidate() {
  resumeRecovery?.abort.abort();
  resumeRecovery = null;
  revision += 1;
  stopHeartbeat();
  if (currentRoomId) callbacks?.onClearRemotePets();
  currentRoomId = null;
  return revision;
}

function assertCurrent(version: number) {
  if (version !== revision) throw new DOMException("房间操作已取消", "AbortError");
}

function enqueue(work: () => Promise<void>): Promise<void> {
  const result = pending.then(work);
  pending = result.catch(() => {});
  return result;
}

/** 释放所有通道；一个通道失败不能阻止其它资源的清理。 */
async function releaseChannels(client: SupabaseClient) {
  const results = await Promise.allSettled([
    leaveInteractions(), presence.leaveRoom(), unsubscribeRoomMessages(client),
  ]);
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}

async function writeOffline(session: SessionContext, rememberRoom = false) {
  const { error } = await session.client.from("presence").update({
    ...(rememberRoom ? {} : { current_room_id: null }),
    is_online: false,
    last_seen: new Date().toISOString(),
  }).eq("user_id", session.userId);
  if (error) throw error;
}

async function ensureProfile(session: SessionContext, version: number) {
  const { data, error } = await session.client.from("profiles").select("id, pet_id, skin")
    .eq("id", session.userId).maybeSingle();
  assertCurrent(version);
  if (error) throw error;
  if (!data) {
    const { error: insertError } = await session.client.from("profiles")
      .upsert({ id: session.userId, display_name: "", pet_id: "default" }, { onConflict: "id", ignoreDuplicates: true });
    assertCurrent(version);
    if (insertError) throw insertError;
  } else { callbacks?.onPetIdResolved(data.pet_id || "default"); callbacks?.onSkinResolved?.(data.skin || "default"); }
}

function startHeartbeat(version: number, pulse: () => void) {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (version !== revision || !currentRoomId) return;
    pulse();
  }, 60_000);
}

async function activateRoom(session: SessionContext, roomId: string, version: number) {
  assertCurrent(version);
  const cbs = callbacks;
  if (!cbs) throw new Error("房间控制器尚未初始化");
  const messages: LocalMessage[] = [];
  let committed = false;
  let users: PresenceUser[] = [];
  const connection = { messages: false, presence: false, interactions: false };
  const healthy = () => Object.values(connection).every(Boolean);
  let pulseQueued = false;
  const pulse = () => {
    if (pulseQueued || !committed || version !== revision) return;
    pulseQueued = true;
    // 与退出/切房串行，旧心跳写入不能落到新房间的在线写入之后。
    void enqueue(async () => {
      pulseQueued = false;
      if (version !== revision || currentRoomId !== roomId) return;
      const { error } = await session.client.from("presence").update({
        is_online: healthy(), last_seen: new Date().toISOString(),
      }).eq("user_id", session.userId);
      if (error) throw error;
    }).catch((error) => console.error("presence heartbeat:", error));
  };
  const observe = (name: keyof typeof connection) => (ready: boolean) => {
    if (version !== revision) return;
    const changed = connection[name] !== ready;
    connection[name] = ready;
    if (changed) pulse();
  };
  // 先建立订阅，快照加载期间缓冲新消息，避免查询与订阅间的空隙。
  await subscribeToRoomMessages(session.client, roomId, (message) => {
    if (version !== revision) return;
    if (committed) cbs.onNewMessage(message);
    else messages.push(message);
  }, observe("messages"));
  assertCurrent(version);
  const history = await fetchRoomMessages(session.client, roomId);
  assertCurrent(version);
  await presence.joinRoom(session.client, roomId, session.userId, {
    onConnectionChange: observe("presence"),
    onPresenceChange: (nextUsers) => {
      if (version !== revision) return;
      users = nextUsers;
      if (committed) cbs.onPresenceChange(nextUsers);
    },
    status: cbs.getSelfStatus(), petId: cbs.getSelfPetId(), skin: cbs.getSelfSkin(),
  });
  assertCurrent(version);
  await joinInteractions(session.client, roomId, {
    onConnectionChange: observe("interactions"),
    onInteraction: (payload) => { if (version === revision && committed) cbs.onInteraction(payload); },
  });
  assertCurrent(version);
  await presence.updateLocalPresence({ status: cbs.getSelfStatus(), petId: cbs.getSelfPetId(), skin: cbs.getSelfSkin() });
  assertCurrent(version);
  if (!healthy()) throw new Error("房间连接在准备期间中断，请重试");
  const { error } = await session.client.from("presence").upsert({
    user_id: session.userId, current_room_id: roomId, is_online: true,
    last_seen: new Date().toISOString(),
  }, { onConflict: "user_id" });
  assertCurrent(version);
  if (error) throw error;
  if (!healthy()) throw new Error("房间连接在准备期间中断，请重试");
  // 全部准备成功后才提交 active 状态；迟到的回调不能修改其它房间。
  currentRoomId = roomId;
  committed = true;
  const merged = new Map([...history, ...messages].map((message) => [message.id, message]));
  cbs.onMessagesLoaded([...merged.values()].sort((a, b) =>
    compareMessagePosition({ id: a.id, createdAt: a.created_at }, { id: b.id, createdAt: b.created_at })));
  cbs.onPresenceChange(users);
  startHeartbeat(version, pulse);
  cbs.onRoomReady();
}

async function enter(session: SessionContext, roomId: string, version: number) {
  assertCurrent(version);
  const started = performance.now();
  const event = { operation: "room-enter" as const, roomId, sessionVersion: version };
  recordLifecycle({ ...event, phase: "start" });
  try {
    await releaseChannels(session.client);
    assertCurrent(version);
    await activateRoom(session, roomId, version);
    recordLifecycle({ ...event, phase: "ok", durationMs: Math.round(performance.now() - started) });
  } catch (error) {
    recordLifecycle({ ...event, phase: error instanceof DOMException && error.name === "AbortError" ? "canceled" : "failed" });
    // 旧操作也要释放已创建的通道，但不触碰更新版本的本地状态。
    await Promise.allSettled([releaseChannels(session.client), writeOffline(session)]);
    if (version === revision) {
      invalidate();
      callbacks?.onRoomReady();
    }
    throw error;
  }
}

export function switchRoom(roomId: string): Promise<void> {
  const session = context;
  if (!session) return Promise.reject(new Error("请先登录"));
  if (!roomId) return Promise.reject(new Error("请选择房间"));
  if (roomId === currentRoomId) return Promise.resolve();
  const version = invalidate();
  return enqueue(async () => {
    await enter(session, roomId, version);
    callbacks?.onEnterRoom();
  });
}

/** 唤醒/网络恢复重建真实连接；临时失败保留房间记录，成员资格消失则明确清除。 */
export function recoverRoomAfterResume(): Promise<void> {
  if (resumeRecovery) return resumeRecovery.result;
  const session = context;
  const roomId = currentRoomId;
  if (!session || !roomId) return Promise.resolve();
  const version = invalidate();
  recordLifecycle({ operation: "room-resume", phase: "start", roomId, sessionVersion: version });
  callbacks?.onRoomReady();
  const abort = new AbortController();
  const result = retryTask(() => enqueue(async () => {
    assertCurrent(version);
    await releaseChannels(session.client);
    assertCurrent(version);
    // 旧房间已失去成员资格时，保留该 room_id 的写入会被 RLS 拒绝；
    // 资格检查必须独立完成，才能选择允许的「清房间」收尾。
    const [offline, membershipResult] = await Promise.allSettled([
      writeOffline(session, true),
      session.client.from("room_members").select("room_id")
        .eq("room_id", roomId).eq("user_id", session.userId).abortSignal(abort.signal).maybeSingle(),
    ]);
    assertCurrent(version);
    if (membershipResult.status === "rejected") throw membershipResult.reason;
    const { data: membership, error } = membershipResult.value;
    if (error) throw error;
    if (!membership) {
      await writeOffline(session);
      assertCurrent(version);
      callbacks?.onRoomReady();
      return;
    }
    if (offline.status === "rejected") throw offline.reason;
    try { await activateRoom(session, roomId, version); }
    catch (error) {
      await Promise.allSettled([releaseChannels(session.client), writeOffline(session, true)]);
      assertCurrent(version);
      throw error;
    }
  }), abort.signal, (error) => console.error("房间恢复失败，将重试：", error));
  const recovery = { abort, result };
  resumeRecovery = recovery;
  void result.then(() => recordLifecycle({ operation: "room-resume", phase: "ok", roomId, sessionVersion: version }),
    () => recordLifecycle({ operation: "room-resume", phase: abort.signal.aborted ? "canceled" : "failed", roomId, sessionVersion: version }));
  void result.finally(() => { if (resumeRecovery === recovery) resumeRecovery = null; }).catch(() => {});
  return result;
}

export function exitCurrentRoom({ rememberRoom = false }: { rememberRoom?: boolean } = {}): Promise<void> {
  const session = context;
  const roomId = currentRoomId ?? undefined;
  const version = invalidate();
  const event = { operation: "room-exit" as const, action: rememberRoom ? "quit" as const : "leave" as const, roomId, sessionVersion: version };
  recordLifecycle({ ...event, phase: "start" });
  callbacks?.onRoomReady();
  if (!session) { recordLifecycle({ ...event, phase: "ok" }); return Promise.resolve(); }
  const result = enqueue(async () => {
    const results = await Promise.allSettled([releaseChannels(session.client), writeOffline(session, rememberRoom)]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  });
  void result.then(() => recordLifecycle({ ...event, phase: "ok" }), () => recordLifecycle({ ...event, phase: "failed" }));
  return result;
}

/** 注销与用户切换独立于退出房间：立即清身份，使旧任务失效。 */
export function stopPetApp(): Promise<void> {
  const result = exitCurrentRoom();
  context = null;
  initialization = null;
  recordLifecycle({ operation: "session-changed", phase: "ok", sessionVersion: revision });
  callbacks?.onSessionChanged?.();
  return result;
}

export function startPetApp({ supabase, session }: StartPetAppOptions = {}): Promise<void> {
  if (!supabase || !session?.user.id) return Promise.reject(new Error("缺少登录会话"));
  if (context?.client === supabase && context.userId === session.user.id) return initialization ?? Promise.resolve();
  const previous = context;
  if (previous?.userId !== session.user.id) callbacks?.onSessionChanged?.();
  const next: SessionContext = { client: supabase, userId: session.user.id };
  const version = invalidate();
  context = next;
  recordLifecycle({ operation: "session-changed", phase: "ok", sessionVersion: version });
  const result = enqueue(async () => {
    if (previous) await Promise.allSettled([releaseChannels(previous.client), writeOffline(previous)]);
    assertCurrent(version);
    await ensureProfile(next, version);
    const { data, error } = await next.client.from("presence").select("current_room_id, is_online")
      .eq("user_id", next.userId).maybeSingle();
    assertCurrent(version);
    if (error) throw error;
    if (data?.current_room_id) {
      const { data: membership, error: memberError } = await next.client.from("room_members")
        .select("room_id").eq("room_id", data.current_room_id).eq("user_id", next.userId).maybeSingle();
      assertCurrent(version);
      if (memberError) throw memberError;
      if (membership) { await enter(next, data.current_room_id, version); return; }
      await writeOffline(next);
    } else if (data?.is_online) await writeOffline(next);
    assertCurrent(version);
    callbacks?.onRoomReady();
  });
  initialization = result;
  void result.catch(() => {
    if (version === revision) {
      initialization = null;
      context = null;
      callbacks?.onRoomReady();
    }
  });
  return result;
}
