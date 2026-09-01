import type { Channel, RosterMember } from "@momo/core/lib/api";
import type { CatalogEmoji, SkinTone } from "@/features/emoji/catalog";
import { displayGlyph } from "@/features/emoji/catalog";
import { filterEmojis, normalizeEmojiQuery } from "@/features/emoji/search";
import type { ComposerInsertion } from "./composerInsertion";

// =============================================================================
// 컴포저 자동완성의 **한 기계** (#1930).
//
// `@`·`#`·`:` 는 서로 다른 세 기능이 아니라 한 문법의 세 글자다. 참조한 buzz 는
// 트리거마다 파일을 하나씩 두었고(MentionAutocomplete / ChannelAutocomplete /
// EmojiAutocomplete), 그 갈라짐의 대가는 앵커 규율이 세 벌이 되는 것이다 —
// `@` 쪽만 고치면 `#` 은 옛 규칙으로 남고, 둘의 차이는 아무 시험도 보지 않는다.
//
// 그래서 여기에는 파서가 하나, 후보 행 모양이 하나, (호출측의) 키보드 처리가
// 하나뿐이다. 트리거별 차이는 **데이터**로만 존재한다: 후보 소스와 삽입
// 직렬화, 그리고 최소 질의 길이. 새 트리거를 하나 더 열고 싶으면 아래 표에 줄을
// 하나 더하고 후보 빌더를 하나 쓰면 되고, 파서를 다시 쓸 일은 없다.
// =============================================================================

export type ComposerTriggerKind = "mention" | "channel" | "emoji";

export interface ComposerTriggerSpec {
  kind: ComposerTriggerKind;
  /** 이 질의를 여는 한 글자. */
  char: string;
  /**
   * 트리거 뒤 최소 글자 수. 이보다 짧으면 질의가 아예 열리지 않는다.
   *
   * `:` 만 2를 요구한다. 콜론 한 글자로 이모지 카탈로그(실측 1914칸)가 통째로
   * 열리는 것은 자동완성이 아니라 사고이고, 피커가 같은 자리에서 같은 판정을
   * 이미 내려 두었다(`isEmojiSearchQuery`, design-review #1746 H-2).
   */
  minQuery: number;
  /** listbox 의 접근 이름. */
  listLabel: string;
  /** DOM id·testid 의 조각. */
  slug: string;
}

export const COMPOSER_TRIGGER_SPECS: readonly ComposerTriggerSpec[] = [
  {
    kind: "mention",
    char: "@",
    minQuery: 0,
    listLabel: "멘션 선택",
    slug: "mention",
  },
  {
    kind: "channel",
    char: "#",
    minQuery: 0,
    listLabel: "채널 선택",
    slug: "channel",
  },
  { kind: "emoji", char: ":", minQuery: 2, listLabel: "이모지 선택", slug: "emoji" },
];

const SPEC_BY_CHAR = new Map(
  COMPOSER_TRIGGER_SPECS.map((spec) => [spec.char, spec])
);

const SPEC_BY_KIND = new Map(
  COMPOSER_TRIGGER_SPECS.map((spec) => [spec.kind, spec])
);

export function composerTriggerSpec(kind: ComposerTriggerKind): ComposerTriggerSpec {
  const spec = SPEC_BY_KIND.get(kind);
  if (!spec) throw new Error(`알 수 없는 트리거 ${kind}`);
  return spec;
}

/** 멘션과 같은 상한을 셋이 함께 쓴다. 목록 하나가 화면을 덮지 않는 길이. */
export const COMPOSER_CANDIDATE_LIMIT = 6;

export interface ComposerTriggerQuery {
  kind: ComposerTriggerKind;
  /** 질의를 연 트리거 글자의 인덱스. */
  start: number;
  text: string;
}

/** `@` 질의. 선택 서식 트레이(#1902)가 이 모양으로 읽는다. */
export interface MentionQuery {
  start: number;
  text: string;
}

