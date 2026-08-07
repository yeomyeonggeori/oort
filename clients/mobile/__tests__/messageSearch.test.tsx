import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, render, screen, waitFor} from '@testing-library/react-native';
import {readFileSync} from 'fs';
import {join} from 'path';
import React from 'react';
import {Text} from 'react-native';

import {serverSurface} from '@momo/core/features/capabilities/serverSurfaces';
import {useMessageSearch} from '../src/features/search/useMessageSearch';

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
// =============================================================================

describe('메시지 검색이라는 목적지는 이름이 하나다 (이슈 #1146 N4)', () => {
  const SCREENS = ['SidebarScreen.tsx', 'SearchScreen.tsx'];

  /** 주석을 걷어낸 소스 — 화면이 실제로 사람에게 내놓는 글자만 남는다. */
  function code(file: string): string {
    return readFileSync(join(__dirname, '../src/screens', file), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  it('이름을 짓지 않고 표면 판정표에서 받아 온다', () => {
    for (const file of SCREENS) {
      expect(code(file)).toContain("serverSurface('messageSearch')");
    }
  });

  it('문을 여는 쪽도 도착한 쪽도 낱말을 손으로 적지 않는다', () => {
    // 판정표의 낱말을 문자열 리터럴로 다시 적은 화면이 하나라도 있으면, 표를
    // 고치는 날 그 화면만 옛 이름으로 남는다. 이름이 갈라지는 유일한 경로다.
    const name = serverSurface('messageSearch').label;
    for (const file of SCREENS) {
      expect(code(file)).not.toContain(`'${name}'`);
      expect(code(file)).not.toContain(`"${name}"`);
    }
  });

  it('1차의 둘째 이름은 어디에도 남지 않는다', () => {
    // 「메시지 찾기」는 사이드바 헤더 액션의 **보이는 글자**였고, 같은 컨트롤의
    // 낭독 라벨은 판정표의 이름이었다. 눈과 귀가 갈린 자리다.
    for (const file of SCREENS) {
      expect(code(file)).not.toContain('메시지 찾기');
    }
  });
});
