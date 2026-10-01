import { DEFAULT_PET } from "./animationCatalog.js";
type StateMeta = { mirrored?: boolean };
const versions = new WeakMap<HTMLImageElement, number>();

export function applyStateToImage(img: HTMLImageElement | null, path: string, meta: StateMeta, refreshPassthrough?: () => void) {
  if (!img) return;
  const version = (versions.get(img) ?? 0) + 1;
  versions.set(img, version);
  const base = path.split("?")[0];
  const dir = base.match(/^\/pets\/([a-z0-9-]+)\//)?.[1] ?? DEFAULT_PET;
  const candidates = [...new Set([path, base.replace(/\/skins\/[a-z0-9-]+\//, "/"), `/pets/${dir}/idle.gif`, `/pets/${DEFAULT_PET}/idle.gif`])];
  let index = 0;
  img.onerror = () => {
    if (versions.get(img) !== version || index + 1 >= candidates.length) return;
    img.src = candidates[++index];
    refreshPassthrough?.();
  };
  img.src = path;
  img.classList.toggle("is-mirrored", Boolean(meta?.mirrored));
  refreshPassthrough?.();
}
