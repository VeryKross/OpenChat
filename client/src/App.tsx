import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { getToolUiResourceUri } from "@modelcontextprotocol/ext-apps/app-bridge";
import type { DiscoveredServerConfig, LlmProviderType } from "@openchat/shared";
import { AppFrame, type AppFrameBridgeEvent } from "./components/AppFrame";
import { CopilotKitMcpSync } from "./copilotkit/CopilotKitMcpSync";
import { subscribeCopilotKitXRayEvents } from "./copilotkit/xrayAdapter";
import { HelpCenter } from "./components/HelpCenter";
import { XRayPanel } from "./components/XRayPanel";
import { runChat, type LlmMessage } from "./hooks/chatService";
import { DEFAULT_HELP_TOPIC_ID, isHelpTopicId, type HelpTopicId } from "./help/topics";
import { useMcpConnections } from "./hooks/useMcpConnections";
import { apiFetch } from "./lib/api";
import {
  getCopilotKitRuntimeUrl,
  getOrchestrationModeLabel,
  isCopilotKitRuntimeConfigured,
} from "./lib/featureFlags";
import type {
  ProviderConfig,
  ServerConfig,
  UiChatMessage,
  XRayEvent,
  XRayTurn,
} from "./types";

function inferResultSummary(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return `${parsed.length} records returned`;
    if (parsed && typeof parsed === "object") {
      const keys = Object.keys(parsed as Record<string, unknown>);
      return `Response with ${keys.length} fields`;
    }
  } catch {
    // ignore parse errors and use plain summary
  }
  return text.length > 80 ? `${text.slice(0, 80)}…` : text || "Tool returned data";
}

function getToolParamInfo(tool: Tool) {
  const schema = tool.inputSchema;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { parameters: [] as string[], required: [] as string[] };
  }

  const schemaObj = schema as Record<string, unknown>;
  const properties =
    schemaObj.properties && typeof schemaObj.properties === "object" && !Array.isArray(schemaObj.properties)
      ? Object.keys(schemaObj.properties as Record<string, unknown>)
      : [];
  const required = Array.isArray(schemaObj.required)
    ? schemaObj.required.filter((item): item is string => typeof item === "string")
    : [];
  return { parameters: properties, required };
}

type SkillSaveLocation = "user-global" | "project-local";
type ThemeMode = "light" | "dark" | "c64";
type CustomProviderMode = NonNullable<ProviderConfig["customMode"]>;
type CustomDirectAuthMode = NonNullable<ProviderConfig["directAuthMode"]>;

interface SkillLibraryInfo {
  id: string;
  displayName: string;
  owner: string;
  repo: string;
  path: string;
}

interface RemoteSkillInfo {
  id: string;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  skillPath: string;
  libraryId: string;
}

interface LocalSkillInfo {
  id: string;
  name: string;
  description: string;
  version?: string;
  tags: string[];
  instructions: string;
  location: SkillSaveLocation;
  directory: string;
  skillFile: string;
}

const PROVIDER_OPTIONS: Array<{ type: LlmProviderType; label: string; needsBaseUrl: boolean }> = [
  { type: "github-models", label: "GitHub Models", needsBaseUrl: false },
  { type: "openai", label: "OpenAI", needsBaseUrl: false },
  { type: "anthropic", label: "Anthropic", needsBaseUrl: false },
  { type: "google", label: "Google", needsBaseUrl: false },
  { type: "custom", label: "Custom (Catalog or Direct Endpoint)", needsBaseUrl: false },
];

const OPENCHAT_LOCAL_WRITE_FILE_TOOL_NAME = "openchat_write_local_file";
const OPENCHAT_LOCAL_TOOLS: Tool[] = [
  {
    name: OPENCHAT_LOCAL_WRITE_FILE_TOOL_NAME,
    description:
      "Write a UTF-8 text file to the configured artifact output folder (or project directory when not configured). Use this when a skill asks to generate a local file artifact. IMPORTANT: Always choose a file extension that matches the content format — use .md for markdown, .json for JSON, .csv for CSV, .yaml/.yml for YAML, .xml for XML, .html for HTML. Never use .txt for structured or markup content.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        relativePath: {
          type: "string",
          description: "Destination path relative to the configured output folder (for example: diagrams/architecture.excalidraw)",
        },
        content: {
          type: "string",
          description: "Full UTF-8 file content to write.",
        },
        overwrite: {
          type: "boolean",
          description: "Set false to fail if file already exists. Defaults to true.",
        },
      },
      required: ["relativePath", "content"],
    },
  },
];

function providerLabelFromType(type: LlmProviderType) {
  return PROVIDER_OPTIONS.find((option) => option.type === type)?.label ?? type;
}

function isThemeMode(value: unknown): value is ThemeMode {
  return value === "dark" || value === "light" || value === "c64";
}

function isCustomProviderMode(value: unknown): value is CustomProviderMode {
  return value === "catalog" || value === "direct-endpoint";
}

function isCustomDirectAuthMode(value: unknown): value is CustomDirectAuthMode {
  return value === "entra-bearer" || value === "azure-api-key";
}

