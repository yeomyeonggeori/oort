import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import {readFileSync} from 'fs';
import {join} from 'path';
import React from 'react';
import {Text} from 'react-native';

import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import {catalog as koCatalog} from '@momo/core/i18n/generated/ko-KR';
import {createMessageService} from '@momo/core/i18n/service';
import type {Channel} from '@momo/core/lib/api';
import {
  __resetSearchRecentsCache,
  recentsFor,
  recentsScope,
  rememberConversation,
  rememberSearch,
} from '../src/features/search/searchRecents';
import {useMessageSearch} from '../src/features/search/useMessageSearch';
import SearchScreen from '../src/screens/SearchScreen';
import {SessionProvider} from '../src/session/useSession';
import {
  callsTo,
  installFetch,
  jsonResponse,
  member,
  OTHER_ID,
  renderWithQuery,
  resetSession,
  selfMember,
  SELF_ID,
  settle,
  signIn,
  WS_ID,
} from './testkit';

// The one network call this surface makes. Mocked at the module boundary so the
// contract under test is "what does this hook ask for, and when" — the two
// things the server's 400s are about.
jest.mock('@momo/core/lib/api', () => {
  const actual = jest.requireActual('@momo/core/lib/api');
  return {...actual, searchMessages: jest.fn()};
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const {searchMessages} = require('@momo/core/lib/api') as {
  searchMessages: jest.Mock;
};

// =============================================================================
// 메시지 검색의 배선.
//
// 규칙 자체는 코어가 이미 증명한다(`searchModel.test.ts`). 여기서 보는 것은 이
// 클라이언트가 **서버를 어떻게 부르는가**이고, 그중 둘은 서버의 400 과 직접
// 짝지어 있다: 2자 미만은 보내지 않는다, 마지막 페이지에는 커서 키가 없다.
// =============================================================================

const WS = 'AAAA1111-2222-4333-8444-555566667777';

function page(count: number, nextCursor?: string) {
  return {
    hits: Array.from({length: count}, (_, i) => ({
      channelId: 'ch',
      messageId: `m-${nextCursor ?? 'last'}-${i}`,
      seq: i + 1,
      authorMemberId: 'a',
      createdAtMs: 1_700_000_000_000,
      snippet: '금요일 배포 이야기',
      matchOffset: 4,
    })),
    ...(nextCursor === undefined ? {} : {nextCursor}),
  };
}

/** A probe that renders the hook's answer, so assertions read like the screen. */
function Probe({initialQuery = ''}: {initialQuery?: string}) {
  const search = useMessageSearch(WS, initialQuery);
  probe = search;
  return (
    <>
      <Text testID="phase">{search.phase}</Text>
      <Text testID="count">{String(search.hits.length)}</Text>
      <Text testID="hasMore">{String(search.hasMore)}</Text>
    </>
  );
}

let probe: ReturnType<typeof useMessageSearch>;

function mount(initialQuery = '') {
  const client = new QueryClient({
    defaultOptions: {queries: {retry: false, gcTime: 0}},
  });
  return render(
    <QueryClientProvider client={client}>
      <Probe initialQuery={initialQuery} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  jest.useFakeTimers();
  searchMessages.mockReset();
});

afterEach(() => {
  jest.useRealTimers();
  cleanup();
});

/** Type, then let the debounce elapse. */
function type(next: string) {
  act(() => {
    probe.setQuery(next);
  });
  act(() => {
    jest.advanceTimersByTime(300);
  });
}

describe('2자 미만은 기기를 떠나지 않는다', () => {
  it('한 글자로는 요청하지 않고, 오류도 아니다', () => {
    mount();
    type('배');
    expect(searchMessages).not.toHaveBeenCalled();
    // 「치는 중」은 실패가 아니다 — 오류로 그리면 사람은 자기가 잘못했다고 읽는다.
    expect(screen.getByTestId('phase').props.children).toBe('tooShort');
  });

  it('두 글자가 되면 그때 나간다', async () => {
    searchMessages.mockResolvedValue(page(2));
    mount();
    type('배포');
    await waitFor(() =>
      expect(searchMessages).toHaveBeenCalledWith(WS, '배포', expect.anything()),
    );
  });

  it('이모지 한 글자는 두 글자가 아니다', () => {
    // 서버는 유니코드 스칼라로 센다. `"..".length` 로 세면 이모지 하나가 둘이
    // 되어, 서버가 400 을 줄 질의를 보내 놓고 그 400 을 화면에 옮기게 된다.
    mount();
    type('🎉');
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('빈칸만 친 것은 아무것도 아니다', () => {
    mount();
    type('   ');
    expect(searchMessages).not.toHaveBeenCalled();
    expect(screen.getByTestId('phase').props.children).toBe('idle');
  });
});

describe('입력은 동기, 요청만 늦다', () => {
  it('setQuery 직후 value 가 이미 그 값이다', () => {
    mount();
    // 디바운스를 흘리지 않는다 — 그래도 입력값은 즉시 최신이어야 한다. 이것이
    // 늦으면 한글 조합이 끊긴다(스파이크 #837 gate 1).
    act(() => {
      probe.setQuery('안녕');
    });
    expect(probe.query).toBe('안녕');
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('지우는 것은 기다리지 않는다', () => {
    mount();
    act(() => {
      probe.setQuery('배포');
    });
    act(() => {
      probe.setQuery('');
    });
    // 디바운스를 흘리지 않았는데도 이미 idle: 지운 것이 250ms 동안 안 지워진
    // 것처럼 보이면 안 된다.
    expect(screen.getByTestId('phase').props.children).toBe('idle');
  });
});

describe('페이지', () => {
  it('마지막 페이지는 커서 키가 없고, 그것이 곧 끝이다', async () => {
    searchMessages.mockResolvedValue(page(3));
    mount();
    type('배포');
    await waitFor(() =>
      expect(screen.getByTestId('phase').props.children).toBe('results'),
    );
    expect(screen.getByTestId('hasMore').props.children).toBe('false');
  });

  it('커서가 있으면 더 있다고 말하고, 이어 붙인다', async () => {
    searchMessages.mockResolvedValueOnce(page(2, 'CURSOR-1'));
    mount();
    type('배포');
    await waitFor(() =>
      expect(screen.getByTestId('hasMore').props.children).toBe('true'),
    );

    searchMessages.mockResolvedValueOnce(page(1));
    await act(async () => {
      probe.loadMore();
    });
    await waitFor(() =>
      expect(screen.getByTestId('count').props.children).toBe('3'),
    );
    expect(searchMessages).toHaveBeenLastCalledWith(
      WS,
      '배포',
      expect.objectContaining({cursor: 'CURSOR-1'}),
    );
  });
});

describe('상태', () => {
  it('결과가 없으면 empty 이지 오류가 아니다', async () => {
    searchMessages.mockResolvedValue(page(0));
    mount();
    type('배포');
    await waitFor(() =>
      expect(screen.getByTestId('phase').props.children).toBe('empty'),
    );
  });

  it('실패하면 error', async () => {
    searchMessages.mockRejectedValue(new Error('네트워크'));
    mount();
    type('배포');
    await waitFor(() =>
      expect(screen.getByTestId('phase').props.children).toBe('error'),
    );
  });
});

describe('넘겨받은 질의', () => {
  it('사이드바에서 들고 온 말은 기다리지 않고 바로 찾는다', async () => {
    searchMessages.mockResolvedValue(page(1));
    mount('배포');
    await waitFor(() =>
      expect(searchMessages).toHaveBeenCalledWith(WS, '배포', expect.anything()),
    );
    expect(probe.query).toBe('배포');
  });
});

// =============================================================================
// 검색 탭 화면 (#5365) — 사람·채널·메시지를 한 입력칸에서.
//
// 가짜는 둘뿐이다: 메시지 검색(`searchMessages`, 위 모듈 경계)과 나머지 네트워크(`fetch`: 채널 목록·명부·DM 열기).
// 화면·훅·저장소는 진짜라서 단정은 「호출했는가」가 아니라 **화면에 무엇이 서는가**에 대한 것이다. 문구는 사전에서 읽는다.
// =============================================================================

describe('검색 탭 — 종류 칩·묶음 결과·최근 목록·대화 고르기 (#5365)', () => {
  const t = createMessageService({messageLocale: 'ko-KR', catalog: koCatalog}).formatMessage;
  const ME = selfMember({displayName: '곽성재', handle: 'seongjae'});
  const LUNA = member({id: OTHER_ID, workspaceId: WS_ID, displayName: '루나', handle: 'luna'});
  const HELPER = member({
    id: 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
    workspaceId: WS_ID,
    kind: 'agent',
    displayName: '루나 도우미',
    handle: 'luna-helper',
  });
  const ROSTER = [member({id: SELF_ID, workspaceId: WS_ID, displayName: '곽성재', handle: 'seongjae'}), LUNA, HELPER];
  const channel = (id: string, name: string, kind: Channel['kind'] = 'public'): Channel => ({
    id,
    workspaceId: WS_ID,
    kind,
    name,
    muted: false,
  });
  const CH_PROJECT = channel('cccccccc-1111-4111-8111-cccccccccccc', '루나-프로젝트');
  const CH_DESIGN = channel('cccccccc-2222-4222-8222-cccccccccccc', '루나-디자인', 'private');
  const CH_LAUNCH = channel('cccccccc-3333-4333-8333-cccccccccccc', '출시-준비');
  const DM_LUNA: Channel = {
    id: 'dddddddd-1111-4111-8111-dddddddddddd',
    workspaceId: WS_ID,
    kind: 'dm',
    memberIds: [SELF_ID, OTHER_ID],
    muted: false,
  };
  const hit = (n: number, channelId: string) => ({
    channelId,
    messageId: `m-${n}`,
    seq: n,
    authorMemberId: OTHER_ID,
    createdAtMs: 1_700_000_000_000,
    snippet: '루나 쪽 배포는 내일이에요',
    matchOffset: 0,
  });
  const scope = recentsScope(WS_ID, SELF_ID);
  const input = () => screen.getByTestId('search-input');
  const enter = (text: string) => fireEvent.changeText(input(), text);
  const press = (testID: string) => fireEvent.press(screen.getByTestId(testID));
  const selected = (kind: string) =>
    screen.getByTestId(`search-kind-${kind}`).props.accessibilityState.selected;

  // 디바운스(250ms)가 지나고, 그 뒤에 나간 요청의 답이 화면까지 오는 두 박자.
  const searched = async () => {
    await settle(300);
    await settle(100);
  };

  let network: jest.Mock;
  // 「DM 열기」 응답을 붙잡아 두는 문 — 기본은 열려 있다.
  let dmGate: Promise<void>;

  beforeEach(() => {
    resetSession();
    signIn(ME);
    __resetSearchRecentsCache();
    dmGate = Promise.resolve();
    network = installFetch(url => {
      if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
      if (url.endsWith('/dms')) {
        return dmGate.then(() => jsonResponse(200, {channel: DM_LUNA, created: false}));
      }
      if (url.includes('/channels')) {
        return jsonResponse(200, {channels: [CH_PROJECT, CH_DESIGN, CH_LAUNCH]});
      }
      return undefined;
    });
  });

  async function mountSearch() {
    const onOpenResult = jest.fn();
    const onClose = jest.fn();
    const view = renderWithQuery(
      <SessionProvider member={ME}>
        <SearchScreen onOpenResult={onOpenResult} onClose={onClose} />
      </SessionProvider>,
    );
    await settle(50);
    return {...view, onOpenResult, onClose};
  }

  it('처음 열면 X(홈으로)와 칩 넷이 서고, 최근이 없으면 안내 한 줄이며 서버는 부르지 않는다', async () => {
    await mountSearch();
    expect(screen.getByTestId('search-exit')).toHaveProp(
      'accessibilityLabel',
      t('search.input.exitLabel'),
    );
    expect(screen.getAllByTestId(/^search-kind-/)).toHaveLength(4);
    expect(selected('all')).toBe(true);
    expect(screen.getByTestId('search-idle')).toHaveTextContent(t('search.recent.empty'));
    expect(searchMessages).not.toHaveBeenCalled();
  });

  it('최근 연 대화·최근 검색이 서고, 검색어를 누르면 입력칸에 들어가며, 모두 지우기는 검색어만 비운다', async () => {
    rememberConversation(scope, CH_PROJECT.id);
    rememberSearch(scope, '배포 일정');
    rememberSearch(scope, '루나');
    searchMessages.mockResolvedValue({hits: []});
    const {onOpenResult} = await mountSearch();

    fireEvent.press(screen.getByTestId(`search-recent-conversation-${CH_PROJECT.id}`));
    expect(onOpenResult).toHaveBeenCalledWith(CH_PROJECT.id, CH_PROJECT.name);

    // 가장 최근 검색이 맨 위다. 누르면 입력칸에 그 말이 들어간다.
    const rows = screen.getAllByTestId('search-recent-search');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('루나');
    fireEvent.press(rows[0]);
    expect(input().props.value).toBe('루나');

    // X 로 입력을 비우면 최근 목록이 돌아오고, 「모두 지우기」는 검색어만 지운다.
    press('search-exit');
    expect(screen.getByTestId('search-recent-searches')).toBeTruthy();
    press('search-recent-clear');
    expect(screen.queryByTestId('search-recent-searches')).toBeNull();
    expect(screen.getByTestId('search-recent-conversations')).toBeTruthy();
    expect(recentsFor(scope).searches).toEqual([]);
    expect(recentsFor(scope).conversations).toEqual([CH_PROJECT.id]);
  });

  it('「전체」: 채널·사람은 서버를 기다리지 않고 바로, 메시지는 250ms 뒤 서버 결과로 — 찾은 글자가 강조된다', async () => {
    searchMessages.mockResolvedValue({hits: [hit(1, CH_PROJECT.id), hit(2, CH_LAUNCH.id)]});
    await mountSearch();
    enter('루나');

    expect(screen.getAllByTestId(/^search-channel-/)).toHaveLength(2);
    expect(screen.getAllByTestId(/^search-person-/)).toHaveLength(2);
    expect(screen.queryByTestId('search-results')).toBeNull();
    expect(searchMessages).not.toHaveBeenCalled();
    // 이름 안에서 찾은 글자만 강조 조각이 된다.
    const row = screen.getByTestId(`search-channel-${CH_DESIGN.id}`);
    expect(within(row).getAllByTestId('search-match')).toHaveLength(1);
    expect(within(row).getByTestId('search-match')).toHaveTextContent('루나');

    await searched();
    expect(searchMessages).toHaveBeenCalledWith(WS_ID, '루나', expect.anything());
    expect(screen.getAllByTestId('search-result')).toHaveLength(2);
    // 채널이 사람보다, 사람이 메시지보다 위다(묶음 순서).
    const order = [
      'search-group-channels',
      'search-group-people',
      'search-group-messages',
    ].map(id => JSON.stringify(screen.toJSON()).indexOf(id));
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('칩이 종류를 좁힌다 — 「전체」의 메시지 묶음은 셋까지이고 「더 보기」는 「메시지」 칩으로, 「채널」·「사람」은 서버를 다시 부르지 않는다', async () => {
    searchMessages.mockResolvedValue({hits: [1, 2, 3, 4].map(n => hit(n, CH_PROJECT.id))});
    await mountSearch();
    enter('루나');
    await searched();
    const calls = searchMessages.mock.calls.length;
    // 「전체」: 메시지 묶음은 셋까지만 보이고 머리의 「더 보기」가 남는다.
    expect(screen.getAllByTestId('search-result')).toHaveLength(3);

    press('search-kind-channels');
    expect(selected('channels')).toBe(true);
    expect(screen.getAllByTestId(/^search-channel-/)).toHaveLength(2);
    expect(screen.queryAllByTestId(/^search-person-/)).toHaveLength(0);

    press('search-kind-people');
    expect(screen.getAllByTestId(/^search-person-/)).toHaveLength(2);
    expect(screen.queryAllByTestId(/^search-channel-/)).toHaveLength(0);
    await searched();
    expect(searchMessages.mock.calls.length).toBe(calls);

    // 「더 보기」는 그 종류 칩으로 보낸다: 메시지는 넷 모두, 채널·사람 묶음은 사라지고 범위 줄이 선다.
    press('search-kind-all');
    expect(screen.queryByTestId('search-scope')).toBeNull();
    press('search-head-messages-more');
    expect(selected('messages')).toBe(true);
    expect(screen.getByTestId('search-scope')).toBeTruthy();
    expect(screen.getAllByTestId('search-result')).toHaveLength(4);
    expect(screen.queryAllByTestId(/^search-(channel|person)-/)).toHaveLength(0);
  });

  it('「대화 고르기」에서 고른 대화 하나로 좁혀 찾고, 「모든 대화」로 되돌린다', async () => {
    searchMessages.mockResolvedValue({hits: [hit(1, CH_PROJECT.id)]});
    await mountSearch();
    press('search-kind-messages');
    enter('루나');
    await searched();
    expect(searchMessages.mock.lastCall?.[2]).not.toHaveProperty('channelId');

    press('search-scope-pick');
    expect(screen.getByTestId('search-picker-sheet')).toBeTruthy();
    // 시트 안에서 이름으로 걸러 고른다.
    fireEvent.changeText(screen.getByTestId('search-picker-filter'), '프로젝트');
    expect(screen.queryByTestId(`search-picker-item-${CH_DESIGN.id}`)).toBeNull();
    press(`search-picker-item-${CH_PROJECT.id}`);
    await settle(600);

    expect(screen.getByTestId('search-scope-chosen')).toHaveTextContent(CH_PROJECT.name as string);
    await searched();
    expect(searchMessages.mock.lastCall?.[2]).toEqual(
      expect.objectContaining({channelId: CH_PROJECT.id}),
    );

    press('search-scope-all');
    expect(screen.queryByTestId('search-scope-chosen')).toBeNull();
    await searched();
    expect(searchMessages.mock.lastCall?.[2]).not.toHaveProperty('channelId');
  });

  it('X 는 입력이 있으면 입력을 지우고, 비어 있으면 홈으로 돌려보낸다', async () => {
    const {onClose} = await mountSearch();
    enter('루나');
    expect(screen.getByTestId('search-exit')).toHaveProp(
      'accessibilityLabel',
      t('search.input.clearLabel'),
    );
    press('search-exit');
    expect(input().props.value).toBe('');
    expect(onClose).not.toHaveBeenCalled();

    press('search-exit');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('결과를 누르면 메시지는 그 메시지로, 채널은 그 채널로, 사람은 DM 으로 가고, 친 말이 최근 검색에 남는다', async () => {
    searchMessages.mockResolvedValue({hits: [hit(7, CH_PROJECT.id)]});
    const {onOpenResult} = await mountSearch();
    enter('루나');
    await searched();

    press('search-result');
    expect(onOpenResult).toHaveBeenLastCalledWith(CH_PROJECT.id, CH_PROJECT.name, {
      messageId: 'm-7',
      seq: 7,
    });
    press(`search-channel-${CH_DESIGN.id}`);
    expect(onOpenResult).toHaveBeenLastCalledWith(CH_DESIGN.id, CH_DESIGN.name);

    press('search-person-luna');
    await settle(100);
    expect(callsTo(network, '/dms')).toBe(1);
    expect(onOpenResult).toHaveBeenLastCalledWith(DM_LUNA.id, '루나');
    expect(recentsFor(scope).searches).toEqual(['루나']);

    // DM 이 열리는 동안 다른 결과를 눌렀다면, 늦게 도착한 DM 이 그 길을 가로채지 않는다.
    let release: () => void = () => {};
    dmGate = new Promise<void>(resolve => {
      release = resolve;
    });
    press('search-person-luna');
    press(`search-channel-${CH_PROJECT.id}`);
    expect(onOpenResult).toHaveBeenLastCalledWith(CH_PROJECT.id, CH_PROJECT.name);
    release();
    await settle(100);
    expect(onOpenResult).toHaveBeenLastCalledWith(CH_PROJECT.id, CH_PROJECT.name);
  });

  it('메시지 쪽 상태: 한 글자는 안내, 실패는 다시 시도, 결과 없음은 친 말을 인용한다', async () => {
    await mountSearch();
    enter('루');
    // 채널·사람은 한 글자부터 바로 찾고, 메시지만 두 글자부터라고 말한다(이 말은 요청과 같은 디바운스 뒤에 선다).
    expect(screen.getAllByTestId(/^search-channel-/)).toHaveLength(2);
    await searched();
    expect(screen.getByTestId('search-too-short')).toHaveTextContent(
      t('search.state.shortHintMessages'),
    );
    expect(searchMessages).not.toHaveBeenCalled();

    searchMessages.mockRejectedValue(new Error('네트워크'));
    press('search-kind-messages');
    enter('배포');
    await searched();
    expect(screen.getByTestId('search-error')).toBeTruthy();
    searchMessages.mockResolvedValue({hits: []});
    press('search-error-retry');
    await settle(100);
    // 결과 없음은 친 말을 인용하고, 범위(내가 속한 채널만)도 함께 말한다.
    expect(screen.getByTestId('search-empty')).toHaveTextContent(
      t('search.state.noResults', {query: '배포'}),
      {exact: false},
    );
    expect(screen.getByTestId('search-empty')).toHaveTextContent(t('search.state.scopeNote'), {
      exact: false,
    });
  });
});

// =============================================================================
// 한 목적지, 한 이름 (이슈 #1146 N4).
//
// 1차의 폰은 이 문을 **눈에는 「메시지 찾기」로, 귀에는 판정표의 이름으로** 내놓
// 았다 — 한 컨트롤이 이름을 둘 가진 것이고, 화면을 되짚어 볼 수 없는 사람에게는
// 자기가 들은 것이 화면에 없다. 웹의 사이드바는 같은 자리에서 셋째 이름을 적고
// 있었다.
//
// 검사가 파일 모양인 것은 `projectShape.test.ts` 가 같은 종류의 결함에 대해
// 내린 판단과 같다: 이 실패는 **조용하고**, 행동 테스트가 볼 수 있을 때쯤이면
// 이미 두 이름이 두 벌의 문서와 두 벌의 습관을 갖는다. 이 화면들을 실제로 띄우
// 려면 세션·질의 클라이언트·목록 세 개를 세워야 하는데, 그렇게 세운 화면이
// 증명하는 것도 결국 「낱말을 손으로 적지 않았다」 하나다.
//
// 주석은 걷어내고 본다 — 산문은 이 낱말들을 계속 써야 하고, 산문까지 막는 가드는
// 가드가 무뎌지는 대신 글이 무뎌진다(DOM 가드가 같은 이유로 같은 일을 한다).
//
// ## 인용형 두 개로는 모자랐다 (이슈 #1170 N1)
//
// 1차의 이 가드는 `'…'` 와 `"…"` 만 봤다. 그런데 이 파일들이 낱말을 내놓는 문법은
// 그 둘이 아니다: RN 화면은 대개 `<Text>글자</Text>` 로 맨글자를 쓰고, 조사가
// 붙는 자리는 백틱 템플릿이다(`fallthroughLabel`). 즉 **가드가 안 보는 문법이
// 이 화면들이 실제로 쓰는 문법**이었고, 이름을 손으로 다시 적으려는 사람이 가장
// 자연스럽게 고를 모양이 정확히 거기였다.
//
// 그래서 인용형을 늘리는 대신 질문을 바꾼다: 「어떤 인용부호로 적었나」가 아니라
// **「이 파일이 그 낱말을 글자로 갖고 있나」**. 주석을 걷어낸 뒤 남은 글자에 이름이
// 있으면, 그것이 어떤 문법이든 손으로 적은 것이다 — 배선으로 받아 온 이름은
// 런타임에만 존재하고 소스에는 없다.
// =============================================================================

describe('메시지 검색이라는 목적지는 이름이 하나다 (이슈 #1146 N4)', () => {
  const SCREENS = ['SidebarScreen.tsx', 'SearchScreen.tsx'];

  /** 산문을 걷어낸다 — 남는 것은 화면이 실제로 사람에게 내놓는 글자다. */
  function stripProse(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  function code(file: string): string {
    return stripProse(readFileSync(join(__dirname, '../src/screens', file), 'utf8'));
  }

  /** 이 소스가 그 낱말을 **손으로** 갖고 있는가. 문법을 묻지 않는다. */
  function handWrites(source: string, name: string): boolean {
    return stripProse(source).includes(name);
  }

  it('이름을 짓지 않고 표면 판정표에서 받아 온다', () => {
    for (const file of SCREENS) {
      expect(code(file)).toContain("serverSurface('messageSearch')");
    }
  });

  it('문을 여는 쪽도 도착한 쪽도 낱말을 손으로 적지 않는다', () => {
    // 판정표의 낱말을 다시 적은 화면이 하나라도 있으면, 표를 고치는 날 그 화면만
    // 옛 이름으로 남는다. 이름이 갈라지는 유일한 경로다.
    const name = serverSurface('messageSearch').label;
    const offenders = SCREENS.filter(file => handWrites(code(file), name));
    expect(offenders).toEqual([]);
  });

  it('가드가 보는 문법이 이 화면들이 쓰는 문법이다 (이슈 #1170 N1)', () => {
    // 위 단정이 무엇을 잡는지 산문으로 주장하지 않고 **씨앗으로** 보인다. 인용형
    // 둘만 보던 1차라면 아래 넷 중 마지막 넷이 통과했다 — 그것이 N1 이 가리킨 구멍
    // 이고, 이 케이스 표가 그 구멍을 다시 열지 못하게 한다.
    const name = serverSurface('messageSearch').label;
    const shapes: ReadonlyArray<readonly [string, string]> = [
      ['홑따옴표', `accessibilityLabel='${name}'`],
      ['쌍따옴표', `accessibilityLabel="${name}"`],
      ['백틱', 'const l = `' + name + '`;'],
      ['백틱 + 치환', 'const l = `' + name + ' ${q}`;'],
      ['JSX 맨글자', `<Text>${name}</Text>`],
      ['JSX 맨글자, 줄바꿈', `<Text>\n  ${name}\n</Text>`],
    ];
    const missed = shapes
      .filter(([, snippet]) => !handWrites(snippet, name))
      .map(([shape]) => shape);
    expect(missed).toEqual([]);

    // 그리고 산문은 여전히 통과한다 — 가드를 넓히면서 글을 좁히지 않았다.
    expect(handWrites(`// 이 문은 ${name}을 연다`, name)).toBe(false);
    expect(handWrites(`/**\n * ${name} 으로 가는 문.\n */`, name)).toBe(false);
  });

  it('1차의 둘째 이름은 어디에도 남지 않는다', () => {
    // 「메시지 찾기」는 사이드바 헤더 액션의 **보이는 글자**였고, 같은 컨트롤의
    // 낭독 라벨은 판정표의 이름이었다. 눈과 귀가 갈린 자리다.
    for (const file of SCREENS) {
      expect(code(file)).not.toContain('메시지 찾기');
    }
  });
});
