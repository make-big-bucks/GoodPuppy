import { createRefreshController } from "../../shared/refreshController.js";
import { fetchLoungeData, type LoungeData, type LoungeDataContext } from "./loungeData.js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { renderRoomList, renderPendingRequests } from "./views/room-list.js";
import type { PendingTransition } from "./views/room-list.js";
import { renderRoomDetail } from "./views/room-detail.js";
import { renderProfileCard } from "./views/profile-card.js";
import { openChatHistory } from "./views/chat-history-dialog.js";
import { showToast } from "./views/toast.js";
import { showPanelSkeleton, showPanelError, hidePanelState, panelIsInError, isOfflineError } from "./views/panelState.js";
import { initShowcase, openShowcase } from "./views/pet-showcase.js";
import { openSettings, closeSettings } from "./views/settings.js";
import { buildMemberViewModels, mapPendingRoomInvitationRows, normalizeGpId } from "./loungeViewModels.js";
import {
  initOnlineNotifier,
  disposeOnlineNotifier,
  onPresenceChange as notifyPresenceChange,
  seedSnapshot as seedNotifierSnapshot,
  syncRooms as syncNotifierRooms,
  isRoomSubscribed,
  setRoomSubscribed,
  dismissAllToasts,
} from "./onlineNotifier.js";
import type {
  ConnectionRequestRow,
  LoungeMemberRow,
  LoungePresenceRow,
  LoungeProfile,
  LoungeRoom,
  PendingRoomInvitationRow,
} from "../../types";

type LoungePanelOptions = {
  supabase: SupabaseClient;
  selfAuthId: string | null;
  isAnonymous: boolean;
  email: string | null;
  getActiveRoomId: () => string | null;
  onEnterRoom: (roomId: string) => Promise<void>;
  onExitRoom: () => Promise<void>;
  onLoginSuccess: () => void;
  onLogout: () => void;
  // 换肤面板「保存」后，把皮肤同步给 pet 窗口（presence 通道 A）。
  onSkinSaved: (skin: string) => void;
};

type UpdatePanelAuthOptions = {
  supabase: SupabaseClient;
  selfAuthId: string | null;
  isAnonymous: boolean;
  email: string | null;
};

type InputModalOptions = {
  title: string;
  label?: string;
  placeholder: string;
  submitText?: string;
  initialValue?: string;
  validate?: (value: string) => string;
  onSubmit: (value: string) => Promise<void>;
};

type RoomMetadataUpdate = {
  roomName: string;
  description: string;
};

type RoomMembershipRow = {
  room_id: string;
  rooms?: {
    id?: string;
    room_name?: string;
    description?: string;
    invite_code?: string;
    created_by?: string;
  } | null;
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object" && "message" in error && typeof (error as { message: unknown }).message === "string") {
    return (error as { message: string }).message || fallback;
  }
  return fallback;
}

function targetElement(target: EventTarget | null) {
  return target instanceof Element ? target : null;
}

function requiredQuery<T extends Element>(root: ParentNode, selector: string) {
  const element = root.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Missing required element: ${selector}`);
  }
  return element;
}

let authRevision = 0;
let supabaseClient: SupabaseClient | null = null;
let selfAuthId: string | null = null;
let currentUserIsAnonymous = false;
let currentUserEmail: string | null = null;
let getActiveRoomId: (() => string | null) | null = null;
let onEnterRoom: ((roomId: string) => Promise<void>) | null = null;
let onExitRoom: (() => Promise<void>) | null = null;
let onLoginSuccess: (() => void) | null = null;
let onLogout: (() => void) | null = null;
let onSkinSaved: ((skin: string) => void) | null = null;

const gearIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeOffSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;
const dogLogoSvg = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M18 47V31C18 20 26 13 37 13C48 13 55 21 55 32C55 41 49 47 39 47H31" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 31C12 33 9 38 9 47" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M38 47V54" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><circle cx="43" cy="28" r="3" fill="currentColor"/></svg>`;
const userInputSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2"/></svg>`;
const passwordInputSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const pawInputSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="6.5" cy="11" r="1.6" stroke="currentColor" stroke-width="1.6"/><circle cx="10" cy="7.5" r="1.6" stroke="currentColor" stroke-width="1.6"/><circle cx="14" cy="7.5" r="1.6" stroke="currentColor" stroke-width="1.6"/><circle cx="17.5" cy="11" r="1.6" stroke="currentColor" stroke-width="1.6"/><path d="M8.5 15.5c0-2 1.6-3.2 3.5-3.2s3.5 1.2 3.5 3.2c0 1.7-1.3 2.7-3.5 2.7s-3.5-1-3.5-2.7Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

let rooms: LoungeRoom[] = [];
let pendingRequests: ConnectionRequestRow[] = [];
let selectedRoomId: string | null = null;
let requestChannel: RealtimeChannel | null = null;
let sentRequestChannel: RealtimeChannel | null = null;
let presenceChannel: RealtimeChannel | null = null;
let roomMembersChannel: RealtimeChannel | null = null;
let profilesChannel: RealtimeChannel | null = null;
let pendingTransition: PendingTransition | null = null;
let currentProfile: LoungeProfile | null = null;
// 冷启动判定：窗口内是否已成功加载过一次数据。仅首屏（false 时）走骨架屏/整屏报错。
let hasLoadedOnce = false;
// online 监听只注册一次。
let onlineListenerBound = false;

const panel = () => document.querySelector<HTMLElement>(".lounge-panel");
const modalBackdrop = () => document.querySelector<HTMLElement>(".lounge-modal-backdrop");
const modalForm = () => document.querySelector<HTMLFormElement>(".lounge-modal");

function getSelectedRoom() {
  return rooms.find((room) => room.id === selectedRoomId) || null;
}

function setModalMessage(text: string) {
  const el = modalForm()?.querySelector<HTMLElement>(".lounge-form-message");
  if (el) el.textContent = text || "";
}

// 提交/确认按钮的加载态：保留按钮文字，仅在文字前插入一个 spinner。
// 记住原始 HTML，结束时还原（按钮若随 modal 关闭已隐藏，还原也无害）。
function setButtonLoading(btn: HTMLButtonElement | null | undefined, loading: boolean) {
  if (!btn) return;
  if (loading) {
    if (btn.dataset.loading === "true") return;
    btn.dataset.loading = "true";
    btn.dataset.originalHtml = btn.innerHTML;
    const label = btn.textContent ?? "";
    btn.innerHTML = `<span class="btn-spinner btn-spinner-inline"></span>`;
    btn.append(label);
  } else {
    if (btn.dataset.loading !== "true") return;
    btn.dataset.loading = "false";
    if (btn.dataset.originalHtml !== undefined) {
      btn.innerHTML = btn.dataset.originalHtml;
      delete btn.dataset.originalHtml;
    }
  }
}

function setModalBusy(isBusy: boolean) {
  modalForm()?.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement>("input, textarea, button").forEach((el) => {
    el.disabled = isBusy;
  });
}

function closeModal() {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (backdrop) backdrop.hidden = true;
  if (form) {
    form.classList.remove("lounge-login-modal");
    form.onsubmit = null;
  }
}

const checkSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

async function copyToClipboard(text: string | null | undefined, btn: HTMLButtonElement) {
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const original = btn.innerHTML;
    btn.innerHTML = checkSvg;
    setTimeout(() => {
      btn.innerHTML = original;
    }, 1500);
  } catch {
    showToast("复制失败", "error");
  }
}

