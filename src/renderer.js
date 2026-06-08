import { getSafeState, stateCount } from "./petState.js";
import { isPointOpaqueInImage } from "./hitTesting.js";
import * as presence from "./presence.js";
import { getPetWindowLayout, orderRemotePetIds } from "./petLayout.js";
import { Menu } from "@tauri-apps/api/menu";

const petStage = document.querySelector(".pet-stage");
const cloudHitImage = new Image();
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const alphaHitThreshold = 16;
const alphaHitSlop = 3;
const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

const SELF_ID = "self";
const DEFAULT_PET_STATE = 6;

const petImage = document.querySelector('.pet-image[data-user="self"]');
const messageBubble = document.querySelector('.message-bubble[data-user="self"]');

messageBubble?.classList.add("is-owned");

let selfPetId = "default";
let currentState = DEFAULT_PET_STATE;
let selfAuthId = null;
let currentRoomId = null;
let activeSupabase = null;
let messagesChannel = null;
const remotePets = new Map();

const messageHistory = [];
let messageIndex = -1;
let isUnread = false;
let pointerStart = null;
let windowStart = null;
let isDragging = false;
let bubblePointerStart = false;
let isIgnoringMouseEvents = false;
let lastPointerEvent = null;
let hasStartedPetApp = false;

cloudHitImage.src = "/img/cloud_transparent.png";
document.querySelector('.dog-area[data-user="self"]')?.style.setProperty("--pet-index", "0");
setPetStateImage(DEFAULT_PET_STATE);
updateBubbleNav();

// ── Pet state image ───────────────────────────────────────────

function getStateImagePath(stateNumber, petId = "default") {
  // v1: only one pet type; petId is wired through for v2 multi-pet support
  void petId;
  return `/state_images/state_${String(stateNumber).padStart(2, "0")}.gif`;
}

function setPetStateImage(stateNumber) {
  if (!petImage) return;
  petImage.src = getStateImagePath(stateNumber, selfPetId);
}

function showNextState() {
  currentState = currentState === stateCount ? 1 : currentState + 1;
  setPetStateImage(currentState);
  refreshMousePassthrough();
}

// ── Remote pet layout ────────────────────────────────────────

function getDogAreaForEvent(event) {
  return event.target?.closest?.(".dog-area") || null;
}

function getPetIdentityForEvent(event) {
  const area = getDogAreaForEvent(event);
  if (!area) return { kind: "self", id: SELF_ID };
  if (area.dataset.user === "remote") return { kind: "remote", id: area.dataset.userId };
  return { kind: "self", id: SELF_ID };
}

function createRemotePetElement(userId) {
  const section = document.createElement("section");
  section.className = "dog-area remote-pet";
  section.dataset.user = "remote";
  section.dataset.userId = userId;
  section.setAttribute("aria-label", "Remote puppy");
  section.innerHTML = `
    <div class="message-bubble" role="status" aria-live="polite" data-user="remote" hidden>
      <span class="message-alert" aria-hidden="true">!</span>
      <div class="bubble-content">
        <div class="bubble-text"></div>
        <div class="bubble-nav" aria-label="Message navigation">
          <button class="bubble-nav-button bubble-prev" type="button" aria-label="Previous message">&lt;</button>
          <button class="bubble-nav-button bubble-next" type="button" aria-label="Next message">&gt;</button>
        </div>
      </div>
    </div>
    <img class="pet-image" data-user="remote" src="${getStateImagePath(
      DEFAULT_PET_STATE
    )}" alt="Remote puppy" draggable="false" />
  `;
  section.querySelector(".pet-image")?.addEventListener("load", refreshMousePassthrough);
  petStage.appendChild(section);
  return section;
}

function applyPetLayout(remoteUserIds) {
  const ordered = orderRemotePetIds(remoteUserIds);
  const online = new Set(ordered);

  for (const [userId, element] of remotePets) {
    if (!online.has(userId)) {
      element.remove();
      remotePets.delete(userId);
    }
  }

  ordered.forEach((userId, index) => {
    let element = remotePets.get(userId);
    if (!element) {
      element = createRemotePetElement(userId);
      remotePets.set(userId, element);
    }
    element.style.setProperty("--pet-index", String(index + 1));
  });

  const selfArea = document.querySelector('.dog-area[data-user="self"]');
  selfArea?.style.setProperty("--pet-index", "0");

  window.goodPuppy.setWindowSize(getPetWindowLayout(ordered.length));
  refreshMousePassthrough();
}

