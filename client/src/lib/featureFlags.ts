import { getApiBaseUrl } from "./api";

function readStringFlag(name: string, defaultValue = "") {
  const raw = String(import.meta.env[name] ?? "").trim();
  return raw || defaultValue;
}

export function getCopilotKitRuntimeUrl() {
  const configured = readStringFlag("VITE_COPILOTKIT_RUNTIME_URL", "/api/copilotkit/runtime");
  if (/^https?:\/\//i.test(configured)) return configured;
  const normalizedPath = configured.startsWith("/") ? configured : `/${configured}`;
  const apiBase = getApiBaseUrl();
  if (!apiBase) return normalizedPath;
  return `${apiBase}${normalizedPath}`;
}

export function isCopilotKitRuntimeConfigured() {
  return getCopilotKitRuntimeUrl().length > 0;
}

export function getOrchestrationModeLabel() {
  return "CopilotKit route";
}
