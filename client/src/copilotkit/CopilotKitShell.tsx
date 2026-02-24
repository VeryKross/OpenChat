import type { ReactNode } from "react";
import type { CopilotErrorEvent } from "@copilotkit/shared";
import { CopilotKit } from "@copilotkit/react-core";
import {
  getCopilotKitRuntimeUrl,
  isCopilotKitRuntimeConfigured,
} from "../lib/featureFlags";
import { publishCopilotKitXRayEvent } from "./xrayAdapter";

interface CopilotKitShellProps {
  children: ReactNode;
}

export function CopilotKitShell({ children }: CopilotKitShellProps) {
  if (!isCopilotKitRuntimeConfigured()) return <>{children}</>;

  return (
    <CopilotKit
      runtimeUrl={getCopilotKitRuntimeUrl()}
      showDevConsole={false}
      onError={(event: CopilotErrorEvent) => publishCopilotKitXRayEvent(event)}
    >
      {children}
    </CopilotKit>
  );
}