// ── Message bubble ────────────────────────────────────────────

function getBubbleTextElement() {
  return messageBubble?.querySelector(".bubble-text");
}

function getBubblePrevButton() {
  return messageBubble?.querySelector(".bubble-prev");
}

function getBubbleNextButton() {
  return messageBubble?.querySelector(".bubble-next");
}

function getBubbleAlert() {
  return messageBubble?.querySelector(".message-alert");
}

function getBubbleComposer() {
  return messageBubble?.querySelector(".bubble-composer");
}

function getBubbleInput() {
  return messageBubble?.querySelector(".bubble-input");
}

function getBubbleStatus() {
  return messageBubble?.querySelector(".bubble-status");
}

function setComposerStatus(message) {
  const status = getBubbleStatus();
  if (status) status.textContent = message || "";
}

function setBubbleText(text) {
  const el = getBubbleTextElement();
  if (el) el.textContent = text;
}

function updateBubbleNav() {
  const prev = getBubblePrevButton();
  const next = getBubbleNextButton();
  if (prev) prev.disabled = messageIndex <= 0;
  if (next) next.disabled = messageIndex < 0 || messageIndex >= messageHistory.length - 1;
}

function normalizeMessage(message) {
  if (!message?.info) return null;
  return {
    id: message.id ?? `${Date.now()}-${Math.random()}`,
    info: message.info,
    state: getSafeState(Number(message.state), DEFAULT_PET_STATE),
    from: message.from,
    created_at: message.created_at || new Date().toISOString(),
  };
}

function sortByTime(messages) {
  return [...messages].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
}

function renderMessageAt(index, { markUnread = false } = {}) {
  const message = messageHistory[index];
  if (!message || !messageBubble) {
    updateBubbleNav();
    return;
  }
  messageIndex = index;
  setBubbleText(message.info);
  messageBubble.hidden = false;
  setUnread(markUnread);
  updateBubbleNav();
  refreshMousePassthrough();
}

function setLocalMessages(messages) {
  const normalized = sortByTime(
    messages.map((m) => normalizeMessage(m)).filter(Boolean)
  );
  messageHistory.length = 0;
  messageHistory.push(...normalized);

  if (normalized.length === 0) {
    messageIndex = -1;
    setBubbleText("");
    setUnread(false);
    updateBubbleNav();
    return;
  }
  renderMessageAt(normalized.length - 1, { markUnread: false });
}

function addLocalMessage(message, { markUnread = false } = {}) {
  const normalized = normalizeMessage(message);
  if (!normalized) return;
  if (messageHistory.some((m) => m.id === normalized.id)) return;
  messageHistory.push(normalized);
  messageHistory.sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  );
  renderMessageAt(messageHistory.length - 1, { markUnread });
}

function setUnread(hasUnread) {
  isUnread = hasUnread;
  messageBubble?.classList.toggle("has-unread", hasUnread);
}

function showPreviousMessage() {
  if (messageIndex > 0) renderMessageAt(messageIndex - 1);
}

function showNextMessage() {
  if (messageIndex >= 0 && messageIndex < messageHistory.length - 1)
    renderMessageAt(messageIndex + 1);
}

function showMessageBubble() {
  if (messageHistory.length === 0) return;
  renderMessageAt(messageIndex >= 0 ? messageIndex : messageHistory.length - 1, {
    markUnread: false,
  });
}

function closeMessageBubble() {
  if (!messageBubble || messageBubble.hidden) return;
  messageBubble.hidden = true;
  setUnread(false);
  refreshMousePassthrough();
}

// ── Composer ──────────────────────────────────────────────────

function openBubbleComposer() {
  if (!messageBubble) return;
  const composer = getBubbleComposer();
  const input = getBubbleInput();
  if (!composer || !input) return;
  messageBubble.hidden = false;
  messageBubble.classList.add("is-editing");
  setUnread(false);
  setComposerStatus("");
  composer.hidden = false;
  input.value = "";
  input.focus();
  refreshMousePassthrough();
}

