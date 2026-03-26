import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../config/config.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";

const copyFileWithinRootMock = vi.hoisted(() => vi.fn());

vi.mock("../config/config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/config.js")>();
  return {
    ...actual,
    loadConfig: vi.fn(),
  };
});

vi.mock("../infra/fs-safe.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/fs-safe.js")>();
  return {
    ...actual,
    copyFileWithinRoot: (...args: unknown[]) => copyFileWithinRootMock(...args),
  };
});

const baseTelegramConfig = {
  channels: { telegram: {} },
  messages: { groupChat: { mentionPatterns: [] } },
  agents: {
    list: [
      {
        id: "main",
        default: true,
        workspace: "/tmp/workspace-main",
      },
      {
        id: "dev",
        workspace: "/tmp/workspace-dev",
        tools: { fs: { workspaceOnly: true } },
      },
    ],
    defaults: {
      model: "anthropic/claude-opus-4-5",
      workspace: "/tmp/workspace-main",
    },
  },
} as never;

const noWorkspaceOnlyConfig = {
  ...baseTelegramConfig,
  agents: {
    ...baseTelegramConfig.agents,
    list: [
      ...baseTelegramConfig.agents.list.filter((agent) => agent.id !== "dev"),
      {
        id: "dev",
        workspace: "/tmp/workspace-dev",
        tools: { fs: { workspaceOnly: false } },
      },
    ],
  },
} as never;

describe("buildTelegramMessageContext inbound media workspace staging", () => {
  beforeEach(() => {
    copyFileWithinRootMock.mockReset();
    vi.mocked(loadConfig).mockReset();
    vi.mocked(loadConfig).mockReturnValue(baseTelegramConfig);
  });

  const buildForumMessage = () => ({
    message_id: 1,
    chat: {
      id: -1001234567890,
      type: "supergroup" as const,
      title: "OpenClaw",
      is_forum: true,
    },
    date: 1_700_000_000,
    text: "@bot hello",
    message_thread_id: 7,
    from: { id: 42, first_name: "Alice" },
  });

  const buildContextForTopic = async (params: {
    allMedia: Array<{ path: string; contentType?: string }>;
    replyMedia?: Array<{ path: string; contentType?: string }>;
    cfg?: unknown;
  }) => {
    return await buildTelegramMessageContextForTest({
      message: buildForumMessage(),
      allMedia: params.allMedia,
      replyMedia: params.replyMedia,
      options: { forceWasMentioned: true },
      cfg: (params.cfg ?? baseTelegramConfig) as never,
      resolveGroupActivation: () => true,
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false },
        topicConfig: { agentId: "dev", systemPrompt: "I am dev" },
      }),
    });
  };

  it("stages inbound and reply media into the target agent workspace when workspaceOnly is enabled", async () => {
    copyFileWithinRootMock.mockResolvedValue(undefined);

    const inboundMedia = [
      { path: "/tmp/openclaw/media/inbound/photo-1.png", contentType: "image/png" },
      { path: "/tmp/openclaw/media/inbound/photo-2.jpg", contentType: "image/jpeg" },
    ];
    const replyMedia = [
      { path: "/tmp/openclaw/media/inbound/reply-1.png", contentType: "image/png" },
    ];
    const ctx = await buildContextForTopic({
      allMedia: inboundMedia,
      replyMedia,
      cfg: baseTelegramConfig,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MediaPaths).toEqual([
      path.posix.join("media", "inbound", "photo-1.png"),
      path.posix.join("media", "inbound", "photo-2.jpg"),
      path.posix.join("media", "inbound", "reply-1.png"),
    ]);
    expect(copyFileWithinRootMock).toHaveBeenCalledTimes(3);
    expect(copyFileWithinRootMock).toHaveBeenCalledWith({
      sourcePath: "/tmp/openclaw/media/inbound/photo-1.png",
      rootDir: "/tmp/workspace-dev",
      relativePath: path.posix.join("media", "inbound", "photo-1.png"),
    });
  });

  it("does not stage media when workspaceOnly is not enabled for the target agent", async () => {
    vi.mocked(loadConfig).mockReturnValue(noWorkspaceOnlyConfig);
    copyFileWithinRootMock.mockResolvedValue(undefined);
    const inboundMedia = [
      { path: "/tmp/openclaw/media/inbound/photo-1.png", contentType: "image/png" },
    ];

    const ctx = await buildContextForTopic({
      allMedia: inboundMedia,
      cfg: noWorkspaceOnlyConfig,
    });

    expect(ctx).not.toBeNull();
    expect(ctx?.ctxPayload?.MediaPaths).toEqual(["/tmp/openclaw/media/inbound/photo-1.png"]);
    expect(copyFileWithinRootMock).not.toHaveBeenCalled();
  });
});
