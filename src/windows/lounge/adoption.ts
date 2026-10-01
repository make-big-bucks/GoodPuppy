import type { SupabaseClient } from "@supabase/supabase-js";

/** 登录会触发界面换代；资料初始化使用实际返回的身份，逐步检查它仍是当前账号。 */
export async function saveAdoptedProfile(client: SupabaseClient, userId: string, name: string, isCurrent: () => boolean) {
  const assertCurrent = () => { if (!isCurrent()) throw new DOMException("账号已改变", "AbortError"); };
  assertCurrent();
  const { error: insertError } = await client.from("profiles")
    .upsert({ id: userId, display_name: name, pet_id: "default" }, { onConflict: "id", ignoreDuplicates: true });
  assertCurrent();
  if (insertError) throw insertError;
  const { data, error: updateError } = await client.from("profiles").update({ display_name: name })
    .eq("id", userId).select("id").single();
  assertCurrent();
  if (updateError) throw updateError;
  if (data?.id !== userId) throw new Error("领养资料未保存，请重试");
}
