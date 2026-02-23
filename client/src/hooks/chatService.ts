import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ProviderConfig, XRayEvent } from "../types";
import { apiFetch } from "../lib/api";

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface LlmMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

interface LlmResponse {
  choices: Array<{
    message: { content: string | null; tool_calls?: ToolCall[] };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export interface ToolCallResult {
  text: string;
  serverName: string;
  toolName: string;
  args: Record<string, unknown>;
  resultSummary: string;
  rawResult: string;
  uiMeta?: {
    uiHtml: string;
    toolResult: CallToolResult;
    interactive?: boolean;
  };
}

interface LocalSkillContext {
  id: string;
  name: string;
  description: string;
  tags: string[];
  instructions: string;
  location: "user-global" | "project-local";
}

interface SkillSelectionResult {
  selectedSkills: LocalSkillContext[];
  selectionMethodBySkillId: Record<string, "score" | "fallback">;
  scoreBySkillId: Record<string, number>;
}

function toOpenAiTools(tools: Tool[]) {
  const aliasBySanitized = new Map<string, string>();
  const openAiTools = tools.map((tool, index) => {
    const base =
      tool.name.replace(/[^a-zA-Z0-9_-]/g, "_").replace(/^_+|_+$/g, "") ||
      `tool_${index + 1}`;
    let sanitized = base;
    let suffix = 2;
    while (
      aliasBySanitized.has(sanitized) &&
      aliasBySanitized.get(sanitized) !== tool.name
    ) {
      sanitized = `${base}_${suffix}`;
      suffix += 1;
    }
    aliasBySanitized.set(sanitized, tool.name);

    return {
      type: "function" as const,
      function: {
        name: sanitized,
        description: tool.description ?? "",
        parameters: tool.inputSchema ?? { type: "object", properties: {} },
      },
    };
  });

  return { openAiTools, aliasBySanitized };
}

function summarizeReason(toolName: string) {
  return `The AI selected "${toolName}" because it provides the exact server data needed for this step.`;
}

function parseArgs(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function isSmallTalkPrompt(prompt: string) {
  const text = prompt.trim().toLowerCase();
  if (!text) return false;
  const directMatches = [
    "hi",
    "hello",
    "hey",
    "how are you",
    "how are you?",
    "good morning",
    "good afternoon",
    "good evening",
    "thanks",
    "thank you",
  ];
  if (directMatches.includes(text)) return true;
  return /^(hi|hello|hey)\b/.test(text) || /how are you/.test(text);
}

function isFileOutputRequestPrompt(prompt: string) {
  const text = prompt.toLowerCase();
  if (!text.trim()) return false;
  const fileHint =
    /\.[a-z0-9]{2,12}\b/.test(text) ||
    /\b(markdown|md|report|file|document|excalidraw|json|csv|yaml|yml|xml|txt)\b/.test(text);
  const actionHint = /\b(create|write|save|export|generate|output|produce)\b/.test(text);
  const targetHint =
    /\b(to|as|into)\s+(a\s+)?(file|document)\b/.test(text) ||
    /\bsave it\b/.test(text) ||
    /\bwrite it\b/.test(text);
  return fileHint && (actionHint || targetHint);
}

function isShortAffirmativePrompt(prompt: string) {
  const normalized = prompt.trim().toLowerCase().replace(/[.!?]+$/g, "");
  if (!normalized) return false;
  return [
    "yes",
    "y",
    "yeah",
    "yep",
    "sure",
    "ok",
    "okay",
    "yes please",
    "please do",
    "do it",
    "go ahead",
  ].includes(normalized);
}

function didAssistantAskToSaveFile(history: LlmMessage[]) {
  const lastAssistant = [...history].reverse().find((message) => message.role === "assistant");
  if (!lastAssistant?.content) return false;
  const text = lastAssistant.content.toLowerCase();
  const saveHint = /\b(save|write|export)\b/.test(text);
  const fileHint = /\b(file|artifact|report|markdown|\.md|\.txt|document)\b/.test(text);
  const askHint = /\?|\b(would you like|want me to|should i)\b/.test(text);
  return saveHint && fileHint && askHint;
}

function isFileSaveConfirmationFollowUp(prompt: string, history: LlmMessage[]) {
  return isShortAffirmativePrompt(prompt) && didAssistantAskToSaveFile(history);
}

function normalizeToken(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

const SKILL_MATCH_STOPWORDS = new Set([
  "skill",
  "skills",
  "creator",
  "create",
  "assistant",
  "openchat",
  "copilot",
  "microsoft",
  "github",
]);

function extractSkillMatchTokens(value: string) {
  return normalizeToken(value)
    .split(" ")
    .filter((token) => token.length >= 3 && !SKILL_MATCH_STOPWORDS.has(token));
}

function selectPromptSkills(prompt: string, skills: LocalSkillContext[]): SkillSelectionResult {
  const selectionMethodBySkillId: Record<string, "score" | "fallback"> = {};
  const scoreBySkillId: Record<string, number> = {};
  const promptLower = prompt.toLowerCase();
  const normalizedPrompt = ` ${normalizeToken(prompt)} `;
  let bestSkill: LocalSkillContext | null = null;
  let bestScore = 0;

  for (const skill of skills) {
    const trimmedName = skill.name.trim();
    const lowerName = trimmedName.toLowerCase();
    const idToken = normalizeToken(skill.id);
    let score = 0;

    if (trimmedName && promptLower.includes(lowerName)) {
      score += 1000;
    }
    if (idToken && normalizedPrompt.includes(` ${idToken} `)) {
      score += 900;
    }
    if (trimmedName) {
      const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const useRegex = new RegExp(`\\buse\\s+(?:the\\s+)?${escaped}\\b`, "i");
      if (useRegex.test(prompt)) {
        score += 1200;
      }
    }

    const nameTokens = extractSkillMatchTokens(skill.name);
    const matchedNameTokens = nameTokens.filter((token) =>
      normalizedPrompt.includes(` ${token} `)
    ).length;
    score += matchedNameTokens * 120;
    if (nameTokens.length > 0 && matchedNameTokens === nameTokens.length) {
      score += 300;
    }

    const matchedTagTokens = skill.tags
      .flatMap((tag) => extractSkillMatchTokens(tag))
      .filter((token) => normalizedPrompt.includes(` ${token} `)).length;
    score += matchedTagTokens * 40;
    scoreBySkillId[skill.id] = score;

    if (
      score > bestScore ||
      (score === bestScore && bestSkill && skill.name.length > bestSkill.name.length)
    ) {
      bestSkill = skill;
      bestScore = score;
    }
  }

  if (bestSkill && bestScore >= 300) {
    selectionMethodBySkillId[bestSkill.id] = "score";
    return {
      selectedSkills: [bestSkill],
      selectionMethodBySkillId,
      scoreBySkillId,
    };
  }

  // Fallback: if the prompt includes a token that uniquely maps to one skill, use it.
  const promptTokens = new Set(extractSkillMatchTokens(prompt));
  if (promptTokens.size === 0) {
    return {
      selectedSkills: [],
      selectionMethodBySkillId,
      scoreBySkillId,
    };
  }
  const tokenToSkillCount = new Map<string, number>();
  const skillToUniqueHits = new Map<string, number>();

  for (const skill of skills) {
    const skillTokens = new Set([
      ...extractSkillMatchTokens(skill.name),
      ...extractSkillMatchTokens(skill.id),
      ...skill.tags.flatMap((tag) => extractSkillMatchTokens(tag)),
    ]);
    for (const token of skillTokens) {
      tokenToSkillCount.set(token, (tokenToSkillCount.get(token) ?? 0) + 1);
    }
  }

  for (const skill of skills) {
    const skillTokens = new Set([
      ...extractSkillMatchTokens(skill.name),
      ...extractSkillMatchTokens(skill.id),
      ...skill.tags.flatMap((tag) => extractSkillMatchTokens(tag)),
    ]);
    let uniqueHits = 0;
    for (const token of skillTokens) {
      if (promptTokens.has(token) && tokenToSkillCount.get(token) === 1) {
        uniqueHits += 1;
      }
    }
    skillToUniqueHits.set(skill.id, uniqueHits);
  }

  const fallback = skills
    .map((skill) => ({ skill, hits: skillToUniqueHits.get(skill.id) ?? 0 }))
    .sort((a, b) => b.hits - a.hits)[0];

  if (fallback && fallback.hits > 0) {
    selectionMethodBySkillId[fallback.skill.id] = "fallback";
    scoreBySkillId[fallback.skill.id] = Math.max(scoreBySkillId[fallback.skill.id] ?? 0, fallback.hits * 100);
    return {
      selectedSkills: [fallback.skill],
      selectionMethodBySkillId,
      scoreBySkillId,
    };
  }

  return {
    selectedSkills: [],
    selectionMethodBySkillId,
    scoreBySkillId,
  };
}

function buildSkillSelectionInsight(
  prompt: string,
  skill: LocalSkillContext,
  skills: LocalSkillContext[],
  selectionMethod: "score" | "fallback" | undefined,
  matchScore: number | undefined
) {
  const promptLower = prompt.toLowerCase();
  const normalizedPrompt = ` ${normalizeToken(prompt)} `;
  const trimmedName = skill.name.trim();
  const lowerName = trimmedName.toLowerCase();
  const idToken = normalizeToken(skill.id);
  const escaped = trimmedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const useRegex = new RegExp(`\\buse\\s+(?:the\\s+)?${escaped}\\b`, "i");
  const explicitUsePhrase = trimmedName.length > 0 && useRegex.test(prompt);
  const directNameMention = trimmedName.length > 0 && promptLower.includes(lowerName);
  const idTokenMatch = idToken.length > 0 && normalizedPrompt.includes(` ${idToken} `);
  const matchedNameTokens = extractSkillMatchTokens(skill.name).filter((token) =>
    normalizedPrompt.includes(` ${token} `)
  );
  const matchedTagTokens = Array.from(
    new Set(
      skill.tags
        .flatMap((tag) => extractSkillMatchTokens(tag))
        .filter((token) => normalizedPrompt.includes(` ${token} `))
    )
  );

  const promptTokens = new Set(extractSkillMatchTokens(prompt));
  const tokenToSkillCount = new Map<string, number>();
  for (const candidate of skills) {
    const skillTokens = new Set([
      ...extractSkillMatchTokens(candidate.name),
      ...extractSkillMatchTokens(candidate.id),
      ...candidate.tags.flatMap((tag) => extractSkillMatchTokens(tag)),
    ]);
    for (const token of skillTokens) {
      tokenToSkillCount.set(token, (tokenToSkillCount.get(token) ?? 0) + 1);
    }
  }
  const uniquePromptTokens = Array.from(
    new Set([
      ...extractSkillMatchTokens(skill.name),
      ...extractSkillMatchTokens(skill.id),
      ...skill.tags.flatMap((tag) => extractSkillMatchTokens(tag)),
    ])
  ).filter((token) => promptTokens.has(token) && tokenToSkillCount.get(token) === 1);

  const reasonParts: string[] = [];
  if (explicitUsePhrase) reasonParts.push(`Prompt explicitly asked to use "${skill.name}".`);
  else if (directNameMention) reasonParts.push(`Prompt directly mentioned "${skill.name}".`);
  if (idTokenMatch) reasonParts.push(`Prompt matched skill id token "${skill.id}".`);
  if (matchedNameTokens.length > 0) {
    reasonParts.push(`Matched skill name keywords: ${matchedNameTokens.join(", ")}.`);
  }
  if (matchedTagTokens.length > 0) {
    reasonParts.push(`Matched skill tags: ${matchedTagTokens.join(", ")}.`);
  }
  if (uniquePromptTokens.length > 0) {
    reasonParts.push(`Unique prompt keywords for this skill: ${uniquePromptTokens.join(", ")}.`);
  }
  if (reasonParts.length === 0) {
    reasonParts.push("Best heuristic match across installed skill names and tags.");
  }

  const description = (skill.description ?? "").trim();
  const intendedUse =
    description.length > 0
      ? description
      : `Apply "${skill.name}" instructions to help complete this request.`;
  const requestIntent = prompt.trim().replace(/\s+/g, " ");
  const promptSnippet =
    requestIntent.length > 160 ? `${requestIntent.slice(0, 157)}...` : requestIntent || "(empty prompt)";
  const methodLabel =
    selectionMethod === "fallback" ? "fallback unique-token match" : "primary scoring match";

  const rawDetail = [
    `Selection method: ${methodLabel}`,
    `Match score: ${matchScore ?? 0}`,
    `Why selected: ${reasonParts.join(" ")}`,
    `Intended use: ${intendedUse}`,
    `Prompt context: ${promptSnippet}`,
    `Skill location: ${skill.location}`,
    `Skill tags: ${skill.tags.length > 0 ? skill.tags.join(", ") : "(none)"}`,
  ].join("\n");

  return {
    reason: reasonParts.join(" "),
    intendedUse,
    rawDetail,
  };
}

function buildSkillsSystemInstruction(selectedSkills: LocalSkillContext[]) {
  if (selectedSkills.length === 0) return "";
  const blocks = selectedSkills.map((skill) => {
    const instructions = (skill.instructions ?? "").trim() || "No instructions provided.";
    return `Skill: ${skill.name}\nDescription: ${skill.description}\nInstructions:\n${instructions}`;
  });
  return (
    "Apply the selected skill instructions below for this response. " +
    "If a skill requires tools that are unavailable, say so explicitly and do not claim you executed them.\n\n" +
    blocks.join("\n\n---\n\n")
  );
}

function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a.localeCompare(b)
  );
  return `{${entries.map(([key, val]) => `${JSON.stringify(key)}:${stableStringify(val)}`).join(",")}}`;
}

const MAX_REQUEST_HISTORY_MESSAGES = 10;
const MAX_RETURN_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CONTENT_CHARS = 1600;
const MAX_SAME_TOOL_CALLS_PER_TURN = 3;
const LOCAL_WRITE_FILE_TOOL_NAME = "openchat_write_local_file";

function truncateContent(content: string, maxChars = MAX_MESSAGE_CONTENT_CHARS) {
  if (content.length <= maxChars) return content;
  return `${content.slice(0, maxChars)}\n...[truncated]`;
}

function compactMessage(message: LlmMessage): LlmMessage {
  return { ...message, content: truncateContent(message.content) };
}

function canonicalizeArgsForDedup(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalizeArgsForDedup(item));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [key, canonicalizeArgsForDedup(item)])
    );
  }
  if (typeof value === "string") {
    return value.trim().replace(/\s+/g, " ");
  }
  return value;
}

