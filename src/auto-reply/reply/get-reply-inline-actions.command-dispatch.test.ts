import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillCommandSpec } from "../../agents/skills.js";
import type { OpenClawConfig } from "../../config/config.js";
import type { TemplateContext } from "../templating.js";
import { clearInlineDirectives } from "./get-reply-directives-utils.js";
import { buildTestCtx } from "./test-ctx.js";
import type { TypingController } from "./typing.js";

const toolingMocks = vi.hoisted(() => ({
  createOpenClawTools: vi.fn(),
}));
const skillCommandMocks = vi.hoisted(() => ({
  listSkillCommandsForWorkspace: vi.fn(),
}));

vi.mock("../../agents/openclaw-tools.js", () => ({
  createOpenClawTools: toolingMocks.createOpenClawTools,
}));
vi.mock("../skill-commands.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../skill-commands.js")>()),
  listSkillCommandsForWorkspace: skillCommandMocks.listSkillCommandsForWorkspace,
}));

const { handleInlineActions } = await import("./get-reply-inline-actions.js");
type HandleInlineActionsInput = Parameters<typeof handleInlineActions>[0];

const createTypingController = (): TypingController => ({
  onReplyStart: async () => {},
  startTypingLoop: async () => {},
  startTypingOnText: async () => {},
  refreshTypingTtl: () => {},
  isActive: () => false,
  markRunComplete: () => {},
  markDispatchIdle: () => {},
  cleanup: vi.fn(),
});

const createHandleInlineActionsInput = (params: {
  ctx: ReturnType<typeof buildTestCtx>;
  typing: TypingController;
  cleanedBody: string;
  command?: Partial<HandleInlineActionsInput["command"]>;
  overrides?: Omit<
    Partial<HandleInlineActionsInput>,
    "ctx" | "sessionCtx" | "typing" | "command" | "cfg" | "cleanedBody"
  >;
}): HandleInlineActionsInput => {
  const baseCommand: HandleInlineActionsInput["command"] = {
    surface: "telegram",
    channel: "telegram",
    channelId: "telegram",
    ownerList: [],
    senderIsOwner: true,
    isAuthorizedSender: true,
    senderId: "sender-1",
    abortKey: "telegram:sender-1",
    rawBodyNormalized: params.cleanedBody,
    commandBodyNormalized: params.cleanedBody,
    from: "telegram:999",
    to: "telegram:999",
  };
  return {
    ctx: params.ctx,
    sessionCtx: params.ctx as unknown as TemplateContext,
    cfg: {} as OpenClawConfig,
    agentId: "main",
    sessionKey: "s:main",
    workspaceDir: "/tmp",
    isGroup: false,
    typing: params.typing,
    allowTextCommands: true,
    inlineStatusRequested: false,
    command: {
      ...baseCommand,
      ...params.command,
    },
    directives: clearInlineDirectives(params.cleanedBody),
    cleanedBody: params.cleanedBody,
    elevatedEnabled: false,
    elevatedAllowed: false,
    elevatedFailures: [],
    defaultActivation: () => "always",
    resolvedThinkLevel: undefined,
    resolvedVerboseLevel: undefined,
    resolvedReasoningLevel: "off",
    resolvedElevatedLevel: "off",
    resolveDefaultThinkingLevel: async () => "off",
    provider: "openai",
    model: "gpt-4o-mini",
    contextTokens: 0,
    sessionScope: "per-sender",
    abortedLastRun: false,
    ...params.overrides,
  };
};

