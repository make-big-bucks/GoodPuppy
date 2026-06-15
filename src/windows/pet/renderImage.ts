type StateMeta = { mirrored?: boolean };

export function applyStateToImage(
  img: HTMLImageElement | null,
  path: string,
  meta: StateMeta,
  refreshPassthrough?: () => void,
) {
  if (!img) return;
  img.src = path;
  img.classList.toggle("is-mirrored", Boolean(meta?.mirrored));
  refreshPassthrough?.();
}
