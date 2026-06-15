import { buildMessageList, insertMessage, canShowPrevious, canShowNext } from "./messageLog.js";
import type { LocalMessage } from "../../types";

type BubbleCallbacks = {
  onRefreshPassthrough: () => void;
  onSubmitMessage: (info: string) => Promise<void>;
};

let bubbleEl: HTMLElement | null = null;
let cbs: BubbleCallbacks = {
  onRefreshPassthrough: () => {},
  onSubmitMessage: async () => {},
};
let messageHistory: LocalMessage[] = [];
let messageIndex = -1;
let isUnread = false;

function getBubbleTextElement() {
  return bubbleEl?.querySelector<HTMLElement>(".bubble-text") ?? null;
}
function getBubblePrevButton() {
  return bubbleEl?.querySelector<HTMLButtonElement>(".bubble-prev") ?? null;
}
function getBubbleNextButton() {
  return bubbleEl?.querySelector<HTMLButtonElement>(".bubble-next") ?? null;
}
function getBubbleAlert() {
  return bubbleEl?.querySelector<HTMLElement>(".message-alert") ?? null;
}
function getBubbleComposer() {
  return bubbleEl?.querySelector<HTMLFormElement>(".bubble-composer") ?? null;
}
function getBubbleInput() {
  return bubbleEl?.querySelector<HTMLTextAreaElement>(".bubble-input") ?? null;
}
function getBubbleStatus() {
  return bubbleEl?.querySelector<HTMLElement>(".bubble-status") ?? null;
}

function setComposerStatus(message: string) {
  const status = getBubbleStatus();
  if (status) status.textContent = message || "";
}

function setBubbleText(text: string) {
  const el = getBubbleTextElement();
  if (el) el.textContent = text;
}

function updateBubbleNav() {
  const prev = getBubblePrevButton();
  const next = getBubbleNextButton();
  if (prev) prev.disabled = !canShowPrevious(messageIndex);
  if (next) next.disabled = !canShowNext(messageIndex, messageHistory.length);
}

function renderMessageAt(index: number, { markUnread = false }: { markUnread?: boolean } = {}) {
  const message = messageHistory[index];
  if (!message || !bubbleEl) {
    updateBubbleNav();
    return;
  }
  messageIndex = index;
  setBubbleText(message.info);
  bubbleEl.hidden = false;
  setUnread(markUnread);
  updateBubbleNav();
  cbs.onRefreshPassthrough();
}

export function initMessageBubble(el: HTMLElement, callbacks: BubbleCallbacks) {
  bubbleEl = el;
  cbs = callbacks;

  const composer = getBubbleComposer();
  const cancelButton = bubbleEl.querySelector(".bubble-cancel");

  composer?.addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const input = getBubbleInput();
    const info = input?.value.trim();
    if (!info) {
      setComposerStatus("请先输入消息");
      input?.focus();
      return;
    }
    setComposerStatus("正在发送...");
    try {
      await cbs.onSubmitMessage(info);
      setComposerStatus("");
      closeComposer();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setComposerStatus(message || "发送失败");
      getBubbleInput()?.focus();
    }
  });

  cancelButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeComposer();
  });

  getBubblePrevButton()?.addEventListener("click", (event) => {
    event.stopPropagation();
    showPreviousMessage();
  });

  getBubbleNextButton()?.addEventListener("click", (event) => {
    event.stopPropagation();
    showNextMessage();
  });

  bubbleEl.querySelector<HTMLElement>(".bubble-compose")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openComposer();
  });

  getBubbleAlert()?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

export function setLocalMessages(messages: Array<Partial<LocalMessage> | null | undefined>) {
  const normalized = buildMessageList(messages);
  messageHistory.length = 0;
  messageHistory.push(...normalized);
  if (normalized.length === 0) {
    messageIndex = -1;
    setBubbleText("");
    setUnread(false);
    updateBubbleNav();
    return;
  }
  renderMessageAt(normalized.length - 1, { markUnread: false });
}

export function addLocalMessage(
  message: Partial<LocalMessage> | null | undefined,
  { markUnread = false }: { markUnread?: boolean } = {},
) {
  const { messages, normalized } = insertMessage(messageHistory, message);
  if (!normalized) return;
  messageHistory.length = 0;
  messageHistory.push(...messages);
  renderMessageAt(messageHistory.length - 1, { markUnread });
}

export function setUnread(hasUnread: boolean) {
  isUnread = hasUnread;
  bubbleEl?.classList.toggle("has-unread", hasUnread);
}

export function showPreviousMessage() {
  if (canShowPrevious(messageIndex)) renderMessageAt(messageIndex - 1);
}

export function showNextMessage() {
  if (canShowNext(messageIndex, messageHistory.length)) renderMessageAt(messageIndex + 1);
}

export function showMessageBubble() {
  if (messageHistory.length === 0) return;
  renderMessageAt(messageIndex >= 0 ? messageIndex : messageHistory.length - 1, {
    markUnread: false,
  });
}

export function closeMessageBubble() {
  if (!bubbleEl || bubbleEl.hidden) return;
  bubbleEl.hidden = true;
  setUnread(false);
  cbs.onRefreshPassthrough();
}

export function openComposer() {
  if (!bubbleEl) return;
  const composer = getBubbleComposer();
  const input = getBubbleInput();
  if (!composer || !input) return;
  bubbleEl.hidden = false;
  bubbleEl.classList.add("is-editing");
  setUnread(false);
  setComposerStatus("");
  composer.hidden = false;
  input.value = "";
  input.focus();
  cbs.onRefreshPassthrough();
}

export function closeComposer() {
  if (!bubbleEl) return;
  const composer = getBubbleComposer();
  const input = getBubbleInput();
  if (!composer || !input) return;
  bubbleEl.classList.remove("is-editing");
  composer.hidden = true;
  setComposerStatus("");
  input.value = "";
  cbs.onRefreshPassthrough();
}

export function isComposerOpen(): boolean {
  return bubbleEl?.classList.contains("is-editing") ?? false;
}

export function getBubbleElement(): HTMLElement | null {
  return bubbleEl;
}

export function hasMessages(): boolean {
  return messageHistory.length > 0;
}

export function isBubbleHidden(): boolean {
  return bubbleEl?.hidden ?? true;
}
