import "./bridge.js";
import "./styles.css";
import { emit, listen } from "@tauri-apps/api/event";
import { startPetApp, switchRoom } from "./renderer.js";
import { createAppSupabaseClient } from "./supabaseClient.js";

const inTauri = "__TAURI_INTERNALS__" in window;
const supabase = createAppSupabaseClient();

async function startFromStoredSession() {
  const { data } = await supabase.auth.getSession();

  if (data.session) {
    startPetApp({ supabase, session: data.session });
  }
}

if (inTauri) {
  listen("pet-init", startFromStoredSession);

  startFromStoredSession().catch((error) => {
    console.error(error);
  });

  listen("switch-room", (event) => {
    switchRoom(event.payload.roomId);
  });

  listen("auth-logout-requested", async () => {
    await supabase.auth.signOut();
    emit("auth-cleared");
  });
}
