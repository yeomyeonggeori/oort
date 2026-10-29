import type {Member} from '@momo/core/lib/api';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react-native';
import * as Notifications from 'expo-notifications';
import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import {AppState} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import App from '../App';
import {
  decideForeground,
  installForegroundNotificationHandler,
  presentForeground,
} from '../src/push/foregroundPresentation';
import {
  __resetViewedConversation,
  publishViewedConversation,
  useReportViewedConversation,
  viewedConversation,
} from '../src/push/viewedConversation';
import AppShell from '../src/shell/AppShell';
import {__resetSessionStore, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';
import {
  installAppClock,
  SHELL_WAIT_TEST_TIMEOUT_MS,
} from './fixtures/fakeClock';
import {jsonResponse, resetSession} from './testkit';

// =============================================================================
// 앱이 앞에 있을 때 다른 대화의 새 메시지가 배너로 뜬다 (#4310, #4295 후속).
//
// 결함: 폰 앱에는 포그라운드 표시 처리기가 없어서, expo-notifications 57.0.8 의 iOS 가 열려 있는
// 동안 온 푸시를 `completionHandler([])` 로 끝냈다 — 배너·목록·소리 모두 없이 사라졌다.
//
// 이 파일이 재는 것은 **expo-notifications 에 실제로 건넨 답**이다. `setNotificationHandler` 에
// 걸린 처리기를 꺼내 릴레이가 보내는 모양의 페이로드로 직접 부른다. 가짜는 둘뿐이다: 네이티브 쪽
// (`setNotificationHandler` 는 받은 처리기를 기록만 한다), 서버의 답(`fetch`). 화면·내비게이션·
// 스레드·`AppState` 판정은 앱이 그리는 그대로다.
//
// ## 단정이 헛돌지 않게 — 세 겹으로 잰다
//
//   1. 결정(`decideForeground`)은 순수 함수로 표를 만든다.
//   2. 처리기(`presentForeground`)는 건넨 답의 **모양**(`shouldShow*`)과, 던지지 않는다는 것을 잰다.
//      결정이 맞아도 처리기가 그 답을 안 쓰면 여기서 빨개진다.
//   3. 「지금 보는 대화」는 손으로 올린 값이 아니라 **진짜 `AppShell` 의 대화 화면이 올린 값**을
//      읽는다. 화면이 값을 안 올리면(배선 누락) 1·2가 다 초록이어도 실제 앱에서는 숨김이 한 번도
//      일어나지 않는다 — 그 구멍은 맨 아래 「실제 화면」 묶음만이 막는다.
//
// fixture 는 가상 인물(이도현·박서연·최민수·정하윤)과 가상 회사(달무리 스튜디오)만 쓴다.
// =============================================================================

const WS = '22222222-2222-4222-8222-222222222222';
const OTHER_WS = '99999999-2222-4222-8222-222222222222';
const DESIGN = '33333333-3333-4333-8333-333333333333';
const NOTICE = '44444444-3333-4333-8333-444444444444';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const OTHER_ROOT_ID = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const MESSAGE_ID = '55555555-5555-4555-8555-555555555555';
const APPROVAL_ID = '66666666-6666-4666-8666-666666666666';
const SELF_ID = '11111111-1111-4111-8111-111111111111';
const SEOYEON_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
const BASE = 'https://api.example.com';
const BASE_MS = 1_700_000_000_000;

/** 처리기가 「보인다」로 답했을 때 expo 에 건네는 값 그대로. */
const SHOWN = {
  shouldShowBanner: true,
  shouldShowList: true,
  shouldPlaySound: true,
  shouldSetBadge: false,
};
/** 「숨긴다」: 배너도, 알림 센터 목록에 남기는 것도, 소리도 없다. */
const HIDDEN = {
  shouldShowBanner: false,
  shouldShowList: false,
  shouldPlaySound: false,
  shouldSetBadge: false,
};

// ---- 릴레이가 보내는 모양 -------------------------------------------------------
// `server-rust/bins/momo-push-relay/src/dispatch.rs` 의 `ApnsPayload` 와 같은 키다.
// 스레드 답글이면 `aps.thread-id` 가 루트 메시지 id 이고, 본류면 채널 id 다.

interface PayloadOver {
  workspaceId?: string;
  channelId: string;
  threadId?: string;
  category?: string;
  reason?: string;
  approvalId?: string;
}

function relayPayload(over: PayloadOver) {
  return {
    aps: {
      alert: {title: 'oort', body: '새 알림'},
      badge: 4,
      sound: 'default',
      'thread-id': over.threadId ?? over.channelId,
      category: over.category ?? 'momo.message',
      'mutable-content': 1,
      'content-available': 1,
    },
    momo: {
      schema: 'momo.push.notification.v2',
      server_id: 'server-a',
      workspace_id: over.workspaceId ?? WS,
      channel_id: over.channelId,
      message_id: MESSAGE_ID,
      collapse_id: 'collapse-1',
      reason: over.reason ?? 'dm',
      ...(over.approvalId === undefined ? {} : {approval_id: over.approvalId}),
    },
  };
}

/** expo 가 `willPresent` 에서 JS 로 올려 주는 모양: 원격 푸시는 `trigger.payload` 에 전체 userInfo 를 든다. */
function remoteNotification(userInfo: unknown): Notifications.Notification {
  return {
    date: BASE_MS,
    request: {
      identifier: 'collapse-1',
      content: {title: null, subtitle: null, body: null, data: {}, sound: 'default'},
      trigger: {type: 'push', payload: userInfo},
    },
  } as unknown as Notifications.Notification;
}

/** 잠금 화면 승인 뒤 네이티브 처리기가 올리는 결과 줄: 트리거가 없고 원문은 `data.origin` 에 있다. */
function localResultLine(origin: unknown): Notifications.Notification {
  return {
    date: BASE_MS,
    request: {
      identifier: 'collapse-1',
      content: {title: '승인했어요', subtitle: null, body: null, data: {origin}, sound: null},
      trigger: null,
    },
  } as unknown as Notifications.Notification;
}

const setHandler = jest.mocked(Notifications.setNotificationHandler);

/** 가장 최근에 expo 에 걸린 처리기. */
function registeredHandler(): Notifications.NotificationHandler {
  const handler = setHandler.mock.calls.at(-1)?.[0];
  if (!handler) throw new Error('no notification handler was registered');
  return handler;
}

/** expo 가 하듯이 처리기를 부른다. */
function present(userInfo: unknown): Promise<Notifications.NotificationBehavior> {
  return registeredHandler().handleNotification(remoteNotification(userInfo));
}

// ---- AppState --------------------------------------------------------------------

let appStatus = 'active';

function pinAppState(initial = 'active') {
  appStatus = initial;
  Object.defineProperty(AppState, 'currentState', {
    configurable: true,
    get: () => appStatus,
  });
}

// 시험 파일마다 RN 모듈 레지스트리가 새로 서므로 getter 를 되돌릴 필요는 없다. 시험마다 다시 못 박는다.
beforeEach(() => {
  pinAppState('active');
  __resetViewedConversation();
  setHandler.mockClear();
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

const VIEWING_DESIGN = {workspaceId: WS, channelId: DESIGN, threadRootId: null};
const VIEWING_DESIGN_THREAD = {
  workspaceId: WS,
  channelId: DESIGN,
  threadRootId: ROOT_ID,
};

// =============================================================================
// 1. 결정 — 보고 있는 대화의 알림만 숨긴다 (순수)
// =============================================================================

describe('결정: 보고 있는 대화의 알림만 숨긴다', () => {
  it('앞에 있는 대화가 없으면 보인다', () => {
    expect(decideForeground(relayPayload({channelId: DESIGN}), null)).toEqual({
      show: true,
      why: 'not-viewing',
    });
  });

  it('다른 채널을 보는 중에는 보인다 — 다른 대화의 DM 배너', () => {
    expect(
      decideForeground(relayPayload({channelId: NOTICE}), VIEWING_DESIGN),
    ).toEqual({show: true, why: 'other-conversation'});
  });

  it('같은 채널 본류를 보고 있으면 숨긴다', () => {
    expect(
      decideForeground(relayPayload({channelId: DESIGN}), VIEWING_DESIGN),
    ).toEqual({show: false, why: 'viewing'});
  });

  it('같은 채널이라도 다른 워크스페이스의 알림이면 보인다', () => {
    expect(
      decideForeground(
        relayPayload({workspaceId: OTHER_WS, channelId: DESIGN}),
        VIEWING_DESIGN,
      ),
    ).toEqual({show: true, why: 'other-workspace'});
  });

  // 위의 `WS`·`DESIGN` 은 숫자뿐이라 `toUpperCase()` 해도 그대로다 — 그 id 로 대소문자를 재면 단정이
  // 헛돈다(처음 판이 그랬고, 비교를 `===` 로 바꾸는 변조가 초록으로 지나갔다). 16진 글자가 든 id 를 쓴다.
  describe('id 의 대소문자가 달라도 같은 방이다', () => {
    const CASE_WS = 'abcdef01-2222-4222-8222-abcdefabcdef';
    const CASE_CH = 'fedcba98-3333-4333-8333-fedcbafedcba';
    const lower = {workspaceId: CASE_WS, channelId: CASE_CH, threadRootId: null};
    const upper = {
      workspaceId: CASE_WS.toUpperCase(),
      channelId: CASE_CH.toUpperCase(),
      threadRootId: null,
    };

    it('이 fixture 는 대소문자를 실제로 가른다 — 아래 두 단정이 헛돌지 않는다', () => {
      expect(CASE_WS.toUpperCase()).not.toBe(CASE_WS);
      expect(CASE_CH.toUpperCase()).not.toBe(CASE_CH);
    });

    it('화면의 id 가 대문자여도 숨긴다(봉투는 소문자로 접힌다)', () => {
      const push = relayPayload({workspaceId: CASE_WS, channelId: CASE_CH});
      expect(decideForeground(push, upper)).toEqual({show: false, why: 'viewing'});
    });

    it('봉투의 id 가 대문자여도 숨긴다', () => {
      const push = relayPayload({
        workspaceId: CASE_WS.toUpperCase(),
        channelId: CASE_CH.toUpperCase(),
      });
      expect(decideForeground(push, lower)).toEqual({show: false, why: 'viewing'});
    });
  });

  describe('스레드 답글은 같은 스레드가 열려 있을 때만 숨긴다', () => {
    const reply = relayPayload({channelId: DESIGN, threadId: ROOT_ID});

    it('채널 본류만 보는 중이면 보인다', () => {
      expect(decideForeground(reply, VIEWING_DESIGN)).toEqual({
        show: true,
        why: 'other-thread',
      });
    });

    it('같은 스레드가 열려 있으면 숨긴다', () => {
      expect(decideForeground(reply, VIEWING_DESIGN_THREAD)).toEqual({
        show: false,
        why: 'viewing',
      });
    });

    it('다른 스레드가 열려 있으면 보인다', () => {
      expect(
        decideForeground(reply, {...VIEWING_DESIGN_THREAD, threadRootId: OTHER_ROOT_ID}),
      ).toEqual({show: true, why: 'other-thread'});
    });

    it('스레드 id 의 대소문자가 달라도 같은 스레드다 (ROOT_ID 는 16진 글자를 든다)', () => {
      expect(ROOT_ID.toUpperCase()).not.toBe(ROOT_ID);
      expect(
        decideForeground(reply, {
          ...VIEWING_DESIGN_THREAD,
          threadRootId: ROOT_ID.toUpperCase(),
        }),
      ).toEqual({show: false, why: 'viewing'});
    });

    it('다른 채널의 스레드는 루트 id 가 같아도 보인다', () => {
      expect(
        decideForeground(
          relayPayload({channelId: NOTICE, threadId: ROOT_ID}),
          VIEWING_DESIGN_THREAD,
        ),
      ).toEqual({show: true, why: 'other-conversation'});
    });
  });

  // 문면 그대로의 규칙이다: 「같은 채널(스레드 알림이면 같은 스레드)」. 스레드 판이 채널을 덮고 있어도
  // 같은 채널의 본류 알림은 숨긴다 — 서버의 「보고 있음」 신호(`useViewingBeat`)가 채널 단위로 같은
  // 판정을 이미 내리고 있어서 이 폰의 규칙이 서버와 같다. 이 경계는 기획 결정 3 으로 확정됐다(스레드 판이 열려
  // 있어도 본류 알림은 숨긴다). 바꾸려면 이 줄과 `decideForeground` 가 함께 바뀐다.
  it('스레드 판이 열려 있어도 같은 채널 본류의 알림은 숨긴다 (결정 3 — 서버 presence 와 같은 단위)', () => {
    expect(
      decideForeground(relayPayload({channelId: DESIGN}), VIEWING_DESIGN_THREAD),
    ).toEqual({show: false, why: 'viewing'});
  });

  // 기획 결정 1 (#2592 권고안 A): 승인 요청은 행동이 필요한 알림이라 같은 방을 보고 있어도 배너로 보인다.
  // 승인 카테고리는 둘이다 — 잠금 화면에서 결정하는 `momo.approval` 과 앱에서 열어 결정하는
  // `momo.approval.open`. 하나만 빼면 그쪽 승인이 보고 있는 방에서 소리 없이 묻힌다.
  describe('승인 요청은 같은 방을 보고 있어도 보인다 (행동이 필요한 알림)', () => {
    const APPROVAL_CATEGORIES = ['momo.approval', 'momo.approval.open'];
    const approvalIn = (category: string, over: Partial<PayloadOver> = {}) =>
      relayPayload({
        channelId: DESIGN,
        category,
        reason: 'approval_request',
        approvalId: APPROVAL_ID,
        ...over,
      });

    it.each(APPROVAL_CATEGORIES)('같은 방 본류를 보는 중에도 보인다 — %s', category => {
      expect(decideForeground(approvalIn(category), VIEWING_DESIGN)).toEqual({
        show: true,
        why: 'approval',
      });
    });

    it.each(APPROVAL_CATEGORIES)('같은 스레드가 열려 있어도 보인다 — %s', category => {
      expect(
        decideForeground(
          approvalIn(category, {threadId: ROOT_ID}),
          VIEWING_DESIGN_THREAD,
        ),
      ).toEqual({show: true, why: 'approval'});
    });

    // 예외가 승인에만 걸려 있다: 같은 방의 멘션·DM·작업 알림은 그대로 숨는다.
    it.each([
      ['momo.message', 'dm'],
      ['momo.mention', 'mention'],
      ['momo.work', 'work_session_idle'],
    ])('대조: 같은 방의 승인 아닌 알림은 숨는다 — %s', (category, reason) => {
      expect(
        decideForeground(
          relayPayload({channelId: DESIGN, category, reason}),
          VIEWING_DESIGN,
        ),
      ).toEqual({show: false, why: 'viewing'});
    });

    // 승인 여부는 `reason` 문자열이 아니라 **승인 id** 로 가린다. 서버 계약에서는 둘이 늘 함께 가지만, 파서는 둘을 따로
    // 받아들이므로 어느 쪽이 판별자인지가 이 시험이 못박는 선택이다.
    it('reason 이 승인이 아니어도 승인 id 가 있으면 승인이다', () => {
      expect(
        decideForeground(approvalIn('momo.approval', {reason: 'mention'}), VIEWING_DESIGN),
      ).toEqual({show: true, why: 'approval'});
    });

    it('reason 이 승인이어도 승인 id 가 없으면(승인 카테고리가 아니면) 승인이 아니다', () => {
      expect(
        decideForeground(
          relayPayload({channelId: DESIGN, category: 'momo.message', reason: 'approval_request'}),
          VIEWING_DESIGN,
        ),
      ).toEqual({show: false, why: 'viewing'});
    });

    // 예외는 숨길 뻔한 경우에만 이유를 바꾼다: 어차피 보였을 승인은 원래 이유로 보인다(로그가 흐려지지 않는다).
    it('다른 방의 승인·앞에 아무것도 없을 때의 승인은 원래 이유로 보인다', () => {
      expect(
        decideForeground(approvalIn('momo.approval', {channelId: NOTICE}), VIEWING_DESIGN),
      ).toEqual({show: true, why: 'other-conversation'});
      expect(decideForeground(approvalIn('momo.approval'), null)).toEqual({
        show: true,
        why: 'not-viewing',
      });
    });
  });
});

describe('결정: 봉투를 못 읽으면 보인다 — 숨기는 쪽으로 실패하지 않는다', () => {
  const ok = relayPayload({channelId: DESIGN});
  const without = (patch: (copy: ReturnType<typeof relayPayload>) => void) => {
    const copy = JSON.parse(JSON.stringify(ok)) as ReturnType<typeof relayPayload>;
    patch(copy);
    return copy;
  };

  const UNREADABLE: [string, unknown][] = [
    ['undefined', undefined],
    ['null', null],
    ['문자열', 'momo'],
    ['빈 객체', {}],
    ['momo 키 없음', {aps: ok.aps}],
    ['aps 키 없음', {momo: ok.momo}],
    ['스키마가 다름(다른 서버)', without(c => ((c.momo as {schema: string}).schema = 'momo.push.notification.v9'))],
    ['channel_id 가 UUID 가 아님', without(c => ((c.momo as {channel_id: string}).channel_id = DESIGN.slice(1)))],
    ['workspace_id 없음', without(c => delete (c.momo as {workspace_id?: string}).workspace_id)],
    ['aps.thread-id 없음', without(c => delete (c.aps as {'thread-id'?: string})['thread-id'])],
    ['모르는 reason(새 서버, 옛 앱)', without(c => ((c.momo as {reason: string}).reason = 'something_new'))],
    ['모르는 category', without(c => ((c.aps as {category: string}).category = 'momo.new'))],
    ['badge 가 숫자가 아님', without(c => ((c.aps as {badge: unknown}).badge = '4'))],
    ['승인 category 인데 approval_id 없음', without(c => ((c.aps as {category: string}).category = 'momo.approval'))],
  ];

  it.each(UNREADABLE)('같은 방을 보는 중에도 보인다 — %s', (_label, payload) => {
    expect(decideForeground(payload, VIEWING_DESIGN)).toEqual({
      show: true,
      why: 'unreadable',
    });
  });

  it('대조: 고장 낸 곳 없는 같은 페이로드는 숨는다 — 위 열네 개가 헛돌지 않는다', () => {
    expect(decideForeground(ok, VIEWING_DESIGN)).toEqual({show: false, why: 'viewing'});
  });
});

// =============================================================================
// 2. 처리기 — expo 에 건네는 답과, 던지지 않는다는 것
// =============================================================================

describe('처리기: expo-notifications 에 건네는 것', () => {
  it('설치하면 setNotificationHandler 를 한 번 부르고, 거두면 null 로 비운다', () => {
    const stop = installForegroundNotificationHandler();
    expect(setHandler).toHaveBeenCalledTimes(1);
    expect(typeof registeredHandler().handleNotification).toBe('function');
    stop();
    expect(setHandler).toHaveBeenCalledTimes(2);
    expect(setHandler).toHaveBeenLastCalledWith(null);
  });

  it('다른 채널을 보는 중 DM 은 배너 + 목록 + 소리로 답한다 — 배지는 건드리지 않는다', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    const behavior = await present(relayPayload({channelId: NOTICE}));
    // 정확히 이 네 칸이다. `shouldShowAlert`(폐기됨, 쓰면 경고)가 끼어 있지도 않다.
    expect(behavior).toStrictEqual(SHOWN);
  });

  it('같은 채널을 보는 중에는 아무것도 하지 않는다 — 배너도 목록도 소리도 배지도', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    expect(await present(relayPayload({channelId: DESIGN}))).toStrictEqual(HIDDEN);
  });

  it('같은 채널을 보는 중에도 승인 요청은 배너 + 목록 + 소리로 답한다 — 행동이 필요한 알림', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    for (const category of ['momo.approval', 'momo.approval.open']) {
      const approval = relayPayload({
        channelId: DESIGN,
        category,
        reason: 'approval_request',
        approvalId: APPROVAL_ID,
      });
      expect(await present(approval)).toStrictEqual(SHOWN);
    }
    // 같은 방의 일반 메시지는 그 옆에서 여전히 숨는다.
    expect(await present(relayPayload({channelId: DESIGN}))).toStrictEqual(HIDDEN);
  });

  it('같은 스레드가 열려 있을 때만 그 스레드의 답글을 숨긴다', async () => {
    installForegroundNotificationHandler();
    const reply = relayPayload({channelId: DESIGN, threadId: ROOT_ID});
    publishViewedConversation(VIEWING_DESIGN);
    expect(await present(reply)).toStrictEqual(SHOWN);
    publishViewedConversation(VIEWING_DESIGN_THREAD);
    expect(await present(reply)).toStrictEqual(HIDDEN);
  });

  it('앱이 앞이 아니면(배경·inactive) 화면이 마운트된 채여도 「보는 대화 없음」이다', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    const push = relayPayload({channelId: DESIGN});
    expect(await present(push)).toStrictEqual(HIDDEN);

    appStatus = 'background';
    expect(await present(push)).toStrictEqual(SHOWN);
    appStatus = 'inactive';
    expect(await present(push)).toStrictEqual(SHOWN);
    appStatus = 'active';
    expect(await present(push)).toStrictEqual(HIDDEN);
  });

  it('봉투를 못 읽으면 같은 방을 보는 중에도 보인다', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    const unknown = relayPayload({channelId: DESIGN, reason: 'something_new'});
    expect(await present(unknown)).toStrictEqual(SHOWN);
  });

  it('원격 푸시는 trigger.payload 만 읽는다 — 본문이 싣고 온 origin 으로는 숨겨지지 않는다', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    // 다른 방의 원격 푸시가 `data.origin` 에 **보고 있는 방**의 봉투를 실어 보냈다.
    const forged = {
      date: BASE_MS,
      request: {
        identifier: 'collapse-1',
        content: {
          title: null,
          subtitle: null,
          body: null,
          sound: 'default',
          data: {origin: relayPayload({channelId: DESIGN})},
        },
        trigger: {type: 'push', payload: relayPayload({channelId: NOTICE})},
      },
    } as unknown as Notifications.Notification;
    expect(await registeredHandler().handleNotification(forged)).toStrictEqual(SHOWN);
  });

  it('잠금 화면 승인의 결과 줄(트리거 없음)은 origin 의 봉투로 같은 규칙을 탄다', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    const handler = registeredHandler();
    expect(
      await handler.handleNotification(localResultLine(relayPayload({channelId: DESIGN}))),
    ).toStrictEqual(HIDDEN);
    expect(
      await handler.handleNotification(localResultLine(relayPayload({channelId: NOTICE}))),
    ).toStrictEqual(SHOWN);
    // 원문이 없는 결과 줄은 읽을 수 없으니 보인다.
    expect(await handler.handleNotification(localResultLine(undefined))).toStrictEqual(SHOWN);
  });

  // 결과 줄은 실제로는 승인 알림에서만 나온다(네이티브 처리기가 잠금 화면 승인 뒤에 올린다). 그래서 origin 은
  // 늘 승인 봉투이고, 결정 1(승인은 행동이 필요한 알림)이 그대로 걸린다: 같은 방을 보고 있어도 보인다.
  it('결과 줄의 origin 이 승인 봉투면 같은 방을 보고 있어도 보인다 (결정 1)', async () => {
    installForegroundNotificationHandler();
    publishViewedConversation(VIEWING_DESIGN);
    for (const category of ['momo.approval', 'momo.approval.open']) {
      const origin = relayPayload({
        channelId: DESIGN,
        category,
        reason: 'approval_request',
        approvalId: APPROVAL_ID,
      });
      expect(
        await registeredHandler().handleNotification(localResultLine(origin)),
      ).toStrictEqual(SHOWN);
    }
  });

  describe('던지지도 기다리지도 않는다 — 던지면 expo 가 그 알림을 버린다', () => {
    it('요청 자체가 깨진 알림에도 거부하지 않고 「보임」으로 답한다', async () => {
      installForegroundNotificationHandler();
      publishViewedConversation(VIEWING_DESIGN);
      const broken = {} as unknown as Notifications.Notification;
      await expect(registeredHandler().handleNotification(broken)).resolves.toStrictEqual(SHOWN);
    });

    it('화면 상태를 읽다 터져도 「보임」으로 답한다', async () => {
      installForegroundNotificationHandler();
      publishViewedConversation(VIEWING_DESIGN);
      Object.defineProperty(AppState, 'currentState', {
        configurable: true,
        get: () => {
          throw new Error('native bridge went away');
        },
      });
      await expect(
        present(relayPayload({channelId: DESIGN})),
      ).resolves.toStrictEqual(SHOWN);
    });

    it('presentForeground 는 동기로 결정한다 — 처리기 안에 기다리는 일이 없다', async () => {
      publishViewedConversation(VIEWING_DESIGN);
      // 이미 이행된 프라미스와 같은 틱에 끝난다: 마이크로태스크 한 번이면 답이 나와 있다.
      let answer: unknown = 'pending';
      void presentForeground(remoteNotification(relayPayload({channelId: DESIGN}))).then(
        value => (answer = value),
      );
      await Promise.resolve();
      expect(answer).toStrictEqual(HIDDEN);
    });
  });

  it('결과를 한 줄로 남긴다 — 기기 확인이 `[push]` 로 grep 한다. 아이디·본문은 적지 않는다', async () => {
    installForegroundNotificationHandler();
    const log = jest.mocked(console.log);
    await present(relayPayload({channelId: NOTICE}));
    publishViewedConversation(VIEWING_DESIGN);
    await present(relayPayload({channelId: DESIGN}));
    await present(
      relayPayload({
        channelId: DESIGN,
        category: 'momo.approval',
        reason: 'approval_request',
        approvalId: APPROVAL_ID,
      }),
    );
    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines).toContain('[push] foreground notification -> shown (not-viewing)');
    expect(lines).toContain('[push] foreground notification -> hidden (viewing)');
    expect(lines).toContain('[push] foreground notification -> shown (approval)');
    for (const line of lines) {
      expect(line).not.toContain(DESIGN);
      expect(line).not.toContain(WS);
    }
  });

  it('handleError 는 던지지 않고 메시지만 남긴다 — 오류 자리에 무엇이 와도', () => {
    installForegroundNotificationHandler();
    const warn = jest.mocked(console.warn);
    const {handleError} = registeredHandler();
    expect(() => handleError?.('collapse-1', new Error('timed out'))).not.toThrow();
    expect(() => handleError?.('collapse-1', undefined as unknown as Error)).not.toThrow();
    expect(() => handleError?.('collapse-1', 'boom' as unknown as Error)).not.toThrow();
    const lines = warn.mock.calls.map(call => String(call[0]));
    expect(lines).toContain('[push] foreground notification was not presented: timed out');
    expect(lines).toContain('[push] foreground notification was not presented: boom');
  });

  it('설치가 터져도 앱 시작을 막지 않는다', () => {
    setHandler.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let stop: (() => void) | undefined;
    expect(() => {
      stop = installForegroundNotificationHandler();
    }).not.toThrow();
    expect(() => stop?.()).not.toThrow();
  });
});

