import { uuidEq } from "../../lib/api";
import {
  UNAVAILABLE_OFFLINE,
  UNAVAILABLE_REVOKED,
  UNAVAILABLE_T3_DISABLED,
  type HostTier,
  type SpawnExecutionPlan,
  type SpawnHostCandidate,
} from "../../lib/executionPlan";

// =============================================================================
// 승인 카드의 호스트 선택기 — 규칙과 문구 (ADR-0125 D6-A, #1114 클라 축)
//
// 형상은 `lib/executionPlan.ts`가 읽고, **무엇이 골라지고 무엇이 전송되는가**는
// 여기가 정한다. 웹의 라디오 그룹과 폰의 라디오 행이 둘 다 이 파일을 부른다 —
// 두 번째 구현이 아니라 두 번째 호출자다. 두 표면이 각자 판정하면 같은 카드가
// 기기마다 다른 호스트를 미리 고르고, 그 차이는 아무도 안 보는 쪽에서 자란다.
//
// ## 규율 1 — 자격 없는 호스트는 **숨기지 않고 사유와 함께 세운다**
//
// 서버가 그렇게 싣기로 한 이유를 그대로 잇는다(#1132 PR 본문): 회색으로 처리된
// 「내 맥 (오프라인)」이 "왜 내 랩탑을 못 고르지"의 정직한 답이고, 빈 목록은
// 아니다. 숨기면 사람은 자기 기계가 등록조차 안 됐다고 읽고 엉뚱한 곳을 고친다.
//
// ## 규율 2 — 고를 수 없으면 **보내지 않는다** (fail-closed)
//
// 자격 없는 줄은 라디오가 `disabled`이고, 선택 상태가 그 줄로 옮겨 가지 않으며,
// 결정 본문에 그 id가 실리지 않는다. 서버는 같은 것을 두 겹으로 다시 막지만
// (카드가 낸 목록과의 대조 403 + 결정 시점 재판정), 화면이 고를 수 있는 것처럼
// 보여 놓고 서버가 거절하는 것은 「막았다」가 아니라 「거짓말한 뒤 막았다」이다.
//
// ## 규율 3 — 아무것도 고를 수 없으면 **승인 자체가 막힌다**
//
// 자격 있는 후보가 0이면 서버는 승인에 409(`no eligible work host is available`)로
// 답한다. 그 사실을 결정 **전에** 말한다: 승인 버튼은 실제로 불가용하고, 그 옆에
// 이유가 선다. 거부는 그대로 열어 둔다 — 거부에는 호스트가 필요 없고(서버도
// `!approve`면 호스트를 아예 묻지 않는다), 실행할 수 없는 요청을 정리할 길까지
// 막을 이유는 없다.
// =============================================================================

/**
 * 이 승인이 호스트를 묻는가.
 *
 * **후보의 개수를 보지 않는다.** 서버의 같은 술어(`offers_host_choice`)가
 * `execution.host_candidates` **키의 존재**만 보기 때문이고, 두 술어가 갈라지면
 * 정확히 한 자리에서 사고가 난다: 워크스페이스에 등록된 호스트가 하나도 없어
 * 목록이 빈 배열로 오는 경우. 개수로 판정하면 클라이언트는 "이 카드는 호스트를
 * 묻지 않는다"고 읽어 승인 버튼을 그대로 세우고, 서버는 같은 payload를 보고
 * "묻는다"고 읽어 409(`no eligible work host is available`)로 답한다. 사람은
 * 멀쩡해 보이는 버튼을 누르고 이유 없는 실패를 받는다.
 *
 * 키가 있으면 묻는 것이고, 고를 것이 하나도 없다는 사실은 `spawnHostGate`가
 * 결정 **전에** 말한다.
 */
export function offersHostChoice(
  plan: SpawnExecutionPlan | null | undefined
): plan is SpawnExecutionPlan {
  return plan != null;
}

/** 지금 실제로 고를 수 있는 후보들. */
export function selectableHosts(
  plan: SpawnExecutionPlan | null | undefined
): SpawnHostCandidate[] {
  return (plan?.candidates ?? []).filter((candidate) => candidate.selectable);
}

export function findCandidate(
  plan: SpawnExecutionPlan | null | undefined,
  hostId: string | null | undefined
): SpawnHostCandidate | null {
  if (hostId == null) return null;
  return (
    plan?.candidates.find((candidate) => uuidEq(candidate.hostId, hostId)) ?? null
  );
}

