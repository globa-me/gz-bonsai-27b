import { describe, expect, it } from "vitest";
import { normalizeChatTitle, renameChatSession, type ChatSession } from "./chatStore";

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
});
