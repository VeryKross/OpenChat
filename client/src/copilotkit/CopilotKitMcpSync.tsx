import { Component, useEffect, type ReactNode } from "react";
import { useCopilotChat } from "@copilotkit/react-core";

/**
 * Keeps CopilotKit's MCP server list synchronized with OpenChat-managed server settings.
 * Depends on CopilotKit chat context (`useCopilotChat`) and deterministic server normalization.
 */
interface CopilotKitMcpServerConfig {
  endpoint: string;
  apiKey?: string;
}

interface CopilotKitMcpSyncProps {
  servers: CopilotKitMcpServerConfig[];
}

interface CopilotKitMcpSyncBoundaryProps {
  children: ReactNode;
}

interface CopilotKitMcpSyncBoundaryState {
  hasError: boolean;
}

function normalizeServers(servers: CopilotKitMcpServerConfig[]) {
  return [...servers]
    .map((server) => ({
      endpoint: server.endpoint.trim(),
      apiKey: server.apiKey?.trim() || undefined,
    }))
    .filter((server) => server.endpoint.length > 0)
    .sort((a, b) =>
      `${a.endpoint}|${a.apiKey ?? ""}`.localeCompare(`${b.endpoint}|${b.apiKey ?? ""}`)
    );
}

function CopilotKitMcpSyncInner({ servers }: CopilotKitMcpSyncProps) {
  const { mcpServers, setMcpServers } = useCopilotChat();

  useEffect(() => {
    if (typeof setMcpServers !== "function") return;
    const next = normalizeServers(servers);
    const current = normalizeServers(Array.isArray(mcpServers) ? mcpServers : []);
    if (JSON.stringify(next) === JSON.stringify(current)) return;
    setMcpServers(next);
  }, [mcpServers, servers, setMcpServers]);

  return null;
}

class CopilotKitMcpSyncBoundary extends Component<
  CopilotKitMcpSyncBoundaryProps,
  CopilotKitMcpSyncBoundaryState
> {
  state: CopilotKitMcpSyncBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CopilotKitMcpSyncBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown) {
    console.error("[CopilotKitMcpSync] Disabling MCP sync because CopilotKit context is unavailable.", error);
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

/**
 * Headless bridge component that updates CopilotKit MCP config only when normalized server inputs differ.
 * The boundary prevents provider-context failures from blanking the entire application UI.
 */
export function CopilotKitMcpSync({ servers }: CopilotKitMcpSyncProps) {
  return (
    <CopilotKitMcpSyncBoundary>
      <CopilotKitMcpSyncInner servers={servers} />
    </CopilotKitMcpSyncBoundary>
  );
}
