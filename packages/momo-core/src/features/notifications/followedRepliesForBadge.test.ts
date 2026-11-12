import { describe, expect, it } from "vitest";
import { followedRepliesForBadge, type FollowedRepliesBadgeInput } from "./model";

// #5660 (owner 2026-11-11 「켜줘」): 따라가는 스레드에 남이 단 답글도 맥의 메뉴 막대 점·독 배지를 켠다. 수는 서버 읽음 투영의 채널 줄 값
// (`followedUnreadReplyCount`, 서버 #5667) 그대로이고, 규칙은 DM 몫과 같다(ADR-0124 D2·D4-A). 멘션과의 겹침은 채널 줄로는 정확히 뺄 수 없어
// 덜 세는 쪽(`max(답글 − 멘션, 0)`)으로 뺀다.

const A = "00000000-0000-7000-8000-0000000000a1";
const B = "00000000-0000-7000-8000-0000000000b2";
const C = "00000000-0000-7000-8000-0000000000c3";

type Row = { mentionCount: number; followedUnreadReplyCount?: number };

function input(rows: Record<string, Row>, over: Partial<FollowedRepliesBadgeInput> = {}): FollowedRepliesBadgeInput {
  return {
    channels: [{ id: A }, { id: B }, { id: C }],
    readState: (id) => rows[id.toLowerCase()],
    viewingThreadChannelId: null,
    ...over,
  };
}

describe("followedRepliesForBadge (#5660)", () => {
  it("채널마다 따라가는 스레드의 안 읽은 답글을 더하고, 멘션 수만큼은 빼서 두 번 세지 않는다(덜 세는 쪽)", () => {
    const rows = {
      [A]: { mentionCount: 0, followedUnreadReplyCount: 3 },
      [B]: { mentionCount: 1, followedUnreadReplyCount: 2 },
      [C]: { mentionCount: 4, followedUnreadReplyCount: 2 },
    };
    // A 3 + B (2 - 1) + C max(2 - 4, 0) = 4.
    expect(followedRepliesForBadge(input(rows))).toBe(4);
  });

  it("켜져야 할 때는 언제나 켜진다: 답글이 있는 채널은 멘션 몫과 이 몫 중 하나가 반드시 센다", () => {
    for (const mentions of [0, 1, 2, 5]) {
      for (const replies of [1, 2, 5]) {
        const share = followedRepliesForBadge(input({ [A]: { mentionCount: mentions, followedUnreadReplyCount: replies } }));
        expect(mentions + share, `멘션 ${mentions} · 답글 ${replies}`).toBeGreaterThan(0);
        // 그 채널의 합은 max(멘션, 답글): 겹침을 뺀 실제 합보다 크지 않다.
        expect(mentions + share).toBe(Math.max(mentions, replies));
      }
    }
  });

  it("필드가 없으면(#5667 전 서버) 0이고, 깨진 값도 0이다: 지어내지 않는다", () => {
    const rows = {
      [A]: { mentionCount: 0 },
      [B]: { mentionCount: 0, followedUnreadReplyCount: Number.NaN },
      [C]: { mentionCount: 0, followedUnreadReplyCount: -3 },
    };
    expect(followedRepliesForBadge(input(rows))).toBe(0);
    // 투영에 줄이 없는 채널도 0.
    expect(followedRepliesForBadge(input({}))).toBe(0);
  });

  it("지금 앞에서 열어 둔 스레드의 채널은 몫 전체를 세지 않는다(대소문자가 달라도 같은 채널), 닫으면 다시 센다", () => {
    const rows = {
      [A]: { mentionCount: 0, followedUnreadReplyCount: 3 },
      [B]: { mentionCount: 0, followedUnreadReplyCount: 2 },
    };
    expect(followedRepliesForBadge(input(rows, { viewingThreadChannelId: A.toUpperCase() }))).toBe(2);
    expect(followedRepliesForBadge(input(rows, { viewingThreadChannelId: null }))).toBe(5);
  });

  it("알림 끄기·일시 중지와 무관하다(ADR-0124 D2·D4-A): 입력에 그 값이 없다", () => {
    expect(Object.keys(input({})).sort()).toEqual(["channels", "readState", "viewingThreadChannelId"]);
  });
});
