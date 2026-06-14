import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { InteractionPayload } from "../../types";

let channel: RealtimeChannel | null = null;
let onInteractionHandler: (payload: InteractionPayload) => void = () => {};

export async function joinInteractions(
  supabase: SupabaseClient,
  roomId: string,
  { onInteraction }: { onInteraction?: (payload: InteractionPayload) => void } = {},
) {
  onInteractionHandler = typeof onInteraction === "function" ? onInteraction : () => {};

  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }

  channel = supabase.channel(`interactions:${roomId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on("broadcast", { event: "interaction" }, ({ payload }) => {
    if (payload) onInteractionHandler(payload as InteractionPayload);
  });

  await channel.subscribe();
}

export async function leaveInteractions() {
  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }
  onInteractionHandler = () => {};
}

export function sendInteraction(payload: InteractionPayload) {
  if (!channel) return;
  void channel.send({ type: "broadcast", event: "interaction", payload });
}
