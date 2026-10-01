import { describe, expect, it, vi } from "vitest";
import { fetchLoungeData } from "./loungeData.js";
function query(result: unknown) {
  const builder: any = { select: () => builder, eq: vi.fn(() => builder), in: () => builder,
    abortSignal: vi.fn(() => builder), maybeSingle: () => Promise.resolve(result), single: () => Promise.resolve(result),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve) };
  return builder;
}
describe("captured lounge data context", () => {
  it("normalizes to-one embedded room responses and passes cancellation to each query", async () => {
    const profile = query({ data: { id: "a" }, error: null });
    const membership = query({ data: [{ room_id: "room", rooms: [{ id: "room", room_name: "name" }] }], error: null });
    const members = query({ data: [], error: null }); const presence = query({ data: [], error: null });
    const invitations = query({ data: [], error: null });
    let roomCalls = 0;
    const client = { from: (table: string) => table === "profiles" ? profile : table === "presence" ? presence : ++roomCalls === 1 ? membership : members,
      rpc: (name: string) => name === "get_online_room_presence" ? presence : invitations };
    const signal = new AbortController().signal;
    const result = await fetchLoungeData({ client: client as never, userId: "a" }, signal);
    expect(result.myRooms[0].rooms?.room_name).toBe("name");
    expect(profile.eq).toHaveBeenCalledWith("id", "a");
    for (const builder of [profile, membership, members, presence, invitations]) expect(builder.abortSignal).toHaveBeenCalledWith(signal);
  });
});
