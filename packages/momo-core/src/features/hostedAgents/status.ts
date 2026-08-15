import {
  boundedLabel,
  connectionFacts,
  hostedStatusDetail,
  hostedStatusLabel,
  hostedStatusTone,
  type HostedAgentConnection,
  type HostedChipTone,
  type HostedFact,
} from "./model";
import {
  cleanupEvidenceText,
  cleanupRowDetail,
  cleanupRowState,
  cleanupRowStateLabel,
  cleanupRowTitle,
  cleanupRowTone,
  type CleanupRowTone,
  type HostedCleanupArtifact,
} from "./cleanup";
import {
  cleanupProgress,
  cleanupProgressSentence,
  type CleanupProgress,
  type HostedConnectionDetail,
} from "./disconnect";

// =============================================================================
// 호스티드 연결의 **읽기 전용** 관전 뷰모델 (ADR-0162, goal HAP-UX3 / #1359).
//
// 폰이 처음으로 호스티드 연결을 보는 표면이고, 그 표면은 **관전**이다: pairing
// confirm/regenerate·credential rotate·disconnect·cleanup acknowledge 어느 것도
// 여기서 하지 않는다. **두 클라가 공유하는 것은 어휘 프리미티브**다 —
// `hostedStatusLabel`/`Tone`/`Detail`·`connectionFacts`·`cleanupRow*`·
// `cleanupEvidenceText`. 웹은 그 낱말들을 자기 컴포넌트(`HostedConnectionSection`)
// 로 조립하고, 이 파일이 짜는 **관전 화면 한 벌**(`hostedListRow`·`hostedDetailView`)
// 은 **폰 전용**이다 — 웹에는 그 조립을 부르는 importer 가 하나도 없다.
//
// ## 어휘의 출처 — cleanup·disconnect·model 이 정본이다
//
// connection 상태 어휘는 UX1 `./model`, cleanup 정리 목록의 읽기 어휘는 UX2
// `./cleanup`, 단건 조회 파서와 진행 셈은 UX2 `./disconnect` 가 정본이다. 이 파일은
// 그 셋을 **읽어서** 관전 화면 한 벌로 조립할 뿐, 같은 판단을 두 번 짓지 않는다
// (초판은 UX2 가 track/engine 에 없던 동안 그 읽기 부분을 여기 미러링했고, #1362 가
// 랜딩한 뒤 이 파일에서 지우고 정본으로 되돌렸다 — 73ac11d4).
//
// ## 이 표면이 정직하게 답할 수 있는 것과 없는 것
//
// 읽기 모델(openapi `HostedAgentConnection`)이 실어 주는 열에는 **provider preset 도,
// 실시간 last-seen 도 없다**(서버가 안에 든 `detected_at`·`proved_at`·client 이름을
// 클라이언트로 내보내지 않는다). 그 둘은 #1405 로 티켓됐고, 그때까지 이 표면은
// 실어 준 사실을 정확한 이름으로 세우고 실어 주지 않은 것을 실은 것처럼 말하지
// 않는다(`HOSTED_LIVENESS_NOTE`, 그리고 preset 대신 `connectionFacts` 의 검증된 사실).
// =============================================================================

export const HOSTED_SECTION_TITLE = "호스티드 연결";

export const HOSTED_LIST_LEAD =
  "다른 인프라에서 돌리는 에이전트를 이 워크스페이스에 들인 연결들입니다. 여기서는 상태만 봅니다.";

/**
 * 이 표면이 무엇을 하지 않는지. 폰은 관전만 하고, 연결·해제·정리 확인은 데스크톱
 * 에서 한다(ADR-0162, 이 화면의 out-of-scope).
 */
export const HOSTED_READONLY_NOTE =
  "연결을 만들고, 해제하고, 정리를 확인하는 일은 데스크톱에서 합니다. 이 화면은 지금 어떤 상태인지만 보여 줍니다.";

