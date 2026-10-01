import type { SupabaseConfig } from "../types";

export const PRODUCTION_BACKEND = {
  url: "https://mrvdeeiiwnegaqjwpsgk.supabase.co",
  publishableKey: "sb_publishable_bFATe1o6HCfPJwiBripDqg_utJGVUxV",
};

export function assertPublishableSupabaseKey(key: unknown): asserts key is string {
  if (typeof key !== "string" || !key.startsWith("sb_publishable_") || key.includes("service_role")) {
    throw new Error("Only a Supabase publishable key may be used in the desktop client");
  }
}

export function resolveSupabaseConfig(config: SupabaseConfig = PRODUCTION_BACKEND) {
  if (!config.url) throw new Error("Supabase URL is required");
  let parsed: URL;
  try { parsed = new URL(config.url); } catch { throw new Error("Invalid Supabase URL"); }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  if (parsed.username || parsed.password || parsed.search || parsed.hash ||
    (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback))) {
    throw new Error("Supabase URL must use HTTPS, or HTTP on loopback, without credentials or query parameters");
  }
  assertPublishableSupabaseKey(config.publishableKey);
  return { url: parsed.href.replace(/\/$/, ""), publishableKey: config.publishableKey,
    ...(config.storageKey ? { storageKey: config.storageKey } : {}) };
}

/** 生产保持 Supabase SDK 的默认键；其它环境显式覆盖。 */
export function getSupabaseStorageKey(config: SupabaseConfig) {
  return config.storageKey ?? `sb-${new URL(config.url!).hostname.split(".")[0]}-auth-token`;
}

/** 覆盖后端必须显式指定环境与完整 URL/key；发布默认保持已有生产配置与认证存储。 */
export function resolveBackendEnvironment(env: Record<string, unknown>) {
  const environment = env.VITE_BACKEND_ENV ?? "production";
  if (!["production", "development", "test"].includes(String(environment))) throw new Error("Invalid VITE_BACKEND_ENV");
  const url = typeof env.VITE_SUPABASE_URL === "string" ? env.VITE_SUPABASE_URL.trim() : "";
  const publishableKey = typeof env.VITE_SUPABASE_PUBLISHABLE_KEY === "string" ? env.VITE_SUPABASE_PUBLISHABLE_KEY.trim() : "";
  if ((url || publishableKey) && !env.VITE_BACKEND_ENV) throw new Error("Backend overrides require explicit VITE_BACKEND_ENV");
  if (Boolean(url) !== Boolean(publishableKey) || (environment !== "production" && !url)) {
    throw new Error("Custom backend requires both VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY");
  }
  const supabase = resolveSupabaseConfig(url ? { url, publishableKey } : PRODUCTION_BACKEND);
  if (environment !== "production") {
    if (new URL(supabase.url).hostname === new URL(PRODUCTION_BACKEND.url).hostname) {
      throw new Error("Development/test backend must be separate from the production project");
    }
    Object.assign(supabase, { storageKey: `sb-goodpuppy-${environment}-${new URL(supabase.url).host}-auth-token` });
  }
  return { backendEnvironment: environment as "production" | "development" | "test", supabase };
}
