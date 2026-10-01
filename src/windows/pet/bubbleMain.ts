import { createPresenterEndpoint } from "./windowReadiness.js";
// 独立气泡窗口入口（label `bubble-self` / `bubble-<userId>`，多窗口 Phase A）。
//
// 气泡窗口是某只 pet 窗口的原生子窗口，由 OS 跟随 pet 移动（见 lib.rs add_child_window）。
// 它只渲染那只 pet 的消息堆叠：听协调者（"main"）定向来的 pet-message / pet-history。
// 远程气泡窗口不碰网络；自己的气泡窗口（bubble-self）另含写消息记号棒（见 Slice B）。
//
// 鼠标穿透同样由原生光标监视器独占：气泡窗口下发「可交互矩形 = 可见堆叠 / 记号棒」的命中
// 形状（无 pet 剪影掩模），空窗口（无消息）整窗穿透。
import "../../shared/bridge.js";
import "../../shared/styles.css";
import { initBubbleStacks, mountStack, setBubbleScope, setMessagesForArea, addMessageToArea, showArea } from "./messageBubble.js";
import { initComposeStick, openComposeStick, closeComposeStick, isComposeOpen } from "./composeStick.js";
import {
  BUBBLE_SELF_LABEL,
  COORDINATOR_LABEL,
  PET_MESSAGE,
  PET_HISTORY,
  BUBBLE_SHOW,
  BUBBLE_PLACEMENT,
  OVERLAY_HOVER,
  SELF_OPEN_COMPOSE,
  SELF_COMPOSE_SUBMIT,
  SELF_COMPOSE_RESULT,
  type PetMessagePayload,
  type PetHistoryPayload,
  type BubblePlacementPayload,
  type SelfComposeResultPayload,
} from "../../shared/pet/petWindowEvents.js";

import { requestWindow } from "../../shared/windowRequest.js";
import { emit } from "@tauri-apps/api/event";

const bridge = window.goodPuppy;
const endpoint = createPresenterEndpoint({ label: bridge.getWindowLabel(), instanceId: bridge.getWindowInstance(),
  listen: (event, handler) => bridge.onAppEvent(event, handler),
  send: (label, event, payload) => bridge.emitToWindow(label, event, payload),
});
const isSelf = bridge.getWindowLabel() === BUBBLE_SELF_LABEL;

const root = document.querySelector<HTMLElement>(".bubble-window");
const area = document.querySelector<HTMLElement>(".dog-area");
const composeStick = document.querySelector<HTMLElement>(".compose-stick");

// 远程气泡窗口没有记号棒；移除它，避免命中/布局误判。自己窗口的记号棒接线见 Slice B。
if (!isSelf) composeStick?.remove();

const BUBBLE_REGION_SELECTOR = ".bubble-stack:not([hidden]), .compose-stick:not([hidden])";

function publishHitShape() {
  const rects = [...document.querySelectorAll<HTMLElement>(BUBBLE_REGION_SELECTOR)].map((el) => {
    const r = el.getBoundingClientRect();
    return [r.left, r.top, r.width, r.height] as [number, number, number, number];
  });
  void bridge.publishHitShape({
    mask: [],
    maskCols: 0,
    maskRows: 0,
    maskRect: [0, 0, 0, 0],
    rects,
    forceInteractive: false,
  }).catch(console.error);
}

// 写消息提交：把文本交给 main（协调者独占 Supabase），等它回报结果再收尾。
// composeStick 期望一个会在失败时抛错的 Promise，于是把 result 事件转成 resolve/reject。
let currentRoomId: string | null = null;
let messageRequests = new AbortController();
const roomState = isSelf ? bridge.onAppEvent<{ roomId?: string | null }>("active-room-changed", (payload) => {
  const roomId = payload?.roomId ?? null;
  if (roomId !== currentRoomId) {
    messageRequests.abort();
    messageRequests = new AbortController();
    closeComposeStick();
    currentRoomId = roomId;
  }
}) : null;
void roomState?.ready.then(() => emit("request-active-room")).catch(console.error);

