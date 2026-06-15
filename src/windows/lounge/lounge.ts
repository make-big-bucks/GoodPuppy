import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { renderRoomList, renderPendingRequests } from "./views/room-list.js";
import type { PendingTransition } from "./views/room-list.js";
import { renderRoomDetail } from "./views/room-detail.js";
import { renderProfileCard } from "./views/profile-card.js";
import { showToast } from "./views/toast.js";
import { buildMemberViewModels, normalizeGpId } from "./loungeViewModels.js";
import type {
  ConnectionRequestRow,
  LoungeMemberRow,
  LoungePresenceRow,
  LoungeProfile,
  LoungeRoom,
} from "../../types";

type LoungePanelOptions = {
  supabase: SupabaseClient;
  selfAuthId: string | null;
  getActiveRoomId: () => string | null;
  onEnterRoom: (roomId: string) => Promise<void>;
  onExitRoom: () => Promise<void>;
  onLoginSuccess: () => void;
  onLogout: () => void;
};

type UpdatePanelAuthOptions = {
  supabase: SupabaseClient;
  selfAuthId: string | null;
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

let supabaseClient: SupabaseClient | null = null;
let selfAuthId: string | null = null;
let getActiveRoomId: (() => string | null) | null = null;
let onEnterRoom: ((roomId: string) => Promise<void>) | null = null;
let onExitRoom: (() => Promise<void>) | null = null;
let onLoginSuccess: (() => void) | null = null;
let onLogout: (() => void) | null = null;

const logoutIconSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
const eyeSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
const eyeOffSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;
const dogLogoSvg = `<svg viewBox="0 0 64 64" fill="none" aria-hidden="true"><path d="M18 47V31C18 20 26 13 37 13C48 13 55 21 55 32C55 41 49 47 39 47H31" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/><path d="M18 31C12 33 9 38 9 47" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><path d="M38 47V54" stroke="currentColor" stroke-width="5" stroke-linecap="round"/><circle cx="43" cy="28" r="3" fill="currentColor"/></svg>`;
const userInputSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 21a8 8 0 0 0-16 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><circle cx="12" cy="7" r="4" stroke="currentColor" stroke-width="2"/></svg>`;
const passwordInputSvg = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="5" y="10" width="14" height="10" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;

let rooms: LoungeRoom[] = [];
let pendingRequests: ConnectionRequestRow[] = [];
let selectedRoomId: string | null = null;
let requestChannel: RealtimeChannel | null = null;
let presenceChannel: RealtimeChannel | null = null;
let pendingTransition: PendingTransition | null = null;

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
  renderProfileCard(profile);
}

function renderAuthState(isLoggedIn: boolean) {
  document.querySelector<HTMLElement>(".profile-section")?.classList.toggle("is-unauth", !isLoggedIn);

  const sidebarActions = document.querySelector<HTMLElement>(".sidebar-actions");
  if (sidebarActions) sidebarActions.hidden = !isLoggedIn;

  const requestList = document.querySelector<HTMLElement>(".lounge-request-list");
  if (requestList && !isLoggedIn) requestList.hidden = true;

  const emptyDetail = document.querySelector<HTMLElement>(".lounge-empty-detail");
  if (emptyDetail) {
    emptyDetail.textContent = isLoggedIn ? "选择一个房间查看成员" : "登录后即可查看你的房间和邀请";
  }

  const actionBtn = document.querySelector<HTMLButtonElement>(".lounge-settings-btn");
  if (actionBtn) {
    if (isLoggedIn) {
      actionBtn.hidden = false;
      actionBtn.setAttribute("aria-label", "退出登录");
      actionBtn.innerHTML = logoutIconSvg;
    } else {
      actionBtn.hidden = true;
    }
  }

  if (!isLoggedIn) {
    const roomDetail = document.querySelector<HTMLElement>(".lounge-room-detail");
    if (roomDetail) roomDetail.hidden = true;
  }
}

function openLoginDialog() {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.classList.add("lounge-login-modal");
  form.innerHTML = `
    <section class="lounge-login-brand">
      <div class="lounge-login-logo">${dogLogoSvg}</div>
      <h2 class="lounge-login-title">GoodPuppy</h2>
      <p class="lounge-login-subtitle">和朋友一起出现在彼此的桌面上</p>
    </section>
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
  `;

  const emailInput = requiredQuery<HTMLInputElement>(form, "#login-email");
  const passwordInput = requiredQuery<HTMLInputElement>(form, ".login-password-input");
  const passwordToggle = requiredQuery<HTMLButtonElement>(form, ".login-password-toggle");
  const registerBtn = requiredQuery<HTMLButtonElement>(form, ".lounge-form-register");

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

  async function doSignIn() {
    if (!supabaseClient) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) { setModalMessage("请填写邮箱和密码"); return; }
    setModalBusy(true);
    setModalMessage("正在登录...");
    try {
      const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
      if (error) throw error;
      closeModal();
      onLoginSuccess?.();
    } catch (error) {
      setModalMessage(getErrorMessage(error, "登录失败"));
    } finally {
      setModalBusy(false);
    }
  }

  async function doSignUp() {
    if (!supabaseClient) return;
    const email = emailInput.value.trim();
    const password = passwordInput.value;
    if (!email || !password) { setModalMessage("请填写邮箱和密码"); return; }
    setModalBusy(true);
    setModalMessage("正在注册...");
    try {
      const { data, error } = await supabaseClient.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) {
        closeModal();
        onLoginSuccess?.();
      } else {
        setModalMessage("注册成功，请检查邮箱确认账号");
        setModalBusy(false);
      }
    } catch (error) {
      setModalMessage(getErrorMessage(error, "注册失败"));
      setModalBusy(false);
    }
  }

  registerBtn.addEventListener("click", () => { void doSignUp(); });
  form.onsubmit = (event) => { event.preventDefault(); void doSignIn(); };
}

function openLogoutConfirmDialog() {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.classList.remove("lounge-login-modal");
  form.innerHTML = `
    <h2 class="modal-title">退出登录</h2>
    <p class="lounge-confirm-text">确认要退出登录吗？</p>
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
    if (onExitRoom) {
      try { await onExitRoom(); } catch { /* ignore */ }
    }
    await supabaseClient?.auth.signOut();
    closeModal();
    onLogout?.();
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
  renderRoomDetail(getSelectedRoom(), selfAuthId, getActiveRoomId?.() || null, pendingTransition);
}

