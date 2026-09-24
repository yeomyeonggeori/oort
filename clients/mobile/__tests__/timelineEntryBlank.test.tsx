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
//   - 첫 페이지의 행이 전부 렌더 범위에 든다. 이것은 jsdom 에서 빨개질 수 없다 —
//     기기에서도 렌더 범위는 0–9 전부였다. 빈 화면은 행이 없어서가 아니라 오프셋이
//     행 밖이어서였고, 그것을 재는 것이 이중 테스트다.
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
// 콘텐츠 자식의 자리(frame y·높이)를 **순서대로** — 머리, 셀 열 개(오늘 구분선 + 9행),
// 꼬리. 시뮬레이터의 `VirtualizedList` 셀 계측(`_listMetrics`)과 머리·꼬리 길이에서
// 옮겼다. 창 529.3 · 콘텐츠 952 · 끝 422.7 도 같은 실측이다.
interface Geometry {
  frames: readonly {y: number; h: number}[];
  content: number;
  viewport: number;
}

const DEPLOY_9: Geometry = {
  frames: [
    {y: 0, h: 30.33}, // 머리
    {y: 30.33, h: 36}, // 오늘
    {y: 66.33, h: 79},
    {y: 145.33, h: 79},
    {y: 224.33, h: 102},
    {y: 326.33, h: 78}, // 스레드 루트
    {y: 404.33, h: 98}, // 인라인 답글
    {y: 502.33, h: 98}, // 인라인 답글(멘션)
    {y: 600.33, h: 186}, // 승인 카드
    {y: 786.33, h: 79}, // 멘션
    {y: 865.33, h: 78.67}, // 마지막 행
    {y: 944, h: 8}, // 꼬리
  ],
  content: 952,
  viewport: 529.33,
};

/**
 * 짧은 방(2행)은 `flexGrow` + `flex-end` 로 창 바닥에 붙는다 — 콘텐츠 = 창.
 * 실측: 머리 341 · 오늘 371.3 · 행 407.3/464.3 · 꼬리 521.3 · 창 529.3.
 */
const SHORT_2: Geometry = {
  frames: [
    {y: 341, h: 30.33},
    {y: 371.33, h: 36},
    {y: 407.33, h: 57},
    {y: 464.33, h: 57},
    {y: 521.33, h: 8},
  ],
  content: 529.33,
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
  private views: {role: number; viewId: number}[] = [];
  private pool: number[] = [];
  private nextViewId = 1;
  private anchor: {viewId: number; recordedY: number} | null = null;
  private prevMvcp = false;
  private observing = false;
  private queue: (() => void)[] = [];

  constructor(private readonly geometry: Geometry) {}

  get end(): number {
    return Math.max(0, this.geometry.content - this.geometry.viewport);
  }

  /** 한 번의 커밋. `children` 은 콘텐츠 직계 자식들이 스스로 뷰를 지키는가. */
  commit(mvcp: boolean, children: readonly boolean[]) {
    // willMount — 옛 prop 으로 앵커를 기록한다. 이 스크롤뷰가 처음 선 커밋에는 아직
    // 관찰자가 아니므로 기록하지 않는다(RCTMountingTransactionObserverCoordinator).
    if (this.observing && this.prevMvcp) this.recordAnchor();

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

function mount(messages: Message[], geometry: Geometry) {
  const native = new NativeScrollDouble(geometry);
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
  render(
    <QueryClientProvider client={client}>
      <SessionProvider member={ME}>
        <Profiler id="timeline" onRender={onCommit}>
          <Timeline
            messages={messages}
            directory={DIRECTORY}
            status="ready"
            channelId={CHANNEL}
            myMemberId={SELF}
            nowMs={at(31)}
            lastReadSeq={messages.length}
            unreadCount={0}
            approvalGates={GATES}
            approvalsProvided
            reachedStart
            selfSendToken={0}
            jumpPills
            listRef={listRef}
          />
        </Profiler>
      </SessionProvider>
    </QueryClientProvider>,
  );
  rendered = true;
  onCommit();
  // 목록의 스크롤 명령은 네이티브 이중으로 간다(규칙 4).
  const flat = listRef.current!;
  jest.spyOn(flat, 'scrollToEnd').mockImplementation(() => native.command(native.end));
  jest
    .spyOn(flat, 'scrollToOffset')
    .mockImplementation(({offset}: {offset: number}) => native.command(offset));
  return {native, seen};
}

/** 진입 — 창이 재지고, 콘텐츠가 보고되고, 수렴이 끝날 만큼 시간이 흐른다. */
async function enter(geometry: Geometry) {
  fireEvent(screen.getByTestId('timeline-list'), 'layout', {
    nativeEvent: {layout: {x: 0, y: 0, width: 375, height: geometry.viewport}},
  });
  fireEvent(screen.getByTestId('timeline-list'), 'contentSizeChange', 375, geometry.content);
  // rAF 한 번 + 수렴 라운드(50ms)들 + 풀린 뒤 네이티브가 한 번 더 도는 시간.
  for (let round = 0; round < 8; round += 1) {
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
    expect(native.offset).toBeCloseTo(DEPLOY_9.content - DEPLOY_9.viewport, 1);
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
    for (let round = 0; round < 4; round += 1) {
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 60));
      });
    }
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
    // jsdom 은 이 단정을 빨갛게 만들 수 없다 — 기기에서도 렌더 범위는 0–9 전부였고
    // 빈 화면은 오프셋이 행 밖이어서였다(위 테스트). 이 단정이 지키는 것은 수리가
    // 범위를 줄여 빈 화면을 「덜 보이게」 만드는 일이 없다는 것이다.
    mount(FIXTURE, DEPLOY_9);
    await enter(DEPLOY_9);
    for (const message of FIXTURE) {
      expect(screen.getAllByText(message.body ?? '', {exact: false}).length).toBeGreaterThan(0);
    }
    expect(contentChildren()).toHaveLength(DEPLOY_9.frames.length);
  });
});

