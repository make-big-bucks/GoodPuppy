import { compareMessagePosition } from "../../shared/messageOrder.js";
import type { LocalMessage } from "../../types";

/** 每只宠物气泡堆叠在内存中保留的最大条数；超出靠裁剪丢弃最旧的。 */
export const MAX_STACK_MESSAGES = 20;

export function normalizeMessage(message: Partial<LocalMessage> | null | undefined): LocalMessage | null {
  if (!message?.info) return null;
  return {
    id: message.id ?? `${Date.now()}-${Math.random()}`,
    info: message.info,
    from: message.from ?? "",
    created_at: message.created_at || new Date().toISOString(),
  };
}

export function sortByTime(messages: LocalMessage[]) {
  return [...messages].sort(
    (a, b) => compareMessagePosition({ id: a.id, createdAt: a.created_at }, { id: b.id, createdAt: b.created_at }),
  );
}

export function buildMessageList(messages: Array<Partial<LocalMessage> | null | undefined>) {
  return sortByTime(messages.map((m) => normalizeMessage(m)).filter((m): m is LocalMessage => Boolean(m)));
}

export function insertMessage(history: LocalMessage[], message: Partial<LocalMessage> | null | undefined) {
  const normalized = normalizeMessage(message);
  if (!normalized) return { messages: history, normalized: null };
  if (history.some((m) => m.id === normalized.id)) {
    return { messages: history, normalized: null };
  }
  return { messages: sortByTime([...history, normalized]), normalized };
}

/** 裁剪到最近 max 条（保留时间靠后的），用于气泡堆叠容量控制。 */
export function trimMessages(messages: LocalMessage[], max: number = MAX_STACK_MESSAGES) {
  if (max <= 0) return [];
  return messages.length <= max ? messages : messages.slice(messages.length - max);
}

export function canShowPrevious(index: number) {
  return index > 0;
}

export function canShowNext(index: number, length: number) {
  return index >= 0 && index < length - 1;
}
