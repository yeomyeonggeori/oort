import {looseTailMatches} from '@momo/core/features/channels/nameSearch';
import {compareChannelNames} from '@momo/core/features/channels/nameCollation';
import {uuidEq, type Channel, type RosterMember} from '@momo/core/lib/api';

// =============================================================================
// 검색 탭이 폰 안에서 바로 하는 일 — 채널·사람 이름 찾기 (#5365).
//
// 서버 검색은 메시지만 한다(`q`·`channel`·`cursor`). 채널과 사람은 폰이 이미 받아 둔 목록(`useChannels`·
// `useDirectory`)에서 글자마다 바로 걸러 낸다 — 네트워크도 디바운스도 없다. 규칙은 순수 함수라 화면 없이 잰다.
//
// ## 순서는 글자 규칙이 정한다 (Buzz 모바일의 같은 화면에서 모양만 읽었다)
//
//   0 이름이 그대로   1 앞부분   2 단어 시작   3 중간   4 글자가 차례대로 들어 있음
//
// 낮은 숫자가 위다. 같은 숫자끼리는 이름 가나다 순이다. 4번(차례대로)은 두 글자부터 센다: 한 글자는 3번과 같다.
//
// ## 글자 단위는 코드포인트다
//
// 이모지가 든 이름에서 `slice` 가 UTF-16 코드 단위로 끊으면 강조가 한 칸씩 밀린다. 코어 `snippetSegments` 가 같은
// 이유로 코드포인트로 센다. 범위(`[시작, 끝)`)도 코드포인트 위치이고, 자르는 쪽(`highlightParts`)도 같은 단위다.
// =============================================================================

export type SearchKind = 'all' | 'messages' | 'channels' | 'people';

/** 칩 순서. 「전체」가 먼저인 것은 열었을 때의 기본값이기 때문이다. */
export const SEARCH_KINDS: readonly SearchKind[] = ['all', 'messages', 'channels', 'people'];

/** 「전체」 화면에서 묶음마다 먼저 보이는 건수. 넘으면 그 묶음의 「더 보기」가 그 종류 칩으로 보낸다. */
export const PREVIEW_COUNT = {channels: 3, people: 3, messages: 3} as const;

/** 단어의 경계로 읽는 글자. 이름 가운데의 `-`·공백·`_` 뒤에서 시작하는 일치가 「단어 시작」이다. */
const WORD_BREAKS = new Set([' ', '-', '_', '.', '/', '·', ':']);

export type NameRank = 0 | 1 | 2 | 3 | 4;
/** `[시작, 끝)` 코드포인트 위치. 오름차순이고 서로 겹치지 않는다. */
export type MatchRanges = ReadonlyArray<readonly [number, number]>;
export interface NameMatch {
  rank: NameRank;
  ranges: MatchRanges;
}

/** 대소문자를 접는다. 접으면 글자 수가 바뀌는 드문 글자(`İ`)는 그대로 둬서 위치가 어긋나지 않게 한다. */
function fold(char: string): string {
  const lower = char.toLowerCase();
  return Array.from(lower).length === 1 ? lower : char;
}

function foldedChars(text: string): string[] {
  return Array.from(text).map(fold);
}

/** 글자 규칙으로 `text` 가 `query` 에 얼마나 맞는지. 맞지 않으면 `null`이다. */
export function matchName(query: string, text: string, loose = false): NameMatch | null {
  const needle = foldedChars(query.trim().normalize('NFC'));
  const hay = foldedChars(text);
  const size = needle.length;
  if (size === 0 || hay.length < size) return null;

  const startsAt = (from: number): boolean => needle.every((char, i) => hay[from + i] === char);

  if (startsAt(0)) return {rank: hay.length === size ? 0 : 1, ranges: [[0, size]]};
  for (let from = 1; from + size <= hay.length; from += 1) {
    if (WORD_BREAKS.has(hay[from - 1]) && startsAt(from)) {
      return {rank: 2, ranges: [[from, from + size]]};
    }
  }
  for (let from = 1; from + size <= hay.length; from += 1) {
    if (startsAt(from)) return {rank: 3, ranges: [[from, from + size]]};
  }
  // 한글을 치는 도중의 마지막 글자만 느슨하게(`디장` ↔ `디자인`, ADR-0225 D12). 채널 이름에만 켠다.
  if (loose) {
    const hits = looseTailMatches(query, text);
    const at = (predicate: (start: number) => boolean) => hits.find(hit => predicate(hit.start));
    const hit =
      at(start => start === 0) ?? at(start => WORD_BREAKS.has(hay[start - 1])) ?? hits[0];
    if (hit !== undefined) {
      const rank: NameRank = hit.start === 0 ? 1 : WORD_BREAKS.has(hay[hit.start - 1]) ? 2 : 3;
      return {rank, ranges: [[hit.start, hit.end]]};
    }
  }
  if (size < 2) return null;

  // 글자가 차례대로만 들어 있는 경우: 왼쪽부터 가장 빨리 닿는 자리를 잡는다.
  const spots: number[] = [];
  let cursor = 0;
  for (const char of needle) {
    while (cursor < hay.length && hay[cursor] !== char) cursor += 1;
    if (cursor === hay.length) return null;
    spots.push(cursor);
    cursor += 1;
  }
  const ranges: Array<[number, number]> = [];
  for (const spot of spots) {
    const last = ranges[ranges.length - 1];
    if (last !== undefined && last[1] === spot) last[1] = spot + 1;
    else ranges.push([spot, spot + 1]);
  }
  return {rank: 4, ranges};
}

