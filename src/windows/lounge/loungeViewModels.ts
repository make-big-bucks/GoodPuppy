import type {
  LoungeMemberRow,
  LoungePresenceRow,
  LoungeProfile,
  MemberViewModel,
  RoomAction,
} from "../../types";

const GP_ID_PATTERN = /^gp_[a-z0-9]{8,}$/i;

// 心跳间隔 60s，超过 3 次未收到心跳则视为离线
const PRESENCE_TIMEOUT_MS = 3 * 60 * 1000;

function isPresenceOnline(presence: LoungePresenceRow | undefined, roomId: string | null | undefined): boolean {
  if (!presence?.is_online || presence.current_room_id !== roomId) return false;
  if (!presence.last_seen) return true;
  return Date.now() - Date.parse(presence.last_seen) < PRESENCE_TIMEOUT_MS;
}

export function normalizeGpId(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  return GP_ID_PATTERN.test(normalized) ? normalized : "";
}

export function getDisplayName(profile: LoungeProfile = {}) {
  const name = String(profile.display_name || "").trim();
  return name || profile.gp_id || "GoodPuppy";
}

function joinedAtValue(member: LoungeMemberRow) {
  const time = Date.parse(member.joined_at || "");
  return Number.isNaN(time) ? 0 : time;
}

export function buildMemberViewModels(
  members: LoungeMemberRow[] = [],
  presenceRows: LoungePresenceRow[] = [],
  selfAuthId?: string | null,
  roomId?: string | null,
  activeRoomId?: string | null,
): MemberViewModel[] {
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
      const isSelf = member.user_id === selfAuthId;
      return {
        userId: member.user_id,
        gpId: profile.gp_id || "",
        displayName: getDisplayName(profile),
        petId: profile.pet_id || "default",
        skin: profile.skin || "default",
        isSelf,
        isOnline: isSelf ? Boolean(roomId && roomId === activeRoomId) : isPresenceOnline(presence, roomId),
      };
    });
}

export function getRoomAction(selectedRoomId: string | null, activeRoomId: string | null): RoomAction {
  if (selectedRoomId && selectedRoomId === activeRoomId) {
    return { action: "exit", label: "退出房间" };
  }
  return { action: "enter", label: "进入房间" };
}
