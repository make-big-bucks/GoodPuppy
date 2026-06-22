-- 把 profiles 加入 supabase_realtime publication，使会客厅可实时订阅成员改名/换肤。
-- 客户端（src/windows/lounge/lounge.ts subscribeToProfilesChanges）按当前房间成员过滤变更，
-- 因为 profiles_select 的 RLS 为 true，订阅会收到全站任意用户的变更。
alter publication supabase_realtime add table public.profiles;
