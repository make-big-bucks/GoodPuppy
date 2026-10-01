import { describe, expect, it, vi } from "vitest";
import { buildAlphaMask, isPointInAlphaMask } from "./hitTesting.js";

function fixture(width = 10, height = 10, mirrored = false, rect = { left: 0, top: 0, width, height }) {
  const data = new Uint8ClampedArray(width * height * 4);
  const element = { getBoundingClientRect: () => rect, classList: { contains: () => mirrored } } as unknown as HTMLElement;
  const image = { complete: true, naturalWidth: width, naturalHeight: height } as HTMLImageElement;
  const context = { clearRect: vi.fn(), drawImage: vi.fn(), getImageData: vi.fn(() => ({ data })) };
  const canvas = {} as HTMLCanvasElement;
  return { element, image, context, canvas, opaque: (x: number, y: number, alpha = 255) => { data[(y * width + x) * 4 + 3] = alpha; },
    build: (options = {}) => buildAlphaMask(element, image, context as unknown as CanvasRenderingContext2D, canvas, options) };
}
describe("shared alpha mask geometry", () => {
  it("retains a thin silhouette outside the cell center and reads pixels once", () => {
    const f = fixture(); f.opaque(0, 0); const mask = f.build();
    expect(mask?.mask).toEqual([1, 0, 0, 0]);
    expect(f.context.getImageData).toHaveBeenCalledTimes(1);
    expect(isPointInAlphaMask({ clientX: 1, clientY: 1 }, mask)).toBe(true);
    expect(isPointInAlphaMask({ clientX: 8, clientY: 8 }, mask)).toBe(false);
  });
  it("encodes edge tolerance into the same mask used by clicks", () => {
    const f = fixture(15, 15); f.opaque(7, 7);
    expect(isPointInAlphaMask({ clientX: 1, clientY: 1 }, f.build())).toBe(false);
    const padded = f.build({ hitSlop: 3 });
    expect(isPointInAlphaMask({ clientX: 1, clientY: 1 }, padded)).toBe(true);
    expect(isPointInAlphaMask({ clientX: -1, clientY: 1 }, padded)).toBe(false);
  });
  it("normalizes non-divisible rectangles into equal cells", () => {
    const f = fixture(12, 5); f.opaque(4, 2); const mask = f.build();
    expect(mask?.maskCols).toBe(3); expect(mask?.mask).toEqual([0, 1, 0]);
    expect(isPointInAlphaMask({ clientX: 4, clientY: 2 }, mask)).toBe(true);
    expect(isPointInAlphaMask({ clientX: 3.99, clientY: 2 }, mask)).toBe(false);
  });
  it("preserves object-fit placement and mirrored source coordinates", () => {
    const f = fixture(10, 5, true, { left: 10, top: 20, width: 100, height: 100 }); f.opaque(0, 0);
    const mask = f.build(); expect(mask?.maskRect).toEqual([10, 45, 100, 50]);
    expect(isPointInAlphaMask({ clientX: 105, clientY: 46 }, mask)).toBe(true);
    expect(isPointInAlphaMask({ clientX: 11, clientY: 46 }, mask)).toBe(false);
  });
  it("matches native inclusive outer boundaries and alpha threshold", () => {
    const f = fixture(); f.opaque(9, 9, 17); f.opaque(0, 0, 16); const mask = f.build({ alphaThreshold: 16 });
    expect(isPointInAlphaMask({ clientX: 0, clientY: 0 }, mask)).toBe(false);
    expect(isPointInAlphaMask({ clientX: 10, clientY: 10 }, mask)).toBe(true);
    expect(isPointInAlphaMask({ clientX: 10.01, clientY: 10 }, mask)).toBe(false);
    expect(isPointInAlphaMask({ clientX: 1, clientY: 1 }, null)).toBe(false);
  });
});
