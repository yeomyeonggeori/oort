import type {Message, RosterMember} from '@momo/core/lib/api';
import type {PendingMessage, TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React, {Profiler, useState} from 'react';
import type {FlatList} from 'react-native';

import {createDockFollow, DockFollowContext, type DockFollow} from '../src/features/conversation/dockFollow';
import {Timeline, type PillState} from '../src/features/conversation/Timeline';
import {installAppClock} from './fixtures/fakeClock';

// =============================================================================
// 연결이 돌아와 자동으로 다시 보낸 글이 서버 사본으로 바뀔 때, 목록이 바닥에 붙어 있었으면 붙은 채다 (#5284, 검증 5a High).
//
// ## 무슨 일이었나
//
// 폰에서 api 를 내렸다 올리면 못 보낸 글(실패 행 `p-<clientMsgId>`)이 저절로 다시 나가 서버 사본(`m-<seq>`)으로 바뀐다. 이때 목록이 **마지막 행을 끝에서
// 한참(검증 캡처 17~18pt, 강제 순서 시험 140pt) 못 미쳐** 서 있었다. 일반 보내기는 안 그랬고, 55초 뒤에도 그대로였다.
//
// ## 원인 (강제 순서 시험으로 숫자를 잡았다)
//
//   · 서버 사본으로 바뀌면 셀의 **키가 바뀐다**(`p-…` → `m-…`). 새 셀은 레이아웃 보고가 오기 전까지 `VirtualizedList` 에게 「안 잰 셀」이다.
//   · 같은 때(또는 바로 뒤, 셀 보고보다 먼저) 목록의 **창이 커진다**: 보낼 수 없던 동안 입력창 위에 섰던 원인 문장이 걷히기 때문이다(+37pt).
//   · 창이 바뀌면 `Timeline.onLayout` 이 따라가는 중일 때 `VirtualizedList.scrollToEnd` 를 부르는데, 그것은 끝을 **셀 기록으로 어림**한다. 안 잰 마지막 셀은
//     평균 높이로 어림되고(머리·위 여백은 어림에 없다), 그 값이 끝보다 모자라면 목록은 모자란 자리에 앉는다.
//   · 실패 행과 서버 사본은 높이가 같아서 콘텐츠 길이는 안 변한다. `onContentSizeChange` 가 다시 불리지 않으니 고칠 기회가 없다.
//   · 모자람이 120pt(`FOLLOW_THRESHOLD_PX`) 안이면 따라가는 중은 켜진 채라 「최신으로」 필도 안 선다(검증 캡처). 넘으면 활강 핀이 풀릴 때 따라가기가 꺼지고
//     필이 선다(강제 순서 시험).
//
// ## 고침
//
// 창이 바뀔 때의 따라가기는 도크 처리기(#4518)와 같은 **네이티브 `scrollToEnd`** 로 간다 — 그 순간의 창과 콘텐츠 길이로 끝을 셈하므로 셀이 재졌는지와 무관하다.
// 네이티브 응답자가 없으면(시험·하네스) 예전처럼 목록의 어림으로 물러난다.
//
// ## 이 시험의 이중
//
// 네이티브 이중은 `timelineEntryEnd.test.tsx` 의 규칙 5·9를 줄인 것이다: 커밋은 **그 자리에서** 새 프레임을 만들고, 레이아웃 보고(셀·콘텐츠)는 **따로** 낸다.
// 그래서 「창 보고가 새 셀 보고보다 먼저 온다」는 순서를 시험이 정한다. `VirtualizedList.scrollToEnd` 는 가로채지 않고 진짜 코드가 셀 기록으로 셈하게 둔 뒤 한 단계
// 아래(`VirtualizedList.scrollToOffset`)에서 명령을 받는다. 네이티브 `scrollToEnd` 는 응답자를 갈아 끼워 받고, 이중이 **실행 순간**의 콘텐츠·창으로 끝을 셈한다.
//
// ## 뒤에 더한 것 (#5310, 검증 5b)
//
// 위 고침 뒤에도 검증 5b 의 실제 끊김 흐름에서 같은 모양(마지막 행이 입력창 위 목록 끝에서 17~20pt 잘린 채 55초 뒤에도)이 남았다. 이 시험 이중으로 그 순서를 자연 그대로 만들지는 못했다.
// 확인되는 빈틈은 하나다: **목록이 낸 따라가기 명령의 결과를 아무도 다시 묻지 않는다** — 끝에 못 미쳐 앉아도 120pt 문턱 안이면 「따라가는 중」으로 남고, 다음 사건이 없으면 그대로다.
// 그래서 아래 마지막 절은 명령이 모자라게 앉는 모양(`skewNativeEnd` — 명령이 읽은 창·콘텐츠가 한 칸 늦은 값인 경우)을 이중에 주고, 가라앉은 뒤 한 번 더 묻는 것(`armSettle`)을 잠근다.
//
// =============================================================================

const SELF = '11111111-5284-4000-8000-000000000001';
const OTHER = '11111111-5284-4000-8000-000000000002';
const CHANNEL = '22222222-5284-4000-8000-000000000001';
const BASE_MS = 1_700_000_000_000;

function member(id: string, name: string): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: name,
    handle: name,
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([member(SELF, 'seongjae'), member(OTHER, 'minsu')]);

// ---- 잰 기하(기기 로그의 모양을 줄였다) ---------------------------------------------
/** 원인 문장이 서 있는 동안의 목록 창 — 기기: 669.3. */
const WINDOW_WITH_NOTE = 669;
/** 문장이 걷힌 뒤 — 기기: 706. 창이 37pt 커진다. */
const WINDOW_WITHOUT_NOTE = 706;
/** 목록 머리(빈 머리) 16 · 날짜 구분선 36 · 꼬리 8, 행은 모두 120(평균 어림이 맞는 모양). */
const HEADER = 16;
const DIVIDER = 36;
const FOOTER = 8;
const ROW = 120;
/** 실패 행은 「못 보냈어요」 줄이 더해져 48pt 크다(기기: 126.3 대 78.3). */
const FAILED_ROW = ROW + 48;
const FRAME_MS = 16;

function history(): Message[] {
  return Array.from({length: 8}, (_, i) => ({
    id: `msg-${i + 1}`,
    channelId: CHANNEL,
    seq: i + 1,
    hlcTs: i + 1,
    hlcCount: 0,
    authorMemberId: OTHER,
    type: 'text',
    body: `${i + 1}번째 글`,
    state: 'sent',
    createdAtMs: BASE_MS + (i + 1) * 1000,
  })) as Message[];
}

const BODY = '서버 끊긴 채 보낸 글';
const CLIENT_MSG_ID = 'aaaaaaaa-5284-4000-8000-00000000c0de';

function failedRow(status: 'failed' | 'sending'): PendingMessage {
  return {
    clientMsgId: CLIENT_MSG_ID,
    channelId: CHANNEL,
    authorMemberId: SELF,
    body: BODY,
    status,
    sinceSeq: 8,
    createdAtMs: BASE_MS + 9_000,
  };
}

/** 서버가 받은 같은 글. 폰의 `post` 는 확정본을 합치는 같은 틱에 실패 행을 걷는다. */
const SERVER_COPY: Message = {
  id: 'msg-9',
  channelId: CHANNEL,
  seq: 9,
  hlcTs: 9,
  hlcCount: 0,
  authorMemberId: SELF,
  type: 'text',
  body: BODY,
  state: 'sent',
  createdAtMs: BASE_MS + 9_500,
} as Message;

// ---- 테스트 렌더러의 노드 ---------------------------------------------------------
type Node = ReturnType<typeof screen.getByTestId>;

function isNode(child: unknown): child is Node {
  return typeof child !== 'string';
}

function firstHost(node: Node): Node {
  let cursor: Node = node;
  while (typeof cursor.type !== 'string') {
    const next = (cursor.children as unknown[]).find(isNode);
    if (next === undefined) return cursor;
    cursor = next;
  }
  return cursor;
}

interface Child {
  /** 셀 키, `…-header`·`…-footer`, 스페이서는 `spacer:<React 키>`. */
  id: string;
  /** 그 자식의 첫 호스트 뷰 — `onLayout` 이 사는 곳. */
  host: Node;
  spacer: number | null;
}

/** 콘텐츠 컨테이너의 직계 자식들. */
function contentChildren(): Child[] {
  let container: Node = screen.getByTestId('timeline-list');
  for (;;) {
    const kids = (container.children as unknown[]).filter(isNode);
    if (kids.length !== 1) break;
    container = kids[0];
  }
  return (container.children as unknown[]).filter(isNode).map((child, index) => {
    const key = (child.props as {cellKey?: unknown}).cellKey;
    const host = firstHost(child);
    if (typeof key === 'string') return {id: key, host, spacer: null};
    const reactKey = (child as unknown as {_fiber?: {key?: string | null}})._fiber?.key;
    const style = host.props.style as {height?: number} | undefined;
    return {id: `spacer:${reactKey ?? index}`, host, spacer: Math.max(0, style?.height ?? 0)};
  });
}

const list = () => screen.getByTestId('timeline-list');

/** 손가락이 떨어진다 — 속도 없이(관성 없음). */
const LIFT = {nativeEvent: {velocity: {x: 0, y: 0}}};

// ---- 네이티브 이중 -----------------------------------------------------------------
class NativeTail {
  offset = 0;
  window = WINDOW_WITH_NOTE;
  /** 받은 명령들: 어림이 낸 것(`inner`)과 네이티브 끝(`native`). */
  readonly commands: Array<{via: 'inner' | 'native'; target: number | 'end'}> = [];
  private children: Child[] = [];
  private frames = new Map<string, {y: number; h: number}>();
  private announced = new Map<string, string>();
  private announcedContent = -1;
  /** 앞으로 `times` 번의 네이티브 끝 명령이 `px` 만큼 **못 미쳐** 앉는다 — 명령이 읽은 창·콘텐츠 값이 한 칸 늦은 값이던 경우의 모양이다(#5310). */
  private skew = {px: 0, times: 0};

  constructor(private readonly heightOf: (child: Child) => number) {}

  skewNativeEnd(px: number, times = 1) {
    this.skew = {px, times};
  }

  /** 받은 네이티브 끝 명령의 수. */
  nativeEnds(): number {
    return this.commands.filter(command => command.via === 'native').length;
  }

  /** 커밋: 새 프레임을 **그 자리에서** 만든다(보고는 따로 낸다). */
  commit(children: Child[]) {
    this.children = children;
    const out = new Map<string, {y: number; h: number}>();
    let y = 0;
    for (const child of children) {
      const h = this.heightOf(child);
      out.set(child.id, {y, h});
      y += h;
    }
    this.frames = out;
  }

  content(): number {
    let total = 0;
    for (const frame of this.frames.values()) total += frame.h;
    return Math.max(total, this.window);
  }

  end(): number {
    return Math.max(0, this.content() - this.window);
  }

  /** 셀마다 `onLayout`(바뀐 것만). 첫 보고가 곧 「잰 셀」이 되는 순간이다. */
  announceCells() {
    for (const child of this.children) {
      if (child.spacer !== null) continue;
      const frame = this.frames.get(child.id);
      const onLayout = child.host.props.onLayout as ((event: unknown) => void) | undefined;
      if (frame === undefined || onLayout === undefined) continue;
      const signature = `${frame.y.toFixed(2)}:${frame.h.toFixed(2)}`;
      if (this.announced.get(child.id) === signature) continue;
      this.announced.set(child.id, signature);
      onLayout({nativeEvent: {layout: {x: 0, y: frame.y, width: 375, height: frame.h}}});
    }
  }

  /** 콘텐츠 길이가 바뀌었을 때만 보고한다 — 같은 높이의 교체는 보고가 없다(이 결함이 고쳐질 기회가 없던 까닭). */
  announceContent() {
    const content = this.content();
    if (Math.abs(content - this.announcedContent) < 0.01) return;
    this.announcedContent = content;
    list().props.onContentSizeChange(375, content);
  }

  announce() {
    this.announceCells();
    this.announceContent();
  }

  /** 창이 바뀌었다: 네이티브가 먼저 새 창을 알고, 목록의 `onLayout` 이 뒤따른다. */
  resizeWindow(height: number) {
    this.window = height;
    fireEvent(list(), 'layout', {nativeEvent: {layout: {x: 0, y: 0, width: 375, height}}});
  }

  private clamp(to: number) {
    return Math.min(Math.max(0, to), this.end());
  }

  /** 명령은 한 틱 뒤에 돈다. `end` 는 **그때의** 콘텐츠·창으로 끝을 셈한다(네이티브 `scrollToEnd`). 숫자는 부른 순간 고정이다(어림). */
  command(via: 'inner' | 'native', target: number | 'end') {
    this.commands.push({via, target});
    const short = via === 'native' && target === 'end' && this.skew.times > 0 ? this.skew.px : 0;
    if (short > 0) this.skew.times -= 1;
    setTimeout(() => {
      this.offset = this.clamp(target === 'end' ? this.end() - short : target);
      this.report();
    }, 0);
  }

  drag(to: number) {
    this.offset = this.clamp(to);
    this.report();
  }

  report() {
    list().props.onScroll({
      nativeEvent: {
        contentOffset: {x: 0, y: this.offset},
        contentSize: {width: 375, height: this.content()},
        layoutMeasurement: {width: 375, height: this.window},
        zoomScale: 1,
      },
      timeStamp: Date.now(),
    });
  }
}

type ListRef = React.MutableRefObject<FlatList<TimelineStreamItem> | null>;

interface Room {
  native: NativeTail;
  pillsRef: React.MutableRefObject<PillState | null>;
  /** 실패 행이 다시 보내는 중으로(자동 재전송의 첫 순간). `settle` 프레임을 흘려 보낸다(기본 30). */
  retry: (settle?: number) => Promise<void>;
  /** 서버 사본이 오고 실패 행이 걷힌다(`post` 의 성공 틱). */
  swap: () => Promise<void>;
}

async function frames(count: number) {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      jest.advanceTimersByTime(FRAME_MS);
    });
  }
}

