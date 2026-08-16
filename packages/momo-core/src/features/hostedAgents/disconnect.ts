import { bool, num, record, WireShapeError } from "../../lib/wire";
import {
  cleanupRowTitle,
  parseCleanupArtifacts,
  sortCleanupArtifacts,
  toCleanupArtifact,
  type HostedCleanupArtifact,
} from "./cleanup";
import {
  toHostedConnection,
  type HostedAgentConnection,
} from "./model";
import type { HostedGate } from "./wizard";

// =============================================================================
// 해제의 두 걸음 — oort 권한 폐기(즉시)와 provider 정리 확인(사람)
// (ADR-0162 HAP-E6, goal HAP-UX2 / #1362).
//
// 이 흐름이 두 걸음인 이유는 oort 가 provider 안에 손을 넣을 수 없기 때문이다.
// 그래서 화면이 절대 하면 안 되는 두 가지가 있고, 이 파일의 모든 판정이 그 둘을
// 막는 데 쓰인다:
//
//   1. **oort 가 정리해 준 척하지 않는다.** 커넥터도 routine 도 플러그인도 사람이
//      provider 화면에서 직접 지운다. 이 목록은 대신 해 주는 도구가 아니라
//      사람이 무엇을 확인했는지 적는 장부다.
//   2. **클라이언트 체크만으로 끝났다고 말하지 않는다.** terminal `disconnected`
//      는 서버가 정한다. 서버는 필수 항목이 하나라도 미해결이면 409 이고, 자기가
//      한 일(자격증명 0개·전용 멤버 pause)을 되읽지 못해도 409 다. 화면의 상태는
//      언제나 마지막으로 받은 서버 상태이고, 새로고침·오프라인·재시도 뒤에도
//      같은 자리가 복원된다.
//
// ## 첫 걸음은 즉시이고 원자적이다
//
// `POST …/disconnect` 한 transaction 안에서 자격증명 폐기, `cleanup_pending`
// 전이, 전용 멤버 pause, 진행 중이던 작업 정리, 6종 정리 목록 씨앗이 함께
// 일어난다. 하나라도 실패하면 전부 되돌아간다. 그래서 이 화면은 "폐기했습니다,
// 그런데 pause 는 실패했습니다" 같은 반쪽 상태를 그릴 필요가 없다 — 그런 상태는
// 존재하지 않는다.
//
// ## 재시도는 두 번째 해제가 아니다
//
// 이미 `cleanup_pending` 인 연결에 같은 요청을 보내면 서버는 `startedNow: false`
// 로 답하고 아무것도 다시 쓰지 않는다. 다만 **목록은 병합한다**: 두 번째로
// provider 설정을 훑다가 찾은 항목이야말로 놓치기 쉬운 항목이기 때문이다. 그래서
// 이 화면의 재시도 버튼은 「해제 다시 하기」가 아니라 「정리 목록 복원」이다.
// =============================================================================

// ---- wire -------------------------------------------------------------------

export interface HostedConnectionDetail {
  connection: HostedAgentConnection;
  /** 해제 전에는 빈 목록이다. 다른 형상이 아니라 **같은 형상의 빈 값**이다. */
  artifacts: HostedCleanupArtifact[];
}

/**
 * 단건 조회 응답 전체.
 *
 * UX1 의 `parseHostedConnection` 은 커넥션만 돌려준다. 그 파서를 넓히는 대신 이
 * 파서를 따로 두는 이유는 두 화면이 같은 URL 에서 **서로 다른 것**을 필요로 하기
 * 때문이다: 마법사는 상태 한 줄을 되묻고, 이 화면은 장부 전체를 읽는다. 파서 하나가
 * 둘을 겸하면 마법사의 폴링이 매 5초마다 쓰지 않을 목록을 파싱한다.
 */
export function parseHostedConnectionDetail(wire: unknown): HostedConnectionDetail {
  const connection = toHostedConnection(record(wire)?.["connection"]);
  if (!connection) throw new WireShapeError();
  return { connection, artifacts: parseCleanupArtifacts(wire) };
}

export interface HostedDisconnectStarted extends HostedConnectionDetail {
  /** 아직 해결되지 않은 **필수** 항목 수. 서버가 센 값이다. */
  remainingRequired: number;
  /** 이 호출이 전이를 일으켰는가. 거짓이면 이미 진행 중이던 해제다. */
  startedNow: boolean;
}

