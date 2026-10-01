import type { RealtimeChannel } from "@supabase/supabase-js";

/** subscribe() 返回频道而非连接 Promise；首次连接必须等待状态回执。 */
export function subscribeChannel(
  channel: RealtimeChannel,
  onSubscribed: () => Promise<void> = async () => {},
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("实时连接超时")), timeoutMs);
    const fail = (error: unknown) => { clearTimeout(timer); reject(error); };
    try {
      channel.subscribe((status, error) => {
        if (status === "SUBSCRIBED") {
          // 重连也需要重新 track；闭包捕获自己的频道，不引用可变的全局频道。
          void onSubscribed().then(() => { clearTimeout(timer); resolve(); }, fail);
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          fail(error ?? new Error(`实时连接失败：${status}`));
        }
      });
    } catch (error) { fail(error); }
  });
}
