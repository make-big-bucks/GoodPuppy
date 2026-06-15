import { PetAnimator } from "./petState.js";
import {
  loadPetManifest,
  durationFromManifest,
  INTERACTIONS,
  STATUS_OPTIONS,
  DEFAULT_SKIN,
} from "./animationCatalog.js";
import { isPointOpaqueInImage } from "./hitTesting.js";
import * as presence from "./presence.js";
import { joinInteractions, leaveInteractions, sendInteraction } from "./interactions.js";
import {
  getPetWindowLayout,
  orderRemotePetIds,
  clampPetScale,
  stepPetScale,
  DEFAULT_PET_SCALE,
  MIN_PET_SCALE,
  MAX_PET_SCALE,
} from "./petLayout.js";
import {
  readStoredSkin,
  writeStoredSkin,
  readStoredScale,
  writeStoredScale,
} from "./preferences.js";
import {
  buildMessageList,
  insertMessage,
  canShowPrevious,
  canShowNext,
} from "./messageLog.js";
import { Menu, Submenu, MenuItem, CheckMenuItem } from "@tauri-apps/api/menu";
import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type { Session } from "@supabase/supabase-js";
import type { InteractionPayload, LocalMessage, PetManifest, PetStatus, PresenceUser, WindowPoint } from "../../types";

type PointerPoint = { x: number; y: number };
type HoverEventLike = { clientX: number; clientY: number; target: EventTarget | null };

type RemotePetEntry = {
  element: HTMLElement;
  animator: PetAnimator;
  leaving: boolean;
  removeTimer: ReturnType<typeof setTimeout> | null;
};

type StateMeta = { mirrored?: boolean };

type InteractionDef = (typeof INTERACTIONS)[keyof typeof INTERACTIONS];
type InteractionDefWithExtras = InteractionDef & { mirror?: string; holdMs?: number };

type MessageInsert = {
  id: string;
  content: string;
  sender_id: string;
  created_at: string;
  kind?: string;
};

type StartPetAppOptions = {
  supabase?: SupabaseClient;
  session?: Session | null;
};

function targetElement(target: EventTarget | null) {
  return target instanceof Element ? target : null;
}

function closestFromEvent<T extends Element>(event: { target: EventTarget | null }, selector: string) {
  return targetElement(event.target)?.closest(selector) as T | null;
}

function getInteractionDef(action: string): InteractionDef | null {
  return action in INTERACTIONS ? INTERACTIONS[action as keyof typeof INTERACTIONS] : null;
}

const petStage = document.querySelector<HTMLElement>(".pet-stage");
const cloudHitImage = new Image();
const hitCanvas = document.createElement("canvas");
const hitContext = hitCanvas.getContext("2d", { willReadFrequently: true });
const alphaHitThreshold = 16;
const alphaHitSlop = 3;
const supportsNativeWindowDrag = window.goodPuppy.supportsNativeWindowDrag();

const SELF_ID = "self";

const petImage = document.querySelector<HTMLImageElement>('.pet-image[data-user="self"]');
const messageBubble = document.querySelector<HTMLElement>('.message-bubble[data-user="self"]');
const selfArea = document.querySelector<HTMLElement>('.dog-area[data-user="self"]');

messageBubble?.classList.add("is-owned");

let selfPetId = "default";
// 换肤 / 尺寸：纯本地偏好，读写见 preferences.js（不进 Supabase，避免 schema 变更）。
// 换肤进房后通过 presence 广播给房间里其他人；尺寸用 CSS --pet-scale 缩放视觉、
// 用窗口尺寸跟随（见 relayoutRemotePets）。
let selfSkin = readStoredSkin();
let petScale = readStoredScale();
let selfAuthId: string | null = null;
let currentRoomId: string | null = null;
let activeSupabase: SupabaseClient | null = null;
let messagesChannel: RealtimeChannel | null = null;

// userId -> { element, animator, leaving, removeTimer }
const remotePets = new Map<string, RemotePetEntry>();

