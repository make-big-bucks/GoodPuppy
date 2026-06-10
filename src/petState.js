// 宠物状态机：每只 pet（self + 每个 remote）一个 PetAnimator 实例。
//
// 三层优先级模型，任一时刻只渲染一个状态：
//   瞬时层 (transient) > 状态层 (status) > 基础层 (base)
// 瞬时层分两种：一次性 (oneshot) 播完自动清除；按住型 (held) 外部解除前持续。
// 状态层是单槽互斥（情绪 / 工作抢一个槽，后设的赢，null 即回落到基础层）。
// 基础层常驻 idle；若 pet.json 声明了 idle-* 变体，则 idle 停留一段时间后
// 随机播一个变体再回到 idle，营造 per-pet 的「鲜活」表现。没有变体就纯 idle。

import {
  BASE_STATE,
  getBehavior,
  isIdleVariant,
  durationFromManifest,
  getStateImagePath,
} from "./animationCatalog.js";

// 包一层箭头函数：直接传 setTimeout/clearTimeout 引用，作为 timers.set(...) 调用时
// 浏览器会因 this 不是 window 抛 "Illegal invocation"。
const DEFAULT_TIMERS = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
};

export class PetAnimator {
  // onState(stateName, imagePath) 在解算出的当前状态变化时被调用，由调用方换 img.src。
  constructor({
    petId = "default",
    manifest = null,
    onState = () => {},
    autoCycle = true,
    timers = DEFAULT_TIMERS,
    random = Math.random,
  } = {}) {
    this.petId = petId;
    this.manifest = manifest;
    this.onState = onState;
    this.autoCycle = autoCycle;
    this.timers = timers;
    this.random = random;

    this.base = BASE_STATE;
    this.status = null;
    this.transient = null; // { name, kind, mirrored }
    this.variants = this._collectVariants(manifest);

    this.shown = null;
    this.reloadToken = 0;
    this._forceReload = false;
    this._transientTimer = null;
    this._cycleTimer = null;

    this.applyRender();
    if (this.autoCycle) this.startCycle();
  }

  _collectVariants(manifest) {
    return Object.keys(manifest?.states || {}).filter(isIdleVariant);
  }

  // 解算当前应渲染的状态。
  resolve() {
    if (this.transient) return this.transient.name;
    if (this.status) return this.status;
    return this.base;
  }

  applyRender() {
    const next = this.resolve();
    if (next === this.shown && !this._forceReload) return;
    this.shown = next;
    let path = getStateImagePath(this.petId, next);
    if (this._forceReload) {
      path += `?r=${++this.reloadToken}`;
      this._forceReload = false;
    }
    const mirrored = Boolean(this.transient && next === this.transient.name && this.transient.mirrored);
    this.onState(next, path, { mirrored });
  }

  setPetId(petId) {
    if (petId === this.petId) return;
    this.petId = petId;
    this._forceReload = true;
    this.applyRender();
  }

  setManifest(manifest) {
    this.manifest = manifest;
    this.variants = this._collectVariants(manifest);
    // 当前停在的变体已不存在于新 manifest：回落到 idle。
    if (this.base !== BASE_STATE && !this.variants.includes(this.base)) {
      this.base = BASE_STATE;
      this.applyRender();
    }
    if (this.autoCycle) this.startCycle();
  }

  // ── 状态层（持续，单槽互斥）─────────────────────────────────
  setStatus(name) {
    const valid = name == null || getBehavior(name)?.kind === "status";
    const next = valid ? name : null;
    if (next === this.status) return;
    this.status = next;
    this.applyRender();
  }

  // ── 瞬时层：按住型（如拖动）─────────────────────────────────
  setHeld(name) {
    if (name == null) {
      if (this.transient?.kind === "held") {
        this.transient = null;
        this.applyRender();
      }
      return;
    }
    if (getBehavior(name)?.kind !== "held") return;
    this._clearTransientTimer();
    this.transient = { name, kind: "held", mirrored: false };
    this.applyRender();
  }

  // ── 瞬时层：一次性，播完自动清除 ────────────────────────────
  // mirrored=true 时 onState 的 meta 携带镜像标记（如双向贴贴的朝向翻转）。
  playTransient(name, { durationMs, mirrored = false } = {}) {
    const behavior = getBehavior(name);
    if (!behavior || (behavior.kind !== "oneshot" && behavior.kind !== "held")) {
      return;
    }
    this._clearTransientTimer();
    this.transient = { name, kind: "oneshot", mirrored: Boolean(mirrored) };
    this._forceReload = true; // 同状态连播也从首帧重新开始
    this.applyRender();

    const ms = durationMs ?? durationFromManifest(this.manifest?.states?.[name]);
    this._transientTimer = this.timers.set(() => {
      this._transientTimer = null;
      if (this.transient?.name === name && this.transient.kind === "oneshot") {
        this.transient = null;
        this.applyRender();
      }
    }, ms);
  }

  _clearTransientTimer() {
    if (this._transientTimer != null) {
      this.timers.clear(this._transientTimer);
      this._transientTimer = null;
    }
  }

  // ── 基础层自主循环 ──────────────────────────────────────────
  startCycle() {
    this.stopCycle();
    this._scheduleNextCycle();
  }

  stopCycle() {
    if (this._cycleTimer != null) {
      this.timers.clear(this._cycleTimer);
      this._cycleTimer = null;
    }
  }

  _scheduleNextCycle() {
    // 没有变体就不起定时器（纯 idle）；setManifest 注入变体后会重启循环。
    if (this.variants.length === 0) return;
    const onIdle = this.base === BASE_STATE;
    // idle 停留 6-14s 后随机播一个变体；变体时长来自 manifest（一次性，播完回 idle）。
    const delay = onIdle
      ? 6000 + this.random() * 8000
      : durationFromManifest(this.manifest?.states?.[this.base]);
    this._cycleTimer = this.timers.set(() => {
      this.base = onIdle ? this._pickVariant() : BASE_STATE;
      // 变体多为一次性 GIF：同名连播也要从首帧重新开始。
      // 仅在基础层实际可见时强刷，避免重启正在播放的上层动画。
      if (this.base !== BASE_STATE && this.resolve() === this.base) this._forceReload = true;
      this.applyRender();
      this._scheduleNextCycle();
    }, delay);
  }

  _pickVariant() {
    return this.variants[Math.floor(this.random() * this.variants.length)] || BASE_STATE;
  }

  destroy() {
    this._clearTransientTimer();
    this.stopCycle();
    this.onState = () => {};
  }
}
