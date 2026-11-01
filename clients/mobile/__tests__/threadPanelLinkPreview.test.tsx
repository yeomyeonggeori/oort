import type {Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {UnfurlPreview} from '@momo/core/features/timeline/unfurl';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import {setLinkPreviewPreference} from '../src/features/conversation/linkPreviewPreference';
import {resetUnfurlImagesForTest} from '../src/features/conversation/unfurlImage';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';
import {resetAttachmentDraftsForTest} from '../src/features/attachments/draftStore';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// #5016: 폰 **스레드 패널**이 입력창의 미리보기 ✕를 답글 전송까지 나르는가. 입력창 자체의 규칙(기다림·✕·429)은
// `composerLinkPreview.test.tsx` 가 재고, 여기서는 호스트 배선만 잰다: 스레드 패널이 입력창에 **스레드가 선 방**을
// 주는가(그 채널에 묻는다), 그리고 ✕로 끈 답글이 `sendReply` 에 억제 필드를 싣는가 — 켜지 않은 답글은 예전과 같은
// 호출(옵션 자리가 비어 있음)이다.
// =============================================================================

const mockMarkThreadRead = jest.fn();
const mockFetchPreview = jest.fn();
jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  markThreadRead: (...args: unknown[]) => mockMarkThreadRead(...args),
  fetchUnfurlPreview: (...args: unknown[]) => mockFetchPreview(...args),
}));

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WS = 'ws-1';
const CH = 'channel-1';
const LINK = 'https://a.example/one';
const BASE_MS = 1_700_000_000_000;
const mmkv = (jest.requireMock('react-native-mmkv') as {__store: Map<string, string>}).__store;

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName: name,
    handle: name,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}
const DIRECTORY = makeDirectory([member(SELF, '곽성재'), member(OTHER, '김인턴')]);

const ROOT: Message = {
  id: ROOT_ID,
  channelId: CH,
  seq: 10,
  hlcTs: 10,
  hlcCount: 0,
  authorMemberId: OTHER,
  type: 'text',
  body: '배포는 금요일에 합니다.',
  state: 'sent',
  createdAtMs: BASE_MS,
};

function timeline(sendReply: jest.Mock): UseTimelineResult {
  return {
    state: {messages: [ROOT], oldestSeq: ROOT.seq, newestSeq: 10},
    status: 'ready',
    resume: {lastRecovered: null, lastBackfillCount: 0, resubscribeCount: 0},
    recoveryMarkers: [],
    pending: [],
    send: async () => {},
    resend: async () => {},
    toggleReaction: async () => {},
    editBody: async () => {},
    removeMessage: async () => {},
    loadReplies: async () => ({following: false}),
    applyThreadRead: () => {},
    sendReply,
    repliesPending: () => [],
    loadOlder: async () => {},
    reload: () => {},
    loadingOlder: false,
    reachedStart: true,
    reactions: {},
  } as unknown as UseTimelineResult;
}

function panel(sendReply: jest.Mock) {
  return (
    <ThreadPanel
      root={ROOT}
      timeline={timeline(sendReply)}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 60_000}
      workspaceId={WS}
      channelId={CH}
      onClose={() => {}}
    />
  );
}

function ok(url: string): UnfurlPreview {
  return {id: 'p-1', url, status: 'ok', title: 'Title of a.example', domain: 'a.example'} as UnfurlPreview;
}

async function showCard() {
  mockFetchPreview.mockResolvedValue(ok(LINK));
  await act(async () => {
    fireEvent.changeText(screen.getByTestId('composer-input'), LINK);
  });
  await act(async () => {
    jest.advanceTimersByTime(350);
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  installAppClock();
  mmkv.clear();
  mockMarkThreadRead.mockReset();
  mockMarkThreadRead.mockResolvedValue({following: false});
  mockFetchPreview.mockReset();
  resetUnfurlImagesForTest(async () => 'data:image/png;base64,AAAA');
  resetAttachmentDraftsForTest();
  setLinkPreviewPreference('compact');
});
afterEach(() => {
  cleanup();
  jest.useRealTimers();
  resetUnfurlImagesForTest();
});

describe('폰 스레드 패널의 링크 미리보기 (#5016)', () => {
  it('스레드가 선 채널로 묻고, ✕로 끈 답글은 sendReply 에 억제 필드를 싣는다', async () => {
    const sendReply = jest.fn(async () => {});
    render(panel(sendReply));
    await showCard();
    expect(mockFetchPreview).toHaveBeenCalledWith(WS, CH, LINK, expect.any(AbortSignal));
    expect(screen.getByTestId('composer-link-preview')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('composer-link-preview-dismiss'));
    });
    expect(screen.queryByTestId('composer-link-preview')).toBeNull();
    await act(async () => {
      fireEvent.press(screen.getByTestId('composer-send'));
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(ROOT_ID, LINK, undefined, {suppressUnfurl: true});
  });

  it('끄지 않은 답글은 예전과 같은 호출이다 — 옵션 자리가 비어 있다', async () => {
    const sendReply = jest.fn(async () => {});
    render(panel(sendReply));
    await showCard();
    await act(async () => {
      fireEvent.press(screen.getByTestId('composer-send'));
    });
    expect(sendReply).toHaveBeenCalledTimes(1);
    expect(sendReply).toHaveBeenCalledWith(ROOT_ID, LINK, undefined, undefined);
  });
});
