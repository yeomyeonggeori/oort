import { describe, expect, it } from "vitest";
import { ApiError, type MembershipRole, type RosterMember } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import { createMessageService } from "../../i18n/service";
import { catalog as ko } from "../../i18n/generated/ko-KR";
import { canRemoveFromChannel, channelMemberRemoveFailure, withChannelMemberRemoved } from "./memberRemove";

const ME = "00000000-0000-7000-8000-00000000a001";
const OTHER = "00000000-0000-7000-8000-00000000a002";

const human = (role: MembershipRole | undefined, id = OTHER) => ({ id, kind: "human" as const, role });

describe("canRemoveFromChannel — 워크스페이스 정지·제거 사다리의 거울 (#5778)", () => {
  // 서버 `workspace_authorization.rs` `can_remove` 표와 같은 판: 보는 사람이 대상보다 높아야 한다.
  const table: [MembershipRole | undefined, MembershipRole | undefined, boolean][] = [
    ["owner", "owner", false],
    ["owner", "admin", true],
    ["owner", "member", true],
    ["owner", "guest", true],
    ["owner", undefined, true],
    ["admin", "owner", false],
    ["admin", "admin", false],
    ["admin", "member", true],
    ["admin", "guest", true],
    ["admin", undefined, false],
    ["member", "member", false],
    ["member", "guest", false],
    ["guest", "member", false],
    [undefined, "member", false],
  ];

  it.each(table)("보는 사람 %s → 대상 %s: %s", (viewer, target, expected) => {
    expect(canRemoveFromChannel(viewer, ME, human(target))).toBe(expected);
  });

  it("자기 줄에는 없다 — 나는 「채널 나가기」로 나간다", () => {
    expect(canRemoveFromChannel("owner", ME, human("member", ME))).toBe(false);
    expect(canRemoveFromChannel("owner", ME.toUpperCase(), human("member", ME))).toBe(false);
  });

  it("에이전트 줄에는 없다 — 사람만", () => {
    expect(canRemoveFromChannel("owner", ME, { id: OTHER, kind: "agent", role: "member" })).toBe(false);
  });
});

describe("channelMemberRemoveFailure", () => {
  const messages = createMessageService({ messageLocale: "ko-KR", catalog: ko });
  const say = (error: unknown) => {
    const failure = channelMemberRemoveFailure(error);
    return messages.formatMessage(failure.key, failure.values as never);
  };

  it("403·404·네트워크·그 밖은 서로 다른 사전 문장이다", () => {
    const texts = [
      say(new ApiError(403, "workspace owner or admin role required")),
      say(new ApiError(404, "active channel membership not found")),
      say(new NetworkError("timeout", 15_000)),
      say(new Error("boom")),
    ];
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts[0]).toContain("권한");
    expect(texts[1]).toContain("이미");
    expect(texts[2]).toContain("15초");
    // 서버의 영어 문장을 옮겨 적지 않는다.
    expect(texts.join(" ")).not.toMatch(/required|not found|boom/);
  });
});

describe("withChannelMemberRemoved", () => {
  const CH = "00000000-0000-7000-8000-000000000201";
  const OTHER_CH = "00000000-0000-7000-8000-000000000202";
  const row = (id: string, channelIds: string[]) =>
    ({ id, kind: "human", channelIds, channelCount: channelIds.length }) as unknown as RosterMember;

  it("그 사람의 그 채널만 빼고, 다른 사람·다른 채널은 그대로다", () => {
    const before = [row(ME, [CH, OTHER_CH]), row(OTHER, [CH, OTHER_CH])];
    const after = withChannelMemberRemoved(before, CH.toUpperCase(), OTHER);
    expect(after[0]).toBe(before[0]);
    expect(after[1].channelIds).toEqual([OTHER_CH]);
    expect(after[1].channelCount).toBe(1);
  });

  it("이미 없으면 같은 줄을 돌려준다", () => {
    const before = [row(OTHER, [OTHER_CH])];
    expect(withChannelMemberRemoved(before, CH, OTHER)[0]).toBe(before[0]);
  });
});
