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
const appConfig = window.goodPuppy.getAppConfig();
const currentUserConfig = appConfig.userConfigs[appConfig.currentUser];
const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

if (!currentUserConfig) {
  throw new Error(`Unknown current user: ${appConfig.currentUser}`);
}
const petImages = {
  user_a: document.querySelector('.pet-image[data-user="user_a"]'),
  user_b: document.querySelector('.pet-image[data-user="user_b"]')
};
const messageBubbles = {
  user_a: document.querySelector('.message-bubble[data-user="user_a"]'),
  user_b: document.querySelector('.message-bubble[data-user="user_b"]')
};
const petImage = petImages[appConfig.currentUser];
const userStates = Object.fromEntries(
  Object.entries(appConfig.userConfigs).map(([userId, userConfig]) => [userId, userConfig.initialState])
);
const lastRemoteMessageIds = {};
const unreadByUser = Object.fromEntries(Object.keys(appConfig.userConfigs).map((userId) => [userId, false]));
const onlineByUser = Object.fromEntries(Object.keys(appConfig.userConfigs).map((userId) => [userId, false]));
const messageHistoryByUser = Object.fromEntries(Object.keys(appConfig.userConfigs).map((userId) => [userId, []]));
const messageIndexByUser = Object.fromEntries(Object.keys(appConfig.userConfigs).map((userId) => [userId, -1]));
const animatedPetSources = {};
const remoteUserId = Object.keys(appConfig.userConfigs).find((userId) => userId !== appConfig.currentUser);
let currentState = currentUserConfig.initialState;
let activeSupabase = null;
let currentAuthUserId = null;
let messagesChannel = null;
let pointerStart = null;
let pointerPetUser = null;
let windowStart = null;
let isDragging = false;
let bubblePointerStart = false;
let isIgnoringMouseEvents = false;
let lastPointerEvent = null;
let longPressTimer = null;
let didShowBubbleFromPetLongPress = false;

