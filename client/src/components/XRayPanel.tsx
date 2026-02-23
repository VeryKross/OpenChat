import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { XRayEvent, XRayEventType, XRayTurn } from "../types";

interface XRayPanelProps {
  turns: XRayTurn[];
  serverNames: string[];
  themeMode: "light" | "dark" | "c64";
  onClose: () => void;
}

const EVENT_META_DARK: Record<XRayEventType, { icon: string; color: string; bg: string }> = {
  prompt_received: { icon: "👤", color: "#58a6ff", bg: "rgba(88,166,255,0.12)" },
  llm_analyzing: { icon: "🧠", color: "#bc8cff", bg: "rgba(188,140,255,0.12)" },
  skill_selected: { icon: "🧩", color: "#7ee787", bg: "rgba(126,231,135,0.12)" },
  tool_selected: { icon: "🎯", color: "#f0883e", bg: "rgba(240,136,62,0.12)" },
  server_called: { icon: "⚡", color: "#d29922", bg: "rgba(210,153,34,0.12)" },
  data_returned: { icon: "📊", color: "#3fb950", bg: "rgba(63,185,80,0.12)" },
  ui_loaded: { icon: "🖼️", color: "#22d3ee", bg: "rgba(34,211,238,0.12)" },
  ai_processing: { icon: "⚙️", color: "#bc8cff", bg: "rgba(188,140,255,0.10)" },
  response_ready: { icon: "💬", color: "#56d364", bg: "rgba(86,211,100,0.12)" },
  run_stats: { icon: "📈", color: "#60a5fa", bg: "rgba(96,165,250,0.15)" },
};

const EVENT_META_LIGHT: Record<XRayEventType, { icon: string; color: string; bg: string }> = {
  prompt_received: { icon: "👤", color: "#0969da", bg: "rgba(9,105,218,0.18)" },
  llm_analyzing: { icon: "🧠", color: "#8250df", bg: "rgba(130,80,223,0.18)" },
  skill_selected: { icon: "🧩", color: "#1a7f37", bg: "rgba(26,127,55,0.18)" },
  tool_selected: { icon: "🎯", color: "#b35900", bg: "rgba(179,89,0,0.18)" },
  server_called: { icon: "⚡", color: "#9a6700", bg: "rgba(154,103,0,0.2)" },
  data_returned: { icon: "📊", color: "#1a7f37", bg: "rgba(26,127,55,0.18)" },
  ui_loaded: { icon: "🖼️", color: "#0e7490", bg: "rgba(14,116,144,0.18)" },
  ai_processing: { icon: "⚙️", color: "#8250df", bg: "rgba(130,80,223,0.16)" },
  response_ready: { icon: "💬", color: "#1a7f37", bg: "rgba(26,127,55,0.18)" },
  run_stats: { icon: "📈", color: "#0969da", bg: "rgba(9,105,218,0.2)" },
};

const EVENT_META_C64: Record<XRayEventType, { icon: string; color: string; bg: string }> = {
  prompt_received: { icon: "👤", color: "#d8e4ff", bg: "rgba(216,228,255,0.2)" },
  llm_analyzing: { icon: "🧠", color: "#ffe08a", bg: "rgba(255,224,138,0.22)" },
  skill_selected: { icon: "🧩", color: "#b7f6b0", bg: "rgba(183,246,176,0.2)" },
  tool_selected: { icon: "🎯", color: "#ffd37a", bg: "rgba(255,211,122,0.2)" },
  server_called: { icon: "⚡", color: "#ffeb99", bg: "rgba(255,235,153,0.2)" },
  data_returned: { icon: "📊", color: "#b7f6b0", bg: "rgba(183,246,176,0.2)" },
  ui_loaded: { icon: "🖼️", color: "#9ff6ff", bg: "rgba(159,246,255,0.18)" },
  ai_processing: { icon: "⚙️", color: "#ffe08a", bg: "rgba(255,224,138,0.18)" },
  response_ready: { icon: "💬", color: "#c9ffd4", bg: "rgba(201,255,212,0.2)" },
  run_stats: { icon: "📈", color: "#d8e4ff", bg: "rgba(216,228,255,0.24)" },
};

