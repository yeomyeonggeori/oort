import {useCallback, useSyncExternalStore} from 'react';
import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

// =============================================================================
// 검색 탭의 「최근 검색」과 「최근 연 대화」 — 이 기기에만 남긴다 (#5365).
//
// 서버는 둘 다 모른다. 서버가 쓰는 「최근 활동」은 채널에 활동 시각이 없어 지금은 말할 수 없고, 사람이 친 검색어는
// 서버가 가질 이유가 없다. 그래서 MMKV 한 키에 JSON 한 덩이로 둔다(허용 키 `searchRecents`).
//
// ## 열쇠는 작업공간과 멤버 둘이다
//
// 한 폰에 다른 사람이 들어와도 앞사람이 친 말이 보이면 안 된다. 열쇠에 멤버 id 를 넣어 두 사람이 서로의 칸을 보지
// 못하게 하고, 사람이 직접 나갈 때(`signOut`)는 통째로 비운다(`clearAllSearchRecents`). 토큰 만료로 세션이 끊긴 경우는
// 이 칸이 남지만 열쇠가 달라 다른 멤버에게는 닿지 않는다.
//
// ## 글이 아니라 목록이다
//
// 검색어는 사람이 방금 화면에서 친 글자이고 서버가 본 적이 없다 — `composerDrafts` 와 같은 종류라서 정원을 두고(검색어
// 6개, 대화 10개) 길이도 자른다. 대화는 **id 만** 적는다: 이름·얼굴은 보여 줄 때 목록에서 풀어서, 이름이 바뀌거나
// 나간 대화가 낡은 글자로 남지 않는다.
//
// ## 두 군데가 읽는다
//
// 검색 화면은 탭이라 한 번 열리면 계속 마운트돼 있고, 「최근 연 대화」는 셸이 대화를 열 때마다 쓴다. 화면이 열릴 때만
// 읽으면 방금 연 대화가 안 보이므로, 저장소를 구독하는 작은 외부 스토어(`useSyncExternalStore`)로 둔다.
//
// ## 최근 검색은 **한 목록**이다 (#5384, owner 시안 추천)
//
// 홈 검색과 대화 안 검색이 같은 목록을 쓴다 — 어디서 찾았든 방금 찾은 말이 두 화면의 「최근 검색」 맨 앞에 선다. 한 줄은 `{query, channelId?}` 이다: **범위가 있는 검색**(한 대화 안에서
// 찾은 것 — 대화 안 검색 전부, 홈의 「메시지」 칩 + 「대화 고르기」)은 그 대화의 id 를 함께 들고 두 화면이 범위 칩과 함께 보여 준다. 같은 말이라도 범위가 다르면 다른 줄이다
// (모든 대화에서 찾은 「배포」와 #general 에서 찾은 「배포」). 정원은 그대로 6줄이다.
//
// 옛 저장(`conversationSearchRecent`, 대화 안 검색이 따로 들던 지도)은 처음 읽는 열쇠로 옮겨 오고 지운다(`adoptLegacy`). 그 지도는 멤버 없이 `워크스페이스:채널` 열쇠였으므로, 같은 워크스페이스의
// 처음 읽는 멤버가 가져간다(그 저장도 로그아웃이 지웠고, 이 칸의 지도가 열쇠에 멤버를 넣은 것은 그보다 낫다).
// =============================================================================

export const RECENT_SEARCH_MAX = 6;
export const RECENT_CONVERSATION_MAX = 10;
/** 붙여넣은 문단이 목록 한 줄을 차지하지 않게 한다. */
export const RECENT_QUERY_MAX_CHARS = 80;

/** 최근 검색 한 줄. 범위가 있으면(`channelId`) 그 대화 안에서 찾은 말이다. */
export interface RecentSearch {
  query: string;
  /** 한 대화 안에서 찾았다면 그 채널 id(소문자). 없으면 모든 대화에서 찾은 말이다. */
  channelId?: string;
}

export interface SearchRecents {
  /** 맨 앞이 가장 최근이다. */
  searches: readonly RecentSearch[];
  /** 채널 id(소문자). 맨 앞이 가장 최근이다. */
  conversations: readonly string[];
}

const EMPTY: SearchRecents = {searches: [], conversations: []};

export function recentsScope(workspaceId: string, memberId: string): string {
  return `${workspaceId.toLowerCase()}:${memberId.toLowerCase()}`;
}

/** 같은 줄인가 — 같은 글(대소문자만 다른 것 포함)이고 범위도 같다. 같은 말이라도 범위가 다르면 다른 줄이다. */
function sameSearch(a: RecentSearch, b: RecentSearch): boolean {
  return a.query.toLowerCase() === b.query.toLowerCase() && a.channelId === b.channelId;
}

