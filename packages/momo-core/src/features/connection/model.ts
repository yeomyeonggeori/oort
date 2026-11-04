import type { RestOutcome } from "../../lib/http";
import type { RealtimeStatus } from "../../lib/realtimeEvents";
import { CONNECTION_KEYS as K, type ConnectionPlainKey } from "./copyKeys";
import {
  foldRestOutcome,
  INITIAL_REST_SIGNAL,
  isUnreachableOutcome,
  restHasUnansweredFailure,
  restUnreachableDeclared,
  type RestSignal,
} from "./restSignal";
import { foldSocketEvent, openingSocketGap, settleGap, type SocketGap } from "./socketGap";
import { DISPLAY_GRACE_MS } from "./thresholds";

// =============================================================================
// 연결 상태 모델 하나 (#5219, #5201 S-A, 감사 문서 §4·§5·§7).
//
// 웹·데스크탑·폰이 같은 사실을 같은 문턱으로 읽는다. 입력은 네 가지 사실이고, 출력은 화면이 그대로 그릴 수
// 있는 모양이다. **순수**하다: 시계는 인자(`now`), 타이머·구독·저장 없음. 시계를 돌리는 일(다음 판정 시각에
// 다시 부르기)은 화면 훅이 `nextChangeAt`으로 한다.
//
// ## 입력
//   deviceOnline    기기가 아는 사실. `true`/`false`, 플랫폼이 모르면 `null`(모르면 막지 않는다).
//   socket          소켓 틈의 시계(`socketGap.ts`).
//   rest            REST 결과를 접은 한 줄(`restSignal.ts`) — 서버에 닿았나.
//   sessionExpired  로그인이 만료됐다(리프레시가 거절된 뒤에만 선다. 5xx·429·408로 회전이 끝나지 못한
//                   것은 만료가 아니라 서버 오류다 — 그 규칙은 `lib/api.ts`가 그대로 갖는다).
//
// ## 판정 순서(원인 우선순위). 먼저 맞는 것이 이긴다.
//   1. 로그인 만료         → phase `expired`. 앱이 로그인 화면으로 돌아가므로 연결에 대해 말하지 않는다.
//                            이미 서버가 거절했고 다시 로그인해야 한다는 사실은 기기·소켓 상태와 무관하다.
//   2. 기기 오프라인       → `deviceOffline`. OS가 확정한 사실이라 기다리지 않는다.
//   3. 서버에 닿지 못함    → `serverUnreachable`. REST 선언(서로 다른 요청 3건 연속 실패)이 섰을 때. 소켓이
//                            멀쩡해도 선다. 기다리지 않는다.
//   4. 소켓 틈             → 1초 미만 침묵(`quiet`), 10초까지 「연결 중」(`connecting`), 그 뒤 「끊김」.
//                            끝난 소켓은 기다리지 않고 바로 「끊김」. 끊김의 이름은 REST에 응답 없이 닿지
//                            못한 요청이 남아 있으면 `unknown`(실시간만이라고 말할 증거가 없다), 아니면
//                            `realtimeDown`.
//
// ## 막는 기준: 「이 요청이 나갈 수 있는가」(감사 문서 §4 원칙 4)
// 기기 오프라인·서버에 닿지 못함이 **확정**일 때만 보내기·올리기·승인을 막는다. 전송은 REST이고 소켓은
// 수신용이라, 실시간만 끊기면 열어 둔다. 모르면(`unknown`, `deviceOnline: null`) 열어 둔다. 막을 때도
// 입력과 초안은 지킨다(그 쪽은 화면 몫).
// =============================================================================

/**
 * 화면이 지금 어떤 모습이어야 하나.
 *   ok          말할 것이 없다. 아무것도 그리지 않는다.
 *   quiet       소켓 틈이 1초 안이다. 틈은 있지만 화면은 아직 침묵한다.
 *   connecting  틈이 1~10초다. 「연결 중…」, 단추 없음.
 *   down        끊김. `cause`가 이유를 말한다.
 *   expired     로그인이 만료됐다.
 */
export type ConnectionPhase = "ok" | "quiet" | "connecting" | "down" | "expired";

/** 닫힌 분류. 코드·서버 원문은 말하지 않는다(ADR-0213 §4·§7). */
export type ConnectionCause = "deviceOffline" | "serverUnreachable" | "realtimeDown" | "unknown";

export interface ConnectionInput {
  readonly deviceOnline: boolean | null;
  readonly socket: SocketGap;
  readonly rest: RestSignal;
  readonly sessionExpired: boolean;
}