const messageHistory: LocalMessage[] = [];
let messageIndex = -1;
let isUnread = false;
let pointerStart: PointerPoint | null = null;
let windowStart: WindowPoint | null = null;
let isDragging = false;
let bubblePointerStart = false;
let isIgnoringMouseEvents = false;
let lastPointerEvent: HoverEventLike | null = null;
let hasStartedPetApp = false;
let dragLiftTimer: ReturnType<typeof setTimeout> | null = null;

// onState 统一回调：换帧图 + 同步镜像朝向（如双向贴贴需要面对面）。
function applyStateToImage(img: HTMLImageElement | null, path: string, meta: StateMeta) {
  if (!img) return;
  img.src = path;
  img.classList.toggle("is-mirrored", Boolean(meta?.mirrored));
}

// ── Self pet animator ─────────────────────────────────────────

function applyPetScale() {
  document.documentElement.style.setProperty("--pet-scale", String(petScale));
}

function setPetScale(next: number | string | null | undefined) {
  const clamped = clampPetScale(next);
  if (clamped === petScale) return;
  petScale = clamped;
  applyPetScale();
  writeStoredScale(petScale);
  // 窗口尺寸跟随缩放重排，并刷新命中区域。
  relayoutRemotePets();
}

const selfAnimator = new PetAnimator({
  petId: selfPetId,
  skin: selfSkin,
  onState: (_state, path, meta) => applyStateToImage(petImage, path, meta),
});

// 形象清单就绪后立刻播 enter——这是自己 pet 出现在屏幕上的第一个动作（从门中走出）。
// 不依赖登录 / 房间：房间激活有多次网络往返，挂在其后会先看到 idle、过会儿才 enter。
// 等 manifest 到位再播，是为了拿到正确的 enter 时长（兜底 900ms 会截断 1180ms 的 enter）。
loadPetManifest(selfPetId).then((manifest) => {
  selfAnimator.setManifest(manifest);
  selfAnimator.playTransient("enter");
});

cloudHitImage.src = "/img/cloud_transparent.png";
applyPetScale();
selfArea?.style.setProperty("--pet-index", "0");
updateBubbleNav();

// 自己的桌宠应在窗口出现的第一时间就开始待机呼吸，不依赖登录 / 房间。
// 房间激活只负责追加远程 pet，不再作为自己 pet 的可见性前提。
petStage?.classList.remove("is-initializing");

function animatorForUser(userId: string) {
  if (userId === selfAuthId || userId === SELF_ID) return selfAnimator;
  return remotePets.get(userId)?.animator || null;
}

// ── Remote pet layout ────────────────────────────────────────

function getDogAreaForEvent(event: { target: EventTarget | null }) {
  return closestFromEvent<HTMLElement>(event, ".dog-area");
}

function getPetIdentityForEvent(event: { target: EventTarget | null }) {
  const area = getDogAreaForEvent(event);
  if (!area) return { kind: "self", id: SELF_ID };
  if (area.dataset.user === "remote" && area.dataset.userId) return { kind: "remote", id: area.dataset.userId };
  return { kind: "self", id: SELF_ID };
}

