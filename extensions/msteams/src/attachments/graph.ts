import { fetchWithSsrFGuard, type SsrFPolicy } from "openclaw/plugin-sdk/msteams";
import { getMSTeamsRuntime } from "../runtime.js";
import { downloadMSTeamsAttachments } from "./download.js";
import { downloadAndStoreMSTeamsRemoteMedia } from "./remote-media.js";
import {
  applyAuthorizationHeaderForUrl,
  GRAPH_ROOT,
  inferPlaceholder,
  isRecord,
  isUrlAllowed,
  type MSTeamsAttachmentFetchPolicy,
  normalizeContentType,
  resolveMediaSsrfPolicy,
  resolveAttachmentFetchPolicy,
  resolveRequestUrl,
  safeFetchWithPolicy,
} from "./shared.js";
import type {
  MSTeamsAccessTokenProvider,
  MSTeamsAttachmentLike,
  MSTeamsGraphMediaResult,
  MSTeamsInboundMedia,
} from "./types.js";

type GraphHostedContent = {
  id?: string | null;
  contentType?: string | null;
  contentBytes?: string | null;
};

type GraphAttachment = {
  id?: string | null;
  contentType?: string | null;
  contentUrl?: string | null;
  name?: string | null;
  thumbnailUrl?: string | null;
  content?: unknown;
};

function readNestedString(value: unknown, keys: Array<string | number>): string | undefined {
  let current: unknown = value;
  for (const key of keys) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[key as keyof typeof current];
  }
  return typeof current === "string" && current.trim() ? current.trim() : undefined;
}

function normalizeAadConversationId(value: string): string | undefined {
  const trimmed = value.trim().split(";")[0] ?? "";
  if (!trimmed) {
    return undefined;
  }
  if (!trimmed.startsWith("a:")) {
    return trimmed;
  }

  const encoded = trimmed.slice(2);
  if (!encoded) {
    return `19:${encoded}@unq.gbl.spaces`;
  }

  const toHex = (decoded: Buffer) => decoded.toString("hex").toLowerCase();
  const formatGuid = (hex: string): string =>
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  const decodeBase64Url = (input: string): Buffer | undefined => {
    try {
      const decoded = Buffer.from(input, "base64url");
      return decoded.length === 0 ? undefined : decoded;
    } catch {
      // Fall through to manual normalization for compatibility with older Node runtimes.
    }

    const normalized = input
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .replace(/[^A-Za-z0-9+/=]/g, "");
    const padded =
      normalized.length % 4 === 0
        ? normalized
        : `${normalized}${"=".repeat(4 - (normalized.length % 4))}`;
    try {
      const decoded = Buffer.from(padded, "base64");
      return decoded.length === 0 ? undefined : decoded;
    } catch {
      return undefined;
    }
  };

  const decoded = decodeBase64Url(encoded);
  if (decoded && decoded.length >= 16) {
    const hex = toHex(decoded);
    if (hex.length >= 32) {
      return `19:${formatGuid(hex)}@unq.gbl.spaces`;
    }
  }

  return `19:${encoded}@unq.gbl.spaces`;
}

export function buildMSTeamsGraphMessageUrls(params: {
  conversationType?: string | null;
  conversationId?: string | null;
  messageId?: string | null;
  replyToId?: string | null;
  conversationMessageId?: string | null;
  channelData?: unknown;
}): string[] {
  const conversationType = params.conversationType?.trim().toLowerCase() ?? "";
  const messageIdCandidates = new Set<string>();
  const pushCandidate = (value: string | null | undefined) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    if (trimmed) {
      messageIdCandidates.add(trimmed);
    }
  };

  pushCandidate(params.messageId);
  pushCandidate(params.conversationMessageId);
  pushCandidate(readNestedString(params.channelData, ["messageId"]));
  pushCandidate(readNestedString(params.channelData, ["teamsMessageId"]));

  const replyToId = typeof params.replyToId === "string" ? params.replyToId.trim() : "";

  if (conversationType === "channel") {
    const teamId =
      readNestedString(params.channelData, ["team", "id"]) ??
      readNestedString(params.channelData, ["teamId"]);
    const channelId =
      readNestedString(params.channelData, ["channel", "id"]) ??
      readNestedString(params.channelData, ["channelId"]) ??
      readNestedString(params.channelData, ["teamsChannelId"]);
    if (!teamId || !channelId) {
      return [];
    }
    const urls: string[] = [];
    if (replyToId) {
      for (const candidate of messageIdCandidates) {
        if (candidate === replyToId) {
          continue;
        }
        urls.push(
          `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(replyToId)}/replies/${encodeURIComponent(candidate)}`,
        );
      }
    }
    if (messageIdCandidates.size === 0 && replyToId) {
      messageIdCandidates.add(replyToId);
    }
    for (const candidate of messageIdCandidates) {
      urls.push(
        `${GRAPH_ROOT}/teams/${encodeURIComponent(teamId)}/channels/${encodeURIComponent(channelId)}/messages/${encodeURIComponent(candidate)}`,
      );
    }
    return Array.from(new Set(urls));
  }

  const chatId = normalizeAadConversationId(
    params.conversationId?.trim() ||
      readNestedString(params.channelData, ["chatId"]) ||
      readNestedString(params.channelData, ["chat", "id"]) ||
      "",
  );
  if (!chatId) {
    return [];
  }
  if (messageIdCandidates.size === 0 && replyToId) {
    messageIdCandidates.add(replyToId);
  }
  const urls = Array.from(messageIdCandidates).map(
    (candidate) =>
      `${GRAPH_ROOT}/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(candidate)}`,
  );
  return Array.from(new Set(urls));
}