function formatDuration(ms?: number) {
  if (!ms || ms < 0) return "";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

function EventNode({
  event,
  first,
  themeMode,
}: {
  event: XRayEvent;
  first: boolean;
  themeMode: "light" | "dark" | "c64";
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const meta =
    themeMode === "light"
      ? EVENT_META_LIGHT[event.type]
      : themeMode === "c64"
        ? EVENT_META_C64[event.type]
        : EVENT_META_DARK[event.type];
  const argsText = event.toolArgs ? JSON.stringify(event.toolArgs, null, 2) : "";
  const copyRawDetail = async (e: MouseEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (!event.rawDetail) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(event.rawDetail);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = event.rawDetail;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div className="xray-step">
      {!first && (
        <div className="xray-arrow">
          {event.durationMs && event.durationMs > 0 && (
            <span className="xray-duration">{formatDuration(event.durationMs)}</span>
          )}
          <span className="xray-arrow-line">▶</span>
        </div>
      )}
      <div
        className={`xray-node ${expanded ? "expanded" : ""}`}
        style={{ borderColor: meta.color, background: meta.bg }}
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="xray-node-header">
          <span className="xray-node-icon">{meta.icon}</span>
          <span className="xray-node-label" style={{ color: meta.color }}>
            {event.label}
          </span>
        </div>
        <div className="xray-node-summary">{event.summary}</div>
        {expanded && (
          <div className="xray-node-detail">
            {event.serverName && (
              <div className="xray-detail-row">
                <span className="xray-detail-key">Server:</span>
                <span className="xray-detail-val">{event.serverName}</span>
              </div>
            )}
            {event.skillName && (
              <div className="xray-detail-row">
                <span className="xray-detail-key">Skill:</span>
                <span className="xray-detail-val">{event.skillName}</span>
              </div>
            )}
            {event.toolName && (
              <div className="xray-detail-row">
                <span className="xray-detail-key">Tool:</span>
                <span className="xray-detail-val">{event.toolName}</span>
              </div>
            )}
            {event.toolArgs && event.type === "server_called" && (
              <div className="xray-detail-row xray-detail-row-block">
                <span className="xray-detail-key">Args:</span>
                <pre className="xray-detail-json">{argsText}</pre>
              </div>
            )}
            {event.resultSummary && (
              <div className="xray-detail-row">
                <span className="xray-detail-key">Result:</span>
                <span className="xray-detail-val">{event.resultSummary}</span>
              </div>
            )}
            {event.rawDetail && (
              <details className="xray-raw" onClick={(e) => e.stopPropagation()}>
                <summary className="xray-raw-summary">
                  <span>Technical details</span>
                  <button
                    type="button"
                    className="xray-copy-btn"
                    onClick={copyRawDetail}
                    title={copied ? "Copied" : "Copy to clipboard"}
                    aria-label={copied ? "Copied" : "Copy technical details to clipboard"}
                  >
                    {copied ? "✅" : "📋"}
                  </button>
                </summary>
                <pre>{event.rawDetail}</pre>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function TurnRow({
  turn,
  serverFilter,
  themeMode,
}: {
  turn: XRayTurn;
  serverFilter: string;
  themeMode: "light" | "dark" | "c64";
}) {
  const [collapsed, setCollapsed] = useState(false);
  const pipelineRef = useRef<HTMLDivElement>(null);
  const tailRef = useRef<HTMLDivElement>(null);
  const events =
    serverFilter === "all"
      ? turn.events
      : turn.events.filter((e) => !e.serverName || e.serverName === serverFilter);
  if (events.length === 0) return null;

  const totalMs =
    events.length > 0 ? events[events.length - 1].timestamp - turn.startedAt : undefined;
  const lastEventTimestamp = events[events.length - 1]?.timestamp ?? turn.startedAt;

  // Auto-scroll pipeline to the right when new events arrive, including completion.
  useEffect(() => {
    if (collapsed) return;
    const frame = window.requestAnimationFrame(() => {
      const el = pipelineRef.current;
      if (!el) return;
      el.scrollLeft = el.scrollWidth;
      tailRef.current?.scrollIntoView({ block: "nearest", inline: "end" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [events.length, lastEventTimestamp, turn.complete, collapsed]);

  return (
    <div className="xray-turn">
      <div
        className={`xray-turn-header${!turn.complete ? " xray-turn-active" : ""}`}
        onClick={() => setCollapsed((v) => !v)}
      >
        <span className="xray-turn-chevron">{collapsed ? "▶" : "▼"}</span>
        <span className="xray-turn-prompt">"{turn.prompt}"</span>
        <span className="xray-turn-meta">
          {events.length} steps
          {totalMs !== undefined && ` · ${formatDuration(totalMs)}`}
          {!turn.complete && " · ⏳"}
        </span>
      </div>
      {!collapsed && (
        <div className="xray-pipeline" ref={pipelineRef}>
          {events.map((event, i) => (
            <EventNode
              key={`${turn.startedAt}-${i}`}
              event={event}
              first={i === 0}
              themeMode={themeMode}
            />
          ))}
          <div ref={tailRef} className="xray-tail-anchor" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export function XRayPanel({ turns, serverNames, themeMode, onClose }: XRayPanelProps) {
  const tabs = useMemo(() => ["all", ...serverNames], [serverNames]);
  const [activeTab, setActiveTab] = useState("all");
  const hasServerFilters = tabs.length > 1;

  return (
    <div className="xray-overlay">
      <div className="xray-panel">
        <div className="xray-header">
          <span className="xray-title">🔍 XRay</span>
          {hasServerFilters ? (
            <div className="xray-tabs">
              {tabs.map((tab) => (
                <button
                  key={tab}
                  className={`xray-tab ${activeTab === tab ? "active" : ""}`}
                  onClick={() => setActiveTab(tab)}
                >
                  {tab === "all" ? "All Servers" : tab}
                </button>
              ))}
            </div>
          ) : (
            <span className="xray-tab-static">All Servers</span>
          )}
          <button className="xray-close" onClick={onClose} title="Close panel">
            ✕
          </button>
        </div>
        <div className="xray-body">
          {turns.length === 0 ? (
            <div className="xray-empty">
              Send a message to visualize how the client, model, and MCP servers interact.
            </div>
          ) : (
            [...turns]
              .reverse()
              .map((turn) => (
                <TurnRow
                  key={turn.startedAt}
                  turn={turn}
                  serverFilter={activeTab}
                  themeMode={themeMode}
                />
              ))
          )}
        </div>
      </div>
    </div>
  );
}

