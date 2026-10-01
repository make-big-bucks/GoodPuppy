import type { EventSubscription } from "../../shared/eventSubscription.js";
export const WINDOW_READY = "presenter-ready";
export const WINDOW_READY_REQUEST = "presenter-ready-request";
export type ReadyPayload = { label: string; instanceId: string; controllerId?: string | null };
export type PresenterEnvelope<T = unknown> = { instanceId: string; controllerId: string; sequence: number; payload: T };

export function createWindowReadiness(deps: {
  controllerId: string;
  listen: (event: string, callback: (payload: ReadyPayload) => void) => EventSubscription;
  send: (label: string, event: string, payload: unknown) => Promise<void>;
}) {
  const waiters = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const key = (label: string, instance: string) => `${label}|${instance}`;
  const listener = deps.listen(WINDOW_READY, (payload) => {
    if (!payload || typeof payload.label !== "string" || typeof payload.instanceId !== "string") return;
    const waiter = waiters.get(key(payload.label, payload.instanceId));
    if (!waiter) return;
    if (payload.controllerId === deps.controllerId) waiter.resolve();
    else void deps.send(payload.label, WINDOW_READY_REQUEST, { instanceId: payload.instanceId, controllerId: deps.controllerId }).catch((error) => waiter.reject(error));
  });
  return {
    ready: listener.ready,
    wait(label: string, instanceId: string, signal?: AbortSignal, timeoutMs = 10_000): Promise<void> {
      const id = key(label, instanceId);
      if (waiters.has(id)) return Promise.reject(new Error("窗口就绪等待已存在"));
      return new Promise((resolve, reject) => {
        let finished = false;
        const finish = (error?: Error) => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          waiters.delete(id);
          if (error) reject(error); else resolve();
        };
        const abort = () => finish(new DOMException("窗口准备已取消", "AbortError"));
        const timer = setTimeout(() => finish(new Error(`窗口 ${label} 初始化超时`)), timeoutMs);
        waiters.set(id, { resolve: () => finish(), reject: finish });
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    ping(label: string, instanceId: string) { return deps.send(label, WINDOW_READY_REQUEST, { instanceId, controllerId: deps.controllerId }); },
    dispose() {
      listener();
      for (const waiter of [...waiters.values()]) waiter.reject(new DOMException("窗口管理器已关闭", "AbortError"));
    },
  };
}

/** 每个呈现者只接收本次实例的数据，丢弃重复或乱序旧帧。 */
export function createPresenterEndpoint(deps: {
  label: string; instanceId: string;
  listen: <T>(event: string, callback: (payload: T) => void) => EventSubscription;
  send: (label: string, event: string, payload: unknown) => Promise<void>;
}) {
  const listeners: EventSubscription[] = [];
  let sequence = 0;
  let controllerId: string | null = null;
  let disposed = false;
  const announce = () => deps.send("main", WINDOW_READY, { label: deps.label, instanceId: deps.instanceId, controllerId });
  return {
    listen<T>(event: string, callback: (payload: T) => void) {
      const listener = deps.listen<PresenterEnvelope<T>>(event, (message) => {
        if (disposed || !message || message.instanceId !== deps.instanceId || message.controllerId !== controllerId
          || !Number.isSafeInteger(message.sequence) || message.sequence <= sequence) return;
        sequence = message.sequence;
        callback(message.payload);
        void deps.send("main", "presenter-applied", { label: deps.label, instanceId: deps.instanceId,
          controllerId, sequence, event }).catch(console.error);
      });
      listeners.push(listener);
      return listener;
    },
    async ready() {
      const ping = deps.listen<{ instanceId?: string; controllerId?: string }>(WINDOW_READY_REQUEST, (payload) => {
        if (!disposed && payload?.instanceId === deps.instanceId && typeof payload.controllerId === "string") {
          if (controllerId !== payload.controllerId) { controllerId = payload.controllerId; sequence = 0; }
          void announce().catch(console.error);
        }
      });
      listeners.push(ping);
      await Promise.all(listeners.map((listener) => listener.ready));
      if (!disposed) await announce();
    },
    dispose() { disposed = true; listeners.forEach((listener) => listener()); },
  };
}
