import { describe, expect, it } from "vitest";
import { buildPromptHistory } from "./promptHistory";
import type { ChatMessage } from "./chatStore";

describe("buildPromptHistory", () => {
  it("sends current attachments once and excludes old payloads", () => {
    const old: ChatMessage = { id: "1", role: "user", content: "First", attachments: [{ id: "a", name: "secret.txt", mime: "text/plain", size: 6, kind: "text", content: "SECRET" }] };
    const current: ChatMessage = { id: "2", role: "user", content: "Second", attachments: [{ id: "b", name: "new.txt", mime: "text/plain", size: 3, kind: "text", content: "NEW" }] };
    const history = buildPromptHistory([old], current, "Describe images");
    expect(history[0].content).toBe("First");
    expect(history[1].content).toContain("NEW");
    expect(JSON.stringify(history)).not.toContain("SECRET");
  });

  it("limits older turns and skips failed assistant messages", () => {
    const previous: ChatMessage[] = Array.from({ length: 12 }, (_, index) => ({ id: String(index), role: index % 2 ? "assistant" : "user", content: String(index) }));
    previous.push({ id: "bad", role: "assistant", content: "", error: "failed" });
    const history = buildPromptHistory(previous, { id: "now", role: "user", content: "Now" }, "Describe images");
    expect(history).toHaveLength(9);
    expect(JSON.stringify(history)).not.toContain("failed");
  });
});
