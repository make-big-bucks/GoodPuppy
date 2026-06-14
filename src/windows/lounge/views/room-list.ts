import { getDisplayName } from "../loungeViewModels.js";
import { createPetAvatar } from "./pet-avatar.js";
import type { ConnectionRequestRow, LoungeRoom } from "../../../types";

function roomIconSvg() {
  return `
    <svg class="room-icon" viewBox="0 0 24 24" fill="none">
      <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    </svg>
  `;
}

export function renderRoomList(rooms: LoungeRoom[], selectedRoomId: string | null, onSelectRoom: (roomId: string) => void) {
  const list = document.querySelector<HTMLElement>(".lounge-room-list");
  if (!list) return;

  list.innerHTML = "";

  if (rooms.length === 0) {
    return;
  }

  for (const room of rooms) {
    const btn = document.createElement("button");
    btn.className = "room-item";
    btn.type = "button";
    btn.dataset.roomId = room.id;
    btn.classList.toggle("active", room.id === selectedRoomId);
    btn.innerHTML = `
      ${roomIconSvg()}
      <span class="room-text">${room.room_name || "未命名房间"}</span>
      <span class="room-meta">${room.members.length} 人</span>
    `;
    btn.addEventListener("click", () => onSelectRoom(room.id));
    list.appendChild(btn);
  }
}

export function renderPendingRequests(pendingRequests: ConnectionRequestRow[]) {
  const list = document.querySelector<HTMLElement>(".lounge-request-list");
  if (!list) return;

  list.innerHTML = "";
  list.hidden = pendingRequests.length === 0;

  for (const req of pendingRequests) {
    const sender = req.profiles || {};
    const item = document.createElement("div");
    item.className = "invite-item";
    item.appendChild(
      createPetAvatar({
        petId: sender.pet_id,
        skin: sender.skin,
        alt: getDisplayName(sender),
      }),
    );

    const copy = document.createElement("div");
    copy.className = "invite-copy";

    const title = document.createElement("div");
    title.className = "invite-title";
    title.textContent = getDisplayName(sender);
    copy.appendChild(title);

    const meta = document.createElement("div");
    meta.className = "invite-meta";
    meta.textContent = sender.gp_id || req.from_id;
    copy.appendChild(meta);
    item.appendChild(copy);

    const actions = document.createElement("div");
    actions.className = "invite-actions";
    actions.innerHTML = `
      <button class="small-btn primary" type="button" data-action="accept" data-id="${req.id}">接受</button>
      <button class="small-btn" type="button" data-action="decline" data-id="${req.id}">拒绝</button>
    `;
    item.appendChild(actions);
    list.appendChild(item);
  }
}
