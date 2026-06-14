import type { LocalMessage } from "../../types";

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
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
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

export function canShowPrevious(index: number) {
  return index > 0;
}

export function canShowNext(index: number, length: number) {
  return index >= 0 && index < length - 1;
}
