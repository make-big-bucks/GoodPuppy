export const PET_WINDOW_HEIGHT = 220;
export const BASE_PET_WINDOW_WIDTH = 150;
export const PET_SLOT_WIDTH = 120;
export const PET_STAGE_PADDING_X = 15;

// 用户可调缩放：以默认大小为 1，通过右键菜单按步长增减并持久化。
// CSS 用 --pet-scale 变量缩放视觉，窗口尺寸在 getPetWindowLayout 里同步乘以缩放。
export const DEFAULT_PET_SCALE = 1;
export const MIN_PET_SCALE = 0.6;
export const MAX_PET_SCALE = 2;
export const PET_SCALE_STEP = 0.2;

export function orderRemotePetIds(userIds = []) {
  return [...new Set(userIds.filter(Boolean))].sort();
}

// 把任意输入夹到 [MIN, MAX]，并做两位小数取整以避免浮点漂移（0.6000000001）。
export function clampPetScale(scale) {
  const n = Number(scale);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PET_SCALE;
  const clamped = Math.min(MAX_PET_SCALE, Math.max(MIN_PET_SCALE, n));
  return Math.round(clamped * 100) / 100;
}

// direction: +1 放大 / -1 缩小，越界由 clamp 截停。
export function stepPetScale(scale, direction) {
  return clampPetScale(clampPetScale(scale) + Math.sign(direction) * PET_SCALE_STEP);
}

export function getPetWindowLayout(remotePetCount, scale = DEFAULT_PET_SCALE) {
  const count = Math.max(0, Number(remotePetCount) || 0);
  const s = clampPetScale(scale);
  const baseWidth = Math.max(
    BASE_PET_WINDOW_WIDTH,
    PET_STAGE_PADDING_X * 2 + (count + 1) * PET_SLOT_WIDTH
  );
  return {
    width: Math.round(baseWidth * s),
    height: Math.round(PET_WINDOW_HEIGHT * s),
  };
}
