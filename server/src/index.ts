import cors from "cors";
import express from "express";
import { execFile } from "node:child_process";
import type { Server } from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DiscoveredServerConfig, LlmRequestPayload } from "@openchat/shared";

type SkillSaveLocation = "user-global" | "project-local";

interface SkillLibraryDefinition {
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

const BUILTIN_SKILL_LIBRARIES: SkillLibraryDefinition[] = [
  {
    id: "awesome-copilot",
    displayName: "GitHub Awesome Copilot",
    owner: "github",
    repo: "awesome-copilot",
    path: "skills",
  },
  {
    id: "microsoft-skills",
    displayName: "Microsoft Skills",
    owner: "microsoft",
    repo: "skills",
    path: "skills",
  },
];

const app = express();
const defaultPort = Number(process.env.PORT ?? 4173);

app.use(cors());
app.use(express.json({ limit: "2mb" }));

function hasUnresolvedInputPlaceholder(value?: string) {
  return typeof value === "string" && /\$\{input:[^}]+\}/.test(value);
}

function validateProviderAuth(
  value: {
    type: string;
    authMode?: string;
    apiKey: string;
    customMode?: string;
    baseUrl?: string;
    directEndpointUrl?: string;
    directAuthMode?: string;
    directModelName?: string;
  },
  ctx: z.RefinementCtx
) {
  const isCustomProvider = value.type === "custom";
  const customMode = value.customMode === "direct-endpoint" ? "direct-endpoint" : "catalog";

  if (isCustomProvider && customMode === "catalog" && !normalizeBaseUrl(value.baseUrl)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Custom provider (Catalog mode) requires a base URL.",
      path: ["baseUrl"],
    });
  }

  if (isCustomProvider && customMode === "direct-endpoint") {
    const directEndpointUrl = (value.directEndpointUrl ?? "").trim();
    if (!directEndpointUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct endpoint mode requires an endpoint URL.",
        path: ["directEndpointUrl"],
      });
    } else {
      try {
        // eslint-disable-next-line no-new
        new URL(directEndpointUrl);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Direct endpoint URL must be a valid URL.",
          path: ["directEndpointUrl"],
        });
      }
    }

    const directModelName = (value.directModelName ?? "").trim();
    if (!directModelName) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct endpoint mode requires a model/deployment name.",
        path: ["directModelName"],
      });
    }

    if (value.directAuthMode !== "entra-bearer" && value.directAuthMode !== "azure-api-key") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Direct endpoint mode requires an auth type (Entra bearer or Azure API key).",
        path: ["directAuthMode"],
      });
    }
  }

  if (value.type === "github-models" && value.authMode === "gh-cli") {
    return;
  }
  if (!value.apiKey.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "API key is required for the selected provider/auth mode.",
      path: ["apiKey"],
    });
  }
}

const providerSchemaBase = z.object({
  id: z.string(),
  type: z.enum(["github-models", "openai", "anthropic", "google", "custom"]),
  label: z.string(),
  model: z.string().min(1),
  apiKey: z.string(),
  authMode: z.enum(["manual", "gh-cli"]).optional(),
  baseUrl: z.string().optional(),
  customMode: z.enum(["catalog", "direct-endpoint"]).optional(),
  directEndpointUrl: z.string().optional(),
  directAuthMode: z.enum(["entra-bearer", "azure-api-key"]).optional(),
  directModelName: z.string().optional(),
});

const providerSchema = providerSchemaBase.superRefine(validateProviderAuth);

const providerSetupSchema = providerSchemaBase
  .pick({
  id: true,
  type: true,
  label: true,
  apiKey: true,
  authMode: true,
  baseUrl: true,
  customMode: true,
  directEndpointUrl: true,
  directAuthMode: true,
  directModelName: true,
  })
  .superRefine(validateProviderAuth);

const llmBodySchema = z.object({
  provider: providerSchema,
  messages: z.array(z.record(z.string(), z.unknown())),
  tools: z.array(z.record(z.string(), z.unknown())).optional(),
  temperature: z.number().min(0).max(2).optional(),
});

