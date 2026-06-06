import { getSafeState, stateCount } from "./petState.js";
import { isPointOpaqueInImage } from "./hitTesting.js";

const petStage = document.querySelector(".pet-stage");
const cloudHitImage = new Image();
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const dragThreshold = 4;
const alphaHitThreshold = 16;
const alphaHitSlop = 3;
const longPressInterval = 650;
const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

// 固定的显示槽 ID：self 始终对应 user_a（左），remote 对应 user_b（右）
const SELF_ID = "user_a";
const REMOTE_ID = "user_b";
const DEFAULT_PET_STATE = 6;

const petImages = {
  user_a: document.querySelector('.pet-image[data-user="user_a"]'),
  user_b: document.querySelector('.pet-image[data-user="user_b"]')
};
const messageBubbles = {
  user_a: document.querySelector('.message-bubble[data-user="user_a"]'),
  user_b: document.querySelector('.message-bubble[data-user="user_b"]')
};
const petImage = petImages[SELF_ID];
const userStates = { [SELF_ID]: DEFAULT_PET_STATE, [REMOTE_ID]: DEFAULT_PET_STATE };
const lastRemoteMessageIds = {};
const unreadByUser = { [SELF_ID]: false, [REMOTE_ID]: false };
const onlineByUser = { [SELF_ID]: false, [REMOTE_ID]: false };
const messageHistoryByUser = { [SELF_ID]: [], [REMOTE_ID]: [] };
const messageIndexByUser = { [SELF_ID]: -1, [REMOTE_ID]: -1 };
const animatedPetSources = {};

// Auth 和房间状态
let selfAuthId = null;
let remoteAuthId = null;
let currentRoomId = null;
let activeSupabase = null;
let messagesChannel = null;

// UI 状态
let currentState = DEFAULT_PET_STATE;
let pointerStart = null;
let pointerPetUser = null;
let windowStart = null;
let isDragging = false;
let bubblePointerStart = false;
let isIgnoringMouseEvents = false;
let lastPointerEvent = null;
let longPressTimer = null;
let didShowBubbleFromPetLongPress = false;
let hasStartedPetApp = false;

cloudHitImage.src = "/img/cloud_transparent.png";
[SELF_ID, REMOTE_ID].forEach((displayId) => {
  const userPetImage = petImages[displayId];
  const userBubble = messageBubbles[displayId];

  if (userPetImage) {
    setPetStateImage(displayId, DEFAULT_PET_STATE);
  }

  if (userBubble) {
    userBubble.classList.toggle("is-owned", displayId === SELF_ID);
    updateBubbleNav(displayId);
  }
});

function getBubbleTextElement(userId) {
  return messageBubbles[userId]?.querySelector(".bubble-text");
}

function getBubblePrevButton(userId) {
  return messageBubbles[userId]?.querySelector(".bubble-prev");
}

function getBubbleNextButton(userId) {
  return messageBubbles[userId]?.querySelector(".bubble-next");
}

function getBubbleAlert(userId) {
  return messageBubbles[userId]?.querySelector(".message-alert");
}

function getBubbleComposer(userId) {
  return messageBubbles[userId]?.querySelector(".bubble-composer");
}

function getBubbleInput(userId) {
  return messageBubbles[userId]?.querySelector(".bubble-input");
}

function getBubbleStatus(userId) {
  return messageBubbles[userId]?.querySelector(".bubble-status");
}

function setComposerStatus(userId, message) {
  const status = getBubbleStatus(userId);

  if (!status) {
    return;
  }

  status.textContent = message || "";
}

function setBubbleText(userId, text) {
  const textElement = getBubbleTextElement(userId);

  if (textElement) {
    textElement.textContent = text;
  }
}

function normalizeMessage(message, fallbackState = 3) {
  if (!message?.info) {
    return null;
  }

  return {
    id: message.id ?? `${Date.now()}-${Math.random()}`,
    info: message.info,
    state: getSafeState(Number(message.state), fallbackState),
    from: message.from,
    created_at: message.created_at || new Date().toISOString()
  };
}

function sortMessagesByTime(messages) {
  return [...messages].sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime();
    const rightTime = new Date(right.created_at).getTime();
    return leftTime - rightTime;
  });
}

