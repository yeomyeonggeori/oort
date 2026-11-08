import 'react-native-url-polyfill/auto';
import React, {useCallback} from 'react';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import {Keyboard, View} from 'react-native';
import type {CatalogEmoji} from '@momo/core/features/emoji/catalog';
import {sendMessage, sendThreadReply, type Message, type RosterMember} from '@momo/core/lib/api';
import {NetworkError} from '@momo/core/lib/http';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {createExpressionFixtureServer, type ExpressionFixtureRequest} from '@momo/core/features/expressions/fixtureServer';
import {FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID} from '@momo/core/features/expressions/fixtures';
import {FIXTURE_MEDIA} from '@momo/core/features/expressions/fixtureMedia';
import type {Expression} from '@momo/core/features/expressions/types';

import '../src/boot/polyfills';
import '../src/boot/coreHost';
import {Composer, type ComposerSendOptions} from '../src/features/conversation/Composer';
import {ConversationLayout} from '../src/features/conversation/ConversationLayout';
import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import {useReplyDraft, type UseReplyDraftResult} from '../src/features/conversation/useReplyDraft';
import {useTimeline, type UseTimelineResult} from '../src/features/conversation/useTimeline';
import {loadPhoneEmojiCatalog} from '../src/features/emoji/catalog';
import {rememberEmojiCatalog} from '../src/features/emoji/catalogMemory';
import {emojiFrequency, emojiSkinTone} from '../src/features/emoji/preferences';
import {resetPanelTab} from '../src/features/expressions/ExpressionKeyboardPanel';
import {PhoneExpressions} from '../src/features/expressions/ExpressionProvider';
import {createPhoneExpressionStore, type PhoneExpressionStore} from '../src/features/expressions/store';
import {installAppClock} from './fixtures/fakeClock';
import {pinReduceMotion} from './fixtures/reduceMotion';

jest.mock('@momo/core/lib/api', () => ({
  ...jest.requireActual('@momo/core/lib/api'),
  sendMessage: jest.fn(),
  sendThreadReply: jest.fn(),
  fetchThreadReplies: jest.fn(async () => ({messages: [], nextCursor: undefined, following: false})),
  markThreadRead: jest.fn(async () => ({following: false})),
}));
jest.mock('../src/features/conversation/failedSends', () => ({
  forgetFailedSend: jest.fn(),
  readFailedSends: jest.fn(() => []),
  rememberFailedSend: jest.fn(),
}));
jest.mock('../src/features/emoji/catalog', () => ({loadPhoneEmojiCatalog: jest.fn()}));
jest.mock('../src/features/expressions/ExpressionImage', () => {
  const {View: Box} = require('react-native');
  return {ExpressionImage: ({expression, size}: {expression: {name: string}; size: string}) => <Box testID={`img-${size}-${expression.name}`} />};
});

// =============================================================================
// 밀어서 답장·스레드 입력창도 이모티콘 미리 보기 → 보내기 한 번에 [큰 그림, 글] (#5490, 웹 스레드 입력창 #5487 의 짝, 검증 7b M5).
//
// **고르기부터 서버까지** 한 줄로 잇는다: 진짜 `Composer`·`ConversationLayout`·창·`useTimeline`(진짜 대기 행·묶음 규칙)·`useReplyDraft`·`ThreadPanel`. 가짜는 서버 쪽 둘(`sendThreadReply`·`sendMessage`, 요청이
// 나간 차례와 인자를 재는 자리)과 서버 보관함(코어 fixture)·표준 이모지 목록·그림 부품뿐이다. 입력창 수준 규칙(머리말과 미리 보기가 함께 서는 것, 취소 뒤에도 남는 것)은 `expressionComposerPanel.test`,
// 훅 수준 규칙(첫째 실패·둘째만 실패의 모든 길)은 `expressionBundleSend.test` 가 잰다. 여기는 그 사이의 **이음매**를 잰다 - 입력창의 `onSend(글, {expression})` 이 두 메시지가 되어 같은 스레드로 나가는가.
//
// 스레드 입력창은 웹과 달리 보내는 중·실패 행(`repliesPending`)이 있다. 그래서 웹 스레드 입력칸처럼 「실패하면 미리 보기·글이 입력창에 남는다」가 아니라 **대화 입력창과 같은 규칙**이다:
// 보내기를 누르면 입력창은 바로 비고, 실패한 그림·글은 스레드 안의 실패한 행 둘로 남아 어느 쪽에서 다시 보내도 그림부터 같은 id 로 나간다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const WS = 'ws-1';
const CH = 'channel-1';
const BASE_MS = 1_700_000_000_000;

