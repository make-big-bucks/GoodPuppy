import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('./release-version.mjs', import.meta.url));
async function fixture(work) {
  const root = await mkdtemp(path.join(tmpdir(), 'goodpuppy-version-'));
  try {
    await mkdir(path.join(root, 'src-tauri'));
    for (const [name, data] of Object.entries({
      'package.json': { version: '0.1.0' },
      'package-lock.json': { version: '0.1.0', packages: { '': { version: '0.1.0' } } },
      'src-tauri/tauri.conf.json': { version: '../package.json' },
    })) await writeFile(path.join(root, name), JSON.stringify(data));
    await writeFile(path.join(root, 'src-tauri/Cargo.toml'), '[package]\nname = "app"\nversion = "0.1.0"\n');
    await writeFile(path.join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "app"\nversion = "0.1.0"\n');
    const run = (...args) => spawnSync(process.execPath, [script, ...args, '--root', root], { encoding: 'utf8' });
    await work(root, run);
  } finally { await rm(root, { recursive: true, force: true }); }
}
test('tag must match canonical version, prefix and all lockfiles', () => fixture(async (root, run) => {
  assert.equal(run('check', '--tag', 'v0.1.0').status, 0);
  assert.equal(run('check', '--tag', 'v0.2.0').status, 1);
  assert.equal(run('check', '--tag', '0.1.0').status, 1);
  await writeFile(path.join(root, 'src-tauri/Cargo.lock'), '[[package]]\nname = "app"\nversion = "0.2.0"\n');
  assert.equal(run('check').status, 1);
}));
test('set updates package, npm lock, Cargo and Cargo lock together and is idempotent', () => fixture(async (root, run) => {
  for (let i = 0; i < 2; i++) {
    const result = run('set', '0.2.0-beta.1');
    assert.equal(result.status, 0, result.stderr);
  }
  assert.equal(run('check', '--tag', 'v0.2.0-beta.1').status, 0);
  const config = JSON.parse(await readFile(path.join(root, 'src-tauri/tauri.conf.json')));
  assert.equal(config.version, '../package.json');
}));
test('invalid versions are rejected without changing files', () => fixture(async (root, run) => {
  const before = await readFile(path.join(root, 'package.json'), 'utf8');
  assert.equal(run('set', '01.0.0').status, 1);
  assert.equal(await readFile(path.join(root, 'package.json'), 'utf8'), before);
}));
