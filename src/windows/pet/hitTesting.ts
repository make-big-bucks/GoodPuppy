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
