import { getRoomAction } from "../loungeViewModels.js";
import { createPetAvatar } from "./pet-avatar.js";
import type { LoungeRoom } from "../../../types";

export function switchView(name: "detail" | "empty") {
  const detail = document.querySelector<HTMLElement>(".lounge-room-detail");
  const empty = document.querySelector<HTMLElement>(".lounge-empty-detail");
  if (!detail || !empty) return;
  const isDetail = name === "detail";
  detail.hidden = !isDetail;
  empty.hidden = isDetail;
}

export function renderRoomDetail(room: LoungeRoom | null, selfAuthId: string | null, activeRoomId: string | null = null) {
  if (!room) {
    switchView("empty");
    return;
  }

  switchView("detail");

  const detail = document.querySelector<HTMLElement>(".lounge-room-detail");
  if (!detail) return;

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
    const roomAction = getRoomAction(room.id, activeRoomId);
    actionButton.dataset.action = roomAction.action;
    const label = actionButton.querySelector<HTMLElement>(".lounge-enter-label");
    if (label) label.textContent = roomAction.label;
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
