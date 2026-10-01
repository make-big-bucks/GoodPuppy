import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPetRegistry } from "./petRegistry.mjs";
const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true }); });
function pet(root: string, id: string) {
  const path = join(root, id); mkdirSync(path);
  writeFileSync(join(path, "pet.json"), JSON.stringify({ id, states: [{ state: "idle", file: "idle.gif" }], skins: [] }));
  writeFileSync(join(path, "idle.gif"), "synthetic-test-only");
}
describe("build-time pet discovery", () => {
  it("rejects a directory that would overwrite the reserved default alias", () => {
    const root = mkdtempSync(join(tmpdir(), "goodpuppy-pets-")); directories.push(root);
    pet(root, "shiba"); pet(root, "default");
    expect(() => readPetRegistry(root)).toThrow("reserved");
  });
  it("registers a new validated folder without changing frontend source", () => {
    const root = mkdtempSync(join(tmpdir(), "goodpuppy-pets-")); directories.push(root);
    pet(root, "shiba"); pet(root, "ghost");
    expect(readPetRegistry(root).ghost.dir).toBe("ghost");
    expect(readPetRegistry(root).default.dir).toBe("shiba");
  });
  it("rejects a missing state instead of shipping an invisible pet", () => {
    const root = mkdtempSync(join(tmpdir(), "goodpuppy-pets-")); directories.push(root);
    pet(root, "shiba"); rmSync(join(root, "shiba/idle.gif"));
    expect(() => readPetRegistry(root)).toThrow("Missing");
  });
});
