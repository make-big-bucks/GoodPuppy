import { subscribeChannel } from "../../../shared/realtimeSubscription.js";
import { createChatWindow } from "../chatWindow.js";
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
  type MessageCursor,
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
export function closeChatHistory() { activeClose?.(); }

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

  const store = createChatWindow();
  const abort = new AbortController();
  let oldestCursor: MessageCursor | null = null;
  let hasMore = true;
  let loadingOlder = false;
  let disposed = false;
  let channel: RealtimeChannel | null = null;
  let latestRevision = 0;
  let firstConnection = true;

  // ---- DOM ----
  const backdrop = document.createElement("div");
  backdrop.className = "chat-history-backdrop";

  const panel = document.createElement("div");
  panel.className = "chat-history-panel";
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", "聊天记录");
  const previousFocus = document.activeElement as HTMLElement | null;

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
  status.hidden = true;
  log.appendChild(status);

  // 首屏加载用气泡骨架占位（往上翻历史时改用 status 文案，不打断阅读）。
  const skeletonWidths = [62, 48, 78, 40, 70];
  function buildInitialSkeleton() {
    const wrap = document.createElement("div");
    wrap.className = "chat-history-skeleton";
    skeletonWidths.forEach((width, i) => {
      const row = document.createElement("div");
      row.className = `chat-skel-row${i % 2 === 0 ? "" : " is-self"}`;
      const bubble = document.createElement("div");
      bubble.className = "gp-skeleton chat-skel-bubble";
      bubble.style.width = `${width}%`;
      row.appendChild(bubble);
      wrap.appendChild(row);
    });
    return wrap;
  }

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
    row.dataset.messageId = message.id;

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
    const messages = store.messages;
    const senders = new Set(messages.map((message) => message.senderId));
    for (const id of profileCache.keys()) if (!senders.has(id)) profileCache.delete(id);
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
    if (disposed) return;
    const stickToBottom = isNearBottom();
    if (!store.live(message)) { if (store.readingOlder) jumpBtn.hidden = false; return; }
    const anchor = visibleAnchor();
    renderAll();
    if (stickToBottom || message.senderId === selfAuthId) scrollToBottom();
    else { restoreAnchor(anchor); jumpBtn.hidden = false; }
  }
  function visibleAnchor() {
    const top = log.getBoundingClientRect().top;
    const row = [...log.querySelectorAll<HTMLElement>(".chat-row")].find((element) => element.getBoundingClientRect().bottom >= top);
    return row ? { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top } : null;
  }
  function restoreAnchor(anchor: ReturnType<typeof visibleAnchor>) {
    if (!anchor) return;
    const row = [...log.querySelectorAll<HTMLElement>(".chat-row")].find((element) => element.dataset.messageId === anchor.id);
    if (row) log.scrollTop += row.getBoundingClientRect().top - log.getBoundingClientRect().top - anchor.offset;
  }

  function clearInitialPlaceholders() {
    log.querySelectorAll(".chat-history-skeleton, .chat-history-error").forEach((el) => el.remove());
  }

  async function loadInitial() {
    const revision = ++latestRevision;
    store.startLatest();
    clearInitialPlaceholders();
    log.appendChild(buildInitialSkeleton());
    try {
      const { page, rows } = await fetchMessagePage(supabase, room.id, null, abort.signal);
      if (disposed || revision !== latestRevision) return;
      cacheRowProfiles(rows);
      store.snapshot(page.messages);
      status.hidden = true; jumpBtn.hidden = true; jumpBtn.textContent = "新消息 ↓";
      hasMore = page.hasMore;
      oldestCursor = page.nextCursor;
      clearInitialPlaceholders();
      renderAll();
      scrollToBottom();
    } catch {
      if (disposed || revision !== latestRevision) return;
      clearInitialPlaceholders();
      const error = document.createElement("div");
      error.className = "chat-history-error";
      const text = document.createElement("p");
      text.textContent = "加载失败";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn btn-primary lounge-status-retry";
      retry.textContent = "重试";
      retry.addEventListener("click", () => void loadInitial());
      error.append(text, retry);
      log.appendChild(error);
    }
  }

  async function loadOlder() {
    if (loadingOlder || !hasMore || !oldestCursor) return;
    loadingOlder = true;
    status.hidden = false;
    status.textContent = "正在加载更早的消息…";
    const anchor = visibleAnchor();
    const revision = latestRevision;
    try {
      const { page, rows } = await fetchMessagePage(supabase, room.id, oldestCursor, abort.signal);
      if (disposed || revision !== latestRevision) return;
      cacheRowProfiles(rows);
      store.older(page.messages);
      if (store.readingOlder) { jumpBtn.hidden = false; jumpBtn.textContent = "返回最新 ↓"; }
      hasMore = page.hasMore;
      oldestCursor = page.nextCursor;
      status.hidden = true;
      renderAll();
      // 保持视口停在原来的位置，避免插入历史后跳动。
      restoreAnchor(anchor);
    } catch {
      if (disposed || revision !== latestRevision) return;
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
      .abortSignal(abort.signal).maybeSingle();
    if (!disposed && data) profileCache.set(senderId, data as LoungeProfile);
  }

  async function subscribeRealtime() {
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
          if (disposed) return;
          appendMessage(message);
          if (message.senderId && !profileCache.has(message.senderId)) {
            void resolveNewSender(message.senderId).then(() => { if (!disposed) renderAll(); }).catch(console.error);
          }
        },
      );
    await subscribeChannel(channel, async () => {
      if (disposed) return;
      if (firstConnection) { firstConnection = false; return; }
      if (isNearBottom() && !store.readingOlder) await loadInitial();
      else { store.holdOlder(); jumpBtn.hidden = false; jumpBtn.textContent = "返回最新 ↓"; }
    });
  }

  function onScroll() {
    if (log.scrollTop < NEAR_BOTTOM_PX) void loadOlder();
    if (isNearBottom() && !store.readingOlder) jumpBtn.hidden = true;
  }

  function close() {
    if (disposed) return;
    disposed = true;
    abort.abort();
    log.removeEventListener("scroll", onScroll);
    document.removeEventListener("keydown", onKeydown);
    if (channel) void supabase.removeChannel(channel);
    backdrop.remove();
    previousFocus?.focus();
    if (activeClose === close) activeClose = null;
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") {
      const controls = [...panel.querySelectorAll<HTMLElement>("button, input, textarea, [tabindex]")]
        .filter((element) => !element.hidden && !element.hasAttribute("disabled") && element.getAttribute("tabindex") !== "-1");
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    }
  }

  // ---- wire ----
  activeClose = close;
  closeBtn.addEventListener("click", close);
  backdrop.addEventListener("pointerdown", (event) => {
    if (event.target === backdrop) close();
  });
  jumpBtn.addEventListener("click", () => {
    if (store.readingOlder) void loadInitial();
    else scrollToBottom();
    jumpBtn.hidden = true;
  });
  log.addEventListener("scroll", onScroll);
  document.addEventListener("keydown", onKeydown);

  log.appendChild(buildInitialSkeleton());
  void subscribeRealtime().then(() => { if (!disposed) return loadInitial(); }).catch(() => { if (!disposed) { status.hidden = false; status.textContent = "实时连接失败，请关闭后重试"; } });
  closeBtn.focus();

  return close;
}
