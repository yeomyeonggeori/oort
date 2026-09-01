import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Channel, RosterMember } from "@momo/core/lib/api";
import { loadCatalog, displayGlyph } from "@/features/emoji/catalog";
import { filterEmojis } from "@/features/emoji/search";
import {
  channelCandidates,
  COMPOSER_CANDIDATE_LIMIT,
  COMPOSER_TRIGGER_SPECS,
  composerTriggerQueryAt,
  emojiCandidates,
  insertComposerCandidate,
  insertMention,
  isComposerCaretInCode,
  matchChannels,
  matchMembers,
  memberCandidates,
  mentionQueryAt,
} from "./composerAutocomplete";

// =============================================================================
// 한 파서·한 목록 기계·한 키보드 (#1930).
//
// buzz 는 `@`·`#`·`:` 를 세 파일(MentionAutocomplete / ChannelAutocomplete /
// EmojiAutocomplete)로 갈라 두었고, 그래서 앵커 규율이 세 벌이 됐다. 이 파일의
// 첫 describe 는 그 갈라짐이 여기서 재현되지 않는다는 것을 **구조로** 단정한다.
// =============================================================================

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = `${dir}/${entry}`;
    if (statSync(path).isDirectory()) {
      out.push(...sourceFiles(path));
      continue;
    }
    if (/\.tsx?$/.test(entry)) out.push(path);
  }
  return out;
}

const ALL_SOURCES = sourceFiles(SRC).filter(
  (path) => !/\.test\.tsx?$/.test(path)
);

const rel = (path: string) => path.slice(SRC.length);

