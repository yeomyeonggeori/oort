// M3 알림 미리 안내 (#2820, ADR-0193 D8 → #3925, ADR-0204 D4 「어떤 알림을 받을까요?」).
//
// 잰다.
//   1. 세션이 서도 알림 권한을 묻지 않는다(`requestPermissionsAsync` 0회). 예전의
//      `PushProvider`는 마운트되자마자 물었다. 그 호출을 되돌리면 이 파일이 빨갛다.
//   2. M3은 「아무도 묻지 않았을 때」만 선다. 허용·거부·provisional·ephemeral이면
//      건너뛴다. expo가 provisional을 일반 `status`에서 `undetermined`로 접으므로
//      iOS 원래 값을 보지 않으면 provisional에서 M3이 서고 이 파일이 빨갛다.
//   3. (D4) 버튼은 [계속] 하나이고 스위치는 버튼이 아니다. 작업 끝남 스위치는 프로필의 그
//      스위치와 같은 `PATCH …/push-kinds {workComplete}` 하나만 로그인한 세션으로 보낸다.
//      승인 요청·멘션·DM은 「항상 와요」이고 끌 수 없다.
//   4. (D4) 거부하면 같은 화면이 「프로필 › 알림에서 켤 수 있어요」를 말하고, 버튼 하나로
//      내려간다. 그동안 키 연결 시트는 기다린다.
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

import type {Member} from '@momo/core/lib/api';
import {
  PUSH_WORK_COMPLETE_LABEL,
  NOTIFICATION_PAUSE_SAVE_FAILED,
} from '@momo/core/features/settings/notificationRules';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import React from 'react';
import {ScrollView, StyleSheet} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {slopTo, TOUCH_TARGET} from '../src/design/tokens';
import {KOMETTO_EXPRESSION_ASSETS} from '../src/features/onboarding/komettoExpressions';
import {NotificationPrimerGate} from '../src/features/onboarding/NotificationPrimer';
import {
  isNotifyPrimerHeld,
  NOTIFY_ALWAYS_LABEL,
  NOTIFY_APPROVAL_NOTE,
  NOTIFY_APPROVE_BUTTON,
  NOTIFY_CONTINUE_LABEL,
  NOTIFY_DECLINED_DETAIL,
  NOTIFY_DECLINED_LABEL,
  NOTIFY_DECLINED_LINE,
  NOTIFY_DETAIL,
  NOTIFY_LINE,
  NOTIFY_MENTION_LABEL,
  NOTIFY_REJECT_BUTTON,
  NOTIFY_SAMPLES,
  noteConnectRoute,
  resetConnectRoute,
  shouldAskNotifications,
} from '../src/features/onboarding/phoneFlow';
import {PUSH_CATEGORY} from '../src/push/contract';
import {PUSH_CATEGORY_ACTIONS} from '../src/push/categories';
import PushProvider from '../src/push/PushProvider';
import {SessionProvider} from '../src/session/useSession';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

const WS = '22222222-2222-4222-8222-222222222222';
const MEMBER: Member = {
  id: '11111111-1111-4111-8111-111111111111',
  workspaceId: WS,
  kind: 'human',
  displayName: 'Seongjae Kwak',
  handle: 'seongjae',
};

const getPermissions = Notifications.getPermissionsAsync as jest.Mock;
const requestPermissions = Notifications.requestPermissionsAsync as jest.Mock;

/** 알림 예시는 장식이라 보조기술(그리고 기본 질의)에서 숨는다. */
const HIDDEN = {includeHiddenElements: true} as const;

/** expo `NotificationPermissionsStatus`의 모양. iOS 값은 UNAuthorizationStatus. */
function settings(
  status: 'granted' | 'denied' | 'undetermined',
  iosStatus?: number,
) {
  return {
    status,
    granted: status === 'granted',
    canAskAgain: status !== 'denied',
    expires: 'never',
    ...(iosStatus === undefined ? {} : {ios: {status: iosStatus}}),
  };
}

const NOT_DETERMINED = 0;
const DENIED = 1;
const AUTHORIZED = 2;
const PROVISIONAL = 3;
const EPHEMERAL = 4;

function jsonResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

// ---- push-kinds를 서버처럼 받는 fetch -------------------------------------------

interface KindsCall {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
}

