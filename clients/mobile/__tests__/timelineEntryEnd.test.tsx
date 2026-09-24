import type {Message, RosterMember} from '@momo/core/lib/api';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React, {Profiler, useCallback, useRef, useState} from 'react';
import type {FlatList} from 'react-native';

import {Timeline, type PillState} from '../src/features/conversation/Timeline';

// =============================================================================
// 방에 들어가면 끝에 앉는다 — 옛 페이지가 붙는 팀 방에서도, 빈 화면 없이 (#2604)
//
// ## 잰 사슬 (iPhone 13 mini · Release · 목 서버 busy-120, 첫 페이지 50행)
//
//   t=14   첫 콘텐츠 보고 772.7 → 진입 수렴이 시작한다(MVCP 뗌). 같은 커밋에서
//          `VirtualizedList` 가 오프셋 0 을 「맨 위」로 읽고 `onStartReached` 를 부른다.
//   t=22   옛 페이지(21–70)가 위에 붙는다. 머리 16 → 36pt(스피너). 0번 셀이던 오늘
//          구분선은 41번이 되어 렌더 범위(0–19) 밖으로 나가고, 그 뷰는 재활용된다.
//   t=43   두 번째 옛 페이지(1–20). 수렴은 이제 **옛 행들의** 끝을 쫓는다.
//   t=88   그때 렌더된 끝(3425.3 / 3954.7)에서 도착을 선언하고 풀린다 — 첫 페이지 50행은
//          아직 하나도 그려지지 않았다.
//   t=95   다시 붙는 MVCP 가 진입 앵커(재활용된 그 뷰)의 이동량을 더한다: +849.7 →
//          4275.0, 그때의 끝을 36pt 넘었다(바닥이 빈다).
//   t=103  콘텐츠가 자라고(배치마다 ~790pt) 따라가기가 활강을 부른다. 활강의 첫 보고는
//          거의 움직이지 않은 자리라 끝에서 711pt — 따라가기가 풀린다(t=112).
//   t=490  콘텐츠는 9600.7 까지 자랐고 목록은 4986.7 / 끝 9071 에 서 있다.
//
// 결함 둘이 겹친다(진입 중 옛 페이지 · 조기 도착과 활강 중 따라가기 해제). 수리는
// 셋이고, 이 파일이 하나씩 잠근다(`Timeline.tsx`).
//
//   D  옛 페이지는 진입이 앉은 뒤에만 부른다(`olderReady`). 진입 앵커가 제 행에 남는다.
//      → 방 셋의 시험. 되돌리면 팀 방이 끝을 8908pt 넘고 빈 프레임이 선다.
//   Q  진입은 콘텐츠가 `ENTRY_QUIET_MS` 동안 멈춘 뒤에만 도착한다 — 증가는 콘텐츠를
//      싣는 **모든** 보고에서 읽는다. → 방 셋의 시험(도착 자리·활강)과 늦은 콘텐츠
//      보고 시험. 되돌리면 도착이 진짜 끝보다 3239–7211pt 앞에서 선다.
//   H  진입도 도착 뒤 `holdLanding` 을 받는다. 기기에서 다시 붙는 MVCP 가 D 뒤에도
//      +9.3pt 를 더했고(0번 셀 표본 17.7 → 25.3), 배치가 `ENTRY_QUIET_MS` 보다 뜸한
//      기기는 도착 뒤에도 자란다. → +9.3 시험(되돌리면 끝을 9.3pt 넘은 채 선다)과
//      느린 기기 시험(되돌리면 3239pt 모자란다).
//
// 이중의 밀림 크기(되돌린 D 의 8908pt)는 후입선출 풀 모형의 값이다. 기기의 진실은
// +849.7pt 이고, 둘 다 같은 부류(재활용된 앵커 뷰)로 빨개진다.
//
// ## 네이티브 이중 (#2586 이중을 넓혔다)
//
// `timelineEntryBlank.test.tsx` 의 네 규칙에 이 결함이 기대는 넷을 더한다.
//
//   1. 납작화 — MVCP 가 빠진 커밋에서는 `collapsable={false}` 가 아닌 자식이 뷰를
//      풀에 돌려준다. 풀은 후입선출이다.
//   2. 앵커 — MVCP 가 **있던** 커밋의 willMount 가 1번 서브뷰부터 일부라도 보이는 첫
//      뷰를 기록하고, MVCP 가 **있는** 커밋의 didMount 가 그 뷰의 이동량을 clamp 없이
//      더한다(`_prepareForMaintainVisibleScrollPosition` / `_adjust…`, RN 0.86).
//   3. 명령은 커밋 뒤에 돌고 끝으로 clamp 된다(`scrollTo:y:animated:`).
//   4. 뷰는 **행의 정체성**(셀 키)을 따른다. 렌더 범위에서 빠진 행의 뷰는 풀로 간다.
//   5. 레이아웃 보고 — 커밋 뒤 셀마다 `onLayout` 을 준다. `VirtualizedList` 는 그것으로
//      창을 계산하고(급할 때는 즉시, 아니면 50ms 배치), 스페이서의 높이를 정하고,
//      꼬리 스페이서를 잰 셀까지로 자른다 — 콘텐츠가 자라는 박자는 목록의 진짜 코드가
//      낸다.
//   6. 애니메이션 명령은 UIKit 의 활강이다: 330ms, 느리게 출발해 느리게 서는 곡선,
//      16ms 마다 보고(기기 활강 4274.3 → 4986.7 의 표본에 맞췄다). 목표는 부른 순간
//      고정이다. 즉시 명령·MVCP 이동·손가락이 활강을 끊는다.
//   7. 빈 화면 — 커밋과 스크롤 보고마다, 창에 걸린 메시지 행이 없으면 센다. 창이 콘텐츠
//      끝 너머로 보인 길이도 잰다.
//
// 높이는 그 방에서 잰 값이다: 머리 16(빈 머리)·36(스피너)·40.33(「대화의 시작」,
// 첫 셀 y), 꼬리 8, 날짜 구분선 36, 행 57·79·101(한·두·세 줄 = seq % 3), 창 529.33.
// 시계는 가짜다 — 16ms 한 프레임씩 나아가고, 같은 입력이면 같은 사슬이 나온다.
// =============================================================================

