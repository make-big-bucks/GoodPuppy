import { describe, expect, it } from "vitest";
import { isPointOpaqueInImage } from "./hitTesting.js";

function createElement(rect, classes = []) {
  return {
    getBoundingClientRect: () => rect,
    classList: {
      contains: (name) => classes.includes(name)
    }
  };
}

function createImage(width, height) {
  return {
    complete: true,
    naturalWidth: width,
    naturalHeight: height
  };
}

function createContextWithOpaquePixels(opaquePixels) {
  return {
    clearRect() {},
    drawImage() {},
    getImageData(x, y) {
      return {
        data: [0, 0, 0, opaquePixels.has(`${x},${y}`) ? 255 : 0]
      };
    }
  };
}

describe("isPointOpaqueInImage", () => {
  it("treats nearby opaque pixels as a hit to avoid animated edge flicker", () => {
    const element = createElement({ left: 0, top: 0, width: 100, height: 100 });
    const image = createImage(100, 100);
    const context = createContextWithOpaquePixels(new Set(["53,50"]));
    const canvas = {};

    expect(
      isPointOpaqueInImage(
        { clientX: 50, clientY: 50 },
        element,
        image,
        context,
        canvas,
        { alphaThreshold: 16, hitSlop: 3 }
      )
    ).toBe(true);
  });
});
