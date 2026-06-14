// 消息气泡历史的纯逻辑：规范化、按时间排序、去重插入、导航边界。
// 从 renderer.js 抽出——这些是无 DOM、无 IO 的纯函数，便于单测。
// 有状态的 messageHistory 数组与 DOM 渲染仍留在 renderer.js。

export function normalizeMessage(message) {
  if (!message?.info) return null;
  return {
    id: message.id ?? `${Date.now()}-${Math.random()}`,
    info: message.info,
    from: message.from,
    created_at: message.created_at || new Date().toISOString(),
  };
}

export function sortByTime(messages) {
  return [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

// 规范化整段消息、丢弃无效项、按时间排序，用于初始化历史。
export function buildMessageList(messages) {
  return sortByTime(messages.map((m) => normalizeMessage(m)).filter(Boolean));
}

// 去重插入并保持按时间有序。返回新数组与本次规范化结果；
// 当消息无效或 id 已存在时 normalized 为 null（调用方据此判断是否需要重渲染）。
export function insertMessage(history, message) {
  const normalized = normalizeMessage(message);
  if (!normalized) return { messages: history, normalized: null };
  if (history.some((m) => m.id === normalized.id)) {
    return { messages: history, normalized: null };
  }
  return { messages: sortByTime([...history, normalized]), normalized };
}

export function canShowPrevious(index) {
  return index > 0;
}

export function canShowNext(index, length) {
  return index >= 0 && index < length - 1;
}