const SELF = '11111111-2604-4000-8000-000000000001';
const MINSU = '11111111-2604-4000-8000-000000000002';
const HANEUL = '11111111-2604-4000-8000-000000000003';
const HERMES = '11111111-2604-4000-8000-000000000004';
const CHANNEL = '22222222-2604-4000-8000-000000000120';

function member(id: string, name: string, kind: 'human' | 'agent' = 'human'): RosterMember {
  return {
    id,
    workspaceId: 'ws',
    kind,
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

const DIRECTORY = makeDirectory([
  member(SELF, 'seongjae'),
  member(MINSU, 'minsu'),
  member(HANEUL, 'haneul'),
  member(HERMES, 'hermes', 'agent'),
]);

/** 오늘 정오. */
const TODAY = new Date(2026, 8, 24, 12, 0, 0).getTime();
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 목 서버 busy-120 과 같은 규칙: 줄 수 = 1 + seq % 3, 작성자는 셋이 돈다.
 * `yesterdayUpTo` 이하는 전날이다 — 그런 옛 페이지는 제 날짜 구분선을 들고 온다.
 */
function busyRow(seq: number, yesterdayUpTo: number): Message {
  const lines = 1 + (seq % 3);
  return {
    id: `m-${seq}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: seq % 3 === 0 ? HERMES : seq % 2 === 0 ? HANEUL : MINSU,
    type: 'text',
    body: Array.from({length: lines}, (_, k) => `바쁜 방 ${seq}번째 글의 ${k + 1}번째 줄입니다.`).join('\n'),
    state: 'sent',
    createdAtMs: (seq <= yesterdayUpTo ? TODAY - DAY_MS : TODAY) + seq * 60_000,
  };
}

const range = (from: number, to: number) =>
  Array.from({length: to - from + 1}, (_, i) => from + i);

// ---- 잰 기하 ---------------------------------------------------------------------
const VIEWPORT = 529.33;
const HEADER = {idle: 16, loading: 36, start: 40.33};
const FOOTER = 8;
const DIVIDER = 36;
const ROW_BY_LINES = [57, 79, 101];
const FRAME_MS = 16;
/** UIKit `setContentOffset:animated:` — 기기 표본 4274.3 → 4986.7 이 329ms 에 걸렸다. */
const GLIDE_MS = 330;

/** 테스트 렌더러의 노드 — RNTL 이 돌려주는 그 모양이다. */
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
  /** `collapsable={false}`: MVCP 가 빠져도 제 뷰를 지킨다. */
  preserved: boolean;
  /** 스페이서는 목록이 정한 높이를 들고 온다. 나머지는 정체성으로 정해진다. */
  spacer: number | null;
}

const isMessage = (id: string) => id.startsWith('m-');

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
    if (typeof key === 'string') {
      return {id: key, host, preserved: host.props.collapsable === false, spacer: null};
    }
    const reactKey = (child as unknown as {_fiber?: {key?: string | null}})._fiber?.key;
    const style = host.props.style as {height?: number} | undefined;
    return {
      id: `spacer:${reactKey ?? index}`,
      host,
      preserved: false,
      // 낡은 셀 기록으로 계산된 스페이서는 음수가 되기도 한다 — Yoga 는 0 으로 둔다.
      spacer: Math.max(0, style?.height ?? 0),
    };
  });
}

interface Frame {
  y: number;
  h: number;
}

const smooth = (k: number) => k * k * (3 - 2 * k);

// ---- 네이티브 이중 ---------------------------------------------------------------
class NativeListDouble {
  offset = 0;
  /** 창에 메시지 행이 하나도 없던 순간의 오프셋. */
  readonly blanks: number[] = [];
  /** 창이 콘텐츠 끝 너머로 보인 가장 긴 길이, pt. */
  pastEnd = 0;
  readonly shoves: number[] = [];
  /** 애니메이션 명령 수 — 진입은 「도착하는 모습이 보이지 않는다」(`convergeToEnd`). */
  glides = 0;
  private children: Child[] = [];
  private frames = new Map<string, Frame>();
  private views = new Map<string, number>();
  private pool: number[] = [];
  private nextViewId = 1;
  private anchor: {viewId: number; y: number} | null = null;
  private prevMvcp = false;
  private mounted = false;
  private announced = new Map<string, string>();
  private announcedContent = -1;
  private glide: ReturnType<typeof setTimeout>[] = [];

  constructor(
    private readonly heightOf: (child: Child) => number,
    /** 커밋에서 레이아웃 보고까지(ms). 0 은 다음 틱이다. */
    private readonly lagMs = 0,
  ) {}

  private layout(children: Child[]): Map<string, Frame> {
    const heights = children.map(child => this.heightOf(child));
    const total = heights.reduce((sum, h) => sum + h, 0);
    // `CONTENT_ALIGNMENT`: 창보다 짧은 대화는 바닥에 붙는다.
    let y = Math.max(0, VIEWPORT - total);
    const out = new Map<string, Frame>();
    children.forEach((child, index) => {
      out.set(child.id, {y, h: heights[index]});
      y += heights[index];
    });
    return out;
  }

  content(): number {
    let total = 0;
    for (const frame of this.frames.values()) total += frame.h;
    return Math.max(total, VIEWPORT);
  }

  end(): number {
    return Math.max(0, this.content() - VIEWPORT);
  }

  commit(mvcp: boolean, next: Child[]) {
    // willMount — 바뀌기 **전의** prop 이 기록 여부를 정하고, 화면의 frame 으로 기록한다.
    if (this.mounted && this.prevMvcp) this.recordAnchor();
    const forming = new Set(next.filter(child => mvcp || child.preserved).map(child => child.id));
    for (const [id, viewId] of [...this.views]) {
      if (!forming.has(id)) {
        this.pool.push(viewId);
        this.views.delete(id);
      }
    }
    for (const child of next) {
      if (forming.has(child.id) && !this.views.has(child.id)) {
        this.views.set(child.id, this.pool.pop() ?? this.nextViewId++);
      }
    }
    this.children = next;
    this.frames = this.layout(next);
    // didMount — 바뀐 **뒤의** prop 이 적용 여부를 정한다.
    if (mvcp && this.anchor !== null) {
      const anchor = this.anchor;
      const owner = [...this.views].find(([, viewId]) => viewId === anchor.viewId)?.[0];
      const frame = owner === undefined ? undefined : this.frames.get(owner);
      if (frame !== undefined && Math.abs(frame.y - anchor.y) > 0.5) {
        this.stopGlide();
        this.offset += frame.y - anchor.y;
        this.shoves.push(Math.round((frame.y - anchor.y) * 10) / 10);
        this.later(() => this.report());
      }
    }
    this.prevMvcp = mvcp;
    this.mounted = true;
    this.check();
    setTimeout(() => this.announce(), this.lagMs);
  }

  private recordAnchor() {
    let last: {viewId: number; y: number} | null = null;
    for (let index = 1; index < this.children.length; index += 1) {
      const id = this.children[index].id;
      const viewId = this.views.get(id);
      const frame = this.frames.get(id);
      if (viewId === undefined || frame === undefined) continue;
      last = {viewId, y: frame.y};
      if (frame.y + frame.h > this.offset) {
        this.anchor = last;
        return;
      }
    }
    if (last !== null) this.anchor = last;
  }

  /** 커밋 뒤의 레이아웃 보고: 셀마다 `onLayout`, 그리고 콘텐츠 크기. */
  private announce() {
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
    const content = this.content();
    if (Math.abs(content - this.announcedContent) < 0.01) return;
    this.announcedContent = content;
    screen.getByTestId('timeline-list').props.onContentSizeChange(375, content);
  }

  private clamp(to: number) {
    return Math.min(Math.max(0, to), this.end());
  }

  private stopGlide() {
    this.glide.forEach(timer => clearTimeout(timer));
    this.glide = [];
  }

  command(target: 'end' | number, animated: boolean) {
    this.later(() => {
      const to = this.clamp(target === 'end' ? this.end() : target);
      this.stopGlide();
      if (!animated) {
        this.offset = to;
        this.report();
        return;
      }
      this.glides += 1;
      const from = this.offset;
      for (let at = FRAME_MS; at < GLIDE_MS + FRAME_MS; at += FRAME_MS) {
        const k = smooth(Math.min(1, at / GLIDE_MS));
        this.glide.push(
          setTimeout(() => {
            this.offset = from + (to - from) * k;
            this.report();
          }, at),
        );
      }
    });
  }

  drag(to: number) {
    this.stopGlide();
    this.offset = this.clamp(to);
    this.report();
  }

  report() {
    screen.getByTestId('timeline-list').props.onScroll({
      nativeEvent: {
        contentOffset: {x: 0, y: this.offset},
        contentSize: {width: 375, height: this.content()},
        layoutMeasurement: {width: 375, height: VIEWPORT},
        zoomScale: 1,
      },
      timeStamp: Date.now(),
    });
    this.check();
  }

  private later(run: () => void) {
    setTimeout(run, 0);
  }

  private check() {
    const top = this.offset;
    const bottom = this.offset + VIEWPORT;
    let seen = false;
    let any = false;
    for (const [id, frame] of this.frames) {
      if (!isMessage(id)) continue;
      any = true;
      if (frame.y < bottom && frame.y + frame.h > top) {
        seen = true;
        break;
      }
    }
    if (any && !seen) this.blanks.push(Math.round(this.offset));
    this.pastEnd = Math.max(this.pastEnd, bottom - this.content());
  }

  /** 그 행이 창 윗변에서 얼마나 아래에 있는가 — 그려져 있지 않으면 null. */
  rowTop(id: string): number | null {
    const frame = this.frames.get(id);
    return frame === undefined ? null : frame.y - this.offset;
  }

  visibleMessages(): string[] {
    const out: string[] = [];
    for (const [id, frame] of this.frames) {
      if (isMessage(id) && frame.y < this.offset + VIEWPORT && frame.y + frame.h > this.offset) {
        out.push(id);
      }
    }
    return out;
  }
}

// ---- 방 --------------------------------------------------------------------------
interface RoomShape {
  firstPage: number[];
  /** 옛 페이지들, 새것부터. 비었으면 대화의 시작에 닿아 있다. */
  olderPages: number[][];
  /** 이 seq 이하는 전날이다. */
  yesterdayUpTo: number;
  /** 옛 페이지 한 장이 오는 데 걸리는 시간(ms). 기기 목 서버에서 8ms 였다. */
  networkMs: number;
  /** 커밋에서 레이아웃 보고까지(ms) — 잰 것보다 느린 기기. */
  lagMs?: number;
  /**
   * MVCP 가 빠져 있는 동안 0번 셀이 아래로 움직이는 양(pt). 기기에서 D 뒤에도 잰 값이
   * +9.33 이다(0번 셀 표본 17.7 → 25.3, 다시 붙을 때 +9.3). 이중에서는 그만큼 머리를
   * 키워 심는다 — 앵커가 움직였다는 사실만 옮기고, 까닭은 옮기지 않는다.
   */
  anchorDriftPx?: number;
}

interface StartCall {
  at: number;
  settled: boolean;
}

interface Room {
  native: NativeListDouble;
  startCalls: StartCall[];
  /** 진입이 도착을 선언한 순간(`settleEntry`)의 자리. */
  settle: {offset: number; content: number} | null;
  pillsRef: React.MutableRefObject<PillState | null>;
}

/** 목 서버 busy-120: 첫 페이지 50행, 옛 페이지 둘(반은 전날). 팀 방의 보통 모양이다. */
const TEAM_ROOM: RoomShape = {
  firstPage: range(71, 120),
  olderPages: [range(21, 70), range(1, 20)],
  yesterdayUpTo: 60,
  networkMs: 8,
};

const ROOMS: [string, RoomShape][] = [
  ['팀 방 — 첫 페이지 50행, 옛 페이지 둘(반은 전날)', TEAM_ROOM],
  [
    '옛 페이지가 없는 50행 방',
    {firstPage: range(71, 120), olderPages: [], yesterdayUpTo: 60, networkMs: 8},
  ],
  [
    '하루치 200행 방 — 옛 페이지 셋, 날짜 경계 없음',
    {
      firstPage: range(151, 200),
      olderPages: [range(101, 150), range(51, 100), range(1, 50)],
      yesterdayUpTo: 0,
      networkMs: 8,
    },
  ],
];

type ListRef = React.MutableRefObject<FlatList<TimelineStreamItem> | null>;

async function frames(room: Room, count: number) {
  for (let frame = 0; frame < count; frame += 1) {
    await act(async () => {
      jest.advanceTimersByTime(FRAME_MS);
    });
    if (room.settle === null && room.pillsRef.current?.settled === true) {
      room.settle = {offset: room.native.offset, content: room.native.content()};
    }
  }
}

async function enterRoom(shape: RoomShape): Promise<Room> {
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as ListRef;
  const pillsRef = React.createRef<PillState>() as React.MutableRefObject<PillState | null>;
  const state = {
    loadingOlder: false,
    reachedStart: shape.olderPages.length === 0,
    count: 0,
    /** MVCP 가 한 번이라도 빠졌다 — `anchorDriftPx` 가 그때부터 선다. */
    detached: false,
  };
  const heightOf = (child: Child): number => {
    if (child.spacer !== null) return child.spacer;
    if (child.id.endsWith('-header')) {
      const drift = state.detached ? shape.anchorDriftPx ?? 0 : 0;
      if (state.loadingOlder) return HEADER.loading + drift;
      return (state.reachedStart && state.count > 0 ? HEADER.start : HEADER.idle) + drift;
    }
    if (child.id.endsWith('-footer')) return FOOTER;
    if (isMessage(child.id)) return ROW_BY_LINES[Number(child.id.slice(2)) % 3];
    return DIVIDER;
  };
  const native = new NativeListDouble(heightOf, shape.lagMs ?? 0);
  const startCalls: StartCall[] = [];
  const startedAt = Date.now();
  let rendered = false;
  const onCommit = () => {
    if (!rendered) return;
    const mvcp = screen.getByTestId('timeline-list').props.maintainVisibleContentPosition != null;
    if (!mvcp) state.detached = true;
    native.commit(mvcp, contentChildren());
  };

  function RoomView(): React.JSX.Element {
    const row = (seq: number) => busyRow(seq, shape.yesterdayUpTo);
    const [messages, setMessages] = useState(() => shape.firstPage.map(row));
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [reachedStart, setReachedStart] = useState(shape.olderPages.length === 0);
    const pages = useRef(shape.olderPages.map(page => page.map(row)));
    const busy = useRef(false);
    state.loadingOlder = loadingOlder;
    state.reachedStart = reachedStart;
    state.count = messages.length;
    // `useTimeline.loadOlder` 의 모양: 부르는 중이면 무시하고, 한 장씩 앞에 붙인다.
    const onStartReached = useCallback(() => {
      startCalls.push({at: Date.now() - startedAt, settled: pillsRef.current?.settled === true});
      if (busy.current || pages.current.length === 0) return;
      busy.current = true;
      setLoadingOlder(true);
      setTimeout(() => {
        const page = pages.current.shift() ?? [];
        setMessages(current => [...page, ...current]);
        setReachedStart(pages.current.length === 0);
        setLoadingOlder(false);
        busy.current = false;
      }, shape.networkMs);
    }, []);
    return (
      <Profiler id="room" onRender={onCommit}>
        <Timeline
          messages={messages}
          directory={DIRECTORY}
          status="ready"
          channelId={CHANNEL}
          myMemberId={SELF}
          nowMs={TODAY + 121 * 60_000}
          lastReadSeq={messages[messages.length - 1]?.seq ?? null}
          unreadCount={0}
          loadingOlder={loadingOlder}
          reachedStart={reachedStart}
          onStartReached={onStartReached}
          selfSendToken={0}
          jumpPills
          pillsRef={pillsRef}
          listRef={listRef}
        />
      </Profiler>
    );
  }

  render(<RoomView />);
  rendered = true;
  const flat = listRef.current!;
  jest
    .spyOn(flat, 'scrollToEnd')
    .mockImplementation((params?: {animated?: boolean | null}) =>
      native.command('end', params?.animated !== false),
    );
  jest
    .spyOn(flat, 'scrollToOffset')
    .mockImplementation((params: {offset: number; animated?: boolean | null}) =>
      native.command(params.offset, params.animated !== false),
    );
  // 마운트: 창이 재지고(기기 t=14), 첫 커밋의 레이아웃·콘텐츠 보고가 뒤따른다.
  await act(async () => {
    onCommit();
    fireEvent(screen.getByTestId('timeline-list'), 'layout', {
      nativeEvent: {layout: {x: 0, y: 0, width: 375, height: VIEWPORT}},
    });
  });
  return {native, startCalls, settle: null, pillsRef};
}

const pt = (value: number) => (Math.abs(value) <= 1 ? 0 : Math.round(value * 10) / 10);

/** 한 방의 판정 — 빨개질 때 숫자가 한 번에 보이도록 한 객체로 묶는다. */
function verdict(room: Room) {
  const {native, settle} = room;
  return {
    /** 끝까지 남은 거리(음수는 끝을 넘음). */
    shortOfEnd: pt(native.end() - native.offset),
    /** 창에 메시지 행이 하나도 없던 커밋·보고 수. */
    blankFrames: native.blanks.length,
    /** 창이 콘텐츠 끝 너머로 보인 가장 긴 길이. */
    pastEnd: native.pastEnd <= 0.5 ? 0 : pt(native.pastEnd),
    /** 도착을 선언한 자리에서 진짜 끝까지 — 그 뒤에 자란 만큼이다. */
    settledShort: settle === null ? 'never' : pt(native.end() - settle.offset),
    /** 진입이 끝을 향해 미끄러지는 모습이 보인 횟수. */
    glides: native.glides,
    /** 진입이 앉기 전에 부른 옛 페이지. */
    olderBeforeSettled: room.startCalls.filter(call => !call.settled).length,
  };
}

const CLEAN = {
  shortOfEnd: 0,
  blankFrames: 0,
  pastEnd: 0,
  settledShort: 0,
  glides: 0,
  olderBeforeSettled: 0,
};

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  cleanup();
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('방에 들어가면 끝에 앉는다 (#2604)', () => {
  it.each(ROOMS)('%s: 빈 화면 없이, 보이지 않게, 끝에 앉는다', async (_name, shape) => {
    const room = await enterRoom(shape);
    await frames(room, 150); // 2.4초 — 기기에서 콘텐츠는 490ms 에 멈췄다.

    expect(verdict(room)).toEqual(CLEAN);
    expect(room.native.visibleMessages()).toContain(`m-${shape.firstPage[shape.firstPage.length - 1]}`);
  });

  // 도착 판정은 콘텐츠를 싣는 **모든** 보고로 증가를 읽는다. 스크롤 보고가 새 길이를
  // 먼저 싣고 콘텐츠 보고가 뒤따르면(기기: 1606.3 스크롤 보고 뒤 1543 콘텐츠 보고),
  // 콘텐츠 보고만 보는 판정에게는 아무것도 자라지 않은 것처럼 보인다.
  it('콘텐츠 보고가 스크롤 보고보다 늦게 와도, 자라는 동안 도착하지 않는다', async () => {
    const room = await enterRoom({...TEAM_ROOM, lagMs: 60});
    await frames(room, 150);

    const {settledShort, olderBeforeSettled} = verdict(room);
    expect({settledShort, olderBeforeSettled}).toEqual({settledShort: 0, olderBeforeSettled: 0});
  });

  // D 뒤에도 기기의 진입은 다시 붙을 때 +9.3pt 밀렸다 — 0번 셀이 이동 동안 그만큼
  // 내려갔다. 그 밀림은 끝을 9.3pt 넘기고(바닥이 빈 띠), 착지 유지의 첫 틱(+67ms)이
  // 끝으로 되돌렸다(`hold-correct left −9.33`). 이중에 같은 양을 심는다.
  it('다시 붙는 MVCP 가 잰 +9.3pt 를 더해도, 착지 유지가 끝으로 되돌린다', async () => {
    const room = await enterRoom({...TEAM_ROOM, anchorDriftPx: 9.33});
    await frames(room, 150);

    // 시나리오가 일어났다: 다시 붙으며 +9.3.
    expect(room.native.shoves).toContain(9.3);
    const {shortOfEnd, blankFrames, olderBeforeSettled} = verdict(room);
    expect({shortOfEnd, blankFrames, olderBeforeSettled}).toEqual({
      shortOfEnd: 0,
      blankFrames: 0,
      olderBeforeSettled: 0,
    });
    // 되돌리기 전 한 틱 동안의 띠는 그 양을 넘지 않는다.
    expect(room.native.pastEnd).toBeLessThanOrEqual(9.33 + 0.01);
  });

  // 배치가 `ENTRY_QUIET_MS` 보다 뜸하게 오는 기기에서는 도착이 배치 사이에 선다.
  // 그 뒤의 증가는 도착 뒤의 착지 유지가 받는다 — 빈 화면 없이 끝에 앉는다.
  it.each([120, 200, 300])(
    '잰 것보다 느린 기기(레이아웃 보고 %ims 뒤): 도착 뒤에 자라도 끝에 앉는다',
    async lag => {
      const room = await enterRoom({...TEAM_ROOM, lagMs: lag});
      await frames(room, 250);

      const {shortOfEnd, blankFrames, pastEnd} = verdict(room);
      expect({shortOfEnd, blankFrames, pastEnd}).toEqual({shortOfEnd: 0, blankFrames: 0, pastEnd: 0});
    },
  );

  // 진입도 도착 뒤에 착지를 붙든다. 손가락은 그 유지를 끝낸다 — 판정은 유지의 창이
  // 다 지난 뒤에 한다(N-4 와 같은 이유).
  it('도착 뒤 착지를 붙드는 동안 손가락이 목록을 잡으면, 손가락이 이긴다', async () => {
    const room = await enterRoom(TEAM_ROOM);
    for (let frame = 0; frame < 150 && room.settle === null; frame += 1) {
      await frames(room, 1);
    }
    expect(room.settle).not.toBeNull();
    await frames(room, 5); // 도착 + 80ms — 유지는 도착 + 50ms 부터 600ms

    const readAt = room.native.end() - 300;
    await act(async () => {
      fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
      room.native.drag(readAt);
    });
    await frames(room, 50); // 800ms

    expect(pt(room.native.offset - readAt)).toBe(0);
  });

  it('옛 페이지는 사람이 맨 위에 닿을 때 부르고, 붙어도 빈 화면이 없다', async () => {
    const room = await enterRoom(TEAM_ROOM);
    await frames(room, 150);
    expect(room.startCalls).toEqual([]);

    // 사람이 목록을 잡고 맨 위로 올린다. 그 보고가 옛 페이지를 부른다.
    await act(async () => {
      fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
      room.native.drag(0);
    });
    const contentBefore = room.native.content();
    await frames(room, 60);

    expect(room.startCalls.length).toBeGreaterThan(0);
    expect(room.startCalls.every(call => call.settled)).toBe(true);
    // 한 장(21–70)이 붙었다. 다음 장은 사람이 다시 맨 위에 닿을 때다.
    expect(room.native.content() - contentBefore).toBeGreaterThan(3000);
    expect(room.native.blanks).toEqual([]);
    expect(room.native.pastEnd).toBeLessThanOrEqual(0.5);
    // 붙는 동안 MVCP 는 창 맨 위의 첫 서브뷰(오늘 구분선)를 제자리에 두므로, 옛 페이지의
    // 오늘 행(61–70)은 그 구분선 **아래로** 들어온다 — 이 이슈 밖의 앞붙이기 앵커
    // 성질이라 여기서는 단정하지 않는다.
  });
});
