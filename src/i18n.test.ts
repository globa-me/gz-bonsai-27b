import { describe, expect, it } from "vitest";
import { messages, translate } from "./i18n";

describe("localization", () => {
  it("keeps Russian and English catalogs in sync", () => {
    expect(Object.keys(messages.ru).sort()).toEqual(Object.keys(messages.en).sort());
  });

  it("returns a translated value", () => {
    expect(translate("en", "start")).toBe("Start model");
  });
});
