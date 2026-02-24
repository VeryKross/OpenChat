import { useEffect } from "react";
import { useCopilotChat } from "@copilotkit/react-core";

interface CopilotKitMcpServerConfig {
  endpoint: string;
  apiKey?: string;
}

interface CopilotKitMcpSyncProps {
  servers: CopilotKitMcpServerConfig[];
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

export function CopilotKitMcpSync({ servers }: CopilotKitMcpSyncProps) {
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
