import { retryTask } from "../../shared/retryTask.js";
import { subscribeChannel, type ConnectionObserver } from "../../shared/realtimeSubscription.js";
import { resolvePetDir, resolveSkin, getBehavior } from "../../shared/pet/animationCatalog.js";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { PetStatus, PresenceUser } from "../../types";

type LocalPresencePatch = { status?: PetStatus; petId?: string; skin?: string };
type Options = LocalPresencePatch & { revision?: number; onPresenceChange?: (users: PresenceUser[]) => void;
  onConnectionChange?: ConnectionObserver; onMembershipLost?: () => void };
type Row = { user_id: string; pet_id?: string; skin?: string; status?: string | null; remaining_ms: number; expiresAt?: number };
type Session = { client: SupabaseClient; roomId: string; userId: string; revision: number; channel: RealtimeChannel;
  abort: AbortController; options: Options; ready: boolean; active: boolean; status: PetStatus;
  rows: Row[]; loading: boolean; dirty: boolean; timer: ReturnType<typeof setTimeout> | null; poll: ReturnType<typeof setInterval> | null; nextRead: number; signature: string };
const clientId = crypto.randomUUID();
let fallbackRevision = 0;
let current: Session | null = null;

function emit(session: Session) {
  if (current !== session) return;
  const users = session.rows.filter(row => row.user_id !== session.userId && (row.expiresAt ?? 0) > performance.now()).map(row => {
    const petId = resolvePetDir(row.pet_id ?? "default");
    return { userId: row.user_id, petId, skin: resolveSkin(petId, row.skin),
      status: row.status && getBehavior(row.status)?.kind === "status" ? row.status : null };
  }) as PresenceUser[];
  const signature = JSON.stringify(users);
  if (signature !== session.signature) { session.signature = signature; session.options.onPresenceChange?.(users); }
}
function args(session: Session) { return { p_user: session.userId, p_room: session.roomId, p_client: clientId, p_revision: session.revision }; }
async function rpc(session: Session, name: string, extra = {}) {
  const { error } = await session.client.rpc(name, { ...args(session), ...extra });
  if (error) throw error;
}
async function read(session: Session) {
  const started = performance.now();
  const { data, error } = await session.client.rpc("get_room_presence", { p_user: session.userId, p_room: session.roomId }).abortSignal(session.abort.signal);
  if (current !== session) return;
  if (error) {
    session.rows = []; emit(session);
    if (error.code === "42501") session.options.onMembershipLost?.();
    throw error;
  }
  session.rows = (data ?? []).filter((row: Row) => typeof row.user_id === "string").map((row: Row) => ({
    ...row, expiresAt: performance.now() + Math.max(0, Math.min(120_000, Number(row.remaining_ms)) - (performance.now() - started)),
  }));
  emit(session);
}
/** 广播内容完全不参与身份/状态判定，仅合并为最多每秒两次的快照读取。 */
function refresh(session: Session) {
  if (current !== session || !session.ready) return;
  emit(session);
  session.dirty = true;
  if (session.loading || session.timer) return;
  session.timer = setTimeout(async () => {
    session.timer = null; session.loading = true; session.dirty = false;
    session.nextRead = Date.now() + 500;
    try { await read(session); } catch (error) { if (!session.abort.signal.aborted) console.error("presence snapshot:", error); }
    finally { session.loading = false; if (session.dirty) refresh(session); }
  }, Math.max(0, session.nextRead - Date.now()));
}
export async function joinRoom(client: SupabaseClient, roomId: string, userId: string, options: Options = {}) {
  await leaveRoom();
  const channel = client.channel(`presence:${roomId}`, { config: { private: true } });
  const session: Session = { client, roomId, userId, revision: options.revision ?? ++fallbackRevision, channel,
    abort: new AbortController(), options, ready: false, active: false, status: options.status ?? null,
    rows: [], loading: false, dirty: false, timer: null, poll: null, nextRead: 0, signature: "" };
  current = session; emit(session);
  channel.on("broadcast", { event: "presence-changed" }, () => refresh(session));
  await subscribeChannel(channel, async (reconnected) => {
    if (current !== session) return;
    if (reconnected) await retryTask(() => read(session), session.abort.signal, (error) => console.error("presence reconnect:", error));
    else await read(session);
  }, undefined, (ready, error) => {
    if (current !== session) return;
    session.ready = ready;
    if (!ready) { session.rows = []; emit(session); }
    session.options.onConnectionChange?.(ready, error);
  });
  if (current !== session) return;
  session.poll = setInterval(() => refresh(session), 10_000);
}
export async function activatePresence() {
  const session = current;
  if (!session?.ready) throw new Error("在线状态频道尚未就绪");
  await rpc(session, "activate_room_presence", { p_status: session.status });
  if (current !== session) return;
  session.active = true; refresh(session);
}
export async function updateLocalPresence({ status }: LocalPresencePatch = {}) {
  const session = current;
  if (!session) return;
  if (status !== undefined) session.status = status;
  if (session.active && session.ready) await rpc(session, "update_room_presence", { p_status: session.status, p_connected: null });
}
export async function heartbeatPresence(connected: boolean) {
  const session = current;
  if (!session?.active) return;
  await rpc(session, "update_room_presence", { p_status: session.status, p_connected: connected });
}
export async function leaveRoom() {
  const session = current;
  current = null;
  if (!session) return;
  session.abort.abort(); if (session.timer) clearTimeout(session.timer); if (session.poll) clearInterval(session.poll);
  session.options.onPresenceChange?.([]);
  const results = await Promise.allSettled([
    session.client.removeChannel(session.channel),
    rpc(session, "deactivate_room_presence"),
  ]);
  const failure = results.find(result => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
