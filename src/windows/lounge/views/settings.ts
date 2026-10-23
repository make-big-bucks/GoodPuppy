import { appUpdates } from "../appUpdates.js";
import { createAutostartController } from "../autostartController.js";
import { showToast } from "./toast.js";
// 会客厅设置页（方案 A：整窗内切换）。点侧边栏齿轮 → 隐藏房间布局、显示本视图，
// 左上「← 返回」切回。设置项分组：桌宠 / 通用 / 账号。
//
// 数据流：桌宠偏好（摆放模式 / 大小）由 main 桌宠窗口实际消费。设置页写入 localStorage
// 保证持久化（即便 main 尚未生成），同时 emit 给 main 实时应用；main 的监听再写一次属
// 幂等无副作用。见 petWindowEvents.ts 的 PET_PREF_* 约定。
import {
  readStoredMode,
  writeStoredMode,
  readStoredScale,
  writeStoredScale,
  type PetMode,
} from "../../../shared/pet/preferences.js";
import {
  clampPetScale,
  MIN_PET_SCALE,
  MAX_PET_SCALE,
} from "../../../shared/pet/petLayout.js";
import {
  COORDINATOR_LABEL,
  PET_PREF_MODE,
  PET_PREF_SCALE,
} from "../../../shared/pet/petWindowEvents.js";

export type SettingsAccount = {
  isLoggedIn: boolean;
  isAnonymous: boolean;
  email: string | null;
};

export type SettingsCallbacks = {
  /** 取当前账号信息，用于渲染账号分组。 */
  getAccount: () => SettingsAccount;
  /** 匿名账号点「绑定邮箱」。 */
  onBindAccount: () => void;
  /** 点「退出登录」。 */
  onLogout: () => void;
  /** 点返回。 */
  onClose: () => void;
};

