/**
 * Provider-agnostic reply router.
 *
 * Routes replies to the originating channel based on OriginatingChannel/OriginatingTo
 * instead of using the session's lastChannel. This ensures replies go back to the
 * provider where the message originated, even when the main session is shared
 * across multiple providers.
 */

import { createHash } from "node:crypto";
import { resolveSessionAgentId } from "../../agents/agent-scope.js";
import { resolveEffectiveMessagesConfig } from "../../agents/identity.js";
import { normalizeChannelId } from "../../channels/plugins/index.js";
import type { OpenClawConfig } from "../../config/config.js";
import { createDedupeCache } from "../../infra/dedupe.js";
import { buildOutboundSessionContext } from "../../infra/outbound/session-context.js";
import { INTERNAL_MESSAGE_CHANNEL, normalizeMessageChannel } from "../../utils/message-channel.js";
import type { OriginatingChannelType } from "../templating.js";
import type { ReplyPayload } from "../types.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { shouldSuppressReasoningPayload } from "./reply-payloads.js";

let deliverRuntimePromise: Promise<
  typeof import("../../infra/outbound/deliver-runtime.js")
> | null = null;
const ROUTE_REPLY_DEDUPE_TTL_MS = 60_000;
const ROUTE_REPLY_DEDUPE_MAX_SIZE = 10_000;
const ROUTE_REPLY_DEDUPE_WITHOUT_MESSAGE_ID_TTL_MS = 5_000;
const routeReplyDedupeCache = createDedupeCache({
  ttlMs: ROUTE_REPLY_DEDUPE_TTL_MS,
  maxSize: ROUTE_REPLY_DEDUPE_MAX_SIZE,
});
const routeReplyDedupeInProgress = new Set<string>();
const routeReplyDedupeWithoutMessageIdCache = createDedupeCache({
  ttlMs: ROUTE_REPLY_DEDUPE_WITHOUT_MESSAGE_ID_TTL_MS,
  maxSize: ROUTE_REPLY_DEDUPE_MAX_SIZE,
});
const routeReplyDedupeWithoutMessageIdInProgress = new Set<string>();

const buildRouteReplyPayloadFingerprint = (payload: ReplyPayload): string => {
  const normalizedPayload = {
    text: payload.text?.trim() ?? "",
    mediaUrl: payload.mediaUrl?.trim() ?? "",
    mediaUrls: (payload.mediaUrls ?? []).filter((url): url is string => Boolean(url)).map(String),
    replyToId: payload.replyToId ?? null,
    replyToTag: payload.replyToTag === true,
    replyToCurrent: payload.replyToCurrent === true,
    isReasoning: payload.isReasoning === true,
    isError: payload.isError === true,
    audioAsVoice: payload.audioAsVoice === true,
    channelData: payload.channelData ?? null,
  };
  return createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex");
};

const resolveRouteReplyTargetChannelAndAddress = (params: {
  channel: OriginatingChannelType;
  to: string;
}): { channel: string; to: string } => {
  const normalizedTo = params.to.trim();
  const explicitPrefix = normalizedTo.split(":")[0]?.trim();
  if (explicitPrefix) {
    const resolvedPrefix = normalizeChannelId(explicitPrefix);
    if (resolvedPrefix && resolvedPrefix !== INTERNAL_MESSAGE_CHANNEL) {
      return {
        channel: resolvedPrefix,
        to: normalizedTo.slice(explicitPrefix.length + 1).trim(),
      };
    }
  }
  return {
    channel: normalizeMessageChannel(params.channel) ?? INTERNAL_MESSAGE_CHANNEL,
    to: normalizedTo,
  };
};

const buildRouteReplyTargetFingerprint = (params: {
  channel: OriginatingChannelType;
  to: string;
  accountId?: string;
  threadId?: string | number;
}): string => {
  const normalizedTarget = resolveRouteReplyTargetChannelAndAddress({
    channel: params.channel,
    to: params.to,
  });
  const normalizedTo = normalizedTarget.to;
  const threadIdValue =
    params.threadId === undefined || params.threadId === null ? "" : String(params.threadId);
  return `${normalizedTarget.channel}|${normalizedTo}|${params.accountId ?? ""}|${threadIdValue}`;
};

const buildRouteReplyDedupeKey = (params: {
  messageId: string;
  sessionKey?: string;
  channel: OriginatingChannelType;
  to: string;
  accountId?: string;
  threadId?: string | number;
  payload: ReplyPayload;
}): string => {
  const payloadFingerprint = buildRouteReplyPayloadFingerprint(params.payload);
  const targetFingerprint = buildRouteReplyTargetFingerprint({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
  });
  return JSON.stringify({
    type: "route-reply",
    messageId: params.messageId,
    sessionKey: params.sessionKey ?? "",
    targetFingerprint,
    payloadFingerprint,
  });
};

