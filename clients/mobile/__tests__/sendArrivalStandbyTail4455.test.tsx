import type {Message, MessageAttachment, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {PendingMessage} from '@momo/core/features/timeline/model';
import {act, cleanup, render, screen} from '@testing-library/react-native';
import React from 'react';
import {Animated, View} from 'react-native';

import {resetAttachmentContentForTest} from '../src/features/attachments/content';
import {Timeline} from '../src/features/conversation/Timeline';
import {ECHO_LINGER_MS, markArrived, resetArrivedForTest} from '../src/features/conversation/sendArrival';

// =============================================================================
// #4455 design-review r4 H4 — 사진 뒤에 서 있는 행은 대기 서버 사본이 끼어도 새 인스턴스로 다시 서지 않는다.
//
// 대기 서버 사본(`standby`)을 메아리 바로 뒤에 끼우면 목록이 한 칸 늘면서 **그 뒤 행들의 인덱스가 한 칸씩 밀린다**. RN 0.86
// `VirtualizedList` 는 항목이 늘어난 커밋에서 렌더 창의 끝을 그대로 두므로(`getDerivedStateFromProps`) 가장 뒤 행이 창 밖으로 나가
// 언마운트됐다가 새 인스턴스로 다시 선다 — 사진 메아리를 「유령」으로 겹치려던 첫 설계를 버리게 한 바로 그 기전이 메아리 셀에서 꼬리
// 셀(에이전트 「작업 중」 자리·뒤이어 보낸 메아리)로 옮겨 간다. 그래서 대기 서버 사본은 **스트림 맨 끝**에 두고 메아리는 확정본의 자리에
// 남긴다 — 어떤 기존 행의 인덱스도 안 바뀐다.
//
// 이 파일은 **실제 `Timeline` 과 실제 RN `VirtualizedList` JS** 를 쓰고 레이아웃·스크롤 이벤트만 흉내 내서(렌더 창이 꼬리로 수렴하게)
// 행 **인스턴스**를 센다. 인스턴스 수가 곧 재마운트다 — `View.prototype.render` 를 가로채 testID 별로 서로 다른 인스턴스를 모은다.
// 다른 `Timeline` 시험은 사진이 마지막 항목인 데이터뿐이라 이 재마운트를 못 잡았다(design-review r4).
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
const AGENT = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const NOW = 1_700_000_000_000;
const HIST = 14;
const VIEWPORT = 700;
const CELL = 70;

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
  member({id: AGENT, kind: 'agent', displayName: 'hermes', handle: 'hermes'}),
]);

const photo = (id: string): MessageAttachment => ({id, name: `${id}.png`, mime: 'image/png', sizeBytes: 4096});

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

const history = Array.from({length: HIST}, (_, index) => message(index + 1));

function echo(over: Partial<PendingMessage> = {}): PendingMessage {
  return {
    clientMsgId: 'c-1',
    channelId: 'ch',
    authorMemberId: SELF,
    body: '',
    createdAtMs: NOW,
    sinceSeq: HIST,
    status: 'sending',
    attachments: [photo('photo-a')],
    ...over,
  };
}

/** 내가 보낸 사진의 확정본. */
const minePhoto = (seq: number, over: Partial<Message> = {}): Message =>
  message(seq, {authorMemberId: SELF, body: '', createdAtMs: NOW + 100, attachments: [photo('photo-a')], ...over});

// ---- 인스턴스 수 ----------------------------------------------------------------------------------
const TRACKED = (id: string) =>
  id.startsWith('working-row') ||
  id === 'pending-row' ||
  id === 'attachment-preview' ||
  id === 'message-row' ||
  id === 'message-row-standby';
const seen: Record<string, Set<unknown>> = {};
function trackInstances() {
  const original = View.prototype.render;
  jest.spyOn(View.prototype, 'render').mockImplementation(function (this: {props: {testID?: string}}) {
    const id = this.props.testID;
    if (typeof id === 'string' && TRACKED(id)) (seen[id] ??= new Set()).add(this);
    return original.call(this);
  } as never);
}
const instances = (id: string) => (seen[id] === undefined ? 0 : seen[id].size);