const FENCE_LINE = /^\s{0,3}```/;

/**
 * 이 자리가 코드 서식 **안**인가.
 *
 * 서식 트레이(#1902)가 넣는 두 가지를 본다: 인라인 코드 `` `…` `` 와 ```` ``` ````
 * 블록. 코드 안에서 `@`·`#`·`:` 는 사람이 부르는 이름이 아니라 코드의 글자이고,
 * 거기서 목록이 뜨면 붙여넣은 로그 한 줄이 자동완성 창을 계속 띄운다.
 *
 * 인덱스는 **트리거 글자의 자리**를 받는다. 캐럿이 아니라 트리거를 묻는 이유는
 * `` `npm run build` @her `` 처럼 코드가 이미 닫힌 뒤의 멘션은 코드가 아니기
 * 때문이다 — 그 판정은 트리거가 어디 섰는지로만 갈린다.
 */
export function isComposerCaretInCode(value: string, index: number): boolean {
  const at = Math.min(Math.max(index, 0), value.length);
  const lineStart = value.lastIndexOf("\n", at - 1) + 1;
  let fenceOpen = false;
  for (const line of value.slice(0, lineStart).split("\n")) {
    if (FENCE_LINE.test(line)) fenceOpen = !fenceOpen;
  }
  if (fenceOpen) return true;
  const line = value.slice(lineStart, at);
  // 여는 펜스 줄 자체(```` ```sh ````)도 본문이 아니다.
  if (FENCE_LINE.test(line)) return true;
  let ticks = 0;
  for (const char of line) {
    if (char === "`") ticks += 1;
  }
  return ticks % 2 === 1;
}

/**
 * 캐럿에 열려 있는 자동완성 질의, 없으면 null. **세 트리거의 유일한 파서다.**
 *
 * 규율은 멘션이 쓰던 것 그대로이고 셋이 함께 쓴다:
 *
 * 1. 질의에는 공백이 없다. 캐럿에서 뒤로 훑다 공백을 먼저 만나면 열린 질의가 없다.
 * 2. 트리거는 줄 시작이거나 공백 뒤에서만 연다(비공백 캐럿 앵커). 그래서
 *    `person@example.com` 도 `issue#1930` 도 질의가 아니다.
 * 3. 앵커에 실패한 트리거 글자는 **평범한 본문**이므로 거기서 멈추지 않고 계속
 *    뒤로 훑는다. `@hermes:` 를 칠 때 콜론 하나가 열려 있던 멘션 목록을 죽이면
 *    안 되고, 이 한 줄이 그것을 막는다.
 * 4. 코드 서식 안이면 열지 않는다(`allowInCode` 로만 끈다 — 아래 참조).
 */
export function composerTriggerQueryAt(
  value: string,
  caret: number,
  options?: {
    /**
     * 코드 억제를 끈다. 문법만 묻는 자리(`mentionQueryAt`)를 위한 것이고,
     * 자동완성 기계는 절대 쓰지 않는다.
     */
    allowInCode?: boolean;
  }
): ComposerTriggerQuery | null {
  const end = Math.min(Math.max(caret, 0), value.length);
  for (let at = end - 1; at >= 0; at -= 1) {
    const char = value[at];
    if (/\s/.test(char)) return null;
    const spec = SPEC_BY_CHAR.get(char);
    if (spec === undefined) continue;
    if (at > 0 && !/\s/.test(value[at - 1])) continue;
    const text = value.slice(at + 1, end);
    if (text.length < spec.minQuery) return null;
    if (options?.allowInCode !== true && isComposerCaretInCode(value, at)) {
      return null;
    }
    return { kind: spec.kind, start: at, text };
  }
  return null;
}

/**
 * 캐럿의 `@` 질의, 없으면 null. 같은 기계에서 멘션만 갈라 본다.
 *
 * 코드 억제를 끄고 부르는 이유: 이 함수의 소비자는 선택 서식 트레이이고,
 * 트레이가 묻는 것은 「지금 멘션을 치는 중인가」라는 **문법** 질문이다. 코드
 * 안 선택에 서식을 걸지 말지는 트레이가 스스로 정할 일이지 멘션 문법이 답할
 * 것이 아니다.
 */
export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const query = composerTriggerQueryAt(value, caret, { allowInCode: true });
  if (query === null || query.kind !== "mention") return null;
  return { start: query.start, text: query.text };
}

