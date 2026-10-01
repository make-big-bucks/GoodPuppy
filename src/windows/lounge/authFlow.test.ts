import { describe, expect, it, vi } from "vitest";
import { createAuthFlow } from "./authFlow.js";
function fixture() {
  let userId: string | null = null; let current = true;
  const login = vi.fn(); const success = vi.fn(); const refresh = vi.fn(async () => {}); const save = vi.fn(async () => {});
  const client = { auth: { signInAnonymously: login, signInWithPassword: login, signUp: login } };
  const view = { isCurrent: () => current, busy: vi.fn(), message: vi.fn(), close: vi.fn() };
  const flow = createAuthFlow({ context: () => ({ client: client as never, userId }), success: () => success,
    refresh, saveProfile: save, notifyError: vi.fn(), errorMessage: (error, fallback) => error instanceof Error ? error.message : fallback });
  return { flow, view, login, success, refresh, save, setUser: (id: string) => { userId = id; }, close: () => { current = false; } };
}
describe("authentication operation ownership", () => {
  it("keeps one network operation across modal replacement and permits retry after failure", async () => {
    const f = fixture(); let finish!: (value: any) => void;
    f.login.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const first = f.flow.run("signin", { email: "a", password: "b" }, f.view);
    f.close();
    const replacement = { isCurrent: () => true, busy: vi.fn(), message: vi.fn(), close: vi.fn() };
    await f.flow.run("signup", { email: "a", password: "b" }, replacement);
    expect(f.login).toHaveBeenCalledTimes(1);
    finish({ data: { session: null }, error: new Error("denied") }); await first;
    expect(f.view.busy).toHaveBeenCalledTimes(1);
    expect(f.view.message).toHaveBeenCalledTimes(1);
    f.login.mockResolvedValue({ data: { session: null }, error: null });
    await f.flow.run("signup", { email: "a", password: "b" }, replacement);
    expect(replacement.busy).toHaveBeenLastCalledWith(false);
    expect(replacement.message).toHaveBeenLastCalledWith("注册成功，请检查邮箱确认账号");
  });
  it("does not adopt or report success for an account replaced before the auth response", async () => {
    const f = fixture(); f.setUser("other");
    f.login.mockResolvedValue({ data: { session: { user: { id: "old" } } }, error: null });
    await f.flow.run("adopt", { name: "泡芙" }, f.view);
    expect(f.save).not.toHaveBeenCalled(); expect(f.success).not.toHaveBeenCalled();
  });
  it("finishes current-account adoption after its dialog closes without updating the old view", async () => {
    const f = fixture(); let finish!: (value: any) => void;
    f.login.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const work = f.flow.run("adopt", { name: "泡芙" }, f.view);
    f.close(); f.setUser("adopted"); finish({ data: { session: { user: { id: "adopted" } } }, error: null }); await work;
    expect(f.save).toHaveBeenCalled(); expect(f.success).toHaveBeenCalledTimes(1); expect(f.refresh).toHaveBeenCalledTimes(1);
    expect(f.view.close).not.toHaveBeenCalled(); expect(f.view.busy).toHaveBeenCalledTimes(1);
  });
});
