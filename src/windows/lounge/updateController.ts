export type UpdateInfo = { configured: boolean; currentVersion: string; version: string | null; notes: string | null };
export type UpdateProgress = { downloaded: number; total?: number | null };
export type UpdatePhase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "current" | "unconfigured" | "error";
export type UpdateStatus = { phase: UpdatePhase; currentVersion: string; version: string | null; notes: string; progress: number | null };

/** 会客厅独占更新状态，跨设置页重开保留下载结果；安装只由用户点击触发。 */
export function createUpdateController(deps: {
  check: () => Promise<UpdateInfo>;
  download: (onProgress: (progress: UpdateProgress) => void) => Promise<void>;
  install: () => Promise<void>;
}) {
  let status: UpdateStatus = { phase: "idle", currentVersion: "", version: null, notes: "", progress: null };
  let busy = false;
  const listeners = new Set<(status: UpdateStatus) => void>();
  const publish = (patch: Partial<UpdateStatus>) => {
    status = { ...status, ...patch };
    for (const listener of listeners) listener({ ...status });
  };
  const check = async () => {
    if (busy || status.phase === "ready") return;
    busy = true;
    publish({ phase: "checking", progress: null });
    try {
      const info = await deps.check();
      publish({ currentVersion: info.currentVersion, version: info.version, notes: info.notes ?? "",
        phase: !info.configured ? "unconfigured" : info.version ? "available" : "current" });
    } catch { publish({ phase: "error" }); }
    finally { busy = false; }
  };
  return {
    check,
    getStatus: () => ({ ...status }),
    subscribe(listener: (status: UpdateStatus) => void) {
      listeners.add(listener); listener({ ...status });
      return () => { listeners.delete(listener); };
    },
    async act() {
      if (busy) return;
      if (status.phase !== "available" && status.phase !== "ready") return check();
      busy = true;
      const installing = status.phase === "ready";
      publish({ phase: installing ? "installing" : "downloading", progress: null });
      try {
        if (installing) await deps.install();
        else {
          await deps.download(({ downloaded, total }) => publish({
            progress: total && total > 0 ? Math.min(100, Math.floor(downloaded / total * 100)) : null,
          }));
          publish({ phase: "ready" });
        }
      } catch { publish({ phase: "error" }); }
      finally { busy = false; }
    },
  };
}