function sanitizeToolMessageSequence(messages: LlmMessage[]) {
  const sanitized: LlmMessage[] = [];
  let pendingToolCallIds: Set<string> | null = null;

  for (const message of messages) {
    if (message.role === "assistant") {
      const toolCalls = message.tool_calls ?? [];
      pendingToolCallIds =
        toolCalls.length > 0
          ? new Set(
              toolCalls
                .map((toolCall) => toolCall.id)
                .filter((id): id is string => typeof id === "string" && id.length > 0)
            )
          : null;
      sanitized.push(message);
      continue;
    }

    if (message.role === "tool") {
      if (!pendingToolCallIds || pendingToolCallIds.size === 0) {
        continue;
      }
      if (message.tool_call_id && !pendingToolCallIds.has(message.tool_call_id)) {
        continue;
      }
      if (message.tool_call_id) {
        pendingToolCallIds.delete(message.tool_call_id);
      }
      sanitized.push(message);
      continue;
    }

    pendingToolCallIds = null;
    sanitized.push(message);
  }

  return sanitized;
}

function buildRequestMessages(messages: LlmMessage[]): LlmMessage[] {
  const system = messages.find((message) => message.role === "system");
  const nonSystem = messages.filter((message) => message.role !== "system");
  const recent = sanitizeToolMessageSequence(
    nonSystem.slice(-MAX_REQUEST_HISTORY_MESSAGES).map((message, index, list) =>
    index >= list.length - 4 ? message : compactMessage(message)
    )
  );
  return system ? [compactMessage(system), ...recent] : recent;
}

