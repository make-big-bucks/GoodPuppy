/** 同一会话的刷新共享在途请求，突发变更至多补一次；新会话不等待旧请求。 */
export function createRefreshController<C, R>(deps: {
  load: (context: C, signal: AbortSignal) => Promise<R>;
  commit: (result: R, context: C) => void;
  error: (error: unknown) => void;
}) {
  let epoch = 0;
  let current: { context: C; abort: AbortController; dirty: boolean; running: Promise<void> | null } | null = null;
  return {
    setContext(context: C | null) {
      epoch += 1;
      current?.abort.abort();
      current = context === null ? null : { context, abort: new AbortController(), dirty: false, running: null };
    },
    refresh(): Promise<void> {
      const session = current;
      if (!session) return Promise.resolve();
      session.dirty = true;
      if (session.running) return session.running;
      const version = epoch;
      const work = Promise.resolve().then(async () => {
        while (session.dirty && version === epoch) {
          session.dirty = false;
          try {
            const result = await deps.load(session.context, session.abort.signal);
            if (version !== epoch) return;
            if (!session.dirty) deps.commit(result, session.context);
          } catch (error) {
            if (version === epoch && !session.abort.signal.aborted) deps.error(error);
          }
        }
      });
      session.running = work;
      void work.finally(() => { if (session.running === work) session.running = null; }).catch(console.error);
      return work;
    },
    dispose() { this.setContext(null); },
  };
}