/** 줄 하나. 범위가 없으면 `channelId` 키를 아예 두지 않는다(저장 모양이 「없으면 없다」를 지킨다). */
function entry(query: string, channelId: string | undefined): RecentSearch {
  return channelId === undefined ? {query} : {query, channelId: channelId.toLowerCase()};
}

/** 맨 앞에 더한다. 같은 줄(같은 글·같은 범위)은 하나로 합치고 정원 밖은 자른다. */
export function withSearch(
  list: readonly RecentSearch[],
  query: string,
  channelId?: string,
): readonly RecentSearch[] {
  const text = Array.from(query.trim()).slice(0, RECENT_QUERY_MAX_CHARS).join('');
  if (text === '') return list;
  const added = entry(text, channelId);
  return [added, ...list.filter(item => !sameSearch(item, added))].slice(0, RECENT_SEARCH_MAX);
}

export function withConversation(list: readonly string[], channelId: string): readonly string[] {
  const key = channelId.toLowerCase();
  return [key, ...list.filter(item => item !== key)].slice(0, RECENT_CONVERSATION_MAX);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item !== '')
    : [];
}

/**
 * 저장된 최근 검색 한 줄. 옛 모양(글 하나짜리 문자열 — 한 목록이 되기 전)과 새 모양(`{query, channelId?}`)을 모두 읽는다. 모양이 틀린 줄만 건너뛴다.
 */
function searchesOf(value: unknown): RecentSearch[] {
  if (!Array.isArray(value)) return [];
  const out: RecentSearch[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      if (item !== '') out.push({query: item});
    } else if (item !== null && typeof item === 'object') {
      const {query, channelId} = item as Record<string, unknown>;
      if (typeof query !== 'string' || query === '') continue;
      out.push(typeof channelId === 'string' && channelId !== '' ? entry(query, channelId) : {query});
    }
  }
  return out;
}

/** 저장값 → 열쇠별 목록. 망가진 값은 빈 표로 읽는다(최근 목록은 없어도 되는 편의다). */
export function parseRecents(raw: string | undefined): Record<string, SearchRecents> {
  if (raw === undefined) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, SearchRecents> = {};
    for (const [scope, saved] of Object.entries(value as Record<string, unknown>)) {
      if (saved === null || typeof saved !== 'object') continue;
      const {searches, conversations} = saved as Record<string, unknown>;
      out[scope] = {
        searches: searchesOf(searches).slice(0, RECENT_SEARCH_MAX),
        conversations: strings(conversations).slice(0, RECENT_CONVERSATION_MAX),
      };
    }
    return out;
  } catch {
    return {};
  }
}

let cache: Record<string, SearchRecents> | null = null;
const listeners = new Set<() => void>();
/** 옛 대화 안 검색 저장을 이미 살펴본 열쇠들(이 실행 안에서). 한 열쇠가 한 번만 옮긴다. */
const adopted = new Set<string>();

function table(): Record<string, SearchRecents> {
  cache ??= parseRecents(nonSecretStore().getString(NON_SECRET_KEYS.searchRecents));
  return cache;
}

function persist(): void {
  try {
    nonSecretStore().set(NON_SECRET_KEYS.searchRecents, JSON.stringify(cache ?? {}));
  } catch {
    // 편의일 뿐이다 — 못 쓰면 이 실행 동안만 남는다.
  }
}

function publish(next: Record<string, SearchRecents>): void {
  cache = next;
  persist();
  listeners.forEach(listener => listener());
}

/**
 * 옛 대화 안 검색 저장(`conversationSearchRecent`)을 이 열쇠의 한 목록으로 옮기고 지운다 (#5384).
 *
 * 옛 지도는 열쇠가 `워크스페이스:채널`(소문자), 값이 그 대화의 말 목록(최근이 앞)이고 지도의 열쇠 순서가 대화의 최근 순서(맨 뒤가 가장 최근)였다. 이 열쇠의 워크스페이스에 속한 대화만 가져온다:
 * 가장 최근에 쓴 대화부터, 각 대화의 말은 순서대로 — 이미 이 목록에 있던 줄(새 것)이 앞이고 옮겨 온 줄은 그 뒤다. 다른 워크스페이스의 대화는 옛 지도에 남겨 두었다가 그 워크스페이스를
 * 처음 읽을 때 옮긴다 — 지도가 비면 키를 지운다. 읽기·쓰기가 저장소 오류로 던져도 검색은 멈추지 않는다.
 *
 * 읽는 쪽(`recentsFor`)이 첫 읽기 때 부르므로 **구독이 걸리기 전**에 끝난다 — 알릴 사람이 없다.
 */
