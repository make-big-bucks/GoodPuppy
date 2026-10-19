import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = join(root, 'design/icons');
const output = join(root, 'src-tauri/icons');
const scratch = mkdtempSync(join(tmpdir(), 'goodpuppy-icons-'));
// 与旧版粉色爪印保持一致；小尺寸托盘使用无描边的简化轮廓。
const paw = `<ellipse cx="350" cy="335" rx="70" ry="98" transform="rotate(-18 350 335)"/>
<ellipse cx="555" cy="310" rx="70" ry="98" transform="rotate(10 555 310)"/>
<ellipse cx="205" cy="490" rx="66" ry="88" transform="rotate(-38 205 490)"/>
<ellipse cx="740" cy="445" rx="66" ry="88" transform="rotate(30 740 445)"/>
<path d="M 295 677 C 290 607 363 566 407 515 C 448 468 509 461 556 500 C 609 546 718 563 733 638 C 749 718 668 746 595 747 C 522 748 490 819 415 799 C 352 783 298 747 295 677 Z"/>`;
const svg = body => `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">${body}</svg>\n`;
mkdirSync(source, { recursive: true });
const app = svg(`<rect x="64" y="64" width="896" height="896" rx="204" fill="#fff2f6"/><g fill="#df87ae" stroke="#fff" stroke-width="24" stroke-linejoin="round">${paw}</g>`);
const template = svg(`<g fill="#000" transform="translate(-26 -80) translate(512 512) scale(1.12) translate(-512 -512)">${paw}</g>`);
const tray = svg(`<g fill="#e897ba" stroke="#fff" stroke-width="38" stroke-linejoin="round" transform="translate(-26 -80) translate(512 512) scale(1.12) translate(-512 -512)">${paw}</g>`);
function generate(input, target, sizes = []) {
  const args = [join(root, 'node_modules/@tauri-apps/cli/tauri.js'), 'icon', input, '--output', target];
  for (const size of sizes) args.push('--png', String(size));
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`图标生成失败：${input}`);
}
try {
  for (const [name, data] of [['app', app], ['tray-template', template], ['tray-windows', tray]]) {
    writeFileSync(join(source, `${name}.svg`), data);
  }
  generate(join(source, 'app.svg'), scratch);
  // 只复制桌面资源，不把移动端产物写进仓库。
  const { readdirSync } = await import('node:fs');
  for (const file of readdirSync(scratch, { withFileTypes: true })) {
    if (file.isFile()) copyFileSync(join(scratch, file.name), join(output, file.name));
  }
  for (const [name, sizes] of [['tray-template', [22, 44]], ['tray-windows', [16, 20, 24, 32, 40, 48, 64]]]) {
    const target = join(scratch, name);
    generate(join(source, `${name}.svg`), target, sizes);
    for (const size of sizes) copyFileSync(join(target, `${size}x${size}.png`), join(output, `${name}-${size}.png`));
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
