// 多窗口独立桌宠的位置记忆（localStorage）。
//
// - 自己的 pet：全局记忆上次位置，键 `pet-pos:self`。
// - 远程成员 pet：按 (房间 + 成员) 记忆，键 `pet-pos:<roomId>:<userId>`。
//
// 仅存逻辑像素的窗口左上角坐标 {x, y}。读不到 / 解析失败时返回 null，
// 由协调者退化为自动摆位。见 docs/superpowers/specs/2026-06-17-多窗口独立桌宠-phaseB-design.md。
import type { WindowPoint } from "../../types";

type OptionalStorage = Pick<Storage, "getItem" | "setItem" | "removeItem"> | null | undefined;

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
    const parsed = JSON.parse(raw) as Partial<WindowPoint> | null;
    if (!parsed || typeof parsed.x !== "number" || typeof parsed.y !== "number") return null;
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
    safeStorage(storage)?.setItem(key, JSON.stringify({ x: Math.round(point.x), y: Math.round(point.y) }));
  } catch {
    // localStorage 不可用时仅保留本会话布局。
  }
}

export function readSelfPos(storage?: OptionalStorage): WindowPoint | null {
  return readPoint(SELF_KEY, storage);
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