/**
 * 해제 시작 응답.
 *
 * 상태를 `cleanup_pending` 로 못 박는 것이 이 파서의 일이다. 서버가 그 전이를
 * 약속하고 있고(openapi), 다른 상태를 실은 응답을 받아 그리면 화면은 "해제가
 * 시작됐다"고 말하면서 아직 살아 있는 연결을 보여 준다.
 */
export function parseDisconnectStart(
  wire: unknown,
  expected: { connectionId: string }
): HostedDisconnectStarted {
  const row = record(wire);
  const connection = toHostedConnection(row?.["connection"]);
  const remainingRequired = num(row, "remainingRequired");
  const startedNow = bool(row, "startedNow");
  if (
    !connection ||
    remainingRequired === undefined ||
    startedNow === undefined
  ) {
    throw new WireShapeError();
  }
  if (connection.id !== expected.connectionId) throw new WireShapeError();
  if (connection.status !== "cleanup_pending") throw new WireShapeError();
  return {
    connection,
    artifacts: parseCleanupArtifacts(wire),
    remainingRequired,
    startedNow,
  };
}

export interface HostedArtifactAcknowledged {
  artifact: HostedCleanupArtifact;
  remainingRequired: number;
  /** 거짓이면 바이트가 같은 반복이고 서버는 감사 기록을 남기지 않았다. */
  changed: boolean;
}

/**
 * 확인 기록 응답.
 *
 * `expected.artifactId` 대조가 있는 이유는 이 화면이 여러 줄을 연달아 확인하는
 * 자리이기 때문이다. 응답이 늦게 도착해 다른 줄의 응답과 뒤바뀌면, 화면은 사람이
 * 손대지 않은 줄에 방금 적은 증거를 붙인다.
 */
export function parseArtifactAcknowledgement(
  wire: unknown,
  expected: { artifactId: string }
): HostedArtifactAcknowledged {
  const row = record(wire);
  const artifact = toCleanupArtifact(row?.["artifact"]);
  const remainingRequired = num(row, "remainingRequired");
  const changed = bool(row, "changed");
  if (!artifact || remainingRequired === undefined || changed === undefined) {
    throw new WireShapeError();
  }
  if (artifact.id !== expected.artifactId) throw new WireShapeError();
  return { artifact, remainingRequired, changed };
}

export interface HostedDisconnectCompleted extends HostedConnectionDetail {
  /** 거짓이면 이미 끝난 전이의 재생이다. 두 번 일어나지 않는다. */
  disconnectedNow: boolean;
}

export function parseDisconnectCompletion(
  wire: unknown,
  expected: { connectionId: string }
): HostedDisconnectCompleted {
  const row = record(wire);
  const connection = toHostedConnection(row?.["connection"]);
  const disconnectedNow = bool(row, "disconnectedNow");
  if (!connection || disconnectedNow === undefined) throw new WireShapeError();
  if (connection.id !== expected.connectionId) throw new WireShapeError();
  // 이 응답의 뜻은 하나뿐이다: 끝났다. 다른 상태를 실은 200 은 형상 오류다.
  if (connection.status !== "disconnected") throw new WireShapeError();
  return {
    connection,
    artifacts: parseCleanupArtifacts(wire),
    disconnectedNow,
  };
}

// ---- 진행 -------------------------------------------------------------------

export interface CleanupProgress {
  total: number;
  resolved: number;
  /** 아직 답하지 않은 필수 항목 수. terminal 을 막는 것은 이 숫자다. */
  remainingRequired: number;
  /** 그중 첫 줄의 이름. "다음에 무엇을" 이 이름을 쓴다. */
  nextTitle: string | null;
}

/**
 * 아직 답하지 않은 필수 줄들, **화면 순서로**.
 *
 * 정렬이 여기 있는 이유는 「다음은 무엇인가」가 이 목록의 첫 줄이기 때문이다.
 * 입력 순서를 그대로 쓰면 서버가 알파벳으로 준 목록에서는 봇이, 화면이 정렬한
 * 목록에서는 커넥터가 「다음」이 되어, 같은 상태의 같은 연결이 어디서 물었느냐에
 * 따라 다른 다음 행동을 답한다.
 */
export function unresolvedRequired(
  artifacts: readonly HostedCleanupArtifact[]
): HostedCleanupArtifact[] {
  return sortCleanupArtifacts(
    artifacts.filter((row) => row.required && !row.resolved)
  );
}