async function loadPanelData() {
  if (!supabaseClient || !selfAuthId) return;

  try {
    const [profileResult, myRoomsResult, requestsResult] = await Promise.all([
      supabaseClient
        .from("profiles")
        .select("id, gp_id, display_name, pet_id, skin")
        .eq("id", selfAuthId)
        .single(),
      supabaseClient
        .from("room_members")
        .select("room_id, rooms!inner(id, room_name, description, invite_code, created_by)")
        .eq("user_id", selfAuthId),
      supabaseClient
        .from("connection_requests")
        .select("id, from_id, profiles!connection_requests_from_id_fkey(id, gp_id, display_name, pet_id, skin)")
        .eq("to_id", selfAuthId)
        .eq("status", "pending")
        .order("created_at", { ascending: true }),
    ]);

    if (profileResult.error) throw profileResult.error;
    if (myRoomsResult.error) throw myRoomsResult.error;
    if (requestsResult.error) throw requestsResult.error;

    renderProfile((profileResult.data as LoungeProfile | null) || null);

    const myRooms = (myRoomsResult.data as RoomMembershipRow[] | null) || [];
    const roomIds = myRooms.map((item) => item.room_id);
    let allMembers: LoungeMemberRow[] = [];
    let allPresence: LoungePresenceRow[] = [];

    if (roomIds.length > 0) {
      const [membersResult, presenceResult] = await Promise.all([
        supabaseClient
          .from("room_members")
          .select("room_id, user_id, joined_at, profiles!room_members_user_id_fkey(id, gp_id, display_name, pet_id, skin)")
          .in("room_id", roomIds),
        supabaseClient
          .from("presence")
          .select("current_room_id, user_id, is_online, last_seen")
          .in("current_room_id", roomIds),
      ]);

      if (membersResult.error) throw membersResult.error;
      if (presenceResult.error) throw presenceResult.error;
      allMembers = (membersResult.data as LoungeMemberRow[] | null) || [];
      allPresence = (presenceResult.data as LoungePresenceRow[] | null) || [];
    }

    rooms = myRooms.map((item) => ({
      id: item.room_id,
      room_name: item.rooms?.room_name || "未命名房间",
      description: item.rooms?.description || "",
      invite_code: item.rooms?.invite_code || "",
      created_by: item.rooms?.created_by || "",
      members: buildMemberViewModels(
        allMembers.filter((member) => member.room_id === item.room_id),
        allPresence,
        selfAuthId,
        item.room_id,
        getActiveRoomId?.() || null,
      ),
    }));

    pendingRequests = ((requestsResult.data as ConnectionRequestRow[] | null) || []);

    if (!selectedRoomId || !rooms.some((room) => room.id === selectedRoomId)) {
      selectedRoomId = rooms[0]?.id || null;
    }

    renderAll();
  } catch (error) {
    showToast(getErrorMessage(error, "加载失败"), "error");
  }
}

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
    try {
      await onSubmit(value);
      closeModal();
    } catch (error) {
      setModalMessage(getErrorMessage(error, "操作失败"));
    } finally {
      setModalBusy(false);
    }
  };
}

