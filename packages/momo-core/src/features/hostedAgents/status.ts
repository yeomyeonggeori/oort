import {
  boundedLabel,
  connectionFacts,
  hostedStatusDetail,
  hostedStatusLabel,
  hostedStatusTone,
  toHostedConnection,
  type HostedAgentConnection,
  type HostedChipTone,
  type HostedFact,
} from "./model";
import { arrayField, bool, num, record, str, WireShapeError } from "../../lib/wire";

// =============================================================================
// 호스티드 연결의 **읽기 전용** 상태 뷰모델 (ADR-0162, goal HAP-UX3 / #1359).
//
// 폰이 처음으로 호스티드 연결을 보는 표면이고, 그 표면은 **관전**이다: pairing
// confirm/regenerate·credential rotate·disconnect·cleanup acknowledge 어느 것도
// 여기서 하지 않는다. 그래서 이 파일은 판단과 문구만 들고, 두 클라(web·RN)는
// 그것을 얇게 그린다 — 「one core, two thin clients」.
//
// ## 이 파일이 지금 무엇을 겹쳐 들고 있는가 (LANDING 정리 지시)
//
// 아래 A·B 구역은 #1362(HAP-UX2) `cleanup.ts` + `disconnect.ts` 의 **읽기 부분만**
// 을 옮겨 온 것이다. 그 두 파일은 track/engine 에 아직 없고(UX2 가 병렬로 랜딩
// 중), UX3 는 그것을 기다리지 않기 위해 여기서 같은 이름·같은 의미로 다시 짓는다.
// 문자열과 함수 몸통을 **일부러 바이트 그대로** 옮겼으므로, 두 갈래가 함께 랜딩할
// 때 오케스트레이터는 A·B 를 지우고 이 import 들을 `./cleanup`·`./disconnect` 로
// 돌리면 된다(동일 심볼·동일 의미). C 구역만 UX3 고유다.
//
// ## 규율은 `./model` 과 같다
//
//   1. wire 는 스프레드가 아니라 **이름 붙은 필드**로 다시 짓는다. 서버가 약속을
//      어기고 무언가 더 실어도 이 타입을 거쳐서는 화면에 닿지 못한다.
//   2. 모르는 어휘(status·kind·source)는 **버린다**. 반쯤 그린 줄은 사람이 무엇을
//      허락했고 무엇이 남았는지 읽을 수 없게 만든다.
//   3. 서버가 영어로 쓴 운영자 문장(`server_verified` evidence)은 화면에 올리지
//      않는다. 한국어 문구는 이 파일이 짓는다.
// =============================================================================

// =============================================================================
// A 구역 — cleanup 정리 목록의 읽기 어휘 (#1362 cleanup.ts 의 읽기 부분과 겹침).
// =============================================================================

/** 서버 `HOSTED_ARTIFACT_KINDS`. 여섯이고, 이 여섯이 전부다. */
export const HOSTED_CLEANUP_KINDS = [
  "bot",
  "routine",
  "plugin",
  "connector",
  "local_plugin_files",
  "secret",
] as const;

export type HostedCleanupKind = (typeof HOSTED_CLEANUP_KINDS)[number];

/** 종류가 요구하는 행동. 서버 `expected_action_for_kind` 와 한 규칙이다. */
export type HostedCleanupAction = "remove" | "revoke" | "decide";

/** 사람이 **본 것**. 처분이 아니다. */
export type HostedCleanupStatus = "unknown" | "present" | "inactive" | "absent";

/** 사람이 **정한 것**. `pending` 이 아닌 값만 줄을 닫는다. */
export type HostedCleanupDisposition =
  | "pending"
  | "removed"
  | "preserved"
  | "revoked";

/** 누가 확인했는가. `server_verified` 는 요청으로 만들 수 없다. */
export type HostedCleanupSource = "server_verified" | "manual";

/**
 * 정리 목록 한 줄.
 *
 * `externalRef` 가 없으면 "이 종류 전체"를 뜻하는 씨앗 줄이고, 있으면 사람이 따로
 * 이름 붙인 항목 하나다. 어느 쪽도 비밀값을 담지 않는다.
 */
export interface HostedCleanupArtifact {
  id: string;
  kind: HostedCleanupKind;
  externalRef?: string;
  expectedAction: HostedCleanupAction;
  currentStatus: HostedCleanupStatus;
  disposition: HostedCleanupDisposition;
  resolved: boolean;
  required: boolean;
  source?: HostedCleanupSource;
  acknowledgedBy?: string;
  acknowledgedAtMs?: number;
  evidence?: string;
  updatedAtMs: number;
}

