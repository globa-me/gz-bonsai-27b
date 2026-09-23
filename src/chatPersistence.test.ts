import { describe, expect, it } from "vitest";
import { createSaveQueue } from "./chatPersistence";

describe("createSaveQueue", () => {
  it("writes snapshots in order and continues after failure", async () => {
    const written: number[] = [];
    const queue = createSaveQueue(async (value: number) => {
      if (value === 2) throw new Error("storage full");
      written.push(value);
    });
    const first = queue(1);
    const second = queue(2);
    const third = queue(3);
    await expect(first).resolves.toBeUndefined();
    await expect(second).rejects.toThrow("storage full");
    await expect(third).resolves.toBeUndefined();
    expect(written).toEqual([1, 3]);
  });
});