function renderProfile(profile: LoungeProfile | null) {
  currentProfile = profile;
  renderProfileCard(profile);
}

function handleSkinChange(skin: string) {
  if (currentProfile) {
    currentProfile = { ...currentProfile, skin };
    renderProfileCard(currentProfile);
  }
  for (const room of rooms) {
    for (const member of room.members) {
      if (member.isSelf) member.skin = skin;
    }
  }
  renderAll();
  // 通知 pet 窗口应用新皮肤（动画 + presence 广播给远程好友）。
  onSkinSaved?.(skin);
}

function renderAuthState(isLoggedIn: boolean) {
  const profileSection = document.querySelector<HTMLElement>(".profile-section");
  profileSection?.classList.toggle("is-unauth", !isLoggedIn);

  const sidebarActions = document.querySelector<HTMLElement>(".sidebar-actions");
  if (sidebarActions) sidebarActions.hidden = !isLoggedIn;

  const requestList = document.querySelector<HTMLElement>(".lounge-request-list");
  if (requestList && !isLoggedIn) requestList.hidden = true;

  const emptyDetail = document.querySelector<HTMLElement>(".lounge-empty-detail");
  if (emptyDetail) {
    emptyDetail.textContent = isLoggedIn ? "选择一个房间查看成员" : "登录后即可查看你的房间和邀请";
  }

  // 齿轮 = 设置入口；未登录不提供入口（退出登录、绑定邮箱均已收进设置页）。
  const settingsBtn = document.querySelector<HTMLButtonElement>(".lounge-settings-btn");
  if (settingsBtn) {
    settingsBtn.hidden = !isLoggedIn;
    settingsBtn.setAttribute("aria-label", "设置");
    settingsBtn.innerHTML = gearIconSvg;
  }

  if (!isLoggedIn) {
    closeSettings();
    const roomDetail = document.querySelector<HTMLElement>(".lounge-room-detail");
    if (roomDetail) roomDetail.hidden = true;
  }
}

const loginBrandHtml = `
    <section class="lounge-login-brand">
      <div class="lounge-login-logo">${dogLogoSvg}</div>
      <h2 class="lounge-login-title">GoodPuppy</h2>
      <p class="lounge-login-subtitle">和朋友一起出现在彼此的桌面上</p>
    </section>`;