function closeBubbleComposer() {
  if (!messageBubble) return;
  const composer = getBubbleComposer();
  const input = getBubbleInput();
  if (!composer || !input) return;
  messageBubble.classList.remove("is-editing");
  composer.hidden = true;
  setComposerStatus("");
  input.value = "";
  refreshMousePassthrough();
}

async function sendComposerMessage() {
  const input = getBubbleInput();
  const info = input?.value.trim();
  if (!info) {
    setComposerStatus("请先输入消息");
    input?.focus();
    return;
  }
  if (!activeSupabase || !selfAuthId || !currentRoomId) {
    setComposerStatus("请先登录");
    input?.focus();
    return;
  }
  setComposerStatus("正在发送...");
  const { error } = await activeSupabase.from("messages").insert({
    room_id: currentRoomId,
    sender_id: selfAuthId,
    kind: "text",
    content: info,
  });
  if (error) {
    setComposerStatus(error.message || "发送失败");
    throw error;
  }
  setComposerStatus("");
  addLocalMessage(
    {
      id: `local-${Date.now()}`,
      info,
      state: DEFAULT_PET_STATE,
      from: selfAuthId,
      created_at: new Date().toISOString(),
    },
    { markUnread: false }
  );
  closeBubbleComposer();
}

// ── Messages (self) ───────────────────────────────────────────

function msgToLocal(msg) {
  return {
    id: msg.id,
    info: msg.content,
    state: DEFAULT_PET_STATE,
    from: msg.sender_id,
    created_at: msg.created_at,
  };
}

async function fetchSelfMessages() {
  if (!activeSupabase || !currentRoomId || !selfAuthId) return;
  const { data, error } = await activeSupabase
    .from("messages")
    .select("id, content, created_at, sender_id, kind")
    .eq("room_id", currentRoomId)
    .eq("sender_id", selfAuthId)
    .order("created_at", { ascending: false })
    .limit(5);
  if (error) throw error;
  setLocalMessages((data || []).map(msgToLocal));
}

async function subscribeToSelfMessages() {
  if (!activeSupabase || !currentRoomId) return;
  if (messagesChannel) {
    await activeSupabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }
  // Only subscribe to messages sent by self (for local confirmation / multi-device)
  messagesChannel = activeSupabase
    .channel("self-messages-" + currentRoomId)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `room_id=eq.${currentRoomId}`,
      },
      (payload) => {
        const msg = msgToLocal(payload.new);
        // Only handle messages from self that weren't added locally already
        if (msg.from === selfAuthId) {
          addLocalMessage(msg, { markUnread: false });
        }
      }
    )
    .subscribe();
}

// ── Hit testing & mouse passthrough ──────────────────────────

function isPetOpaqueAt(event) {
  const image = event.target?.closest?.(".pet-image");
  if (!image) return false;
  return isPointOpaqueInImage(event, image, image, hitContext, hitCanvas, {
    respectObjectFit: true,
    alphaThreshold: alphaHitThreshold,
    hitSlop: alphaHitSlop,
  });
}

function isBubbleOpaqueAt(event) {
  const bubble = getBubbleForPoint(event);
  if (!bubble || bubble.hidden) return false;
  return isPointOpaqueInImage(event, bubble, cloudHitImage, hitContext, hitCanvas, {
    alphaThreshold: alphaHitThreshold,
    hitSlop: alphaHitSlop,
  });
}

function isBubbleVisible() {
  return Boolean(document.querySelector(".message-bubble:not([hidden])"));
}

function isComposerVisible() {
  return messageBubble?.classList.contains("is-editing");
}

