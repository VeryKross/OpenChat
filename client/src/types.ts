import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type {
  ChatMessage,
  ProviderConfig,
  ServerConfig,
  XRayEventType,
  XRayEvent,
  XRayTurn,
} from "@openchat/shared";

export type {
  ChatMessage,
  ProviderConfig,
  ServerConfig,
  XRayEventType,
  XRayEvent,
  XRayTurn,
};

export interface McpConnection {
  config: ServerConfig;
  status: "connecting" | "connected" | "disconnected";
  error?: string;
  client?: Client;
  tools: Tool[];
}

export interface AliasedTool {
  aliasName: string;
  serverId: string;
  serverName: string;
  originalName: string;
  toolDef: Tool;
}

export interface UiRenderMeta {
  client?: Client;
  uiHtml: string;
  toolName: string;
  serverName?: string;
  toolArgs: Record<string, unknown>;
  toolResult: CallToolResult;
  interactive?: boolean;
}

export interface UiChatMessage extends ChatMessage {
  uiMeta?: UiRenderMeta;
}