// ---- 레이아웃 흉내 --------------------------------------------------------------------------------
// 실제 `VirtualizedList` 는 셀이 `onLayout` 을 알려 와야 렌더 창을 꼬리로 수렴시킨다. 모든 셀이 같은 높이(CELL)를 갖고 목록이 꼬리에 붙어
// 있다고 흉내 낸다. 높이 0 이어야 하는 대기 행도 CELL 로 흉내 내지만 인덱스 이동·창 거동에는 영향이 없다.
const cellComposites = () =>
  screen.UNSAFE_root.findAll(
    (node: any) =>
      typeof node.type !== 'string' &&
      node.props &&
      node.props.cellKey !== undefined &&
      typeof node.props.index === 'number' &&
      typeof node.props.onLayout === 'function',
  );
let tick = 0;
function layoutPass() {
  const list = screen.getByTestId('timeline-list');
  const total = (list.props.data as unknown[]).length * CELL;
  act(() => {
    list.props.onLayout({nativeEvent: {layout: {x: 0, y: 0, width: 390, height: VIEWPORT}}});
    for (const cell of cellComposites()) {
      cell.props.onLayout({nativeEvent: {layout: {x: 0, y: cell.props.index * CELL, width: 390, height: CELL}}});
    }
    list.props.onContentSizeChange(390, total);
    tick += 16;
    list.props.onScroll({
      timeStamp: 1000 + tick,
      nativeEvent: {
        contentOffset: {x: 0, y: Math.max(0, total - VIEWPORT)},
        contentSize: {width: 390, height: total},
        layoutMeasurement: {width: 390, height: VIEWPORT},
        zoomScale: 1,
      },
    });
  });
}
function converge(passes = 10) {
  for (let pass = 0; pass < passes; pass += 1) {
    layoutPass();
    act(() => {
      jest.advanceTimersByTime(60);
    });
  }
}
const settle = () =>
  act(async () => {
    for (let tickCount = 0; tickCount < 20; tickCount += 1) await Promise.resolve();
  });

/** 목록 데이터의 끝 몇 개(날짜 구분선은 거른다). `*` 는 대기 중인 서버 사본. */
const keys = (take = 6) =>
  (screen.getByTestId('timeline-list').props.data as Array<{key: string; standby?: boolean}>)
    .filter(entry => /^[mpw]-/.test(entry.key))
    .map(entry => (entry.standby ? `${entry.key}*` : entry.key))
    .slice(-take);

const tl = (messages: Message[], pending: PendingMessage[], working: Array<{memberId: string}> = []) => (
  <Timeline
    messages={messages}
    directory={DIRECTORY}
    status="ready"
    myMemberId={SELF}
    nowMs={NOW + 60_000}
    pending={pending}
    working={working}
  />
);

let consoleErrors: string[] = [];
beforeEach(() => {
  fileSystem.__reset();
  resetAttachmentContentForTest();
  resetArrivedForTest();
  for (const key of Object.keys(seen)) delete seen[key];
  jest.useFakeTimers();
  jest.setSystemTime(NOW);
  tick = 0;
  jest
    .spyOn(Animated, 'timing')
    .mockImplementation(() => ({start: jest.fn(), stop: jest.fn(), reset: jest.fn()}) as never);
  consoleErrors = [];
  jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map(String).join(' '));
  });
  trackInstances();
});
afterEach(async () => {
  await settle();
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
  resetArrivedForTest();
  expect(consoleErrors).toEqual([]);
});