function openLoginDialog() {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.classList.add("lounge-login-modal");

  // 领养首屏：匿名登录 + 给宠物取名（名字必填）。
  function renderAdoptScreen() {
    form!.innerHTML = `
    ${loginBrandHtml}
    <div class="lounge-login-field">
      <label for="adopt-name">给你的宠物取个名字</label>
      <div class="lounge-login-input-box">
        ${pawInputSvg}
        <input class="lounge-login-input" id="adopt-name" name="petName" type="text" autocomplete="off" maxlength="20" placeholder="比如：泡芙" required />
      </div>
    </div>
    <p class="lounge-form-message" role="status"></p>
    <button class="lounge-auth-button lounge-auth-primary lounge-form-submit" type="submit" disabled>领养并进入</button>
    <p class="lounge-adopt-hint">无需注册账号，稍后可以绑定邮箱</p>
    <div class="lounge-login-divider">或</div>
    <button class="lounge-auth-button lounge-auth-secondary lounge-show-email" type="button">已有账号？用邮箱上线</button>
  `;

    const nameInput = requiredQuery<HTMLInputElement>(form!, "#adopt-name");
    const submitBtn = requiredQuery<HTMLButtonElement>(form!, ".lounge-form-submit");
    const showEmailBtn = requiredQuery<HTMLButtonElement>(form!, ".lounge-show-email");

    setModalMessage("");
    setModalBusy(false);
    nameInput.focus();

    const syncSubmitState = () => { submitBtn.disabled = nameInput.value.trim().length === 0; };
    syncSubmitState();
    nameInput.addEventListener("input", syncSubmitState);

    showEmailBtn.addEventListener("click", () => { renderEmailScreen(); });
    form!.onsubmit = (event) => {
      event.preventDefault();
      void doAdopt(nameInput.value.trim(), submitBtn);
    };
  }

  // 邮箱登录屏：已有账号上线 / 创建新账号，可返回领养首屏。
  function renderEmailScreen() {
    form!.innerHTML = `
    ${loginBrandHtml}
    <div class="lounge-login-field">
      <label for="login-email">账号</label>
      <div class="lounge-login-input-box">
        ${userInputSvg}
        <input class="lounge-login-input" id="login-email" name="email" type="email" autocomplete="email" placeholder="邮箱 / 账号" required />
      </div>
    </div>
    <div class="lounge-login-field">
      <label for="login-password">密码</label>
      <div class="lounge-login-input-box login-password-wrap">
        ${passwordInputSvg}
        <input class="lounge-login-input login-password-input" id="login-password" name="password" type="password" autocomplete="current-password" placeholder="输入密码" minlength="6" required />
        <button class="login-password-toggle" type="button" aria-label="显示密码">${eyeSvg}</button>
      </div>
    </div>
    <p class="lounge-form-message" role="status"></p>
    <button class="lounge-auth-button lounge-auth-primary lounge-form-submit" type="submit">上线</button>
    <div class="lounge-login-divider">或</div>
    <button class="lounge-auth-button lounge-auth-secondary lounge-form-register" type="button">创建新账号</button>
    <button class="lounge-auth-button lounge-quick-entry lounge-back-adopt" type="button">← 返回领养宠物</button>
  `;

    const emailInput = requiredQuery<HTMLInputElement>(form!, "#login-email");
    const passwordInput = requiredQuery<HTMLInputElement>(form!, ".login-password-input");
    const passwordToggle = requiredQuery<HTMLButtonElement>(form!, ".login-password-toggle");
    const registerBtn = requiredQuery<HTMLButtonElement>(form!, ".lounge-form-register");
    const submitBtn = requiredQuery<HTMLButtonElement>(form!, ".lounge-form-submit");
    const backBtn = requiredQuery<HTMLButtonElement>(form!, ".lounge-back-adopt");

    setModalMessage("");
    setModalBusy(false);
    emailInput.focus();

    passwordToggle.addEventListener("click", () => {
      const shouldShow = passwordInput.type === "password";
      passwordInput.type = shouldShow ? "text" : "password";
      passwordToggle.innerHTML = shouldShow ? eyeOffSvg : eyeSvg;
      passwordToggle.setAttribute("aria-label", shouldShow ? "隐藏密码" : "显示密码");
      passwordInput.focus();
    });

    async function doSignIn() {
      if (!supabaseClient) return;
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) { setModalMessage("请填写邮箱和密码"); return; }
      setModalBusy(true);
      setButtonLoading(submitBtn, true);
      setModalMessage("正在登录...");
      try {
        const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
        if (error) throw error;
        closeModal();
        onLoginSuccess?.();
      } catch (error) {
        setModalMessage(getErrorMessage(error, "登录失败"));
      } finally {
        setButtonLoading(submitBtn, false);
        setModalBusy(false);
      }
    }

    async function doSignUp() {
      if (!supabaseClient) return;
      const email = emailInput.value.trim();
      const password = passwordInput.value;
      if (!email || !password) { setModalMessage("请填写邮箱和密码"); return; }
      setModalBusy(true);
      setButtonLoading(registerBtn, true);
      setModalMessage("正在注册...");
      try {
        const { data, error } = await supabaseClient.auth.signUp({ email, password });
        if (error) throw error;
        if (data.session) {
          closeModal();
          onLoginSuccess?.();
        } else {
          setModalMessage("注册成功，请检查邮箱确认账号");
          setButtonLoading(registerBtn, false);
          setModalBusy(false);
        }
      } catch (error) {
        setModalMessage(getErrorMessage(error, "注册失败"));
        setButtonLoading(registerBtn, false);
        setModalBusy(false);
      }
    }

    registerBtn.addEventListener("click", () => { void doSignUp(); });
    backBtn.addEventListener("click", () => { renderAdoptScreen(); });
    form!.onsubmit = (event) => { event.preventDefault(); void doSignIn(); };
  }

  // 匿名登录成功后立刻把宠物名写入 profiles（onConflict 更新，非 ignoreDuplicates），
  // 预创建行，避开 loadPanelData 的空名兜底；对 pet 窗口 ignoreDuplicates upsert 无竞态影响。
  async function doAdopt(name: string, submitBtn: HTMLButtonElement) {
    if (!supabaseClient) return;
    if (!name) { setModalMessage("请先给宠物取个名字"); return; }
    setModalBusy(true);
    setButtonLoading(submitBtn, true);
    setModalMessage("正在领养...");
    try {
      const { data, error } = await supabaseClient.auth.signInAnonymously();
      if (error) throw error;
      const userId = data.user?.id;
      if (userId) {
        const { error: profileError } = await supabaseClient
          .from("profiles")
          .upsert({ id: userId, display_name: name, pet_id: "default" }, { onConflict: "id", ignoreDuplicates: true });
        if (profileError) throw profileError;
        const { error: nameError } = await supabaseClient.from("profiles").update({ display_name: name }).eq("id", userId);
        if (nameError) throw nameError;
      }
      closeModal();
      onLoginSuccess?.();
    } catch (error) {
      setModalMessage(getErrorMessage(error, "领养失败"));
      setButtonLoading(submitBtn, false);
      setModalBusy(false);
    }
  }

  backdrop.hidden = false;
  renderAdoptScreen();
}

function openSettingsView() {
  // 邮箱来自启动时 getSession() 拿到的会话（onAuthStateChange 持续同步），这里无需再发
  // getUser() 网络请求，直接同步打开设置页，点齿轮即开、不卡顿。
  openSettings({
    getAccount: () => ({
      isLoggedIn: Boolean(selfAuthId),
      isAnonymous: currentUserIsAnonymous,
      email: currentUserEmail,
    }),
    onBindAccount: () => openBindAccountDialog(),
    onLogout: () => openLogoutConfirmDialog(),
    onClose: () => closeSettings(),
  });
}

