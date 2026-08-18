import { boundedLabel } from "./model";
import { num, record, str, bool, arrayField } from "../../lib/wire";

// =============================================================================
// 해제 정리 목록 한 줄 — 무엇이 남았고, 사람이 무엇을 확인했는가
// (ADR-0162 HAP-E6, goal HAP-UX2 / #1362).
//
// 이 파일이 존재하는 이유는 #1344 의 실측 두 줄이다:
//
//   1. provider UI 에서 커넥터를 Uninstall 했는데 **로컬 플러그인 파일은 남았다**.
//   2. routine 의 Active 를 껐는데 **routine 은 제거되지 않았다**.
//
// 두 사실이 이 목록의 형태를 통째로 정한다. 커넥터와 파일은 **서로 다른 줄**이고
// 한 줄을 확인해도 다른 줄은 열린 채로 남는다. "꺼짐"은 관측이지 처분이 아니라서
// 그것만으로는 어떤 줄도 닫히지 않는다. 서버는 그 두 규칙을 각각 별도 row 와
// `resolved = (disposition <> 'pending')` 생성 컬럼으로 못 박았고, 이 파일은 그
// 구조를 화면 말로 옮긴다.
//
// ## 규율 1 — 처분 어휘는 종류가 정한다 (migration 072 의 CHECK 를 그대로)
//
// `preserve` 는 bot 에만, `revoke` 는 secret 에만, 나머지는 `delete` 하나뿐이다.
// 이 비대칭이 이 흐름의 윤리다: bot 을 지우면 provider 쪽 대화 기록이 함께
// 사라지므로 "남긴다"가 정식 답이어야 하고, "커넥터를 그냥 두었다"는 정식 답이
// 아니다. `dispositionChoices` 가 그 표이고, 그 표가 DB CHECK 와 어긋나지 않는다는
// 사실은 테스트가 지킨다.
//
// ## 규율 2 — 서버가 확인한 줄과 사람이 확인한 줄은 다르게 읽힌다
//
// `server_verified` 는 이 서버가 **자기가 지운 것**(해제 시점에 폐기한 hosted
// bearer)에만 쓰는 출처이고 요청 본문에서 절대 읽히지 않는다. 그 줄에 체크박스를
// 세우면 사람이 서버의 사실을 승인하는 판이 되고, 반대로 그 줄을 사람 확인과 같은
// 모양으로 그리면 oort 가 provider 안까지 들여다본 것처럼 읽힌다. 둘 다 거짓말이라
// 이 파일은 상태를 넷으로 가른다(`cleanupRowState`).
//
// ## 규율 3 — 증거 없는 처분은 처분이 아니다
//
// 서버는 disposition 이 실린 요청에 1..=2000 바이트의 evidence 를 요구하고 없으면
// 400 이다. 화면이 그 규칙을 미리 말하지 않으면 사람은 라디오를 고르고 저장을 누른
// 뒤에야 거절을 듣는다. `evidenceIssue` 가 같은 자를 들고 같은 단위(바이트)로 잰다.
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

/** 요청 본문의 처분 어휘. 저장된 어휘(`disposition`)와 낱말이 다르다. */
export type HostedCleanupChoice = "delete" | "preserve" | "revoke";

/**
 * 정리 목록 한 줄.
 *
 * `externalRef` 가 없으면 "이 종류 전체"를 뜻하는 씨앗 줄이고, 있으면 사람이
 * 따로 이름 붙인 항목 하나다. 어느 쪽도 비밀값을 담지 않는다 — 서버가 그 이름을
 * 자기 자격증명 접두사로 시작하지 못하게 막고 있고, 이 타입에는 애초에 비밀값이
 * 들어갈 칸이 없다.
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

// ---- wire -------------------------------------------------------------------

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

function toStatus(value: string | undefined): HostedCleanupStatus | null {
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

function toDisposition(value: string | undefined): HostedCleanupDisposition | null {
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
  // 모르는 출처는 **버린다**. 「출처 미상」 줄을 그리는 것보다, 출처 없는 줄로
  // 그리는 편이 정직하다: 이 화면에서 출처는 "누가 이걸 보증하는가"이고 그 답을
  // 모르면 아무도 보증하지 않은 것이다.
  return value === "server_verified" || value === "manual" ? value : undefined;
}

/**
 * 한 줄을 필드 이름으로 다시 짓는다 (`./model` 규율 1).
 *
 * 필수 칸이 하나라도 빠지거나 이 빌드가 모르는 어휘가 오면 `null` 이다. 반쯤 그린
 * 정리 줄은 "이건 확인해야 하나 아닌가"를 사람이 판단할 수 없게 만들고, 그 판단
 * 착오의 대가가 남은 권한이다.
 */
