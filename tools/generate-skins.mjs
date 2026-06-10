// 离线皮肤生成器：从一套基础 GIF（橙色 shiba）派生出多套换肤变体。
//
// 原理：基础动画是索引调色板像素图，毛色集中在一段橙色色相里。脚本逐帧解码成
// RGBA，对「属于毛色的像素」（色相落在 fur 区间且饱和度足够）在 HSL 空间里只改
// 饱和度/明度、尽量保留相对明暗，于是毛色的高光阴影层次得以保留；鼻子、黑描边、
// 白色高光因饱和度低被自动排除。再用 gifenc 重新编码，沿用原帧时长，保留透明。
//
// 用法：node tools/generate-skins.mjs [petDir=shiba] [state1 state2 ...]
//   不带 state 参数则处理 pet.json 里全部状态。
// 输出：public/pets/<petDir>/skins/<skinId>/<state>.gif
//
// 这是构建期工具，不进运行时。动画更新后重跑即可。

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseGIF, decompressFrames } from "gifuct-js";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ── HSL 互转（h:0-360, s/l:0-1）──────────────────────────────
function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  h /= 360;
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hk = (t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [
    Math.round(hk(h + 1 / 3) * 255),
    Math.round(hk(h) * 255),
    Math.round(hk(h - 1 / 3) * 255),
  ];
}

function applyChannel(value, cfg) {
  if (!cfg) return value;
  let v = value;
  if (cfg.set !== undefined) v = cfg.set;
  if (cfg.mul !== undefined) v *= cfg.mul;
  if (cfg.add !== undefined) v += cfg.add;
  return Math.max(0, Math.min(1, v));
}

// 判定一个颜色是否「属于毛色色相」（色相区间 + 饱和度下限）。
function inFurHue(r, g, b, fur) {
  const [h, s] = rgbToHsl(r, g, b);
  return h >= fur.hueMin && h <= fur.hueMax && s >= fur.satMin;
}

// 从「无道具」的参考状态采集真正的狗毛颜色集合。道具（门/食盆）只出现在
// feed/enter/leave，不会进入参考集；于是 recolor 时按「颜色是否接近狗毛集合」
// 二次过滤，就能放过和狗毛同色相但不属于狗身的道具像素。
function buildFurReference(petRoot, fur, refStates) {
  const ref = []; // [[r,g,b], ...]
  const seen = new Set();
  for (const state of refStates) {
    let buf;
    try { buf = readFileSync(join(petRoot, `${state}.gif`)); } catch { continue; }
    const { frames } = buildFullFrames(buf);
    for (const f of frames) {
      const px = f.rgba;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i + 3] === 0) continue;
        const r = px[i], g = px[i + 1], b = px[i + 2];
        const key = (r << 16) | (g << 8) | b;
        if (seen.has(key)) continue;
        seen.add(key);
        if (inFurHue(r, g, b, fur)) ref.push([r, g, b]);
      }
    }
  }
  return ref;
}

// 颜色到参考集的最近欧氏距离是否在容差内（带 packed-rgb 决策缓存）。
function makeFurMatcher(ref, tolerance) {
  const tol2 = tolerance * tolerance;
  const cache = new Map();
  return (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let hit = false;
    for (const [rr, gg, bb] of ref) {
      const dr = r - rr, dg = g - gg, db = b - bb;
      if (dr * dr + dg * dg + db * db <= tol2) { hit = true; break; }
    }
    cache.set(key, hit);
    return hit;
  };
}

// 对一帧 RGBA 原地重着色。仅命中「毛色色相 且 接近参考毛色集合」的像素。
function recolorFrame(rgba, fur, skin, isFur) {
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i + 3] === 0) continue;
    const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
    if (!inFurHue(r, g, b, fur)) continue;
    if (!isFur(r, g, b)) continue; // 道具像素（门/食盆）被放过
    const [h, s, l] = rgbToHsl(r, g, b);
    const nh = skin.hue && skin.hue.set !== undefined ? skin.hue.set : h;
    const ns = applyChannel(s, skin.sat);
    const nl = applyChannel(l, skin.light);
    const [nr, ng, nb] = hslToRgb(nh, ns, nl);
    rgba[i] = nr; rgba[i + 1] = ng; rgba[i + 2] = nb;
  }
}