interface KindsServer {
  /** 서버의 값. 서버 기본은 「켬」이다. */
  kinds: {workComplete: boolean};
  /** 종류 GET의 답: 정상 · 500 · 404(이 경로를 모르는 서버) · 영영 안 옴. */
  read: 'ok' | 'fail' | 'absent' | 'hang';
  /** PATCH를 500으로 실패시킨다. */
  writeFails: boolean;
  /** push-kinds로 나간 요청 전부(GET 포함). */
  calls: KindsCall[];
}

let server: KindsServer;
/**
 * 영영 안 오는 답의 풀이. 그냥 두면 `fetchWithDeadline`의 기한 타이머가 시험이 끝난
 * 뒤에도 살아 jest가 닫히지 않는다 — 시험이 끝나면 답을 보내 타이머를 거둔다.
 */
const hung: Array<() => void> = [];

function installFetch(): void {
  globalThis.fetch = jest.fn(async (url: string, init?: RequestInit) => {
    if (!url.includes('/notification-rules/push-kinds')) {
      return jsonResponse(200, {items: [], unreadTotal: 0});
    }
    const method = init?.method ?? 'GET';
    server.calls.push({
      url,
      method,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: new Headers(init?.headers).get('Authorization'),
    });
    if (method === 'PATCH') {
      if (server.writeFails) return jsonResponse(500, {error: {message: 'x'}});
      const body = JSON.parse(String(init?.body)) as {workComplete: boolean};
      server.kinds = {...server.kinds, ...body};
      return jsonResponse(200, {...server.kinds});
    }
    if (server.read === 'fail') {
      return jsonResponse(500, {error: {message: 'boom'}});
    }
    if (server.read === 'absent') {
      return jsonResponse(404, {error: {message: 'no route'}});
    }
    if (server.read === 'hang') {
      return new Promise<Response>(resolve => {
        hung.push(() => resolve(jsonResponse(200, {...server.kinds})));
      });
    }
    return jsonResponse(200, {...server.kinds});
  }) as unknown as typeof fetch;
}

const patches = () => server.calls.filter(call => call.method === 'PATCH');

beforeEach(() => {
  __resetSessionStore();
  __resetServerBaseCache();
  resetConnectRoute();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin({
    accessToken: 'access-token-1',
    refreshToken: 'refresh-token-1',
    realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
    member: MEMBER,
  });
  server = {
    kinds: {workComplete: true},
    read: 'ok',
    writeFails: false,
    calls: [],
  };
  installFetch();
  getPermissions.mockReset();
  requestPermissions.mockReset();
  requestPermissions.mockResolvedValue(settings('granted', AUTHORIZED));
});

afterEach(() => {
  hung.splice(0).forEach(release => release());
  jest.restoreAllMocks();
});

function mount() {
  const client = new QueryClient({
    defaultOptions: {
      queries: {retry: false, gcTime: 0},
      mutations: {retry: false, gcTime: 0},
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <SessionProvider member={MEMBER}>
        <PushProvider>
          <NotificationPrimerGate />
        </PushProvider>
      </SessionProvider>
    </QueryClientProvider>,
  );
}

async function settle() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) await Promise.resolve();
  });
}

/** M3이 서고, 서버의 작업 끝남 값을 읽어 스위치가 선 때까지. */
async function mountPrimer() {
  getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
  mount();
  await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
  await waitFor(() =>
    expect(screen.getByTestId('notify-work-switch', HIDDEN)).toBeTruthy(),
  );
}

describe('shouldAskNotifications — M3 only when nobody has asked', () => {
  it.each([
    ['granted', settings('granted', AUTHORIZED), false],
    ['denied', settings('denied', DENIED), false],
    ['undetermined (iOS notDetermined)', settings('undetermined', NOT_DETERMINED), true],
    // expo folds these two into `undetermined` (ExpoNotificationsPermissionsRequester
    // `default:`); they are decided answers all the same.
    ['provisional', settings('undetermined', PROVISIONAL), false],
    ['ephemeral', settings('undetermined', EPHEMERAL), false],
    ['undetermined without an iOS value', settings('undetermined'), true],
  ])('%s', (_name, value, expected) => {
    expect(shouldAskNotifications(value)).toBe(expected);
  });
});

describe('PushProvider never asks on its own (#2820)', () => {
  it('reads the permission on sign-in and does not raise the iOS prompt', async () => {
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    await settle();
    expect(getPermissions).toHaveBeenCalled();
    expect(requestPermissions).toHaveBeenCalledTimes(0);
  });
});

