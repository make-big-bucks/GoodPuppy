// 写消息「记号棒」：右键菜单触发，在自己宠物头顶弹出一条可输入的举牌式输入条，
// 带发送 ✓ / 取消 ✕ 两个 icon 按钮。仅自己宠物可用。

type ComposeCallbacks = {
  onSubmitMessage: (info: string) => Promise<void>;
  onRefreshPassthrough: () => void;
  /** 展开/收起时调用，让窗口为记号棒预留/收回空间。 */
  onVisibilityChange: () => void;
};

let stickEl: HTMLElement | null = null;
let cbs: ComposeCallbacks = {
  onSubmitMessage: async () => {},
  onRefreshPassthrough: () => {},
  onVisibilityChange: () => {},
};

function getForm() {
  if (stickEl instanceof HTMLFormElement) return stickEl;
  return stickEl?.querySelector<HTMLFormElement>(".compose-form") ?? null;
}
function getInput() {
  return stickEl?.querySelector<HTMLTextAreaElement>(".compose-input") ?? null;
}
function getStatus() {
  return stickEl?.querySelector<HTMLElement>(".compose-status") ?? null;
}

function setStatus(message: string) {
  const status = getStatus();
  if (status) status.textContent = message || "";
}

export function initComposeStick(el: HTMLElement, callbacks: ComposeCallbacks) {
  stickEl = el;
  cbs = callbacks;

  getForm()?.addEventListener("submit", async (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    const input = getInput();
    const info = input?.value.trim();
    if (!info) {
      setStatus("请先输入消息");
      input?.focus();
      return;
    }
    setStatus("正在发送...");
    try {
      await cbs.onSubmitMessage(info);
      setStatus("");
      closeComposeStick();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(message || "发送失败");
      getInput()?.focus();
    }
  });

  stickEl.querySelector(".compose-cancel")?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeComposeStick();
  });
}

export function openComposeStick() {
  if (!stickEl) return;
  const input = getInput();
  stickEl.hidden = false;
  setStatus("");
  // 置顶面板默认不抢焦点；显式取得 key 状态，否则 textarea 收不到键盘输入。
  window.goodPuppy.setFocus("openComposeStick");
  if (input) {
    input.value = "";
    input.focus();
  }
  cbs.onVisibilityChange();
  cbs.onRefreshPassthrough();
}

export function closeComposeStick() {
  if (!stickEl || stickEl.hidden) return;
  stickEl.hidden = true;
  setStatus("");
  const input = getInput();
  if (input) input.value = "";
  cbs.onVisibilityChange();
  cbs.onRefreshPassthrough();
}

export function isComposeOpen(): boolean {
  return Boolean(stickEl && !stickEl.hidden);
}

export function getComposeStickElement(): HTMLElement | null {
  return stickEl;
}
