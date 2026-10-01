import type { EventSubscription } from "./eventSubscription.js";

export type WindowResponse = { requestId: string; ok: boolean; error?: string };
export type RequestTransport = {
  listen: (event: string, callback: (response: WindowResponse) => void) => EventSubscription;
  send: (target: string, event: string, payload: unknown) => Promise<void>;
};

/** 请求回执与状态广播分离；先等监听就绪，所有终态均清监听与计时器。 */
export function requestWindow<T extends WindowResponse>(transport: RequestTransport, options: {
  target: string;
  requestEvent: string;
  responseEvent: string;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
  timeoutMs?: number;
  cancelEvent?: string;
}): Promise<T> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    let finished = false;
    let sent = false;
    let subscription: EventSubscription | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (response?: T, error?: unknown) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      subscription?.();
      options.signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(response!);
    };
    const cancel = (error: Error) => {
      if (finished) return;
      if (sent && options.cancelEvent) {
        void transport.send(options.target, options.cancelEvent, { requestId }).catch(console.error);
      }
      finish(undefined, error);
    };
    const abort = () => cancel(new DOMException("请求已取消", "AbortError"));
    if (options.signal?.aborted) { abort(); return; }
    options.signal?.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => cancel(new Error("操作超时，请重试")), options.timeoutMs ?? 15_000);
    try {
      subscription = transport.listen(options.responseEvent, (response) => {
        if (!response || response.requestId !== requestId || typeof response.ok !== "boolean") return;
        if (!response.ok) finish(undefined, new Error(response.error || "操作失败"));
        else finish(response as T);
      });
      if (finished) subscription();
      void subscription.ready.then(async () => {
        if (!finished) {
          sent = true;
          await transport.send(options.target, options.requestEvent, { ...options.payload, requestId });
        }
      }).catch((error) => finish(undefined, error));
    } catch (error) { finish(undefined, error); }
  });
}
