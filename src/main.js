// 顺序重要：bridge 必须先于 renderer 执行（renderer 顶层会读 window.goodPuppy）
import "./bridge.js";
import "./styles.css";
import { initializeAuth } from "./auth.js";
import { startPetApp, switchRoom } from "./renderer.js";
import { initConnectPanel, updateConnectPanelAuth, openConnectPanel } from "./connect.js";

initConnectPanel({ supabase: null, selfAuthId: null, onEnterRoom: switchRoom });

window.goodPuppy.onOpenConnectPanel(() => {
  openConnectPanel();
});

function startPetAppWithConnect({ supabase, session }) {
  updateConnectPanelAuth({ supabase, selfAuthId: session?.user?.id });
  startPetApp({ supabase, session });
}

initializeAuth(startPetAppWithConnect).catch((error) => {
  console.error(error);
});
