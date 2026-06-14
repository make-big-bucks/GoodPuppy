export function switchView(name) {
  const detail = document.querySelector(".lounge-room-detail");
  const empty = document.querySelector(".lounge-empty-detail");
  if (!detail || !empty) return;
  const isDetail = name === "detail";
  detail.hidden = !isDetail;
  empty.hidden = isDetail;
}

export function renderRoomDetail(room, selfAuthId) {
  if (!room) {
    switchView("empty");
    return;
  }

  switchView("detail");

  const detail = document.querySelector(".lounge-room-detail");
  if (!detail) return;

  const inviteCode = detail.querySelector(".lounge-invite-code");
  const members = detail.querySelector(".lounge-member-list");

  if (inviteCode) inviteCode.textContent = room.invite_code || "暂无";

  if (members) {
    members.innerHTML = "";
    for (const member of room.members) {
      const isSelf = member.user_id === selfAuthId;
      const id = member.profiles?.id || member.user_id;
      const item = document.createElement("div");
      item.className = "member";
      item.innerHTML = `
        <div class="member-avatar">${isSelf ? "我" : "友"}</div>
        <div class="member-name" title="${id}">${id}</div>
        <span class="badge">${isSelf ? "你" : "成员"}</span>
      `;
      members.appendChild(item);
    }
  }
}