/** 후보 한 줄. 세 트리거가 같은 모양으로 그려지고 같은 방식으로 삽입된다. */
export interface ComposerCandidate {
  kind: ComposerTriggerKind;
  /** 목록 key. 멤버 id · 채널 id · 이모지 글리프. */
  id: string;
  /** 왼쪽 자리. `@handle` · `#name` · 이모지 글리프. */
  lead: string;
  /** 오른쪽 흐린 자리. 사람 이름 · 채널 주제 · 이모지 숏코드. */
  hint: string;
  /** 트리거 자리부터 캐럿까지를 대체할 문자열. 뒤 공백을 포함한다. */
  insert: string;
  /**
   * 이모지만 — 빈도 가산의 기준 글리프.
   *
   * 스킨톤을 입힌 글자가 아니라 카탈로그의 신원을 센다. 피커가 같은 규율이다
   * (`EmojiPickerPanel.onPick(displayGlyph(entry, tone), entry.glyph)`): 톤을
   * 바꿨다고 「자주 씀」이 갈라지면 한 사람의 습관이 여섯 벌로 흩어진다.
   */
  base?: string;
}

/** 활성 멤버를 핸들·표시 이름 부분일치로 좁힌다. #1930 이전 규칙 그대로. */
export function matchMembers(
  members: RosterMember[],
  query: string,
  limit = COMPOSER_CANDIDATE_LIMIT
): RosterMember[] {
  const needle = query.trim().toLowerCase();
  const active = members.filter((member) => member.status === "active");
  const matched = needle
    ? active.filter(
        (member) =>
          member.handle.toLowerCase().includes(needle) ||
          member.displayName.toLowerCase().includes(needle)
      )
    : active;
  return matched.slice(0, limit);
}

/**
 * 내가 든 채널 목록을 이름 부분일치로 좁힌다. 멘션과 같은 자다.
 *
 * DM 과 보관된 방은 후보가 아니다: `#` 는 **방 이름**을 부르는 글자이고, DM 은
 * 이름이 없고(스키마상 `name` 이 null), 보관된 방은 사이드바에서도 물러난 방이다.
 * 새 서버 표면을 열지 않는다 — 이미 받아 둔 채널 스토어를 그대로 읽는다.
 */
export function matchChannels(
  channels: Channel[],
  query: string,
  limit = COMPOSER_CANDIDATE_LIMIT
): Channel[] {
  const needle = query.trim().toLowerCase();
  const open = channels.filter(
    (channel) =>
      channel.kind !== "dm" &&
      channel.archivedAtMs === undefined &&
      (channel.name ?? "") !== ""
  );
  const matched = needle
    ? open.filter((channel) => (channel.name ?? "").toLowerCase().includes(needle))
    : open;
  return matched.slice(0, limit);
}

export function memberCandidates(
  members: RosterMember[],
  query: string,
  limit = COMPOSER_CANDIDATE_LIMIT
): ComposerCandidate[] {
  return matchMembers(members, query, limit).map((member) => ({
    kind: "mention" as const,
    id: member.id,
    lead: `@${member.handle}`,
    hint: member.displayName,
    // 코어 `mentionTokenAt` 이 읽는 그 문법이다. 삽입은 평문이고, 렌더가
    // 그 평문을 다시 토큰으로 읽는다 — 보이지 않는 신원을 본문에 심지 않는다.
    insert: `@${member.handle} `,
  }));
}

