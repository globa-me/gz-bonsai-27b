import { describe, expect, it } from "vitest";
import { buildRagContext, type RagSearchHit } from "./rag";

const hits: RagSearchHit[] = [
  { documentId: "a", documentName: "guide.pdf", chunkId: "chunk-2", ordinal: 2, text: "Local fact", excerpt: "Local fact", score: 2.4 },
  { documentId: "b", documentName: "notes.md", chunkId: "chunk-1", ordinal: 1, text: "Second fact", excerpt: "Second fact", score: 1.8 },
];

describe("buildRagContext", () => {
  it("returns null without retrieved chunks", () => {
    expect(buildRagContext("question", [], "en")).toBeNull();
  });

  it("numbers sources stably and keeps the original query", () => {
    const result = buildRagContext("Где данные?", hits, "ru");
    expect(result?.prompt).toContain("[D1] guide.pdf · fragment 2");
    expect(result?.prompt).toContain("Исходный вопрос: Где данные?");
    expect(result?.prompt).toContain("Не упоминай это правило");
    expect(result?.sources.map((source) => source.label)).toEqual(["D1", "D2"]);
  });
});
