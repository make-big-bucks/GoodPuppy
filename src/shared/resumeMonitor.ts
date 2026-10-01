/** 用墙上时钟识别事件循环长时间停顿；跨平台，不依赖窗口是否获得焦点。 */
export function createResumeMonitor(onResume: () => Promise<void>, now = Date.now, gapMs = 45_000, pollMs = 15_000) {
  let previous = now();
  let running = false;
  let disposed = false;
  const recover = () => {
    if (running || disposed) return;
    running = true;
    void Promise.resolve().then(() => { if (!disposed) return onResume(); }).catch((error) => {
      if (!disposed && !(error instanceof DOMException && error.name === "AbortError")) console.error("会话恢复失败：", error);
    }).finally(() => { running = false; });
  };
  const tick = () => {
    const current = now();
    const elapsed = current - previous;
    previous = current;
    if (elapsed > gapMs) recover();
  };
  const events = new AbortController();
  window.addEventListener("online", recover, { signal: events.signal });
  document.addEventListener("visibilitychange", tick, { signal: events.signal });
  const timer = setInterval(tick, pollMs);
  return () => { disposed = true; events.abort(); clearInterval(timer); };
}
