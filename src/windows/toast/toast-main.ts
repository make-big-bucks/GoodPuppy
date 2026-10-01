import "../../shared/bridge.js";
import "./toast.css";
import { createPetAvatar } from "../lounge/views/pet-avatar.js";
import type { OnlineNotifyPayload } from "../../types";

// 房间上线提醒 toast 窗口入口。窗口由 Lounge 经 native spawn_toast_window 创建，
// 内容（谁、哪个房间、形象）经 toast-data 定向事件下发。本窗口负责渲染卡片、
// 自动消失计时、手动关闭与「进入房间」回传，全部通过 Lounge 复用既有进房流程。

const bridge = window.goodPuppy;
const label = bridge.getWindowLabel();
const instanceId = bridge.getWindowInstance();

const card = document.querySelector<HTMLElement>(".toast-card");
const avatarSlot = document.querySelector<HTMLElement>(".toast-avatar");
const titleEl = document.querySelector<HTMLElement>(".toast-title");
const roomEl = document.querySelector<HTMLElement>(".toast-room");
const enterBtn = document.querySelector<HTMLButtonElement>(".toast-enter");
const closeBtn = document.querySelector<HTMLButtonElement>(".toast-close");

let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let currentRoomId: string | null = null;
let dismissed = false;

function dismiss(reason: "timeout" | "close" | "enter") {
  if (dismissed) return;
  dismissed = true;
  if (dismissTimer) clearTimeout(dismissTimer);
  if (reason === "enter" && currentRoomId) {
    void bridge.emitToWindow("lounge", "toast-enter-room", { roomId: currentRoomId, label, instanceId });
  } else {
    void bridge.emitToWindow("lounge", "toast-dismiss", { label, reason, instanceId });
  }
}

function render(payload: OnlineNotifyPayload) {
  currentRoomId = payload.roomId;

  if (avatarSlot) {
    avatarSlot.innerHTML = "";
    avatarSlot.appendChild(
      createPetAvatar({ petId: payload.petId, skin: payload.skin, alt: payload.displayName }),
    );
  }
  if (titleEl) titleEl.textContent = `${payload.displayName} 来了`;
  if (roomEl) roomEl.textContent = `在「${payload.roomName}」`;

  // 起渐入动画；计时仅在窗口可见后开始（spawn 后窗口已 show，可见即生效）。
  card?.classList.add("is-visible");
  void bridge.emitToWindow("lounge", "toast-applied", { label, instanceId }).catch(console.error);

  if (payload.autoDismissMs > 0) {
    dismissTimer = setTimeout(() => dismiss("timeout"), payload.autoDismissMs);
  }
}

enterBtn?.addEventListener("click", () => dismiss("enter"));
closeBtn?.addEventListener("click", () => dismiss("close"));

const data = bridge.onAppEvent<{ instanceId: string; payload: OnlineNotifyPayload }>("toast-data", (envelope) => {
  if (!dismissed && envelope?.instanceId === instanceId) render(envelope.payload);
});
void data.ready.then(() => bridge.emitToWindow("lounge", "toast-ready", { label, instanceId })).catch(console.error);
window.addEventListener("beforeunload", () => { data(); if (dismissTimer) clearTimeout(dismissTimer); });
