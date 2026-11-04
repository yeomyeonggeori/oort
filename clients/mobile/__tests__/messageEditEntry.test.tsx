import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react-native';
import React from 'react';

import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {__resetEntryDrafts} from '../src/lib/entryDrafts';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({workspaceId: 'ws', member: {id: 'self'}, signOut: jest.fn()}),
}));

// =============================================================================
// 메시지 고치기의 입구 — 폰 코드 경로 (#5191)
//
// 메시지 고치기가 안 된다는 보고(#5191)에서 폰 칸은 기기 없이 **코드 경로**로 잰다: 행을 길게 눌러 시트를 열고, 시트에 「고치기」가
// 있는지·눌러서 편집기가 지금 글로 열리는지·저장이 글 하나만 보내는지·고친 줄에 「수정됨」이 서는지.
//
// 재현 표(웹·WebKit 은 `clients/web/scripts/capture-5191.mjs`)가 먼저 반박한 가설: **첨부가 든 메시지는 `type` 이 `text` 가
// 아니라 고치기가 안 뜬다**는 사실이 아니다. 클라이언트는 첨부를 `type: "text"` + `attachmentIds` 로 보내고, 예약 보냄도 서버가
// `MessageType::Text` 로 같은 길에 넣는다(`scheduler.rs`). 그래서 이 표의 「글 · 첨부 든 글 · 예약 보낸 글 · 답글 · 스레드 루트」
// 다섯 칸은 같은 판정(`canEditMessage`)을 지나고 전부 열린다. 이 파일은 그 사실이 **폰 화면에서도** 참인지를 못 박는다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const AGENT = 'cccccccc-1111-4111-8111-cccccccccccc';
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
  member({id: SELF, displayName: '이도현', handle: 'dohyun'}),
  member({id: OTHER, displayName: '박서연', handle: 'seoyeon'}),
  member({id: AGENT, displayName: '달무리봇', handle: 'dalmuri-bot', kind: 'agent'}),
]);

const PHOTO: MessageAttachment = {
  id: 'dddddddd-1111-4111-8111-dddddddddd01',
  name: 'lunch-spot.png',
  mime: 'image/png',
  sizeBytes: 48_001,
};

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: 'ch',
    seq: 1,
    hlcTs: 1,
    hlcCount: 0,
    authorMemberId: SELF,
    type: 'text',
    body: '회의 시간은 3시로 정했어요',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF,
    onToggleReaction: jest.fn().mockResolvedValue(undefined),
    onEdit: jest.fn().mockResolvedValue(undefined),
    onDelete: jest.fn().mockResolvedValue(undefined),
    onOpenThread: jest.fn(),
    ...over,
  };
}

// 첨부 이미지 타일은 마운트하며 바이트를 내려받고, 그 결과(여기서는 네트워크가 없어 실패)가 비동기로 상태를 바꾼다. 렌더 뒤에 act 한 번으로
// 그 갱신을 시험 안에서 끝낸다(이 시험이 재는 것은 고치기 입구이지 이미지가 아니다).
async function renderRow(msg: Message, rowActions: MessageRowActions = actions()) {
  render(
    <MessageRow
      message={msg}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      actions={rowActions}
    />,
  );
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
  return rowActions;
}

/** 손가락이 닿아 눌린 채 기다린다: 행이 시트를 연다(`messageActions.test.tsx` 와 같은 제스처). */
function longPress() {
  const row = screen.getByTestId('message-row');
  const point = {nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200}};
  fireEvent(row, 'touchStart', point);
  fireEvent(screen.getByTestId('message-press'), 'longPress');
}

beforeEach(() => {
  __resetEntryDrafts();
});
afterEach(cleanup);

describe('폰 재현 표: 내 메시지의 고치기 입구 (#5191)', () => {
  const OWN_KINDS: ReadonlyArray<[string, Partial<Message>]> = [
    ['글', {}],
    ['첨부 든 글', {attachments: [PHOTO]}],
    // 예약 보냄은 서버가 같은 전송 길(`MessageType::Text`)로 넣어 와이어에서 보통 글과 같다.
    ['예약해서 보낸 글', {body: '예약해서 보낸 글이에요, 아침 아홉 시에 나갔어요'}],
    ['답글', {rootId: 'root-1'}],
    ['스레드 루트', {thread: {reply_count: 2, last_reply_seq: 9, last_reply_at: BASE_MS}}],
  ];

  it.each(OWN_KINDS)('%s: 길게 눌러 열린 시트에 「고치기」가 있다', async (_name, over) => {
    await renderRow(message(over));
    longPress();
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    expect(screen.getByTestId('sheet-edit')).toBeTruthy();
  });

  const NOT_MINE: ReadonlyArray<[string, Partial<Message>]> = [
    ['남의 글', {authorMemberId: OTHER}],
    ['에이전트 글', {authorMemberId: AGENT}],
  ];

  it.each(NOT_MINE)('%s: 시트에 「고치기」가 없다(남의 메시지 고치기는 막혀 있다)', async (_name, over) => {
    await renderRow(message(over));
    longPress();
    expect(screen.getByTestId('message-action-sheet')).toBeTruthy();
    expect(screen.queryByTestId('sheet-edit')).toBeNull();
  });

  it('첨부 든 글: 고치기 → 편집기가 지금 글로 열리고, 저장하면 글 하나만 보낸다(첨부는 건드리지 않는다)', async () => {
    const rowActions = actions();
    const original = message({attachments: [PHOTO]});
    await renderRow(original, rowActions);
    longPress();
    fireEvent.press(screen.getByTestId('sheet-edit'));

    const input = await screen.findByTestId('editor-input');
    expect(input.props.value).toBe('회의 시간은 3시로 정했어요');
    fireEvent.changeText(input, '회의 시간은 3시 30분으로 정했어요');
    fireEvent.press(screen.getByTestId('editor-save'));

    await waitFor(() => expect(rowActions.onEdit).toHaveBeenCalledTimes(1));
    expect(rowActions.onEdit).toHaveBeenCalledWith(original, '회의 시간은 3시 30분으로 정했어요');
  });

  it('고친 메시지에는 「수정됨」이 선다(웹과 같은 낱말)', async () => {
    await renderRow(message({state: 'edited', editedAtMs: BASE_MS + 1000}));
    expect(screen.getByTestId('edited-mark')).toBeTruthy();
    expect(screen.getByText('수정됨')).toBeTruthy();
  });

  it('고치지 않은 메시지에는 「수정됨」이 없다', async () => {
    await renderRow(message());
    expect(screen.queryByTestId('edited-mark')).toBeNull();
  });
});
