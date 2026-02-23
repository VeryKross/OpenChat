import { useCallback, useRef, useState } from "react";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { McpConnection, ServerConfig } from "../types";
import { apiFetch } from "../lib/api";

type TransportMap = Map<string, StreamableHTTPClientTransport | SSEClientTransport>;
type ServerTestResult = { ok?: boolean; tools?: Tool[]; error?: string };

export function useMcpConnections() {
  const [connections, setConnections] = useState<McpConnection[]>([]);
  const transportsRef = useRef<TransportMap>(new Map());
  const connectionsRef = useRef<McpConnection[]>([]);

  const disconnectAll = useCallback(async () => {
    const current = [...connectionsRef.current];
    for (const connection of current) {
      try {
        await connection.client?.close();
      } catch {
        // Ignore close failures
      }
      try {
        await transportsRef.current.get(connection.config.id)?.close();
      } catch {
        // Ignore transport close failures
      }
    }
    transportsRef.current.clear();
    connectionsRef.current = [];
    setConnections([]);
  }, []);

  const connectServers = useCallback(async (servers: ServerConfig[]) => {
    await disconnectAll();
    const enabled = servers.filter((s) => s.enabled);
    if (enabled.length === 0) {
      connectionsRef.current = [];
      setConnections([]);
      return { connected: 0, failed: 0 };
    }

    const connecting = enabled.map((config) => ({ config, status: "connecting", tools: [] })) as McpConnection[];
    connectionsRef.current = connecting;
    setConnections(connecting);

    const nextConnections: McpConnection[] = [];
    let connected = 0;
    let failed = 0;
    for (const config of enabled) {
      try {
        const transportType = config.transport ?? (config.command ? "stdio" : "http");
        if (transportType === "stdio") {
          const response = await apiFetch("/api/servers/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              transport: "stdio",
              command: config.command,
              args: config.args,
              env: config.env,
              cwd: config.cwd,
            }),
          });
          const data = (await response.json()) as ServerTestResult;
          if (!response.ok || !data.ok) {
            throw new Error(data.error ?? "Unknown stdio connection error");
          }

          nextConnections.push({
            config,
            status: "connected",
            tools: data.tools ?? [],
          });
        } else {
          if (!config.url) {
            throw new Error(`${transportType.toUpperCase()} server is missing a URL.`);
          }
          const requestHeaders = config.authToken
            ? { Authorization: `Bearer ${config.authToken}` }
            : undefined;
          const transport =
            transportType === "sse"
              ? new SSEClientTransport(new URL(config.url), {
                  requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
                })
              : new StreamableHTTPClientTransport(new URL(config.url), {
                  requestInit: requestHeaders ? { headers: requestHeaders } : undefined,
                });
          const client = new Client({ name: "OpenChat", version: "0.1.0" });
          await client.connect(transport);
          const listed = await client.listTools();
          transportsRef.current.set(config.id, transport);
          nextConnections.push({
            config,
            status: "connected",
            client,
            tools: listed.tools,
          });
        }
        connected += 1;
      } catch (error) {
        nextConnections.push({
          config,
          status: "disconnected",
          tools: [],
          error: error instanceof Error ? error.message : String(error),
        });
        failed += 1;
      }
      connectionsRef.current = [...nextConnections];
      setConnections([...nextConnections]);
    }
    return { connected, failed };
  }, [disconnectAll]);

  return { connections, connectServers, disconnectAll };
}