/**
 * 목록 전체를 한 줄 숫자로.
 *
 * `remainingRequired` 를 서버 응답에서 받아 두고도 여기서 다시 세는 이유는 이
 * 화면이 서버 응답 사이에도 산다는 것이다: 확인 하나를 저장한 직후, 목록을 다시
 * 받기 전에도 진행 표시는 맞아야 한다. 서버가 준 숫자와 어긋날 수 있는 유일한
 * 구간이 그 사이이고, 그 구간에서 옳은 것은 방금 받은 줄이 반영된 이 계산이다.
 */
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
    return "정리 목록이 아직 없습니다. 해제를 시작하면 확인할 항목이 여기 생깁니다.";
  }
  if (progress.remainingRequired === 0) {
    return "필수 항목을 모두 확인했습니다. 이제 해제를 끝낼 수 있습니다.";
  }
  const next = progress.nextTitle;
  return next === null
    ? `아직 확인하지 않은 항목이 ${progress.remainingRequired}개 남았습니다.`
    : `아직 확인하지 않은 항목이 ${progress.remainingRequired}개 남았습니다. 다음은 ${next}입니다.`;
}

// ---- 게이트 -----------------------------------------------------------------

/**
 * 지금 해제를 시작할 수 있는가.
 *
 * 서버 `HOSTED_DISCONNECTABLE_STATES` 그대로 `detected` 와 `active` 둘이다. 나머지
 * 상태에서 버튼을 눌러 409 를 받게 두면, 사람은 자기가 무엇을 잘못했는지 모른 채
 * 「연결을 해제할 수 없습니다」만 읽는다. 막힌 이유는 상태마다 다르고, 다음 행동도
 * 다르다.
 */
export function disconnectStartGate(
  connection: HostedAgentConnection | null
): HostedGate {
  if (connection === null) {
    return { allowed: false, blockedCopy: "이 에이전트에는 호스티드 연결이 없습니다." };
  }
  switch (connection.status) {
    case "detected":
    case "active":
      return { allowed: true };
    case "pairing_pending":
      return {
        allowed: false,
        blockedCopy:
          "아직 이 에이전트가 한 번도 다이얼인하지 않아 해제할 권한이 없습니다. 그대로 두면 연결 값이 만료됩니다.",
      };
    case "expired":
      return {
        allowed: false,
        blockedCopy:
          "연결 값이 만료돼 이미 아무 권한도 열려 있지 않습니다. 정리할 provider 설정이 있으면 provider 화면에서 직접 지우세요.",
      };
    case "cleanup_pending":
      return {
        allowed: false,
        blockedCopy: "이 연결은 이미 해제 중입니다. 아래 정리 목록을 이어서 확인하세요.",
      };
    case "disconnected":
      return { allowed: false, blockedCopy: "이 연결은 이미 해제됐습니다." };
  }
}

/**
 * 지금 정리 목록을 복원할 수 있는가 (재시도 경로).
 *
 * 같은 `POST …/disconnect` 이지만 사람에게는 다른 동작이다: 전이는 이미
 * 일어났고 이 호출은 목록만 다시 채운다. 목록이 빈 채로 `cleanup_pending` 인
 * 연결은 terminal 을 영원히 거절당하므로(서버가 빈 목록을 근거로 통과시키지
 * 않는다), 그 막다른 골목에서 빠져나오는 길이 정확히 이 버튼이다.
 */
export function manifestRepairGate(
  connection: HostedAgentConnection | null
): HostedGate {
  if (connection === null || connection.status !== "cleanup_pending") {
    return {
      allowed: false,
      blockedCopy: "정리 중인 연결에서만 목록을 복원할 수 있습니다.",
    };
  }
  return { allowed: true };
}

/**
 * 지금 해제를 끝낼 수 있는가.
 *
 * 서버의 네 관문을 화면 말로 미리 답한다. **막힌 이유를 감추지 않는 것**이 이
 * 게이트의 전부다: 버튼이 조용히 죽어 있으면 사람은 자기가 무엇을 더 해야 하는지
 * 알 수 없고, 결국 아무것이나 눌러 본다.
 *
 * 마지막 관문(자격증명 0개·전용 멤버 pause)은 이 화면이 확인할 수 없다. 서버만
 * 되읽을 수 있는 사실이고, 그래서 이 게이트가 통과시킨 뒤에도 409 가 올 수 있다.
 * 그 응답의 문구가 `hostedFailureMessage("complete", …)` 에 따로 있는 이유다.
 */
