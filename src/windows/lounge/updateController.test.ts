import { describe, it, expect, vi } from "vitest";
import { createUpdateController, type UpdateInfo } from "./updateController.js";
const available: UpdateInfo = { configured: true, currentVersion: "0.1.0", version: "0.2.0", notes: "更新说明" };
describe("application updates", () => {
  it("checks automatically but requires separate user actions to download and install", async () => {
    const download = vi.fn(async (progress) => { progress({ downloaded: 5, total: 10 }); });
    const install = vi.fn(async () => {});
    const updates = createUpdateController({ check: async () => available, download, install });
    await updates.check();
    expect(updates.getStatus().phase).toBe("available");
    expect(download).not.toHaveBeenCalled();
    await updates.act();
    expect(updates.getStatus()).toMatchObject({ phase: "ready", progress: 50 });
    expect(install).not.toHaveBeenCalled();
    await updates.check();
    expect(updates.getStatus().phase).toBe("ready");
    await updates.act();
    expect(install).toHaveBeenCalledOnce();
  });
  it("serializes checks and downloads across settings view reopen", async () => {
    let finish!: (value: UpdateInfo) => void;
    const check = vi.fn(() => new Promise<UpdateInfo>((resolve) => { finish = resolve; }));
    const updates = createUpdateController({ check, download: async () => {}, install: async () => {} });
    const pending = updates.check();
    await updates.act();
    expect(check).toHaveBeenCalledOnce();
    const listener = vi.fn(); const unsubscribe = updates.subscribe(listener); unsubscribe();
    finish(available); await pending;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(updates.getStatus().phase).toBe("available");
  });
  it("keeps unavailable configuration distinct from latest version and network failures retryable", async () => {
    const check = vi.fn().mockResolvedValueOnce({ ...available, configured: false, version: null })
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ...available, version: null });
    const updates = createUpdateController({ check, download: async () => {}, install: async () => {} });
    await updates.check(); expect(updates.getStatus().phase).toBe("unconfigured");
    await updates.check(); expect(updates.getStatus().phase).toBe("error");
    await updates.act(); expect(updates.getStatus().phase).toBe("current");
  });
  it("download or installation failures require a fresh check and never auto-install", async () => {
    const install = vi.fn(async () => { throw new Error("installer failed"); });
    const download = vi.fn().mockRejectedValueOnce(new Error("bad signature")).mockResolvedValue(undefined);
    const updates = createUpdateController({ check: async () => available, download, install });
    await updates.check(); await updates.act(); expect(updates.getStatus().phase).toBe("error");
    expect(install).not.toHaveBeenCalled();
    await updates.act(); await updates.act(); await updates.act();
    expect(updates.getStatus().phase).toBe("error");
    await updates.act(); expect(updates.getStatus().phase).toBe("available");
  });
});
