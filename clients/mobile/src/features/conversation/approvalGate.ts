import type {Approval} from '@momo/core/lib/api';
import type {
  AgentApprovalCard,
  ApprovalStatus,
} from '@momo/core/features/timeline/agentCardModel';

// =============================================================================
// 타임라인 승인 카드가 결정 가능한가
// =============================================================================
//
// 감사 H-1: 폰의 타임라인 승인 카드는 막다른 길이다 — 「이 결정은 인박스나
// 데스크톱 앱에서 처리할 수 있습니다」만 반복한다. 컨트롤(`ApprovalDecision`)은
// 이미 있고 잠금화면 알림과 인박스가 그것을 쓴다. 옮기면 된다.
//
// ## 그런데 사실 하나가 안 따라온다
//
// `ApprovalDecision` 은 세 가지를 받는다: `approvalId` · `reversible` ·
// `deadlinePassed`. 앞의 둘은 카드에 있다. **기한은 없다.**
//
// 타임라인 카드는 `AgentApprovalCard` 이고, 그것은 **메시지 props 로 지은
// 스냅샷**이다(`agentCardModel.ts`). 만료 시각은 거기 실리지 않는다. 인박스는
// 승인 projection(`Approval`)에서 `expiresAtMs` 를 읽어 계산한다.
//
// `deadlinePassed` 는 버튼을 막는 게이트가 아니라 **정직 문구**다: 기한이 지난
// 뒤 결정을 보내면 서버는 승인/거부가 아니라 **만료로 확정**하고, 확정 문장이 그
// 사실을 말해야 한다. 모르는 것을 `false` 로 넘기면 **그 문장이 거짓말을 한다** —
// fail-closed 규율의 정반대다.
//
// ## 그래서 카드는 「누구인지」만 말하고, 「지금 무엇이 참인가」는 원장이 말한다
//
// 메시지는 그때 일어난 일의 기록이고, 승인 목록은 지금의 사실이다. 화면이 대기
// 승인 목록을 구독하고 `approvalId` 로 맞춰 보면 세 가지가 한꺼번에 해결된다:
//
//  1. `expiresAtMs`·`isReversible` 이 **인박스와 같은 정본**에서 온다. 「인박스·
//     잠금화면과 결과가 일관된다」가 중복 구현이 아니라 **구조**로 지켜진다 —
//     두 번째 구현이 아니라 세 번째 호출자다.
//  2. **다른 데서 이미 결정된 건은 대기 목록에서 빠진다** → 컨트롤이 저절로
//     사라진다. 카드 `status` 만 보면 그 메시지가 새 프레임으로 갱신될 때까지
//     옛 상태를 그리고, 사람은 이미 끝난 결정을 다시 누를 수 있다고 읽는다.
//  3. 코어를 건드리지 않는다. 카드 모델에 만료를 더하는 쪽이 더 짧아 보이지만
//     그것은 스냅샷에 라이브 사실을 섞는 일이고, 스냅샷은 갱신되지 않는다.
//
// ## 문은 넷이고, 하나는 목록만 안다
//
// 아래 `gateFor` 가 컨트롤을 **안** 세우는 조건:
//
//   ① `approvalId === null`   결정할 대상이 없다(재개 제안은 승인이 아니다)
//   ② 카드 status ≠ pending   이미 끝난 결정
//   ③ 대기 목록에 없다        다른 데서 결정됐거나 서버가 모른다
//   ④ (호출부) 오프라인       인박스 전례대로 「연결되면 여기서」 한 줄
//
// 셋째가 이 설계의 값이다. 나머지 셋은 카드만 봐도 알지만, 셋째는 목록만 안다.
// =============================================================================

/**
 * 한 승인에 대해 **원장이 말하는** 사실.
 *
 * `deadlinePassed` 가 아니라 `expiresAtMs` 를 든다. 기한이 지났는지는 시계가
 * 움직이면 바뀌는 값이라, 여기 담아 두면 이 객체가 매 tick 마다 새 값이 되고 행의
 * `memo` 가 영영 적중하지 못한다(goal RN-P2a 가 산 것). 행은 자기가 이미 받는
 * `nowMs` 로 그때 판단한다.
 */
export interface ApprovalGate {
  approvalId: string;
  /** 서버가 **명시적으로** 가역이라 말했을 때만 참 (2R B1 의 fail-closed). */
  reversible: boolean;
  /** 서버가 기한을 실었을 때만. 없으면 모르는 것이고, 모르면 지어내지 않는다. */
  expiresAtMs: number | null;
}