export function terminalGate(
  connection: HostedAgentConnection | null,
  artifacts: readonly HostedCleanupArtifact[]
): HostedGate {
  if (connection === null) {
    return { allowed: false, blockedCopy: "이 에이전트에는 호스티드 연결이 없습니다." };
  }
  if (connection.status === "disconnected") {
    return { allowed: false, blockedCopy: "이 연결은 이미 해제됐습니다." };
  }
  if (connection.status !== "cleanup_pending") {
    return {
      allowed: false,
      blockedCopy: "아직 해제를 시작하지 않았습니다. 먼저 연결 해제를 시작하세요.",
    };
  }
  if (artifacts.length === 0) {
    return {
      allowed: false,
      blockedCopy:
        "정리 목록이 비어 있어 무엇을 확인했는지 판단할 수 없습니다. 목록을 복원한 뒤 이어서 확인하세요.",
    };
  }
  const progress = cleanupProgress(artifacts);
  if (progress.remainingRequired > 0) {
    return {
      allowed: false,
      blockedCopy: cleanupProgressSentence(progress),
    };
  }
  return { allowed: true };
}

// ---- 첫 걸음이 이미 한 일 ---------------------------------------------------

export interface DisconnectFact {
  key: string;
  value: string;
}

/**
 * 해제가 시작된 순간 서버가 **이미** 한 일들.
 *
 * 이 목록이 있는 이유는 수용 기준 하나가 그것을 요구해서가 아니라, 이 화면의 남은
 * 절반이 전부 "아직 안 끝났다"를 말하기 때문이다. 그 옆에 끝난 것을 적지 않으면
 * 사람은 자기 워크스페이스가 아직 열려 있다고 읽고 provider 정리를 서두른다.
 *
 * 세 줄 전부 한 transaction 의 결과이므로 부분 참이 없다. 그래서 상태 하나
 * (`cleanup_pending` 이상)로 세 줄을 함께 세운다.
 */
export function revokeFacts(
  connection: HostedAgentConnection
): DisconnectFact[] {
  if (connection.status !== "cleanup_pending" && connection.status !== "disconnected") {
    return [];
  }
  return [
    {
      key: "자격증명",
      value:
        "폐기됐습니다. 이 연결이 쓰던 값으로는 어떤 요청도 통과하지 못하고, 도구 목록도 열리지 않습니다.",
    },
    {
      key: "전용 에이전트",
      value:
        "일시정지됐습니다. 멘션해도 응답하지 않고 새 작업을 가져가지 못합니다.",
    },
    {
      key: "진행 중이던 작업",
      value:
        "정리됐습니다. 이미 넘겨 둔 작업의 점유가 풀렸고, 다음 폴링이 아니라 그 자리에서 멈췄습니다.",
    },
  ];
}

// ---- 문구 -------------------------------------------------------------------

export const DISCONNECT_SECTION_TITLE = "호스티드 연결";

/**
 * 탭 머리의 한 문단.
 *
 * 주어가 「이 에이전트」가 아니라 「호스티드 연결」인 것은 이 탭이 연결 없는
 * 에이전트에도 서기 때문이다. 앞 판의 문장은 「이 에이전트는 다른 곳에서 돌고
 * 있고」로 시작했고, 그것이 빈 상태에서 바로 아래 문장(「이 워크스페이스가 직접
 * 실행하는 에이전트입니다」)과 정면으로 어긋났다.
 */
export const DISCONNECT_SECTION_LEAD =
  "호스티드 연결은 다른 곳에서 돌고 있는 에이전트를 이 워크스페이스에 들인 것입니다. 해제는 oort 쪽 권한을 즉시 끊는 일과, provider에 남은 설정을 사람이 정리했는지 확인하는 일 두 걸음입니다.";

/** 해제를 시작하기 전 화면이 반드시 나눠 말해야 하는 두 문단 중 첫째. */
export const DISCONNECT_IMMEDIATE_HEADLINE = "지금 바로 일어나는 일";

export const DISCONNECT_IMMEDIATE_ITEMS: readonly string[] = [
  "이 연결의 자격증명이 폐기되고, 그 값으로는 아무 요청도 통과하지 못합니다.",
  "전용 에이전트가 일시정지되어 멘션에도 응답하지 않습니다.",
  "이미 넘겨 둔 작업의 점유가 풀리고 그 자리에서 멈춥니다.",
];

