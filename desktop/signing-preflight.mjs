const platform = (process.argv[2] ?? "").toLowerCase();

function has(name) {
  return typeof process.env[name] === "string" && process.env[name].trim().length > 0;
}

function fail(message) {
  // eslint-disable-next-line no-console
  console.error(`[signing-preflight] ${message}`);
  process.exit(1);
}

if (platform !== "win" && platform !== "mac") {
  fail("Usage: node desktop/signing-preflight.mjs <win|mac>");
}

if (platform === "win") {
  const hasLink = has("CSC_LINK");
  const hasPassword = has("CSC_KEY_PASSWORD");
  if (hasLink !== hasPassword) {
    fail("Windows signing config is partial. Set both CSC_LINK and CSC_KEY_PASSWORD, or neither.");
  }
  // eslint-disable-next-line no-console
  console.log(
    hasLink
      ? "[signing-preflight] Windows build will run with code signing enabled."
      : "[signing-preflight] Windows build will run unsigned (internal/beta mode)."
  );
  process.exit(0);
}

const hasCscLink = has("CSC_LINK");
const hasCscPassword = has("CSC_KEY_PASSWORD");
const hasAppleId = has("APPLE_ID");
const hasApplePassword = has("APPLE_APP_SPECIFIC_PASSWORD");
const hasAppleTeam = has("APPLE_TEAM_ID");
const hasAppleNotarySet = hasAppleId && hasApplePassword && hasAppleTeam;

if (hasCscLink !== hasCscPassword) {
  fail("macOS signing config is partial. Set both CSC_LINK and CSC_KEY_PASSWORD, or neither.");
}
if ((hasAppleId || hasApplePassword || hasAppleTeam) && !hasAppleNotarySet) {
  fail(
    "macOS notarization config is partial. Set APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID together."
  );
}
if (hasAppleNotarySet && !hasCscLink) {
  fail("Notarization credentials are present but macOS signing credentials are missing.");
}

// eslint-disable-next-line no-console
console.log(
  hasCscLink
    ? hasAppleNotarySet
      ? "[signing-preflight] macOS build will run with signing + notarization."
      : "[signing-preflight] macOS build will run with signing only."
    : "[signing-preflight] macOS build will run unsigned (internal/beta mode)."
);
