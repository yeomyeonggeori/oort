// attachmentPhotoRow — 사진 첨부 행 (MessageRow·AttachmentList)
// 합친 원본: photoOnlyMessage4294.test.tsx, attachmentSize4455.test.tsx
// 이슈 번호는 아래 묶음 `describe` 이름과 주석에 남아 있다.

import type {
  Message,
  MessageAttachment,
  RosterMember,
} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {payloadToMessage, type MessageNewEvent} from '@momo/core/lib/realtimeEvents';
import {
  type PendingMessage,
  reconcileMessages,
} from '@momo/core/features/timeline/model';
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
import {Animated, Image, StyleSheet, View} from 'react-native';

import {
  MEASURED_SIZE_LIMIT,
  measuredAttachmentSize,
  rememberAttachmentSize,
  resetAttachmentContentForTest,
} from '../src/features/attachments/content';
import {
  MessageRow,
  type MessageRowActions,
  PendingRow,
} from '../src/features/conversation/MessageRow';
import {ATTACHMENT_INLINE_IMAGE} from '../src/design/tokens';
import {FixedScheme} from '../src/design/theme';
import {AttachmentList} from '../src/features/attachments/AttachmentList';
import {Timeline} from '../src/features/conversation/Timeline';
import {resetArrivedForTest} from '../src/features/conversation/sendArrival';
import {drainRender} from './testkit';

jest.mock('../src/session/useSession', () => ({
  useSession: () => ({
    workspaceId: 'ws',
    member: {id: 'self'},
    signOut: jest.fn(),
  }),
}));

// ---- 아래 묶음들이 함께 쓰는 고정값·도구 (원래 파일마다 글자 그대로 같게 선언돼 있던 것)
const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CHANNEL = '33333333-3333-4333-8333-333333333333';

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

// =============================================================================
// 합친 시험: 원래 photoOnlyMessage4294.test.tsx (#4294)
// =============================================================================
describe('photoOnlyMessage (#4294)', () => {
  // =============================================================================
  // #4294 - 글 없이 사진만 보낸 메시지가 받는 쪽에서 「내용 없는 메시지」로 보였다 (베타 피드백).
  //
  // 폰 행은 본문 칸이 비면 「※ 내용 없는 메시지」를 세웠고, 그 판정이 첨부를 보지 않았다 - 사진 아래에
  // 「내용 없는 메시지」가 같이 서 있었다. 이 파일은 그 줄이 **첨부가 없을 때만** 서는지를 그려진
  // 트리에서 읽는다. 「줄이 없다」만 단정하면 행을 통째로 비워도 통과하므로, 단정은 항상 **카드가 그려졌다**와
  // 한 쌍이다.
  // =============================================================================

  interface FileSystemMock {
    __reset: () => void;
  }

  const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
  const BASE_MS = 1_700_000_000_000;
  const EMPTY_NOTE = '※ 내용 없는 메시지';

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
    await drainRender();
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
});