// 把 gifuct 的逐帧 patch 按 disposal 合成为整画布全帧序列。
function buildFullFrames(buf) {
  const gif = parseGIF(new Uint8Array(buf));
  const frames = decompressFrames(gif, true);
  const W = gif.lsd.width, H = gif.lsd.height;
  const canvas = new Uint8ClampedArray(W * H * 4); // 透明背景
  const out = [];
  for (const frame of frames) {
    const before = frame.disposalType === 3 ? canvas.slice() : null;
    const { left, top, width, height } = frame.dims;
    const patch = frame.patch; // RGBA，透明像素 alpha=0
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pi = (y * width + x) * 4;
        if (patch[pi + 3] === 0) continue; // 透明：保留画布下层
        const ci = ((top + y) * W + (left + x)) * 4;
        canvas[ci] = patch[pi];
        canvas[ci + 1] = patch[pi + 1];
        canvas[ci + 2] = patch[pi + 2];
        canvas[ci + 3] = patch[pi + 3];
      }
    }
    out.push({ rgba: canvas.slice(), delay: frame.delay || 100 });
    // 为下一帧应用 disposal
    if (frame.disposalType === 2) {
      const ci0 = (top * W + left) * 4;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const ci = ci0 + (y * W + x) * 4;
          canvas[ci] = canvas[ci + 1] = canvas[ci + 2] = canvas[ci + 3] = 0;
        }
      }
    } else if (frame.disposalType === 3 && before) {
      canvas.set(before);
    }
  }
  return { W, H, frames: out };
}

function encodeGif({ W, H, frames }) {
  const enc = GIFEncoder();
  for (const f of frames) {
    const palette = quantize(f.rgba, 256, { format: "rgba4444" });
    const index = applyPalette(f.rgba, palette, "rgba4444");
    enc.writeFrame(index, W, H, {
      palette,
      delay: f.delay,
      transparent: true,
      dispose: 2,
    });
  }
  enc.finish();
  return Buffer.from(enc.bytes());
}

// ── 主流程 ───────────────────────────────────────────────────
const petDir = process.argv[2] || "shiba";
const stateArgs = process.argv.slice(3);
const petRoot = join(ROOT, "public", "pets", petDir);
const config = JSON.parse(readFileSync(join(__dirname, "skins.json"), "utf8"));
const fur = config.fur;

let states = stateArgs;
if (states.length === 0) {
  states = readdirSync(petRoot)
    .filter((f) => f.endsWith(".gif"))
    .map((f) => f.replace(/\.gif$/, ""));
}

// 参考集：从无道具状态采集真正的狗毛颜色，供 recolor 时排除道具像素。
const refStates = (fur.referenceStates || ["idle"]).filter((s) => {
  try { readFileSync(join(petRoot, `${s}.gif`)); return true; } catch { return false; }
});
const furRef = buildFurReference(petRoot, fur, refStates);
const isFur = makeFurMatcher(furRef, fur.tolerance ?? 24);
console.log(`参考集：${refStates.length} 个状态，${furRef.length} 种毛色，容差 ${fur.tolerance ?? 24}`);

for (const skin of config.skins) {
  const outDir = join(petRoot, "skins", skin.id);
  mkdirSync(outDir, { recursive: true });
  for (const state of states) {
    const src = join(petRoot, `${state}.gif`);
    let buf;
    try {
      buf = readFileSync(src);
    } catch {
      console.warn(`  skip ${state}: 缺少 ${src}`);
      continue;
    }
    const full = buildFullFrames(buf);
    for (const f of full.frames) recolorFrame(f.rgba, fur, skin, isFur);
    const bytes = encodeGif(full);
    writeFileSync(join(outDir, `${state}.gif`), bytes);
    process.stdout.write(`  ${skin.id}/${state}.gif (${full.frames.length}f, ${(bytes.length / 1024).toFixed(1)}KB)\n`);
  }
  console.log(`✓ skin "${skin.id}" → ${outDir}`);
}
