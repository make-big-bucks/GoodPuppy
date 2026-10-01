"""在本机独立临时库验证业务基线、授权和事务交错，不接受远程连接。"""
import os
from pathlib import Path
import subprocess
import uuid
from urllib.parse import urlparse, urlunparse

ROOT = Path(__file__).resolve().parents[1]
base = os.environ.get('GOODPUPPY_TEST_DATABASE_URL', 'postgresql://localhost:55432/postgres')
parsed = urlparse(base)
if parsed.hostname not in ('localhost', '127.0.0.1', '::1') or parsed.password:
    raise SystemExit('Only an isolated loopback PostgreSQL server is allowed; use PGPASSWORD if necessary.')
name = 'goodpuppy_verify_' + uuid.uuid4().hex[:12]
connection = urlunparse(parsed._replace(path='/' + name))

def run(sql=None, file=None, url=None):
    args = ['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', url or connection]
    args += ['-f', str(file)] if file else ['-c', sql]
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode: raise RuntimeError(result.stderr)
    return result.stdout.strip()

def start(sql):
    return subprocess.Popen(['psql', '-X', '-At', '-v', 'ON_ERROR_STOP=1', connection, '-c', sql], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)

def finish(process, expected_success=True):
    out, error = process.communicate(timeout=15)
    if expected_success and process.returncode: raise RuntimeError(error)
    return process.returncode, out

def user(uid, operation, hold=0):
    return f"BEGIN;SET LOCAL ROLE authenticated;SELECT set_config('request.jwt.claim.sub','{uid}',true);{operation};SELECT pg_sleep({hold});COMMIT;"

A = '11111111-0000-0000-0000-000000000001'
B = '22222222-0000-0000-0000-000000000002'
room = 'aaaaaaaa-0000-0000-0000-000000000001'
created = False
try:
    run(f'CREATE DATABASE {name}', url=base)
    created = True
    run(file=ROOT / 'supabase/tests/platform.sql')
    run(file=ROOT / 'supabase/migrations/20260622134754_baseline.sql')
    for file in sorted((ROOT / 'supabase/migrations').glob('202610*.sql')): run(file=file)
    run(file=ROOT / 'supabase/tests/authorization.sql')
    print('PASS: empty database rebuild and role authorization assertions')
    run(f"INSERT INTO auth.users(id) VALUES('{A}'),('{B}');INSERT INTO public.profiles(id) SELECT id FROM auth.users;")
    run(user(A, f"SELECT public.create_room('concurrency','{room}')"))
    request = run(f"SET ROLE authenticated;SELECT set_config('request.jwt.claim.sub','{A}',false);SELECT public.invite_room_member('{room}','{B}')").splitlines()[-1]
    first = start(user(B, f"SELECT public.accept_connection('{request}')", .3))
    second = start(user(B, f"SELECT public.accept_connection('{request}')", .3))
    finish(first); finish(second)
    assert run(f"SELECT count(*) FROM public.room_members WHERE room_id='{room}'") == '2'
    first = start(user(A, f"SELECT public.leave_room('{room}')", .3))
    second = start(user(B, f"SELECT public.leave_room('{room}')", .3))
    finish(first); finish(second)
    assert run(f"SELECT count(*) FROM public.rooms WHERE id='{room}'") == '0'
    # last leave vs invite-code join: either a valid surviving member or a rejected join.
    run(user(A, f"SELECT public.create_room('join-race','{room}')"))
    code = run(f"SELECT invite_code FROM public.rooms WHERE id='{room}'")
    first = start(user(A, f"SELECT public.leave_room('{room}')", .3))
    second = start(user(B, f"SELECT public.join_room_by_invite('{code}')", .3))
    finish(first)
    join_status, _ = finish(second, expected_success=False)
    if join_status == 0:
        assert run(f"SELECT count(*) FROM public.room_members WHERE room_id='{room}' AND user_id='{B}'") == '1'
        assert run(f"SELECT count(*) FROM public.rooms WHERE id='{room}'") == '1'
    else:
        assert run(f"SELECT count(*) FROM public.rooms WHERE id='{room}'") == '0'
    print('PASS: concurrent accept, last-member leave and leave/join serialization')
finally:
    # 仅删除本次随机创建的库；连接失败时不修改其它对象。
    if created: run(f'DROP DATABASE IF EXISTS {name} WITH (FORCE)', url=base)
