let _supabase = null;
let _selfAuthId = null;
let _onEnterRoom = null;

// Panel state
let currentView = "main"; // 'main' | 'room-detail'
let selectedRoom = null;  // { id, invite_code, members: [] }
let activeForm = null;    // null | 'id' | 'code'

// DOM refs — resolved once on first use
const panel = () => document.querySelector(".connect-panel");
const mainView = () => document.querySelector(".connect-main");
const detailView = () => document.querySelector(".connect-room-detail");

// ── Helpers ──────────────────────────────────────────────────

function setMainMessage(text, { isError = false } = {}) {
  const el = mainView()?.querySelector(".connect-message");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-error", isError);
  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 3000);
  }
}

function setDetailMessage(text, { isError = false } = {}) {
  const el = detailView()?.querySelector(".connect-message");
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-error", isError);
  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 3000);
  }
}

function setFormMessage(form, text) {
  const el = form?.querySelector(".connect-form-message");
  if (!el) return;
  el.textContent = text || "";
}

function setFormBusy(form, busy) {
  form?.querySelectorAll("input, button").forEach((el) => {
    el.disabled = busy;
  });
}

async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    const original = btn.textContent;
    btn.textContent = "已复制";
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  } catch {
    // silently ignore clipboard errors
  }
}

// ── View switching ────────────────────────────────────────────

function showMainView() {
  currentView = "main";
  mainView().hidden = false;
  detailView().hidden = true;
}

function showDetailView(room) {
  selectedRoom = room;
  currentView = "room-detail";
  mainView().hidden = true;
  detailView().hidden = false;
  renderRoomDetail(room);
}

// ── Render: main view ─────────────────────────────────────────

function renderProfile(profile) {
  const nameEl = mainView()?.querySelector(".connect-display-name");
  const idEl = mainView()?.querySelector(".connect-gp-id");
  if (nameEl) nameEl.textContent = profile.display_name || "（未设置）";
  if (idEl) idEl.textContent = profile.gp_id || _selfAuthId?.slice(0, 12) + "…";
}

function renderPendingRequests(requests) {
  const section = mainView()?.querySelector(".connect-requests");
  const list = mainView()?.querySelector(".connect-request-list");
  if (!section || !list) return;

  if (!requests || requests.length === 0) {
    section.hidden = true;
    return;
  }

  section.hidden = false;
  list.innerHTML = "";
  for (const req of requests) {
    const sender = req.profiles || {};
    const li = document.createElement("li");
    li.className = "connect-request-item";
    li.innerHTML = `
      <span class="connect-request-name">${sender.display_name || "未知用户"}</span>
      <span class="connect-request-id">${sender.gp_id || ""}</span>
      <button class="connect-req-btn accept" data-id="${req.id}" data-type="accept">接受</button>
      <button class="connect-req-btn decline" data-id="${req.id}" data-type="decline">拒绝</button>
    `;
    list.appendChild(li);
  }
}

function renderRoomList(rooms) {
  const list = mainView()?.querySelector(".connect-room-list");
  if (!list) return;

  list.innerHTML = "";

  if (!rooms || rooms.length === 0) {
    const li = document.createElement("li");
    li.className = "connect-empty-hint";
    li.textContent = "还没有房间";
    list.appendChild(li);
    return;
  }

  for (const room of rooms) {
    const otherMembers = room.members.filter((m) => m.user_id !== _selfAuthId);
    const label =
      otherMembers.map((m) => m.profiles?.display_name || m.profiles?.gp_id || "成员").join("、") ||
      "（仅自己）";

    const li = document.createElement("li");
    li.className = "connect-room-item";
    li.dataset.roomId = room.id;
    li.innerHTML = `
      <span class="connect-room-name">${label}</span>
      <span class="connect-room-meta">${room.members.length} 人</span>
      <span class="connect-room-arrow">›</span>
    `;
    li.addEventListener("click", () => showDetailView(room));
    list.appendChild(li);
  }
}

// ── Render: room detail ───────────────────────────────────────

function renderRoomDetail(room) {
  const view = detailView();
  if (!view) return;

  const memberList = view.querySelector(".connect-member-list");
  const inviteCodeEl = view.querySelector(".connect-invite-code");

  if (inviteCodeEl) inviteCodeEl.textContent = room.invite_code || "—";

  if (memberList) {
    memberList.innerHTML = "";
    for (const m of room.members) {
      const isSelf = m.user_id === _selfAuthId;
      const name = m.profiles?.display_name || m.profiles?.gp_id || "未知成员";
      const li = document.createElement("li");
      li.className = "connect-member-item";
      li.innerHTML = `
        <span>${name}</span>
        ${isSelf ? '<span class="connect-member-self">（你）</span>' : ""}
      `;
      memberList.appendChild(li);
    }
  }
}