describe('M3 어떤 알림을 받을까요? (#3925, ADR-0204 D4)', () => {
  it('asks the D4 question and has exactly one button, 「계속」', async () => {
    await mountPrimer();
    expect(screen.getByText(NOTIFY_LINE)).toBeTruthy();
    expect(NOTIFY_LINE).toBe('어떤 알림을 받을까요?');
    expect(screen.getByTestId('notify-primer-detail')).toHaveTextContent(NOTIFY_DETAIL);
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(NOTIFY_CONTINUE_LABEL);
    // HIG: no way out that skips the system prompt, and no label that reads like
    // the system's own buttons (the mockup's 「알림 켜기」/「나중에」, ADR-0193 D8).
    expect(buttons[0]).not.toHaveTextContent(/허용|나중에|알림 켜기/);
  });

  it('does not count the switch or the pictured [승인][거부] as buttons, hidden ones included', async () => {
    await mountPrimer();
    // 스위치는 `switch` 역할이다.
    expect(
      screen.getByRole('switch', {name: PUSH_WORK_COMPLETE_LABEL}),
    ).toBeTruthy();
    // 숨겨진 것까지 세어도 버튼은 [계속] 하나다: 미리 보기의 버튼 모양은 그림이다.
    expect(screen.getAllByRole('button', HIDDEN)).toHaveLength(1);
    const pictured = screen.getByTestId('notify-sample-approval', HIDDEN);
    expect(within(pictured).getByText(NOTIFY_APPROVE_BUTTON, HIDDEN)).toBeTruthy();
    expect(within(pictured).getByText(NOTIFY_REJECT_BUTTON, HIDDEN)).toBeTruthy();
  });

  it('shows three kinds in the ADR order; 승인 요청 and 멘션·답·DM say 「항상 와요」, 작업 끝남 has the switch', async () => {
    await mountPrimer();
    const labels = screen
      .getAllByTestId(/^notify-kind-(approval|work|mention)$/)
      .map(node => node.props.testID);
    expect(labels).toEqual([
      'notify-kind-approval',
      'notify-kind-work',
      'notify-kind-mention',
    ]);

    const approval = screen.getByTestId('notify-kind-approval-head');
    expect(approval.props.accessibilityLabel).toBe(`승인 요청, ${NOTIFY_ALWAYS_LABEL}`);
    expect(screen.getByTestId('notify-kind-approval-note')).toHaveTextContent(
      NOTIFY_APPROVAL_NOTE,
    );
    expect(NOTIFY_APPROVAL_NOTE).toBe('잠금 화면에서 바로');

    const mention = screen.getByTestId('notify-kind-mention-head');
    expect(mention.props.accessibilityLabel).toBe(
      `${NOTIFY_MENTION_LABEL}, ${NOTIFY_ALWAYS_LABEL}`,
    );
    expect(NOTIFY_MENTION_LABEL).toMatch(/^나를 부른 멘션·답/);
    expect(NOTIFY_MENTION_LABEL).toMatch(/DM/);

    // 끌 수 없는 둘에는 스위치가 없고, 끌 수 있는 하나에만 있다.
    expect(within(screen.getByTestId('notify-kind-approval')).queryByRole('switch')).toBeNull();
    expect(within(screen.getByTestId('notify-kind-mention')).queryByRole('switch')).toBeNull();
    const work = screen.getByTestId('notify-work-row');
    expect(work.props.accessibilityRole).toBe('switch');
    expect(work.props.accessibilityState).toMatchObject({checked: true, disabled: false});
    expect(PUSH_WORK_COMPLETE_LABEL).toBe('작업 끝남');
  });

  it('reaches 44pt on the 작업 끝남 row: its box plus a derived hitSlop, never a typed 44', async () => {
    await mountPrimer();
    const row = screen.getByTestId('notify-work-row');
    const box = StyleSheet.flatten(row.props.style).minHeight as number;
    const {top, bottom} = row.props.hitSlop as {top: number; bottom: number};
    expect(top).toBe(slopTo(box));
    expect(bottom).toBe(slopTo(box));
    expect(box + top + bottom).toBeGreaterThanOrEqual(TOUCH_TARGET);
    // 세 종류 이름 줄이 같은 높이여야 이름과 알림 사이가 같은 리듬으로 선다.
    const heights = ['approval', 'mention'].map(
      kind =>
        StyleSheet.flatten(
          screen.getByTestId(`notify-kind-${kind}-head`).props.style,
        ).minHeight,
    );
    expect(heights).toEqual([box, box]);
  });

  it('centres every kind head in its box: a wrapping row sticks the text to the top, and the gap under the name then differs by kind', async () => {
    await mountPrimer();
    const heads = [
      screen.getByTestId('notify-kind-approval-head'),
      screen.getByTestId('notify-work-row'),
      screen.getByTestId('notify-kind-mention-head'),
    ].map(node => StyleSheet.flatten(node.props.style));
    expect(heads.map(style => style.alignContent)).toEqual([
      'center',
      'center',
      'center',
    ]);
  });

  it('keeps 「계속」 out of the scrolling content, so it is in view on the smallest phone and at the largest type', async () => {
    await mountPrimer();
    const scroll = screen.UNSAFE_getByType(ScrollView);
    // 내용(종류 셋과 안내 두 줄)은 스크롤 안에 있고 함께 스크롤한다.
    expect(within(scroll).getByTestId('notify-kind-approval')).toBeTruthy();
    expect(within(scroll).getByTestId('notify-kind-mention')).toBeTruthy();
    expect(within(scroll).getByTestId('notify-primer-detail')).toBeTruthy();
    // [계속]은 스크롤 밖 바닥에 붙는다: 내용이 길어도 첫 화면에서 눌러 볼 수 있다.
    expect(within(scroll).queryByTestId('notify-primer-continue')).toBeNull();
    expect(screen.getByTestId('notify-primer-continue')).toBeTruthy();
  });

  it('pictures the real approval buttons: the preview names the same two actions the notification carries', () => {
    const approval = PUSH_CATEGORY_ACTIONS.find(
      ([identifier]) => identifier === PUSH_CATEGORY.approval,
    );
    expect(approval).toBeDefined();
    expect(approval![1].map(action => action.buttonTitle)).toEqual([
      NOTIFY_APPROVE_BUTTON,
      NOTIFY_REJECT_BUTTON,
    ]);
    // 그리고 iOS는 거부를 붉게 그린다(`isDestructive`). 미리 보기도 그렇게 그린다.
    expect(approval![1][1].options?.isDestructive).toBe(true);
  });

  it('writes the previews the way the notification really reads, with no person name', () => {
    const swift = readFileSync(
      join(__dirname, '..', 'ios/MomoPushKit/PushNotification.swift'),
      'utf8',
    );
    // 「작업 끝남」: 알림 확장의 고정 문구(`PushWorkRunDoneCopy`)를 그대로.
    const block = swift.slice(swift.indexOf('enum PushWorkRunDoneCopy'));
    const title = block.match(/static let title = "([^"]+)"/)?.[1];
    const body = block.match(/static let body = "([^"]+)"/)?.[1];
    expect(title).toBeDefined();
    expect(NOTIFY_SAMPLES.work).toEqual({title, body});
    // 「승인 요청」: 서버가 카드 본문에 쓰는 꼴 「승인 요청: {제목}」.
    expect(NOTIFY_SAMPLES.approval.body).toMatch(/^승인 요청: \S/);
    // 사람 이름을 넣지 않는다: 제목은 에이전트 이름이거나 고정 문구뿐이다.
    expect(
      [NOTIFY_SAMPLES.approval.title, NOTIFY_SAMPLES.mention.title].every(
        t => t === 'Claude',
      ),
    ).toBe(true);
    expect(JSON.stringify(NOTIFY_SAMPLES)).not.toMatch(
      new RegExp(`${MEMBER.displayName}|${MEMBER.handle}|곽성재`),
    );
  });

  it('raises the iOS prompt only when 「계속」 is pressed, then gets out of the way', async () => {
    await mountPrimer();
    expect(requestPermissions).toHaveBeenCalledTimes(0);

    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(screen.queryByTestId('notify-primer')).toBeNull());
    expect(requestPermissions).toHaveBeenCalledTimes(1);
    // 허용하면 거부 뒤 안내는 서지 않는다.
    expect(screen.queryByTestId('notify-declined')).toBeNull();
    expect(isNotifyPrimerHeld()).toBe(false);
  });

  it.each([
    ['granted', settings('granted', AUTHORIZED)],
    ['denied', settings('denied', DENIED)],
    ['provisional', settings('undetermined', PROVISIONAL)],
    ['ephemeral', settings('undetermined', EPHEMERAL)],
  ])(
    'is skipped when the permission is already %s, and costs that person no extra request',
    async (_name, value) => {
      getPermissions.mockResolvedValue(value);
      mount();
      await settle();
      expect(getPermissions).toHaveBeenCalled();
      expect(screen.queryByTestId('notify-primer')).toBeNull();
      expect(screen.queryByTestId('notify-declined')).toBeNull();
      expect(requestPermissions).toHaveBeenCalledTimes(0);
      // 서 있지 않은 M3은 종류 스위치의 값을 읽지도 않는다.
      expect(server.calls).toEqual([]);
    },
  );

  it('continues the QR route’s progress dots: three steps, the third', async () => {
    noteConnectRoute('qr');
    await mountPrimer();
    expect(screen.getByTestId('onboarding-dots').props.accessibilityLabel).toBe(
      '3단계 중 3단계',
    );
  });

  it('shows no dots when the route is unknown (the app was relaunched)', async () => {
    await mountPrimer();
    expect(screen.queryByTestId('onboarding-dots')).toBeNull();
  });
});

