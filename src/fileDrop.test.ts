import { describe, expect, it } from "vitest";
import { classifyDroppedPaths } from "./fileDrop";

describe("classifyDroppedPaths", () => {
  it("routes PDF and DOCX to local RAG", () => {
    expect(classifyDroppedPaths(["/tmp/guide.PDF", "/tmp/notes.docx"])).toEqual({
      ragPaths: ["/tmp/guide.PDF", "/tmp/notes.docx"],
      attachmentPaths: [],
      choicePaths: [],
    });
  });

  it("asks where to attach text while keeping images and code in the prompt", () => {
    expect(classifyDroppedPaths(["/tmp/photo.webp", "/tmp/context.md", "/tmp/app.ts"])).toEqual({
      ragPaths: [],
      attachmentPaths: ["/tmp/photo.webp", "/tmp/app.ts"],
      choicePaths: ["/tmp/context.md"],
    });
  });
});
