import { getStateImagePath } from "../../pet/animationCatalog.js";

type PetAvatarOptions = {
  petId?: string;
  skin?: string;
  alt?: string;
};

export function createPetAvatar({ petId = "default", skin = "default", alt = "" }: PetAvatarOptions = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "pet-avatar";

  const img = document.createElement("img");
  img.className = "pet-avatar-image";
  img.alt = alt;
  img.draggable = false;
  img.src = getStateImagePath(petId, "idle", skin);
  img.addEventListener(
    "error",
    () => {
      wrapper.classList.add("is-fallback");
      img.remove();
      wrapper.textContent = "GP";
    },
    { once: true },
  );

  wrapper.appendChild(img);
  return wrapper;
}
