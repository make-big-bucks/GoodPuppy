import { compareMessagePosition, type MessagePosition } from "../../shared/messageOrder.js";
import { bubbleScopeKey, type BubbleScope } from "../../shared/pet/bubbleScope.js";
import { buildMessageList, insertMessage, trimMessages } from "./messageLog.js";
import type { LocalMessage } from "../../types";

// 每只宠物（self / 各 remote）头上一个独立的、可滚动的气泡堆叠。
// 同一窗口内多只宠物各自维护一份消息，DOM 节点挂在各自 .dog-area 的 .bubble-stack 内。
// 最新消息始终是最后一个 .bubble 子节点，靠 CSS :last-child 画指向宠物头的小尾巴。

type StackCallbacks = {
  onRefreshPassthrough: () => void;
  /** 任一堆叠显示/隐藏（影响窗口是否需要为气泡增高）时调用。 */
  onVisibilityChange: () => void;
};

let cbs: StackCallbacks = {
  onRefreshPassthrough: () => {},
  onVisibilityChange: () => {},
};

// 每个 dog-area 对应的消息列表（按时间升序）。
const messagesByArea = new WeakMap<HTMLElement, LocalMessage[]>();

// 关闭游标按查看者/房间/发送者隔离，使用时间与 ID；旧全局数字键不迁移。
const WATERMARK_PREFIX = "gp.bubble.dismissWatermark.";
const watermarkByArea = new WeakMap<HTMLElement, MessagePosition | null>();

function watermarkStorageKey(area: HTMLElement): string | null {
  const key = area.dataset.watermarkKey;
  return key ? WATERMARK_PREFIX + key : null;
}

function loadWatermark(area: HTMLElement): MessagePosition | null {
  if (watermarkByArea.has(area)) return watermarkByArea.get(area) ?? null;
  let value: MessagePosition | null = null;
  try {
    const key = watermarkStorageKey(area);
    const saved = key ? JSON.parse(localStorage.getItem(key) ?? "null") : null;
    if (saved && typeof saved.id === "string" && typeof saved.createdAt === "string" && Number.isFinite(Date.parse(saved.createdAt))) value = saved;
  } catch { /* 仅内存回退 */ }
  watermarkByArea.set(area, value);
  return value;
}
function saveWatermark(area: HTMLElement, value: MessagePosition | null) {
  watermarkByArea.set(area, value);
  try {
    const key = watermarkStorageKey(area);
    if (key) { if (value) localStorage.setItem(key, JSON.stringify(value)); else localStorage.removeItem(key); }
  } catch { /* 仅内存回退 */ }
}
export function setBubbleScope(area: HTMLElement, scope: BubbleScope | null) {
  const key = scope ? bubbleScopeKey(scope) : "";
  if ((area.dataset.watermarkKey ?? "") === key) return;
  area.dataset.watermarkKey = key;
  watermarkByArea.delete(area);
  messagesByArea.set(area, []);
}

export function initBubbleStacks(callbacks: StackCallbacks) {
  cbs = callbacks;
}

export function bubbleClassName(messageId: string, enteringMessageId: string | null): string {
  return messageId === enteringMessageId ? "bubble is-entering" : "bubble";
}

function getStackEl(area: HTMLElement): HTMLElement | null {
  return area.querySelector<HTMLElement>(".bubble-stack");
}

/** 绑定某只宠物气泡堆叠的关闭按钮（hover 才浮现，点击仅隐藏不删消息）。
 * 关闭按钮随气泡每次重建挂到最新气泡上，故用事件委托绑定一次。 */
export function mountStack(area: HTMLElement, storageKey?: string) {
  const stack = getStackEl(area);
  if (!stack) return;
  if (storageKey) area.dataset.watermarkKey = storageKey;
  if (!messagesByArea.has(area)) messagesByArea.set(area, []);
  stack.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".bubble-close")) return;
    event.stopPropagation();
    dismissArea(area);
  });
  renderArea(area, null);
}

function renderArea(area: HTMLElement, enteringMessageId: string | null) {
  const stack = getStackEl(area);
  if (!stack) return;
  const messages = messagesByArea.get(area) ?? [];
  // 清掉旧气泡，保留关闭按钮。
  stack.querySelectorAll(".bubble").forEach((el) => el.remove());

  // 只显示晚于水位线的消息（关闭后到达的新消息）；没有游标时显示全部。
  const watermark = loadWatermark(area);
  const visible = watermark ? messages.filter((m) => compareMessagePosition({ id: m.id, createdAt: m.created_at }, watermark) > 0) : messages;

  if (visible.length === 0) {
    stack.hidden = true;
    cbs.onVisibilityChange();
    cbs.onRefreshPassthrough();
    return;
  }

  for (const message of visible) {
    const bubble = document.createElement("div");
    bubble.className = bubbleClassName(message.id, enteringMessageId);
    bubble.textContent = message.info;
    stack.appendChild(bubble);
  }
  // 关闭按钮锚定在最新气泡（最贴近宠物头那条）右上角，固定可见、不随滚动跑到顶端。
  const latest = stack.querySelector<HTMLElement>(".bubble:last-child");
  if (latest) {
    const closeBtn = document.createElement("button");
    closeBtn.className = "bubble-close";
    closeBtn.type = "button";
    closeBtn.setAttribute("aria-label", "Close messages");
    closeBtn.textContent = "×";
    latest.appendChild(closeBtn);
  }
  stack.hidden = false;
  // 简单版：新消息总是滚到最新（最后一个 .bubble）。
  latest?.scrollIntoView({ block: "nearest" });
  cbs.onVisibilityChange();
  cbs.onRefreshPassthrough();
}

export function setMessagesForArea(
  area: HTMLElement,
  messages: Array<Partial<LocalMessage> | null | undefined>,
) {
  // 历史重放：替换消息列表但保留水位线，水位线以下的旧历史不会重新弹出。
  messagesByArea.set(area, trimMessages(buildMessageList(messages)));
  renderArea(area, null);
}

export function addMessageToArea(area: HTMLElement, message: Partial<LocalMessage> | null | undefined) {
  const history = messagesByArea.get(area) ?? [];
  const { messages, normalized } = insertMessage(history, message);
  if (!normalized) return;
  messagesByArea.set(area, trimMessages(messages));
  // 不清水位线：关闭后只有「晚于水位线」的新消息会显示，历史不再重新弹出。
  renderArea(area, normalized.id);
}

/** 关闭该宠物堆叠：记下当前最新消息时间为水位线（持久化），之后只显示更晚的新消息。 */
export function dismissArea(area: HTMLElement) {
  const messages = messagesByArea.get(area) ?? [];
  const latest = messages.at(-1);
  saveWatermark(area, latest ? { id: latest.id, createdAt: latest.created_at } : null);
  renderArea(area, null);
}

/** 显式重新展开全部堆叠（远程「查看状态」触发），清掉水位线。无消息时无可见效果。 */
export function showArea(area: HTMLElement) {
  saveWatermark(area, null);
  renderArea(area, null);
}

export function clearArea(area: HTMLElement) {
  messagesByArea.delete(area);
  const stack = getStackEl(area);
  stack?.querySelectorAll(".bubble").forEach((el) => el.remove());
  if (stack) stack.hidden = true;
}

export function hasMessagesForArea(area: HTMLElement): boolean {
  return (messagesByArea.get(area)?.length ?? 0) > 0;
}

/** 窗口内是否存在任一可见气泡（决定窗口要不要为气泡增高）。 */
export function hasVisibleBubbles(): boolean {
  return Boolean(document.querySelector(".bubble-stack:not([hidden]) .bubble"));
}