const backIconSvg = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>`;

/** 缩放值 → 显示百分比（DEFAULT_PET_SCALE = 1 即 100%）。导出以便单测。 */
export function scaleToPercent(scale: number) {
  return `${Math.round(clampPetScale(scale) * 100)}%`;
}

function settingsRoot() {
  return document.querySelector<HTMLElement>(".settings-view");
}

function loungeLayout() {
  return document.querySelector<HTMLElement>(".lounge-panel .layout");
}

function buildMarkup() {
  const scale = readStoredScale();
  const mode = readStoredMode();
  return `
    <header class="settings-header">
      <button class="icon-btn settings-back" type="button" aria-label="返回">${backIconSvg}</button>
      <h1 class="settings-title">返回</h1>
    </header>
    <div class="settings-body">
      <section class="settings-group">
        <h2 class="settings-group-title">桌宠</h2>
        <div class="settings-row">
          <div class="settings-row-text">
            <div class="settings-row-label">朋友摆放模式</div>
            <div class="settings-row-desc">自由摆放：每只各自可拖动、记忆位置；自动排布：好友自动一字排开，不可单独拖动。</div>
          </div>
          <div class="settings-segmented" role="group" aria-label="朋友摆放模式">
            <button type="button" class="settings-seg-btn" data-mode="free" aria-pressed="${mode === "free"}">自由摆放</button>
            <button type="button" class="settings-seg-btn" data-mode="semi" aria-pressed="${mode === "semi"}">自动排布</button>
          </div>
        </div>
        <div class="settings-row">
          <div class="settings-row-text">
            <div class="settings-row-label">桌宠大小</div>
            <div class="settings-row-desc">调整桌面上自己这只桌宠的显示大小。</div>
          </div>
          <div class="settings-slider-wrap">
            <input class="settings-scale-slider" type="range"
              min="${MIN_PET_SCALE}" max="${MAX_PET_SCALE}" step="0.05" value="${scale}"
              aria-label="桌宠大小" />
            <span class="settings-scale-value">${scaleToPercent(scale)}</span>
          </div>
        </div>
      </section>

      <section class="settings-group">
        <h2 class="settings-group-title">通用</h2>
        <div class="settings-row">
          <div class="settings-row-text">
            <div class="settings-row-label">开机自启动</div>
            <div class="settings-row-desc">登录系统后自动启动 GoodPuppy。</div>
          </div>
          <button class="settings-toggle" type="button" role="switch" aria-checked="false" aria-label="开机自启动" disabled>
            <span class="settings-toggle-knob"></span>
          </button>
        </div>
      </section>

      <section class="settings-group">
        <h2 class="settings-group-title">应用更新</h2>
        <div class="settings-row"><div class="settings-row-text">
          <div class="settings-row-label settings-update-version">GoodPuppy</div>
          <div class="settings-row-desc settings-update-status" role="status" aria-live="polite"></div>
        </div><button class="small-btn settings-update-btn" type="button">检查更新</button></div>
        <p class="settings-row-desc settings-update-notes" style="white-space: pre-wrap" hidden></p>
      </section>
      <section class="settings-group">
        <h2 class="settings-group-title">诊断</h2>
        <div class="settings-row"><div class="settings-row-text"><div class="settings-row-label">复制诊断记录</div>
          <div class="settings-row-desc">最近的窗口与房间操作记录，不包含口令或消息正文。</div></div>
          <button class="small-btn settings-diagnostics-btn" type="button">复制诊断</button></div>
      </section>
      <section class="settings-group settings-account-group">
        <h2 class="settings-group-title">账号</h2>
        <div class="settings-row settings-account-row"></div>
        <div class="settings-row settings-logout-row">
          <div class="settings-row-text">
            <div class="settings-row-label">退出登录</div>
            <div class="settings-row-desc">退出当前账号。</div>
          </div>
          <button class="small-btn danger settings-logout-btn" type="button">退出登录</button>
        </div>
      </section>
    </div>
  `;
}

function renderAccount(root: HTMLElement, cb: SettingsCallbacks) {
  const accountRow = root.querySelector<HTMLElement>(".settings-account-row");
  if (!accountRow) return;
  const { isAnonymous, email } = cb.getAccount();

  if (isAnonymous || !email) {
    accountRow.innerHTML = `
      <div class="settings-row-text">
        <div class="settings-row-label">邮箱</div>
        <div class="settings-row-desc">当前为匿名账号。绑定邮箱后可在其他设备继续使用。</div>
      </div>
      <button class="small-btn primary settings-bind-btn" type="button">绑定邮箱</button>
    `;
    accountRow
      .querySelector<HTMLButtonElement>(".settings-bind-btn")
      ?.addEventListener("click", () => cb.onBindAccount());
  } else {
    accountRow.innerHTML = `
      <div class="settings-row-text">
        <div class="settings-row-label">邮箱</div>
        <div class="settings-row-desc settings-account-email">${email}</div>
      </div>
    `;
  }
}

const autostart = createAutostartController({
  read: () => window.goodPuppy.isAutostartEnabled(),
  write: (enabled) => window.goodPuppy.setAutostart(enabled),
});
async function wireAutostart(root: HTMLElement) {
  const toggle = root.querySelector<HTMLButtonElement>(".settings-toggle");
  if (!toggle) return;
  const current = () => toggle.isConnected && !root.hidden;
  const apply = (enabled: boolean) => {
    toggle.setAttribute("aria-checked", String(enabled)); toggle.classList.toggle("is-on", enabled);
  };
  if (!window.__TAURI_INTERNALS__) { toggle.title = "请在桌面应用中设置自启动"; return; }
  try {
    const enabled = await autostart.read();
    if (!current()) return;
    apply(enabled); toggle.disabled = false;
  } catch {
    if (current()) { toggle.title = "自启动状态读取失败"; toggle.setAttribute("aria-label", "自启动状态不可用"); showToast("无法读取自启动状态", "error"); }
    return;
  }
  toggle.addEventListener("click", async () => {
    if (toggle.disabled) return;
    const next = toggle.getAttribute("aria-checked") !== "true"; toggle.disabled = true;
    try {
      const result = await autostart.write(next);
      if (current()) apply(result);
    } catch { if (current()) showToast("无法修改自启动设置，请重试", "error"); }
    finally { if (toggle.isConnected) toggle.disabled = false; }
  });
}

function wirePetPrefs(root: HTMLElement) {
  // 摆放模式
  const segBtns = root.querySelectorAll<HTMLButtonElement>(".settings-seg-btn");
  const setMode = (mode: PetMode) => {
    writeStoredMode(mode);
    void window.goodPuppy.emitToWindow(COORDINATOR_LABEL, PET_PREF_MODE, { mode });
    segBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  };
  segBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode === "semi" ? "semi" : "free";
      setMode(mode);
    });
  });

  // 桌宠大小
  const slider = root.querySelector<HTMLInputElement>(".settings-scale-slider");
  const valueLabel = root.querySelector<HTMLElement>(".settings-scale-value");
  slider?.addEventListener("input", () => {
    const scale = clampPetScale(parseFloat(slider.value));
    if (valueLabel) valueLabel.textContent = scaleToPercent(scale);
    writeStoredScale(scale);
    void window.goodPuppy.emitToWindow(COORDINATOR_LABEL, PET_PREF_SCALE, { scale });
  });
}

let releaseUpdates: (() => void) | undefined;
function wireUpdates(root: HTMLElement) {
  releaseUpdates?.();
  const button = root.querySelector<HTMLButtonElement>(".settings-update-btn")!;
  const label = root.querySelector<HTMLElement>(".settings-update-version")!;
  const description = root.querySelector<HTMLElement>(".settings-update-status")!;
  const notes = root.querySelector<HTMLElement>(".settings-update-notes")!;
  if (!window.__TAURI_INTERNALS__) { button.disabled = true; description.textContent = "请在桌面应用中检查更新"; return; }
  releaseUpdates = appUpdates.subscribe((status) => {
    label.textContent = status.currentVersion ? `GoodPuppy ${status.currentVersion}` : "GoodPuppy";
    const messages = {
      idle: "检查是否有可用的新版本", checking: "正在检查更新…", available: `发现新版本 ${status.version ?? ""}`,
      downloading: status.progress === null ? "正在下载更新…" : `正在下载更新 ${status.progress}%`,
      ready: "更新已下载并验证，安装时将退出房间并重启应用", installing: "正在安装并重启…",
      current: "当前已是最新版本", unconfigured: "当前构建尚未启用自动更新", error: "更新失败，请检查网络后重试",
    };
    description.textContent = messages[status.phase];
    button.disabled = ["checking", "downloading", "installing", "unconfigured"].includes(status.phase);
    button.textContent = status.phase === "available" ? "下载更新" : status.phase === "ready" ? "安装并重启" : "检查更新";
    notes.textContent = status.notes; notes.hidden = !status.notes;
  });
  button.onclick = () => { void appUpdates.act(); };
  if (appUpdates.getStatus().phase === "idle") void appUpdates.check();
}

export function openSettings(cb: SettingsCallbacks) {
  const root = settingsRoot();
  const layout = loungeLayout();
  if (!root || !layout) return;

  root.innerHTML = buildMarkup();
  renderAccount(root, cb);
  wirePetPrefs(root);
  void wireAutostart(root);
  wireUpdates(root);

  const diagnostics = root.querySelector<HTMLButtonElement>(".settings-diagnostics-btn");
  if (diagnostics) {
    diagnostics.disabled = !("__TAURI_INTERNALS__" in window);
    diagnostics.onclick = async () => {
      diagnostics.disabled = true;
      try {
        const report = await window.goodPuppy.getDiagnosticReport();
        if (!diagnostics.isConnected) return;
        await navigator.clipboard.writeText(report);
        if (diagnostics.isConnected) diagnostics.textContent = "已复制";
      } catch {
        if (diagnostics.isConnected) diagnostics.textContent = "复制失败，请重试";
      } finally { if (diagnostics.isConnected) diagnostics.disabled = false; }
    };
  }
  root.querySelector<HTMLButtonElement>(".settings-back")?.addEventListener("click", () => cb.onClose());
  root.querySelector<HTMLButtonElement>(".settings-logout-btn")?.addEventListener("click", () => cb.onLogout());

  layout.hidden = true;
  root.hidden = false;
}

export function closeSettings() {
  releaseUpdates?.(); releaseUpdates = undefined;
  const root = settingsRoot();
  const layout = loungeLayout();
  if (root) {
    root.hidden = true;
    root.innerHTML = "";
  }
  if (layout) layout.hidden = false;
}
