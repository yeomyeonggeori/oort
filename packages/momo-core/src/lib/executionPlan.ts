import { record, str, bool, arrayField } from "./wire";

// =============================================================================
// 승인이 묻는 **두 번째 질문**: 어디서 실행하나 (ADR-0125 D6-A, #1114 클라 축)
//
// 승인 대부분은 예/아니오 하나만 묻는다. 작업 세션 스폰은 다르다 — 사람은 허가와
// 함께 **어느 호스트에서 돌릴지**를 정한다. 서버는 그 재료를 승인 payload와 카드
// props 양쪽에 `execution` 객체로 싣는다(서버 축 #1132,
// `crates/momo-t3/src/work_control.rs` `spawn_execution_object`):
//
//   execution.kind              "work_session_spawn"
//   execution.tool / label      무엇을 시작하는가
//   execution.requested_host_id 모델이 제안한 호스트(있으면). 제안이지 결정이 아니다.
//   execution.default_host_id   카드가 미리 고른 호스트(로컬 온라인 우선)
//   execution.host_candidates[] {host_id, display_name, host_type, tier, scope,
//                                online, selectable, unavailable_reason}
//
// ## 왜 `lib`에 있고 `features`에 없나
//
// 이 형상은 **와이어**다. 승인 프로젝션(`lib/api.ts`의 `Approval`)과 타임라인
// 카드(`features/timeline/agentCardModel.ts`)가 둘 다 같은 객체를 읽는데, 전자는
// `lib` 층이라 `features`를 import 할 수 없다(그렇게 하면 순환이다). 그래서 형상과
// 방어적 읽기만 여기 두고, **선택 규칙과 우리말 문구는** `features/timeline/
// spawnHostChoice.ts`가 진다. 이 파일에는 화면에 나갈 글자가 한 자도 없다.
//
// ## snake_case인 이유 — 우리가 고른 것이 아니다
//
// 결정 요청 본문은 camelCase `hostId`인데(정본 스펙 `docs/api/openapi.yaml`
// `ApprovalDecisionRequest`) 이 객체 안은 snake_case다. 서버가 그렇게 정했고 이유를
// 적어 두었다(`SpawnHostCandidate::to_json`): `approval.payload`와 `message.props`는
// jsonb 칸이고 그 이웃(`tool_call`·`call_id`·`approval_reason`)이 전부 snake_case다.
// DTO 층의 camelCase 규칙은 **응답 본문**을 지배하지 이 두 칸을 지배하지 않는다.
// 클라이언트가 할 일은 표기를 고르는 것이 아니라 **온 그대로 읽는 것**이다.
//
// ## 방어적 읽기: 모르면 못 고른다
//
// 이 파일의 모든 판정은 fail-closed다. `selectable`이 진짜 `true`가 아니면
// 선택 불가고, `tier`가 아는 값이 아니면 `unknown`이며, 후보 한 줄이 형상을
// 어기면 그 줄만 버린다(목록 전체가 아니라). 이유는 이 값들이 **되돌릴 수 없는
// 실행의 목적지**를 정하기 때문이다: 형상을 못 읽었다는 이유로 호스트를 고를 수
// 있다고 말하면, 그 다음에 일어나는 일은 사람이 고른 적 없는 기계에서 에이전트가
// 도는 것이다. 서버는 두 겹으로 다시 검증하지만(카드가 낸 목록과의 대조 + 결정
// 시점의 재판정, `routes/approvals.rs` `resolve_host_choice`), 그것은 이 파일이
// 느슨해도 된다는 뜻이 아니라 **화면이 거짓말을 해도 실행은 막힌다**는 뜻이다.
// 화면이 거짓말하지 않는 것은 여전히 이 파일의 몫이다.
// =============================================================================

/**
 * ADR-0125 D6-A의 3택 어휘. `work_host.type` → tier 사상은 서버가 갖는다
 * (`host_tier`: app→local, workd→remote, cloud→cloud).
 *
 * `unknown`은 서버의 것이기도 하다 — 등록기가 모르는 타입을 `local`로 추측하면
 * 정체불명의 기계가 기본값 뒤에 서게 된다. 클라이언트도 같은 값을 그대로 받는다.
 */
export type HostTier = "local" | "remote" | "cloud" | "unknown";

const TIERS: ReadonlySet<string> = new Set<HostTier>([
  "local",
  "remote",
  "cloud",
  "unknown",
]);

/** 픽커 한 줄. 서버 `SpawnHostCandidate::to_json`과 1:1. */
export interface SpawnHostCandidate {
  hostId: string;
  displayName: string;
  /** `work_host.type` 원문(`app`/`workd`/`cloud`). 화면에 그대로 나가지 않는다. */
  hostType?: string;
  tier: HostTier;
  /** `member` | `workspace`. 없을 수 있다. */
  scope?: string;
  /** 등록기가 최근 90초 안에 하트비트를 들었는가. */
  online: boolean;
  /** 지금 이 사람이 실제로 고를 수 있는가. 모르면 **false**. */
  selectable: boolean;
  /** 왜 못 고르는가 — `offline` · `revoked` · `t3_disabled`. 고를 수 있으면 없다. */
  unavailableReason?: string;
}

/** 승인 카드가 답해야 하는 「어디서」. `execution`이 없으면 이 객체도 없다. */
export interface SpawnExecutionPlan {
  /** 지금은 `work_session_spawn` 하나. 모르는 kind는 파싱 자체가 거절한다. */
  kind: string;
  /** `codex` 같은 도구 키. */
  tool?: string;
  /** 사람이 붙인 작업 이름. */
  label?: string;
  /** 모델이 제안한 호스트. **제안이지 선택이 아니다.** */
  requestedHostId?: string;
  /** 카드가 미리 고른 호스트. 자격이 없을 수도 있다(아래 주석). */
  defaultHostId?: string;
  candidates: SpawnHostCandidate[];
}