const serverTestSchema = z
  .object({
    transport: z.enum(["http", "sse", "stdio"]).optional(),
    url: z.string().optional(),
    authToken: z.string().optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    env: z.record(z.string(), z.string()).optional(),
    cwd: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasPlaceholder =
      hasUnresolvedInputPlaceholder(value.url) ||
      hasUnresolvedInputPlaceholder(value.command) ||
      hasUnresolvedInputPlaceholder(value.cwd) ||
      (value.args ?? []).some((arg) => hasUnresolvedInputPlaceholder(arg)) ||
      Object.values(value.env ?? {}).some((val) => hasUnresolvedInputPlaceholder(val));
    if (hasPlaceholder) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Server config still contains unresolved ${input:*} placeholders. Replace them with real values first.",
      });
      return;
    }

    const transport = value.transport ?? (value.command ? "stdio" : "http");
    if (transport === "http" || transport === "sse") {
      if (!value.url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${transport.toUpperCase()} transport requires a URL.` });
        return;
      }
      try {
        // eslint-disable-next-line no-new
        new URL(value.url);
      } catch {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Invalid MCP URL." });
      }
      return;
    }
    if (!value.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Stdio transport requires a command.",
      });
    }
  });

const stdioCallSchema = z.object({
  server: serverTestSchema,
  toolName: z.string().min(1),
  args: z.record(z.string(), z.unknown()).optional(),
  resourceUri: z.string().optional(),
});

const skillSaveLocationSchema = z.enum(["user-global", "project-local"]);

const skillsBrowseSchema = z.object({
  libraryId: z.string().min(1),
});

const skillsInstallSchema = z.object({
  libraryId: z.string().min(1),
  skillPath: z.string().min(1),
  saveLocation: skillSaveLocationSchema,
});

const skillsCreateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
  saveLocation: skillSaveLocationSchema,
});

const skillsUpdateSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  instructions: z.string().optional(),
  location: skillSaveLocationSchema,
  directory: z.string().min(1),
});

const skillsRemoveSchema = z.object({
  location: skillSaveLocationSchema,
  directory: z.string().min(1),
});

const localWriteFileSchema = z.object({
  relativePath: z.string().min(1),
  content: z.string(),
  overwrite: z.boolean().optional(),
  outputDirectory: z.string().optional(),
});
const desktopChooseFolderSchema = z.object({
  initialPath: z.string().optional(),
});

type DesktopFolderPicker = (initialPath?: string) => Promise<string | null> | string | null;
let desktopFolderPicker: DesktopFolderPicker | null = null;

function getProjectRoot() {
  const configuredRoot = process.env.OPENCHAT_PROJECT_ROOT?.trim();
  if (configuredRoot) {
    return path.resolve(configuredRoot);
  }
  return process.env.INIT_CWD ?? path.resolve(process.cwd(), "..");
}

function resolveOutputFilePath(relativePath: string, outputDirectory?: string) {
  const projectRoot = getProjectRoot();
  const outputRootInput = outputDirectory?.trim() ?? "";
  const outputRoot = outputRootInput
    ? path.isAbsolute(outputRootInput) || /^[a-zA-Z]:/.test(outputRootInput)
      ? path.resolve(outputRootInput)
      : path.resolve(projectRoot, outputRootInput)
    : projectRoot;
  const cleaned = relativePath.trim();
  if (!cleaned) {
    throw new Error("relativePath is required.");
  }
  if (path.isAbsolute(cleaned) || /^[a-zA-Z]:/.test(cleaned)) {
    throw new Error("Path must be relative.");
  }
  const resolved = path.resolve(outputRoot, cleaned);
  const relativeToOutputRoot = path.relative(outputRoot, resolved);
  if (
    !relativeToOutputRoot ||
    relativeToOutputRoot === "." ||
    relativeToOutputRoot.startsWith("..") ||
    path.isAbsolute(relativeToOutputRoot)
  ) {
    throw new Error("Path escapes output root.");
  }
  return { projectRoot, outputRoot, resolved, relativeToOutputRoot };
}

function asNumber(value: unknown, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stripMarkdownCodeFence(content: string) {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : trimmed;
}

function parseJsonFromContent(content: string): unknown {
  const stripped = stripMarkdownCodeFence(content);
  try {
    return JSON.parse(stripped) as unknown;
  } catch {
    const start = stripped.indexOf("{");
    const end = stripped.lastIndexOf("}");
    if (start >= 0 && end > start) {
      return JSON.parse(stripped.slice(start, end + 1)) as unknown;
    }
    throw new Error("Content is not valid JSON.");
  }
}

function normalizeExcalidrawElement(raw: unknown, index: number, now: number) {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const rawType = typeof source.type === "string" ? source.type : "rectangle";
  const allowedTypes = new Set(["rectangle", "ellipse", "diamond", "text", "arrow", "line"]);
  const type = allowedTypes.has(rawType) ? rawType : "rectangle";
  const widthDefault = type === "arrow" || type === "line" ? 140 : type === "text" ? 160 : 220;
  const heightDefault = type === "arrow" || type === "line" ? 0 : type === "text" ? 40 : 100;
  const width = asNumber(source.width, widthDefault);
  const height = asNumber(source.height, heightDefault);
  const element: Record<string, unknown> = {
    type,
    id: typeof source.id === "string" && source.id.trim() ? source.id : `oc-${now}-${index}`,
    x: asNumber(source.x, 100 + index * 20),
    y: asNumber(source.y, 100 + index * 20),
    width,
    height,
    angle: asNumber(source.angle, 0),
    strokeColor:
      typeof source.strokeColor === "string"
        ? source.strokeColor
        : typeof source.stroke === "string"
          ? source.stroke
          : "#1e1e1e",
    backgroundColor:
      typeof source.backgroundColor === "string"
        ? source.backgroundColor
        : typeof source.fill === "string"
          ? source.fill
          : "transparent",
    fillStyle: typeof source.fillStyle === "string" ? source.fillStyle : "solid",
    strokeWidth: asNumber(source.strokeWidth, 2),
    strokeStyle: typeof source.strokeStyle === "string" ? source.strokeStyle : "solid",
    roughness: asNumber(source.roughness, 1),
    opacity: asNumber(source.opacity, 100),
    groupIds: Array.isArray(source.groupIds)
      ? source.groupIds.filter((item): item is string => typeof item === "string")
      : [],
    frameId: source.frameId ?? null,
    roundness:
      source.roundness ??
      (type === "rectangle" || type === "diamond"
        ? { type: 3 }
        : null),
    seed: asNumber(source.seed, Math.floor(Math.random() * 1_000_000_000)),
    version: asNumber(source.version, 1),
    versionNonce: asNumber(source.versionNonce, Math.floor(Math.random() * 1_000_000_000)),
    isDeleted: Boolean(source.isDeleted),
    boundElements: Array.isArray(source.boundElements) ? source.boundElements : [],
    updated: asNumber(source.updated, now),
    link: source.link ?? null,
    locked: Boolean(source.locked),
  };

  if (type === "text") {
    const text = typeof source.text === "string" ? source.text : "";
    element.text = text;
    element.fontSize = asNumber(source.fontSize, 24);
    element.fontFamily = asNumber(source.fontFamily, 1);
    element.textAlign = typeof source.textAlign === "string" ? source.textAlign : "center";
    element.verticalAlign = typeof source.verticalAlign === "string" ? source.verticalAlign : "middle";
    element.containerId = source.containerId ?? null;
    element.originalText = typeof source.originalText === "string" ? source.originalText : text;
    element.autoResize = source.autoResize === undefined ? true : Boolean(source.autoResize);
    element.lineHeight = asNumber(source.lineHeight, 1.25);
  } else if (type === "arrow" || type === "line") {
    element.points = Array.isArray(source.points) ? source.points : [[0, 0], [width, height]];
    element.lastCommittedPoint = source.lastCommittedPoint ?? null;
    if (type === "arrow") {
      element.startArrowhead = source.startArrowhead ?? null;
      element.endArrowhead = source.endArrowhead ?? "arrow";
      element.startBinding = source.startBinding ?? null;
      element.endBinding = source.endBinding ?? null;
    }
  }

  return element;
}

function normalizeExcalidrawContent(content: string) {
  const parsed = parseJsonFromContent(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Excalidraw content must be a JSON object.");
  }
  const source = parsed as Record<string, unknown>;
  if (!Array.isArray(source.elements)) {
    throw new Error("Excalidraw content must include an elements array.");
  }
  const now = Date.now();
  const normalizedElements: Array<Record<string, unknown>> = [];
  for (let index = 0; index < source.elements.length; index += 1) {
    const rawElement = source.elements[index];
    const normalizedElement = normalizeExcalidrawElement(rawElement, index, now);
    normalizedElements.push(normalizedElement);

    const raw =
      rawElement && typeof rawElement === "object" && !Array.isArray(rawElement)
        ? (rawElement as Record<string, unknown>)
        : {};
    const type = String(normalizedElement.type ?? "");
    const legacyText = typeof raw.text === "string" ? raw.text.trim() : "";
    if (!legacyText || type === "text" || type === "arrow" || type === "line") {
      continue;
    }

    const containerId = String(normalizedElement.id ?? `oc-${now}-${index}`);
    const textId = `${containerId}-label`;
    const boundElements = Array.isArray(normalizedElement.boundElements)
      ? normalizedElement.boundElements
      : [];
    normalizedElement.boundElements = [...boundElements, { type: "text", id: textId }];
    const label = normalizeExcalidrawElement(
      {
        type: "text",
        id: textId,
        x: asNumber(normalizedElement.x, 0) + asNumber(normalizedElement.width, 120) / 2 - 80,
        y: asNumber(normalizedElement.y, 0) + asNumber(normalizedElement.height, 40) / 2 - 14,
        width: 160,
        height: 28,
        text: legacyText,
        originalText: legacyText,
        textAlign: "center",
        verticalAlign: "middle",
        containerId,
        strokeColor:
          typeof normalizedElement.strokeColor === "string"
            ? normalizedElement.strokeColor
            : "#1e1e1e",
        backgroundColor: "transparent",
      },
      source.elements.length + index,
      now
    );
    normalizedElements.push(label);
  }
  const normalized = {
    type: "excalidraw",
    version: asNumber(source.version, 2),
    source: typeof source.source === "string" ? source.source : "https://openchat.local",
    elements: normalizedElements,
    appState:
      source.appState && typeof source.appState === "object" && !Array.isArray(source.appState)
        ? source.appState
        : {},
    files:
      source.files && typeof source.files === "object" && !Array.isArray(source.files)
        ? source.files
        : {},
  };
  return JSON.stringify(normalized, null, 2);
}

function getSkillsDirectory(saveLocation: SkillSaveLocation) {
  return saveLocation === "user-global"
    ? path.join(os.homedir(), ".openchat", "skills")
    : path.join(getProjectRoot(), ".openchat", "skills");
}

function slugify(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function parseSkillMarkdown(content: string, fallbackName: string) {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  let bodyStart = 0;
  const metadata: Record<string, string> = {};
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (line === "---") {
        bodyStart = i + 1;
        break;
      }
      const idx = line.indexOf(":");
      if (idx <= 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim().replace(/^["']|["']$/g, "");
      metadata[key] = val;
    }
  }

  const tags = (metadata.tags ?? "")
    .split(/[,\s]+/)
    .map((tag) => tag.trim())
    .filter(Boolean);

  const name = metadata.name || fallbackName;
  const description = metadata.description || "No description provided.";
  const version = metadata.version || undefined;
  const body = lines.slice(bodyStart).join("\n").trim();

  return { name, description, version, tags, body };
}

async function fetchGitHubJson(url: string) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "OpenChat",
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status}): ${text}`);
  }
  return JSON.parse(text) as unknown;
}