// =============================================================================
// 합친 시험: 원래 attachmentSize4455.test.tsx (#4455)
// =============================================================================
describe('attachmentSize (#4455)', () => {
  // =============================================================================
  // #4455 design-review r2 H2 — 사진 한 장의 서버 사본이 메아리 타일이 이미 잰 크기로 선다.
  //
  // 한 장짜리 사진 타일은 마운트 때 비율을 몰라 폭 280 · 16:9 자리표시로 서고, `Image.getSize` 가 돌아온 뒤에야 실제 비율이 된다.
  // 보낸 사진의 메아리가 서버 사본으로 바뀌면(키가 `p-…` → `m-…`, 새 마운트) 서버 사본 타일이 16:9 에서 다시 시작해, 교체 순간 행이
  // 가로 52.7pt · 세로 162.7pt 줄었다가(목록이 꼬리에 붙어 있으면 스크롤 오프셋이 되감긴다) 다시 자랐다. 같은 일이 기록을 읽다가
  // 화면 밖에서 돌아온 행과 방에 다시 들어왔을 때도 일어난다.
  //
  // 수리: 잰 크기를 첨부 id 별로 모듈에 두고(`content.ts`) 새 마운트가 **첫 프레임부터** 그 크기로 선다(`ImageTile` 의 `useState` 초기값).
  //
  // **첫 렌더를 본다.** RNTL 의 `render` 는 효과까지 act 로 밀어서, 「초기값이 맞다」와 「효과가 한 프레임 뒤에 고쳤다」를 구분하지
  // 못한다(후자는 곧 16:9 한 프레임이고 그것이 이음매다). 그래서 미리보기 칸이 **렌더될 때마다의 스타일**을 `View.render` 를 가로채
  // 모으고, 첫 항목을 단정한다.
  // =============================================================================

  interface FileSystemMock {
    __reset: () => void;
    __state: {downloads: unknown[]};
  }
  const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
  const NOW = 1_700_000_000_000;

  const {maxWidth: MAX_W, maxHeight: MAX_H, tile: TILE} = ATTACHMENT_INLINE_IMAGE;

  const photo = (id: string, over: Partial<MessageAttachment> = {}): MessageAttachment => ({
    id,
    name: `${id}.png`,
    mime: 'image/png',
    sizeBytes: 4096,
    ...over,
  });

  const flat = (style: unknown): Record<string, unknown> => ({
    ...((StyleSheet.flatten(style as never) ?? {}) as Record<string, unknown>),
  });

  /** 지금 화면의 첫 미리보기 칸의 스타일. */
  const frameNow = () => flat(screen.getAllByTestId('attachment-preview')[0].props.style);

  /**
   * 미리보기 칸(`attachment-preview`)이 **렌더될 때마다**의 스타일. 첫 항목이 첫 렌더다 — 효과가 도는 것보다 앞선다.
   * (`View` 는 jest 에서 클래스 목이라 `render` 가 프로토타입에 있다.)
   */
  function recordPreviewFrames(): Array<Record<string, unknown>> {
    const frames: Array<Record<string, unknown>> = [];
    const original = View.prototype.render;
    jest.spyOn(View.prototype, 'render').mockImplementation(function (this: {props: {testID?: string; style?: unknown}}) {
      if (this.props.testID === 'attachment-preview') frames.push(flat(this.props.style));
      return original.call(this);
    } as never);
    return frames;
  }

  interface SizeCall {
    uri: string;
    success: (width: number, height: number) => void;
    failure?: (error: unknown) => void;
  }

  /** `Image.getSize` 를 손으로 푼다 — 호출을 모아 두고, 시험이 원하는 때 크기를 돌려준다. */
  function holdGetSize(): {calls: SizeCall[]; spy: jest.SpyInstance} {
    const calls: SizeCall[] = [];
    const spy = jest.spyOn(Image, 'getSize').mockImplementation(((
      uri: string,
      success: SizeCall['success'],
      failure?: SizeCall['failure'],
    ) => {
      calls.push({uri, success, failure});
    }) as never);
    return {calls, spy};
  }

  const ready = () =>
    waitFor(() =>
      expect(screen.getAllByTestId('attachment-preview')[0].props.accessibilityValue.text).toBe('ready'),
    );

  function actions(): MessageRowActions {
    return {
      myMemberId: SELF,
      onToggleReaction: async () => {},
      onEdit: async () => {},
      onDelete: async () => {},
    };
  }

  function message(over: Partial<Message> = {}): Message {
    return {
      id: 'msg-1',
      channelId: CHANNEL,
      seq: 10,
      hlcTs: 10,
      hlcCount: 0,
      authorMemberId: SELF,
      type: 'text',
      state: 'sent',
      createdAtMs: NOW,
      ...over,
    };
  }

  /** act 밖에서 상태가 바뀌었다는 경고를 모은다 — 시험이 비동기 마무리를 빼먹으면 그 시험이 스스로 붉다. */
  let consoleErrors: string[] = [];

  beforeEach(() => {
    fileSystem.__reset();
    resetAttachmentContentForTest();
    resetArrivedForTest();
    consoleErrors = [];
    jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      consoleErrors.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    await drainRender();
    // 사진 크기를 읽는 콜백이 시험이 끝난 뒤에 상태를 건드려 act 경고가 나지 않게 한 번 비운다.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    cleanup();
    jest.restoreAllMocks();
    expect(consoleErrors).toEqual([]);
  });

  // -----------------------------------------------------------------------------
  // 잰 크기 저장소
  // -----------------------------------------------------------------------------
  describe('잰 크기 저장소 (content.ts)', () => {
    it('같은 첨부는 같은 객체를 돌려준다 — 대소문자를 가리지 않는다', () => {
      expect(measuredAttachmentSize('Att-A')).toBeNull();
      const size = rememberAttachmentSize('Att-A', 4000, 3000);
      expect(size).toEqual({width: 4000, height: 3000});
      expect(measuredAttachmentSize('att-a')).toBe(size);
      expect(measuredAttachmentSize('ATT-A')).toBe(size);
      // 같은 값을 다시 적어도 같은 객체다(상태 갱신이 비교만으로 끝난다).
      expect(rememberAttachmentSize('att-a', 4000, 3000)).toBe(size);
    });

    it.each([
      ['가로 0', 0, 300],
      ['세로 0', 400, 0],
      ['음수', -1, 300],
      ['NaN', Number.NaN, 300],
      ['무한', Number.POSITIVE_INFINITY, 300],
    ])('그림이 아닌 값(%s)은 적지 않는다', (_name, width, height) => {
      expect(rememberAttachmentSize('bad', width, height)).toBeNull();
      expect(measuredAttachmentSize('bad')).toBeNull();
    });

    it('상한을 넘으면 오래된 것부터 잊는다 — 최근 것은 남는다', () => {
      for (let index = 0; index <= MEASURED_SIZE_LIMIT; index += 1) {
        rememberAttachmentSize(`att-${index}`, 100, 100);
      }
      expect(measuredAttachmentSize('att-0')).toBeNull();
      expect(measuredAttachmentSize('att-1')).not.toBeNull();
      expect(measuredAttachmentSize(`att-${MEASURED_SIZE_LIMIT}`)).not.toBeNull();
    });

    it('다시 적으면 가장 최근으로 옮겨져 먼저 잊히지 않는다', () => {
      for (let index = 0; index < MEASURED_SIZE_LIMIT; index += 1) {
        rememberAttachmentSize(`att-${index}`, 100, 100);
      }
      rememberAttachmentSize('att-0', 200, 100);
      rememberAttachmentSize('att-new', 100, 100);
      expect(measuredAttachmentSize('att-0')).toEqual({width: 200, height: 100});
      expect(measuredAttachmentSize('att-1')).toBeNull();
    });

    it('시험 사이에는 비운다', () => {
      rememberAttachmentSize('att-a', 100, 100);
      resetAttachmentContentForTest();
      expect(measuredAttachmentSize('att-a')).toBeNull();
    });
  });

  // -----------------------------------------------------------------------------
  // ImageTile: 첫 프레임부터
  // -----------------------------------------------------------------------------
  describe('사진 한 장 — 새 마운트는 첫 프레임부터 잰 크기로 선다', () => {
    it('같은 첨부를 다시 마운트하면 첫 렌더가 이미 잰 비율이다(16:9 자리표시를 거치지 않는다)', async () => {
      const {calls, spy} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      // 처음 보는 그림: 자리표시로 시작한다.
      expect(frames[0]).toMatchObject({width: MAX_W, aspectRatio: 16 / 9});
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].success(4000, 3000));
      // 가로 4:3 → 폭 상한 280 안에서 280x210.
      expect(frameNow()).toMatchObject({width: 280, height: 210});
      expect(frameNow().aspectRatio).toBeUndefined();
      first.unmount();

      // 새 마운트(서버 사본·화면 밖에서 돌아온 행·다시 들어온 방).
      frames.length = 0;
      render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      expect(frames.length).toBeGreaterThan(0);
      // **첫 렌더**가 곧 잰 크기다.
      expect(frames[0]).toMatchObject({width: 280, height: 210});
      expect(frames[0].aspectRatio).toBeUndefined();
      // 렌더마다 같은 크기다 — 자리표시가 끼어든 프레임이 없다.
      for (const frame of frames) {
        expect(frame).toMatchObject({width: 280, height: 210});
        expect(frame.aspectRatio).toBeUndefined();
      }
      await ready();
      // 이미 잰 그림은 다시 재지 않는다.
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('세로 사진도 같다 — 3:4 는 240x320', async () => {
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('photo-solo')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].success(3000, 4000));
      expect(frameNow()).toMatchObject({width: 240, height: MAX_H});
      first.unmount();
      frames.length = 0;
      render(<AttachmentList channelId="ch" attachments={[photo('photo-solo')]} />);
      expect(frames[0]).toMatchObject({width: 240, height: 320});
    });

    it('아직 못 잰 다른 그림은 여전히 자리표시로 시작한다 — 잰 크기가 다른 첨부로 새지 않는다(기록 읽기 첫 통과)', async () => {
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].success(4000, 3000));
      first.unmount();

      frames.length = 0;
      render(<AttachmentList channelId="ch" attachments={[photo('photo-other')]} />);
      expect(frames[0]).toMatchObject({width: MAX_W, aspectRatio: 16 / 9});
      // 받고 나면 그 그림의 비율로 선다(기존 동작 그대로).
      await ready();
      await waitFor(() => expect(calls).toHaveLength(2));
      act(() => calls[1].success(1000, 1000));
      expect(frameNow()).toMatchObject({width: 280, height: 280});
      expect(measuredAttachmentSize('photo-a')).toEqual({width: 4000, height: 3000});
      expect(measuredAttachmentSize('photo-other')).toEqual({width: 1000, height: 1000});
    });

    it('첨부 id 의 대소문자가 달라도(메아리 대 서버 사본) 같은 그림이다', async () => {
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('PHOTO-A')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].success(4000, 3000));
      first.unmount();
      frames.length = 0;
      render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      expect(frames[0]).toMatchObject({width: 280, height: 210});
      await ready();
    });

    it('미리보기 캐시도 대소문자를 가리지 않는다(L13) — 같은 첨부·채널이 대소문자만 달라도 한 번만 내려받고 서버 사본이 곧바로 ready 로 선다', async () => {
      holdGetSize();
      const first = render(<AttachmentList channelId="CH-1" attachments={[photo('PHOTO-A')]} />);
      await ready();
      expect(fileSystem.__state.downloads).toHaveLength(1);
      first.unmount();
      // 서버 사본: 같은 사진인데 채널·첨부 id 의 대소문자가 다르다.
      render(<AttachmentList channelId="ch-1" attachments={[photo('photo-a')]} />);
      // 첫 렌더부터 ready 다(받아 오는 칸으로 서지 않는다).
      expect(screen.getAllByTestId('attachment-preview')[0].props.accessibilityValue.text).toBe('ready');
      await ready();
      expect(fileSystem.__state.downloads).toHaveLength(1);
    });

    it('잰 크기를 지우면(시험 사이·앱 재시작) 자리표시로 돌아간다', async () => {
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].success(4000, 3000));
      first.unmount();
      resetAttachmentContentForTest();
      frames.length = 0;
      render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      expect(frames[0]).toMatchObject({width: MAX_W, aspectRatio: 16 / 9});
      await ready();
    });

    it('여러 장(격자)은 잰 크기를 쓰지 않는다 — 정사각 칸 그대로', async () => {
      const {calls} = holdGetSize();
      rememberAttachmentSize('photo-a', 4000, 3000);
      rememberAttachmentSize('photo-b', 3000, 4000);
      const frames = recordPreviewFrames();
      render(<AttachmentList channelId="ch" attachments={[photo('photo-a'), photo('photo-b')]} />);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) expect(frame).toMatchObject({width: TILE, height: TILE});
      await ready();
      // 격자는 크기를 묻지도 않는다.
      expect(calls).toHaveLength(0);
    });

    it('크기를 못 읽으면(실패) 자리표시로 남고, 실패는 적지 않아서 다음 마운트가 다시 시도한다', async () => {
      const {calls} = holdGetSize();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].failure?.(new Error('unreadable')));
      expect(frameNow()).toMatchObject({width: MAX_W, aspectRatio: 16 / 9});
      expect(measuredAttachmentSize('photo-a')).toBeNull();
      first.unmount();
      render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(2));
    });

    it('마운트가 사라진 뒤에 크기가 돌아와도 잰 값은 남는다 — 다음 마운트가 첫 프레임부터 맞는다', async () => {
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      // 서버 사본이 서서 메아리가 사라진 뒤에야 재는 쪽이 답한다.
      first.unmount();
      act(() => calls[0].success(4000, 3000));
      expect(measuredAttachmentSize('photo-a')).toEqual({width: 4000, height: 3000});
      frames.length = 0;
      render(<AttachmentList channelId="ch" attachments={[photo('photo-a')]} />);
      expect(frames[0]).toMatchObject({width: 280, height: 210});
    });
  });

  // -----------------------------------------------------------------------------
  // 메아리 → 서버 사본 (H2 의 장면 그대로)
  // -----------------------------------------------------------------------------
  describe('보낸 사진 — 서버 사본의 첫 프레임이 메아리의 마지막 프레임과 같다', () => {
    const echo = (attachments: MessageAttachment[]): PendingMessage => ({
      clientMsgId: 'c-1',
      channelId: CHANNEL,
      authorMemberId: SELF,
      body: '',
      createdAtMs: NOW,
      sinceSeq: 9,
      status: 'sending',
      attachments,
    });

    it.each([
      ['가로 4:3', 4000, 3000, {width: 280, height: 210}],
      ['세로 3:4', 3000, 4000, {width: 240, height: 320}],
    ] as const)('%s: 메아리 타일이 잰 크기로 서버 사본이 선다(이전에는 16:9 로 서서 53~163pt 줄었다 자랐다)', async (_name, w, h, expected) => {
      jest
        .spyOn(Animated, 'timing')
        .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const file = photo('photo-sent');

      const pending = render(
        <FixedScheme scheme="dark">
          <PendingRow pending={echo([file])} startsGroup directory={DIRECTORY} />
        </FixedScheme>,
      );
      // 메아리 자신의 첫 타일은 처음 보는 그림이라 자리표시로 시작한다(교체 전, 목록 글라이드 안에서 일어나는 일 — base 와 같다).
      expect(frames[0]).toMatchObject({width: MAX_W, aspectRatio: 16 / 9});
      await ready();
      await waitFor(() => expect(calls).toHaveLength(1));
      act(() => calls[0].success(w, h));
      const echoFinal = frameNow();
      expect(echoFinal).toMatchObject(expected);
      pending.unmount();

      // 서버 사본이 선다 — 새 마운트.
      frames.length = 0;
      render(
        <FixedScheme scheme="dark">
          <MessageRow
            message={message({attachments: [file]})}
            startsGroup
            directory={DIRECTORY}
            chips={[]}
            nowMs={NOW + 60_000}
            actions={actions()}
          />
        </FixedScheme>,
      );
      // 서버 사본의 **첫 렌더**가 메아리의 마지막 프레임과 같은 크기다 → 교체 순간 행 높이 변화 0.
      expect(frames[0]).toMatchObject(expected);
      expect(frames[0].width).toBe(echoFinal.width);
      expect(frames[0].height).toBe(echoFinal.height);
      for (const frame of frames) expect(frame.aspectRatio).toBeUndefined();
      await ready();
    });
  });

  // -----------------------------------------------------------------------------
  // 기록 읽기·재진입 — Timeline 을 떠났다 돌아와도 첫 프레임부터 맞다
  // -----------------------------------------------------------------------------
  describe('기록 읽기 경로 — 방에 다시 들어와도 이미 본 사진은 첫 프레임부터 제 비율이다', () => {
    const history = [
      message({id: 'm1', seq: 1, authorMemberId: OTHER, body: '', attachments: [photo('hist-a')]}),
      message({id: 'm2', seq: 2, authorMemberId: OTHER, body: '', attachments: [photo('hist-b')]}),
    ];
    const timeline = (
      <Timeline
        messages={history}
        directory={DIRECTORY}
        status="ready"
        myMemberId={SELF}
        nowMs={NOW + 60_000}
        pending={[]}
      />
    );

    it('처음 읽을 때는 자리표시로 시작해 잰 뒤 제 비율이 되고, 다시 들어오면 둘 다 첫 렌더부터 제 비율이다', async () => {
      const {calls} = holdGetSize();
      const frames = recordPreviewFrames();
      const first = render(timeline);
      // 처음: 두 사진 모두 자리표시.
      expect(frames.length).toBeGreaterThan(0);
      expect(frames[0]).toMatchObject({aspectRatio: 16 / 9});
      await waitFor(() => expect(calls).toHaveLength(2));
      act(() => {
        calls[0].success(4000, 3000);
        calls[1].success(3000, 4000);
      });
      const sizes = screen.getAllByTestId('attachment-preview').map(node => flat(node.props.style));
      expect(sizes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({width: 280, height: 210}),
          expect.objectContaining({width: 240, height: 320}),
        ]),
      );
      first.unmount();

      // 다시 들어온 방.
      frames.length = 0;
      render(timeline);
      expect(frames.length).toBeGreaterThan(0);
      for (const frame of frames) {
        expect(frame.aspectRatio).toBeUndefined();
        expect([`${frame.width}x${frame.height}`]).toEqual(
          expect.arrayContaining([expect.stringMatching(/^(280x210|240x320)$/)]),
        );
      }
      await ready();
      // 다시 재지 않았다.
      expect(calls).toHaveLength(2);
    });
  });
});