/** 이 빌드가 픽커를 그릴 줄 아는 유일한 실행 갈래. */
export const SPAWN_EXECUTION_KIND = "work_session_spawn";

/** 서버가 쓰는 사유 문자열(`work_control.rs`의 `UNAVAILABLE_*`). */
export const UNAVAILABLE_OFFLINE = "offline";
export const UNAVAILABLE_REVOKED = "revoked";
export const UNAVAILABLE_T3_DISABLED = "t3_disabled";

function nonEmpty(source: unknown, key: string): string | undefined {
  const value = str(source, key);
  return value !== undefined && value.trim() !== "" ? value : undefined;
}

/**
 * 후보 한 줄. 형상을 어기면 `null`이고, 호출자는 **그 줄만** 버린다.
 *
 * `host_id`와 `display_name`이 필수인 이유는 서로 다르다. 앞의 것이 없으면 고를
 * 대상이 없고, 뒤의 것이 없으면 사람이 무엇을 고르는지 화면에서 알 수 없다 — id를
 * 이름 자리에 대신 그리는 것은 「이름을 모른다」를 「이름이 uuid다」로 바꿔 말하는
 * 것이라 하지 않는다.
 */
function toCandidate(value: unknown): SpawnHostCandidate | null {
  const hostId = nonEmpty(value, "host_id");
  const displayName = nonEmpty(value, "display_name");
  if (hostId === undefined || displayName === undefined) return null;
  const rawTier = str(value, "tier");
  const unavailableReason = nonEmpty(value, "unavailable_reason");
  const candidate: SpawnHostCandidate = {
    hostId,
    displayName,
    tier: rawTier !== undefined && TIERS.has(rawTier) ? (rawTier as HostTier) : "unknown",
    // 하트비트를 못 읽었으면 오프라인으로 읽는다. 이 값은 문구에만 쓰이고 게이트는
    // `selectable`이 지지만, 두 값이 같은 방향으로 조심스러워야 한 화면에서
    // "온라인인데 못 고름" 같은 모순이 안 나온다.
    online: bool(value, "online") === true,
    // fail-closed의 핵심 한 줄. `true`가 실려 있을 때만 고를 수 있다.
    selectable: bool(value, "selectable") === true,
  };
  const hostType = nonEmpty(value, "host_type");
  if (hostType !== undefined) candidate.hostType = hostType;
  const scope = nonEmpty(value, "scope");
  if (scope !== undefined) candidate.scope = scope;
  if (unavailableReason !== undefined) {
    candidate.unavailableReason = unavailableReason;
  }
  // 서버가 「못 고른다」면서 사유를 안 실었을 수 있다(미래의 사유가 늘 때). 사유를
  // 지어내지 않는다 — 화면은 사유 없는 불가를 사유 없이 말한다.
  return candidate;
}

/**
 * `execution` 객체를 승인 payload에서든 카드 props에서든 읽는다.
 *
 * **인자는 payload/props 그 자체**(둘 다 `execution` 키를 같은 자리에 갖는다).
 * 두 표면이 같은 함수를 부르는 것이 이 설계의 값이다: 인박스 행은 프로젝션에서,
 * 타임라인 카드는 브로드캐스트된 메시지에서 같은 픽커를 그린다. 규칙이 두 벌이면
 * 한 표면이 다른 표면보다 관대해지고, 관대한 쪽이 아무도 안 보는 쪽이다.
 *
 * `null`을 답하는 경우가 곧 「이 승인은 호스트를 묻지 않는다」이고, 그때 결정에
 * `hostId`를 실으면 서버는 400으로 거절한다(그 400은 옳다 — 카드가 묻지 않은 것에
 * 답하는 클라이언트는 사람에게 고른 적 없는 선택을 고른 것처럼 보여준 것이다).
 */
export function parseExecutionPlan(source: unknown): SpawnExecutionPlan | null {
  const execution = record(source)?.["execution"];
  if (execution === undefined) return null;
  const kind = nonEmpty(execution, "kind");
  // 모르는 kind는 그리지 않는다. 이 파일이 아는 픽커는 스폰 하나뿐이고, 미래의
  // 실행 갈래를 스폰 카드로 그리면 그 카드는 자기가 무엇을 고르는지 모른다.
  if (kind !== SPAWN_EXECUTION_KIND) return null;
  const rawCandidates = arrayField(execution, "host_candidates");
  // `host_candidates` 키 자체가 없으면 픽커가 아니다. 서버의 `offers_host_choice`도
  // 정확히 그 키의 존재로 판정한다 — 게이트와 화면이 같은 술어를 봐야 한다.
  if (rawCandidates === null) return null;
  const candidates: SpawnHostCandidate[] = [];
  for (const raw of rawCandidates) {
    const candidate = toCandidate(raw);
    if (candidate !== null) candidates.push(candidate);
  }
  const plan: SpawnExecutionPlan = { kind, candidates };
  const tool = nonEmpty(execution, "tool");
  if (tool !== undefined) plan.tool = tool;
  const label = nonEmpty(execution, "label");
  if (label !== undefined) plan.label = label;
  const requestedHostId = nonEmpty(execution, "requested_host_id");
  if (requestedHostId !== undefined) plan.requestedHostId = requestedHostId;
  const defaultHostId = nonEmpty(execution, "default_host_id");
  if (defaultHostId !== undefined) plan.defaultHostId = defaultHostId;
  return plan;
}
