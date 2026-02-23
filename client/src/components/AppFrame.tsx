import { useEffect, useRef, useState } from "react";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";

interface AppFrameProps {
  client: Client;
  uiHtml: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  toolResult: CallToolResult;
}

export function AppFrame({
  client,
  uiHtml,
  toolName,
  toolArgs,
  toolResult,
}: AppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(300);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    let disposed = false;
    let bridge: AppBridge | null = null;

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
          hostContext: {
            theme: "dark",
            platform: "web",
            containerDimensions: { width: iframe.clientWidth, maxHeight: 800 },
            displayMode: "inline",
          },
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

      await bridge.sendToolInput({ arguments: toolArgs });
      await bridge.sendToolResult(toolResult);
    };

    start().catch((error) => {
      // eslint-disable-next-line no-console
      console.error("[AppFrame] Failed to initialize AppBridge:", error);
    });

    return () => {
      disposed = true;
      void bridge?.close();
    };
  }, [client, uiHtml, toolArgs, toolName, toolResult]);

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


