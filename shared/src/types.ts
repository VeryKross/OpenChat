export type LlmProviderType =
  | "github-models"
  | "openai"
  | "anthropic"
  | "google"
  | "custom";

export type GithubProviderAuthMode = "manual" | "gh-cli";
export type CustomProviderMode = "catalog" | "direct-endpoint";
export type CustomDirectAuthMode = "entra-bearer" | "azure-api-key";

export interface ProviderConfig {
  id: string;
  type: LlmProviderType;
  label: string;
  model: string;
  apiKey: string;
  authMode?: GithubProviderAuthMode;
  baseUrl?: string;
  customMode?: CustomProviderMode;
  directEndpointUrl?: string;
  directAuthMode?: CustomDirectAuthMode;
  directModelName?: string;
}

export interface ServerConfig {
  id: string;
  name: string;
  transport?: "http" | "sse" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled: boolean;
  description?: string;
  authToken?: string;
}

export interface DiscoveredServerConfig extends ServerConfig {
  source: string;
  discovered: boolean;
  supportedTransport: boolean;
}

export interface ChatMessage {
  role: "user" | "assistant" | "tool" | "error";
  content: string;
  toolName?: string;
  serverId?: string;
  uiHtml?: string;
}

export type XRayEventType =
  | "prompt_received"
  | "llm_analyzing"
  | "skill_selected"
  | "tool_selected"
  | "server_called"
  | "data_returned"
  | "ui_loaded"
  | "ai_processing"
  | "response_ready"
  | "run_stats";

export interface XRayEvent {
  type: XRayEventType;
  label: string;
  summary: string;
  timestamp: number;
  durationMs?: number;
  skillName?: string;
  toolName?: string;
  serverName?: string;
  toolArgs?: Record<string, unknown>;
  resultSummary?: string;
  rawDetail?: string;
}

export interface XRayTurn {
  prompt: string;
  startedAt: number;
  complete: boolean;
  events: XRayEvent[];
}

export interface LlmRequestPayload {
  provider: ProviderConfig;
  messages: Array<Record<string, unknown>>;
  tools?: Array<Record<string, unknown>>;
  temperature?: number;
}

