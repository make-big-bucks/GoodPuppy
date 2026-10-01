import { requestWindow, type RequestTransport, type WindowResponse } from "./windowRequest.js";
export const ROOM_STATE_QUERY = "room-state-query";
export const ROOM_STATE_RESULT = "room-state-result";
export type RoomState = { controllerId: string; userId: string | null; roomId: string | null; revision: number };
export type RoomStateRequest = { requestId: string; replyTo: "lounge"; userId: string | null };
export function isRoomStateRequest(value: unknown): value is RoomStateRequest {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.requestId === "string" && p.requestId.length > 0 && p.replyTo === "lounge"
    && (p.userId === null || typeof p.userId === "string");
}
export function isRoomState(value: unknown): value is RoomState {
  if (!value || typeof value !== "object") return false;
  const p = value as Record<string, unknown>;
  return typeof p.controllerId === "string" && p.controllerId.length > 0
    && (p.userId !== null || p.roomId === null) && (p.userId === null || typeof p.userId === "string") && (p.roomId === null || typeof p.roomId === "string")
    && typeof p.revision === "number" && Number.isSafeInteger(p.revision) && p.revision >= 0;
}
export async function requestRoomState(transport: RequestTransport, userId: string | null, signal: AbortSignal) {
  const state = await requestWindow<WindowResponse & RoomState>(transport, {
    target: "main", requestEvent: ROOM_STATE_QUERY, responseEvent: ROOM_STATE_RESULT,
    payload: { replyTo: "lounge", userId }, signal,
  });
  if (!isRoomState(state) || state.userId !== userId) throw new Error("房间状态与当前账号不一致");
  return state;
}
