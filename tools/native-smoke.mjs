// 仅操作隔离标识下的窗口；启动的 Vite 由本脚本负责回收。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let server;
const ready = async () => {
  try { return (await fetch('http://localhost:1420/@vite/client', { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
};
try {
  if (!await ready()) {
    server = spawn(process.execPath, ['node_modules/vite/bin/vite.js'], { cwd: root, stdio: 'inherit' });
    const deadline = Date.now() + 15_000;
    while (!await ready()) {
      if (server.exitCode !== null || Date.now() > deadline) throw new Error('Vite did not start');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  const child = spawn(process.execPath, ['node_modules/@tauri-apps/cli/tauri.js', 'dev', '--no-watch', '--config',
    JSON.stringify({ identifier: 'com.goodpuppy.desktop.native-smoke', build: { beforeDevCommand: null } })], {
    cwd: root, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, GOODPUPPY_NATIVE_SMOKE: '1' },
  });
  let passed = false;
  let failed = false;
  let output = '';
  for (const [stream, destination] of [[child.stdout, process.stdout], [child.stderr, process.stderr]]) {
    stream.on('data', chunk => {
      destination.write(chunk);
      output = (output + chunk.toString()).slice(-50_000);
      passed ||= output.includes('[native-smoke] PASS:');
      failed ||= output.includes('[native-smoke] FAIL:');
    });
  }
  const exit = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => resolve(code ?? 1));
  });
  process.exitCode = exit === 0 && passed && !failed ? 0 : 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally { server?.kill(); }
