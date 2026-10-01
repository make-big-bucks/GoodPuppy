import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this verifier with npm run verify.');
const run = (command, args) => new Promise((resolve, reject) => {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${command} exited with ${code}`)));
});
try {
  for (const script of ['check:dependencies', 'build', 'test', 'test:rust', 'test:assets']) await run(process.execPath, [npm, 'run', script]);
  // 原生桌面与数据库检查需要明确环境，分别由 test:native / test:db 执行。
} catch (error) { console.error(error); process.exitCode = 1; }
