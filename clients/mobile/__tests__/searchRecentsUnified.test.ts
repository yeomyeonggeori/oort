import {
  __resetSearchRecentsCache,
  clearAllSearchRecents,
  parseRecents,
  RECENT_SEARCH_MAX,
  recentsFor,
  recentsScope,
  rememberSearch,
  withSearch,
} from '../src/features/search/searchRecents';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {mmkvStore, SELF_ID, OTHER_ID, WS_ID} from './testkit';

// =============================================================================
// 최근 검색은 홈 검색과 대화 안 검색이 **한 목록**이다 (#5384).
//
// 한 줄은 `{query, channelId?}` 이다 — 한 대화 안에서 찾은 말은 그 대화의 id 를 함께 들고, 두 화면이 범위 칩과 함께 보여 준다. 이 파일이 묻는 것:
//
//   1. 같은 말이라도 범위가 다르면 다른 줄이고, 같은 줄은 하나로 합쳐 맨 앞으로 온다.
//   2. 옛 저장(글 하나짜리 문자열 · 대화 안 검색이 따로 들던 `conversationSearchRecent`)을 읽어서 옮기고, 옛 키는 지운다.
//   3. 로그아웃은 한 목록과 옛 키를 모두 비운다.
// =============================================================================

const WS = WS_ID;
const ME = recentsScope(WS, SELF_ID);
const OTHER_MEMBER = recentsScope(WS, OTHER_ID);

beforeEach(() => {
  mmkvStore.clear();
  __resetSearchRecentsCache();
});

describe('한 줄 = 말 + 범위', () => {
  it('같은 말도 범위가 다르면 다른 줄이고, 같은 줄은 하나로 합쳐 맨 앞으로 온다(범위의 대소문자는 눕힌다)', () => {
    let list = withSearch([], '배포');
    list = withSearch(list, '배포', 'CH-A');
    list = withSearch(list, '배포', 'ch-b');
    expect(list).toEqual([
      {query: '배포', channelId: 'ch-b'},
      {query: '배포', channelId: 'ch-a'},
      {query: '배포'},
    ]);
    // 같은 줄(같은 말·같은 범위)을 다시 쓰면 앞으로 올라오고 한 줄만 남는다.
    expect(withSearch(list, ' 배포 ', 'CH-A')).toEqual([
      {query: '배포', channelId: 'ch-a'},
      {query: '배포', channelId: 'ch-b'},
      {query: '배포'},
    ]);
    // 정원은 여섯 줄이다.
    let many = list;
    for (const text of ['하나', '둘', '셋', '넷']) many = withSearch(many, text);
    expect(many).toHaveLength(RECENT_SEARCH_MAX);
  });

  it('저장은 범위 없는 줄에 channelId 키를 두지 않고, 다시 읽어도 같은 모양이다', () => {
    rememberSearch(ME, '루나');
    rememberSearch(ME, '롤백', 'CH-DESIGN');
    expect(JSON.parse(mmkvStore.get(NON_SECRET_KEYS.searchRecents) as string)[ME].searches).toEqual([
      {query: '롤백', channelId: 'ch-design'},
      {query: '루나'},
    ]);
    __resetSearchRecentsCache();
    expect(recentsFor(ME).searches).toEqual([{query: '롤백', channelId: 'ch-design'}, {query: '루나'}]);
  });

  it('글 하나짜리 문자열(한 목록이 되기 전의 저장)도 읽는다 — 모양이 틀린 줄만 건너뛴다', () => {
    const parsed = parseRecents(
      JSON.stringify({
        [ME]: {searches: ['옛 검색어', {query: '새 검색어', channelId: 'CH-A'}, 42, {query: ''}, {nope: 1}], conversations: []},
      }),
    );
    expect(parsed[ME].searches).toEqual([{query: '옛 검색어'}, {query: '새 검색어', channelId: 'ch-a'}]);
  });
});