describe('작업 끝남 스위치 → push-kinds (ADR-0204 D4)', () => {
  it('reads the server value, and turning it off sends exactly PATCH {workComplete:false} as the signed-in session', async () => {
    await mountPrimer();
    // 읽기만 했다: 스위치는 서버가 말한 「켬」으로 서고 쓰기는 아직 없다.
    expect(patches()).toHaveLength(0);
    expect(server.calls.map(call => call.method)).toEqual(['GET']);
    expect(screen.getByTestId('notify-work-switch', HIDDEN).props.value).toBe(true);

    fireEvent.press(screen.getByTestId('notify-work-row'));
    await waitFor(() => expect(patches()).toHaveLength(1));

    const sent = patches()[0];
    expect(sent.url).toBe(
      `https://api.example.com/v1/workspaces/${WS}/notification-rules/push-kinds`,
    );
    expect(JSON.stringify(sent.body)).toBe('{"workComplete":false}');
    // 세션이 선 뒤다: 로그인한 세션의 토큰으로 나간다.
    expect(sent.authorization).toBe('Bearer access-token-1');
    await waitFor(() =>
      expect(screen.getByTestId('notify-work-row').props.accessibilityState).toMatchObject({
        checked: false,
      }),
    );
    // 이 스위치는 iOS 창과 아무 상관이 없다.
    expect(requestPermissions).toHaveBeenCalledTimes(0);
  });

  it('the switch control itself sends the same PATCH; turning it back on sends {workComplete:true}', async () => {
    server.kinds = {workComplete: false};
    await mountPrimer();
    expect(screen.getByTestId('notify-work-switch', HIDDEN).props.value).toBe(false);
    fireEvent(screen.getByTestId('notify-work-switch', HIDDEN), 'valueChange', true);
    await waitFor(() => expect(patches()).toHaveLength(1));
    expect(JSON.stringify(patches()[0].body)).toBe('{"workComplete":true}');
  });

  it('dims the work-done example when it is off, and only then', async () => {
    await mountPrimer();
    const flat = (style: unknown) =>
      Object.assign({}, ...[style].flat(Infinity).filter(Boolean)) as {opacity?: number};
    expect(flat(screen.getByTestId('notify-sample-work', HIDDEN).props.style).opacity).toBe(
      undefined,
    );
    fireEvent.press(screen.getByTestId('notify-work-row'));
    await waitFor(() =>
      expect(
        flat(screen.getByTestId('notify-sample-work', HIDDEN).props.style).opacity,
      ).toBeLessThan(1),
    );
    // 항상 오는 것은 스위치를 꺼도 흐려지지 않는다.
    expect(
      flat(screen.getByTestId('notify-sample-approval', HIDDEN).props.style).opacity,
    ).toBe(undefined);
  });

  it('pressing 「계속」 writes nothing by itself', async () => {
    await mountPrimer();
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(requestPermissions).toHaveBeenCalledTimes(1));
    expect(patches()).toHaveLength(0);
  });

  it('is locked until the server value is read: no switch, and pressing sends nothing', async () => {
    server.read = 'hang';
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    const row = screen.getByTestId('notify-work-row');
    expect(row.props.accessibilityState).toMatchObject({disabled: true});
    expect(screen.queryByTestId('notify-work-switch', HIDDEN)).toBeNull();
    expect(screen.getByTestId('notify-work-loading', HIDDEN)).toBeTruthy();
    fireEvent.press(row);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(patches()).toHaveLength(0);
    // 그래도 [계속]은 누를 수 있다: 스위치를 못 읽었다고 사람을 가두지 않는다.
    expect(screen.getByTestId('notify-primer-continue').props.accessibilityState).toMatchObject({
      disabled: false,
    });
  });

  it('puts the switch back and says so when the write fails', async () => {
    server.writeFails = true;
    await mountPrimer();
    fireEvent.press(screen.getByTestId('notify-work-row'));
    await waitFor(() => expect(screen.getByTestId('notify-work-failure')).toBeTruthy());
    expect(screen.getByTestId('notify-work-failure')).toHaveTextContent(
      NOTIFICATION_PAUSE_SAVE_FAILED,
    );
    expect(screen.getByTestId('notify-work-row').props.accessibilityState).toMatchObject({
      checked: true,
    });
  });

  it('says the value could not be read, and does not draw a switch it does not know', async () => {
    server.read = 'fail';
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-work-load-failed')).toBeTruthy(), {
      timeout: 4000,
    });
    expect(screen.queryByTestId('notify-work-switch', HIDDEN)).toBeNull();
    expect(screen.queryByTestId('notify-work-loading', HIDDEN)).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('leaves the 작업 끝남 kind out on a server that does not know the route (404)', async () => {
    server.read = 'absent';
    getPermissions.mockResolvedValue(settings('undetermined', NOT_DETERMINED));
    mount();
    await waitFor(() => expect(screen.getByTestId('notify-primer')).toBeTruthy());
    await waitFor(() => expect(screen.queryByTestId('notify-kind-work')).toBeNull());
    // 나머지 둘과 [계속]은 그대로다.
    expect(screen.getByTestId('notify-kind-approval')).toBeTruthy();
    expect(screen.getByTestId('notify-kind-mention')).toBeTruthy();
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });
});

