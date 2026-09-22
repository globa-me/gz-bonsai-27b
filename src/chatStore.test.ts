import { describe, expect, it } from "vitest";
import { normalizeChatTitle, renameChatSession, restoreAutoChatTitle, sanitizeChatsForStorage, type ChatSession } from "./chatStore";

const chat: ChatSession = {
  id: "chat-1",
  title: "New chat",
  createdAt: 1,
  updatedAt: 2,
  messages: [],
  titleSource: "auto",
};

describe("chat titles", () => {
  it("normalizes whitespace and limits titles", () => {
    expect(normalizeChatTitle(`  hello   ${"x".repeat(100)}  `)).toBe(`hello ${"x".repeat(74)}`);
  });

  it("marks a renamed chat as user titled without changing its order", () => {
    expect(renameChatSession(chat, "  My chat  ")).toEqual({
      ...chat,
      title: "My chat",
      titleSource: "user",
    });
  });

  it("keeps the old title when the new title is empty", () => {
    expect(renameChatSession(chat, "   ")).toBe(chat);
  });

  it("restores a fuller automatic title from the first user message", () => {
    const prompt = "Какой код проекта указан в PDF и сколько символов есть в приложенном документе?";
    expect(restoreAutoChatTitle({
      ...chat,
      title: prompt.slice(0, 42),
      messages: [{ id: "prompt-1", role: "user", content: prompt }],
    }).title).toBe(prompt);
  });

  it("does not replace a title explicitly chosen by the user", () => {
    const renamed = { ...chat, title: "Мой проект", titleSource: "user" as const, messages: [{ id: "prompt-1", role: "user" as const, content: "Очень длинный исходный запрос" }] };
    expect(restoreAutoChatTitle(renamed)).toBe(renamed);
  });

  it("never persists web search result payloads", () => {
    const stored = sanitizeChatsForStorage([{
      ...chat,
      messages: [{
        id: "answer-1",
        role: "assistant",
        content: "Answer [1]",
        sources: [{ title: "Source", url: "https://example.com", snippet: "Raw provider data", provider: "brave" }],
      }],
    }]);
    expect(stored[0].messages[0].content).toBe("Answer [1]");
    expect(stored[0].messages[0].sources).toBeUndefined();
  });
});