function updateBubbleNav(userId) {
  const history = messageHistoryByUser[userId];
  const currentIndex = messageIndexByUser[userId];
  const prevButton = getBubblePrevButton(userId);
  const nextButton = getBubbleNextButton(userId);

  if (prevButton) {
    prevButton.disabled = currentIndex <= 0;
  }

  if (nextButton) {
    nextButton.disabled = currentIndex < 0 || currentIndex >= history.length - 1;
  }
}

function renderMessageAt(userId, index, { markUnread = false, updatePetState = userId !== SELF_ID } = {}) {
  const history = messageHistoryByUser[userId];
  const message = history[index];
  const targetBubble = messageBubbles[userId];

  if (!message || !targetBubble) {
    updateBubbleNav(userId);
    return;
  }

  messageIndexByUser[userId] = index;
  setBubbleText(userId, message.info);
  targetBubble.hidden = false;
  setUnread(userId, userId !== SELF_ID && markUnread);
  updateBubbleNav(userId);

  if (updatePetState) {
    userStates[userId] = getSafeState(Number(message.state));
    setPetStateImage(userId, userStates[userId]);

    if (userId === SELF_ID) {
      currentState = userStates[userId];
    }
  }

  refreshMousePassthrough();
}

function setLocalMessages(userId, messages, { updatePetState = userId !== SELF_ID } = {}) {
  const normalizedMessages = sortMessagesByTime(
    messages.map((message) => normalizeMessage(message, DEFAULT_PET_STATE)).filter(Boolean)
  );

  messageHistoryByUser[userId] = normalizedMessages;

  if (normalizedMessages.length === 0) {
    messageIndexByUser[userId] = -1;
    setBubbleText(userId, "");
    setUnread(userId, false);
    updateBubbleNav(userId);
    return;
  }

  renderMessageAt(userId, normalizedMessages.length - 1, {
    markUnread: false,
    updatePetState
  });
}

function addLocalMessage(userId, message, { markUnread = false, updatePetState = userId !== SELF_ID } = {}) {
  const normalizedMessage = normalizeMessage(message, userStates[userId]);

  if (!normalizedMessage) {
    return;
  }

  const history = messageHistoryByUser[userId];

  if (history.some((item) => item.id === normalizedMessage.id)) {
    return;
  }

  history.push(normalizedMessage);
  history.sort((left, right) => new Date(left.created_at).getTime() - new Date(right.created_at).getTime());
  renderMessageAt(userId, history.length - 1, { markUnread, updatePetState });
}

function showPreviousMessage(userId) {
  const currentIndex = messageIndexByUser[userId];

  if (currentIndex > 0) {
    renderMessageAt(userId, currentIndex - 1, {
      markUnread: false,
      updatePetState: userId !== SELF_ID
    });
  }
}

function showNextMessage(userId) {
  const currentIndex = messageIndexByUser[userId];
  const history = messageHistoryByUser[userId];

  if (currentIndex >= 0 && currentIndex < history.length - 1) {
    renderMessageAt(userId, currentIndex + 1, {
      markUnread: false,
      updatePetState: userId !== SELF_ID
    });
  }
}

function showMessageBubble(userId) {
  const history = messageHistoryByUser[userId];
  const currentIndex = messageIndexByUser[userId];

  if (history.length === 0) {
    return;
  }

  renderMessageAt(userId, currentIndex >= 0 ? currentIndex : history.length - 1, {
    markUnread: false,
    updatePetState: userId !== SELF_ID
  });
}

function setUnread(userId, hasUnread) {
  const bubble = messageBubbles[userId];

  if (!bubble) {
    return;
  }

  unreadByUser[userId] = hasUnread;
  bubble.classList.toggle("has-unread", hasUnread);
}

function clearUnreadForRemoteUser(userId) {
  if (userId !== SELF_ID && unreadByUser[userId]) {
    setUnread(userId, false);
  }
}

function setUserOnline(userId, isOnline) {
  const targetPetImage = petImages[userId];

  if (!targetPetImage) {
    return;
  }

  const shouldShowOnline = userId === SELF_ID || isOnline;

  onlineByUser[userId] = shouldShowOnline;
  targetPetImage.classList.toggle("is-offline", !shouldShowOnline);

  if (shouldShowOnline) {
    const animatedSource = animatedPetSources[userId] || getStateImagePath(userStates[userId]);

    if (targetPetImage.getAttribute("src") !== animatedSource) {
      targetPetImage.src = animatedSource;
    }
  } else {
    freezePetImage(userId);
  }
}

