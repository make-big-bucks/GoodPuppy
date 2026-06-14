import { getCurrentWindow } from "@tauri-apps/api/window";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import { renderRoomList, renderPendingRequests } from "./views/room-list.js";
import { renderRoomDetail } from "./views/room-detail.js";
import { renderProfileCard } from "./views/profile-card.js";
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
  onEnterRoom: (roomId: string) => void;
  onExitRoom: () => void;
};

type UpdatePanelAuthOptions = {
  supabase: SupabaseClient;
  selfAuthId: string | null;
};

type InputModalOptions = {
  title: string;
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
  return error instanceof Error ? error.message : fallback;
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
let onEnterRoom: ((roomId: string) => void) | null = null;
let onExitRoom: (() => void) | null = null;

let rooms: LoungeRoom[] = [];
let pendingRequests: ConnectionRequestRow[] = [];
let selectedRoomId: string | null = null;
let requestChannel: RealtimeChannel | null = null;

const panel = () => document.querySelector<HTMLElement>(".lounge-panel");
const modalBackdrop = () => document.querySelector<HTMLElement>(".lounge-modal-backdrop");
const modalForm = () => document.querySelector<HTMLFormElement>(".lounge-modal");

function getSelectedRoom() {
  return rooms.find((room) => room.id === selectedRoomId) || null;
}

function setMessage(text: string, { isError = false }: { isError?: boolean } = {}) {
  const el = document.querySelector<HTMLElement>(".lounge-message");
  if (!el) return;

  el.textContent = text || "";
  el.classList.toggle("is-error", isError);

  if (text) {
    setTimeout(() => {
      if (el.textContent === text) el.textContent = "";
    }, 3000);
  }
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

async function copyToClipboard(text: string | null | undefined, btn: HTMLButtonElement) {
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

function renderProfile(profile: LoungeProfile | null) {
  renderProfileCard(profile);
}

function onRoomSelect(id: string) {
  selectedRoomId = id;
  renderAll();
}

function renderAll() {
  renderRoomList(rooms, selectedRoomId, onRoomSelect);
  renderPendingRequests(pendingRequests);
  renderRoomDetail(getSelectedRoom(), selfAuthId, getActiveRoomId?.() || null);
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
          .select("room_id, user_id, is_online, last_seen")
          .in("room_id", roomIds),
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
        allPresence.filter((presence) => presence.room_id === item.room_id),
        selfAuthId,
      ),
    }));

    pendingRequests = ((requestsResult.data as ConnectionRequestRow[] | null) || []);

    if (!selectedRoomId || !rooms.some((room) => room.id === selectedRoomId)) {
      selectedRoomId = rooms[0]?.id || null;
    }

    renderAll();
  } catch (error) {
    setMessage(getErrorMessage(error, "加载失败"), { isError: true });
  }
}

function openInputModal({
  title,
  placeholder,
  submitText = "确定",
  initialValue = "",
  validate,
  onSubmit,
}: InputModalOptions) {
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

  const close = () => {
    backdrop.hidden = true;
    form.onsubmit = null;
  };

  cancel.onclick = close;
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
      setModalMessage(getErrorMessage(error, "操作失败"));
    } finally {
      setModalBusy(false);
    }
  };
}

async function createRoom(roomName: string) {
  if (!supabaseClient || !selfAuthId) return;
  const { data: room, error: roomError } = await supabaseClient
    .from("rooms")
    .insert({
      room_name: roomName,
      created_by: selfAuthId,
    })
    .select("id, room_name, description, invite_code, created_by")
    .single();

  if (roomError) throw roomError;

  const { error: memberError } = await supabaseClient.from("room_members").insert({
    room_id: room.id,
    user_id: selfAuthId,
  });

  if (memberError) throw memberError;

  selectedRoomId = room.id;
  setMessage("房间已创建");
  await loadPanelData();
}

async function joinRoomByInvite(inviteCode: string) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.rpc("join_room_by_invite", {
    p_invite_code: inviteCode,
  });

  if (error) throw error;

  setMessage("已加入房间");
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

  setMessage("邀请已发送");
}

async function updateDisplayName(displayName: string) {
  if (!supabaseClient || !selfAuthId) return;
  const value = displayName.trim();
  if (!value) throw new Error("请输入用户名");

  const { error } = await supabaseClient.from("profiles").update({ display_name: value }).eq("id", selfAuthId);
  if (error) throw error;

  setMessage("用户名已更新");
  await loadPanelData();
}