function isPointInsideElement(event, element) {
  const rect = element.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function getBubbleForPoint(event) {
  const targetBubble = event.target?.closest?.(".message-bubble");
  if (targetBubble && !targetBubble.hidden && isPointInsideElement(event, targetBubble)) {
    return targetBubble;
  }

  return (
    [...document.querySelectorAll(".message-bubble:not([hidden])")].find((bubble) =>
      isPointInsideElement(event, bubble)
    ) || null
  );
}

function isBubbleControlAt(event) {
  const bubble = getBubbleForPoint(event);
  if (!bubble) return false;
  return [...bubble.querySelectorAll("button, textarea, input")].some((control) =>
    isPointInsideElement(event, control)
  );
}

function isInteractiveAt(event) {
  const bubble = getBubbleForPoint(event);
  if (isBubbleControlAt(event)) return true;
  if (isComposerVisible() && bubble) return true;
  if (bubble) return true;
  if (isBubbleVisible() && isBubbleOpaqueAt(event)) return true;
  return isPetOpaqueAt(event);
}

function setMousePassthrough(shouldPassThrough) {
  if (isIgnoringMouseEvents === shouldPassThrough) return;
  isIgnoringMouseEvents = shouldPassThrough;
  window.goodPuppy.setIgnoreMouseEvents(shouldPassThrough);
}

function updateMousePassthrough(event) {
  lastPointerEvent = event;
  if (pointerStart || bubblePointerStart) {
    setMousePassthrough(false);
    return;
  }
  setMousePassthrough(!isInteractiveAt(event));
}

function refreshMousePassthrough() {
  if (lastPointerEvent) {
    window.requestAnimationFrame(() => updateMousePassthrough(lastPointerEvent));
  }
}

document.addEventListener("mousemove", updateMousePassthrough);
document.addEventListener("mouseleave", () => {
  if (!pointerStart && !bubblePointerStart) setMousePassthrough(true);
});

window.goodPuppy.onCursorMoved((point) => {
  if (!point) return;
  const target = document.elementFromPoint(point.x, point.y) || document.body;
  updateMousePassthrough({ clientX: point.x, clientY: point.y, target });
});

// ── Pointer events ────────────────────────────────────────────

function showRemoteBubble(userId) {
  const element = remotePets.get(userId);
  const bubble = element?.querySelector(".message-bubble");
  const text = bubble?.querySelector(".bubble-text");
  if (!bubble || !text) return;
  text.textContent = "在线";
  bubble.hidden = false;
  refreshMousePassthrough();
}

async function showPetContextMenu(event) {
  const identity = getPetIdentityForEvent(event);
  const hasSelfMessages = messageHistory.length > 0;
  const menu = await Menu.new({
    items: [
      {
        id: "show-message",
        text: identity.kind === "self" ? "查看对话" : "查看状态",
        action: () => {
          if (identity.kind === "remote") {
            showRemoteBubble(identity.id);
            return;
          }
          if (hasSelfMessages) {
            showMessageBubble();
          } else {
            openBubbleComposer();
          }
        },
      },
      {
        id: "write-message",
        text: "写消息",
        action: () => openBubbleComposer(),
      },
      {
        id: "next-state",
        text: "切换我的表情",
        action: () => showNextState(),
      },
    ],
  });
  await menu.popup();
}

petStage.addEventListener("pointerdown", async (event) => {
  setMousePassthrough(false);
  if (event.button !== 0) return;
  if (event.target.closest(".bubble-composer")) return;
  if (event.target.closest(".bubble-nav")) return;
  if (event.target.closest(".bubble-text")) return;

  if (isBubbleOpaqueAt(event)) {
    bubblePointerStart = true;
    pointerStart = null;
    windowStart = null;
    isDragging = false;
    return;
  }

  if (!isPetOpaqueAt(event)) return;

  if (supportsNativeWindowDrag) {
    window.goodPuppy.startWindowDrag();
    return;
  }

  pointerStart = { x: event.screenX, y: event.screenY };
  isDragging = false;
  petStage.setPointerCapture(event.pointerId);
  windowStart = await window.goodPuppy.getWindowPosition();
});

petStage.addEventListener("contextmenu", (event) => {
  if (
    event.target.closest(".bubble-composer") ||
    event.target.closest(".bubble-nav") ||
    event.target.closest(".bubble-text")
  )
    return;
  event.preventDefault();
  if (isBubbleOpaqueAt(event)) return;
  if (!isPetOpaqueAt(event)) return;
  showPetContextMenu(event).catch(console.error);
});

petStage.addEventListener("pointermove", (event) => {
  updateMousePassthrough(event);
  if (!pointerStart) return;
  const deltaX = event.screenX - pointerStart.x;
  const deltaY = event.screenY - pointerStart.y;
  isDragging = true;
  if (isDragging && windowStart) {
    window.goodPuppy.setWindowPosition({
      x: windowStart.x + deltaX,
      y: windowStart.y + deltaY,
    });
  }
});

petStage.addEventListener("pointerup", (event) => {
  if (event.target.closest(".bubble-nav")) return;
  if (event.target.closest(".bubble-composer")) return;

  if (bubblePointerStart) {
    if (event.button === 0 && isBubbleOpaqueAt(event)) {
      if (!messageBubble?.classList.contains("is-editing")) {
        closeMessageBubble();
      }
    }
    bubblePointerStart = false;
    return;
  }

  pointerStart = null;
  windowStart = null;
  isDragging = false;

  if (petStage.hasPointerCapture(event.pointerId)) {
    petStage.releasePointerCapture(event.pointerId);
  }

  updateMousePassthrough(event);
});

petStage.addEventListener("pointercancel", () => {
  pointerStart = null;
  windowStart = null;
  isDragging = false;
  bubblePointerStart = false;
});

// ── Bubble event wiring ───────────────────────────────────────

if (messageBubble) {
  const composer = getBubbleComposer();
  const cancelButton = messageBubble.querySelector(".bubble-cancel");
  const alertButton = getBubbleAlert();

  composer?.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await sendComposerMessage();
    } catch (error) {
      console.error(error);
      getBubbleInput()?.focus();
    }
  });

  cancelButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeBubbleComposer();
  });

  getBubblePrevButton()?.addEventListener("click", (event) => {
    event.stopPropagation();
    showPreviousMessage();
  });

  getBubbleNextButton()?.addEventListener("click", (event) => {
    event.stopPropagation();
    showNextMessage();
  });

  messageBubble.querySelector(".bubble-compose")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openBubbleComposer();
  });

  alertButton?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
}