// =============================================================================
// 3. 올려 두는 값 — 「지금 보는 대화」의 저장소
// =============================================================================

describe('보는 대화를 올리고 내린다', () => {
  it('아무것도 올라가 있지 않으면 null', () => {
    expect(viewedConversation()).toBeNull();
  });

  it('올린 값을 그대로 돌려준다', () => {
    publishViewedConversation(VIEWING_DESIGN_THREAD);
    expect(viewedConversation()).toEqual(VIEWING_DESIGN_THREAD);
  });

  it('자기 것이 올라가 있을 때만 내린다 — 늦게 온 앞 화면의 cleanup 이 지금 방을 지우지 않는다', () => {
    const releaseOld = publishViewedConversation(VIEWING_DESIGN);
    const releaseNew = publishViewedConversation({
      workspaceId: WS,
      channelId: NOTICE,
      threadRootId: null,
    });
    releaseOld();
    expect(viewedConversation()?.channelId).toBe(NOTICE);
    releaseNew();
    expect(viewedConversation()).toBeNull();
  });

  describe('훅', () => {
    function mount(args: {ws: string; ch: string; thread: string | null}) {
      return renderHook(
        (props: {ws: string; ch: string; thread: string | null}) =>
          useReportViewedConversation(props.ws, props.ch, props.thread),
        {initialProps: args},
      );
    }

    it('마운트하면 올리고, 스레드·채널이 바뀌면 따라가고, 언마운트하면 내린다', () => {
      const view = mount({ws: WS, ch: DESIGN, thread: null});
      expect(viewedConversation()).toEqual(VIEWING_DESIGN);
      view.rerender({ws: WS, ch: DESIGN, thread: ROOT_ID});
      expect(viewedConversation()).toEqual(VIEWING_DESIGN_THREAD);
      view.rerender({ws: WS, ch: NOTICE, thread: null});
      expect(viewedConversation()).toEqual({
        workspaceId: WS,
        channelId: NOTICE,
        threadRootId: null,
      });
      view.unmount();
      expect(viewedConversation()).toBeNull();
    });

    it.each([
      ['워크스페이스', {ws: '', ch: DESIGN}],
      ['채널', {ws: WS, ch: ''}],
    ])('%s id 가 비어 있으면(어느 방인지 모르면) 올리지 않는다', (_label, ids) => {
      mount({...ids, thread: null});
      expect(viewedConversation()).toBeNull();
    });
  });
});

