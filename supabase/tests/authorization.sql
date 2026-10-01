-- 在独立测试库执行；所有测试用户、房间和函数最终回滚。
BEGIN;
CREATE FUNCTION public.test_assert(condition boolean, label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF condition IS DISTINCT FROM true THEN RAISE EXCEPTION 'Assertion failed: %',label; END IF; END $$;
CREATE FUNCTION public.test_denied(statement text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE statement;
  EXCEPTION WHEN insufficient_privilege OR raise_exception THEN RETURN;
  END;
  RAISE EXCEPTION 'Expected rejection: %',statement;
END $$;
INSERT INTO auth.users(id) VALUES('11111111-0000-0000-0000-000000000001'),('22222222-0000-0000-0000-000000000002'),('33333333-0000-0000-0000-000000000003');
INSERT INTO public.profiles(id) SELECT id FROM auth.users;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','11111111-0000-0000-0000-000000000001',true);
SELECT public.create_room('test-room','aaaaaaaa-0000-0000-0000-000000000001');
SELECT invite_code FROM public.rooms WHERE id='aaaaaaaa-0000-0000-0000-000000000001' \gset
SELECT public.create_room('test-room','aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.test_assert((SELECT count(*)=1 FROM public.room_members),'create retry is idempotent');
SELECT public.test_denied($sql$INSERT INTO public.room_members(room_id,user_id) VALUES('aaaaaaaa-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002')$sql$);
SELECT public.test_denied($sql$UPDATE public.profiles SET gp_id='spoofed' WHERE id=auth.uid()$sql$);
SELECT public.test_denied($sql$UPDATE public.profiles SET created_at='2000-01-01' WHERE id=auth.uid()$sql$);
UPDATE public.profiles SET display_name='allowed' WHERE id=auth.uid();
SELECT public.invite_room_member('aaaaaaaa-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002') AS request_id \gset
SELECT public.invite_room_member('aaaaaaaa-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002');
SELECT public.test_assert((SELECT count(*)=1 FROM public.connection_requests WHERE status='pending'),'invite retry is idempotent');
SELECT set_config('realtime.topic','presence:aaaaaaaa-0000-0000-0000-000000000001',true);
INSERT INTO realtime.messages(topic,extension) VALUES('presence:aaaaaaaa-0000-0000-0000-000000000001','presence');
SELECT public.test_denied($sql$INSERT INTO realtime.messages(topic,extension,payload) VALUES('interactions:aaaaaaaa-0000-0000-0000-000000000001','broadcast','{}')$sql$);
SELECT set_config('request.jwt.claim.sub','33333333-0000-0000-0000-000000000003',true);
SELECT public.test_denied($sql$INSERT INTO public.room_members(room_id,user_id) VALUES('aaaaaaaa-0000-0000-0000-000000000001',auth.uid())$sql$);
SELECT public.test_denied($sql$SELECT public.invite_room_member('aaaaaaaa-0000-0000-0000-000000000001','22222222-0000-0000-0000-000000000002')$sql$);
SELECT public.test_denied($sql$SELECT public.create_room('collision','aaaaaaaa-0000-0000-0000-000000000001')$sql$);
SELECT public.test_denied($sql$INSERT INTO public.presence(user_id,current_room_id,is_online) VALUES(auth.uid(),'aaaaaaaa-0000-0000-0000-000000000001',true)$sql$);
SELECT public.test_assert(NOT private.can_access_room_topic('presence:aaaaaaaa-0000-0000-0000-000000000001'),'nonmember channel denied');
SELECT public.test_assert(NOT private.can_access_room_topic('presence:not-a-uuid'),'invalid topic safely denied');
SELECT public.test_denied($sql$INSERT INTO realtime.messages(topic,extension) VALUES('presence:aaaaaaaa-0000-0000-0000-000000000001','presence')$sql$);
SELECT public.join_room_by_invite(:'invite_code');
SELECT public.test_assert((SELECT count(*)=2 FROM public.room_members),'valid invite-code join');
SELECT public.leave_room('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.sub','22222222-0000-0000-0000-000000000002',true);
SELECT public.test_denied($sql$UPDATE public.connection_requests SET status='accepted'$sql$);

SELECT public.accept_connection(:'request_id');
SELECT public.accept_connection(:'request_id');
SELECT public.test_assert((SELECT count(*)=2 FROM public.room_members),'accept retry does not duplicate membership');
SELECT public.send_room_interaction('aaaaaaaa-0000-0000-0000-000000000001','feed','11111111-0000-0000-0000-000000000001');
SELECT set_config('realtime.topic','interactions:aaaaaaaa-0000-0000-0000-000000000001',true);
SELECT public.test_assert((SELECT payload->>'actorId'='22222222-0000-0000-0000-000000000002' FROM realtime.messages WHERE event='interaction'),'actor identity is stamped by server');
SELECT public.test_denied($sql$SELECT public.send_room_interaction('aaaaaaaa-0000-0000-0000-000000000001','unknown','11111111-0000-0000-0000-000000000001')$sql$);
SELECT public.leave_room('aaaaaaaa-0000-0000-0000-000000000001');
SELECT public.test_assert(NOT private.can_access_room_topic('presence:aaaaaaaa-0000-0000-0000-000000000001'),'membership removal revokes topic access');
SELECT set_config('request.jwt.claim.sub','11111111-0000-0000-0000-000000000001',true);
SELECT public.invite_room_member('aaaaaaaa-0000-0000-0000-000000000001','33333333-0000-0000-0000-000000000003') AS stale_request \gset
SELECT public.leave_room('aaaaaaaa-0000-0000-0000-000000000001');
SELECT set_config('request.jwt.claim.sub','33333333-0000-0000-0000-000000000003',true);
SELECT public.test_denied(format('SELECT public.accept_connection(%L)',:'stale_request'));
RESET ROLE;
SELECT public.test_assert(NOT EXISTS(SELECT 1 FROM public.rooms WHERE id='aaaaaaaa-0000-0000-0000-000000000001'),'last member removes room');
SET LOCAL ROLE anon;
SELECT public.test_denied($sql$SELECT public.create_room('anonymous','bbbbbbbb-0000-0000-0000-000000000001')$sql$);
ROLLBACK;
