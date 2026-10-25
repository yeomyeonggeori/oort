import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {payloadToMessage, type MessageNewEvent} from '@momo/core/lib/realtimeEvents';
import {reconcileMessages} from '@momo/core/features/timeline/model';
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

import {resetAttachmentContentForTest} from '../src/features/attachments/content';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';

// =============================================================================
// #4294 - 글 없이 사진만 보낸 메시지가 받는 쪽에서 「내용 없는 메시지」로 보였다 (베타 피드백).
//
// 폰 행은 본문 칸이 비면 「※ 내용 없는 메시지」를 세웠고, 그 판정이 첨부를 보지 않았다 - 사진 아래에
// 「내용 없는 메시지」가 같이 서 있었다. 이 파일은 그 줄이 **첨부가 없을 때만** 서는지를 그려진
// 트리에서 읽는다. 「줄이 없다」만 단정하면 행을 통째로 비워도 통과하므로, 단정은 항상 **카드가 그려졌다**와
// 한 쌍이다.
// =============================================================================

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

interface FileSystemMock {
  __reset: () => void;
}

const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';
const BASE_MS = 1_700_000_000_000;
const EMPTY_NOTE = '※ 내용 없는 메시지';

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이도현',
    handle: 'dohyeon',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER}),
]);

function photo(over: Partial<MessageAttachment> = {}): MessageAttachment {
  return {
    id: 'att-photo-1',
    name: '현장.png',
    mime: 'image/png',
    sizeBytes: 4096,
    ...over,
  };
}

function message(over: Partial<Message> = {}): Message {
  return {
    id: 'msg-1',
    channelId: CHANNEL,
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

function row(m: Message) {
  return render(
    <MessageRow
      message={m}
      startsGroup
      directory={DIRECTORY}
      chips={[]}
      nowMs={BASE_MS}
    />,
  );
}

function actions(over: Partial<MessageRowActions> = {}): MessageRowActions {
  return {
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
    ...over,
  };
}

/** 폰이 실제로 보내는 제스처 (`messageCopy.test.tsx` 와 같다). */
function longPress() {
  const point = {
    nativeEvent: {pageX: 100, pageY: 200, locationX: 100, locationY: 200},
  };
  fireEvent(screen.getByTestId('message-row'), 'touchStart', point);
  fireEvent(screen.getByTestId('message-press'), 'longPress');
}

beforeEach(() => {
  fileSystem.__reset();
  resetAttachmentContentForTest();
});

afterEach(async () => {
  // 사진 크기를 읽는 `Image.getSize` 콜백이 시험이 끝난 뒤에 상태를 건드려 act 경고가 나지 않게 한 번 비운다.
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
  cleanup();
});

describe('#4294 - 사진만 보낸 행은 사진을 그리고 「내용 없는 메시지」라 말하지 않는다', () => {
  it.each([
    ['빈 문자열', ''],
    ['공백만', '   \n  '],
    ['키 자체가 없음', undefined],
  ])('본문이 %s 이어도 첨부 카드가 서고 빈 메시지 줄은 없다', async (_name, body) => {
    row(message(body === undefined ? {attachments: [photo()]} : {body, attachments: [photo()]}));

    // 짝 1: 행이 비지 않았다 - 사진 카드가 그려졌다.
    expect(screen.getAllByTestId('attachment-item')).toHaveLength(1);
    // 짝 2: 그리고 그 아래에 「내용 없는 메시지」가 서 있지 않다.
    expect(screen.queryByText(EMPTY_NOTE)).toBeNull();
    // 미리보기 바이트 요청이 끝나기를 기다려 act 경고 없이 마친다.
    await waitFor(() =>
      expect(screen.getByTestId('attachment-preview').props.accessibilityValue.text).toBe('ready'),
    );
  });

  it('여러 장·파일이 섞여도 같다', async () => {
    row(
      message({
        body: '',
        attachments: [
          photo({id: 'a1'}),
          photo({id: 'a2', name: '현장2.png'}),
          photo({id: 'a3', name: '견적.pdf', mime: 'application/pdf'}),
        ],
      }),
    );
    expect(screen.getAllByTestId('attachment-item')).toHaveLength(3);
    expect(screen.queryByText(EMPTY_NOTE)).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('attachment-preview').length).toBeGreaterThan(0));
  });

  it('대조: 첨부가 없으면 예전처럼 「내용 없는 메시지」라고 말한다', () => {
    // 이 줄을 아예 지워도 위 시험은 통과한다 - 그 반대쪽을 이 한 쌍이 잡는다.
    row(message({body: '', attachments: []}));
    expect(screen.getByText(EMPTY_NOTE)).toBeTruthy();
    expect(screen.queryByTestId('attachment-item')).toBeNull();
  });

  it('대조: 첨부 키가 없는 행도 같다', () => {
    row(message({body: ''}));
    expect(screen.getByText(EMPTY_NOTE)).toBeTruthy();
  });

  it('지워진 행은 첨부가 남아 있어도 묘비 한 줄이다 (삭제가 첨부를 이긴다)', () => {
    row(message({body: undefined, state: 'deleted', attachments: [photo()]}));
    expect(screen.getByTestId('tombstone')).toBeTruthy();
    expect(screen.queryByTestId('attachment-item')).toBeNull();
    expect(screen.queryByText(EMPTY_NOTE)).toBeNull();
  });
});

