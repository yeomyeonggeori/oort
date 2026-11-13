import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { createMessageService } from "../../i18n/service";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import {
  CHANNEL_COPY_FAILURE,
  CHANNEL_COPY_GROUP_LABEL,
  CHANNEL_COPY_ID_DONE_LABEL,
  CHANNEL_COPY_ID_LABEL,
  CHANNEL_COPY_NAME_DONE_LABEL,
  CHANNEL_COPY_NAME_LABEL,
  CHANNEL_COPY_UNAVAILABLE,
  CHANNEL_LEAVE_LABEL,
  CHANNEL_MARK_READ_FAILURE,
  CHANNEL_MARK_READ_LABEL,
  CHANNEL_MARK_UNREAD_BUSY_LABEL,
  CHANNEL_MARK_UNREAD_FAILURE,
  CHANNEL_MARK_UNREAD_LABEL,
  CHANNEL_MUTE_LABEL,
  CHANNEL_NAME_MAX,
  CHANNEL_TOPIC_MAX,
  CHANNEL_TOPIC_VIEW_LABEL,
  CHANNEL_UNMUTE_LABEL,
  DM_CLOSE_LABEL,
  canCreateChannel,
  canCreateChannelNow,
  canLeaveChannel,
  channelCopyIdLabel,
  channelCopyNameLabel,
  channelLeaveConfirmBodyKey,
  channelLeaveFailure,
  channelMenuAccessibleLabel,
  channelMuteToggleLabel,
  channelNameIssue,
  channelNameIssueMessage,
  channelTopicIssue,
  createChannelFailure,
  dmCloseButtonLabel,
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
  it("offers leaving every public and private channel, whatever the role (#5778 — the self route)", () => {
    // 본인 나가기(`…/members/me`)는 사람이면 역할을 보지 않는다(2026-11-14 로컬 스택: 멤버·게스트 200).
    expect(canLeaveChannel("public")).toBe(true);
    expect(canLeaveChannel("private")).toBe(true);
  });

  it("never offers it on a DM, which the server refuses with 403", () => {
    expect(canLeaveChannel("dm")).toBe(false);
  });
});

describe("channelLeaveFailure", () => {
  const messages = createMessageService({ messageLocale: "ko-KR", catalog: ko });
  const say = (error: unknown) => {
    const failure = channelLeaveFailure(error);
    return messages.formatMessage(failure.key, failure.values as never);
  };

  it("does not send a member to an admin: leaving is their own route", () => {
    const failure = channelLeaveFailure(new ApiError(403, "forbidden"));
    expect(failure.key).toBe("timeline.channelLeave.errorForbidden");
    expect(say(new ApiError(403, "forbidden"))).not.toMatch(/관리자|forbidden/);
  });

  it("reads a 404 as 'already not a member', which includes an archived channel", () => {
    expect(channelLeaveFailure(new ApiError(404, "not found")).key).toBe("timeline.channelLeave.errorNotFound");
    expect(say(new ApiError(404, "not found"))).toContain("이미");
  });

  it("reuses the transport's measured copy when nothing answered, and never apologises", () => {
    expect(say(new NetworkError("timeout", 15_000))).toContain("15초");
    const generic = say(new Error("boom"));
    expect(generic).toContain("다시 시도");
    expect(generic).not.toMatch(/죄송/);
  });
});