async function fetchGitHubRawBuffer(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "OpenChat",
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`GitHub raw content request failed (${response.status}): ${text}`);
  }
  const data = await response.arrayBuffer();
  return Buffer.from(data);
}

function resolveSkillLibrary(libraryId: string) {
  return BUILTIN_SKILL_LIBRARIES.find((library) => library.id === libraryId);
}

async function fetchRemoteSkillMarkdown(owner: string, repo: string, skillPath: string) {
  const normalizedPath = skillPath.replace(/^\/+/, "");
  const fileUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(normalizedPath).replace(/%2F/g, "/")}`;
  const fileJson = (await fetchGitHubJson(fileUrl)) as {
    content?: string;
    encoding?: string;
  };
  if (!fileJson.content || fileJson.encoding !== "base64") {
    throw new Error("Remote skill content was not returned as base64.");
  }
  return Buffer.from(fileJson.content.replace(/\n/g, ""), "base64").toString("utf8");
}

function ensurePathInside(root: string, candidate: string) {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Resolved path escapes destination root.");
  }
}

async function installRemoteSkillDirectory(
  owner: string,
  repo: string,
  remoteDirPath: string,
  localDir: string
) {
  const queue: Array<{ remotePath: string; localPath: string }> = [
    { remotePath: remoteDirPath.replace(/^\/+/, ""), localPath: localDir },
  ];
  let fileCount = 0;

  while (queue.length > 0) {
    const next = queue.shift();
    if (!next) break;

    const dirUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${encodeURIComponent(next.remotePath).replace(/%2F/g, "/")}`;
    const entries = (await fetchGitHubJson(dirUrl)) as Array<{
      type?: string;
      name?: string;
      path?: string;
      download_url?: string | null;
    }>;
    if (!Array.isArray(entries)) {
      throw new Error(`Expected directory listing for ${next.remotePath}.`);
    }

    fs.mkdirSync(next.localPath, { recursive: true });

    for (const entry of entries) {
      if (!entry.name || !entry.path) continue;
      const destination = path.join(next.localPath, entry.name);
      ensurePathInside(localDir, destination);

      if (entry.type === "dir") {
        queue.push({ remotePath: entry.path, localPath: destination });
        continue;
      }

      if (entry.type !== "file" || !entry.download_url) continue;
      const buffer = await fetchGitHubRawBuffer(entry.download_url);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, buffer);
      fileCount += 1;
    }
  }

  return fileCount;
}

