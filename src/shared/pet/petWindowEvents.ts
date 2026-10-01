import type { BubbleScope } from "./bubbleScope.js";
// 跨窗口事件契约（协调者 ⇄ 远程呈现者，按 Tauri 窗口 label 定向）。
// 见 docs/superpowers/specs/2026-06-17-多窗口独立桌宠-phaseB-design.md。
import type { LocalMessage, WindowPoint } from "../../types";

/** 远程 pet 窗口 label：pet-<userId>。 */
export function petWindowLabel(userId: string) {
  return `pet-${userId}`;
}

/** 从远程 pet 窗口 label 还原 userId（非 pet 窗口返回 null）。 */
export function userIdFromLabel(label: string): string | null {
  return label.startsWith("pet-") ? label.slice("pet-".length) : null;
}

/** 自己气泡窗口的固定 label（整会话只隐藏不销毁，对齐 main）。 */
export const BUBBLE_SELF_LABEL = "bubble-self";

/** 某只 pet 的气泡子窗口 label：自己 = bubble-self；远程 = bubble-<userId>。 */
export function bubbleWindowLabel(userId: string) {
  return `bubble-${userId}`;
}

export const COORDINATOR_LABEL = "main";

// 协调者 → 呈现者（pet 窗口）
export const PET_STATE = "pet-state";
export const PET_INTERACTION = "pet-interaction";
export const PET_LEAVE = "pet-leave";
export const PET_MODE = "pet-mode";
export const PET_ARRANGE = "pet-arrange";

// 协调者/pet 窗口 → 气泡窗口（多窗口 Phase A：消息搬进独立气泡窗口）
export const PET_HISTORY = "pet-history";
export const PET_MESSAGE = "pet-message";
/** 撤销「已关闭」状态、重新展开堆叠（「查看对话/状态」触发）。 */
export const BUBBLE_SHOW = "bubble-show";
/** 协调者告知气泡窗口最终几何 + 朝向（上/下）。气泡窗口据此重设自身位置/尺寸并切
 * 堆叠锚点与小尾巴方向（窗口只能改自己，故由气泡窗口自行 setWindowBounds）。 */
export const BUBBLE_PLACEMENT = "bubble-placement";

/** 原生光标监视器逐 tick 告知该覆盖层窗口当前是否「可交互」（光标落在命中区内）。
 * 气泡窗口据此切关闭按钮的浮现，避免依赖窗口聚焦才更新的 CSS `:hover`（非 key 窗口
 * 收不到 mouseMoved，`:hover` 不刷新）。payload 为布尔。 */
export const OVERLAY_HOVER = "overlay-hover";

export type BubblePlacementPayload = {
  x: number;
  y: number;
  width: number;
  height: number;
  placement: "above" | "below";
};

// 自己写消息链路（记号棒搬进 bubble-self 后跨窗口回环，Phase A Slice B）
/** main →（自己右键「写消息」）→ bubble-self：展开记号棒并聚焦。 */
export const SELF_OPEN_COMPOSE = "self-open-compose";
/** bubble-self →（点发送）→ main：把文本交给协调者走 Supabase 插入。 */
export const SELF_COMPOSE_SUBMIT = "self-compose-submit";
/** main →（插入完成）→ bubble-self：回报结果，成功则收起记号棒，失败则显错。 */
export const SELF_COMPOSE_RESULT = "self-compose-result";

export type SelfComposeSubmitPayload = { requestId: string; text: string; roomId: string };
export type SelfComposeResultPayload = { requestId: string; ok: boolean; error?: string };

// 会客厅设置页 → 协调者（main）：远程遥控桌宠偏好，main 是唯一执行 + 落盘点。
/** 设置页改了「朋友摆放模式」。 */
export const PET_PREF_MODE = "pet-pref-mode";
/** 设置页改了「桌宠大小」。 */
export const PET_PREF_SCALE = "pet-pref-scale";

export type PetPrefModePayload = { mode: "free" | "semi" };
export type PetPrefScalePayload = { scale: number };

// 呈现者 → 协调者
export const PET_MOVED = "pet-moved";
export const PET_BUBBLE_SHOW_REQUEST = "pet-bubble-show-request";
export const PET_INTERACT_REQUEST = "pet-interact-request";

export type PetStatePayload = { petId: string; skin: string; status: string | null };
export type PetHistoryPayload = { messages: LocalMessage[]; scope?: BubbleScope | null };
export type PetMessagePayload = { message: LocalMessage; scope?: BubbleScope | null };
export type PetInteractionPayload = { state: string; mirrored: boolean; durationMs?: number };
export type PetModePayload = { draggable: boolean };
export type PetArrangePayload = WindowPoint;
export type PetMovedPayload = { userId: string; instanceId: string } & WindowPoint;
export type PetInteractRequestPayload = { action: string; targetId: string; instanceId: string };
