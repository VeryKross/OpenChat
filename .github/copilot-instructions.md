# Copilot Instructions for OpenChat

## Build, test, and lint commands

Run from repository root (`D:\_V\AI\McpChat`):

- `npm run dev` - builds `shared` + `server`, then runs server (`4173`) and client (`5180`) together.
- `npm run dev:watch` - runs server watch mode (`tsx watch`) and client dev server together.
- `npm run build` - builds `shared`, `server`, and `client` in that order.
- `npm --prefix shared run build` - compile shared TypeScript contracts only.
- `npm --prefix server run build` - compile server only.
- `npm --prefix server run start` - run built server from `server/dist/index.js`.
- `npm --prefix client run build` - TypeScript build + Vite production build for client.
- `npm --prefix client run preview` - preview built client.

Test/lint status in current repo:

- There are no project test scripts yet (`test`) in root/client/server/shared `package.json`.
- There are no lint scripts yet (`lint`).
- Single-test command is not available until a test runner is added.

## High-level architecture

- Monorepo with three packages:
  - `shared/`: shared TypeScript contracts (`ProviderConfig`, `ServerConfig`, `ChatMessage`, X-Ray event types).
  - `server/`: Express API for provider calls, model discovery, MCP discovery, stdio tool execution, and MCP connection tests.
  - `client/`: React + Vite UI for settings, server management, chat, tool-driven responses, and optional "Under the Hood" trace UI.
- Client calls backend with relative `/api/*` routes; Vite proxy in `client/vite.config.ts` forwards `/api` to `http://localhost:4173`.
- LLM provider integration is centralized in `server/src/index.ts`:
  - Provider-specific endpoints/auth/body are normalized there.
  - Anthropic/Google responses are reshaped into OpenAI-like `choices[0].message.content` for client consistency.
- MCP execution split by transport:
  - HTTP MCP servers connect directly from browser (`useMcpConnections`) via MCP SDK `StreamableHTTPClientTransport`.
  - Stdio MCP servers are executed via server endpoints (`/api/servers/test`, `/api/servers/call-stdio`) since browser cannot spawn local processes.
- Chat orchestration (`client/src/hooks/chatService.ts`) runs multi-round tool-calling with capped history, duplicate tool-call blocking, and X-Ray event emission.
- Interactive MCP app rendering (`ui://`) is handled in `AppFrame` via `@modelcontextprotocol/ext-apps` `AppBridge`; stdio results fall back to static iframe preview.
- Next phase note: the project is expected to evolve into a desktop-hosted app (VS Code-style), so new changes should avoid hard-coding assumptions that only web/browser hosting will exist.

## Key conventions

- Tool names are server-scoped in the client as `${serverId}__${toolName}` to avoid collisions across connected servers.
- `chatService.ts` sanitizes tool names for OpenAI function schema and keeps an alias map back to original MCP tool names.
- Keep API responses user-facing and parse-safe: many endpoints intentionally parse `response.text()` then JSON-decode with explicit fallback messages.
- Server discovery reads multiple local config sources (`.vscode/mcp.json`, user-level VS Code and Copilot MCP config) and supports both `servers` and `mcpServers` keys.
- Manual/discovered server entries are merged with duplicate checks based on transport + endpoint/command shape before being added.
- Settings → General expects model discovery via **Load Models** after entering provider credentials; this is the canonical way to populate valid model IDs.
- Custom provider behavior is OpenAI-compatible: `/chat/completions` is appended if missing for chat, and `/models` is used for model discovery.
- Persisted/exported server configs intentionally strip `authToken` from `servers` payloads in `App.tsx`.
