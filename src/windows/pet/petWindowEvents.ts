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

export const COORDINATOR_LABEL = "main";

// 协调者 → 呈现者
export const PET_STATE = "pet-state";
export const PET_HISTORY = "pet-history";
export const PET_MESSAGE = "pet-message";
export const PET_INTERACTION = "pet-interaction";
export const PET_LEAVE = "pet-leave";
export const PET_MODE = "pet-mode";
export const PET_ARRANGE = "pet-arrange";

// 呈现者 → 协调者
export const PET_MOVED = "pet-moved";
export const PET_INTERACT_REQUEST = "pet-interact-request";

export type PetStatePayload = { petId: string; skin: string; status: string | null };
export type PetHistoryPayload = { messages: LocalMessage[] };
export type PetMessagePayload = { message: LocalMessage };
export type PetInteractionPayload = { state: string; mirrored: boolean; durationMs?: number };
export type PetModePayload = { draggable: boolean };
export type PetArrangePayload = WindowPoint;
export type PetMovedPayload = { userId: string } & WindowPoint;
export type PetInteractRequestPayload = { action: string; targetId: string };
