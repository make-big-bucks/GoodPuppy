import type { RoomResult } from "../../shared/roomProtocol.js";

/** 房间操作的跨窗口客户端；回执与最新快照均确认后才触发窗口副作用。 */
export function createRoomCommandClient(deps: {
  context: () => { userId: string | null; signal: AbortSignal };
  request: (action: "enter" | "exit", roomId: string | undefined, signal: AbortSignal) => Promise<RoomResult>;
  synchronize: () => Promise<void>;
  currentRoom: () => string | null;
  entered: () => Promise<void>;
}) {
  return {
    async change(action: "enter" | "exit", roomId?: string) {
      const context = deps.context();
      const assertCurrent = () => {
        const current = deps.context();
        if (context.signal.aborted || context.signal !== current.signal || context.userId !== current.userId)
          throw new DOMException("账号已改变", "AbortError");
      };
      assertCurrent();
      const result = await deps.request(action, roomId, context.signal);
      assertCurrent();
      if (!result.ok) throw new Error(result.error || "房间操作失败");
      if (result.action !== action || result.requestedRoomId !== roomId
        || result.roomId !== (action === "enter" ? roomId : null)) throw new Error("房间回复与请求不一致");
      await deps.synchronize(); assertCurrent();
      if (deps.currentRoom() !== result.roomId) throw new Error("房间状态已发生变化，请重试");
      if (action === "enter") await deps.entered();
    },
  };
}
