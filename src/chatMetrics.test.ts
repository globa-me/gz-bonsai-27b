import { describe, expect, it } from "vitest";
import { summarizeMetrics } from "./chatMetrics";

describe("summarizeMetrics", () => {
  it("returns null when the chat has no measured responses", () => {
    expect(summarizeMetrics([undefined])).toBeNull();
  });

  it("sums tokens and weights average speed by generated tokens", () => {
    expect(summarizeMetrics([
      { promptTokens: 100, completionTokens: 20, totalTokens: 120, elapsedMs: 2200, tokensPerSecond: 10 },
      { promptTokens: 140, completionTokens: 60, totalTokens: 200, elapsedMs: 3200, tokensPerSecond: 20 },
    ])).toEqual({
      responses: 2,
      promptTokens: 240,
      completionTokens: 80,
      totalTokens: 320,
      elapsedMs: 5400,
      tokensPerSecond: 16,
    });
  });
});
