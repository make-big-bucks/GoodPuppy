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
