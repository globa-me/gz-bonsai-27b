import { describe, expect, it } from "vitest";
import { classifyDroppedPaths } from "./fileDrop";

describe("classifyDroppedPaths", () => {
  it("routes PDF and DOCX to local RAG", () => {
    expect(classifyDroppedPaths(["/tmp/guide.PDF", "/tmp/notes.docx"])).toEqual({
      ragPaths: ["/tmp/guide.PDF", "/tmp/notes.docx"],
      attachmentPaths: [],
    });
  });

  it("keeps images, text and code as prompt attachments", () => {
    expect(classifyDroppedPaths(["/tmp/photo.webp", "/tmp/context.md", "/tmp/app.ts"])).toEqual({
      ragPaths: [],
      attachmentPaths: ["/tmp/photo.webp", "/tmp/context.md", "/tmp/app.ts"],
    });
  });
});
