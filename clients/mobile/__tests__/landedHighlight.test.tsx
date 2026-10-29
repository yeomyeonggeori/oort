import type {Member, Message} from '@momo/core/lib/api';
import {makeDirectory} from '@momo/core/features/workspace/directory';
import {QueryClient, QueryClientProvider} from '@tanstack/react-query';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from './fixtures/darkWorld';
import React, {Profiler} from 'react';
import {AccessibilityInfo, Animated, FlatList, StyleSheet} from 'react-native';

import {color} from '../src/design/tokens';
import type {
  ApprovalGate,
  ApprovalReceipt,
} from '../src/features/conversation/approvalGate';
import {
  LANDED_HOLD_MS,
  landedApprovalOf,
} from '../src/features/conversation/landedHighlight';
import {
  LandedTintFade,
  ReduceMotionRefContext,
} from '../src/features/conversation/LandedTintFade';
import {MessageRow} from '../src/features/conversation/MessageRow';
import {Timeline} from '../src/features/conversation/Timeline';
import {LANDED_TINT_FADE_MS} from '../src/design/motion';
import {SessionProvider} from '../src/session/useSession';
import {member} from './testkit';

// =============================================================================
// #3921 — 알림 도착 강조(`rowLanded`)가 승인 뒤에도 남던 결함
//
// 성재 실측(2026-10-16, iOS 3045, 운영): 승인 푸시를 눌러 승인 카드로 도착 → 카드에서
// 「승인」 → 카드는 「승인됨 · 승인을 기록했어요」인데 행의 주황 도착 강조는 그대로 남아
// 「아직 처리할 것」처럼 보였다. #1076 이 시한을 버리고 손가락(`onScrollBeginDrag`)만
// 남긴 탓에, 스크롤하지 않으면 영원히 남았다.
//
// 규칙은 셋이고 먼저 오는 것이 이긴다(`landedHighlight.ts` 머리말):
//   ① 승인이 결정되면 곧바로  ② 이동이 **끝난 뒤** 2초  ③ 손가락
//
// ## 이 파일의 단정이 실제로 실패할 수 있는가
//
// 단정마다 일부러 구현을 깨 보고 빨개지는 것을 확인했다. 결과표는 PR 본문에 있다. 각
// `it` 의 주석 끝 「깨뜨리면」이 그 사보타주다.
//
// ## 시계
//
// 가짜 시계(modern)다. 점프의 이동은 `setInterval` + `Date.now()`, 회복은
// `requestAnimationFrame` 이라 둘 다 같은 시계로 간다. 이동이 끝나는 시각은 마지막
// 움직임 + `JUMP_SETTLE_MS`(250ms)이고, 시한은 그 뒤 `LANDED_HOLD_MS`(2,000ms)다.
// =============================================================================

const SELF = '11111111-1111-4111-8111-111111111111';
const AGENT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const BASE_MS = 1_700_000_000_000;
const CH = 'ch';

const DIRECTORY = makeDirectory([
  member({id: SELF, displayName: '곽성재', handle: 'seongjae'}),
  member({id: AGENT, kind: 'agent', displayName: '김인턴', handle: 'intern-kim'}),
]);

function plain(seq: number): Message {
  return {
    id: `msg-${seq}`,
    channelId: CH,
    seq,
    hlcTs: seq,
    hlcCount: 0,
    authorMemberId: AGENT,
    type: 'text',
    body: `${seq}번째 메시지`,
    state: 'sent',
    createdAtMs: BASE_MS + seq * 1000,
  };
}

/** 승인 요청 카드. `status` 는 카드가 든 스냅샷이다(원장이 아니다). */
function approvalMessage(status: string = 'pending'): Message {
  return {
    ...plain(5),
    id: 'msg-approval',
    type: 'approval_request',
    body: '툴 호출 승인',
    props: {
      approval_id: 'ap-1',
      title: 'github.search_issues 실행 허가',
      approval_status: status,
    },
  } as unknown as Message;
}

const APPROVAL_ID = 'msg-approval';

function history(status: string = 'pending'): Message[] {
  return [plain(1), plain(2), plain(3), plain(4), approvalMessage(status), plain(6), plain(7), plain(8)];
}

const GATE: ApprovalGate = {approvalId: 'ap-1', reversible: false, expiresAtMs: null};
const PENDING = new Map([['ap-1', GATE]]);
const NO_GATES = new Map<string, ApprovalGate>();
const RECEIPT: ApprovalReceipt = {note: '승인을 기록했어요.', status: 'approved'};
const RECEIPTS = new Map([['ap-1', RECEIPT]]);

