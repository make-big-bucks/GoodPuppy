import { describe, expect, it, vi } from "vitest";
import { applyStateToImage } from "./renderImage.js";

describe("applyStateToImage", () => {
  it("refreshes mouse passthrough immediately after changing the state image", () => {
    const image = {
      src: "/pets/shiba/idle.gif",
      classList: {
        toggle: vi.fn(),
      },
    } as unknown as HTMLImageElement;
    const refreshPassthrough = vi.fn();

    applyStateToImage(image, "/pets/shiba/happy.gif", { mirrored: false }, refreshPassthrough);

    expect(image.src).toBe("/pets/shiba/happy.gif");
    expect(refreshPassthrough).toHaveBeenCalledTimes(1);
  });
});
