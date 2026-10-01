import { afterEach, describe, expect, it, vi } from "vitest";
import { bindDialogFocus } from "./dialogFocus.js";

function fixture() {
  class Element {
    isConnected = true;
    tabIndex = 0;
    hidden = false;
    disabled = false;
    focus = vi.fn(() => { doc.activeElement = this; });
    closest() { return this.hidden ? this : null; }
    hasAttribute() { return this.disabled; }
  }
  const previous = new Element(); const first = new Element(); const last = new Element();
  const handlers = new Map<string, (event: any) => void>();
  const doc = { activeElement: previous,
    addEventListener: (name: string, handler: any) => handlers.set(name, handler),
    removeEventListener: (name: string, handler: any) => { if (handlers.get(name) === handler) handlers.delete(name); } };
  vi.stubGlobal("HTMLElement", Element); vi.stubGlobal("document", doc);
  const dialog = { setAttribute: vi.fn(), querySelectorAll: () => [first, last],
    contains: (element: Element) => element === first || element === last, focus: vi.fn(), tabIndex: 0 };
  const key = (value: string, shiftKey = false) => {
    const event = { key: value, shiftKey, preventDefault: vi.fn(), stopPropagation: vi.fn() };
    handlers.get("keydown")?.(event); return event;
  };
  return { doc, first, last, previous, handlers, dialog, binding: dialog as unknown as HTMLElement, key };
}
afterEach(() => vi.unstubAllGlobals());
describe("dialog keyboard ownership", () => {
  it("wraps Tab in both directions and closes with Escape", () => {
    const f = fixture(); const close = vi.fn(); const dispose = bindDialogFocus(f.binding, close);
    f.doc.activeElement = f.last; expect(f.key("Tab").preventDefault).toHaveBeenCalled();
    expect(f.first.focus).toHaveBeenCalled();
    f.key("Tab", true); expect(f.last.focus).toHaveBeenCalled();
    f.key("Escape"); expect(close).toHaveBeenCalledTimes(1);
    dispose(); expect(f.handlers.size).toBe(0); expect(f.previous.focus).toHaveBeenCalled();
  });
  it("keeps focus on the dialog when controls are disabled and skips a hidden return target", () => {
    const f = fixture(); f.first.disabled = f.last.disabled = true;
    const dispose = bindDialogFocus(f.binding, () => {});
    f.key("Tab"); expect(f.dialog.focus).toHaveBeenCalled();
    f.previous.hidden = true; dispose(); expect(f.previous.focus).not.toHaveBeenCalled();
  });
});
