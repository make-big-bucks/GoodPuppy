-- 本地准备，未在远端执行。在线状态由认证实例租约提供，客户端 Presence key 不再作为身份。
CREATE TABLE private.presence_clients (
 user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
 client_id uuid NOT NULL, session_id uuid NOT NULL REFERENCES auth.sessions(id) ON DELETE CASCADE,
 revision bigint NOT NULL CHECK(revision>=0), retired boolean NOT NULL DEFAULT false,
 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,client_id)
);
CREATE TABLE private.presence_leases (
 user_id uuid NOT NULL,client_id uuid NOT NULL,room_id uuid NOT NULL,
 status text CHECK(status IS NULL OR status IN('happy','sad','busy','bored')),
 active boolean NOT NULL DEFAULT true,last_seen timestamptz NOT NULL DEFAULT now(),state_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(user_id,client_id),
 FOREIGN KEY(user_id,client_id) REFERENCES private.presence_clients(user_id,client_id) ON DELETE CASCADE,
 FOREIGN KEY(room_id,user_id) REFERENCES public.room_members(room_id,user_id) ON DELETE CASCADE
);
CREATE INDEX presence_leases_room_activity_idx ON private.presence_leases(room_id,last_seen) WHERE active;
ALTER TABLE private.presence_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.presence_leases ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON private.presence_clients,private.presence_leases FROM PUBLIC,anon,authenticated;

CREATE FUNCTION private.presence_session(p_expected_user uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_sid text := auth.jwt()->>'session_id';
BEGIN
 IF p_expected_user IS DISTINCT FROM auth.uid() OR auth.uid() IS NULL
   OR v_sid IS NULL OR v_sid !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'Invalid presence identity' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM auth.sessions WHERE id=v_sid::uuid AND user_id=auth.uid())
 THEN RAISE EXCEPTION 'Presence requires an active authentication session' USING ERRCODE='42501'; END IF;
 RETURN v_sid::uuid;
