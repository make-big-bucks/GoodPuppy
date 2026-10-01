import { describe, expect, it, vi } from "vitest";
import { assertPublishableSupabaseKey, resolveSupabaseConfig, createAppSupabaseClient } from "./supabaseClient.js";
import { resolveBackendEnvironment } from "./backendConfig.js";
const { createClient } = vi.hoisted(() => ({ createClient: vi.fn(() => ({})) }));
vi.mock("@supabase/supabase-js", () => ({ createClient }));

describe("assertPublishableSupabaseKey", () => {
  it("accepts Supabase publishable keys for desktop clients", () => {
    expect(() => assertPublishableSupabaseKey("sb_publishable_example")).not.toThrow();
  });

  it("rejects secret and service-role keys before they can be bundled", () => {
    expect(() => assertPublishableSupabaseKey("sb_secret_example")).toThrow(/publishable/i);
    expect(() => assertPublishableSupabaseKey("service_role.jwt.token")).toThrow(/publishable/i);
  });
});

describe("resolveSupabaseConfig", () => {
  it("passes the isolated auth namespace to the actual client construction path", () => {
    const config = resolveBackendEnvironment({ VITE_BACKEND_ENV: "test", VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" });
    createAppSupabaseClient(config.supabase);
    expect(createClient).toHaveBeenCalledWith(config.supabase.url, config.supabase.publishableKey, expect.objectContaining({
      auth: expect.objectContaining({ storageKey: config.supabase.storageKey, persistSession: true }),
    }));
  });
  it("normalizes the configured Supabase URL and publishable key", () => {
    expect(
      resolveSupabaseConfig({
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_example",
      }),
    ).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_example",
    });
  });
});
