import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const validId = (id) => typeof id === "string" && /^[a-z][a-z0-9-]*$/.test(id);
/** 注册资源以实际目录和清单为准，缺失文件在开发/构建时失败，不留到桌面隐形。 */
export function readPetRegistry(root) {
  const result = {};
  for (const dir of readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
    if (dir.name === "default") throw new Error("default is a reserved pet alias");
    if (!validId(dir.name)) throw new Error(`Invalid pet directory: ${dir.name}`);
    const path = join(root, dir.name);
    const manifest = JSON.parse(readFileSync(join(path, "pet.json"), "utf8"));
    if (manifest.id !== dir.name || !Array.isArray(manifest.states)) throw new Error(`Invalid pet manifest: ${dir.name}`);
    const states = manifest.states.map((state) => {
      if (!validId(state.state) || state.file !== `${state.state}.gif` || !existsSync(join(path, state.file))) throw new Error(`Missing or invalid state in ${dir.name}: ${state.state}`);
      return state.state;
    });
    if (!states.includes("idle") || new Set(states).size !== states.length) throw new Error(`Invalid idle/state list in ${dir.name}`);
    const skins = (manifest.skins ?? []).map((skin) => {
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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const registry = readPetRegistry(resolve(process.argv[2]));
    const id = process.argv[3];
    if (id && registry[id]?.dir !== id) throw new Error("Pet is not registered to its own directory");
    process.stdout.write(JSON.stringify({ ok: true, petId: id, assets: registry[id] }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
