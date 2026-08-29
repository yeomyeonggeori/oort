import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MUTE_LABEL,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  CHANNEL_TOPIC_VIEW_LABEL,
  CHANNEL_UNMUTE_LABEL,
  canCreateChannel,
  canCreateChannelNow,
  canLeaveChannel,
  channelLeaveConfirmBody,
  channelLeaveFailureMessage,
  channelMuteToggleLabel,
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

// 검수 피드백 #3 — 채널 헤더 메뉴. 낱말과 「어떤 항목이 서는가」의 규칙이 정본이다.

describe("channelMuteToggleLabel", () => {
  it("makes the word the state: 켜져 있으면 「끄기」, 꺼져 있으면 「켜기」", () => {
    expect(channelMuteToggleLabel(false)).toBe(CHANNEL_MUTE_LABEL);
    expect(channelMuteToggleLabel(true)).toBe(CHANNEL_UNMUTE_LABEL);
    // 두 낱말이 뒤바뀌지 않는다: 껐다 켰다가 같은 글자면 항목이 상태를 잃는다.
    expect(CHANNEL_MUTE_LABEL).not.toBe(CHANNEL_UNMUTE_LABEL);
  });
});

describe("canLeaveChannel", () => {
  it("offers leaving only to owner/admin, the roles the server lets remove a membership", () => {
    // remove_member는 `role_of_actor.is_admin()`를 요구한다(channels.rs). 일반
    // 멤버에게 내놓으면 확인 뒤 403으로 끝나는 막다른 길이다.
    expect(canLeaveChannel("owner")).toBe(true);
    expect(canLeaveChannel("admin")).toBe(true);
    expect(canLeaveChannel("member")).toBe(false);
    expect(canLeaveChannel("guest")).toBe(false);
  });

  it("offers it when the role has not arrived, and lets the server have the last word", () => {
    // canCreateChannel과 같은 규율: 필드가 늦게 온다고 유일한 길을 숨기지 않는다.
    expect(canLeaveChannel(undefined)).toBe(true);
  });
});

describe("channelLeaveFailureMessage", () => {
  it("maps the admin-only 403 to a next step rather than echoing the server", () => {
    const message = channelLeaveFailureMessage(new ApiError(403, "forbidden"));
    expect(message).toContain("관리자");
    expect(message).not.toContain("forbidden");
  });

  it("reads a 404 as 'already not a member' rather than a failure", () => {
    expect(channelLeaveFailureMessage(new ApiError(404, "not found"))).toContain(
      "이미"
    );
  });

  it("reuses the transport's measured copy when nothing answered, and never apologises", () => {
    expect(
      channelLeaveFailureMessage(new NetworkError("timeout", 15_000))
    ).toContain("15초");
    const generic = channelLeaveFailureMessage(new Error("boom"));
    expect(generic).toContain("다시 시도");
    expect(generic).not.toMatch(/죄송/);
  });
});

describe("channelLeaveConfirmBody", () => {
  it("names the channel and states that re-entry needs an admin", () => {
    const body = channelLeaveConfirmBody("release-2026-08");
    expect(body).toContain("release-2026-08");
    expect(body).toContain("관리자");
  });
});

describe("channel header menu labels", () => {
  it("keeps the action words distinct", () => {
    const words = new Set([
      CHANNEL_MUTE_LABEL,
      CHANNEL_UNMUTE_LABEL,
      CHANNEL_LEAVE_LABEL,
      CHANNEL_TOPIC_VIEW_LABEL,
    ]);
    expect(words.size).toBe(4);
  });

  it("names the topic item as view, because there is no topic PATCH", () => {
    expect(CHANNEL_TOPIC_VIEW_LABEL).toBe("주제 보기");
  });
});