// ── Data loading ──────────────────────────────────────────────

async function loadPanelData() {
  if (!_supabase || !_selfAuthId) return;

  try {
    const [profileResult, myRoomsResult, requestsResult] = await Promise.all([
      _supabase.from("profiles").select("gp_id, display_name").eq("id", _selfAuthId).single(),
      _supabase
        .from("room_members")
        .select("room_id, rooms!inner(id, invite_code)")
        .eq("user_id", _selfAuthId),
      _supabase
        .from("connection_requests")
        .select("id, from_id, profiles!connection_requests_from_id_fkey(gp_id, display_name)")
        .eq("to_id", _selfAuthId)
        .eq("status", "pending"),
    ]);

    if (profileResult.data) renderProfile(profileResult.data);

    const myRooms = myRoomsResult.data || [];
    let rooms = [];

    if (myRooms.length > 0) {
      const roomIds = myRooms.map((r) => r.room_id);
      const { data: allMembers } = await _supabase
        .from("room_members")
        .select("room_id, user_id, profiles!room_members_user_id_fkey(gp_id, display_name)")
        .in("room_id", roomIds);

      rooms = myRooms.map((r) => {
        const roomData = r.rooms;
        const members = (allMembers || []).filter((m) => m.room_id === r.room_id);
        return {
          id: r.room_id,
          invite_code: roomData?.invite_code || "",
          members,
        };
      });
    }

    renderRoomList(rooms);
    renderPendingRequests(requestsResult.data || []);
  } catch (error) {
    setMainMessage(error.message || "加载失败", { isError: true });
  }
}

// ── Actions ───────────────────────────────────────────────────

async function handleAcceptRequest(requestId) {
  try {
    const { error } = await _supabase.rpc("accept_connection", { request_id: requestId });
    if (error) throw error;
    setMainMessage("已接受，房间已创建");
    await loadPanelData();
  } catch (error) {
    setMainMessage(error.message || "操作失败", { isError: true });
  }
}

async function handleDeclineRequest(requestId) {
  try {
    const { error } = await _supabase
      .from("connection_requests")
      .update({ status: "declined" })
      .eq("id", requestId);
    if (error) throw error;
    setMainMessage("已拒绝");
    await loadPanelData();
  } catch (error) {
    setMainMessage(error.message || "操作失败", { isError: true });
  }
}

async function handleConnectById(gpId) {
  const form = mainView()?.querySelector(".connect-form-id");
  setFormBusy(form, true);
  setFormMessage(form, "");

  try {
    const { data: target, error: lookupError } = await _supabase
      .from("profiles")
      .select("id")
      .eq("gp_id", gpId)
      .single();

    if (lookupError || !target) {
      setFormMessage(form, "找不到该 GoodPuppy ID");
      return;
    }

    if (target.id === _selfAuthId) {
      setFormMessage(form, "不能连接自己");
      return;
    }

    const { error: insertError } = await _supabase.from("connection_requests").insert({
      from_id: _selfAuthId,
      to_id: target.id,
      status: "pending",
    });

    if (insertError) throw insertError;

    hideActiveForm();
    setMainMessage("连接请求已发送，等待对方确认");
  } catch (error) {
    setFormMessage(form, error.message || "发送失败");
  } finally {
    setFormBusy(form, false);
  }
}

async function handleJoinByCode(inviteCode) {
  const form = mainView()?.querySelector(".connect-form-code");
  setFormBusy(form, true);
  setFormMessage(form, "");

  try {
    const { error } = await _supabase.rpc("join_room_by_invite", { invite_code: inviteCode });
    if (error) throw error;

    hideActiveForm();
    setMainMessage("已加入房间");
    await loadPanelData();
  } catch (error) {
    setFormMessage(form, error.message || "加入失败");
  } finally {
    setFormBusy(form, false);
  }
}

// ── Form toggle ───────────────────────────────────────────────

