import { afterEach, describe, expect, it, vi } from "vitest";
import koChannels from "../../i18n/catalogs/ko-KR/channels.json";
import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
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
  CHANNEL_NAME_SERVER_REJECTED_KEY,
  CHANNEL_TOPIC_MAX,
  CHANNEL_TOPIC_VIEW_LABEL,
  CHANNEL_UNMUTE_LABEL,
  DM_CLOSE_LABEL,
  canCreateChannel,
  canCreateChannelNow,
  canLeaveChannel,
  channelCopyIdLabel,
  channelCopyNameLabel,
  channelLeaveConfirmBody,
  channelLeaveFailureMessage,
  channelMenuAccessibleLabel,
  channelMuteToggleLabel,
  channelNameIssue,
  channelNameIssueKey,
  channelNameIssueMessage,
  judgeChannelName,
  channelTopicIssue,
  createChannelFailure,
  dmCloseButtonLabel,
  normalizeChannelName,
  normalizeChannelTopic,
} from "./model";

// The contract under test is the server's (ADR-0225 D1-D5). The rows live in one
// shared vectors file; the Rust server test and this one read the same bytes.

// This package has no Node typings (it runs in the phone and the browser), so the
// byte-level check loads Node's own modules by name at run time.
const nodeModule = (name: string): Promise<any> => import(/* @vite-ignore */ name);
const { readFileSync } = await nodeModule("node:fs");
const { createHash } = await nodeModule("node:crypto");
const { fileURLToPath } = await nodeModule("node:url");
const FIXTURE_PATH: string = fileURLToPath(
  new URL("./__fixtures__/channel-name.vectors.json", (import.meta as unknown as { url: string }).url)
);

/** sha256 of the vectors copy. The server side must assert the same value (or,
 *  better, that this file equals `docs/api/channel-name.vectors.json`). */
const VECTORS_SHA256 =
  "6e75fba45869ad1a9921561787441259dcbca4d0aacf456d1a65197f496a8861";

interface VectorCase {
  group: "kept" | "fixed" | "refused";
  note: string;
  input: string;
  verdict: "ok" | "required" | "tooLong" | "hidden" | "unsupported" | "edge";
  stored?: string;
}
const vectorBytes: { toString(encoding: string): string } = readFileSync(FIXTURE_PATH);
const vectors = JSON.parse(vectorBytes.toString("utf8")) as {
  maxChars: number;
  cases: VectorCase[];
};

const label = (input: string) =>
  JSON.stringify(input).replace(/[^\x20-\x7e]/g, (c) =>
    c.codePointAt(0)! > 0xffff
      ? `\\u{${c.codePointAt(0)!.toString(16)}}`
      : `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`
  );

describe("shared vectors copy", () => {
  it("is the file the server reads: sha256 pinned, ASCII only", () => {
    expect(createHash("sha256").update(vectorBytes).digest("hex")).toBe(VECTORS_SHA256);
    expect(/^[\x00-\x7f]*$/.test(vectorBytes.toString("latin1"))).toBe(true);
  });

  it("carries the 57 rows and the 80 code point ceiling", () => {
    expect(vectors.cases).toHaveLength(57);
    expect(vectors.maxChars).toBe(CHANNEL_NAME_MAX);
  });
});

describe("judgeChannelName against the shared vectors", () => {
  it.each(vectors.cases.map((c, i) => [`${i + 1} ${c.verdict} ${label(c.input).slice(0, 48)}`, c] as const))(
    "%s",
    (_name, c) => {
      const judged = judgeChannelName(c.input);
      if (c.verdict === "ok") {
        expect(judged).toEqual({ ok: true, name: c.stored });
        // Running the stored value again must not change it.
        expect(normalizeChannelName(c.stored!)).toBe(c.stored);
        expect(channelNameIssue(c.input)).toBeNull();
      } else {
        expect(judged).toEqual({ ok: false, verdict: c.verdict });
        expect(channelNameIssue(c.input)).not.toBeNull();
      }
    }
  );
});

describe("normalizeChannelName", () => {
  it("stores what the server stores: trimmed, lowercased, blanks as hyphens", () => {
    expect(normalizeChannelName("  Release-Notes  ")).toBe("release-notes");
    expect(normalizeChannelName("Design Review")).toBe("design-review");
  });

  it("folds with the 25 White_Space code points of ADR-0225 D2, not the regex class", () => {
    const blanks = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680,
      ...Array.from({ length: 11 }, (_, i) => 0x2000 + i),
      0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
    ];
    expect(blanks).toHaveLength(25);
    for (const cp of blanks) {
      expect(normalizeChannelName(`a${String.fromCodePoint(cp)}b`), cp.toString(16)).toBe("a-b");
    }
    // U+FEFF is a format character, not a blank: it is refused as hidden, where
    // a regex whitespace class would have turned it into a hyphen.
    expect(judgeChannelName("a\uFEFFb")).toEqual({ ok: false, verdict: "hidden" });
    expect(normalizeChannelName("a\uFEFFb")).toBe("a\uFEFFb");
  });
});

