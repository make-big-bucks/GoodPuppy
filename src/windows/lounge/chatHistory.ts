import type { SupabaseClient } from "@supabase/supabase-js";
import type { LoungeProfile } from "../../types";
import { getDisplayName } from "./loungeViewModels.js";

/** 单页拉取条数；向上滚动时每次再取一页。 */
export const PAGE_SIZE = 50;

/** 聊天记录里使用的本地消息视图模型。 */
export interface ChatMessage {
  id: string;
  content: string;
  senderId: string;
  createdAt: string;
}

/** Supabase 查询返回的原始行（内嵌 sender 的 profile）。 */
export interface ChatMessageRow {
  id: string;
  content: string;
  sender_id: string;
  created_at: string;
  // 内嵌 join：to-one 关系通常是对象，但部分版本会返回数组，两种都兼容。
  profiles?: LoungeProfile | LoungeProfile[] | null;
}

export interface SenderIdentity {
  name: string;
  color: string;
  isDeleted: boolean;
}

export interface MessagePage {
  /** 升序（旧 → 新）排列，方便直接 append/prepend。 */
  messages: ChatMessage[];
  /** 是否可能还有更早的历史。 */
  hasMore: boolean;
  /** 下一页向更早翻页时使用的游标（最早一条的 created_at）。 */
  nextCursor: string | null;
}

// 一组柔和、在浅色背景上可读的发送者强调色。颜色仅用于名字文本。
const SENDER_PALETTE = [
  "#2f5f8f",
  "#137a45",
  "#a1444d",
  "#7a5c2e",
  "#5b4b8a",
  "#b06a2c",
  "#2e7d7a",
  "#8a4b6b",
];

/** 由 sender_id 稳定哈希出一个颜色；同一账号每次结果一致。 */
export function senderColor(senderId: string): string {
  let hash = 0;
  for (let i = 0; i < senderId.length; i += 1) {
    hash = (hash * 31 + senderId.charCodeAt(i)) >>> 0;
  }
  return SENDER_PALETTE[hash % SENDER_PALETTE.length];
}

function firstProfile(profiles: ChatMessageRow["profiles"]): LoungeProfile | null {
  if (!profiles) return null;
  return Array.isArray(profiles) ? profiles[0] ?? null : profiles;
}

/**
 * 解析发送者身份：
 * - profile 存在 → 用当前 display_name（改名自动跟随）。
 * - profile 缺失（未来删号场景）→ 用 sender_id 末 4 位生成稳定标签，多个注销账号天然可区分。
 * 颜色始终由 sender_id 派生，保证同一人前后一致。
 */
export function resolveSender(senderId: string, profile?: LoungeProfile | null): SenderIdentity {
  const color = senderColor(senderId);
  if (profile && (String(profile.display_name || "").trim() || profile.gp_id)) {
    return { name: getDisplayName(profile), color, isDeleted: false };
  }
  const suffix = senderId.replace(/-/g, "").slice(-4) || senderId;
  return { name: `已注销用户·${suffix}`, color, isDeleted: true };
}

export function rowToMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    content: row.content,
    senderId: row.sender_id,
    createdAt: row.created_at,
  };
}

export function rowProfile(row: ChatMessageRow): LoungeProfile | null {
  return firstProfile(row.profiles);
}

/**
 * 把按 created_at 降序拉取的一页原始行，整理成升序的 MessagePage。
 * 拆成纯函数便于单测。
 */
export function assemblePage(rows: ChatMessageRow[]): MessagePage {
  const hasMore = rows.length === PAGE_SIZE;
  const ascending = [...rows].reverse();
  const nextCursor = rows.length > 0 ? rows[rows.length - 1].created_at : null;
  return {
    messages: ascending.map(rowToMessage),
    hasMore,
    nextCursor,
  };
}

const PAGE_SELECT = "id, content, created_at, sender_id, profiles!messages_sender_id_fkey(id, gp_id, display_name)";

/**
 * 拉取一页房间消息。`before` 为游标（created_at），不传则取最新一页。
 * 同时返回原始行，便于调用方缓存内嵌的 profile。
 */
export async function fetchMessagePage(
  supabase: SupabaseClient,
  roomId: string,
  before?: string | null,
): Promise<{ page: MessagePage; rows: ChatMessageRow[] }> {
  let query = supabase
    .from("messages")
    .select(PAGE_SELECT)
    .eq("room_id", roomId)
    .eq("kind", "text")
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .limit(PAGE_SIZE);

  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) throw error;

  const rows = (data as ChatMessageRow[] | null) || [];
  return { page: assemblePage(rows), rows };
}

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** 同一天判断，用于决定是否插入日期分割线。 */
export function isSameDay(a: string, b: string): boolean {
  return startOfDay(new Date(a)) === startOfDay(new Date(b));
}

/** 日期分割线文案：今天 / 昨天 / M月D日 / 跨年时带年份。 */
export function formatDayLabel(iso: string, now: Date = new Date()): string {
  const date = new Date(iso);
  const today = startOfDay(now);
  const target = startOfDay(date);
  const oneDay = 24 * 60 * 60 * 1000;
  if (target === today) return "今天";
  if (target === today - oneDay) return "昨天";
  const md = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? md : `${date.getFullYear()}年${md}`;
}

/** 气泡时间：HH:mm。 */
export function formatTime(iso: string): string {
  const date = new Date(iso);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}
