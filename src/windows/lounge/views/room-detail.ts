import { getRoomAction } from "../loungeViewModels.js";
import { createPetAvatar } from "../../../shared/pet/pet-avatar.js";
import type { LoungeRoom } from "../../../types";
import type { PendingTransition } from "./room-list.js";

const enterIconPaths = `<path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><polyline points="10 17 15 12 10 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="15" y1="12" x2="3" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`;
const exitIconPaths = `<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/><polyline points="16 17 21 12 16 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><line x1="21" y1="12" x2="9" y2="12" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`;

export function switchView(name: "detail" | "empty") {
  const detail = document.querySelector<HTMLElement>(".lounge-room-detail");
  const empty = document.querySelector<HTMLElement>(".lounge-empty-detail");
  if (!detail || !empty) return;
  const isDetail = name === "detail";
  detail.hidden = !isDetail;
  empty.hidden = isDetail;
}

export interface RoomNotifyControls {
  isSubscribed: (roomId: string) => boolean;
  onToggle: (roomId: string, on: boolean) => void;
}

export function renderRoomDetail(
  room: LoungeRoom | null,
  selfAuthId: string | null,
  activeRoomId: string | null = null,
  pendingTransition: PendingTransition | null = null,
  notify: RoomNotifyControls | null = null,
) {
  if (!room) {
    switchView("empty");
    return;
  }

  switchView("detail");

  const detail = document.querySelector<HTMLElement>(".lounge-room-detail");
  if (!detail) return;

  const notifyToggle = detail.querySelector<HTMLButtonElement>(".lounge-notify-toggle");
  if (notifyToggle) {
    const on = notify ? notify.isSubscribed(room.id) : false;
    notifyToggle.setAttribute("aria-pressed", on ? "true" : "false");
    notifyToggle.classList.toggle("is-on", on);
    notifyToggle.title = on ? "已开启上线提醒，点击关闭" : "有人进入该房间时提醒";
    // 替换节点以清掉上一次 render 绑定的旧房间 click 闭包。
    const fresh = notifyToggle.cloneNode(true) as HTMLButtonElement;
    notifyToggle.replaceWith(fresh);
    fresh.addEventListener("click", () => {
      if (!notify) return;
      notify.onToggle(room.id, !notify.isSubscribed(room.id));
    });
  }

  const title = detail.querySelector<HTMLElement>(".lounge-room-title");
  const description = detail.querySelector<HTMLElement>(".lounge-room-description");
  const members = detail.querySelector<HTMLElement>(".lounge-member-list");
  const actionButton = detail.querySelector<HTMLButtonElement>(".lounge-enter-room");

  if (title) title.textContent = room.room_name || "未命名房间";
  if (description) {
    if (room.description) {
      description.textContent = room.description;
      description.classList.remove("is-placeholder");
    } else {
      description.textContent = "暂无房间简介";
      description.classList.add("is-placeholder");
    }
  }

  if (actionButton) {
    const isPending = pendingTransition?.roomId === room.id;
    const svgEl = actionButton.querySelector<SVGSVGElement>("svg");
    const label = actionButton.querySelector<HTMLElement>(".lounge-enter-label");
    let spinner = actionButton.querySelector<HTMLElement>(".btn-spinner");

    if (isPending) {
      // 加载中：保留文字（按本次过渡方向），只把图标换成 spinner。
      actionButton.disabled = true;
      actionButton.classList.add("is-pending");
      if (svgEl) svgEl.style.display = "none";
      if (!spinner) {
        spinner = document.createElement("span");
        spinner.className = "btn-spinner";
        actionButton.insertBefore(spinner, label ?? null);
      }
      if (label) label.textContent = pendingTransition?.type === "exit" ? "退出房间" : "进入房间";
    } else {
      const roomAction = getRoomAction(room.id, activeRoomId);
      const isExit = roomAction.action === "exit";
      actionButton.disabled = false;
      actionButton.classList.remove("is-pending");
      actionButton.dataset.action = roomAction.action;
      actionButton.classList.toggle("is-exit", isExit);
      if (spinner) spinner.remove();
      if (svgEl) {
        svgEl.style.display = "";
        svgEl.innerHTML = isExit ? exitIconPaths : enterIconPaths;
      }
      if (label) label.textContent = roomAction.label;
    }
  }

  if (members) {
    members.innerHTML = "";
    for (const member of room.members) {
      const item = document.createElement("div");
      item.className = `member${member.isOnline ? "" : " is-offline"}`;
      item.appendChild(createPetAvatar({ petId: member.petId, skin: member.skin, alt: member.displayName }));

      const copy = document.createElement("div");
      copy.className = "member-copy";

      const name = document.createElement("div");
      name.className = "member-name";
      name.textContent = member.displayName;
      copy.appendChild(name);

      item.appendChild(copy);

      const dot = document.createElement("span");
      dot.className = `status-dot ${member.isOnline ? "is-online" : "is-offline"}`;
      item.appendChild(dot);

      members.appendChild(item);
    }
  }
}
