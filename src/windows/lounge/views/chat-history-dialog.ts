import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { LoungeProfile, LoungeRoom } from "../../../types";
import {
  fetchMessagePage,
  formatDayLabel,
  formatTime,
  isSameDay,
  resolveSender,
  rowProfile,
  type ChatMessage,
  type ChatMessageRow,
} from "../chatHistory.js";

type OpenChatHistoryOptions = {
  supabase: SupabaseClient;
  selfAuthId: string;
  room: Pick<LoungeRoom, "id" | "room_name" | "members">;
};

// 距底部小于该值视为「贴着底部」，新消息会自动滚到底。
const NEAR_BOTTOM_PX = 80;

const closeIcon = `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M1 1l12 12M13 1L1 13" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;

let activeClose: (() => void) | null = null;

export function openChatHistory({ supabase, selfAuthId, room }: OpenChatHistoryOptions) {
  // 同一时间只允许一个聊天记录覆盖层。
  activeClose?.();

  // sender_id → profile 缓存：先用房间成员预热，分页拉取与实时新消息再补充。
  const profileCache = new Map<string, LoungeProfile>();
  for (const member of room.members) {
    profileCache.set(member.userId, {
      id: member.userId,
      gp_id: member.gpId,
      display_name: member.displayName,
    });
  }

  const seenIds = new Set<string>();
  let messages: ChatMessage[] = [];
  let oldestCursor: string | null = null;
  let hasMore = true;
  let loadingOlder = false;
  let disposed = false;
  let channel: RealtimeChannel | null = null;

  // ---- DOM ----
  const backdrop = document.createElement("div");
  backdrop.className = "chat-history-backdrop";

  const panel = document.createElement("div");
  panel.className = "chat-history-panel";

  const header = document.createElement("div");
  header.className = "chat-history-header";
  const heading = document.createElement("div");
  heading.className = "chat-history-heading";
  heading.innerHTML = `<span class="chat-history-title">聊天记录</span><span class="chat-history-room"></span>`;
  heading.querySelector<HTMLElement>(".chat-history-room")!.textContent = room.room_name || "未命名房间";
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "chat-history-close";
  closeBtn.setAttribute("aria-label", "关闭");
  closeBtn.innerHTML = closeIcon;
  header.append(heading, closeBtn);

  const log = document.createElement("div");
  log.className = "chat-log";

  const status = document.createElement("div");
  status.className = "chat-history-status";
  status.textContent = "正在加载…";
  log.appendChild(status);

  const jumpBtn = document.createElement("button");
  jumpBtn.type = "button";
  jumpBtn.className = "chat-jump-btn";
  jumpBtn.textContent = "新消息 ↓";
  jumpBtn.hidden = true;

  panel.append(header, log, jumpBtn);
  backdrop.appendChild(panel);
  document.body.appendChild(backdrop);

  // ---- helpers ----
  function isNearBottom() {
    return log.scrollHeight - log.scrollTop - log.clientHeight < NEAR_BOTTOM_PX;
  }

  function scrollToBottom() {
    log.scrollTop = log.scrollHeight;
  }

  function cacheRowProfiles(rows: ChatMessageRow[]) {
    for (const row of rows) {
      const profile = rowProfile(row);
      if (profile && row.sender_id) profileCache.set(row.sender_id, profile);
    }
  }

  function buildBubble(message: ChatMessage, prev: ChatMessage | null) {
    const fragment = document.createDocumentFragment();

    if (!prev || !isSameDay(prev.createdAt, message.createdAt)) {
      const divider = document.createElement("div");
      divider.className = "chat-day";
      divider.innerHTML = `<span>${formatDayLabel(message.createdAt)}</span>`;
      fragment.appendChild(divider);
    }

    const isSelf = message.senderId === selfAuthId;
    const row = document.createElement("div");
    row.className = `chat-row${isSelf ? " is-self" : ""}`;

    const col = document.createElement("div");
    col.className = "chat-col";

    if (!isSelf) {
      const identity = resolveSender(message.senderId, message.senderId ? profileCache.get(message.senderId) : null);
      const sender = document.createElement("div");
      sender.className = `chat-sender${identity.isDeleted ? " is-deleted" : ""}`;
      sender.textContent = identity.name;
      sender.style.color = identity.color;
      col.appendChild(sender);
    }

    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = message.content;
    col.appendChild(bubble);

    const time = document.createElement("div");
    time.className = "chat-time";
    time.textContent = formatTime(message.createdAt);
    col.appendChild(time);

    row.appendChild(col);
    fragment.appendChild(row);
    return fragment;
  }

  function renderAll() {
    log.querySelectorAll(".chat-row, .chat-day, .chat-history-empty").forEach((el) => el.remove());
    if (messages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "chat-history-empty";
      empty.textContent = "还没有聊天记录";
      log.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    let prev: ChatMessage | null = null;
    for (const message of messages) {
      frag.appendChild(buildBubble(message, prev));
      prev = message;
    }
    log.appendChild(frag);
  }

  function appendMessage(message: ChatMessage) {
    if (seenIds.has(message.id)) return;
    seenIds.add(message.id);
    const stickToBottom = isNearBottom();
    const prev = messages[messages.length - 1] ?? null;
    messages.push(message);
    log.querySelector(".chat-history-empty")?.remove();
    log.appendChild(buildBubble(message, prev));
    if (stickToBottom || message.senderId === selfAuthId) {
      scrollToBottom();
    } else {
      jumpBtn.hidden = false;
    }
  }

  async function loadInitial() {
    try {
      const { page, rows } = await fetchMessagePage(supabase, room.id);
      if (disposed) return;
      cacheRowProfiles(rows);
      for (const m of page.messages) seenIds.add(m.id);
      messages = page.messages;
      hasMore = page.hasMore;
      oldestCursor = page.nextCursor;
      status.hidden = true;
      renderAll();
      scrollToBottom();
    } catch {
      if (disposed) return;
      status.textContent = "加载失败";
    }
  }

  async function loadOlder() {
    if (loadingOlder || !hasMore || !oldestCursor) return;
    loadingOlder = true;
    status.hidden = false;
    status.textContent = "正在加载更早的消息…";
    const prevHeight = log.scrollHeight;
    const prevTop = log.scrollTop;
    try {
      const { page, rows } = await fetchMessagePage(supabase, room.id, oldestCursor);
      if (disposed) return;
      cacheRowProfiles(rows);
      const fresh = page.messages.filter((m) => !seenIds.has(m.id));
      for (const m of fresh) seenIds.add(m.id);
      messages = [...fresh, ...messages];
      hasMore = page.hasMore;
      oldestCursor = page.nextCursor;
      status.hidden = true;
      renderAll();
      // 保持视口停在原来的位置，避免插入历史后跳动。
      log.scrollTop = log.scrollHeight - prevHeight + prevTop;
    } catch {
      if (disposed) return;
      status.textContent = "加载失败";
    } finally {
      loadingOlder = false;
    }
  }

  async function resolveNewSender(senderId: string) {
    if (profileCache.has(senderId)) return;
    const { data } = await supabase
      .from("profiles")
      .select("id, gp_id, display_name")
      .eq("id", senderId)
      .maybeSingle();
    if (data) profileCache.set(senderId, data as LoungeProfile);
  }

  function subscribeRealtime() {
    channel = supabase
      .channel(`lounge-chat-history-${room.id}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "messages", filter: `room_id=eq.${room.id}` },
        (payload) => {
          const next = payload.new as ChatMessageRow & { kind?: string };
          if (next?.kind !== "text") return;
          const message: ChatMessage = {
            id: next.id,
            content: next.content,
            senderId: next.sender_id,
            createdAt: next.created_at,
          };
          if (seenIds.has(message.id)) return;
          if (!message.senderId || profileCache.has(message.senderId) || message.senderId === selfAuthId) {
            appendMessage(message);
          } else {
            void resolveNewSender(message.senderId).then(() => {
              if (!disposed) appendMessage(message);
            });
          }
        },
      )
      .subscribe();
  }

  function onScroll() {
    if (log.scrollTop < NEAR_BOTTOM_PX) void loadOlder();
    if (isNearBottom()) jumpBtn.hidden = true;
  }

  function close() {
    if (disposed) return;
    disposed = true;
    log.removeEventListener("scroll", onScroll);
    document.removeEventListener("keydown", onKeydown);
    if (channel) void supabase.removeChannel(channel);
    backdrop.remove();
    if (activeClose === close) activeClose = null;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") close();
  }

  // ---- wire ----
  activeClose = close;
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  jumpBtn.addEventListener("click", () => {
    scrollToBottom();
    jumpBtn.hidden = true;
  });
  log.addEventListener("scroll", onScroll);
  document.addEventListener("keydown", onKeydown);

  void loadInitial();
  subscribeRealtime();

  return close;
}
