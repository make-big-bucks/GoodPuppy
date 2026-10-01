/** 每次打开注册、关闭释放；不保留已替换弹层的焦点监听。 */
export function bindDialogFocus(dialog: HTMLElement, close: () => void) {
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  dialog.setAttribute("role", "dialog");
  dialog.setAttribute("aria-modal", "true");
  dialog.tabIndex = -1;
  const controls = () => [...dialog.querySelectorAll<HTMLElement>("button, input, textarea, select, a[href], [tabindex]")]
    .filter((element) => !element.closest("[hidden]") && !element.hasAttribute("disabled") && element.tabIndex >= 0);
  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "Tab") return;
    const items = controls();
    const first = items[0]; const last = items.at(-1);
    if (!first) { event.preventDefault(); dialog.focus(); return; }
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) {
      event.preventDefault(); last?.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  };
  document.addEventListener("keydown", onKeydown);
  return () => {
    document.removeEventListener("keydown", onKeydown);
    if (previous?.isConnected && !previous.closest("[hidden]")) previous.focus();
  };
}
