import { getDisplayName } from "../loungeViewModels.js";
import { createPetAvatar } from "./pet-avatar.js";
import type { ConnectionRequestRow, LoungeRoom } from "../../../types";

const enterRoomSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>`;
const exitRoomSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>`;
const hereIconSvg = `<svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-3.866 3.582-7 8-7s8 3.134 8 7"/></svg>`;

function roomIconSvg() {
  return `
    <svg class="room-icon" viewBox="0 0 24 24" fill="none">
      <path d="M4 11.5 12 5l8 6.5V20a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1v-8.5Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/>
    </svg>
  `;
}

export function renderRoomList(
  rooms: LoungeRoom[],
  selectedRoomId: string | null,
  activeRoomId: string | null,
  onSelectRoom: (roomId: string) => void,
) {
  const list = document.querySelector<HTMLElement>(".lounge-room-list");
  if (!list) return;

  list.innerHTML = "";

  if (rooms.length === 0) {
    return;
  }

  for (const room of rooms) {
    const isActive = room.id === activeRoomId;

    const row = document.createElement("div");
    row.className = `room-item-row${isActive ? " is-current-room" : ""}`;

    const btn = document.createElement("button");
    btn.className = "room-item";
    btn.type = "button";
    btn.dataset.roomId = room.id;
    btn.classList.toggle("active", room.id === selectedRoomId);
    btn.innerHTML = `
      ${roomIconSvg()}
      <span class="room-text">${room.room_name || "未命名房间"}</span>
      ${isActive ? `<span class="room-here-badge" title="你在这里">${hereIconSvg}</span>` : ""}
      <span class="room-meta">${room.members.length} 人</span>
    `;
    btn.addEventListener("click", () => onSelectRoom(room.id));

    const quickAction = document.createElement("button");
    quickAction.className = "room-quick-action";
    quickAction.type = "button";
    quickAction.dataset.roomId = room.id;
    quickAction.dataset.action = isActive ? "exit" : "enter";
    quickAction.setAttribute("aria-label", isActive ? "退出房间" : "进入房间");
    quickAction.innerHTML = isActive ? exitRoomSvg : enterRoomSvg;

    row.appendChild(btn);
    row.appendChild(quickAction);
    list.appendChild(row);
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