function member(id: string, name: string): RosterMember {
  return {id, workspaceId: WS, kind: 'human', status: 'active', displayName: name, handle: name, channelCount: 0, channelIds: [], capabilities: [], createdAtMs: 0, updatedAtMs: 0} as RosterMember;
}
const DIRECTORY = makeDirectory([member(SELF, '곽성재'), member(OTHER, '김인턴')]);
/** 남이 쓴 본류의 글 - 밀어서 답장을 걸 대상이면서 스레드의 루트다. */
const PEER: Message = {id: ROOT_ID, channelId: CH, seq: 10, hlcTs: 10, hlcCount: 0, authorMemberId: OTHER, type: 'text', body: '배포는 금요일에 합니다.', state: 'sent', createdAtMs: BASE_MS};

const PNG = FIXTURE_MEDIA.png.image;
const PNG_MEDIA = {...FIXTURE_EXPRESSIONS[1].media!, small: {...PNG}, large: {...PNG}};
const kk: Expression = {...FIXTURE_EXPRESSIONS[2], id: '00000000-0000-4000-8000-000000000401', name: 'dam_kk', displayName: '킹받네', tags: ['농담곰', '킹받네'], kind: 'sticker', media: PNG_MEDIA};
const party: CatalogEmoji = {glyph: '🎉', name: 'party popper', koreanName: '축하', shortcodes: ['tada'], keywords: [], category: 'activity', version: 1};

const stores: PhoneExpressionStore[] = [];
let release: (() => void) | undefined;
async function loadedStore() {
  const server = createExpressionFixtureServer();
  const base = `/v1/workspaces/${FIXTURE_WORKSPACE_ID}/expressions`;
  const request = jest.fn(async (input: ExpressionFixtureRequest) => {
    const response = server.request(input);
    const json = response.json as {items?: Expression[]} | undefined;
    return input.method === 'GET' && input.path.split('?')[0] === base && json?.items ? {...response, json: {...json, items: [kk]}} : response;
  });
  const store = createPhoneExpressionStore(
    FIXTURE_WORKSPACE_ID,
    FIXTURE_MEMBER_ID,
    {request},
    {write: jest.fn((key: string) => `file:///fixture/${key}`), remove: jest.fn()},
    {read: () => null, write: jest.fn()},
  );
  stores.push(store);
  await store.refresh(true);
  return store;
}

// ---- 서버 대역: 요청이 나간 차례·인자를 잰다 --------------------------------------------------------------------------------
const reply = jest.mocked(sendThreadReply);
const main = jest.mocked(sendMessage);
let serverSeq = 100;
const confirmAll = () =>
  reply.mockImplementation(async (_ws, _ch, root, id, body) => ({
    id: String(id), channelId: CH, seq: ++serverSeq, hlcTs: serverSeq, hlcCount: 0, authorMemberId: SELF, type: 'text', body: String(body), state: 'sent', createdAtMs: BASE_MS, rootId: String(root),
  }) as Message);
const requests = () => reply.mock.calls.map(call => ({root: String(call[2]), id: String(call[3]), body: String(call[4])}));

// ---- 두 화면의 뼈대 -------------------------------------------------------------------------------------------------------
let draft: UseReplyDraftResult;
let live: UseTimelineResult;

/** 대화 화면의 뼈대: 진짜 `useTimeline` + `useReplyDraft`(`sendThreadReply: timeline.sendReply`)와 진짜 입력창. `onSend` 의 분기는 `ConversationScreen.onSend` 와 같은 줄이다. */
function Conversation() {
  const timeline = useTimeline(null, WS, CH, SELF);
  const replyDraft = useReplyDraft({channelId: CH, messages: timeline.state.messages, myMemberId: SELF, sendThreadReply: timeline.sendReply});
  draft = replyDraft;
  live = timeline;
  const {send} = timeline;
  const {sendReply} = replyDraft;
  const onSend = useCallback(
    (body: string, options?: ComposerSendOptions) => {
      if (sendReply(body, options)) return;
      void send(body, undefined, options?.attachments, undefined, options?.expression === undefined ? undefined : {expression: options.expression});
    },
    [sendReply, send],
  );
  return (
    <ConversationLayout
      list={<View testID="list-slot" />}
      composer={
        <Composer
          recipient="place"
          channelLabel="agent-lab"
          directory={DIRECTORY}
          attachmentTarget={{workspaceId: WS, channelId: CH}}
          replyTarget={replyDraft.replyTarget}
          onCancelReply={replyDraft.cancelReply}
          onSend={onSend}
          expressionBundle
        />
      }
    />
  );
}

