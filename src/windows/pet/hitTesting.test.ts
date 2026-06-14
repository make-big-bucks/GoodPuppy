import { describe, expect, it } from "vitest";
import { isPointOpaqueInImage } from "./hitTesting.js";

type RectStub = {
  left: number;
  top: number;
  width: number;
  height: number;
};

function createElement(rect: RectStub, classes: string[] = []) {
  return {
    getBoundingClientRect: () => rect,
    classList: {
      contains: (name: string) => classes.includes(name),
    },
  } as unknown as HTMLElement;
}

function createImage(width: number, height: number) {
  return {
    complete: true,
    naturalWidth: width,
    naturalHeight: height,
  } as HTMLImageElement;
}

function createContextWithOpaquePixels(opaquePixels: Set<string>) {
  return {
    clearRect() {},
    drawImage() {},
    getImageData(x: number, y: number) {
      return {
        data: [0, 0, 0, opaquePixels.has(`${x},${y}`) ? 255 : 0],
      };
    },
  } as unknown as CanvasRenderingContext2D;
}

describe("isPointOpaqueInImage", () => {
  it("treats nearby opaque pixels as a hit to avoid animated edge flicker", () => {
    const element = createElement({ left: 0, top: 0, width: 100, height: 100 });
    const image = createImage(100, 100);
    const context = createContextWithOpaquePixels(new Set(["53,50"]));
    const canvas = {} as HTMLCanvasElement;

    expect(
      isPointOpaqueInImage(
        { clientX: 50, clientY: 50 },
        element,
        image,
        context,
        canvas,
        { alphaThreshold: 16, hitSlop: 3 },
      ),
    ).toBe(true);
  });
});
