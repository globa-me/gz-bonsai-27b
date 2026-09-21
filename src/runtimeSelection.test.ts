import { describe, expect, it } from "vitest";
import { resolveRuntimePath } from "./runtimeSelection";

describe("resolveRuntimePath", () => {
  it("rebinds a managed model to the runtime inside the current app bundle", () => {
    expect(resolveRuntimePath(
      "/Volumes/Old/GZ Bonsai 27B.app/Contents/Resources/runtime/llama-server",
      "/Users/test/Library/Application Support/com.bonsai.desktop/managed/models/bonsai/model.gguf",
      "/Applications/GZ Bonsai 27B.app/Contents/Resources/runtime/llama-server",
      ["/Users/test/Library/Application Support/com.bonsai.desktop/managed/models/bonsai/model.gguf"],
    )).toBe("/Applications/GZ Bonsai 27B.app/Contents/Resources/runtime/llama-server");
  });

  it("preserves an explicitly selected custom runtime for a custom model", () => {
    expect(resolveRuntimePath(
      "/Users/test/bin/custom-llama-server",
      "/Users/test/Models/custom.gguf",
      "/Applications/GZ Bonsai 27B.app/Contents/Resources/runtime/llama-server",
      ["/Users/test/Library/Application Support/com.bonsai.desktop/managed/models/bonsai/model.gguf"],
    )).toBe("/Users/test/bin/custom-llama-server");
  });
});
