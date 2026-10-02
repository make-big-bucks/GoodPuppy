/** 页面资源的单一释放入口；迟到取得的资源立即释放，一个失败不阻断其它资源。 */
export function createResourceLifetime(onError: (error: unknown) => void = console.error) {
  const abort = new AbortController(); const releases = new Set<() => void>();
  const release = (dispose: () => void) => { try { dispose(); } catch (error) { try { onError(error); } catch { /* 诊断回调不能阻断其它资源释放。 */ } } };
  return {
    signal: abort.signal,
    own(dispose: () => void) { if (abort.signal.aborted) release(dispose); else releases.add(dispose); },
    dispose() {
      if (abort.signal.aborted) return;
      abort.abort();
      for (const dispose of releases) release(dispose);
      releases.clear();
    },
  };
}