/** 둘째 문단. **이 버튼이 하지 않는 일**을 같은 크기로 적는다. */
export const DISCONNECT_NOT_DONE_HEADLINE = "이 버튼이 하지 않는 일";

export const DISCONNECT_NOT_DONE_ITEMS: readonly string[] = [
  "provider에 만들어 둔 커넥터, 플러그인, routine, 봇은 그대로 남습니다. oort는 provider 안에 손을 넣지 못합니다.",
  "이 기기에 받아 둔 플러그인 파일도 그대로 남습니다.",
  "지금까지 나눈 대화, 채널, 작업 기록은 하나도 지워지지 않습니다.",
];

/**
 * 대화가 지워진다는 오해를 막는 한 문장.
 *
 * 해제 화면에서 사람이 가장 자주 하는 오해가 이것이고, 그 오해는 두 방향으로
 * 비싸다: 지워질까 봐 해제를 미루거나, 지워졌다고 믿고 남은 기록을 방치한다.
 */
export const DISCONNECT_HISTORY_NOTE =
  "해제는 기록을 지우는 일이 아닙니다. 이 에이전트가 남긴 메시지와 작업 기록은 채널에 그대로 남습니다.";

export const DISCONNECT_START_LABEL = "연결 해제 시작";

export const DISCONNECT_START_QUESTION =
  "이 연결의 자격증명을 지금 폐기하고 정리 확인을 시작합니다. 폐기는 되돌릴 수 없고, 다시 쓰려면 새 연결을 만들어야 합니다.";

export const DISCONNECT_START_CONFIRM_LABEL = "폐기하고 시작";

// ---- 정리 목록 --------------------------------------------------------------

export const CLEANUP_HEADLINE = "provider에 남은 것 정리";

/**
 * 목록 머리의 한 문단.
 *
 * "oort 는 확인만 한다"를 여기서 한 번 적어 두면, 각 줄이 자기 함정만 말하면
 * 된다. 줄마다 이 사실을 반복하면 여섯 번 같은 말이 서고 정작 줄마다 다른 함정이
 * 묻힌다.
 */
export const CLEANUP_LEAD =
  "아래 항목은 사람이 provider 화면에서 직접 정리하고, oort는 그 확인을 기록만 합니다. 확인한 내용은 나중에 이 해제를 설명하는 근거로 남습니다.";

/** 한 줄을 확인해도 다른 줄이 닫히지 않는다는 사실. 목록 머리에 상시 노출된다. */
export const CLEANUP_INDEPENDENCE_NOTE =
  "항목은 서로 대신하지 않습니다. 커넥터를 제거해도 로컬 파일 줄은 열린 채 남고, routine을 꺼 두는 것은 제거가 아닙니다.";

/**
 * 오프라인일 때 목록 머리에 한 번 서는 문장.
 *
 * 배너가 아니라 문장인 이유: 에이전트 화면은 이미 자기 오프라인 배너를 하나
 * 들고 있고(`agent-hub-offline`), 그 아래 같은 말을 배너로 또 세우면 한 화면에
 * 같은 사실이 셋이 된다(셸까지 세면 넷). 대신 이 문장은 **id 를 갖고**, 잠긴
 * 여섯 줄의 버튼이 전부 이 한 문장을 가리킨다 — 같은 사유를 여섯 번 적는 대신
 * 한 번 적고 여섯이 참조하는 규율은 `ConfirmButton.describedBy` 의 것이다.
 */
export const CLEANUP_OFFLINE_NOTE =
  "연결이 끊겨 있어 지금은 확인을 저장할 수 없습니다. 마지막으로 받은 목록은 그대로 읽을 수 있습니다.";

