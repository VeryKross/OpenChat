import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const targetArg = process.argv.find((arg) => arg.startsWith("--target=")) ?? "--target=all";
const target = targetArg.slice("--target=".length);

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`[build-prereq] ${message}`);
  process.exit(1);
}

function checkCommand(command, args, missingMessage) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.error) {
    fail(missingMessage);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${command} ${args.join(" ")} failed.\n${result.stderr?.trim() || result.stdout?.trim() || "(no output)"}`);
  }
}

function checkShellCommand(command, missingMessage) {
  const result = spawnSync(command, { encoding: "utf8", shell: true });
  if (result.error) {
    fail(missingMessage);
  }
  if (typeof result.status === "number" && result.status !== 0) {
    fail(`${command} failed.\n${result.stderr?.trim() || result.stdout?.trim() || "(no output)"}`);
  }
}

function checkPackageDependency(packageDir, moduleName) {
  try {
    const packageRequire = createRequire(new URL(`../${packageDir}/package.json`, import.meta.url));
    packageRequire.resolve(`${moduleName}/package.json`);
  } catch {
    fail(
      `Missing ${moduleName} dependency for "${packageDir}". Run \`npm run install:all\` from the repository root first.`
    );
  }
}

if (!["all", "win", "mac"].includes(target)) {
  fail("Usage: node desktop/build-prereq-check.mjs --target=<all|win|mac>");
}

if (!process.version) {
  fail("Node.js runtime is unavailable. Install Node.js LTS first.");
}

checkShellCommand(
  "npm --version",
  "npm is not available on PATH. Install Node.js LTS (includes npm), then restart your terminal."
);

try {
  require.resolve("electron-builder/package.json");
} catch {
  fail("electron-builder is not installed. Run `npm run install:all` at the repository root.");
}

checkPackageDependency("shared", "typescript");
checkPackageDependency("server", "typescript");
checkPackageDependency("client", "typescript");
checkPackageDependency("client", "vite");

if ((target === "mac" || target === "all") && process.platform !== "darwin") {
  fail("macOS desktop builds must run on macOS. Use `npm run build:desktop:win` on Windows.");
}

if (target === "mac") {
  checkCommand(
    "xcode-select",
    ["-p"],
    "Xcode Command Line Tools are missing. Install them with `xcode-select --install`."
  );
  checkCommand(
    "hdiutil",
    ["help"],
    "hdiutil is unavailable. This macOS tool is required to create DMG installers."
  );
}

// eslint-disable-next-line no-console
console.log(`[build-prereq] Prerequisites OK for target: ${target}`);
