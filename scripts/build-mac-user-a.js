const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "src", "shared", "appConfig.js");
const builderCliPath = path.join(projectRoot, "node_modules", "electron-builder", "cli.js");
const originalConfig = fs.readFileSync(configPath, "utf8");

function selectUserA() {
  const nextConfig = originalConfig.replace(
    /const currentUser = "user_[ab]";/,
    'const currentUser = "user_a";'
  );

  if (nextConfig === originalConfig && !originalConfig.includes('const currentUser = "user_a";')) {
    throw new Error("Could not find currentUser in appConfig.js");
  }

  fs.writeFileSync(configPath, nextConfig, "utf8");
}

function buildDmg() {
  const result = spawnSync(process.execPath, [builderCliPath, "--mac", "dmg", "--arm64"], {
    cwd: projectRoot,
    stdio: "inherit"
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(`electron-builder failed with exit code ${result.status}`);
  }
}

try {
  console.log("Building GoodPuppy user_a DMG for Apple Silicon...");
  selectUserA();
  buildDmg();
} finally {
  fs.writeFileSync(configPath, originalConfig, "utf8");
}