/**
 * 앞선 쓰기가 아직 날고 있어 목록이 잠겼을 때, 오프라인 문장과 **같은 자리에**
 * 서는 두 번째 사유.
 *
 * 이 화면은 잠기는 이유가 둘인데(오프라인, 그리고 이 화면이 보낸 앞선 쓰기)
 * 문장은 하나뿐이었다. 그래서 두 번째 이유로 잠긴 줄들의 버튼은 사유 없이
 * 회색이 됐고, 잠긴 컨트롤이 `aria-disabled` 로 tab order 에 남게 된 뒤로는 그
 * 침묵이 더 크게 들린다: 초점은 닿는데 왜 못 하는지는 아무 데도 없다.
 *
 * 낱말이 「저장」이 아니라 「누른 것」인 이유: 이 잠금을 켜는 쓰기는 셋이고
 * (해제 시작·목록 복원, 확인 저장, 해제 확정) 그중 무엇이 날고 있는지 이 문장은
 * 알지 못한다. 셋 다 사람이 방금 이 화면에서 누른 것이므로, 참인 말은 그것뿐이다.
 * 없는 구체성을 지어내면 「확인을 저장하는 중」이라고 적어 두고 실제로는 해제
 * 확정이 날고 있는 경우가 생긴다.
 */
export const CLEANUP_BUSY_NOTE =
  "앞서 누른 것이 아직 끝나지 않았습니다. 그것이 끝나면 이어서 기록할 수 있습니다.";

export const CLEANUP_ACKNOWLEDGE_LABEL = "확인 기록";

export const CLEANUP_SAVE_LABEL = "확인 저장";

export const CLEANUP_EVIDENCE_LABEL = "무엇을 보고 확인했습니까";

export const CLEANUP_STATUS_LEGEND = "지금 provider에서 본 상태";

export const CLEANUP_DISPOSITION_LEGEND = "이 항목을 어떻게 했습니까";

/** 처분을 아직 고르지 않은 선택지. 관측만 기록하는 길이 있다는 사실을 세운다. */
export const CLEANUP_DISPOSITION_DEFER_LABEL = "아직 정하지 않았습니다";

export const CLEANUP_DISPOSITION_DEFER_DETAIL =
  "본 것만 기록하고 이 항목은 열어 둡니다. 열린 항목이 하나라도 있으면 해제를 끝낼 수 없습니다.";

// ---- 마지막 걸음 ------------------------------------------------------------

export const TERMINAL_HEADLINE = "해제 끝내기";

export const TERMINAL_LEAD =
  "필수 항목을 모두 확인하면 서버가 마지막으로 자기 쪽 상태를 다시 읽고 해제를 확정합니다. 확정은 한 번만 일어납니다.";

export const TERMINAL_LABEL = "해제 확정";

export const TERMINAL_QUESTION =
  "정리 확인을 모두 마쳤다고 서버에 알리고 이 연결을 해제 상태로 확정합니다. 확정한 뒤에는 이 연결을 되살릴 수 없습니다.";

export const TERMINAL_CONFIRM_LABEL = "확정";

export const TERMINAL_DONE_HEADLINE = "이 연결은 해제됐습니다.";

export const TERMINAL_DONE_DETAIL =
  "이 에이전트를 다시 들이려면 새 연결을 만들어야 하고, 그때 만들어지는 것은 새 전용 에이전트입니다. 지난 대화와 작업 기록은 그대로 남아 있습니다.";

export const MANIFEST_REPAIR_LABEL = "정리 목록 복원";

export const MANIFEST_REPAIR_NOTE =
  "목록을 다시 채웁니다. 이미 확인한 항목은 되돌아가지 않고, 해제가 두 번 일어나지도 않습니다.";

// ---- live region ------------------------------------------------------------

/**
 * 상태가 바뀔 때 스크린리더가 읽을 한 문장.
 *
 * 비밀값을 담지 않는 것은 `wizard.ts` 와 같은 규율이고, 여기서는 더 쉽다 — 이
 * 표면에는 원문 비밀값이 아예 오지 않는다. 대신 이 자리가 조심할 것은 **숫자**다:
 * "3개 남았습니다"가 매 저장마다 낭독되어야 사람이 진행을 귀로 따라간다.
 */
export function disconnectLiveMessage(
  connection: HostedAgentConnection | null,
  artifacts: readonly HostedCleanupArtifact[]
): string {
  if (connection === null) return "이 에이전트에는 호스티드 연결이 없습니다.";
  switch (connection.status) {
    case "cleanup_pending": {
      const progress = cleanupProgress(artifacts);
      return `oort 쪽 권한은 끊겼습니다. ${cleanupProgressSentence(progress)}`;
    }
    case "disconnected":
      return "이 연결은 해제됐습니다.";
    default:
      return "이 연결은 아직 살아 있습니다. 해제를 시작하면 자격증명이 폐기됩니다.";
  }
}
