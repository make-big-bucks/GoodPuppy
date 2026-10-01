/** 同名原生资源的创建/销毁串行；取消房间后，旧工作的继续部分必须显式检查 signal。 */
export function createRemoteWindowQueue() {
  let generation = new AbortController();
  let pending = Promise.resolve();
  return {
    get signal() { return generation.signal; },
    invalidate() { generation.abort(); generation = new AbortController(); },
    run(work: () => Promise<void>): Promise<void> {
      const result = pending.then(work);
      pending = result.catch(() => {});
      return result;
    },
    idle() { return pending; },
  };
}
