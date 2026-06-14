import { createPetAvatar } from "./pet-avatar.js";
import type { LoungeProfile } from "../../../types";

const guestAvatarSvg = `<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.6-7 8-7s8 3 8 7"/></svg>`;

function createGuestAvatar() {
  const wrapper = document.createElement("div");
  wrapper.className = "pet-avatar guest-avatar";
  wrapper.innerHTML = guestAvatarSvg;
  return wrapper;
}

export function renderProfileCard(profile: LoungeProfile | null | undefined) {
  const root = document.querySelector<HTMLElement>(".lounge-profile-card");
  if (!root) return;

  root.innerHTML = "";

  if (!profile) {
    root.appendChild(createGuestAvatar());
    const body = document.createElement("div");
    body.className = "profile-body";
    body.innerHTML = `<div class="profile-name-row"><span class="unauth-profile-name">未登录</span></div>`;
    root.appendChild(body);
    return;
  }

  root.appendChild(
    createPetAvatar({
      petId: profile.pet_id,
      skin: profile.skin,
      alt: profile.display_name || "GoodPuppy",
    }),
  );

  const body = document.createElement("div");
  body.className = "profile-body";
  body.innerHTML = `
    <div class="profile-name-row">
      <button class="profile-name lounge-edit-display-name" type="button"></button>
      <button class="icon-btn lounge-edit-name-btn" type="button" aria-label="编辑用户名"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4Z"/></svg></button>
    </div>
    <div class="profile-id-row">
      <span class="profile-id-label">ID</span>
      <span class="profile-id lounge-gp-id"></span>
      <button class="icon-btn lounge-copy-id-btn" type="button" data-copy="gp-id" aria-label="复制 ID"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg></button>
    </div>
  `;
  const profileName = body.querySelector<HTMLButtonElement>(".profile-name");
  const profileId = body.querySelector<HTMLElement>(".profile-id");
  if (profileName) profileName.textContent = profile.display_name || "GoodPuppy";
  if (profileId) profileId.textContent = profile.gp_id || "";
  root.appendChild(body);
}