describe('#4294 - 실시간 프레임으로 온 사진만 있는 메시지는 새로고침 없이 사진으로 선다', () => {
  // 서버는 첨부를 메시지와 **같은 트랜잭션**에서 묶고 complete 인 것만 묶는다
  // (`link_attachments_in_tx`: status != complete 이면 메시지째 거절). 그 트랜잭션의
  // `message.new` 프레임이 attachments 를 싣는다 - 그래서 「메시지가 먼저 오고 첨부가
  // 늦게 붙는」 경로는 계약에 없다. 이 시험은 그 계약의 받는 쪽 절반을 화면까지 잇는다:
  // 프레임 → `payloadToMessage` → `reconcileMessages` → 행.
  const frame = (over: Partial<MessageNewEvent['payload']> = {}): MessageNewEvent => ({
    type: 'message.new',
    v: 1,
    ts: BASE_MS,
    seq: 11,
    payload: {
      id: 'msg-live',
      channel_id: CHANNEL,
      seq: 11,
      type: 'text',
      body: null,
      author_member_id: OTHER,
      hlc_ts: BASE_MS,
      hlc_count: 0,
      attachments: [{id: 'att-live', name: '현장.png', mime: 'image/png', sizeBytes: 4096}],
      ...over,
    },
  });

  it('프레임 하나가 곧 사진 카드이고 빈 메시지 줄이 아니다', async () => {
    const state = reconcileMessages(
      {messages: [], oldestSeq: null, newestSeq: null},
      [payloadToMessage(frame().payload)],
    );
    expect(state.messages).toHaveLength(1);
    row(state.messages[0]);
    expect(screen.getAllByTestId('attachment-item')).toHaveLength(1);
    expect(screen.queryByText(EMPTY_NOTE)).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId('attachment-preview').props.accessibilityValue.text).toBe('ready'),
    );
  });

  it('첨부 키가 없는 프레임은 사진을 지어내지 않는다 (대조)', () => {
    const state = reconcileMessages(
      {messages: [], oldestSeq: null, newestSeq: null},
      [payloadToMessage(frame({attachments: undefined}).payload)],
    );
    row(state.messages[0]);
    expect(screen.queryByTestId('attachment-item')).toBeNull();
    expect(screen.getByText(EMPTY_NOTE)).toBeTruthy();
  });
});

describe('#4294 - 길게 눌러 여는 액션 시트가 사진만 보낸 메시지를 가리키는 한 줄', () => {
  const openSheet = (m: Message) => {
    render(
      <MessageRow
        message={m}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        nowMs={BASE_MS}
        actions={actions()}
      />,
    );
    longPress();
    return screen.getByTestId('message-action-sheet');
  };

  it('사진만 보낸 메시지는 「내용 없는 메시지」가 아니라 「사진 2장」이다', async () => {
    const sheet = openSheet(
      message({body: '', attachments: [photo({id: 'a1'}), photo({id: 'a2'})]}),
    );
    // 짝: 시트가 열려 있다 (위에서 못 찾으면 throw) 그리고 그 안의 줄이 개수다.
    expect(within(sheet).getByText('사진 2장')).toBeTruthy();
    expect(within(sheet).queryByText('내용 없는 메시지')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('attachment-preview').length).toBeGreaterThan(0));
  });

  it('파일만이면 「파일 1개」, 섞이면 사진이 먼저다', () => {
    const only = openSheet(
      message({body: undefined, attachments: [photo({id: 'f1', name: '견적.pdf', mime: 'application/pdf'})]}),
    );
    expect(within(only).getByText('파일 1개')).toBeTruthy();
  });

  it('대조: 글이 있으면 글이다', async () => {
    const sheet = openSheet(message({body: '현장 사진이에요', attachments: [photo()]}));
    expect(within(sheet).getByText('현장 사진이에요')).toBeTruthy();
    expect(within(sheet).queryByText('사진 1장')).toBeNull();
    await waitFor(() => expect(screen.getAllByTestId('attachment-preview').length).toBeGreaterThan(0));
  });

  it('대조: 글도 첨부도 없으면 예전 문장이다', () => {
    const sheet = openSheet(message({body: '', attachments: []}));
    expect(within(sheet).getByText('내용 없는 메시지')).toBeTruthy();
  });
});