const buildRouteReplyDedupeWithoutMessageIdKey = (params: {
  sessionKey?: string;
  channel: OriginatingChannelType;
  to: string;
  accountId?: string;
  threadId?: string | number;
  payload: ReplyPayload;
}): string => {
  const payloadFingerprint = buildRouteReplyPayloadFingerprint(params.payload);
  const targetFingerprint = buildRouteReplyTargetFingerprint({
    channel: params.channel,
    to: params.to,
    accountId: params.accountId,
    threadId: params.threadId,
  });
  return JSON.stringify({
    type: "route-reply-no-message-id",
    sessionKey: params.sessionKey ?? "",
    targetFingerprint,
    payloadFingerprint,
  });
};

const tryReserveRouteReplyDedupKey = (key: string): boolean => {
  if (routeReplyDedupeInProgress.has(key)) {
    return false;
  }
  if (routeReplyDedupeCache.peek(key)) {
    return false;
  }
  routeReplyDedupeInProgress.add(key);
  return true;
};

const tryReserveRouteReplyWithoutMessageIdDedupKey = (key: string): boolean => {
  if (routeReplyDedupeWithoutMessageIdInProgress.has(key)) {
    return false;
  }
  if (routeReplyDedupeWithoutMessageIdCache.peek(key)) {
    return false;
  }
  routeReplyDedupeWithoutMessageIdInProgress.add(key);
  return true;
};

const releaseRouteReplyDedupKey = (key: string): void => {
  routeReplyDedupeInProgress.delete(key);
};

const releaseRouteReplyWithoutMessageIdDedupKey = (key: string): void => {
  routeReplyDedupeWithoutMessageIdInProgress.delete(key);
};

export function resetRouteReplyDedupeForTests(): void {
  routeReplyDedupeCache.clear();
  routeReplyDedupeInProgress.clear();
  routeReplyDedupeWithoutMessageIdCache.clear();
  routeReplyDedupeWithoutMessageIdInProgress.clear();
}

function loadDeliverRuntime() {
  deliverRuntimePromise ??= import("../../infra/outbound/deliver-runtime.js");
  return deliverRuntimePromise;
}

export type RouteReplyParams = {
  /** The reply payload to send. */
  payload: ReplyPayload;
  /** The originating channel type (telegram, slack, etc). */
  channel: OriginatingChannelType;
  /** The destination chat/channel/user ID. */
  to: string;
  /** Session key for deriving agent identity defaults (multi-agent). */
  sessionKey?: string;
  /** Provider account id (multi-account). */
  accountId?: string;
  /** Thread id for replies (Telegram topic id or Matrix thread event id). */
  threadId?: string | number;
  /** Config for provider-specific settings. */
  cfg: OpenClawConfig;
  /** Optional abort signal for cooperative cancellation. */
  abortSignal?: AbortSignal;
  /** Mirror reply into session transcript (default: true when sessionKey is set). */
  mirror?: boolean;
  /** Source inbound message id for dedupe in shared sessions. */
  messageId?: string;
  /** Whether this message is being sent in a group/channel context */
  isGroup?: boolean;
  /** Group or channel identifier for correlation with received events */
  groupId?: string;
};

export type RouteReplyResult = {
  /** Whether the reply was sent successfully. */
  ok: boolean;
  /** Optional message ID from the provider. */
  messageId?: string;
  /** Error message if the send failed. */
  error?: string;
};

/**
 * Routes a reply payload to the specified channel.
 *
 * This function provides a unified interface for sending messages to any
 * supported provider. It's used by the followup queue to route replies
 * back to the originating channel when OriginatingChannel/OriginatingTo
 * are set.
 */
