import type { WindowResponse } from "./windowRequest.js";
export const ROOM_COMMAND = "room-command";
export const ROOM_CANCEL = "room-command-cancel";
export const ROOM_RESULT = "room-command-result";
export type RoomCommand = { requestId: string; replyTo: "lounge"; action: "enter" | "exit"; roomId?: string };
export type RoomResult = WindowResponse & { action: "enter" | "exit"; requestedRoomId?: string; roomId: string | null };

function roomErrorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  // PostgREST 和原生桥接可能拒绝普通对象；跨窗口前保留其中的可读消息。
  if (error && typeof error === "object" && "message" in error
    && typeof error.message === "string" && error.message.trim()) return error.message;
  return "房间操作失败，请重试";
}

export function isRoomCommand(value: unknown): value is RoomCommand {
  if (!value || typeof value !== "object") return false;
  const command = value as Record<string, unknown>;
  return typeof command.requestId === "string" && command.requestId.length > 0 && command.replyTo === "lounge"
    && (command.action === "exit" || (command.action === "enter" && typeof command.roomId === "string" && command.roomId.length > 0));
}

export async function executeRoomCommand(command: RoomCommand, deps: {
  enter: (roomId: string) => Promise<void>;
  exit: () => Promise<void>;
  sync: () => Promise<void>;
  getRoomId: () => string | null;
  getRevision: () => number;
}): Promise<RoomResult> {
  const result = { requestId: command.requestId, action: command.action, requestedRoomId: command.roomId };
  let enteredRevision: number | null = null;
  try {
    if (command.action === "enter") await deps.enter(command.roomId!);
    else await deps.exit();
    if (command.action === "enter") enteredRevision = deps.getRevision();
    await deps.sync();
    const roomId = deps.getRoomId();
    if (roomId !== (command.action === "enter" ? command.roomId : null)) throw new Error("房间操作已被新的请求取代");
    return { ...result, ok: true, roomId };
  } catch (error) {
    if (enteredRevision !== null && enteredRevision === deps.getRevision()
      && deps.getRoomId() === command.roomId) await deps.exit().catch(console.error);
    // 网络清理失败时，本地隐藏也必须收尾；原始错误仍返回给请求者。
    await deps.sync().catch(console.error);
    console.error("房间操作失败：", command.action, error);
    return { ...result, ok: false, roomId: deps.getRoomId(), error: roomErrorMessage(error) };
  }
}
