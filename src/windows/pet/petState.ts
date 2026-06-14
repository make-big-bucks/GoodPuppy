import {
  BASE_STATE,
  DEFAULT_SKIN,
  getBehavior,
  isIdleVariant,
  durationFromManifest,
  getStateImagePath,
} from "./animationCatalog.js";
import type { PetManifest } from "../../types";

type TimerId = ReturnType<typeof setTimeout> | number;

type TimerApi = {
  set: (fn: () => void, ms: number) => TimerId;
  clear: (id: TimerId) => void;
};

type TransientState = {
  name: string;
  kind: "oneshot" | "held";
  mirrored: boolean;
};

type OnStateMeta = {
  mirrored: boolean;
};

type OnStateCallback = (stateName: string, imagePath: string, meta: OnStateMeta) => void;

type PetAnimatorOptions = {
  petId?: string;
  skin?: string;
  manifest?: PetManifest | null;
  onState?: OnStateCallback;
  autoCycle?: boolean;
  timers?: TimerApi;
  random?: () => number;
};

type PlayTransientOptions = {
  durationMs?: number;
  mirrored?: boolean;
};

const DEFAULT_TIMERS: TimerApi = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id),
};

export class PetAnimator {
  petId: string;
  skin: string;
  manifest: PetManifest | null;
  onState: OnStateCallback;
  autoCycle: boolean;
  timers: TimerApi;
  random: () => number;
  base: string;
  status: string | null;
  transient: TransientState | null;
  variants: string[];
  shown: string | null;
  reloadToken: number;
  private forceReload: boolean;
  private transientTimer: TimerId | null;
  private cycleTimer: TimerId | null;

  constructor({
    petId = "default",
    skin = DEFAULT_SKIN,
    manifest = null,
    onState = () => {},
    autoCycle = true,
    timers = DEFAULT_TIMERS,
    random = Math.random,
  }: PetAnimatorOptions = {}) {
    this.petId = petId;
    this.skin = skin || DEFAULT_SKIN;
    this.manifest = manifest;
    this.onState = onState;
    this.autoCycle = autoCycle;
    this.timers = timers;
    this.random = random;

    this.base = BASE_STATE;
    this.status = null;
    this.transient = null;
    this.variants = this.collectVariants(manifest);

    this.shown = null;
    this.reloadToken = 0;
    this.forceReload = false;
    this.transientTimer = null;
    this.cycleTimer = null;

    this.applyRender();
    if (this.autoCycle) this.startCycle();
  }

  private collectVariants(manifest: PetManifest | null) {
    return Object.keys(manifest?.states || {}).filter(isIdleVariant);
  }

  resolve() {
    if (this.transient) return this.transient.name;
    if (this.status) return this.status;
    return this.base;
  }

  applyRender() {
    const next = this.resolve();
    if (next === this.shown && !this.forceReload) return;
    this.shown = next;
    let path = getStateImagePath(this.petId, next, this.skin);
    if (this.forceReload) {
      path += `?r=${++this.reloadToken}`;
      this.forceReload = false;
    }
    const mirrored = Boolean(this.transient && next === this.transient.name && this.transient.mirrored);
    this.onState(next, path, { mirrored });
  }

  setPetId(petId: string) {
    if (petId === this.petId) return;
    this.petId = petId;
    this.forceReload = true;
    this.applyRender();
  }

  setSkin(skin: string | null | undefined) {
    const next = skin || DEFAULT_SKIN;
    if (next === this.skin) return;
    this.skin = next;
    this.forceReload = true;
    this.applyRender();
  }

  setManifest(manifest: PetManifest | null) {
    this.manifest = manifest;
    this.variants = this.collectVariants(manifest);
    if (this.base !== BASE_STATE && !this.variants.includes(this.base)) {
      this.base = BASE_STATE;
      this.applyRender();
    }
    if (this.autoCycle) this.startCycle();
  }

  setStatus(name: string | null) {
    const valid = name == null || getBehavior(name)?.kind === "status";
    const next = valid ? name : null;
    if (next === this.status) return;
    this.status = next;
    this.applyRender();
  }

  setHeld(name: string | null) {
    if (name == null) {
      if (this.transient?.kind === "held") {
        this.transient = null;
        this.applyRender();
      }
      return;
    }
    if (getBehavior(name)?.kind !== "held") return;
    this.clearTransientTimer();
    this.transient = { name, kind: "held", mirrored: false };
    this.applyRender();
  }

  playTransient(name: string, { durationMs, mirrored = false }: PlayTransientOptions = {}) {
    const behavior = getBehavior(name);
    if (!behavior || (behavior.kind !== "oneshot" && behavior.kind !== "held")) {
      return;
    }
    this.clearTransientTimer();
    this.transient = { name, kind: "oneshot", mirrored: Boolean(mirrored) };
    this.forceReload = true;
    this.applyRender();

    const ms = durationMs ?? durationFromManifest(this.manifest?.states?.[name]);
    this.transientTimer = this.timers.set(() => {
      this.transientTimer = null;
      if (this.transient?.name === name && this.transient.kind === "oneshot") {
        this.transient = null;
        this.applyRender();
      }
    }, ms);
  }

  private clearTransientTimer() {
    if (this.transientTimer != null) {
      this.timers.clear(this.transientTimer);
      this.transientTimer = null;
    }
  }

  startCycle() {
    this.stopCycle();
    this.scheduleNextCycle();
  }

  stopCycle() {
    if (this.cycleTimer != null) {
      this.timers.clear(this.cycleTimer);
      this.cycleTimer = null;
    }
  }

  private scheduleNextCycle() {
    if (this.variants.length === 0) return;
    const onIdle = this.base === BASE_STATE;
    const delay = onIdle
      ? 6000 + this.random() * 8000
      : durationFromManifest(this.manifest?.states?.[this.base]);
    this.cycleTimer = this.timers.set(() => {
      this.base = onIdle ? this.pickVariant() : BASE_STATE;
      if (this.base !== BASE_STATE && this.resolve() === this.base) this.forceReload = true;
      this.applyRender();
      this.scheduleNextCycle();
    }, delay);
  }

  private pickVariant() {
    return this.variants[Math.floor(this.random() * this.variants.length)] || BASE_STATE;
  }

  destroy() {
    this.clearTransientTimer();
    this.stopCycle();
    this.onState = () => {};
  }
}