function createRemotePetElement(userId: string) {
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
    <img class="pet-image" data-user="remote" alt="Remote puppy" draggable="false" />
  `;
  const img = section.querySelector<HTMLImageElement>(".pet-image");
  img?.addEventListener("load", refreshMousePassthrough);
  petStage?.appendChild(section);
  return section;
}

function relayoutRemotePets() {
  const ids = orderRemotePetIds([...remotePets.keys()]);
  ids.forEach((userId, index) => {
    remotePets.get(userId)?.element.style.setProperty("--pet-index", String(index + 1));
  });
  selfArea?.style.setProperty("--pet-index", "0");
  window.goodPuppy.setWindowSize(getPetWindowLayout(ids.length, petScale));
  refreshMousePassthrough();
}

function clearRemotePets() {
  for (const entry of remotePets.values()) {
    if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
    entry.animator.destroy();
    entry.element.remove();
  }
  remotePets.clear();
  relayoutRemotePets();
}

function createRemotePet(userId: string, info: PresenceUser) {
  const element = createRemotePetElement(userId);
  const img = element.querySelector<HTMLImageElement>(".pet-image");
  const animator = new PetAnimator({
    petId: info.petId,
    skin: info.skin,
    onState: (_state, path, meta) => applyStateToImage(img, path, meta),
  });
  loadPetManifest(info.petId).then((manifest) => animator.setManifest(manifest));
  const entry = { element, animator, leaving: false, removeTimer: null };
  remotePets.set(userId, entry);
  return entry;
}

// presence 回调：users = [{ userId, status, petId }]
function applyPresence(users: PresenceUser[]) {
  const byId = new Map(users.map((u) => [u.userId, u]));
  const onlineSet = new Set(byId.keys());

  // 离开：在线列表中消失且尚未在离场动画中的 pet 播 leave（走入门中消失）后移除。
  for (const [userId, entry] of remotePets) {
    if (onlineSet.has(userId) || entry.leaving) continue;
    entry.leaving = true;
    entry.animator.playTransient("leave");
    const ms = durationFromManifest(entry.animator.manifest?.states?.["leave"]);
    entry.removeTimer = setTimeout(() => {
      entry.animator.destroy();
      entry.element.remove();
      remotePets.delete(userId);
      relayoutRemotePets();
    }, ms);
  }

  // 进入 / 更新。
  for (const userId of onlineSet) {
    const info = byId.get(userId);
    if (!info) continue;
    let entry = remotePets.get(userId);
    if (!entry) {
      entry = createRemotePet(userId, info);
      entry.animator.playTransient("enter"); // 从门中走出
      selfAnimator.playTransient("greet"); // 我向新来的打招呼
    } else if (entry.leaving) {
      // 离场途中又回来：取消移除。
      entry.leaving = false;
      if (entry.removeTimer != null) {
        clearTimeout(entry.removeTimer);
        entry.removeTimer = null;
      }
    }
    entry.animator.setPetId(info.petId);
    entry.animator.setSkin(info.skin);
    entry.animator.setStatus(info.status);
  }

  relayoutRemotePets();
}

// ── Cross-user interactions ───────────────────────────────────

// pet 在本端布局中的横向序号：self 固定 0，远端按布局顺序 1..n。
function petLayoutIndex(userId: string) {
  if (userId === selfAuthId || userId === SELF_ID) return 0;
  const index = orderRemotePetIds([...remotePets.keys()]).indexOf(userId);
  return index === -1 ? null : index + 1;
}

// 双角色互动：发起者与被作用者各播自己的动画。
// mirror:"facing" 时基准 GIF 朝右贴，对方在本端布局左侧的一方做镜像——
// 镜像按「本端布局中的相对方位」而非 actor/target 角色判定，保证每个端
// （包括旁观者）看到的双方都是面对面。
function applyInteraction({ action, actorId, targetId }: InteractionPayload) {
  const def = getInteractionDef(action);
  if (!def) return;
  playInteractionRole(def, def.actorState, actorId, targetId);
  playInteractionRole(def, def.targetState, targetId, actorId);
}

function playInteractionRole(def: InteractionDefWithExtras, state: string, userId: string, partnerId: string) {
  if (!state) return;
  const animator = animatorForUser(userId);
  if (!animator) return;
  let mirrored = false;
  if (def.mirror === "facing") {
    const ownIndex = petLayoutIndex(userId);
    const partnerIndex = petLayoutIndex(partnerId);
    mirrored = ownIndex != null && partnerIndex != null && partnerIndex < ownIndex;
  }
  animator.playTransient(state, { durationMs: def.holdMs, mirrored });
}

function triggerInteraction(action: keyof typeof INTERACTIONS, targetId: string) {
  if (!getInteractionDef(action) || !selfAuthId) return;
  const payload = { action, actorId: selfAuthId, targetId };
  sendInteraction(payload);
  applyInteraction(payload); // 本地立即播（broadcast self:false 不回环）
}

// ── Persistent status (emotion / work) ───────────────────────

function setSelfStatus(status: PetStatus) {
  selfAnimator.setStatus(status);
  presence.updateLocalPresence({ status }).catch(console.error);
}

// ── Skin (换肤) ───────────────────────────────────────────────

function setSelfSkin(skin: string | null | undefined) {
  const next = skin || DEFAULT_SKIN;
  if (next === selfSkin) return;
  selfSkin = next;
  selfAnimator.setSkin(next);
  writeStoredSkin(next);
  presence.updateLocalPresence({ skin: next }).catch(console.error);
}

// ── Message bubble ────────────────────────────────────────────

function getBubbleTextElement() {
  return messageBubble?.querySelector<HTMLElement>(".bubble-text");
}

function getBubblePrevButton() {
  return messageBubble?.querySelector<HTMLButtonElement>(".bubble-prev");
}

function getBubbleNextButton() {
  return messageBubble?.querySelector<HTMLButtonElement>(".bubble-next");
}

function getBubbleAlert() {
  return messageBubble?.querySelector<HTMLElement>(".message-alert");
}

function getBubbleComposer() {
  return messageBubble?.querySelector<HTMLFormElement>(".bubble-composer");
}

function getBubbleInput() {
  return messageBubble?.querySelector<HTMLTextAreaElement>(".bubble-input");
}

function getBubbleStatus() {
  return messageBubble?.querySelector<HTMLElement>(".bubble-status");
}

function setComposerStatus(message: string) {
  const status = getBubbleStatus();
  if (status) status.textContent = message || "";
}

function setBubbleText(text: string) {
  const el = getBubbleTextElement();
  if (el) el.textContent = text;
}

function updateBubbleNav() {
  const prev = getBubblePrevButton();
  const next = getBubbleNextButton();
  if (prev) prev.disabled = !canShowPrevious(messageIndex);
  if (next) next.disabled = !canShowNext(messageIndex, messageHistory.length);
}

function renderMessageAt(index: number, { markUnread = false }: { markUnread?: boolean } = {}) {
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

function setLocalMessages(messages: Array<Partial<LocalMessage> | null | undefined>) {
  const normalized = buildMessageList(messages);
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

function addLocalMessage(message: Partial<LocalMessage> | null | undefined, { markUnread = false }: { markUnread?: boolean } = {}) {
  const { messages, normalized } = insertMessage(messageHistory, message);
  if (!normalized) return;
  messageHistory.length = 0;
  messageHistory.push(...messages);
  renderMessageAt(messageHistory.length - 1, { markUnread });
}

function setUnread(hasUnread: boolean) {
  isUnread = hasUnread;
  messageBubble?.classList.toggle("has-unread", hasUnread);
}

function showPreviousMessage() {
  if (canShowPrevious(messageIndex)) renderMessageAt(messageIndex - 1);
}

function showNextMessage() {
  if (canShowNext(messageIndex, messageHistory.length)) renderMessageAt(messageIndex + 1);
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
  selfAnimator.playTransient("message"); // 发消息手势
  addLocalMessage(
    {
      id: `local-${Date.now()}`,
      info,
      from: selfAuthId,
      created_at: new Date().toISOString(),
    },
    { markUnread: false }
  );
  closeBubbleComposer();
}

// ── Messages (self) ───────────────────────────────────────────

function msgToLocal(msg: MessageInsert): LocalMessage {
  return {
    id: msg.id,
    info: msg.content,
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
    .eq("kind", "text")
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
        if (payload.new?.kind !== "text") return;
        const msg = msgToLocal(payload.new as MessageInsert);
        if (msg.from === selfAuthId) {
          addLocalMessage(msg, { markUnread: false });
        }
      }
    )
    .subscribe();
}

// ── Hit testing & mouse passthrough ──────────────────────────

function isPetOpaqueAt(event: HoverEventLike) {
  const image = closestFromEvent<HTMLImageElement>(event, ".pet-image");
  if (!image) return false;
  return isPointOpaqueInImage(event, image, image, hitContext, hitCanvas, {
    respectObjectFit: true,
    alphaThreshold: alphaHitThreshold,
    hitSlop: alphaHitSlop,
  });
}

function isBubbleOpaqueAt(event: HoverEventLike) {
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

function isPointInsideElement(event: HoverEventLike, element: HTMLElement) {
  const rect = element.getBoundingClientRect();
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  );
}

function getBubbleForPoint(event: HoverEventLike) {
  const targetBubble = closestFromEvent<HTMLElement>(event, ".message-bubble");
  if (targetBubble && !targetBubble.hidden && isPointInsideElement(event, targetBubble)) {
    return targetBubble;
  }

  return (
    [...document.querySelectorAll<HTMLElement>(".message-bubble:not([hidden])")].find((bubble) =>
      isPointInsideElement(event, bubble)
    ) || null
  );
}

function isBubbleControlAt(event: HoverEventLike) {
  const bubble = getBubbleForPoint(event);
  if (!bubble) return false;
  return [...bubble.querySelectorAll<HTMLElement>("button, textarea, input")].some((control) =>
    isPointInsideElement(event, control)
  );
}

function isInteractiveAt(event: HoverEventLike) {
  const bubble = getBubbleForPoint(event);
  if (isBubbleControlAt(event)) return true;
  if (isComposerVisible() && bubble) return true;
  if (bubble) return true;
  if (isBubbleVisible() && isBubbleOpaqueAt(event)) return true;
  return isPetOpaqueAt(event);
}

function setMousePassthrough(shouldPassThrough: boolean) {
  if (isIgnoringMouseEvents === shouldPassThrough) return;
  isIgnoringMouseEvents = shouldPassThrough;
  window.goodPuppy.setIgnoreMouseEvents(shouldPassThrough);
}

function updateMousePassthrough(event: HoverEventLike) {
  lastPointerEvent = event;
  if (pointerStart || bubblePointerStart) {
    setMousePassthrough(false);
    return;
  }
  setMousePassthrough(!isInteractiveAt(event));
}

function refreshMousePassthrough() {
  if (lastPointerEvent) {
    const event = lastPointerEvent;
    window.requestAnimationFrame(() => updateMousePassthrough(event));
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

// ── Drag-lift (按住型瞬时动画：被拎起，方向无关) ──────────────

function startDragLift() {
  selfAnimator.setHeld("drag-lift");
  // 原生窗口拖动可能吞掉 pointerup，加安全超时兜底清除。
  if (dragLiftTimer != null) clearTimeout(dragLiftTimer);
  dragLiftTimer = setTimeout(stopDragLift, 4000);
}

function stopDragLift() {
  if (dragLiftTimer != null) {
    clearTimeout(dragLiftTimer);
    dragLiftTimer = null;
  }
  selfAnimator.setHeld(null);
}

// ── Pointer events ────────────────────────────────────────────

function showRemoteBubble(userId: string) {
  const element = remotePets.get(userId)?.element;
  const bubble = element?.querySelector<HTMLElement>(".message-bubble");
  const text = bubble?.querySelector<HTMLElement>(".bubble-text");
  if (!bubble || !text) return;
  text.textContent = "在线";
  bubble.hidden = false;
  refreshMousePassthrough();
}

// 「换肤」子菜单：选项来自 self pet 的 manifest.skins（pet.json 声明），
// 加一个「原色」回到 default。当前所选打勾。无皮肤声明时返回 null（不显示该项）。
async function buildSkinSubmenu() {
  const skins = selfAnimator.manifest?.skins || [];
  if (skins.length === 0) return null;
  const options = [{ id: DEFAULT_SKIN, label: "原色" }, ...skins];
  const items = await Promise.all(
    options.map((opt) =>
      CheckMenuItem.new({
        id: `skin-${opt.id}`,
        text: opt.label,
        checked: selfSkin === opt.id,
        action: () => setSelfSkin(opt.id),
      })
    )
  );
  return Submenu.new({ text: "换肤", items });
}

// 「大小」子菜单：像调字号一样按步长放大/缩小，到边界时对应项禁用；
// 非默认大小时提供「恢复默认」。所选大小持久化在 localStorage。
async function buildSizeSubmenu() {
  const items = await Promise.all([
    MenuItem.new({
      id: "size-up",
      text: "放大",
      enabled: petScale < MAX_PET_SCALE,
      action: () => setPetScale(stepPetScale(petScale, 1)),
    }),
    MenuItem.new({
      id: "size-down",
      text: "缩小",
      enabled: petScale > MIN_PET_SCALE,
      action: () => setPetScale(stepPetScale(petScale, -1)),
    }),
    MenuItem.new({
      id: "size-reset",
      text: "恢复默认大小",
      enabled: petScale !== DEFAULT_PET_SCALE,
      action: () => setPetScale(DEFAULT_PET_SCALE),
    }),
  ]);
  return Submenu.new({ text: "大小", items });
}

async function showPetContextMenu(event: MouseEvent) {
  const identity = getPetIdentityForEvent(event);
  const hasSelfMessages = messageHistory.length > 0;

  if (identity.kind === "remote") {
    const targetId = identity.id;
    const menu = await Menu.new({
      items: [
        {
          id: "show-status",
          text: "查看状态",
          action: () => showRemoteBubble(targetId),
        },
        ...Object.entries(INTERACTIONS).map(([action, def]) => ({
          id: `interact-${action}`,
          text: def.label,
          action: () => triggerInteraction(action as keyof typeof INTERACTIONS, targetId),
        })),
      ],
    });
    await menu.popup();
    return;
  }

  const skinMenu = await buildSkinSubmenu();
  const sizeMenu = await buildSizeSubmenu();
  const menu = await Menu.new({
    items: [
      {
        id: "show-message",
        text: "查看对话",
        action: () => {
          if (hasSelfMessages) showMessageBubble();
          else openBubbleComposer();
        },
      },
      {
        id: "write-message",
        text: "写消息",
        action: () => openBubbleComposer(),
      },
      ...STATUS_OPTIONS.map((opt) => ({
        id: `status-${opt.value}`,
        text: `${opt.group === "mood" ? "心情" : "状态"}：${opt.label}`,
        action: () => setSelfStatus(opt.value),
      })),
      {
        id: "status-normal",
        text: "恢复正常",
        action: () => setSelfStatus(null),
      },
      ...(skinMenu ? [skinMenu] : []),
      sizeMenu,
    ],
  });
  await menu.popup();
}

petStage?.addEventListener("pointerdown", async (event: PointerEvent) => {
  setMousePassthrough(false);
  if (event.button !== 0) return;
  if (targetElement(event.target)?.closest(".bubble-composer")) return;
  if (targetElement(event.target)?.closest(".bubble-nav")) return;
  if (targetElement(event.target)?.closest(".bubble-text")) return;

  if (isBubbleOpaqueAt(event)) {
    bubblePointerStart = true;
    pointerStart = null;
    windowStart = null;
    isDragging = false;
    return;
  }

  if (!isPetOpaqueAt(event)) return;

  // 只有拖动自己的桌宠才触发被拎起动画。
  if (getPetIdentityForEvent(event).kind === "self") startDragLift();

  if (supportsNativeWindowDrag) {
    window.goodPuppy.startWindowDrag();
    return;
  }

  pointerStart = { x: event.screenX, y: event.screenY };
  isDragging = false;
  petStage?.setPointerCapture(event.pointerId);
  windowStart = await window.goodPuppy.getWindowPosition();
});

petStage?.addEventListener("contextmenu", (event: MouseEvent) => {
  if (
    targetElement(event.target)?.closest(".bubble-composer") ||
    targetElement(event.target)?.closest(".bubble-nav") ||
    targetElement(event.target)?.closest(".bubble-text")
  )
    return;
  event.preventDefault();
  if (isBubbleOpaqueAt(event)) return;
  if (!isPetOpaqueAt(event)) return;
  showPetContextMenu(event).catch(console.error);
});

petStage?.addEventListener("pointermove", (event: PointerEvent) => {
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

petStage?.addEventListener("pointerup", (event: PointerEvent) => {
  if (targetElement(event.target)?.closest(".bubble-nav")) return;
  if (targetElement(event.target)?.closest(".bubble-composer")) return;

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

  if (petStage?.hasPointerCapture(event.pointerId)) {
    petStage.releasePointerCapture(event.pointerId);
  }

  updateMousePassthrough(event);
});

petStage?.addEventListener("pointercancel", () => {
  pointerStart = null;
  windowStart = null;
  isDragging = false;
  bubblePointerStart = false;
});

// 拖动结束（含原生窗口拖动）统一在 window 层清除被拎起动画。
window.addEventListener("pointerup", stopDragLift);
window.addEventListener("blur", stopDragLift);

// ── Bubble event wiring ───────────────────────────────────────

if (messageBubble) {
  const composer = getBubbleComposer();
  const cancelButton = messageBubble.querySelector(".bubble-cancel");
  const alertButton = getBubbleAlert();

  composer?.addEventListener("submit", async (event: SubmitEvent) => {
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

  messageBubble.querySelector<HTMLElement>(".bubble-compose")?.addEventListener("click", (event) => {
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
    selfAnimator.setPetId(selfPetId);
    loadPetManifest(selfPetId).then((manifest) => selfAnimator.setManifest(manifest));
  }
}

async function activateRoom(roomId: string) {
  currentRoomId = roomId;

  try {
    await fetchSelfMessages();
    await subscribeToSelfMessages();
  } catch (error) {
    console.error(error);
  }

  petStage?.classList.remove("is-initializing");
  refreshMousePassthrough();

  if (!activeSupabase || !selfAuthId) return;
  await presence.joinRoom(activeSupabase, roomId, selfAuthId, {
    onPresenceChange: applyPresence,
    status: selfAnimator.status,
    petId: selfPetId,
    skin: selfSkin,
  });
  void activeSupabase
    .from("presence")
    .upsert(
      { user_id: selfAuthId, current_room_id: roomId, is_online: true, last_seen: new Date().toISOString() },
      { onConflict: "user_id" },
    )
    .then(({ error }) => { if (error) console.error("presence upsert:", error); });
  await joinInteractions(activeSupabase, roomId, { onInteraction: applyInteraction });
}

async function loadCurrentRoom() {
  if (!activeSupabase || !selfAuthId) return;
  const { data: memberships, error } = await activeSupabase
    .from("room_members")
    .select("room_id")
    .limit(1);
  if (error) throw error;
  if (!memberships || memberships.length === 0) {
    petStage?.classList.remove("is-initializing");
    refreshMousePassthrough();
    return;
  }
  await activateRoom(memberships[0].room_id);
}

export async function switchRoom(roomId: string) {
  if (!activeSupabase || !selfAuthId || roomId === currentRoomId) return;
  try {
    await leaveInteractions();
    await presence.leaveRoom();
    await activateRoom(roomId);
    selfAnimator.playTransient("enter"); // 手动切换房间：重新从门中走出
  } catch (error) {
    console.error(error);
  }
}

export function getCurrentRoomId() {
  return currentRoomId;
}

export async function exitCurrentRoom() {
  if (!currentRoomId) return;
  await leaveInteractions();
  await presence.leaveRoom();
  if (activeSupabase && selfAuthId) {
    void activeSupabase
      .from("presence")
      .update({ is_online: false, current_room_id: null, last_seen: new Date().toISOString() })
      .eq("user_id", selfAuthId)
      .then(({ error }) => { if (error) console.error("presence exit:", error); });
  }
  if (messagesChannel) {
    await activeSupabase?.removeChannel(messagesChannel);
    messagesChannel = null;
  }
  currentRoomId = null;
  clearRemotePets();
}

export function startPetApp({ supabase, session }: StartPetAppOptions = {}) {
  activeSupabase = supabase || activeSupabase;
  selfAuthId = session?.user?.id || selfAuthId;

  const doLoad = () =>
    ensureProfile()
      .then(() => loadCurrentRoom())
      .catch((error) => {
        console.error(error);
        petStage?.classList.remove("is-initializing");
      });

  if (hasStartedPetApp) {
    doLoad();
    return;
  }

  hasStartedPetApp = true;
  doLoad();
}

window.addEventListener("load", refreshMousePassthrough);
