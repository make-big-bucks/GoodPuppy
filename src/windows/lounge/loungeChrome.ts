import { getCurrentWindow } from "@tauri-apps/api/window";
import { LogicalSize } from "@tauri-apps/api/dpi";
type PageResources = { signal: AbortSignal; own: (release: () => void) => void };

export async function initLoungeChrome(page: PageResources) {
  await initWinTitlebar(page);
  if (page.signal.aborted) return;
  initDragRegion(page); initResizeHandle(page);
}

async function initWinTitlebar(page: PageResources) {
  if (page.signal.aborted || !navigator.platform.startsWith('Win')) return;

  document.body.classList.add('platform-windows');

  // Attach the title bar controls FIRST, synchronously, so they are wired up
  // regardless of how the sizing/show IPC below resolves. (Previously these were
  // attached after the awaits, so a rejected/deferred resize left the title bar
  // visible but undraggable.)
  const dragArea = document.querySelector('.win-titlebar-drag') as HTMLElement | null;
  const minBtn = document.querySelector('.win-minimize-btn') as HTMLButtonElement | null;
  const maxBtn = document.querySelector('.win-maximize-btn') as HTMLButtonElement | null;
  const closeBtn = document.querySelector('.win-close-btn') as HTMLButtonElement | null;

  dragArea?.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    void window.goodPuppy.startWindowDrag().catch(console.error);
  }, { signal: page.signal });

  minBtn?.addEventListener('click', () => {
    void getCurrentWindow().minimize();
  }, { signal: page.signal });

  maxBtn?.addEventListener('click', () => {
    void getCurrentWindow().toggleMaximize();
  }, { signal: page.signal });

  closeBtn?.addEventListener('click', () => {
    void getCurrentWindow().hide();
  }, { signal: page.signal });

  // Rust stripped decorations while the window was hidden. Now resize to compensate
  // for the 28px custom title bar so the app content area matches macOS (720px),
  // then show the window — no flash since it was never visible before this point.
  // Done last (and defensively) so a sizing failure can never block the controls
  // above or leave the window stuck hidden.
  const appWindow = getCurrentWindow();
  try {
    await appWindow.setSize(new LogicalSize(1120, 748));
    if (page.signal.aborted) return;
    await appWindow.setMinSize(new LogicalSize(1040, 708));
  } catch (error) {
    console.warn('Failed to resize lounge window for custom title bar.', error);
  }
  if (!page.signal.aborted) await appWindow.show();
}

function initDragRegion(page: PageResources) {
  const dragRegion = document.querySelector(".sidebar-drag-region") as HTMLElement | null;
  if (!dragRegion) return;
  dragRegion.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    void window.goodPuppy.startWindowDrag().catch(console.error);
  }, { signal: page.signal });
}

function initResizeHandle(page: PageResources) {
  const handle = document.querySelector(".resize-handle") as HTMLElement | null;
  const appWindow = document.querySelector(".app-window") as HTMLElement | null;
  if (!handle || !appWindow) return;

  const MIN_W = 240;
  const MAX_W = 480;

  let stopResize: (() => void) | null = null;
  page.own(() => stopResize?.());

  handle.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stopResize?.();
    const events = new AbortController();

    const startX = e.clientX;
    const startW = (document.querySelector(".sidebar") as HTMLElement).offsetWidth;
    handle.classList.add("is-resizing");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      const newW = Math.max(MIN_W, Math.min(MAX_W, startW + ev.clientX - startX));
      appWindow.style.setProperty("--sidebar-w", `${newW}px`);
    };

    const onUp = () => {
      handle.classList.remove("is-resizing");
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      events.abort();
      stopResize = null;
    };

    stopResize = onUp;
    window.addEventListener("mousemove", onMove, { signal: events.signal });
    window.addEventListener("mouseup", onUp, { signal: events.signal });
    // 切应用/隐藏窗口可能收不到 mouseup，必须释放拖动样式和监听。
    window.addEventListener("blur", onUp, { signal: events.signal });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") onUp();
    }, { signal: events.signal });
  }, { signal: page.signal });
}

