import { EventEmitter } from "node:events";
import type { AgentMessage, AgentTool } from "@mariozechner/pi-agent-core";
import type { SessionManager } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "@sinclair/typebox";
import type { OpenClawConfig } from "../../config/config.js";
import { registerUnhandledRejectionHandler } from "../../infra/unhandled-rejections.js";
import {
  hasInterSessionUserProvenance,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  downgradeOpenAIReasoningBlocks,
  isCompactionFailureError,
  isGoogleModelApi,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
} from "../pi-embedded-helpers.js";
import { cleanToolSchemaForGemini } from "../pi-tools.schema.js";
import {
  sanitizeToolCallInputs,
  stripToolResultDetails,
  sanitizeToolUseResultPairing,
} from "../session-transcript-repair.js";
import type { TranscriptPolicy } from "../transcript-policy.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import {
  makeZeroUsageSnapshot,
  normalizeUsage,
  type AssistantUsageSnapshot,
  type UsageLike,
} from "../usage.js";
import { log } from "./logger.js";
import { dropThinkingBlocks } from "./thinking.js";
import { describeUnknownError } from "./utils.js";

const GOOGLE_TURN_ORDERING_CUSTOM_TYPE = "google-turn-ordering-bootstrap";
const GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS = new Set([
  "patternProperties",
  "additionalProperties",
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "definitions",
  "examples",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "multipleOf",
  "pattern",
  "format",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

const INTER_SESSION_PREFIX_BASE = "[Inter-session message]";

function buildInterSessionPrefix(message: AgentMessage): string {
  const provenance = normalizeInputProvenance((message as { provenance?: unknown }).provenance);
  if (!provenance) {
    return INTER_SESSION_PREFIX_BASE;
  }
  const details = [
    provenance.sourceSessionKey ? `sourceSession=${provenance.sourceSessionKey}` : undefined,
    provenance.sourceChannel ? `sourceChannel=${provenance.sourceChannel}` : undefined,
    provenance.sourceTool ? `sourceTool=${provenance.sourceTool}` : undefined,
  ].filter(Boolean);
  if (details.length === 0) {
    return INTER_SESSION_PREFIX_BASE;
  }
  return `${INTER_SESSION_PREFIX_BASE} ${details.join(" ")}`;
}

function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const msg of messages) {
    if (!hasInterSessionUserProvenance(msg as { role?: unknown; provenance?: unknown })) {
      out.push(msg);
      continue;
    }
    const prefix = buildInterSessionPrefix(msg);
    const user = msg as Extract<AgentMessage, { role: "user" }>;
    if (typeof user.content === "string") {
      if (user.content.startsWith(prefix)) {
        out.push(msg);
        continue;
      }
      touched = true;
      out.push({
        ...(msg as unknown as Record<string, unknown>),
        content: `${prefix}\n${user.content}`,
      } as AgentMessage);
      continue;
    }
    if (!Array.isArray(user.content)) {
      out.push(msg);
      continue;
    }

    const textIndex = user.content.findIndex(
      (block) =>
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    );

    if (textIndex >= 0) {
      const existing = user.content[textIndex] as { type: "text"; text: string };
      if (existing.text.startsWith(prefix)) {
        out.push(msg);
        continue;
      }
      const nextContent = [...user.content];
      nextContent[textIndex] = {
        ...existing,
        text: `${prefix}\n${existing.text}`,
      };
      touched = true;
      out.push({
        ...(msg as unknown as Record<string, unknown>),
        content: nextContent,
      } as AgentMessage);
      continue;
    }

    touched = true;
    out.push({
      ...(msg as unknown as Record<string, unknown>),
      content: [{ type: "text", text: prefix }, ...user.content],
    } as AgentMessage);
  }
  return touched ? out : messages;
}

function parseMessageTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return null;
}

