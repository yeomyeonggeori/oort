import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react-native';
import React, {useMemo} from 'react';
import {StyleSheet} from 'react-native';

import {Composer} from '../src/features/conversation/Composer';
import {CONV} from '../src/features/conversation/convDesign';
import {
  MessageRow,
  type MessageRowActions,
} from '../src/features/conversation/MessageRow';
import {useReplyDraft} from '../src/features/conversation/useReplyDraft';
import {createMobileLocaleController} from '../src/i18n/controller';
import {MobileLocaleProvider} from '../src/i18n/LocaleProvider';
import {finger} from './fixtures/finger';

// =============================================================================
// 입력칸의 답글 머리말과 보내기 (#4869).
//
// 하네스는 **진짜** 부품만 쓴다: 진짜 `MessageRow`(밀기 컨테이너 포함)·진짜 `Composer`·진짜 `useReplyDraft`. 가짜는 서버 쪽 둘
// (`sendThreadReply` = `timeline.sendReply`, 평범한 보내기)과 스레드를 여는 `onOpenThread` 뿐이다 — 「대화 화면에 머문다」는
// `onOpenThread` 가 한 번도 안 불리는 것으로 잰다. 보내기 분기는 `ConversationScreen.onSend` 의 첫 줄과 같은 한 줄이다
// (`if (reply.sendReply(body, options)) return;`). 화면 전체를 올리는 시험은 셸·서버 대역이 수백 줄이라 하지 않았다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const REPLY_ID = 'cccccccc-1111-4111-8111-cccccccccccc';
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
  member({id: SELF, displayName: '이서준', handle: 'seojun'}),
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(over: Partial<Message> = {}): Message {
  return {
    id: ROOT_ID,
    channelId: 'ch',
    seq: 10,
    hlcTs: 10,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: '그건 배포 뒤에 봅시다',
    state: 'sent',
    createdAtMs: BASE_MS,
    ...over,
  };
}

const ROOT = message();
const REPLY = message({
  id: REPLY_ID,
  rootId: ROOT_ID,
  seq: 11,
  authorMemberId: SELF,
  body: '금요일은 어때요',
});

interface Senders {
  sendThreadReply: jest.Mock<Promise<void>, [string, string, MessageAttachment[] | undefined]>;
  plainSend: jest.Mock;
  onOpenThread: jest.Mock;
  onStarted: jest.Mock;
}

function senders(): Senders {
  return {
    sendThreadReply: jest.fn().mockResolvedValue(undefined),
    plainSend: jest.fn(),
    onOpenThread: jest.fn(),
    onStarted: jest.fn(),
  };
}

function Harness({
  messages,
  channelId = 'ch',
  fake,
}: {
  messages: Message[];
  channelId?: string;
  fake: Senders;
}): React.JSX.Element {
  const reply = useReplyDraft({
    channelId,
    messages,
    myMemberId: SELF,
    sendThreadReply: fake.sendThreadReply,
    onStarted: fake.onStarted,
  });
  const actions = useMemo<MessageRowActions>(
    () => ({
      myMemberId: SELF,
      onToggleReaction: async () => {},
      onEdit: async () => {},
      onDelete: async () => {},
      onOpenThread: fake.onOpenThread,
      onReplyInline: reply.startReply,
    }),
    [fake.onOpenThread, reply.startReply],
  );
  return (
    <>
      {messages.map(row => (
        <MessageRow
          key={row.id}
          message={row}
          startsGroup
          directory={DIRECTORY}
          chips={[]}
          nowMs={BASE_MS + 60_000}
          actions={actions}
        />
      ))}
      <Composer
        recipient="place"
        channelLabel="일반"
        directory={DIRECTORY}
        replyTarget={reply.replyTarget}
        onCancelReply={reply.cancelReply}
        onSend={(body, options) => {
          if (reply.sendReply(body, options)) return;
          fake.plainSend(body);
        }}
      />
    </>
  );
}

/** 목록의 `index` 번째 행을 오른쪽→왼쪽으로 문턱 넘게 민다. */
function swipeRow(index: number) {
  const target = screen.getAllByTestId('reply-swipe')[index] as unknown as {
    props: Record<string, (event: unknown) => unknown>;
  };
  const touch = finger(target);
  touch.down(300, 400);
  touch.move(250, 400);
  touch.move(200, 400);
  touch.up();
}

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  act(() => {
    jest.runOnlyPendingTimers();
  });
  jest.useRealTimers();
  cleanup();
});

