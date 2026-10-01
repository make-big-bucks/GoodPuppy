import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const tasks = {
  assets: ['-m', 'unittest', 'discover', '-s', 'skills/hatch-puppy-pet/tests'],
  database: ['tools/verify-database.py'],
};
const args = tasks[process.argv[2]];
if (!args) throw new Error('Unknown Python verification task.');
const child = spawn(process.env.PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3'), args, {
  cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit',
});
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