function openDisplayNameEditor() {
  const profileName = document.querySelector<HTMLElement>(".lounge-edit-display-name")?.textContent || "";
  openInputModal({
    title: "编辑用户名",
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

  setMessage("房间信息已更新");
  await loadPanelData();
}

function openRoomMetadataModal() {
  const room = getSelectedRoom();
  const backdrop = modalBackdrop();
  const form = modalForm();
  if (!room || !backdrop || !form) return;

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

  const roomNameInput = requiredQuery<HTMLInputElement>(form, ".lounge-room-name-input");
  const roomDescriptionInput = requiredQuery<HTMLTextAreaElement>(form, ".lounge-room-description-input");
  const cancel = requiredQuery<HTMLButtonElement>(form, ".lounge-form-cancel");

  roomNameInput.value = room.room_name || "";
  roomDescriptionInput.value = room.description || "";
  setModalMessage("");
  setModalBusy(false);
  backdrop.hidden = false;

  const close = () => {
    backdrop.hidden = true;
    form.onsubmit = null;
  };

  cancel.onclick = close;
  roomNameInput.focus();
  form.onsubmit = async (event) => {
    event.preventDefault();
    setModalBusy(true);
    try {
      await updateSelectedRoomMetadata({
        roomName: roomNameInput.value,
        description: roomDescriptionInput.value,
      });
      close();
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

  setMessage("已接受邀请");
  await loadPanelData();
}

async function declineRequest(requestId: string) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient
    .from("connection_requests")
    .update({ status: "declined" })
    .eq("id", requestId);

  if (error) throw error;

  setMessage("已拒绝邀请");
  await loadPanelData();
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

function bindEvents() {
  const p = panel();
  if (!p || p.dataset.bound === "true") return;

  p.dataset.bound = "true";

  p.querySelector<HTMLElement>(".lounge-close")?.addEventListener("click", closeLoungePanel);

  p.addEventListener("click", (event) => {
    const btn = targetElement(event.target)?.closest<HTMLButtonElement>("button");
    if (!btn) return;

    if (btn.matches(".lounge-copy-id-btn")) {
      void copyToClipboard(document.querySelector<HTMLElement>(".lounge-gp-id")?.textContent, btn);
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
        onExitRoom?.();
        setMessage("已退出房间");
        return;
      }

      onEnterRoom?.(room.id);
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
      setMessage(getErrorMessage(error, "操作失败"), { isError: true });
    } finally {
      btn.disabled = false;
    }
  });

  document.querySelector<HTMLElement>(".lounge-modal-backdrop")?.addEventListener("pointerdown", (event) => {
    if (event.target === event.currentTarget && event.currentTarget instanceof HTMLElement) {
      event.currentTarget.hidden = true;
    }
  });

  p.addEventListener("pointerdown", (event) => {
    const target = targetElement(event.target);
    if (target?.closest("input, button, textarea, .room-list, .invite-list")) return;
    window.goodPuppy.startWindowDrag();
  });
}

export function initLoungePanel({
  supabase,
  selfAuthId: nextSelfAuthId,
  getActiveRoomId: nextGetActiveRoomId,
  onEnterRoom: nextOnEnterRoom,
  onExitRoom: nextOnExitRoom,
}: LoungePanelOptions) {
  supabaseClient = supabase;
  selfAuthId = nextSelfAuthId;
  getActiveRoomId = nextGetActiveRoomId;
  onEnterRoom = nextOnEnterRoom;
  onExitRoom = nextOnExitRoom;

  bindEvents();
  subscribeToRequests();
}

export function updateLoungePanelAuth({ supabase, selfAuthId: nextSelfAuthId }: UpdatePanelAuthOptions) {
  supabaseClient = supabase;
  selfAuthId = nextSelfAuthId;
  subscribeToRequests();
}

export function openLoungePanel() {
  const p = panel();
  if (!p) return;

  p.hidden = false;
  window.goodPuppy.setIgnoreMouseEvents(false);
  void loadPanelData();
}

export function closeLoungePanel() {
  if (window.__TAURI_INTERNALS__) {
    void getCurrentWindow().hide();
  } else {
    const p = panel();
    if (p) p.hidden = true;
  }
}
