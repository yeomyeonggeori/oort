import {reproposeDraft} from '@momo/core/features/approvals/expiry';
import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import {channelDraftKey, readDraft, saveDraft, threadDraftKey} from '../src/features/conversation/drafts';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';
import {__setNonSecretStore} from '../src/storage/kv';

// =============================================================================
// #5171. 요청의 묶음 카드는 **요청 메시지의 스레드**에 선다(요청 고리 §4). 폰의 스레드 화면은 자기 입력창을 갖고 채널 입력창은 그
// 화면 뒤에 있으므로, 거기서 누른 「다시 요청」은 **이 스레드의** 입력창에 초안을 넣어야 한다 — 눈에 안 보이는 입력창에 넣는
// 동작은 결과가 화면 밖에 떨어진다(`ThreadPanel` 의 `onQuote` 부재와 같은 이유). 카드·상태 표는 `requestBundleRepropose.test.tsx`
// 가 재고, 이 시험은 스레드 화면이 그 단추를 **자기 입력창에** 배선했는지만 잰다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
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
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: AGENT, displayName: '김인턴', handle: 'kim-intern', kind: 'agent', ownerHumanId: SELF}),
]);

const ROOT = {
  id: ROOT_ID,
  channelId: 'ch',
  seq: 10,
  hlcTs: 10,
  hlcCount: 0,
  authorMemberId: SELF,
  type: 'text',
  body: '@kim-intern 작업 세션을 끝내 줘',
  state: 'sent',
  createdAtMs: BASE_MS,
} as Message;

/** 만료된 도구 승인 카드가 요청 메시지의 스레드에 서 있다(서버가 쓰는 모양). */
const EXPIRED_CARD = {
  id: 'card-1',
  channelId: 'ch',
  rootId: ROOT_ID,
  seq: 11,
  hlcTs: 11,
  hlcCount: 0,
  authorMemberId: AGENT,
  type: 'approval_request',
  body: '승인 요청',
  state: 'sent',
  createdAtMs: BASE_MS + 1_000,
  props: {
    approval_id: 'ap-1',
    run_id: 'run-1',
    channel_id: 'ch',
    call_id: 'c1',
    tool_name: 'work.session.end',
    action_type: 'tool_call',
    title: '도구 「work.session.end」 실행',
    decision_mode: 'inline',
    approval_status: 'expired',
    status: 'expired',
    expires_at_ms: BASE_MS + 600_000,
  },
} as unknown as Message;

function memoryStore() {
  const map = new Map<string, string>();
  return {
    map,
    getString: (key: string) => map.get(key),
    set: (key: string, value: string) => void map.set(key, String(value)),
    remove: (key: string) => map.delete(key),
  };
}

beforeEach(() => {
  __setNonSecretStore(memoryStore());
});

afterEach(() => {
  cleanup();
  __setNonSecretStore(null);
});

/** `ThreadPanel` 이 실제로 읽는 만큼의 `useTimeline` (`threadPin.test.tsx` 와 같다). */
function renderThread() {
  const timeline = {
    state: {messages: [ROOT, EXPIRED_CARD], oldestSeq: ROOT.seq, newestSeq: EXPIRED_CARD.seq},
    status: 'ready',
    resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [],
    pending: [],
    send: async () => {},
    resend: async () => {},
    toggleReaction: async () => {},
    editBody: async () => {},
    removeMessage: async () => {},
    loadReplies: async () => {},
    sendReply: async () => {},
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
    pins: {},
    pinsStatus: 'ready',
    reloadPins: () => {},
    togglePin: async () => {},
  } as unknown as UseTimelineResult;
  render(
    <ThreadPanel
      root={ROOT}
      timeline={timeline}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 120_000}
      onClose={() => {}}
    />,
  );
}

describe('스레드 화면의 「다시 요청」은 이 스레드의 입력창에 초안을 넣는다 (#5171)', () => {
  it('누르면 스레드 입력창에 초안이 서고, 채널의 초안 자리는 그대로다', async () => {
    renderThread();
    await act(async () => {});
    expect(screen.getByTestId('request-state-expired')).toBeTruthy();
    expect(screen.getByTestId('composer-input').props.value).toBe('');

    fireEvent.press(screen.getByTestId('request-bundle-repropose'));

    const draft = reproposeDraft('kim-intern', 'expired');
    expect(screen.getByTestId('composer-input').props.value).toBe(draft);
    expect(readDraft(threadDraftKey(ROOT_ID))).toBe(draft);
    expect(readDraft(channelDraftKey('ch'))).toBe('');
    expect(screen.getByTestId('request-bundle-repropose-note')).toHaveTextContent(/입력창에 넣어 뒀어요/);
  });

  it('스레드 입력창에 쓰던 글이 있으면 덮지 않고 못 넣었다고 말한다', async () => {
    renderThread();
    await act(async () => {});
    fireEvent.changeText(screen.getByTestId('composer-input'), '먼저 쓰던 답글');

    fireEvent.press(screen.getByTestId('request-bundle-repropose'));

    expect(screen.getByTestId('composer-input').props.value).toBe('먼저 쓰던 답글');
    expect(readDraft(threadDraftKey(ROOT_ID))).toBe('먼저 쓰던 답글');
    expect(screen.getByTestId('request-bundle-repropose-note')).toHaveTextContent(/쓰던 글이 있어서 넣지 못했어요/);
  });

  it('채널 입력창에 쓰던 글이 있어도 스레드 입력창이 비어 있으면 들어간다 — 두 입력창은 서로의 글을 모른다', async () => {
    saveDraft(channelDraftKey('ch'), '채널에 쓰던 글');
    renderThread();
    await act(async () => {});

    fireEvent.press(screen.getByTestId('request-bundle-repropose'));

    expect(screen.getByTestId('composer-input').props.value).toBe(reproposeDraft('kim-intern', 'expired'));
    expect(readDraft(channelDraftKey('ch'))).toBe('채널에 쓰던 글');
  });
});