/** 스레드 화면: 진짜 `useTimeline` 위에 진짜 `ThreadPanel`(스레드의 보내는 중·실패 행은 `repliesPending`). */
function Thread() {
  const timeline = useTimeline(null, WS, CH, SELF);
  live = timeline;
  return <ThreadPanel root={PEER} timeline={timeline} directory={DIRECTORY} myMemberId={SELF} nowMs={BASE_MS + 60_000} workspaceId={WS} channelId={CH} onClose={() => {}} />;
}

const input = () => screen.getByTestId('composer-input');
const mountWith = (store: PhoneExpressionStore, surface: React.JSX.Element) => render(<PhoneExpressions.Provider value={store}>{surface}</PhoneExpressions.Provider>);
const pickKk = () => {
  fireEvent.press(screen.getByTestId('composer-expression'));
  fireEvent.press(screen.getByTestId('expression-pick-dam_kk'));
};
const press = async (testID: string) => {
  await act(async () => {
    fireEvent.press(screen.getByTestId(testID));
  });
};

beforeEach(async () => {
  jest.clearAllMocks();
  reply.mockReset();
  main.mockReset();
  serverSeq = 100;
  resetPanelTab();
  rememberEmojiCatalog(null);
  release = await pinReduceMotion(true);
  (loadPhoneEmojiCatalog as jest.Mock).mockResolvedValue([party]);
  emojiFrequency.reset();
  emojiSkinTone.reset();
  jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => {});
  // 스레드 패널의 시계(읽음 신호·지금 시각)가 진짜 타이머를 쥐고 시험 뒤에도 남지 않게 한다(`threadPanelLinkPreview.test` 와 같은 길).
  installAppClock();
});
afterEach(async () => {
  await act(async () => {});
  cleanup();
  jest.useRealTimers();
  stores.splice(0).forEach(store => store.dispose());
  release?.();
  jest.restoreAllMocks();
});

describe('밀어서 답장(답글 머리말) - 고르기 → 미리 보기 → 보내기 한 번', () => {
  it('서버가 받는 순서는 [큰 그림, 글]이고 둘 다 머리말이 가리킨 스레드의 답글이다 - 멱등 열쇠는 서로 다르다. 본류로는 아무것도 가지 않는다', async () => {
    const store = await loadedStore();
    confirmAll();
    mountWith(store, <Conversation />);
    act(() => draft.startReply(PEER));
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();
    pickKk();
    // 머리말과 미리 보기가 함께 서고, `:이름:` 글은 입력칸에 들어가지 않는다.
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(input().props.value).toBe('');
    fireEvent.changeText(input(), '고생 많았어요');
    await press('composer-send');

    expect(requests().map(call => [call.root, call.body])).toEqual([[ROOT_ID, ':dam_kk:'], [ROOT_ID, '고생 많았어요']]);
    expect(new Set(requests().map(call => call.id)).size).toBe(2);
    expect(main).not.toHaveBeenCalled();
    // 보낸 뒤: 머리말은 떨어지고(보낸 순간), 미리 보기와 글은 비고, 대기 행은 모두 확정되어 없다.
    expect(screen.queryByTestId('reply-draft-card')).toBeNull();
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    expect(input().props.value).toBe('');
    expect(live.repliesPending(ROOT_ID)).toEqual([]);
  });

  it('머리말을 떼고 보내면 같은 묶음이 본류의 글 둘로 나간다 - 그림만 본류에 홀로 남지 않고 스레드로 새지도 않는다', async () => {
    const store = await loadedStore();
    main.mockImplementation(async (_ws, _ch, id, body) => ({id: String(id), channelId: CH, seq: ++serverSeq, hlcTs: serverSeq, hlcCount: 0, authorMemberId: SELF, type: 'text', body: String(body), state: 'sent', createdAtMs: BASE_MS}) as Message);
    mountWith(store, <Conversation />);
    act(() => draft.startReply(PEER));
    pickKk();
    await press('reply-draft-cancel');
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy(); // 취소 뒤에도 미리 보기는 남는다
    fireEvent.changeText(input(), '본류로 보내요');
    await press('composer-send');
    expect(main.mock.calls.map(call => String(call[3]))).toEqual([':dam_kk:', '본류로 보내요']);
    expect(reply).not.toHaveBeenCalled();
  });
});

