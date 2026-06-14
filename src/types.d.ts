// 全仓库的数据契约类型定义（JSDoc + 渐进式 TS 的起点）。
//
// 用途：给跨窗口 / 跨网络 / 前端 ↔ Rust 的「契约型」数据上类型，
// 让编辑器对 window.goodPuppy.*、presence / interaction payload、Supabase 行结构
// 提供自动补全与悬浮文档。当前不强制类型检查（jsconfig 里 checkJs:false）——
// 想对某个文件开启检查，在文件首行加 `// @ts-check` 即可。
//
// 在 .js 里引用：JSDoc 中用 `import("../../types").PresenceUser` 形式。
// window.goodPuppy 因下方 `declare global` 自动全局可见，无需 import。

// ── 前端 ↔ Rust 桥接（src/shared/bridge.js 暴露在 window.goodPuppy）─────────

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

/** bridge.js 暴露的桥接 API，挂在 window.goodPuppy。 */
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
  getAppConfig(): AppConfig;
}

/** src/shared/appConfig.js 的形状。 */
export interface AppConfig {
  supabaseUrl?: string;
  supabasePublishableKey?: string;
  [key: string]: unknown;
}

// ── 房间在线状态（src/windows/pet/presence.js）──────────────────────────────

/** 持续状态值：情绪 / 工作标签，无状态时为 null。取值见 animationCatalog.STATUS_OPTIONS。 */
export type PetStatus = string | null;

/** presence onPresenceChange 回调里的单个在线用户（已规范化）。 */
export interface PresenceUser {
  userId: string;
  status: PetStatus;
  petId: string;
  skin: string;
}

// ── 跨用户瞬时互动（src/windows/pet/interactions.js）────────────────────────

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

export interface RoomMemberRow {
  room_id: string;
}

/** 消息气泡使用的本地视图模型（src/windows/pet/messageLog.js）。 */
export interface LocalMessage {
  id: string;
  info: string;
  from: string;
  created_at: string;
}

declare global {
  interface Window {
    goodPuppy: GoodPuppyBridge;
  }
}
