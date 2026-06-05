export const stateCount = 24;

export function getSafeState(stateNumber, fallback = 3) {
  return Number.isInteger(stateNumber) && stateNumber >= 1 && stateNumber <= stateCount
    ? stateNumber
    : fallback;
}