function getStateImagePath(stateNumber) {
  return `/state_images/state_${String(stateNumber).padStart(2, "0")}.gif`;
}

function isUserOnline(userId) {
  return userId === SELF_ID || onlineByUser[userId];
}

function capturePetStillImage(userId) {
  const targetPetImage = petImages[userId];

  if (!targetPetImage || !targetPetImage.complete || !targetPetImage.naturalWidth || !targetPetImage.naturalHeight) {
    return null;
  }

  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");

  if (!context) {
    return null;
  }

  canvas.width = targetPetImage.naturalWidth;
  canvas.height = targetPetImage.naturalHeight;
  context.drawImage(targetPetImage, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

function freezePetImage(userId) {
  const targetPetImage = petImages[userId];

  if (!targetPetImage || isUserOnline(userId) || targetPetImage.src.startsWith("data:image/")) {
    return;
  }

  const stillImage = capturePetStillImage(userId);

  if (stillImage) {
    targetPetImage.src = stillImage;
    refreshMousePassthrough();
    return;
  }

  targetPetImage.addEventListener(
    "load",
    () => {
      if (!isUserOnline(userId)) {
        freezePetImage(userId);
      }
    },
    { once: true }
  );
}

function setPetStateImage(userId, stateNumber) {
  const targetPetImage = petImages[userId];

  if (!targetPetImage) {
    return;
  }

  const stateImagePath = getStateImagePath(stateNumber);
  animatedPetSources[userId] = stateImagePath;
  targetPetImage.src = stateImagePath;

  if (!isUserOnline(userId)) {
    freezePetImage(userId);
  }
}

function isBubbleVisible() {
  return Object.values(messageBubbles).some((bubble) => bubble && !bubble.hidden);
}

function isComposerVisible() {
  return Object.values(messageBubbles).some((bubble) => bubble?.classList.contains("is-editing"));
}

function showNextState() {
  currentState = currentState === stateCount ? 1 : currentState + 1;
  userStates[SELF_ID] = currentState;
  setPetStateImage(SELF_ID, currentState);
  refreshMousePassthrough();
}

function getPetAt(event) {
  return Object.entries(petImages).find(
    ([, targetPetImage]) =>
      targetPetImage &&
      isPointOpaqueInImage(event, targetPetImage, targetPetImage, hitContext, hitCanvas, {
        respectObjectFit: true,
        alphaThreshold: alphaHitThreshold,
        hitSlop: alphaHitSlop
      })
  );
}

function isPetOpaqueAt(event) {
  return Boolean(getPetAt(event));
}

function getBubbleAt(event) {
  return Object.entries(messageBubbles).find(
    ([, bubble]) =>
      bubble &&
      !bubble.hidden &&
      isPointOpaqueInImage(event, bubble, cloudHitImage, hitContext, hitCanvas, {
        alphaThreshold: alphaHitThreshold,
        hitSlop: alphaHitSlop
      })
  );
}

function isBubbleOpaqueAt(event) {
  return Boolean(getBubbleAt(event));
}

function closeMessageBubble(userId) {
  const targetBubble = messageBubbles[userId];

  if (!targetBubble || targetBubble.hidden) {
    return;
  }

  targetBubble.hidden = true;
  setUnread(userId, false);
  refreshMousePassthrough();
}

// 将数据库消息行转为内部展示格式
function msgToLocal(msg) {
  return {
    id: msg.id,
    info: msg.content,
    state: DEFAULT_PET_STATE,
    from: msg.sender_id,
    created_at: msg.created_at
  };
}

function getDisplayIdForSender(senderId) {
  if (senderId === selfAuthId) return SELF_ID;
  if (senderId === remoteAuthId) return REMOTE_ID;
  return null;
}

function getMessageDisplayUserId(message) {
  return getDisplayIdForSender(message?.from);
}

async function fetchLatestMessagesForDisplayUser(displayId) {
  if (!activeSupabase || !currentRoomId) return;

  const authId = displayId === SELF_ID ? selfAuthId : remoteAuthId;
  if (!authId) return;

  const { data, error } = await activeSupabase
    .from("messages")
    .select("id, content, created_at, sender_id, kind")
    .eq("room_id", currentRoomId)
    .eq("sender_id", authId)
    .order("created_at", { ascending: false })
    .limit(5);

  if (error) {
    throw error;
  }

  setLocalMessages(displayId, (data || []).map(msgToLocal), { updatePetState: true });
}

function handleRemoteMessage(message) {
  if (message?.from === selfAuthId) {
    return;
  }

  const displayUserId = getMessageDisplayUserId(message);

  if (!displayUserId) {
    return;
  }

  if (message.id === lastRemoteMessageIds[displayUserId]) {
    return;
  }

  lastRemoteMessageIds[displayUserId] = message.id;
  addLocalMessage(displayUserId, message, {
    markUnread: displayUserId !== SELF_ID,
    updatePetState: true,
  });
}

async function subscribeToRemoteMessages() {
  if (!activeSupabase || !currentRoomId) return;

  if (messagesChannel) {
    await activeSupabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }

  messagesChannel = activeSupabase
    .channel("room-messages-" + currentRoomId)
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
        filter: `room_id=eq.${currentRoomId}`,
      },
      (payload) => {
        handleRemoteMessage(msgToLocal(payload.new));
      }
    )
    .subscribe((status) => {
      console.log(`Messages channel status: ${status}`);
    });
}

