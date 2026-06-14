import { getCurrentWindow } from "@tauri-apps/api/window";

let _supabase = null;
let _selfAuthId = null;
let _onEnterRoom = null;

let rooms = [];
let pendingRequests = [];
let selectedRoomId = null;
let requestChannel = null;

const panel = () => document.querySelector(".connect-panel");
const roomList = () => document.querySelector(".connect-room-list");
const requestList = () => document.querySelector(".connect-request-list");
const detailView = () => document.querySelector(".connect-room-detail");
const emptyDetail = () => document.querySelector(".connect-empty-detail");
const modalBackdrop = () => document.querySelector(".connect-modal-backdrop");
const modalForm = () => document.querySelector(".connect-modal");

function getSelectedRoom() {
  return rooms.find((room) => room.id === selectedRoomId) || null;
}

function setMessage(text, { isError = false } = {}) {
  const el = document.querySelector(".connect-message");
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
  const el = modalForm()?.querySelector(".connect-form-message");
  if (el) el.textContent = text || "";
}

function setModalBusy(isBusy) {
  modalForm()?.querySelectorAll("input, button").forEach((el) => {
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

function roomIconSvg() {
  return `
    <svg class="room-icon" viewBox="0 0 24 24" fill="none">
      <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    </svg>
  `;
}

function renderProfile(profile) {
  const nameEl = document.querySelector(".connect-display-name");
  const idEl = document.querySelector(".connect-gp-id");

  if (nameEl) nameEl.textContent = profile?.display_name || "GoodPuppy";
  if (idEl) idEl.textContent = profile?.id || _selfAuthId || "";
}

function renderRoomList() {
  const list = roomList();
  if (!list) return;

  list.innerHTML = "";

  if (rooms.length === 0) {
    const empty = document.createElement("div");
    empty.className = "room-item";
    empty.innerHTML = `<span class="room-text">还没有房间</span>`;
    list.appendChild(empty);
    return;
  }

  for (const room of rooms) {
    const btn = document.createElement("button");
    btn.className = "room-item";
    btn.type = "button";
    btn.dataset.roomId = room.id;
    btn.classList.toggle("active", room.id === selectedRoomId);
    btn.innerHTML = `
      ${roomIconSvg()}
      <span class="room-text">${room.room_name || "未命名房间"}</span>
      <span class="room-meta">${room.members.length} 人</span>
    `;
    btn.addEventListener("click", () => {
      selectedRoomId = room.id;
      renderRoomList();
      renderRoomDetail();
    });
    list.appendChild(btn);
  }
}

function renderPendingRequests() {
  const list = requestList();
  if (!list) return;

  list.innerHTML = "";

  for (const req of pendingRequests) {
    const sender = req.profiles || {};
    const item = document.createElement("div");
    item.className = "invite-item";
    item.innerHTML = `
      <div class="invite-title">新的房间邀请</div>
      <div class="invite-meta">${sender.id || req.from_id}</div>
      <div class="invite-actions">
        <button class="small-btn primary" type="button" data-action="accept" data-id="${req.id}">接受</button>
        <button class="small-btn" type="button" data-action="decline" data-id="${req.id}">拒绝</button>
      </div>
    `;
    list.appendChild(item);
  }
}

function renderRoomDetail() {
  const room = getSelectedRoom();
  const detail = detailView();
  const empty = emptyDetail();

  if (!detail || !empty) return;

  if (!room) {
    detail.hidden = true;
    empty.hidden = false;
    return;
  }

  detail.hidden = false;
  empty.hidden = true;

  const title = detail.querySelector(".connect-room-title");
  const members = detail.querySelector(".connect-member-list");
  const inviteCode = detail.querySelector(".connect-invite-code");

  if (title) title.textContent = room.room_name || "未命名房间";
  if (inviteCode) inviteCode.textContent = room.invite_code || "暂无";

  if (members) {
    members.innerHTML = "";
    for (const member of room.members) {
      const isSelf = member.user_id === _selfAuthId;
      const id = member.profiles?.id || member.user_id;
      const item = document.createElement("div");
      item.className = "member";
      item.innerHTML = `
        <div class="member-avatar">${isSelf ? "我" : "友"}</div>
        <div class="member-name" title="${id}">${id}</div>
        <span class="badge">${isSelf ? "你" : "成员"}</span>
      `;
      members.appendChild(item);
    }
  }
}

function renderAll() {
  renderRoomList();
  renderPendingRequests();
  renderRoomDetail();
}

async function loadPanelData() {
  if (!_supabase || !_selfAuthId) return;

  try {
    const [profileResult, myRoomsResult, requestsResult] = await Promise.all([
      _supabase.from("profiles").select("id, gp_id, display_name").eq("id", _selfAuthId).single(),
      _supabase
        .from("room_members")
        .select("room_id, rooms!inner(id, room_name, invite_code, created_by)")
        .eq("user_id", _selfAuthId),
      _supabase
        .from("connection_requests")
        .select("id, from_id, profiles!connection_requests_from_id_fkey(id, gp_id, display_name)")
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

    if (roomIds.length > 0) {
      const { data, error } = await _supabase
        .from("room_members")
        .select("room_id, user_id, profiles!room_members_user_id_fkey(id, gp_id, display_name)")
        .in("room_id", roomIds);

      if (error) throw error;
      allMembers = data || [];
    }

    rooms = myRooms.map((item) => ({
      id: item.room_id,
      room_name: item.rooms?.room_name || "未命名房间",
      invite_code: item.rooms?.invite_code || "",
      created_by: item.rooms?.created_by || "",
      members: allMembers.filter((member) => member.room_id === item.room_id),
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

function openInputModal({ title, placeholder, submitText = "确定", validate, onSubmit }) {
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!backdrop || !form) return;

  const titleEl = form.querySelector(".connect-modal-title");
  const input = form.querySelector(".connect-input");
  const submit = form.querySelector(".connect-form-submit");

  titleEl.textContent = title;
  input.value = "";
  input.placeholder = placeholder;
  submit.textContent = submitText;
  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    form.onsubmit = null;
  };

  form.querySelector(".connect-form-cancel").onclick = close;
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
    .select("id, room_name, invite_code, created_by")
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

async function inviteMember(targetUserId) {
  if (targetUserId === _selfAuthId) {
    throw new Error("不能邀请自己");
  }

  const { data: target, error: lookupError } = await _supabase
    .from("profiles")
    .select("id")
    .eq("id", targetUserId)
    .single();

  if (lookupError || !target) {
    throw new Error("找不到该用户 ID");
  }

  const { error } = await _supabase.from("connection_requests").insert({
    from_id: _selfAuthId,
    to_id: target.id,
    status: "pending",
  });

  if (error) throw error;

  setMessage("邀请已发送");
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
    .channel(`connect-requests-${_selfAuthId}`)
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

  p.querySelector(".connect-close")?.addEventListener("click", closeConnectPanel);

  p.querySelector('.connect-copy-btn[data-copy="gp-id"]')?.addEventListener("click", function () {
    copyToClipboard(document.querySelector(".connect-gp-id")?.textContent, this);
  });

  p.querySelector('.connect-copy-btn[data-copy="invite-code"]')?.addEventListener("click", function () {
    copyToClipboard(document.querySelector(".connect-invite-code")?.textContent, this);
  });

  p.querySelector(".connect-create-room")?.addEventListener("click", () => {
    openInputModal({
      title: "创建房间",
      placeholder: "输入房间名称",
      submitText: "创建",
      validate: (value) => (!value ? "请输入房间名称" : ""),
      onSubmit: createRoom,
    });
  });

  p.querySelector(".connect-join-room")?.addEventListener("click", () => {
    openInputModal({
      title: "加入房间",
      placeholder: "输入房间邀请码",
      submitText: "加入",
      validate: (value) => (!value ? "请输入邀请码" : ""),
      onSubmit: joinRoomByInvite,
    });
  });

  p.querySelector(".connect-invite-member")?.addEventListener("click", () => {
    openInputModal({
      title: "邀请成员",
      placeholder: "输入用户 ID",
      submitText: "邀请",
      validate: (value) => (!value ? "请输入用户 ID" : ""),
      onSubmit: inviteMember,
    });
  });

  p.querySelector(".connect-enter-room")?.addEventListener("click", () => {
    const room = getSelectedRoom();
    if (!room) return;

    closeConnectPanel();
    _onEnterRoom?.(room.id);
  });

  requestList()?.addEventListener("click", async (event) => {
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

  document.querySelector(".connect-modal-backdrop")?.addEventListener("pointerdown", (event) => {
    if (event.target === event.currentTarget) {
      event.currentTarget.hidden = true;
    }
  });

  p.addEventListener("pointerdown", (event) => {
    if (event.target.closest("input, button, textarea, .room-list, .invite-list")) return;
    window.goodPuppy?.startWindowDrag?.();
  });
}

export function initConnectPanel({ supabase, selfAuthId, onEnterRoom }) {
  _supabase = supabase;
  _selfAuthId = selfAuthId;
  _onEnterRoom = onEnterRoom;

  bindEvents();
  subscribeToRequests();
}

export function updateConnectPanelAuth({ supabase, selfAuthId }) {
  _supabase = supabase;
  _selfAuthId = selfAuthId;
  subscribeToRequests();
}

export function openConnectPanel() {
  const p = panel();
  if (!p) return;

  p.hidden = false;
  window.goodPuppy?.setIgnoreMouseEvents?.(false);
  loadPanelData();
}

export function closeConnectPanel() {
  if (window.__TAURI_INTERNALS__) {
    getCurrentWindow().hide();
  } else {
    const p = panel();
    if (p) p.hidden = true;
  }
}