export interface ConnectionAction {
  readonly kind: "reconnectNow";
  readonly labelKey: typeof K.reconnectNow;
}

export interface ConnectionView {
  readonly phase: ConnectionPhase;
  /** `phase`가 `down`일 때만 있다. */
  readonly cause: ConnectionCause | null;
  readonly canSend: boolean;
  readonly canUpload: boolean;
  readonly canDecide: boolean;
  /** 지속 표시(카드·띠)의 문장. 침묵이면 null. */
  readonly copy: { readonly title: ConnectionPlainKey; readonly detail: ConnectionPlainKey | null } | null;
  /** 보내기를 막았을 때 컴포저 위에 서는 한 줄. 막지 않았으면 null. */
  readonly composerNote: ConnectionPlainKey | null;
  /** 승인을 막았을 때 단추 자리의 한 줄. 막지 않았으면 null. */
  readonly approvalNote: ConnectionPlainKey | null;
  /** 지금 줄 수 있는 행동. 「연결 중」과 「오프라인」에는 단추가 없다. */
  readonly action: ConnectionAction | null;
  /**
   * 입력이 그대로여도 이 시각(epoch ms)에는 판정이 달라진다(`quiet`→`connecting`→`down`). 화면 훅이
   * `setTimeout(재판정, nextChangeAt - now)`로 쓴다. 시간으로 바뀔 일이 없으면 null.
   */
  readonly nextChangeAt: number | null;
}

/** 원인별 문장과 규칙. 화면은 이 표를 읽지 않고 `ConnectionView`를 읽는다(불러오기·올리기 이유만 `copyForCause`). */
interface CauseRule {
  readonly blocks: boolean;
  readonly reconnect: boolean;
  readonly copy: CauseCopy;
}

export interface CauseCopy {
  readonly title: ConnectionPlainKey;
  readonly detail: ConnectionPlainKey;
  /** 보내기 줄. 이 원인이 보내기를 막을 때만. */
  readonly composer: ConnectionPlainKey | null;
  /** 승인 줄. 이 원인이 승인을 막을 때만. */
  readonly approval: ConnectionPlainKey | null;
  /** 불러오기가 실패했을 때의 이유 한 줄. */
  readonly loadReason: ConnectionPlainKey;
  /** 올리기가 실패했을 때의 이유. 이 원인이 올리기 실패를 설명할 때만(아니면 null — 화면의 기존 문장을 쓴다). */
  readonly uploadFailed: ConnectionPlainKey | null;
}

const CAUSES = {
  deviceOffline: {
    blocks: true,
    reconnect: false,
    copy: {
      title: K.offlineTitle,
      detail: K.offlineDetail,
      composer: K.composerOffline,
      approval: K.approvalOffline,
      loadReason: K.loadReasonOffline,
      uploadFailed: K.uploadFailedOffline,
    },
  },
  serverUnreachable: {
    blocks: true,
    reconnect: true,
    copy: {
      title: K.serverUnreachableTitle,
      detail: K.serverUnreachableDetail,
      composer: K.composerServerUnreachable,
      approval: K.approvalServerUnreachable,
      loadReason: K.loadReasonServer,
      uploadFailed: K.uploadFailedServer,
    },
  },
  realtimeDown: {
    blocks: false,
    reconnect: true,
    copy: {
      title: K.realtimeDownTitle,
      detail: K.realtimeDownDetail,
      composer: null,
      approval: null,
      loadReason: K.loadReasonUnknown,
      uploadFailed: null,
    },
  },
  unknown: {
    blocks: false,
    reconnect: true,
    copy: {
      title: K.unknownTitle,
      detail: K.unknownDetail,
      composer: null,
      approval: null,
      loadReason: K.loadReasonUnknown,
      uploadFailed: null,
    },
  },
} as const satisfies Record<ConnectionCause, CauseRule>;

/** 원인별 문장 한 벌. 원인을 모르면(null) `unknown`의 문장이다. */
export function copyForCause(cause: ConnectionCause | null): CauseCopy {
  return CAUSES[cause ?? "unknown"].copy;
}

const RECONNECT_NOW: ConnectionAction = { kind: "reconnectNow", labelKey: K.reconnectNow };

const SILENT: ConnectionView = {
  phase: "ok",
  cause: null,
  canSend: true,
  canUpload: true,
  canDecide: true,
  copy: null,
  composerNote: null,
  approvalNote: null,
  action: null,
  nextChangeAt: null,
};

const EXPIRED: ConnectionView = {
  ...SILENT,
  phase: "expired",
  canSend: false,
  canUpload: false,
  canDecide: false,
  copy: { title: K.sessionExpired, detail: null },
};

