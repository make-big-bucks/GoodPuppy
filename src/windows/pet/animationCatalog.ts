import type { PetManifest, PetManifestSkin, PetManifestState } from "../../types";

export const LAYER = Object.freeze({
  BASE: 0,
  STATUS: 1,
  TRANSIENT: 2,
});

export const STATE_BEHAVIOR = Object.freeze({
  idle: { layer: LAYER.BASE, kind: "base" },
  happy: { layer: LAYER.STATUS, kind: "status" },
  sad: { layer: LAYER.STATUS, kind: "status" },
  busy: { layer: LAYER.STATUS, kind: "status" },
  bored: { layer: LAYER.STATUS, kind: "status" },
  "drag-lift": { layer: LAYER.TRANSIENT, kind: "held" },
  message: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  cuddle: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  cast: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  feed: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  kicked: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  enter: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  greet: { layer: LAYER.TRANSIENT, kind: "oneshot" },
  leave: { layer: LAYER.TRANSIENT, kind: "oneshot" },
});

export const BASE_STATE = "idle";

const IDLE_VARIANT_PATTERN = /^idle-[a-z][a-z-]*$/;
const IDLE_VARIANT_BEHAVIOR = Object.freeze({ layer: LAYER.BASE, kind: "variant" });

export const STATUS_OPTIONS = Object.freeze([
  { value: "happy", label: "开心", group: "mood" },
  { value: "sad", label: "难过", group: "mood" },
  { value: "busy", label: "忙碌", group: "work" },
  { value: "bored", label: "无聊", group: "work" },
]);

export const INTERACTIONS = Object.freeze({
  cuddle: {
    actorState: "cuddle",
    targetState: "cuddle",
    mirror: "facing",
    holdMs: 3000,
    label: "贴贴",
  },
  feed: { actorState: "cast", targetState: "feed", label: "喂食" },
  kick: { actorState: "cast", targetState: "kicked", label: "踢飞" },
});

const PET_REGISTRY = Object.freeze({
  default: "shiba",
  shiba: "shiba",
});

export const DEFAULT_PET = "shiba";
export const DEFAULT_SKIN = "default";
export const DEFAULT_ONESHOT_MS = 900;

type PetId = keyof typeof PET_REGISTRY | (string & {});
type KnownStateName = keyof typeof STATE_BEHAVIOR;
type Behavior = (typeof STATE_BEHAVIOR)[KnownStateName] | typeof IDLE_VARIANT_BEHAVIOR;

function hasOwnKey<T extends object>(obj: T, key: PropertyKey): key is keyof T {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

export function isIdleVariant(stateName: string | null | undefined) {
  return typeof stateName === "string" && IDLE_VARIANT_PATTERN.test(stateName);
}

export function resolvePetDir(petId: PetId) {
  return hasOwnKey(PET_REGISTRY, petId) ? PET_REGISTRY[petId] : DEFAULT_PET;
}

export function getStateImagePath(petId: PetId, stateName: string, skin = DEFAULT_SKIN) {
  const dir = resolvePetDir(petId);
  if (skin && skin !== DEFAULT_SKIN) {
    return `/pets/${dir}/skins/${skin}/${stateName}.gif`;
  }
  return `/pets/${dir}/${stateName}.gif`;
}

export function isStatusState(stateName: string) {
  return hasOwnKey(STATE_BEHAVIOR, stateName) && STATE_BEHAVIOR[stateName].kind === "status";
}

export function getBehavior(stateName: string | null | undefined): Behavior | null {
  if (!stateName) return null;
  if (hasOwnKey(STATE_BEHAVIOR, stateName)) {
    return STATE_BEHAVIOR[stateName];
  }
  if (isIdleVariant(stateName)) return IDLE_VARIANT_BEHAVIOR;
  return null;
}

export function durationFromManifest(manifestState?: PetManifestState | null) {
  if (!manifestState || !Array.isArray(manifestState.durationsMs)) {
    return DEFAULT_ONESHOT_MS;
  }
  const total = manifestState.durationsMs.reduce((sum: number, ms: number) => sum + (Number(ms) || 0), 0);
  return total > 0 ? total : DEFAULT_ONESHOT_MS;
}

const manifestCache = new Map<string, PetManifest>();

export async function loadPetManifest(
  petId: PetId,
  { fetchImpl = fetch }: { fetchImpl?: typeof fetch } = {},
): Promise<PetManifest> {
  const dir = resolvePetDir(petId);
  if (manifestCache.has(dir)) return manifestCache.get(dir)!;

  let manifest: PetManifest = { id: dir, states: {}, skins: [] };
  try {
    const res = await fetchImpl(`/pets/${dir}/pet.json`);
    if (res.ok) {
      const json = (await res.json()) as {
        id?: string;
        states?: PetManifestState[];
        skins?: Array<Partial<PetManifestSkin> | null | undefined>;
      };
      const states: Record<string, PetManifestState> = {};
      for (const state of json.states || []) {
        if (state?.state) states[state.state] = state;
      }
      const skins = (json.skins || [])
        .filter((skin): skin is Partial<PetManifestSkin> & { id: string } => Boolean(skin?.id && skin.id !== DEFAULT_SKIN))
        .map((skin) => ({ id: skin.id, label: skin.label || skin.id }));
      manifest = { id: json.id || dir, states, skins };
    }
  } catch {
    // 网络/解析失败：留空 states，使用兜底时长。
  }
  manifestCache.set(dir, manifest);
  return manifest;
}
