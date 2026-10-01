import type { SupabaseClient } from "@supabase/supabase-js";
import { saveAdoptedProfile } from "./adoption.js";

type Action = "adopt" | "signin" | "signup";
type Values = { email?: string; password?: string; name?: string };
type View = { isCurrent: () => boolean; busy: (busy: boolean) => void; message: (message: string) => void; close: () => void };

/** 认证网络流程独占在途状态；界面实例和实际返回账号分别校验。 */
export function createAuthFlow(deps: {
  context: () => { client: SupabaseClient; userId: string | null } | null;
  success: () => (() => void) | null;
  refresh: () => Promise<void>;
  notifyError: (message: string) => void;
  errorMessage: (error: unknown, fallback: string) => string;
  saveProfile?: typeof saveAdoptedProfile;
}) {
  let pending = false;
  return {
    /** 注销/绑定也占用同一门禁，弹层失效不能提前释放正在执行的 SDK 操作。 */
    async exclusive(work: () => Promise<void>) {
      if (pending) return false;
      pending = true;
      try { await work(); return true; } finally { pending = false; }
    },
    async run(action: Action, values: Values, view: View) {
      if (!view.isCurrent()) return;
      if (pending) { view.message("上一次账号操作仍在处理中，请稍后重试"); return; }
      const context = deps.context(); const success = deps.success();
      if (!context) return;
      const client = context.client;
      if (action === "adopt" ? !values.name : !values.email || !values.password) {
        view.message(action === "adopt" ? "请先给宠物取个名字" : "请填写邮箱和密码"); return;
      }
      pending = true; view.busy(true);
      view.message(action === "adopt" ? "正在领养..." : action === "signup" ? "正在注册..." : "正在登录...");
      let authenticatedId: string | null = null;
      const isCurrentUser = () => {
        const current = deps.context();
        return authenticatedId !== null && current?.client === client && current.userId === authenticatedId;
      };
      try {
        const credentials = { email: values.email ?? "", password: values.password ?? "" };
        const { data, error } = action === "adopt" ? await client.auth.signInAnonymously()
          : action === "signup" ? await client.auth.signUp(credentials) : await client.auth.signInWithPassword(credentials);
        if (error) throw error;
        if (!data.session) {
          if (action !== "signup") throw new Error("登录未返回会话");
          if (view.isCurrent()) view.message("注册成功，请检查邮箱确认账号");
          return;
        }
        authenticatedId = data.session.user.id;
        if (!isCurrentUser()) return;
        if (action === "adopt") await (deps.saveProfile ?? saveAdoptedProfile)(client, authenticatedId, values.name!, isCurrentUser);
        if (!isCurrentUser()) return;
        if (view.isCurrent()) view.close();
        success?.();
        if (action === "adopt") await deps.refresh();
      } catch (error) {
        const message = deps.errorMessage(error, action === "adopt" ? "领养失败" : action === "signup" ? "注册失败" : "登录失败");
        if (view.isCurrent()) view.message(message);
        else if (isCurrentUser()) deps.notifyError(message);
      } finally {
        pending = false;
        if (view.isCurrent()) view.busy(false);
      }
    },
  };
}