describe('머리말', () => {
  it('밀면 입력칸 위에 머리말이 붙는다 — 「○○님에게 답글」·원문·「답글 입력」, 내 글은 「내 글에 답글」', () => {
    // 글 없는 메시지의 대체 글(사진·파일·이모티콘)은 `replyTarget.test.ts` 가 잰다 — 사진 행을 그리려면 세션·서버 대역이 든다.
    render(<Harness messages={[ROOT, REPLY]} fake={senders()} />);
    expect(screen.queryByTestId('reply-draft-card')).toBeNull();
    // 대조: 걸리기 전에는 보통의 입력칸이다.
    expect(screen.getByTestId('composer-input').props.placeholder).not.toBe('답글 입력');

    swipeRow(0);
    expect(screen.getByTestId('reply-draft-header').props.children).toBe('김인턴님에게 답글');
    expect(screen.getByTestId('reply-draft-excerpt').props.children).toBe('그건 배포 뒤에 봅시다');
    expect(screen.getByTestId('composer-input').props.placeholder).toBe('답글 입력');
    // 두 줄이 한 접근성 원소로 읽힌다.
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();

    swipeRow(1); // 내 글
    expect(screen.getByTestId('reply-draft-header').props.children).toBe('내 글에 답글');
    expect(screen.getByTestId('reply-draft-excerpt').props.children).toBe('금요일은 어때요');
  });

  it('앱 언어가 영어면 같은 대상이 영어로 말한다 — 문구는 사전의 것이다', async () => {
    const controller = await createMobileLocaleController({
      port: {
        readPreference: () => 'en-US',
        writePreference: () => {},
        readDevice: () => ({languages: ['en-US'], timeZone: 'UTC'}),
      },
    });
    render(
      <MobileLocaleProvider createController={async () => controller}>
        <Harness messages={[ROOT, REPLY]} fake={senders()} />
      </MobileLocaleProvider>,
    );
    await waitFor(() => expect(screen.getAllByTestId('reply-swipe')).toHaveLength(2));
    swipeRow(0);
    expect(screen.getByTestId('reply-draft-header').props.children).toBe('Reply to 김인턴');
    expect(screen.getByTestId('composer-input').props.placeholder).toBe('Write a reply');
    expect(screen.getByTestId('reply-draft-cancel').props.accessibilityLabel).toBe('Cancel reply');
    controller.dispose();
  });

  it('✕ 는 대상만 지우고 쓴 글은 남긴다', () => {
    const fake = senders();
    render(<Harness messages={[ROOT]} fake={fake} />);
    swipeRow(0);
    fireEvent.changeText(screen.getByTestId('composer-input'), '금요일에 배포합니다');
    expect(screen.getByTestId('reply-draft-cancel').props.accessibilityLabel).toBe('답글 취소');

    fireEvent.press(screen.getByTestId('reply-draft-cancel'));
    expect(screen.queryByTestId('reply-draft-card')).toBeNull();
    expect(screen.getByTestId('composer-input').props.value).toBe('금요일에 배포합니다');
    expect(screen.getByTestId('composer-input').props.placeholder).not.toBe('답글 입력');

    // 대상이 떨어진 뒤의 보내기는 평범한 채널 글이다.
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(fake.plainSend).toHaveBeenCalledWith('금요일에 배포합니다');
    expect(fake.sendThreadReply).not.toHaveBeenCalled();
  });
});

