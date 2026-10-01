import { isRoomState, type RoomState } from "../../shared/roomState.js";
type Context = { userId: string | null; signal: AbortSignal };

/** 当前房间快照的单一所有者；广播不能自行切换主窗口实例。 */
export function createRoomStateSync(deps: {
  context: () => Context;
  read: (userId: string | null, signal: AbortSignal) => Promise<RoomState>;
  changed: () => void;
  failed: (error: unknown) => void;
}) {
  let state: RoomState | null = null;
  let epoch = 0; let generation = 0;
  let latest: Promise<void> = Promise.resolve();
  function apply(next: RoomState) {
    if (state?.controllerId === next.controllerId && next.revision < state.revision) return;
    state = next; deps.changed();
  }
  function sync(): Promise<void> {
    const context = deps.context(); const scope = epoch; const readGeneration = ++generation;
    const assertCurrent = () => {
      const current = deps.context();
      if (scope !== epoch || context.signal.aborted || context.userId !== current.userId || context.signal !== current.signal)
        throw new DOMException("房间查询已失效", "AbortError");
    };
    const result = (async () => {
      try {
        const next = await deps.read(context.userId, context.signal);
        assertCurrent();
        if (readGeneration !== generation) { await latest; assertCurrent(); return; }
        if (!isRoomState(next) || next.userId !== context.userId) throw new Error("房间状态与当前账号不一致");
        apply(next);
      } catch (error) {
        assertCurrent();
        if (readGeneration !== generation) { await latest; assertCurrent(); return; }
        throw error;
      }
    })();
    latest = result; return result;
  }
  return {
    get roomId() { return state?.userId === deps.context().userId ? state?.roomId ?? null : null; },
    reset() { state = null; epoch += 1; latest = Promise.resolve(); },
    sync,
    receive(next: unknown) {
      if (!isRoomState(next) || next.userId !== deps.context().userId) return;
      if (next.controllerId !== state?.controllerId) { void sync().catch(deps.failed); return; }
      apply(next);
    },
  };
}