async function createRoom(roomName: string) {
  if (!supabaseClient || !selfAuthId) return;

  // Pre-generate UUID client-side so we can insert room_members before SELECTing
  // the room. rooms_select RLS requires the user to be in room_members, so doing
  // .insert().select().single() on rooms would return 0 rows (user not a member yet).
  const roomId = crypto.randomUUID();

  const { error: roomError } = await supabaseClient
    .from("rooms")
    .insert({
      id: roomId,
      room_name: roomName,
      created_by: selfAuthId,
    });

  if (roomError) throw roomError;

  const { error: memberError } = await supabaseClient.from("room_members").insert({
    room_id: roomId,
    user_id: selfAuthId,
  });

  if (memberError) throw memberError;

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

  const { error } = await supabaseClient.from("connection_requests").insert({
    from_id: selfAuthId,
    to_id: target.id,
    status: "pending",
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
    try {
      await updateSelectedRoomMetadata({
        roomName: roomNameInput.value,
        description: roomDescriptionInput.value,
      });
      closeModal();
    } catch (error) {
      setModalMessage(getErrorMessage(error, "保存失败"));
    } finally {
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

  if (requestChannel) {
    void supabaseClient.removeChannel(requestChannel);
    requestChannel = null;
  }

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
        void loadPanelData();
      },
    )
    .subscribe();
}

function subscribeToPresenceChanges() {
  if (!supabaseClient || !selfAuthId) return;

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
      () => {
        void loadPanelData();
      },
    )
    .subscribe();
}

function bindEvents() {
  const p = panel();
  if (!p || p.dataset.bound === "true") return;

  p.dataset.bound = "true";

  p.querySelector<HTMLElement>(".lounge-close")?.addEventListener("click", closeLoungePanel);

  p.addEventListener("click", (event) => {
    const target = targetElement(event.target);
    if (target?.closest(".lounge-login-btn")) {
      openLoginDialog();
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
        openLogoutConfirmDialog();
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
    }
  });

  document.querySelector<HTMLElement>(".lounge-request-list")?.addEventListener("click", async (event) => {
    const btn = targetElement(event.target)?.closest<HTMLButtonElement>("button[data-action]");
    if (!btn) return;

    const { action, id } = btn.dataset;
    if (!id) return;
    btn.disabled = true;

    try {
      if (action === "accept") await acceptRequest(id);
      if (action === "decline") await declineRequest(id);
    } catch (error) {
      showToast(getErrorMessage(error, "操作失败"), "error");
    } finally {
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
    if (target?.closest(".sidebar-drag-region, .main-drag-region")) {
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
  getActiveRoomId: nextGetActiveRoomId,
  onEnterRoom: nextOnEnterRoom,
  onExitRoom: nextOnExitRoom,
  onLoginSuccess: nextOnLoginSuccess,
  onLogout: nextOnLogout,
}: LoungePanelOptions) {
  supabaseClient = supabase;
  selfAuthId = nextSelfAuthId;
  getActiveRoomId = nextGetActiveRoomId;
  onEnterRoom = nextOnEnterRoom;
  onExitRoom = nextOnExitRoom;
  onLoginSuccess = nextOnLoginSuccess;
  onLogout = nextOnLogout;

  bindEvents();
  if (selfAuthId) {
    subscribeToRequests();
    subscribeToPresenceChanges();
  }
}

export function updateLoungePanelAuth({ supabase, selfAuthId: nextSelfAuthId }: UpdatePanelAuthOptions) {
  const wasLoggedIn = Boolean(selfAuthId);
  const isLoggedIn = Boolean(nextSelfAuthId);

  supabaseClient = supabase;
  selfAuthId = nextSelfAuthId;

  if (isLoggedIn) {
    subscribeToRequests();
    subscribeToPresenceChanges();
    renderAuthState(true);
    void loadPanelData();
  } else if (wasLoggedIn) {
    if (requestChannel && supabaseClient) {
      void supabaseClient.removeChannel(requestChannel);
      requestChannel = null;
    }
    if (presenceChannel && supabaseClient) {
      void supabaseClient.removeChannel(presenceChannel);
      presenceChannel = null;
    }
    rooms = [];
    pendingRequests = [];
    selectedRoomId = null;
    pendingTransition = null;
    renderAuthState(false);
    renderProfile(null);
    renderAll();
  }
}

export function refreshLoungePanelActiveRoom() {
  renderAll();
  if (selfAuthId) void loadPanelData();
}

export function openLoungePanel() {
  const p = panel();
  if (!p) return;

  p.hidden = false;
  window.goodPuppy.setIgnoreMouseEvents(false);

  if (selfAuthId) {
    renderAuthState(true);
    void loadPanelData();
  } else {
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