describe('보내기', () => {
  it('답글 행을 밀고 보내면 그 스레드의 루트(rootId)에 달리고, 대상이 떨어지며, 스레드 화면은 열리지 않는다', () => {
    const fake = senders();
    render(<Harness messages={[ROOT, REPLY]} fake={fake} />);
    swipeRow(1); // 이미 스레드 답글인 행
    expect(fake.onStarted).toHaveBeenCalledTimes(1);

    fireEvent.changeText(screen.getByTestId('composer-input'), '네 그날로 해요');
    fireEvent.press(screen.getByTestId('composer-send'));

    expect(fake.sendThreadReply).toHaveBeenCalledTimes(1);
    expect(fake.sendThreadReply).toHaveBeenCalledWith(ROOT_ID, '네 그날로 해요', undefined);
    expect(fake.sendThreadReply.mock.calls[0][0]).not.toBe(REPLY_ID); // 행 id 가 아니라 루트
    expect(fake.plainSend).not.toHaveBeenCalled();
    expect(fake.onOpenThread).not.toHaveBeenCalled(); // 대화 화면에 머문다
    expect(screen.queryByTestId('reply-draft-card')).toBeNull(); // 보낸 순간 떨어진다
    expect(screen.getByTestId('composer-input').props.value).toBe('');

    // 다음 줄은 같은 스레드로 가지 않는다.
    fireEvent.changeText(screen.getByTestId('composer-input'), '다음 안건');
    fireEvent.press(screen.getByTestId('composer-send'));
    expect(fake.plainSend).toHaveBeenCalledWith('다음 안건');
    expect(fake.sendThreadReply).toHaveBeenCalledTimes(1);
  });

  it('밀 수 없는 행은 대상이 되지 않고, 채널을 옮기거나 대상·루트가 지워지면 조용히 떨어진다', () => {
    const fake = senders();
    const approval = message({id: 'eeeeeeee-1111-4111-8111-eeeeeeeeeeee', seq: 13, type: 'approval_request'});
    const view = render(<Harness messages={[ROOT, REPLY, approval]} fake={fake} />);
    swipeRow(2);
    expect(screen.queryByTestId('reply-draft-card')).toBeNull();
    expect(fake.onStarted).not.toHaveBeenCalled();

    swipeRow(1);
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();
    // 루트가 지워졌다 — 서버가 지워진 루트에 다는 답글을 거절하므로 대상을 뗀다.
    view.rerender(
      <Harness
        messages={[{...ROOT, state: 'deleted', body: undefined, deletedAtMs: BASE_MS}, REPLY, approval]}
        fake={fake}
      />,
    );
    expect(screen.queryByTestId('reply-draft-card')).toBeNull();

    swipeRow(1);
    expect(screen.queryByTestId('reply-draft-card')).toBeNull(); // 루트가 지워진 스레드의 답글 행은 그 자리에서 다시 걸 수 없다
    view.rerender(<Harness messages={[ROOT, REPLY, approval]} fake={fake} />);
    swipeRow(0);
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();
    // 채널을 옮기면 이 대상은 다른 방의 것이다.
    view.rerender(<Harness messages={[ROOT, REPLY, approval]} channelId="other" fake={fake} />);
    expect(screen.queryByTestId('reply-draft-card')).toBeNull();
  });
});

// =============================================================================
// 머리말의 글자 열 (#5067, design-review M2) — 입력창의 **지금 배치**와 같은 선.
//
// 제스트에는 레이아웃 엔진이 없다. 그래서 두 글자의 x 를 **스타일에서 도출**한다: 알약 상자 안에서 글자까지 가는 길(호스트 조상)의 왼쪽 바깥 여백 + 테두리 + 안쪽 여백을
// 더한다. 입력창은 `composer-bar`(줄 여백) → `composer-field`(글 칸 들여쓰기, 접힘 36 / 펼침 0) → `composer-input`(테두리 + 안쪽 여백) 이고, 머리말은 `reply-draft-card`(`textLeft`)
// → 글 상자 → 글이다. 가로 줄(`flexDirection: 'row'`) 조상에서는 글로 가는 가지가 **첫 자식**이 아니면 던진다 — 앞선 형제가 x 를 미는데 이 도구는 그 폭을 못 잰다.
// 그 사실을 조용히 지나가지 않는다.
// =============================================================================

type TestNode = ReturnType<typeof screen.getByTestId>;

const flatStyle = (style: unknown) =>
  (StyleSheet.flatten(style as never) ?? {}) as Record<string, number | string | undefined>;
const px = (value: unknown) => (typeof value === 'number' ? value : 0);

