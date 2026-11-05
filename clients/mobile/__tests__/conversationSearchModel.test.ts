import {
  foldRecent,
  newerIndex,
  olderIndex,
  RECENT_CONVERSATION_LIMIT,
  RECENT_LIMIT,
  searchPosition,
} from '../src/features/conversation/conversationSearchModel';
import {
  clearAllConversationSearchRecent,
  forgetRecent,
  readRecent,
  recentKey,
  rememberRecent,
} from '../src/features/conversation/conversationSearchRecent';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {mmkvStore, resetSession} from './testkit';

// =============================================================================
// 대화 안 검색의 순수 규칙과 「최근 검색」 저장 (#5364). 화면은 `conversationSearch.test.tsx` 가 잰다.
// =============================================================================

beforeEach(() => {
  resetSession();
});

describe('최근 검색 — 접기와 저장(기기에만)', () => {
  it('서버가 안 받아 줄 말은 남기지 않고, 같은 말은 하나로 합쳐 맨 앞에 두며, 정원을 넘는 꼬리는 버린다', () => {
    expect(foldRecent(['배포'], ' 가 ')).toEqual(['배포']);
    expect(foldRecent(['루나', '배포', '롤백'], ' 배포 ')).toEqual(['배포', '루나', '롤백']);
    const next = foldRecent(['a1', 'a2', 'a3', 'a4', 'a5', 'a6'], 'new');
    expect(next).toHaveLength(RECENT_LIMIT);
    expect(next[0]).toBe('new');
    expect(next).not.toContain('a6');
  });

  it('대화마다 따로 남고(열쇠는 대소문자를 눕힌다), 깨진 값은 빈 목록으로 읽으며, 대화 정원을 넘으면 가장 오래 안 쓴 대화가 먼저 떨어진다', () => {
    rememberRecent('WS-1', 'CH-A', '배포');
    rememberRecent('ws-1', 'ch-b', '루나');
    expect(readRecent('ws-1', 'ch-a')).toEqual(['배포']);
    expect(readRecent('ws-1', 'ch-b')).toEqual(['루나']);
    expect(recentKey('WS-1', 'CH-A')).toBe('ws-1:ch-a');
    forgetRecent('ws-1', 'ch-a');
    expect(readRecent('ws-1', 'ch-a')).toEqual([]);

    mmkvStore.set(NON_SECRET_KEYS.conversationSearchRecent, '{ 이건 JSON 이 아니다');
    expect(readRecent('ws', 'ch')).toEqual([]);
    mmkvStore.set(NON_SECRET_KEYS.conversationSearchRecent, JSON.stringify({'ws:ch': ['배포', 42, ''], 'ws:other': 'x'}));
    expect(readRecent('ws', 'ch')).toEqual(['배포']);
    expect(readRecent('ws', 'other')).toEqual([]);

    clearAllConversationSearchRecent();
    for (let index = 0; index <= RECENT_CONVERSATION_LIMIT; index += 1) rememberRecent('ws', `ch-${index}`, '배포');
    expect(readRecent('ws', 'ch-0')).toEqual([]);
    expect(readRecent('ws', `ch-${RECENT_CONVERSATION_LIMIT}`)).toEqual(['배포']);
  });
});

describe('번호 이동 — 최근 결과가 1번이다', () => {
  it('↑ 는 번호가 커지는 쪽(불러온 끝에서 null), ↓ 는 작아지는 쪽(1번에서 null)이고, 총 건수는 불러온 수 + 뒤에 더 있는지다', () => {
    expect(olderIndex(0, 3)).toBe(1);
    expect(olderIndex(2, 3)).toBeNull();
    expect(newerIndex(2)).toBe(1);
    expect(newerIndex(0)).toBeNull();
    expect(searchPosition(2, 20, true)).toEqual({index: 3, total: 20, more: true});
    expect(searchPosition(2, 3, false)).toEqual({index: 3, total: 3, more: false});
    expect(searchPosition(null, 3, false)).toBeNull();
    expect(searchPosition(3, 3, false)).toBeNull();
  });
});
