import type { CopilotErrorEvent } from "@copilotkit/shared";
import type { XRayEvent } from "../types";

type XRayListener = (event: XRayEvent) => void;

const listeners = new Set<XRayListener>();

function toXRayType(eventType: CopilotErrorEvent["type"]): XRayEvent["type"] {
  switch (eventType) {
    case "request":
      return "server_called";
    case "response":
      return "data_returned";
    case "action":
      return "tool_selected";
    case "performance":
      return "run_stats";
    case "error":
      return "run_stats";
    case "agent_state":
    case "message":
    default:
      return "ai_processing";
  }
}

function extractErrorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return undefined;
}

function truncate(text: string, max = 2200) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function safeJson(value: unknown) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function toXRayEventFromCopilotEvent(event: CopilotErrorEvent): XRayEvent {
  const source = event.context.source;
  const operation = event.context.request?.operation ?? "unknown";
  const url = event.context.request?.url ?? event.context.request?.path;
  const status = event.context.response?.status;
  const latency = event.context.response?.latency;
  const errorMessage = extractErrorMessage(event.error);

  const detailLines = [
    `Copilot event type: ${event.type}`,
    `Source: ${source}`,
    `Operation: ${operation}`,
    ...(url ? [`URL: ${url}`] : []),
    ...(typeof status === "number" ? [`Status: ${status}`] : []),
    ...(typeof latency === "number" ? [`Latency: ${latency}ms`] : []),
    ...(errorMessage ? [`Error: ${errorMessage}`] : []),
    ...(event.context.technical?.stackTrace
      ? [`Stack: ${event.context.technical.stackTrace}`]
      : []),
    ...(event.error ? [`Raw error:\n${safeJson(event.error)}`] : []),
  ];

  const summary =
    event.type === "error"
      ? `CopilotKit ${source} error during ${operation}.`
      : `CopilotKit ${event.type} from ${source} (${operation}).`;

  return {
    type: toXRayType(event.type),
    label: event.type === "error" ? "CopilotKit Error" : "CopilotKit Event",
    summary,
    timestamp: event.timestamp || Date.now(),
    resultSummary: errorMessage ?? (typeof status === "number" ? `HTTP ${status}` : operation),
    rawDetail: truncate(detailLines.join("\n")),
  };
}

export function publishCopilotKitXRayEvent(event: CopilotErrorEvent) {
  const mapped = toXRayEventFromCopilotEvent(event);
  for (const listener of listeners) listener(mapped);
}

export function subscribeCopilotKitXRayEvents(listener: XRayListener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

