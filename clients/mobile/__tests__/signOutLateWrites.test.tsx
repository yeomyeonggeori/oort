import {sendMessage, type Message} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, renderHook, screen} from '@testing-library/react-native';
import React from 'react';
import {makeDirectory} from '@momo/core/features/workspace/directory';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {Composer} from '../src/features/conversation/Composer';
import {channelDraftKey, readDraft} from '../src/features/conversation/drafts';
import {readFailedSends} from '../src/features/conversation/failedSends';
import {EMPTY_DRAFT, readDraft as readDelegateDraft, writeDraft as writeDelegateDraft} from '../src/features/work/delegate/session';
import {useTimeline} from '../src/features/conversation/useTimeline';
import type {ChannelRail} from '../src/realtime/channelRail';
import {SessionProvider, useSession} from '../src/session/useSession';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetSessionStore, clearSession, keychainSettled, sessionPort} from '../src/storage/secureSession';
import {__resetServerBaseCache, setServerBase} from '../src/storage/serverBase';

// =============================================================================
// #5799 — 로그아웃 뒤에 이 폰에 쓰다 만 글·보내지 못한 글이 다시 남지 않는다 (웹 `signOutDrafts.browser.test.ts`의 짝).
//
// 로그아웃은 초안과 보내지 못한 글을 지운다(`useSession.tsx` signOut). 그런데 세션 트리는 그 **뒤에** 내려간다. 내려가는 대화는 결과를
// 모르는 전송을 「못 보낸 글」로 남기고(`useTimeline` 정리 함수), 그 요청이 더 늦게 실패하면 또 남긴다. 그 둘이 지운 자리를 되살리면
// 다음 사람이 같은 폰에서 앞 사람의 글을 갖게 된다.
//
//   (1) 입력창: 폰은 키를 누를 때만 초안을 적는다(내려갈 때 적지 않는다) — 로그아웃 뒤 내려가도 0건. 지금 이미 지켜지는 것을 잠근다.
//   (2) 날아가던 전송: 로그아웃 → 대화가 내려감 → 요청이 늦게 실패 — 그래도 0건. 다음 로그인(새 세션 provider)은 다시 남긴다.
//   (3) 다른 사람이 들어온 뒤에 앞 사람의 요청이 끝나도 그 글은 남지 않는다. 같은 사람이 다시 들어왔으면 평소처럼 남는다.
//   (4) 토큰 만료로 나간 뒤: 같은 사람이 다시 들어오면 쓰던 글이 그대로, 다른 사람이 들어오면 입력창이 비고 이 폰에서도 지워진다.
//   (5) 「작업 맡기기」 시트의 글(메모리)도 로그아웃이 지운다.
// 사보타주: `failedSends.ts`의 `writeMap` 첫 줄(닫힌 동안 쓰지 않는다)을 지우면 (2)가 붉고, `useSession.tsx`의 다시 여는 효과를
// 지우면 (2)의 마지막 단정이 붉다. 작성자 확인을 걷으면 (3), 초안의 작성자 거르기·지우기를 걷으면 (4), 시트 지우기를 걷으면 (5)가 붉다.
// =============================================================================

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
  fetchMessages: jest.fn(async () => ({messages: [], nextBefore: undefined})),
  fetchReactionSnapshot: jest.fn(async () => ({})),
  fetchChannelPins: jest.fn(async () => []),
}));

const WS = '22222222-2222-4222-8222-222222222222';
const CH = '44444444-4444-4444-8444-444444444444';
const ME = '11111111-1111-4111-8111-111111111111';
const SEOYEON = '33333333-3333-4333-8333-333333333333';
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {id: ME, workspaceId: WS, kind: 'human' as const, displayName: '김도현', handle: 'dohyeon'},
};
const LOGIN_SEOYEON = {
  ...LOGIN_BODY,
  accessToken: 'access-token-2',
  refreshToken: 'refresh-token-2',
  member: {id: SEOYEON, workspaceId: WS, kind: 'human' as const, displayName: '이서연', handle: 'seoyeon'},
};

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

