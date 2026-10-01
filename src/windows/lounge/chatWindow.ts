import type { ChatMessage } from "./chatHistory.js";
export const CHAT_WINDOW_LIMIT = 500;
function micros(iso: string) { return Number((iso.match(/\.(\d+)/)?.[1] ?? "").padEnd(6, "0").slice(3, 6)); }
export function mergeChatMessages(...groups: ChatMessage[][]): ChatMessage[] {
  const byId = new Map(groups.flat().map((message) => [message.id, message]));
  return [...byId.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)
    || micros(a.createdAt) - micros(b.createdAt) || a.id.localeCompare(b.id));
}
/** 首屏缓冲与有界阅读窗口；旧页裁剪新端后，实时消息只提示，显式返回最新页。 */
export function createChatWindow(limit = CHAT_WINDOW_LIMIT) {
  let messages: ChatMessage[] = [];
  let buffered: ChatMessage[] = [];
  let loading = true;
  let olderView = false;
  return {
    get messages() { return messages; },
    get readingOlder() { return olderView; },
    holdOlder() { olderView = true; },
    startLatest() { loading = true; olderView = false; },
    snapshot(page: ChatMessage[]) {
      messages = mergeChatMessages(page, buffered).slice(-limit);
      buffered = []; loading = false; olderView = false;
    },
    older(page: ChatMessage[]) {
      const combined = mergeChatMessages(page, messages);
      if (combined.length > limit) olderView = true;
      messages = combined.slice(0, limit);
    },
    live(message: ChatMessage): boolean {
      if (messages.some((old) => old.id === message.id)) return false;
      if (loading || olderView) { buffered = mergeChatMessages(buffered, [message]).slice(-limit); return false; }
      messages = mergeChatMessages(messages, [message]).slice(-limit);
      return true;
    },
  };
}