export async function routeReply(params: RouteReplyParams): Promise<RouteReplyResult> {
  const { payload, channel, to, accountId, threadId, cfg, abortSignal } = params;
  if (shouldSuppressReasoningPayload(payload)) {
    return { ok: true };
  }
  const messageId = params.messageId?.trim();
  const normalizedChannel = normalizeMessageChannel(channel);
  const resolvedAgentId = params.sessionKey
    ? resolveSessionAgentId({
        sessionKey: params.sessionKey,
        config: cfg,
      })
    : undefined;

  // Debug: `pnpm test src/auto-reply/reply/route-reply.test.ts`
  const responsePrefix = params.sessionKey
    ? resolveEffectiveMessagesConfig(
        cfg,
        resolvedAgentId ?? resolveSessionAgentId({ config: cfg }),
        { channel: normalizedChannel, accountId },
      ).responsePrefix
    : cfg.messages?.responsePrefix === "auto"
      ? undefined
      : cfg.messages?.responsePrefix;
  const normalized = normalizeReplyPayload(payload, {
    responsePrefix,
  });
  if (!normalized) {
    return { ok: true };
  }

  let dedupeKey: string | undefined;
  let fallbackDedupeKey: string | undefined;
  if (messageId) {
    dedupeKey = buildRouteReplyDedupeKey({
      messageId,
      sessionKey: params.sessionKey,
      channel: normalizedChannel ?? channel,
      to: to.trim(),
      accountId,
      threadId,
      payload: normalized,
    });
    if (!tryReserveRouteReplyDedupKey(dedupeKey)) {
      return { ok: true };
    }
  } else if (params.sessionKey) {
    fallbackDedupeKey = buildRouteReplyDedupeWithoutMessageIdKey({
      sessionKey: params.sessionKey,
      channel: normalizedChannel ?? channel,
      to: to.trim(),
      accountId,
      threadId,
      payload: normalized,
    });
    if (!tryReserveRouteReplyWithoutMessageIdDedupKey(fallbackDedupeKey)) {
      return { ok: true };
    }
  }

  let text = normalized.text ?? "";
  let mediaUrls = (normalized.mediaUrls?.filter(Boolean) ?? []).length
    ? (normalized.mediaUrls?.filter(Boolean) as string[])
    : normalized.mediaUrl
      ? [normalized.mediaUrl]
      : [];
  const replyToId = normalized.replyToId;

  // Skip empty replies.
  if (!text.trim() && mediaUrls.length === 0) {
    if (dedupeKey) {
      releaseRouteReplyDedupKey(dedupeKey);
    }
    if (fallbackDedupeKey) {
      releaseRouteReplyWithoutMessageIdDedupKey(fallbackDedupeKey);
    }
    return { ok: true };
  }

  if (channel === INTERNAL_MESSAGE_CHANNEL) {
    return {
      ok: false,
      error: "Webchat routing not supported for queued replies",
    };
  }

  const channelId = normalizeChannelId(channel) ?? null;
  if (!channelId) {
    return { ok: false, error: `Unknown channel: ${String(channel)}` };
  }
  if (abortSignal?.aborted) {
    return { ok: false, error: "Reply routing aborted" };
  }

  const resolvedReplyToId =
    replyToId ??
    (channelId === "slack" && threadId != null && threadId !== "" ? String(threadId) : undefined);
  const resolvedThreadId = channelId === "slack" ? null : (threadId ?? null);

  try {
    // Provider docking: this is an execution boundary (we're about to send).
    // Keep the module cheap to import by loading outbound plumbing lazily.
    const { deliverOutboundPayloads } = await loadDeliverRuntime();
    const outboundSession = buildOutboundSessionContext({
      cfg,
      agentId: resolvedAgentId,
      sessionKey: params.sessionKey,
    });
    const results = await deliverOutboundPayloads({
      cfg,
      channel: channelId,
      to,
      accountId: accountId ?? undefined,
      payloads: [normalized],
      replyToId: resolvedReplyToId ?? null,
      threadId: resolvedThreadId,
      session: outboundSession,
      abortSignal,
      mirror:
        params.mirror !== false && params.sessionKey
          ? {
              sessionKey: params.sessionKey,
              agentId: resolvedAgentId,
              text,
              mediaUrls,
              ...(params.isGroup != null ? { isGroup: params.isGroup } : {}),
              ...(params.groupId ? { groupId: params.groupId } : {}),
            }
          : undefined,
    });

    const last = results.at(-1);
    if (dedupeKey) {
      routeReplyDedupeCache.check(dedupeKey);
    } else if (fallbackDedupeKey) {
      routeReplyDedupeWithoutMessageIdCache.check(fallbackDedupeKey);
    }
    return { ok: true, messageId: last?.messageId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Failed to route reply to ${channel}: ${message}`,
    };
  } finally {
    if (dedupeKey) {
      releaseRouteReplyDedupKey(dedupeKey);
    }
    if (fallbackDedupeKey) {
      releaseRouteReplyWithoutMessageIdDedupKey(fallbackDedupeKey);
    }
  }
}

/**
 * Checks if a channel type is routable via routeReply.
 *
 * Some channels (webchat) require special handling and cannot be routed through
 * this generic interface.
 */
export function isRoutableChannel(
  channel: OriginatingChannelType | undefined,
): channel is Exclude<OriginatingChannelType, typeof INTERNAL_MESSAGE_CHANNEL> {
  if (!channel || channel === INTERNAL_MESSAGE_CHANNEL) {
    return false;
  }
  return normalizeChannelId(channel) !== null;
}
