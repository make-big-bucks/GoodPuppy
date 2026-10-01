-- 本地 PostgreSQL 的最小 Supabase 平台替身；不用于生产。
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, is_anonymous boolean DEFAULT false, created_at timestamptz DEFAULT now());
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid REFERENCES auth.users(id));
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
 SELECT jsonb_build_object('session_id',coalesce(nullif(current_setting('request.jwt.claim.session_id',true),''),auth.uid()::text))
$$;
GRANT EXECUTE ON FUNCTION auth.jwt() TO authenticated;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
CREATE PUBLICATION supabase_realtime;
CREATE SCHEMA realtime;
CREATE TABLE realtime.messages (id uuid DEFAULT gen_random_uuid(), topic text, extension text, payload jsonb, event text, private boolean);
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA realtime TO authenticated;
GRANT SELECT, INSERT ON realtime.messages TO authenticated;
CREATE FUNCTION realtime.topic() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT current_setting('realtime.topic', true)
$$;

CREATE FUNCTION realtime.send(payload jsonb,event text,topic text,private boolean DEFAULT true)
RETURNS void LANGUAGE sql AS $$
  INSERT INTO realtime.messages(payload,event,topic,private,extension) VALUES(payload,event,topic,private,'broadcast')
$$;
CREATE SCHEMA cron;
CREATE TABLE cron.job(jobname text PRIMARY KEY,schedule text,command text);
CREATE FUNCTION cron.schedule(jobname text,schedule text,command text) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO cron.job VALUES(jobname,schedule,command) ON CONFLICT(jobname) DO UPDATE SET schedule=excluded.schedule,command=excluded.command RETURNING 1::bigint
$$;
