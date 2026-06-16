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

export function initBubbleStacks(callbacks: StackCallbacks) {
  cbs = callbacks;
}

function getStackEl(area: HTMLElement): HTMLElement | null {
  return area.querySelector<HTMLElement>(".bubble-stack");
}

/** 绑定某只宠物气泡堆叠的关闭按钮（hover 才浮现，点击仅隐藏不删消息）。
 * 关闭按钮随气泡每次重建挂到最新气泡上，故用事件委托绑定一次。 */
export function mountStack(area: HTMLElement) {
  const stack = getStackEl(area);
  if (!stack) return;
  if (!messagesByArea.has(area)) messagesByArea.set(area, []);
  stack.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(".bubble-close")) return;
    event.stopPropagation();
    dismissArea(area);
  });
  renderArea(area);
}

function renderArea(area: HTMLElement) {
  const stack = getStackEl(area);
  if (!stack) return;
  const messages = messagesByArea.get(area) ?? [];
  // 清掉旧气泡，保留关闭按钮。
  stack.querySelectorAll(".bubble").forEach((el) => el.remove());

  const dismissed = area.classList.contains("bubbles-dismissed");
  if (messages.length === 0 || dismissed) {
    stack.hidden = true;
    cbs.onVisibilityChange();
    cbs.onRefreshPassthrough();
    return;
  }

  for (const message of messages) {
    const bubble = document.createElement("div");
    bubble.className = "bubble";
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
  messagesByArea.set(area, trimMessages(buildMessageList(messages)));
  area.classList.remove("bubbles-dismissed");
  renderArea(area);
}

export function addMessageToArea(area: HTMLElement, message: Partial<LocalMessage> | null | undefined) {
  const history = messagesByArea.get(area) ?? [];
  const { messages, normalized } = insertMessage(history, message);
  if (!normalized) return;
  messagesByArea.set(area, trimMessages(messages));
  // 新消息到达：撤销「已关闭」状态，重新展开全部堆叠。
  area.classList.remove("bubbles-dismissed");
  renderArea(area);
}

/** 隐藏该宠物堆叠（消息保留在内存，下一条新消息会重新展开）。 */
export function dismissArea(area: HTMLElement) {
  area.classList.add("bubbles-dismissed");
  renderArea(area);
}

/** 重新展开该宠物堆叠（撤销已关闭状态）。无消息时无可见效果。 */
export function showArea(area: HTMLElement) {
  area.classList.remove("bubbles-dismissed");
  renderArea(area);
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
