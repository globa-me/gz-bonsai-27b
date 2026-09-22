import { describe, expect, it } from "vitest";
import { inferSearchFreshness, resolveSearchCountry, searchErrorCode } from "./webSearch";

describe("web search request helpers", () => {
  it("recognizes freshness in Russian and English queries", () => {
    expect(inferSearchFreshness("Новости Казахстана за последние две недели")).toBe("pm");
    expect(inferSearchFreshness("What happened today?")).toBe("pd");
    expect(inferSearchFreshness("Что такое Digital Bridge?")).toBeUndefined();
  });

  it("prefers Kazakhstan for the local timezone", () => {
    expect(resolveSearchCountry("ru-RU", "Asia/Almaty")).toBe("KZ");
    expect(resolveSearchCountry("en-US", "America/New_York")).toBe("US");
  });

  it("extracts stable backend error codes", () => {
    expect(searchErrorCode("SEARCH_QUOTA: limit reached")).toBe("SEARCH_QUOTA");
    expect(searchErrorCode(new Error("network"))).toBe("SEARCH_UNKNOWN");
  });
});