// =============================================================================
// 4. 앱 시작 경로 — 처리기는 앱 어디에서도 한 번만 걸린다
// =============================================================================

// 처리기는 `index.js` 의 모듈 평가 시점, `AppRegistry.registerComponent` 보다 앞에서 걸린다(기획 결정 6:
// 시작 직후에 온 푸시가 사라지는 틈을 줄이려고 `App.tsx` 의 시작 effect 에서 옮겼다). 세 가지를 잰다:
//   1. 실제로 `index.js` 를 평가해 본다 — 한 번 걸리고, 루트를 등록하기 **전**이다.
//   2. 호출 자리를 소스에서 센다 — `index.js` 하나, `App.tsx` 에는 없다.
//   3. 앱 트리를 그려도 처리기를 다시 걸지 않는다(두 번째 호출은 첫 처리기를 조용히 갈아 끼운다).

describe('시작 경로 — 처리기는 index.js 에서, 루트를 등록하기 전에 한 번만 걸린다', () => {
  beforeEach(() => {
    __resetSessionStore();
    __resetServerBaseCache();
  });

  afterEach(() => {
    cleanup();
  });

  const APP_ROOT = path.resolve(__dirname, '..');
  const codeOnly = (source: string) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('index.js 를 평가하는 그 순간에 처리기가 한 번 걸리고, 그것은 루트 등록보다 앞이다', () => {
    let handlerCalls = -1;
    let registerCalls = -1;
    let handlerOrder = 0;
    let registerOrder = Number.POSITIVE_INFINITY;
    jest.isolateModules(() => {
      // 격리된 모듈 레지스트리: index.js 와 이 시험이 같은 `react-native`·`expo-notifications` 를 본다.
      const {AppRegistry} = require('react-native');
      const notifications = require('expo-notifications');
      const register = jest
        .spyOn(AppRegistry, 'registerComponent')
        .mockImplementation(() => 'MomoMobile');
      const handler = notifications.setNotificationHandler as jest.Mock;
      handler.mockClear();
      require('../index');
      handlerCalls = handler.mock.calls.length;
      registerCalls = register.mock.calls.length;
      handlerOrder = handler.mock.invocationCallOrder[0] ?? 0;
      registerOrder = register.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    });
    expect(handlerCalls).toBe(1);
    expect(registerCalls).toBe(1);
    expect(handlerOrder).toBeGreaterThan(0);
    expect(handlerOrder).toBeLessThan(registerOrder);
  });

  it('index.js 소스에서도 호출이 두 boot import 뒤, registerComponent 앞에 있다', () => {
    const source = codeOnly(fs.readFileSync(path.join(APP_ROOT, 'index.js'), 'utf8'));
    const at = (needle: string) => {
      const index = source.indexOf(needle);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const install = at('installForegroundNotificationHandler();');
    expect(install).toBeGreaterThan(at("'./src/boot/polyfills'"));
    expect(install).toBeGreaterThan(at("'./src/boot/coreHost'"));
    expect(install).toBeLessThan(at('AppRegistry.registerComponent('));
  });

  // `setNotificationHandler` 는 부를 때마다 앞의 처리기를 갈아 끼운다. 이 앱 소스에 호출 자리가 둘이
  // 되면 나중 것이 이긴다 — 이 파일의 규칙이 조용히 꺼질 수 있어서, 호출 자리를 소스에서 센다.
  it('처리기를 거는 곳은 앱 소스 전체에서 index.js 한 곳이다 (App.tsx·PushProvider 는 걸지 않는다)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (['node_modules', 'Pods', 'build', '__tests__', 'ios', 'android'].includes(entry.name)) {
          continue;
        }
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        // `jest.setup.js` 는 expo-notifications 목을 만드는 시험 인프라라 앱 소스가 아니다.
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && entry.name !== 'jest.setup.js') {
          files.push(full);
        }
      }
    };
    walk(APP_ROOT);
    const callers = (pattern: RegExp) =>
      files
        .filter(file => pattern.test(codeOnly(fs.readFileSync(file, 'utf8'))))
        .map(file => path.relative(APP_ROOT, file));
    // 전달 함수 호출은 index.js 하나(정의 자체는 세지 않는다).
    expect(callers(/(?<!function\s)\binstallForegroundNotificationHandler\s*\(/)).toEqual([
      'index.js',
    ]);
    // expo 의 `setNotificationHandler` 를 **언급하는** 파일은 하나다. 호출만이 아니라 식별자 자체를 세므로
    // `import {setNotificationHandler as x}` 같은 별칭이나 `Notifications.setNotificationHandler(…)` 도 잡힌다.
    expect(callers(/\bsetNotificationHandler\b/)).toEqual([
      path.join('src', 'push', 'foregroundPresentation.ts'),
    ]);
  });

  it('앱 트리를 그려도 처리기를 다시 걸지 않는다 — 걸 자리는 index.js 하나다', async () => {
    const view = render(<App />);
    await act(async () => {});
    expect(setHandler).not.toHaveBeenCalled();
    view.unmount();
    expect(setHandler).not.toHaveBeenCalled();
  });
});

