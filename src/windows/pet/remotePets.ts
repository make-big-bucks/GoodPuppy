import { PetAnimator } from "./petState.js";
import { loadPetManifest, durationFromManifest } from "./animationCatalog.js";
import { orderRemotePetIds } from "./petLayout.js";
import { applyStateToImage } from "./renderImage.js";
import { mountStack, clearArea, showArea } from "./messageBubble.js";
import type { PresenceUser } from "../../types";

type RemotePetEntry = {
  element: HTMLElement;
  animator: PetAnimator;
  leaving: boolean;
  removeTimer: ReturnType<typeof setTimeout> | null;
};

let petStageEl: HTMLElement | null = null;
let selfAreaEl: HTMLElement | null = null;
let getPetScale: () => number = () => 1;
let onRefreshPassthrough: () => void = () => {};
let onSelfGreet: () => void = () => {};
let onRelayout: () => void = () => {};
let onRemotePetCreated: (userId: string, area: HTMLElement) => void = () => {};

const remotePetsMap = new Map<string, RemotePetEntry>();

function closestFromEvent<T extends Element>(
  event: { target: EventTarget | null },
  selector: string,
) {
  const target = event.target instanceof Element ? event.target : null;
  return target?.closest(selector) as T | null;
}

export function initRemotePets(opts: {
  stage: HTMLElement;
  selfArea: HTMLElement;
  getPetScale: () => number;
  onRefreshPassthrough: () => void;
  onSelfGreet: () => void;
  onRelayout: () => void;
  onRemotePetCreated?: (userId: string, area: HTMLElement) => void;
}) {
  petStageEl = opts.stage;
  selfAreaEl = opts.selfArea;
  getPetScale = opts.getPetScale;
  onRefreshPassthrough = opts.onRefreshPassthrough;
  onSelfGreet = opts.onSelfGreet;
  onRelayout = opts.onRelayout;
  onRemotePetCreated = opts.onRemotePetCreated ?? (() => {});
}

function createRemotePetElement(userId: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "dog-area remote-pet";
  section.dataset.user = "remote";
  section.dataset.userId = userId;
  section.setAttribute("aria-label", "Remote puppy");
  section.innerHTML = `
    <div class="bubble-stack" role="log" aria-live="polite" aria-label="Messages" data-user="remote" hidden>
      <button class="bubble-close" type="button" aria-label="Close messages">&times;</button>
    </div>
    <img class="pet-image" data-user="remote" alt="Remote puppy" draggable="false" />
  `;
  const img = section.querySelector<HTMLImageElement>(".pet-image");
  img?.addEventListener("load", onRefreshPassthrough);
  petStageEl?.appendChild(section);
  mountStack(section);
  return section;
}

export function relayoutRemotePets() {
  const ids = orderRemotePetIds([...remotePetsMap.keys()]);
  ids.forEach((userId, index) => {
    remotePetsMap.get(userId)?.element.style.setProperty("--pet-index", String(index + 1));
  });
  selfAreaEl?.style.setProperty("--pet-index", "0");
  // 窗口尺寸由 renderer 的布局编排统一处理（需同时考虑气泡纵向空间）。
  onRelayout();
}

export function getRemotePetCount(): number {
  return remotePetsMap.size;
}

export function clearRemotePets() {
  for (const entry of remotePetsMap.values()) {
    if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
    clearArea(entry.element);
    entry.animator.destroy();
    entry.element.remove();
  }
  remotePetsMap.clear();
  relayoutRemotePets();
}

function createRemotePet(userId: string, info: PresenceUser): RemotePetEntry {
  const element = createRemotePetElement(userId);
  const img = element.querySelector<HTMLImageElement>(".pet-image");
  const animator = new PetAnimator({
    petId: info.petId,
    skin: info.skin,
    onState: (_state, path, meta) => applyStateToImage(img, path, meta, onRefreshPassthrough),
  });
  loadPetManifest(info.petId).then((manifest) => animator.setManifest(manifest));
  const entry: RemotePetEntry = { element, animator, leaving: false, removeTimer: null };
  remotePetsMap.set(userId, entry);
  onRemotePetCreated(userId, element);
  return entry;
}

export function applyPresence(users: PresenceUser[]) {
  const byId = new Map(users.map((u) => [u.userId, u]));
  const onlineSet = new Set(byId.keys());

  for (const [userId, entry] of remotePetsMap) {
    if (onlineSet.has(userId) || entry.leaving) continue;
    entry.leaving = true;
    entry.animator.playTransient("leave");
    const ms = durationFromManifest(entry.animator.manifest?.states?.["leave"]);
    entry.removeTimer = setTimeout(() => {
      clearArea(entry.element);
      entry.animator.destroy();
      entry.element.remove();
      remotePetsMap.delete(userId);
      relayoutRemotePets();
    }, ms);
  }

  for (const userId of onlineSet) {
    const info = byId.get(userId);
    if (!info) continue;
    let entry = remotePetsMap.get(userId);
    if (!entry) {
      entry = createRemotePet(userId, info);
      entry.animator.playTransient("enter");
      onSelfGreet();
    } else if (entry.leaving) {
      entry.leaving = false;
      if (entry.removeTimer != null) {
        clearTimeout(entry.removeTimer);
        entry.removeTimer = null;
      }
    }
    entry.animator.setPetId(info.petId);
    entry.animator.setSkin(info.skin);
    entry.animator.setStatus(info.status);
  }

  relayoutRemotePets();
}

export function getDogAreaForEvent(event: { target: EventTarget | null }): HTMLElement | null {
  return closestFromEvent<HTMLElement>(event, ".dog-area");
}

export function getPetIdentityForEvent(
  event: { target: EventTarget | null },
): { kind: "self" | "remote"; id: string } {
  const area = getDogAreaForEvent(event);
  if (!area) return { kind: "self", id: "self" };
  if (area.dataset.user === "remote" && area.dataset.userId) {
    return { kind: "remote", id: area.dataset.userId };
  }
  return { kind: "self", id: "self" };
}

export function getPetLayoutIndex(userId: string, selfAuthId: string | null): number | null {
  if (userId === selfAuthId || userId === "self") return 0;
  const index = orderRemotePetIds([...remotePetsMap.keys()]).indexOf(userId);
  return index === -1 ? null : index + 1;
}

export function animatorForRemoteUser(userId: string): PetAnimator | null {
  return remotePetsMap.get(userId)?.animator ?? null;
}

/** 取某远程宠物的 dog-area（用于把其主人的消息路由到该宠物头上的堆叠）。 */
export function getRemotePetArea(userId: string): HTMLElement | null {
  return remotePetsMap.get(userId)?.element ?? null;
}

/** 远程右键「查看状态」：重新展开该宠物已被关闭的消息堆叠。 */
export function showRemoteBubble(userId: string) {
  const area = remotePetsMap.get(userId)?.element;
  if (!area) return;
  showArea(area);
  onRefreshPassthrough();
}
