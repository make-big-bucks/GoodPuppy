import { describe, expect, it, vi } from "vitest";
import { saveAdoptedProfile } from "./adoption.js";

function fixture() {
  let finish!: (result: { error: Error | null }) => void;
  const insert = new Promise<{ error: Error | null }>((resolve) => { finish = resolve; });
  const eq = vi.fn(async () => ({ error: null }));
  const upsert = vi.fn(() => insert);
  const update = vi.fn(() => ({ eq }));
  const client = { from: () => ({ upsert, update }) };
  return { client: client as never, finish, upsert, update, eq };
}
describe("adoption profile ownership", () => {
  it("preserves an existing pet and updates only the returned account's name", async () => {
    const f = fixture();
    const result = saveAdoptedProfile(f.client, "adopted-user", "泡芙", () => true);
    f.finish({ error: null }); await result;
    expect(f.upsert).toHaveBeenCalledWith({ id: "adopted-user", display_name: "泡芙", pet_id: "default" }, { onConflict: "id", ignoreDuplicates: true });
    expect(f.update).toHaveBeenCalledWith({ display_name: "泡芙" });
    expect(f.eq).toHaveBeenCalledWith("id", "adopted-user");
  });
  it("stops before the next write when the account changes during insert", async () => {
    const f = fixture(); let current = true;
    const result = saveAdoptedProfile(f.client, "adopted-user", "泡芙", () => current);
    current = false; f.finish({ error: null });
    await expect(result).rejects.toThrow("账号已改变");
    expect(f.update).not.toHaveBeenCalled();
  });
  it("propagates an insert failure without updating the name", async () => {
    const f = fixture();
    const result = saveAdoptedProfile(f.client, "adopted-user", "泡芙", () => true);
    f.finish({ error: new Error("denied") });
    await expect(result).rejects.toThrow("denied");
    expect(f.update).not.toHaveBeenCalled();
  });
});