describe("트리거 파서는 하나다 (#1930)", () => {
  it("세 트리거가 한 표에서만 정의된다", () => {
    expect(COMPOSER_TRIGGER_SPECS.map((spec) => spec.char)).toEqual([
      "@",
      "#",
      ":",
    ]);
    expect(COMPOSER_TRIGGER_SPECS.map((spec) => spec.kind)).toEqual([
      "mention",
      "channel",
      "emoji",
    ]);
  });

  it("트리거 글자를 뒤로 훑는 코드가 한 파일에만 있다", () => {
    const scanners = ALL_SOURCES.filter((path) => {
      const source = readFileSync(path, "utf8");
      return (
        /lastIndexOf\("[@#:]"\)/.test(source) ||
        /export function \w*TriggerQueryAt/.test(source)
      );
    }).map(rel);
    expect(scanners).toEqual(["/features/chat/composerAutocomplete.ts"]);
  });

  it("`@` 전용 파서는 남지 않고, 멘션 질의는 같은 기계에서 갈라진다", () => {
    expect(
      ALL_SOURCES.map(rel).filter((path) => path.includes("MentionAutocomplete"))
    ).toEqual([]);
    const machine = readFileSync(`${SRC}/features/chat/composerAutocomplete.ts`, "utf8");
    expect(machine).toMatch(
      /export function mentionQueryAt[\s\S]{0,320}composerTriggerQueryAt\(/
    );
  });

  it("두 컴포저가 같은 훅·같은 목록 컴포넌트를 소비한다", () => {
    for (const path of [
      `${SRC}/features/chat/Composer.tsx`,
      `${SRC}/features/timeline/ThreadComposer.tsx`,
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).toContain("useComposerAutocomplete");
      expect(source).toContain("<ComposerAutocompleteList");
      expect(source).not.toContain("useMentionAutocomplete");
    }
  });
});

// -----------------------------------------------------------------------------
// `@` 회귀 0. 아래 표는 #1930 이전 `mentionQueryAt` 이 내던 값 그대로다.
// -----------------------------------------------------------------------------

describe("멘션 문법은 한 글자도 바뀌지 않는다", () => {
  it.each([
    ["줄 시작", "@her", 4, { start: 0, text: "her" }],
    ["공백 뒤", "배포 전에 @her", "배포 전에 @her".length, { start: 6, text: "her" }],
    ["빈 질의", "hi @", 4, { start: 3, text: "" }],
    ["트리거 한 글자", "@", 1, { start: 0, text: "" }],
    ["여러 멘션 중 마지막", "@a @b", 5, { start: 3, text: "b" }],
  ])("%s 는 질의를 연다", (_name, value, caret, expected) => {
    expect(mentionQueryAt(value, caret as number)).toEqual(expected);
  });

  it.each([
    ["비공백 뒤 @", "person@example.com", 18],
    ["질의 안 공백", "@a b", 4],
    ["캐럿이 0", "@her", 0],
    ["트리거 없음", "안녕하세요", 5],
  ])("%s 는 질의가 아니다", (_name, value, caret) => {
    expect(mentionQueryAt(value, caret)).toBeNull();
  });

  it("앵커에 실패한 트리거 글자는 평범한 본문이라 뒤로 계속 훑는다", () => {
    // `:` 는 핸들 문자가 아니지만 질의 텍스트로는 지나갈 수 있어야 한다.
    // 여기서 멈추면 `@hermes:` 를 치는 순간 열려 있던 멘션 목록이 사라진다.
    expect(mentionQueryAt("@hermes:", 8)).toEqual({ start: 0, text: "hermes:" });
    expect(composerTriggerQueryAt("@hermes:", 8)).toEqual({
      kind: "mention",
      start: 0,
      text: "hermes:",
    });
  });

  it("멘션 후보와 삽입 직렬화가 그대로다", () => {
    const members: RosterMember[] = [
      member("m1", "hermes", "헤르메스"),
      member("m2", "intern", "김인턴"),
      member("m3", "gone", "떠난사람", "suspended"),
    ];
    expect(matchMembers(members, "her").map((m) => m.handle)).toEqual(["hermes"]);
    expect(matchMembers(members, "").map((m) => m.handle)).toEqual([
      "hermes",
      "intern",
    ]);
    const value = "배포 전에 @her 확인";
    const caret = "배포 전에 @her".length;
    const query = mentionQueryAt(value, caret);
    expect(insertMention(value, caret, query!, "hermes")).toEqual({
      value: "배포 전에 @hermes  확인",
      caret: "배포 전에 @hermes ".length,
    });
    const [row] = memberCandidates(members, "her");
    expect(row).toMatchObject({
      kind: "mention",
      id: "m1",
      lead: "@hermes",
      hint: "헤르메스",
      insert: "@hermes ",
    });
  });
});

// -----------------------------------------------------------------------------
// `#` 채널
// -----------------------------------------------------------------------------

const LONG_NAME = "2026-하반기-릴리스-준비-회고-및-후속-작업";

const CHANNELS: Channel[] = [
  channel("c1", "general"),
  channel("c2", "엔진"),
  channel("c3", "release-notes"),
  channel("c4", LONG_NAME),
  { ...channel("c5", "옛채널"), archivedAtMs: 1 },
  { ...channel("c6", undefined), kind: "dm", dmKey: "k" },
];

describe("`#` 채널 자동완성 (#1930)", () => {
  it("`#` 는 멘션과 같은 앵커 규율로 열린다", () => {
    expect(composerTriggerQueryAt("#gen", 4)).toEqual({
      kind: "channel",
      start: 0,
      text: "gen",
    });
    expect(composerTriggerQueryAt("배포는 #엔진", "배포는 #엔진".length)).toEqual({
      kind: "channel",
      start: 4,
      text: "엔진",
    });
    expect(composerTriggerQueryAt("issue#1930", 10)).toBeNull();
    expect(composerTriggerQueryAt("#gen eral", 9)).toBeNull();
  });

  it("보관된 채널과 DM 은 후보가 아니다", () => {
    expect(matchChannels(CHANNELS, "").map((c) => c.name)).toEqual([
      "general",
      "엔진",
      "release-notes",
      LONG_NAME,
    ]);
    expect(matchChannels(CHANNELS, "옛채널")).toEqual([]);
  });

  it("대소문자를 가리지 않고 부분 일치로 좁힌다", () => {
    expect(matchChannels(CHANNELS, "RELEASE").map((c) => c.name)).toEqual([
      "release-notes",
    ]);
    expect(matchChannels(CHANNELS, "notes").map((c) => c.name)).toEqual([
      "release-notes",
    ]);
  });

  it("긴 채널 이름도 자르지 않고 그대로 넣는다", () => {
    const [row] = channelCandidates(CHANNELS, "회고");
    expect(row).toMatchObject({
      kind: "channel",
      id: "c4",
      lead: `#${LONG_NAME}`,
      insert: `#${LONG_NAME} `,
    });
    const value = "다음은 #회고";
    const caret = value.length;
    const query = composerTriggerQueryAt(value, caret)!;
    expect(insertComposerCandidate(value, caret, query.start, row.insert)).toEqual({
      value: `다음은 #${LONG_NAME} `,
      caret: `다음은 #${LONG_NAME} `.length,
    });
  });

  it("후보 수는 멘션과 같은 한 상한을 쓴다", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      channel(`x${index}`, `채널${index}`)
    );
    expect(matchChannels(many, "채널")).toHaveLength(COMPOSER_CANDIDATE_LIMIT);
  });
});

