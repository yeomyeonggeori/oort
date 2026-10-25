import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage, TimelineItem} from '@momo/core/features/timeline/model';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, StyleSheet, View} from 'react-native';

import {SEND_ARRIVE_HOLD_SLACK_MS, SEND_ARRIVE_MS} from '../src/design/motion';
import {FixedScheme} from '../src/design/theme';
import {resetAttachmentContentForTest} from '../src/features/attachments/content';
import {MessageRow, type MessageRowActions} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {
  carriesInlinePhoto,
  ECHO_LINGER_MS,
  isStandbyItem,
  markArrived,
  photoEchoesOf,
  resetArrivedForTest,
  sameEchoes,
  settledEchoes,
  withLingeringEchoes,
} from '../src/features/conversation/sendArrival';

// =============================================================================
// #4455 design-review r3 H3 — 사진은 서버 사본을 눈에 안 보이는 채 먼저 마운트해 두고 메아리를 잠깐 더 남긴다.
//
// 서버 사본은 새 마운트라 사진 타일의 `<Image>` 도 새로 서고, 새 네이티브 이미지 뷰는 첫 프레임에 안 그려져 타일이 한 프레임
// (8~23ms) 빈 면으로 번쩍였다(레이아웃 지표 0 — 칠만 빈다). JS 에서 첫 페인트를 앞당길 길이 없으니 **새 뷰가 보이기 전에 미리
// 마운트해 그려 둔다**: 메아리는 그 항목 그대로(같은 키·인덱스·인스턴스) `ECHO_LINGER_MS` 더 남고, 확정본은 그 뒤에 대기 상태
// (`standby`: 높이 0 · 투명 · 눌림·낭독 없음)로 서 있다가, 창이 끝나는 한 커밋에 메아리가 걷히며 드러난다. 여기서 재는 것:
//   1. 순수 함수(사진 판정·짝 짓기·끼워 넣는 자리·확정본 없는 것은 버림·참조 보존)
//   2. `MessageRow` 의 대기 모드(레이아웃 0·투명·눌림/낭독 없음·위 여백 없음, 보통 행은 그대로, 인스턴스가 드러남으로 이어짐)
//   3. `Timeline`: 보류가 풀리는 **그 커밋에** 메아리가 남고 서버 사본이 대기로 선다(보류 경로·보류 없는 경로·느린 확정),
//      메아리 인스턴스는 새 마운트가 아니며, 창이 끝나면 걷히고, 글자·파일 행에는 없다
// jest 는 레이아웃이 없어서 `VirtualizedList` 가 늘어난 꼬리의 셀을 그리지 않는다 — 목록 **데이터**(키·`standby` 표지)와 원래
// 있던 메아리 셀을 단정하고, 대기 행의 모양은 2 에서 따로 잰다.
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
const OTHER = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const NOW = 1_700_000_000_000;
const HOLD_MS = SEND_ARRIVE_MS + SEND_ARRIVE_HOLD_SLACK_MS;

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
  member({id: SELF, displayName: '박서연', handle: 'seoyeon'}),
  member({id: OTHER, displayName: '이도현', handle: 'dohyeon'}),
]);

const photo = (id: string, over: Partial<MessageAttachment> = {}): MessageAttachment => ({
  id,
  name: `${id}.png`,
  mime: 'image/png',
  sizeBytes: 4096,
  ...over,
});
const FILE_CARD: MessageAttachment = {id: 'file-1', name: '배포-결과.pdf', mime: 'application/pdf', sizeBytes: 2048};

function message(seq: number, over: Partial<Message> = {}): Message {
  return {
    id: `msg-${seq}`,
    channelId: 'ch',
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `메시지 ${seq}`,
    state: 'sent',
    createdAtMs: NOW - 600_000 + seq * 1000,
    ...over,
  };
}

function echo(over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '',
    createdAtMs: NOW,
    sinceSeq: 2,
    status: 'sending',
    attachments: [photo('photo-a')],
    ...over,
  };
}

/** 내가 보낸 사진의 확정본. */
const mine = (seq: number, over: Partial<Message> = {}): Message =>
  message(seq, {authorMemberId: SELF, body: '', createdAtMs: NOW + 100, attachments: [photo('photo-a')], ...over});