/**
 * 카드가 열릴 때 이미 찍혀 있는 라디오.
 *
 * 순서에 이유가 있다:
 *
 *  1. `default_host_id` — 서버가 ADR-0125 D6-A의 "로컬 온라인 우선"으로 고른 것.
 *     **단 그것이 지금 고를 수 있을 때만.** 이 단서는 이론이 아니다: REST 컨트롤
 *     경로는 후보에 자격 있는 것이 없으면 기본값을 모델이 겨냥한 호스트로
 *     되돌린다(`work_controls.rs:467` — `default_spawn_host(...).or(target)`),
 *     그리고 그 호스트는 오프라인이라 후보에서 자격이 없을 수 있다. 그 id를
 *     찍어 두면 화면은 고를 수 없는 것을 골라 놓은 상태가 된다.
 *  2. 그 다음이 첫 번째 자격 후보. 서버가 낸 순서(display_name, id) 그대로다 —
 *     화면이 다시 정렬하면 카드가 낸 목록과 사람이 본 목록이 갈라진다.
 *  3. 아무것도 없으면 `null`. 이때는 승인 자체가 막힌다(규율 3).
 */
export function preselectedHostId(
  plan: SpawnExecutionPlan | null | undefined
): string | null {
  const preferred = findCandidate(plan, plan?.defaultHostId);
  if (preferred !== null && preferred.selectable) return preferred.hostId;
  return selectableHosts(plan)[0]?.hostId ?? null;
}

/**
 * 결정 본문에 실을 `hostId` — 없으면 `undefined`(키 자체를 안 싣는다).
 *
 * 세 갈래고, 각각이 서버의 한 갈래와 마주 본다
 * (`routes/approvals.rs` `resolve_host_choice`):
 *
 *  - **픽커가 없는 승인**: 무엇을 보내든 400이다. 그래서 아무것도 안 보낸다.
 *  - **사람이 카드가 찍어 준 그대로 둔 경우**: 키를 **뺀다**. 서버는 같은
 *    payload의 `default_host_id`를 적용하므로 결과가 동일하고, 뺀 쪽이 정직하다 —
 *    사람이 선택이라는 행위를 하지 않았다는 사실이 원장에 그대로 남는다.
 *  - **그 밖의 모든 경우**: 명시적으로 싣는다. 여기에는 사람이 다른 호스트로 바꾼
 *    경우뿐 아니라, 서버 기본값이 자격을 잃어 화면이 다른 것을 찍어 준 경우도
 *    들어간다. 후자에서 키를 빼면 서버는 자격 없는 기본값을 집어 들고 거절한다 —
 *    사람은 자격 있는 호스트가 찍힌 화면을 보고 눌렀는데 "쓸 수 있는 호스트가
 *    없다"는 답을 받는다.
 */
export function decisionHostId(
  plan: SpawnExecutionPlan | null | undefined,
  pickedHostId: string | null | undefined
): string | undefined {
  if (!offersHostChoice(plan)) return undefined;
  if (pickedHostId == null) return undefined;
  const picked = findCandidate(plan, pickedHostId);
  // 자격 없는 것이 어떤 경로로든 선택 상태에 들어왔다면 그것을 보내지 않는다.
  // 화면이 그것을 고르게 두지 않는 것이 1차 방어고, 이것이 2차다.
  if (picked === null || !picked.selectable) return undefined;
  const serverDefault = findCandidate(plan, plan.defaultHostId);
  if (
    serverDefault !== null &&
    serverDefault.selectable &&
    uuidEq(serverDefault.hostId, picked.hostId)
  ) {
    return undefined;
  }
  return picked.hostId;
}

// ---- 문구 -------------------------------------------------------------------

/**
 * 왜 못 고르는가, 한 마디로. 모르는 사유는 **모른다고 말한다**.
 *
 * `t3_disabled`가 「준비 중」인 것은 마케팅이 아니라 사실이다: ADR-0136이 T3를
 * 기본 비활성으로 두었고 서버 상수 `T3_SPAWN_ENABLED = false`가 그 결정이다.
 * 「사용 불가」라고 쓰면 영영 못 쓰는 것처럼 읽히고, 「곧 출시」라고 쓰면 우리가
 * 모르는 날짜를 약속한다.
 */
export function unavailableReasonCopy(reason: string | undefined): string | null {
  if (reason === undefined) return null;
  if (reason === UNAVAILABLE_OFFLINE) return "오프라인";
  if (reason === UNAVAILABLE_REVOKED) return "해지됨";
  if (reason === UNAVAILABLE_T3_DISABLED) return "준비 중";
  // 이 빌드가 모르는 사유. 원문을 그대로 내보내지 않는다(서버 어휘는 화면의 말이
  // 아니다) — 대신 아는 것만 말한다: 지금은 못 고른다.
  return "지금 선택할 수 없음";
}

/**
 * 라디오 줄에 적히는 이름.
 *
 * 자격 없는 줄은 이름 뒤에 사유를 괄호로 단다 — 「momo Cloud (준비 중)」,
 * 「내 맥 (오프라인)」. 사유를 별도 줄로 떼지 않는 이유: 목록에서 눈이 훑는 것은
 * 이름이고, 사유가 이름과 떨어져 있으면 두 번째 줄을 안 읽은 사람에게는 그냥
 * 흐린 이름 하나다.
 */