async function browseSkillLibrary(library: SkillLibraryDefinition): Promise<RemoteSkillInfo[]> {
  const listUrl = `https://api.github.com/repos/${library.owner}/${library.repo}/contents/${library.path}`;
  const entries = (await fetchGitHubJson(listUrl)) as Array<{
    type?: string;
    name?: string;
    path?: string;
  }>;
  const skills: RemoteSkillInfo[] = [];

  for (const entry of entries) {
    if (entry.type !== "dir" || !entry.name || !entry.path) continue;
    const skillPath = `${entry.path}/SKILL.md`;
    try {
      const markdown = await fetchRemoteSkillMarkdown(library.owner, library.repo, skillPath);
      const parsed = parseSkillMarkdown(markdown, entry.name);
      skills.push({
        id: slugify(parsed.name) || slugify(entry.name),
        name: parsed.name,
        description: parsed.description,
        version: parsed.version,
        tags: parsed.tags,
        skillPath,
        libraryId: library.id,
      });
    } catch {
      // Skip entries that do not provide readable SKILL.md content.
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function listLocalSkills() {
  const roots: Array<{ location: SkillSaveLocation; rootPath: string }> = [
    { location: "user-global", rootPath: getSkillsDirectory("user-global") },
    { location: "project-local", rootPath: getSkillsDirectory("project-local") },
  ];
  const items: Array<{
    id: string;
    name: string;
    description: string;
    version?: string;
    tags: string[];
    instructions: string;
    location: SkillSaveLocation;
    directory: string;
    skillFile: string;
  }> = [];

  for (const root of roots) {
    if (!fs.existsSync(root.rootPath)) continue;
    const dirs = fs.readdirSync(root.rootPath, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    for (const dirent of dirs) {
      const skillFile = path.join(root.rootPath, dirent.name, "SKILL.md");
      if (!fs.existsSync(skillFile)) continue;
      try {
        const content = fs.readFileSync(skillFile, "utf8");
        const parsed = parseSkillMarkdown(content, dirent.name);
        items.push({
          id: slugify(parsed.name) || slugify(dirent.name),
          name: parsed.name,
          description: parsed.description,
          version: parsed.version,
          tags: parsed.tags,
          instructions: parsed.body,
          location: root.location,
          directory: path.dirname(skillFile),
          skillFile,
        });
      } catch {
        // Skip unreadable local skills.
      }
    }
  }

  return items;
}

function resolveLocalSkillDirectory(location: SkillSaveLocation, directory: string) {
  const root = path.resolve(getSkillsDirectory(location));
  const input = directory.trim();
  if (!input) {
    throw new Error("Skill directory is required.");
  }
  const resolvedDir =
    path.isAbsolute(input) || /^[a-zA-Z]:/.test(input)
      ? path.resolve(input)
      : path.resolve(root, input);
  const relative = path.relative(root, resolvedDir);
  if (
    !relative ||
    relative === "." ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Skill directory escapes skills root.");
  }
  return { root, resolvedDir };
}

function buildSkillMarkdown(
  name: string,
  description: string,
  instructions: string,
  version?: string,
  tags?: string[]
) {
  const lines = [
    "---",
    `name: ${name}`,
    `description: ${description}`,
    `version: ${version ?? "1.0.0"}`,
  ];
  if (tags && tags.length > 0) {
    lines.push(`tags: ${tags.join(", ")}`);
  }
  lines.push("---", "", instructions, "");
  return lines.join("\n");
}

function parseMcpJsonServers(filePath: string): DiscoveredServerConfig[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const json = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      servers?: Record<string, Record<string, unknown>>;
      mcpServers?: Record<string, Record<string, unknown>>;
    };
    const servers = { ...(json.servers ?? {}), ...(json.mcpServers ?? {}) };
    const sourceDir = path.dirname(filePath);
    const inferredRoot =
      path.basename(sourceDir).toLowerCase() === ".vscode" ? path.dirname(sourceDir) : sourceDir;
    return Object.entries(servers).map(([name, config]) => {
      const maybeUrl = typeof config.url === "string" ? config.url : undefined;
      const maybeEndpoint =
        typeof config.endpoint === "string" ? config.endpoint : undefined;
      const maybeType = typeof config.type === "string" ? config.type.toLowerCase() : undefined;
      const maybeCommand =
        typeof config.command === "string"
          ? config.command
          : typeof config.executable === "string"
            ? config.executable
            : undefined;
      const maybeArgs = Array.isArray(config.args)
        ? config.args.filter((item): item is string => typeof item === "string")
        : undefined;
      const maybeEnv =
        config.env && typeof config.env === "object"
          ? Object.fromEntries(
              Object.entries(config.env as Record<string, unknown>).filter(
                (entry): entry is [string, string] => typeof entry[1] === "string"
              )
            )
          : undefined;
      const maybeCwdRaw = typeof config.cwd === "string" ? config.cwd : undefined;
      const maybeCwd = maybeCwdRaw
        ? path.isAbsolute(maybeCwdRaw)
          ? maybeCwdRaw
          : path.resolve(inferredRoot, maybeCwdRaw)
        : inferredRoot;
      const resolvedUrl =
        maybeUrl ?? (maybeType === "http" || maybeType === "sse" ? maybeEndpoint : undefined);
      const hasPlaceholder =
        hasUnresolvedInputPlaceholder(resolvedUrl) ||
        hasUnresolvedInputPlaceholder(maybeCommand) ||
        hasUnresolvedInputPlaceholder(maybeCwd) ||
        (maybeArgs ?? []).some((arg) => hasUnresolvedInputPlaceholder(arg)) ||
        Object.values(maybeEnv ?? {}).some((val) => hasUnresolvedInputPlaceholder(val));
      const transport: "http" | "sse" | "stdio" =
        maybeType === "sse"
          ? "sse"
          : resolvedUrl
        ? "http"
        : maybeType === "stdio" || maybeCommand
          ? "stdio"
          : "http";
      const supportedTransport =
        (transport === "stdio" ? Boolean(maybeCommand) : Boolean(resolvedUrl)) && !hasPlaceholder;

      return {
        id: `${name}-${path.basename(path.dirname(filePath))}`,
        name,
        url: resolvedUrl ?? "",
        command: maybeCommand,
        args: maybeArgs,
        env: maybeEnv,
        cwd: maybeCwd,
        transport,
        enabled: false,
        description: hasPlaceholder
          ? `Discovered from ${filePath} (contains unresolved input placeholders)`
          : `Discovered from ${filePath}`,
        source: filePath,
        discovered: true,
        supportedTransport,
      };
    });
  } catch {
    return [];
  }
}

function discoverServers(): DiscoveredServerConfig[] {
  const candidates = new Set<string>();
  const parentRoot = path.resolve(process.cwd(), "..", "..");
  if (fs.existsSync(parentRoot)) {
    for (const dirent of fs.readdirSync(parentRoot, { withFileTypes: true })) {
      if (dirent.isDirectory()) {
        candidates.add(path.join(parentRoot, dirent.name, ".vscode", "mcp.json"));
      }
    }
  }
  candidates.add(path.join(process.cwd(), "..", ".vscode", "mcp.json"));
  if (process.env.USERPROFILE) {
    candidates.add(path.join(process.env.USERPROFILE, ".vscode", "mcp.json"));
    candidates.add(path.join(process.env.USERPROFILE, ".copilot", "mcp-config.json"));
    candidates.add(
      path.join(process.env.USERPROFILE, "AppData", "Roaming", "Code", "User", "mcp.json")
    );
  }

  const discovered = Array.from(candidates).flatMap(parseMcpJsonServers);
  const dedup = new Map<string, DiscoveredServerConfig>();
  for (const server of discovered) {
    const key = `${server.name}|${server.url}|${server.source}`;
    dedup.set(key, server);
  }
  return Array.from(dedup.values());
}

function normalizeBaseUrl(baseUrl?: string) {
  return (baseUrl ?? "").trim().replace(/\/$/, "");
}

function readGhCliToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", ["auth", "token"], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = `${stderr ?? ""}`.trim();
        if ("code" in error && error.code === "ENOENT") {
          reject(
            new Error(
              "GitHub CLI is not installed. Install `gh` and run `gh auth login`, or switch to manual token mode."
            )
          );
          return;
        }
        reject(
          new Error(
            message
              ? `GitHub CLI authentication failed: ${message}`
              : "GitHub CLI authentication failed. Run `gh auth login` or switch to manual token mode."
          )
        );
        return;
      }
      const token = (stdout ?? "").trim();
      if (!token) {
        reject(
          new Error(
            "GitHub CLI is not authenticated. Run `gh auth login`, or switch to manual token mode."
          )
        );
        return;
      }
      resolve(token);
    });
  });
}

