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

/**
 * 本窗口的「可交互命中形状」，由 webview 下发给原生，供光标监视器原生侧判定鼠标穿透
 * （像素级，免去逐帧 IPC 往返）。坐标均为窗口内容区 CSS 逻辑像素。见 bridge.publishHitShape。
 */
export interface PetHitShape {
  /** pet 剪影 alpha 掩模，行优先，1 = 不透明像素。 */
  mask: number[];
  maskCols: number;
  maskRows: number;
  /** 掩模覆盖的矩形 [x, y, w, h]（内容区像素）。 */
  maskRect: [number, number, number, number];
  /** 始终可交互的矩形（可见气泡 / 输入条），[x, y, w, h]。 */
  rects: [number, number, number, number][];
  /** 拖动期间整窗强制可交互，不受命中形状限制。 */
  forceInteractive: boolean;
}

/** bridge.ts 暴露的桥接 API，挂在 window.goodPuppy。 */
export interface GoodPuppyBridge {
  getWindowPosition(): Promise<WindowPoint>;
  /** 当前窗口外尺寸（逻辑像素）。 */
  getWindowSize(): Promise<WindowSize>;
  getWindowLayout(): Promise<WindowLayout>;
  /** 宠物窗口当前所在显示器的可用区域（逻辑像素），用于气泡边缘翻转判定。 */
  getMonitorWorkArea(): Promise<WindowPoint & WindowSize>;
  setWindowPosition(position: WindowPoint): void;
  setWindowSize(size: WindowSize): void;
  /** 原子化设置窗口位置+尺寸（单次 IPC），避免增高/翻转时的闪烁跳动。 */
  setWindowBounds(bounds: WindowPoint & WindowSize): void;
  /** 让置顶面板成为 key window，使记号棒输入框可接收键盘输入；返回是否成为 key window。 */
  setFocus(reason?: string): Promise<boolean>;
  /** 是否支持系统原生窗口拖拽；缺失时回退到手动跟随。 */
  supportsNativeWindowDrag(): boolean;
  /** 把本次手势交给系统接管（fire-and-forget）。 */
  startWindowDrag(): void;
  /** 下发本窗口的可交互命中形状给原生（原生据此判定鼠标穿透）。 */
  publishHitShape(shape: PetHitShape): void;
  /** 当前 webview 窗口的 label（"main" = 自己/协调者，"pet-<userId>" = 远程呈现者）。 */
  getWindowLabel(): string;
  /** 协调者请求 Rust 动态创建一只远程成员的 pet 窗口（label `pet-<userId>`）。 */
  spawnPetWindow(opts: { label: string; x: number; y: number; width: number; height: number }): Promise<void>;
  /** 协调者请求销毁某只远程 pet 窗口。 */
  closePetWindow(label: string): Promise<void>;
  /** 向指定窗口定向发送一个跨窗口事件（协调者 → 呈现者，或呈现者 → 协调者）。 */
  emitToWindow(label: string, event: string, payload?: unknown): Promise<void>;
  /** 订阅本窗口收到的跨窗口事件（含定向到本窗口的事件）；返回取消订阅函数。 */
  onAppEvent<T = unknown>(event: string, callback: (payload: T) => void): () => void;
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

export interface PendingRoomInvitationRow {
  id: string;
  from_id: string;
  room_id?: string | null;
  room_name?: string | null;
  profile_id?: string | null;
  gp_id?: string | null;
  display_name?: string | null;
  pet_id?: string | null;
  skin?: string | null;
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
