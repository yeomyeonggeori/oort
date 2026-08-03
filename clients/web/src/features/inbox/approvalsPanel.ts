import type { FeedItem } from "@momo/core/features/inbox/model";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";

// =============================================================================
// 승인함의 판정들 (goal W-AP1). 순수 함수만, DOM 없이 단언 가능하게.
//
// 이 파일이 존재하는 이유는 취향이 아니라 이 표면이 **되돌릴 수 없는 액션**을
// 다루기 때문이다. 승인은 이 제품에서 되돌릴 수 없는 유일한 액션 계열이고,
// 그러므로 "언제 결정 컨트롤을 세우는가"와 "결정의 답을 무슨 색으로 말하는가"는
// 컴포넌트 안에서 삼항 연산자로 흩어져 있으면 안 된다. 흩어지면 조건 하나가
// 조용히 뒤집혀도 아무 테스트도 이름을 부르며 실패하지 않는다.
//
// 세 가지 판정이 여기 산다:
//   ① `approvalsPanelState` — 목록 한 판이 지금 무엇인가 (4상태 + 목록).
//   ② `approvalRowControl`  — 이 행에 결정 컨트롤을 붙일 자격이 있는가.
//   ③ `decisionNote`        — 원장이 답한 것을 사람에게 무엇이라 말하는가.
// =============================================================================

// ---- ① 목록 한 판의 상태 ---------------------------------------------------

/**
 * 이 표면의 의무 4상태(design-taste-web §5)에 목록을 더한 것.
 *
 * `unavailable`이 `error`와 **다른 칸**인 것이 이 goal의 핵심이다. 서버가
 * "그런 경로 없다"고 답한 것(404/405/501)은 장애가 아니라 아직 없는 기능이고,
 * 그 둘을 한 칸에 넣으면 화면은 기다리면 될 일을 다시 시도할 일로 말한다
 * (features/capabilities/serverSurfaces.ts 상단의 규약).
 */
export type PanelState = "unavailable" | "loading" | "error" | "empty" | "list";

export interface PanelInput {
  /** 첫 응답이 아직 오지 않았다. */
  isLoading: boolean;
  /** 서버가 이 경로를 모른다고 직접 답했다(`serverSaysAbsent`). */
  absent: boolean;
  /** 그 밖의 실패. 네트워크·5xx·권한. */
  error: boolean;
  /** 지금 손에 있는 행의 수. 캐시된 행도 포함한다. */
  count: number;
}

/**
 * 순서가 곧 정직함이다.
 *
 * 1. `absent`가 가장 먼저다. 캐시에 행이 남아 있더라도, 결정을 받아 줄 경로가
 *    없는 서버에서 결정 컨트롤이 달린 목록을 그리는 것은 누를 수 없는 버튼을
 *    세우는 일이다. 이 표면에서 그것은 "허가를 기다리는 일이 있다"는 거짓말이다.
 * 2. 그다음이 로딩이다. 단, **손에 행이 있으면 로딩으로 덮지 않는다**(P15):
 *    재조회 때마다 목록이 스켈레톤으로 바뀌면 결정하려던 행이 눈앞에서 사라진다.
 * 3. 오류도 같은 규칙이다. 마지막으로 받은 목록이 있으면 그것을 계속 보여 준다.
 * 4. 행이 없으면 빈 상태. 인박스에서 비어 있음은 실패가 아니라 설계가 작동한
 *    모습이고, 그 문구는 호출자가 갖는다.
 */
export function approvalsPanelState(input: PanelInput): PanelState {
  if (input.absent) return "unavailable";
  if (input.count > 0) return "list";
  if (input.isLoading) return "loading";
  if (input.error) return "error";
  return "empty";
}

// ---- ② 행 하나의 결정 컨트롤 -----------------------------------------------

/**
 * 이 행이 지금 받을 컨트롤.
 *
 *   none    아무것도 붙지 않는다.
 *   offline 자리는 지키고 왜 지금 결정할 수 없는지 말한다.
 *   decide  승인/거부 2단 컨트롤. 결정을 보낼 `approvalId`를 함께 싣는다.
 *
 * `decide`가 id를 실어 나르는 것은 편의가 아니다. 컨트롤을 세울 자격과 결정을
 * 보낼 주소가 같은 판정에서 나와야, 화면이 "세워도 된다"고 판정한 행과 결정이
 * 날아가는 행이 갈라질 수 없다.
 */