async function resolveProviderApiKey(provider: LlmRequestPayload["provider"]) {
  if (provider.type !== "github-models") {
    return provider.apiKey.trim();
  }
  if (provider.authMode === "gh-cli") {
    return readGhCliToken();
  }
  const key = provider.apiKey.trim();
  if (!key) {
    throw new Error("GitHub Models (manual mode) requires an API key.");
  }
  return key;
}

function providerEndpoint(payload: LlmRequestPayload, resolvedApiKey: string): string {
  const provider = payload.provider;
  if (provider.type === "github-models") {
    return "https://models.inference.ai.azure.com/chat/completions";
  }
  if (provider.type === "openai") {
    return "https://api.openai.com/v1/chat/completions";
  }
  if (provider.type === "anthropic") {
    return "https://api.anthropic.com/v1/messages";
  }
  if (provider.type === "google") {
    return `https://generativelanguage.googleapis.com/v1beta/models/${provider.model}:generateContent?key=${encodeURIComponent(resolvedApiKey)}`;
  }

  const customMode = provider.customMode === "direct-endpoint" ? "direct-endpoint" : "catalog";
  if (customMode === "direct-endpoint") {
    const endpoint = (provider.directEndpointUrl ?? "").trim();
    if (!endpoint) {
      throw new Error("Custom provider (Direct endpoint mode) requires an endpoint URL.");
    }
    return endpoint;
  }

  const base = normalizeBaseUrl(provider.baseUrl);
  if (!base) {
    throw new Error("Custom provider (Catalog mode) requires a base URL.");
  }
  if (/\/chat\/completions$/i.test(base)) return base;
  return `${base}/chat/completions`;
}

function providerAuthHeaders(
  provider: LlmRequestPayload["provider"],
  resolvedApiKey: string
): Record<string, string> {
  if (provider.type === "anthropic") {
    return {
      "x-api-key": resolvedApiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    };
  }
  if (provider.type === "google") {
    return { "Content-Type": "application/json" };
  }
  if (provider.type === "custom" && provider.customMode === "direct-endpoint") {
    if (provider.directAuthMode === "azure-api-key") {
      return {
        "Content-Type": "application/json",
        "api-key": resolvedApiKey,
      };
    }
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${resolvedApiKey}`,
    };
  }
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${resolvedApiKey}`,
  };
}

function providerChatBody(payload: LlmRequestPayload) {
  const normalizeModelForProvider = (providerType: LlmRequestPayload["provider"]["type"], model: string) => {
    if (providerType !== "github-models") return model;
    const trimmed = model.trim();
    if (!trimmed.includes("/")) return trimmed;
    return trimmed.split("/").pop() ?? trimmed;
  };

  if (payload.provider.type === "anthropic") {
    const userMessages = payload.messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content:
          typeof message.content === "string"
            ? [{ type: "text", text: message.content }]
            : message.content,
      }));
    return {
      model: normalizeModelForProvider(payload.provider.type, payload.provider.model),
      max_tokens: 2048,
      messages: userMessages,
    };
  }

  if (payload.provider.type === "google") {
    const joinedPrompt = payload.messages
      .map((message) =>
        `${String(message.role).toUpperCase()}: ${String(message.content ?? "")}`
      )
      .join("\n\n");
    return {
      contents: [{ role: "user", parts: [{ text: joinedPrompt }] }],
      generationConfig:
        payload.temperature !== undefined ? { temperature: payload.temperature } : undefined,
    };
  }

  return {
    model: normalizeModelForProvider(payload.provider.type, payload.provider.model),
    messages: payload.messages,
    tools: payload.tools,
    temperature: payload.temperature,
  };
}

