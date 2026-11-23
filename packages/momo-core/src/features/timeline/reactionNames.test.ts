import { describe, expect, it } from "vitest";
import type { RosterMember } from "../../lib/api";
import { catalog as koCatalog } from "../../i18n/generated/ko-KR";
import { createMessageCopy } from "../../testkit";
import { makeDirectory } from "../workspace/directory";
import {
  formatReactionNames,
  reactionChipAccessibleName,
} from "./reactionNames";
// 문장은 사전(`timeline.json`)에 있다(#6044). 시험은 제품과 같은 한국어 생성물로 키를 풀어 한국어 그대로 단정한다.
const ko = createMessageCopy({ messageLocale: "ko-KR", catalog: koCatalog });


const WS = "00000000-0000-7000-8000-000000000001";
const ME = "11111111-2222-3333-4444-555555555555";
const MINJUN = "aaaaaaaa-bbbb-cccc-dddd-000000000001";
const SEOYEON = "aaaaaaaa-bbbb-cccc-dddd-000000000002";
const JIHOON = "aaaaaaaa-bbbb-cccc-dddd-000000000003";
const NADIA = "aaaaaaaa-bbbb-cccc-dddd-000000000004";
const INTERN_HUMAN = "aaaaaaaa-bbbb-cccc-dddd-000000000201";
const INTERN_AGENT = "aaaaaaaa-bbbb-cccc-dddd-000000000301";
const GONE = "aaaaaaaa-bbbb-cccc-dddd-00000000dead";

function member(
  over: Partial<RosterMember> & { id: string; displayName: string; handle: string }
): RosterMember {
  return {
    workspaceId: WS,
    kind: "human",
    status: "active",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const DIRECTORY = makeDirectory([
  member({ id: ME, displayName: "데모 사용자", handle: "demo" }),
  member({ id: MINJUN, displayName: "김민준", handle: "minjun" }),
  member({ id: SEOYEON, displayName: "이서연", handle: "seoyeon" }),
  member({ id: JIHOON, displayName: "박지훈", handle: "jihoon" }),
  member({ id: NADIA, displayName: "Nadia Rahman", handle: "nadia" }),
  member({ id: INTERN_HUMAN, displayName: "김인턴", handle: "intern-kim" }),
  member({
    id: INTERN_AGENT,
    kind: "agent",
    displayName: "김인턴",
    handle: "kim-intern",
  }),
  member({ id: "blank", displayName: "   ", handle: "blank" }),
]);

describe("formatReactionNames", () => {
  it("names me first, with the chip's remove hint in parentheses", () => {
    expect(formatReactionNames(ko, [ME], DIRECTORY, ME)).toBe(
      `나(내 반응 취소)`
    );
  });

  it("names one other person", () => {
    expect(formatReactionNames(ko, [MINJUN], DIRECTORY, ME)).toBe("김민준");
  });

  it("names two other people in insertion order", () => {
    expect(formatReactionNames(ko, [MINJUN, SEOYEON], DIRECTORY, ME)).toBe(
      "김민준, 이서연"
    );
  });

  it("names three other people without folding", () => {
    expect(
      formatReactionNames(ko, [MINJUN, SEOYEON, JIHOON], DIRECTORY, ME)
    ).toBe("김민준, 이서연, 박지훈");
  });

  it("folds the fourth and later into 외 N명", () => {
    expect(
      formatReactionNames(ko, [MINJUN, SEOYEON, JIHOON, NADIA], DIRECTORY, ME)
    ).toBe("김민준, 이서연, 박지훈 외 1명");
  });

  it("keeps me first when I am not the first id, then folds past three names", () => {
    expect(
      formatReactionNames(ko, [MINJUN, SEOYEON, JIHOON, ME], DIRECTORY, ME.toUpperCase())
    ).toBe(`나(내 반응 취소), 김민준, 이서연 외 1명`);
  });

  it("counts unresolved ids (missing roster, blank name) as 외 N명, never a stand-in", () => {
    expect(formatReactionNames(ko, [GONE, GONE], DIRECTORY, ME)).toBe("외 1명");
    expect(formatReactionNames(ko, ["blank"], DIRECTORY, ME)).toBe("외 1명");
    expect(
      formatReactionNames(ko, [ME, GONE, "blank"], makeDirectory([]), ME)
    ).toBe(`나(내 반응 취소) 외 2명`);
    expect(formatReactionNames(ko, [GONE, MINJUN, "missing"], DIRECTORY, ME)).toBe(
      "김민준 외 2명"
    );
    expect(formatReactionNames(ko, [GONE, GONE, "missing"], DIRECTORY, undefined)).toBe(
      "외 2명"
    );
  });

  it("disambiguates the two 김인턴 the directory actually carries", () => {
    expect(formatReactionNames(ko, [INTERN_HUMAN], DIRECTORY, ME)).toBe(
      "김인턴 @intern-kim"
    );
    expect(formatReactionNames(ko, [INTERN_AGENT], DIRECTORY, ME)).toBe(
      "김인턴 @kim-intern"
    );
  });
});

describe("reactionChipAccessibleName", () => {
  it("puts count, names, and the add hint on a chip that is not mine", () => {
    expect(
      reactionChipAccessibleName(ko, "👍", 2, "김민준, 이서연", false)
    ).toBe(`👍 반응 2개, 김민준, 이서연, 나도 반응하기`);
  });

  it("does not repeat the remove hint when the name sentence already has it", () => {
    const names = `나(내 반응 취소), 김민준`;
    expect(reactionChipAccessibleName(ko, "👍", 2, names, true)).toBe(
      `👍 반응 2개, ${names}`
    );
  });

  it("falls back to the count-only chip labels when names are empty", () => {
    expect(reactionChipAccessibleName(ko, "🎉", 1, "", true)).toBe(
      `🎉 반응 1개, 내 반응 취소`
    );
    expect(reactionChipAccessibleName(ko, "🎉", 1, "", false)).toBe(
      `🎉 반응 1개, 나도 반응하기`
    );
  });
});
