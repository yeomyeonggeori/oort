import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  canCreateChannel,
  canCreateChannelNow,
  channelNameIssue,
  channelNameIssueMessage,
  channelTopicIssue,
  createChannelFailure,
  normalizeChannelName,
  normalizeChannelTopic,
} from "./model";

// The contract under test is the server's, so the cases below are the ones
// ChannelRoutes.normalizedChannelName actually decides, not a paraphrase of it.

describe("normalizeChannelName", () => {
  it("stores what the server stores: trimmed and lowercased", () => {
    expect(normalizeChannelName("  Release-Notes  ")).toBe("release-notes");
  });
});

describe("channelNameIssue", () => {
  it("accepts a plain slug, digits, hyphen and underscore", () => {
    expect(channelNameIssue("general")).toBeNull();
    expect(channelNameIssue("release-notes")).toBeNull();
    expect(channelNameIssue("wave_a2")).toBeNull();
    expect(channelNameIssue("a")).toBeNull();
    expect(channelNameIssue("7")).toBeNull();
  });

  it("accepts uppercase input, because the server lowercases it", () => {
    expect(channelNameIssue("Release-Notes")).toBeNull();
  });

  it("reports an empty or whitespace-only name as required", () => {
    expect(channelNameIssue("")).toBe("required");
    expect(channelNameIssue("   ")).toBe("required");
  });

  it("names an illegal character as an illegal character", () => {
    // Korean is the case a Korean team types first, and the server refuses it.
    expect(channelNameIssue("엔진")).toBe("unsupportedCharacters");
    expect(channelNameIssue("with space")).toBe("unsupportedCharacters");
    expect(channelNameIssue("dot.name")).toBe("unsupportedCharacters");
  });

  it("names a leading or trailing separator as what it is", () => {
    // Every one of these uses only legal characters, so the alphabet sentence
    // would have told the reader to use exactly what they had already used.
    // The rule they actually broke is where a name may begin and end.
    for (const name of ["-release", "release-", "_ops", "ops-", "-", "__"]) {
      expect(channelNameIssue(name), name).toBe("edgeSeparator");
    }
  });

  it("reports length before shape, so the fixable problem is named first", () => {
    expect(channelNameIssue("a".repeat(CHANNEL_NAME_MAX))).toBeNull();
    expect(channelNameIssue("a".repeat(CHANNEL_NAME_MAX + 1))).toBe("tooLong");
    // Too long AND illegal: still the length, matching the server's order.
    expect(channelNameIssue("한".repeat(CHANNEL_NAME_MAX + 1))).toBe("tooLong");
  });

  it("has copy for every issue, none of it an apology", () => {
    for (const issue of [
      "required",
      "tooLong",
      "unsupportedCharacters",
      "edgeSeparator",
    ] as const) {
      const message = channelNameIssueMessage(issue);
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toMatch(/죄송|오류가 발생/);
      expect(message).not.toMatch(/—|–/);
    }
  });

  it("does not answer an edge separator with the alphabet sentence", () => {
    // The regression this file exists to catch: `-release` was told to use
    // only the characters it was already using.
    const edge = channelNameIssueMessage("edgeSeparator");
    expect(edge).not.toBe(channelNameIssueMessage("unsupportedCharacters"));
    expect(edge).toContain("처음과 끝");
  });
});

describe("channelTopicIssue", () => {
  it("treats an empty topic as fine: it is optional", () => {
    expect(channelTopicIssue("")).toBeNull();
    expect(channelTopicIssue("   ")).toBeNull();
    expect(normalizeChannelTopic("  릴리스 노트  ")).toBe("릴리스 노트");
  });

  it("holds the server's 280 character ceiling", () => {
    expect(channelTopicIssue("가".repeat(CHANNEL_TOPIC_MAX))).toBeNull();
    expect(channelTopicIssue("가".repeat(CHANNEL_TOPIC_MAX + 1))).toBe("tooLong");
  });
});

describe("canCreateChannel", () => {
  it("follows requireWorkspaceAdmin", () => {
    expect(canCreateChannel("owner")).toBe(true);
    expect(canCreateChannel("admin")).toBe(true);
    expect(canCreateChannel("member")).toBe(false);
    expect(canCreateChannel("guest")).toBe(false);
  });

  it("lets the server decide when the roster did not report a role", () => {
    expect(canCreateChannel(undefined)).toBe(true);
  });
});

describe("canCreateChannelNow", () => {
  // R2 M5: an offer that is withdrawn a frame later is worse than a late one.
  it("offers nothing while the roster is still in flight", () => {
    expect(canCreateChannelNow(false, "owner")).toBe(false);
    expect(canCreateChannelNow(false, "member")).toBe(false);
    expect(canCreateChannelNow(false, undefined)).toBe(false);
  });

  it("answers as before once it has settled, roleless roster included", () => {
    expect(canCreateChannelNow(true, "owner")).toBe(true);
    expect(canCreateChannelNow(true, "admin")).toBe(true);
    expect(canCreateChannelNow(true, "member")).toBe(false);
    expect(canCreateChannelNow(true, undefined)).toBe(true);
  });
});

describe("createChannelFailure", () => {
  it("puts a duplicate name beside the name field", () => {
    const failure = createChannelFailure(
      new ApiError(409, "channel name already exists")
    );
    expect(failure.field).toBe("name");
    expect(failure.message).toContain("이미 있습니다");
  });

  it("puts a server-side name rejection beside the name field too", () => {
    expect(createChannelFailure(new ApiError(400, "bad name")).field).toBe("name");
  });

  it("treats permission and rate limits as form-level, not field-level", () => {
    expect(createChannelFailure(new ApiError(403, "forbidden")).field).toBeNull();
    expect(createChannelFailure(new ApiError(429, "slow down")).field).toBeNull();
  });

  it("reuses the transport's measured copy when nothing answered", () => {
    const failure = createChannelFailure(new NetworkError("timeout", 15_000));
    expect(failure.field).toBeNull();
    expect(failure.message).toContain("15초");
  });

  it("never says nothing, and never apologises", () => {
    const failure = createChannelFailure(new Error("boom"));
    expect(failure.field).toBeNull();
    expect(failure.message).toContain("다시 시도");
    expect(failure.message).not.toMatch(/죄송|알 수 없는/);
  });
});