describe("channelNameIssue", () => {
  it("accepts a plain slug, digits, hyphen and underscore", () => {
    for (const name of ["general", "release-notes", "wave_a2", "a", "7"]) {
      expect(channelNameIssue(name), name).toBeNull();
    }
  });

  it("accepts names in other scripts and uppercase, because the server folds them", () => {
    expect(channelNameIssue("엔진")).toBeNull();
    expect(channelNameIssue("Release-Notes")).toBeNull();
    expect(channelNameIssue("with space")).toBeNull();
  });

  it("reports an empty or blank-only name as required", () => {
    expect(channelNameIssue("")).toBe("required");
    expect(channelNameIssue("   ")).toBe("required");
  });

  it("names punctuation as an illegal character", () => {
    for (const name of ["dot.name", "v1.2", "a!", "#general", "\u{1F680}launch"]) {
      expect(channelNameIssue(name), name).toBe("unsupportedCharacters");
    }
  });

  it("names invisible characters as invisible, not as illegal", () => {
    for (const name of ["a\u200Bb", "a\u200Db", "a\u202Eb", "\u3164", "a\uFE0F", "a\uE000b", "a\uFEFFb", "a\uD800b"]) {
      expect(channelNameIssue(name), label(name)).toBe("hiddenCharacters");
    }
  });

  it("names a leading or trailing separator as what it is", () => {
    // Every one of these uses only legal characters, so the alphabet sentence
    // would have told the reader to use exactly what they had already used.
    for (const name of ["-release", "release-", "_ops", "ops-", "-", "__"]) {
      expect(channelNameIssue(name), name).toBe("edgeSeparator");
    }
  });

  it("counts a combining mark as part of the letter it leans on, never on a separator", () => {
    expect(channelNameIssue("e\u0301quipe")).toBeNull();
    expect(channelNameIssue("a-\u0301b")).toBe("unsupportedCharacters");
    expect(channelNameIssue("\u0301abc")).toBe("unsupportedCharacters");
  });

  it("measures length in code points, before shape, so the fixable problem is named first", () => {
    const rare = "\u{20BB7}"; // one code point, two UTF-16 units
    expect(rare.length).toBe(2);
    expect(channelNameIssue(rare.repeat(CHANNEL_NAME_MAX))).toBeNull();
    expect(channelNameIssue(rare.repeat(CHANNEL_NAME_MAX + 1))).toBe("tooLong");
    expect(channelNameIssue("a".repeat(CHANNEL_NAME_MAX))).toBeNull();
    expect(channelNameIssue("a".repeat(CHANNEL_NAME_MAX + 1))).toBe("tooLong");
    expect(channelNameIssue("한".repeat(CHANNEL_NAME_MAX))).toBeNull();
    // Too long AND illegal: still the length, matching the server's order.
    expect(channelNameIssue("!".repeat(CHANNEL_NAME_MAX + 1))).toBe("tooLong");
  });

  it("measures the folded name: blanks that fold away do not count", () => {
    expect(channelNameIssue(`  ${"a".repeat(CHANNEL_NAME_MAX)}  `)).toBeNull();
  });
});

describe("Unicode property patterns are built on first use (ADR-0225 D11)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not construct a property regex while the module loads", async () => {
    const RealRegExp = RegExp;
    const built: string[] = [];
    const Spy = new Proxy(RealRegExp, {
      construct(target, args: [string | RegExp, string?]) {
        built.push(String(args[0]));
        return new target(...args);
      },
    });
    vi.stubGlobal("RegExp", Spy);
    vi.resetModules();
    const mod = await import("./model");
    expect(built.filter((s) => s.includes("\\p{Cc}"))).toEqual([]);
    expect(mod.channelNameIssue("한글")).toBeNull();
    expect(built.filter((s) => s.includes("\\p{Cc}"))).toHaveLength(1);
    mod.channelNameIssue("another");
    expect(built.filter((s) => s.includes("\\p{Cc}"))).toHaveLength(1);
  });
});

describe("name rule sentences", () => {
  const ko = koChannels as Record<string, string>;
  const issues = [
    "required",
    "tooLong",
    "hiddenCharacters",
    "unsupportedCharacters",
    "edgeSeparator",
  ] as const;

  it("has a dictionary key for every issue and the Korean fallback says the same words", () => {
    for (const issue of issues) {
      const text = ko[channelNameIssueKey(issue)].replace("{max, number}", String(CHANNEL_NAME_MAX));
      expect(channelNameIssueMessage(issue), issue).toBe(text);
    }
    expect(new Set(issues.map(channelNameIssueKey)).size).toBe(5);
  });

  it("gives the invisible-character sentence of ADR-0225 D13", () => {
    expect(channelNameIssueMessage("hiddenCharacters")).toBe(
      "보이지 않는 글자가 들어 있어요. 이름을 지우고 다시 적어 주세요."
    );
  });

  it("is not an apology and does not tell a Korean name to use English", () => {
    for (const issue of issues) {
      const message = channelNameIssueMessage(issue);
      expect(message).not.toMatch(/죄송|오류가 발생|영문/);
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

  it("answers a 400 with the dictionary sentence, never the server's English", () => {
    const failure = createChannelFailure(new ApiError(400, "channel name must use letters"));
    expect(failure.messageKey).toBe(CHANNEL_NAME_SERVER_REJECTED_KEY);
    expect(failure.message).toBe(
      (koChannels as Record<string, string>)[CHANNEL_NAME_SERVER_REJECTED_KEY]
    );
    expect(failure.message).not.toMatch(/channel name/);
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
