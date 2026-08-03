import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React from 'react';
import {FlatList} from 'react-native';

import {ThreadPanel} from '../src/features/conversation/ThreadPanel';
import type {UseTimelineResult} from '../src/features/conversation/useTimeline';

// =============================================================================
// 스레드에서 보낸 내 답글은 어디로 갔나 (goal RN-U1 결함 4).
//
// 성재, iPhone 17: "스레드에서도 뭔가 채팅을 하면 위에 숨겨져 있어서 채팅 닫아야
// 보이더라."
//
// 티켓의 진단은 "RN-P3 의 자가전송 수정이 스레드 패널에 안 들어갔다" 였고, **그것은
// 사실이 아니다.** 이 파일의 첫 describe 가 그것을 잰다: 스레드도 채널과 **같은
// `Timeline` 인스턴스**를 쓰고, `ThreadPanel` 은 처음 쓰인 날부터 `selfSendToken` 을
// 넘겨 왔다(RN-C5, 49a524f6). 답글을 보내면 보정은 채널에서와 똑같이 돈다.
//
// 진짜 원인은 스레드에 대한 것이 아니라 **짧은 대화**에 대한 것이었고, 산수로 나온다:
//
//   내용이 뷰포트보다 짧은 `FlatList` 는 내용을 **위에** 그리고 스크롤할 것이 없다 —
//   `scrollToEnd` 는 올바르게 아무 일도 하지 않는다. 그런데 `ConversationLayout` 은
//   `overflow: 'hidden'` 클립 아래에서 팬 전체를 키보드 높이만큼 들어 올린다.
//   아이폰 17에서 그 리프트는 302pt(키보드 336 − 홈 인디케이터 34)이고, 리스트의
//   윗변은 ~103pt(세이프에어리어+헤더)에 있으며, 루트 하나와 답글 하나짜리 스레드는
//   ~120pt다. 그 모든 점이 **음수 y** 로 간다. 대화는 접힌 아래에 있는 것이 아니라
//   화면 **위로** 나가 있었다 — 그래서 "위에 숨겨져" 이고, 그래서 키보드를 닫으면
//   돌아왔다.
//
// 스레드에서 먼저 터진 것은 스레드가 거의 항상 짧기 때문이지, 스레드여서가 아니다.
// 메시지 세 개짜리 채널도 똑같고, 그것은 사람이 첫날에 만나는 화면이다. 그래서 수정은
// 공유 컴포넌트인 `Timeline` 에 들어간다(`contentContainerStyle` — 짧으면 바닥에
// 붙고, 길면 `flexGrow` 가 나눠 줄 여백이 없어 아무것도 바뀌지 않는다).
//
// **픽셀은 여기서 잴 수 없다.** Jest 렌더러에는 레이아웃이 없다. 이 파일이 지키는
// 것은 규칙이고, 숫자는 시뮬레이터에서 `measure/` 가 낸다 — 이 배치의 PR 에 그대로
// 적혀 있다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const OTHER = 'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb';
const ROOT_ID = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;
const NEWEST_SEQ = 30;

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
  member({id: OTHER, displayName: '김인턴', handle: 'intern-kim'}),
]);

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `${seq}번째`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
    ...over,
  };
}

const ROOT = message(10, {id: ROOT_ID});
const REPLIES = Array.from({length: 20}, (_, i) =>
  message(11 + i, {rootId: ROOT_ID}),
);

/**
 * `ThreadPanel` 이 실제로 쓰는 만큼의 `useTimeline`.
 *
 * 답글 전송만 진짜로 움직인다: `sendReply` 가 낙관적 에코를 밀어 넣고, 패널은
 * `repliesPending(root.id)` 로 그것을 다시 읽는다 — 앱에서 벌어지는 순서 그대로다.
 */
function Harness({
  replies = REPLIES,
  onReplySent,
}: {
  replies?: Message[];
  onReplySent?: () => void;
}): React.JSX.Element {
  const [pending, setPending] = React.useState<PendingMessage[]>([]);
  const timeline = React.useMemo<UseTimelineResult>(
    () =>
      ({
        state: {
          messages: [ROOT, ...replies],
          oldestSeq: ROOT.seq,
          newestSeq: NEWEST_SEQ,
        },
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
        sendReply: async (_rootId: string, body: string) => {
          setPending(list => [
            ...list,
            {
              clientMsgId: `client-${list.length}`,
              channelId: 'ch',
              authorMemberId: SELF,
              body,
              createdAtMs: BASE_MS + 999_000,
              // 채널의 최신 seq — 실제 `sendReply` 가 스탬프하는 값이다.
              sinceSeq: NEWEST_SEQ,
              status: 'sending',
            },
          ]);
        },
        repliesPending: () => pending,
        loadOlder: async () => {},
        reload: () => {},
        loadingOlder: false,
        reachedStart: true,
        reactions: {},
      }) as unknown as UseTimelineResult,
    [pending, replies],
  );
  return (
    <ThreadPanel
      root={ROOT}
      timeline={timeline}
      directory={DIRECTORY}
      myMemberId={SELF}
      nowMs={BASE_MS + 60_000}
      onClose={() => {}}
      onReplySent={onReplySent}
    />
  );
}