const item = (m: Message, startsGroup = true): TimelineItem => ({
  kind: 'message',
  key: `m-${m.seq}`,
  message: m,
  startsGroup,
});

const echoItem = (pending: PendingMessage, startsGroup = true): Extract<TimelineItem, {kind: 'pending'}> => ({
  kind: 'pending',
  key: `p-${pending.clientMsgId}`,
  pending,
  startsGroup,
});

const flat = (style: unknown): Record<string, any> => (StyleSheet.flatten(style as never) ?? {}) as Record<string, any>;

function spyTiming() {
  return jest
    .spyOn(Animated, 'timing')
    .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
}

/** 미리보기 칸(`attachment-preview`)의 **인스턴스**를 모은다 — 같은 인스턴스가 이어지는지(새 마운트가 아닌지) 본다. */
function trackTiles() {
  const instances = new Set<unknown>();
  const original = View.prototype.render;
  jest.spyOn(View.prototype, 'render').mockImplementation(function (this: {props: {testID?: string}}) {
    if (this.props.testID === 'attachment-preview') instances.add(this);
    return original.call(this);
  } as never);
  return instances;
}

/** 미리보기를 받아 오는 비동기(첨부 내려받기)가 act 밖에서 상태를 건드려 경고가 나지 않게 act 안에서 비운다. */
const settle = () =>
  act(async () => {
    for (let tick = 0; tick < 20; tick += 1) await Promise.resolve();
  });

let consoleErrors: string[] = [];

beforeEach(() => {
  fileSystem.__reset();
  resetAttachmentContentForTest();
  resetArrivedForTest();
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
});
afterEach(async () => {
  await settle();
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetArrivedForTest();
  expect(consoleErrors).toEqual([]);
});

// -----------------------------------------------------------------------------
// 1. 순수 함수
// -----------------------------------------------------------------------------
describe('사진 메아리를 남기는 순수 함수', () => {
  it('사진 판정: 인라인 사진이 하나라도 있어야 한다 — 글자·파일 카드·SVG·첨부 없음은 아니다', () => {
    expect(carriesInlinePhoto(echo())).toBe(true);
    expect(carriesInlinePhoto(echo({body: '설명', attachments: [FILE_CARD, photo('p2')]}))).toBe(true);
    expect(carriesInlinePhoto(echo({attachments: [FILE_CARD]}))).toBe(false);
    expect(carriesInlinePhoto(echo({attachments: []}))).toBe(false);
    expect(carriesInlinePhoto(echo({body: '글자만', attachments: undefined}))).toBe(false);
    expect(carriesInlinePhoto(echo({attachments: [photo('svg', {mime: 'image/svg+xml'})]}))).toBe(false);
  });

  it('photoEchoesOf: 서 있는 사진 메아리만 모은다 — 글자 메아리·확정본은 뺀다', () => {
    const photoEcho = echoItem(echo({clientMsgId: 'c-photo'}));
    const textEcho = echoItem(echo({clientMsgId: 'c-text', body: '글자', attachments: undefined}));
    expect(photoEchoesOf([item(message(1)), photoEcho, textEcho])).toEqual([photoEcho]);
    expect(isStandbyItem({...item(message(1)), standby: true})).toBe(true);
    expect(isStandbyItem(item(message(1)))).toBe(false);
    expect(isStandbyItem(null)).toBe(false);
  });

  it('sameEchoes: 키와 보낸 사본의 동일성으로 같은 목록을 가린다', () => {
    const a = echoItem(echo({clientMsgId: 'c-1'}));
    const b = echoItem(echo({clientMsgId: 'c-2'}));
    expect(sameEchoes([a], [a])).toBe(true);
    expect(sameEchoes([a], [{...a}])).toBe(true);
    expect(sameEchoes([a], [b])).toBe(false);
    expect(sameEchoes([a], [a, b])).toBe(false);
    expect(sameEchoes([], [])).toBe(true);
    expect(sameEchoes([a], [{...a, pending: {...a.pending}}])).toBe(false);
  });

  it('settledEchoes: 확정본이 이미 서 있는 것만 — 확정본 없이 사라진 것(방을 옮김)은 남기지 않는다', () => {
    const settled = echoItem(echo({clientMsgId: 'c-1'}));
    const orphan = echoItem(echo({clientMsgId: 'c-2', attachments: [photo('photo-b')]}));
    const items = [item(message(1)), item(message(2)), item(mine(3))];
    expect(settledEchoes([settled, orphan], items)).toEqual([settled]);
    expect(settledEchoes([orphan], items)).toEqual([]);
  });

  it('settledEchoes: 확정본 하나는 메아리 하나만 짝짓는다 — 같은 사진 두 장은 보낸 순서대로 하나씩', () => {
    const first = echoItem(echo({clientMsgId: 'c-1'}));
    const second = echoItem(echo({clientMsgId: 'c-2', createdAtMs: NOW + 50}));
    const one = [item(message(1)), item(message(2)), item(mine(3))];
    expect(settledEchoes([first, second], one)).toEqual([first]);
    expect(settledEchoes([first, second], [...one, item(mine(4), false)])).toEqual([first, second]);
  });

  it('withLingeringEchoes: 메아리를 확정본 바로 앞에 **그대로** 끼우고 확정본에 standby 를 붙인다', () => {
    const lingering = echoItem(echo({clientMsgId: 'c-1'}));
    const items = [item(message(1)), item(message(2)), item(mine(3)), item(message(4))];
    const out = withLingeringEchoes(items, [lingering]);
    expect(out.map(entry => entry.key)).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3', 'm-4']);
    // 메아리 항목은 받은 그대로다(같은 객체 — 같은 키·같은 모양이라 인스턴스가 이어진다).
    expect(out[2]).toBe(lingering);
    expect(isStandbyItem(out[3])).toBe(true);
    expect(isStandbyItem(out[4])).toBe(false);
    // 원본 배열과 확정본 항목은 건드리지 않는다.
    expect(items).toHaveLength(4);
    expect(isStandbyItem(items[2])).toBe(false);
  });

  it('withLingeringEchoes: 바꿀 것이 없으면 받은 배열 그대로(참조) — 남길 메아리 없음·확정본을 못 찾음', () => {
    const items = [item(message(1)), item(message(2))];
    expect(withLingeringEchoes(items, [])).toBe(items);
    expect(withLingeringEchoes(items, [echoItem(echo({clientMsgId: 'c-lost'}))])).toBe(items);
  });
});