petImage?.addEventListener("load", refreshMousePassthrough);

// ── Profile & room setup ──────────────────────────────────────

async function ensureProfile() {
  if (!activeSupabase || !selfAuthId) return;
  const { data, error } = await activeSupabase
    .from("profiles")
    .select("id, pet_id")
    .eq("id", selfAuthId)
    .maybeSingle();
  if (error && error.code !== "PGRST116") throw error;
  if (!data) {
    const { error: insertError } = await activeSupabase
      .from("profiles")
      .insert({ id: selfAuthId, display_name: "", pet_id: "default" });
    if (insertError) throw insertError;
  } else {
    selfPetId = data.pet_id || "default";
    setPetStateImage(currentState);
  }
}

async function activateRoom(roomId) {
  currentRoomId = roomId;

  try {
    await fetchSelfMessages();
    await subscribeToSelfMessages();
  } catch (error) {
    console.error(error);
  }

  petStage.classList.remove("is-initializing");
  refreshMousePassthrough();

  await presence.joinRoom(activeSupabase, roomId, selfAuthId, {
    onOnlineUsersChange: applyPetLayout,
  });
}

async function loadCurrentRoom() {
  if (!activeSupabase || !selfAuthId) return;
  const { data: memberships, error } = await activeSupabase
    .from("room_members")
    .select("room_id")
    .limit(1);
  if (error) throw error;
  if (!memberships || memberships.length === 0) {
    petStage.classList.remove("is-initializing");
    refreshMousePassthrough();
    return;
  }
  await activateRoom(memberships[0].room_id);
}

export async function switchRoom(roomId) {
  if (!activeSupabase || !selfAuthId || roomId === currentRoomId) return;
  try {
    await presence.leaveRoom();
    await activateRoom(roomId);
  } catch (error) {
    console.error(error);
  }
}

export function startPetApp({ supabase, session } = {}) {
  activeSupabase = supabase || activeSupabase;
  selfAuthId = session?.user?.id || selfAuthId;

  const doLoad = () =>
    ensureProfile()
      .then(() => loadCurrentRoom())
      .catch((error) => {
        console.error(error);
        petStage.classList.remove("is-initializing");
      });

  if (hasStartedPetApp) {
    doLoad();
    return;
  }

  hasStartedPetApp = true;
  doLoad();
}

window.addEventListener("load", refreshMousePassthrough);