interface OpenOptions {
  /** 진입 수렴이 도는 동안(첫 콘텐츠 보고 직후) 창을 이 높이로 바꾼다. */
  windowDuringEntry?: number;
  /** 도크 다리(`ConversationLayout` 이 만드는 것) — 주면 목록을 그 컨텍스트 안에 렌더한다(#5310). */
  dock?: DockFollow;
}

async function openRoom(options: OpenOptions = {}): Promise<Room> {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as ListRef;
  const pillsRef = React.createRef<PillState>() as React.MutableRefObject<PillState | null>;
  const state = {failed: true};
  const heightOf = (child: Child): number => {
    if (child.spacer !== null) return child.spacer;
    if (child.id.endsWith('-header')) return HEADER;
    if (child.id.endsWith('-footer')) return FOOTER;
    if (child.id.startsWith('p-')) return state.failed ? FAILED_ROW : ROW;
    if (child.id.startsWith('m-')) return ROW;
    return DIVIDER;
  };
  const native = new NativeTail(heightOf);
  let rendered = false;
  const control = {
    retry: () => {},
    swap: () => {},
  };

  function RoomView(): React.JSX.Element {
    const [messages, setMessages] = useState<Message[]>(history);
    const [pending, setPending] = useState<PendingMessage[]>([failedRow('failed')]);
    control.retry = () => setPending([failedRow('sending')]);
    control.swap = () => {
      setMessages(current => [...current, SERVER_COPY]);
      setPending([]);
    };
    const timeline = (
      <Profiler
        id="room"
        onRender={() => {
          if (rendered) native.commit(contentChildren());
        }}>
        <Timeline
          messages={messages}
          pending={pending}
          directory={DIRECTORY}
          status="ready"
          channelId={CHANNEL}
          myMemberId={SELF}
          nowMs={BASE_MS + 20_000}
          lastReadSeq={null}
          unreadCount={0}
          selfSendToken={0}
          jumpPills
          pillsRef={pillsRef}
          listRef={listRef}
        />
      </Profiler>
    );
    return options.dock === undefined ? (
      timeline
    ) : (
      <DockFollowContext.Provider value={options.dock}>{timeline}</DockFollowContext.Provider>
    );
  }

  render(<RoomView />);
  rendered = true;
  const flat = listRef.current!;
  // 규칙 9: `scrollToEnd` 는 목록의 진짜 코드가 셀 기록으로 셈한다. 명령은 한 단계 아래에서 받는다 — `FlatList.scrollToOffset` 도 같은 문을 지난다.
  const inner = (flat as unknown as {_listRef: {scrollToOffset: unknown}})._listRef;
  jest
    .spyOn(inner as {scrollToOffset: (p: {offset: number; animated?: boolean | null}) => void}, 'scrollToOffset')
    .mockImplementation((params: {offset: number; animated?: boolean | null}) =>
      native.command('inner', params.offset),
    );
  // 네이티브 `scrollToEnd`(ScrollView 의 명령): 스크롤 응답자를 갈아 끼워 받는다.
  jest.spyOn(flat, 'getScrollResponder').mockReturnValue({
    scrollToEnd: () => native.command('native', 'end'),
  } as never);

  // 마운트: 첫 커밋의 프레임을 만들고, 창·셀·콘텐츠를 알린다.
  await act(async () => {
    native.commit(contentChildren());
    native.resizeWindow(WINDOW_WITH_NOTE);
    native.announce();
  });
  if (options.windowDuringEntry !== undefined) {
    const during = options.windowDuringEntry;
    await act(async () => {
      native.resizeWindow(during);
    });
  }
  // 진입이 끝에 앉는다(기기에서는 진입 수렴이 한다). 앉은 뒤의 일상이 이 시험의 대상이다.
  await frames(80);
  await act(async () => {
    native.drag(native.end());
  });
  await frames(80);

  return {
    native,
    pillsRef,
    retry: async (settle = 30) => {
      state.failed = false;
      await act(async () => {
        control.retry();
      });
      await act(async () => {
        native.announce();
      });
      await frames(settle);
    },
    swap: async () => {
      await act(async () => {
        control.swap();
      });
    },
  };
}

