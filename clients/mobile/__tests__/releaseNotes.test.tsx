import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {ReleaseNote} from '@momo/core/features/releaseNotes/model';
import {RELEASE_NOTES} from '@momo/core/features/releaseNotes/notes';
import type {Member, RosterMember} from '@momo/core/lib/api';
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
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {ThemeProvider} from '../src/design/theme';
import {SettingsPage} from '../src/features/profile/SettingsPage';
import {
  ReleaseNotesSettingsPage,
} from '../src/features/releaseNotes/ReleaseNotesPage';
import {
  ReleaseNotesLaunchHost,
  ReleaseNotesSheet,
} from '../src/features/releaseNotes/ReleaseNotesSheet';
import {
  lastSeenReleaseNote,
  markReleaseNoteSeen,
  resetReleaseNotesSeenForTest,
} from '../src/features/releaseNotes/seenStore';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import AppShell from '../src/shell/AppShell';
import {NON_SECRET_KEYS} from '../src/storage/kv';
import {
  __resetSessionStore,
  sessionPort,
} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {pinReduceMotion} from './fixtures/reduceMotion';
import {describeCloseContract} from './fixtures/sheetContract';

// 이 파일의 「셸 안에서」 시험은 이 빌드 번호의 폰이다(전역 가짜는 65라 어느 소식도 붙지 않는다).
jest.mock('expo-application', () => ({
  nativeBuildVersion: '3058',
  nativeApplicationVersion: '1.0',
}));