describe('거부 뒤 안내 (ADR-0204 D4)', () => {
  async function declineInThePrompt() {
    requestPermissions.mockResolvedValue(settings('denied', DENIED));
    await mountPrimer();
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('notify-declined')).toBeTruthy());
  }

  it('after 「허용 안 함」 the same screen says where to turn it on, with one button', async () => {
    await declineInThePrompt();
    expect(screen.getByText(NOTIFY_DECLINED_LINE)).toBeTruthy();
    expect(screen.getByTestId('kometto-guide-detail')).toHaveTextContent(
      NOTIFY_DECLINED_DETAIL,
    );
    expect(NOTIFY_DECLINED_DETAIL).toContain('프로필 › 알림에서 켤 수 있어요');
    // 종류 목록과 스위치는 걷혔다. 버튼은 하나이고 [시작하기]다.
    expect(screen.queryByTestId('notify-kind-approval')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toHaveTextContent(NOTIFY_DECLINED_LABEL);
    expect(screen.queryByTestId('notify-primer-continue')).toBeNull();
    // 창은 한 번만 떴다.
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('keeps 「시작하기」 in the same pinned place as 「계속」 was', async () => {
    await declineInThePrompt();
    const scroll = screen.UNSAFE_getByType(ScrollView);
    expect(within(scroll).queryByTestId('notify-declined-continue')).toBeNull();
    expect(screen.getByTestId('notify-declined-continue')).toBeTruthy();
  });

  it('the face turns sleepy (the 「skipped」 row of the D11 table)', async () => {
    await declineInThePrompt();
    expect(screen.getByTestId('kometto-face-current', HIDDEN).props.source).toBe(
      KOMETTO_EXPRESSION_ASSETS.sleepy,
    );
  });

  it('「시작하기」 closes it and the app is all there is', async () => {
    await declineInThePrompt();
    fireEvent.press(screen.getByTestId('notify-declined-continue'));
    await waitFor(() => expect(screen.queryByTestId('notify-declined')).toBeNull());
    expect(screen.queryByTestId('notify-primer')).toBeNull();
    // 거부했다고 다시 묻지 않는다.
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('holds the key-link sheet from the moment 「계속」 is pressed until the note is closed', async () => {
    requestPermissions.mockResolvedValue(settings('denied', DENIED));
    await mountPrimer();
    expect(isNotifyPrimerHeld()).toBe(false);
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(screen.getByTestId('notify-declined')).toBeTruthy());
    expect(isNotifyPrimerHeld()).toBe(true);
    fireEvent.press(screen.getByTestId('notify-declined-continue'));
    await waitFor(() => expect(isNotifyPrimerHeld()).toBe(false));
  });

  it('lets go of the key-link sheet when the app is signed out of the way', async () => {
    requestPermissions.mockResolvedValue(settings('denied', DENIED));
    await mountPrimer();
    await act(async () => {
      fireEvent.press(screen.getByTestId('notify-primer-continue'));
    });
    await waitFor(() => expect(isNotifyPrimerHeld()).toBe(true));
    screen.unmount();
    expect(isNotifyPrimerHeld()).toBe(false);
  });
});
