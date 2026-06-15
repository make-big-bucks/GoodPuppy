import { PetAnimator } from "./petState.js";
import { loadPetManifest, durationFromManifest } from "./animationCatalog.js";
import { getPetWindowLayout, orderRemotePetIds } from "./petLayout.js";
import type { PresenceUser } from "../../types";

type RemotePetEntry = {
  element: HTMLElement;
  animator: PetAnimator;
  leaving: boolean;
  removeTimer: ReturnType<typeof setTimeout> | null;
};

type StateMeta = { mirrored?: boolean };

let petStageEl: HTMLElement | null = null;
let selfAreaEl: HTMLElement | null = null;
let getPetScale: () => number = () => 1;
let onRefreshPassthrough: () => void = () => {};
let onSelfGreet: () => void = () => {};

const remotePetsMap = new Map<string, RemotePetEntry>();

function applyStateToImage(img: HTMLImageElement | null, path: string, meta: StateMeta) {
  if (!img) return;
  img.src = path;
  img.classList.toggle("is-mirrored", Boolean(meta?.mirrored));
}

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
}) {
  petStageEl = opts.stage;
  selfAreaEl = opts.selfArea;
  getPetScale = opts.getPetScale;
  onRefreshPassthrough = opts.onRefreshPassthrough;
  onSelfGreet = opts.onSelfGreet;
}

function createRemotePetElement(userId: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "dog-area remote-pet";
  section.dataset.user = "remote";
  section.dataset.userId = userId;
  section.setAttribute("aria-label", "Remote puppy");
  section.innerHTML = `
    <div class="message-bubble" role="status" aria-live="polite" data-user="remote" hidden>
      <span class="message-alert" aria-hidden="true">!</span>
      <div class="bubble-content">
        <div class="bubble-text"></div>
        <div class="bubble-nav" aria-label="Message navigation">
          <button class="bubble-nav-button bubble-prev" type="button" aria-label="Previous message">&lt;</button>
          <button class="bubble-nav-button bubble-next" type="button" aria-label="Next message">&gt;</button>
        </div>
      </div>
    </div>
    <img class="pet-image" data-user="remote" alt="Remote puppy" draggable="false" />
  `;
  const img = section.querySelector<HTMLImageElement>(".pet-image");
  img?.addEventListener("load", onRefreshPassthrough);
  petStageEl?.appendChild(section);
  return section;
}

export function relayoutRemotePets() {
  const ids = orderRemotePetIds([...remotePetsMap.keys()]);
  ids.forEach((userId, index) => {
    remotePetsMap.get(userId)?.element.style.setProperty("--pet-index", String(index + 1));
  });
  selfAreaEl?.style.setProperty("--pet-index", "0");
  window.goodPuppy.setWindowSize(getPetWindowLayout(ids.length, getPetScale()));
  onRefreshPassthrough();
}

export function clearRemotePets() {
  for (const entry of remotePetsMap.values()) {
    if (entry.removeTimer != null) clearTimeout(entry.removeTimer);
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
    onState: (_state, path, meta) => applyStateToImage(img, path, meta),
  });
  loadPetManifest(info.petId).then((manifest) => animator.setManifest(manifest));
  const entry: RemotePetEntry = { element, animator, leaving: false, removeTimer: null };
  remotePetsMap.set(userId, entry);
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

export function showRemoteBubble(userId: string) {
  const element = remotePetsMap.get(userId)?.element;
  const bubble = element?.querySelector<HTMLElement>(".message-bubble");
  const text = bubble?.querySelector<HTMLElement>(".bubble-text");
  if (!bubble || !text) return;
  text.textContent = "在线";
  bubble.hidden = false;
  onRefreshPassthrough();
}