// =============================================================================
// 5. 실제 화면 — 진짜 대화 화면이 올린 값을 처리기가 읽는다
// =============================================================================

const SELF: Member = {
  id: SELF_ID,
  workspaceId: WS,
  kind: 'human',
  displayName: '이도현',
  handle: 'dohyun',
};

const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: SELF,
};

function rosterMember(over: Record<string, unknown>) {
  return {
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

const ROSTER = [
  rosterMember({id: SELF_ID, displayName: '이도현', handle: 'dohyun'}),
  rosterMember({id: SEOYEON_ID, displayName: '박서연', handle: 'seoyeon', channelIds: [DESIGN]}),
];

const CHANNELS = [
  {id: DESIGN, workspaceId: WS, kind: 'public', name: '디자인', muted: false},
  {id: NOTICE, workspaceId: WS, kind: 'public', name: '공지', muted: false},
];

function restMessage(seq: number, over: Record<string, unknown> = {}) {
  return {
    id: `msg-${seq}`,
    channelId: DESIGN,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: SEOYEON_ID,
    type: 'text',
    body: `시안 ${seq}번 공유드려요`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

/** 답글이 달린 루트 하나와 평범한 메시지 몇 개. `thread` 는 서버가 페이지에 싣는 롤업이다. */
const HISTORY = [
  restMessage(1),
  restMessage(2),
  restMessage(3, {
    id: ROOT_ID,
    body: '시안 3번에 의견 주세요',
    thread: {reply_count: 2, last_reply_seq: 5, last_reply_at: BASE_MS + 5000},
  }),
];

const REPLIES = [
  restMessage(4, {id: 'reply-4', rootId: ROOT_ID, body: '저는 첫 번째가 좋아요'}),
  restMessage(5, {id: 'reply-5', rootId: ROOT_ID, body: '저도요'}),
];

function installFetch(): jest.Mock {
  const mock = jest.fn(async (url: string) => {
    if (url.includes('/viewing')) return jsonResponse(200, {});
    if (url.includes('/replies')) return jsonResponse(200, {messages: REPLIES});
    if (url.includes('/reactions')) return jsonResponse(200, {});
    if (url.includes('/messages')) return jsonResponse(200, {messages: HISTORY});
    if (url.includes('/channels') && !url.includes('/messages')) {
      return jsonResponse(200, {channels: CHANNELS});
    }
    if (url.includes('/roster')) return jsonResponse(200, {members: ROSTER});
    if (url.includes('/read-state')) return jsonResponse(200, {read_states: []});
    if (url.includes('/work-sessions')) return jsonResponse(200, {workSessions: []});
    if (url.includes('/work-hosts')) return jsonResponse(200, {workHosts: []});
    if (url.includes('/profile')) {
      return jsonResponse(403, {error: {message: 'agent owner required'}});
    }
    if (url.includes('/allowed-models')) {
      return jsonResponse(200, {allowedAgentModels: []});
    }
    if (url.includes('/inbox') || url.includes('/approvals')) {
      return jsonResponse(200, {mentions: [], approvals: [], items: []});
    }
    throw new Error(`unrouted request: ${url}`);
  });
  globalThis.fetch = mock as unknown as typeof fetch;
  return mock;
}

jest.setTimeout(SHELL_WAIT_TEST_TIMEOUT_MS);

describe('실제 화면: 진짜 AppShell 의 대화 화면이 올린 값을 처리기가 읽는다', () => {
  let queryClient: QueryClient | null = null;

  beforeEach(() => {
    installAppClock();
    resetSession();
    setServerBase(BASE);
    sessionPort.applyLogin(LOGIN_BODY);
    installFetch();
  });

  afterEach(() => {
    cleanup();
    queryClient?.clear();
    queryClient = null;
    jest.useRealTimers();
  });

  async function openDesignChannel() {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: {retry: false, gcTime: 0},
        mutations: {retry: false, gcTime: 0},
      },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <AppShell member={SELF} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    // 아직 어느 대화도 열지 않았다.
    expect(viewedConversation()).toBeNull();
    fireEvent.press(screen.getByTestId(`sidebar-row-channel:${DESIGN}`));
    await waitFor(() => expect(screen.getByTestId('timeline-list')).toBeTruthy());
    await waitFor(() =>
      expect(screen.getAllByTestId('message-row').length).toBeGreaterThan(0),
    );
  }

  it('채널을 열면 그 방의 알림만 숨고, 뒤로 가면 다시 보인다 — 다른 방 DM 은 늘 보인다', async () => {
    installForegroundNotificationHandler();
    await openDesignChannel();

    expect(viewedConversation()).toEqual(VIEWING_DESIGN);
    expect(await present(relayPayload({channelId: DESIGN}))).toStrictEqual(HIDDEN);
    expect(await present(relayPayload({channelId: NOTICE}))).toStrictEqual(SHOWN);
    // 열려 있는 방이어도 승인 요청은 보인다(행동이 필요한 알림).
    expect(
      await present(
        relayPayload({
          channelId: DESIGN,
          category: 'momo.approval',
          reason: 'approval_request',
          approvalId: APPROVAL_ID,
        }),
      ),
    ).toStrictEqual(SHOWN);

    // 대화 목록으로 돌아왔다: 더는 보는 대화가 없다.
    fireEvent.press(screen.getByTestId('header-back'));
    await waitFor(() => expect(screen.getByTestId('sidebar-list')).toBeTruthy());
    expect(viewedConversation()).toBeNull();
    expect(await present(relayPayload({channelId: DESIGN}))).toStrictEqual(SHOWN);
  });

  it('스레드를 열면 그 스레드의 답글이 숨고, 닫으면 다시 보인다', async () => {
    installForegroundNotificationHandler();
    await openDesignChannel();

    const reply = relayPayload({channelId: DESIGN, threadId: ROOT_ID});
    // 채널 본류만 보는 중에는 스레드 답글이 보인다(스레드가 열려 있지 않다).
    expect(await present(reply)).toStrictEqual(SHOWN);

    fireEvent.press(screen.getByTestId('thread-rollup'));
    await waitFor(() => expect(screen.getByTestId('thread-title')).toBeTruthy());
    expect(viewedConversation()).toEqual(VIEWING_DESIGN_THREAD);
    expect(await present(reply)).toStrictEqual(HIDDEN);
    // 열려 있지 않은 다른 스레드의 답글은 보인다.
    expect(
      await present(relayPayload({channelId: DESIGN, threadId: OTHER_ROOT_ID})),
    ).toStrictEqual(SHOWN);

    fireEvent.press(screen.getByLabelText('스레드 닫기'));
    await waitFor(() => expect(screen.queryByTestId('thread-title')).toBeNull());
    expect(viewedConversation()).toEqual(VIEWING_DESIGN);
    expect(await present(reply)).toStrictEqual(SHOWN);
  });

  it('앱이 배경으로 가면 화면이 열려 있어도 같은 방의 알림이 보이고, 돌아오면 다시 숨는다', async () => {
    installForegroundNotificationHandler();
    await openDesignChannel();
    const push = relayPayload({channelId: DESIGN});

    expect(await present(push)).toStrictEqual(HIDDEN);
    appStatus = 'background';
    expect(await present(push)).toStrictEqual(SHOWN);
    appStatus = 'active';
    expect(await present(push)).toStrictEqual(HIDDEN);
  });
});
