import { getStateImagePath } from "./animationCatalog.js";

type PetAvatarOptions = {
  petId?: string;
  skin?: string;
  alt?: string;
};

export function createPetAvatar({ petId = "default", skin = "default", alt = "" }: PetAvatarOptions = {}) {
  const wrapper = document.createElement("div");
  wrapper.className = "pet-avatar";

  const canvas = document.createElement("canvas");
  canvas.className = "pet-avatar-image";
  canvas.setAttribute("role", "img");
  canvas.setAttribute("aria-label", alt);

  const img = new Image();
  img.src = getStateImagePath(petId, "idle", skin);
  img.addEventListener(
    "load",
    () => {
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext("2d")?.drawImage(img, 0, 0);
    },
    { once: true },
  );
  img.addEventListener(
    "error",
    () => {
      wrapper.classList.add("is-fallback");
      canvas.remove();
      wrapper.textContent = "GP";
    },
    { once: true },
  );

  wrapper.appendChild(canvas);
  return wrapper;
}