export function candidateLabel(candidate: SpawnHostCandidate): string {
  if (candidate.selectable) return candidate.displayName;
  const reason = unavailableReasonCopy(candidate.unavailableReason);
  return reason === null
    ? candidate.displayName
    : `${candidate.displayName} (${reason})`;
}

/**
 * tier를 사람 말로. `unknown`은 **아무 말도 하지 않는다**.
 *
 * 등록기가 모르는 타입을 「로컬」로 적으면 정체를 모르는 기계에 「내 기기」라는
 * 뜻을 붙이는 것이다. 서버도 같은 이유로 추측하지 않는다(`host_tier`의 `_` 갈래).
 */
export function tierLabel(tier: HostTier): string | null {
  if (tier === "local") return "로컬";
  if (tier === "remote") return "원격";
  if (tier === "cloud") return "클라우드";
  return null;
}

/** 픽커 그룹의 보이는 라벨. 스크린리더 전용이 아니다. */
export const HOST_CHOICE_LABEL = "실행할 호스트";

/**
 * 자격 있는 후보가 하나도 없을 때 픽커 자리에 서는 문장.
 *
 * 「없다」로 끝내지 않고 무엇이 그것을 바꾸는지까지 말한다. 이 상태의 원인은 거의
 * 항상 「내 맥이 꺼져 있다」이고, 그것은 사람이 30초 안에 고칠 수 있는 것이다.
 */
export const NO_ELIGIBLE_HOST_COPY =
  "지금 이 작업을 실행할 수 있는 호스트가 없습니다. 호스트 앱이 켜져 있는지 확인한 뒤 다시 시도하세요.";

/**
 * 승인 확정 문장의 **첫 문장** — 목적지가 조건절 안에 있다.
 *
 * 확정 화면에서 라디오는 잠긴다(요청이 나가는 중에 목적지를 바꿀 수는 없다).
 * 그래서 어디로 가는지가 문장에 있어야 한다 — 잠긴 컨트롤을 다시 읽게 하는 대신,
 * 사람이 지금 누르려는 버튼 바로 위에서 목적지를 말한다.
 *
 * ## 목적지를 **별도 문장으로 앞세우지 않는 이유** (design-review H3)
 *
 * 앞 판은 "「팀 VPS」에서 실행합니다."를 앞에 붙였고, 그 한 문장이 바로 뒤 문장이
 * 조심스럽게 피한 약속을 해 버렸다. 이 제품의 승인은 실행을 보장하지 않는다:
 * 승인은 재개 job을 outbox에 넣을 뿐이고, run이 이미 hold를 떠났으면 job은 아예
 * 들어가지 않은 채 200만 돌아온다(`routes/approvals.rs`의 `approve_run`). 그래서
 * 「…에서 실행합니다」는 현재 직설로 실행을 단언하는데, 그 다음 문장은 「승인하면
 * … 이어서 진행합니다」로 조건을 달고 있었다. 한 호흡에 실린 두 문장이 서로를
 * 반박한 것이다.
 *
 * 목적지를 **조건절 안으로** 넣으면 둘 다 참이 된다: 승인이 조건이고, 그 조건이
 * 성립했을 때 에이전트가 가는 곳이 이 호스트다.
 *
 * 「」를 쓰지 않는 것도 같은 검토에서 나왔다(N3). 이 제품의 사용자 문구는 이름을
 * 그대로 이어 쓰고(`${name}님은…`), 꺾쇠는 지금까지 주석과 테스트 제목에만 있었다.
 * 화면에서 새 구두점 관습을 시작할 이유가 없다.
 */
export function spawnApproveLead(hostName: string | null): string {
  return hostName === null
    ? "승인하면 에이전트가 이어서 진행합니다."
    : `승인하면 에이전트가 ${hostName}에서 이어서 진행합니다.`;
}

/** 승인 컨트롤이 지금 무엇을 할 수 있나. */
export interface SpawnHostGate {
  /** 승인 버튼을 세울 수 있는가. 거부는 이 값과 무관하게 언제나 가능하다. */
  canApprove: boolean;
  /** `canApprove`가 거짓인 이유. 참이면 없다. */
  blockedCopy?: string;
}

/**
 * 스폰 승인의 게이트. 픽커가 없는 승인은 이 파일이 판단할 것이 없다 — 언제나 통과.
 */
export function spawnHostGate(
  plan: SpawnExecutionPlan | null | undefined
): SpawnHostGate {
  if (!offersHostChoice(plan)) return { canApprove: true };
  if (selectableHosts(plan).length === 0) {
    return { canApprove: false, blockedCopy: NO_ELIGIBLE_HOST_COPY };
  }
  return { canApprove: true };
}