export function toCleanupArtifact(value: unknown): HostedCleanupArtifact | null {
  const row = record(value);
  if (!row) return null;
  const id = str(row, "id");
  const kind = toKind(str(row, "kind"));
  const expectedAction = toAction(str(row, "expectedAction"));
  const currentStatus = toStatus(str(row, "currentStatus"));
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
 * 목록을 화면 순서로 짓는다.
 *
 * 서버는 `kind ASC` 로 정렬한다. 그 순서를 그대로 쓰지 않는 이유는 알파벳이
 * 사람의 동선이 아니기 때문이다. 이 목록의 순서는 **사람이 provider 설정 화면에서
 * 밟는 순서**이고, 그 안에서 커넥터 바로 뒤에 로컬 파일이 서는 것이 #1344 의
 * 교훈을 눈으로 보게 만드는 유일한 배치다(둘이 떨어져 있으면 커넥터를 지운 사람이
 * 목록을 다 읽었다고 믿고 떠난다).
 *
 * 같은 종류 안에서는 씨앗 줄이 먼저이고, 이름 붙은 항목은 이름 순이다.
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

// ---- 종류 -------------------------------------------------------------------

/**
 * 종류가 요구하는 행동. 서버 `expected_action_for_kind` 와 같은 표다.
 *
 * 서버가 이미 각 줄에 `expectedAction` 을 실어 주는데도 이 함수가 있는 이유는
 * 하나다: 처분 어휘가 이 표를 따르므로(규율 1), 두 표가 갈리면 화면이 서버가
 * 거절할 선택지를 내민다. 한 자리에서 도출하고 테스트가 서버 표와 대조한다.
 */
export function cleanupExpectedAction(
  kind: HostedCleanupKind
): HostedCleanupAction {
  switch (kind) {
    case "bot":
      return "decide";
    case "secret":
      return "revoke";
    case "routine":
    case "plugin":
    case "connector":
    case "local_plugin_files":
      return "remove";
  }
}

export interface CleanupKindCopy {
  /** 목록에서 이 줄을 부르는 이름. */
  label: string;
  /** 사람이 여기서 무엇을 해야 하는가. 상시 노출된다. */
  expectation: string;
  /**
   * 이 줄만의 함정. **감추지 않는다.**
   *
   * 여섯 줄 중 셋이 #1344 에서 실제로 사람을 속인 자리다. 그 문장이 disclosure
   * 뒤에 있으면 속은 사람은 두 번 속는다.
   */
  caution: string;
}

const CLEANUP_KIND_COPY: Record<HostedCleanupKind, CleanupKindCopy> = {
  connector: {
    label: "커넥터 설치",
    expectation:
      "provider의 커넥터 목록에서 이 연결이 쓰던 커넥터를 제거하세요.",
    caution:
      "커넥터를 제거해도 로컬에 받아 둔 플러그인 파일은 그대로 남습니다. 그 파일은 바로 아래 줄에서 따로 확인합니다.",
  },
  local_plugin_files: {
    label: "로컬 플러그인 파일",
    expectation:
      "이 기기에 남은 플러그인 소스 파일을 직접 찾아 지우세요.",
    caution:
      "oort는 이 기기의 파일을 읽지도 지우지도 못합니다. 지웠다는 사실은 사람만 확인할 수 있고, 그 확인이 이 줄의 전부입니다.",
  },
  plugin: {
    label: "플러그인 등록",
    expectation: "provider에 등록해 둔 비공개 플러그인 자체를 지우세요.",
    caution:
      "커넥터 제거는 설치를 되돌릴 뿐이고 등록은 provider 계정에 남습니다. 남아 있으면 누구든 다시 설치할 수 있습니다.",
  },
  routine: {
    label: "자동 실행 루틴",
    expectation:
      "이 연결이 쓰던 routine을 provider 설정에서 제거하세요.",
    caution:
      "Active를 끄는 것은 제거가 아닙니다. 꺼 둔 routine은 그대로 남아 있고, 이 줄은 끄는 것만으로 닫히지 않습니다.",
  },
  bot: {
    label: "provider의 봇",
    expectation:
      "이 봇을 지울지 남길지 직접 정하세요. oort는 어느 쪽도 대신 하지 않습니다.",
    caution:
      "지우면 그 봇과 나눈 provider 쪽 대화 기록도 함께 사라집니다. 남기는 것도 정식 답이며, 그때는 남긴 이유가 기록에 남습니다.",
  },
  secret: {
    label: "연결 자격증명",
    expectation:
      "이 연결이 쓰던 자격증명이 더 이상 통하지 않는지 확인하세요.",
    caution:
      "oort가 발급한 값은 해제를 시작한 순간 이미 폐기됐습니다. provider나 비밀 저장소에 따로 복사해 둔 사본이 있으면 그것은 직접 지워야 합니다.",
  },
};

export function cleanupKindCopy(kind: HostedCleanupKind): CleanupKindCopy {
  return CLEANUP_KIND_COPY[kind];
}

/**
 * 목록에 그리는 줄 이름.
 *
 * 이름 붙은 항목은 그 이름을 쓰되 종류를 함께 세운다. 이름만 쓰면 「Oort Inbox:
 * 팀 / 김인턴」 같은 줄이 무엇의 이름인지 알 수 없고, 종류만 쓰면 같은 종류의 두
 * 줄이 같은 이름으로 선다.
 */
export function cleanupRowTitle(artifact: HostedCleanupArtifact): string {
  const kind = cleanupKindCopy(artifact.kind).label;
  return artifact.externalRef === undefined
    ? kind
    : `${kind}: ${boundedLabel(artifact.externalRef, 80)}`;
}

// ---- 처분 -------------------------------------------------------------------

export interface CleanupDispositionChoice {
  id: HostedCleanupChoice;
  label: string;
  /** 고르면 무슨 일이 이미 일어난 것인가. 상시 노출된다. */
  detail: string;
  /** 되돌릴 수 없는 쪽인가. 화면이 이 줄에 경고 색을 준다. */
  destructive: boolean;
}

/**
 * 이 종류에 legal 한 처분 전부. migration 072 의 `disposition_ck` 와 서버
 * `stored_disposition` 을 함께 비춘다 (규율 1).
 *
 * bot 이 둘인 것과 secret 이 `revoke` 하나인 것이 이 표의 전부이고, 그 둘이 곧
 * #1344 의 교훈이다. 표를 넓히고 싶어지면 그것은 화면의 결정이 아니라 CHECK 의
 * 결정이므로 migration 부터 고쳐야 한다.
 */
export function dispositionChoices(
  kind: HostedCleanupKind
): readonly CleanupDispositionChoice[] {
  if (kind === "bot") {
    return [
      {
        id: "delete",
        label: "봇을 지웠습니다",
        detail:
          "provider에서 이 봇을 삭제했습니다. 그 봇과 나눈 provider 쪽 대화 기록도 함께 사라집니다.",
        destructive: true,
      },
      {
        id: "preserve",
        label: "봇을 남깁니다",
        detail:
          "봇을 그대로 둡니다. 대화 기록은 지켜지지만, 남은 봇을 나중에 다시 쓰면 이 워크스페이스와 무관한 자리에서 쓰이게 됩니다.",
        destructive: false,
      },
    ];
  }
  if (kind === "secret") {
    return [
      {
        id: "revoke",
        label: "더 이상 통하지 않습니다",
        detail:
          "이 자격증명으로는 어떤 요청도 통과하지 못하고, 남겨 둔 사본도 없습니다.",
        destructive: false,
      },
    ];
  }
  return [
    {
      id: "delete",
      label: "제거했습니다",
      detail: removalConsequence(kind),
      destructive: false,
    },
  ];
}

function removalConsequence(kind: HostedCleanupKind): string {
  switch (kind) {
    case "connector":
      return "provider의 커넥터 목록에서 사라진 것을 확인했습니다. 로컬 파일은 이 확인에 포함되지 않습니다.";
    case "local_plugin_files":
      return "이 기기에서 그 파일들을 지운 것을 확인했습니다.";
    case "plugin":
      return "provider 계정에서 플러그인 등록 자체가 사라진 것을 확인했습니다.";
    case "routine":
      return "routine이 목록에서 사라진 것을 확인했습니다. 꺼 두기만 한 것은 여기 해당하지 않습니다.";
    case "bot":
    case "secret":
      // 두 종류는 위에서 자기 문장을 갖는다. 여기 닿을 일은 없지만, 닿았을 때
      // 빈 문자열을 그리는 것보다 한 문장을 그리는 편이 낫다.
      return "이 항목을 정리한 것을 확인했습니다.";
  }
}

/**
 * 요청 어휘를 저장 어휘로. 서버 `stored_disposition` 과 같은 표이고, 같은 방식으로
 * **불가능한 짝을 `null` 로 답한다** (fail-closed).
 */
export function storedDisposition(
  kind: HostedCleanupKind,
  choice: HostedCleanupChoice
): HostedCleanupDisposition | null {
  if (kind === "bot") {
    if (choice === "delete") return "removed";
    if (choice === "preserve") return "preserved";
    return null;
  }
  if (kind === "secret") {
    return choice === "revoke" ? "revoked" : null;
  }
  return choice === "delete" ? "removed" : null;
}

// ---- 관측 -------------------------------------------------------------------

export interface CleanupStatusChoice {
  id: HostedCleanupStatus;
  label: string;
  detail: string;
}

/**
 * 사람이 고를 수 있는 관측 셋.
 *
 * `unknown` 은 목록에 없다 — 그것은 아직 아무것도 보지 않은 씨앗 상태이고,
 * "모르겠다"를 고르게 하는 것은 확인 절차에서 뒤로 가는 유일한 선택지를 만드는
 * 일이다. `inactive` 는 **끌 수 있는 종류에만** 선다: 파일과 자격증명에는 꺼진
 * 상태가 없고, 없는 상태를 고르게 두면 사람은 자기가 무엇을 적었는지 모른다.
 */
export function statusChoices(
  kind: HostedCleanupKind
): readonly CleanupStatusChoice[] {
  const present: CleanupStatusChoice =
    kind === "local_plugin_files"
      ? {
          id: "present",
          label: "아직 남아 있습니다",
          detail: "지우지 못했거나 아직 손대지 않았습니다.",
        }
      : {
          id: "present",
          label: "아직 남아 있습니다",
          detail: "provider에서 그대로 살아 있는 것을 확인했습니다.",
        };
  const absent: CleanupStatusChoice = {
    id: "absent",
    label: "사라진 것을 확인했습니다",
    detail: "찾아봤고 없었습니다.",
  };
  if (kind === "local_plugin_files" || kind === "secret") {
    return [present, absent];
  }
  return [
    present,
    {
      id: "inactive",
      label: "꺼져 있지만 남아 있습니다",
      detail:
        "동작은 멈췄지만 항목 자체는 그대로입니다. 이 관측만으로는 이 줄이 닫히지 않습니다.",
    },
    absent,
  ];
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

// ---- 줄의 상태 --------------------------------------------------------------

/**
 * 한 줄을 어떻게 그릴 것인가.
 *
 * 넷인 것이 규율 2 다. `server_confirmed` 는 사람이 손댈 자리가 아니고,
 * `observed` 는 사람이 본 것은 있으나 아직 아무 줄도 닫지 않은 자리이며 —
 * 그 둘을 하나로 합치면 "꺼 둔 routine" 이 "확인된 routine" 으로 읽힌다.
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
    return artifact.source === "server_verified" ? "server_confirmed" : "resolved";
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
export function cleanupRowStateLabel(
  artifact: HostedCleanupArtifact
): string {
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
 * 지금 이 줄이 사람에게 무엇을 말하는가 — 상태 아래 한 문장.
 *
 * `observed` 가 자기 문장을 갖는 것이 이 함수의 존재 이유다. "꺼짐"이라고만 적힌
 * 줄은 끝난 것처럼 보인다.
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

/** 이 줄에 사람이 손댈 자리가 있는가. 서버가 닫은 줄과 이미 닫힌 줄은 없다. */
export function cleanupRowActionable(artifact: HostedCleanupArtifact): boolean {
  return !artifact.resolved;
}

/**
 * 화면에 그대로 그려도 되는 확인 내용.
 *
 * `server_verified` 줄의 `evidence` 는 **서버가 영어로 쓴 운영자 문장**이다
 * (`oort revoked N hosted credential(s) …`). 그것을 그리는 것은 `./model` 규율 3 이
 * 금지한 바로 그 습관이고, 이 표면에서는 한 번 더 나쁘다: 사람이 손으로 적은
 * 확인들 사이에 영어 한 줄이 서면 그것도 누군가 적은 말처럼 읽힌다. 서버가
 * 확인한 줄이 무엇을 뜻하는지는 `cleanupRowDetail` 이 한국어로 이미 말한다.
 *
 * manual 줄의 `evidence` 는 반대다 — 그 문장은 이 화면의 사람이 이 화면에서
 * 적은 것이므로 그대로 보여 주는 것이 정확하다.
 */
export function cleanupEvidenceText(
  artifact: HostedCleanupArtifact
): string | null {
  if (artifact.source === "server_verified") return null;
  return artifact.evidence ?? null;
}

/**
 * 확인을 저장하기 직전에 묻는 한 문장.
 *
 * 처분은 되돌릴 수 없다 — 서버는 이미 해결된 줄의 재결정을 409 로 거절한다. 그래서
 * 관측만 적는 저장(언제든 다시 적을 수 있다)과 달리 이 저장에는 질문이 선다.
 */
export function acknowledgeQuestion(
  kind: HostedCleanupKind,
  choice: HostedCleanupChoice
): string {
  const detail =
    dispositionChoices(kind).find((item) => item.id === choice)?.detail ?? "";
  return `${detail} 이 답은 기록에 남고 다시 정할 수 없습니다.`;
}

/** 질문에 답하는 버튼의 낱말. 저장이 아니라 **기록**이다. */
export const CLEANUP_CONFIRM_LABEL = "이대로 기록";

// ---- 증거 -------------------------------------------------------------------

/** 서버 `MAX_ARTIFACT_EVIDENCE_BYTES`. 화면이 자기 숫자를 지어내지 않는다. */
export const CLEANUP_EVIDENCE_MAX_BYTES = 2_000;

export type CleanupEvidenceIssue = "empty" | "tooLong";

/**
 * 서버 `validate_artifact_evidence` 와 같은 자. 트림한 뒤 **바이트**로 잰다.
 *
 * 글자가 아니라 바이트인 것이 중요하다: 한글 한 글자는 UTF-8 로 3바이트이므로
 * 글자로 재면 화면은 통과시키고 서버는 400 을 답한다. 그 어긋남은 사람이 긴
 * 확인 메모를 다 적은 다음에야 드러난다.
 */
export function evidenceIssue(raw: string): CleanupEvidenceIssue | null {
  const trimmed = raw.trim();
  if (trimmed === "") return "empty";
  if (new TextEncoder().encode(trimmed).byteLength > CLEANUP_EVIDENCE_MAX_BYTES) {
    return "tooLong";
  }
  return null;
}

export function evidenceIssueMessage(issue: CleanupEvidenceIssue): string {
  switch (issue) {
    case "empty":
      return "무엇을 보고 확인했는지 한 줄로 적어야 저장할 수 있습니다. 이 문장이 나중에 이 해제를 설명하는 유일한 기록입니다.";
    case "tooLong":
      return `확인한 내용이 너무 깁니다. ${CLEANUP_EVIDENCE_MAX_BYTES}바이트 안으로 줄이세요. 한글은 한 글자가 3바이트입니다.`;
  }
}

/** 증거 칸 옆에 상시 서는 예시. 종류마다 다르다. */
export function evidencePlaceholder(kind: HostedCleanupKind): string {
  switch (kind) {
    case "connector":
      return "예: 커넥터 목록에서 제거를 눌렀고 목록에서 사라진 것을 봤습니다";
    case "local_plugin_files":
      return "예: 이 기기의 플러그인 폴더를 열어 해당 소스 폴더를 지웠습니다";
    case "plugin":
      return "예: 플러그인 관리 화면에서 등록을 삭제했습니다";
    case "routine":
      return "예: routine 목록에서 이 항목을 삭제했고 목록이 비었습니다";
    case "bot":
      return "예: 대화 기록을 팀에 알리고 봇을 삭제했습니다";
    case "secret":
      return "예: 저장해 둔 사본을 비밀 저장소에서 지웠습니다";
  }
}

// ---- 요청 본문 --------------------------------------------------------------

export interface CleanupAcknowledgeInput {
  currentStatus: HostedCleanupStatus;
  /** 없으면 관측만 기록한다. `resolved` 는 그대로 거짓이다. */
  disposition?: HostedCleanupChoice;
  evidence?: string;
}

/**
 * acknowledge 본문. 이 종류가 받을 수 없는 처분은 **싣지 않는다** (fail-closed,
 * `approval.ts` 규율 3 과 같은 규율).
 *
 * `source` 는 여기에 없고 앞으로도 없다. 그 값은 서버가 자기가 지운 것에만 쓰는
 * 출처이고, 본문에 실을 칸을 만드는 순간 다음 사람이 그 칸을 채운다.
 */
export function buildAcknowledgement(
  kind: HostedCleanupKind,
  status: HostedCleanupStatus,
  choice: HostedCleanupChoice | null,
  evidence: string
): CleanupAcknowledgeInput {
  const legal = choice !== null && storedDisposition(kind, choice) !== null;
  if (!legal) return { currentStatus: status };
  return {
    currentStatus: status,
    disposition: choice as HostedCleanupChoice,
    evidence: evidence.trim(),
  };
}

/** 지금 저장 버튼을 누를 수 있는가. 처분을 골랐으면 증거가 있어야 한다. */
export function acknowledgeReady(
  kind: HostedCleanupKind,
  choice: HostedCleanupChoice | null,
  evidence: string
): boolean {
  if (choice === null) return true;
  if (storedDisposition(kind, choice) === null) return false;
  return evidenceIssue(evidence) === null;
}
