import { describe, expect, it } from "vitest";
import { workConsoleSessionPath } from "./model";

describe("workConsoleSessionPath", () => {
  it("makes the selected session linkable and normalizes its identity", () => {
    expect(workConsoleSessionPath("ABC/DEF")).toBe("/work?session=abc%2Fdef");
  });
});
