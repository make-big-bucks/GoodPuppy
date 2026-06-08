let presenceChannel = null;
let knownOnlineUsers = new Set();
let _selfId = null;
let _onOnlineUsersChange = () => {};

function emitOnlineUsers() {
  _onOnlineUsersChange([...knownOnlineUsers]);
}

function syncOnlineState() {
  if (!presenceChannel) return;

  const state = presenceChannel.presenceState();
  // presenceState keys are the track keys; we track with user_id as the key
  const onlineIds = new Set(Object.keys(state));
  const nextOnlineUsers = new Set([...onlineIds].filter((id) => id !== _selfId));
  const changed =
    nextOnlineUsers.size !== knownOnlineUsers.size ||
    [...nextOnlineUsers].some((id) => !knownOnlineUsers.has(id));

  knownOnlineUsers = nextOnlineUsers;
  if (changed) emitOnlineUsers();
}

export async function joinRoom(supabase, roomId, selfId, { onOnlineUsersChange } = {}) {
  _selfId = selfId;
  _onOnlineUsersChange =
    typeof onOnlineUsersChange === "function" ? onOnlineUsersChange : () => {};

  if (presenceChannel) {
    await presenceChannel.unsubscribe();
    presenceChannel = null;
  }

  knownOnlineUsers.clear();
  emitOnlineUsers();

  presenceChannel = supabase.channel(`presence:${roomId}`, {
    config: { presence: { key: selfId } },
  });

  presenceChannel
    .on("presence", { event: "sync" }, syncOnlineState)
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        await presenceChannel.track({ user_id: selfId, online_at: new Date().toISOString() });
      }
    });
}

export async function leaveRoom() {
  if (presenceChannel) {
    await presenceChannel.unsubscribe();
    presenceChannel = null;
  }
  knownOnlineUsers.clear();
  emitOnlineUsers();
}
