/** 房间状态决定自己的宠物显隐；准备窗口与显隐串行执行，避免迟到的气泡创建覆盖退出。 */
export function createRoomVisibilityController(deps: {
  getRoomId: () => string | null;
  prepare: () => Promise<void>;
  setVisible: (visible: boolean) => Promise<void>;
  notify: (roomId: string | null) => Promise<void>;
}) {
  let pending = Promise.resolve();
  return {
    sync(): Promise<void> {
      const next = pending.then(async () => {
        if (deps.getRoomId()) await deps.prepare();
        // 准备期间可能已经退出房间，必须重新读取，不能使用进入时的状态。
        const roomId = deps.getRoomId();
        await deps.setVisible(Boolean(roomId));
        await deps.notify(roomId);
      });
      // 单次失败不阻塞后续退出/进入的显隐同步；调用者仍能收到本次错误。
      pending = next.catch(() => {});
      return next;
    },
  };
}