/**
 * 시각의 정직함. 읽기 모델은 `createdAtMs`·`updatedAtMs` 만 싣고, 서버가 안에
 * 들고 있는 `detected_at`·`proved_at` 은 클라이언트로 내보내지 않는다(#1405). 그래서
 * 「마지막 상태 변화」는 있는 값의 정확한 이름이고, 「지금 살아 있는가」는 이 화면이
 * 답할 수 없는 질문이다 — 답할 수 없다는 것을 답한다.
 */
export const HOSTED_LIVENESS_NOTE =
  "이 시각은 연결 상태가 마지막으로 바뀐 때입니다. 에이전트가 지금 살아 있는지를 실시간으로 알려 주는 값은 아닙니다.";

export const HOSTED_CREATED_LABEL = "연결 만든 때";
export const HOSTED_UPDATED_LABEL = "마지막 상태 변화";

export const HOSTED_LIST_EMPTY_HEADLINE = "아직 호스티드 연결이 없습니다.";
export const HOSTED_LIST_EMPTY_DETAIL =
  "다른 인프라의 에이전트를 들이는 것은 데스크톱에서 시작합니다.";

/** owner/admin 이 아니면 목록 자체가 403 이다(장애가 아니라 권한의 답). */
export const HOSTED_LIST_DENIED_HEADLINE = "이 목록은 볼 수 없습니다.";
export const HOSTED_LIST_DENIED_DETAIL =
  "호스티드 연결은 워크스페이스 오너나 관리자만 볼 수 있습니다.";

/**
 * 오프라인 — 지금 이 기기가 네트워크에 닿지 않을 때 목록/상세 위에 서는 문장.
 * active 와 구분되어야 하는 값이라(끊긴 화면과 살아 있는 화면은 다르다) 따로 있다.
 */
export const HOSTED_OFFLINE_NOTE =
  "지금 이 기기가 네트워크에 닿지 않습니다. 아래는 마지막으로 받아 둔 상태이고, 그 뒤 provider에서 일어난 변화는 반영되지 않았습니다.";

/** 캐시된 값을 그릴 때 시각 앞에 서는 말. */
export const HOSTED_STALE_LABEL = "마지막으로 확인한 때";

/** 목록/상세를 못 불러왔을 때. */
export const HOSTED_LIST_ERROR_HEADLINE = "연결 목록을 불러오지 못했습니다.";
export const HOSTED_DETAIL_ERROR_HEADLINE = "연결 상태를 불러오지 못했습니다.";

// ---- 목록 한 줄 -------------------------------------------------------------

export interface HostedListRow {
  connectionId: string;
  agentMemberId: string;
  /** 전용 에이전트의 이름(사람이 지은 것). 상한을 씌워 다시 그린다. */
  title: string;
  statusLabel: string;
  statusTone: HostedChipTone;
  /** 상태가 지금 무엇을 뜻하는지 한 문장. `detected` 는 두 자리라 커넥션을 받는다. */
  statusDetail: string;
}

/**
 * 목록 한 줄의 뷰모델.
 *
 * 목록 응답에는 cleanup 목록이 없으므로(그것은 단건 조회에만 온다) 이 줄은
 * unresolved 개수를 세지 않는다. 정리 중이라는 사실은 상태 낱말(「정리 중」)이
 * 이미 말하고, 몇 개가 남았는지는 상세에서 센다.
 */
export function hostedListRow(
  connection: HostedAgentConnection,
  agentLabel: string
): HostedListRow {
  return {
    connectionId: connection.id,
    agentMemberId: connection.agentMemberId,
    title: boundedLabel(agentLabel),
    statusLabel: hostedStatusLabel(connection.status),
    statusTone: hostedStatusTone(connection.status),
    statusDetail: hostedStatusDetail(connection),
  };
}

// ---- 정리 목록 한 줄(읽기 전용) --------------------------------------------

export interface HostedArtifactRow {
  id: string;
  title: string;
  stateLabel: string;
  tone: CleanupRowTone;
  detail: string;
  /** manual 확인의 사람 문장. `server_verified` 이거나 없으면 `null`. */
  evidence: string | null;
}