// -----------------------------------------------------------------------------
// 2. MessageRow 의 대기 모드
// -----------------------------------------------------------------------------
describe('MessageRow — 대기 모드', () => {
  const actions: MessageRowActions = {
    myMemberId: SELF,
    onToggleReaction: async () => {},
    onEdit: async () => {},
    onDelete: async () => {},
  };
  const row = (standby: boolean | undefined, startsGroup = true) => (
    <FixedScheme scheme="dark">
      <MessageRow
        message={mine(3)}
        startsGroup={startsGroup}
        directory={DIRECTORY}
        chips={[]}
        nowMs={NOW + 60_000}
        actions={actions}
        standby={standby}
      />
    </FixedScheme>
  );

  it('보통 행은 그대로다 — 대기 표지·눌림 차단·낭독 숨김이 없고 머리 행의 위 여백을 진다', async () => {
    render(row(undefined));
    const root = screen.getByTestId('message-row');
    expect(root.props.pointerEvents).toBeUndefined();
    expect(root.props.accessibilityElementsHidden).toBeUndefined();
    expect(root.props.importantForAccessibility).toBeUndefined();
    expect(screen.queryByTestId('message-row-standby')).toBeNull();
    const style = flat(root.props.style);
    expect(style.height).toBeUndefined();
    expect(style.opacity).toBeUndefined();
    expect(style.marginTop).toBeGreaterThan(0);
    await settle();
  });

  it('대기 행: 높이 0 · 투명 · 위 여백 없음 · 눌림과 낭독을 받지 않는다', async () => {
    render(row(true));
    // 낭독에서 숨긴 요소라 조회가 기본으로 건너뛴다.
    const root = screen.getByTestId('message-row-standby', {includeHiddenElements: true});
    const style = flat(root.props.style);
    expect(style.height).toBe(0);
    expect(style.opacity).toBe(0);
    expect(style.marginTop).toBeUndefined();
    expect(root.props.pointerEvents).toBe('none');
    expect(root.props.accessibilityElementsHidden).toBe(true);
    expect(root.props.importantForAccessibility).toBe('no-hide-descendants');
    expect(screen.queryByTestId('message-row')).toBeNull();
    await settle();
  });

  it('대기에서 드러남으로 바뀌어도 같은 인스턴스다 — 사진 타일의 이미지 뷰가 새로 서지 않는다', async () => {
    const tiles = trackTiles();
    const view = render(row(true));
    expect(tiles.size).toBe(1);
    view.rerender(row(undefined));
    expect(screen.getByTestId('message-row')).toBeTruthy();
    expect(flat(screen.getByTestId('message-row').props.style).height).toBeUndefined();
    // 인스턴스가 하나 더 생겼다면 드러나는 순간 이미지 뷰가 새로 서서 빈 프레임이 다시 생기는 것이다.
    expect(tiles.size).toBe(1);
    await settle();
  });
});