function openLogoutConfirmDialog() {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  const confirmText = currentUserIsAnonymous
    ? "当前是匿名账号。退出登录后，本机将不再保留这个匿名账号的信息；如果想保留账号，请先绑定邮箱。"
    : "确认要退出登录吗？";

  form.classList.remove("lounge-login-modal");
  form.innerHTML = `
    <h2 class="modal-title">退出登录</h2>
    <p class="lounge-confirm-text">${confirmText}</p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn danger lounge-logout-confirm" type="button">退出登录</button>
    </div>
  `;

  const cancel = requiredQuery<HTMLButtonElement>(form, ".lounge-form-cancel");
  const logoutBtn = requiredQuery<HTMLButtonElement>(form, ".lounge-logout-confirm");

  backdrop.hidden = false;

  cancel.onclick = closeModal;
  logoutBtn.onclick = async () => {
    logoutBtn.disabled = true;
    setButtonLoading(logoutBtn, true);
    if (onExitRoom) {
      try { await onExitRoom(); } catch { /* ignore */ }
    }
    await supabaseClient?.auth.signOut();
    closeModal();
    closeSettings();
    onLogout?.();
  };
}

function openBindAccountDialog() {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.classList.add("lounge-login-modal");
  form.innerHTML = `
    <section class="lounge-login-brand">
      <div class="lounge-login-logo">${dogLogoSvg}</div>
      <h2 class="lounge-login-title">绑定账号</h2>
      <p class="lounge-login-subtitle">绑定邮箱后，可以在其他设备继续使用这个账号</p>
    </section>
    <div class="lounge-login-field">
      <label for="bind-email">邮箱</label>
      <div class="lounge-login-input-box">
        ${userInputSvg}
        <input class="lounge-login-input" id="bind-email" name="email" type="email" autocomplete="email" placeholder="输入邮箱" required />
      </div>
    </div>
    <div class="lounge-login-field">
      <label for="bind-password">密码</label>
      <div class="lounge-login-input-box login-password-wrap">
        ${passwordInputSvg}
        <input class="lounge-login-input login-password-input" id="bind-password" name="password" type="password" autocomplete="new-password" placeholder="设置密码" minlength="6" required />
        <button class="login-password-toggle" type="button" aria-label="显示密码">${eyeSvg}</button>
      </div>
    </div>
    <p class="lounge-form-message" role="status"></p>
    <button class="lounge-auth-button lounge-auth-primary lounge-form-submit" type="submit">绑定账号</button>
  `;

  const emailInput = requiredQuery<HTMLInputElement>(form, "#bind-email");
  const passwordInput = requiredQuery<HTMLInputElement>(form, ".login-password-input");
  const passwordToggle = requiredQuery<HTMLButtonElement>(form, ".login-password-toggle");

  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;
  emailInput.focus();

  passwordToggle.addEventListener("click", () => {
    const shouldShow = passwordInput.type === "password";
    passwordInput.type = shouldShow ? "text" : "password";
    passwordToggle.innerHTML = shouldShow ? eyeOffSvg : eyeSvg;
    passwordToggle.setAttribute("aria-label", shouldShow ? "隐藏密码" : "显示密码");
    passwordInput.focus();
  });

  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!supabaseClient) return;

    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) {
      setModalMessage("请填写邮箱和密码");
      return;
    }

    setModalBusy(true);
    setModalMessage("正在绑定...");
    try {
      const { data, error } = await supabaseClient.auth.updateUser({ email, password });
      if (error) throw error;

      currentUserIsAnonymous = Boolean(data.user?.is_anonymous);
      currentUserEmail = data.user?.email ?? currentUserEmail;
      renderAuthState(Boolean(selfAuthId));
      closeModal();
      showToast(currentUserIsAnonymous ? "请检查邮箱完成绑定" : "账号已绑定");
    } catch (error) {
      setModalMessage(getErrorMessage(error, "绑定失败"));
    } finally {
      setModalBusy(false);
    }
  };
}

function openLeaveRoomPermanentDialog(room: LoungeRoom) {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  const isLastMember = room.members.length === 1;
  const bodyText = isLastMember
    ? "你是此房间的最后一位成员。退出后，房间及其所有内容将被永久删除，无法恢复。"
    : "退出后，此房间将从你的列表消失，且无法撤销。";

  form.classList.remove("lounge-login-modal");
  form.innerHTML = `
    <h2 class="modal-title">永久退出房间</h2>
    <p class="lounge-confirm-text">${bodyText}</p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn danger lounge-leave-permanent-confirm" type="button">确认退出</button>
    </div>
  `;

  const cancel = requiredQuery<HTMLButtonElement>(form, ".lounge-form-cancel");
  const confirmBtn = requiredQuery<HTMLButtonElement>(form, ".lounge-leave-permanent-confirm");

  backdrop.hidden = false;

  cancel.onclick = closeModal;
  confirmBtn.onclick = async () => {
    confirmBtn.disabled = true;
    setButtonLoading(confirmBtn, true);
    try {
      if (getActiveRoomId?.() === room.id && onExitRoom) {
        try { await onExitRoom(); } catch { /* ignore */ }
      }
      const { error } = await supabaseClient!.rpc("leave_room", { p_room_id: room.id });
      if (error) throw error;
      closeModal();
      selectedRoomId = null;
      showToast("已永久退出房间");
      await loadPanelData();
    } catch (error) {
      closeModal();
      showToast(getErrorMessage(error, "操作失败"), "error");
    }
  };
}

function onRoomSelect(id: string) {
  selectedRoomId = id;
  renderAll();
}

function renderAll() {
  renderRoomList(rooms, selectedRoomId, getActiveRoomId?.() || null, onRoomSelect, pendingTransition);
  renderPendingRequests(pendingRequests);
  renderRoomDetail(getSelectedRoom(), selfAuthId, getActiveRoomId?.() || null, pendingTransition, {
    isSubscribed: isRoomSubscribed,
    onToggle: (roomId, on) => {
      setRoomSubscribed(roomId, on);
      renderAll();
    },
  });
}