const pt = (value: number) => (Math.abs(value) <= 0.5 ? 0 : Math.round(value * 10) / 10);

/** 판정 한 줄 — 빨개질 때 숫자가 한 번에 보이도록 한 객체로 묶는다. */
function verdict(room: Room) {
  return {
    /** 끝까지 남은 거리. 0 이어야 마지막 행이 온전히 보인다. */
    shortOfEnd: pt(room.native.end() - room.native.offset),
    /** 「최신으로」 필이 섰는가(따라가기가 꺼졌다는 말이다). */
    latestPill: room.pillsRef.current?.latest === true,
  };
}

beforeEach(() => {
  installAppClock();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('실패 행이 서버 사본으로 바뀔 때 목록이 바닥에 붙어 있었으면 붙은 채다 (#5284)', () => {
  it('대조: 창이 그대로면 키만 바뀌는 교체는 끝에 앉은 채다', async () => {
    const room = await openRoom();
    await room.retry();
    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});

    await room.swap();
    await act(async () => {
      room.native.announce();
    });
    await frames(60);

    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
  });

  it('원인 문장이 걷혀 창이 커지는 보고가 새 셀 보고보다 먼저 와도 마지막 행이 끝에 온전히 있다', async () => {
    const room = await openRoom();
    await room.retry();
    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});

    // 서버 사본이 서고(셀 키가 바뀐다 — 새 셀은 아직 안 쟀다) …
    await room.swap();
    // … 같은 때 원인 문장이 걷혀 창이 커진다. 네이티브의 창 보고가 새 셀의 보고보다 **먼저** 온다.
    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    // 그다음에야 셀 보고가 온다. 실패 행과 서버 사본은 높이가 같아 콘텐츠 보고는 없다.
    await act(async () => {
      room.native.announce();
    });
    await frames(60); // 활강 핀(350ms)이 풀리고도 남는다.

    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
  });

  it('위로 올라가 읽던 사람은 같은 일이 일어나도 읽던 자리에 남는다', async () => {
    const room = await openRoom();
    await room.retry();
    await act(async () => {
      fireEvent(list(), 'scrollBeginDrag');
      room.native.drag(room.native.end() - 600); // 읽으러 올라갔다 — 따라가기 문턱 밖
      fireEvent(list(), 'scrollEndDrag', LIFT);
    });
    await frames(30);
    const readingAt = room.native.offset;
    expect(room.pillsRef.current?.latest).toBe(true); // 대조: 읽는 중이라 따라가는 중이 꺼졌다

    await room.swap();
    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await act(async () => {
      room.native.announce();
    });
    await frames(60);

    expect(pt(room.native.offset - readingAt)).toBe(0);
    expect(room.pillsRef.current?.latest).toBe(true);
  });

  it('진입 수렴이 도는 동안의 창 변화는 예전 길(어림)로 간다 — 진입 기계가 스스로 끝을 묻고 있다', async () => {
    // 마운트 때의 창 보고는 첫 콘텐츠 보고(`didInitialScrollRef`)보다 앞서고, 바로 뒤의 창 변화는 진입 수렴(`convergingRef`) 한가운데에 온다.
    // 두 경우 모두 네이티브 끝을 부르면 안 된다: 진입의 앵커·착지 유지 계약(#1025·#2604)은 그 기계의 몫이다.
    const room = await openRoom({windowDuringEntry: WINDOW_WITHOUT_NOTE});

    expect(room.native.commands.filter(command => command.via === 'native')).toEqual([]);
  });

  it('손가락이 목록을 잡은 동안에는 창이 커져도 끌어가지 않는다', async () => {
    const room = await openRoom();
    await room.retry();
    await act(async () => {
      fireEvent(list(), 'scrollBeginDrag');
      room.native.drag(room.native.end() - 30); // 바닥에서 잡고 조금 끌었다 — 아직 따라가는 중
    });
    const heldAt = room.native.offset;
    room.native.commands.length = 0;

    await room.swap();
    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await act(async () => {
      room.native.announce();
    });
    await frames(10);

    // 손가락이 먼저다: 창이 커진 데 대한 따라가기 명령이 아예 나가지 않는다.
    expect(room.native.commands).toEqual([]);
    expect(pt(room.native.offset - heldAt)).toBe(0);
  });
});

