type PointLike = { clientX: number; clientY: number };

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
  hitSlop?: number;
};

/**
 * Rasterize the image's alpha into a coarse opacity grid over its displayed rect,
 * in window-content coords. Native uses this to decide mouse passthrough without a
 * per-move IPC round-trip. The same published grid is used for frontend clicks.
 */
export function buildAlphaMask(
  element: HTMLElement,
  image: HTMLImageElement,
  hitContext: CanvasRenderingContext2D | null,
  hitCanvas: HTMLCanvasElement,
  { cellSize = 5, alphaThreshold = 16, respectObjectFit = true, hitSlop = 0 }: MaskOptions = {},
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
  // 取每格覆盖像素的最大 alpha，避免细尾巴等特征刚好落在格子中心之外。
  // 格子按显示矩形等分，与原生判定一致（宽高不整除 cellSize 时也不偏移）。
  for (let row = 0; row < maskRows; row++) {
    const y0 = Math.floor(row * image.naturalHeight / maskRows);
    const y1 = Math.ceil((row + 1) * image.naturalHeight / maskRows);
    for (let col = 0; col < maskCols; col++) {
      const x0 = Math.floor(col * image.naturalWidth / maskCols);
      const x1 = Math.ceil((col + 1) * image.naturalWidth / maskCols);
      scan: for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const sampleX = flipped ? image.naturalWidth - 1 - x : x;
          if (data[(y * image.naturalWidth + sampleX) * 4 + 3] > alphaThreshold) {
            mask[row * maskCols + col] = 1;
            break scan;
          }
        }
      }
    }
  }
  // 容错预先编码进同一掩模；粗网格向外取整，不在事件阶段另做像素采样。
  if (hitSlop > 0) {
    const original = mask.slice();
    const radiusX = Math.ceil(hitSlop * maskCols / renderRect.width);
    const radiusY = Math.ceil(hitSlop * maskRows / renderRect.height);
    for (let row = 0; row < maskRows; row++) for (let col = 0; col < maskCols; col++) {
      if (!original[row * maskCols + col]) continue;
      for (let y = Math.max(0, row - radiusY); y <= Math.min(maskRows - 1, row + radiusY); y++) {
        for (let x = Math.max(0, col - radiusX); x <= Math.min(maskCols - 1, col + radiusX); x++) mask[y * maskCols + x] = 1;
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

/** 与 Rust shape_is_interactive 相同的坐标归一化和边界夹取。 */
export function isPointInAlphaMask(point: PointLike, shape: AlphaMask | null) {
  if (!shape) return false;
  const [x, y, width, height] = shape.maskRect;
  if (width <= 0 || height <= 0 || shape.maskCols <= 0 || shape.maskRows <= 0) return false;
  if (point.clientX < x || point.clientY < y || point.clientX > x + width || point.clientY > y + height) return false;
  const col = Math.min(shape.maskCols - 1, Math.floor((point.clientX - x) / width * shape.maskCols));
  const row = Math.min(shape.maskRows - 1, Math.floor((point.clientY - y) / height * shape.maskRows));
  return Boolean(shape.mask[row * shape.maskCols + col]);
}
