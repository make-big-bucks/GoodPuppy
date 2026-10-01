import { subscribeChannel } from "../../shared/realtimeSubscription.js";
import type { RealtimeChannel, RealtimePresenceState, SupabaseClient } from "@supabase/supabase-js";
import type { PetStatus, PresenceUser } from "../../types";

type PresenceMeta = {
  user_id?: string;
  online_at?: string;
  status?: PetStatus;
  pet_id?: string;
  skin?: string;
};

type LocalPresencePatch = {
  status?: PetStatus;
  petId?: string;
  skin?: string;
};

type JoinRoomOptions = LocalPresencePatch & {
  onPresenceChange?: (users: PresenceUser[]) => void;
};

let presenceChannel: RealtimeChannel | null = null;
let knownUsers = new Map<string, { status: PetStatus; petId: string; skin: string }>();
let selfId: string | null = null;
let onPresenceChangeHandler: (users: PresenceUser[]) => void = () => {};
let localPayload: PresenceMeta = { status: null, pet_id: "default", skin: "default" };

function emitPresence() {
  onPresenceChangeHandler(
    [...knownUsers.entries()].map(([userId, info]) => ({
      userId,
      status: info.status ?? null,
      petId: info.petId || "default",
      skin: info.skin || "default",
    })),
  );
}

function syncOnlineState() {
  if (!presenceChannel) return;

  const state = presenceChannel.presenceState() as RealtimePresenceState<PresenceMeta>;
  const next = new Map<string, { status: PetStatus; petId: string; skin: string }>();
  for (const [key, metas] of Object.entries(state)) {
    if (key === selfId) continue;
    const meta = latestMeta(metas);
    next.set(key, {
      status: meta?.status ?? null,
      petId: meta?.pet_id || "default",
      skin: meta?.skin || "default",
    });
  }

  const changed =
    next.size !== knownUsers.size ||
    [...next.entries()].some(([id, info]) => {
      const prev = knownUsers.get(id);
      return !prev || prev.status !== info.status || prev.petId !== info.petId || prev.skin !== info.skin;
    });

  knownUsers = next;
  if (changed) emitPresence();
}

export function latestMeta(metas: PresenceMeta[] | PresenceMeta | null | undefined) {
  if (!Array.isArray(metas)) return metas;
  let best: PresenceMeta | null = null;
  let bestTime = -Infinity;
  for (const meta of metas) {
    const time = Date.parse(meta?.online_at ?? "") || 0;
    if (time >= bestTime) {
      bestTime = time;
      best = meta;
    }
  }
  return best;
}

export async function joinRoom(
  supabase: SupabaseClient,
  roomId: string,
  nextSelfId: string,
  { onPresenceChange, status, petId, skin }: JoinRoomOptions = {},
) {
  selfId = nextSelfId;
  onPresenceChangeHandler = typeof onPresenceChange === "function" ? onPresenceChange : () => {};
  localPayload = {
    status: status ?? localPayload.status ?? null,
    pet_id: petId || localPayload.pet_id || "default",
    skin: skin || localPayload.skin || "default",
  };

  const previous = presenceChannel;
  presenceChannel = null;
  if (previous) await previous.unsubscribe();

  knownUsers.clear();
  emitPresence();

  presenceChannel = supabase.channel(`presence:${roomId}`, {
    config: { presence: { key: nextSelfId } },
  });

  const joinedChannel = presenceChannel;
  joinedChannel.on("presence", { event: "sync" }, () => {
    if (presenceChannel === joinedChannel) syncOnlineState();
  });
  await subscribeChannel(joinedChannel, async () => {
    if (presenceChannel !== joinedChannel) return;
    const result = await joinedChannel.track({
      user_id: nextSelfId, online_at: new Date().toISOString(), ...localPayload,
    });
    if (result !== "ok") throw new Error(`在线状态同步失败：${result}`);
  });
}

export async function updateLocalPresence({ status, petId, skin }: LocalPresencePatch = {}) {
  if (status !== undefined) localPayload.status = status;
  if (petId !== undefined) localPayload.pet_id = petId || "default";
  if (skin !== undefined) localPayload.skin = skin || "default";
  if (presenceChannel) {
    await presenceChannel.track({
      user_id: selfId,
      online_at: new Date().toISOString(),
      ...localPayload,
    });
  }
}

export async function leaveRoom() {
  const previous = presenceChannel;
  presenceChannel = null;
  if (previous) await previous.unsubscribe();
  knownUsers.clear();
  emitPresence();
}