async function fetchGraphCollection<T>(params: {
  url: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ status: number; items: T[] }> {
  const fetchFn = params.fetchFn ?? fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: params.url,
    fetchImpl: fetchFn,
    init: {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    },
    policy: params.ssrfPolicy,
    auditContext: "msteams.graph.collection",
  });
  try {
    const status = response.status;
    if (!response.ok) {
      return { status, items: [] };
    }
    try {
      const data = (await response.json()) as { value?: T[] };
      return { status, items: Array.isArray(data.value) ? data.value : [] };
    } catch {
      return { status, items: [] };
    }
  } finally {
    await release();
  }
}

async function fetchHostedContentValue(params: {
  id: string;
  messageUrl: string;
  accessToken: string;
  fetchFn?: typeof fetch;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ status: number; buffer?: Buffer; contentType?: string }> {
  const fetchFn = params.fetchFn ?? fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: `${params.messageUrl}/hostedContents/${encodeURIComponent(params.id)}/$value`,
    fetchImpl: fetchFn,
    init: {
      headers: { Authorization: `Bearer ${params.accessToken}` },
    },
    policy: params.ssrfPolicy,
    auditContext: "msteams.graph.hosted-content",
  });
  try {
    const status = response.status;
    if (!response.ok) {
      return { status };
    }
    const arrayBuffer = await response.arrayBuffer();
    return {
      status,
      buffer: Buffer.from(arrayBuffer),
      contentType: response.headers.get("content-type") ?? undefined,
    };
  } finally {
    await release();
  }
}

function normalizeGraphAttachment(att: GraphAttachment): MSTeamsAttachmentLike {
  let content: unknown = att.content;
  if (typeof content === "string") {
    try {
      content = JSON.parse(content);
    } catch {
      // Keep as raw string if it's not JSON.
    }
  }
  return {
    contentType: normalizeContentType(att.contentType) ?? undefined,
    contentUrl: att.contentUrl ?? undefined,
    name: att.name ?? undefined,
    thumbnailUrl: att.thumbnailUrl ?? undefined,
    content,
  };
}

/**
 * Download all hosted content from a Teams message (images, documents, etc.).
 * Renamed from downloadGraphHostedImages to support all file types.
 */
async function downloadGraphHostedContent(params: {
  accessToken: string;
  messageUrl: string;
  maxBytes: number;
  fetchFn?: typeof fetch;
  preserveFilenames?: boolean;
  ssrfPolicy?: SsrFPolicy;
}): Promise<{ media: MSTeamsInboundMedia[]; status: number; count: number }> {
  const hosted = await fetchGraphCollection<GraphHostedContent>({
    url: `${params.messageUrl}/hostedContents`,
    accessToken: params.accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy: params.ssrfPolicy,
  });
  if (hosted.items.length === 0) {
    return { media: [], status: hosted.status, count: 0 };
  }

  const out: MSTeamsInboundMedia[] = [];
  for (const item of hosted.items) {
    let buffer: Buffer | undefined;
    let headerContentType = item.contentType ?? undefined;
    try {
      if (typeof item.id !== "string" || !item.id.trim()) {
        continue;
      }

      const valueResponse = await fetchHostedContentValue({
        id: item.id,
        messageUrl: params.messageUrl,
        accessToken: params.accessToken,
        fetchFn: params.fetchFn,
        ssrfPolicy: params.ssrfPolicy,
      });
      if (!valueResponse.buffer) {
        continue;
      }
      buffer = valueResponse.buffer;
      if (valueResponse.contentType) {
        headerContentType = valueResponse.contentType;
      }
    } catch {
      continue;
    }
    if (buffer.byteLength > params.maxBytes) {
      continue;
    }
    const mime = await getMSTeamsRuntime().media.detectMime({
      buffer,
      headerMime: headerContentType,
    });
    // Download any file type, not just images
    try {
      const saved = await getMSTeamsRuntime().channel.media.saveMediaBuffer(
        buffer,
        mime ?? item.contentType ?? undefined,
        "inbound",
        params.maxBytes,
      );
      out.push({
        path: saved.path,
        contentType: saved.contentType,
        placeholder: inferPlaceholder({ contentType: saved.contentType }),
      });
    } catch {
      // Ignore save failures.
    }
  }

  return { media: out, status: hosted.status, count: hosted.items.length };
}