const rail = {subscribeChannel: jest.fn(() => () => undefined)} as unknown as ChannelRail;
const send = jest.mocked(sendMessage);
const realFetch = globalThis.fetch;
let store = memoryStore();

beforeEach(async () => {
  store = memoryStore();
  __setNonSecretStore(store);
  __resetSessionStore();
  __resetServerBaseCache();
  setServerBase('https://api.example.com');
  sessionPort.applyLogin(LOGIN_BODY);
  await keychainSettled();
  globalThis.fetch = jest.fn(async () =>
    new Response(JSON.stringify({status: 'ok'}), {status: 200, headers: {'Content-Type': 'application/json'}}),
  ) as unknown as typeof fetch;
  send.mockReset();
});

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  __setNonSecretStore(null);
});

/** 앱이 실제로 쓰는 세션 provider 를 세우고 그 `signOut` 을 꺼낸다. `unmount` 는 로그아웃 뒤 세션 트리가 내려가는 자리다. */
function sessionTree(
  member: typeof LOGIN_BODY.member = LOGIN_BODY.member,
  children?: React.ReactNode,
): {signOut: () => void; unmount: () => void} {
  let captured: (() => void) | null = null;
  function Probe(): React.JSX.Element | null {
    captured = useSession().signOut;
    return null;
  }
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider member={member as never}>
        <Probe />
        {children}
      </SessionProvider>
    </QueryClientProvider>,
  );
  if (captured === null) throw new Error('signOut 을 잡지 못했다');
  return {signOut: captured, unmount: view.unmount};
}