function subscribeToPresence() {
  setUserOnline(SELF_ID, true);
  setUserOnline(REMOTE_ID, false);
}

async function initializeRemoteMessages() {
  try {
    await Promise.all([
      fetchLatestMessagesForDisplayUser(SELF_ID),
      fetchLatestMessagesForDisplayUser(REMOTE_ID),
    ]);
    await subscribeToRemoteMessages();
  } catch (error) {
    console.error(error);
  }

  petStage.classList.remove("is-initializing");
  refreshMousePassthrough();
}

function clearLongPressTimer() {
  window.clearTimeout(longPressTimer);
  longPressTimer = null;
}

function openBubbleComposer(userId) {
  if (userId !== SELF_ID) {
    return;
  }

  const bubble = messageBubbles[userId];
  const composer = getBubbleComposer(userId);
  const input = getBubbleInput(userId);

  if (!bubble || !composer || !input) {
    return;
  }

  bubble.hidden = false;
  bubble.classList.add("is-editing");
  setUnread(userId, false);
  setComposerStatus(userId, "");
  composer.hidden = false;
  input.value = "";
  input.focus();
  refreshMousePassthrough();
}

function closeBubbleComposer(userId) {
  const bubble = messageBubbles[userId];
  const composer = getBubbleComposer(userId);
  const input = getBubbleInput(userId);

  if (!bubble || !composer || !input) {
    return;
  }

  bubble.classList.remove("is-editing");
  composer.hidden = true;
  setComposerStatus(userId, "");
  input.value = "";
  refreshMousePassthrough();
}

async function sendComposerMessage(userId) {
  const input = getBubbleInput(userId);
  const info = input?.value.trim();

  if (!info) {
    setComposerStatus(userId, "请先输入消息");
    input?.focus();
    return;
  }

  if (!activeSupabase || !selfAuthId || !currentRoomId) {
    setComposerStatus(userId, "请先登录");
    input?.focus();
    return;
  }

  setComposerStatus(userId, "正在发送...");

  const { error } = await activeSupabase
    .from("messages")
    .insert({
      room_id: currentRoomId,
      sender_id: selfAuthId,
      kind: "text",
      content: info,
    });

  if (error) {
    setComposerStatus(userId, error.message || "发送失败");
    throw error;
  }

  setComposerStatus(userId, "");
  addLocalMessage(
    userId,
    {
      id: `local-${Date.now()}`,
      info,
      state: DEFAULT_PET_STATE,
      from: selfAuthId,
      created_at: new Date().toISOString(),
    },
    { markUnread: false, updatePetState: true }
  );
  closeBubbleComposer(userId);
}

function isComposerEvent(event) {
  return Boolean(event.target.closest(".bubble-composer"));
}

function isBubbleNavEvent(event) {
  return Boolean(event.target.closest(".bubble-nav"));
}