type ListRef = React.MutableRefObject<FlatList<unknown> | null>;

interface MountProps {
  messages?: Message[];
  gates?: ReadonlyMap<string, ApprovalGate>;
  receipts?: ReadonlyMap<string, ApprovalReceipt>;
  jumpTarget?: {messageId: string; seq: number | null; token: number};
  jumpPills?: boolean;
  selfSendToken?: number;
}

/** 승인 카드의 컨트롤(`ApprovalDecision`)이 세션과 질의 클라이언트를 요구한다. */
const ME = {id: SELF, workspaceId: 'ws', displayName: '곽성재'} as Member;
const CLIENT = new QueryClient({
  defaultOptions: {queries: {retry: false, gcTime: 0}},
});

function element(listRef: ListRef, over: MountProps) {
  return (
    <QueryClientProvider client={CLIENT}>
      <SessionProvider member={ME}>
        <Timeline
          messages={over.messages ?? history()}
          directory={DIRECTORY}
          status="ready"
          channelId={CH}
          myMemberId={SELF}
          nowMs={BASE_MS}
          approvalGates={over.gates}
          approvalReceipts={over.receipts}
          approvalsProvided
          approvalOffline={false}
          jumpTarget={over.jumpTarget}
          jumpPills={over.jumpPills ?? false}
          selfSendToken={over.selfSendToken}
          listRef={listRef as never}
        />
      </SessionProvider>
    </QueryClientProvider>
  );
}

function mount(over: MountProps = {}) {
  const listRef = React.createRef<FlatList<unknown>>() as ListRef;
  const view = render(element(listRef, over));
  const rerender = (next: MountProps) =>
    act(() => {
      view.rerender(element(listRef, {...over, ...next}));
    });
  return {view, listRef, rerender};
}

function list() {
  return screen.getByTestId('timeline-list');
}

type Node = {props?: Record<string, unknown>};
/** 시험 렌더러 인스턴스 중 이 파일이 쓰는 모양만 — 타입 정의가 없어 손으로 적는다. */
type TestNode = {findAll: (predicate: (node: Node) => boolean) => unknown[]};

/** 목록이 **물들인** 행들(`landed` 참) — 판정 쪽 증거. */
function landedIds(): string[] {
  const ids: string[] = screen.UNSAFE_root
    .findAll(
      (node: Node) =>
        node.props?.landed === true &&
        typeof (node.props?.message as {id?: unknown})?.id === 'string',
    )
    .map((node: Node) => (node.props?.message as {id: string}).id);
  // `MessageRow` 는 memo 껍데기와 안쪽 둘이 같은 prop 을 들어 한 행이 두 번 잡힌다.
  return Array.from(new Set<string>(ids));
}

/** 그릇이 배경으로 입은 행의 수 — 그려진 쪽 증거. */
function tintedRows(): number {
  return screen
    .getAllByTestId('message-row')
    .filter(
      node =>
        StyleSheet.flatten(node.props.style)?.backgroundColor === color.warnSurface,
    ).length;
}

const fadeOverlay = () => screen.queryByTestId('message-row-landed-fade');

/**
 * 가짜 시계를 `ms` 만큼 보낸다 — **한 틱씩, 틱마다 act 를 닫으며**.
 *
 * 한 번에 `advanceTimersByTime(2500)` 을 부르면 그 안에서 일어난 상태 변경(이동이 끝나
 * 시계가 켜지는 것)이 act 가 닫힐 때에야 렌더되어, 시계의 효과가 **2500ms 가 다 지난 시각**에
 * 선다. 기기에서는 렌더가 곧바로 따라오므로 시계는 이동이 끝난 그 순간 켜진다. 틱을
 * 잘게 나누는 것이 그 순서를 시험에 되살린다(이동 판정 간격 `CONVERGE_ROUND_MS` 50ms 의
 * 절반).
 */
const TICK_MS = 25;
async function advance(ms: number) {
  for (let left = ms; left > 0; left -= TICK_MS) {
    await act(async () => {
      jest.advanceTimersByTime(Math.min(TICK_MS, left));
    });
  }
}

/** 목록이 오프셋 `y` 에 서 있다고 보고한다(창 800 · 콘텐츠 4000). 움직임으로 센다. */
function reportScroll(y: number) {
  act(() => {
    fireEvent.scroll(list(), {
      nativeEvent: {
        contentOffset: {y},
        contentSize: {height: 4000, width: 390},
        layoutMeasurement: {height: 800, width: 390},
      },
    });
  });
}

