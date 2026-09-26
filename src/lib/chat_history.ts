import type { ChatHistoryMessage, TerminalLine } from "../types";

function stripChatPrefix(text: string): string {
  return text.replace(/^\[(你|AI)\]\s*/, "").trim();
}

/** 从终端聊天记录提取最近 N 条对话，供 AI 多轮上下文使用 */
export function buildChatHistoryFromLines(lines: TerminalLine[], maxMessages = 20): ChatHistoryMessage[] {
  const chatLines = lines.filter(
    (line) =>
      line.role === "user" ||
      line.role === "assistant" ||
      line.text.startsWith("[你]") ||
      line.text.startsWith("[AI]"),
  );

  return chatLines.slice(-maxMessages).map((line) => {
    const isUser = line.role === "user" || line.text.startsWith("[你]");
    return {
      role: isUser ? "user" : "assistant",
      content: stripChatPrefix(line.text),
    };
  });
}
