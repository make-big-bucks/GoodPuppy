import { subscribeChannel } from "../../shared/realtimeSubscription.js";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { InteractionPayload } from "../../types";

let channel: RealtimeChannel | null = null;
let ready = false;
let activeRoom: { client: SupabaseClient; roomId: string } | null = null;
let onInteractionHandler: (payload: InteractionPayload) => void = () => {};

function isInteractionPayload(payload: unknown): payload is InteractionPayload {
  if (!payload || typeof payload !== "object") return false;
  const value = payload as Record<string, unknown>;
  return (
    typeof value.action === "string" &&
    typeof value.actorId === "string" &&
    typeof value.targetId === "string"
  );
}

export async function joinInteractions(
  supabase: SupabaseClient,
  roomId: string,
  { onInteraction }: { onInteraction?: (payload: InteractionPayload) => void } = {},
) {
  ready = false;
  activeRoom = { client: supabase, roomId };
  onInteractionHandler = typeof onInteraction === "function" ? onInteraction : () => {};

  const previous = channel;
  channel = null;
  if (previous) await previous.unsubscribe();

  channel = supabase.channel(`interactions:${roomId}`, {
    config: { private: true, broadcast: { self: false } },
  });

  const joinedChannel = channel;
  const handler = onInteractionHandler;
  channel.on("broadcast", { event: "interaction" }, ({ payload }) => {
    if (channel === joinedChannel && isInteractionPayload(payload)) handler(payload);
  });

  await subscribeChannel(joinedChannel);
  if (channel === joinedChannel) ready = true;
}

export async function leaveInteractions() {
  activeRoom = null;
  ready = false;
  const previous = channel;
  channel = null;
  if (previous) await previous.unsubscribe();
  onInteractionHandler = () => {};
}

export async function sendInteraction(payload: InteractionPayload) {
  const room = activeRoom;
  if (!room || !channel || !ready) throw new Error("互动频道尚未就绪");
  const { error } = await room.client.rpc("send_room_interaction", {
    p_room_id: room.roomId, p_action: payload.action, p_target_id: payload.targetId,
  });
  if (error) throw error;
}
