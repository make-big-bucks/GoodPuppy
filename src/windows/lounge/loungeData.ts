import type { SupabaseClient } from "@supabase/supabase-js";
import type { LoungeProfile, LoungeMemberRow, LoungePresenceRow, PendingRoomInvitationRow } from "../../types";
export type RoomMembershipRow = { room_id: string; rooms: { id: string; room_name?: string | null; description?: string | null; invite_code?: string | null; created_by?: string | null } | null };
export type LoungeDataContext = { client: SupabaseClient; userId: string };
export async function fetchLoungeData({ client, userId }: LoungeDataContext, signal: AbortSignal) {
  const [profileResult, myRoomsResult, requestsResult] = await Promise.all([
    client
      .from("profiles")
      .select("id, gp_id, display_name, pet_id, skin")
      .eq("id", userId)
      .abortSignal(signal).maybeSingle(),
    client
      .from("room_members")
      .select("room_id, rooms!inner(id, room_name, description, invite_code, created_by)")
      .eq("user_id", userId).abortSignal(signal),
    client.rpc("get_pending_room_invitations").abortSignal(signal),
  ]);

  if (profileResult.error) throw profileResult.error;
  if (myRoomsResult.error) throw myRoomsResult.error;
  if (requestsResult.error) throw requestsResult.error;

  if (signal.aborted) throw new DOMException("会话已取消", "AbortError");
  // 新用户注册后 profiles 行尚不存在，自动创建默认行（gp_id 由数据库触发器生成）
  // 用 ignoreDuplicates 避免与 pet 窗口 ensureProfile() 的竞态冲突
  let profileData = profileResult.data as LoungeProfile | null;
  if (!profileData) {
    const { error: upsertError } = await client
      .from("profiles")
      .upsert({ id: userId, display_name: "", pet_id: "default" }, { onConflict: "id", ignoreDuplicates: true }).abortSignal(signal);
    if (upsertError) throw upsertError;
    const { data: fetched, error: fetchError } = await client
      .from("profiles")
      .select("id, gp_id, display_name, pet_id, skin")
      .eq("id", userId)
      .abortSignal(signal).single();
    if (fetchError) throw fetchError;
    profileData = fetched as LoungeProfile | null;
  }

  type RawMembership = Omit<RoomMembershipRow, "rooms"> & { rooms: RoomMembershipRow["rooms"] | NonNullable<RoomMembershipRow["rooms"]>[] };
  const rawRooms = (myRoomsResult.data as RawMembership[] | null) ?? [];
  const myRooms: RoomMembershipRow[] = rawRooms.map((row) => ({ ...row, rooms: Array.isArray(row.rooms) ? row.rooms[0] ?? null : row.rooms }));
  const roomIds = myRooms.map((item) => item.room_id);
  let allMembers: LoungeMemberRow[] = [];
  let allPresence: LoungePresenceRow[] = [];

  if (roomIds.length > 0) {
    const [membersResult, presenceResult] = await Promise.all([
      client
        .from("room_members")
        .select("room_id, user_id, joined_at, profiles!room_members_user_id_fkey(id, gp_id, display_name, pet_id, skin)")
        .in("room_id", roomIds).abortSignal(signal),
      client
        .from("presence")
        .select("current_room_id, user_id, is_online, last_seen")
        .in("current_room_id", roomIds).abortSignal(signal),
    ]);

    if (membersResult.error) throw membersResult.error;
    if (presenceResult.error) throw presenceResult.error;
    allMembers = (membersResult.data as LoungeMemberRow[] | null) || [];
    allPresence = (presenceResult.data as LoungePresenceRow[] | null) || [];
  }

  return { profile: profileData, myRooms, allMembers, allPresence,
    invitations: (requestsResult.data as PendingRoomInvitationRow[] | null) ?? [] };
}
export type LoungeData = Awaited<ReturnType<typeof fetchLoungeData>>;
