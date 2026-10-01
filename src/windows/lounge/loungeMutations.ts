import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeGpId } from "./loungeViewModels.js";

export type MutationContext = { client: SupabaseClient; userId: string; roomId: string | null; assertCurrent: () => void };

export async function sendRoomInvitation(mutation: MutationContext, targetGpId: string) {
  mutation.assertCurrent();
  if (!mutation.roomId) throw new Error("请选择房间");
  const gpId = normalizeGpId(targetGpId);
  if (!gpId) throw new Error("请输入 gp_ 开头的 GoodPuppy ID");

  const { data: target, error: lookupError } = await mutation.client
    .from("profiles")
    .select("id")
    .eq("gp_id", gpId)
    .single();

  mutation.assertCurrent();
  if (lookupError || !target) {
    throw new Error("找不到该 GoodPuppy ID");
  }

  if (target.id === mutation.userId) {
    throw new Error("不能邀请自己");
  }

  // 检查对方是否已经是当前房间成员
  if (mutation.roomId) {
    const { data: existing, error: membershipError } = await mutation.client
      .from("room_members")
      .select("user_id")
      .eq("room_id", mutation.roomId)
      .eq("user_id", target.id)
      .maybeSingle();
    mutation.assertCurrent();
    if (membershipError) throw membershipError;
    if (existing) throw new Error("对方已经是房间成员");
  }

  const { error } = await mutation.client.rpc("invite_room_member", {
    p_room_id: mutation.roomId, p_to_user_id: target.id,
  });
  mutation.assertCurrent();
  if (error) throw error;
}

export async function saveDisplayName(mutation: MutationContext, displayName: string) {
  mutation.assertCurrent();
  const value = displayName.trim();
  if (!value) throw new Error("请输入用户名");
  const { data, error } = await mutation.client.from("profiles").update({ display_name: value })
    .eq("id", mutation.userId).select("id").single();
  mutation.assertCurrent();
  if (error) throw error;
  if (data?.id !== mutation.userId) throw new Error("用户名未保存，请重试");
}

export async function saveRoomMetadata(mutation: MutationContext, roomId: string, values: { roomName: string; description: string }) {
  mutation.assertCurrent();
  const { data, error } = await mutation.client.from("rooms").update({
    room_name: values.roomName.trim() || "未命名房间", description: values.description.trim(),
  }).eq("id", roomId).select("id").single();
  mutation.assertCurrent();
  if (error) throw error;
  if (data?.id !== roomId) throw new Error("房间资料未保存，请重试");
}

export class InvitationStateChangedError extends Error {
  constructor() { super("邀请已被处理或已失效"); }
}

export async function declineRoomInvitation(mutation: MutationContext, requestId: string) {
  mutation.assertCurrent();
  const { data, error } = await mutation.client.from("connection_requests").update({ status: "declined" })
    .eq("id", requestId).eq("to_id", mutation.userId).eq("status", "pending").select("id, status").single();
  mutation.assertCurrent();
  if (error?.code === "PGRST116") throw new InvitationStateChangedError();
  if (error) throw error;
  if (data?.id !== requestId || data.status !== "declined") throw new Error("邀请状态未更新，请重试");
}
