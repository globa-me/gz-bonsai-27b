import { describe, expect, it } from "vitest";
import { buildRagContext, groupDocumentSources, type RagSearchHit } from "./rag";

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
    expect(result?.prompt).toContain("[D1] guide.pdf · фрагмент 2");
    expect(result?.prompt).toContain("Исходный вопрос: Где данные?");
    expect(result?.prompt).toContain("Не упоминай это правило");
    expect(result?.sources.map((source) => source.label)).toEqual(["D1", "D2"]);
  });

  it("uses one citation label for several excerpts from the same file", () => {
    const result = buildRagContext("summarize", [hits[0], { ...hits[0], chunkId: "chunk-3", ordinal: 3 }], "en");
    expect(result?.sources.map((source) => source.label)).toEqual(["D1", "D1"]);
    expect(groupDocumentSources(result?.sources ?? [])).toHaveLength(1);
    expect(result?.prompt).toContain("Available source labels: [D1]");
    expect(result?.prompt).not.toContain("[D2]");
  });

  it("identifies beginning and end excerpts in a long document", () => {
    const result = buildRagContext("opening and closing markers", [
      { ...hits[0], ordinal: 1, chunkCount: 21, text: "TOPAZ-311" },
      { ...hits[0], ordinal: 21, chunkId: "chunk-21", chunkCount: 21, text: "OPAL-722" },
    ], "en");
    expect(result?.prompt).toContain("fragment 1 of 21 (beginning)");
    expect(result?.prompt).toContain("fragment 21 of 21 (end)");
  });
});
