import { extractText } from "./chat/message-extract.ts";
import type { ChatEventPayload } from "./controllers/chat.ts";

const NO_REPLY_PATTERN = /^\s*NO_REPLY\s*$/;

function shouldReloadForFinalMessage(message: Record<string, unknown>) {
  const role = typeof message.role === "string" ? message.role.toLowerCase() : "";
  if (role && role !== "assistant") {
    return true;
  }
  const text = extractText(message);
  if (!text) {
    return true;
  }
  return !NO_REPLY_PATTERN.test(text);
}

export function shouldReloadHistoryForFinalEvent(payload?: ChatEventPayload): boolean {
  if (!payload || payload.state !== "final") {
    return false;
  }
  if (!payload.message || typeof payload.message !== "object") {
    return true;
  }
  const message = payload.message as Record<string, unknown>;
  return shouldReloadForFinalMessage(message);
}