function getSystemThemeMode(): ThemeMode {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "dark";
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

const THEME_CYCLE: ThemeMode[] = ["dark", "light", "c64"];

function getNextThemeMode(current: ThemeMode): ThemeMode {
  const index = THEME_CYCLE.indexOf(current);
  if (index === -1) return "dark";
  return THEME_CYCLE[(index + 1) % THEME_CYCLE.length];
}

function getThemeLabel(mode: ThemeMode) {
  if (mode === "dark") return "Dark";
  if (mode === "light") return "Light";
  return "Commodore 64";
}

function getThemeIcon(mode: ThemeMode) {
  if (mode === "dark") return "🌙";
  if (mode === "light") return "☀️";
  return "C64";
}

function deriveCopilotKitMcpServers(servers: ServerConfig[]) {
  const projections = new Map<string, { endpoint: string; apiKey?: string }>();
  for (const server of servers) {
    if (!server.enabled) continue;
    const transport = server.transport ?? (server.command ? "stdio" : "http");
    if (transport === "stdio") continue;
    const endpoint = String(server.url ?? "").trim();
    if (!endpoint) continue;
    const projection = {
      endpoint,
      apiKey: server.authToken?.trim() || undefined,
    };
    projections.set(`${projection.endpoint}|${projection.apiKey ?? ""}`, projection);
  }
  return Array.from(projections.values());
}

export default function App() {
  const CONFIG_KEY = "openchat.config.v1";
  const LEGACY_CONFIG_KEY = "mcpchat.config.v1";
  const HELP_TOPIC_KEY = "openchat.help.topic.v1";
  const { connections, connectServers, disconnectAll } = useMcpConnections();
  const [providerType, setProviderType] = useState<ProviderConfig["type"]>("github-models");
  const [providerLabel, setProviderLabel] = useState(providerLabelFromType("github-models"));
  const [model, setModel] = useState("gpt-4o");
  const [modelRestoredFromConfig, setModelRestoredFromConfig] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [isLoadingModels, setIsLoadingModels] = useState(false);
  const [modelLoadStatus, setModelLoadStatus] = useState(
    "Enter your API key, then click \"Load Models\"."
  );
  const [apiKey, setApiKey] = useState("");
  const [providerAuthMode, setProviderAuthMode] = useState<NonNullable<ProviderConfig["authMode"]>>(
    "manual"
  );
  const [baseUrl, setBaseUrl] = useState("");
  const [customProviderMode, setCustomProviderMode] = useState<CustomProviderMode>("catalog");
  const [directEndpointUrl, setDirectEndpointUrl] = useState("");
  const [directAuthMode, setDirectAuthMode] = useState<CustomDirectAuthMode>("entra-bearer");
  const [directModelName, setDirectModelName] = useState("");
  const [artifactOutputDirectory, setArtifactOutputDirectory] = useState("");
  const [themeMode, setThemeMode] = useState<ThemeMode>(getSystemThemeMode);
  const [generalStatus, setGeneralStatus] = useState("");
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServerConfig[]>([]);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [discoveryStatus, setDiscoveryStatus] = useState("Click Refresh to discover MCP servers.");
  const [servers, setServers] = useState<ServerConfig[]>([]);
  const [manualName, setManualName] = useState("");
  const [manualTransport, setManualTransport] = useState<"http" | "sse" | "stdio">("http");
  const [manualUrl, setManualUrl] = useState("http://localhost:3001/mcp");
  const [manualToken, setManualToken] = useState("");
  const [manualCommand, setManualCommand] = useState("");
  const [manualArgs, setManualArgs] = useState("");
  const [manualAddStatus, setManualAddStatus] = useState("");
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<UiChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [showSettings, setShowSettings] = useState(true);
  const [activeSettingsTab, setActiveSettingsTab] = useState<"general" | "mcp" | "skills">(
    "general"
  );
  const [showHelpCenter, setShowHelpCenter] = useState(false);
  const [activeHelpTopicId, setActiveHelpTopicId] = useState<HelpTopicId>(() => {
    const stored = localStorage.getItem(HELP_TOPIC_KEY);
    return isHelpTopicId(stored) ? stored : DEFAULT_HELP_TOPIC_ID;
  });
  const [configHydrated, setConfigHydrated] = useState(false);
  const [xrayOpen, setXrayOpen] = useState(false);
  const [xrayTurns, setXrayTurns] = useState<XRayTurn[]>([]);
  const appInteractionTurnByIdRef = useRef(new Map<string, number>());
  const [serverTestStatus, setServerTestStatus] = useState<
    Record<string, { status: string; tools: Tool[] }>
  >({});
  const [toolListServerId, setToolListServerId] = useState<string | null>(null);
  const [connectStatus, setConnectStatus] = useState("");
  const [isConnectingServers, setIsConnectingServers] = useState(false);
  const [skillLibraries, setSkillLibraries] = useState<SkillLibraryInfo[]>([]);
  const [selectedLibraryId, setSelectedLibraryId] = useState("awesome-copilot");
  const [remoteSkills, setRemoteSkills] = useState<RemoteSkillInfo[]>([]);
  const [localSkills, setLocalSkills] = useState<LocalSkillInfo[]>([]);
  const [skillsStatus, setSkillsStatus] = useState("Load a library to browse available skills.");
  const [localSkillsStatus, setLocalSkillsStatus] = useState("");
  const [isBrowsingSkills, setIsBrowsingSkills] = useState(false);
  const [installLocation, setInstallLocation] = useState<SkillSaveLocation>("user-global");
  const [createLocation, setCreateLocation] = useState<SkillSaveLocation>("project-local");
  const [installingSkillPath, setInstallingSkillPath] = useState<string | null>(null);
  const [lastInstalledSkill, setLastInstalledSkill] = useState<{
    name: string;
    location: SkillSaveLocation;
  } | null>(null);
  const [newSkillName, setNewSkillName] = useState("");
  const [newSkillDescription, setNewSkillDescription] = useState("");
  const [newSkillInstructions, setNewSkillInstructions] = useState("");
  const [showSkillEditor, setShowSkillEditor] = useState(false);
  const [editingSkill, setEditingSkill] = useState<LocalSkillInfo | null>(null);
  const [isSkillEditorExpanded, setIsSkillEditorExpanded] = useState(false);
  const [isSavingSkill, setIsSavingSkill] = useState(false);
  const [removingSkillKey, setRemovingSkillKey] = useState<string | null>(null);
  const [skillsFilter, setSkillsFilter] = useState("");
  const [installedSkillsFilter, setInstalledSkillsFilter] = useState("");
  const historyRef = useRef<LlmMessage[]>([]);
  const importInputRef = useRef<HTMLInputElement>(null);
  const installedSkillsRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const autoResizeTextarea = useCallback(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    const lineHeight = 22;
    const maxLines = 6;
    const maxHeight = lineHeight * maxLines;
    ta.style.height = `${Math.min(ta.scrollHeight, maxHeight)}px`;
  }, []);

  const openHelpCenter = useCallback(
    (topicId?: string) => {
      if (isHelpTopicId(topicId)) {
        setActiveHelpTopicId(topicId);
      }
      setShowHelpCenter(true);
    },
    []
  );

  const activeConnections = connections.filter((c) => c.status === "connected");
  const copilotKitMcpProjection = deriveCopilotKitMcpServers(servers);
  const transportModeLabel = "OpenChat MCP bridge (CopilotKit projected)";
  const enabledServersCount = servers.filter((server) => server.enabled).length;
  const isCustomProvider = providerType === "custom";
  const isCustomDirectMode = isCustomProvider && customProviderMode === "direct-endpoint";
  const isCustomCatalogMode = isCustomProvider && customProviderMode === "catalog";
  const modelOptions = useMemo(() => {
    if (isCustomDirectMode) {
      const direct = directModelName.trim();
      if (direct) return [direct];
      if (model.trim()) return [model.trim()];
      return [];
    }
    if (!model) return availableModels;
    return availableModels.includes(model) ? availableModels : [model, ...availableModels];
  }, [availableModels, directModelName, isCustomDirectMode, model]);
  const filteredRemoteSkills = useMemo(() => {
    const needle = skillsFilter.trim().toLowerCase();
    if (!needle) return remoteSkills;
    return remoteSkills.filter((skill) =>
      [skill.name, skill.description, skill.tags.join(" ")].join(" ").toLowerCase().includes(needle)
    );
  }, [remoteSkills, skillsFilter]);
  const filteredLocalSkills = useMemo(() => {
    const needle = installedSkillsFilter.trim().toLowerCase();
    if (!needle) return localSkills;
    return localSkills.filter((skill) =>
      [skill.name, skill.description, skill.tags.join(" "), skill.location]
        .join(" ")
        .toLowerCase()
        .includes(needle)
    );
  }, [localSkills, installedSkillsFilter]);
  const installedSkillKeys = useMemo(
    () =>
      new Set(
        localSkills.map((skill) => `${skill.location}:${skill.name.trim().toLowerCase()}`)
      ),
    [localSkills]
  );
  const requiresApiKey = providerType !== "github-models" || providerAuthMode !== "gh-cli";
  const isConfigured =
    (!requiresApiKey || apiKey.trim().length > 0) &&
    model.trim().length > 0 &&
    (!isCustomCatalogMode || baseUrl.trim().length > 0) &&
    (!isCustomDirectMode ||
      (directEndpointUrl.trim().length > 0 && directModelName.trim().length > 0));
  const readinessIssues: string[] = [];
  if (requiresApiKey && !apiKey.trim()) readinessIssues.push("API key not entered");
  if (!model.trim()) readinessIssues.push("Model not selected");
  if (isCustomCatalogMode && !baseUrl.trim()) readinessIssues.push("Custom catalog base URL not entered");
  if (isCustomDirectMode && !directEndpointUrl.trim()) readinessIssues.push("Direct endpoint URL not entered");
  if (isCustomDirectMode && !directModelName.trim()) readinessIssues.push("Direct model/deployment name not entered");
  const chatMode = activeConnections.length > 0 ? "LLM + MCP" : "LLM-only";
  const orchestrationMode = getOrchestrationModeLabel();
  const copilotKitRuntimeUrl = getCopilotKitRuntimeUrl();
  const copilotKitMcpSyncEnabled = isCopilotKitRuntimeConfigured();
  const isDesktopRuntime = window.location.protocol === "file:" || Boolean(window.openchatDesktop?.isDesktop);
  const apiUnavailableHint = isDesktopRuntime
    ? "OpenChat local API is unavailable. Restart OpenChat and try again."
    : "OpenChat API is unavailable. Ensure the OpenChat runtime is running and try again.";

  const loadDiscovery = async () => {
    setIsDiscovering(true);
    setDiscoveryStatus("Scanning for MCP servers...");
    try {
      const response = await apiFetch("/api/discovery/servers");
      const raw = await response.text();
      let data: { servers?: DiscoveredServerConfig[]; error?: string } = {};
      if (raw.trim()) {
        try {
          data = JSON.parse(raw) as { servers?: DiscoveredServerConfig[]; error?: string };
        } catch {
          setDiscoveredServers([]);
          setDiscoveryStatus("Discovery returned an invalid response.");
          return;
        }
      }
      if (!response.ok) {
        setDiscoveredServers([]);
        setDiscoveryStatus(
          raw.trim() || (response.status >= 500 ? apiUnavailableHint : `Discovery failed (HTTP ${response.status}).`)
        );
        return;
      }
      const servers = Array.isArray(data.servers) ? data.servers : [];
      setDiscoveredServers(servers);
      if (data.error) {
        setDiscoveryStatus(`Discovery warning: ${data.error}`);
        return;
      }
      setDiscoveryStatus(
        servers.length > 0
          ? `Found ${servers.length} discovered server(s).`
          : "No discovered servers found. You can still add one manually."
      );
    } catch (error) {
      setDiscoveredServers([]);
      setDiscoveryStatus(
        error instanceof Error && error.message
          ? `${apiUnavailableHint} (${error.message})`
          : apiUnavailableHint
      );
    } finally {
      setIsDiscovering(false);
    }
  };

  const loadSkillLibraries = async () => {
    try {
      const response = await apiFetch("/api/skills/libraries");
      const data = (await response.json()) as { libraries?: SkillLibraryInfo[]; error?: string };
      if (!response.ok || !data.libraries) {
        setSkillsStatus(data.error ?? "Unable to load skill libraries.");
        return;
      }
      setSkillLibraries(data.libraries);
      if (data.libraries.length > 0 && !data.libraries.some((library) => library.id === selectedLibraryId)) {
        setSelectedLibraryId(data.libraries[0].id);
      }
    } catch (error) {
      setSkillsStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const loadLocalSkills = async () => {
    try {
      const response = await apiFetch("/api/skills/local");
      const data = (await response.json()) as {
        skills?: LocalSkillInfo[];
        userGlobalPath?: string;
        projectLocalPath?: string;
      };
      if (!response.ok) {
        setLocalSkillsStatus("Failed to load installed skills.");
        return;
      }
      setLocalSkills(data.skills ?? []);
      setLocalSkillsStatus(
        `User-global: ${data.userGlobalPath ?? "~/.openchat/skills"} · Project-local: ${data.projectLocalPath ?? ".openchat/skills"}`
      );
    } catch (error) {
      setLocalSkillsStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const browseSkills = async () => {
    if (!selectedLibraryId) return;
    setIsBrowsingSkills(true);
    setSkillsStatus("Loading skills from selected library...");
    try {
      const response = await apiFetch("/api/skills/browse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ libraryId: selectedLibraryId }),
      });
      const raw = await response.text();
      const data = raw
        ? (JSON.parse(raw) as { skills?: RemoteSkillInfo[]; error?: string; library?: SkillLibraryInfo })
        : {};
      if (!response.ok) {
        setSkillsStatus(data.error ?? "Failed to browse skill library.");
        setRemoteSkills([]);
        return;
      }
      setRemoteSkills(data.skills ?? []);
      setSkillsStatus(
        data.skills && data.skills.length > 0
          ? `Loaded ${data.skills.length} skill(s) from ${data.library?.displayName ?? selectedLibraryId}.`
          : "No skills found in selected library."
      );
    } catch (error) {
      setRemoteSkills([]);
      setSkillsStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsBrowsingSkills(false);
    }
  };

  const installSkill = async (skill: RemoteSkillInfo) => {
    setInstallingSkillPath(skill.skillPath);
    try {
      const response = await apiFetch("/api/skills/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          libraryId: skill.libraryId,
          skillPath: skill.skillPath,
          saveLocation: installLocation,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string; skill?: { name?: string } };
      if (!response.ok || !data.ok) {
        setSkillsStatus(data.error ?? "Failed to install skill.");
        return;
      }
      const installedName = data.skill?.name ?? skill.name;
      setSkillsStatus(`Installed "${installedName}" to ${installLocation}.`);
      setLastInstalledSkill({ name: installedName, location: installLocation });
      await loadLocalSkills();
    } catch (error) {
      setSkillsStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setInstallingSkillPath(null);
    }
  };

  const openCreateSkillEditor = () => {
    setEditingSkill(null);
    setIsSkillEditorExpanded(false);
    setNewSkillName("");
    setNewSkillDescription("");
    setNewSkillInstructions("");
    setShowSkillEditor(true);
  };

  const openEditSkillEditor = (skill: LocalSkillInfo) => {
    setEditingSkill(skill);
    setIsSkillEditorExpanded(false);
    setCreateLocation(skill.location);
    setNewSkillName(skill.name);
    setNewSkillDescription(skill.description ?? "");
    setNewSkillInstructions(skill.instructions ?? "");
    setShowSkillEditor(true);
  };

  const closeSkillEditor = () => {
    if (isSavingSkill) return;
    setShowSkillEditor(false);
    setIsSkillEditorExpanded(false);
    setEditingSkill(null);
  };

  const saveSkill = async () => {
    if (!newSkillName.trim()) {
      setSkillsStatus("Enter a skill name before saving.");
      return;
    }
    setIsSavingSkill(true);
    try {
      const endpoint = editingSkill ? "/api/skills/update" : "/api/skills/create";
      const payload = editingSkill
        ? {
            name: newSkillName.trim(),
            description: newSkillDescription.trim() || undefined,
            instructions: newSkillInstructions.trim() || undefined,
            location: editingSkill.location,
            directory: editingSkill.directory,
          }
        : {
            name: newSkillName.trim(),
            description: newSkillDescription.trim() || undefined,
            instructions: newSkillInstructions.trim() || undefined,
            saveLocation: createLocation,
          };
      const response = await apiFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        setSkillsStatus(data.error ?? `Failed to ${editingSkill ? "update" : "create"} skill.`);
        return;
      }
      const location = editingSkill?.location ?? createLocation;
      setSkillsStatus(
        editingSkill
          ? `Updated skill "${newSkillName.trim()}" in ${location}.`
          : `Created skill "${newSkillName.trim()}" in ${location}.`
      );
      setLastInstalledSkill({ name: newSkillName.trim(), location });
      setNewSkillName("");
      setNewSkillDescription("");
      setNewSkillInstructions("");
      setShowSkillEditor(false);
      setIsSkillEditorExpanded(false);
      setEditingSkill(null);
      await loadLocalSkills();
    } catch (error) {
      setSkillsStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsSavingSkill(false);
    }
  };

  const removeSkill = async (skill: LocalSkillInfo) => {
    const confirmed = window.confirm(`Remove installed skill "${skill.name}" from ${skill.location}?`);
    if (!confirmed) return;
    const skillKey = `${skill.location}:${skill.directory}`;
    setRemovingSkillKey(skillKey);
    try {
      const response = await apiFetch("/api/skills/remove", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location: skill.location,
          directory: skill.directory,
        }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (!response.ok || !data.ok) {
        setSkillsStatus(data.error ?? "Failed to remove skill.");
        return;
      }
      setSkillsStatus(`Removed skill "${skill.name}" from ${skill.location}.`);
      await loadLocalSkills();
    } catch (error) {
      setSkillsStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setRemovingSkillKey(null);
    }
  };

  useEffect(() => {
    void loadDiscovery();
    void loadSkillLibraries();
    void loadLocalSkills();

    const storedConfig = localStorage.getItem(CONFIG_KEY) ?? localStorage.getItem(LEGACY_CONFIG_KEY);
    let resolvedThemeMode: ThemeMode = getSystemThemeMode();
    if (storedConfig) {
      try {
        const parsed = JSON.parse(storedConfig) as {
          providerType?: ProviderConfig["type"];
          providerLabel?: string;
          providerAuthMode?: ProviderConfig["authMode"];
          apiKey?: string;
          model?: string;
          baseUrl?: string;
          customMode?: ProviderConfig["customMode"];
          directEndpointUrl?: string;
          directAuthMode?: ProviderConfig["directAuthMode"];
          directModelName?: string;
          artifactOutputDirectory?: string;
          themeMode?: ThemeMode;
          servers?: ServerConfig[];
        };
        if (parsed.providerType) {
          setProviderType(parsed.providerType);
          setProviderLabel(providerLabelFromType(parsed.providerType));
        }
        if (parsed.providerAuthMode === "manual" || parsed.providerAuthMode === "gh-cli") {
          setProviderAuthMode(parsed.providerAuthMode);
        }
        if (parsed.providerLabel && !parsed.providerType) setProviderLabel(parsed.providerLabel);
        if (parsed.apiKey) setApiKey(parsed.apiKey);
        if (parsed.model) {
          setModel(parsed.model);
          setModelRestoredFromConfig(true);
        }
        if (parsed.baseUrl) setBaseUrl(parsed.baseUrl);
        if (isCustomProviderMode(parsed.customMode)) {
          setCustomProviderMode(parsed.customMode);
        }
        if (typeof parsed.directEndpointUrl === "string") {
          setDirectEndpointUrl(parsed.directEndpointUrl);
        }
        if (isCustomDirectAuthMode(parsed.directAuthMode)) {
          setDirectAuthMode(parsed.directAuthMode);
        }
        if (typeof parsed.directModelName === "string") {
          setDirectModelName(parsed.directModelName);
        }
        if (typeof parsed.artifactOutputDirectory === "string") {
          setArtifactOutputDirectory(parsed.artifactOutputDirectory);
        }
        if (isThemeMode(parsed.themeMode)) {
          resolvedThemeMode = parsed.themeMode;
        }
        if (parsed.servers) setServers(parsed.servers.map((s) => ({ ...s, authToken: undefined })));
      } catch {
        // ignore invalid local config
      }
    }
    setThemeMode(resolvedThemeMode);

    localStorage.removeItem("openchat.chat.v1");
    localStorage.removeItem("mcpchat.chat.v1");
    setConfigHydrated(true);
  }, [CONFIG_KEY, LEGACY_CONFIG_KEY]);

  useEffect(() => {
    if (!configHydrated) return;
    localStorage.setItem(
      CONFIG_KEY,
      JSON.stringify({
        providerType,
        providerLabel,
        providerAuthMode,
        apiKey,
        model,
        baseUrl,
        customMode: providerType === "custom" ? customProviderMode : undefined,
        directEndpointUrl: providerType === "custom" ? directEndpointUrl : undefined,
        directAuthMode: providerType === "custom" ? directAuthMode : undefined,
        directModelName: providerType === "custom" ? directModelName : undefined,
        artifactOutputDirectory,
        themeMode,
        servers: servers.map(({ authToken: _ignored, ...rest }) => rest),
      })
    );
  }, [
    apiKey,
    artifactOutputDirectory,
    baseUrl,
    customProviderMode,
    configHydrated,
    directAuthMode,
    directEndpointUrl,
    directModelName,
    model,
    providerAuthMode,
    providerLabel,
    providerType,
    servers,
    themeMode,
  ]);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode === "light" ? "light" : "dark";
  }, [themeMode]);

  useEffect(() => {
    localStorage.setItem(HELP_TOPIC_KEY, activeHelpTopicId);
  }, [HELP_TOPIC_KEY, activeHelpTopicId]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ topicId?: string }>).detail;
      openHelpCenter(detail?.topicId);
    };
    window.addEventListener("openchat:open-help", handler as EventListener);
    return () => {
      window.removeEventListener("openchat:open-help", handler as EventListener);
    };
  }, [openHelpCenter]);

  useEffect(() => {
    return () => {
      void disconnectAll();
    };
  }, [disconnectAll]);

  useEffect(() => {
    if (!isCustomDirectMode) return;
    const normalized = directModelName.trim();
    if (!normalized || normalized === model) return;
    setModel(normalized);
    setModelRestoredFromConfig(false);
  }, [directModelName, isCustomDirectMode, model]);

  useEffect(() => {
    setAvailableModels([]);
    if (isCustomDirectMode) {
      setModelLoadStatus(
        "Direct endpoint mode uses the configured model/deployment name and does not browse /models."
      );
      return;
    }
    if (model) {
      setModelLoadStatus('Model preserved. Click "Load Models" to refresh provider options.');
      return;
    }
    if (providerType === "github-models" && providerAuthMode === "gh-cli") {
      setModelLoadStatus('Click "Load Models" to use your GitHub CLI session (`gh auth login`).');
      return;
    }
    setModelLoadStatus('Enter your API key, then click "Load Models".');
  }, [providerType, baseUrl, isCustomDirectMode, model, providerAuthMode]);

  const providerConfig: ProviderConfig = useMemo(
    () => ({
      id: providerType,
      type: providerType,
      label: providerLabel,
      model,
      apiKey,
      authMode: providerType === "github-models" ? providerAuthMode : undefined,
      baseUrl: providerType === "custom" && customProviderMode === "catalog" ? baseUrl : undefined,
      customMode: providerType === "custom" ? customProviderMode : undefined,
      directEndpointUrl:
        providerType === "custom" && customProviderMode === "direct-endpoint"
          ? directEndpointUrl
          : undefined,
      directAuthMode:
        providerType === "custom" && customProviderMode === "direct-endpoint"
          ? directAuthMode
          : undefined,
      directModelName:
        providerType === "custom" && customProviderMode === "direct-endpoint"
          ? directModelName
          : undefined,
    }),
    [
      apiKey,
      baseUrl,
      customProviderMode,
      directAuthMode,
      directEndpointUrl,
      directModelName,
      model,
      providerAuthMode,
      providerLabel,
      providerType,
    ]
  );

  const aliasedTools = useMemo(() => {
    const tools: Tool[] = [];
    for (const connection of activeConnections) {
      for (const tool of connection.tools) {
        tools.push({
          ...tool,
          name: `${connection.config.id}__${tool.name}`,
          description: `[${connection.config.name}] ${tool.description ?? ""}`.trim(),
        });
      }
    }
    return tools;
  }, [activeConnections]);

  const toolMap = useMemo(() => {
    const map = new Map<
      string,
      {
        tool: Tool;
        serverId: string;
        serverName: string;
        connection: (typeof activeConnections)[number];
      }
    >();
    for (const connection of activeConnections) {
      for (const tool of connection.tools) {
        map.set(`${connection.config.id}__${tool.name}`, {
          tool,
          serverId: connection.config.id,
          serverName: connection.config.name,
          connection,
        });
      }
    }
    return map;
  }, [activeConnections]);

  const addXRayTurn = (prompt: string) => {
    setXrayTurns((prev) => [
      ...prev,
      { prompt, startedAt: Date.now(), complete: false, events: [] },
    ]);
  };

  const appendXRayEvent = (event: XRayEvent) => {
    setXrayTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next[next.length - 1];
      next[next.length - 1] = { ...last, events: [...last.events, event] };
      return next;
    });
  };

  const completeXRayTurn = () => {
    setXrayTurns((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      next[next.length - 1] = { ...next[next.length - 1], complete: true };
      return next;
    });
  };

  const handleAppFrameBridgeEvent = useCallback((event: AppFrameBridgeEvent) => {
    if (event.phase === "started") {
      const prompt = `${event.serverName ?? "MCP"} app interaction`;
      const serverLabel = event.serverName ?? "MCP server";
      setXrayTurns((prev) => {
        const interactionEvents: XRayEvent[] = [
          {
            type: "tool_selected",
            label: "App Interaction",
            summary: `Interactive app requested ${event.toolName}.`,
            timestamp: event.timestamp,
            toolName: event.toolName,
            serverName: event.serverName,
            toolArgs: event.toolArgs,
            resultSummary: `Routing through ${serverLabel}`,
          },
          {
            type: "server_called",
            label: "Server Called",
            summary: `Calling ${event.toolName} on ${serverLabel}.`,
            timestamp: event.timestamp + 1,
            durationMs: 1,
            toolName: event.toolName,
            serverName: event.serverName,
            toolArgs: event.toolArgs,
          },
        ];
        const interactionTurn: XRayTurn = {
          prompt,
          startedAt: event.timestamp,
          complete: false,
          events: interactionEvents,
        };
        const next = [
          ...prev,
          interactionTurn,
        ];
        appInteractionTurnByIdRef.current.set(event.interactionId, next.length - 1);
        return next;
      });
      return;
    }

    const eventLabel = event.phase === "failed" ? "Call Failed" : "Data Returned";
    const eventSummary =
      event.resultSummary ??
      (event.phase === "failed" ? "Interactive app tool call failed." : "Interactive app tool call succeeded.");
    const completionEvent: XRayEvent = {
      type: "data_returned",
      label: eventLabel,
      summary: eventSummary,
      timestamp: event.timestamp,
      durationMs: event.durationMs,
      toolName: event.toolName,
      serverName: event.serverName,
      resultSummary: eventSummary,
      rawDetail: event.rawDetail,
    };

    setXrayTurns((prev) => {
      const index = appInteractionTurnByIdRef.current.get(event.interactionId);
      if (index === undefined || index < 0 || index >= prev.length) {
        return [
          ...prev,
          {
            prompt: `${event.serverName ?? "MCP"} app interaction`,
            startedAt: event.timestamp,
            complete: true,
            events: [completionEvent],
          },
        ];
      }

      const next = [...prev];
      const current = next[index];
      next[index] = { ...current, events: [...current.events, completionEvent], complete: true };
      appInteractionTurnByIdRef.current.delete(event.interactionId);
      return next;
    });
  }, []);

  useEffect(() => {
    return subscribeCopilotKitXRayEvents((event) => {
      setXrayTurns((prev) => {
        if (prev.length === 0 || prev[prev.length - 1].complete) {
          return [
            ...prev,
            {
              prompt: "CopilotKit runtime",
              startedAt: event.timestamp,
              complete: true,
              events: [event],
            },
          ];
        }

        const next = [...prev];
        const last = next[next.length - 1];
        next[next.length - 1] = { ...last, events: [...last.events, event] };
        return next;
      });
    });
  }, []);

  const addManualServer = () => {
    if (!manualName.trim()) {
      setManualAddStatus("Please enter a server name.");
      return;
    }
    if (manualTransport !== "stdio" && !manualUrl.trim()) {
      setManualAddStatus("Please enter an MCP server URL.");
      return;
    }
    const name = manualName.trim();
    const args = manualArgs
      .split(" ")
      .map((part) => part.trim())
      .filter(Boolean);
    if (manualTransport === "stdio" && !manualCommand.trim()) {
      setManualAddStatus("Please enter a stdio command.");
      return;
    }
    const alreadyExists = servers.some(
      (server) =>
        server.name === name &&
        (server.transport ?? "http") === manualTransport &&
        (manualTransport === "stdio"
          ? server.command === manualCommand.trim() &&
            JSON.stringify(server.args ?? []) === JSON.stringify(args)
          : server.url === manualUrl.trim())
    );
    if (alreadyExists) {
      setManualAddStatus("That server is already in the configured list.");
      return;
    }
    setServers((prev) => [
      ...prev,
      {
        id: `${name.toLowerCase().replace(/\s+/g, "-")}-${Date.now()}`,
        name,
        transport: manualTransport,
        url: manualTransport !== "stdio" ? manualUrl.trim() : undefined,
        command: manualTransport === "stdio" ? manualCommand.trim() : undefined,
        args: manualTransport === "stdio" ? args : undefined,
        enabled: true,
        authToken: manualTransport !== "stdio" ? manualToken.trim() || undefined : undefined,
      },
    ]);
    setManualAddStatus(`Added "${name}" (${manualTransport.toUpperCase()}) and enabled it.`);
    setManualName("");
    setManualCommand("");
    setManualArgs("");
    setManualToken("");
  };

  const addDiscoveredServer = (server: DiscoveredServerConfig) => {
    if (!server.supportedTransport) return;
    setServers((prev) =>
      prev.some(
        (s) =>
          s.name === server.name &&
          (s.transport ?? "http") === (server.transport ?? "http") &&
          (server.transport === "stdio"
            ? s.command === server.command
            : s.url === server.url)
      )
        ? prev
        : [...prev, { ...server, enabled: true }]
    );
    setManualAddStatus(`Added discovered server "${server.name}" and enabled it.`);
  };

  const setServerEnabled = (serverId: string, enabled: boolean) => {
    setServers((prev) =>
      prev.map((server) => (server.id === serverId ? { ...server, enabled } : server))
    );
  };

  const removeServer = (serverId: string) => {
    setServers((prev) => prev.filter((server) => server.id !== serverId));
    setServerTestStatus((prev) => {
      const next = { ...prev };
      delete next[serverId];
      return next;
    });
    setToolListServerId((prev) => (prev === serverId ? null : prev));
  };

  const testServer = async (server: ServerConfig) => {
    setServerTestStatus((prev) => ({ ...prev, [server.id]: { status: "Testing...", tools: [] } }));
    const response = await apiFetch("/api/servers/test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transport: server.transport ?? "http",
        url: server.url,
        authToken: server.authToken,
        command: server.command,
        args: server.args,
        env: server.env,
        cwd: server.cwd,
      }),
    });
    const raw = await response.text();
    let data: {
      ok?: boolean;
      toolCount?: number;
      tools?: Tool[];
      error?: string;
    } = {};
    if (raw.trim()) {
      try {
        data = JSON.parse(raw) as {
          ok?: boolean;
          toolCount?: number;
          tools?: Tool[];
          error?: string;
        };
      } catch {
        setServerTestStatus((prev) => ({
          ...prev,
          [server.id]: {
            status:
              response.status >= 500
                ? `Failed: ${raw.trim() || apiUnavailableHint}`
                : "Failed: Invalid response from server test endpoint.",
            tools: [],
          },
        }));
        return;
      }
    }
    if (response.ok && data.ok) {
      const tools = data.tools ?? [];
      setServerTestStatus((prev) => ({
        ...prev,
        [server.id]: {
          status: "Connected",
          tools,
        },
      }));
      return;
    }
    setServerTestStatus((prev) => ({
      ...prev,
      [server.id]: {
        status:
          response.status >= 500
            ? `Failed: ${raw.trim() || apiUnavailableHint}`
            : `Failed: ${data.error ?? "Unknown error"}`,
        tools: [],
      },
    }));
  };

  const loadModels = async () => {
    if (requiresApiKey && !apiKey.trim()) {
      setModelLoadStatus("Please provide an API key before loading models.");
      return;
    }
    if (isCustomCatalogMode && !baseUrl.trim()) {
      setModelLoadStatus("Custom provider (Catalog mode) requires a Base URL.");
      return;
    }
    if (isCustomDirectMode) {
      const directName = directModelName.trim();
      if (!directEndpointUrl.trim()) {
        setModelLoadStatus("Direct endpoint mode requires an endpoint URL.");
        return;
      }
      if (!directName) {
        setModelLoadStatus("Direct endpoint mode requires a model/deployment name.");
        return;
      }
      setAvailableModels([directName]);
      setModel(directName);
      setModelRestoredFromConfig(false);
      setModelLoadStatus("Direct endpoint mode uses the configured model/deployment name.");
      return;
    }
    setIsLoadingModels(true);
    setModelLoadStatus("Loading models...");
    try {
      const response = await apiFetch("/api/providers/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: {
            id: providerType,
            type: providerType,
            label: providerLabel,
            apiKey,
            authMode: providerType === "github-models" ? providerAuthMode : undefined,
            baseUrl: providerType === "custom" && customProviderMode === "catalog" ? baseUrl : undefined,
            customMode: providerType === "custom" ? customProviderMode : undefined,
            directEndpointUrl:
              providerType === "custom" && customProviderMode === "direct-endpoint"
                ? directEndpointUrl
                : undefined,
            directAuthMode:
              providerType === "custom" && customProviderMode === "direct-endpoint"
                ? directAuthMode
                : undefined,
            directModelName:
              providerType === "custom" && customProviderMode === "direct-endpoint"
                ? directModelName
                : undefined,
          },
        }),
      });
      const raw = await response.text();
      let data: { models?: string[]; error?: string } = {};
      if (raw.trim()) {
        try {
          data = JSON.parse(raw) as { models?: string[]; error?: string };
        } catch {
          if (!response.ok) {
            setAvailableModels([]);
            setModelLoadStatus(raw);
            return;
          }
          setAvailableModels([]);
          setModelLoadStatus("Provider returned an invalid response while loading models.");
          return;
        }
      }

      if (!response.ok || !data.models || data.models.length === 0) {
        setAvailableModels([]);
        setModelLoadStatus(
          data.error ??
            (raw.trim() ||
              (response.status >= 500
                ? apiUnavailableHint
                : `Could not load models for this provider (HTTP ${response.status}).`))
        );
        return;
      }
      setAvailableModels(data.models);
      setModel(data.models[0]);
      setModelRestoredFromConfig(false);
      setModelLoadStatus(`Loaded ${data.models.length} models. Choose one above.`);
    } catch (error) {
      setAvailableModels([]);
      setModelLoadStatus(error instanceof Error ? error.message : String(error));
    } finally {
      setIsLoadingModels(false);
    }
  };

  const browseArtifactOutputFolder = async () => {
    try {
      setGeneralStatus("Opening folder browser...");
      const response = await apiFetch("/api/desktop/choose-output-folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initialPath: artifactOutputDirectory.trim() || undefined }),
      });
      const raw = await response.text();
      if (!response.ok) {
        setGeneralStatus(raw.trim() || `Couldn't open folder browser (HTTP ${response.status}).`);
        return;
      }
      const data = raw.trim() ? (JSON.parse(raw) as { path?: string | null }) : {};
      const selected = typeof data.path === "string" && data.path.trim() ? data.path.trim() : null;
      if (selected) {
        setArtifactOutputDirectory(selected);
        setGeneralStatus(`Artifact output folder set to ${selected}`);
        return;
      }
      setGeneralStatus("Folder selection canceled.");
    } catch (error) {
      setGeneralStatus(
        `Couldn't open folder browser. ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  const connectConfiguredServers = async () => {
    setIsConnectingServers(true);
    await disconnectAll();

    const selected = servers.filter((server) => server.enabled);
    const projected = deriveCopilotKitMcpServers(servers);
    if (selected.length === 0) {
      setConnectStatus("All server connections cleared. Check servers to connect and try again.");
      setIsConnectingServers(false);
      return;
    }

    setConnectStatus(
      `Connecting to ${selected.length} server(s)... (CopilotKit MCP projection: ${projected.length})`
    );
    const result = await connectServers(servers);
    if (result.connected > 0) {
      setConnectStatus(
        `Connected to ${result.connected} server(s). ${
          result.failed > 0 ? `${result.failed} failed. ` : ""
        }CopilotKit MCP projection: ${projected.length}.`
      );
    } else {
      setConnectStatus(
        `No servers connected. ${
          result.failed > 0 ? "Check URLs/auth and use Test for details. " : ""
        }CopilotKit MCP projection: ${projected.length}.`
      );
    }
    setIsConnectingServers(false);
  };

  const exportConfig = () => {
    const payload = {
      providerType,
      providerLabel,
      providerAuthMode,
      apiKey,
      model,
      baseUrl,
      customMode: providerType === "custom" ? customProviderMode : undefined,
      directEndpointUrl: providerType === "custom" ? directEndpointUrl : undefined,
      directAuthMode: providerType === "custom" ? directAuthMode : undefined,
      directModelName: providerType === "custom" ? directModelName : undefined,
      artifactOutputDirectory,
      themeMode,
      servers: servers.map(({ authToken: _ignored, ...rest }) => rest),
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "openchat-config.json";
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importConfigFromFile = async (file: File) => {
    const raw = await file.text();
    const parsed = JSON.parse(raw) as {
      providerType?: ProviderConfig["type"];
      providerLabel?: string;
      providerAuthMode?: ProviderConfig["authMode"];
      apiKey?: string;
      model?: string;
      baseUrl?: string;
      customMode?: ProviderConfig["customMode"];
      directEndpointUrl?: string;
      directAuthMode?: ProviderConfig["directAuthMode"];
      directModelName?: string;
      artifactOutputDirectory?: string;
      themeMode?: ThemeMode;
      servers?: ServerConfig[];
    };
    if (parsed.providerType) setProviderType(parsed.providerType);
    if (parsed.providerType) setProviderLabel(providerLabelFromType(parsed.providerType));
    else if (parsed.providerLabel) setProviderLabel(parsed.providerLabel);
    if (parsed.providerAuthMode === "manual" || parsed.providerAuthMode === "gh-cli") {
      setProviderAuthMode(parsed.providerAuthMode);
    }
    if (parsed.apiKey) setApiKey(parsed.apiKey);
    if (parsed.model) {
      setModel(parsed.model);
      setModelRestoredFromConfig(true);
    }
    if (parsed.baseUrl) setBaseUrl(parsed.baseUrl);
    if (isCustomProviderMode(parsed.customMode)) {
      setCustomProviderMode(parsed.customMode);
    }
    if (typeof parsed.directEndpointUrl === "string") {
      setDirectEndpointUrl(parsed.directEndpointUrl);
    }
    if (isCustomDirectAuthMode(parsed.directAuthMode)) {
      setDirectAuthMode(parsed.directAuthMode);
    }
    if (typeof parsed.directModelName === "string") {
      setDirectModelName(parsed.directModelName);
    }
    if (typeof parsed.artifactOutputDirectory === "string") {
      setArtifactOutputDirectory(parsed.artifactOutputDirectory);
    }
    if (isThemeMode(parsed.themeMode)) {
      setThemeMode(parsed.themeMode);
    }
    if (parsed.servers) setServers(parsed.servers.map((s) => ({ ...s, authToken: undefined })));
  };

  const startNewChat = () => {
    historyRef.current = [];
    setMessages([]);
    setXrayTurns([]);
    appInteractionTurnByIdRef.current.clear();
  };

  const handleSend = async () => {
    const prompt = input.trim();
    if (!prompt || isProcessing || !isConfigured) return;

    setInput("");
    setIsProcessing(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    addXRayTurn(prompt);

    try {
      const result = await runChat({
        prompt,
        provider: providerConfig,
        history: historyRef.current,
        tools: aliasedTools,
        localTools: OPENCHAT_LOCAL_TOOLS,
        skills: localSkills,
        onXRayEvent: (event) => appendXRayEvent(event as XRayEvent),
        callTool: async (aliasName, args) => {
          if (aliasName === OPENCHAT_LOCAL_WRITE_FILE_TOOL_NAME) {
            const response = await apiFetch("/api/local/write-file", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                ...args,
                outputDirectory: artifactOutputDirectory.trim() || undefined,
              }),
            });
            const raw = await response.text();
            let data: {
              ok?: boolean;
              error?: string;
              relativePath?: string;
              bytes?: number;
              path?: string;
              outputRoot?: string;
              normalized?: boolean;
              normalizationNote?: string;
            } = {};
            if (raw.trim()) {
              try {
                data = JSON.parse(raw) as {
                  ok?: boolean;
                  error?: string;
                  relativePath?: string;
                  bytes?: number;
                  path?: string;
                  outputRoot?: string;
                  normalized?: boolean;
                  normalizationNote?: string;
                };
              } catch {
                if (!response.ok) {
                  throw new Error(raw);
                }
              }
            }
            if (!response.ok || !data.ok || !data.relativePath) {
              throw new Error(data.error || raw.trim() || "Failed to write local file.");
            }
            const byteCount = typeof data.bytes === "number" ? data.bytes : 0;
            const resolvedPath = data.path?.trim() || data.relativePath;
            const summary = `Wrote ${resolvedPath}${byteCount > 0 ? ` (${byteCount} bytes)` : ""}${
              data.normalized ? " [normalized]" : ""
            }`;
            const detailLines = [`Full path: ${resolvedPath}`, `Requested path: ${data.relativePath}`];
            if (data.outputRoot) {
              detailLines.push(`Output root: ${data.outputRoot}`);
            }
            return {
              text: [summary, ...detailLines, data.normalizationNote ?? ""].filter(Boolean).join("\n"),
              serverName: "OpenChat Local",
              toolName: OPENCHAT_LOCAL_WRITE_FILE_TOOL_NAME,
              args,
              resultSummary: summary,
              rawResult: raw.trim() || data.normalizationNote || summary,
            };
          }

          const route = toolMap.get(aliasName);
          if (!route) throw new Error(`Tool alias not found: ${aliasName}`);
          const resourceUri = getToolUiResourceUri(route.tool);
          let uiHtml: string | undefined;
          let toolResult: CallToolResult;

          if (route.connection.client) {
            toolResult = (await route.connection.client.callTool({
              name: route.tool.name,
              arguments: args,
            })) as CallToolResult;
            if (resourceUri) {
              try {
                const resource = await route.connection.client.readResource({ uri: resourceUri });
                const content = resource.contents?.[0];
                if (content && "text" in content) {
                  uiHtml = content.text;
                }
              } catch {
                // Optional UI resource can fail without blocking chat.
              }
            }
          } else {
            const response = await apiFetch("/api/servers/call-stdio", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                server: route.connection.config,
                toolName: route.tool.name,
                args,
                resourceUri,
              }),
            });
            const data = (await response.json()) as {
              ok?: boolean;
              error?: string;
              toolResult?: CallToolResult;
              uiHtml?: string;
            };
            if (!response.ok || !data.ok || !data.toolResult) {
              throw new Error(data.error ?? "Failed to call stdio MCP tool.");
            }
            toolResult = data.toolResult;
            uiHtml = data.uiHtml;
          }

          const textResult = toolResult.content
            .filter((content) => content.type === "text")
            .map((content) => ("text" in content ? content.text : ""))
            .join("\n");

          return {
            text: textResult,
            serverName: route.serverName,
            toolName: route.tool.name,
            args,
            resultSummary: inferResultSummary(textResult),
            rawResult: textResult,
            uiMeta: uiHtml
              ? { uiHtml, toolResult, interactive: Boolean(route.connection.client) }
              : undefined,
          };
        },
      });

      historyRef.current = result.updatedHistory;
      const lastUiRoute = result.lastUi ? toolMap.get(result.lastUi.toolAlias) : undefined;
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.finalText,
          uiMeta: result.lastUi
            ? {
                client: lastUiRoute?.connection.client,
                uiHtml: result.lastUi.uiHtml,
                toolArgs: result.lastUi.toolArgs,
                toolName: result.lastUi.toolName,
                serverName: result.lastUi.serverName,
                toolResult: result.lastUi.toolResult,
                interactive: result.lastUi.interactive,
              }
            : undefined,
        },
      ]);
    } catch (error) {
      setMessages((prev) => [
        ...prev,
        {
          role: "error",
          content: error instanceof Error ? error.message : String(error),
        },
      ]);
    } finally {
      completeXRayTurn();
      setIsProcessing(false);
    }
  };

  const nextThemeMode = getNextThemeMode(themeMode);
  const themeButtonLabel = `Theme: ${getThemeLabel(themeMode)}. Switch to ${getThemeLabel(nextThemeMode)} mode.`;

  return (
    <div className="app">
      {copilotKitMcpSyncEnabled && <CopilotKitMcpSync servers={copilotKitMcpProjection} />}
      <div className="app-header">
        <h1>💬 OpenChat</h1>
        <span className="subtitle">Expose LLM, MCP, and tool interactions with transparent execution</span>
        <button
          className="theme-toggle"
          onClick={() => setThemeMode(nextThemeMode)}
          title={themeButtonLabel}
          aria-label={themeButtonLabel}
        >
          {getThemeIcon(themeMode)}
        </button>
        <button
          className={`xray-toggle ${xrayOpen ? "active" : ""}`}
          onClick={() => setXrayOpen((v) => !v)}
        >
          🔍 XRay
        </button>
        <button
          className="help-toggle"
          onClick={() => openHelpCenter()}
          title="Open help center"
          aria-label="Open help center"
        >
          ❓ Help
        </button>
      </div>

      <div className="panels-container">
        {xrayOpen && (
          <XRayPanel
            turns={xrayTurns}
            serverNames={activeConnections.map((c) => c.config.name)}
            themeMode={themeMode}
            onClose={() => setXrayOpen(false)}
          />
        )}

        {showSettings ? (
          <div className="messages">
            <div className="settings-banner">
              <div className="panel-header settings-header">
                <div className="settings-title-group">
                  <h2>⚙ Settings</h2>
                  <span className="settings-badge">Control Center</span>
                </div>
                <button className="settings-close-button" onClick={() => setShowSettings(false)}>
                  Done
                </button>
              </div>
              <p className="settings-lead">
                Make OpenChat feel like your own: tune model settings, connect MCP servers, and install skills.
              </p>
              <div className="settings-tabs-row">
                <button
                  className={`settings-tab-btn ${activeSettingsTab === "general" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("general")}
                >
                  General
                </button>
                <button
                  className={`settings-tab-btn ${activeSettingsTab === "mcp" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("mcp")}
                >
                  MCP Servers ({servers.length})
                </button>
                <button
                  className={`settings-tab-btn ${activeSettingsTab === "skills" ? "active" : ""}`}
                  onClick={() => setActiveSettingsTab("skills")}
                >
                  Skills ({localSkills.length})
                </button>
              </div>
            </div>

            {activeSettingsTab === "general" && (
            <div className="message assistant">
              <strong>General Settings</strong>
              <p className="status-text">
                Pick your provider, configure authentication, and manage import/export of your OpenChat preferences.
              </p>
              <div className="setup-grid">
                <label>
                  Provider
                  <select
                    value={providerType}
                    onChange={(e) => {
                      const next = e.target.value as ProviderConfig["type"];
                      setProviderType(next);
                      setProviderLabel(providerLabelFromType(next));
                    }}
                  >
                    {PROVIDER_OPTIONS.map((option) => (
                      <option key={option.type} value={option.type}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                {providerType === "github-models" && (
                  <label>
                    GitHub auth
                    <select
                      value={providerAuthMode}
                      onChange={(e) => setProviderAuthMode(e.target.value as "manual" | "gh-cli")}
                    >
                      <option value="manual">Manual token</option>
                      <option value="gh-cli">Use GitHub CLI session</option>
                    </select>
                  </label>
                )}
                {(providerType !== "github-models" || providerAuthMode === "manual") && (
                  <label>
                    API key
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder="Required"
                    />
                  </label>
                )}
                {providerType === "custom" && (
                  <label>
                    Custom mode
                    <select
                      value={customProviderMode}
                      onChange={(e) => setCustomProviderMode(e.target.value as CustomProviderMode)}
                    >
                      <option value="catalog">Catalog (/models + /chat/completions)</option>
                      <option value="direct-endpoint">Direct endpoint (single deployment)</option>
                    </select>
                  </label>
                )}
                {providerType === "custom" && customProviderMode === "catalog" && (
                  <label>
                    Base URL
                    <input
                      value={baseUrl}
                      onChange={(e) => setBaseUrl(e.target.value)}
                      placeholder="https://your-provider.example.com/v1"
                    />
                  </label>
                )}
                {providerType === "custom" && customProviderMode === "direct-endpoint" && (
                  <>
                    <label>
                      Direct endpoint URL
                      <input
                        value={directEndpointUrl}
                        onChange={(e) => setDirectEndpointUrl(e.target.value)}
                        placeholder="https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=..."
                      />
                    </label>
                    <label>
                      Credential type
                      <select
                        value={directAuthMode}
                        onChange={(e) => setDirectAuthMode(e.target.value as CustomDirectAuthMode)}
                      >
                        <option value="entra-bearer">Entra ID bearer token (Authorization)</option>
                        <option value="azure-api-key">Azure OpenAI key (api-key)</option>
                      </select>
                    </label>
                    <label>
                      Model / deployment name
                      <input
                        value={directModelName}
                        onChange={(e) => setDirectModelName(e.target.value)}
                        placeholder="e.g. gpt-4o or your deployment alias"
                      />
                    </label>
                  </>
                )}
                <label className="artifact-output-label">
                  Artifact output folder (optional)
                  <div className="artifact-output-picker-row">
                    <button type="button" onClick={() => void browseArtifactOutputFolder()}>
                      Browse…
                    </button>
                    <input
                      value={artifactOutputDirectory}
                      onChange={(e) => {
                        setArtifactOutputDirectory(e.target.value);
                        setGeneralStatus("");
                      }}
                      placeholder="Default: OpenChat project folder"
                    />
                  </div>
                </label>
              </div>
              {generalStatus && <p className="status-text">{generalStatus}</p>}
              {providerType === "github-models" && providerAuthMode === "gh-cli" && (
                <p className="status-text">
                  OpenChat will call <code>gh auth token</code>. If needed, run <code>gh auth login</code> first.
                </p>
              )}
              <div className="model-picker-row">
                <button onClick={loadModels} disabled={isLoadingModels}>
                  {isLoadingModels
                    ? "Loading..."
                    : isCustomDirectMode
                      ? "Use Direct Model"
                      : "Load Models"}
                </button>
                <label>
                  Model
                    <select
                      value={model}
                      onChange={(e) => {
                        setModel(e.target.value);
                        setModelRestoredFromConfig(false);
                      }}
                      disabled={modelOptions.length === 0}
                    >
                    {modelOptions.length === 0 ? (
                      <option value="">Load models first</option>
                    ) : (
                      modelOptions.map((modelName, index) => (
                        <option key={modelName} value={modelName}>
                          {index === 0 &&
                          modelName === model &&
                          !availableModels.includes(modelName) &&
                          modelRestoredFromConfig
                            ? `${modelName} (saved)`
                            : modelName}
                        </option>
                      ))
                    )}
                  </select>
                </label>
              </div>
              <div className="status-text">{modelLoadStatus}</div>
              {isCustomDirectMode && (
                <p className="status-text">
                  Direct endpoint auth mapping:{" "}
                  <code>{directAuthMode === "azure-api-key" ? "api-key: &lt;key&gt;" : "Authorization: Bearer &lt;token&gt;"}</code>
                </p>
              )}
              <div className="server-row">
                <button onClick={exportConfig}>Export Settings</button>
                <button onClick={() => importInputRef.current?.click()}>Import Settings</button>
                <input
                  ref={importInputRef}
                  className="hidden-file-input"
                  type="file"
                  accept=".json,application/json"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      void importConfigFromFile(file);
                    }
                    e.currentTarget.value = "";
                  }}
                />
              </div>
              <p className="status-text">
                Chat readiness: {readinessIssues.length === 0 ? "Ready" : `Not ready (${readinessIssues.join(" · ")})`}
              </p>
            </div>
            )}

            {activeSettingsTab === "mcp" && (
            <>
            <div className="message assistant">
              <strong>MCP Server Directory</strong>
              <p className="status-text">
                Add servers manually or discover existing configs, then test each connection before you enable chat tools.
              </p>
              <div className="setup-grid">
                <label>
                  Server name
                  <input value={manualName} onChange={(e) => setManualName(e.target.value)} />
                </label>
                <label>
                  Transport
                  <select
                    value={manualTransport}
                    onChange={(e) => setManualTransport(e.target.value as "http" | "sse" | "stdio")}
                  >
                    <option value="http">HTTP</option>
                    <option value="sse">SSE (legacy HTTP)</option>
                    <option value="stdio">Local stdio</option>
                  </select>
                </label>
                {manualTransport !== "stdio" ? (
                  <>
                    <label>
                      MCP URL
                      <input
                        value={manualUrl}
                        onChange={(e) => setManualUrl(e.target.value)}
                        placeholder="http://localhost:3001/mcp"
                      />
                    </label>
                    <label>
                      Auth token (optional)
                      <input
                        value={manualToken}
                        onChange={(e) => setManualToken(e.target.value)}
                        placeholder="Bearer token"
                      />
                    </label>
                  </>
                ) : (
                  <>
                    <label>
                      Command
                      <input
                        value={manualCommand}
                        onChange={(e) => setManualCommand(e.target.value)}
                        placeholder="npx"
                      />
                    </label>
                    <label>
                      Args (space-separated)
                      <input
                        value={manualArgs}
                        onChange={(e) => setManualArgs(e.target.value)}
                        placeholder="-y @modelcontextprotocol/server-everything"
                      />
                    </label>
                  </>
                )}
              </div>
              <div className="section-block-sm">
                <button onClick={addManualServer}>Add Manual Server</button>
              </div>
              {manualAddStatus && <div className="status-text">{manualAddStatus}</div>}
              <div className="section-block">
                <div className="server-row">
                  <strong>Discovered Servers</strong>
                  <button onClick={() => void loadDiscovery()} disabled={isDiscovering}>
                    {isDiscovering ? "Refreshing..." : "Refresh"}
                  </button>
                </div>
                <p className="status-text">{discoveryStatus}</p>
                {discoveredServers.map((server) => (
                  <div key={`${server.name}-${server.source}`} className="server-row">
                    <span>
                      {server.name} (
                      {(server.transport ?? "http").toUpperCase()}{" "}
                      {server.transport === "stdio"
                        ? `${server.command ?? "command missing"}${server.cwd ? ` (cwd: ${server.cwd})` : ""}`
                        : server.url ?? "URL missing"}
                      )
                    </span>
                    <span className="status-text">
                      Source: {server.source}
                      {!server.supportedTransport ? " (unsupported entry)" : ""}
                    </span>
                    <button
                      onClick={() => addDiscoveredServer(server)}
                      disabled={!server.supportedTransport}
                    >
                      Add
                    </button>
                  </div>
                ))}
              </div>
              <div className="section-block">
                <strong>Configured Servers</strong>
                {servers.length === 0 ? (
                  <p className="status-text">
                    No configured servers yet. Add one manually above or from discovered servers.
                  </p>
                ) : (
                  servers.map((server) => (
                    <div key={server.id} className="server-row">
                      <label>
                        <input
                          type="checkbox"
                          checked={server.enabled}
                          onChange={(e) => setServerEnabled(server.id, e.target.checked)}
                        />
                        Enabled
                      </label>
                      <span>
                        <strong>{server.name}</strong> —{" "}
                        {(server.transport ?? "http") === "stdio"
                          ? `${server.command ?? "Missing command"} ${(server.args ?? []).join(" ")}${server.cwd ? ` (cwd: ${server.cwd})` : ""}`
                          : server.url ?? "Missing URL"}
                      </span>
                      <button onClick={() => testServer(server)}>Test</button>
                      <button onClick={() => removeServer(server.id)}>Remove</button>
                      {serverTestStatus[server.id] && (
                        <span className="server-test-status">
                          {serverTestStatus[server.id].status}
                          {serverTestStatus[server.id].tools.length > 0 && (
                            <>
                              {" "}
                              (
                              <button
                                type="button"
                                className="inline-link-button"
                                onClick={() => setToolListServerId(server.id)}
                              >
                                {serverTestStatus[server.id].tools.length} tools
                              </button>
                              )
                            </>
                          )}
                        </span>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="message assistant">
              <strong>Connect and Validate</strong>
              <p className="status-text">
                Enabled servers: {servers.filter((server) => server.enabled).length}
              </p>
              <p className="status-text">
                Chat readiness:{" "}
                {readinessIssues.length === 0
                  ? "Ready"
                  : `Not ready (${readinessIssues.join(" · ")})`}
              </p>
              <p className="status-text">
                MCP connected: {activeConnections.length} server(s) · Chat mode: {chatMode} ·
                Orchestration: {orchestrationMode}
              </p>
              <p className="status-text">
                CopilotKit runtime URL: {copilotKitRuntimeUrl}
              </p>
              <p className="status-text">MCP transport: {transportModeLabel}</p>
              <p className="status-text">
                CopilotKit MCP projection: {copilotKitMcpProjection.length} HTTP/SSE endpoint(s)
              </p>
              <p className="status-text">
                CopilotKit MCP sync: {copilotKitMcpSyncEnabled ? "active" : "inactive"}
              </p>
              <div className="section-block-sm">
                <button onClick={connectConfiguredServers} disabled={isConnectingServers}>
                  {isConnectingServers ? "Connecting..." : "Connect Selected Servers"}
                </button>
              </div>
              {connectStatus && (
                <div className="server-row">
                  <span>{connectStatus}</span>
                </div>
              )}
              {connections.length > 0 && (
                <div className="section-block-sm">
                  <strong>Connection Results</strong>
                  {connections.map((connection) => (
                    <div key={connection.config.id} className="server-row">
                      <span>
                        {connection.config.name}: {connection.status}
                        {connection.status === "connected"
                          ? ` (${connection.tools.length} tools)`
                          : connection.error
                            ? ` — ${connection.error}`
                            : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            </>
            )}
            {activeSettingsTab === "skills" && (
            <div className="message assistant">
              <strong>Skills Marketplace</strong>
              <p className="status-text">
                Browse trusted skill catalogs, install with one click, and create your own reusable skills.
              </p>
              <div className="setup-grid">
                <label>
                  Library
                  <select
                    value={selectedLibraryId}
                    onChange={(event) => setSelectedLibraryId(event.target.value)}
                  >
                    {skillLibraries.map((library) => (
                      <option key={library.id} value={library.id}>
                        {library.displayName}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Install location
                  <select
                    value={installLocation}
                    onChange={(event) => setInstallLocation(event.target.value as SkillSaveLocation)}
                  >
                    <option value="user-global">User-global (~/.openchat/skills)</option>
                    <option value="project-local">Project-local (.openchat/skills)</option>
                  </select>
                </label>
              </div>
              <div className="server-row">
                <button onClick={() => void browseSkills()} disabled={isBrowsingSkills || !selectedLibraryId}>
                  {isBrowsingSkills ? "Browsing..." : "Browse Library Skills"}
                </button>
                <button onClick={() => void loadLocalSkills()}>Refresh Installed Skills</button>
                <button onClick={openCreateSkillEditor}>Create Custom Skill</button>
              </div>
              <p className="status-text">{skillsStatus}</p>
              {lastInstalledSkill && (
                <div className="skills-inline-success">
                  Installed <strong>{lastInstalledSkill.name}</strong> to {lastInstalledSkill.location}.{" "}
                  <button
                    type="button"
                    className="inline-link-button"
                    onClick={() => installedSkillsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
                  >
                    View installed list
                  </button>
                </div>
              )}
              {remoteSkills.length > 0 && (
                <div className="skills-available-section">
                  <strong>Available Skills</strong>
                  <input
                    className="skills-filter-input"
                    value={skillsFilter}
                    onChange={(event) => setSkillsFilter(event.target.value)}
                    placeholder="Filter by skill name, description, or tags"
                  />
                  {filteredRemoteSkills.length === 0 && (
                    <p className="status-text">No skills match your current filter.</p>
                  )}
                  {filteredRemoteSkills.length > 0 && (
                    <p className="status-text">Showing {filteredRemoteSkills.length} skills</p>
                  )}
                  <div className="skills-list">
                    {filteredRemoteSkills.map((skill) => {
                      const skillKey = `${installLocation}:${skill.name.trim().toLowerCase()}`;
                      const isInstalled = installedSkillKeys.has(skillKey);
                      const justInstalled =
                        lastInstalledSkill?.location === installLocation &&
                        lastInstalledSkill.name.trim().toLowerCase() === skill.name.trim().toLowerCase();
                      return (
                    <div
                      key={`${skill.libraryId}:${skill.skillPath}`}
                      className={`skill-card ${justInstalled ? "just-installed" : ""}`}
                    >
                      <div>
                        <div className="skill-card-title-row">
                          <strong>
                            {skill.name}
                            {skill.version ? ` (v${skill.version})` : ""}
                          </strong>
                          {isInstalled && (
                            <span className="skill-installed-pill">
                              {justInstalled ? "Installed just now" : "Installed"}
                            </span>
                          )}
                        </div>
                        <div className="status-text">{skill.description}</div>
                        {skill.tags.length > 0 && (
                          <div className="status-text">Tags: {skill.tags.join(", ")}</div>
                        )}
                      </div>
                      <button
                        className="skill-install-btn"
                        onClick={() => void installSkill(skill)}
                        disabled={installingSkillPath === skill.skillPath}
                      >
                        {installingSkillPath === skill.skillPath
                          ? "Installing..."
                          : isInstalled
                            ? "Reinstall"
                            : "Install"}
                      </button>
                    </div>
                    );
                  })}
                  </div>
                </div>
              )}
              <div className="section-block" ref={installedSkillsRef}>
                <strong>Installed Skills</strong>
                {localSkillsStatus && <p className="status-text">{localSkillsStatus}</p>}
                <input
                  className="skills-filter-input"
                  value={installedSkillsFilter}
                  onChange={(event) => setInstalledSkillsFilter(event.target.value)}
                  placeholder="Filter installed skills"
                />
                {localSkills.length === 0 ? (
                  <p className="status-text">No installed skills found yet.</p>
                ) : filteredLocalSkills.length === 0 ? (
                  <p className="status-text">No installed skills match your filter.</p>
                ) : (
                  <div className="installed-skills-list">
                    {filteredLocalSkills.map((skill) => {
                      const removingKey = `${skill.location}:${skill.directory}`;
                      return (
                    <div key={`${skill.location}:${skill.id}:${skill.directory}`} className="installed-skill-card">
                      <div className="installed-skill-main">
                        <div className="installed-skill-title-row">
                          <strong>{skill.name}</strong>
                          {skill.version && <span className="skill-installed-pill">v{skill.version}</span>}
                          <span className="skill-installed-pill">{skill.location}</span>
                        </div>
                        <div className="status-text">{skill.description}</div>
                        {skill.tags.length > 0 && (
                          <div className="status-text">Tags: {skill.tags.join(", ")}</div>
                        )}
                        <div className="status-text">{skill.skillFile || skill.directory}</div>
                      </div>
                      <div className="installed-skill-actions">
                        <button
                          className="installed-skill-action"
                          onClick={() => openEditSkillEditor(skill)}
                        >
                          Edit
                        </button>
                        <button
                          className="installed-skill-action danger"
                          onClick={() => void removeSkill(skill)}
                          disabled={removingSkillKey === removingKey}
                        >
                          {removingSkillKey === removingKey ? "Removing..." : "Remove"}
                        </button>
                      </div>
                    </div>
                    );
                  })}
                  </div>
                )}
              </div>
            </div>
            )}
          </div>
        ) : (
          <div className="messages">
            <div className="panel-header chat-header">
              <h2>Chat</h2>
              <span className="tool-count">
                {activeConnections.length} connected
                {enabledServersCount > activeConnections.length
                  ? ` (${enabledServersCount} enabled)`
                  : ""}{" "}
                servers · {aliasedTools.length} tools · {chatMode} · {orchestrationMode}
              </span>
              <button onClick={startNewChat}>New Chat</button>
            </div>
            {messages.length === 0 && (
              <div className="message assistant">
                Ask a question in plain language. OpenChat will use MCP tools only when they add useful context.
              </div>
            )}
            {messages.map((message, index) => (
              <div key={index}>
                <div className={`message ${message.role}`}>{message.content}</div>
                {message.uiMeta && message.uiMeta.client && (
                  <AppFrame
                    client={message.uiMeta.client}
                    uiHtml={message.uiMeta.uiHtml}
                    toolName={message.uiMeta.toolName}
                    serverName={message.uiMeta.serverName}
                    toolArgs={message.uiMeta.toolArgs}
                    toolResult={message.uiMeta.toolResult}
                    themeMode={themeMode}
                    onBridgeEvent={handleAppFrameBridgeEvent}
                  />
                )}
                {message.uiMeta && !message.uiMeta.client && (
                  <div className="app-frame">
                    <div className="status-text app-frame-note">
                      Static preview only for this transport. Use HTTP or SSE MCP transport for fully interactive cards.
                    </div>
                    <iframe
                      sandbox="allow-scripts allow-same-origin allow-forms"
                      title={`${message.uiMeta.toolName} UI`}
                      srcDoc={message.uiMeta.uiHtml}
                    />
                  </div>
                )}
              </div>
            ))}
            {isProcessing && <div className="typing-indicator">Thinking...</div>}
          </div>
        )}
      </div>

      {showHelpCenter && (
        <HelpCenter
          activeTopicId={activeHelpTopicId}
          onSelectTopic={setActiveHelpTopicId}
          onClose={() => setShowHelpCenter(false)}
        />
      )}

      {showSkillEditor && (
        <div className="tool-popup-backdrop" onClick={closeSkillEditor}>
          <div
            className={`tool-popup skill-editor-modal${isSkillEditorExpanded ? " expanded" : ""}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="tool-popup-header">
              <div className="tool-popup-title">
                {editingSkill ? "Edit Installed Skill" : "Create Custom Skill"}
              </div>
              <div className="tool-popup-header-actions">
                <button
                  type="button"
                  className="skill-editor-expand"
                  onClick={() => setIsSkillEditorExpanded((value) => !value)}
                  title={isSkillEditorExpanded ? "Collapse editor" : "Expand editor"}
                  aria-label={isSkillEditorExpanded ? "Collapse editor" : "Expand editor"}
                >
                  {isSkillEditorExpanded ? "🗗" : "🗖"}
                </button>
                <button
                  type="button"
                  className="tool-popup-close"
                  onClick={closeSkillEditor}
                  title="Close"
                >
                  ✕
                </button>
              </div>
            </div>
            <div className="tool-popup-body">
              <p className="status-text">
                {editingSkill
                  ? "Update your local skill definition."
                  : "Create a local SKILL.md and return to the Installed Skills list."}
              </p>
              <div className="setup-grid">
                <label>
                  Skill name
                  <input
                    value={newSkillName}
                    onChange={(event) => setNewSkillName(event.target.value)}
                    placeholder="e.g. explain-trace"
                  />
                </label>
                {editingSkill ? (
                  <label>
                    Save location
                    <input value={editingSkill.location} readOnly />
                  </label>
                ) : (
                  <label>
                    Save location
                    <select
                      value={createLocation}
                      onChange={(event) => setCreateLocation(event.target.value as SkillSaveLocation)}
                    >
                      <option value="user-global">User-global (~/.openchat/skills)</option>
                      <option value="project-local">Project-local (.openchat/skills)</option>
                    </select>
                  </label>
                )}
                <label className="full-span">
                  Description
                  <textarea
                    className="settings-textarea skill-description-textarea"
                    value={newSkillDescription}
                    onChange={(event) => setNewSkillDescription(event.target.value)}
                    placeholder="Describe what the skill should help with"
                  />
                </label>
                <label className="full-span">
                  Instructions
                  <textarea
                    className="settings-textarea skill-instructions-textarea"
                    value={newSkillInstructions}
                    onChange={(event) => setNewSkillInstructions(event.target.value)}
                    placeholder="Write behavior guidance that will be saved into SKILL.md"
                  />
                </label>
              </div>
              <div className="skill-editor-actions">
                <button type="button" onClick={closeSkillEditor} disabled={isSavingSkill}>
                  Cancel
                </button>
                <button type="button" onClick={() => void saveSkill()} disabled={isSavingSkill}>
                  {isSavingSkill ? "Saving..." : editingSkill ? "Save Changes" : "Create Skill"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {toolListServerId && serverTestStatus[toolListServerId] && (
        <div className="tool-popup-backdrop" onClick={() => setToolListServerId(null)}>
          <div className="tool-popup" onClick={(event) => event.stopPropagation()}>
            <div className="tool-popup-header">
              <div className="tool-popup-title">
                {servers.find((server) => server.id === toolListServerId)?.name ?? "Server"} tools
              </div>
              <button
                type="button"
                className="tool-popup-close"
                onClick={() => setToolListServerId(null)}
                title="Close"
              >
                ✕
              </button>
            </div>
            <div className="tool-popup-body">
              {serverTestStatus[toolListServerId].tools.map((tool) => {
                const { parameters, required } = getToolParamInfo(tool);
                return (
                  <div key={tool.name} className="tool-popup-card">
                    <div className="tool-popup-tool-name">{tool.name}</div>
                    <div className="tool-popup-tool-desc">{tool.description || "No description."}</div>
                    <div className="tool-popup-meta">
                      <strong>Parameters:</strong>{" "}
                      {parameters.length > 0 ? parameters.join(", ") : "None"}
                    </div>
                    <div className="tool-popup-meta">
                      <strong>Required:</strong> {required.length > 0 ? required.join(", ") : "None"}
                    </div>
                    <details className="tool-popup-schema">
                      <summary>Input schema</summary>
                      <pre>{JSON.stringify(tool.inputSchema ?? {}, null, 2)}</pre>
                    </details>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      <div className="input-bar">
        <textarea
          ref={textareaRef}
          rows={1}
          placeholder={
            isConfigured
              ? "Ask anything about your tools, systems, or workflows..."
              : `Complete settings first (${readinessIssues.join(" · ")})`
          }
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            autoResizeTextarea();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          disabled={!isConfigured || isProcessing}
        />
        {isProcessing ? (
          <div className="processing-indicator" title="Processing…">
            <span className="processing-dot" />
            <span className="processing-dot" />
            <span className="processing-dot" />
          </div>
        ) : (
          <button onClick={() => void handleSend()} disabled={!isConfigured}>
            Send
          </button>
        )}
        <button
          className="settings-cog-button"
          onClick={() => setShowSettings(true)}
          title="Open settings (General, MCP Servers, Skills)"
          aria-label="Open settings"
        >
          ⚙
        </button>
      </div>
    </div>
  );
}


