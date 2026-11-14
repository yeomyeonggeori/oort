import type {Channel, RosterMember} from '@momo/core/lib/api';

import {
  highlightParts,
  matchChannels,
  matchName,
  matchPeople,
  previewOf,
} from '../src/features/search/localSearch';
import {
  __resetSearchRecentsCache,
  clearAllSearchRecents,
  forgetSearches,
  parseRecents,
  RECENT_CONVERSATION_MAX,
  RECENT_SEARCH_MAX,
  recentsFor,
  recentsScope,
  rememberConversation,
  rememberSearch,
  withConversation,
  withSearch,
  type RecentSearch,
} from '../src/features/search/searchRecents';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {mmkvStore, OTHER_ID, SELF_ID, WS_ID} from './testkit';

// =============================================================================
// 검색 탭이 폰 안에서 하는 일 (#5365): 채널·사람 이름 찾기와 기기에만 남는 최근 목록.
//
// 서버는 메시지만 찾는다. 채널·사람은 이미 받아 둔 목록에서 글자마다 바로 거르므로 네트워크 없이 규칙만 잰다.
// =============================================================================

function channel(id: string, name: string | undefined, kind: Channel['kind'] = 'public'): Channel {
  return {id, workspaceId: WS_ID, kind, name, muted: false};
}

