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

it("falls back from a missing skin/state and never loops past default idle", () => {
  const image = { src: "", classList: { toggle: vi.fn() }, onerror: null } as unknown as HTMLImageElement;
  applyStateToImage(image, "/pets/shiba/skins/blue/feed.gif", {});
  const error = () => image.onerror?.(new Event("error") as never);
  error(); expect(image.src).toBe("/pets/shiba/feed.gif");
  error(); expect(image.src).toBe("/pets/shiba/idle.gif");
  error(); expect(image.src).toBe("/pets/shiba/idle.gif");
});

it("ignores an old image error handler after the desired state changed", () => {
  const image = { src: "", classList: { toggle: vi.fn() }, onerror: null } as unknown as HTMLImageElement;
  applyStateToImage(image, "/pets/shiba/feed.gif", {}); const old = image.onerror;
  applyStateToImage(image, "/pets/shiba/happy.gif", {}); old?.call(image, new Event("error") as never);
  expect(image.src).toBe("/pets/shiba/happy.gif");
});