/**
 * `text` 안에서 `query` 가 나오는 곳 **전부**(왼쪽부터, 서로 겹치지 않게). 말풍선 안 찾은 글자 강조(#5384)가 쓴다 — 서버 검색(ILIKE)이 대소문자를 접어 찾으므로 여기서도 접는다.
 * 위치는 코드포인트다(`highlightParts` 와 같은 단위). 질의가 비었거나 글에 없으면 `[]`.
 */
export function queryRanges(text: string, query: string): MatchRanges {
  const needle = foldedChars(query.trim());
  const hay = foldedChars(text);
  const size = needle.length;
  if (size === 0 || hay.length < size) return [];
  const ranges: Array<[number, number]> = [];
  let from = 0;
  while (from + size <= hay.length) {
    if (needle.every((char, i) => hay[from + i] === char)) {
      ranges.push([from, from + size]);
      from += size;
    } else {
      from += 1;
    }
  }
  return ranges;
}

export interface HighlightPart {
  text: string;
  match: boolean;
}

/** 범위대로 글을 강조 조각과 보통 조각으로 자른다. 범위가 비면 글 전체가 한 조각이다. */
export function highlightParts(text: string, ranges: MatchRanges): HighlightPart[] {
  const chars = Array.from(text);
  const parts: HighlightPart[] = [];
  let cursor = 0;
  for (const [start, end] of ranges) {
    if (start >= chars.length) break;
    const stop = Math.min(end, chars.length);
    if (start > cursor) parts.push({text: chars.slice(cursor, start).join(''), match: false});
    if (stop > start) parts.push({text: chars.slice(start, stop).join(''), match: true});
    cursor = Math.max(cursor, stop);
  }
  if (cursor < chars.length) parts.push({text: chars.slice(cursor).join(''), match: false});
  return parts;
}

export interface ChannelMatch {
  channel: Channel;
  name: string;
  rank: NameRank;
  ranges: MatchRanges;
}

/**
 * 내가 든 채널(공개·비공개) 중에서 이름으로 찾는다. DM 은 「사람」 묶음의 몫이라 여기에 없다.
 * 이름이 없는 채널은 걸 글자가 없어 뺀다.
 */
export function matchChannels(
  channels: readonly Channel[],
  query: string,
  /** 보는 사람의 화면 언어(`messageLocale`). 같은 순위끼리 이 언어의 차례로 세우고 숫자는 값으로 센다. */
  locale: string,
): ChannelMatch[] {
  const found: ChannelMatch[] = [];
  for (const channel of channels) {
    if (channel.kind === 'dm' || channel.name === undefined || channel.name === '') continue;
    const match = matchName(query, channel.name, true);
    if (match !== null) found.push({channel, name: channel.name, ...match});
  }
  const byName = compareChannelNames(locale);
  return found.sort((a, b) => a.rank - b.rank || byName(a.name, b.name));
}

export interface PersonMatch {
  member: RosterMember;
  rank: NameRank;
  /** 이름(`displayName`) 안의 강조 범위. 핸들로 찾았으면 비어 있다. */
  nameRanges: MatchRanges;
  /** 핸들(`@` 없이) 안의 강조 범위. 이름으로 찾았으면 비어 있다. */
  handleRanges: MatchRanges;
}

/**
 * 같은 작업공간의 사람과 에이전트(에이전트도 멤버다)를 이름이나 핸들로 찾는다.
 * 나 자신과 활성이 아닌 멤버는 뺀다. 질의가 `@` 로 시작하면 핸들만 본다.
 */
export function matchPeople(
  members: readonly RosterMember[],
  selfMemberId: string,
  query: string,
): PersonMatch[] {
  const trimmed = query.trim();
  const handleOnly = trimmed.startsWith('@');
  const needle = handleOnly ? trimmed.slice(1) : trimmed;
  const found: PersonMatch[] = [];
  for (const member of members) {
    if (member.status !== 'active' || uuidEq(member.id, selfMemberId)) continue;
    const byName = handleOnly ? null : matchName(needle, member.displayName);
    const byHandle = matchName(needle, member.handle);
    if (byName !== null && (byHandle === null || byName.rank <= byHandle.rank)) {
      found.push({member, rank: byName.rank, nameRanges: byName.ranges, handleRanges: []});
    } else if (byHandle !== null) {
      found.push({member, rank: byHandle.rank, nameRanges: [], handleRanges: byHandle.ranges});
    }
  }
  return found.sort(
    (a, b) => a.rank - b.rank || a.member.displayName.localeCompare(b.member.displayName, 'ko'),
  );
}

/** 「전체」 화면의 첫 몇 건과, 더 있는지. */
export function previewOf<T>(items: readonly T[], limit: number): {shown: T[]; more: boolean} {
  return {shown: items.slice(0, limit), more: items.length > limit};
}
