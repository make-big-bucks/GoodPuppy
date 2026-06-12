import { emit } from "@tauri-apps/api/event";
import { createAppSupabaseClient } from "./supabaseClient.js";

const authForm = document.querySelector(".auth-card");
const authMessage = document.querySelector(".auth-message");
const passwordInput = document.querySelector(".auth-password");
const passwordToggle = document.querySelector(".auth-password-toggle");
const rememberMeInput = document.querySelector(".remember-me");

const supabase = createAppSupabaseClient();
const temporarySessionKey = "goodPuppy.temporarySession";

let authHandled = false;
let pendingRememberSession = null;

function setAuthMessage(message, { isError = false } = {}) {
  if (!authMessage) return;
  authMessage.textContent = message;
  authMessage.classList.toggle("is-error", isError);
}

function setAuthBusy(isBusy) {
  authForm?.querySelectorAll("input, button").forEach((element) => {
    element.disabled = isBusy;
  });
}

function getAuthCredentials() {
  const formData = new FormData(authForm);
  return {
    email: String(formData.get("email") || "").trim(),
    password: String(formData.get("password") || ""),
  };
}

function shouldRememberSession() {
  return Boolean(rememberMeInput?.checked);
}

function markSessionPersistence(shouldRemember) {
  if (shouldRemember) {
    localStorage.removeItem(temporarySessionKey);
  } else {
    localStorage.setItem(temporarySessionKey, "true");
  }
}

async function clearTemporarySessionIfNeeded() {
  if (localStorage.getItem(temporarySessionKey) !== "true") {
    return false;
  }

  localStorage.removeItem(temporarySessionKey);
  await supabase.auth.signOut();
  return true;
}

async function notifyAuthReady() {
  if (authHandled) return;
  authHandled = true;
  await emit("auth-ready");
}

async function signIn() {
  const { email, password } = getAuthCredentials();
  pendingRememberSession = shouldRememberSession();
  setAuthBusy(true);
  setAuthMessage("\u6b63\u5728\u767b\u5f55...");

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;

    markSessionPersistence(pendingRememberSession);
    pendingRememberSession = null;
    await notifyAuthReady();
  } catch (error) {
    pendingRememberSession = null;
    setAuthMessage(error.message || "\u767b\u5f55\u5931\u8d25", { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

async function signUp() {
  const { email, password } = getAuthCredentials();
  pendingRememberSession = shouldRememberSession();
  setAuthBusy(true);
  setAuthMessage("\u6b63\u5728\u6ce8\u518c...");

  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;

    if (data.session) {
      markSessionPersistence(pendingRememberSession);
      setAuthMessage("\u6ce8\u518c\u6210\u529f");
      await notifyAuthReady();
    } else {
      setAuthMessage("\u6ce8\u518c\u6210\u529f\uff0c\u8bf7\u68c0\u67e5\u90ae\u7bb1\u786e\u8ba4\u8d26\u53f7");
    }

    pendingRememberSession = null;
  } catch (error) {
    pendingRememberSession = null;
    setAuthMessage(error.message || "\u6ce8\u518c\u5931\u8d25", { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

function setupPasswordToggle() {
  passwordToggle?.addEventListener("click", () => {
    const shouldShow = passwordInput.type === "password";
    passwordInput.type = shouldShow ? "text" : "password";
    passwordToggle.textContent = shouldShow ? "\u9690\u85cf" : "\u663e\u793a";
    passwordToggle.setAttribute("aria-label", shouldShow ? "\u9690\u85cf\u5bc6\u7801" : "\u663e\u793a\u5bc6\u7801");
    passwordInput.focus();
  });
}

function subscribeToAuthChanges() {
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      if (event === "SIGNED_IN" && pendingRememberSession !== null) {
        markSessionPersistence(pendingRememberSession);
      }

      notifyAuthReady();
      return;
    }

    authHandled = false;
    pendingRememberSession = null;
    localStorage.removeItem(temporarySessionKey);
    setAuthMessage("");
  });
}

export async function initializeAuth() {
  setupPasswordToggle();

  authForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    signIn();
  });

  document.querySelector(".auth-register")?.addEventListener("click", () => {
    signUp();
  });

  if (await clearTemporarySessionIfNeeded()) {
    subscribeToAuthChanges();
    return;
  }

  subscribeToAuthChanges();

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    setAuthMessage(error.message, { isError: true });
    return;
  }

  if (data.session) {
    await notifyAuthReady();
  }
}
