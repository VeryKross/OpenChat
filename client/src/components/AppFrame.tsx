import { useEffect, useRef, useState } from "react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  AppBridge,
  PostMessageTransport,
  type McpUiStyles,
} from "@modelcontextprotocol/ext-apps/app-bridge";

type ThemeMode = "light" | "dark" | "c64";

interface AppFrameProps {
  client: Client;
  uiHtml: string;
  toolName: string;
  serverName?: string;
  toolArgs: Record<string, unknown>;
  toolResult: CallToolResult;
  themeMode: ThemeMode;
  onBridgeEvent?: (event: AppFrameBridgeEvent) => void;
}

export interface AppFrameBridgeEvent {
  interactionId: string;
  phase: "started" | "completed" | "failed";
  timestamp: number;
  durationMs?: number;
  toolName: string;
  serverName?: string;
  toolArgs?: Record<string, unknown>;
  resultSummary?: string;
  rawDetail?: string;
}

function readCssVariable(styles: CSSStyleDeclaration, name: string) {
  const value = styles.getPropertyValue(name).trim();
  return value || undefined;
}

function getHostTheme(themeMode: ThemeMode): "light" | "dark" {
  return themeMode === "light" ? "light" : "dark";
}

function getHostStyleVariables(): McpUiStyles {
  const styles = getComputedStyle(document.documentElement);
  const shadow = readCssVariable(styles, "--shadow");

  return {
    "--color-background-primary": readCssVariable(styles, "--bg-primary"),
    "--color-background-secondary": readCssVariable(styles, "--bg-secondary"),
    "--color-background-tertiary": readCssVariable(styles, "--bg-tertiary"),
    "--color-text-primary": readCssVariable(styles, "--text-primary"),
    "--color-text-secondary": readCssVariable(styles, "--text-secondary"),
    "--color-text-inverse": readCssVariable(styles, "--text-on-accent"),
    "--color-border-primary": readCssVariable(styles, "--border-color"),
    "--color-border-secondary": readCssVariable(styles, "--border-color"),
    "--color-border-info": readCssVariable(styles, "--text-accent"),
    "--color-border-danger": readCssVariable(styles, "--error"),
    "--color-border-success": readCssVariable(styles, "--success"),
    "--color-border-warning": readCssVariable(styles, "--warning"),
    "--color-ring-primary": readCssVariable(styles, "--border-accent"),
    "--color-ring-info": readCssVariable(styles, "--text-accent"),
    "--color-ring-danger": readCssVariable(styles, "--error"),
    "--color-ring-success": readCssVariable(styles, "--success"),
    "--color-ring-warning": readCssVariable(styles, "--warning"),
    "--font-sans": readCssVariable(styles, "--font-family-base"),
    "--border-radius-sm": readCssVariable(styles, "--radius-sm"),
    "--border-radius-md": readCssVariable(styles, "--radius"),
    "--border-radius-full": readCssVariable(styles, "--radius-pill"),
    "--border-width-regular": "1px",
    "--shadow-sm": shadow ? `0 1px 2px ${shadow}` : undefined,
    "--shadow-md": shadow ? `0 4px 12px ${shadow}` : undefined,
  } as McpUiStyles;
}

function getHostContext(
  iframe: HTMLIFrameElement,
  themeMode: ThemeMode
): Parameters<AppBridge["setHostContext"]>[0] {
  return {
    theme: getHostTheme(themeMode),
    styles: { variables: getHostStyleVariables() },
    locale: navigator.language,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    userAgent: navigator.userAgent,
    platform: "web" as const,
    containerDimensions: { width: Math.max(iframe.clientWidth, 1), maxHeight: 800 },
    displayMode: "inline" as const,
  };
}

