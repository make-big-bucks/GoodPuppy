// 房间上线提醒的纯逻辑层：上线检测、卡片定位、订阅开关持久化、去抖判定。
// 本文件**不得**引入 Tauri / bridge / window 等运行时依赖，以便在 node 下单测。
// 有副作用的调度与窗口管理放 `onlineNotifier.ts`。

export interface PresenceRowLike {
  user_id: string;
  current_room_id?: string | null;
  is_online?: boolean;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** 把一条 presence 行折算成「当前所在房间」（离线或无房间为 null）。 */
export function nextPresenceRoom(row: PresenceRowLike): string | null {
  return row.is_online && row.current_room_id ? row.current_room_id : null;
}

export interface OnlineDecision {
  /** 是否产出一条上线提醒。 */
  shouldNotify: boolean;
  /** 该用户折算后的新房间状态，调用方据此更新快照（无论是否提醒）。 */
  roomId: string | null;
}

/**
 * 依据快照对比 + 过滤规则判断一条 presence 变更是否构成「上线」。纯函数。
 * 命中条件（全部满足）：进入了某具体房间、该房间不同于上一状态、非自己、
 * 非当前所在房间、房间已订阅、未在去抖窗口内。
 */
export function decideOnlineNotification(args: {
  prevRoom: string | null | undefined;
  row: PresenceRowLike;
  selfId: string;
  activeRoomId: string | null;
  isSubscribed: (roomId: string) => boolean;
  isDeduped: (roomId: string, userId: string) => boolean;
}): OnlineDecision {
  const newRoom = nextPresenceRoom(args.row);
  const shouldNotify =
    newRoom !== null &&
    newRoom !== args.prevRoom &&
    args.row.user_id !== args.selfId &&
    newRoom !== args.activeRoomId &&
    args.isSubscribed(newRoom) &&
    !args.isDeduped(newRoom, args.row.user_id);
  return { shouldNotify, roomId: newRoom };
}

const DEFAULT_MARGIN = 16;
const DEFAULT_GAP = 12;

/**
 * 计算第 index 张卡片的桌面位置；内容逻辑尺寸和间距按 desktopScale 换算。
 * macOS：右上角向下堆叠；Windows：右下角（taskbar 上方）向上堆叠。
 */
export function computeToastPosition(opts: {
  workArea: Rect;
  platform: "macos" | "windows";
  index: number;
  card: Size;
  margin?: number;
  gap?: number;
  desktopScale?: number;
}): { x: number; y: number } {
  const scale = opts.desktopScale ?? 1;
  const margin = (opts.margin ?? DEFAULT_MARGIN) * scale;
  const gap = (opts.gap ?? DEFAULT_GAP) * scale;
  const card = { width: opts.card.width * scale, height: opts.card.height * scale };
  const x = opts.workArea.x + opts.workArea.width - card.width - margin;
  const step = card.height + gap;

  if (opts.platform === "windows") {
    const bottom = opts.workArea.y + opts.workArea.height - card.height - margin;
    return { x, y: bottom - opts.index * step };
  }

  const top = opts.workArea.y + margin;
  return { x, y: top + opts.index * step };
}

// ---- 订阅开关持久化（注入 Storage，便于在 node 下单测）----

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 按账号隔离的 localStorage 键。 */
export function subscriptionStorageKey(selfId: string): string {
  return `goodpuppy.onlineNotify.${selfId}`;
}

/** 读取某账号已开启提醒的房间集合；缺失或损坏一律返回空集合（默认关闭）。 */
export function readSubscribedRooms(storage: StorageLike, selfId: string): Set<string> {
  try {
    const raw = storage.getItem(subscriptionStorageKey(selfId));
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id): id is string => typeof id === "string"));
  } catch {
    return new Set();
  }
}

/** 写回某账号的订阅集合。 */
export function writeSubscribedRooms(storage: StorageLike, selfId: string, rooms: Set<string>): void {
  storage.setItem(subscriptionStorageKey(selfId), JSON.stringify([...rooms]));
}

/** 同一 (room,user) 是否仍在去抖窗口内（last 为上次提醒时间戳，缺失则不去抖）。 */
export function isWithinDedupeWindow(last: number | undefined, now: number, windowMs: number): boolean {
  if (last === undefined) return false;
  return now - last < windowMs;
}