let panelSnapshot: LoungeData | null = null;
const panelRefresh = createRefreshController<LoungeDataContext, LoungeData>({
  load: async (context, signal) => {
    if (!hasLoadedOnce) showPanelSkeleton();
    return fetchLoungeData(context, signal);
  },
  commit: (snapshot) => {
    panelSnapshot = snapshot;
    renderProfile(snapshot.profile);
    rebuildRoomViews();
    pendingRequests = mapPendingRoomInvitationRows(snapshot.invitations);
    if (!selectedRoomId || !rooms.some((room) => room.id === selectedRoomId)) selectedRoomId = rooms[0]?.id ?? null;
    seedNotifierSnapshot(snapshot.allPresence);
    syncNotifierRooms();
    hasLoadedOnce = true;
    hidePanelState();
    renderAll();
  },
  error: (error) => {
    if (!hasLoadedOnce) showPanelError({ offline: isOfflineError(error), onRetry: () => void loadPanelData() });
    else showToast(getErrorMessage(error, "加载失败"), "error");
  },
});
function rebuildRoomViews() {
  const snapshot = panelSnapshot;
  if (!snapshot) return;
  rooms = snapshot.myRooms.map((item) => ({
    id: item.room_id,
    room_name: item.rooms?.room_name || "未命名房间",
    description: item.rooms?.description || "",
    invite_code: item.rooms?.invite_code || "",
    created_by: item.rooms?.created_by || "",
    members: buildMemberViewModels(
      snapshot.allMembers.filter((member) => member.room_id === item.room_id),
      snapshot.allPresence,
      selfAuthId,
      item.room_id,
      getActiveRoomId?.() || null,
    ),
  }));
}
function loadPanelData() { return panelRefresh.refresh(); }

function openInputModal({
  title,
  label,
  placeholder,
  submitText = "确定",
  initialValue = "",
  validate,
  onSubmit,
}: InputModalOptions) {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.classList.remove("lounge-login-modal");
  form.innerHTML = `
    <h2 class="modal-title lounge-modal-title"></h2>
    <div class="lounge-form-field">
      ${label ? `<label class="lounge-form-label" for="modal-input">${label}</label>` : ""}
      <input class="lounge-input" id="modal-input" name="modal-value" autocomplete="off" />
    </div>
    <p class="lounge-form-message" role="status"></p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn primary lounge-form-submit" type="submit">确定</button>
    </div>
  `;

  const titleEl = requiredQuery<HTMLElement>(form, ".lounge-modal-title");
  const input = requiredQuery<HTMLInputElement>(form, ".lounge-input");
  const submit = requiredQuery<HTMLButtonElement>(form, ".lounge-form-submit");
  const cancel = requiredQuery<HTMLButtonElement>(form, ".lounge-form-cancel");

  titleEl.textContent = title;
  input.value = initialValue;
  input.placeholder = placeholder;
  submit.textContent = submitText;
  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;

  cancel.onclick = closeModal;
  input.focus();

  form.onsubmit = async (event) => {
    event.preventDefault();
    const value = input.value.trim();
    const validationMessage = validate?.(value);
    if (validationMessage) {
      setModalMessage(validationMessage);
      return;
    }

    setModalBusy(true);
    setButtonLoading(submit, true);
    try {
      await onSubmit(value);
      closeModal();
    } catch (error) {
      setModalMessage(getErrorMessage(error, "操作失败"));
    } finally {
      setButtonLoading(submit, false);
      setModalBusy(false);
    }
  };
}

async function createRoom(roomName: string) {
  if (!supabaseClient || !selfAuthId) return;

  const roomId = crypto.randomUUID();
  const { error } = await supabaseClient.rpc("create_room", { p_room_name: roomName, p_room_id: roomId });
  if (error) throw error;

  selectedRoomId = roomId;
  showToast("房间已创建");
  await loadPanelData();
}

async function joinRoomByInvite(inviteCode: string) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.rpc("join_room_by_invite", {
    p_invite_code: inviteCode,
  });

  if (error) throw error;

  showToast("已加入房间");
  await loadPanelData();
}

async function inviteMember(targetGpId: string) {
  if (!supabaseClient || !selfAuthId) return;
  const gpId = normalizeGpId(targetGpId);
  if (!gpId) throw new Error("请输入 gp_ 开头的 GoodPuppy ID");

  const { data: target, error: lookupError } = await supabaseClient
    .from("profiles")
    .select("id")
    .eq("gp_id", gpId)
    .single();

  if (lookupError || !target) {
    throw new Error("找不到该 GoodPuppy ID");
  }

  if (target.id === selfAuthId) {
    throw new Error("不能邀请自己");
  }

  // 检查对方是否已经是当前房间成员
  if (selectedRoomId) {
    const { data: existing } = await supabaseClient
      .from("room_members")
      .select("user_id")
      .eq("room_id", selectedRoomId)
      .eq("user_id", target.id)
      .maybeSingle();
    if (existing) throw new Error("对方已经是房间成员");
  }

  if (!selectedRoomId) throw new Error("请选择房间");
  const { error } = await supabaseClient.rpc("invite_room_member", {
    p_room_id: selectedRoomId, p_to_user_id: target.id,
  });
  if (error) throw error;

  showToast("邀请已发送");
}

async function updateDisplayName(displayName: string) {
  if (!supabaseClient || !selfAuthId) throw new Error("请先登录");
  const value = displayName.trim();
  if (!value) throw new Error("请输入用户名");

  const { error } = await supabaseClient.from("profiles").update({ display_name: value }).eq("id", selfAuthId);
  if (error) throw error;

  await loadPanelData();
}

function openDisplayNameEditor() {
  const profileName = document.querySelector<HTMLElement>(".lounge-edit-display-name")?.textContent || "";
  openInputModal({
    title: "编辑用户名",
    label: "用户名",
    placeholder: "输入用户名",
    submitText: "保存",
    initialValue: profileName,
    validate: (value) => (!value.trim() ? "请输入用户名" : ""),
    onSubmit: updateDisplayName,
  });
}