/** 리스트가 처음으로 자기 길이를 말하는 순간 — 열자마자 끝으로 가는 그 스크롤. */
function settleInitialLayout() {
  fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 390, 4000);
}

/** 위로 올라가 읽는 중. `following` 이 꺼진다 — 결함이 필요로 했던 조건. */
function scrollAwayFromBottom() {
  fireEvent.scroll(screen.getByTestId('timeline-list'), {
    nativeEvent: {
      contentOffset: {y: 0},
      contentSize: {height: 4000, width: 390},
      layoutMeasurement: {height: 800, width: 390},
    },
  });
}

/** 자가전송 스크롤은 한 프레임 미뤄져 있다 — 삽입된 행이 높이를 갖게 한 뒤에 잰다. */
async function flushFrame() {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function reply(body = '답글입니다') {
  fireEvent.changeText(screen.getByTestId('composer-input'), body);
  await act(async () => {
    fireEvent.press(screen.getByTestId('composer-send'));
  });
  await flushFrame();
}

afterEach(cleanup);

// -----------------------------------------------------------------------------

describe('스레드도 채널과 같은 자가전송 규칙을 쓴다 (이미 그랬다)', () => {
  it('읽던 자리가 끝이 아니어도 내 답글로 데려간다', async () => {
    const spy = jest.spyOn(FlatList.prototype, 'scrollToEnd');
    render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    settleInitialLayout();
    scrollAwayFromBottom();
    spy.mockClear();

    await reply();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('연달아 두 번 답글을 달면 두 번 다 따라간다', async () => {
    // 토큰이 카운터인 이유. 불리언이었다면 두 번째 답글은 아무 일도 일으키지 않는다.
    const spy = jest.spyOn(FlatList.prototype, 'scrollToEnd');
    render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    settleInitialLayout();
    scrollAwayFromBottom();

    for (const body of ['첫 답글', '둘째 답글']) {
      spy.mockClear();
      await reply(body);
      expect(spy).toHaveBeenCalled();
    }
    spy.mockRestore();
  });

  it('채널도 함께 따라간다 — 패널을 닫으면 그것이 채널의 마지막 줄이다', async () => {
    const onReplySent = jest.fn();
    render(<Harness onReplySent={onReplySent} />);
    await act(async () => {
      await Promise.resolve();
    });

    await reply();
    expect(onReplySent).toHaveBeenCalledTimes(1);
  });

  it('스레드를 여는 것만으로는 따라가지 않는다', async () => {
    const spy = jest.spyOn(FlatList.prototype, 'scrollToEnd');
    render(<Harness />);
    await act(async () => {
      await Promise.resolve();
    });
    // 최초 위치 잡기(contentSizeChange)를 빼면 토큰 0 이 「방금 보냈다」로 읽혀서는
    // 안 된다 — 그러면 열자마자 스크롤이 최초 위치 잡기와 다툰다.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('그래서 원인은 짧은 대화의 정렬이었다', () => {
  it('답글 하나짜리 스레드도 바닥 정렬을 쓴다 — 리프트가 닿지 못하는 자리', () => {
    // 이 한 줄이 결함 4다. 위로 정렬돼 있으면 이 스레드(루트+답글 하나)는 통째로
    // 헤더 위로 밀려 나간다. 픽셀은 `measure/` 가 시뮬레이터에서 재고, 여기서는
    // 그 숫자가 성립하기 위한 전제를 지킨다.
    render(<Harness replies={[REPLIES[0]]} />);
    expect(
      screen.getByTestId('timeline-list').props.contentContainerStyle,
    ).toEqual({flexGrow: 1, justifyContent: 'flex-end'});
  });

  it('스레드에서도 끌면 키보드가 내려간다', () => {
    // 결함 1 은 채널만의 것이 아니었다. 스레드 컴포저도 똑같이 열리고, 똑같이 닫을
    // 길이 없었다 — 같은 `Timeline` 이므로 같은 수정을 받는다.
    render(<Harness />);
    expect(screen.getByTestId('timeline-list').props.keyboardDismissMode).toBe(
      'on-drag',
    );
  });
});
