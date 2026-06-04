const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const configPath = path.join(projectRoot, "src", "shared", "appConfig.js");
const releasePath = path.join(projectRoot, "release");
const sourceBuildPath = path.join(releasePath, "win-unpacked");
const users = process.argv.slice(2);
const targetUsers = users.length > 0 ? users : ["user_a", "user_b"];
const originalConfig = fs.readFileSync(configPath, "utf8");

function setCurrentUser(userId) {
  const nextConfig = originalConfig.replace(
    /const currentUser = "user_[ab]";/,
    `const currentUser = "${userId}";`
  );

  if (nextConfig === originalConfig && !originalConfig.includes(`const currentUser = "${userId}";`)) {
    throw new Error("Could not find currentUser in appConfig.js");
  }

  fs.writeFileSync(configPath, nextConfig, "utf8");
}

function runDist() {
  const builderCliPath = path.join(projectRoot, "node_modules", "electron-builder", "cli.js");
  const result = spawnSync(process.execPath, [builderCliPath, "--win", "dir"], {
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

function copyBuild(userId) {
  if (!fs.existsSync(sourceBuildPath)) {
    throw new Error(`Build output not found: ${sourceBuildPath}`);
  }

  const targetPath = path.join(releasePath, `GoodPuppy-${userId}`);
  fs.rmSync(targetPath, { recursive: true, force: true });
  fs.cpSync(sourceBuildPath, targetPath, { recursive: true });
}

try {
  for (const userId of targetUsers) {
    if (!["user_a", "user_b"].includes(userId)) {
      throw new Error(`Unsupported user: ${userId}`);
    }

    console.log(`\nBuilding GoodPuppy for ${userId}...`);
    setCurrentUser(userId);
    runDist();
    copyBuild(userId);
  }
} finally {
  fs.writeFileSync(configPath, originalConfig, "utf8");
}