export async function downloadMSTeamsGraphMedia(params: {
  messageUrl?: string | null;
  tokenProvider?: MSTeamsAccessTokenProvider;
  maxBytes: number;
  allowHosts?: string[];
  authAllowHosts?: string[];
  fetchFn?: typeof fetch;
  /** When true, embeds original filename in stored path for later extraction. */
  preserveFilenames?: boolean;
}): Promise<MSTeamsGraphMediaResult> {
  if (!params.messageUrl || !params.tokenProvider) {
    return { media: [] };
  }
  const policy: MSTeamsAttachmentFetchPolicy = resolveAttachmentFetchPolicy({
    allowHosts: params.allowHosts,
    authAllowHosts: params.authAllowHosts,
  });
  const ssrfPolicy = resolveMediaSsrfPolicy(policy.allowHosts);
  const messageUrl = params.messageUrl;
  let accessToken: string;
  try {
    accessToken = await params.tokenProvider.getAccessToken("https://graph.microsoft.com");
  } catch {
    return { media: [], messageUrl, tokenError: true };
  }

  // Fetch the full message to get SharePoint file attachments (for group chats)
  const fetchFn = params.fetchFn ?? fetch;
  const sharePointMedia: MSTeamsInboundMedia[] = [];
  const downloadedReferenceUrls = new Set<string>();
  try {
    const { response: msgRes, release } = await fetchWithSsrFGuard({
      url: messageUrl,
      fetchImpl: fetchFn,
      init: {
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      policy: ssrfPolicy,
      auditContext: "msteams.graph.message",
    });
    try {
      if (msgRes.ok) {
        const msgData = (await msgRes.json()) as {
          body?: { content?: string; contentType?: string };
          attachments?: Array<{
            id?: string;
            contentUrl?: string;
            contentType?: string;
            name?: string;
          }>;
        };

        // Extract SharePoint file attachments (contentType: "reference")
        // Download any file type, not just images
        const spAttachments = (msgData.attachments ?? []).filter(
          (a) => a.contentType === "reference" && a.contentUrl && a.name,
        );
        for (const att of spAttachments) {
          const name = att.name ?? "file";

          try {
            // SharePoint URLs need to be accessed via Graph shares API
            const shareUrl = att.contentUrl!;
            if (!isUrlAllowed(shareUrl, policy.allowHosts)) {
              continue;
            }
            const encodedUrl = Buffer.from(shareUrl).toString("base64url");
            const sharesUrl = `${GRAPH_ROOT}/shares/u!${encodedUrl}/driveItem/content`;

            const media = await downloadAndStoreMSTeamsRemoteMedia({
              url: sharesUrl,
              filePathHint: name,
              maxBytes: params.maxBytes,
              contentTypeHint: "application/octet-stream",
              preserveFilenames: params.preserveFilenames,
              ssrfPolicy,
              fetchImpl: async (input, init) => {
                const requestUrl = resolveRequestUrl(input);
                const headers = new Headers(init?.headers);
                applyAuthorizationHeaderForUrl({
                  headers,
                  url: requestUrl,
                  authAllowHosts: policy.authAllowHosts,
                  bearerToken: accessToken,
                });
                return await safeFetchWithPolicy({
                  url: requestUrl,
                  policy,
                  fetchFn,
                  requestInit: {
                    ...init,
                    headers,
                  },
                });
              },
            });
            sharePointMedia.push(media);
            downloadedReferenceUrls.add(shareUrl);
          } catch {
            // Ignore SharePoint download failures.
          }
        }
      }
    } finally {
      await release();
    }
  } catch {
    // Ignore message fetch failures.
  }

  const hosted = await downloadGraphHostedContent({
    accessToken,
    messageUrl,
    maxBytes: params.maxBytes,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
    ssrfPolicy,
  });

  const attachments = await fetchGraphCollection<GraphAttachment>({
    url: `${messageUrl}/attachments`,
    accessToken,
    fetchFn: params.fetchFn,
    ssrfPolicy,
  });

  const normalizedAttachments = attachments.items.map(normalizeGraphAttachment);
  const filteredAttachments =
    sharePointMedia.length > 0
      ? normalizedAttachments.filter((att) => {
          const contentType = att.contentType?.toLowerCase();
          if (contentType !== "reference") {
            return true;
          }
          const url = typeof att.contentUrl === "string" ? att.contentUrl : "";
          if (!url) {
            return true;
          }
          return !downloadedReferenceUrls.has(url);
        })
      : normalizedAttachments;
  const attachmentMedia = await downloadMSTeamsAttachments({
    attachments: filteredAttachments,
    maxBytes: params.maxBytes,
    tokenProvider: params.tokenProvider,
    allowHosts: policy.allowHosts,
    authAllowHosts: policy.authAllowHosts,
    fetchFn: params.fetchFn,
    preserveFilenames: params.preserveFilenames,
  });

  return {
    media: [...sharePointMedia, ...hosted.media, ...attachmentMedia],
    hostedCount: hosted.count,
    attachmentCount: filteredAttachments.length + sharePointMedia.length,
    hostedStatus: hosted.status,
    attachmentStatus: attachments.status,
    messageUrl,
  };
}
