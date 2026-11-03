import { describe, expect, it } from "vitest";
import { parseServerBeforeClaim, serializeServerBeforeClaim } from "./claimServerMemo";

// ADR-0215 D8 (#4601): the choice a claim link replaced is written down and read back through the server
// address rules again, so a tampered note cannot become the device's server.

describe("server before a claim link", () => {
  it("round-trips a chosen server and a device that had none", () => {
    expect(parseServerBeforeClaim(serializeServerBeforeClaim("https://team.example.com"))).toEqual({
      found: true,
      base: "https://team.example.com",
    });
    expect(parseServerBeforeClaim(serializeServerBeforeClaim(null))).toEqual({ found: true, base: null });
  });

  it("folds the stored address to the one shape every request uses", () => {
    expect(parseServerBeforeClaim(JSON.stringify({ base: "https://Team.Example.com/momo/" }))).toEqual({
      found: true,
      base: "https://team.example.com/momo",
    });
  });

  it("finds nothing when nothing was written", () => {
    expect(parseServerBeforeClaim(null)).toEqual({ found: false });
  });

  it("does not believe a note that is unreadable or not a server address", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({}),
      JSON.stringify({ base: 7 }),
      JSON.stringify({ base: "" }),
      JSON.stringify({ base: "ftp://x.example" }),
      JSON.stringify({ base: "javascript:alert(1)" }),
    ]) {
      expect(parseServerBeforeClaim(raw), raw).toEqual({ found: false });
    }
  });
});