describe('사진 뒤에 서 있는 행은 대기 서버 사본이 끼어도 새 인스턴스로 다시 서지 않는다', () => {
  it('대조군 — 글 메아리 뒤의 「작업 중」 자리는 확정본이 와도 한 인스턴스다(대기 행이 안 생긴다)', async () => {
    markArrived('c-1');
    const text = echo({body: '글자만', attachments: undefined});
    const view = render(tl(history, [text], [{memberId: AGENT}]));
    converge();
    expect(instances(`working-row-${AGENT}`)).toBe(1);
    view.rerender(
      tl(
        [...history, message(HIST + 1, {authorMemberId: SELF, body: '글자만', createdAtMs: NOW + 100})],
        [],
        [{memberId: AGENT}],
      ),
    );
    converge(4);
    expect(instances(`working-row-${AGENT}`)).toBe(1);
    expect(instances('message-row-standby')).toBe(0);
    await settle();
  });

  it('사진 메아리 뒤에 「작업 중」 자리가 있어도 확정본이 오는 커밋·창이 끝나는 커밋에 그 자리는 한 인스턴스다', async () => {
    markArrived('c-1');
    const view = render(tl(history, [echo()], [{memberId: AGENT}]));
    converge();
    expect(instances(`working-row-${AGENT}`)).toBe(1);
    expect(instances('pending-row')).toBe(1);
    view.rerender(tl([...history, minePhoto(HIST + 1)], [], [{memberId: AGENT}]));
    // 확정본이 온 **바로 그 커밋**: 메아리는 확정본의 자리(`m-15` 의 자리)에 그대로 서고, 대기 서버 사본은 맨 끝이다.
    expect(keys(3)).toEqual([`p-c-1`, `w-${AGENT}`, 'm-15*']);
    converge(4);
    expect(instances(`working-row-${AGENT}`)).toBe(1);
    expect(instances('pending-row')).toBe(1);
    // 사진 타일은 둘이다 — 메아리의 것과 미리 마운트된 대기 서버 사본의 것.
    expect(instances('attachment-preview')).toBe(2);
    expect(instances('message-row-standby')).toBe(1);
    // 창이 끝나면 서버 사본이 자기 자리로 드러나고 메아리가 걷힌다 — 그래도 「작업 중」 자리는 그대로다.
    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS + 10);
    });
    converge(2);
    expect(keys(2)).toEqual(['m-15', `w-${AGENT}`]);
    expect(instances(`working-row-${AGENT}`)).toBe(1);
    expect(instances('attachment-preview')).toBe(2);
    await settle();
  });

  it('사진 메아리 뒤에 이어 보낸 글 메아리가 서 있어도 둘 다 새 인스턴스로 서지 않는다', async () => {
    markArrived('c-1');
    markArrived('c-2');
    const second = echo({clientMsgId: 'c-2', body: '이거 봐줘', attachments: undefined, createdAtMs: NOW + 30});
    const view = render(tl(history, [echo(), second]));
    converge();
    expect(instances('pending-row')).toBe(2);
    view.rerender(tl([...history, minePhoto(HIST + 1)], [second]));
    expect(keys(3)).toEqual(['p-c-1', 'p-c-2', 'm-15*']);
    converge(4);
    // 메아리 인스턴스는 둘이고(첫 사진 메아리 + 이어 보낸 글 메아리) 셋이 아니다.
    expect(instances('pending-row')).toBe(2);
    expect(instances('attachment-preview')).toBe(2);
    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS + 10);
    });
    converge(2);
    expect(keys(2)).toEqual(['m-15', 'p-c-2']);
    expect(instances('pending-row')).toBe(2);
    await settle();
  });

  it('사진 메아리 뒤에 상대 말이 이미 도착해 있어도 그 행은 새 인스턴스로 서지 않는다', async () => {
    markArrived('c-1');
    // 확정본(seq 15)이 아직 오기 전에 상대의 말이 먼저 도착했다 — 메아리는 맨 끝, 상대 말은 그 앞이다.
    const view = render(tl([...history, message(HIST + 1, {body: '상대 말'})], [echo({sinceSeq: HIST + 1})]));
    converge();
    const before = instances('message-row');
    view.rerender(
      tl([...history, message(HIST + 1, {body: '상대 말'}), minePhoto(HIST + 2)], []),
    );
    converge(4);
    // 상대 말 행의 인스턴스는 늘지 않는다(대기 서버 사본 하나만 새로 선다).
    expect(instances('message-row')).toBeLessThanOrEqual(before + 1);
    expect(instances('message-row-standby')).toBe(1);
    await settle();
  });

  it('혼자 서 있는 사진 메아리(캡처한 경우)는 그대로다 — 메아리 1 · 타일 2 · 대기 1, 드러난 뒤에도 타일 2', async () => {
    markArrived('c-1');
    const view = render(tl(history, [echo()]));
    converge();
    view.rerender(tl([...history, minePhoto(HIST + 1)], []));
    converge(4);
    expect(instances('pending-row')).toBe(1);
    expect(instances('attachment-preview')).toBe(2);
    expect(instances('message-row-standby')).toBe(1);
    act(() => {
      jest.advanceTimersByTime(ECHO_LINGER_MS + 10);
    });
    converge(2);
    expect(keys(1)).toEqual(['m-15']);
    expect(instances('attachment-preview')).toBe(2);
    await settle();
  });
});