async function submitViaCoordinator(text: string): Promise<void> {
  if (!currentRoomId) throw new Error("请先进入房间");
  await requestWindow<SelfComposeResultPayload>({
    listen: (event, handler) => bridge.onAppEvent(event, handler),
    send: (target, event, payload) => bridge.emitToWindow(target, event, payload),
  }, {
    target: COORDINATOR_LABEL, requestEvent: SELF_COMPOSE_SUBMIT, responseEvent: SELF_COMPOSE_RESULT,
    payload: { text, roomId: currentRoomId }, signal: messageRequests.signal,
  });
}

// 合并一帧内的多次触发（消息渲染会同时改可见性 + 内容）。
let scheduled = false;
function refreshHitShape() {
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    scheduled = false;
    publishHitShape();
  });
}

if (root && area) {
  area.dataset.user = isSelf ? "self" : "remote";

  initBubbleStacks({ onRefreshPassthrough: refreshHitShape, onVisibilityChange: refreshHitShape });
  // 用气泡窗口 label（bubble-self / bubble-<userId>）作水位线持久化 key。
  mountStack(area);

  // 光标落在气泡命中区时浮现关闭按钮（由原生监视器驱动，不依赖窗口聚焦）。
  const hover = bridge.onAppEvent<boolean>(OVERLAY_HOVER, (interactive) => {
    area.classList.toggle("bubble-hovered", interactive);
  });

  endpoint.listen<PetHistoryPayload>(PET_HISTORY, (payload) => { setBubbleScope(area, payload.scope ?? null); setMessagesForArea(area, payload.messages); });
  endpoint.listen<PetMessagePayload>(PET_MESSAGE, (payload) => { setBubbleScope(area, payload.scope ?? null); addMessageToArea(area, payload.message); });
  // 「查看对话/状态」：协调者/对端右键触发，撤销已关闭状态重新展开堆叠。
  endpoint.listen<void>(BUBBLE_SHOW, () => showArea(area));
  // 几何 + 朝向：气泡窗口重设自身位置/尺寸（窗口只能改自己），并切堆叠锚点 + 小尾巴方向。
  endpoint.listen<BubblePlacementPayload>(BUBBLE_PLACEMENT, (payload) => {
    root.dataset.placement = payload.placement;
    bridge.setWindowBounds({ x: payload.x, y: payload.y, width: payload.width, height: payload.height });
    refreshHitShape();
  });

  // 自己的气泡窗口承载写消息记号棒：提交走跨窗口回环到 main（它独占 Supabase）。
  if (isSelf && composeStick) {
    initComposeStick(composeStick, {
      onRefreshPassthrough: refreshHitShape,
      onVisibilityChange: refreshHitShape,
      onSubmitMessage: submitViaCoordinator,
    });
    endpoint.listen<{ roomId: string }>(SELF_OPEN_COMPOSE, (payload) => {
      if (!currentRoomId || payload?.roomId !== currentRoomId) return;
      const room = currentRoomId;
      openComposeStick();
      // 主窗右键菜单收起可能晚于此事件，重试一次取 key + 聚焦，确保 textarea 收键。
      setTimeout(() => {
        if (room !== currentRoomId || !isComposeOpen()) return;
        void bridge.setFocus("post-menu").then((focused) => {
          if (focused && room === currentRoomId && isComposeOpen()) composeStick.querySelector<HTMLTextAreaElement>(".compose-input")?.focus();
        });
      }, 60);
    });
  }

  root.classList.remove("is-initializing");
  window.addEventListener("resize", refreshHitShape);
  window.addEventListener("load", refreshHitShape);
  refreshHitShape();
  void endpoint.ready().catch(console.error);
  window.addEventListener("beforeunload", () => { endpoint.dispose(); hover(); roomState?.(); messageRequests.abort(); });

}
