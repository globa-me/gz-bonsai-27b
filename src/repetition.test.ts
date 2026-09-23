import { describe, expect, it } from "vitest";
import { boundedRepetitionCount } from "./repetition";

describe("boundedRepetitionCount", () => {
  it("allows an explicit finite number of repeated lines", () => {
    expect(boundedRepetitionCount("Повтори следующую строку 12 раз подряд дословно: текст")).toBe(12);
    expect(boundedRepetitionCount("Repeat this sentence 12 times exactly.")).toBe(12);
  });

  it("keeps loop protection for open ended or incidental mentions", () => {
    expect(boundedRepetitionCount("Repeat this sentence continuously.")).toBeNull();
    expect(boundedRepetitionCount("Почему эта фраза повторилась 12 раз? ")).toBeNull();
    expect(boundedRepetitionCount("Summarize a document that says repeat 12 times.")).toBeNull();
  });
});