const WS = '22222222-2222-4222-8222-222222222222';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const BASE = 'https://api.example.com';
const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};
const ROSTER = [
  {
    id: SELF_ID,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이도현',
    handle: 'dohyun',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const mmkvStore = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

function note(version: string, phoneBuild: number): ReleaseNote {
  const item = (id: string, surfaces: ReleaseNote['items'][number]['surfaces']) => ({
    id,
    surfaces,
    copy: {
      'ko-KR': {title: '제목 ' + id, changed: '바뀐 점 ' + id, tryIt: '써 보기 ' + id},
      'en-US': {title: 'Title ' + id, changed: 'Changed ' + id, tryIt: 'Try ' + id},
    },
  });
  return {
    version,
    releasedOn: version === '0.1.42' ? '2026-11-05' : '2026-10-31',
    phoneBuild,
    desktopFrom: [version],
    summary: {'ko-KR': '요약 ' + version, 'en-US': 'Summary ' + version},
    items: [
      item('a', ['phone', 'desktop']),
      item('b', ['phone']),
      item('c', ['desktop']),
      item('d', ['phone']),
      item('e', ['phone', 'desktop']),
      item('f', ['phone']),
    ],
  };
}
const V41 = note('0.1.41', 3058);
const V42 = note('0.1.42', 3070);

const koreanController = () =>
  createMobileLocaleController({
    port: {
      readPreference: () => 'ko-KR',
      writePreference: () => {},
      readDevice: () => ({languages: ['ko-KR'], timeZone: 'Asia/Seoul'}),
    },
  });
const englishController = () =>
  createMobileLocaleController({
    port: {
      readPreference: () => 'en-US',
      writePreference: () => {},
      readDevice: () => ({languages: ['en-US'], timeZone: 'America/New_York'}),
    },
  });

function withLocale(children: React.ReactNode, english = false) {
  return (
    <ThemeProvider>
      <MobileLocaleProvider createController={english ? englishController : koreanController}>
        {children}
      </MobileLocaleProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  mmkvStore.clear();
  resetReleaseNotesSeenForTest();
});
afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

/**
 * 움직임이 주제가 아닌 시험은 층·시트가 누르는 즉시 걷히도록 동작 줄이기를 켠 채 돈다. 닫는 길 계약(`describeCloseContract`)은
 * 켬과 끔을 스스로 정하므로 이 핀을 걸지 않는다(핀을 쥔 채 끔을 재면 저장소가 켠 값을 그대로 말한다).
 */
function pinMotionOff() {
  let release: (() => void) | null = null;
  beforeEach(async () => {
    release = await pinReduceMotion(true);
  });
  afterEach(() => {
    release?.();
    release = null;
  });
}

describe('업데이트 소식 시트: 처음 열 때 한 번', () => {
  pinMotionOff();
  const host = (build: string | null, idle = true, onOpenDetails: () => void = () => {}) => (
    <ReleaseNotesLaunchHost idle={idle} build={build} notes={[V41, V42]} onOpenDetails={onOpenDetails} />
  );

  it('이 빌드의 소식을 한 번 올리고, X 로 닫으면 기기에 기록된다', async () => {
    render(withLocale(host('3058')));
    const sheet = await screen.findByTestId('release-notes-sheet');
    expect(within(sheet).getByText('업데이트 소식')).toBeTruthy();
    expect(screen.getByTestId('release-notes-sheet-version')).toHaveTextContent('버전 0.1.41 · 2026-10-31');
    expect(within(sheet).getByText('요약 0.1.41')).toBeTruthy();
    // 이 화면(폰)에서 보이는 변화만 제목으로: 데스크탑 전용(c)은 없고, 네 줄까지 보이고 나머지는 접힌다.
    const titles = within(screen.getByTestId('release-notes-sheet-titles'));
    for (const id of ['a', 'b', 'd', 'e']) expect(titles.getByText('제목 ' + id)).toBeTruthy();
    expect(titles.queryByText('제목 c')).toBeNull();
    expect(titles.getByText('그 밖에 1가지')).toBeTruthy();
    expect(lastSeenReleaseNote()).toBeNull();

    fireEvent.press(screen.getByTestId('release-notes-close'));
    await waitFor(() => expect(screen.queryByTestId('release-notes-sheet')).toBeNull());
    expect(lastSeenReleaseNote()).toBe('0.1.41');
    expect(mmkvStore.get(NON_SECRET_KEYS.releaseNotesSeen)).toBe('0.1.41');
  });

  it('닫은 소식은 같은 빌드에서 다시 안 올라온다 (앱을 다시 켜도)', async () => {
    markReleaseNoteSeen('0.1.41');
    // 앱을 다시 켠 것과 같다: 메모리 값을 버려 저장소에서 다시 읽는다.
    resetReleaseNotesSeenForTest();
    render(withLocale(host('3058')));
    await act(async () => {});
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();
  });

  it('새 소식이 붙는 빌드에서는 같은 기기에서 다시 올라온다', async () => {
    markReleaseNoteSeen('0.1.41');
    resetReleaseNotesSeenForTest();
    render(withLocale(host('3070')));
    expect(await screen.findByTestId('release-notes-sheet-version')).toHaveTextContent('버전 0.1.42 · 2026-11-05');
  });

  it('한가해질 때까지 기다리고, 빌드를 읽지 못하면 아무것도 하지 않으며, 더 새 소식을 본 기기의 값은 낮아지지 않는다', async () => {
    const view = render(withLocale(host('3058', false)));
    await act(async () => {});
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();
    view.rerender(withLocale(host('3058', true)));
    expect(await screen.findByTestId('release-notes-sheet')).toBeTruthy();
    view.unmount();

    // 개발 빌드(전역 가짜의 65)와 읽지 못한 값은 어느 소식도 붙지 않는다.
    mmkvStore.clear();
    resetReleaseNotesSeenForTest();
    const dev = render(withLocale(host('65')));
    await act(async () => {});
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();
    dev.rerender(withLocale(host(null)));
    await act(async () => {});
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();

    markReleaseNoteSeen('0.1.42');
    markReleaseNoteSeen('0.1.41');
    expect(lastSeenReleaseNote()).toBe('0.1.42');
  });

  it('「자세히 보기」는 시트를 내리고 봤다고 적은 뒤 한 번만 상세를 연다', async () => {
    const onOpenDetails = jest.fn();
    render(withLocale(host('3058', true, onOpenDetails)));
    await screen.findByTestId('release-notes-sheet');
    expect(onOpenDetails).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('release-notes-details'));
    await waitFor(() => expect(onOpenDetails).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();
    expect(lastSeenReleaseNote()).toBe('0.1.41');
  });
});

// 시트 하나가 공용 닫는 길 다섯과 머리 X 를 지키는가: X · 스크림 · 끌어내리기 · VoiceOver escape (동작 줄이기 포함).
const closed = jest.fn();
describeCloseContract({
  name: 'ReleaseNotesSheet',
  open: async () => {
    closed.mockClear();
    render(withLocale(<ReleaseNotesSheet note={V41} onClose={closed} onOpenDetails={() => {}} />));
    await screen.findByTestId('release-notes-sheet');
  },
  closedCount: () => closed.mock.calls.length,
  closeTestID: 'release-notes-close',
  closeLabel: '업데이트 소식 닫기',
  scrimTestID: 'release-notes-sheet-backdrop',
  scrimLabel: '업데이트 소식 닫기',
});

describe('설정 › 업데이트 소식 장', () => {
  pinMotionOff();
  it('목록은 새 소식이 맨 위이고 이 빌드의 소식에 「지금 쓰는 버전」이 서며, 내용·‹ 는 한 겹씩이다', async () => {
    const onBack = jest.fn();
    // 새 소식이 앞에 오지 않게 일부러 거꾸로 넘긴다: 화면이 스스로 줄 세운다.
    render(withLocale(<ReleaseNotesSettingsPage onBack={onBack} build="3058" notes={[V41, V42]} />));
    await screen.findByTestId('settings-release-notes-page');
    const order: string[] = [];
    for (const version of ['0.1.42', '0.1.41']) order.push(screen.getByTestId('release-notes-row-' + version).props.testID);
    expect(order).toEqual(['release-notes-row-0.1.42', 'release-notes-row-0.1.41']);
    const html = JSON.stringify(screen.toJSON());
    expect(html.indexOf('release-notes-row-0.1.42')).toBeLessThan(html.indexOf('release-notes-row-0.1.41'));
    expect(within(screen.getByTestId('release-notes-row-0.1.41')).getByText('지금 쓰는 버전')).toBeTruthy();
    expect(within(screen.getByTestId('release-notes-row-0.1.42')).getByText('2026-11-05')).toBeTruthy();
    expect(within(screen.getByTestId('release-notes-row-0.1.42')).queryByText('지금 쓰는 버전')).toBeNull();

    // 내용: 공개일·요약, 항목마다 보이는 화면 한 줄·바뀐 점·이렇게 써 보세요(머리글).
    fireEvent.press(screen.getByTestId('release-notes-row-0.1.42'));
    const detail = await screen.findByTestId('release-notes-detail');
    expect(within(detail).getByTestId('release-notes-detail-title')).toHaveTextContent('버전 0.1.42');
    expect(within(detail).getByText('2026-11-05 공개')).toBeTruthy();
    const item = within(screen.getByTestId('release-notes-item-a'));
    expect(item.getByText('제목 a')).toBeTruthy();
    expect(item.getByText('바뀐 점 a')).toBeTruthy();
    expect(item.getByText('써 보기 a')).toBeTruthy();
    const surfaces = screen.getByTestId('release-notes-item-a-surfaces');
    expect(surfaces).toHaveTextContent('폰 · 데스크탑');
    expect(surfaces.props.accessibilityLabel).toBe('보이는 화면: 폰, 데스크탑');
    expect(screen.getByTestId('release-notes-item-b-surfaces')).toHaveTextContent('폰');
    for (const label of ['바뀐 점', '이렇게 써 보세요']) {
      expect(item.getByText(label).props.accessibilityRole).toBe('header');
    }

    // ‹ 는 한 겹만: 내용 → 목록 → 설정(onBack).
    expect(within(detail).getByTestId('release-notes-back').props.accessibilityLabel).toBe('업데이트 소식으로 돌아가기');
    fireEvent.press(screen.getByTestId('release-notes-back'));
    await waitFor(() => expect(screen.queryByTestId('release-notes-detail')).toBeNull());
    expect(screen.getByTestId('settings-release-notes-page')).toBeTruthy();
    expect(onBack).not.toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('settings-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('VoiceOver 두 손가락 문지르기(escape)도 한 겹씩만 벗긴다: 내용 → 목록 → 설정', async () => {
    const onBack = jest.fn();
    render(withLocale(<ReleaseNotesSettingsPage onBack={onBack} build="3058" notes={[V41]} />));
    await screen.findByTestId('settings-release-notes-page');
    fireEvent.press(screen.getByTestId('release-notes-row-0.1.41'));
    fireEvent(await screen.findByTestId('release-notes-detail'), 'accessibilityEscape');
    await waitFor(() => expect(screen.queryByTestId('release-notes-detail')).toBeNull());
    expect(onBack).not.toHaveBeenCalled();
    fireEvent(screen.getByTestId('settings-release-notes-page'), 'accessibilityEscape');
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('영어 UI에서는 같은 소식의 영어 글과 영어 문구가 선다 (실제 v0.1.41 소식)', async () => {
    render(withLocale(<ReleaseNotesSettingsPage onBack={() => {}} build="3058" />, true));
    await screen.findByTestId('settings-release-notes-page');
    expect(screen.getByText('What\'s new')).toBeTruthy();
    const row = screen.getByTestId('release-notes-row-0.1.41');
    expect(within(row).getByText('Version 0.1.41')).toBeTruthy();
    expect(within(row).getByText('Your version')).toBeTruthy();
    expect(within(row).getByText(RELEASE_NOTES[0].summary['en-US'])).toBeTruthy();
    fireEvent.press(row);
    const first = RELEASE_NOTES[0].items[0];
    const card = within(await screen.findByTestId('release-notes-item-' + first.id));
    expect(card.getByText(first.copy['en-US'].title)).toBeTruthy();
    expect(card.getByText('What changed')).toBeTruthy();
    expect(card.getByText('Try it like this')).toBeTruthy();
  });
});

describe('설정 › 정보 카드의 「업데이트 소식」 행', () => {
  pinMotionOff();
  // `language`: ko·en = 앱처럼 언어 provider 안, none = provider 없이(캡처 하네스의 `shell-profile-bottom` 같은 격리 표면).
  function mountSettings(
    initialPage?: React.ComponentProps<typeof SettingsPage>['initialPage'],
    language: 'ko' | 'en' | 'none' = 'ko',
  ) {
    const queryClient = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
    const page = (
      <QueryClientProvider client={queryClient}>
        <SettingsPage
          workspaceId={WS}
          member={SELF}
          directory={makeDirectory(ROSTER as unknown as RosterMember[])}
          connected
          onSignOut={() => {}}
          onClose={() => {}}
          initialPage={initialPage}
        />
      </QueryClientProvider>
    );
    return render(
      language === 'none' ? (
        <ThemeProvider>{page}</ThemeProvider>
      ) : (
        withLocale(page, language === 'en')
      ),
    );
  }

  it('정보 카드의 첫 줄이고, 값은 이 빌드의 소식 버전이며, 누르면 소식 장이 열린다', async () => {
    mountSettings();
    const row = await screen.findByTestId('settings-release-notes-row');
    const card = screen.getByTestId('settings-about-card-card');
    const rows = within(card).getAllByRole('button');
    // 정보 카드: 업데이트 소식, 연결 기록 복사(계정 카드 위, #4936).
    expect(rows[0]).toBe(row);
    expect(within(card).getByTestId('settings-copy-connection-log')).toBeTruthy();
    expect(within(row).getByText('업데이트 소식')).toBeTruthy();
    expect(within(row).getByText('0.1.41')).toBeTruthy();
    expect(row.props.accessibilityHint).toBe('버전별로 바뀐 점을 봐요.');
    fireEvent.press(row);
    expect(await screen.findByTestId('settings-release-notes-page')).toBeTruthy();
  });

  // #5047: 검증 줄 1회차에 `shell-profile-bottom` 의 이 행이 한국어 화면에서 「What's new」로 찍혔다. 사전 값은 처음부터 맞았고(위 시험),
  // 틀린 것은 언어 provider 가 없는 하네스에서 소식 훅이 영어 사전으로 떨어지던 대체였다. 하네스 조건 그대로(provider 없이) 잰다.
  it('언어 provider 가 없는 격리 표면(캡처 하네스)에서도 행은 한국어다 (#5047)', async () => {
    mountSettings(undefined, 'none');
    const row = await screen.findByTestId('settings-release-notes-row');
    expect(within(row).getByText('업데이트 소식')).toBeTruthy();
    expect(within(row).queryByText("What's new")).toBeNull();
    expect(row.props.accessibilityHint).toBe('버전별로 바뀐 점을 봐요.');
  });

  it("영어 앱에서는 같은 행이 「What's new」다 (#5047)", async () => {
    mountSettings(undefined, 'en');
    const row = await screen.findByTestId('settings-release-notes-row');
    expect(within(row).getByText("What's new")).toBeTruthy();
    expect(within(row).queryByText('업데이트 소식')).toBeNull();
    expect(within(row).getByText('0.1.41')).toBeTruthy();
    expect(row.props.accessibilityHint).toBe('See what changed in each version.');
  });
});

describe('셸 안에서: 시트의 「자세히 보기」가 설정의 소식 장을 연다', () => {
  pinMotionOff();
  let queryClient: QueryClient | null = null;
  const json = (body: unknown) =>
    ({status: 200, ok: true, text: async () => JSON.stringify(body)}) as unknown as Response;

  beforeEach(() => {
    __resetSessionStore();
    __resetServerBaseCache();
    setServerBase(BASE);
    sessionPort.applyLogin({
      accessToken: 'access-token-1',
      refreshToken: 'refresh-token-1',
      realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
      member: SELF,
    });
    globalThis.fetch = jest.fn(async (url: string) => {
      if (url.includes('/dev-access')) {
        return json(url.endsWith('/credentials') ? {credentials: []} : {policy: 'admins', canCreate: false, canManageAll: false});
      }
      if (url.includes('/reactions')) return json({});
      if (url.includes('/channels') && !url.includes('/messages')) return json({channels: []});
      if (url.includes('/roster')) return json({members: ROSTER});
      if (url.includes('/read-state')) return json({read_states: []});
      if (url.includes('/messages')) return json({messages: []});
      if (url.includes('/approvals')) return json({approvals: []});
      throw new Error('unrouted request: ' + url);
    }) as unknown as typeof fetch;
  });
  afterEach(() => {
    queryClient?.clear();
    queryClient = null;
  });

  it('홈이 서면 한 번 올라오고, 「자세히 보기」가 소식 장으로 열며, 다른 입구는 설정 첫 장으로 열린다', async () => {
    queryClient = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}, mutations: {retry: false, gcTime: 0}}});
    render(
      <ThemeProvider>
        <QueryClientProvider client={queryClient}>
          <AppShell member={SELF} />
        </QueryClientProvider>
      </ThemeProvider>,
    );
    // 빌드 3058 의 폰: 실제 v0.1.41 소식이 한 번 올라온다.
    expect(await screen.findByTestId('release-notes-sheet', {}, {timeout: 5000})).toBeTruthy();
    expect(screen.queryByTestId('settings-page')).toBeNull();
    fireEvent.press(screen.getByTestId('release-notes-details'));
    expect(await screen.findByTestId('settings-release-notes-page')).toBeTruthy();
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();
    expect(lastSeenReleaseNote()).toBe('0.1.41');

    // ‹ 는 설정 첫 장으로, X 는 설정을 닫는다. 같은 소식은 다시 올라오지 않는다.
    fireEvent.press(screen.getByTestId('settings-back'));
    await waitFor(() => expect(screen.queryByTestId('settings-release-notes-page')).toBeNull());
    expect(screen.getByTestId('settings-header')).toBeTruthy();
    fireEvent.press(screen.getByTestId('settings-close'));
    await waitFor(() => expect(screen.queryByTestId('settings-page')).toBeNull());
    expect(screen.queryByTestId('release-notes-sheet')).toBeNull();

    // 아바타로 연 설정은 소식 장이 아니라 첫 장이다(처음 열 장이 남지 않는다).
    fireEvent.press(screen.getByTestId('profile-avatar'));
    expect(await screen.findByTestId('settings-header')).toBeTruthy();
    expect(screen.queryByTestId('settings-release-notes-page')).toBeNull();
  });
});
