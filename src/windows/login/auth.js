import { emit } from "@tauri-apps/api/event";
import { createAppSupabaseClient } from "../../shared/supabaseClient.js";

const authForm = document.querySelector(".auth-card");
const authMessage = document.querySelector(".auth-message");
const passwordInput = document.querySelector(".auth-password");
const passwordToggle = document.querySelector(".auth-password-toggle");

const supabase = createAppSupabaseClient();

let authHandled = false;

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
    setAuthMessage(error.message || "登录失败", { isError: true });
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
    setAuthMessage(error.message || "注册失败", { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

function setupPasswordToggle() {
  passwordToggle?.addEventListener("click", () => {
    const shouldShow = passwordInput.type === "password";
    passwordInput.type = shouldShow ? "text" : "password";
    passwordToggle.textContent = shouldShow ? "隐藏" : "显示";
    passwordToggle.setAttribute("aria-label", shouldShow ? "隐藏密码" : "显示密码");
    passwordInput.focus();
  });
}

function subscribeToAuthChanges() {
  supabase.auth.onAuthStateChange((event, session) => {
    if (session) {
      notifyAuthReady();
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
    signIn();
  });

  document.querySelector(".auth-register")?.addEventListener("click", () => {
    signUp();
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
