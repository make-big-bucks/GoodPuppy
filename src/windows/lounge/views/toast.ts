export type ToastType = "error" | "info" | "success";

function getContainer(): HTMLElement {
  let container = document.querySelector<HTMLElement>(".lounge-toast-container");
  if (!container) {
    container = document.createElement("div");
    container.className = "lounge-toast-container";
    document.body.appendChild(container);
  }
  return container;
}

export function showToast(message: string, type: ToastType = "info") {
  const container = getContainer();

  const toast = document.createElement("div");
  toast.className = `lounge-toast lounge-toast--${type}`;
  toast.textContent = message;
  container.prepend(toast);

  // Trigger reflow so the transition starts from the initial state
  void toast.offsetHeight;
  toast.classList.add("lounge-toast--visible");

  setTimeout(() => {
    toast.classList.remove("lounge-toast--visible");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
  }, 3000);
}
