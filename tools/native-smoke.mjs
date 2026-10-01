// 仅操作隔离标识下的窗口；启动的 Vite 由本脚本负责回收。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const devPort = 1422;
let server;
const ready = async () => {
  try { return (await fetch(`http://localhost:${devPort}/@vite/client`, { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
};
try {
  if (await ready()) throw new Error(`Native smoke port ${devPort} is already in use`);
  {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit', env: { ...process.env, DEV_PORT: String(devPort),
      VITE_BACKEND_ENV: 'test', VITE_SUPABASE_URL: 'http://127.0.0.1:54321', VITE_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_native_smoke' } });
    await new Promise(resolve => setTimeout(resolve, 250));
    const deadline = Date.now() + 15_000;
    while (!await ready()) {
      if (server.exitCode !== null || Date.now() > deadline) throw new Error('Vite did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (server.exitCode !== null) throw new Error('Native smoke Vite server exited');
  }
  const child = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'dev', '--no-watch', '--config',
    JSON.stringify({ identifier: 'com.goodpuppy.desktop.native-smoke', build: { beforeDevCommand: null, devUrl: `http://localhost:${devPort}` } })], {
    cwd: root, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, GOODPUPPY_NATIVE_SMOKE: '1' },
  });
  let passed = false;
  let quitPassed = false;
  let failed = false;
  let output = '';
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', chunk => {
      destination.write(chunk);
      output = (output + chunk.toString()).slice(-50_000);
      passed ||= output.includes('[native-smoke] PASS:');
      quitPassed ||= output.includes('[native-smoke] QUIT-PASS:');
      failed ||= output.includes('[native-smoke] FAIL:');
    });
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  process.exitCode = exit === 0 && passed && quitPassed && !failed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { server?.kill(); }
