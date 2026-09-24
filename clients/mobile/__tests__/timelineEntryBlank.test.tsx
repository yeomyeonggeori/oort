import type {Member, Message, RosterMember} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import type {TimelineStreamItem} from '@momo/core/features/timeline/model';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {act, cleanup, fireEvent, render, screen} from '@testing-library/react-native';
import React, {Profiler} from 'react';
import type {FlatList} from 'react-native';

import type {ApprovalGate} from '../src/features/conversation/approvalGate';
import {Timeline} from '../src/features/conversation/Timeline';
import {SessionProvider} from '../src/session/useSession';

// =============================================================================
// 긴 첫 페이지에 스레드·승인 행이 섞이면 목록이 통째로 빈다 (#2586)
//
// ## 잰 것 (iPhone 13 mini 375pt · iOS 26.5 · Release, 목 서버의 #배포 9행)
//
// 방을 열면 진입 수렴이 끝(422.7 = 콘텐츠 952 − 창 529.3)에 도착하고 풀린다. 그
// **2ms 뒤** 스크롤 보고가 오프셋 **1336.3** 을 말한다 — 끝을 913.7pt 넘었고, 창에는
// 행이 하나도 없다(보이는 행 0개, 렌더 범위는 0–9 전부). 이분 탐색의 방 여덟 개가
// 모두 같은 식으로 밀렸다: **밀린 양 = 목록 꼬리(footer)의 y − 첫 셀의 y**
// (배포 944 − 30.3 = 913.7, 잡담 521.3 − 371.3 = 150, approval-2 521.3 − 90 = 431.3 …).
// 평범한 글 14행만 반대로 24.3pt **모자라게** 섰다(#2604 의 한 갈래).
//
// ## 원인 (lldb 로 네이티브 앵커를 직접 읽었다)
//
//   1. 이 목록은 먼 이동 동안 `maintainVisibleContentPosition` 을 뗐다 붙였다
//      (`chasingTail`, goal RN-P3).
//   2. RN 의 `ScrollView.js:1732` 는 그 prop 의 유무로 콘텐츠 자식의 납작화를
//      정한다 — `collapsableChildren={!preserveChildren}`. 떼는 순간 셀 래퍼들이
//      납작해져 네이티브 뷰가 **재활용 풀로** 가고, 붙이는 순간 풀에서 **다른 자리로**
//      다시 나온다.
//   3. 네이티브 MVCP(`RCTScrollViewComponentView.mm`)는 뗄 때 기록한 앵커 뷰의 약한
//      포인터와 그 frame 을 들고 있다가, 다시 붙는 트랜잭션에서 「그 뷰의 지금 frame −
//      기록한 frame」만큼 contentOffset 을 **clamp 없이** 옮긴다. 그 뷰가 다른 행의
//      뷰로 재활용됐는지 보는 tag 검사(:1086)는 `enableViewCulling` 일 때만 돈다(기본 꺼짐).
//
//   실측: 앵커(구분선, tag 740, y 371.33)의 뷰가 풀에 들어갔다가(tag 0) **꼬리의 뷰로**
//   돌아왔고(tag 804, y 521.33), 그 트랜잭션에서 오프셋이 0 → 150 으로 밀렸다(잡담).
//
// ## 수리와 이 파일이 잠그는 것
//
// 셀 래퍼가 prop 과 무관하게 제 네이티브 뷰를 지킨다(`Timeline.tsx` 의 `TimelineCell`).
// 토글은 그대로 두었다 — 이유와 잰 값은 그 주석에 있다.
//
//   - 위 규칙을 옮긴 **네이티브 이중**에 잰 frame 을 주입해, 진입이 끝에 앉고 끝 행이
//     창 안에 있으며 위로 끌면 첫 행이 나오는지를 **오프셋으로** 단정한다. 수리를
//     되돌리면 이중이 기기와 같은 1336.3 을 낸다(짧은 방은 150).
//   - 그 이중이 기대는 사실 — prop 이 빠진 커밋에서도 셀 래퍼가 전부 뷰로 남는다 — 을
//     커밋마다 직접 본다. 토글이 실제로 일어났다는 것도 함께 본다(안 일어났으면 이
//     단정은 아무것도 재지 않은 것이다).
//   - 첫 페이지의 행이 전부 렌더 범위에 든다. 이것은 이 시험 환경(`testEnvironment:
//     'node'` — 네이티브 레이아웃이 없다)에서 빨개질 수 없다 — 기기에서도 렌더 범위는
//     0–9 전부였다. 빈 화면은 행이 없어서가 아니라 오프셋이 행 밖이어서였고, 그것을
//     재는 것이 이중 테스트다.
//   - (R1 H-1) 먼 전송: 이동 동안 앵커 행이 움직이면 다시 붙는 트랜잭션이 그만큼 목록을
//     끝에서 밀어낸다(기기 −78.3pt). 방금 보낸 행의 아랫변이 창 안에 있는지 단정한다.
//
// 이중은 `collapsable={false}` 인 자식만 「제 뷰를 지킨다」로 센다. 실제 Fabric 은
// testID·배경색·접근성 prop 으로도 뷰를 만든다 — 그런 방식의 대안 수리는 이 이중에서
// RED 로 읽힌다(보수적인 쪽이다, R1 N-1).
// =============================================================================