cloudHitImage.src = "/img/cloud_transparent.png";
Object.entries(appConfig.userConfigs).forEach(([userId, userConfig]) => {
  const userPetImage = petImages[userId];
  const userBubble = messageBubbles[userId];

  if (userPetImage) {
    setPetStateImage(userId, userConfig.initialState);
  }

  if (userBubble) {
    userBubble.classList.toggle("is-owned", userId === appConfig.currentUser);
    updateBubbleNav(userId);
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

function renderMessageAt(userId, index, { markUnread = false, updatePetState = userId !== appConfig.currentUser } = {}) {
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
  setUnread(userId, userId !== appConfig.currentUser && markUnread);
  updateBubbleNav(userId);

  if (updatePetState) {
    userStates[userId] = getSafeState(Number(message.state));
    setPetStateImage(userId, userStates[userId]);

    if (userId === appConfig.currentUser) {
      currentState = userStates[userId];
    }
  }

  refreshMousePassthrough();
}

function setLocalMessages(userId, messages, { updatePetState = userId !== appConfig.currentUser } = {}) {
  const normalizedMessages = sortMessagesByTime(
    messages.map((message) => normalizeMessage(message, appConfig.userConfigs[userId]?.initialState)).filter(Boolean)
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

function addLocalMessage(userId, message, { markUnread = false, updatePetState = userId !== appConfig.currentUser } = {}) {
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
      updatePetState: userId !== appConfig.currentUser
    });
  }
}

function showNextMessage(userId) {
  const currentIndex = messageIndexByUser[userId];
  const history = messageHistoryByUser[userId];

  if (currentIndex >= 0 && currentIndex < history.length - 1) {
    renderMessageAt(userId, currentIndex + 1, {
      markUnread: false,
      updatePetState: userId !== appConfig.currentUser
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
    updatePetState: userId !== appConfig.currentUser
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
  if (userId !== appConfig.currentUser && unreadByUser[userId]) {
    setUnread(userId, false);
  }
}

function setUserOnline(userId, isOnline) {
  const targetPetImage = petImages[userId];

  if (!targetPetImage) {
    return;
  }

  const shouldShowOnline = userId === appConfig.currentUser || isOnline;

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
  return userId === appConfig.currentUser || onlineByUser[userId];
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
  userStates[appConfig.currentUser] = currentState;
  setPetStateImage(appConfig.currentUser, currentState);
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

function getMessageDisplayUserId(message) {
  return message?.from === currentAuthUserId ? appConfig.currentUser : remoteUserId;
}

function getSupabaseMessageSelect() {
  return "id,info,state,created_at,from";
}

async function fetchLatestMessagesForDisplayUser(userId) {
  if (!activeSupabase || !currentAuthUserId) {
    return;
  }

  let query = activeSupabase
    .from("messages")
    .select(getSupabaseMessageSelect())
    .order("created_at", { ascending: false })
    .limit(5);

  if (userId === appConfig.currentUser) {
    query = query.eq("from", currentAuthUserId);
  } else {
    query = query.neq("from", currentAuthUserId);
  }

  const { data, error } = await query;

  if (error) {
    throw error;
  }

  setLocalMessages(userId, data || [], {
    updatePetState: true,
  });
}

function handleRemoteMessage(message) {
  if (message?.from === currentAuthUserId) {
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
    markUnread: displayUserId !== appConfig.currentUser,
    updatePetState: true,
  });
}

async function subscribeToRemoteMessages() {
  if (!activeSupabase || !currentAuthUserId) {
    return;
  }

  if (messagesChannel) {
    await activeSupabase.removeChannel(messagesChannel);
    messagesChannel = null;
  }

  messagesChannel = activeSupabase
    .channel("good-puppy-messages-inserts")
    .on(
      "postgres_changes",
      {
        event: "INSERT",
        schema: "public",
        table: "messages",
      },
      (payload) => {
        handleRemoteMessage(payload.new);
      }
    )
    .subscribe((status) => {
      console.log(`Supabase Realtime messages status: ${status}`);
    });
}

function subscribeToPresence() {
  Object.keys(appConfig.userConfigs).forEach((userId) => {
    setUserOnline(userId, userId === appConfig.currentUser);
  });
}

async function initializeRemoteMessages() {
  try {
    await Promise.all(
      Object.keys(appConfig.userConfigs).map((userId) => fetchLatestMessagesForDisplayUser(userId))
    );
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
  if (userId !== appConfig.currentUser) {
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
    setComposerStatus(userId, "\u8bf7\u5148\u8f93\u5165\u6d88\u606f");
    input?.focus();
    return;
  }

  if (!activeSupabase || !currentAuthUserId) {
    setComposerStatus(userId, "\u8bf7\u5148\u767b\u5f55");
    input?.focus();
    return;
  }

  setComposerStatus(userId, "\u6b63\u5728\u53d1\u9001...");

  const { error } = await activeSupabase
    .from("messages")
    .insert({
      info,
      state: currentState,
      from: currentAuthUserId,
    });

  if (error) {
    setComposerStatus(userId, error.message || "\u53d1\u9001\u5931\u8d25");
    throw error;
  }

  setComposerStatus(userId, "");
  addLocalMessage(
    userId,
    {
      id: `local-${Date.now()}`,
      info,
      state: currentState,
      from: currentAuthUserId,
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

  const currentUserBubble = messageBubbles[appConfig.currentUser];

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
// 这是窗口失焦后仍能重新捕获鼠标（恢复点击/拖拽/聚焦）的关键来源。
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
    if (userId === appConfig.currentUser && messageHistoryByUser[userId].length === 0) {
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
      // 必须先释放指针捕获，否则 webview 占着鼠标会话，macOS 无法接管拖拽。
      if (petStage.hasPointerCapture(event.pointerId)) {
        petStage.releasePointerCapture(event.pointerId);
      }

      window.goodPuppy.startWindowDrag();

      // 原生拖拽会吞掉本次手势剩余事件（含 pointerup），本地不再跟踪；
      // 状态在下一次 pointerdown 时重置。
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

  if (pointerStart && pointerPetUser === appConfig.currentUser && !isDragging) {
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

let hasStartedPetApp = false;

export function startPetApp({ supabase, session } = {}) {
  activeSupabase = supabase || activeSupabase;
  currentAuthUserId = session?.user?.id || currentAuthUserId;

  if (hasStartedPetApp) {
    initializeRemoteMessages();
    return;
  }

  hasStartedPetApp = true;
  subscribeToPresence();
  initializeRemoteMessages();
}

window.addEventListener("load", refreshMousePassthrough);
