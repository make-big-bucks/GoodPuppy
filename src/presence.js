// 房间在线状态：基于 Supabase Realtime presence。
// payload 除了在线标识外，还携带每个用户的持续状态（情绪 / 工作）与所选形象 pet_id，
// 让远端桌宠能渲染正确形象并反映对方的持续状态。
// 一次性互动事件不走这里，见 interactions.js。

let presenceChannel = null;
let knownUsers = new Map(); // userId -> { status, petId }
let _selfId = null;
let _onPresenceChange = () => {};
let _localPayload = { status: null, pet_id: "default" };

function emitPresence() {
  _onPresenceChange(
    [...knownUsers.entries()].map(([userId, info]) => ({
      userId,
      status: info.status ?? null,
      petId: info.petId || "default",
    }))
  );
}

function syncOnlineState() {
  if (!presenceChannel) return;

  const state = presenceChannel.presenceState();
  const next = new Map();
  for (const [key, metas] of Object.entries(state)) {
    if (key === _selfId) continue;
    // 同一 key 可能累积多个 meta（再次 track() 更新时 Supabase 会追加而非替换），
    // 取 online_at 最新的那个，否则会读到过期状态。见 latestMeta()。
    const meta = latestMeta(metas);
    next.set(key, { status: meta?.status ?? null, petId: meta?.pet_id || "default" });
  }

  const changed =
    next.size !== knownUsers.size ||
    [...next.entries()].some(([id, info]) => {
      const prev = knownUsers.get(id);
      return !prev || prev.status !== info.status || prev.petId !== info.petId;
    });

  knownUsers = next;
  if (changed) emitPresence();
}

// 从一个 presence key 的 meta 列表里取「最新」的一个（按 online_at）。
// Supabase 再次 track() 更新同一 key 时会追加 meta 而非替换，盲取 metas[0] 会读到旧值。
export function latestMeta(metas) {
  if (!Array.isArray(metas)) return metas;
  let best = null;
  let bestTime = -Infinity;
  for (const m of metas) {
    const t = Date.parse(m?.online_at ?? "") || 0;
    if (t >= bestTime) {
      bestTime = t;
      best = m;
    }
  }
  return best;
}

export async function joinRoom(supabase, roomId, selfId, { onPresenceChange, status, petId } = {}) {
  _selfId = selfId;
  _onPresenceChange = typeof onPresenceChange === "function" ? onPresenceChange : () => {};
  _localPayload = {
    status: status ?? _localPayload.status ?? null,
    pet_id: petId || _localPayload.pet_id || "default",
  };

  if (presenceChannel) {
    await presenceChannel.unsubscribe();
    presenceChannel = null;
  }

  knownUsers.clear();
  emitPresence();

  presenceChannel = supabase.channel(`presence:${roomId}`, {
    config: { presence: { key: selfId } },
  });

  presenceChannel.on("presence", { event: "sync" }, syncOnlineState).subscribe(async (status) => {
    if (status === "SUBSCRIBED") {
      await presenceChannel.track({ user_id: selfId, online_at: new Date().toISOString(), ..._localPayload });
    }
  });
}

// 更新本地持续状态 / 形象并重新广播。无房间时仅记录，下次 joinRoom 生效。
export async function updateLocalPresence({ status, petId } = {}) {
  if (status !== undefined) _localPayload.status = status;
  if (petId !== undefined) _localPayload.pet_id = petId || "default";
  if (presenceChannel) {
    await presenceChannel.track({
      user_id: _selfId,
      online_at: new Date().toISOString(),
      ..._localPayload,
    });
  }
}

export async function leaveRoom() {
  if (presenceChannel) {
    await presenceChannel.unsubscribe();
    presenceChannel = null;
  }
  knownUsers.clear();
  emitPresence();
}