END $$;
CREATE FUNCTION private.claim_presence_revision(p_user uuid,p_client uuid,p_revision bigint,p_retired boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_sid uuid := private.presence_session(p_user);
BEGIN
 IF p_revision IS NULL OR p_revision<0 OR p_client IS NULL THEN RAISE EXCEPTION 'Invalid presence revision'; END IF;
 INSERT INTO private.presence_clients(user_id,client_id,session_id,revision,retired) VALUES(auth.uid(),p_client,v_sid,p_revision,p_retired)
 ON CONFLICT(user_id,client_id) DO UPDATE SET session_id=EXCLUDED.session_id,revision=EXCLUDED.revision,
   retired=EXCLUDED.retired,updated_at=now()
 WHERE presence_clients.revision<EXCLUDED.revision OR
   (presence_clients.revision=EXCLUDED.revision AND (p_retired OR NOT presence_clients.retired));
 IF NOT FOUND THEN RAISE EXCEPTION 'Obsolete presence operation' USING ERRCODE='40001'; END IF;
END $$;
CREATE FUNCTION private.presence_hint() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF TG_OP='DELETE' THEN PERFORM realtime.send('{}'::jsonb,'presence-changed','presence:'||OLD.room_id::text,true); RETURN OLD; END IF;
 IF TG_OP='INSERT' OR NEW.room_id IS DISTINCT FROM OLD.room_id OR NEW.status IS DISTINCT FROM OLD.status
  OR NEW.active IS DISTINCT FROM OLD.active OR OLD.last_seen<now()-interval '2 minutes' THEN
  PERFORM realtime.send('{}'::jsonb,'presence-changed','presence:'||NEW.room_id::text,true);
  IF TG_OP='UPDATE' AND NEW.room_id<>OLD.room_id THEN PERFORM realtime.send('{}'::jsonb,'presence-changed','presence:'||OLD.room_id::text,true); END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER presence_lease_hint AFTER INSERT OR UPDATE OR DELETE ON private.presence_leases FOR EACH ROW EXECUTE FUNCTION private.presence_hint();

CREATE FUNCTION private.activate_room_presence(p_user uuid,p_room uuid,p_client uuid,p_revision bigint,p_status text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.room_members m WHERE m.user_id=auth.uid() AND m.room_id=p_room)
 THEN RAISE EXCEPTION 'Presence requires room membership' USING ERRCODE='42501'; END IF;
 PERFORM private.claim_presence_revision(p_user,p_client,p_revision,false);
 INSERT INTO private.presence_leases(user_id,client_id,room_id,status) VALUES(auth.uid(),p_client,p_room,p_status)
 ON CONFLICT(user_id,client_id) DO UPDATE SET room_id=EXCLUDED.room_id,status=EXCLUDED.status,active=true,last_seen=now(),state_at=clock_timestamp();
 DELETE FROM private.presence_clients WHERE user_id=auth.uid() AND updated_at<now()-interval '1 day' AND client_id<>p_client
 AND NOT EXISTS(SELECT 1 FROM private.presence_leases l WHERE l.user_id=auth.uid() AND l.client_id=presence_clients.client_id AND l.last_seen>now()-interval '2 minutes');
END $$;
CREATE FUNCTION private.update_room_presence(p_user uuid,p_room uuid,p_client uuid,p_revision bigint,p_status text,p_connected boolean DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_sid uuid := private.presence_session(p_user);
BEGIN
 PERFORM 1 FROM private.presence_clients WHERE user_id=auth.uid() AND client_id=p_client
   AND revision=p_revision AND NOT retired AND session_id=v_sid FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Obsolete presence operation' USING ERRCODE='40001'; END IF;
 UPDATE private.presence_leases SET status=p_status,active=coalesce(p_connected,active),last_seen=now(),
   state_at=CASE WHEN status IS DISTINCT FROM p_status THEN clock_timestamp() ELSE state_at END
 WHERE user_id=auth.uid() AND client_id=p_client AND room_id=p_room;
 IF NOT FOUND THEN RAISE EXCEPTION 'Presence instance is no longer active' USING ERRCODE='42501'; END IF;
 UPDATE private.presence_clients SET updated_at=now() WHERE user_id=auth.uid() AND client_id=p_client;
 IF p_connected IS NULL THEN PERFORM realtime.send('{}'::jsonb,'presence-changed','presence:'||p_room::text,true); END IF;
END $$;
CREATE FUNCTION private.deactivate_room_presence(p_user uuid,p_room uuid,p_client uuid,p_revision bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.claim_presence_revision(p_user,p_client,p_revision,true);
 DELETE FROM private.presence_leases WHERE user_id=auth.uid() AND client_id=p_client AND room_id=p_room;
END $$;
CREATE FUNCTION private.get_room_presence(p_user uuid,p_room uuid)
RETURNS TABLE(user_id uuid,pet_id text,skin text,status text,remaining_ms bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.presence_session(p_user);
 IF NOT EXISTS(SELECT 1 FROM public.room_members m WHERE m.user_id=auth.uid() AND m.room_id=p_room)
 THEN RAISE EXCEPTION 'Presence requires room membership' USING ERRCODE='42501'; END IF;
 RETURN QUERY SELECT DISTINCT ON(l.user_id) l.user_id,p.pet_id,p.skin,l.status,
   greatest(0,(extract(epoch FROM(l.last_seen+interval '2 minutes'-now()))*1000)::bigint)
 FROM private.presence_leases l JOIN public.profiles p ON p.id=l.user_id
 WHERE l.room_id=p_room AND l.active AND l.last_seen>now()-interval '2 minutes'
 ORDER BY l.user_id,l.state_at DESC,l.client_id;
END $$;
CREATE FUNCTION private.get_online_room_presence(p_user uuid)
RETURNS TABLE(user_id uuid,current_room_id uuid,is_online boolean,last_seen timestamptz,age_ms bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM private.presence_session(p_user);
 RETURN QUERY SELECT l.user_id,l.room_id,true,max(l.last_seen),(extract(epoch FROM(now()-max(l.last_seen)))*1000)::bigint
 FROM private.presence_leases l WHERE l.active AND l.last_seen>now()-interval '2 minutes'
 AND EXISTS(SELECT 1 FROM public.room_members m WHERE m.room_id=l.room_id AND m.user_id=auth.uid()) GROUP BY l.user_id,l.room_id;
END $$;

CREATE FUNCTION public.activate_room_presence(p_user uuid,p_room uuid,p_client uuid,p_revision bigint,p_status text) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private.activate_room_presence(p_user,p_room,p_client,p_revision,p_status) $$;
CREATE FUNCTION public.update_room_presence(p_user uuid,p_room uuid,p_client uuid,p_revision bigint,p_status text,p_connected boolean DEFAULT NULL) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private.update_room_presence(p_user,p_room,p_client,p_revision,p_status,p_connected) $$;
CREATE FUNCTION public.deactivate_room_presence(p_user uuid,p_room uuid,p_client uuid,p_revision bigint) RETURNS void
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT private.deactivate_room_presence(p_user,p_room,p_client,p_revision) $$;
CREATE FUNCTION public.get_room_presence(p_user uuid,p_room uuid) RETURNS TABLE(user_id uuid,pet_id text,skin text,status text,remaining_ms bigint)
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM private.get_room_presence(p_user,p_room) $$;
CREATE FUNCTION public.get_online_room_presence(p_user uuid) RETURNS TABLE(user_id uuid,current_room_id uuid,is_online boolean,last_seen timestamptz,age_ms bigint)
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$ SELECT * FROM private.get_online_room_presence(p_user) $$;
REVOKE ALL ON FUNCTION private.presence_session(uuid),private.claim_presence_revision(uuid,uuid,bigint,boolean),private.presence_hint() FROM PUBLIC,anon,authenticated;
DO $$ DECLARE f record; BEGIN
 FOR f IN SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname IN('public','private') AND p.proname IN('activate_room_presence','update_room_presence','deactivate_room_presence','get_room_presence','get_online_room_presence') LOOP
 EXECUTE format('REVOKE ALL ON FUNCTION %I.%I(%s) FROM PUBLIC,anon',f.nspname,f.proname,f.args);
 EXECUTE format('GRANT EXECUTE ON FUNCTION %I.%I(%s) TO authenticated',f.nspname,f.proname,f.args);
 END LOOP;
END $$;
-- 客户端 track/broadcast 不能制造可信状态；授权成员只读，发布统一经过上述 RPC。
DROP POLICY goodpuppy_room_presence_write ON realtime.messages;