function person(id: string, displayName: string, handle: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS_ID,
    kind: 'human',
    status: 'active',
    displayName,
    handle,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

describe('이름 찾기의 글자 규칙', () => {
  it('정확 → 앞부분 → 단어 시작 → 중간 → 글자 차례 순으로 낮은 숫자가 위이고, 강조는 코드포인트로 자른다', () => {
    const rank = (text: string) => matchName('루나', text)?.rank;
    expect([
      rank('루나'),
      rank('루나-프로젝트'),
      rank('새-루나-일정'),
      rank('아루나'),
      rank('루-나'),
    ]).toEqual([0, 1, 2, 3, 4]);
    expect(matchName('루나', '프로젝트')).toBeNull();

    // 대소문자는 접고, 한 글자는 「차례대로」 규칙을 쓰지 않는다(그 규칙은 두 글자부터다).
    expect(matchName('LUNA', 'luna-helper')?.rank).toBe(1);
    expect(matchName('프', '루나-프로젝트')?.rank).toBe(2);
    expect(matchName('젝', '루나-프로젝트')?.rank).toBe(3);
    expect(matchName('쭉', '루나-프로젝트')).toBeNull();
    // 차례대로 든 글자는 붙은 것끼리 한 범위로 묶인다.
    expect(matchName('루프로', '루나-프로젝트')?.ranges).toEqual([
      [0, 1],
      [3, 5],
    ]);

    // 앞의 이모지가 강조를 한 칸씩 밀지 않는다.
    const text = '🎉루나-일정';
    const found = matchName('루나', text);
    expect(found?.rank).toBe(3);
    expect(highlightParts(text, found?.ranges ?? [])).toEqual([
      {text: '🎉', match: false},
      {text: '루나', match: true},
      {text: '-일정', match: false},
    ]);
    expect(highlightParts('루나', [])).toEqual([{text: '루나', match: false}]);
  });
});

describe('한글 조합 중 채널 찾기 · 정렬 자 (ADR-0225 D12)', () => {
  const hangul = [channel('h1', '디자인'), channel('h2', '디저트')];

  it.each(['디', '디ㅈ', '디자', '디장', '디자이', '디자인'])(
    '`%s` 를 칠 때 「디자인」은 남고 「디저트」는 `디자`부터 빠진다',
    query => {
      const names = matchChannels(hangul, query, 'ko-KR').map(match => match.name);
      expect(names).toContain('디자인');
      expect(names.includes('디저트')).toBe(query === '디' || query === '디ㅈ');
    },
  );

  it('느슨하게 맞은 줄의 강조는 이름 안의 글자 구간이다', () => {
    const [hit] = matchChannels(hangul, '디장', 'ko-KR');
    expect(hit.rank).toBe(1);
    expect(hit.ranges).toEqual([[0, 3]]);
  });

  it('사람 이름은 느슨하게 보지 않는다 (채널 이름에만 켠다)', () => {
    expect(matchName('디장', '디자인')).toBeNull();
    expect(matchName('디장', '디자인', true)).not.toBeNull();
  });

  it('같은 순위끼리는 숫자를 값으로 세운다: sprint-2 가 sprint-10 앞', () => {
    const sprints = [channel('s1', 'sprint-10'), channel('s2', 'sprint-2'), channel('s3', 'sprint-1')];
    expect(matchChannels(sprints, 'sprint', 'ko-KR').map(match => match.name)).toEqual([
      'sprint-1',
      'sprint-2',
      'sprint-10',
    ]);
  });

  it('화면 언어로 센다: 같은 순위의 섞인 이름이 ko·en·ja 에서 다른 차례다', () => {
    const mixed = ['漢字', '가나', 'かな', 'abc'].map((name, i) => channel(`m${i}`, name));
    // 모두 같은 순위(앞부분)로 걸리게 `x-` 를 붙여 질의한다.
    const all = (locale: string) =>
      matchChannels(
        mixed.map((c, i) => ({...c, name: `x-${c.name}`, id: `n${i}`})),
        'x-',
        locale,
      ).map(match => match.name.slice(2));
    expect(all('ko-KR')).toEqual(['가나', '漢字', 'abc', 'かな']);
    expect(all('en-US')).toEqual(['abc', '가나', 'かな', '漢字']);
    expect(all('ja-JP')).toEqual(['abc', 'かな', '漢字', '가나']);
  });
});

describe('채널·사람 걸러내기', () => {
  it('채널은 내 채널의 이름으로만, 사람은 나·비활성을 빼고 이름이나 핸들로 — 글자 규칙 순서다', () => {
    // 채널: DM·이름 없는 채널은 빠지고, 순서는 글자 규칙 뒤 가나다다.
    const channels = [
      channel('c1', '프로젝트-루나'),
      channel('c2', '루나-프로젝트'),
      channel('c3', '루나-디자인', 'private'),
      channel('c4', undefined),
      channel('c5', '루나', 'dm'),
    ];
    expect(matchChannels(channels, '루나', 'ko-KR').map(match => match.name)).toEqual([
      '루나-디자인',
      '루나-프로젝트',
      '프로젝트-루나',
    ]);

    // 사람: 나 자신과 활성이 아닌 멤버는 빠지고, `@` 로 시작하면 핸들만 본다.
    const roster = [
      person(SELF_ID, '루나 나', 'me'),
      person(OTHER_ID, '루나', 'luna'),
      person('p3', '루나 도우미', 'helper', {kind: 'agent'}),
      person('p4', '루나 정지', 'gone', {status: 'suspended'}),
      person('p5', '도우미', 'luna-helper', {kind: 'agent'}),
    ];
    const byName = matchPeople(roster, SELF_ID, '루나');
    expect(byName.map(match => match.member.id)).toEqual([OTHER_ID, 'p3']);
    expect(byName[0].nameRanges).toEqual([[0, 2]]);
    // 이름으로 찾은 줄은 이름 안을, 핸들로 찾은 줄은 핸들 안을 강조한다.
    const byHandle = matchPeople(roster, SELF_ID, 'luna');
    expect(byHandle.map(match => match.member.id)).toEqual([OTHER_ID, 'p5']);
    expect(byHandle[0].handleRanges).toEqual([[0, 4]]);
    expect(byHandle[1].nameRanges).toEqual([]);
    // `@luna` 는 핸들만 본다: 이름 「루나」 는 걸리지 않는다.
    expect(matchPeople(roster, SELF_ID, '@luna').map(match => match.member.id)).toEqual([
      OTHER_ID,
      'p5',
    ]);
    expect(matchPeople(roster, SELF_ID, '@루나')).toEqual([]);
    expect(previewOf([1, 2, 3, 4], 3)).toEqual({shown: [1, 2, 3], more: true});
    expect(previewOf([1, 2], 3)).toEqual({shown: [1, 2], more: false});
  });
});

describe('최근 검색·최근 연 대화는 이 기기에만, 열쇠마다 따로', () => {
  beforeEach(() => {
    mmkvStore.clear();
    __resetSearchRecentsCache();
  });

  it('검색어는 맨 앞에 쌓여 같은 글은 하나로 합쳐지고 정원을 넘지 않으며, 저장소에 남아 열쇠마다 따로 보이고, 로그아웃이 전부 비운다', () => {
    let list: readonly RecentSearch[] = [];
    for (const query of ['하나', '둘', '셋', '넷', '다섯', '여섯', '일곱']) {
      list = withSearch(list, query);
    }
    expect(list).toHaveLength(RECENT_SEARCH_MAX);
    expect(list[0]).toEqual({query: '일곱'});
    expect(list.map(line => line.query)).not.toContain('하나');
    // 대소문자만 다른 같은 글은 하나이고, 다시 쓰면 맨 앞으로 온다.
    expect(withSearch([{query: 'Deploy'}, {query: '둘'}], '  deploy ')).toEqual([{query: 'deploy'}, {query: '둘'}]);
    expect(withSearch([{query: '둘'}], '   ')).toEqual([{query: '둘'}]);
    // 붙여넣은 문단은 한 줄을 차지하지 않게 잘린다.
    expect(Array.from(withSearch([], '가'.repeat(300))[0].query)).toHaveLength(80);

    let convs: readonly string[] = [];
    for (let i = 0; i < RECENT_CONVERSATION_MAX + 3; i += 1) convs = withConversation(convs, `CH-${i}`);
    expect(convs).toHaveLength(RECENT_CONVERSATION_MAX);
    expect(convs[0]).toBe(`ch-${RECENT_CONVERSATION_MAX + 2}`);
    expect(withConversation(['a', 'b'], 'B')).toEqual(['b', 'a']);

    // 저장소에 남는다: 메모리를 버리고 다시 읽어도 그대로이고, 지우기는 검색어만 비우며, 다른 멤버의 칸은 보이지 않는다.
    const mine = recentsScope(WS_ID, SELF_ID);
    const theirs = recentsScope(WS_ID, OTHER_ID);
    rememberSearch(mine, '배포 일정');
    rememberConversation(mine, 'CH-A');
    rememberSearch(theirs, '비밀 검색어');

    // 메모리를 버리고 저장소에서 다시 읽어도 남아 있다.
    __resetSearchRecentsCache();
    expect(recentsFor(mine)).toEqual({searches: [{query: '배포 일정'}], conversations: ['ch-a']});
    expect(recentsFor(theirs).searches).toEqual([{query: '비밀 검색어'}]);
    expect(recentsFor(recentsScope(WS_ID, 'someone-else')).searches).toEqual([]);

    forgetSearches(mine);
    expect(recentsFor(mine)).toEqual({searches: [], conversations: ['ch-a']});

    clearAllSearchRecents();
    expect(mmkvStore.has(NON_SECRET_KEYS.searchRecents)).toBe(false);
    __resetSearchRecentsCache();
    expect(recentsFor(theirs).searches).toEqual([]);

    // 망가진 저장값은 빈 목록으로 읽는다.
    expect(parseRecents('{not json')).toEqual({});
    expect(parseRecents('[1]')).toEqual({});
  });
});
