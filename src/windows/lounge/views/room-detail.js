import { getRoomAction } from "../loungeViewModels.js";
import { createPetAvatar } from "./pet-avatar.js";

export function switchView(name) {
  const detail = document.querySelector(".lounge-room-detail");
  const empty = document.querySelector(".lounge-empty-detail");
  if (!detail || !empty) return;
  const isDetail = name === "detail";
  detail.hidden = !isDetail;
  empty.hidden = isDetail;
}

export function renderRoomDetail(room, selfAuthId, activeRoomId = null) {
  if (!room) {
    switchView("empty");
    return;
  }

  switchView("detail");

  const detail = document.querySelector(".lounge-room-detail");
  if (!detail) return;

  const title = detail.querySelector(".lounge-room-title");
  const description = detail.querySelector(".lounge-room-description");
  const members = detail.querySelector(".lounge-member-list");
  const actionButton = detail.querySelector(".lounge-enter-room");

  if (title) title.textContent = room.room_name || "未命名房间";
  if (description) description.textContent = room.description || "还没有房间简介。";

  if (actionButton) {
    const roomAction = getRoomAction(room.id, activeRoomId);
    actionButton.dataset.action = roomAction.action;
    const label = actionButton.querySelector(".lounge-enter-label");
    if (label) label.textContent = roomAction.label;
  }

  if (members) {
    members.innerHTML = "";
    for (const member of room.members) {
      const item = document.createElement("div");
      item.className = "member";
      item.appendChild(createPetAvatar({ petId: member.petId, skin: member.skin, alt: member.displayName }));

      const copy = document.createElement("div");
      copy.className = "member-copy";

      const name = document.createElement("div");
      name.className = "member-name";
      name.title = member.gpId;
      name.textContent = member.displayName;
      copy.appendChild(name);

      const id = document.createElement("div");
      id.className = "member-id";
      id.textContent = member.gpId;
      copy.appendChild(id);
      item.appendChild(copy);

      const status = document.createElement("span");
      status.className = `status-badge ${member.isOnline ? "is-online" : "is-offline"}`;
      status.textContent = member.isOnline ? "在线" : "离线";
      item.appendChild(status);

      if (member.isSelf || member.userId === selfAuthId) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = "你";
        item.appendChild(badge);
      }

      members.appendChild(item);
    }
  }
}