describe('스레드 입력창 - 고르기 → 미리 보기 → 보내기 한 번', () => {
  it('서버가 받는 순서는 [큰 그림, 글]이고 둘 다 이 스레드의 답글이다 - 멱등 열쇠는 서로 다르고 입력창은 비워진다', async () => {
    const store = await loadedStore();
    confirmAll();
    mountWith(store, <Thread />);
    await screen.findByTestId('composer-input');
    pickKk();
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(input().props.value).toBe(''); // `:이름:` 글이 들어가지 않는다
    fireEvent.changeText(input(), '점심 같이 가요');
    await press('composer-send');

    expect(requests().map(call => [call.root, call.body])).toEqual([[ROOT_ID, ':dam_kk:'], [ROOT_ID, '점심 같이 가요']]);
    expect(new Set(requests().map(call => call.id)).size).toBe(2);
    expect(main).not.toHaveBeenCalled();
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    expect(input().props.value).toBe('');
    expect(live.repliesPending(ROOT_ID)).toEqual([]);
  });

  it('글을 치다 멈추면 스레드 입력창에도 추천 줄이 서고, 누르면 미리 보기에 오른다 - 저절로 보내지 않는다', async () => {
    const store = await loadedStore();
    mountWith(store, <Thread />);
    await screen.findByTestId('composer-input');
    act(() => void fireEvent(input(), 'focus'));
    act(() => void fireEvent.changeText(input(), '킹받네'));
    expect(screen.queryByTestId('composer-expression-suggest')).toBeNull(); // 0.3초 전엔 없다
    act(() => void jest.advanceTimersByTime(300));
    fireEvent.press(screen.getByTestId('composer-expression-suggest-item-dam_kk'));
    expect(screen.getByTestId('composer-expression-preview')).toBeTruthy();
    expect(screen.queryByTestId('composer-expression-suggest')).toBeNull();
    act(() => void jest.advanceTimersByTime(5000));
    expect(reply).not.toHaveBeenCalled();
    expect(input().props.value).toBe('킹받네'); // 쓴 글은 그대로
  });

  it('첫째가 실패하면 둘째는 나가지 않는다 - 입력창은 비고(대화 입력창과 같은 규칙) 실패한 행 둘이 스레드에 남아, 둘째 행에서 다시 보내도 그림부터 같은 id 로 나간다', async () => {
    const store = await loadedStore();
    reply.mockRejectedValueOnce(new NetworkError('unreachable', 15_000));
    mountWith(store, <Thread />);
    await screen.findByTestId('composer-input');
    pickKk();
    fireEvent.changeText(input(), '글도 보낼래요');
    await press('composer-send');

    expect(requests()).toHaveLength(1); // 첫째만 나갔고 둘째는 요청이 없다
    expect(input().props.value).toBe('');
    expect(screen.queryByTestId('composer-expression-preview')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('pending-row')).toHaveLength(2));
    const [head, tail] = live.repliesPending(ROOT_ID);
    expect([head.body, head.status, tail.body, tail.status]).toEqual([':dam_kk:', 'failed', '글도 보낼래요', 'failed']);

    reply.mockReset();
    confirmAll();
    await act(async () => {
      fireEvent.press(screen.getAllByTestId('pending-resend')[1]); // 둘째(글) 행의 「다시 보내기」
    });
    expect(requests().map(call => [call.id, call.root, call.body])).toEqual([
      [head.clientMsgId, ROOT_ID, ':dam_kk:'],
      [tail.clientMsgId, ROOT_ID, '글도 보낼래요'],
    ]);
    expect(live.repliesPending(ROOT_ID)).toEqual([]);
  });
});
