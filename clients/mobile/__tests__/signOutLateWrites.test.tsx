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
import {useTimeline} from '../src/features/conversation/useTimeline';
import type {ChannelRail} from '../src/realtime/channelRail';
import {SessionProvider, useSession} from '../src/session/useSession';
import {__setNonSecretStore, NON_SECRET_KEYS} from '../src/storage/kv';
import {__resetSessionStore, keychainSettled, sessionPort} from '../src/storage/secureSession';
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
// 사보타주: `failedSends.ts`의 `writeMap` 첫 줄(닫힌 동안 쓰지 않는다)을 지우면 (2)가 붉고, `useSession.tsx`의 다시 여는 효과를
// 지우면 (2)의 마지막 단정이 붉다.
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
const LOGIN_BODY = {
  accessToken: 'access-token-1',
  refreshToken: 'refresh-token-1',
  realtimeWebSocketUrl: 'wss://api.example.com/connection/websocket',
  member: {id: ME, workspaceId: WS, kind: 'human' as const, displayName: '김도현', handle: 'dohyeon'},
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
function sessionTree(): {signOut: () => void; unmount: () => void} {
  let captured: (() => void) | null = null;
  function Probe(): React.JSX.Element | null {
    captured = useSession().signOut;
    return null;
  }
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  const view = render(
    <QueryClientProvider client={client}>
      <SessionProvider member={LOGIN_BODY.member as never}>
        <Probe />
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
});