// -----------------------------------------------------------------------------
// `:` 이모지
// -----------------------------------------------------------------------------

describe("`:` 이모지 자동완성 (#1930)", () => {
  it("콜론 뒤 2자부터 발동한다", () => {
    expect(composerTriggerQueryAt(":", 1)).toBeNull();
    expect(composerTriggerQueryAt(":t", 2)).toBeNull();
    expect(composerTriggerQueryAt(":th", 3)).toEqual({
      kind: "emoji",
      start: 0,
      text: "th",
    });
  });

  it("후보와 순위가 피커의 검색 결과와 같다", async () => {
    const catalog = await loadCatalog();
    for (const query of ["th", "thumbsup", "hand"]) {
      expect(emojiCandidates(catalog, query, 0).map((row) => row.lead)).toEqual(
        filterEmojis(catalog, query)
          .slice(0, COMPOSER_CANDIDATE_LIMIT)
          .map((entry) => displayGlyph(entry, 0))
      );
    }
    const [first] = emojiCandidates(catalog, "thumbsup", 0);
    expect(first.insert).toBe("👍️ ");
    expect(first.base).toBe("👍️");
  });

  it("스킨톤은 삽입 글리프에만 반영되고 빈도 신원은 기준 글리프다", async () => {
    const catalog = await loadCatalog();
    const [row] = emojiCandidates(catalog, "thumbsup", 3);
    expect(row.lead).toBe("👍🏽");
    expect(row.insert).toBe("👍🏽 ");
    expect(row.base).toBe("👍️");
  });

  it("긴 질의도 규칙을 통과한다", async () => {
    const catalog = await loadCatalog();
    expect(emojiCandidates(catalog, "thumbsupthumbsup", 0)).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// 코드 서식 안 억제
// -----------------------------------------------------------------------------

describe("코드 서식 안에서는 셋 다 열리지 않는다 (#1930)", () => {
  it.each([
    ["멘션", "`@her"],
    ["채널", "`#gen"],
    ["이모지", "`:thu"],
  ])("닫히지 않은 인라인 코드 안의 %s", (_name, value) => {
    expect(composerTriggerQueryAt(value, value.length)).toBeNull();
  });

  it.each([
    ["멘션", "```\n@her"],
    ["채널", "```\n#gen"],
    ["이모지", "```\n:thu"],
  ])("코드블록 안의 %s", (_name, value) => {
    expect(composerTriggerQueryAt(value, value.length)).toBeNull();
  });

  it("닫힌 인라인 코드 **뒤** 는 억제하지 않는다", () => {
    const value = "`npm run build` @her";
    expect(composerTriggerQueryAt(value, value.length)).toEqual({
      kind: "mention",
      start: 16,
      text: "her",
    });
  });

  it("닫힌 코드블록 **뒤** 는 억제하지 않는다", () => {
    const value = "```\nnpm run build\n```\n@her";
    expect(composerTriggerQueryAt(value, value.length)).toEqual({
      kind: "mention",
      start: 22,
      text: "her",
    });
  });

  it("억제 판정은 트리거 자리를 본다", () => {
    expect(isComposerCaretInCode("`@her", 1)).toBe(true);
    expect(isComposerCaretInCode("`npm run build` @her", 16)).toBe(false);
    expect(isComposerCaretInCode("```\n@her", 4)).toBe(true);
  });
});

function member(
  id: string,
  handle: string,
  displayName: string,
  status: RosterMember["status"] = "active"
): RosterMember {
  return {
    id,
    handle,
    displayName,
    kind: "human",
    status,
  } as RosterMember;
}

function channel(id: string, name: string | undefined): Channel {
  return {
    id,
    workspaceId: "w1",
    kind: "public",
    name,
    muted: false,
  };
}
