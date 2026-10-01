import { describe, expect, it, vi } from "vitest";
import { saveAdoptedProfile } from "./adoption.js";

function fixture() {
  let finish!: (result: { error: Error | null }) => void;
  const insert = new Promise<{ error: Error | null }>((resolve) => { finish = resolve; });
  const single = vi.fn(async () => ({ data: { id: "adopted-user" }, error: null }));
  const select = vi.fn(() => ({ single }));
  const eq = vi.fn(() => ({ select }));
  const upsert = vi.fn(() => insert);
  const update = vi.fn(() => ({ eq }));
  const client = { from: () => ({ upsert, update }) };
  return { client: client as never, finish, upsert, update, eq, select, single };
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
  it("rejects a zero-row profile receipt instead of completing adoption", async () => {
    const f = fixture(); f.single.mockResolvedValue({ data: null, error: null } as never);
    const result = saveAdoptedProfile(f.client, "adopted-user", "泡芙", () => true);
    const rejection = expect(result).rejects.toThrow("领养资料未保存");
    f.finish({ error: null }); await rejection;
    expect(f.select).toHaveBeenCalledWith("id");
  });
  it("propagates an insert failure without updating the name", async () => {
    const f = fixture();
    const result = saveAdoptedProfile(f.client, "adopted-user", "泡芙", () => true);
    f.finish({ error: new Error("denied") });
    await expect(result).rejects.toThrow("denied");
    expect(f.update).not.toHaveBeenCalled();
  });
});
