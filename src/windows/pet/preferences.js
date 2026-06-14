// 桌宠本地偏好（换肤 / 尺寸）读写。
// 纯本地，存 localStorage，不进 Supabase（避免 schema 变更）。
// 从 renderer.js 抽出，便于单测：所有函数接受可选 storage 注入，
// 默认用 globalThis.localStorage；存储不可用时安全降级（读取兜底默认值、写入静默忽略）。
import { DEFAULT_SKIN } from "./animationCatalog.js";
import { clampPetScale, DEFAULT_PET_SCALE } from "./petLayout.js";

export const SKIN_STORAGE_KEY = "goodpuppy.skin";
export const SCALE_STORAGE_KEY = "goodpuppy.scale";

function safeStorage(storage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readStoredSkin(storage) {
  try {
    return safeStorage(storage)?.getItem(SKIN_STORAGE_KEY) || DEFAULT_SKIN;
  } catch {
    return DEFAULT_SKIN;
  }
}

export function writeStoredSkin(skin, storage) {
  try {
    safeStorage(storage)?.setItem(SKIN_STORAGE_KEY, skin);
  } catch {
    // localStorage 不可用时仅保留本会话选择。
  }
}

export function readStoredScale(storage) {
  try {
    const raw = safeStorage(storage)?.getItem(SCALE_STORAGE_KEY);
    return raw == null ? DEFAULT_PET_SCALE : clampPetScale(parseFloat(raw));
  } catch {
    return DEFAULT_PET_SCALE;
  }
}

export function writeStoredScale(scale, storage) {
  try {
    safeStorage(storage)?.setItem(SCALE_STORAGE_KEY, String(scale));
  } catch {
    // localStorage 不可用时仅保留本会话选择。
  }
}