async function updateSelectedRoomMetadata({ roomName, description }: RoomMetadataUpdate) {
  if (!supabaseClient) return;
  const room = getSelectedRoom();
  if (!room) return;

  const { error } = await supabaseClient
    .from("rooms")
    .update({
      room_name: roomName.trim() || "未命名房间",
      description: description.trim(),
    })
    .eq("id", room.id);
  if (error) throw error;

  await loadPanelData();
}

function openRoomMetadataModal() {
  const room = getSelectedRoom();
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!room || !backdrop || !form) return;

  form.classList.remove("lounge-login-modal");
  form.innerHTML = `
    <h2 class="modal-title">编辑房间信息</h2>
    <div class="lounge-form-field">
      <label class="lounge-form-label" for="lounge-room-name">房间名称</label>
      <input class="lounge-input lounge-room-name-input" id="lounge-room-name" name="room-name" autocomplete="off" />
    </div>
    <div class="lounge-form-field">
      <label class="lounge-form-label" for="lounge-room-description">房间简介</label>
      <textarea class="lounge-input lounge-room-description-input" id="lounge-room-description" name="room-description" rows="4"></textarea>
    </div>
    <p class="lounge-form-message" role="status"></p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn primary lounge-form-submit" type="submit">保存</button>
    </div>
  `;

  const roomNameInput = requiredQuery<HTMLInputElement>(form, ".lounge-room-name-input");
  const roomDescriptionInput = requiredQuery<HTMLTextAreaElement>(form, ".lounge-room-description-input");
  const cancel = requiredQuery<HTMLButtonElement>(form, ".lounge-form-cancel");
  const submit = requiredQuery<HTMLButtonElement>(form, ".lounge-form-submit");

  roomNameInput.value = room.room_name || "";
  roomDescriptionInput.value = room.description || "";
  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;

  cancel.onclick = closeModal;
  roomNameInput.focus();
  form.onsubmit = async (event) => {
    event.preventDefault();
    setModalBusy(true);
    setButtonLoading(submit, true);
    try {
      await updateSelectedRoomMetadata({
        roomName: roomNameInput.value,
        description: roomDescriptionInput.value,
      });
      closeModal();
    } catch (error) {
      setModalMessage(getErrorMessage(error, "保存失败"));
    } finally {
      setButtonLoading(submit, false);
      setModalBusy(false);
    }
  };
}

async function acceptRequest(requestId: string) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.rpc("accept_connection", {
    p_request_id: requestId,
  });

  if (error) throw error;

  showToast("已接受邀请");
  await loadPanelData();
}

async function declineRequest(requestId: string) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient
    .from("connection_requests")
    .update({ status: "declined" })
    .eq("id", requestId);

  if (error) throw error;

  showToast("已拒绝邀请");
  await loadPanelData();
}

async function handleRoomTransition(roomId: string, type: "enter" | "exit") {
  if (pendingTransition) return;

  pendingTransition = { roomId, type };
  renderAll();

  try {
    if (type === "exit") {
      await onExitRoom?.();
      showToast("已退出房间");
    } else {
      await onEnterRoom?.(roomId);
    }
  } catch (error) {
    showToast(getErrorMessage(error, "操作失败"), "error");
  } finally {
    pendingTransition = null;
    renderAll();
  }
}

function subscribeToRequests() {
  if (!supabaseClient || !selfAuthId) return;
  const version = authRevision;

  if (requestChannel) {
    void supabaseClient.removeChannel(requestChannel);
    requestChannel = null;
  }
  if (sentRequestChannel) {
    void supabaseClient.removeChannel(sentRequestChannel);
    sentRequestChannel = null;
  }

  // 收到的邀请（to_id = 自己）
  requestChannel = supabaseClient
    .channel(`lounge-requests-${selfAuthId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "connection_requests",
        filter: `to_id=eq.${selfAuthId}`,
      },
      () => {
        if (version !== authRevision) return;
        void loadPanelData();
      },
    )
    .subscribe();

  // 发出的邀请被接受/拒绝时（from_id = 自己），刷新房间成员列表
  sentRequestChannel = supabaseClient
    .channel(`lounge-sent-requests-${selfAuthId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "connection_requests",
        filter: `from_id=eq.${selfAuthId}`,
      },
      () => {
        if (version !== authRevision) return;
        void loadPanelData();
      },
    )
    .subscribe();
}

function subscribeToRoomMembers() {
  if (!supabaseClient || !selfAuthId) return;
  const version = authRevision;

  if (roomMembersChannel) {
    void supabaseClient.removeChannel(roomMembersChannel);
    roomMembersChannel = null;
  }

  // 监听 room_members 变更，实时感知新成员加入/退出
  roomMembersChannel = supabaseClient
    .channel(`lounge-room-members-${selfAuthId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "room_members",
      },
      () => {
        if (version !== authRevision) return;
        void loadPanelData();
      },
    )
    .subscribe();
}

// 当前可见房间里的所有成员 user_id（含自己），用于过滤 profiles 变更——
// profiles 的 SELECT RLS 为 true，订阅会收到全站任意用户的变更，必须客户端按成员过滤，
// 否则任意陌生用户改名都会触发一次 loadPanelData。
function knownMemberIds(): Set<string> {
  const ids = new Set<string>();
  if (selfAuthId) ids.add(selfAuthId);
  for (const room of rooms) {
    for (const member of room.members) ids.add(member.userId);
  }
  return ids;
}

function subscribeToProfilesChanges() {
  if (!supabaseClient || !selfAuthId) return;
  const version = authRevision;

  if (profilesChannel) {
    void supabaseClient.removeChannel(profilesChannel);
    profilesChannel = null;
  }

  // 监听 profiles 变更，实时反映成员改名/换肤（含远程好友）。仅当变更者是已知房间成员时刷新。
  profilesChannel = supabaseClient
    .channel(`lounge-profiles-${selfAuthId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "profiles",
      },
      (payload) => {
        if (version !== authRevision) return;
        const changedId = (payload.new as { id?: string } | null)?.id;
        if (changedId && knownMemberIds().has(changedId)) {
          void loadPanelData();
        }
      },
    )
    .subscribe();
}

