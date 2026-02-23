export type HelpTopicId =
  | "getting-started"
  | "llm-setup-configuration"
  | "mcp-discovery-and-connection"
  | "skills-and-custom-skills"
  | "xray-guide";

export interface HelpTopic {
  id: HelpTopicId;
  section: "Getting Started" | "Configuration" | "Skills" | "Observability";
  title: string;
  summary: string;
  markdown: string;
}

export const DEFAULT_HELP_TOPIC_ID: HelpTopicId = "getting-started";

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "getting-started",
    section: "Getting Started",
    title: "OpenChat Setup Guide",
    summary: "Start here for a complete setup sequence from provider to tools.",
    markdown: `# OpenChat Setup Guide

This guide walks through a complete first-time setup and the recommended operating flow.

## Recommended order

1. Configure your LLM provider in **Settings -> General**.
2. Load models and select the model you want to use.
3. Configure MCP servers in **Settings -> MCP Servers**.
4. Test servers, then connect enabled servers.
5. Install skills in **Settings -> Skills** if needed.
6. Start chat runs and inspect **XRay** for transparency.

## Quick readiness checklist

- Provider selected
- Authentication configured (API key or GitHub CLI mode)
- Model loaded and selected
- At least one MCP server enabled and connected (if tool calls are needed)
- Optional: artifact output directory configured
- Optional: skills installed for specialized workflows

## Key concepts

- **LLM-only mode**: You can always chat with just an LLM provider.
- **LLM + MCP mode**: Tool calls become available once MCP servers are connected.
- **Skills**: Reusable instruction packs that steer the model for repeatable tasks.
- **XRay**: A timeline of what OpenChat did, why it did it, and what happened.

## Common first-run issues

- "Load Models" fails: verify API key, provider base URL (custom providers), or \`gh auth login\`.
- Servers fail to connect: use **Test** on each server and check transport/auth settings.
- Skill appears installed but does not trigger: mention the skill name clearly in the prompt.
- File output did not occur: ask explicitly for a file artifact and include desired format/path.`,
  },
  {
    id: "llm-setup-configuration",
    section: "Configuration",
    title: "LLM Selection and Configuration",
    summary: "Provider selection, auth options, model loading, and troubleshooting.",
    markdown: `# LLM Selection and Configuration

## Provider options

- **GitHub Models**
- **OpenAI**
- **Anthropic**
- **Google**
- **Custom (OpenAI-compatible)**

Choose the provider in **Settings -> General -> Provider**.

## Authentication modes

### GitHub Models

1. **Manual token**: paste API key directly.
2. **GitHub CLI session**: select "Use GitHub CLI session" and run \`gh auth login\` beforehand.

### Other providers

- Enter the provider API key in the **API key** field.

### Custom provider

- Choose **Custom mode**:
  1. **Catalog mode**: OpenAI-compatible base URL with \`/models\` discovery and \`/chat/completions\`.
  2. **Direct endpoint mode**: single deployed endpoint (for example Azure AI Foundry/Azure OpenAI deployment URL).

#### Direct endpoint auth options

- **Entra ID bearer token** -> sent as \`Authorization: Bearer <token>\`
- **Azure OpenAI key** -> sent as \`api-key: <key>\`

In Direct endpoint mode, set:

- endpoint URL,
- credential type,
- model/deployment name.

## Model loading

1. Click **Load Models**.
2. Choose from the **Model** dropdown.
3. Saved model selections remain available even before reload (shown as saved when needed).

## Configuration import/export

- **Export Settings** writes a JSON configuration snapshot.
- **Import Settings** restores provider/model/server/theme settings.
- Secret fields are intentionally constrained by OpenChat behavior and should be managed carefully.

## Best practices

- Use a stable model for production-like workflows.
- Keep a fallback model configured for provider outages.
- Re-run "Load Models" after auth/base URL changes.
- Use smaller/cheaper models for exploratory tool development and larger models for final outputs.

## Troubleshooting

- **HTTP 401/403**: invalid token or insufficient permission scope.
- **No models returned**: wrong base URL or provider API mismatch.
- **Timeouts**: network/proxy issues or provider-side latency.
- **Unexpected responses**: verify custom provider compatibility with OpenAI-like chat/models APIs.`,
  },
  {
    id: "mcp-discovery-and-connection",
    section: "Configuration",
    title: "MCP Discovery, Selection, and Connection",
    summary: "How to add, validate, enable, and connect MCP servers reliably.",
    markdown: `# MCP Discovery, Selection, and Connection

## Discovery sources

OpenChat can discover servers from known local MCP config locations. Use **Refresh** in:

- **Settings -> MCP Servers -> Discovered Servers**

Then add discovered entries into configured servers.

## Manual server setup

Use manual setup when discovery is unavailable or for custom endpoints.

### Transport options

- **HTTP**: standard MCP over HTTP endpoint.
- **SSE (legacy HTTP)**: server-sent-events transport for older MCP stacks.
- **stdio**: local command-based server process.

### Required fields

- HTTP/SSE: URL (auth token optional).
- stdio: command + args (and optional cwd if supplied by config/discovery).

## Validation flow

1. Add server.
2. Click **Test** to validate endpoint/process and enumerate tools.
   - After a successful test, click the **tools count** link to open detailed tool metadata.
3. Fix issues shown in the status text.
4. Enable server with the checkbox.
5. Click **Connect Selected Servers**.

## Activation and connection semantics

- **Enabled** means "candidate for connection."
- **Connected** means "active and tool-capable for this chat runtime."
- You can enable many servers and selectively connect based on current workflow.

## Readiness indicators

- "Chat readiness" reports whether your current setup can execute desired workflows.
- Connection results show per-server status and available tool counts.

## Troubleshooting checklist

- Wrong transport type (HTTP vs SSE vs stdio).
- Invalid URL or unreachable host/port.
- Missing/invalid auth token.
- stdio command not found or arguments incorrect.
- Local permissions/environment differences between terminal and packaged app.`,
  },
  {
    id: "skills-and-custom-skills",
    section: "Skills",
    title: "Skills Discovery, Installation, and Custom Skill Creation",
    summary: "Find, install, manage, and author skills for repeatable behavior.",
    markdown: `# Skills Discovery and Custom Skill Creation

## Browse and install library skills

In **Settings -> Skills**:

1. Select a **Library**.
2. Choose **Install location**:
   - user-global (\`~/.openchat/skills\`)
   - project-local (\`.openchat/skills\`)
3. Click **Browse Library Skills**.
4. Install/reinstall selected skills.

## Installed skills management

- Use **Refresh Installed Skills** to sync local state.
- Filter installed skills by name/description/tags.
- **Edit** local skill definitions.
- **Remove** skills no longer needed.

## Skill dependency notes

- Some skills include additional files/assets besides \`SKILL.md\`.
- OpenChat now installs full skill directory contents from library sources.
- If a skill expects assets, keep folder structure intact.

## Create custom skill

Use **Create Custom Skill** in the Skills tab.

Recommended fields:

- **Skill name**: short, clear, and unique.
- **Description**: what it does and when to use it.
- **Instructions**: concrete behavior rules, output expectations, and constraints.

## Custom skill authoring tips

- Be explicit about output format.
- Define assumptions and edge-case behavior.
- State required tools and expected fallbacks.
- Keep instructions task-focused; avoid broad or conflicting directives.

## Skill activation behavior

- OpenChat selects matching skills based on prompt terms and skill metadata.
- XRay shows why a skill was selected and intended usage hints.
- If no MCP tools are connected, skill-guided external actions may be unavailable (the app will surface this).`,
  },
  {
    id: "xray-guide",
    section: "Observability",
    title: "XRay Guide and Node Reference",
    summary: "Understand run flow, inspect decisions, and interact with each node type.",
    markdown: `# XRay Guide

XRay visualizes each run as a timeline of nodes so you can understand model decisions and tool orchestration.

## Basic usage

- Open XRay with the header toggle.
- Expand/collapse run rows to inspect event pipelines.
- Click nodes to expand details.
- Use **Technical details** for raw data and copy-to-clipboard.

## How to read a run

1. Prompt is accepted.
2. AI reasoning/selection nodes appear.
3. Tool/server/result nodes show execution.
4. Final response and run stats close the run.

## Node-by-node glossary

### \`prompt_received\`
- The run was accepted and processing started.
- Usually the first node of each run.

### \`llm_analyzing\`
- The model is deciding next actions.
- Can appear multiple times as context evolves.

### \`skill_selected\`
- A skill matched the prompt and was applied.
- Expanded view may include match rationale, intended use, and scoring details.

### \`tool_selected\`
- The model chose a specific MCP tool for the next step.
- Shows selected tool and reasoning summary when available.

### \`server_called\`
- OpenChat executed a tool call against a server.
- Expanded view can include server, tool name, and call arguments.

### \`data_returned\`
- Tool/server response came back to the model pipeline.
- Use this to verify whether the model had enough data to continue.

### \`ui_loaded\`
- A UI resource (for example \`ui://\`) was loaded from tool output.
- Indicates app-card style content was available for rendering.

### \`ai_processing\`
- Intermediate AI interpretation/transformation over returned data.
- Often appears between tool result and response finalization.

### \`response_ready\`
- Final assistant response is complete for the run.
- This should appear near the end of each successful run.

### \`run_stats\`
- Terminal analytics node for the run.
- Includes timing, retries, tool/skill counts, bytes, tokens, and touched resources.

## Interaction tips

- Use server tabs in XRay to isolate events by server.
- Expand only suspicious nodes first to reduce noise.
- Compare \`tool_selected\` vs \`server_called\` to confirm execution alignment.
- Use \`run_stats\` to compare prompt efficiency across runs.

## Troubleshooting with XRay

- Missing tool execution: check if no connected servers or no matching tools.
- Repeated calls: inspect duplicate-block and retry behavior in run stats.
- Missing skill effects: inspect \`skill_selected\` details for selection rationale and context.
- File-output confusion: verify whether local write-file tool calls actually executed.`,
  },
];

const HELP_TOPIC_ID_SET = new Set<HelpTopicId>(HELP_TOPICS.map((topic) => topic.id));

export function isHelpTopicId(value: unknown): value is HelpTopicId {
  return typeof value === "string" && HELP_TOPIC_ID_SET.has(value as HelpTopicId);
}