export type RowControl =
  | { kind: "none" }
  | { kind: "offline" }
  | { kind: "decide"; approvalId: string };

/**
 * 결정할 수 있는 행인가.
 *
 * 자격은 **서버가 준 사실 하나**로 정한다: `approvalId`. `approvalItem`
 * (@momo/core features/inbox/model)은 `status === "pending"`인 승인에만 그 값을
 * 싣는다. 그러므로 이미 승인된·거부된·만료된·취소된 행에는 붙을 자리가 없고,
 * 그 판정을 이 파일이 다시 계산하지 않는다: 같은 사실을 두 곳에서 계산하면
 * 한쪽만 고쳐지는 날이 온다.
 *
 * `kind` 검사가 함께 있는 이유는 방어가 아니라 **계약**이다. 이 목록에는 멘션과
 * 작업 실행 행이 섞여 들어올 수 있고(에이전트 탭), 승인이 아닌 행이 승인 결정
 * 컨트롤을 받는 일은 어떤 경우에도 일어나면 안 된다.
 *
 * 오프라인 갈래가 `none`이 아닌 이유: 끊긴 채로 버튼을 그대로 두면 15초 뒤
 * 실패로 반박당하고, 말없이 치우면 무엇이 사라졌는지 알 수 없다.
 */
export function approvalRowControl(
  item: FeedItem,
  options: { offline: boolean }
): RowControl {
  if (item.kind !== "approval") return { kind: "none" };
  if (item.approvalId === undefined) return { kind: "none" };
  if (options.offline) return { kind: "offline" };
  return { kind: "decide", approvalId: item.approvalId };
}

// ---- ③ 원장의 답을 사람의 문장으로 -----------------------------------------

/**
 * 결정 뒤 목록 위에 남는 한 줄.
 *
 * `tone`이 문자열이 아니라 판정인 것이 이 타입의 전부다. `InlineBanner`의
 * `error`는 `role="alert"`와 --danger를 쓴다: 스크린리더에 끼어들고 빨갛다.
 * 아래 `superseded`가 그 색을 받으면 화면은 **정상적인 상태 전이를 사고로**
 * 말하게 된다.
 */
export interface DecisionNote {
  /**
   *   neutral      기록됐거나, 이미 결정되어 있었다. 조용한 줄.
   *   unavailable  이 서버에 승인 라우트가 없다. 장애가 **아니다** — 목록 쪽이
   *                같은 404를 미제공으로 접으므로 같은 색이어야 한다(2R M1).
   *   error        진짜 실패. 다시 시도할 값이 있다.
   */
  tone: "neutral" | "unavailable" | "error";
  text: string;
}

/**
 * 이미 다른 곳에서 결정된 요청에 두 번째 결정을 보냈을 때 할 말.
 *
 * 폰 푸시에서 승인해 두고 웹 목록을 새로고침하지 않은 채 다시 누르는 것은 예외가
 * 아니라 정상 경로다. 서버는 그때 409에 **결정된 상태를 실은 영수증**으로 답하고
 * (`interpretReceipt`가 그것을 `superseded`로 읽는다), 그것은 실패가 아니라
 * "당신이 원하던 일은 이미 되어 있다"는 답이다.
 */
const SUPERSEDED_FALLBACK = "이 요청은 이미 결정되어 있었습니다.";

/**
 * 승인/거부 영수증의 정본 문장 (2R 오케스트레이터 결정 + 서버 실측).
 *
 * **약속하지 않는 것이 이 두 문장의 설계다.**
 *
 * 승인: "승인을 기록했습니다." — 그 뒤에 무엇이 일어나는지는 말하지 않는다.
 * `routes/approvals.rs:475-500`의 `approve_run`은 `requeue_run_from_approval_in_tx`가
 * false를 돌려주면(락과 여기 사이에 실행이 hold를 떠났으면) **resume job 없이**
 * 200으로 끝난다. 정상 경로에서도 재개는 outbox를 거치는 비동기다. 그러므로
 * "바로 실행합니다"는 계약이 지킬 수 없는 약속이었다.
 *
 * 거부: "거부를 기록했습니다. 이 실행은 이어지지 않습니다."
 * 실측(`routes/approvals.rs:447-449`, `:513-575`, `crates/momo-agent/src/run.rs:764-790`):
 * 거부는 같은 트랜잭션에서 `end_parked_run_in_tx(..., RunStatus::Cancelled)`까지
 * 함께 커밋한다 — 여기까지는 참이다. 그런데 그 UPDATE는
 * `WHERE status = 'awaiting_approval'`로 가드돼 있고, 걸리지 않으면
 * `if !ended { return Ok(()); }`로 조용히 빠진다. 즉 **"실행이 취소되었습니다"는
 * 좁은 경합에서 거짓이 된다**(실행이 그 사이 다른 이유로 끝나 있던 경우).
 * 반면 "이어지지 않는다"는 무조건 참이다: 거부 경로는 어떤 경우에도 resume job을
 * 넣지 않는다. 그래서 승인 쪽과 같은 기준으로 후자를 쓴다.
 */
