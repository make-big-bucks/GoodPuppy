// 跨用户瞬时互动事件总线：room 维度一条 Supabase Realtime broadcast channel。
// 纯瞬时、不落库、不进消息历史——适合「踢飞 / 喂食 / 贴贴」这类高频低价值信号。
// 事件形如 { action, actorId, targetId }，action 见 animationCatalog.INTERACTIONS。

let channel = null;
let _onInteraction = () => {};

/**
 * 订阅房间的瞬时互动广播。
 * @param {import("@supabase/supabase-js").SupabaseClient} supabase
 * @param {string} roomId
 * @param {{ onInteraction?: (payload: import("../../types").InteractionPayload) => void }} [options]
 */
export async function joinInteractions(supabase, roomId, { onInteraction } = {}) {
  _onInteraction = typeof onInteraction === "function" ? onInteraction : () => {};

  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }

  channel = supabase.channel(`interactions:${roomId}`, {
    config: { broadcast: { self: false } }, // 发起方本地直接播，无需回环
  });

  channel.on("broadcast", { event: "interaction" }, ({ payload }) => {
    if (payload) _onInteraction(payload);
  });

  await channel.subscribe();
}

export async function leaveInteractions() {
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  _onInteraction = () => {};
}

/** @param {import("../../types").InteractionPayload} payload */
export function sendInteraction(payload) {
  if (!channel) return;
  channel.send({ type: "broadcast", event: "interaction", payload });
}