function subscribeToPresenceChanges() {
  if (!supabaseClient || !selfAuthId) return;
  const version = authRevision;

  if (presenceChannel) {
    void supabaseClient.removeChannel(presenceChannel);
    presenceChannel = null;
  }

  presenceChannel = supabaseClient
    .channel(`lounge-presence-${selfAuthId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "presence",
      },
      (payload) => {
        if (version !== authRevision) return;
        // 先用旧快照做上线检测，再 loadPanelData 刷新数据（其内部会重置快照基线）。
        const row = payload.new as LoungePresenceRow | null;
        if (row?.user_id) notifyPresenceChange(row);
        void loadPanelData();
      },
    )
    .subscribe();
}

function bindEvents() {
  const p = panel();
  if (!p || p.dataset.bound === "true") return;

  p.dataset.bound = "true";

  initShowcase();

  p.querySelector<HTMLElement>(".lounge-close")?.addEventListener("click", closeLoungePanel);

  p.addEventListener("click", (event) => {
    const target = targetElement(event.target);
    if (target?.closest(".lounge-login-btn")) {
      openLoginDialog();
      return;
    }

    if (target?.closest(".pet-avatar") && target?.closest(".lounge-profile-card:not(.is-unauth)")) {
      if (currentProfile && selfAuthId && supabaseClient) {
        openShowcase({
          petId: currentProfile.pet_id || "default",
          skin: currentProfile.skin || "default",
          selfAuthId,
          supabase: supabaseClient,
          onSkinChange: handleSkinChange,
        });
      }
      return;
    }

    const btn = target?.closest<HTMLButtonElement>("button");
    if (!btn) return;

    if (btn.matches(".lounge-copy-id-btn")) {
      void copyToClipboard(document.querySelector<HTMLElement>(".lounge-gp-id")?.textContent, btn);
      return;
    }

    if (btn.matches(".lounge-login-btn")) {
      openLoginDialog();
      return;
    }

    if (btn.matches(".lounge-edit-name-btn")) {
      openDisplayNameEditor();
      return;
    }

    if (btn.matches(".lounge-edit-room")) {
      openRoomMetadataModal();
      return;
    }

    if (btn.matches(".lounge-create-room")) {
      openInputModal({
        title: "创建房间",
        label: "房间名称",
        placeholder: "输入房间名称",
        submitText: "创建",
        validate: (value) => (!value ? "请输入房间名称" : ""),
        onSubmit: createRoom,
      });
      return;
    }

    if (btn.matches(".lounge-invite-member")) {
      openInputModal({
        title: "邀请成员",
        label: "GoodPuppy ID",
        placeholder: "输入 gp_ 开头的 GoodPuppy ID",
        submitText: "邀请",
        validate: (value) => (!normalizeGpId(value) ? "请输入 gp_ 开头的 GoodPuppy ID" : ""),
        onSubmit: inviteMember,
      });
      return;
    }

    if (btn.matches(".lounge-settings-btn")) {
      if (selfAuthId) {
        void openSettingsView();
      }
      return;
    }

    if (btn.matches(".room-quick-action")) {
      const roomId = btn.dataset.roomId;
      if (!roomId || pendingTransition) return;
      const isExit = btn.dataset.action === "exit";
      void handleRoomTransition(roomId, isExit ? "exit" : "enter");
      return;
    }

    if (btn.matches(".lounge-enter-room")) {
      const room = getSelectedRoom();
      if (!room || pendingTransition) return;
      const isExit = btn.dataset.action === "exit";
      void handleRoomTransition(room.id, isExit ? "exit" : "enter");
      return;
    }

    if (btn.matches(".lounge-leave-room-permanent")) {
      const room = getSelectedRoom();
      if (!room || !selfAuthId) return;
      openLeaveRoomPermanentDialog(room);
      return;
    }

    if (btn.matches(".lounge-view-history")) {
      const room = getSelectedRoom();
      if (!room || !selfAuthId || !supabaseClient) return;
      openChatHistory({ supabase: supabaseClient, selfAuthId, room });
    }
  });

  document.querySelector<HTMLElement>(".lounge-request-list")?.addEventListener("click", async (event) => {
    const btn = targetElement(event.target)?.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;

    const { action, id } = btn.dataset;
    if (!id) return;
    btn.disabled = true;
    setButtonLoading(btn, true);

    try {
      if (action === "accept") await acceptRequest(id);
      if (action === "decline") await declineRequest(id);
    } catch (error) {
      showToast(getErrorMessage(error, "操作失败"), "error");
    } finally {
      setButtonLoading(btn, false);
      btn.disabled = false;
    }
  });

  document.querySelector<HTMLElement>(".lounge-modal-backdrop")?.addEventListener("pointerdown", (event) => {
    if (event.target === event.currentTarget && event.currentTarget instanceof HTMLElement) {
      closeModal();
    }
  });

  p.addEventListener("pointerdown", (event) => {
    const target = targetElement(event.target);
    if (
      target?.closest(".sidebar-drag-region, .main-drag-region, .settings-header") &&
      !target?.closest(".settings-back")
    ) {
      window.goodPuppy.startWindowDrag();
    }
  });

  p.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const target = targetElement(event.target);
    if (!target?.closest(".lounge-login-btn")) return;

    event.preventDefault();
    openLoginDialog();
  });
}

export function initLoungePanel({
  supabase,
  selfAuthId: nextSelfAuthId,
  isAnonymous: nextIsAnonymous,
  email: nextEmail,
  getActiveRoomId: nextGetActiveRoomId,
  onEnterRoom: nextOnEnterRoom,
  onExitRoom: nextOnExitRoom,
  onLoginSuccess: nextOnLoginSuccess,
  onLogout: nextOnLogout,
  onSkinSaved: nextOnSkinSaved,
}: LoungePanelOptions) {
  supabaseClient = supabase;
  selfAuthId = nextSelfAuthId;
  currentUserIsAnonymous = Boolean(nextSelfAuthId && nextIsAnonymous);
  currentUserEmail = nextSelfAuthId ? nextEmail : null;
  authRevision += 1;
  panelRefresh.setContext(selfAuthId ? { client: supabase, userId: selfAuthId } : null);
  getActiveRoomId = nextGetActiveRoomId;
  onEnterRoom = nextOnEnterRoom;
  onExitRoom = nextOnExitRoom;
  onLoginSuccess = nextOnLoginSuccess;
  onLogout = nextOnLogout;
  onSkinSaved = nextOnSkinSaved;

  bindEvents();
  bindOnlineNotifier();
  if (!onlineListenerBound) {
    onlineListenerBound = true;
    // 断网恢复时，若当前正停在冷启动报错态，自动重新加载（手动「重试」按钮作兜底）。
    window.addEventListener("online", () => {
      if (selfAuthId && panelIsInError()) void loadPanelData();
    });
  }
  if (selfAuthId) {
    subscribeToRequests();
    subscribeToPresenceChanges();
    subscribeToRoomMembers();
    subscribeToProfilesChanges();
    startOnlineNotifier();
  }
}

// toast「进入房间」回传：复用既有进房流程，并清掉所有提醒。整会话只绑定一次。
let toastEnterListenerBound = false;
function bindOnlineNotifier() {
  if (toastEnterListenerBound) return;
  toastEnterListenerBound = true;
  window.goodPuppy.onAppEvent<{ roomId?: string }>("toast-enter-room", ({ roomId }) => {
    console.warn("[online-notify] toast-enter-room recv", roomId);
    if (!roomId) return;
    dismissAllToasts();
    if (getActiveRoomId?.() === roomId) return;
    selectedRoomId = roomId;
    void handleRoomTransition(roomId, "enter");
  });
}

function startOnlineNotifier() {
  initOnlineNotifier({
    getSelfId: () => selfAuthId,
    getRooms: () => rooms,
    getActiveRoomId: () => getActiveRoomId?.() || null,
  });
}

export function updateLoungePanelAuth({ supabase, selfAuthId: nextSelfAuthId, isAnonymous: nextIsAnonymous, email: nextEmail }: UpdatePanelAuthOptions) {
  const previousClient = supabaseClient;
  const changed = selfAuthId !== nextSelfAuthId || previousClient !== supabase;
  if (changed) {
    authRevision += 1;
    panelRefresh.setContext(nextSelfAuthId ? { client: supabase, userId: nextSelfAuthId } : null);
    for (const channel of [requestChannel, sentRequestChannel, presenceChannel, roomMembersChannel, profilesChannel]) {
      if (channel && previousClient) void previousClient.removeChannel(channel).catch(console.error);
    }
    requestChannel = sentRequestChannel = presenceChannel = roomMembersChannel = profilesChannel = null;
    disposeOnlineNotifier();
    panelSnapshot = null;
    rooms = []; pendingRequests = []; selectedRoomId = null; pendingTransition = null;
    hasLoadedOnce = false;
    renderProfile(null);
    closeModal(); closeSettings();
  }
  supabaseClient = supabase;
  selfAuthId = nextSelfAuthId;
  currentUserIsAnonymous = Boolean(nextSelfAuthId && nextIsAnonymous);
  currentUserEmail = nextSelfAuthId ? nextEmail : null;
  renderAuthState(Boolean(selfAuthId));
  if (changed && selfAuthId) {
    subscribeToRequests(); subscribeToPresenceChanges(); subscribeToRoomMembers(); subscribeToProfilesChanges();
    startOnlineNotifier();
    void loadPanelData();
  } else if (!selfAuthId) hidePanelState();
  renderAll();
}

export function refreshLoungePanelActiveRoom() {
  rebuildRoomViews();
  renderAll();
  if (selfAuthId) void loadPanelData();
}

// 托盘「房间聊天记录」：打开当前所在房间的聊天记录（无则回退到选中/第一个房间）。
// 数据可能尚未加载（托盘在 lounge 隐藏期间触发），先确保加载再打开。
export async function openActiveRoomHistory() {
  if (!supabaseClient || !selfAuthId) return;
  if (rooms.length === 0) {
    await loadPanelData();
  }
  const activeId = getActiveRoomId?.() || null;
  const room =
    (activeId ? rooms.find((r) => r.id === activeId) : null) ||
    getSelectedRoom() ||
    rooms[0] ||
    null;
  if (!room) return;
  selectedRoomId = room.id;
  renderAll();
  openChatHistory({ supabase: supabaseClient, selfAuthId, room });
}

export function openLoungePanel() {
  const p = panel();
  if (!p) return;

  p.hidden = false;

  if (selfAuthId) {
    renderAuthState(true);
    void loadPanelData();
  } else {
    // 未登录：撤掉冷启动时乐观铺设的骨架屏（见 lounge-main.ts 的 hasPersistedSession）。
    hidePanelState();
    renderAuthState(false);
    renderProfile(null);
  }
}

export function closeLoungePanel() {
  if (window.__TAURI_INTERNALS__) {
    void getCurrentWindow().hide();
  } else {
    const p = panel();
    if (p) p.hidden = true;
  }
}

setInterval(() => {
  if (selfAuthId && document.visibilityState === "visible" && panelSnapshot) {
    const before = rooms.map((room) => room.members.map((member) => member.isOnline).join()).join();
    rebuildRoomViews();
    const after = rooms.map((room) => room.members.map((member) => member.isOnline).join()).join();
    if (before !== after) renderAll();
  }
}, 10_000);
window.addEventListener("beforeunload", () => panelRefresh.dispose());