export const APPROVED_RECEIPT = "승인을 기록했습니다.";
export const REJECTED_RECEIPT = "거부를 기록했습니다. 이 실행은 이어지지 않습니다.";

export function decisionNote(outcome: DecisionOutcome): DecisionNote {
  if (outcome.kind === "superseded") {
    return { tone: "neutral", text: outcome.note ?? SUPERSEDED_FALLBACK };
  }
  if (outcome.kind === "error") {
    // 2R M1: 같은 404를 목록은 조용히 접고 이 줄만 빨갛게 그리면, 한 화면이
    // 같은 사실을 두 색으로 말한다.
    return {
      tone: outcome.errorCode === "surface_absent" ? "unavailable" : "error",
      text: outcome.errorCopy ?? "결정을 처리하지 못했습니다.",
    };
  }
  if (outcome.status === "approved") {
    return { tone: "neutral", text: APPROVED_RECEIPT };
  }
  if (outcome.status === "rejected") {
    return { tone: "neutral", text: REJECTED_RECEIPT };
  }
  // 200을 받았지만 원장이 알아볼 수 없는 상태를 답했다. 무엇으로 기록됐는지
  // 우리가 모르므로, 안다고 말하지 않는다.
  return {
    tone: "neutral",
    text: "결정을 보냈습니다. 기록된 상태는 목록에서 확인하세요.",
  };
}

// ---- ④ 배지와 반쪽 원장 (2R M3 · H1) ---------------------------------------

/**
 * 「결정 대기」 탭 배지의 수 (2R M3).
 *
 * 행 수가 아니라 **결정할 수 있는 행 수**다. 배지는 "당신이 지금 해야 할 일이
 * 몇 개인가"를 말하는 자리이고, 결정할 수 없는 행(이미 결정됐거나 자격이 없는
 * 행)이 그 수에 들어가면 사람은 인박스를 열고 셀 것을 찾지 못한다. 판정은
 * `approvalRowControl` 한 벌을 그대로 재사용한다 — 배지가 자기만의 규칙을
 * 갖는 순간, 배지와 목록이 다른 수를 말하기 시작한다.
 *
 * `offline: false`로 세는 이유: 연결이 끊긴 것은 **지금 못 누른다**는 사실이지
 * 할 일이 없다는 사실이 아니다. 끊겼다고 배지가 0이 되면 화면은 오프라인을
 * "처리 완료"로 말하게 된다.
 */
export function decidableCount(items: readonly FeedItem[]): number {
  return items.filter(
    (item) => approvalRowControl(item, { offline: false }).kind === "decide"
  ).length;
}

/**
 * 「에이전트」 탭은 두 원장 위에 서 있다 (2R H1).
 *
 * 승인 원장과 작업 실행 기록. 지금 이 서버는 앞의 것만 답하고 뒤의 것은 읽는
 * 경로가 없다(경로가 POST 전용이라 GET은 405). 그런데 화면은 승인 기록만 담긴
 * 목록을 그려 놓고 비어 있으면 "조용한 게 정상입니다"라고 말했다. 절반이 보이지
 * 않는다는 사실을 삼킨 문장이라, 사용자는 에이전트가 아무 작업도 하지 않았다고
 * 읽는다 — 우리가 모르는 사실이다.
 *
 * 그래서 반쪽인 동안에는 그 사실을 먼저 말한다. 목록은 그대로 남긴다: 있는
 * 절반을 감추는 것은 반대 방향의 같은 거짓말이다.
 */
export function agentsFeedPartial(provides: (id: "agentRunHistory") => boolean): boolean {
  return !provides("agentRunHistory");
}
