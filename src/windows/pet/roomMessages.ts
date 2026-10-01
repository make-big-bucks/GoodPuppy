import { subscribeChannel } from "../../shared/realtimeSubscription.js";
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
let messagesClient: SupabaseClient | null = null;

// 拉取的房间历史上限；按发送者分组后每只宠物再裁剪到 MAX_STACK_MESSAGES。
const ROOM_HISTORY_LIMIT = 120;

function msgToLocal(msg: MessageInsert): LocalMessage {
  return {
    id: msg.id,
    info: msg.content,
    from: msg.sender_id,
    created_at: msg.created_at,
  };
}

/** 拉取房间内最近的文本消息（所有成员），升序返回。由调用方按 sender 分组到各宠物。 */
export async function fetchRoomMessages(
  supabase: SupabaseClient,
  roomId: string,
): Promise<LocalMessage[]> {
  const { data, error } = await supabase
    .from("messages")
    .select("id, content, created_at, sender_id, kind")
    .eq("room_id", roomId)
    .eq("kind", "text")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(ROOM_HISTORY_LIMIT);
  if (error) throw error;
  return (data || []).map(msgToLocal).reverse();
}

/** 订阅房间内所有成员的文本消息 INSERT；由调用方按 sender 路由到对应宠物头上。 */
export async function subscribeToRoomMessages(
  supabase: SupabaseClient,
  roomId: string,
  onMessage: (msg: LocalMessage) => void,
): Promise<void> {
  await unsubscribeRoomMessages(supabase);
  messagesClient = supabase;
  const joinedChannel = supabase
    .channel("room-messages-" + roomId)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `room_id=eq.${roomId}`,
      },
      (payload) => {
        if (messagesChannel !== joinedChannel) return;
        if (payload.new?.kind !== "text") return;
        onMessage(msgToLocal(payload.new as MessageInsert));
      },
    );
  messagesChannel = joinedChannel;
  let recoveryGeneration = 0;
  await subscribeChannel(joinedChannel, async (reconnected) => {
    if (!reconnected || messagesChannel !== joinedChannel) return;
    const version = recoveryGeneration;
    const history = await fetchRoomMessages(supabase, roomId);
    if (messagesChannel !== joinedChannel || version !== recoveryGeneration) return;
    for (const message of history) onMessage(message);
  }, undefined, (_ready, error) => {
    if (!_ready) recoveryGeneration += 1;
    if (messagesChannel === joinedChannel && error) console.error("房间消息频道：", error);
  });
}

export async function unsubscribeRoomMessages(supabase: SupabaseClient): Promise<void> {
  const previous = messagesChannel;
  const owner = messagesClient ?? supabase;
  messagesChannel = null;
  messagesClient = null;
  if (previous) await owner.removeChannel(previous);
}
