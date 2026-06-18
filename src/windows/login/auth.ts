import { emit } from "@tauri-apps/api/event";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

const authForm = document.querySelector<HTMLFormElement>(".auth-card");
const authMessage = document.querySelector<HTMLElement>(".auth-message");
const passwordInput = document.querySelector<HTMLInputElement>(".auth-password");
const passwordToggle = document.querySelector<HTMLButtonElement>(".auth-password-toggle");

const supabase = createAppSupabaseClient();

let authHandled = false;

function getErrorMessage(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}

function setAuthMessage(message: string, { isError = false }: { isError?: boolean } = {}) {
  if (!authMessage) return;
  authMessage.textContent = message;
  authMessage.classList.toggle("is-error", isError);
}

function setAuthBusy(isBusy: boolean) {
  authForm?.querySelectorAll<HTMLInputElement | HTMLButtonElement>("input, button").forEach((element) => {
    element.disabled = isBusy;
  });
}

function getAuthCredentials() {
  if (!authForm) {
    return { email: "", password: "" };
  }
  const formData = new FormData(authForm);
  return {
    email: String(formData.get("email") || "").trim(),
    password: String(formData.get("password") || ""),
  };
}

async function notifyAuthReady() {
  if (authHandled) return;
  authHandled = true;
  await emit("auth-ready");
}

async function signIn() {
  const { email, password } = getAuthCredentials();
  setAuthBusy(true);
  setAuthMessage("正在登录...");

  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
    await notifyAuthReady();
  } catch (error) {
    setAuthMessage(getErrorMessage(error, "登录失败"), { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

async function signUp() {
  const { email, password } = getAuthCredentials();
  setAuthBusy(true);
  setAuthMessage("正在注册...");

  try {
    const { data, error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;

    if (data.session) {
      setAuthMessage("注册成功");
      await notifyAuthReady();
    } else {
      setAuthMessage("注册成功，请检查邮箱确认账号");
    }
  } catch (error) {
    setAuthMessage(getErrorMessage(error, "注册失败"), { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

async function signInAnonymously() {
  setAuthBusy(true);
  setAuthMessage("正在创建匿名账号...");

  try {
    const { error } = await supabase.auth.signInAnonymously();
    if (error) throw error;
    await notifyAuthReady();
  } catch (error) {
    setAuthMessage(getErrorMessage(error, "匿名登录失败"), { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

function setupPasswordToggle() {
  if (!passwordInput || !passwordToggle) return;
  const eyeSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></svg>`;
  const eyeOffSvg = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"/><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"/><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"/><path d="m2 2 20 20"/></svg>`;
  passwordToggle.addEventListener("click", () => {
    const shouldShow = passwordInput.type === "password";
    passwordInput.type = shouldShow ? "text" : "password";
    passwordToggle.innerHTML = shouldShow ? eyeOffSvg : eyeSvg;
    passwordToggle.setAttribute("aria-label", shouldShow ? "隐藏密码" : "显示密码");
    passwordInput.focus();
  });
}

function subscribeToAuthChanges() {
  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      void notifyAuthReady();
      return;
    }

    authHandled = false;
    setAuthMessage("");
  });
}

export async function initializeAuth() {
  setupPasswordToggle();

  authForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    void signIn();
  });

  document.querySelector<HTMLButtonElement>(".auth-register")?.addEventListener("click", () => {
    void signUp();
  });

  document.querySelector<HTMLButtonElement>(".auth-quick-entry")?.addEventListener("click", () => {
    void signInAnonymously();
  });

  subscribeToAuthChanges();

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    setAuthMessage(error.message, { isError: true });
    await emit("show-login");
    return;
  }

  if (data.session) {
    await notifyAuthReady();
  } else {
    await emit("show-login");
  }
}