function toKind(value: string | undefined): HostedCleanupKind | null {
  return value !== undefined &&
    (HOSTED_CLEANUP_KINDS as readonly string[]).includes(value)
    ? (value as HostedCleanupKind)
    : null;
}

function toAction(value: string | undefined): HostedCleanupAction | null {
  switch (value) {
    case "remove":
    case "revoke":
    case "decide":
      return value;
    default:
      return null;
  }
}

function toCleanupStatus(value: string | undefined): HostedCleanupStatus | null {
  switch (value) {
    case "unknown":
    case "present":
    case "inactive":
    case "absent":
      return value;
    default:
      return null;
  }
}

function toDisposition(
  value: string | undefined
): HostedCleanupDisposition | null {
  switch (value) {
    case "pending":
    case "removed":
    case "preserved":
    case "revoked":
      return value;
    default:
      return null;
  }
}

function toSource(value: string | undefined): HostedCleanupSource | undefined {
  // 모르는 출처는 **버린다**. 출처가 "누가 이걸 보증하는가"이고 그 답을 모르면
  // 아무도 보증하지 않은 것이다.
  return value === "server_verified" || value === "manual" ? value : undefined;
}

/**
 * 한 줄을 필드 이름으로 다시 짓는다. 필수 칸이 하나라도 빠지거나 이 빌드가 모르는
 * 어휘가 오면 `null` 이다.
 */
export function toCleanupArtifact(value: unknown): HostedCleanupArtifact | null {
  const row = record(value);
  if (!row) return null;
  const id = str(row, "id");
  const kind = toKind(str(row, "kind"));
  const expectedAction = toAction(str(row, "expectedAction"));
  const currentStatus = toCleanupStatus(str(row, "currentStatus"));
  const disposition = toDisposition(str(row, "disposition"));
  const resolved = bool(row, "resolved");
  const required = bool(row, "required");
  const updatedAtMs = num(row, "updatedAtMs");
  if (
    !id ||
    !kind ||
    !expectedAction ||
    !currentStatus ||
    !disposition ||
    resolved === undefined ||
    required === undefined ||
    updatedAtMs === undefined
  ) {
    return null;
  }
  const externalRef = str(row, "externalRef");
  const source = toSource(str(row, "source"));
  const acknowledgedBy = str(row, "acknowledgedBy");
  const acknowledgedAtMs = num(row, "acknowledgedAtMs");
  const evidence = str(row, "evidence");
  return {
    id,
    kind,
    ...(externalRef ? { externalRef } : {}),
    expectedAction,
    currentStatus,
    disposition,
    resolved,
    required,
    ...(source ? { source } : {}),
    ...(acknowledgedBy ? { acknowledgedBy } : {}),
    ...(acknowledgedAtMs === undefined ? {} : { acknowledgedAtMs }),
    ...(evidence ? { evidence } : {}),
    updatedAtMs,
  };
}

/**
 * 목록을 **사람이 provider 설정 화면에서 밟는 순서**로 짓는다. 커넥터 바로 뒤에
 * 로컬 파일이 서는 것이 #1344 의 교훈을 눈으로 보게 만드는 배치다.
 */
export const HOSTED_CLEANUP_ORDER: readonly HostedCleanupKind[] = [
  "connector",
  "local_plugin_files",
  "plugin",
  "routine",
  "bot",
  "secret",
];

export function sortCleanupArtifacts(
  artifacts: readonly HostedCleanupArtifact[]
): HostedCleanupArtifact[] {
  return [...artifacts].sort((a, b) => {
    const kindGap =
      HOSTED_CLEANUP_ORDER.indexOf(a.kind) - HOSTED_CLEANUP_ORDER.indexOf(b.kind);
    if (kindGap !== 0) return kindGap;
    const left = a.externalRef ?? "";
    const right = b.externalRef ?? "";
    if (left === right) return a.id.localeCompare(b.id);
    if (left === "") return -1;
    if (right === "") return 1;
    return left.localeCompare(right);
  });
}

/** `cleanupArtifacts` 배열 하나를 읽는다. 없으면 빈 목록이다(해제 전의 정상). */
export function parseCleanupArtifacts(wire: unknown): HostedCleanupArtifact[] {
  const rows = arrayField(record(wire) ?? {}, "cleanupArtifacts") ?? [];
  return sortCleanupArtifacts(
    rows
      .map(toCleanupArtifact)
      .filter((row): row is HostedCleanupArtifact => row !== null)
  );
}

export interface CleanupKindCopy {
  label: string;
  /** 사람이 여기서 무엇을 해야 하는가. 상시 노출된다. */
  expectation: string;
}

