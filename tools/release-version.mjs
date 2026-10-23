import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const packagePaths = ["package.json"];
const lockPackagePaths = [""];

function parseArgs(argv) {
  const positional = [];
  let root = process.cwd();
  let tag;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--root") {
      root = argv[++index];
    } else if (arg === "--tag") {
      tag = argv[++index];
    } else {
      positional.push(arg);
    }
  }

  if (!root) throw new Error("--root requires a path");
  return { command: positional[0], version: positional[1], root: path.resolve(root), tag };
}

async function readJson(root, relativePath) {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8"));
}

async function writeJson(root, relativePath, value) {
  await writeFile(path.join(root, relativePath), `${JSON.stringify(value, null, 2)}\n`);
}

function assertSemver(version) {
  if (!semverPattern.test(version ?? "")) {
    throw new Error(`invalid semantic version: ${version ?? "(missing)"}`);
  }
}

async function assertTauriVersionSource(root) {
  const tauri = await readJson(root, "src-tauri/tauri.conf.json");
  if (tauri.version !== "../package.json") {
    throw new Error(`src-tauri/tauri.conf.json must read its version from ../package.json`);
  }
}

async function check(root, tag) {
  const rootPackage = await readJson(root, "package.json");
  const version = rootPackage.version;
  assertSemver(version);

  for (const relativePath of packagePaths.slice(1)) {
    const pkg = await readJson(root, relativePath);
    if (pkg.version !== version) {
      throw new Error(`${relativePath} version ${pkg.version} does not match project version ${version}`);
    }
  }

  const lock = await readJson(root, "package-lock.json");
  if (lock.version !== version) {
    throw new Error(`package-lock.json version ${lock.version} does not match project version ${version}`);
  }
  for (const packagePath of lockPackagePaths) {
    const lockedVersion = lock.packages?.[packagePath]?.version;
    if (lockedVersion !== version) {
      const label = packagePath || "root";
      throw new Error(`package-lock.json ${label} version ${lockedVersion} does not match project version ${version}`);
    }
  }

  const cargo = await readFile(path.join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoVersion = cargo.match(/\[package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/)?.[1];
  if (cargoVersion !== version) {
    throw new Error(`src-tauri/Cargo.toml version ${cargoVersion} does not match project version ${version}`);
  }

  const cargoLock = await readFile(path.join(root, "src-tauri/Cargo.lock"), "utf8");
  const lockedCargoVersion = cargoLock.match(/\[\[package\]\]\nname = "app"\nversion = "([^"]+)"/)?.[1];
  if (lockedCargoVersion !== version) throw new Error("Cargo.lock app version does not match project version");
  await assertTauriVersionSource(root);

  if (tag) {
    if (!tag.startsWith("v")) {
      throw new Error(`tag ${tag} does not match required tag v${version}`);
    }
    if (tag !== `v${version}`) {
      throw new Error(`tag ${tag} does not match project version ${version}`);
    }
  }

  process.stdout.write(`GoodPuppy version ${version} is consistent.\n`);
}

async function set(root, version) {
  assertSemver(version);
  await check(root);

  const packages = await Promise.all(packagePaths.map(async (relativePath) => ({
    relativePath,
    value: await readJson(root, relativePath),
  })));
  const lock = await readJson(root, "package-lock.json");
  for (const packagePath of lockPackagePaths) {
    if (!lock.packages?.[packagePath]) {
      throw new Error(`package-lock.json is missing workspace entry: ${packagePath || "root"}`);
    }
  }
  await assertTauriVersionSource(root);

  const cargoPath = path.join(root, "src-tauri/Cargo.toml");
  const cargo = await readFile(cargoPath, "utf8");
  const updatedCargo = cargo.replace(
    /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+("\s*)/,
    `$1${version}$2`,
  );
  if (!/\[package\][\s\S]*?\nversion\s*=\s*"[^"]+"/.test(cargo)) throw new Error("could not find Cargo package version");

  for (const pkg of packages) {
    pkg.value.version = version;
    await writeJson(root, pkg.relativePath, pkg.value);
  }
  lock.version = version;
  for (const packagePath of lockPackagePaths) {
    lock.packages[packagePath].version = version;
  }
  await writeJson(root, "package-lock.json", lock);
  await writeFile(cargoPath, updatedCargo);
  const cargoLockPath = path.join(root, "src-tauri/Cargo.lock");
  const cargoLock = await readFile(cargoLockPath, "utf8");
  await writeFile(cargoLockPath, cargoLock.replace(/(\[\[package\]\]\nname = "app"\nversion = ")[^"]+(")/, `$1${version}$2`));

  await check(root);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "check") {
    await check(args.root, args.tag);
  } else if (args.command === "set") {
    await set(args.root, args.version);
  } else {
    throw new Error("usage: release-version.mjs check [--tag vX.Y.Z] | set X.Y.Z");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
