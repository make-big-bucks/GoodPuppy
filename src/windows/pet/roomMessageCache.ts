import { compareMessagePosition } from "../../shared/messageOrder.js";
import type { LocalMessage } from "../../types";

/** 协调者消息快照的唯一所有者：按完整游标去重排序，并统一限制历史与实时缓存。 */
export function createRoomMessageCache(limit = 200) {
  let messages: LocalMessage[] = [];
  const normalize = (values: LocalMessage[]) => [...new Map(values.map(message => [message.id, message])).values()]
    .sort((a, b) => compareMessagePosition({ id: a.id, createdAt: a.created_at }, { id: b.id, createdAt: b.created_at }))
    .slice(-limit);
  return {
    replace(values: LocalMessage[]) { messages = normalize(values); },
    append(message: LocalMessage) {
      if (messages.some(cached => cached.id === message.id)) return false;
      messages = normalize([...messages, message]);
      return true;
    },
    forSender(senderId: string) { return messages.filter(message => message.from === senderId); },
    get senders() { return [...new Set(messages.map(message => message.from))]; },
    clear() { messages = []; },
  };
}
