import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { LocalMessage } from "../../types";

type MessageInsert = {
  id: string;
  content: string;
  sender_id: string;
  created_at: string;
  kind?: string;
};

let messagesChannel: RealtimeChannel | null = null;

function msgToLocal(msg: MessageInsert): LocalMessage {
  return {
    id: msg.id,
    info: msg.content,
    from: msg.sender_id,
    created_at: msg.created_at,
  };
}

export async function fetchSelfMessages(
  supabase: SupabaseClient,
  roomId: string,
  selfAuthId: string,
): Promise<LocalMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, content, created_at, sender_id, kind")
    .eq("room_id", roomId)
    .eq("sender_id", selfAuthId)
    .eq("kind", "text")
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  return (data || []).map(msgToLocal);
}

export async function subscribeToSelfMessages(
  supabase: SupabaseClient,
  roomId: string,
  selfAuthId: string,
  onMessage: (msg: LocalMessage) => void,
): Promise<void> {
  if (messagesChannel) {
    await supabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }
  messagesChannel = supabase
    .channel("self-messages-" + roomId)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        if (payload.new?.kind !== "text") return;
        const msg = msgToLocal(payload.new as MessageInsert);
        if (msg.from === selfAuthId) onMessage(msg);
      },
    )
    .subscribe();
}

export async function unsubscribeSelfMessages(supabase: SupabaseClient): Promise<void> {
  if (messagesChannel) {
    await supabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }
}