// ## `#` 는 v1 에서 **삽입까지**다 — 렌더 링크화는 이 티켓이 하지 않는다 (#1930)
//
// 티켓의 축소 조항을 쓴다. 사유를 남겨 두는 이유는 다음 사람이 이것을 미완이
// 아니라 결정으로 읽어야 하기 때문이다.
//
// 1. **코어에 없는 문법이다.** 타임라인이 `@` 를 스타일하는 근거는
//    `mentionTokenAt` 의 핸들 문법 `[A-Za-z0-9_.-]+` 인데, 채널 `name` 은
//    스키마상 자유 텍스트다(`schema_v0.sql` channel.name text — 유일성 제약만
//    있고 글자 제약이 없다. 실제로 「엔진」처럼 한글이고 공백도 담을 수 있다).
//    `#` 를 렌더하려면 그 자유 텍스트를 담는 **새 토큰 문법**을 코어에 세워야
//    하고, 코어는 폰 클라이언트까지 함께 출하되는 정본이다.
// 2. **해소원이 렌더러에 없다.** 이름→채널 id 는 워크스페이스 채널 목록이
//    답하는데, `MessageBody` 가 드는 것은 `MentionRendering`(활성 핸들 집합)뿐
//    이다. 링크를 그리려면 채널 디렉터리를 그 옆에 하나 더 달아 타임라인·스레드·
//    검색·인박스 미리보기의 모든 호출부로 관통시켜야 한다.
//
// 그래서 v1 은 「삽입 = `#이름` 평문 + 후보 선택 UX」까지다. 삽입 직렬화는 멘션과
// 동형이라(트리거 글자 + 이름 + 공백) 나중에 문법이 서면 이미 쓰여 있는 글이
// 그대로 링크가 된다. `/c/{id}` 딥링크 문법(`features/inbox/anchor.ts`
// `channelPath`)은 그때 재사용할 자리이고, 후속 티켓이 든다.
export function channelCandidates(
  channels: Channel[],
  query: string,
  limit = COMPOSER_CANDIDATE_LIMIT
): ComposerCandidate[] {
  return matchChannels(channels, query, limit).map((channel) => {
    const name = channel.name ?? "";
    return {
      kind: "channel" as const,
      id: channel.id,
      lead: `#${name}`,
      hint: channel.topic ?? "",
      insert: `#${name} `,
    };
  });
}

/**
 * 이모지 후보. **피커와 같은 열**이어야 한다.
 *
 * 순위를 여기서 다시 매기지 않고 `filterEmojis` 가 돌려준 순서를 그대로 자른다.
 * 검색 결과의 순서는 피커가 이미 정해 둔 사실이고, 같은 질의에 두 표면이 다른
 * 첫 번째를 내놓으면 사람이 외운 근육이 표면마다 갈라진다.
 */
/**
 * 오른쪽 흐린 자리에 **지금 친 글자가 맞춘 그 숏코드**를 보인다.
 *
 * 첫 숏코드를 그냥 쓰면 `:thu` 가 👍 를 맞춰 놓고 `:+1:` 이라고 적는다 —
 * 사람이 방금 친 글자와 화면이 보여 주는 이름이 다르면 그 줄이 왜 거기 있는지
 * 알 수 없다. 못 맞추면(이름·키워드로 걸린 줄) 첫 숏코드로 돌아간다.
 */
function matchedShortcode(entry: CatalogEmoji, needle: string): string {
  const matched = needle
    ? entry.shortcodes.find((code) => code.includes(needle))
    : undefined;
  const code = matched ?? entry.shortcodes[0];
  return code ? `:${code}:` : entry.name;
}

export function emojiCandidates(
  entries: readonly CatalogEmoji[],
  query: string,
  tone: SkinTone,
  limit = COMPOSER_CANDIDATE_LIMIT
): ComposerCandidate[] {
  const needle = normalizeEmojiQuery(query);
  return filterEmojis(entries, query)
    .slice(0, limit)
    .map((entry) => {
      const shown = displayGlyph(entry, tone);
      return {
        kind: "emoji" as const,
        id: entry.glyph,
        lead: shown,
        hint: matchedShortcode(entry, needle),
        insert: `${shown} `,
        base: entry.glyph,
      };
    });
}

/**
 * 트리거 자리부터 캐럿까지를 후보의 직렬화로 갈아 끼우고, 그 뒤의 캐럿을 준다.
 *
 * 세 트리거가 이 한 함수를 지난다. 범위는 방어적으로 본문 안에 가둔다 —
 * selectionStart 와 String.length 는 둘 다 UTF-16 code unit 이라 이모지가
 * surrogate pair 여도 글자 수 변환이 필요 없다.
 */
export function insertComposerCandidate(
  value: string,
  caret: number,
  start: number,
  insert: string
): ComposerInsertion {
  const end = Math.min(Math.max(caret, 0), value.length);
  const from = Math.min(Math.max(start, 0), end);
  return {
    value: `${value.slice(0, from)}${insert}${value.slice(end)}`,
    caret: from + insert.length,
  };
}

/** 멘션 삽입. #1930 이전과 한 글자도 다르지 않은 결과를 낸다. */
export function insertMention(
  value: string,
  caret: number,
  query: MentionQuery,
  handle: string
): ComposerInsertion {
  return insertComposerCandidate(value, caret, query.start, `@${handle} `);
}
