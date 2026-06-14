import { getCurrentWindow } from "@tauri-apps/api/window";
import { renderRoomList, renderPendingRequests } from "./views/room-list.js";
import { renderRoomDetail } from "./views/room-detail.js";
import { renderProfileCard } from "./views/profile-card.js";
import { buildMemberViewModels, normalizeGpId } from "./loungeViewModels.js";

let _supabase = null;
let _selfAuthId = null;
let _getActiveRoomId = null;
let _onEnterRoom = null;
let _onExitRoom = null;

let rooms = [];
let pendingRequests = [];
let selectedRoomId = null;
let requestChannel = null;

const panel = () => document.querySelector(".lounge-panel");
const modalBackdrop = () => document.querySelector(".lounge-modal-backdrop");
const modalForm = () => document.querySelector(".lounge-modal");

function getSelectedRoom() {
  return rooms.find((room) => room.id === selectedRoomId) || null;
}

function setMessage(text, { isError = false } = {}) {
  const el = document.querySelector(".lounge-message");
  if (!el) return;

  el.textContent = text || "";
  el.classList.toggle("is-error", isError);

  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 3000);
  }
}

function setModalMessage(text) {
  const el = modalForm()?.querySelector(".lounge-form-message");
  if (el) el.textContent = text || "";
}

function setModalBusy(isBusy) {
  modalForm()?.querySelectorAll("input, textarea, button").forEach((el) => {
    el.disabled = isBusy;
  });
}

async function copyToClipboard(text, btn) {
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch {
    setMessage("复制失败", { isError: true });
  }
}

function renderProfile(profile) {
  renderProfileCard(profile);
}

function onRoomSelect(id) {
  selectedRoomId = id;
  renderAll();
}

function renderAll() {
  renderRoomList(rooms, selectedRoomId, onRoomSelect);
  renderPendingRequests(pendingRequests);
  renderRoomDetail(getSelectedRoom(), _selfAuthId, _getActiveRoomId?.() || null);
}

async function loadPanelData() {
  if (!_supabase || !_selfAuthId) return;

  try {
    const [profileResult, myRoomsResult, requestsResult] = await Promise.all([
      _supabase
        .from("profiles")
        .select("id, gp_id, display_name, pet_id, skin")
        .eq("id", _selfAuthId)
        .single(),
      _supabase
        .from("room_members")
        .select("room_id, rooms!inner(id, room_name, description, invite_code, created_by)")
        .eq("user_id", _selfAuthId),
      _supabase
        .from("connection_requests")
        .select("id, from_id, profiles!connection_requests_from_id_fkey(id, gp_id, display_name, pet_id, skin)")
        .eq("to_id", _selfAuthId)
        .eq("status", "pending")
        .order("created_at", { ascending: true }),
    ]);

    if (profileResult.error) throw profileResult.error;
    if (myRoomsResult.error) throw myRoomsResult.error;
    if (requestsResult.error) throw requestsResult.error;

    renderProfile(profileResult.data);

    const myRooms = myRoomsResult.data || [];
    const roomIds = myRooms.map((item) => item.room_id);
    let allMembers = [];
    let allPresence = [];

    if (roomIds.length > 0) {
      const [membersResult, presenceResult] = await Promise.all([
        _supabase
          .from("room_members")
          .select("room_id, user_id, joined_at, profiles!room_members_user_id_fkey(id, gp_id, display_name, pet_id, skin)")
          .in("room_id", roomIds),
        _supabase
          .from("presence")
          .select("room_id, user_id, is_online, last_seen")
          .in("room_id", roomIds),
      ]);

      if (membersResult.error) throw membersResult.error;
      if (presenceResult.error) throw presenceResult.error;
      allMembers = membersResult.data || [];
      allPresence = presenceResult.data || [];
    }

    rooms = myRooms.map((item) => ({
      id: item.room_id,
      room_name: item.rooms?.room_name || "未命名房间",
      description: item.rooms?.description || "",
      invite_code: item.rooms?.invite_code || "",
      created_by: item.rooms?.created_by || "",
      members: buildMemberViewModels(
        allMembers.filter((member) => member.room_id === item.room_id),
        allPresence.filter((presence) => presence.room_id === item.room_id),
        _selfAuthId,
      ),
    }));

    pendingRequests = requestsResult.data || [];

    if (!selectedRoomId || !rooms.some((room) => room.id === selectedRoomId)) {
      selectedRoomId = rooms[0]?.id || null;
    }

    renderAll();
  } catch (error) {
    setMessage(error.message || "加载失败", { isError: true });
  }
}