function summarizeToolResult(result: CallToolResult): { summary: string; rawDetail?: string } {
  const textResult = result.content
    .map((content) => (content.type === "text" && "text" in content ? content.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();

  if (!textResult) {
    return { summary: result.isError ? "Tool call failed." : "Tool call completed." };
  }

  return {
    summary: textResult.length > 120 ? `${textResult.slice(0, 120)}…` : textResult,
    rawDetail: textResult,
  };
}

export function AppFrame({
  client,
  uiHtml,
  toolName,
  serverName,
  toolArgs,
  toolResult,
  themeMode,
  onBridgeEvent,
}: AppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(300);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let disposed = false;
    let bridge: AppBridge | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const start = async () => {
      if (!iframe.contentWindow) return;
      const cw = iframe.contentWindow;
      const serverCaps = client.getServerCapabilities?.();

      bridge = new AppBridge(
        client,
        { name: "OpenChat", version: "0.1.0" },
        {
          serverTools: serverCaps?.tools ? { listChanged: Boolean(serverCaps.tools.listChanged) } : undefined,
          serverResources: serverCaps?.resources
            ? { listChanged: Boolean(serverCaps.resources.listChanged) }
            : undefined,
          openLinks: {},
        },
        {
          hostContext: getHostContext(iframe, themeMode),
        }
      );

      bridge.onsizechange = (size) => {
        if (size.height && size.height > 0) {
          setHeight(Math.min(size.height + 20, 800));
        }
      };

      const transport = new PostMessageTransport(cw, cw);
      const connectPromise = bridge.connect(transport);

      cw.document.open();
      cw.document.write(uiHtml);
      cw.document.close();
      await connectPromise;

      if (disposed) {
        await bridge.close();
        return;
      }

      bridge.oncalltool = async (params, extra) => {
        const startedAt = Date.now();
        const interactionId = `${startedAt}-${Math.random().toString(36).slice(2, 8)}`;
        const interactionArgs =
          params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments)
            ? (params.arguments as Record<string, unknown>)
            : {};
        onBridgeEvent?.({
          interactionId,
          phase: "started",
          timestamp: startedAt,
          toolName: params.name,
          serverName,
          toolArgs: interactionArgs,
        });

        try {
          const result = (await client.callTool(params, undefined, {
            signal: extra.signal,
          })) as CallToolResult;
          const endedAt = Date.now();
          const resultInfo = summarizeToolResult(result);
          onBridgeEvent?.({
            interactionId,
            phase: "completed",
            timestamp: endedAt,
            durationMs: Math.max(endedAt - startedAt, 0),
            toolName: params.name,
            serverName,
            toolArgs: interactionArgs,
            resultSummary: resultInfo.summary,
            rawDetail: resultInfo.rawDetail,
          });
          return result;
        } catch (error) {
          const endedAt = Date.now();
          const errorMessage = error instanceof Error ? error.message : String(error);
          onBridgeEvent?.({
            interactionId,
            phase: "failed",
            timestamp: endedAt,
            durationMs: Math.max(endedAt - startedAt, 0),
            toolName: params.name,
            serverName,
            toolArgs: interactionArgs,
            resultSummary: errorMessage,
            rawDetail: errorMessage,
          });
          throw error;
        }
      };

      bridge.setHostContext(getHostContext(iframe, themeMode));
      if (typeof ResizeObserver !== "undefined") {
        resizeObserver = new ResizeObserver(() => {
          bridge?.setHostContext(getHostContext(iframe, themeMode));
        });
        resizeObserver.observe(iframe);
      }

      await bridge.sendToolInput({ arguments: toolArgs });
      await bridge.sendToolResult(toolResult);
    };

    start().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[AppFrame] Failed to initialize AppBridge:", error);
    });

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      void bridge?.close();
    };
  }, [client, onBridgeEvent, serverName, uiHtml, toolArgs, toolName, toolResult, themeMode]);

  return (
    <div className="app-frame">
      <iframe
        ref={iframeRef}
        sandbox="allow-scripts allow-same-origin allow-forms"
        style={{ height: `${height}px` }}
        title={`${toolName} UI`}
      />
    </div>
  );
}


