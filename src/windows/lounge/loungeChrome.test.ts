import { expect, it, vi } from "vitest";
import { createResourceLifetime } from "../../shared/resourceLifetime.js";
import { initLoungeChrome } from "./loungeChrome.js";
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: vi.fn() }));
it("has one primary-button drag path for static and dynamic chrome and releases it on unload", async () => {
  class Surface extends EventTarget {
    back = false;
    closest(selector: string) { return selector === ".settings-back" ? this.back ? this : null : this; }
    querySelector() { return null; }
  }
  const document = new Surface(); const drag = vi.fn(async () => {}); const page = createResourceLifetime();
  vi.stubGlobal("Element", Surface); vi.stubGlobal("document", document);
  vi.stubGlobal("navigator", { platform: "MacIntel" }); vi.stubGlobal("window", { goodPuppy: { startWindowDrag: drag } });
  const pointer = (button: number) => Object.assign(new Event("pointerdown"), { button });
  try {
    await initLoungeChrome(page);
    document.dispatchEvent(pointer(0)); document.dispatchEvent(Object.assign(new Event("mousedown"), { button: 0 }));
    expect(drag).toHaveBeenCalledOnce();
    document.dispatchEvent(pointer(2)); document.back = true; document.dispatchEvent(pointer(0));
    expect(drag).toHaveBeenCalledOnce();
    document.back = false; page.dispose(); document.dispatchEvent(pointer(0));
    expect(drag).toHaveBeenCalledOnce();
  } finally { page.dispose(); vi.unstubAllGlobals(); }
});