const SELF = '11111111-2586-4000-8000-000000000001';
const MINSU = '11111111-2586-4000-8000-000000000002';
const HANEUL = '11111111-2586-4000-8000-000000000003';
const HERMES = '11111111-2586-4000-8000-000000000004';
const WS = '7a2b6c1d-0000-4000-8000-000000002586';
const CHANNEL = '22222222-2586-4000-8000-000000000001';
const ROOT = '33333333-2586-4000-8000-000000000004';
const APPROVAL = '44444444-2586-4000-8000-000000000001';

function member(id: string, displayName: string, handle: string, over: Partial<RosterMember> = {}): RosterMember {
  return {
    id,
    workspaceId: WS,
    kind: 'human',
    status: 'active',
    displayName,
    handle,
    channelCount: 1,
    channelIds: [CHANNEL],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const DIRECTORY = makeDirectory([
  member(SELF, '곽성재', 'seongjae'),
  member(MINSU, '김민수', 'minsu'),
  member(HANEUL, '이하늘', 'haneul'),
  member(HERMES, '헤르메스', 'hermes', {kind: 'agent'}),
]);
const ME = {id: SELF, workspaceId: WS, displayName: '곽성재'} as Member;

const BASE_MS = 1_700_000_000_000;
const at = (minute: number) => BASE_MS + minute * 60_000;

function row(seq: number, author: string, body: string, minute: number, over: Partial<Message> = {}): Message {
  return {
    id: `33333333-2586-4000-8000-${String(seq).padStart(12, '0')}`,
    channelId: CHANNEL,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: author,
    type: 'text',
    body,
    state: 'sent',
    createdAtMs: at(minute),
    ...over,
  } as Message;
}

/**
 * 이슈의 9행 그대로다(PR #2584 캡처 중 발견한 #배포): 평범한 글 셋 + 스레드 루트
 * (롤업 2) + 채널에 인라인으로 뜬 답글 둘(하나는 나를 부른다) + 승인 카드 + 나를
 * 부르는 글 + 평범한 글.
 */
const FIXTURE: Message[] = [
  row(1, MINSU, '오늘 저녁 배포 일정 공유합니다. 19시에 스테이징부터 올립니다.', 1),
  row(2, HANEUL, '마이그레이션이 두 개 들어가요. 롤백 스크립트도 같이 확인 부탁드려요.', 4),
  row(3, HERMES, '스테이징 배포를 시작했습니다. 헬스체크 결과는 체크리스트 스레드에 남기겠습니다.', 9),
  row(4, MINSU, '배포 체크리스트', 12, {
    id: ROOT,
    thread: {reply_count: 2, last_reply_seq: 6, last_reply_at: at(21)},
  } as Partial<Message>),
  row(5, HANEUL, 'DB 백업 끝났습니다. 스냅샷 이름은 pre-0.1.6 입니다.', 15, {rootId: ROOT}),
  row(6, HERMES, '@곽성재 헬스체크 세 개가 모두 통과했습니다. 프로덕션으로 넘어가도 됩니다.', 21, {
    rootId: ROOT,
    props: {mention_member_ids: [SELF]},
  }),
  row(7, HERMES, '프로덕션 배포 실행 허가', 24, {
    type: 'approval_request',
    props: {
      approval_id: APPROVAL,
      title: '프로덕션 배포 실행 허가',
      approval_status: 'pending',
      summary: '스테이징 헬스체크가 모두 통과했습니다. v0.1.6을 프로덕션에 배포합니다.',
      is_reversible: false,
    },
  } as Partial<Message>),
  row(8, MINSU, '@곽성재 배포 로그 링크를 스레드에 올려 뒀어요. 승인 전에 한 번만 봐 주세요.', 27, {
    props: {mention_member_ids: [SELF]},
  }),
  row(9, HANEUL, '저도 로그 확인했습니다. 마이그레이션 시간은 40초 정도 걸렸어요.', 30),
];

const GATES: ReadonlyMap<string, ApprovalGate> = new Map([
  [APPROVAL, {approvalId: APPROVAL, reversible: false, expiresAtMs: null}],
]);

// ---- 잰 기하 -----------------------------------------------------------------
//
// 콘텐츠 자식의 높이를 **순서대로** — 머리, 셀들, 꼬리. 시뮬레이터의 `VirtualizedList`
// 셀 계측(`_listMetrics`)과 머리·꼬리 길이에서 옮겼다. 자리(y)는 커밋마다 높이에서
// 다시 셈한다 — 이동 동안 높이가 바뀌는 경우(R1 H-1)를 같은 이중으로 재기 위해서다.
interface Layout {
  header: number;
  cells: readonly number[];
  footer: number;
  viewport: number;
}

interface Geometry {
  frames: readonly {y: number; h: number}[];
  content: number;
  viewport: number;
}

/**
 * `CONTENT_ALIGNMENT`(`flexGrow: 1` + `flex-end`) 그대로: 창보다 짧은 콘텐츠는 창
 * 바닥으로 붙고 콘텐츠 높이는 창 높이가 된다.
 */
function geometryOf(layout: Layout): Geometry {
  const heights = [layout.header, ...layout.cells, layout.footer];
  const total = heights.reduce((sum, h) => sum + h, 0);
  let y = Math.max(0, layout.viewport - total);
  const frames = heights.map(h => {
    const frame = {y, h};
    y += h;
    return frame;
  });
  return {frames, content: Math.max(total, layout.viewport), viewport: layout.viewport};
}

/** #배포 9행: 창 529.3 · 콘텐츠 952 · 끝 422.7 (실측). */
const DEPLOY_9: Layout = {
  header: 30.33,
  // 오늘 · 행 셋 · 스레드 루트 · 인라인 답글 둘 · 승인 카드 · 멘션 · 마지막 행
  cells: [36, 79, 79, 102, 78, 98, 98, 186, 79, 78.67],
  footer: 8,
  viewport: 529.33,
};

/**
 * 짧은 방(2행)은 창 바닥에 붙는다 — 콘텐츠 = 창.
 * 실측: 머리 341 · 오늘 371.3 · 행 407.3/464.3 · 꼬리 521.3 · 창 529.3.
 */
const SHORT_2: Layout = {
  header: 30.33,
  cells: [36, 57, 57],
  footer: 8,
  viewport: 529.33,
};

/** 테스트 렌더러의 노드 — RNTL 이 돌려주는 그 모양이다. */
type ReactTestInstance = ReturnType<typeof screen.getByTestId>;

// ---- 네이티브 이중 -------------------------------------------------------------
//
// RN 0.86.2 Fabric 이 이 목록에 하는 일 중 #2586 을 만든 넷을 **그대로** 옮긴다. 넷 다
// 위 머리말의 실측으로 확인했고, 이중이 되돌린 수리에서 기기와 같은 1336.3 을 내는
// 것이 그 확인의 사본이다.
//
//   1. MVCP 가 없는 커밋에서는 콘텐츠의 직계 자식 중 `collapsable={false}` 가 아닌 것이
//      납작해져 네이티브 뷰를 잃는다(`ScrollView.js:1732`).
//   2. 잃은 뷰는 재활용 풀(후입선출)로 가고, 새로 서는 뷰는 풀에서 꺼낸다.
//   3. MVCP 가 **켜져 있던** 커밋의 시작에 첫 보이는 자식(첨자 1부터 — 머리는 건너뛴다)의
//      뷰와 frame 을 기록하고, MVCP 가 **켜진** 커밋의 끝에 그 뷰의 지금 frame 과의
//      차이만큼 오프셋을 clamp 없이 옮긴다.
//   4. JS 의 스크롤 명령은 그 명령을 부른 커밋 **뒤에** UI 스레드에서 돌고, 끝으로
//      clamp 된다. 옮긴 뒤 스크롤 보고가 JS 로 온다.
class NativeScrollDouble {
  offset = 0;
  geometry: Geometry;
  /** 다시 붙으며 앵커를 적용한 이동량들 — 시나리오가 실제로 일어났는지의 증거. */
  readonly shoves: number[] = [];
  /** prop 이 처음 빠지는 커밋에서 한 번 부른다(이동 동안의 변화를 심는 자리). */
  onDetach: (() => void) | null = null;
  private views: {role: number; viewId: number}[] = [];
  private pool: number[] = [];
  private nextViewId = 1;
  private anchor: {viewId: number; recordedY: number} | null = null;
  private prevMvcp = false;
  private observing = false;
  private queue: (() => void)[] = [];

  constructor(layout: Layout) {
    this.geometry = geometryOf(layout);
  }

  get end(): number {
    return Math.max(0, this.geometry.content - this.geometry.viewport);
  }

  /** 높이가 바뀌었다 — 네이티브는 콘텐츠 크기를 다음 틈에 보고한다. */
  setLayout(layout: Layout) {
    this.geometry = geometryOf(layout);
    const content = this.geometry.content;
    setTimeout(() => {
      screen.getByTestId('timeline-list').props.onContentSizeChange(375, content);
    }, 0);
  }

  /** 한 번의 커밋. `children` 은 콘텐츠 직계 자식들이 스스로 뷰를 지키는가. */
  commit(mvcp: boolean, children: readonly boolean[]) {
    // willMount — 옛 prop 으로 앵커를 기록한다. 이 스크롤뷰가 처음 선 커밋에는 아직
    // 관찰자가 아니므로 기록하지 않는다(RCTMountingTransactionObserverCoordinator).
    if (this.observing && this.prevMvcp) this.recordAnchor();
    if (this.prevMvcp && !mvcp && this.onDetach !== null) {
      const detach = this.onDetach;
      this.onDetach = null;
      detach();
    }

    const formsView = children.map(preserved => mvcp || preserved);
    const kept: {role: number; viewId: number}[] = [];
    for (const view of this.views) {
      if (formsView[view.role]) kept.push(view);
      else this.pool.push(view.viewId);
    }
    const next: {role: number; viewId: number}[] = [];
    formsView.forEach((forms, role) => {
      if (!forms) return;
      const had = kept.find(view => view.role === role);
      next.push(
        had ?? {role, viewId: this.pool.pop() ?? this.nextViewId++},
      );
    });
    this.views = next;

    // didMount — 새 prop 으로 앵커를 적용한다.
    if (mvcp && this.anchor !== null) {
      const now = this.views.find(view => view.viewId === this.anchor?.viewId);
      if (now !== undefined) {
        const delta = this.geometry.frames[now.role].y - this.anchor.recordedY;
        if (Math.abs(delta) > 0.5) {
          this.offset += delta; // clamp 없음 — `_adjustForMaintainVisibleContentPosition`
          this.shoves.push(Math.round(delta * 10) / 10);
          this.enqueue(() => {});
        }
      }
    }
    this.prevMvcp = mvcp;
    this.observing = true;
  }

  private recordAnchor() {
    const visible = this.views.find(
      view =>
        view.role >= 1 &&
        this.geometry.frames[view.role].y + this.geometry.frames[view.role].h >
          this.offset,
    );
    const chosen = visible ?? this.views[this.views.length - 1];
    if (chosen === undefined) return;
    this.anchor = {viewId: chosen.viewId, recordedY: this.geometry.frames[chosen.role].y};
  }

  /** 4. 명령은 커밋 뒤에 돈다 — 옮기고, 보고한다. */
  command(target: number) {
    this.enqueue(() => {
      this.offset = Math.min(Math.max(0, target), this.end);
    });
  }

  /** 손가락 — 사람이 옮긴 자리. */
  drag(to: number) {
    this.offset = Math.min(Math.max(0, to), this.end);
    this.report();
  }

  private enqueue(move: () => void) {
    this.queue.push(move);
    setTimeout(() => {
      const next = this.queue.shift();
      if (next === undefined) return;
      next();
      this.report();
    }, 0);
  }

  report() {
    const list = screen.getByTestId('timeline-list');
    list.props.onScroll({
      nativeEvent: {
        contentOffset: {x: 0, y: this.offset},
        contentSize: {width: 375, height: this.geometry.content},
        layoutMeasurement: {width: 375, height: this.geometry.viewport},
        zoomScale: 1,
      },
      timeStamp: Date.now(),
    });
  }

  /** 이 자리의 창에 걸리는 콘텐츠 자식(첨자). */
  visibleRoles(): number[] {
    const top = this.offset;
    const bottom = this.offset + this.geometry.viewport;
    return this.geometry.frames
      .map((frame, role) => ({frame, role}))
      .filter(({frame}) => frame.y + frame.h > top && frame.y < bottom)
      .map(({role}) => role);
  }
}

/** 콘텐츠 컨테이너의 직계 자식(호스트)들 — 머리, 셀들, 꼬리. */
function contentChildren(): ReactTestInstance[] {
  // jest 의 ScrollView 는 `<RCTScrollView><View>…</View></RCTScrollView>` 로 한 겹씩
  // 싼다. 자식이 하나뿐인 겹을 내려가 처음 갈라지는 노드가 콘텐츠 컨테이너다.
  let container: ReactTestInstance = screen.getByTestId('timeline-list');
  for (;;) {
    const kids = (container.children as unknown[]).filter(isInstance);
    if (kids.length !== 1) break;
    container = kids[0];
  }
  return (container.children as unknown[]).filter(isInstance).map(firstHost);
}

function isInstance(child: unknown): child is ReactTestInstance {
  return typeof child !== 'string';
}

function firstHost(node: ReactTestInstance): ReactTestInstance {
  let cursor: ReactTestInstance = node;
  while (typeof cursor.type !== 'string') {
    const next = (cursor.children as unknown[]).find(isInstance);
    if (next === undefined) return cursor;
    cursor = next;
  }
  return cursor;
}

function mvcpOnList(): unknown {
  return screen.getByTestId('timeline-list').props.maintainVisibleContentPosition;
}

type ListRef = React.MutableRefObject<FlatList<TimelineStreamItem> | null>;

/** 한 커밋에서 본 것 — prop 이 붙어 있었나, 셀 래퍼(머리·꼬리 뺀 자식)가 전부 뷰였나. */
interface CommitSeen {
  mvcp: boolean;
  cellsKeepViews: boolean;
}

function mount(messages: Message[], layout: Layout) {
  const native = new NativeScrollDouble(layout);
  const seen: CommitSeen[] = [];
  const listRef = React.createRef<FlatList<TimelineStreamItem>>() as ListRef;
  const client = new QueryClient({defaultOptions: {queries: {retry: false, gcTime: 0}}});
  // 첫 커밋(마운트)은 `render` 가 돌아오기 전에 끝나서 `screen` 이 아직 없다 — 그 한
  // 커밋은 돌아온 뒤에 같은 방식으로 읽는다(마운트 사이에 다른 커밋은 없다).
  let rendered = false;
  const onCommit = () => {
    if (!rendered) return;
    const mvcp = mvcpOnList() != null;
    const preserved = contentChildren().map(child => child.props.collapsable === false);
    seen.push({mvcp, cellsKeepViews: preserved.slice(1, -1).every(Boolean)});
    native.commit(mvcp, preserved);
  };
  const tree = (rows: Message[], selfSendToken: number) => (
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <Profiler id="timeline" onRender={onCommit}>
          <Timeline
            messages={rows}
            directory={DIRECTORY}
            status="ready"
            channelId={CHANNEL}
            myMemberId={SELF}
            nowMs={at(31)}
            lastReadSeq={rows.length}
            unreadCount={0}
            approvalGates={GATES}
            approvalsProvided
            reachedStart
            selfSendToken={selfSendToken}
            jumpPills
            listRef={listRef}
          />
        </Profiler>
      </SessionProvider>
    </QueryClientProvider>
  );
  const view = render(tree(messages, 0));
  rendered = true;
  onCommit();
  // 목록의 스크롤 명령은 네이티브 이중으로 간다(규칙 4).
  const flat = listRef.current!;
  jest.spyOn(flat, 'scrollToEnd').mockImplementation(() => native.command(native.end));
  jest
    .spyOn(flat, 'scrollToOffset')
    .mockImplementation(({offset}: {offset: number}) => native.command(offset));
  const rerender = (rows: Message[], selfSendToken: number) =>
    view.rerender(tree(rows, selfSendToken));
  return {native, seen, rerender};
}

/** 진입 — 창이 재지고, 콘텐츠가 보고되고, 수렴이 끝날 만큼 시간이 흐른다. */
async function enter(layout: Layout) {
  const geometry = geometryOf(layout);
  fireEvent(screen.getByTestId('timeline-list'), 'layout', {
    nativeEvent: {layout: {x: 0, y: 0, width: 375, height: geometry.viewport}},
  });
  fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 375, geometry.content);
  // rAF 한 번 + 수렴 라운드(50ms)들 + 풀린 뒤 네이티브가 한 번 더 도는 시간.
  await rounds(8);
}

async function rounds(count: number) {
  for (let round = 0; round < count; round += 1) {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 60));
    });
  }
}

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
});