describe("channelLeaveConfirmBodyKey", () => {
  const messages = createMessageService({ messageLocale: "ko-KR", catalog: ko });

  it("names the channel and the only way back today: an owner or admin adds you", () => {
    const body = messages.formatMessage(channelLeaveConfirmBodyKey("public"), { name: "release-2026-08" });
    expect(body).toContain("release-2026-08");
    expect(body).toContain("관리자");
    // 채널 둘러보기·스스로 참여는 아직 없다(결정 문서 단계): 약속하지 않는다.
    expect(body).not.toMatch(/찾아|둘러보|스스로/);
  });

  it("tells a private channel's leaver that re-entry needs an invitation and that the last one out archives it", () => {
    expect(channelLeaveConfirmBodyKey("private")).toBe("timeline.channelLeave.bodyPrivate");
    const body = messages.formatMessage(channelLeaveConfirmBodyKey("private"), { name: "design-room" });
    expect(body).toContain("초대");
    expect(body).toContain("보관");
  });

  it("falls back to the public sentence when the kind is unknown", () => {
    expect(channelLeaveConfirmBodyKey(undefined)).toBe("timeline.channelLeave.bodyPublic");
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

// ---- BT-1 (#1929): 행에서 채널을 조작하는 낱말 -------------------------------

describe("channelCopyNameLabel", () => {
  it("낱말이 상태다: 복사 전과 후가 다른 문장이다", () => {
    expect(channelCopyNameLabel(false)).toBe(CHANNEL_COPY_NAME_LABEL);
    expect(channelCopyNameLabel(true)).toBe(CHANNEL_COPY_NAME_DONE_LABEL);
    expect(CHANNEL_COPY_NAME_LABEL).not.toBe(CHANNEL_COPY_NAME_DONE_LABEL);
  });

  it("동사구다: 메뉴의 형제 항목들과 같은 꼴", () => {
    // 「메시지 복사하기」·「링크 복사하기」·「채널 나가기」와 같은 결.
    expect(CHANNEL_COPY_NAME_LABEL.endsWith("하기")).toBe(true);
    expect(CHANNEL_MARK_READ_LABEL.endsWith("하기")).toBe(true);
  });
});

describe("복사·읽음 실패 문장", () => {
  it("클립보드가 없을 때와 쓰기가 실패했을 때를 갈라 말한다", () => {
    // 다시 눌러도 같은 경우에 「다시」라고 말하면 거짓말이 된다.
    expect(CHANNEL_COPY_UNAVAILABLE).not.toContain("다시");
    expect(CHANNEL_COPY_FAILURE).toContain("다시");
    expect(CHANNEL_COPY_UNAVAILABLE).not.toBe(CHANNEL_COPY_FAILURE);
  });

  it("읽음 실패는 그 자리에서 다음 행동을 준다", () => {
    expect(CHANNEL_MARK_READ_FAILURE).toContain("다시 시도");
  });
});

// ---- design-review #1937 R1: 진행 낱말과 DM 낱말 -----------------------------

describe("channelMenuAccessibleLabel", () => {
  it("DM 을 「채널」이라 부르지 않는다", () => {
    expect(channelMenuAccessibleLabel("이도현", true)).toBe(
      "이도현 다이렉트 메시지 메뉴"
    );
    expect(channelMenuAccessibleLabel("이도현", true)).not.toContain("채널");
  });

  it("채널은 채널이라 부른다", () => {
    expect(channelMenuAccessibleLabel("general", false)).toBe("general 채널 메뉴");
  });
});

// ---- #3963: 복사 무리 · 읽지 않음으로 표시 · DM 닫기 --------------------------

describe("channelCopyIdLabel", () => {
  it("낱말이 상태다: 복사 전과 후가 다른 문장이다", () => {
    expect(channelCopyIdLabel(false)).toBe(CHANNEL_COPY_ID_LABEL);
    expect(channelCopyIdLabel(true)).toBe(CHANNEL_COPY_ID_DONE_LABEL);
    expect(CHANNEL_COPY_ID_LABEL).not.toBe(CHANNEL_COPY_ID_DONE_LABEL);
  });

  it("이름 복사와 같은 결의 동사구다", () => {
    expect(CHANNEL_COPY_ID_LABEL.endsWith("복사하기")).toBe(true);
    expect(CHANNEL_COPY_NAME_LABEL.endsWith("복사하기")).toBe(true);
    expect(CHANNEL_COPY_GROUP_LABEL).toBe("복사");
  });
});

describe("읽지 않음으로 표시 · DM 닫기 낱말", () => {
  it("읽음 처리와 서로 다른 낱말이고, 같은 메뉴의 형제 항목처럼 -기 동사구다", () => {
    expect(CHANNEL_MARK_UNREAD_LABEL).toBe("읽지 않음으로 표시하기");
    expect(CHANNEL_MARK_UNREAD_LABEL).not.toBe(CHANNEL_MARK_READ_LABEL);
    expect(CHANNEL_MARK_UNREAD_BUSY_LABEL).not.toBe(CHANNEL_MARK_UNREAD_LABEL);
  });

  it("진행 낱말은 「명사 + 중」이다(프리플라이트 분류 11 이 재는 축)", () => {
    expect(CHANNEL_MARK_UNREAD_BUSY_LABEL).not.toMatch(/하는 중$/);
    expect(CHANNEL_MARK_UNREAD_BUSY_LABEL.endsWith("중")).toBe(true);
  });

  it("실패 문장은 그 자리에서 다음 행동을 준다", () => {
    expect(CHANNEL_MARK_UNREAD_FAILURE).toContain("다시 시도");
  });

  it("DM 숨기기는 삭제도 나가기도 아니라 목록에서 숨기는 것이라고 말한다", () => {
    expect(DM_CLOSE_LABEL).toBe("목록에서 숨기기");
    expect(DM_CLOSE_LABEL).not.toContain("삭제");
    expect(DM_CLOSE_LABEL).not.toContain("닫");
    expect(DM_CLOSE_LABEL).not.toContain("나가기");
  });

  it("호버 X 의 이름은 어느 대화인지 말한다(행의 링크 이름 꼴: 이름, 뜻)", () => {
    expect(dmCloseButtonLabel("이도현")).toBe("이도현, 목록에서 숨기기");
    expect(dmCloseButtonLabel("하윤의 Claude")).toBe("하윤의 Claude, 목록에서 숨기기");
  });
});