function stripStaleAssistantUsageBeforeLatestCompaction(messages: AgentMessage[]): AgentMessage[] {
  let latestCompactionSummaryIndex = -1;
  let latestCompactionTimestamp: number | null = null;
  for (let i = 0; i < messages.length; i += 1) {
    const entry = messages[i];
    if (entry?.role !== "compactionSummary") {
      continue;
    }
    latestCompactionSummaryIndex = i;
    latestCompactionTimestamp = parseMessageTimestamp(
      (entry as { timestamp?: unknown }).timestamp ?? null,
    );
  }
  if (latestCompactionSummaryIndex === -1) {
    return messages;
  }

  const out = [...messages];
  let touched = false;
  for (let i = 0; i < out.length; i += 1) {
    const candidate = out[i] as
      | (AgentMessage & { usage?: unknown; timestamp?: unknown })
      | undefined;
    if (!candidate || candidate.role !== "assistant") {
      continue;
    }
    if (!candidate.usage || typeof candidate.usage !== "object") {
      continue;
    }

    const messageTimestamp = parseMessageTimestamp(candidate.timestamp);
    const staleByTimestamp =
      latestCompactionTimestamp !== null &&
      messageTimestamp !== null &&
      messageTimestamp <= latestCompactionTimestamp;
    const staleByLegacyOrdering = i < latestCompactionSummaryIndex;
    if (!staleByTimestamp && !staleByLegacyOrdering) {
      continue;
    }

    // pi-coding-agent expects assistant usage to always be present during context
    // accounting. Keep stale snapshots structurally valid, but zeroed out.
    const candidateRecord = candidate as unknown as Record<string, unknown>;
    out[i] = {
      ...candidateRecord,
      usage: makeZeroUsageSnapshot(),
    } as unknown as AgentMessage;
    touched = true;
  }
  return touched ? out : messages;
}

function normalizeAssistantUsageSnapshot(usage: unknown) {
  const normalized = normalizeUsage((usage ?? undefined) as UsageLike | undefined);
  if (!normalized) {
    return makeZeroUsageSnapshot();
  }
  const input = normalized.input ?? 0;
  const output = normalized.output ?? 0;
  const cacheRead = normalized.cacheRead ?? 0;
  const cacheWrite = normalized.cacheWrite ?? 0;
  const totalTokens = normalized.total ?? input + output + cacheRead + cacheWrite;
  const cost = normalizeAssistantUsageCost(usage);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens,
    ...(cost ? { cost } : {}),
  };
}

function normalizeAssistantUsageCost(usage: unknown): AssistantUsageSnapshot["cost"] | undefined {
  const base = makeZeroUsageSnapshot().cost;
  if (!usage || typeof usage !== "object") {
    return undefined;
  }
  const rawCost = (usage as { cost?: unknown }).cost;
  if (!rawCost || typeof rawCost !== "object") {
    return undefined;
  }
  const cost = rawCost as Record<string, unknown>;
  const inputRaw = toFiniteCostNumber(cost.input);
  const outputRaw = toFiniteCostNumber(cost.output);
  const cacheReadRaw = toFiniteCostNumber(cost.cacheRead);
  const cacheWriteRaw = toFiniteCostNumber(cost.cacheWrite);
  const totalRaw = toFiniteCostNumber(cost.total);
  if (
    inputRaw === undefined &&
    outputRaw === undefined &&
    cacheReadRaw === undefined &&
    cacheWriteRaw === undefined &&
    totalRaw === undefined
  ) {
    return undefined;
  }
  const input = inputRaw ?? base.input;
  const output = outputRaw ?? base.output;
  const cacheRead = cacheReadRaw ?? base.cacheRead;
  const cacheWrite = cacheWriteRaw ?? base.cacheWrite;
  const total = totalRaw ?? input + output + cacheRead + cacheWrite;
  return { input, output, cacheRead, cacheWrite, total };
}

function toFiniteCostNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ensureAssistantUsageSnapshots(messages: AgentMessage[]): AgentMessage[] {
  if (messages.length === 0) {
    return messages;
  }

  let touched = false;
  const out = [...messages];
  for (let i = 0; i < out.length; i += 1) {
    const message = out[i] as (AgentMessage & { role?: unknown; usage?: unknown }) | undefined;
    if (!message || message.role !== "assistant") {
      continue;
    }
    const normalizedUsage = normalizeAssistantUsageSnapshot(message.usage);
    const usageCost =
      message.usage && typeof message.usage === "object"
        ? (message.usage as { cost?: unknown }).cost
        : undefined;
    const normalizedCost = normalizedUsage.cost;
    if (
      message.usage &&
      typeof message.usage === "object" &&
      (message.usage as { input?: unknown }).input === normalizedUsage.input &&
      (message.usage as { output?: unknown }).output === normalizedUsage.output &&
      (message.usage as { cacheRead?: unknown }).cacheRead === normalizedUsage.cacheRead &&
      (message.usage as { cacheWrite?: unknown }).cacheWrite === normalizedUsage.cacheWrite &&
      (message.usage as { totalTokens?: unknown }).totalTokens === normalizedUsage.totalTokens &&
      ((normalizedCost &&
        usageCost &&
        typeof usageCost === "object" &&
        (usageCost as { input?: unknown }).input === normalizedCost.input &&
        (usageCost as { output?: unknown }).output === normalizedCost.output &&
        (usageCost as { cacheRead?: unknown }).cacheRead === normalizedCost.cacheRead &&
        (usageCost as { cacheWrite?: unknown }).cacheWrite === normalizedCost.cacheWrite &&
        (usageCost as { total?: unknown }).total === normalizedCost.total) ||
        (!normalizedCost && usageCost === undefined))
    ) {
      continue;
    }
    out[i] = {
      ...(message as unknown as Record<string, unknown>),
      usage: normalizedUsage,
    } as AgentMessage;
    touched = true;
  }

  return touched ? out : messages;
}

