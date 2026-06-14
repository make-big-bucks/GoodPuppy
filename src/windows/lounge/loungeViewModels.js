const GP_ID_PATTERN = /^gp_[a-z0-9]{8,}$/i;

export function normalizeGpId(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return GP_ID_PATTERN.test(normalized) ? normalized : "";
}

export function getDisplayName(profile = {}) {
  const name = String(profile.display_name || "").trim();
  return name || profile.gp_id || "GoodPuppy";
}

function joinedAtValue(member) {
  const time = Date.parse(member.joined_at || "");
  return Number.isNaN(time) ? 0 : time;
}

export function buildMemberViewModels(members = [], presenceRows = [], selfAuthId) {
  const presenceByUser = new Map(presenceRows.map((row) => [row.user_id, row]));

  return [...members]
    .sort((a, b) => {
      if (a.user_id === selfAuthId) return -1;
      if (b.user_id === selfAuthId) return 1;
      return joinedAtValue(a) - joinedAtValue(b);
    })
    .map((member) => {
      const profile = member.profiles || {};
      const presence = presenceByUser.get(member.user_id);
      return {
        userId: member.user_id,
        gpId: profile.gp_id || "",
        displayName: getDisplayName(profile),
        petId: profile.pet_id || "default",
        skin: profile.skin || "default",
        isSelf: member.user_id === selfAuthId,
        isOnline: Boolean(presence?.is_online),
      };
    });
}

export function getRoomAction(selectedRoomId, activeRoomId) {
  if (selectedRoomId && selectedRoomId === activeRoomId) {
    return { action: "exit", label: "退出房间" };
  }
  return { action: "enter", label: "进入房间" };
}