function parseModelIds(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const source = payload as Record<string, unknown>;
  const candidates: string[] = [];
  const pushMaybeModel = (value: unknown) => {
    if (typeof value === "string" && value.trim()) {
      candidates.push(value.trim().replace(/^models\//, ""));
    }
  };

  const fromArray = (arr: unknown[]) => {
    for (const item of arr) {
      if (typeof item === "string") {
        pushMaybeModel(item);
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      pushMaybeModel(obj.id);
      pushMaybeModel(obj.model);
    }
  };

  if (Array.isArray(source.data)) fromArray(source.data);
  if (Array.isArray(source.models)) fromArray(source.models);
  if (Array.isArray(source.items)) fromArray(source.items);
  if (Array.isArray(source.modelIds)) fromArray(source.modelIds);
  if (Array.isArray(payload)) fromArray(payload as unknown[]);

  const unique = Array.from(new Set(candidates));
  const normalizeToken = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const canonicalTokens = new Set(
    unique.filter((value) => !/\s/.test(value)).map((value) => normalizeToken(value))
  );
  return unique
    .filter(
      (value) => !/\s/.test(value) || !canonicalTokens.has(normalizeToken(value))
    )
    .sort((a, b) => a.localeCompare(b));
}

async function fetchProviderModels(provider: z.infer<typeof providerSetupSchema>) {
  const resolvedApiKey = await resolveProviderApiKey(provider as LlmRequestPayload["provider"]);
  const headers = providerAuthHeaders(
    provider as LlmRequestPayload["provider"],
    resolvedApiKey
  );

  const request = async (url: string, overrideHeaders?: Record<string, string>) => {
    const response = await fetch(url, {
      method: "GET",
      headers: overrideHeaders ?? headers,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(`Model list request failed (${response.status}): ${text}`);
    }
    return JSON.parse(text) as unknown;
  };

  if (provider.type === "github-models") {
    const attempts = [
      "https://models.github.ai/catalog/models",
      "https://models.inference.ai.azure.com/models",
    ];
    for (const endpoint of attempts) {
      try {
        const json = await request(endpoint, {
          Authorization: `Bearer ${resolvedApiKey}`,
          "Content-Type": "application/json",
        });
        const models = parseModelIds(json)
          .map((model) => (model.includes("/") ? (model.split("/").pop() ?? model) : model))
          .map((model) => model.trim())
          .filter(Boolean);
        const uniqueModels = Array.from(new Set(models)).sort((a, b) => a.localeCompare(b));
        if (uniqueModels.length > 0) return uniqueModels;
      } catch {
        // try next endpoint
      }
    }
    throw new Error("Unable to load models from GitHub Models catalog.");
  }

  if (provider.type === "openai") {
    return parseModelIds(await request("https://api.openai.com/v1/models"));
  }

  if (provider.type === "anthropic") {
    return parseModelIds(await request("https://api.anthropic.com/v1/models"));
  }

  if (provider.type === "google") {
    return parseModelIds(
      await request(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(
          resolvedApiKey
        )}`,
        { "Content-Type": "application/json" }
      )
    );
  }

  const customMode = provider.customMode === "direct-endpoint" ? "direct-endpoint" : "catalog";
  if (customMode === "direct-endpoint") {
    const directModelName = (provider.directModelName ?? "").trim();
    if (!directModelName) {
      throw new Error("Direct endpoint mode requires a model/deployment name.");
    }
    return [directModelName];
  }

  const base = normalizeBaseUrl(provider.baseUrl);
  if (!base) throw new Error("Custom provider (Catalog mode) requires a base URL.");
  return parseModelIds(await request(`${base}/models`));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, name: "OpenChat server" });
});

app.post("/api/providers/models", async (req, res) => {
  const parsed = providerSetupSchema.safeParse(req.body?.provider);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const models = await fetchProviderModels(parsed.data);
    if (models.length === 0) {
      res.status(404).json({
        error:
          "No models were returned by the provider. Verify auth permissions and endpoint settings.",
      });
      return;
    }
    res.json({ models });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get("/api/discovery/servers", (_req, res) => {
  try {
    const servers = discoverServers();
    res.json({ servers });
  } catch (error) {
    res.json({
      servers: [],
      error:
        error instanceof Error
          ? error.message
          : "Discovery failed due to an unexpected local configuration error.",
    });
  }
});

app.get("/api/skills/libraries", (_req, res) => {
  res.json({
    libraries: BUILTIN_SKILL_LIBRARIES.map((library) => ({
      id: library.id,
      displayName: library.displayName,
      owner: library.owner,
      repo: library.repo,
      path: library.path,
    })),
  });
});

app.get("/api/skills/local", (_req, res) => {
  res.json({
    userGlobalPath: getSkillsDirectory("user-global"),
    projectLocalPath: getSkillsDirectory("project-local"),
    skills: listLocalSkills(),
  });
});

app.post("/api/skills/browse", async (req, res) => {
  const parsed = skillsBrowseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const library = resolveSkillLibrary(parsed.data.libraryId);
  if (!library) {
    res.status(404).json({ error: `Unknown skills library: ${parsed.data.libraryId}` });
    return;
  }

  try {
    const skills = await browseSkillLibrary(library);
    res.json({ library, skills });
  } catch (error) {
    res.status(400).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/skills/install", async (req, res) => {
  const parsed = skillsInstallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const library = resolveSkillLibrary(parsed.data.libraryId);
  if (!library) {
    res.status(404).json({ error: `Unknown skills library: ${parsed.data.libraryId}` });
    return;
  }

  try {
    const normalizedSkillPath = parsed.data.skillPath.replace(/^\/+/, "").replace(/\\/g, "/");
    const remoteSkillDir = normalizedSkillPath.toLowerCase().endsWith("/skill.md")
      ? path.posix.dirname(normalizedSkillPath)
      : normalizedSkillPath;
    const markdown = await fetchRemoteSkillMarkdown(
      library.owner,
      library.repo,
      `${remoteSkillDir}/SKILL.md`
    );
    const parsedSkill = parseSkillMarkdown(
      markdown,
      path.posix.basename(remoteSkillDir)
    );
    const slug = slugify(parsedSkill.name) || slugify(path.posix.basename(remoteSkillDir));
    if (!slug) throw new Error("Unable to derive a safe skill directory name.");

    const root = getSkillsDirectory(parsed.data.saveLocation);
    const skillDir = path.join(root, slug);
    const installedFiles = await installRemoteSkillDirectory(
      library.owner,
      library.repo,
      remoteSkillDir,
      skillDir
    );
    const filePath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(filePath)) {
      throw new Error("Installed skill is missing SKILL.md.");
    }

    res.json({
      ok: true,
      installedPath: filePath,
      installedFiles,
      location: parsed.data.saveLocation,
      skill: {
        id: slug,
        name: parsedSkill.name,
        description: parsedSkill.description,
        version: parsedSkill.version,
        tags: parsedSkill.tags,
      },
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/skills/create", (req, res) => {
  const parsed = skillsCreateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const name = parsed.data.name.trim();
    const slug = slugify(name);
    if (!slug) {
      res.status(400).json({ error: "Skill name must include letters or numbers." });
      return;
    }
    const description = parsed.data.description?.trim() || "Custom OpenChat skill.";
    const instructions =
      parsed.data.instructions?.trim() ||
      "Describe when to use this skill, what inputs it expects, and the output format.";
    const markdown = buildSkillMarkdown(name, description, instructions);

    const root = getSkillsDirectory(parsed.data.saveLocation);
    const skillDir = path.join(root, slug);
    fs.mkdirSync(skillDir, { recursive: true });
    const filePath = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(filePath, markdown, "utf8");

    res.json({
      ok: true,
      location: parsed.data.saveLocation,
      createdPath: filePath,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/skills/update", (req, res) => {
  const parsed = skillsUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  try {
    const { resolvedDir } = resolveLocalSkillDirectory(parsed.data.location, parsed.data.directory);
    const skillFile = path.join(resolvedDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      res.status(404).json({ error: "Skill file not found." });
      return;
    }
    const existingContent = fs.readFileSync(skillFile, "utf8");
    const existing = parseSkillMarkdown(existingContent, path.basename(resolvedDir));
    const name = parsed.data.name.trim();
    const description = parsed.data.description?.trim() || "Custom OpenChat skill.";
    const instructions =
      parsed.data.instructions?.trim() ||
      "Describe when to use this skill, what inputs it expects, and the output format.";
    const markdown = buildSkillMarkdown(
      name,
      description,
      instructions,
      existing.version,
      existing.tags
    );
    fs.writeFileSync(skillFile, markdown, "utf8");
    res.json({
      ok: true,
      location: parsed.data.location,
      updatedPath: skillFile,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/skills/remove", (req, res) => {
  const parsed = skillsRemoveSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  try {
    const { resolvedDir } = resolveLocalSkillDirectory(parsed.data.location, parsed.data.directory);
    const skillFile = path.join(resolvedDir, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      res.status(404).json({ error: "Skill file not found." });
      return;
    }
    fs.rmSync(resolvedDir, { recursive: true, force: true });
    res.json({
      ok: true,
      location: parsed.data.location,
      removedPath: resolvedDir,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/servers/test", async (req, res) => {
  const parsed = serverTestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const transportType = parsed.data.transport ?? (parsed.data.command ? "stdio" : "http");
  const headers = parsed.data.authToken
    ? { Authorization: `Bearer ${parsed.data.authToken}` }
    : undefined;
  let transport: StreamableHTTPClientTransport | SSEClientTransport | StdioClientTransport | null = null;
  let client: Client | null = null;
  const fallbackCwd = process.env.INIT_CWD ?? path.resolve(process.cwd(), "..");

  try {
    if (transportType === "http") {
      transport = new StreamableHTTPClientTransport(new URL(parsed.data.url!), {
        requestInit: headers ? { headers } : undefined,
      });
    } else if (transportType === "sse") {
      transport = new SSEClientTransport(new URL(parsed.data.url!), {
        requestInit: headers ? { headers } : undefined,
      });
    } else {
      transport = new StdioClientTransport({
        command: parsed.data.command!,
        args: parsed.data.args,
        env: parsed.data.env,
        cwd: parsed.data.cwd ?? fallbackCwd,
      });
    }
    client = new Client({ name: "OpenChat", version: "0.1.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    res.json({
      ok: true,
      transport: transportType,
      toolCount: tools.tools.length,
      tools: tools.tools,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await client?.close();
    } catch {
      // no-op
    }
    try {
      await transport?.close();
    } catch {
      // no-op
    }
  }
});

app.post("/api/servers/call-stdio", async (req, res) => {
  const parsed = stdioCallSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const transportType =
    parsed.data.server.transport ?? (parsed.data.server.command ? "stdio" : "http");
  if (transportType !== "stdio") {
    res.status(400).json({ error: "This endpoint only supports stdio servers." });
    return;
  }

  let transport: StdioClientTransport | null = null;
  let client: Client | null = null;
  const fallbackCwd = process.env.INIT_CWD ?? path.resolve(process.cwd(), "..");
  try {
    transport = new StdioClientTransport({
      command: parsed.data.server.command!,
      args: parsed.data.server.args,
      env: parsed.data.server.env,
      cwd: parsed.data.server.cwd ?? fallbackCwd,
    });
    client = new Client({ name: "OpenChat", version: "0.1.0" });
    await client.connect(transport);

    const toolResult = await client.callTool({
      name: parsed.data.toolName,
      arguments: parsed.data.args ?? {},
    });

    let uiHtml: string | undefined;
    if (parsed.data.resourceUri) {
      try {
        const resource = await client.readResource({ uri: parsed.data.resourceUri });
        const content = resource.contents?.[0];
        if (content && "text" in content) {
          uiHtml = content.text;
        }
      } catch {
        // UI resources are optional.
      }
    }

    res.json({ ok: true, toolResult, uiHtml });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    try {
      await client?.close();
    } catch {
      // no-op
    }
    try {
      await transport?.close();
    } catch {
      // no-op
    }
  }
});

app.post("/api/local/write-file", (req, res) => {
  const parsed = localWriteFileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: parsed.error.flatten() });
    return;
  }

  try {
    const { resolved, relativeToOutputRoot, outputRoot } = resolveOutputFilePath(
      parsed.data.relativePath,
      parsed.data.outputDirectory
    );
    const shouldOverwrite = parsed.data.overwrite ?? true;
    const isExcalidraw = path.extname(relativeToOutputRoot).toLowerCase() === ".excalidraw";
    let contentToWrite = parsed.data.content;
    let normalized = false;
    let normalizationNote: string | undefined;
    if (isExcalidraw) {
      try {
        const normalizedContent = normalizeExcalidrawContent(parsed.data.content);
        normalized = normalizedContent.trim() !== parsed.data.content.trim();
        contentToWrite = normalizedContent;
        if (normalized) {
          normalizationNote = "Normalized Excalidraw content for compatibility.";
        }
      } catch (error) {
        normalizationNote = `Saved original content. Excalidraw normalization skipped: ${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }

    // Fix mismatched file extensions: .txt with markdown content → .md
    const ext = path.extname(resolved).toLowerCase();
    let correctedResolved = resolved;
    let correctedRelative = relativeToOutputRoot;
    if (ext === ".txt") {
      const trimmed = contentToWrite.trim();
      const looksLikeMarkdown =
        /^#{1,6}\s/m.test(trimmed) ||
        /^\s*[-*+]\s/m.test(trimmed) ||
        /\[.+?\]\(.+?\)/.test(trimmed) ||
        /^\s*```/m.test(trimmed) ||
        /\*\*.+?\*\*/.test(trimmed);
      if (looksLikeMarkdown) {
        correctedResolved = resolved.replace(/\.txt$/i, ".md");
        correctedRelative = relativeToOutputRoot.replace(/\.txt$/i, ".md");
        normalizationNote = (normalizationNote ? normalizationNote + " " : "") +
          "Renamed .txt → .md (content is markdown).";
      }
    }

    if (!shouldOverwrite && fs.existsSync(correctedResolved)) {
      res.status(409).json({
        ok: false,
        error: `File already exists: ${correctedRelative}`,
      });
      return;
    }
    fs.mkdirSync(path.dirname(correctedResolved), { recursive: true });
    fs.writeFileSync(correctedResolved, contentToWrite, "utf8");
    const bytes = Buffer.byteLength(contentToWrite, "utf8");
    res.json({
      ok: true,
      relativePath: correctedRelative.replace(/\\/g, "/"),
      path: correctedResolved,
      outputRoot,
      bytes,
      normalized,
      normalizationNote,
    });
  } catch (error) {
    res.status(400).json({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/desktop/choose-output-folder", async (req, res) => {
  const parsed = desktopChooseFolderSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }
  if (!desktopFolderPicker) {
    res.status(501).json({
      error: "Desktop folder picker is unavailable in this runtime.",
    });
    return;
  }
  try {
    const selectedPath = await desktopFolderPicker(parsed.data.initialPath);
    res.json({ path: selectedPath });
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post("/api/llm/chat", async (req, res) => {
  const parsed = llmBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.flatten() });
    return;
  }

  const payload = parsed.data;
  try {
    const resolvedApiKey = await resolveProviderApiKey(payload.provider);
    const endpoint = providerEndpoint(payload, resolvedApiKey);
    const upstream = await fetch(endpoint, {
      method: "POST",
      headers: providerAuthHeaders(payload.provider, resolvedApiKey),
      body: JSON.stringify(providerChatBody(payload)),
    });

    const bodyText = await upstream.text();
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: bodyText });
      return;
    }

    if (payload.provider.type === "anthropic") {
      const json = JSON.parse(bodyText) as {
        content?: Array<{ type?: string; text?: string }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (json.content ?? [])
        .filter((item) => item.type === "text")
        .map((item) => item.text ?? "")
        .join("\n");
      const promptTokens =
        typeof json.usage?.input_tokens === "number" ? json.usage.input_tokens : undefined;
      const completionTokens =
        typeof json.usage?.output_tokens === "number" ? json.usage.output_tokens : undefined;
      res.json({
        choices: [{ message: { content: text, tool_calls: [] } }],
        usage:
          promptTokens === undefined && completionTokens === undefined
            ? undefined
            : {
                prompt_tokens: promptTokens ?? 0,
                completion_tokens: completionTokens ?? 0,
                total_tokens: (promptTokens ?? 0) + (completionTokens ?? 0),
              },
      });
      return;
    }

    if (payload.provider.type === "google") {
      const json = JSON.parse(bodyText) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: {
          promptTokenCount?: number;
          candidatesTokenCount?: number;
          totalTokenCount?: number;
        };
      };
      const text =
        json.candidates?.[0]?.content?.parts
          ?.map((part) => part.text ?? "")
          .join("\n") ?? "";
      const promptTokens =
        typeof json.usageMetadata?.promptTokenCount === "number"
          ? json.usageMetadata.promptTokenCount
          : undefined;
      const completionTokens =
        typeof json.usageMetadata?.candidatesTokenCount === "number"
          ? json.usageMetadata.candidatesTokenCount
          : undefined;
      const totalTokens =
        typeof json.usageMetadata?.totalTokenCount === "number"
          ? json.usageMetadata.totalTokenCount
          : undefined;
      res.json({
        choices: [{ message: { content: text, tool_calls: [] } }],
        usage:
          promptTokens === undefined && completionTokens === undefined && totalTokens === undefined
            ? undefined
            : {
                prompt_tokens: promptTokens ?? 0,
                completion_tokens: completionTokens ?? 0,
                total_tokens: totalTokens ?? (promptTokens ?? 0) + (completionTokens ?? 0),
              },
      });
      return;
    }

    const contentType = upstream.headers.get("content-type") ?? "application/json";
    res.status(200).type(contentType).send(bodyText);
  } catch (error) {
    res.status(502).json({
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  // eslint-disable-next-line no-console
  console.error("Unhandled API error:", error);
  res.status(500).json({
    error: error instanceof Error ? error.message : "Unexpected server error.",
  });
});

export function createOpenChatApp() {
  return app;
}

export function setDesktopFolderPicker(handler: DesktopFolderPicker | null) {
  desktopFolderPicker = handler;
}

export function startOpenChatServer(port = defaultPort, host = "127.0.0.1"): Promise<Server> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      reject(error);
    };
    const server = app.listen(port, host, () => {
      server.off("error", onError);
      const address = server.address();
      const resolvedPort =
        typeof address === "object" && address && "port" in address ? Number(address.port) : port;
      // eslint-disable-next-line no-console
      console.log(`OpenChat server listening on http://localhost:${resolvedPort}`);
      resolve(server);
    });
    server.once("error", onError);
  });
}

const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : "";
const isDirectRun = entryFile === fileURLToPath(import.meta.url);

if (isDirectRun) {
  void startOpenChatServer();
}