/**
 * 이 채널의 대기 승인들을 id 로 찾을 수 있게 편다.
 *
 * 채널로 거르는 이유: 워크스페이스 전체의 대기 승인이 오는데, 다른 채널의 승인이
 * 이 대화의 카드와 같은 id 를 가질 일은 없지만 — 거르지 않으면 이 화면이 자기와
 * 무관한 목록의 크기만큼 일을 한다.
 */
export function approvalGates(
  approvals: readonly Approval[] | undefined,
  channelId: string,
): ReadonlyMap<string, ApprovalGate> {
  const gates = new Map<string, ApprovalGate>();
  for (const approval of approvals ?? []) {
    if (approval.channelId !== channelId) continue;
    // 목록을 `status=pending` 으로 부르지만, 서버가 다른 것을 섞어 보내면 그것을
    // 대기로 읽지 않는다. 이 파일의 규율은 「모르면 안 연다」이다.
    if (approval.status !== 'pending') continue;
    gates.set(approval.id, {
      approvalId: approval.id,
      reversible: approval.isReversible === true,
      expiresAtMs: approval.expiresAtMs ?? null,
    });
  }
  return gates;
}

/**
 * 이 카드에 컨트롤을 세울 수 있나. 세울 수 없으면 `null`.
 *
 * 네 문 중 ①②③ 을 여기서 지킨다(④ 오프라인은 화면이 안다).
 */
export function gateFor(
  card: AgentApprovalCard,
  gates: ReadonlyMap<string, ApprovalGate>,
): ApprovalGate | null {
  // ① 재개 제안에는 `approvalId` 가 없다. 승인할 것이 없는데 승인 버튼을 세우면
  //    그 버튼은 무엇을 하는지 자기도 모른다.
  if (card.approvalId === null) return null;
  // ② 카드가 이미 끝났다고 말한다.
  if (card.status !== 'pending') return null;
  // ③ 그리고 원장이 지금도 대기라고 말해야 한다.
  return gates.get(card.approvalId) ?? null;
}

/**
 * 기한이 지났는가. 기한을 **모르면 지나지 않은 것으로 보지 않고**, 지난 것으로도
 * 보지 않는다 — 모른다.
 *
 * 반환이 `false` 인 두 경우(모름 / 아직 안 지남)를 구분하지 않는 이유: 이 값이
 * 가는 곳은 확정 문장 하나이고, 그 문장은 「기한이 지나 만료로 기록됩니다」를
 * **덧붙일지 말지**만 정한다. 모를 때 덧붙이지 않는 것은 지어내지 않는 것이다.
 */
export function deadlinePassed(gate: ApprovalGate, nowMs: number): boolean {
  return gate.expiresAtMs !== null && gate.expiresAtMs <= nowMs;
}

/**
 * 결정이 끝난 카드가 말할 것.
 *
 * 문장만 들었더니 사진에서 모순이 나왔다: 영수증은 「승인을 기록했습니다」인데
 * 머리의 상태 칩은 여전히 **「승인 대기」**였다. 칩은 카드 스냅샷의 `status` 를
 * 읽고, 그 스냅샷은 서버가 새 프레임을 보낼 때까지 갱신되지 않는다.
 *
 * 원장이 방금 답해 준 상태를 함께 들면 그 창이 닫힌다 — 같은 카드가 한 줄에서
 * 두 가지를 말하지 않는다. `status` 가 없을 수 있는 이유는 `DecisionOutcome`
 * 자신이 모를 수 있기 때문이다(200 인데 알아볼 수 없는 상태). 모르면 칩은
 * 스냅샷을 그대로 둔다 — 지어내지 않는다.
 */
export interface ApprovalReceipt {
  note: string;
  status?: ApprovalStatus;
}

/** `memo` 비교용. 필드가 셋이고 전부 스칼라라 행 하나를 다시 그리는 것보다 싸다. */
export function sameApprovalGate(
  a: ApprovalGate | null | undefined,
  b: ApprovalGate | null | undefined,
): boolean {
  if (a == null || b == null) return a == null && b == null;
  return (
    a.approvalId === b.approvalId &&
    a.reversible === b.reversible &&
    a.expiresAtMs === b.expiresAtMs
  );
}
