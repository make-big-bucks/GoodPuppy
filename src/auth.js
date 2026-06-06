import { createClient } from "@supabase/supabase-js";
import appConfig from "./appConfig.js";

const authPanel = document.querySelector(".auth-panel");
const authForm = document.querySelector(".auth-card");
const authRegisterButton = document.querySelector(".auth-register");
const authMessage = document.querySelector(".auth-message");
const passwordInput = document.querySelector(".auth-password");
const passwordToggle = document.querySelector(".auth-password-toggle");
const petStage = document.querySelector(".pet-stage");

const supabase = createClient(appConfig.supabase.url, appConfig.supabase.apiKey, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: false,
  },
});

let petAppStarted = false;

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

function showLoginPanel() {
  authPanel.hidden = false;
  petStage.classList.add("is-initializing");
  window.goodPuppy.setIgnoreMouseEvents(false);
  setAuthMessage("");
}

async function showPetApp(session, startPetApp) {
  if (!session?.user) {
    showLoginPanel();
    return;
  }

  authPanel.hidden = true;

  if (!petAppStarted) {
    petAppStarted = true;
  }

  startPetApp({ supabase, session });
}

async function signIn(startPetApp) {
  const { email, password } = getAuthCredentials();

  setAuthBusy(true);
  setAuthMessage("\u6b63\u5728\u767b\u5f55...");

  try {
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) throw error;
    await showPetApp(data.session, startPetApp);
  } catch (error) {
    setAuthMessage(error.message || "\u767b\u5f55\u5931\u8d25", { isError: true });
  } finally {
    setAuthBusy(false);
  }
}

async function signUp() {
  const { email, password } = getAuthCredentials();

  setAuthBusy(true);
  setAuthMessage("\u6b63\u5728\u6ce8\u518c...");

  try {
    const { data, error } = await supabase.auth.signUp({ email, password });

    if (error) throw error;

    if (data.session) {
      setAuthMessage("\u6ce8\u518c\u6210\u529f");
    } else {
      setAuthMessage("\u6ce8\u518c\u6210\u529f\uff0c\u8bf7\u68c0\u67e5\u90ae\u7bb1\u786e\u8ba4\u8d26\u53f7");
    }
  } catch (error) {
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

function setupAuthDrag() {
  authPanel?.addEventListener("pointerdown", (event) => {
    if (event.target.closest("input, button")) {
      return;
    }

    window.goodPuppy.startWindowDrag();
  });
}

export async function initializeAuth(startPetApp) {
  showLoginPanel();
  setupPasswordToggle();
  setupAuthDrag();

  authForm?.addEventListener("submit", (event) => {
    event.preventDefault();
    signIn(startPetApp);
  });

  authRegisterButton?.addEventListener("click", () => {
    signUp();
  });

  window.goodPuppy.onTrayLogoutRequest(async () => {
    await supabase.auth.signOut();
    showLoginPanel();
  });

  supabase.auth.onAuthStateChange((_event, session) => {
    if (session) {
      showPetApp(session, startPetApp);
    } else {
      showLoginPanel();
    }
  });

  const { data, error } = await supabase.auth.getSession();

  if (error) {
    setAuthMessage(error.message, { isError: true });
    return;
  }

  if (data.session) {
    await showPetApp(data.session, startPetApp);
  }
}