function isBubbleTextEvent(event) {
  return Boolean(event.target.closest(".bubble-text"));
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

function isAuthPanelVisible() {
  const authPanel = document.querySelector(".auth-panel");
  return Boolean(authPanel && !authPanel.hidden);
}

function isInteractiveAt(event) {
  if (isAuthPanelVisible()) {
    return true;
  }

  if (isComposerVisible() && event.target.closest(".message-bubble")) {
    return true;
  }

  const currentUserBubble = messageBubbles[SELF_ID];

  if (currentUserBubble && !currentUserBubble.hidden && isPointInsideElement(event, currentUserBubble)) {
    return true;
  }

  if (isBubbleVisible() && isBubbleOpaqueAt(event)) {
    return true;
  }

  return isPetOpaqueAt(event);
}

function setMousePassthrough(shouldPassThrough) {
  if (isIgnoringMouseEvents === shouldPassThrough) {
    return;
  }

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
  if (isAuthPanelVisible()) {
    setMousePassthrough(false);
    return;
  }

  if (!pointerStart && !bubblePointerStart) {
    setMousePassthrough(true);
  }
});

// 原生光标流：把 Rust 推送的窗口 client 坐标转成合成事件，复用既有的像素级命中判定。
window.goodPuppy.onCursorMoved((point) => {
  if (!point) return;
  const target = document.elementFromPoint(point.x, point.y) || document.body;
  updateMousePassthrough({ clientX: point.x, clientY: point.y, target });
});

petStage.addEventListener("pointerdown", async (event) => {
  setMousePassthrough(false);

  if (event.button !== 0) {
    return;
  }

  if (isComposerEvent(event)) {
    return;
  }

  if (isBubbleNavEvent(event)) {
    return;
  }

  if (isBubbleTextEvent(event)) {
    return;
  }

  const bubbleEntry = getBubbleAt(event);

  if (bubbleEntry) {
    bubblePointerStart = true;
    pointerStart = null;
    pointerPetUser = null;
    windowStart = null;
    isDragging = false;
    const [userId] = bubbleEntry;
    clearUnreadForRemoteUser(userId);

    return;
  }

  const petEntry = getPetAt(event);

  if (!petEntry) {
    return;
  }

  const [userId] = petEntry;
  clearUnreadForRemoteUser(userId);
  pointerStart = {
    x: event.screenX,
    y: event.screenY
  };
  pointerPetUser = userId;
  windowStart = await window.goodPuppy.getWindowPosition();
  isDragging = false;

  clearLongPressTimer();
  longPressTimer = window.setTimeout(() => {
    if (!pointerStart || isDragging) {
      return;
    }

    didShowBubbleFromPetLongPress = true;

    // 空历史时，长按自己的小狗直接进输入框（否则气泡因 history 为空永不弹出）
    if (userId === SELF_ID && messageHistoryByUser[userId].length === 0) {
      openBubbleComposer(userId);
    } else {
      showMessageBubble(userId);
    }
  }, longPressInterval);

  petStage.setPointerCapture(event.pointerId);
});

petStage.addEventListener("contextmenu", (event) => {
  if (isComposerEvent(event) || isBubbleNavEvent(event) || isBubbleTextEvent(event)) {
    return;
  }

  event.preventDefault();

  if (getBubbleAt(event)) {
    return;
  }

  if (!isPetOpaqueAt(event)) {
    return;
  }
});

petStage.addEventListener("pointermove", (event) => {
  updateMousePassthrough(event);

  if (!pointerStart || !windowStart) {
    return;
  }

  const deltaX = event.screenX - pointerStart.x;
  const deltaY = event.screenY - pointerStart.y;

  if (!isDragging && Math.hypot(deltaX, deltaY) >= dragThreshold) {
    isDragging = true;
    clearLongPressTimer();

    if (supportsNativeWindowDrag) {
      // 交给系统原生拖拽：窗口在设备坐标里与光标锁步，跨屏/跨 DPI 都不会闪烁或错位。
      if (petStage.hasPointerCapture(event.pointerId)) {
        petStage.releasePointerCapture(event.pointerId);
      }

      window.goodPuppy.startWindowDrag();

      pointerStart = null;
      windowStart = null;
      return;
    }
  }

  // 回退路径（无原生拖拽的平台）：手动让窗口跟随光标。
  if (isDragging) {
    window.goodPuppy.setWindowPosition({
      x: windowStart.x + deltaX,
      y: windowStart.y + deltaY
    });
  }
});