const CLEANUP_KIND_COPY: Record<HostedCleanupKind, CleanupKindCopy> = {
  connector: {
    label: "커넥터 설치",
    expectation: "provider의 커넥터 목록에서 이 연결이 쓰던 커넥터를 제거하세요.",
  },
  local_plugin_files: {
    label: "로컬 플러그인 파일",
    expectation: "이 기기에 남은 플러그인 소스 파일을 직접 찾아 지우세요.",
  },
  plugin: {
    label: "플러그인 등록",
    expectation: "provider에 등록해 둔 비공개 플러그인 자체를 지우세요.",
  },
  routine: {
    label: "자동 실행 루틴",
    expectation: "이 연결이 쓰던 routine을 provider 설정에서 제거하세요.",
  },
  bot: {
    label: "provider의 봇",
    expectation:
      "이 봇을 지울지 남길지 직접 정하세요. oort는 어느 쪽도 대신 하지 않습니다.",
  },
  secret: {
    label: "연결 자격증명",
    expectation:
      "이 연결이 쓰던 자격증명이 더 이상 통하지 않는지 확인하세요.",
  },
};

export function cleanupKindCopy(kind: HostedCleanupKind): CleanupKindCopy {
  return CLEANUP_KIND_COPY[kind];
}

/**
 * 목록에 그리는 줄 이름. 이름 붙은 항목은 그 이름을 쓰되 종류를 함께 세운다.
 */
export function cleanupRowTitle(artifact: HostedCleanupArtifact): string {
  const kind = cleanupKindCopy(artifact.kind).label;
  return artifact.externalRef === undefined
    ? kind
    : `${kind}: ${boundedLabel(artifact.externalRef, 80)}`;
}

export function cleanupStatusLabel(status: HostedCleanupStatus): string {
  switch (status) {
    case "unknown":
      return "확인 전";
    case "present":
      return "남아 있음";
    case "inactive":
      return "꺼짐";
    case "absent":
      return "없음";
  }
}

export function cleanupDispositionLabel(
  disposition: HostedCleanupDisposition
): string {
  switch (disposition) {
    case "pending":
      return "미확인";
    case "removed":
      return "제거됨";
    case "preserved":
      return "남김";
    case "revoked":
      return "폐기됨";
  }
}

/**
 * 한 줄을 어떻게 그릴 것인가. 넷인 이유는 서버가 확인한 줄과 사람이 확인한 줄이
 * 다르게 읽혀야 하고(규율 3), 관측만 있고 아직 아무 줄도 닫지 않은 자리가 따로
 * 있기 때문이다 — 그 둘을 합치면 "꺼 둔 routine" 이 "확인된 routine" 으로 읽힌다.
 */
export type CleanupRowState =
  | "server_confirmed"
  | "resolved"
  | "observed"
  | "pending";

export function cleanupRowState(
  artifact: HostedCleanupArtifact
): CleanupRowState {
  if (artifact.resolved) {
    return artifact.source === "server_verified"
      ? "server_confirmed"
      : "resolved";
  }
  return artifact.currentStatus === "unknown" ? "pending" : "observed";
}

export type CleanupRowTone = "ok" | "warn" | "muted" | "accent";

export function cleanupRowTone(state: CleanupRowState): CleanupRowTone {
  switch (state) {
    case "server_confirmed":
    case "resolved":
      return "ok";
    case "observed":
      return "warn";
    case "pending":
      return "muted";
  }
}

/** 칩 한 낱말. 서버가 확인한 줄과 사람이 확인한 줄을 낱말로 가른다. */
export function cleanupRowStateLabel(artifact: HostedCleanupArtifact): string {
  switch (cleanupRowState(artifact)) {
    case "server_confirmed":
      return "서버 확인";
    case "resolved":
      return cleanupDispositionLabel(artifact.disposition);
    case "observed":
      return cleanupStatusLabel(artifact.currentStatus);
    case "pending":
      return "확인 필요";
  }
}

/**
 * 지금 이 줄이 사람에게 무엇을 말하는가 — 상태 아래 한 문장. `observed` 가 자기
 * 문장을 갖는 것이 이 함수의 존재 이유다: "꺼짐"이라고만 적힌 줄은 끝난 것처럼 보인다.
 */
export function cleanupRowDetail(artifact: HostedCleanupArtifact): string {
  const copy = cleanupKindCopy(artifact.kind);
  switch (cleanupRowState(artifact)) {
    case "server_confirmed":
      return "oort가 직접 폐기하고 그 결과를 다시 읽어 확인했습니다. 사람이 승인할 것이 없습니다.";
    case "resolved":
      return artifact.disposition === "preserved"
        ? "남기기로 정했고 그 사유가 기록에 남았습니다."
        : "확인이 기록됐습니다.";
    case "observed":
      return `아직 확인으로 넘어가지 않았습니다. ${copy.expectation}`;
    case "pending":
      return copy.expectation;
  }
}

