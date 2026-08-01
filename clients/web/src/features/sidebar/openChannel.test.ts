import { describe, expect, it } from "vitest";
import { openChannelId } from "./openChannel";

const FIRST = "019F94E3-7A10-79CD-9DEE-208F47EDD9A8";

describe("openChannelId", () => {
  it("reads the channel out of /c/:id", () => {
    expect(openChannelId(`/c/${FIRST}`, null)).toBe(FIRST.toLowerCase());
  });

  it("ignores anything after the id", () => {
    expect(openChannelId(`/c/${FIRST}/`, null)).toBe(FIRST.toLowerCase());
  });

  // The index route renders the channel surface without naming the channel, so
  // "/" is a channel too and its badge must be suppressed like any other.
  it("resolves the index route to the channel it actually shows", () => {
    expect(openChannelId("/", FIRST)).toBe(FIRST.toLowerCase());
    expect(openChannelId("", FIRST)).toBe(FIRST.toLowerCase());
    expect(openChannelId("/", null)).toBeNull();
  });

  it("is null on every route that is not a channel", () => {
    expect(openChannelId("/inbox", FIRST)).toBeNull();
    expect(openChannelId("/activity", FIRST)).toBeNull();
    expect(openChannelId("/settings", FIRST)).toBeNull();
    expect(openChannelId("/workstreams/019f", FIRST)).toBeNull();
  });

  it("survives a malformed escape rather than throwing at render time", () => {
    expect(openChannelId("/c/%E0%A4%A", null)).toBe("%e0%a4%a");
  });
});