function buildRetryRequestMessages(requestMessages: LlmMessage[]) {
  const system = requestMessages.find((message) => message.role === "system");
  const nonSystem = requestMessages.filter((message) => message.role !== "system");
  const maxNonSystem = system ? 5 : 6;
  const trimmed = sanitizeToolMessageSequence(nonSystem.slice(-maxNonSystem));
  return system ? [system, ...trimmed] : trimmed;
}

function buildPersistedHistory(messages: LlmMessage[]): LlmMessage[] {
  return messages.slice(-MAX_RETURN_HISTORY_MESSAGES).map(compactMessage);
}

function estimateRequestChars(messages: LlmMessage[], toolSchemaChars: number, includeTools: boolean) {
  const messageChars = messages.reduce((sum, message) => sum + message.content.length, 0);
  const toolsChars = includeTools ? toolSchemaChars : 0;
  return {
    messageChars,
    toolsChars,
    totalChars: messageChars + toolsChars,
  };
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function bytesForText(value: string) {
  return new TextEncoder().encode(value).length;
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatElapsedMs(value: number) {
  if (value < 1000) return `${value}ms`;
  return `${(value / 1000).toFixed(2)}s`;
}

function extractRateLimitMessage(raw: string): string | undefined {
  const messages = new Set<string>();
  const seen = new Set<unknown>();
  const collect = (value: unknown, depth = 0) => {
    if (value === null || value === undefined || depth > 4 || seen.has(value)) return;
    seen.add(value);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return;
      messages.add(trimmed);
      if ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) {
        try {
          collect(JSON.parse(trimmed), depth + 1);
        } catch {
          // ignore parse errors
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) collect(item, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (["error", "message", "details", "detail", "code"].includes(key.toLowerCase())) {
          collect(item, depth + 1);
        }
      }
      for (const item of Object.values(value as Record<string, unknown>)) {
        collect(item, depth + 1);
      }
    }
  };

  collect(raw);
  const ranked = Array.from(messages);
  return (
    ranked.find((message) => /rate limit|too many requests|429/i.test(message)) ??
    ranked[0]
  );
}

function extractRateLimitWaitSeconds(raw: string, response: Response) {
  const headerWait = response.headers.get("retry-after");
  if (headerWait) {
    const asInt = Number.parseInt(headerWait, 10);
    if (!Number.isNaN(asInt) && asInt > 0) return asInt;
  }

  const detail = extractRateLimitMessage(raw) ?? raw;
  const waitMatch =
    detail.match(/wait\s+(\d+)\s*seconds?/i) ??
    detail.match(/retry\s+(?:after|in)\s+(\d+)\s*seconds?/i);
  if (waitMatch) {
    const asInt = Number.parseInt(waitMatch[1], 10);
    if (!Number.isNaN(asInt) && asInt > 0) return asInt;
  }
  return undefined;
}

export async function runChat(params: {
  prompt: string;
  provider: ProviderConfig;
  tools: Tool[];
  localTools: Tool[];
  skills: LocalSkillContext[];
  history: LlmMessage[];
  callTool: (aliasName: string, args: Record<string, unknown>) => Promise<ToolCallResult>;
  onXRayEvent: (event: XRayEvent) => void;
}): Promise<{ finalText: string; updatedHistory: LlmMessage[]; lastUi?: ToolCallResult["uiMeta"] & { toolAlias: string; toolArgs: Record<string, unknown>; toolName: string; serverName: string } }> {
  const MAX_ROUNDS = 6;
  const runStartedAt = Date.now();
  let lastEventTime = Date.now();
  const duplicateToolCalls = new Set<string>();
  const toolCallCounts = new Map<string, number>();
  let lastUi:
    | (ToolCallResult["uiMeta"] & {
        toolAlias: string;
        toolArgs: Record<string, unknown>;
        toolName: string;
        serverName: string;
      })
    | undefined;

  const emit = (event: Omit<XRayEvent, "timestamp" | "durationMs">) => {
    const now = Date.now();
    params.onXRayEvent({ ...event, timestamp: now, durationMs: now - lastEventTime });
    lastEventTime = now;
  };

  const runStats = {
    rounds: 0,
    llmRequests: 0,
    llmRetries: 0,
    rateLimitRetries: 0,
    tokenRecoveryRetries: 0,
    skillsUsed: 0,
    toolCallsRequested: 0,
    toolCallsExecuted: 0,
    toolCallFailures: 0,
    duplicateBlocks: 0,
    budgetBlocks: 0,
    bytesSent: 0,
    bytesReceived: 0,
    llmBytesSent: 0,
    llmBytesReceived: 0,
    toolBytesSent: 0,
    toolBytesReceived: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    usageResponses: 0,
    selectedSkillNames: [] as string[],
  };
  const touchedTools = new Set<string>();
  const touchedServers = new Set<string>();
  const emitRunStats = (outcome: "success" | "max_rounds" | "error", errorMessage?: string) => {
    const elapsedMs = Math.max(Date.now() - runStartedAt, 0);
    const retryCount = runStats.llmRetries;
    const summary = [
      `Total ${formatElapsedMs(elapsedMs)}`,
      `${runStats.toolCallsExecuted} tool calls`,
      `${runStats.skillsUsed} skills`,
      `${retryCount} retries`,
    ].join(" · ");
    const detail = [
      `Outcome: ${outcome}`,
      `Total time: ${elapsedMs}ms (${formatElapsedMs(elapsedMs)})`,
      `Rounds: ${runStats.rounds}`,
      `LLM requests: ${runStats.llmRequests}`,
      `Retries handled: ${retryCount} (rate-limit: ${runStats.rateLimitRetries}, token-recovery: ${runStats.tokenRecoveryRetries})`,
      `Tool calls requested: ${runStats.toolCallsRequested}`,
      `Tool calls executed: ${runStats.toolCallsExecuted}`,
      `Tool call failures: ${runStats.toolCallFailures}`,
      `Duplicate tool calls blocked: ${runStats.duplicateBlocks}`,
      `Tool budget blocks: ${runStats.budgetBlocks}`,
      `Skills used: ${runStats.skillsUsed}${
        runStats.selectedSkillNames.length > 0
          ? ` (${runStats.selectedSkillNames.join(", ")})`
          : ""
      }`,
      `Unique tools touched: ${touchedTools.size}${touchedTools.size > 0 ? ` (${Array.from(touchedTools).join(", ")})` : ""}`,
      `Unique servers touched: ${touchedServers.size}${touchedServers.size > 0 ? ` (${Array.from(touchedServers).join(", ")})` : ""}`,
      `Bytes sent: ${runStats.bytesSent} (${formatBytes(runStats.bytesSent)})`,
      `Bytes received: ${runStats.bytesReceived} (${formatBytes(runStats.bytesReceived)})`,
      `LLM bytes sent: ${runStats.llmBytesSent} (${formatBytes(runStats.llmBytesSent)})`,
      `LLM bytes received: ${runStats.llmBytesReceived} (${formatBytes(runStats.llmBytesReceived)})`,
      `Tool bytes sent: ${runStats.toolBytesSent} (${formatBytes(runStats.toolBytesSent)})`,
      `Tool bytes received: ${runStats.toolBytesReceived} (${formatBytes(runStats.toolBytesReceived)})`,
      `Tokens in (prompt): ${runStats.promptTokens}`,
      `Tokens out (completion): ${runStats.completionTokens}`,
      `Tokens total: ${runStats.totalTokens}`,
      `Token usage reports: ${runStats.usageResponses}`,
    ];
    if (errorMessage) detail.push(`Error: ${errorMessage}`);
    emit({
      type: "run_stats",
      label: "Run Stats",
      summary,
      resultSummary: `Prompt tokens ${runStats.promptTokens} · Completion tokens ${runStats.completionTokens}`,
      rawDetail: detail.join("\n"),
    });
  };

  const skillSelection = selectPromptSkills(params.prompt, params.skills);
  const selectedSkills = skillSelection.selectedSkills;
  runStats.skillsUsed = selectedSkills.length;
  runStats.selectedSkillNames = selectedSkills.map((skill) => skill.name);
  const skillInstructionBlock = buildSkillsSystemInstruction(selectedSkills);
  const explicitFileOutputRequest =
    isFileOutputRequestPrompt(params.prompt) ||
    isFileSaveConfirmationFollowUp(params.prompt, params.history);
  const shouldExposeLocalTools = selectedSkills.length > 0 || explicitFileOutputRequest;
  const executableTools = shouldExposeLocalTools ? [...params.tools, ...params.localTools] : params.tools;
  const noExecutableToolsForSkills = selectedSkills.length > 0 && executableTools.length === 0;
  const messages: LlmMessage[] = [
    {
      role: "system",
      content:
        "You are OpenChat, an assistant that uses MCP tools only when they are needed for factual answers. " +
        "Explain clearly for non-technical users. Resolve relative dates explicitly. " +
        "If a tool already returned all requested data, do not call the same tool again with identical arguments. " +
        "Do not claim to have executed a skill or tool unless you actually used one in this response." +
        (explicitFileOutputRequest
          ? " The user asked for a file artifact, so you MUST call the local write-file tool before your final response. Do not ask for confirmation again."
          : "") +
        (noExecutableToolsForSkills
          ? " No MCP tools are connected in this chat, so you cannot create files or execute external actions; provide instructions/content only and state this limitation clearly."
          : "") +
        (skillInstructionBlock ? `\n\n${skillInstructionBlock}` : ""),
    },
    ...buildPersistedHistory(params.history),
    { role: "user", content: params.prompt },
  ];

  const { openAiTools, aliasBySanitized } = toOpenAiTools(executableTools);
  const disableToolsForPrompt = isSmallTalkPrompt(params.prompt);
  const toolsAllowed = openAiTools.length > 0 && !disableToolsForPrompt;
  const toolSchemaChars = toolsAllowed ? JSON.stringify(openAiTools).length : 0;
  if (!toolsAllowed) {
    emit({
      type: "llm_analyzing",
      label: disableToolsForPrompt ? "Tool Calls Skipped" : "No MCP Tools Connected",
      summary: disableToolsForPrompt
        ? "OpenChat detected a conversational prompt and will answer directly without calling MCP tools."
        : "The model can answer directly, but MCP tool calls are unavailable until servers are connected.",
    });
  }

  emit({
    type: "prompt_received",
    label: "Prompt Received",
    summary: "The chat request was accepted and processing started.",
  });

  let skillEventsEmitted = false;
  let forcedFileWriteNudgeSent = false;
  let fileArtifactWritten = false;
  try {
    for (let round = 0; round < MAX_ROUNDS; round++) {
      runStats.rounds = round + 1;
    emit({
      type: "llm_analyzing",
      label: "AI Analyzing",
      summary:
        round === 0
          ? "The AI is reviewing your prompt and deciding what data it needs."
          : "The AI is reviewing tool results and deciding if another call is required.",
    });
    if (!skillEventsEmitted) {
      if (selectedSkills.length > 0) {
        for (const skill of selectedSkills) {
          const insight = buildSkillSelectionInsight(
            params.prompt,
            skill,
            params.skills,
            skillSelection.selectionMethodBySkillId[skill.id],
            skillSelection.scoreBySkillId[skill.id]
          );
          emit({
            type: "skill_selected",
            label: "Skill Selected",
            summary: insight.reason,
            skillName: skill.name,
            resultSummary: `Intended use: ${insight.intendedUse}`,
            rawDetail: insight.rawDetail,
          });
        }
        if (noExecutableToolsForSkills) {
          emit({
            type: "skill_selected",
            label: "Skill Execution Unavailable",
            summary:
              "A skill matched, but no MCP tools are connected. OpenChat can only provide instructions/content in this turn.",
            resultSummary: "No connected MCP tools",
          });
        }
      } else if (/\bskill\b/i.test(params.prompt)) {
        emit({
          type: "skill_selected",
          label: "Skill Requested",
          summary:
            "The prompt asked for a skill, but no installed skill name was matched. Mention the skill by name exactly.",
        });
      }
      if (explicitFileOutputRequest) {
        emit({
          type: "llm_analyzing",
          label: "File Output Requested",
          summary:
            "OpenChat will prefer creating a file artifact via tool call instead of pasting the whole document in chat.",
        });
      }
      skillEventsEmitted = true;
    }

      const requestCompletion = async (includeTools: boolean, requestMessages: LlmMessage[]) => {
        const requestBody = JSON.stringify({
          provider: params.provider,
          messages: requestMessages,
          tools: includeTools && toolsAllowed ? openAiTools : undefined,
        });
        const requestBytes = bytesForText(requestBody);
        runStats.llmRequests += 1;
        runStats.llmBytesSent += requestBytes;
        runStats.bytesSent += requestBytes;
      const response = await apiFetch("/api/llm/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
          body: requestBody,
      });
      const raw = await response.text();
        const responseBytes = bytesForText(raw);
        runStats.llmBytesReceived += responseBytes;
        runStats.bytesReceived += responseBytes;
      return { response, raw };
    };
    const requestCompletionWithRateLimitRecovery = async (
      includeTools: boolean,
      requestMessages: LlmMessage[]
    ) => {
      let completion = await requestCompletion(includeTools, requestMessages);
      let retries = 0;
      const maxRetries = 2;
      while (completion.response.status === 429 && retries < maxRetries) {
        const waitSeconds = Math.min(
          Math.max(extractRateLimitWaitSeconds(completion.raw, completion.response) ?? 5, 1),
          90
        );
        const detail = extractRateLimitMessage(completion.raw) ?? completion.raw;
        emit({
          type: "llm_analyzing",
          label: "Rate Limit Recovery",
          summary: `Provider returned HTTP 429. Waiting ${waitSeconds}s before retry ${retries + 1}/${maxRetries}.`,
          resultSummary: `Retry in ${waitSeconds}s`,
          rawDetail: truncateContent(detail || "(empty response body)", 2200),
        });
        await sleep(waitSeconds * 1000);
        retries += 1;
          runStats.llmRetries += 1;
          runStats.rateLimitRetries += 1;
        completion = await requestCompletion(includeTools, requestMessages);
      }

      if (completion.response.status === 429) {
        const waitSeconds = extractRateLimitWaitSeconds(completion.raw, completion.response);
        const detail = extractRateLimitMessage(completion.raw) ?? completion.raw;
        emit({
          type: "llm_analyzing",
          label: "Rate Limit Exhausted",
          summary: waitSeconds
            ? `Rate limit persisted after retries. Retry after about ${waitSeconds}s.`
            : "Rate limit persisted after retries. Try again shortly.",
          resultSummary: "HTTP 429",
          rawDetail: truncateContent(detail || "(empty response body)", 2200),
        });
      }
      return completion;
    };

    const requestMessages = buildRequestMessages(messages);
    let usedToolSchemas = toolsAllowed;
    let completion = await requestCompletionWithRateLimitRecovery(true, requestMessages);
    if (!completion.response.ok) {
      const rawLower = completion.raw.toLowerCase();
      const tokenLimitHit =
        completion.response.status === 413 ||
        rawLower.includes("tokens_limit_reached") ||
        rawLower.includes("request body too large") ||
        rawLower.includes("max size");

      if (tokenLimitHit) {
        usedToolSchemas = false;
        const initialStats = estimateRequestChars(requestMessages, toolSchemaChars, true);
        const compactRequestMessages = buildRetryRequestMessages(requestMessages);
        const retryStats = estimateRequestChars(compactRequestMessages, toolSchemaChars, false);
        emit({
          type: "llm_analyzing",
          label: "Token Limit Recovery",
          summary:
            `Initial payload ~${initialStats.totalChars.toLocaleString()} chars (${initialStats.toolsChars.toLocaleString()} from tool schemas). Retrying without tool schemas.`,
          resultSummary: `HTTP ${completion.response.status}`,
          rawDetail: truncateContent(
            [
              `Initial request messages: ${requestMessages.length}`,
              `Initial payload estimate: ${initialStats.totalChars.toLocaleString()} chars`,
              `- Message content: ${initialStats.messageChars.toLocaleString()} chars`,
              `- Tool schema content: ${initialStats.toolsChars.toLocaleString()} chars`,
              `Retry request messages: ${compactRequestMessages.length}`,
              `Retry payload estimate: ${retryStats.totalChars.toLocaleString()} chars`,
              `Provider error (first attempt):`,
              completion.raw || "(empty response body)",
            ].join("\n"),
            2200
          ),
        });
          runStats.llmRetries += 1;
          runStats.tokenRecoveryRetries += 1;
        completion = await requestCompletionWithRateLimitRecovery(false, compactRequestMessages);
        if (!completion.response.ok) {
          emit({
            type: "llm_analyzing",
            label: "Token Recovery Failed",
            summary: "Retry without tool schemas still failed. Expand for upstream error details.",
            resultSummary: `HTTP ${completion.response.status}`,
            rawDetail: truncateContent(completion.raw || "(empty response body)", 2200),
          });
        }
      }
    }

    if (!completion.response.ok) {
      if (completion.response.status === 429) {
        const waitSeconds = extractRateLimitWaitSeconds(completion.raw, completion.response);
        const detail = extractRateLimitMessage(completion.raw);
        throw new Error(
          waitSeconds
            ? `LLM rate limit reached. Please wait about ${waitSeconds}s and retry.${detail ? ` ${detail}` : ""}`
            : `LLM rate limit reached. Please retry shortly.${detail ? ` ${detail}` : ""}`
        );
      }
      throw new Error(`LLM request failed (${completion.response.status}): ${completion.raw}`);
    }

      let data: LlmResponse;
    try {
      data = JSON.parse(completion.raw) as LlmResponse;
    } catch {
      throw new Error("LLM response was not valid JSON.");
    }
      const promptTokens =
        typeof data.usage?.prompt_tokens === "number" ? data.usage.prompt_tokens : 0;
      const completionTokens =
        typeof data.usage?.completion_tokens === "number" ? data.usage.completion_tokens : 0;
      const totalTokens =
        typeof data.usage?.total_tokens === "number"
          ? data.usage.total_tokens
          : promptTokens + completionTokens;
      if (promptTokens > 0 || completionTokens > 0 || totalTokens > 0) {
        runStats.promptTokens += promptTokens;
        runStats.completionTokens += completionTokens;
        runStats.totalTokens += totalTokens;
        runStats.usageResponses += 1;
      }
    const msg = data.choices[0]?.message;
    if (!msg) throw new Error("LLM response did not include a message.");

    messages.push({
      role: "assistant",
      content: msg.content ?? "",
      tool_calls: msg.tool_calls,
    });

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const noToolExecutionNotice =
        noExecutableToolsForSkills
          ? "Note: No MCP tools are connected, so I cannot actually create files or run Excalidraw in this session. I can provide the content/instructions for you to run once a compatible MCP server is connected."
          : "";
      if (toolsAllowed) {
        emit({
          type: "llm_analyzing",
          label: usedToolSchemas ? "No Tool Call" : "Tool Calls Skipped",
          summary: usedToolSchemas
            ? "The model decided this prompt did not require MCP tools."
            : "Tool calls were skipped on retry to fit model token limits.",
        });
      }
      if (
        explicitFileOutputRequest &&
        toolsAllowed &&
        !fileArtifactWritten &&
        !forcedFileWriteNudgeSent
      ) {
        forcedFileWriteNudgeSent = true;
        emit({
          type: "llm_analyzing",
          label: "File Save Required",
          summary:
            "The user asked for a file artifact, so OpenChat is re-prompting the model to call the local write-file tool now.",
        });
        messages.push({
          role: "user",
          content:
            "You must now call the local write-file tool to save the artifact. Pick an appropriate relativePath with the correct extension for the content (for markdown use .md), then return a brief confirmation.",
        });
        continue;
      }
      emit({
        type: "response_ready",
        label: "Response Ready",
        summary: "The AI has enough data and is returning the final answer.",
      });
        emitRunStats("success");
      return {
        finalText: noToolExecutionNotice
          ? `${noToolExecutionNotice}\n\n${msg.content ?? ""}`.trim()
          : msg.content ?? "",
        updatedHistory: buildPersistedHistory(messages.slice(1)),
        lastUi,
      };
    }

      runStats.toolCallsRequested += msg.tool_calls.length;
      for (const toolCall of msg.tool_calls) {
      const aliasName = aliasBySanitized.get(toolCall.function.name) ?? toolCall.function.name;
      const args = parseArgs(toolCall.function.arguments);
      const canonicalArgs = canonicalizeArgsForDedup(args);
      const cacheKey = `${aliasName}::${stableStringify(canonicalArgs)}`;

      emit({
        type: "tool_selected",
        label: "Tool Selected",
        summary: summarizeReason(aliasName),
        toolName: aliasName,
        toolArgs: args,
      });

      const callCount = toolCallCounts.get(aliasName) ?? 0;
      if (callCount >= MAX_SAME_TOOL_CALLS_PER_TURN) {
          runStats.budgetBlocks += 1;
        emit({
          type: "llm_analyzing",
          label: "Tool Call Budget Reached",
          summary: `"${aliasName}" was already called ${MAX_SAME_TOOL_CALLS_PER_TURN} times in this turn. Use existing results to answer.`,
          toolName: aliasName,
          toolArgs: args,
        });
        messages.push({
          role: "tool",
          content: `Tool call blocked: "${aliasName}" already reached ${MAX_SAME_TOOL_CALLS_PER_TURN} calls in this turn. Use prior results.`,
          tool_call_id: toolCall.id,
        });
        continue;
      }
      toolCallCounts.set(aliasName, callCount + 1);

      if (duplicateToolCalls.has(cacheKey)) {
          runStats.duplicateBlocks += 1;
        emit({
          type: "llm_analyzing",
          label: "Duplicate Tool Blocked",
          summary:
            "The model requested the same tool and arguments again in this turn, so the duplicate call was skipped.",
          toolName: aliasName,
          toolArgs: args,
        });
        messages.push({
          role: "tool",
          content:
            "Duplicate tool call blocked in this turn. Use the previously returned tool result instead.",
          tool_call_id: toolCall.id,
        });
        continue;
      }

      duplicateToolCalls.add(cacheKey);
        runStats.toolCallsExecuted += 1;
        touchedTools.add(aliasName);
        if (aliasName === LOCAL_WRITE_FILE_TOOL_NAME) {
          fileArtifactWritten = true;
        }
        const argsBytes = bytesForText(JSON.stringify(args));
        runStats.toolBytesSent += argsBytes;
        runStats.bytesSent += argsBytes;
      emit({
        type: "server_called",
        label: "Server Called",
        summary: "The request was sent to the selected MCP server.",
        toolName: aliasName,
        toolArgs: args,
        rawDetail: truncateContent(JSON.stringify(args, null, 2), 2200),
      });
      let result: ToolCallResult;
      try {
        result = await params.callTool(aliasName, args);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
          const reasonBytes = bytesForText(reason);
          runStats.toolCallFailures += 1;
          runStats.toolBytesReceived += reasonBytes;
          runStats.bytesReceived += reasonBytes;
        emit({
          type: "data_returned",
          label: "Tool Error",
          summary: `${aliasName}: ${reason}`,
          toolName: aliasName,
          resultSummary: reason,
          rawDetail: reason,
        });
        messages.push({
          role: "tool",
          content: truncateContent(`Tool call failed for ${aliasName}: ${reason}`),
          tool_call_id: toolCall.id,
        });
        continue;
      }
      messages.push({
        role: "tool",
        content: truncateContent(result.text),
        tool_call_id: toolCall.id,
      });
        if (result.toolName === LOCAL_WRITE_FILE_TOOL_NAME) {
          fileArtifactWritten = true;
        }
        touchedServers.add(result.serverName);
        const resultBytes = bytesForText(result.rawResult || result.text || "");
        runStats.toolBytesReceived += resultBytes;
        runStats.bytesReceived += resultBytes;

      emit({
        type: "data_returned",
        label: "Data Returned",
        summary: `${result.serverName}: ${result.resultSummary}`,
        serverName: result.serverName,
        toolName: result.toolName,
        resultSummary: result.resultSummary,
        rawDetail: result.rawResult,
      });

      if (result.uiMeta) {
        lastUi = {
          ...result.uiMeta,
          toolAlias: aliasName,
          toolArgs: result.args,
          toolName: result.toolName,
          serverName: result.serverName,
        };
        emit({
          type: "ui_loaded",
          label: "UI Loaded",
          summary: result.uiMeta.interactive
            ? `${result.serverName} returned an interactive UI for this result.`
            : `${result.serverName} returned a static UI preview (interactive bridge is unavailable for this transport).`,
          toolName: result.toolName,
          serverName: result.serverName,
        });
      }

      emit({
        type: "ai_processing",
        label: "AI Processing",
        summary: `The AI is turning ${result.resultSummary} into a user-friendly response.`,
        toolName: result.toolName,
        serverName: result.serverName,
        resultSummary: result.resultSummary,
      });
    }
  }
  } catch (error) {
    emitRunStats("error", error instanceof Error ? error.message : String(error));
    throw error;
  }

  emitRunStats("max_rounds");
  return {
    finalText: "Maximum tool rounds reached before completion.",
    updatedHistory: buildPersistedHistory(messages.slice(1)),
    lastUi,
  };
}

