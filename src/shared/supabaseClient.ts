import { createBoundedFetch } from "./boundedFetch.js";
import { createClient } from "@supabase/supabase-js";
import appConfig from "./appConfig.js";
import type { SupabaseConfig } from "../types";

const CLIENT_AUTH_OPTIONS = {
  autoRefreshToken: true,
  persistSession: true,
  detectSessionInUrl: false,
};

export function assertPublishableSupabaseKey(key: unknown): asserts key is string {
  if (!key || typeof key !== "string") {
    throw new Error("Supabase publishable key is required");
  }

  if (key.includes("service_role") || key.startsWith("sb_secret_")) {
    throw new Error("Only a Supabase publishable key may be used in the desktop client");
  }

  if (!key.startsWith("sb_publishable_")) {
    throw new Error("Supabase key must use the sb_publishable_ format");
  }
}

export function resolveSupabaseConfig(config: SupabaseConfig = appConfig.supabase) {
  const url = config?.url;
  const publishableKey = config?.publishableKey;

  if (!url || typeof url !== "string") {
    throw new Error("Supabase URL is required");
  }

  assertPublishableSupabaseKey(publishableKey);

  return { url, publishableKey };
}

export function createAppSupabaseClient(config: SupabaseConfig = appConfig.supabase) {
  const { url, publishableKey } = resolveSupabaseConfig(config);

  return createClient(url, publishableKey, {
    auth: CLIENT_AUTH_OPTIONS,
    global: { fetch: createBoundedFetch() },
  });
}
