import { describe, it, expect } from "vitest";
import { latestMeta } from "./presence.js";

describe("latestMeta", () => {
  // 复现 bug：再次 track() 更新状态时，Supabase 在同一 key 下追加 meta 而非替换，
  // 旧的 null 状态在 metas[0]、新的 happy 在 metas[1]。必须按 online_at 取最新。
  it("picks the most recent meta when a key accumulates multiple metas", () => {
    const metas = [
      { online_at: "2026-06-10T13:51:04.290Z", status: null, pet_id: "default" },
      { online_at: "2026-06-10T13:51:26.038Z", status: "happy", pet_id: "default" },
    ];
    expect(latestMeta(metas)?.status).toBe("happy");
  });

  it("is order-independent (newest wins even if listed first)", () => {
    const metas = [
      { online_at: "2026-06-10T13:51:26.038Z", status: "happy" },
      { online_at: "2026-06-10T13:51:04.290Z", status: null },
    ];
    expect(latestMeta(metas)?.status).toBe("happy");
  });

  it("handles a single meta", () => {
    const metas = [{ online_at: "2026-06-10T13:51:04.290Z", status: "busy" }];
    expect(latestMeta(metas)?.status).toBe("busy");
  });

  it("returns the value as-is when not an array", () => {
    const meta = { status: "sad" };
    expect(latestMeta(meta)).toBe(meta);
  });
});