describe('#5799 로그아웃 뒤 이 폰에 글이 다시 남지 않는다', () => {
  it('입력창: 쓰던 글은 로그아웃이 지우고, 입력창이 그 뒤에 내려가도 다시 적지 않는다', () => {
    const key = channelDraftKey(CH);
    const session = sessionTree();
    const input = render(
      <Composer recipient="place" channelLabel="배포" directory={makeDirectory([])} onSend={() => {}} draftKey={key} />,
    );
    fireEvent.changeText(screen.getByTestId('composer-input'), '쓰다 만 초안');
    expect(readDraft(key)).toBe('쓰다 만 초안'); // 대조: 로그아웃 전에는 있다

    act(() => session.signOut());
    input.unmount();
    session.unmount();

    expect(store.map.has(NON_SECRET_KEYS.composerDrafts)).toBe(false);
  });

  it('날아가던 전송: 로그아웃 뒤 대화가 내려가고 요청이 늦게 실패해도 0건, 다음 세션은 다시 남긴다', async () => {
    let fail: (error: unknown) => void = () => undefined;
    send.mockImplementationOnce(() => new Promise<Message>((_ok, reject) => { fail = reject; }));
    const session = sessionTree();
    const timeline = renderHook(() => useTimeline(rail, WS, CH, ME));
    await act(async () => {
      void timeline.result.current.send('날아가는 글');
    });
    expect(timeline.result.current.pending.map(p => p.status)).toEqual(['sending']);

    act(() => session.signOut());
    timeline.unmount(); // 세션 트리가 내려간다: 결과를 모르는 글을 남기려 한다
    session.unmount();
    expect(store.map.has(NON_SECRET_KEYS.failedSends)).toBe(false);

    await act(async () => {
      fail(new NetworkError('unreachable', 15_000)); // 더 늦게 실패한다
    });
    expect(store.map.has(NON_SECRET_KEYS.failedSends)).toBe(false);

    // 다음 사람이 들어오면(새 세션 provider) 보내지 못한 글을 다시 이 기기에 남긴다 — 닫힌 채로 남지 않는다.
    let failNext: (error: unknown) => void = () => undefined;
    send.mockImplementationOnce(() => new Promise<Message>((_ok, reject) => { failNext = reject; }));
    sessionPort.applyLogin(LOGIN_BODY);
    sessionTree();
    const next = renderHook(() => useTimeline(rail, WS, CH, ME));
    await act(async () => {
      void next.result.current.send('다음 사람의 글');
    });
    await act(async () => {
      failNext(new NetworkError('unreachable', 15_000));
    });
    expect(readFailedSends(WS, CH, ME).map(r => r.row.body)).toEqual(['다음 사람의 글']);
  });
  /** 보내던 글을 둔 채 로그아웃하고, `next`가 들어온 뒤에 그 요청이 실패한다. 저장소에 남은 본문들을 돌려준다. */
  async function lateFailureAfterSignIn(next: typeof LOGIN_BODY): Promise<string[]> {
    let fail: (error: unknown) => void = () => undefined;
    send.mockImplementationOnce(() => new Promise<Message>((_ok, reject) => { fail = reject; }));
    const session = sessionTree();
    const timeline = renderHook(() => useTimeline(rail, WS, CH, ME));
    await act(async () => {
      void timeline.result.current.send('앞 사람의 글');
    });
    act(() => session.signOut());
    timeline.unmount();
    session.unmount();
    sessionPort.applyLogin(next);
    sessionTree(next.member);
    await act(async () => {
      fail(new NetworkError('unreachable', 15_000));
    });
    return readFailedSends(WS, CH, ME).map(r => r.row.body);
  }

  it('다른 사람이 들어온 뒤에 앞 사람의 요청이 실패해도 그 글은 이 폰에 남지 않는다', async () => {
    expect(await lateFailureAfterSignIn(LOGIN_SEOYEON)).toEqual([]);
    expect(store.map.get(NON_SECRET_KEYS.failedSends) ?? '').not.toContain('앞 사람의 글');
  });

  it('대조: 같은 사람이 다시 들어온 뒤에 실패하면 평소처럼 남는다', async () => {
    expect(await lateFailureAfterSignIn(LOGIN_BODY)).toEqual(['앞 사람의 글']);
  });

  /** 입력창에 쓰다가 토큰 만료로 나간다(로그아웃을 거치지 않는다). 그 뒤 `next`가 들어와 같은 대화의 입력창을 연다. */
  function composerAfterExpiry(next: typeof LOGIN_BODY): string {
    const key = channelDraftKey(CH);
    const session = sessionTree();
    const input = render(
      <Composer recipient="place" channelLabel="배포" directory={makeDirectory([])} onSend={() => {}} draftKey={key} />,
    );
    fireEvent.changeText(screen.getByTestId('composer-input'), '만료 전에 쓰던 글');
    act(() => clearSession()); // 만료: 세션이 끝나고 트리가 내려간다
    input.unmount();
    session.unmount();
    expect(store.map.get(NON_SECRET_KEYS.composerDrafts) ?? '').toContain('만료 전에 쓰던 글'); // 대조: 만료는 초안을 남긴다

    // 다음 세션: 입력창이 세션 provider 와 한 번에 선다(첫 렌더가 provider 의 효과보다 먼저 초안을 읽는다).
    sessionPort.applyLogin(next);
    sessionTree(
      next.member,
      <Composer recipient="place" channelLabel="배포" directory={makeDirectory([])} onSend={() => {}} draftKey={key} />,
    );
    return screen.getByTestId('composer-input').props.value as string;
  }

  it('토큰 만료 뒤 다른 사람이 들어오면 그 사람의 입력창은 비어 있고, 앞 사람의 글은 이 폰에서도 지워진다', () => {
    expect(composerAfterExpiry(LOGIN_SEOYEON)).toBe('');
    expect(store.map.get(NON_SECRET_KEYS.composerDrafts) ?? '').not.toContain('만료 전에 쓰던 글');
  });

  it('대조: 토큰 만료 뒤 같은 사람이 다시 들어오면 쓰던 글이 그대로 있다', () => {
    expect(composerAfterExpiry(LOGIN_BODY)).toBe('만료 전에 쓰던 글');
  });

  it('「작업 맡기기」 시트에 쓰던 글도 로그아웃이 지운다', () => {
    const session = sessionTree();
    writeDelegateDraft(WS, {title: '배포 점검', brief: '쓰다 만 설명', repo: '', branch: ''});
    expect(readDelegateDraft(WS).brief).toBe('쓰다 만 설명'); // 대조
    act(() => session.signOut());
    expect(readDelegateDraft(WS)).toEqual(EMPTY_DRAFT);
  });
});
