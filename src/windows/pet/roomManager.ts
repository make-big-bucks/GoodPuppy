import * as presence from "./presence.js";
import { joinInteractions, leaveInteractions } from "./interactions.js";
import {
  fetchRoomMessages,
  subscribeToRoomMessages,
  unsubscribeRoomMessages,
} from "./roomMessages.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@supabase/supabase-js";
import type { InteractionPayload, LocalMessage, PetStatus, PresenceUser } from "../../types";
import type { PetAnimator } from "./petState.js";

type RoomCallbacks = {
  onPresenceChange: (users: PresenceUser[]) => void;
  onInteraction: (payload: InteractionPayload) => void;
  onMessagesLoaded: (messages: LocalMessage[]) => void;
  onNewMessage: (msg: LocalMessage) => void;
  onRoomReady: () => void;
  onEnterRoom: () => void;
  onClearRemotePets: () => void;
  onPetIdResolved: (petId: string) => void;
  getSelfAnimator: () => PetAnimator;
  getSelfPetId: () => string;
  getSelfSkin: () => string;
  getSelfStatus: () => PetStatus;
};

type StartPetAppOptions = {
  supabase?: SupabaseClient;
  session?: Session | null;
};

let activeSupabase: SupabaseClient | null = null;
let selfAuthId: string | null = null;
let currentRoomId: string | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let callbacks: RoomCallbacks | null = null;
let hasStartedPetApp = false;

export function initRoomManager(cbs: RoomCallbacks) {
  callbacks = cbs;
}

export function getCurrentRoomId() {
  return currentRoomId;
}

export function getActiveSupabase() {
  return activeSupabase;
}

export function getSelfAuthId() {
  return selfAuthId;
}

function stopHeartbeat() {
  if (heartbeatTimer != null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!activeSupabase || !selfAuthId || !currentRoomId) return;
    void activeSupabase
      .from("presence")
      .update({ last_seen: new Date().toISOString() })
      .eq("user_id", selfAuthId)
      .then(({ error }) => {
        if (error) console.error("presence heartbeat:", error);
      });
  }, 60_000);
}

async function markPresenceNotInRoom(logLabel = "presence exit"): Promise<void> {
  if (!activeSupabase || !selfAuthId) return;
  const { error } = await activeSupabase
    .from("presence")
    .update({
      current_room_id: null,
      is_online: false,
      last_seen: new Date().toISOString(),
    })
    .eq("user_id", selfAuthId);
  if (error) console.error(`${logLabel}:`, error);
}

async function ensureProfile(): Promise<void> {
  if (!activeSupabase || !selfAuthId || !callbacks) return;
  const { data, error } = await activeSupabase
    .from("profiles")
    .select("id, pet_id")
    .eq("id", selfAuthId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  if (!data) {
    const { error: insertError } = await activeSupabase
      .from("profiles")
      .upsert({ id: selfAuthId, display_name: "", pet_id: "default" }, { onConflict: "id", ignoreDuplicates: true });
    if (insertError) throw insertError;
  } else {
    callbacks.onPetIdResolved(data.pet_id || "default");
  }
}

async function activateRoom(roomId: string): Promise<void> {
  if (!callbacks) return;
  currentRoomId = roomId;

  try {
    if (activeSupabase && selfAuthId) {
      const messages = await fetchRoomMessages(activeSupabase, roomId);
      callbacks.onMessagesLoaded(messages);
      await subscribeToRoomMessages(activeSupabase, roomId, (msg) => callbacks!.onNewMessage(msg));
    }
  } catch (error) {
    console.error(error);
  }

  callbacks.onRoomReady();

  if (!activeSupabase || !selfAuthId) return;

  await presence.joinRoom(activeSupabase, roomId, selfAuthId, {
    onPresenceChange: callbacks.onPresenceChange,
    status: callbacks.getSelfStatus(),
    petId: callbacks.getSelfPetId(),
    skin: callbacks.getSelfSkin(),
  });

  void activeSupabase
    .from("presence")
    .upsert(
      {
        user_id: selfAuthId,
        current_room_id: roomId,
        is_online: true,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "user_id" },
    )
    .then(({ error }) => {
      if (error) console.error("presence upsert:", error);
    });

  startHeartbeat();
  await joinInteractions(activeSupabase, roomId, { onInteraction: callbacks.onInteraction });
}

async function loadCurrentRoom(): Promise<void> {
  if (!activeSupabase || !selfAuthId || !callbacks) return;

  try {
    const { data: presenceRow } = await activeSupabase
      .from("presence")
      .select("current_room_id, is_online")
      .eq("user_id", selfAuthId)
      .maybeSingle();
    const lastRoomId = presenceRow?.current_room_id;
    if (lastRoomId) {
      const { data: membership } = await activeSupabase
        .from("room_members")
        .select("room_id")
        .eq("room_id", lastRoomId)
        .eq("user_id", selfAuthId)
        .maybeSingle();
      if (membership) {
        await activateRoom(lastRoomId);
        return;
      }
      await markPresenceNotInRoom("clear stale room presence");
    } else if (presenceRow?.is_online) {
      await markPresenceNotInRoom("clear stale online presence");
    }
  } catch (error) {
    console.error("restore last room failed:", error);
  }

  callbacks.onRoomReady();
}

export async function switchRoom(roomId: string): Promise<void> {
  if (!activeSupabase || !selfAuthId || roomId === currentRoomId) return;
  try {
    await leaveInteractions();
    await presence.leaveRoom();
    await activateRoom(roomId);
    callbacks?.onEnterRoom();
  } catch (error) {
    console.error(error);
  }
}

export async function exitCurrentRoom(): Promise<void> {
  if (!currentRoomId) return;
  stopHeartbeat();
  await leaveInteractions();
  await presence.leaveRoom();
  await markPresenceNotInRoom();
  if (activeSupabase) await unsubscribeRoomMessages(activeSupabase);
  currentRoomId = null;
  callbacks?.onClearRemotePets();
}

export function startPetApp({ supabase, session }: StartPetAppOptions = {}) {
  if (supabase) activeSupabase = supabase;
  if (session?.user?.id) selfAuthId = session.user.id;

  const doLoad = () =>
    ensureProfile()
      .then(() => loadCurrentRoom())
      .catch((error) => {
        console.error(error);
        callbacks?.onRoomReady();
      });

  if (hasStartedPetApp) {
    doLoad();
    return;
  }
  hasStartedPetApp = true;
  doLoad();
}
