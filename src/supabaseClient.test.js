import { describe, expect, it } from "vitest";
import { assertPublishableSupabaseKey, resolveSupabaseConfig } from "./supabaseClient.js";

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
  it("normalizes the configured Supabase URL and publishable key", () => {
    expect(
      resolveSupabaseConfig({
        url: "https://example.supabase.co",
        publishableKey: "sb_publishable_example",
      })
    ).toEqual({
      url: "https://example.supabase.co",
      publishableKey: "sb_publishable_example",
    });
  });
});