describe("handleInlineActions", () => {
  beforeEach(() => {
    toolingMocks.createOpenClawTools.mockReset();
    skillCommandMocks.listSkillCommandsForWorkspace.mockReset();
  });

  it("passes slash command arguments through tool dispatch", async () => {
    const typing = createTypingController();
    const executeMock = vi.fn(async () => ({ content: "dispatched" }));
    toolingMocks.createOpenClawTools.mockReturnValue([
      {
        name: "sessions_send",
        execute: executeMock,
      } as never,
    ]);

    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:999",
      To: "telegram:999",
      MessageThreadId: "t-1",
      OriginatingTo: "telegram:999",
    });

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "dispatch",
        skillName: "dispatch-skill",
        description: "Command dispatch",
        dispatch: {
          kind: "tool",
          toolName: "sessions_send",
        },
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/dispatch 115",
        command: { commandBodyNormalized: "/dispatch 115" },
        overrides: {
          skillCommands,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "dispatched" } });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("cmd_"),
      expect.objectContaining({
        command: "115",
        commandName: "dispatch",
        skillName: "dispatch-skill",
      }),
    );
  });

  it("loads workspace skill commands when preloaded list is empty", async () => {
    const typing = createTypingController();
    const executeMock = vi.fn(async () => ({ content: "dispatched" }));
    toolingMocks.createOpenClawTools.mockReturnValue([
      {
        name: "sessions_send",
        execute: executeMock,
      } as never,
    ]);
    const workspaceCommands: SkillCommandSpec[] = [
      {
        name: "dispatch",
        skillName: "dispatch-skill",
        description: "Command dispatch",
        dispatch: {
          kind: "tool",
          toolName: "sessions_send",
        },
      },
    ];
    skillCommandMocks.listSkillCommandsForWorkspace.mockReturnValue(workspaceCommands as never);

    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:999",
      To: "telegram:999",
      MessageThreadId: "t-1",
      OriginatingTo: "telegram:999",
    });

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/dispatch 115",
        command: { commandBodyNormalized: "/dispatch 115" },
        overrides: {
          skillCommands: [],
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "dispatched" } });
    expect(skillCommandMocks.listSkillCommandsForWorkspace).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("cmd_"),
      expect.objectContaining({
        command: "115",
        commandName: "dispatch",
        skillName: "dispatch-skill",
      }),
    );
  });

  it("passes bot-suffixed slash command arguments through tool dispatch", async () => {
    const typing = createTypingController();
    const executeMock = vi.fn(async () => ({ content: "dispatched" }));
    toolingMocks.createOpenClawTools.mockReturnValue([
      {
        name: "sessions_send",
        execute: executeMock,
      } as never,
    ]);

    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:999",
      To: "telegram:999",
      MessageThreadId: "t-1",
      OriginatingTo: "telegram:999",
    });

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "dispatch",
        skillName: "dispatch-skill",
        description: "Command dispatch",
        dispatch: {
          kind: "tool",
          toolName: "sessions_send",
        },
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/dispatch@bot 115",
        command: { commandBodyNormalized: "/dispatch@bot 115" },
        overrides: {
          skillCommands,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "dispatched" } });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("cmd_"),
      expect.objectContaining({
        command: "115",
        commandName: "dispatch",
        skillName: "dispatch-skill",
      }),
    );
  });

  it("passes bot-suffixed colon slash command arguments through tool dispatch", async () => {
    const typing = createTypingController();
    const executeMock = vi.fn(async () => ({ content: "dispatched" }));
    toolingMocks.createOpenClawTools.mockReturnValue([
      {
        name: "sessions_send",
        execute: executeMock,
      } as never,
    ]);

    const ctx = buildTestCtx({
      Provider: "telegram",
      Surface: "telegram",
      From: "telegram:999",
      To: "telegram:999",
      MessageThreadId: "t-1",
      OriginatingTo: "telegram:999",
    });

    const skillCommands: SkillCommandSpec[] = [
      {
        name: "dispatch",
        skillName: "dispatch-skill",
        description: "Command dispatch",
        dispatch: {
          kind: "tool",
          toolName: "sessions_send",
        },
      },
    ];

    const result = await handleInlineActions(
      createHandleInlineActionsInput({
        ctx,
        typing,
        cleanedBody: "/dispatch@bot:115",
        command: { commandBodyNormalized: "/dispatch@bot:115" },
        overrides: {
          skillCommands,
        },
      }),
    );

    expect(result).toEqual({ kind: "reply", reply: { text: "dispatched" } });
    expect(executeMock).toHaveBeenCalledTimes(1);
    expect(executeMock).toHaveBeenCalledWith(
      expect.stringContaining("cmd_"),
      expect.objectContaining({
        command: "115",
        commandName: "dispatch",
        skillName: "dispatch-skill",
      }),
    );
  });
});