// 한 칸 늦은 값으로 센 명령이 모자라게 앉는 모양을 이중에 준다. 「한 번 낸 명령」 뒤에 아무 사건도 없으면(실패 행 → 서버 사본은 높이가 같다) 고칠 길이 없던 자리다.
describe('따라가기가 낸 명령이 끝에 못 미쳐 앉아도 가라앉은 뒤 한 번 더 붙는다 (#5310)', () => {
  /** 한 프레임씩 흘리며 매 프레임 스크롤 보고를 낸다 — 활강·관성처럼 목록이 아직 움직이는 중이다. */
  async function movingFrames(room: Room, count: number) {
    for (let frame = 0; frame < count; frame += 1) {
      await act(async () => {
        jest.advanceTimersByTime(FRAME_MS);
        room.native.report();
      });
    }
  }

  it('창이 커지는 따라가기가 20pt 모자라게 앉아도 가라앉은 뒤 끝으로 다시 붙는다', async () => {
    const room = await openRoom();
    room.native.skewNativeEnd(20);

    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await frames(2);
    // 대조: 첫 명령은 모자라게 앉았고, 목록은 따라가는 중으로 남았다(120pt 문턱 안이라 필도 없다).
    expect(verdict(room)).toEqual({shortOfEnd: 20, latestPill: false});

    await frames(60);

    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
    expect(room.native.nativeEnds()).toBe(2); // 따라가기 한 번 + 안착 확인이 붙인 한 번
  });

  it('끝에 앉아 있으면 확인은 명령을 더 내지 않는다', async () => {
    const room = await openRoom();

    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await frames(60);

    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
    expect(room.native.nativeEnds()).toBe(1); // 따라가기 한 번뿐
  });

  it('확인이 오기 전에 위로 올라간 사람(따라가기가 꺼졌다)은 끌어가지 않는다', async () => {
    const room = await openRoom();
    room.native.skewNativeEnd(20);
    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await frames(2);
    const issued = room.native.nativeEnds();

    // 손가락 없는 이동(보조기술·상태 막대)으로 읽던 자리까지 올라갔다 — 따라가기 문턱 밖.
    await act(async () => {
      room.native.drag(room.native.end() - 600);
    });
    const readingAt = room.native.offset;
    await frames(60);

    expect(room.native.nativeEnds()).toBe(issued);
    expect(pt(room.native.offset - readingAt)).toBe(0);
  });

  it('손가락이 목록을 쥔 동안에는 확인이 끌어가지 않는다', async () => {
    const room = await openRoom();
    await act(async () => {
      fireEvent(list(), 'scrollBeginDrag'); // 손가락이 닿았다 — 따라가는 중은 켜진 채다
    });
    // 손가락이 쥔 채 콘텐츠가 바뀐다(실패 행의 「못 보냈어요」 줄이 걷힌다) — 따라가기 사건이라 확인 시계가 걸린다.
    await room.retry(1);
    // 시계가 울리기 전에 손가락이 목록을 조금 끌었다 — 바닥에서 30pt, 아직 따라가는 중.
    await act(async () => {
      room.native.drag(room.native.end() - 30);
    });
    const heldAt = room.native.offset;
    room.native.commands.length = 0;

    await frames(60);

    // 손가락이 먼저다: 확인이 네이티브 끝을 부르지 않는다.
    expect(room.native.nativeEnds()).toBe(0);
    expect(pt(room.native.offset - heldAt)).toBe(0);
  });

  it('아직 움직이는 중이면(활강·관성의 스크롤 보고) 미루고, 가라앉은 뒤에 붙인다', async () => {
    const room = await openRoom();
    room.native.skewNativeEnd(20);
    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await frames(2);
    const issued = room.native.nativeEnds();

    // 400ms 동안 매 프레임 스크롤 보고가 온다 — 목록이 아직 움직이는 중이다. 시계가 몇 번 울려도 명령은 안 나간다.
    await movingFrames(room, 25);
    expect(room.native.nativeEnds()).toBe(issued);
    expect(verdict(room).shortOfEnd).toBe(20);

    // 보고가 그치면(가라앉으면) 한 번 붙인다.
    await frames(30);
    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
    expect(room.native.nativeEnds()).toBe(issued + 1);
  });

  it('붙여도 안 앉는 목록은 끝없이 두드리지 않는다(상한 셋)', async () => {
    const room = await openRoom();
    room.native.skewNativeEnd(20, 99); // 이 목록의 네이티브 끝은 늘 20pt 못 미친다

    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await frames(200);

    expect(room.native.nativeEnds()).toBe(1 + 3); // 따라가기 한 번 + 확인이 붙인 세 번(`SETTLE_MAX_FIXES`)
    expect(verdict(room).shortOfEnd).toBe(20);
  });

  it('콘텐츠 변화의 활강이 낡은 창 값으로 목표를 세워 모자라게 앉아도 확인이 끝으로 붙인다', async () => {
    const room = await openRoom();
    // 목록이 아는 창 높이(JS 쪽 기록)가 실제보다 20pt 큰 채로 남아 있다 — 스크롤 보고 하나가 늦은 값을 실어 왔다.
    await act(async () => {
      fireEvent(list(), 'scroll', {
        nativeEvent: {
          contentOffset: {x: 0, y: room.native.offset},
          contentSize: {width: 375, height: room.native.content()},
          layoutMeasurement: {width: 375, height: room.native.window + 20},
          zoomScale: 1,
        },
        timeStamp: Date.now(),
      });
    });
    await frames(10); // 낡은 값을 낸 보고의 활강·핀이 가라앉게 둔다

    // 콘텐츠가 바뀐다(실패 행의 「못 보냈어요」 줄이 걷힌다) — 활강은 낡은 창 값으로 목표를 세워 20pt 모자라게 앉는다.
    await room.retry(2);
    expect(verdict(room).shortOfEnd).toBe(20);

    await frames(60);

    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
  });

  it('확인 시계가 걸린 뒤 손가락이 목록을 끌기 시작하면 손을 뗀 뒤에도 되돌리지 않는다', async () => {
    const room = await openRoom();
    room.native.skewNativeEnd(20);
    await act(async () => {
      room.native.resizeWindow(WINDOW_WITHOUT_NOTE);
    });
    await frames(2); // 20pt 모자라게 앉았고 확인 시계가 걸려 있다
    const issued = room.native.nativeEnds();

    await act(async () => {
      fireEvent(list(), 'scrollBeginDrag');
      room.native.drag(room.native.end() - 60); // 읽으러 조금 끌었다 — 아직 따라가기 문턱(120pt) 안
      fireEvent(list(), 'scrollEndDrag', LIFT);
    });
    const readingAt = room.native.offset;
    await frames(60);

    expect(room.native.nativeEnds()).toBe(issued);
    expect(pt(room.native.offset - readingAt)).toBe(0);
  });

  it('입력창이 자라는 프레임(도크 다리)의 따라가기가 모자라게 앉아도 확인이 끝으로 붙인다', async () => {
    const bridge = createDockFollow();
    const room = await openRoom({dock: bridge});
    room.native.skewNativeEnd(20);

    act(() => bridge.notify());
    await frames(2);
    expect(verdict(room).shortOfEnd).toBe(20);

    await frames(60);

    expect(verdict(room)).toEqual({shortOfEnd: 0, latestPill: false});
    expect(room.native.nativeEnds()).toBe(2);
  });
});
