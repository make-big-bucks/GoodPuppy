import { createBoundedFetch } from "./boundedFetch.js";
import { createClient } from "@supabase/supabase-js";
import appConfig from "./appConfig.js";
import { resolveSupabaseConfig } from "./backendConfig.js";
import type { SupabaseConfig } from "../types";
export { assertPublishableSupabaseKey, resolveSupabaseConfig } from "./backendConfig.js";

const CLIENT_AUTH_OPTIONS = {
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: false,
};

export function createAppSupabaseClient(config: SupabaseConfig = appConfig.supabase) {
  const { url, publishableKey, storageKey } = resolveSupabaseConfig(config);

  return createClient(url, publishableKey, {
    auth: { ...CLIENT_AUTH_OPTIONS, ...(storageKey ? { storageKey } : {}) },
    global: { fetch: createBoundedFetch() },
  });
}
