/** 每个窗口实例独立串行投递；发送前再次检查归属，避免排队期间失效的消息抵达持久窗口。 */
export function createPresenterDelivery(deps: {
  controllerId: string;
  send: (label: string, event: string, payload: unknown) => Promise<void>;
}) {
  let sequence = 0;
  const pending = new Map<string, Promise<void>>();
  return {
    deliver(label: string, instanceId: string, event: string, payload: unknown, valid: () => boolean) {
      const key = `${label}|${instanceId}`;
      const envelope = { instanceId, controllerId: deps.controllerId, sequence: ++sequence, payload };
      const result = (pending.get(key) ?? Promise.resolve()).catch(() => {}).then(async () => {
        if (valid()) await deps.send(label, event, envelope);
      });
      pending.set(key, result);
      const clean = () => { if (pending.get(key) === result) pending.delete(key); };
      void result.then(clean, clean);
      return result;
    },
  };
}