export function findUnsupportedSchemaKeywords(schema: unknown, path: string): string[] {
  if (!schema || typeof schema !== "object") {
    return [];
  }
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      findUnsupportedSchemaKeywords(item, `${path}[${index}]`),
    );
  }
  const record = schema as Record<string, unknown>;
  const violations: string[] = [];
  const properties =
    record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)
      ? (record.properties as Record<string, unknown>)
      : undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.properties.${key}`));
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (key === "properties") {
      continue;
    }
    if (GOOGLE_SCHEMA_UNSUPPORTED_KEYWORDS.has(key)) {
      violations.push(`${path}.${key}`);
    }
    if (value && typeof value === "object") {
      violations.push(...findUnsupportedSchemaKeywords(value, `${path}.${key}`));
    }
  }
  return violations;
}

export function sanitizeToolsForGoogle<
  TSchemaType extends TSchema = TSchema,
  TResult = unknown,
>(params: {
  tools: AgentTool<TSchemaType, TResult>[];
  provider: string;
}): AgentTool<TSchemaType, TResult>[] {
  // Cloud Code Assist uses the OpenAPI 3.03 `parameters` field for both Gemini
  // AND Claude models.  This field does not support JSON Schema keywords such as
  // patternProperties, additionalProperties, $ref, etc.  We must clean schemas
  // for every provider that routes through this path.
  if (params.provider !== "google-gemini-cli") {
    return params.tools;
  }
  return params.tools.map((tool) => {
    if (!tool.parameters || typeof tool.parameters !== "object") {
      return tool;
    }
    return {
      ...tool,
      parameters: cleanToolSchemaForGemini(
        tool.parameters as Record<string, unknown>,
      ) as TSchemaType,
    };
  });
}

export function logToolSchemasForGoogle(params: { tools: AgentTool[]; provider: string }) {
  if (params.provider !== "google-gemini-cli") {
    return;
  }
  const toolNames = params.tools.map((tool, index) => `${index}:${tool.name}`);
  const tools = sanitizeToolsForGoogle(params);
  log.info("google tool schema snapshot", {
    provider: params.provider,
    toolCount: tools.length,
    tools: toolNames,
  });
  for (const [index, tool] of tools.entries()) {
    const violations = findUnsupportedSchemaKeywords(tool.parameters, `${tool.name}.parameters`);
    if (violations.length > 0) {
      log.warn("google tool schema has unsupported keywords", {
        index,
        tool: tool.name,
        violations: violations.slice(0, 12),
        violationCount: violations.length,
      });
    }
  }
}

// Event emitter for unhandled compaction failures that escape try-catch blocks.
// Listeners can use this to trigger session recovery with retry.
const compactionFailureEmitter = new EventEmitter();

export type CompactionFailureListener = (reason: string) => void;

/**
 * Register a listener for unhandled compaction failures.
 * Called when auto-compaction fails in a way that escapes the normal try-catch,
 * e.g., when the summarization request itself exceeds the model's token limit.
 * Returns an unsubscribe function.
 */
export function onUnhandledCompactionFailure(cb: CompactionFailureListener): () => void {
  compactionFailureEmitter.on("failure", cb);
  return () => compactionFailureEmitter.off("failure", cb);
}

registerUnhandledRejectionHandler((reason) => {
  const message = describeUnknownError(reason);
  if (!isCompactionFailureError(message)) {
    return false;
  }
  log.error(`Auto-compaction failed (unhandled): ${message}`);
  compactionFailureEmitter.emit("failure", message);
  return true;
});

type CustomEntryLike = { type?: unknown; customType?: unknown; data?: unknown };

type ModelSnapshotEntry = {
  timestamp: number;
  provider?: string;
  modelApi?: string | null;
  modelId?: string;
};

const MODEL_SNAPSHOT_CUSTOM_TYPE = "model-snapshot";

function readLastModelSnapshot(sessionManager: SessionManager): ModelSnapshotEntry | null {
  try {
    const entries = sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i] as CustomEntryLike;
      if (entry?.type !== "custom" || entry?.customType !== MODEL_SNAPSHOT_CUSTOM_TYPE) {
        continue;
      }
      const data = entry?.data as ModelSnapshotEntry | undefined;
      if (data && typeof data === "object") {
        return data;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function appendModelSnapshot(sessionManager: SessionManager, data: ModelSnapshotEntry): void {
  try {
    sessionManager.appendCustomEntry(MODEL_SNAPSHOT_CUSTOM_TYPE, data);
  } catch {
    // ignore persistence failures
  }
}

function isSameModelSnapshot(a: ModelSnapshotEntry, b: ModelSnapshotEntry): boolean {
  const normalize = (value?: string | null) => value ?? "";
  return (
    normalize(a.provider) === normalize(b.provider) &&
    normalize(a.modelApi) === normalize(b.modelApi) &&
    normalize(a.modelId) === normalize(b.modelId)
  );
}

function normalizeStringValue(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function buildAllowedToolNameSet(allowedToolNames?: Iterable<string>): Set<string> | undefined {
  if (!allowedToolNames) {
    return undefined;
  }
  const normalized = new Set<string>();
  for (const toolName of allowedToolNames) {
    const next = normalizeStringValue(toolName);
    if (next) {
      normalized.add(next.toLowerCase());
    }
  }
  return normalized.size === 0 ? undefined : normalized;
}

function sanitizeModelSwitchFunctionBlocks(params: {
  messages: AgentMessage[];
  allowedToolNames?: Iterable<string>;
}): AgentMessage[] {
  const allowedNames = buildAllowedToolNameSet(params.allowedToolNames);
  let changed = false;
  const out: AgentMessage[] = [];

  for (const msg of params.messages) {
    const role = (msg as { role?: unknown }).role;
    if (role === "assistant" || role === "user") {
      const content = Array.isArray((msg as { content?: unknown }).content)
        ? (msg as { content: unknown[] }).content
        : undefined;
      if (!content) {
        out.push(msg);
        continue;
      }

      const nextContent: unknown[] = [];
      let messageChanged = false;

      for (const block of content) {
        if (!block || typeof block !== "object") {
          nextContent.push(block);
          continue;
        }

        const record = block as Record<string, unknown>;

        // Preserve only function call/response blocks with valid, non-empty names
        // and without legacy unsupported ids when restoring context after a model
        // change. Stale function call state can leak into Gemini requests and
        // produce empty functionResponse.name payloads.
        if (record.functionCall && typeof record.functionCall === "object") {
          const fn = record.functionCall as Record<string, unknown>;
          const normalizedName = normalizeStringValue(fn.name);
          if (!normalizedName) {
            changed = true;
            messageChanged = true;
            continue;
          }
          const name = normalizedName.toLowerCase();
          if (allowedNames && !allowedNames.has(name)) {
            changed = true;
            messageChanged = true;
            continue;
          }
          if (normalizedName !== (fn.name as string)) {
            changed = true;
            nextContent.push({ ...record, functionCall: { ...fn, name: normalizedName } });
          } else {
            nextContent.push(block);
          }
          messageChanged = true;
          continue;
        }

        if (record.functionResponse && typeof record.functionResponse === "object") {
          const fn = record.functionResponse as Record<string, unknown>;
          const normalizedName = normalizeStringValue(fn.name);
          if (!normalizedName) {
            changed = true;
            messageChanged = true;
            continue;
          }
          const name = normalizedName.toLowerCase();
          if (allowedNames && !allowedNames.has(name)) {
            changed = true;
            messageChanged = true;
            continue;
          }
          if (normalizedName !== (fn.name as string)) {
            changed = true;
            nextContent.push({ ...record, functionResponse: { ...fn, name: normalizedName } });
          } else {
            nextContent.push(block);
          }
          messageChanged = true;
          continue;
        }

        nextContent.push(block);
      }

      if (nextContent.length === 0) {
        if (messageChanged) {
          changed = true;
        }
        continue;
      }
      if (messageChanged) {
        changed = true;
        out.push({ ...msg, content: nextContent } as AgentMessage);
        continue;
      }
      out.push(msg);
      continue;
    }

    if (role !== "toolResult") {
      out.push(msg);
      continue;
    }

    const toolCallId = normalizeStringValue((msg as { toolCallId?: unknown }).toolCallId);
    if (!toolCallId) {
      changed = true;
      continue;
    }
    const toolName = normalizeStringValue((msg as { toolName?: unknown }).toolName);
    if (!toolName) {
      changed = true;
      continue;
    }
    if (allowedNames && !allowedNames.has(toolName.toLowerCase())) {
      changed = true;
      continue;
    }
    if (toolName !== (msg as { toolName?: unknown }).toolName) {
      out.push({ ...msg, toolCallId, toolName } as AgentMessage);
      changed = true;
      continue;
    }
    if (toolCallId !== (msg as { toolCallId?: unknown }).toolCallId) {
      out.push({ ...msg, toolCallId } as AgentMessage);
      changed = true;
      continue;
    }

    out.push(msg);
  }

  return changed ? out : params.messages;
}

function hasGoogleTurnOrderingMarker(sessionManager: SessionManager): boolean {
  try {
    return sessionManager
      .getEntries()
      .some(
        (entry) =>
          (entry as CustomEntryLike)?.type === "custom" &&
          (entry as CustomEntryLike)?.customType === GOOGLE_TURN_ORDERING_CUSTOM_TYPE,
      );
  } catch {
    return false;
  }
}

function markGoogleTurnOrderingMarker(sessionManager: SessionManager): void {
  try {
    sessionManager.appendCustomEntry(GOOGLE_TURN_ORDERING_CUSTOM_TYPE, {
      timestamp: Date.now(),
    });
  } catch {
    // ignore marker persistence failures
  }
}

export function applyGoogleTurnOrderingFix(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  sessionManager: SessionManager;
  sessionId: string;
  warn?: (message: string) => void;
}): { messages: AgentMessage[]; didPrepend: boolean } {
  if (!isGoogleModelApi(params.modelApi)) {
    return { messages: params.messages, didPrepend: false };
  }
  const first = params.messages[0] as { role?: unknown; content?: unknown } | undefined;
  if (first?.role !== "assistant") {
    return { messages: params.messages, didPrepend: false };
  }
  const sanitized = sanitizeGoogleTurnOrdering(params.messages);
  const didPrepend = sanitized !== params.messages;
  if (didPrepend && !hasGoogleTurnOrderingMarker(params.sessionManager)) {
    const warn = params.warn ?? ((message: string) => log.warn(message));
    warn(`google turn ordering fixup: prepended user bootstrap (sessionId=${params.sessionId})`);
    markGoogleTurnOrderingMarker(params.sessionManager);
  }
  return { messages: sanitized, didPrepend };
}

export async function sanitizeSessionHistory(params: {
  messages: AgentMessage[];
  modelApi?: string | null;
  modelId?: string;
  provider?: string;
  allowedToolNames?: Iterable<string>;
  config?: OpenClawConfig;
  sessionManager: SessionManager;
  sessionId: string;
  policy?: TranscriptPolicy;
}): Promise<AgentMessage[]> {
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  const policy =
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
    });
  const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
  const sanitizedImages = await sanitizeSessionMessagesImages(
    withInterSessionMarkers,
    "session:history",
    {
      sanitizeMode: policy.sanitizeMode,
      sanitizeToolCallIds: policy.sanitizeToolCallIds,
      toolCallIdMode: policy.toolCallIdMode,
      preserveSignatures: policy.preserveSignatures,
      sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
      ...resolveImageSanitizationLimits(params.config),
    },
  );
  const droppedThinking = policy.dropThinkingBlocks
    ? dropThinkingBlocks(sanitizedImages)
    : sanitizedImages;
  const sanitizedToolCalls = sanitizeToolCallInputs(droppedThinking, {
    allowedToolNames: params.allowedToolNames,
  });
  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" || params.modelApi === "openai-codex-responses";
  const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
  const priorSnapshot = hasSnapshot ? readLastModelSnapshot(params.sessionManager) : null;
  const modelChanged = priorSnapshot
    ? !isSameModelSnapshot(priorSnapshot, {
        timestamp: 0,
        provider: params.provider,
        modelApi: params.modelApi,
        modelId: params.modelId,
      })
    : false;
  const sanitizedModelSwitchArtifacts = sanitizeModelSwitchFunctionBlocks({
    messages: sanitizedToolCalls,
    allowedToolNames: params.allowedToolNames,
  });
  const repairedTools = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairing(sanitizedModelSwitchArtifacts)
    : sanitizedModelSwitchArtifacts;
  const sanitizedToolResults = stripToolResultDetails(repairedTools);
  const sanitizedCompactionUsage = ensureAssistantUsageSnapshots(
    stripStaleAssistantUsageBeforeLatestCompaction(sanitizedToolResults),
  );
  const sanitizedOpenAI = isOpenAIResponsesApi
    ? downgradeOpenAIFunctionCallReasoningPairs(
        downgradeOpenAIReasoningBlocks(sanitizedCompactionUsage),
      )
    : sanitizedCompactionUsage;

  if (hasSnapshot && (!priorSnapshot || modelChanged)) {
    appendModelSnapshot(params.sessionManager, {
      timestamp: Date.now(),
      provider: params.provider,
      modelApi: params.modelApi,
      modelId: params.modelId,
    });
  }

  if (!policy.applyGoogleTurnOrdering) {
    return sanitizedOpenAI;
  }

  // Google models use the full wrapper with logging and session markers.
  if (isGoogleModelApi(params.modelApi)) {
    return applyGoogleTurnOrderingFix({
      messages: sanitizedOpenAI,
      modelApi: params.modelApi,
      sessionManager: params.sessionManager,
      sessionId: params.sessionId,
    }).messages;
  }

  // Strict OpenAI-compatible providers (vLLM, Gemma, etc.) also reject
  // conversations that start with an assistant turn (e.g. delivery-mirror
  // messages after /new).  Apply the same ordering fix without the
  // Google-specific session markers.  See #38962.
  return sanitizeGoogleTurnOrdering(sanitizedOpenAI);
}
