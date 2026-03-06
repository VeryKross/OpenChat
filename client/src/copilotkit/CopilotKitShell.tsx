import { Component, createContext, useContext, type ErrorInfo, type ReactNode } from "react";
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

const CopilotKitAvailabilityContext = createContext(false);

export function useCopilotKitAvailable() {
  return useContext(CopilotKitAvailabilityContext);
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
  if (!isCopilotKitRuntimeConfigured()) {
    return <CopilotKitAvailabilityContext.Provider value={false}>{children}</CopilotKitAvailabilityContext.Provider>;
  }

  return (
    <CopilotKitBoundary
      fallback={<CopilotKitAvailabilityContext.Provider value={false}>{children}</CopilotKitAvailabilityContext.Provider>}
    >
      <CopilotKitAvailabilityContext.Provider value={true}>
        <CopilotKit
          runtimeUrl={getCopilotKitRuntimeUrl()}
          showDevConsole={false}
          onError={(event: CopilotErrorEvent) => publishCopilotKitXRayEvent(event)}
        >
          {children}
        </CopilotKit>
      </CopilotKitAvailabilityContext.Provider>
    </CopilotKitBoundary>
  );
}
