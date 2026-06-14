import { createPetAvatar } from "./pet-avatar.js";

export function renderProfileCard(profile) {
  const root = document.querySelector(".lounge-profile-card");
  if (!root) return;

  root.innerHTML = "";
  root.appendChild(
    createPetAvatar({
      petId: profile?.pet_id,
      skin: profile?.skin,
      alt: profile?.display_name || "GoodPuppy",
    }),
  );

  const body = document.createElement("div");
  body.className = "profile-body";
  body.innerHTML = `
    <div class="profile-name-row">
      <button class="profile-name lounge-edit-display-name" type="button"></button>
      <button class="icon-btn lounge-edit-name-btn" type="button" aria-label="编辑用户名">✎</button>
    </div>
    <div class="profile-id-row">
      <span class="profile-id-label">ID</span>
      <span class="profile-id lounge-gp-id"></span>
      <button class="icon-btn lounge-copy-id-btn" type="button" data-copy="gp-id" aria-label="复制 ID">⧉</button>
    </div>
  `;
  body.querySelector(".profile-name").textContent = profile?.display_name || "GoodPuppy";
  body.querySelector(".profile-id").textContent = profile?.gp_id || "";
  root.appendChild(body);
}