/**
 * 화면에 그대로 그려도 되는 확인 내용.
 *
 * `server_verified` 줄의 `evidence` 는 서버가 영어로 쓴 운영자 문장이라 그리지
 * 않는다(규율 3). manual 줄의 `evidence` 는 이 화면의 사람이 적은 것이므로 그대로
 * 보여 주는 것이 정확하다.
 */
export function cleanupEvidenceText(
  artifact: HostedCleanupArtifact
): string | null {
  if (artifact.source === "server_verified") return null;
  return artifact.evidence ?? null;
}

// =============================================================================
// B 구역 — 단건 조회 파서와 진행 셈 (#1362 disconnect.ts 의 읽기 부분과 겹침).
// =============================================================================

export interface HostedConnectionDetail {
  connection: HostedAgentConnection;
  /** 해제 전에는 빈 목록이다. 다른 형상이 아니라 **같은 형상의 빈 값**이다. */
  artifacts: HostedCleanupArtifact[];
}

/**
 * 단건 조회 응답 전체(connection + cleanupArtifacts).
 *
 * UX1 의 `parseHostedConnection` 은 커넥션만 돌려준다. 이 관전 화면은 장부 전체를
 * 읽어야 하므로 파서를 따로 둔다.
 */
export function parseHostedConnectionDetail(
  wire: unknown
): HostedConnectionDetail {
  const connection = toHostedConnection(record(wire)?.["connection"]);
  if (!connection) throw new WireShapeError();
  return { connection, artifacts: parseCleanupArtifacts(wire) };
}

export interface CleanupProgress {
  total: number;
  resolved: number;
  /** 아직 답하지 않은 **필수** 항목 수. */
  remainingRequired: number;
  /** 그중 첫 줄의 이름. "다음에 무엇을" 이 이름을 쓴다. */
  nextTitle: string | null;
}

/** 아직 답하지 않은 필수 줄들, **화면 순서로**. */
export function unresolvedRequired(
  artifacts: readonly HostedCleanupArtifact[]
): HostedCleanupArtifact[] {
  return sortCleanupArtifacts(
    artifacts.filter((row) => row.required && !row.resolved)
  );
}

/** 목록 전체를 한 줄 숫자로. */
export function cleanupProgress(
  artifacts: readonly HostedCleanupArtifact[]
): CleanupProgress {
  const remaining = unresolvedRequired(artifacts);
  const first = remaining[0];
  return {
    total: artifacts.length,
    resolved: artifacts.filter((row) => row.resolved).length,
    remainingRequired: remaining.length,
    nextTitle: first ? cleanupRowTitle(first) : null,
  };
}

/** 진행 표시 옆의 한 문장. 숫자만 있는 줄은 다음 행동을 말하지 않는다. */
export function cleanupProgressSentence(progress: CleanupProgress): string {
  if (progress.total === 0) {
    return "정리 목록이 아직 없습니다. 해제가 시작되면 확인할 항목이 여기 생깁니다.";
  }
  if (progress.remainingRequired === 0) {
    return "필수 항목을 모두 확인했습니다.";
  }
  const next = progress.nextTitle;
  return next === null
    ? `아직 확인하지 않은 항목이 ${progress.remainingRequired}개 남았습니다.`
    : `아직 확인하지 않은 항목이 ${progress.remainingRequired}개 남았습니다. 다음은 ${next}입니다.`;
}

// =============================================================================
// C 구역 — UX3 고유 읽기 전용 뷰모델과 문구.
//
// 이 관전 표면이 정직하게 답할 수 있는 것과 없는 것의 경계가 여기 있다. 읽기
// 모델(openapi `HostedAgentConnection`)이 실어 주는 것은 열이고, 그 열에 **provider
// preset 도, 실시간 last-seen 도 없다**. 그래서 이 구역은 두 가지를 한다: 실어 준
// 사실을 정확한 이름으로 세우고, 실어 주지 않은 것을 실은 것처럼 말하지 않는다.
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
 * 들고 있는 `detected_at`·`proved_at` 은 클라이언트로 내보내지 않는다. 그래서
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
 * 상세 화면 한 벌의 읽기 전용 뷰모델. 두 클라가 이 하나를 그린다.
 *
 * `connectionFacts` 를 그대로 쓰는 것이 "provider preset/generic 표시"에 대한 이
 * 표면의 정직한 답이다: 읽기 모델에 preset 열이 없고, ADR-0162 는 provider 가 보낸
 * metadata 를 권위로 쓰지 말라고 못 박았다(D6). 그래서 이 화면은 검증된 사실
 * (전용 에이전트 이름·인증 방식·허용 대상)만 세우고, 확인되지 않은 provider 주장을
 * 실은 것처럼 그리지 않는다.
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
