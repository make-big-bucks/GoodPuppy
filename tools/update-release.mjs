import { readFile, writeFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { semverPattern } from "./release-version.mjs";

export function validateKey(key) {
  const decoded = Buffer.from(key?.trim() ?? "", "base64").toString("utf8");
  const raw = Buffer.from(decoded.trim().split(/\r?\n/).at(-1) ?? "", "base64");
  if (raw.length !== 42 || raw.subarray(0, 2).toString() !== "Ed") {
    throw new Error("Set GOODPUPPY_UPDATER_PUBLIC_KEY to the complete generated .pub file contents.");
  }
  return raw.subarray(2, 10);
}

export function validateSignature(signature, publicKey) {
  const keyId = validateKey(publicKey);
  const lines = Buffer.from(signature?.trim() ?? "", "base64").toString("utf8").trim().split(/\r?\n/);
  const raw = Buffer.from(lines[1] ?? "", "base64");
  if (raw.length !== 74 || !raw.subarray(2, 10).equals(keyId)) {
    throw new Error("Updater signing key does not match public key");
  }
}

export function createManifest(release, signatures, publicKey) {
  if (release.draft || !release.published_at) throw new Error("Release must be published first");
  const version = release.tag_name.replace(/^v/, "");
  if (!semverPattern.test(version)) throw new Error("Invalid version tag");
  validateKey(publicKey);
  if (!release.prerelease && version.split("+")[0].includes("-")) throw new Error("Prerelease version cannot advance stable channel");
  const platforms = {};
  for (const [platform, suffix] of Object.entries({
    "darwin-aarch64": "aarch64.app.tar.gz",
    "darwin-x86_64": "x86_64.app.tar.gz",
    "windows-x86_64": "x86_64-setup.exe",
  })) {
    const name = `GoodPuppy_${version}_${suffix}`;
    const asset = release.assets.find((asset) => asset.name === name);
    const signature = signatures[`${name}.sig`]?.trim();
    if (!asset?.size || !signature) throw new Error(`Missing update artifact: ${name}`);
    const url = new URL(asset.browser_download_url);
    if (url.protocol !== "https:") throw new Error("Update URLs must use HTTPS");
    validateSignature(signature, publicKey);
    platforms[platform] = { url: url.href, signature };
  }
  return { version, notes: release.body ?? "", pub_date: release.published_at, platforms };
}

export function compareVersions(a, b) {
  const parse = (value) => {
    const match = semverPattern.exec(value);
    if (!match) throw new Error("Invalid version");
    return { core: match.slice(1, 4).map(BigInt), pre: match[4]?.split(".") };
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }
  if (!left.pre || !right.pre) return left.pre ? -1 : right.pre ? 1 : 0;
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i], y = right.pre[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const nx = /^\d+$/.test(x), ny = /^\d+$/.test(y);
    if (nx && ny) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (nx !== ny) return nx ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

export function selectChannelUpdates(release, manifest, previousByChannel) {
  const requiredChannel = release.prerelease ? "preview" : "stable";
  const channels = [requiredChannel];
  if (!release.prerelease) channels.push("preview");
  return channels.filter((channel) => {
    const previous = previousByChannel[channel];
    if (!previous) return true;
    const comparison = compareVersions(manifest.version, previous.version);
    if (channel === requiredChannel && comparison <= 0) {
      throw new Error("Refusing to overwrite an equal or newer channel version; publish a new version");
    }
    return comparison > 0;
  });
}

async function main() {
  if (process.argv[2] === "validate-keypair") {
    const directory = await mkdtemp(path.join(tmpdir(), "goodpuppy-key-check-"));
    try {
      const artifact = path.join(directory, "challenge");
      await writeFile(artifact, "GoodPuppy release signing preflight");
      const result = spawnSync(process.execPath, ["node_modules/@tauri-apps/cli/tauri.js", "signer", "sign", artifact], { encoding: "utf8" });
      if (result.status !== 0) throw new Error("Cannot sign release preflight; check updater private key and password");
      validateSignature(await readFile(`${artifact}.sig`, "utf8"), process.env.GOODPUPPY_UPDATER_PUBLIC_KEY);
    } finally { await rm(directory, { recursive: true, force: true }); }
    return;
  }
  if (process.argv[2] === "validate-key") { validateKey(process.env.GOODPUPPY_UPDATER_PUBLIC_KEY); return; }
  const release = JSON.parse(await readFile("release.json", "utf8"));
  const signatures = {};
  for (const asset of release.assets.filter((asset) => asset.name.endsWith(".sig"))) {
    const response = await fetch(asset.browser_download_url);
    if (!response.ok) throw new Error(`Signature unavailable: ${asset.name} (${response.status})`);
    signatures[asset.name] = await response.text();
  }
  const manifest = createManifest(release, signatures, process.env.GOODPUPPY_UPDATER_PUBLIC_KEY);
  // Public availability is checked before moving the channel pointer.
  for (const { url } of Object.values(manifest.platforms)) {
    const response = await fetch(url, { method: "HEAD" });
    if (!response.ok) throw new Error(`Update package unavailable (${response.status})`);
  }
  const previousByChannel = {};
  for (const channel of ["preview", "stable"]) {
    try { previousByChannel[channel] = JSON.parse(await readFile(`feed/${channel}.json`, "utf8")); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  await mkdir("feed", { recursive: true });
  for (const channel of selectChannelUpdates(release, manifest, previousByChannel)) {
    await writeFile(`feed/${channel}.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
