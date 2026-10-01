/** 恢复任务保持单次在途、失败后延时重试；退出会话同时取消请求和等待。 */
export async function retryTask<T>(load: () => Promise<T>, signal: AbortSignal, onError: (error: unknown) => void, delayMs = 5_000): Promise<T> {
  while (!signal.aborted) {
    try {
      const result = await load();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      signal.throwIfAborted();
      onError(error);
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(signal.reason); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, delayMs);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  throw signal.reason;
}
