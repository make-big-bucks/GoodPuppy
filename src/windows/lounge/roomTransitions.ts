export type RoomTransition = { roomId: string; type: "enter" | "exit" };

/** 房间命令的在途状态独占所有者；身份/页面重建后旧回执不更新界面。 */
export function createRoomTransitions(deps: {
  changed: () => void;
  succeeded: (transition: RoomTransition) => void;
  failed: (error: unknown) => void;
}) {
  let pending: RoomTransition | null = null;
  return {
    get pending() { return pending; },
    invalidate() {
      const changed = pending !== null;
      pending = null;
      if (changed) deps.changed();
    },
    async run(transition: RoomTransition, work: () => Promise<void>) {
      if (pending) return;
      const operation = { ...transition };
      pending = operation;
      deps.changed();
      try {
        await work();
        if (pending === operation) deps.succeeded(operation);
      } catch (error) {
        if (pending === operation) deps.failed(error);
      } finally {
        if (pending === operation) { pending = null; deps.changed(); }
      }
    },
  };
}