function downView(cause: ConnectionCause): ConnectionView {
  const rule = CAUSES[cause];
  const open = !rule.blocks;
  return {
    phase: "down",
    cause,
    canSend: open,
    canUpload: open,
    canDecide: open,
    copy: { title: rule.copy.title, detail: rule.copy.detail },
    composerNote: rule.copy.composer,
    approvalNote: rule.copy.approval,
    action: rule.reconnect ? RECONNECT_NOW : null,
    nextChangeAt: null,
  };
}

/** 지금 입력이 말하는 모습. 부작용이 없고 `now`만 시계다. */
export function deriveConnectionState(input: ConnectionInput, now: number): ConnectionView {
  if (input.sessionExpired) return EXPIRED;
  if (input.deviceOnline === false) return downView("deviceOffline");
  if (restUnreachableDeclared(input.rest)) return downView("serverUnreachable");

  const socket = settleGap(input.socket, now);
  const gap = socket.open;
  if (socket.status === "connected" || gap === null) return SILENT;

  if (!socket.ended) {
    if (now < gap.quietUntil) {
      return { ...SILENT, phase: "quiet", nextChangeAt: gap.quietUntil };
    }
    if (now - gap.since < DISPLAY_GRACE_MS) {
      return {
        ...SILENT,
        phase: "connecting",
        copy: { title: K.connecting, detail: null },
        nextChangeAt: gap.since + DISPLAY_GRACE_MS,
      };
    }
  }
  return downView(restHasUnansweredFailure(input.rest) ? "unknown" : "realtimeDown");
}

// ---- 입력을 만드는 사건 ------------------------------------------------------
// 훅은 사건이 일어난 순간의 시각(`at`)을 찍어 `foldConnectionEvent`에 넘긴다. 접는 함수 자체는 시계를
// 읽지 않는다(리듀서에서 `Date.now()`를 부르지 않게).

export type ConnectionEvent =
  /** 소켓이 상태를 알렸다(웹은 #786 매핑을 거친 값). `ended`는 「이 소켓은 다시 열리지 않는다」일 때만. */
  | { kind: "socket"; at: number; status: RealtimeStatus; ended?: boolean }
  /** 앱 복귀·손으로 누른 「지금 다시 연결」: 소켓을 다시 여는 쪽이 알린다. */
  | { kind: "resume"; at: number }
  /** 기기의 온라인 사실이 바뀌었다. `null`은 플랫폼이 모른다. */
  | { kind: "device"; at: number; online: boolean | null }
  | { kind: "session"; expired: boolean }
  /** `lib/http.ts`의 `subscribeRestOutcome`이 알린 REST 결과 한 건. */
  | { kind: "rest"; outcome: RestOutcome };

/** 앱이 처음 뜰 때의 입력: 첫 핸드셰이크도 틈이다. */
export function initialConnectionInput(at: number, deviceOnline: boolean | null = null): ConnectionInput {
  return {
    deviceOnline,
    socket: openingSocketGap(at),
    rest: INITIAL_REST_SIGNAL,
    sessionExpired: false,
  };
}

export function foldConnectionEvent(input: ConnectionInput, event: ConnectionEvent): ConnectionInput {
  switch (event.kind) {
    case "socket":
      return {
        ...input,
        socket: foldSocketEvent(input.socket, {
          kind: "status",
          at: event.at,
          status: event.status,
          ...(event.ended === undefined ? {} : { ended: event.ended }),
        }),
      };
    case "resume":
      return { ...input, socket: foldSocketEvent(input.socket, { kind: "resume", at: event.at }) };
    case "device": {
      const next = { ...input, deviceOnline: event.online };
      // 꺼져 있던 기기가 돌아왔다. 그동안 쌓인 틈의 시계로 「끊김」을 말하면 막 돌아온 사람에게 가장
      // 무서운 문장이 먼저 뜬다. 틈을 새로 시작한다(말하던 띠는 「연결 중」으로 이어진다).
      return input.deviceOnline === false && event.online !== false
        ? { ...next, socket: foldSocketEvent(next.socket, { kind: "resume", at: event.at }) }
        : next;
    }
    case "session":
      return { ...input, sessionExpired: event.expired };
    case "rest": {
      // 기기가 꺼져 있는 동안의 실패는 서버에 대해 아무것도 말하지 않는다.
      if (input.deviceOnline === false && isUnreachableOutcome(event.outcome)) return input;
      const rest = foldRestOutcome(input.rest, event.outcome);
      return rest === input.rest ? input : { ...input, rest };
    }
  }
}