function showForm(type) {
  const idForm = mainView()?.querySelector(".connect-form-id");
  const codeForm = mainView()?.querySelector(".connect-form-code");
  const idBtn = mainView()?.querySelector('.connect-action-btn[data-action="id"]');
  const codeBtn = mainView()?.querySelector('.connect-action-btn[data-action="code"]');

  if (activeForm === type) {
    hideActiveForm();
    return;
  }

  activeForm = type;
  idForm.hidden = type !== "id";
  codeForm.hidden = type !== "code";
  idBtn.classList.toggle("is-active", type === "id");
  codeBtn.classList.toggle("is-active", type === "code");

  if (type === "id") {
    setFormMessage(idForm, "");
    idForm.querySelector(".connect-input")?.focus();
  } else {
    setFormMessage(codeForm, "");
    codeForm.querySelector(".connect-input")?.focus();
  }
}

function hideActiveForm() {
  const idForm = mainView()?.querySelector(".connect-form-id");
  const codeForm = mainView()?.querySelector(".connect-form-code");
  const idBtn = mainView()?.querySelector('.connect-action-btn[data-action="id"]');
  const codeBtn = mainView()?.querySelector('.connect-action-btn[data-action="code"]');

  activeForm = null;
  if (idForm) { idForm.hidden = true; idForm.reset(); }
  if (codeForm) { codeForm.hidden = true; codeForm.reset(); }
  idBtn?.classList.remove("is-active");
  codeBtn?.classList.remove("is-active");
}

// ── Public API ────────────────────────────────────────────────

export function initConnectPanel({ supabase, selfAuthId, onEnterRoom }) {
  _supabase = supabase;
  _selfAuthId = selfAuthId;
  _onEnterRoom = onEnterRoom;

  const p = panel();
  if (!p) return;

  // Close buttons
  p.querySelectorAll(".connect-close").forEach((btn) => {
    btn.addEventListener("click", closeConnectPanel);
  });

  // Back button
  p.querySelector(".connect-back")?.addEventListener("click", () => {
    selectedRoom = null;
    showMainView();
  });

  // Action buttons (toggle inline forms)
  mainView()
    ?.querySelectorAll(".connect-action-btn")
    .forEach((btn) => {
      btn.addEventListener("click", () => showForm(btn.dataset.action));
    });

  // Cancel buttons in forms
  mainView()
    ?.querySelectorAll(".connect-form-cancel")
    .forEach((btn) => {
      btn.addEventListener("click", hideActiveForm);
    });

  // Form submits
  mainView()?.querySelector(".connect-form-id")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const gpId = e.target.querySelector('input[name="gp-id"]').value.trim();
    if (gpId) handleConnectById(gpId);
  });

  mainView()?.querySelector(".connect-form-code")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const code = e.target.querySelector('input[name="invite-code"]').value.trim();
    if (code) handleJoinByCode(code);
  });

  // Request list delegation (accept / decline)
  mainView()?.querySelector(".connect-request-list")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".connect-req-btn");
    if (!btn) return;
    const { id, type } = btn.dataset;
    if (type === "accept") handleAcceptRequest(id);
    else if (type === "decline") handleDeclineRequest(id);
  });

  // Copy buttons
  p.querySelector('.connect-copy-btn[data-copy="gp-id"]')?.addEventListener("click", function () {
    const text = mainView()?.querySelector(".connect-gp-id")?.textContent;
    if (text) copyToClipboard(text, this);
  });

  p.querySelector('.connect-copy-btn[data-copy="invite-code"]')?.addEventListener("click", function () {
    const text = detailView()?.querySelector(".connect-invite-code")?.textContent;
    if (text) copyToClipboard(text, this);
  });

  // Enter room
  detailView()?.querySelector(".connect-enter-room")?.addEventListener("click", () => {
    if (!selectedRoom) return;
    closeConnectPanel();
    _onEnterRoom?.(selectedRoom.id);
  });

  // Drag to move window (click on panel background)
  p.addEventListener("pointerdown", (e) => {
    if (e.target.closest("input, button, textarea")) return;
    window.goodPuppy?.startWindowDrag?.();
  });
}

export function updateConnectPanelAuth({ supabase, selfAuthId }) {
  _supabase = supabase;
  _selfAuthId = selfAuthId;
}

export function openConnectPanel() {
  const p = panel();
  if (!p) return;

  showMainView();
  hideActiveForm();
  p.hidden = false;
  window.goodPuppy?.setIgnoreMouseEvents?.(false);
  loadPanelData();
}

export function closeConnectPanel() {
  const p = panel();
  if (!p) return;

  p.hidden = true;
  selectedRoom = null;
  activeForm = null;
}
