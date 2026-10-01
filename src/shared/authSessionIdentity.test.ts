import { expect, it } from "vitest";
import { authSessionIdentity } from "./authSessionIdentity.js";
it("compares session identity independently of refreshed JWT contents", () => {
  const id = "aaaaaaaa-0000-0000-0000-000000000001";
  const token = (expiry: number) => `header.${btoa(JSON.stringify({ session_id: id, exp: expiry }))}.signature`;
  expect(authSessionIdentity(token(1))).toBe(id); expect(authSessionIdentity(token(2))).toBe(id);
});
it("does not use malformed or absent token payloads as a session identity", () => {
  expect(authSessionIdentity(undefined)).toBeNull(); expect(authSessionIdentity("invalid")).toBeNull();
  expect(authSessionIdentity(`header.${btoa('{"sub":"user"}')}.signature`)).toBeNull();
});
