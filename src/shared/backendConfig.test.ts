import { describe, expect, it } from "vitest";
import { PRODUCTION_BACKEND, resolveBackendEnvironment, resolveSupabaseConfig, getSupabaseStorageKey } from "./backendConfig.js";
const development = { VITE_BACKEND_ENV: "development", VITE_SUPABASE_URL: "http://127.0.0.1:54321", VITE_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_dev" };
describe("explicit backend environments", () => {
  it("preserves the published production backend and existing auth namespace", () => {
    expect(resolveBackendEnvironment({})).toEqual({ backendEnvironment: "production", supabase: PRODUCTION_BACKEND });
    expect(getSupabaseStorageKey(PRODUCTION_BACKEND)).toBe("sb-mrvdeeiiwnegaqjwpsgk-auth-token");
  });
  it("isolates development and test sessions even when using the same sandbox server", () => {
    const dev = resolveBackendEnvironment(development);
    const test = resolveBackendEnvironment({ ...development, VITE_BACKEND_ENV: "test" });
    expect(dev.supabase.url).toBe("http://127.0.0.1:54321");
    expect(dev.supabase.storageKey).not.toBe(test.supabase.storageKey);
  });
  it("rejects incomplete, implicit and mislabelled production overrides", () => {
    expect(() => resolveBackendEnvironment({ VITE_BACKEND_ENV: "development" })).toThrow("both");
    expect(() => resolveBackendEnvironment({ ...development, VITE_SUPABASE_PUBLISHABLE_KEY: "" })).toThrow("both");
    expect(() => resolveBackendEnvironment({ ...development, VITE_BACKEND_ENV: undefined })).toThrow("explicit");
    expect(() => resolveBackendEnvironment({ ...development, VITE_SUPABASE_URL: PRODUCTION_BACKEND.url })).toThrow("separate");
    expect(() => resolveBackendEnvironment({ VITE_BACKEND_ENV: "unknown" })).toThrow("Invalid");
  });
  it("rejects secret credentials and credential-bearing or insecure remote URLs", () => {
    expect(() => resolveBackendEnvironment({ ...development, VITE_SUPABASE_PUBLISHABLE_KEY: "sb_secret_private" })).toThrow("publishable");
    for (const url of ["http://example.com", "https://user:pass@example.com", "https://example.com?token=x", "invalid"]) {
      expect(() => resolveSupabaseConfig({ url, publishableKey: "sb_publishable_dev" })).toThrow();
    }
    expect(resolveSupabaseConfig({ url: "http://[::1]:54321/", publishableKey: "sb_publishable_dev" }).url).toBe("http://[::1]:54321");
  });
});
