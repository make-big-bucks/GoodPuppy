/** 自启动是本机偏好；读写跨设置页重开串行，错误不转换为“已关闭”。 */
export function createAutostartController(deps: { read: () => Promise<boolean>; write: (enabled: boolean) => Promise<boolean> }) {
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = (work: () => Promise<boolean>) => {
    const result = pending.then(work); pending = result.catch(() => {}); return result;
  };
  return { read: () => enqueue(deps.read), write: (enabled: boolean) => enqueue(() => deps.write(enabled)) };
}