describe('긴 첫 페이지 + 스레드·승인 행 — 목록이 비지 않는다 (#2586)', () => {
  it('진입이 끝에 앉고 끝 행이 창 안에 있다 — 위로 끌면 첫 행이 나온다 (잰 기하 주입)', async () => {
    const {native} = mount(FIXTURE, DEPLOY_9);
    await enter(DEPLOY_9);

    // 끝(422.7)에 앉았다 — 되돌린 수리에서는 1336.3(기기와 같은 값)이다.
    expect(native.offset).toBeCloseTo(952 - DEPLOY_9.viewport, 1);
    const visible = native.visibleRoles();
    // 끝 행(첨자 10 = 「저도 로그 확인했습니다…」)과 승인 카드 아래 멘션이 창 안이다.
    expect(visible).toContain(10);
    expect(visible).toContain(9);

    // 위로 끈다 — 사람의 손가락이다. 첫 행(첨자 2)과 오늘 구분선이 창 안으로 온다.
    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    await act(async () => {
      native.drag(0);
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    expect(native.visibleRoles()).toEqual(expect.arrayContaining([1, 2, 3]));
    // 그리고 그 자리에 둔다 — 끝으로 도로 끌어내리지 않는다.
    await rounds(4);
    expect(native.offset).toBe(0);
  });

  it('prop 이 빠진 커밋에서도 셀 래퍼가 전부 제 뷰로 남는다 — 진입의 토글을 지나며', async () => {
    const {seen} = mount(FIXTURE, DEPLOY_9);
    await enter(DEPLOY_9);
    // 토글은 일어났다: 진입 수렴이 prop 을 떼었고(RN-P3), 도착해 다시 붙였다.
    expect(seen.some(commit => !commit.mvcp)).toBe(true);
    expect(seen[seen.length - 1].mvcp).toBe(true);
    // 그 커밋들을 포함해 모든 커밋에서 셀 래퍼는 납작해지지 않았다(규칙 1이 닿지 않는다).
    expect(seen.filter(commit => !commit.cellsKeepViews)).toEqual([]);
  });

  it('짧은 방(2행)도 바닥에 앉은 그대로다 — 행 위로 밀려 아래가 비지 않는다', async () => {
    // 이슈 코멘트의 「AX5 짧은 방」과 같은 갈래다. 기본 크기의 실측으로 잠근다(밀림 +150).
    const messages = [
      row(1, HANEUL, '점심 뭐 먹을까요?', 20),
      row(2, MINSU, '국수 어때요. 12시 반에 나가요.', 22),
    ];
    const {native} = mount(messages, SHORT_2);
    await enter(SHORT_2);
    expect(native.offset).toBe(0);
    expect(native.visibleRoles()).toEqual(expect.arrayContaining([2, 3]));
  });

  it('첫 페이지의 모든 행이 렌더 범위에 든다', async () => {
    // 이 시험 환경(`testEnvironment: 'node'`)은 이 단정을 빨갛게 만들 수 없다 — 기기에서도
    // 렌더 범위는 0–9 전부였고 빈 화면은 오프셋이 행 밖이어서였다(위 테스트). 이 단정이
    // 지키는 것은 수리가 범위를 줄여 빈 화면을 「덜 보이게」 만드는 일이 없다는 것이다.
    mount(FIXTURE, DEPLOY_9);
    await enter(DEPLOY_9);
    for (const message of FIXTURE) {
      expect(screen.getAllByText(message.body ?? '', {exact: false}).length).toBeGreaterThan(0);
    }
    expect(contentChildren()).toHaveLength(geometryOf(DEPLOY_9).frames.length);
  });
});

// =============================================================================
// 먼 전송 — 다시 붙는 앵커가 방금 보낸 내 메시지를 창 밖으로 밀어내지 않는다 (R1 H-1)
//
// 기기(Release, 목 서버, 세 화면 뒤에서 보냄): 수렴이 끝(28407.3)에 도착해 풀린 2ms 뒤,
// prop 이 다시 붙으며 목록이 −78.3pt 밀렸고 그 뒤로 아무 일도 없었다 — 보낸 행이 목록
// 아래에서 잘렸다. 120행 방에서는 −30.6pt. 원인: 이동 동안 렌더 창이 끝으로 내려가며
// `VirtualizedList` 가 위쪽 스페이서를 셀별 기록으로 다시 셈했고(그 기록은 서로 다른
// 머리 높이 아래서 잰 것이다), 그 아래 행이 전부 함께 움직였다 — 앵커 `m-101` 도
// 8005.3 → 7984.7. 다시 붙는 트랜잭션은 그 이동량을 그대로 더한다.
//
// 이중에서는 그 스페이서 재셈을 「앵커 위의 행 하나가 78.3pt 줄었다」로 심는다 — prop 이
// 빠지는 커밋에서 한 번. 기기와 같은 양, 같은 순서다.
// =============================================================================
describe('먼 전송 — 방금 보낸 내 메시지가 창 안에 선다 (#2586 R1 H-1)', () => {
  const ROW_H = 250;
  const SENT_H = 79;
  const BEFORE: Layout = {
    header: 30.33,
    cells: [36, ...Array.from({length: 8}, () => ROW_H)], // 오늘 + 8행
    footer: 8,
    viewport: 529.33,
  };
  const HISTORY = Array.from({length: 8}, (_, i) =>
    row(i + 1, i % 2 === 0 ? MINSU : HANEUL, `거슬러 읽는 ${i + 1}번째 글`, 1 + i),
  );
  const SENT = row(9, SELF, '세 화면 뒤에서 보낸 내 메시지', 31);

  it('세 화면 뒤에서 보내면 끝에 앉고, 보낸 행의 아랫변이 창 안에 있다', async () => {
    const {native, seen, rerender} = mount(HISTORY, BEFORE);
    await enter(BEFORE);
    expect(native.offset).toBeCloseTo(native.end, 1); // 진입은 끝(1545)에 앉았다

    // 사람이 위로 올라가 읽는다 — 창 맨 위는 2번째 글(첨자 3, y 316.33)이다.
    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    await act(async () => {
      native.drag(400);
      await new Promise(resolve => setTimeout(resolve, 60));
    });
    expect(native.end - native.offset).toBeGreaterThan(BEFORE.viewport); // 먼 전송이다

    // 보낸다. 메아리 행이 끝에 붙고, prop 이 빠지는 순간 앵커 위의 행이 78.3pt 준다.
    const sent: Layout = {...BEFORE, cells: [...BEFORE.cells, SENT_H]};
    native.onDetach = () => {
      const cells = [...sent.cells];
      cells[1] = ROW_H - 78.3; // 1번째 글 — 앵커(2번째 글) 바로 위
      native.setLayout({...sent, cells});
    };
    native.setLayout(sent);
    const detachedAt = seen.length;
    rerender([...HISTORY, SENT], 1);
    await rounds(25);

    // 시나리오가 실제로 일어났다: prop 이 빠졌다가 다시 붙었고, 붙으며 −78.3 을 적용했다.
    expect(seen.slice(detachedAt).some(commit => !commit.mvcp)).toBe(true);
    expect(seen[seen.length - 1].mvcp).toBe(true);
    expect(native.shoves).toContain(-78.3);

    // 끝에 앉았고, 방금 보낸 행(마지막 셀)의 아랫변이 창 안에 있다.
    expect(native.offset).toBeCloseTo(native.end, 1);
    const frames = native.geometry.frames;
    const sentRow = frames[frames.length - 2];
    expect(sentRow.y + sentRow.h).toBeLessThanOrEqual(native.offset + BEFORE.viewport + 0.5);
  });

  // 착지 유지는 손가락에게 진다 (#2654 R2 N-4). 판정은 착지 유지의 창(도착 + 50ms 부터
  // 600ms)이 **다 지난 뒤**에 한다 — 다음 50ms 틱 전에 보면 유지가 손가락을 되돌리는
  // 것을 볼 수 없다(기존 「자리를 내준다」 시험들이 그래서 사보타주에도 초록이었다).
  it('보낸 뒤 착지를 붙드는 동안 손가락이 목록을 잡으면, 손가락이 이긴다', async () => {
    const {native, rerender} = mount(HISTORY, BEFORE);
    await enter(BEFORE);
    // 진입도 도착 뒤 착지를 붙든다(#2604). 그 유지가 끝난 뒤에 읽으러 올라간다 — 이
    // 시험은 **전송의** 유지만 잰다.
    await rounds(12);
    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    await act(async () => {
      native.drag(400);
      await new Promise(resolve => setTimeout(resolve, 60));
    });

    const sent: Layout = {...BEFORE, cells: [...BEFORE.cells, SENT_H]};
    native.onDetach = () => {
      const cells = [...sent.cells];
      cells[1] = ROW_H - 78.3;
      native.setLayout({...sent, cells});
    };
    native.setLayout(sent);
    rerender([...HISTORY, SENT], 1);
    for (let round = 0; round < 25 && !native.shoves.includes(-78.3); round += 1) {
      await rounds(1);
    }
    await rounds(2);
    // 다시 붙으며 −78.3 밀렸고, 착지 유지의 틱이 끝으로 되돌렸다 — 유지가 서 있다.
    expect(native.shoves).toContain(-78.3);
    expect(native.offset).toBeCloseTo(native.end, 1);

    // 사람이 목록을 잡고 조금 올린다 — 방금 보낸 글 위를 다시 읽으려고.
    const readAt = native.end - 300;
    fireEvent(screen.getByTestId('timeline-list'), 'scrollBeginDrag');
    await act(async () => {
      native.drag(readAt);
    });
    await rounds(12); // 720ms — 남은 유지 창 전부

    expect(native.offset).toBeCloseTo(readAt, 1);
  });
});

