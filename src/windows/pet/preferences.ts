import { DEFAULT_SKIN } from "./animationCatalog.js";
import { clampPetScale, DEFAULT_PET_SCALE } from "./petLayout.js";

type OptionalStorage = Pick<Storage, "getItem" | "setItem"> | null | undefined;

export const SKIN_STORAGE_KEY = "goodpuppy.skin";
export const SCALE_STORAGE_KEY = "goodpuppy.scale";

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