describe('옛 대화 안 검색 저장 옮기기', () => {
  const legacy = (map: Record<string, unknown>) =>
    mmkvStore.set(NON_SECRET_KEYS.conversationSearchRecent, JSON.stringify(map));

  it('같은 워크스페이스의 옛 줄을 범위와 함께 한 목록으로 옮기고 — 최근 대화부터, 새 줄 뒤에 — 옛 키를 지운다', () => {
    rememberSearch(ME, '이미 있던 말');
    // 옛 지도: 열쇠 순서가 대화의 최근 순서(맨 뒤가 가장 최근), 값은 그 대화의 말(최근이 앞).
    legacy({
      [`${WS}:ch-old`]: ['옛 대화 말'],
      [`${WS}:ch-new`]: ['새 대화 말1', '새 대화 말2'],
    });
    __resetSearchRecentsCache();
    // 캐시를 버렸으니 저장소의 새 목록을 다시 읽는 첫 읽기가 옮기기를 일으킨다.
    expect(recentsFor(ME).searches).toEqual([
      {query: '이미 있던 말'},
      {query: '새 대화 말1', channelId: 'ch-new'},
      {query: '새 대화 말2', channelId: 'ch-new'},
      {query: '옛 대화 말', channelId: 'ch-old'},
    ]);
    // 옛 키는 지워졌고(옮겼으면 남기지 않는다), 새 목록이 저장소에 남았다.
    expect(mmkvStore.has(NON_SECRET_KEYS.conversationSearchRecent)).toBe(false);
    __resetSearchRecentsCache();
    expect(recentsFor(ME).searches).toHaveLength(4);
  });

  it('다른 워크스페이스의 옛 줄은 옮기지 않고 옛 키에 남겨 둔다 — 그 워크스페이스를 처음 읽을 때 옮긴다', () => {
    legacy({[`${WS}:ch-a`]: ['이 워크스페이스'], 'other-ws:ch-b': ['다른 워크스페이스']});
    expect(recentsFor(ME).searches).toEqual([{query: '이 워크스페이스', channelId: 'ch-a'}]);
    expect(JSON.parse(mmkvStore.get(NON_SECRET_KEYS.conversationSearchRecent) as string)).toEqual({
      'other-ws:ch-b': ['다른 워크스페이스'],
    });
    const otherScope = recentsScope('other-ws', SELF_ID);
    expect(recentsFor(otherScope).searches).toEqual([{query: '다른 워크스페이스', channelId: 'ch-b'}]);
    expect(mmkvStore.has(NON_SECRET_KEYS.conversationSearchRecent)).toBe(false);
  });

  it('깨진 옛 값은 빈 지도로 읽고 키를 지운다 — 읽을 수 없는 것이 영영 남지 않는다', () => {
    mmkvStore.set(NON_SECRET_KEYS.conversationSearchRecent, '{ 이건 JSON 이 아니다');
    expect(recentsFor(ME).searches).toEqual([]);
    expect(mmkvStore.has(NON_SECRET_KEYS.conversationSearchRecent)).toBe(false);
  });

  it('한 번 옮긴 뒤에는 같은 열쇠가 다시 옮기지 않는다 — 지운 줄이 되살아나지 않는다', () => {
    legacy({[`${WS}:ch-a`]: ['한 번만']});
    expect(recentsFor(ME).searches).toHaveLength(1);
    // 다시 쓴 옛 키(있을 수 없는 일이지만)가 이 실행 안에서 되살아나지 않는다.
    legacy({[`${WS}:ch-b`]: ['되살아나면 안 된다']});
    expect(recentsFor(ME).searches).toEqual([{query: '한 번만', channelId: 'ch-a'}]);
  });
});

describe('로그아웃', () => {
  it('한 목록과 옛 대화 안 검색 키를 모두 비운다 — 다른 멤버의 칸도 함께(사람이 직접 나갈 때)', () => {
    rememberSearch(ME, '내 검색어', 'ch-a');
    rememberSearch(OTHER_MEMBER, '다른 멤버');
    mmkvStore.set(NON_SECRET_KEYS.conversationSearchRecent, JSON.stringify({[`other-ws:ch`]: ['옛 줄']}));
    clearAllSearchRecents();
    expect(mmkvStore.has(NON_SECRET_KEYS.searchRecents)).toBe(false);
    expect(mmkvStore.has(NON_SECRET_KEYS.conversationSearchRecent)).toBe(false);
    __resetSearchRecentsCache();
    expect(recentsFor(ME).searches).toEqual([]);
    expect(recentsFor(OTHER_MEMBER).searches).toEqual([]);
  });
});
