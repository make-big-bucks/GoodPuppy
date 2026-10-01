import appConfig from "./appConfig.js";

export type DiagnosticEvent = {
  operation: "native-window" | "room-enter" | "room-exit" | "room-resume" | "session-changed";
  phase: "start" | "ok" | "failed" | "canceled";
  action?: "spawn" | "close" | "show" | "hide" | "leave" | "quit";
  targetWindow?: string;
  instanceId?: string;
  requestId?: string;
  roomId?: string;
  sessionVersion?: number;
  durationMs?: number;
  environment?: "production" | "development" | "test";
};

/** 日志失败不能改变业务结果；不传入 Error 对象、消息正文或完整命令参数。 */
export function recordLifecycle(event: DiagnosticEvent) {
  if (typeof window === "undefined" || !window.goodPuppy?.recordDiagnostic) return;
  try { void window.goodPuppy.recordDiagnostic({ ...event, environment: appConfig.backendEnvironment }).catch(() => {}); } catch { /* 日志不是业务前置条件 */ }
}
