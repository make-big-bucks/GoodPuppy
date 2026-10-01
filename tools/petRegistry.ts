import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export type PetAssets = Record<string, { dir: string; states: string[]; skins: string[] }>;
const validId = (id: unknown): id is string => typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id);
/** 注册资源以实际目录和清单为准，缺失文件在开发/构建时失败，不留到桌面隐形。 */
export function readPetRegistry(root: string): PetAssets {
  const result: PetAssets = {};
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    if (!validId(dir.name)) throw new Error(`Invalid pet directory: ${dir.name}`);
    const path = join(root, dir.name);
    const manifest = JSON.parse(readFileSync(join(path, "pet.json"), "utf8"));
    if (manifest.id !== dir.name || !Array.isArray(manifest.states)) throw new Error(`Invalid pet manifest: ${dir.name}`);
    const states = manifest.states.map((state: { state?: string; file?: string }) => {
      if (!validId(state.state) || state.file !== `${state.state}.gif` || !existsSync(join(path, state.file))) throw new Error(`Missing or invalid state in ${dir.name}: ${state.state}`);
      return state.state;
    });
    if (!states.includes("idle") || new Set(states).size !== states.length) throw new Error(`Invalid idle/state list in ${dir.name}`);
    const skins = (manifest.skins ?? []).map((skin: { id?: string }) => {
      if (!validId(skin.id)) throw new Error(`Invalid skin in ${dir.name}`);
      for (const state of states) if (!existsSync(join(path, "skins", skin.id, `${state}.gif`))) throw new Error(`Missing skin state: ${dir.name}/${skin.id}/${state}`);
      return skin.id;
    });
    result[dir.name] = { dir: dir.name, states, skins };
  }
  if (!result.shiba) throw new Error("Default shiba resources are missing");
  result.default = result.shiba;
  return result;
}
