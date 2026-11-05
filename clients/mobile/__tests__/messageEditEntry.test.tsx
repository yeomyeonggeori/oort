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

// =============================================================================
// #5326 — 고치기를 찾기 쉽게(시트 맨 위 줄) + 「수정됨」을 누르면·시트 머리에서 고친 시각.
//
// 폰 시계: 제공자 없는 시험은 한국어 서비스의 UTC 문맥으로 읽는다(`useLocaleService` 의 대체). 오전·오후 글자는 ICU 판마다 달라서(Node 24 는
// 한국어를 「AM」으로 낸다) 시각은 숫자(`9:05`)로만 잰다. 09:05 는 12시간제(`9:05`)와 24시간제(`09:05`) 둘 다에 `9:05` 로 들어 있다.
// =============================================================================

const utc = (y: number, m: number, d: number, hh: number, mm: number) => Date.UTC(y, m - 1, d, hh, mm);
// BASE_MS = 2023-11-14 22:13 UTC.
const TODAY_0905 = utc(2023, 11, 14, 9, 5);
const YESTERDAY_0905 = utc(2023, 11, 13, 9, 5);
const OTHER_DAY_0905 = utc(2023, 11, 3, 9, 5);
const OTHER_YEAR_0905 = utc(2022, 12, 31, 9, 5);

function rowTree(msg: Message, rowActions: MessageRowActions = actions()) {
  return (
    <MessageRow
      message={msg}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
      actions={rowActions}
    />
  );
}

async function settle() {
  await act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
  });
}

const textOf = (node: {props: {children?: unknown}}): string => {
  const children = node.props.children;
  return Array.isArray(children) ? children.join('') : String(children ?? '');
};

describe('폰: 길게 누르기 시트의 고치기 — 맨 위 줄 (#5326)', () => {
  // 트리 순서대로 돌려준다(호스트 요소만). 위에서 아래로 읽는 사람의 순서가 곧 이 배열의 순서다.
  const orderedRows = (): string[] =>
    screen
      .getAllByTestId(/^sheet-(edit|reply|quote|copy|pin)$/)
      .map(element => String(element.props.testID));

  it('내 메시지: 고치기가 답글·인용·복사·고정보다 앞, 행동 줄 맨 위다', async () => {
    await renderRow(message());
    longPress();
    const order = orderedRows();
    expect(order[0]).toBe('sheet-edit');
    expect(order).toEqual(expect.arrayContaining(['sheet-reply', 'sheet-copy']));
    expect(order.indexOf('sheet-edit')).toBeLessThan(order.indexOf('sheet-reply'));
    expect(order.indexOf('sheet-edit')).toBeLessThan(order.indexOf('sheet-copy'));
  });

  it('남의 메시지: 고치기가 없고 첫 줄은 답글 달기다', async () => {
    await renderRow(message({authorMemberId: OTHER}));
    longPress();
    expect(screen.queryByTestId('sheet-edit')).toBeNull();
    expect(orderedRows()[0]).toBe('sheet-reply');
  });

  it.each([
    ['첨부 든 글', {attachments: [PHOTO]}],
    ['답글', {rootId: 'root-1'}],
  ] as ReadonlyArray<[string, Partial<Message>]>)('%s도 같은 맨 위 줄이다', async (_name, over) => {
    await renderRow(message(over));
    longPress();
    expect(orderedRows()[0]).toBe('sheet-edit');
  });
});

