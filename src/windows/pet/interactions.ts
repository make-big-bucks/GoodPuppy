import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { InteractionPayload } from "../../types";

let channel: RealtimeChannel | null = null;
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
  onInteractionHandler = typeof onInteraction === "function" ? onInteraction : () => {};

  if (channel) {
    await channel.unsubscribe();
    channel = null;
  }

  channel = supabase.channel(`interactions:${roomId}`, {
    config: { broadcast: { self: false } },
  });

  channel.on("broadcast", { event: "interaction" }, ({ payload }) => {
    if (isInteractionPayload(payload)) onInteractionHandler(payload);
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
