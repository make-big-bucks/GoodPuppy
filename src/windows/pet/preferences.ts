import { DEFAULT_SKIN } from "./animationCatalog.js";
import { clampPetScale, DEFAULT_PET_SCALE } from "./petLayout.js";

type OptionalStorage = Pick<Storage, "getItem" | "setItem"> | null | undefined;

export const SKIN_STORAGE_KEY = "goodpuppy.skin";
export const SCALE_STORAGE_KEY = "goodpuppy.scale";
export const PET_MODE_STORAGE_KEY = "goodpuppy.petMode";

/** 多窗口摆放模式：
 * - "free" 完全自由：每只 pet 各自可拖、记忆位置（默认）。
 * - "semi" 半自由：远程 pet 自动一字排开、不可单独拖；自己的 pet 仍可拖。 */
export type PetMode = "free" | "semi";
export const DEFAULT_PET_MODE: PetMode = "free";

function safeStorage(storage?: OptionalStorage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredSkin(storage?: OptionalStorage) {
  try {
    return safeStorage(storage)?.getItem(SKIN_STORAGE_KEY) || DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

export function writeStoredSkin(skin: string, storage?: OptionalStorage) {
  try {
    safeStorage(storage)?.setItem(SKIN_STORAGE_KEY, skin);
  } catch {
    // localStorage 不可用时仅保留本会话选择。
  }
}

export function readStoredScale(storage?: OptionalStorage) {
  try {
    const raw = safeStorage(storage)?.getItem(SCALE_STORAGE_KEY);
    return raw == null ? DEFAULT_PET_SCALE : clampPetScale(parseFloat(raw));
  } catch {
    return DEFAULT_PET_SCALE;
  }
}

export function writeStoredScale(scale: number, storage?: OptionalStorage) {
  try {
    safeStorage(storage)?.setItem(SCALE_STORAGE_KEY, String(scale));
  } catch {
    // localStorage 不可用时仅保留本会话选择。
  }
}

export function readStoredMode(storage?: OptionalStorage): PetMode {
  try {
    const raw = safeStorage(storage)?.getItem(PET_MODE_STORAGE_KEY);
    return raw === "semi" || raw === "free" ? raw : DEFAULT_PET_MODE;
  } catch {
    return DEFAULT_PET_MODE;
  }
}

export function writeStoredMode(mode: PetMode, storage?: OptionalStorage) {
  try {
    safeStorage(storage)?.setItem(PET_MODE_STORAGE_KEY, mode);
  } catch {
    // localStorage 不可用时仅保留本会话选择。
  }
}