describe('폰: 「수정됨」과 고친 시각 (#5326)', () => {
  it('고치지 않은 글: 시트 머리에 고친 시각 줄이 없다', async () => {
    await renderRow(message());
    longPress();
    expect(screen.queryByTestId('sheet-edited-at')).toBeNull();
  });

  it('고친 글: 길게 누르기 시트 머리가 고친 시각 문장을 말한다', async () => {
    await renderRow(message({state: 'edited', editedAtMs: TODAY_0905}));
    longPress();
    const line = screen.getByTestId('sheet-edited-at');
    expect(textOf(line)).toMatch(/9:05에 수정됨$/);
    expect(textOf(line)).not.toMatch(/어제|월 /);
  });

  it('고친 시각을 모르는 줄: 시트 머리에 줄이 없고 꼬리는 낱말 하나다', async () => {
    await renderRow(message({state: 'edited'}));
    expect(screen.getByText('수정됨')).toBeTruthy();
    longPress();
    expect(screen.queryByTestId('sheet-edited-at')).toBeNull();
  });

  it('꼬리의 「수정됨」을 누르면 시각 문장으로 펼쳐지고, 다시 누르면 낱말로 접힌다', async () => {
    await renderRow(message({state: 'edited', editedAtMs: TODAY_0905}));
    const mark = screen.getByTestId('edited-mark');
    expect(screen.getByText('수정됨')).toBeTruthy();
    expect(mark.props.accessibilityState).toEqual({expanded: false});
    fireEvent.press(mark);
    expect(screen.getByText(/9:05에 수정됨$/)).toBeTruthy();
    expect(screen.getByTestId('edited-mark').props.accessibilityState).toEqual({expanded: true});
    fireEvent.press(screen.getByTestId('edited-mark'));
    expect(screen.getByText('수정됨')).toBeTruthy();
    expect(screen.queryByText(/9:05에 수정됨$/)).toBeNull();
  });

  it('낭독 라벨은 낱말이 아니라 시각 문장을 읽는다(행이 접근성 원소 하나다)', async () => {
    await renderRow(message({state: 'edited', editedAtMs: TODAY_0905}));
    const label = screen.getByTestId('message-row').props.accessibilityLabel as string;
    expect(label).toMatch(/9:05에 수정됨/);
  });

  it.each([
    ['오늘', TODAY_0905, /^(?!.*(어제|월 )).*9:05에 수정됨$/],
    ['어제', YESTERDAY_0905, /^어제 .*9:05에 수정됨$/],
    ['같은 해 다른 날', OTHER_DAY_0905, /^11월 3일 .*9:05에 수정됨$/],
    ['다른 해', OTHER_YEAR_0905, /^2022년 12월 31일 .*9:05에 수정됨$/],
  ] as ReadonlyArray<[string, number, RegExp]>)('%s: 시트 머리의 시각 앞 말', async (_name, editedAtMs, expected) => {
    await renderRow(message({state: 'edited', editedAtMs}));
    longPress();
    expect(textOf(screen.getByTestId('sheet-edited-at'))).toMatch(expected);
  });

  it('실시간: 같은 행이 새 고친 시각으로 다시 그려지면 펼친 문장이 새 시각으로 바뀐다', async () => {
    const rowActions = actions();
    const view = render(rowTree(message({state: 'edited', editedAtMs: TODAY_0905}), rowActions));
    await settle();
    fireEvent.press(screen.getByTestId('edited-mark'));
    expect(screen.getByText(/9:05에 수정됨$/)).toBeTruthy();
    // 다른 사람이 한 번 더 고쳤다: `message.edited` 프레임이 `applyEditedMessage` 를 지나 행에 새 메시지 객체와 새 `editedAtMs` 를 준다.
    view.rerender(
      rowTree(message({state: 'edited', body: '회의 시간은 4시로 바꿨어요', editedAtMs: utc(2023, 11, 14, 11, 40)}), rowActions),
    );
    await settle();
    expect(screen.getByText(/11:40에 수정됨$/)).toBeTruthy();
    expect(screen.queryByText(/9:05에 수정됨$/)).toBeNull();
    expect(screen.getByText('회의 시간은 4시로 바꿨어요')).toBeTruthy();
  });

  it('실시간: 처음 고쳐진 글에 표지가 새로 선다', async () => {
    const rowActions = actions();
    const view = render(rowTree(message(), rowActions));
    await settle();
    expect(screen.queryByTestId('edited-mark')).toBeNull();
    view.rerender(rowTree(message({state: 'edited', editedAtMs: TODAY_0905}), rowActions));
    await settle();
    expect(screen.getByText('수정됨')).toBeTruthy();
  });
});
