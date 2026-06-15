// 全仓库的数据契约类型定义（TypeScript 迁移后的共享契约入口）。
//
// 用途：给跨窗口 / 跨网络 / 前端 ↔ Rust 的「契约型」数据上类型，
// 让编辑器对 window.goodPuppy.*、presence / interaction payload、Supabase 行结构
// 提供集中、可复用的类型来源。
// window.goodPuppy 因下方 `declare global` 自动全局可见，无需 import。

// ── 前端 ↔ Rust 桥接（src/shared/bridge.ts 暴露在 window.goodPuppy）─────────

export interface WindowPoint {
  x: number;
  y: number;
}

export interface WindowSize {
  width: number;
  height: number;
}

export interface WindowLayout {
  windowBounds: WindowPoint & WindowSize;
  workArea: WindowPoint & WindowSize;
}

/** 原生侧推送的窗口 client 坐标（鼠标穿透判定用，见 bridge.onCursorMoved）。 */
export interface CursorPoint {
  x: number;
  y: number;
}

/** bridge.ts 暴露的桥接 API，挂在 window.goodPuppy。 */
export interface GoodPuppyBridge {
  getWindowPosition(): Promise<WindowPoint>;
  getWindowLayout(): Promise<WindowLayout>;
  setWindowPosition(position: WindowPoint): void;
  setWindowSize(size: WindowSize): void;
  /** 是否支持系统原生窗口拖拽；缺失时回退到手动跟随。 */
  supportsNativeWindowDrag(): boolean;
  /** 把本次手势交给系统接管（fire-and-forget）。 */
  startWindowDrag(): void;
  setIgnoreMouseEvents(shouldIgnore: boolean): void;
  /** 订阅原生光标流；返回取消订阅函数。 */
  onCursorMoved(callback: (point: CursorPoint | null) => void): () => void;
  /**
   * 订阅原生「鼠标左键松开」信号；返回取消订阅函数。
   * Windows 原生拖拽会吞掉 webview 的 pointerup，需要靠它判定拖拽结束。
   */
  onDragEnded(callback: () => void): () => void;
  getAppConfig(): AppConfig;
}

/** src/shared/appConfig.ts 的形状。 */
export interface AppConfig {
  supabase?: SupabaseConfig;
  [key: string]: unknown;
}

export interface SupabaseConfig {
  url?: string;
  publishableKey?: string;
}

// ── 房间在线状态（src/windows/pet/presence.ts）──────────────────────────────

/** 持续状态值：情绪 / 工作标签，无状态时为 null。取值见 animationCatalog.STATUS_OPTIONS。 */
export type PetStatus = string | null;

/** presence onPresenceChange 回调里的单个在线用户（已规范化）。 */
export interface PresenceUser {
  userId: string;
  status: PetStatus;
  petId: string;
  skin: string;
}

// ── 跨用户瞬时互动（src/windows/pet/interactions.ts）────────────────────────

/** 一次性互动事件；action 见 animationCatalog.INTERACTIONS。 */
export interface InteractionPayload {
  action: string;
  actorId: string;
  targetId: string;
}

// ── Supabase 行结构（详见 docs/database.md）────────────────────────────────

export interface MessageRow {
  id: string;
  room_id: string;
  sender_id: string;
  kind: string;
  content: string;
  created_at: string;
}

export interface ProfileRow {
  id: string;
  display_name: string;
  pet_id: string;
}

export interface LoungeProfile {
  id?: string;
  gp_id?: string;
  display_name?: string;
  pet_id?: string;
  skin?: string;
}

export interface LoungeMemberRow {
  room_id?: string;
  user_id: string;
  joined_at?: string;
  profiles?: LoungeProfile | null;
}

export interface LoungePresenceRow {
  current_room_id?: string | null;
  user_id: string;
  is_online?: boolean;
  last_seen?: string;
}

export interface MemberViewModel {
  userId: string;
  gpId: string;
  displayName: string;
  petId: string;
  skin: string;
  isSelf: boolean;
  isOnline: boolean;
}

export interface LoungeRoom {
  id: string;
  room_name: string;
  description: string;
  invite_code: string;
  created_by: string;
  members: MemberViewModel[];
}

export interface ConnectionRequestRow {
  id: string;
  from_id: string;
  room_id?: string | null;
  profiles?: LoungeProfile | null;
  rooms?: { id?: string; room_name?: string | null } | null;
}

export interface RoomAction {
  action: "enter" | "exit";
  label: string;
}

export interface RoomMemberRow {
  room_id: string;
}

/** 消息气泡使用的本地视图模型（src/windows/pet/messageLog.ts）。 */
export interface LocalMessage {
  id: string;
  info: string;
  from: string;
  created_at: string;
}

export interface PetManifestState {
  state?: string;
  durationsMs?: number[];
  [key: string]: unknown;
}

export interface PetManifestSkin {
  id: string;
  label: string;
}

export interface PetManifest {
  id: string;
  states: Record<string, PetManifestState>;
  skins: PetManifestSkin[];
}

declare global {
  interface Window {
    goodPuppy: GoodPuppyBridge;
    __TAURI_INTERNALS__?: unknown;
  }
}
