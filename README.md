# OpenChat

OpenChat is a desktop AI chat client intended to be helpful when learning how to work MCP Servers and Skills:

- User-selectable LLM provider/model (GitHub, OpenAI, Anthropic, Google, or Custom)
- Auto-discovered + manually configured MCP servers
- Installable Skills from online Skills library + manually created Skills
- Edit installed Skills to learn how they work
- MCP Apps interactive UI rendering (`ui://` resources)
- View full tool descriptions for registred MCP servers
- An optional **🔍 XRay** explainability panel
  - Each node represents part of the conversation loop
  - Nodes can be expanded to show addition details
  - End node provides statistics for run, including token usage
- Native installers provided for Windows x64 and ARM64, as well as Mac (zip and dmg)
- Supports multiple UI styles (Dark, Light, custom) to help when testing MCP Server app extension UIs

### Dark Mode
<img width="2142" height="1431" alt="image" src="https://github.com/user-attachments/assets/30cbc200-2010-44a1-91de-982e8da6d189" />

### Light Mode
<img width="2139" height="1346" alt="image" src="https://github.com/user-attachments/assets/9e687572-b3e5-4c35-8869-89bf65e65d08" />

### C64 Mode 🤣
<img width="2139" height="1346" alt="image" src="https://github.com/user-attachments/assets/3f74850e-8e56-4841-b3a1-f1a463e3a5e8" />

## Folder layout

```text
<path-to-OpenChat>
├─ client/   # React + Vite UI
├─ desktop/  # Electron main + preload runtime
├─ server/   # Local Node API (provider proxy + discovery + validation)
└─ shared/   # Shared TypeScript contracts
```

## Technical documentation

- [CopilotKit Integration](./COPILOTKIT_INTEGRATION.md)

## Prerequisites

- Node.js LTS (includes npm) installed and available on PATH.
- From repository root, install dependencies (root + package folders):

```bash
npm run install:all
```

- Verify toolchain:

```bash
node -v
npm -v
```

If `npm` is not found on macOS, install Node.js LTS first (for example via [nodejs.org](https://nodejs.org), Homebrew, or nvm), then open a new terminal session.
If builds fail with `tsc: command not found`, run `npm run install:all` from the repository root.

## Run desktop locally

```powershell
cd <path-to-OpenChat>
npm run dev
```

- Opens Electron desktop window and uses Vite dev renderer + local API server.

## Run web locally

```powershell
cd <path-to-OpenChat>
npm run dev:web
```

- Client: http://localhost:5180
- Server: http://localhost:4173

## Build

```powershell
cd <path-to-OpenChat>
npm run build
```

## Build desktop installers (Windows + macOS)

```powershell
cd <path-to-OpenChat>
npm run build:desktop
```

Desktop build commands run a prerequisite check first and will fail fast with setup guidance when required tooling is missing.

### Internal/beta unsigned installers

```powershell
npm run build:desktop:unsigned
```

### Platform-specific installer builds

```powershell
npm run build:desktop:win
npm run build:desktop:mac
```

> Note: macOS installer generation typically needs to run on macOS for signing/notarization workflows.

### Signing/notarization environment variables (production release)

- Windows signing:
  - `WINDOWS_CSC_LINK`
  - `WINDOWS_CSC_KEY_PASSWORD`
- macOS signing/notarization:
  - `MACOS_CSC_LINK`
  - `MACOS_CSC_KEY_PASSWORD`
  - `APPLE_ID`
  - `APPLE_APP_SPECIFIC_PASSWORD`
  - `APPLE_TEAM_ID`

- Preflight checks:
  - `npm run release:preflight:win`
  - `npm run release:preflight:mac`

### CI installer workflow

- Workflow file: `.github/workflows/desktop-installers.yml`
- Builds:
  - Windows NSIS installer on `windows-latest`
  - macOS DMG/ZIP on `macos-latest`
- Outputs are uploaded as GitHub Actions artifacts.

### GitHub release flow (recommended)

To create a **new** release predictably:

1. Bump `version` in root `package.json` (for example `0.1.2` → `0.1.3`) and merge to `main`.
2. Run workflow **Publish Release** (`.github/workflows/publish-current.yml`) from `main`.
3. Enter the same version string in the `version` input (example: `0.1.3`).
4. Leave `update_existing=false` for normal releases (this prevents silently overwriting an existing tag/release).

What this workflow does:
- Verifies the requested release version matches `package.json`.
- Builds Windows + macOS installers.
- Validates artifact filenames match that version.
- Creates GitHub release tag `v<version>` at the current `main` commit and publishes installers.

Important behavior:
- **Desktop Installers** run manually is build-only (unless triggered by a `v*` tag push).
- **Publish Release** is the canonical release entry point for producing a new versioned GitHub release.

### App icon assets

- Branded installer/app icons live in `desktop/assets/icons`:
  - `openchat.ico` (Windows)
  - `openchat.icns` (macOS)
  - `openchat.png` (master PNG source)

### Installer smoke checklist

- Install OpenChat from generated installer.
- Launch app and verify window icon + taskbar/dock icon.
- Verify chat/settings/XRay open correctly.
- Upgrade by installing newer build over previous.
- Uninstall and confirm shortcuts/app bundle are removed.

## Notes

- Open in-app docs via **Help menu -> Open Help Center** (or the header **❓ Help** button).
- Help Center includes exhaustive setup topics for providers, MCP connection workflows, skills/custom skills, and XRay node reference.
- In **Settings → General**, click **Load Models** after configuring provider auth.
- Custom provider supports:
  - **Catalog mode** (OpenAI-compatible `/models` + `/chat/completions`)
  - **Direct endpoint mode** for single deployed endpoints (for example Azure AI Foundry/Azure OpenAI), with selectable auth style (`Authorization: Bearer` or `api-key`).
- For **GitHub Models**, you can use a manual token or your signed-in GitHub CLI session (`gh auth login`).
- Custom provider expects an OpenAI-compatible base URL and `/models` endpoint.
- Skill-guided file artifacts are written under the OpenChat project root using relative paths.
- `.excalidraw` artifacts written through skills are auto-normalized for Excalidraw import compatibility when possible.
- Explicit file requests (for example “save as report.md”) can trigger local file output via OpenChat tooling even without a matched skill.
- "Connect Selected Servers" now reports explicit connection results and errors per server.
- API keys are intentionally **not persisted** to local storage.
- Imported/exported setup files also omit secret fields.
- Use each server's native auth/token configuration for production usage.
- If you move this folder, run `npm --prefix server install` and `npm --prefix client install` to refresh local `file:` package links.

