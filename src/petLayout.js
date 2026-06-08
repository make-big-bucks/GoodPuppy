export const PET_WINDOW_HEIGHT = 360;
export const BASE_PET_WINDOW_WIDTH = 260;
export const PET_SLOT_WIDTH = 220;
export const PET_STAGE_PADDING_X = 20;

export function orderRemotePetIds(userIds = []) {
  return [...new Set(userIds.filter(Boolean))].sort();
}

export function getPetWindowLayout(remotePetCount) {
  const count = Math.max(0, Number(remotePetCount) || 0);
  return {
    width: Math.max(BASE_PET_WINDOW_WIDTH, PET_STAGE_PADDING_X * 2 + (count + 1) * PET_SLOT_WIDTH),
    height: PET_WINDOW_HEIGHT,
  };
}
