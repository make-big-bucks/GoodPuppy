import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 开发配置先合并，调用方的 peer / native-smoke 配置仍可覆盖它。
const args = process.argv.slice(2);
if (args[0] === 'dev') args.splice(1, 0, '--config', 'src-tauri/tauri.dev.conf.json');
const cli = fileURLToPath(new URL('../node_modules/@tauri-apps/cli/tauri.js', import.meta.url));
const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
