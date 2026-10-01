/** 单个可替换界面的操作所有权；关闭、重开或身份变化后旧结果失效。 */
export function createOperationLifetime() {
  let generation = 0;
  return {
    invalidate() { generation += 1; },
    capture(valid: () => boolean = () => true) {
      const version = generation;
      let busy = false;
      const isCurrent = () => version === generation && valid();
      return {
        isCurrent,
        assertCurrent() { if (!isCurrent()) throw new DOMException("操作已取消", "AbortError"); },
        async run(work: () => Promise<void>) {
          if (busy || !isCurrent()) return;
          busy = true;
          try { await work(); } finally { busy = false; }
        },
      };
    },
  };
}
