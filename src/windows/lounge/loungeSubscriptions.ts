import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { LoungePresenceRow } from "../../types";

type Context = { client: SupabaseClient; userId: string };
/** 会话独占频道；频道名带代次，旧 unsubscribe 不会删除同客户端的新订阅。 */
export function createLoungeSubscriptions(deps: {
  refresh: () => void;
  knownMemberIds: () => Set<string>;
  presenceChanged: (row: LoungePresenceRow) => void;
  error: (error: unknown) => void;
}) {
  let generation = 0;
  let current: { context: Context; channels: RealtimeChannel[]; groups: Map<string, { channel: RealtimeChannel | null }> } | null = null;
  const retiring = new WeakMap<SupabaseClient, Map<string, Promise<void>>>();
  const retireGroup = (context: Context, room: string, channel: RealtimeChannel) => {
    let pending = retiring.get(context.client);
    if (!pending) { pending = new Map(); retiring.set(context.client, pending); }
    const work = Promise.resolve().then(() => context.client.removeChannel(channel)).then(() => {}, deps.error);
    pending.set(room, work);
    void work.finally(() => { if (pending!.get(room) === work) pending!.delete(room); }).catch(() => {});
  };
  const release = () => {
    const old = current; current = null;
    if (old) for (const [room, entry] of old.groups) if (entry.channel) retireGroup(old.context, room, entry.channel);
    if (old) for (const channel of old.channels) {
      try { void old.context.client.removeChannel(channel).catch(deps.error); } catch (error) { deps.error(error); }
    }
  };
  return {
    setContext(context: Context | null) {
      if (current?.context.client === context?.client && current?.context.userId === context?.userId) return;
      release(); generation += 1;
      if (!context) return;
      const session = { context: { ...context }, channels: [] as RealtimeChannel[], groups: new Map<string, { channel: RealtimeChannel | null }>() };
      current = session;
      const active = () => current === session;
      const specs = [
        { name: "requests", table: "connection_requests", event: "*" as const, filter: `to_id=eq.${context.userId}` },
        { name: "sent-requests", table: "connection_requests", event: "UPDATE" as const, filter: `from_id=eq.${context.userId}` },
        { name: "room-members", table: "room_members", event: "*" as const },
        { name: "profiles", table: "profiles", event: "UPDATE" as const },
        { name: "presence", table: "presence", event: "*" as const },
      ];
      try {
        for (const spec of specs) {
          const channel = context.client.channel(`lounge-${spec.name}-${context.userId}-${generation}`);
          session.channels.push(channel);
          channel.on("postgres_changes", { schema: "public", table: spec.table, event: spec.event,
            ...("filter" in spec ? { filter: spec.filter } : {}) }, (payload) => {
            if (!active()) return;
            if (spec.name === "profiles") {
              const id = (payload.new as { id?: string })?.id;
              if (!id || !deps.knownMemberIds().has(id)) return;
            }
            if (spec.name === "presence") {
              const row = payload.new as LoungePresenceRow;
              if (row?.user_id) deps.presenceChanged(row);
            }
            deps.refresh();
          }).subscribe((status, error) => {
            if (!active()) return;
            if (status === "SUBSCRIBED") deps.refresh();
            else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") deps.error(error ?? new Error(`会客厅订阅失败：${status}`));
          });
        }
      } catch (error) { release(); deps.error(error); }
    },
    async syncRooms(rooms: string[]) {
      const session = current;
      if (!session) return;
      const desired = new Set(rooms);
      for (const [room, entry] of session.groups) if (!desired.has(room)) {
        session.groups.delete(room); if (entry.channel) retireGroup(session.context, room, entry.channel);
      }
      await Promise.all([...desired].map(async room => {
        if (session.groups.has(room)) return;
        const entry = { channel: null as RealtimeChannel | null }; session.groups.set(room, entry);
        await retiring.get(session.context.client)?.get(room);
        if (current !== session || session.groups.get(room) !== entry) return;
        try {
          const channel = session.context.client.channel(`presence:${room}`, { config: { private: true } }); entry.channel = channel;
          const active = () => current === session && session.groups.get(room) === entry;
          channel.on("broadcast", { event: "presence-changed" }, () => { if (active()) deps.refresh(); })
            .subscribe((status, error) => { if (!active()) return;
              if (status === "SUBSCRIBED") deps.refresh();
              else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") deps.error(error ?? new Error("在线目录连接失败"));
            });
        } catch (error) {
          if (session.groups.get(room) === entry) session.groups.delete(room);
          if (entry.channel) retireGroup(session.context, room, entry.channel);
          if (current === session) deps.error(error);
        }
      }));
    },
    dispose: release,
  };
}
