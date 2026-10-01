/** 通知窗口有界调度：实例绑定、取消后收尾、就绪限时和过期资格检查。 */
export function createNotificationScheduler<T>(deps: {
  key: (payload: T) => string;
  valid: (payload: T) => boolean;
  create: (label: string, instanceId: string, slot: number, payload: T, signal: AbortSignal) => Promise<void>;
  close: (label: string, instanceId: string) => Promise<void>;
  deliver: (label: string, instanceId: string, payload: T) => Promise<void>;
  maxVisible?: number; maxQueued?: number; queueTtlMs?: number; readyTimeoutMs?: number; visibleTimeoutMs?: number;
}) {
  type Entry = { label: string; instanceId: string; slot: number; payload: T; abort: AbortController; timer: ReturnType<typeof setTimeout> | null; delivered: boolean };
  const entries = new Map<string, Entry>();
  const queued: Array<{ payload: T; expires: number }> = [];
  const maxVisible = deps.maxVisible ?? 3;
  const close = (entry: Entry) => { void deps.close(entry.label, entry.instanceId).catch(console.error); };
  function remove(entry: Entry) {
    if (entries.get(entry.label) !== entry) return;
    entries.delete(entry.label); entry.abort.abort();
    if (entry.timer) clearTimeout(entry.timer);
    close(entry); pump();
  }
  function pump() {
    while (entries.size < maxVisible && queued.length) {
      const next = queued.shift()!;
      if (next.expires < Date.now() || !deps.valid(next.payload)) continue;
      const slot = Array.from({ length: maxVisible }, (_, i) => i).find((i) => ![...entries.values()].some((entry) => entry.slot === i))!;
      const instanceId = crypto.randomUUID();
      const entry: Entry = { label: `toast-${instanceId}`, instanceId, slot, payload: next.payload, abort: new AbortController(), timer: null, delivered: false };
      entries.set(entry.label, entry);
      entry.timer = setTimeout(() => remove(entry), deps.readyTimeoutMs ?? 10_000);
      void deps.create(entry.label, instanceId, slot, entry.payload, entry.abort.signal).then(() => {
        if (entry.abort.signal.aborted || entries.get(entry.label) !== entry) close(entry);
      }).catch((error) => { if (!entry.abort.signal.aborted) console.error(error); remove(entry); });
    }
  }
  return {
    enqueue(payload: T) {
      if (!deps.valid(payload) || [...entries.values()].some((entry) => deps.key(entry.payload) === deps.key(payload))) return;
      const existing = queued.find((entry) => deps.key(entry.payload) === deps.key(payload));
      if (existing) existing.payload = payload;
      else queued.push({ payload, expires: Date.now() + (deps.queueTtlMs ?? 30_000) });
      while (queued.length > (deps.maxQueued ?? 20)) queued.shift();
      pump();
    },
    async ready(label: string, instanceId: string) {
      const entry = entries.get(label);
      if (!entry || entry.instanceId !== instanceId || entry.delivered) return;
      if (!deps.valid(entry.payload)) { remove(entry); return; }
      entry.delivered = true;
      if (entry.timer) clearTimeout(entry.timer);
      try {
        await deps.deliver(label, instanceId, entry.payload);
        if (entries.get(label) === entry) entry.timer = setTimeout(() => remove(entry), deps.visibleTimeoutMs ?? 9000);
      } catch (error) { console.error(error); remove(entry); }
    },
    matches(label: string, instanceId: string, predicate: (payload: T) => boolean = () => true) {
      const entry = entries.get(label);
      return Boolean(entry && entry.instanceId === instanceId && deps.valid(entry.payload) && predicate(entry.payload));
    },
    dismiss(label: string, instanceId: string) { const entry = entries.get(label); if (entry?.instanceId === instanceId) remove(entry); },
    clear() {
      queued.length = 0;
      for (const entry of [...entries.values()]) {
        entries.delete(entry.label); entry.abort.abort(); if (entry.timer) clearTimeout(entry.timer); close(entry);
      }
    },
    get queuedCount() { return queued.length; },
    get visibleCount() { return entries.size; },
  };
}
