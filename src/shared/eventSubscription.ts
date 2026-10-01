export type EventSubscription = (() => void) & { ready: Promise<void> };

/** 取消先于异步注册完成时，也必须释放后来取得的监听器。 */
export function createEventSubscription<T>(
  register: (callback: (payload: T) => void) => Promise<() => void>,
  callback: (payload: T) => void,
): EventSubscription {
  let disposed = false;
  let release: (() => void) | null = null;
  const dispose = (() => {
    disposed = true;
    release?.();
    release = null;
  }) as EventSubscription;
  dispose.ready = Promise.resolve().then(() => register((payload) => {
    if (!disposed) callback(payload);
  })).then((unlisten) => {
    if (disposed) unlisten();
    else release = unlisten;
  });
  // 常驻监听器没有 await 调用者时也不产生未处理拒绝；ready 仍保留原始失败。
  void dispose.ready.catch((error) => console.error("event listener registration failed:", error));
  return dispose;
}
