import { Component, type ErrorInfo, type ReactNode } from "react";
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

interface CopilotKitBoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

interface CopilotKitBoundaryState {
  hasError: boolean;
}

class CopilotKitBoundary extends Component<CopilotKitBoundaryProps, CopilotKitBoundaryState> {
  state: CopilotKitBoundaryState = { hasError: false };

  static getDerivedStateFromError(): CopilotKitBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("[CopilotKitShell] CopilotKit provider crashed; falling back to base UI.", error, info);
  }

  render() {
    if (this.state.hasError) return this.props.fallback;
    return this.props.children;
  }
}

export function CopilotKitShell({ children }: CopilotKitShellProps) {
  if (!isCopilotKitRuntimeConfigured()) return <>{children}</>;

  return (
    <CopilotKitBoundary fallback={<>{children}</>}>
      <CopilotKit
        runtimeUrl={getCopilotKitRuntimeUrl()}
        showDevConsole={false}
        onError={(event: CopilotErrorEvent) => publishCopilotKitXRayEvent(event)}
      >
        {children}
      </CopilotKit>
    </CopilotKitBoundary>
  );
}