/** `target` 글자의 시작이 `rootTestID` 상자 **안쪽 왼쪽**에서 얼마나 떨어져 있는가(pt). */
function textStartWithin(target: TestNode, rootTestID: string): number {
  const root = screen.getByTestId(rootTestID);
  const own = flatStyle(target.props.style);
  // 자기 바깥 여백 + (입력창이면) 자기 테두리와 안쪽 여백까지가 글자의 시작이다.
  let x =
    px(own.marginLeft) +
    px(own.borderLeftWidth ?? own.borderWidth) +
    px(own.paddingLeft ?? own.paddingHorizontal);
  let pathChild: TestNode = target;
  for (let at = target.parent; at !== null; pathChild = at, at = at.parent) {
    if (at === root) return x;
    if (typeof at.type !== 'string') continue; // 합성 부품의 스타일은 아래 호스트가 한 번만 센다.
    const style = flatStyle(at.props.style);
    x +=
      px(style.marginLeft) +
      px(style.borderLeftWidth ?? style.borderWidth) +
      px(style.paddingLeft ?? style.paddingHorizontal);
    if (style.flexDirection === 'row' && at.children[0] !== pathChild) {
      throw new Error(`가로 줄 ${String(at.props.testID)} 에서 글로 가는 가지가 첫 자식이 아니다 — 이 도구는 앞선 형제의 폭을 못 잰다`);
    }
  }
  throw new Error(`${rootTestID} 아래에 있지 않다`);
}

describe('머리말의 글자 열 (#5067)', () => {
  const headerX = () => textStartWithin(screen.getByTestId('reply-draft-header'), 'composer-pill');
  const inputX = () => textStartWithin(screen.getByTestId('composer-input'), 'composer-pill');
  const focus = () => fireEvent(screen.getByTestId('composer-input'), 'focus');
  const blur = () => fireEvent(screen.getByTestId('composer-input'), 'blur');
  const frames = (count: number) =>
    act(() => {
      jest.advanceTimersByTime(16 * count);
    });
  const settle = () =>
    act(() => {
      jest.advanceTimersByTime(500);
    });
  const mountReply = () => {
    render(<Harness messages={[ROOT]} fake={senders()} />);
    swipeRow(0);
    expect(screen.getByTestId('reply-draft-card')).toBeTruthy();
  };

  it('접힌 한 줄 입력창 — 머리말 글자와 입력 글자가 같은 선이고, 그 선은 + 원 오른쪽이다', () => {
    mountReply();
    expect(screen.queryByTestId('composer-tools')).toBeNull(); // 접힘: 도구 줄이 없다
    expect(inputX()).toBeGreaterThan(CONV.composerCircle);
    expect(headerX()).toBeCloseTo(inputX(), 5);
  });

  it('초점이 들어 펼친 입력창 — 같은 선이고, 접힘보다 + 원 하나(36) 만큼 가장자리 쪽이다', () => {
    mountReply();
    const collapsedLine = inputX();
    focus();
    settle();
    expect(screen.getByTestId('composer-tools')).toBeTruthy(); // 펼쳤다
    expect(headerX()).toBeCloseTo(inputX(), 5);
    expect(collapsedLine - inputX()).toBeCloseTo(CONV.composerCircle, 5);
    expect(inputX()).toBeLessThan(CONV.composerCircle);
  });

  it('초점 없이 글이 있어 펼친 입력창도 같은 선이다', () => {
    mountReply();
    fireEvent.changeText(screen.getByTestId('composer-input'), '금요일에 배포합니다');
    settle();
    expect(screen.getByTestId('composer-tools')).toBeTruthy();
    expect(headerX()).toBeCloseTo(inputX(), 5);
    expect(inputX()).toBeLessThan(CONV.composerCircle);
  });

  it('펼치고 접는 스프링의 매 프레임에서 같은 선이다 — 선은 실제로 움직인다', () => {
    mountReply();
    const lines: number[] = [];
    const check = () => {
      expect(headerX()).toBeCloseTo(inputX(), 5);
      lines.push(inputX());
    };
    check();
    focus();
    for (let frame = 0; frame < 24; frame += 1) {
      frames(1);
      check();
    }
    blur();
    for (let frame = 0; frame < 24; frame += 1) {
      frames(1);
      check();
    }
    settle();
    check();
    // 대조: 단정이 움직이는 값을 쟀다 — 접힘 끝(36 만큼 안쪽)과 펼침 끝 사이의 중간 값이 여럿 있고, 처음과 끝은 같은 접힘이다.
    const distinct = new Set(lines.map(line => Math.round(line * 10)));
    expect(distinct.size).toBeGreaterThan(6);
    expect(Math.max(...lines) - Math.min(...lines)).toBeCloseTo(CONV.composerCircle, 0);
    expect(lines[0]).toBeCloseTo(lines[lines.length - 1], 5);
  });
});