function adoptLegacy(scope: string): void {
  if (adopted.has(scope)) return;
  adopted.add(scope);
  try {
    const store = nonSecretStore();
    const raw = store.getString(NON_SECRET_KEYS.conversationSearchRecent);
    if (raw === undefined) return;
    const workspace = scope.slice(0, Math.max(0, scope.indexOf(':')));
    // 깨진 값은 빈 지도로 읽는다(옛 모듈과 같다) — 그러면 아래에서 키가 지워져 읽을 수 없는 것이 영영 남지 않는다.
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = null;
    }
    const legacy =
      parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const rest: Record<string, unknown> = {};
    const mine: Array<{channelId: string; terms: string[]}> = [];
    for (const [key, value] of Object.entries(legacy)) {
      const split = key.indexOf(':');
      if (split > 0 && key.slice(0, split) === workspace) {
        const terms = strings(value);
        if (terms.length > 0) mine.push({channelId: key.slice(split + 1), terms});
      } else {
        rest[key] = value;
      }
    }
    if (mine.length > 0) {
      const current = table()[scope] ?? EMPTY;
      let searches: readonly RecentSearch[] = current.searches;
      // 지도의 맨 뒤가 가장 최근 대화다 — 최근 대화부터, 각 대화의 말은 저장된 순서대로. 옮겨 온 줄은 이미 있던 줄보다 오래된 것이니 뒤에 붙인다.
      for (const {channelId, terms} of mine.reverse()) {
        for (const term of terms) {
          const line = entry(term, channelId);
          if (!searches.some(existing => sameSearch(existing, line))) searches = [...searches, line];
        }
      }
      cache = {...table(), [scope]: {...current, searches: searches.slice(0, RECENT_SEARCH_MAX)}};
      persist();
    }
    if (Object.keys(rest).length === 0) store.remove(NON_SECRET_KEYS.conversationSearchRecent);
    else store.set(NON_SECRET_KEYS.conversationSearchRecent, JSON.stringify(rest));
  } catch {
    // 옛 저장을 못 읽어도 새 목록은 그대로 선다. 옮기지 못한 말은 다음 실행에 다시 시도한다(키가 남아 있으므로) — `adopted` 는 이 실행 동안의 기억일 뿐이다.
  }
}

export function recentsFor(scope: string): SearchRecents {
  adoptLegacy(scope);
  return table()[scope] ?? EMPTY;
}

/** 한 말을 맨 앞에 남긴다. `channelId` 가 있으면 그 대화 안에서 찾은 말이다(범위 칩과 함께 보인다). */
export function rememberSearch(scope: string, query: string, channelId?: string): void {
  const current = recentsFor(scope);
  const searches = withSearch(current.searches, query, channelId);
  if (searches === current.searches) return;
  publish({...table(), [scope]: {...current, searches}});
}

export function forgetSearches(scope: string): void {
  const current = recentsFor(scope);
  if (current.searches.length === 0) return;
  publish({...table(), [scope]: {...current, searches: []}});
}

export function rememberConversation(scope: string, channelId: string): void {
  const current = recentsFor(scope);
  if (current.conversations[0] === channelId.toLowerCase()) return;
  publish({
    ...table(),
    [scope]: {...current, conversations: withConversation(current.conversations, channelId)},
  });
}

/**
 * 사람이 직접 나갈 때: 모든 열쇠의 목록을 지운다. 옛 대화 안 검색 저장이 아직 남아 있어도(옮기기 전에 나갔다) 함께 지운다 —
 * 무엇을 찾았는지는 다음 사람에게 보일 일이 아니다.
 */
export function clearAllSearchRecents(): void {
  cache = {};
  listeners.forEach(listener => listener());
  try {
    nonSecretStore().remove(NON_SECRET_KEYS.searchRecents);
    nonSecretStore().remove(NON_SECRET_KEYS.conversationSearchRecent);
  } catch {
    // 지우지 못해도 메모리는 비웠다.
  }
}

/** Test seam: 메모리에 든 사본과 「옛 저장을 살펴봤다」는 기억을 버려 다음 읽기가 저장소를 다시 읽게 한다. */
export function __resetSearchRecentsCache(): void {
  cache = null;
  adopted.clear();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** 이 열쇠의 목록. 바뀔 때만 새 값이라 화면이 쓸데없이 다시 그려지지 않는다. */
export function useSearchRecents(scope: string): SearchRecents {
  const read = useCallback(() => recentsFor(scope), [scope]);
  return useSyncExternalStore(subscribe, read, read);
}