petStage.addEventListener("pointerup", (event) => {
  if (isBubbleNavEvent(event)) {
    return;
  }

  if (isComposerEvent(event)) {
    return;
  }

  if (bubblePointerStart) {
    const bubbleEntry = getBubbleAt(event);

    if (event.button === 0 && bubbleEntry) {
      const [userId] = bubbleEntry;

      if (messageBubbles[userId]?.classList.contains("is-editing")) {
        bubblePointerStart = false;
        return;
      }

      closeMessageBubble(userId);
    }

    bubblePointerStart = false;
    return;
  }

  clearLongPressTimer();

  if (didShowBubbleFromPetLongPress) {
    didShowBubbleFromPetLongPress = false;
    pointerStart = null;
    pointerPetUser = null;
    windowStart = null;
    isDragging = false;
    return;
  }

  if (pointerStart && pointerPetUser === SELF_ID && !isDragging) {
    showNextState();
  }

  pointerStart = null;
  pointerPetUser = null;
  windowStart = null;
  isDragging = false;

  if (petStage.hasPointerCapture(event.pointerId)) {
    petStage.releasePointerCapture(event.pointerId);
  }

  updateMousePassthrough(event);
});

petStage.addEventListener("pointercancel", () => {
  clearLongPressTimer();
  pointerStart = null;
  pointerPetUser = null;
  windowStart = null;
  isDragging = false;
  bubblePointerStart = false;
  didShowBubbleFromPetLongPress = false;
});

petImage.addEventListener("load", refreshMousePassthrough);

Object.entries(messageBubbles).forEach(([userId, bubble]) => {
  const composer = getBubbleComposer(userId);
  const cancelButton = bubble?.querySelector(".bubble-cancel");
  const prevButton = getBubblePrevButton(userId);
  const nextButton = getBubbleNextButton(userId);
  const alertButton = getBubbleAlert(userId);

  composer?.addEventListener("submit", async (event) => {
    event.preventDefault();
    event.stopPropagation();

    try {
      await sendComposerMessage(userId);
    } catch (error) {
      console.error(error);
      getBubbleInput(userId)?.focus();
    }
  });

  cancelButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    closeBubbleComposer(userId);
  });

  prevButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    showPreviousMessage(userId);
  });

  nextButton?.addEventListener("click", (event) => {
    event.stopPropagation();
    showNextMessage(userId);
  });

  bubble?.querySelector(".bubble-compose")?.addEventListener("click", (event) => {
    event.stopPropagation();
    openBubbleComposer(userId);
  });

  alertButton?.addEventListener("click", (event) => {
    event.stopPropagation();
  });
});

// 确保当前用户有 profile（首次登录时自动创建）
async function ensureProfile() {
  if (!activeSupabase || !selfAuthId) return;

  const { data, error } = await activeSupabase
    .from("profiles")
    .select("id")
    .eq("id", selfAuthId)
    .maybeSingle();

  if (error && error.code !== "PGRST116") throw error;

  if (!data) {
    const { error: insertError } = await activeSupabase
      .from("profiles")
      .insert({ id: selfAuthId, display_name: "" });
    if (insertError) throw insertError;
  }
}

// 激活指定房间（拉远端成员 + 初始化消息订阅）
async function activateRoom(roomId) {
  currentRoomId = roomId;

  const { data: members, error: membersError } = await activeSupabase
    .from("room_members")
    .select("user_id")
    .eq("room_id", currentRoomId)
    .neq("user_id", selfAuthId);

  if (membersError) throw membersError;

  remoteAuthId = members && members.length > 0 ? members[0].user_id : null;

  await initializeRemoteMessages();
}

// 加载用户的第一个房间，确定 remoteAuthId
async function loadCurrentRoom() {
  if (!activeSupabase || !selfAuthId) return;

  const { data: memberships, error } = await activeSupabase
    .from("room_members")
    .select("room_id")
    .limit(1);

  if (error) throw error;

  if (!memberships || memberships.length === 0) {
    // 还没有房间，移除初始化状态（connect panel 将引导用户建立连接）
    petStage.classList.remove("is-initializing");
    refreshMousePassthrough();
    return;
  }

  await activateRoom(memberships[0].room_id);
}

// 切换活跃房间（由 connect panel 的"进入此房间"触发）
export async function switchRoom(roomId) {
  if (!activeSupabase || !selfAuthId || roomId === currentRoomId) return;
  try {
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
  subscribeToPresence();
  doLoad();
}

window.addEventListener("load", refreshMousePassthrough);