// -----------------------------------------------------------------------------
// 3. Timeline
// -----------------------------------------------------------------------------
describe('Timeline — 서버 사본이 서는 커밋에 메아리가 남고 서버 사본은 대기한다', () => {
  const history = [message(1), message(2)];
  const tl = (messages: Message[], pending: PendingMessage[]) => (
    <Timeline
      messages={messages}
      directory={DIRECTORY}
      status="ready"
      myMemberId={SELF}
      nowMs={NOW + 60_000}
      pending={pending}
    />
  );
  /** 목록 데이터 중 메시지(`m-`)·메아리(`p-`)만 — 날짜 구분선은 거른다. `*` 는 대기 중인 서버 사본. */
  const keys = () =>
    (screen.getByTestId('timeline-list').props.data as Array<{key: string; standby?: boolean}>)
      .filter(entry => /^[mp]-/.test(entry.key))
      .map(entry => (entry.standby ? `${entry.key}*` : entry.key));
  const echoes = () => screen.queryAllByTestId('pending-row').length;
  /** 그려진 대기 서버 사본(낭독에서 숨긴 요소라 조회가 기본으로 건너뛴다). */
  const standbyRows = () => screen.queryAllByTestId('message-row-standby', {includeHiddenElements: true}).length;

  it.each([
    ['POST 응답 경로(확정본과 pending 제거가 한 렌더)', 30],
    ['등장 중간', 150],
  ] as const)('보류 경로 — %s (%dms): 보류가 풀리는 커밋에 메아리가 남고 서버 사본이 대기로 서며, 창이 끝나면 걷힌다', async (_name, arrivesAt) => {
    spyTiming();
    const tiles = trackTiles();
    const view = render(tl(history, [echo()]));
    expect(echoes()).toBe(1);
    expect(tiles.size).toBe(1);

    act(() => {
      jest.advanceTimersByTime(arrivesAt);
    });
    view.rerender(tl([...history, mine(3)], []));
    // 보류: 확정본 자리에 메아리가 그대로 있다.
    expect(echoes()).toBe(1);
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1']);

    // 보류가 풀리는 **같은 커밋**에 서버 사본이 대기로 서고, 메아리는 그 항목 그대로 남는다.
    act(() => {
      jest.advanceTimersByTime(HOLD_MS - arrivesAt);
    });
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
    expect(echoes()).toBe(1);
    // 서버 사본은 **그려져 있다** — 눈에 안 보이는 대기 행으로(높이 0·투명).
    expect(standbyRows()).toBe(1);
    // 사진 타일 인스턴스는 둘 — 이어 온 메아리의 것(1)과 미리 마운트된 대기 서버 사본의 것(2). 메아리가 새 마운트였다면 3 이다.
    expect(tiles.size).toBe(2);

    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS);
    });
    expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
    expect(echoes()).toBe(0);
    // 창이 끝나면 대기하던 행이 드러난다 — 새로 서지 않고 그 인스턴스가 이어진다(이미지가 이미 그려져 있다).
    expect(standbyRows()).toBe(0);
    expect(screen.getAllByTestId('message-row')).toHaveLength(3);
    expect(tiles.size).toBe(2);
    await settle();
  });

  it('보류가 없는 경로 — 등장이 없는 메아리(동작 줄이기·가상화 재마운트)는 확정본이 오는 커밋에 메아리가 남고 서버 사본이 대기로 선다', async () => {
    spyTiming();
    const tiles = trackTiles();
    // 이미 올라온 적이 있는 메아리는 등장도 보류 장부도 없다(`PendingRow` — 동작 줄이기와 같은 모양).
    markArrived('c-1');
    const view = render(tl(history, [echo()]));
    expect(echoes()).toBe(1);
    view.rerender(tl([...history, mine(3)], []));
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
    expect(echoes()).toBe(1);
    expect(tiles.size).toBe(2);
    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS);
    });
    expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
    expect(tiles.size).toBe(2);
    await settle();
  });

  it('확정이 보류보다 늦은 느린 전송 — 확정본이 오는 커밋에 메아리가 남고 서버 사본이 대기로 선다', async () => {
    spyTiming();
    const view = render(tl(history, [echo()]));
    act(() => {
      jest.advanceTimersByTime(HOLD_MS + 600);
    });
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1']);
    view.rerender(tl([...history, mine(3)], []));
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
    expect(echoes()).toBe(1);
    await settle();
  });

  it('글자 행에는 대기가 없다 — 사진을 안 단 메아리·파일 카드만 단 메아리', async () => {
    spyTiming();
    for (const [pending, confirmed] of [
      [echo({body: '글자만', attachments: undefined}), mine(3, {body: '글자만', attachments: undefined})],
      [echo({attachments: [FILE_CARD]}), mine(3, {attachments: [FILE_CARD]})],
    ] as const) {
      resetArrivedForTest();
      const view = render(tl(history, [pending]));
      act(() => {
        jest.advanceTimersByTime(100);
      });
      view.rerender(tl([...history, confirmed], []));
      act(() => {
        jest.advanceTimersByTime(HOLD_MS);
      });
      expect(keys()).toEqual(['m-1', 'm-2', 'm-3']);
      await settle();
      view.unmount();
    }
  });

  it('확정본 없이 사라진 사진 메아리(전송이 지워짐)는 남기지 않는다', async () => {
    spyTiming();
    markArrived('c-1');
    const view = render(tl(history, [echo()]));
    expect(echoes()).toBe(1);
    view.rerender(tl(history, []));
    expect(echoes()).toBe(0);
    expect(keys()).toEqual(['m-1', 'm-2']);
    await settle();
  });

  it('사진 둘을 잇달아 보내면 메아리도 각자 자기 확정본 앞에 남고 함께 걷힌다', async () => {
    spyTiming();
    markArrived('c-1');
    markArrived('c-2');
    const two = [
      echo({clientMsgId: 'c-1', attachments: [photo('photo-a')]}),
      echo({clientMsgId: 'c-2', attachments: [photo('photo-b')], createdAtMs: NOW + 40}),
    ];
    const view = render(tl(history, two));
    expect(echoes()).toBe(2);
    view.rerender(
      tl(
        [...history, mine(3, {attachments: [photo('photo-a')]}), mine(4, {attachments: [photo('photo-b')]})],
        [],
      ),
    );
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*', 'p-c-2', 'm-4*']);
    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS);
    });
    expect(keys()).toEqual(['m-1', 'm-2', 'm-3', 'm-4']);
    await settle();
  });

  it('언마운트하면 타이머가 걷힌다 — 남은 타이머가 없다', async () => {
    spyTiming();
    markArrived('c-1');
    const view = render(tl(history, [echo()]));
    view.rerender(tl([...history, mine(3)], []));
    expect(keys()).toEqual(['m-1', 'm-2', 'p-c-1', 'm-3*']);
    // 창을 닫는 타이머가 하나 걸려 있다.
    const withTimer = jest.getTimerCount();
    expect(withTimer).toBeGreaterThan(0);
    view.unmount();
    // 언마운트가 그 타이머를 걷는다 — React 19 는 언마운트 뒤 setState 에 경고하지 않으니 남은 타이머 수로 본다.
    expect(jest.getTimerCount()).toBeLessThan(withTimer);
    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS * 2);
    });
    await settle();
  });
});