/**
 * 정리 목록 한 줄을 읽기 전용으로 조립한다. 라디오도 저장도 없이 `./cleanup` 의
 * 읽기 어휘만 모은다 — 서버가 확인한 줄과 사람이 확인한 줄이 낱말로 갈리고
 * (`cleanupRowStateLabel`), server_verified 의 영어 evidence 는 화면에 닿지 않는다
 * (`cleanupEvidenceText` 가 그 줄에 `null` 을 답한다).
 */
export function hostedArtifactRow(
  artifact: HostedCleanupArtifact
): HostedArtifactRow {
  return {
    id: artifact.id,
    title: cleanupRowTitle(artifact),
    stateLabel: cleanupRowStateLabel(artifact),
    tone: cleanupRowTone(cleanupRowState(artifact)),
    detail: cleanupRowDetail(artifact),
    evidence: cleanupEvidenceText(artifact),
  };
}

// ---- 시각 한 줄 -------------------------------------------------------------

export interface HostedTimeFact {
  label: string;
  atMs: number;
}

/**
 * 상세가 그리는 시각들. **시각의 형식(시:분)은 클라이언트가 잰다** — 로케일과
 * 시간대는 기기의 것이고, 코어는 무엇을 어떤 이름으로 세우는지만 정한다.
 */
export function hostedConnectionTimes(
  connection: HostedAgentConnection
): HostedTimeFact[] {
  return [
    { label: HOSTED_CREATED_LABEL, atMs: connection.createdAtMs },
    { label: HOSTED_UPDATED_LABEL, atMs: connection.updatedAtMs },
  ];
}

// ---- 상세 뷰모델 ------------------------------------------------------------

export interface HostedDetailView {
  /** 전용 에이전트·연결 상태·인증 방식·허용 대상. `./model` 이 키를 닫아 둔다. */
  facts: HostedFact[];
  statusLabel: string;
  statusTone: HostedChipTone;
  statusDetail: string;
  times: HostedTimeFact[];
  /** 해제가 시작됐는가 — cleanup 목록이 하나라도 있으면 참. */
  hasCleanup: boolean;
  progress: CleanupProgress;
  progressSentence: string;
  rows: HostedArtifactRow[];
}

/**
 * 상세 화면 한 벌의 읽기 전용 뷰모델 — **폰 전용 조립이다.** 두 클라가 공유하는
 * 것은 이 함수가 읽는 어휘 프리미티브(`connectionFacts`·`hostedStatus*`·
 * `cleanupProgress*`)이지 이 조립 자체가 아니다: 웹은 같은 낱말로 자기
 * `HostedConnectionSection` 을 짜고 이 `hostedDetailView` 는 부르지 않는다.
 *
 * `connectionFacts` 를 그대로 쓰는 것이 "provider preset/generic 표시"에 대한 이
 * 표면의 정직한 답이다: 읽기 모델에 preset 열이 없고(#1405), ADR-0162 는 provider 가
 * 보낸 metadata 를 권위로 쓰지 말라고 못 박았다(D6). 그래서 이 화면은 검증된 사실
 * (전용 에이전트 이름·인증 방식·허용 대상)만 세우고, 확인되지 않은 provider 주장을
 * 실은 것처럼 그리지 않는다.
 *
 * 진행 문장은 `./disconnect` 의 정본 `cleanupProgressSentence` 를 그대로 쓴다 — 두
 * 표면이 같은 상태에 다른 말을 하지 않게 하는 것이 코어를 한 곳에 두는 이유다.
 * 이 화면이 해제를 끝내지는 않지만, 상단의 `HOSTED_READONLY_NOTE` 가 그 행동이
 * 데스크톱에 있음을 이미 말한다.
 */
export function hostedDetailView(
  detail: HostedConnectionDetail,
  agentLabel: string
): HostedDetailView {
  const { connection, artifacts } = detail;
  const progress = cleanupProgress(artifacts);
  return {
    facts: connectionFacts(connection, agentLabel),
    statusLabel: hostedStatusLabel(connection.status),
    statusTone: hostedStatusTone(connection.status),
    statusDetail: hostedStatusDetail(connection),
    times: hostedConnectionTimes(connection),
    hasCleanup: artifacts.length > 0,
    progress,
    progressSentence: cleanupProgressSentence(progress),
    rows: artifacts.map(hostedArtifactRow),
  };
}
