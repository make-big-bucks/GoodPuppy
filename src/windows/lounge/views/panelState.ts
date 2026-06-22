// 会客厅冷启动状态层：首屏取数时的骨架屏 + 失败时的整屏报错态。
// 只在「窗口内还没有任何数据」时使用，刷新/操作后的更新不走这里（见 lounge.ts 的 hasLoadedOnce）。

const STATUS_CLASS = "lounge-panel-status";

/**
 * 判断一个加载错误是否属于「网络未连接」。纯函数，便于单测。
 * @param error 取数抛出的错误
 * @param online navigator.onLine（默认读全局），离线一律视为网络错误
 */
export function isOfflineError(error: unknown, online: boolean = navigatorOnline()): boolean {
  if (!online) return true;
  const message = errorMessage(error).toLowerCase();
  if (!message) return false;
  return (
    message.includes("failed to fetch") ||
    message.includes("networkerror") ||
    message.includes("network request failed") ||
    message.includes("network error")
  );
}

function navigatorOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    const msg = (error as { message: unknown }).message;
    if (typeof msg === "string") return msg;
  }
  return "";
}

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".lounge-panel");
}

function ensureLayer(): HTMLElement | null {
  const host = panel();
  if (!host) return null;
  let layer = host.querySelector<HTMLElement>(`.${STATUS_CLASS}`);
  if (!layer) {
    layer = document.createElement("div");
    layer.className = STATUS_CLASS;
    host.appendChild(layer);
  }
  return layer;
}

function skeletonBlock(extraClass: string): string {
  return `<span class="gp-skeleton ${extraClass}"></span>`;
}

// 状态层盖住了 .layout 里的拖拽区，这里在顶部补一条等效拖拽条，
// 保证加载/报错期间窗口仍可从顶栏拖动（与 lounge-main.ts 的 .sidebar-drag-region 行为一致）。
function mountDragStrip(layer: HTMLElement): void {
  const strip = document.createElement("div");
  strip.className = "lounge-status-drag";
  strip.addEventListener("mousedown", (event) => {
    if (event.button !== 0) return;
    window.goodPuppy?.startWindowDrag();
  });
  layer.prepend(strip);
}

/** 冷启动取数时，盖一层贴合布局的骨架屏。 */
export function showPanelSkeleton(): void {
  const layer = ensureLayer();
  if (!layer) return;
  layer.classList.remove("is-error");
  layer.classList.add("is-loading");
  const memberSlots = Array.from({ length: 6 })
    .map(
      () => `<div class="lounge-skel-member">
        ${skeletonBlock("lounge-skel-avatar")}
        ${skeletonBlock("lounge-skel-member-name")}
      </div>`,
    )
    .join("");
  const roomRows = Array.from({ length: 4 })
    .map(() => skeletonBlock("lounge-skel-room"))
    .join("");
  layer.innerHTML = `
    <div class="lounge-skel-sidebar">
      <div class="lounge-skel-profile">
        ${skeletonBlock("lounge-skel-avatar")}
        <div class="lounge-skel-profile-text">
          ${skeletonBlock("lounge-skel-line")}
          ${skeletonBlock("lounge-skel-line short")}
        </div>
      </div>
      ${skeletonBlock("lounge-skel-heading")}
      <div class="lounge-skel-rooms">${roomRows}</div>
    </div>
    <div class="lounge-skel-main">
      ${skeletonBlock("lounge-skel-heading")}
      <div class="lounge-skel-members">${memberSlots}</div>
    </div>
  `;
  mountDragStrip(layer);
}

const offlineIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 2 20 20"/><path d="M8.5 16.5a5 5 0 0 1 7 0"/><path d="M2 8.82a15 15 0 0 1 4.17-2.65"/><path d="M10.66 5c4.01-.36 8.14.9 11.34 3.76"/><path d="M16.85 11.25a10 10 0 0 1 2.22 1.68"/><path d="M5 13a10 10 0 0 1 5.24-2.76"/><line x1="12" y1="20" x2="12.01" y2="20"/></svg>`;
const errorIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`;

/** 冷启动取数失败时，整屏报错态 + 重试。 */
export function showPanelError({ offline, onRetry }: { offline: boolean; onRetry: () => void }): void {
  const layer = ensureLayer();
  if (!layer) return;
  layer.classList.remove("is-loading");
  layer.classList.add("is-error");
  const title = offline ? "网络未连接" : "加载失败";
  const hint = offline ? "请检查网络后重试" : "请稍后重试";
  layer.innerHTML = `
    <div class="lounge-status-error">
      <div class="lounge-status-icon">${offline ? offlineIconSvg : errorIconSvg}</div>
      <p class="lounge-status-title">${title}</p>
      <p class="lounge-status-hint">${hint}</p>
      <button class="btn btn-primary lounge-status-retry" type="button">重试</button>
    </div>
  `;
  layer.querySelector<HTMLButtonElement>(".lounge-status-retry")?.addEventListener("click", () => {
    onRetry();
  });
  mountDragStrip(layer);
}

/** 数据就绪后移除状态层。 */
export function hidePanelState(): void {
  panel()?.querySelector(`.${STATUS_CLASS}`)?.remove();
}

/** 当前是否正停在报错态（断网恢复自动重试时用来判断）。 */
export function panelIsInError(): boolean {
  return Boolean(panel()?.querySelector(`.${STATUS_CLASS}.is-error`));
}
