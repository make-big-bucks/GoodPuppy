import type { RealtimeChannel } from "@supabase/supabase-js";

export type ConnectionObserver = (ready: boolean, error?: unknown) => void;

/** 首次连接等待回执；之后仍观察状态，过期 track 不能把断线频道重新标记为就绪。 */
export function subscribeChannel(
  channel: RealtimeChannel,
  onSubscribed: (reconnected: boolean) => Promise<void> = async () => {},
  timeoutMs = 10_000,
  onConnectionChange?: ConnectionObserver,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let generation = 0;
    let connectedOnce = false;
    let initialFailed = false;
    const notify = (ready: boolean, error?: unknown) => {
      try {
        if (onConnectionChange) onConnectionChange(ready, error);
        else if (connectedOnce && error) console.error("实时频道连接失败：", error);
      } catch (failure) { console.error("实时频道状态回调失败：", failure); }
    };
    const fail = (error: unknown) => {
      generation += 1;
      clearTimeout(timer);
      if (!connectedOnce) initialFailed = true;
      notify(false, error);
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error("实时连接超时")), timeoutMs);
    try {
      channel.subscribe((status, error) => {
        if (initialFailed) return;
        if (status === "SUBSCRIBED") {
          const version = ++generation;
          notify(false);
          let preparation: Promise<void>;
          try { preparation = onSubscribed(connectedOnce); } catch (failure) { fail(failure); return; }
          void preparation.then(() => {
            if (version !== generation || initialFailed) return;
            clearTimeout(timer);
            connectedOnce = true;
            notify(true);
            resolve();
          }, (failure) => { if (version === generation) fail(failure); });
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          fail(error ?? new Error(`实时连接失败：${status}`));
        }
      });
    } catch (error) { fail(error); }
  });
}
