type PointLike = { clientX: number; clientY: number };

type HitOptions = {
  respectObjectFit?: boolean;
  alphaThreshold?: number;
  hitSlop?: number;
};

function getObjectFitContainRect(element: HTMLElement, image: HTMLImageElement) {
  const rect = element.getBoundingClientRect();
  const imageRatio = image.naturalWidth / image.naturalHeight;
  const elementRatio = rect.width / rect.height;

  if (elementRatio > imageRatio) {
    const width = rect.height * imageRatio;
    return {
      left: rect.left + (rect.width - width) / 2,
      top: rect.top,
      width,
      height: rect.height,
    };
  }

  const height = rect.width / imageRatio;
  return {
    left: rect.left,
    top: rect.top + (rect.height - height) / 2,
    width: rect.width,
    height,
  };
}

function getHitOffsets(hitSlop: number) {
  if (!hitSlop || hitSlop <= 0) {
    return [{ x: 0, y: 0 }];
  }

  return [
    { x: 0, y: 0 },
    { x: hitSlop, y: 0 },
    { x: -hitSlop, y: 0 },
    { x: 0, y: hitSlop },
    { x: 0, y: -hitSlop },
    { x: hitSlop, y: hitSlop },
    { x: hitSlop, y: -hitSlop },
    { x: -hitSlop, y: hitSlop },
    { x: -hitSlop, y: -hitSlop },
  ];
}

function isFlipped(element: Element) {
  return element.classList.contains("is-mirrored");
}

export type AlphaMask = {
  /** Row-major opacity grid, 1 = opaque cell. */
  mask: number[];
  maskCols: number;
  maskRows: number;
  /** [x, y, w, h] of the displayed (object-fit) image in content px. */
  maskRect: [number, number, number, number];
};

type MaskOptions = {
  /** Cell size in CSS px; smaller = finer silhouette, larger payload. */
  cellSize?: number;
  alphaThreshold?: number;
  respectObjectFit?: boolean;
};

/**
 * Rasterize the image's alpha into a coarse opacity grid over its displayed rect,
 * in window-content coords. Native uses this to decide mouse passthrough without a
 * per-move IPC round-trip. Uses the same object-fit / flip / alpha logic as
 * `isPointOpaqueInImage`, so the published shape matches on-event hit testing.
 */
export function buildAlphaMask(
  element: HTMLElement,
  image: HTMLImageElement,
  hitContext: CanvasRenderingContext2D | null,
  hitCanvas: HTMLCanvasElement,
  { cellSize = 5, alphaThreshold = 16, respectObjectFit = true }: MaskOptions = {},
): AlphaMask | null {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || !hitContext) {
    return null;
  }

  const renderRect = respectObjectFit ? getObjectFitContainRect(element, image) : element.getBoundingClientRect();
  if (renderRect.width <= 0 || renderRect.height <= 0) {
    return null;
  }

  const maskCols = Math.max(1, Math.ceil(renderRect.width / cellSize));
  const maskRows = Math.max(1, Math.ceil(renderRect.height / cellSize));

  hitCanvas.width = image.naturalWidth;
  hitCanvas.height = image.naturalHeight;
  hitContext.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
  hitContext.drawImage(image, 0, 0, hitCanvas.width, hitCanvas.height);
  const data = hitContext.getImageData(0, 0, hitCanvas.width, hitCanvas.height).data;

  const flipped = isFlipped(element);
  const mask = new Array<number>(maskCols * maskRows).fill(0);
  for (let row = 0; row < maskRows; row++) {
    for (let col = 0; col < maskCols; col++) {
      const localX = (col + 0.5) * cellSize;
      const localY = (row + 0.5) * cellSize;
      let sampleX = Math.min(
        image.naturalWidth - 1,
        Math.max(0, Math.floor((localX / renderRect.width) * image.naturalWidth)),
      );
      const sampleY = Math.min(
        image.naturalHeight - 1,
        Math.max(0, Math.floor((localY / renderRect.height) * image.naturalHeight)),
      );
      if (flipped) {
        sampleX = image.naturalWidth - 1 - sampleX;
      }
      const alpha = data[(sampleY * image.naturalWidth + sampleX) * 4 + 3];
      if (alpha > alphaThreshold) {
        mask[row * maskCols + col] = 1;
      }
    }
  }

  return {
    mask,
    maskCols,
    maskRows,
    maskRect: [renderRect.left, renderRect.top, renderRect.width, renderRect.height],
  };
}

export function isPointOpaqueInImage(
  point: PointLike,
  element: HTMLElement,
  image: HTMLImageElement,
  hitContext: CanvasRenderingContext2D | null,
  hitCanvas: HTMLCanvasElement,
  { respectObjectFit = false, alphaThreshold = 16, hitSlop = 0 }: HitOptions = {},
) {
  if (!image.complete || !image.naturalWidth || !image.naturalHeight || !hitContext) {
    return false;
  }

  const renderRect = respectObjectFit ? getObjectFitContainRect(element, image) : element.getBoundingClientRect();
  const localX = point.clientX - renderRect.left;
  const localY = point.clientY - renderRect.top;

  if (localX < 0 || localY < 0 || localX > renderRect.width || localY > renderRect.height) {
    return false;
  }

  hitCanvas.width = image.naturalWidth;
  hitCanvas.height = image.naturalHeight;
  hitContext.clearRect(0, 0, hitCanvas.width, hitCanvas.height);
  hitContext.drawImage(image, 0, 0, hitCanvas.width, hitCanvas.height);

  for (const offset of getHitOffsets(hitSlop)) {
    const sampleLocalX = localX + offset.x;
    const sampleLocalY = localY + offset.y;

    if (
      sampleLocalX < 0 ||
      sampleLocalY < 0 ||
      sampleLocalX > renderRect.width ||
      sampleLocalY > renderRect.height
    ) {
      continue;
    }

    let sampleX = Math.min(
      image.naturalWidth - 1,
      Math.max(0, Math.floor((sampleLocalX / renderRect.width) * image.naturalWidth)),
    );
    const sampleY = Math.min(
      image.naturalHeight - 1,
      Math.max(0, Math.floor((sampleLocalY / renderRect.height) * image.naturalHeight)),
    );

    if (isFlipped(element)) {
      sampleX = image.naturalWidth - 1 - sampleX;
    }

    if (hitContext.getImageData(sampleX, sampleY, 1, 1).data[3] > alphaThreshold) {
      return true;
    }
  }

  return false;
}
