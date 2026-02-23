# OpenChat

OpenChat is a desktop-first chat client for MCP servers with:

- user-selectable LLM provider/model (GitHub, OpenAI, Anthropic, Google, or Custom)
- auto-discovered + manually configured MCP servers
- MCP Apps interactive UI rendering (`ui://` resources)
- an optional **🔍 XRay** explainability panel

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

## Run desktop locally

```powershell
cd <path-to-OpenChat>
npm run dev
```

- Opens Electron desktop window and uses Vite dev renderer + local API server.

## Run web locally (legacy dev flow)

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