const JUMP = {messageId: APPROVAL_ID, seq: 5, token: 1};

beforeEach(() => {
  jest.useFakeTimers();
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(false);
  // 점프는 `scrollToIndex` 를 부른다. 레이아웃이 없는 제스트에서는 아무 일도 하지 않는다.
  jest.spyOn(FlatList.prototype, 'scrollToIndex').mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

// -----------------------------------------------------------------------------
// 순수 판정
// -----------------------------------------------------------------------------

describe('landedApprovalOf — 착지한 행의 승인 사정', () => {
  it('승인 요청이 아니면 null — 결정할 것이 없는 행은 ①의 대상이 아니다', () => {
    expect(landedApprovalOf(plain(3), {gates: PENDING, receipts: RECEIPTS})).toBeNull();
  });

  it('대기 카드 + 원장이 든다 → 결정되지 않았고 원장에 있다', () => {
    expect(landedApprovalOf(approvalMessage(), {gates: PENDING})).toEqual({
      approvalId: 'ap-1',
      decided: false,
      pendingInLedger: true,
    });
  });

  it('원장이 비어 있어도 결정으로 읽지 않는다 — 첫 읽기 전의 원장은 늘 비어 있다', () => {
    expect(landedApprovalOf(approvalMessage(), {gates: NO_GATES})).toEqual({
      approvalId: 'ap-1',
      decided: false,
      pendingInLedger: false,
    });
    expect(landedApprovalOf(approvalMessage(), {})).toMatchObject({decided: false});
  });

  it('영수증이 있으면 결정됐다 — 다른 기기가 먼저 한 superseded 도 영수증이다', () => {
    expect(landedApprovalOf(approvalMessage(), {receipts: RECEIPTS})).toMatchObject({
      decided: true,
    });
  });

  it('카드가 든 상태가 대기가 아니면 결정됐다 — 승인·거부·만료·취소 모두', () => {
    for (const status of ['approved', 'rejected', 'expired', 'cancelled']) {
      expect(landedApprovalOf(approvalMessage(status), {gates: PENDING})).toMatchObject({
        decided: true,
      });
    }
  });
});

// -----------------------------------------------------------------------------
// 수용기준 (1) — 승인 카드 도착 → 결정 이벤트 → 강조 해제
// -----------------------------------------------------------------------------

describe.each([[false], [true]])('jumpPills=%s', jumpPills => {
  // 채널(필 있음)과 스레드 패널(필 없음)이 같은 규칙을 탄다 — 보이는 행 보고는 후자에 없다.
  const base: MountProps = {jumpPills, gates: PENDING};

  describe('(1) 승인이 결정되면 곧바로 거둔다', () => {
    it('이 기기에서 결정했다 — 영수증이 서는 그 커밋에서 틴트가 물러난다', async () => {
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(400); // 이동이 끝나 시계가 켜졌다. 시한(2초)은 한참 남았다.
      expect(landedIds()).toEqual([APPROVAL_ID]);
      expect(tintedRows()).toBe(1);

      // 영수증만 선다 — 원장은 아직 그 승인을 대기로 든다. 결정 직후의 실제 순서다
      // (`onApprovalSettled` 가 영수증을 세우고 원장 재조회는 그 뒤에 온다). 원장이 같이
      // 비면 「있다가 사라짐」 길이 대신 거두므로, 이 단정이 영수증 길을 홀로 잰다.
      rerender({jumpTarget: JUMP, receipts: RECEIPTS});

      // 시계를 한 틱도 더 보내지 않았다 — 시한이 아니라 결정이 거뒀다.
      expect(landedIds()).toEqual([]);
      expect(tintedRows()).toBe(0);
      // 깨뜨리면: `landedHighlight.ts` 의 `decided` 에서 영수증 검사를 빼면 이 단정이 빨갛다.
    });

    it('다른 기기·알림 버튼 — 서버가 카드를 알려(message.edited, #3771) 카드 상태가 바뀌어 들어온다', async () => {
      // 이 시험은 사슬의 **끝**만 재생한다: 목록이 새 카드를 받은 뒤의 props. 사슬 전체
      // (레일 → `useTimeline` → 목록)는 `pushTap.test.tsx` 의 레일 시험이 돈다.
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(400);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      rerender({jumpTarget: JUMP, messages: history('expired')});

      expect(landedIds()).toEqual([]);
      // 깨뜨리면: `decided` 에서 `card.status !== 'pending'` 검사를 빼면 빨갛다.
    });

    it('대기 원장에서 **있다가 사라지면** 결정이다 — 카드가 아직 대기로 남은 길', async () => {
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(400);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      // 카드 스냅샷은 아직 대기다 — 카드 행을 알리지 않는 길(만료·취소: 서버는 `approval` 행만
      // 갱신하고 새 줄을 올린다)이거나 그 프레임보다 원장 재조회가 먼저 온 순서다. 이때는 원장만 안다.
      rerender({jumpTarget: JUMP, gates: NO_GATES});

      expect(landedIds()).toEqual([]);
      // 깨뜨리면: 결정 효과의 `ledgerHeldRef` 전이 검사를 빼면 빨갛다.
    });

    it('원장이 **처음부터 비어 있으면** 결정이 아니다 — 알림으로 도착한 순간의 정상 상태', async () => {
      // 알림 탭은 원장 캐시를 무효화만 한다. 착지하는 순간 원장에 그 승인이 없는 것이
      // 정상이다. 이것을 결정으로 읽으면 도착하자마자 틴트가 꺼진다.
      const {rerender} = mount({jumpPills, gates: NO_GATES});
      rerender({jumpTarget: JUMP});
      await advance(1000);

      expect(landedIds()).toEqual([APPROVAL_ID]);
      expect(tintedRows()).toBe(1);

      // 그 뒤 원장이 읽혀 승인이 들어와도 — 있었다가 사라진 적이 없으니 — 그대로다.
      rerender({jumpTarget: JUMP, gates: PENDING});
      await advance(200);
      expect(landedIds()).toEqual([APPROVAL_ID]);
      // 깨뜨리면: `pendingInLedger` 거짓을 곧바로 결정으로 읽으면 첫 단정이 빨갛다.
    });

    it('도착했을 때 이미 결정된 카드는 틴트를 입지 않는다 — 켰다 녹이지도 않는다', async () => {
      const { rerender } = mount({jumpPills, messages: history('approved')});
      rerender({jumpTarget: JUMP});

      // 시계를 한 틱도 보내기 전이다. 세웠다가 결정 효과가 거둔 것이라면 같은 act 안에서
      // 틴트가 켜졌다 녹기 시작해 덮개가 서 있다 — 처음부터 안 입혔다면 덮개도 없다.
      expect(landedIds()).toEqual([]);
      expect(tintedRows()).toBe(0);
      expect(fadeOverlay()).toBeNull();

      await advance(400);
      expect(landedIds()).toEqual([]);
      // 깨뜨리면: 점프 효과의 `alreadyDecided` 를 빼면 첫 `fadeOverlay` 단정이 빨갛다.
    });

    it('승인 요청이 아닌 행은 영수증과 무관하다 — 시한만 적용된다', async () => {
      const { rerender } = mount({jumpPills, receipts: RECEIPTS});
      rerender({jumpTarget: {messageId: 'msg-3', seq: 3, token: 1}});
      await advance(400);

      expect(landedIds()).toEqual(['msg-3']);
    });
  });

  // ---------------------------------------------------------------------------
  // (2) 보임 확인 전에는 타이머가 시작되지 않는다 — 재측정 경로 포함
  // ---------------------------------------------------------------------------

  describe('(2) 이동이 끝나기 전에는 시계가 없다', () => {
    it('애니메이션이 도는 동안 시한이 지나도 거두지 않는다', async () => {
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      // 점프 애니메이션: 100ms 마다 목록이 움직인다. 1.2 초 동안.
      for (let step = 1; step <= 12; step += 1) {
        await advance(100);
        reportScroll(100 * step);
      }
      // 시한(2초)을 **점프를 건 시각부터** 쟀다면 여기(2.3초)서는 이미 꺼졌다.
      await advance(1100);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      // 이동이 멎은 것은 1.45 초 즈음이고, 시한은 거기서부터 2 초다.
      await advance(1300);
      expect(landedIds()).toEqual([]);
      // 깨뜨리면: 점프 효과에서 `holdMs` 를 `LANDED_HOLD_MS` 로 곧바로 세우면(이동 끝을
      // 기다리지 않으면) 2.3 초 지점의 단정이 빨갛다.
    });

    it('아직 안 잰 행이라 `onScrollToIndexFailed` 회복이 도는 동안에도 시계가 없다', async () => {
      // 가상 목록처럼 첫 `scrollToIndex` 가 그 자리에서 실패를 알린다. 회복은 대략의
      // 자리로 한 번 밀고, 다음 프레임에 다시 묻는다. 그 프레임을 붙들어 회복을 열어
      // 둔다 — 이동은 `JUMP_TRAVEL_MAX_MS`(1.5초)까지 끝나지 않는다.
      let calls = 0;
      jest
        .spyOn(FlatList.prototype, 'scrollToIndex')
        .mockImplementation(function (this: FlatList<unknown>, params) {
          calls += 1;
          if (calls > 1) return;
          this.props.onScrollToIndexFailed?.({
            index: params.index,
            averageItemLength: 70,
            highestMeasuredFrameIndex: 1,
          });
        });
      jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});
      const frames: Array<() => void> = [];
      jest
        .spyOn(globalThis, 'requestAnimationFrame')
        .mockImplementation(callback => {
          frames.push(() => callback(0));
          return frames.length;
        });

      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      expect(calls).toBe(1); // 실패했고, 회복의 다음 프레임이 대기 중이다.

      // 시한(2초)이 점프 시각부터였다면 여기서 꺼진다. 회복이 열려 있는 동안은 아니다.
      await advance(1400);
      expect(landedIds()).toEqual([APPROVAL_ID]);
      await advance(900); // 2.3 초 — 백스톱(1.5초)이 이동을 닫았고, 시한은 거기서부터다.
      expect(landedIds()).toEqual([APPROVAL_ID]);

      await advance(1300); // 3.6 초
      expect(landedIds()).toEqual([]);
      // 깨뜨리면: 위와 같다 — 시계를 이동 끝(`onLanded`)이 아니라 점프 시각에 켜면 2.3 초
      // 지점의 단정이 빨갛다.
    });

    it('회복이 끝나 다시 앉으면 그때부터 센다', async () => {
      let calls = 0;
      jest
        .spyOn(FlatList.prototype, 'scrollToIndex')
        .mockImplementation(function (this: FlatList<unknown>, params) {
          calls += 1;
          if (calls > 1) return;
          this.props.onScrollToIndexFailed?.({
            index: params.index,
            averageItemLength: 70,
            highestMeasuredFrameIndex: 1,
          });
        });
      jest.spyOn(FlatList.prototype, 'scrollToOffset').mockImplementation(() => {});

      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(50); // 회복 프레임이 돌아 두 번째 `scrollToIndex` 가 나갔다.
      expect(calls).toBe(2);
      await advance(400); // 움직임이 없으니 이동이 끝났다.
      expect(landedIds()).toEqual([APPROVAL_ID]);

      await advance(1700); // 이동이 끝난 지 1.9초 안팎 — 시한(2초) 직전
      expect(landedIds()).toEqual([APPROVAL_ID]);
      await advance(500);
      expect(landedIds()).toEqual([]);
    });

    it('이동이 거둬져 끝나지 않아도 시계가 영영 안 켜지지는 않는다 — 전송이 걸린 이동을 거둔다', async () => {
      // 새 요청(전송·「최신으로」·「안읽음으로」)은 걸린 이동을 판정 없이 거두고, 거둔 이동은
      // `onLanded` 를 부르지 않는다. 그 착지가 다시 손가락만 기다리면 #3921 이전의 결함이
      // 좁은 길로 남는다 — 백스톱(1.6초) 뒤에 시계가 켜진다.
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(100);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      rerender({jumpTarget: JUMP, selfSendToken: 1}); // 사람이 전송한다 → 이동이 거둬진다

      // 이동이 끝나는 길이 없다: 이동 끝 + 2초(≈0.4 + 2 초)로는 거둬지지 않는다. 상한은 백스톱
      // (1.6초) + 시한(2초) = 3.7초다.
      await advance(2500); // 2.6초
      expect(landedIds()).toEqual([APPROVAL_ID]);

      await advance(1400); // 4.0초
      expect(landedIds()).toEqual([]);
      // 깨뜨리면: 시계 효과의 백스톱(`landedHoldMs === null` 갈래)을 지우면 영영 남아 빨갛다.
    });
  });

  // ---------------------------------------------------------------------------
  // (3) 보임 뒤 시한 경과 → 해제
  // ---------------------------------------------------------------------------

  describe('(3) 이동이 끝난 뒤 약 2초가 지나면 거둔다', () => {
    it('어느 행이든 — 승인 카드가 아니어도', async () => {
      const { rerender } = mount({jumpPills});
      rerender({jumpTarget: {messageId: 'msg-3', seq: 3, token: 1}});
      await advance(400);
      expect(landedIds()).toEqual(['msg-3']);

      await advance(LANDED_HOLD_MS - 600); // 시한 직전(이동이 끝난 지 1.8초)
      expect(landedIds()).toEqual(['msg-3']);
      expect(tintedRows()).toBe(1);

      await advance(600);
      expect(landedIds()).toEqual([]);
      expect(tintedRows()).toBe(0);
      // 깨뜨리면: `LANDED_HOLD_MS` 를 `Infinity` 로 두면 마지막 단정이 빨갛다(예전 규칙).
    });

    it('아직 결정되지 않은 승인 카드도 시한에는 물러난다', async () => {
      // 승인을 기다리는 동안 틴트가 상태를 겸하지 않는다 — 상태는 카드의 칩과 버튼이 말한다.
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(400);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      await advance(LANDED_HOLD_MS + 100);
      expect(landedIds()).toEqual([]);
    });

    it('같은 행으로 다시 점프하면 시계가 새로 선다', async () => {
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(1900); // 앞 시계는 이동이 끝난(0.25초) 뒤 1.65초째 — 0.35초 뒤에 꺼질 참이다.
      expect(landedIds()).toEqual([APPROVAL_ID]);

      rerender({jumpTarget: {...JUMP, token: 2}});
      await advance(1000); // 앞 시계의 시한(2.25초)을 한참 지났다. 새 이동은 0.25초에 끝났고 새 시계는 0.75초째다.
      expect(landedIds()).toEqual([APPROVAL_ID]);

      await advance(1500); // 새 시계의 시한(2초)을 넘겼다
      expect(landedIds()).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // (4) 드래그 해제 유지
  // ---------------------------------------------------------------------------

  describe('(4) 손가락이 닿으면 언제나 거둔다', () => {
    it('이동 중 — 시계가 켜지기 전', async () => {
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(100);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      act(() => {
        fireEvent(list(), 'scrollBeginDrag');
      });

      expect(landedIds()).toEqual([]);
      expect(tintedRows()).toBe(0);
      // 깨뜨리면: `onScrollBeginDrag` 의 `setLanded(null)` 을 지우면 빨갛다.
    });

    it('이동이 끝난 뒤 — 시계가 도는 중. 시계가 되살려 놓지도 않는다', async () => {
      const {rerender} = mount(base);
      rerender({jumpTarget: JUMP});
      await advance(400);
      expect(landedIds()).toEqual([APPROVAL_ID]);

      act(() => {
        fireEvent(list(), 'scrollBeginDrag');
      });
      expect(landedIds()).toEqual([]);

      await advance(LANDED_HOLD_MS * 2);
      expect(landedIds()).toEqual([]);
    });
  });
});

// -----------------------------------------------------------------------------
// (5) 감소된 동작 — 머무는 시간은 그대로, 전환만 즉시
// -----------------------------------------------------------------------------

describe('(5) 「동작 줄이기」', () => {
  /** 덮개가 녹는 데 쓰는 애니메이션 호출만 센다 — 다른 애니메이션은 이 시험의 관심이 아니다. */
  function fadeRuns(timing: jest.SpyInstance): number {
    return timing.mock.calls.filter(
      ([, config]) =>
        (config as {duration?: number}).duration === LANDED_TINT_FADE_MS,
    ).length;
  }

  /** 시계가 켜진 뒤 25ms 씩 보내며 틴트가 물러나는 **그 틱**에서 멈춘다. */
  async function landThenExpire(reduce: boolean) {
    (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(reduce);
    const {rerender} = mount({jumpPills: true});
    await advance(0);
    await act(async () => {}); // `useReduceMotionRef` 의 첫 답이 ref 에 들어온다.
    rerender({jumpTarget: {messageId: 'msg-3', seq: 3, token: 1}});
    await advance(400);
    expect(landedIds()).toEqual(['msg-3']);
    await advance(LANDED_HOLD_MS - 600);
    expect(landedIds()).toEqual(['msg-3']); // 머무는 시간은 설정과 무관하다.
    for (let tick = 0; tick < 40 && landedIds().length > 0; tick += 1) {
      await advance(TICK_MS);
    }
    expect(landedIds()).toEqual([]);
  }

  it('켜져 있으면 덮개 없이 즉시 거둔다 — 시한은 그대로 2초', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await landThenExpire(true);

    // 물러난 **그 틱**에 그릇은 배경을 벗었고 덮개도 애니메이션도 없다.
    expect(tintedRows()).toBe(0);
    expect(fadeOverlay()).toBeNull();
    expect(fadeRuns(timing)).toBe(0);
    // 깨뜨리면: `Leaving` 의 `instant` 를 항상 거짓으로 두면 위 두 단정이 빨갛다.
  });

  it('꺼져 있으면 같은 색의 덮개가 이어받아 녹으며 사라진다', async () => {
    const timing = jest.spyOn(Animated, 'timing');
    await landThenExpire(false);

    // 그릇은 배경을 벗었고, 덮개가 같은 색으로 이어받았다(첫 커밋의 색·면·불투명도는 아래 행 단위 시험이 단정한다).
    expect(tintedRows()).toBe(0);
    const overlay = fadeOverlay();
    expect(overlay).not.toBeNull();
    expect(StyleSheet.flatten(overlay!.props.style).backgroundColor).toBe(
      color.warnSurface,
    );
    // 불투명도를 0 으로, 정해진 시간 동안, 네이티브 드라이버로(JS 스레드가 바빠도 돈다).
    expect(fadeRuns(timing)).toBe(1);
    expect(timing).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        toValue: 0,
        duration: LANDED_TINT_FADE_MS,
        useNativeDriver: true,
      }),
    );

    await advance(LANDED_TINT_FADE_MS + 100);
    expect(fadeOverlay()).toBeNull();
    // 깨뜨리면: `LandedTintFade` 를 지우면 `overlay` 단정이 빨갛다(말없이 툭 꺼진다).
  });
});

// -----------------------------------------------------------------------------
// 전환 한 번을 행 단위로 — `LandedTintFade`
// -----------------------------------------------------------------------------

describe('LandedTintFade — 행 하나의 전환', () => {
  function row(landed: boolean, reduce?: boolean) {
    const tree = (
      <MessageRow
        message={plain(3)}
        startsGroup
        directory={DIRECTORY}
        chips={[]}
        landed={landed}
        nowMs={BASE_MS}
      />
    );
    return reduce === undefined ? (
      tree
    ) : (
      <ReduceMotionRefContext.Provider value={{current: reduce}}>
        {tree}
      </ReduceMotionRefContext.Provider>
    );
  }

  it('한 번도 선 적 없는 행에는 덮개가 없다 — 모든 행이 지는 비용은 null 하나다', () => {
    render(row(false));
    expect(fadeOverlay()).toBeNull();
  });

  it('서 있는 동안에는 덮개가 없다 — 그릇의 배경이 입는다', () => {
    render(row(true));
    expect(fadeOverlay()).toBeNull();
    expect(
      StyleSheet.flatten(screen.getByTestId('message-row').props.style)
        .backgroundColor,
    ).toBe(color.warnSurface);
  });

  it('참에서 거짓이 되는 순간에만 덮개가 선다', async () => {
    const view = render(row(true, false));
    view.rerender(row(false, false));

    expect(fadeOverlay()).not.toBeNull();
    expect(
      StyleSheet.flatten(screen.getByTestId('message-row').props.style)
        .backgroundColor,
    ).toBeUndefined();
    // 덮개는 내용을 가리지 않고 터치를 먹지 않는다.
    expect(fadeOverlay()!.props.pointerEvents).toBe('none');

    await advance(LANDED_TINT_FADE_MS + 100);
    expect(fadeOverlay()).toBeNull();
  });

  // 갈아입는 순간의 모양 셋. 각각 **관측할 수 있는 것만** 말한다 — RNTL 의 `rerender` 는 `act` 로
  // 감싸 효과를 다 비운 뒤에 돌아오므로, 아래 둘째·셋째 시험이 보는 것은 갈아입은 **직후의 정상
  // 상태**이지 커밋 한 번의 중간이 아니다. 「한 커밋」은 첫째 시험이 `Profiler` 로 센다.
  // 시험은 React 트리까지만 본다: 화면 픽셀로는 재지 않았다(design-review M-1·N-8).

  it('덮개는 `landed` 가 뒤집히는 그 한 커밋에 선다 — 효과로 미루면 커밋이 둘이 되어 한 프레임이 깜빡인다', () => {
    const phases: string[] = [];
    const tree = (landed: boolean) => (
      <Profiler
        id="fade"
        onRender={(_id, phase) => {
          phases.push(phase);
        }}>
        <LandedTintFade landed={landed} />
      </Profiler>
    );
    const view = render(tree(true));
    phases.length = 0; // 마운트 커밋은 세지 않는다.

    view.rerender(tree(false));

    // 커밋 한 번이 덮개까지 그렸다. `wasLanded` 비교를 렌더 중 파생 상태에서 효과로 미루면 배경만
    // 벗은 커밋이 먼저 그려지고(덮개 없음) 효과가 덮개를 세우는 둘째 커밋이 따른다. 여기서 세는 것은
    // 덮개 쪽 커밋이다 — 그릇의 배경은 같은 `landed` prop 이 한 렌더에서 그릇 스타일과
    // `LandedTintFade` 두 곳에 닿는 구조(`MessageRow`)가 같은 커밋에 벗기며, 시험이 직접 세지는 않는다.
    expect(phases).toEqual(['update']);
    expect(fadeOverlay()).not.toBeNull();
  });

  it('갈아입은 직후 덮개는 그릇이 벗은 면을 같은 색·불투명도 1 로, 그 밖의 것 없이 덮는다', () => {
    const view = render(row(true, false));
    const standing = StyleSheet.flatten(
      screen.getByTestId('message-row').props.style,
    );
    expect(standing.backgroundColor).toBe(color.warnSurface);
    // 서 있는 착지의 테두리 덧그림(#4300) — 덮개는 같은 테두리를 들고 녹는다.
    const standingEdge = StyleSheet.flatten(
      screen.getByTestId('message-row-landed-edge').props.style,
    );
    expect(standingEdge.borderColor).toBe(color.warnBorder);

    view.rerender(row(false, false));

    // 그릇은 배경을 벗었고,
    expect(
      StyleSheet.flatten(screen.getByTestId('message-row').props.style)
        .backgroundColor,
    ).toBeUndefined();
    // 덮개는 벗은 색 그대로(서 있던 값과 대조), 그릇 전체(네 변 0), 불투명도 1 — 그리고 `margin` 같은
    // 다른 키가 없다(`toEqual`: 있으면 면이 그릇과 달라진다).
    expect(StyleSheet.flatten(fadeOverlay()!.props.style)).toEqual({
      position: 'absolute',
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      // 그릇이 화면 끝에서 띄운 둥근 상자라(`rowFace.ts`) 덮개도 **같은 모서리**다 — 사각형 덮개가
      // 둥근 서 있는 면 위에 올라 물러나는 순간 모서리가 튀면 안 된다(#4300 세 겹 사보타주).
      borderRadius: standing.borderRadius,
      borderWidth: standingEdge.borderWidth,
      borderColor: standingEdge.borderColor,
      backgroundColor: standing.backgroundColor,
      opacity: 1,
    });
  });

  it('덮개는 그릇의 직계 자식이고 내용보다 먼저 그려진다 — 내용 뒤에 깔리고 그릇 전체를 덮는다', () => {
    const view = render(row(true, false));
    view.rerender(row(false, false));

    const container = screen.getByTestId('message-row');
    // 덮개에서 가장 가까운 호스트 부모가 그릇 자신이다 — 안쪽 `Pressable`·래퍼 `View` 안에 들어가면
    // 「그릇 전체」가 아니라 그 안쪽 상자만 덮는다. 인스턴스끼리 `toBe` 로 비교하지 않는 이유: 실패하면
    // jest 가 시험 렌더러 트리 전체를 찍느라 멈춘다(S23 사보타주가 타임아웃으로만 잡혔다).
    let parent = fadeOverlay()!.parent;
    while (parent !== null && typeof parent.type !== 'string') parent = parent.parent;
    expect(parent?.props?.testID).toBe('message-row');
    // 그릇의 자식 순서에서 덮개가 내용(`message-press`)보다 앞이다 — 뒤에 서면 불투명도 1 의 앰버가
    // 글자를 덮는다.
    const childIndex = (testID: string) =>
      container.children.findIndex(
        (child: TestNode | string) =>
          typeof child !== 'string' &&
          child.findAll((node: Node) => node.props?.testID === testID).length > 0,
      );
    expect(childIndex('message-row-landed-fade')).toBeGreaterThanOrEqual(0);
    expect(childIndex('message-press')).toBeGreaterThan(
      childIndex('message-row-landed-fade'),
    );
  });

  it('녹는 도중 같은 행이 다시 서면 덮개를 거둔다 — 틴트가 두 겹이 되지 않는다', () => {
    const view = render(row(true, false));
    view.rerender(row(false, false));
    expect(fadeOverlay()).not.toBeNull();

    view.rerender(row(true, false));

    expect(fadeOverlay()).toBeNull();
    expect(
      StyleSheet.flatten(screen.getByTestId('message-row').props.style)
        .backgroundColor,
    ).toBe(color.warnSurface);
  });

  it('동작 줄이기면 덮개가 한 번도 서지 않는다', () => {
    const view = render(row(true, true));
    view.rerender(row(false, true));

    expect(fadeOverlay()).toBeNull();
  });

  it('컨텍스트가 없는 표면은 움직임을 줄이지 않은 것으로 읽는다', () => {
    const view = render(row(true));
    view.rerender(row(false));

    expect(fadeOverlay()).not.toBeNull();
  });
});
