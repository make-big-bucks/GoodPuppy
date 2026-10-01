// 多窗口独立桌宠的位置记忆（localStorage）。
//
// - 自己的 pet：全局记忆上次位置，键 `pet-pos:self`。
// - 远程成员 pet：按 (房间 + 成员) 记忆，键 `pet-pos:<roomId>:<userId>`。
//
// 当前存档标记平台桌面单位；macOS 可读取旧逻辑坐标，Windows 旧值缺少比例不能可靠转换。
// Windows 旧存档回退自动摆位，未知版本不会直接解释为当前坐标。
// 见 docs/reviews/coordinate-contract.md。
import type { WindowPoint } from "../../types";

type OptionalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

export const POSITION_SPACE = typeof navigator !== "undefined" && navigator.platform.startsWith("Win") ? "desktop-physical-v2" : "desktop-logical-v2";

const SELF_KEY = "pet-pos:self";

function safeStorage(storage?: OptionalStorage) {
  if (storage) return storage;
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function remotePosKey(roomId: string, userId: string) {
  return `pet-pos:${roomId}:${userId}`;
}

function readPoint(key: string, storage?: OptionalStorage): WindowPoint | null {
  try {
    const raw = safeStorage(storage)?.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as (Partial<WindowPoint> & { space?: unknown }) | null;
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
    const legacy = parsed.space === undefined || parsed.space === "window-logical-v1";
    if (parsed.space !== POSITION_SPACE && !(legacy && POSITION_SPACE === "desktop-logical-v2")) return null;
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null;
    return { x: Math.round(parsed.x), y: Math.round(parsed.y) };
  } catch {
    return null;
  }
}

function writePoint(key: string, point: WindowPoint, storage?: OptionalStorage) {
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") return;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
  try {
    safeStorage(storage)?.setItem(key, JSON.stringify({ space: POSITION_SPACE, x: Math.round(point.x), y: Math.round(point.y) }));
  } catch {
    // localStorage 不可用时仅保留本会话布局。
  }
}

function clearPoint(key: string, storage?: OptionalStorage) {
  try {
    safeStorage(storage)?.removeItem(key);
  } catch {
    // localStorage 不可用时无需清理。
  }
}

export function readSelfPos(storage?: OptionalStorage): WindowPoint | null {
  return readPoint(SELF_KEY, storage);
}

/** 清除自己 pet 的存档位置（存档落在已断开屏幕、不再可见时回退默认）。 */
export function clearSelfPos(storage?: OptionalStorage) {
  clearPoint(SELF_KEY, storage);
}

export function writeSelfPos(point: WindowPoint, storage?: OptionalStorage) {
  writePoint(SELF_KEY, point, storage);
}

export function readRemotePos(roomId: string, userId: string, storage?: OptionalStorage): WindowPoint | null {
  return readPoint(remotePosKey(roomId, userId), storage);
}

export function writeRemotePos(roomId: string, userId: string, point: WindowPoint, storage?: OptionalStorage) {
  writePoint(remotePosKey(roomId, userId), point, storage);
}

/** 清除某远程成员的存档位置（存档落在已断开屏幕、不再可见时回退自动摆位）。 */
export function clearRemotePos(roomId: string, userId: string, storage?: OptionalStorage) {
  clearPoint(remotePosKey(roomId, userId), storage);
}
