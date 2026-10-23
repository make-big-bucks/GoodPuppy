import { Channel, invoke } from "@tauri-apps/api/core";
import { createUpdateController, type UpdateInfo, type UpdateProgress } from "./updateController.js";
import { showToast } from "./views/toast.js";

export const appUpdates = createUpdateController({
  check: () => invoke<UpdateInfo>("update_check"),
  download: (onProgress) => {
    const progress = new Channel<UpdateProgress>();
    progress.onmessage = onProgress;
    return invoke<void>("update_download", { progress });
  },
  install: () => invoke<void>("update_install"),
});

export function startUpdateChecks() {
  if (!window.__TAURI_INTERNALS__ || import.meta.env.DEV) return () => {};
  let stopped = false;
  let notifiedVersion: string | null = null;
  const check = async () => {
    await appUpdates.check();
    const status = appUpdates.getStatus();
    if (!stopped && status.phase === "available" && status.version !== notifiedVersion) {
      notifiedVersion = status.version;
      showToast("发现新版本，可在设置中下载更新");
    }
  };
  void check();
  const timer = window.setInterval(() => { void check(); }, 6 * 60 * 60 * 1000);
  return () => { stopped = true; window.clearInterval(timer); };
}
