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
// =============================================================================

export const RECENT_SEARCH_MAX = 6;
export const RECENT_CONVERSATION_MAX = 10;
/** 붙여넣은 문단이 목록 한 줄을 차지하지 않게 한다. */
export const RECENT_QUERY_MAX_CHARS = 80;

export interface SearchRecents {
  searches: readonly string[];
  /** 채널 id(소문자). 맨 앞이 가장 최근이다. */
  conversations: readonly string[];
}

const EMPTY: SearchRecents = {searches: [], conversations: []};

export function recentsScope(workspaceId: string, memberId: string): string {
  return `${workspaceId.toLowerCase()}:${memberId.toLowerCase()}`;
}

/** 맨 앞에 더한다. 같은 글(대소문자만 다른 것 포함)은 하나로 합치고 정원 밖은 자른다. */
export function withSearch(list: readonly string[], query: string): readonly string[] {
  const text = Array.from(query.trim()).slice(0, RECENT_QUERY_MAX_CHARS).join('');
  if (text === '') return list;
  const key = text.toLowerCase();
  return [text, ...list.filter(item => item.toLowerCase() !== key)].slice(0, RECENT_SEARCH_MAX);
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

/** 저장값 → 열쇠별 목록. 망가진 값은 빈 표로 읽는다(최근 목록은 없어도 되는 편의다). */
export function parseRecents(raw: string | undefined): Record<string, SearchRecents> {
  if (raw === undefined) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    const out: Record<string, SearchRecents> = {};
    for (const [scope, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object') continue;
      const {searches, conversations} = entry as Record<string, unknown>;
      out[scope] = {
        searches: strings(searches).slice(0, RECENT_SEARCH_MAX),
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

function table(): Record<string, SearchRecents> {
  cache ??= parseRecents(nonSecretStore().getString(NON_SECRET_KEYS.searchRecents));
  return cache;
}

function publish(next: Record<string, SearchRecents>): void {
  cache = next;
  try {
    nonSecretStore().set(NON_SECRET_KEYS.searchRecents, JSON.stringify(next));
  } catch {
    // 편의일 뿐이다 — 못 쓰면 이 실행 동안만 남는다.
  }
  listeners.forEach(listener => listener());
}

export function recentsFor(scope: string): SearchRecents {
  return table()[scope] ?? EMPTY;
}

export function rememberSearch(scope: string, query: string): void {
  const current = recentsFor(scope);
  const searches = withSearch(current.searches, query);
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

/** 사람이 직접 나갈 때: 모든 열쇠의 목록을 지운다. */
export function clearAllSearchRecents(): void {
  cache = {};
  listeners.forEach(listener => listener());
  try {
    nonSecretStore().remove(NON_SECRET_KEYS.searchRecents);
  } catch {
    // 지우지 못해도 메모리는 비웠다.
  }
}

/** Test seam: 메모리에 든 사본을 버려 다음 읽기가 저장소를 다시 읽게 한다. */
export function __resetSearchRecentsCache(): void {
  cache = null;
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