// =============================================================================
// 사진 뷰어의 보낸 사람·시각 (#4297) — 행이 목록에 넘기고, 목록이 뷰어에 넘긴다. 이음매가 세 개(행 → 목록 → 뷰어)라 화면에서 끝까지 읽는다.
// =============================================================================
describe('사진 뷰어에 보낸 사람·시각이 선다 (#4297)', () => {
  interface FileSystemMock {
    __reset: () => void;
  }
  const fileSystem = jest.requireMock('expo-file-system') as FileSystemMock;
  /** 지역 시간으로 지어 시험이 어느 시간대에서 돌아도 같은 글이 된다. */
  const SENT_AT = new Date(2026, 9, 29, 14, 55).getTime();
  const FILE: MessageAttachment = {id: 'att-4297', name: '현장.png', mime: 'image/png', sizeBytes: 4096};

  beforeEach(() => {
    fileSystem.__reset();
    resetAttachmentContentForTest();
  });

  afterEach(async () => {
    await drainRender();
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    cleanup();
  });

  async function openViewer() {
    fireEvent.press(screen.getByTestId('attachment-item'));
    await screen.findByTestId('attachment-viewer-image');
    // #4775: sender/time controls become accessible after measurement and the opening hero.
    await screen.findByTestId('attachment-viewer-bar');
  }

  it('받은 사진을 열면 보낸 사람 이름과 보낸 시각이 위쪽 띠에 선다', async () => {
    const message: Message = {
      id: 'msg-4297',
      channelId: CHANNEL,
      seq: 7,
      hlcTs: 7,
      hlcCount: 0,
      authorMemberId: OTHER,
      type: 'text',
      body: '',
      state: 'sent',
      createdAtMs: SENT_AT,
      attachments: [FILE],
    };
    render(<MessageRow message={message} startsGroup directory={DIRECTORY} chips={[]} nowMs={SENT_AT} />);
    await openViewer();
    expect(screen.getByTestId('attachment-viewer-sender').props.children).toBe('이도현');
    expect(screen.getByTestId('attachment-viewer-sent-at').props.children).toBe('2026년 10월 29일 14:55');
  });

  it('보낸 사진의 메아리도 같다 — 내 이름과 보낸 시각이고, 서버 사본이 대체해도 띠가 같다', async () => {
    const pending: PendingMessage = {
      clientMsgId: 'c-4297',
      channelId: CHANNEL,
      authorMemberId: SELF,
      body: '',
      createdAtMs: SENT_AT,
      sinceSeq: 6,
      status: 'sending',
      attachments: [FILE],
    };
    render(<PendingRow pending={pending} startsGroup directory={DIRECTORY} />);
    await openViewer();
    expect(screen.getByTestId('attachment-viewer-sender').props.children).toBe('박서연');
    expect(screen.getByTestId('attachment-viewer-sent-at').props.children).toBe('2026년 10월 29일 14:55');
  });
});