function openInputModal({ title, placeholder, submitText = "确定", initialValue = "", validate, onSubmit }) {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.innerHTML = `
    <h2 class="modal-title lounge-modal-title"></h2>
    <input class="lounge-input" name="modal-value" autocomplete="off" />
    <p class="lounge-form-message" role="status"></p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn primary lounge-form-submit" type="submit">确定</button>
    </div>
  `;

  const titleEl = form.querySelector(".lounge-modal-title");
  const input = form.querySelector(".lounge-input");
  const submit = form.querySelector(".lounge-form-submit");

  titleEl.textContent = title;
  input.value = initialValue;
  input.placeholder = placeholder;
  submit.textContent = submitText;
  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    form.onsubmit = null;
  };

  form.querySelector(".lounge-form-cancel").onclick = close;
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
      close();
    } catch (error) {
      setModalMessage(error.message || "操作失败");
    } finally {
      setModalBusy(false);
    }
  };
}

async function createRoom(roomName) {
  const { data: room, error: roomError } = await _supabase
    .from("rooms")
    .insert({
      room_name: roomName,
      created_by: _selfAuthId,
    })
    .select("id, room_name, description, invite_code, created_by")
    .single();

  if (roomError) throw roomError;

  const { error: memberError } = await _supabase.from("room_members").insert({
    room_id: room.id,
    user_id: _selfAuthId,
  });

  if (memberError) throw memberError;

  selectedRoomId = room.id;
  setMessage("房间已创建");
  await loadPanelData();
}

async function joinRoomByInvite(inviteCode) {
  const { error } = await _supabase.rpc("join_room_by_invite", {
    p_invite_code: inviteCode,
  });

  if (error) throw error;

  setMessage("已加入房间");
  await loadPanelData();
}

async function inviteMember(targetGpId) {
  const gpId = normalizeGpId(targetGpId);
  if (!gpId) throw new Error("请输入 gp_ 开头的 GoodPuppy ID");

  const { data: target, error: lookupError } = await _supabase
    .from("profiles")
    .select("id")
    .eq("gp_id", gpId)
    .single();

  if (lookupError || !target) {
    throw new Error("找不到该 GoodPuppy ID");
  }

  if (target.id === _selfAuthId) {
    throw new Error("不能邀请自己");
  }

  const { error } = await _supabase.from("connection_requests").insert({
    from_id: _selfAuthId,
    to_id: target.id,
    status: "pending",
  });

  if (error) throw error;

  setMessage("邀请已发送");
}

async function updateDisplayName(displayName) {
  const value = displayName.trim();
  if (!value) throw new Error("请输入用户名");

  const { error } = await _supabase.from("profiles").update({ display_name: value }).eq("id", _selfAuthId);
  if (error) throw error;

  setMessage("用户名已更新");
  await loadPanelData();
}

function openDisplayNameEditor() {
  const profileName = document.querySelector(".lounge-edit-display-name")?.textContent || "";
  openInputModal({
    title: "编辑用户名",
    placeholder: "输入用户名",
    submitText: "保存",
    initialValue: profileName,
    validate: (value) => (!value.trim() ? "请输入用户名" : ""),
    onSubmit: updateDisplayName,
  });
}

async function updateSelectedRoomMetadata({ roomName, description }) {
  const room = getSelectedRoom();
  if (!room) return;

  const { error } = await _supabase
    .from("rooms")
    .update({
      room_name: roomName.trim() || "未命名房间",
      description: description.trim(),
    })
    .eq("id", room.id);
  if (error) throw error;

  setMessage("房间信息已更新");
  await loadPanelData();
}

function openRoomMetadataModal() {
  const room = getSelectedRoom();
  if (!room) return;

  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  form.innerHTML = `
    <h2 class="modal-title">编辑房间信息</h2>
    <input class="lounge-input lounge-room-name-input" name="room-name" autocomplete="off" />
    <textarea class="lounge-input lounge-room-description-input" name="room-description" rows="4"></textarea>
    <p class="lounge-form-message" role="status"></p>
    <div class="lounge-form-actions">
      <button class="small-btn lounge-form-cancel" type="button">取消</button>
      <button class="small-btn primary lounge-form-submit" type="submit">保存</button>
    </div>
  `;

  form.querySelector(".lounge-room-name-input").value = room.room_name || "";
  form.querySelector(".lounge-room-description-input").value = room.description || "";
  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    form.onsubmit = null;
  };

  form.querySelector(".lounge-form-cancel").onclick = close;
  form.querySelector(".lounge-room-name-input").focus();
  form.onsubmit = async (event) => {
    event.preventDefault();
    setModalBusy(true);
    try {
      await updateSelectedRoomMetadata({
        roomName: form.querySelector(".lounge-room-name-input").value,
        description: form.querySelector(".lounge-room-description-input").value,
      });
      close();
    } catch (error) {
      setModalMessage(error.message || "保存失败");
    } finally {
      setModalBusy(false);
    }
  };
}

async function acceptRequest(requestId) {
  const { error } = await _supabase.rpc("accept_connection", {
    p_request_id: requestId,
  });

  if (error) throw error;

  setMessage("已接受邀请");
  await loadPanelData();
}

async function declineRequest(requestId) {
  const { error } = await _supabase
    .from("connection_requests")
    .update({ status: "declined" })
    .eq("id", requestId);

  if (error) throw error;

  setMessage("已拒绝邀请");
  await loadPanelData();
}

function subscribeToRequests() {
  if (!_supabase || !_selfAuthId) return;

  if (requestChannel) {
    _supabase.removeChannel(requestChannel);
    requestChannel = null;
  }

  requestChannel = _supabase
    .channel(`lounge-requests-${_selfAuthId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "connection_requests",
        filter: `to_id=eq.${_selfAuthId}`,
      },
      () => {
        loadPanelData();
      },
    )
    .subscribe();
}

function bindEvents() {
  const p = panel();
  if (!p || p.dataset.bound === "true") return;

  p.dataset.bound = "true";

  p.querySelector(".lounge-close")?.addEventListener("click", closeLoungePanel);

  p.addEventListener("click", (event) => {
    const btn = event.target.closest("button");
    if (!btn) return;

    if (btn.matches(".lounge-copy-id-btn")) {
      copyToClipboard(document.querySelector(".lounge-gp-id")?.textContent, btn);
      return;
    }

    if (btn.matches(".lounge-edit-name-btn, .lounge-edit-display-name")) {
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
        placeholder: "输入 gp_ 开头的 GoodPuppy ID",
        submitText: "邀请",
        validate: (value) => (!normalizeGpId(value) ? "请输入 gp_ 开头的 GoodPuppy ID" : ""),
        onSubmit: inviteMember,
      });
      return;
    }

    if (btn.matches(".lounge-enter-room")) {
      const room = getSelectedRoom();
      if (!room) return;

      if (btn.dataset.action === "exit") {
        _onExitRoom?.();
        setMessage("已退出房间");
        return;
      }

      _onEnterRoom?.(room.id);
    }
  });

  document.querySelector(".lounge-request-list")?.addEventListener("click", async (event) => {
    const btn = event.target.closest("button[data-action]");
    if (!btn) return;

    const { action, id } = btn.dataset;
    btn.disabled = true;

    try {
      if (action === "accept") await acceptRequest(id);
      if (action === "decline") await declineRequest(id);
    } catch (error) {
      setMessage(error.message || "操作失败", { isError: true });
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelector(".lounge-modal-backdrop")?.addEventListener("pointerdown", (event) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.hidden = true;
    }
  });

  p.addEventListener("pointerdown", (event) => {
    if (event.target.closest("input, button, textarea, .room-list, .invite-list")) return;
    window.goodPuppy?.startWindowDrag?.();
  });
}

export function initLoungePanel({ supabase, selfAuthId, getActiveRoomId, onEnterRoom, onExitRoom }) {
  _supabase = supabase;
  _selfAuthId = selfAuthId;
  _getActiveRoomId = getActiveRoomId;
  _onEnterRoom = onEnterRoom;
  _onExitRoom = onExitRoom;

  bindEvents();
  subscribeToRequests();
}

export function updateLoungePanelAuth({ supabase, selfAuthId }) {
  _supabase = supabase;
  _selfAuthId = selfAuthId;
  subscribeToRequests();
}

export function openLoungePanel() {
  const p = panel();
  if (!p) return;

  p.hidden = false;
  window.goodPuppy?.setIgnoreMouseEvents?.(false);
  loadPanelData();
}

export function closeLoungePanel() {
  if (window.__TAURI_INTERNALS__) {
    getCurrentWindow().hide();
  } else {
    const p = panel();
    if (p) p.hidden = true;
  }
}
