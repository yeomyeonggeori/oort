import type { WorkSessionControlFrame } from "../../lib/realtimeEvents";
import {
  LOGIN_HANDOFF_OUTCOME_DETAIL,
  LOGIN_HANDOFF_OUTCOME_LABEL,
  parseLoginHandoffOutcome,
  type LoginHandoffOutcome,
} from "../timeline/loginHandoffCard";

// =============================================================================
// 세션 상세의 직접 조작 표시 (LIVE-4 / ADR-0004 증보 3 D3)
//
// 카드는 「에이전트가 사람을 불렀다」를 말하고, 이 모듈은 세션 표면이 말할 것을
// 정한다: **지금 이 세션 화면을 누가 잡고 있는가, 언제부터, 그리고 끝났다면 어떻게.**
//
// ## 이 표시의 주어가 왜 창인가
//
// 세션 상세는 이미 상태·호스트·관전자 수를 말한다. 거기에 없던 사실이 하나
// 있었고, 그것이 사람이 가장 먼저 묻는 것이다 — 「왜 에이전트가 멈춰 있지」.
// 답은 세션 상태에도 호스트에도 없다. control 창에 있다.
//
// ## 왜 카드와 다른 타입인가
//
// 카드가 아는 것은 **그 카드가 부른 개입**이고, 이 표면이 아는 것은 **이 세션의
// 창**이다. 둘은 대개 같지만 항상 같지는 않다: 창은 카드 없이도 열린다(REST 직접
// 호출·API 발). 그 경우를 카드 타입으로 그리면 있지도 않은 요청을 그리게 된다.
//
// 결과 어휘는 카드와 **같은 것을 쓴다**(`LoginHandoffOutcome`). 한 창이 끝난
// 방식이 두 표면에서 다른 이름을 가지면, 그 둘을 나란히 본 사람은 두 사건이
// 일어났다고 읽는다.
//
// ## 이 표면이 아는 것의 한계, 그리고 그것을 말하는 방식
//
// 여기 오는 사실은 **경계 이벤트**다 — 전송(Centrifugo)이고 원장이 아니다.
// 그래서 이 화면을 연 뒤에 도착한 것만 안다. 그 한계는 카피로 덮지 않고 [`stale`]
// 로 표시해, 화면이 「창이 없다」고 단언하지 않게 한다. 없는 것과 못 들은 것은
// 다르고, 둘을 같은 침묵으로 그리는 것이 이 레포가 「화면이 거짓을 말함」이라고
// 부르는 실패다.
// =============================================================================

/** 세션 표면이 그릴 창 하나. */
export interface ControlWindowNotice {
  state: "open" | "closed";
  /** 정지 시각. */
  startedAtMs: number;
  /** 재개 시각. 열려 있으면 null. */
  endedAtMs: number | null;
  /** 어떻게 끝났는가. 열려 있으면 null. */
  outcome: LoginHandoffOutcome | null;
  headline: string;
  detail: string;
}

export const CONTROL_OPEN_HEADLINE = "사람이 직접 조작 중";
export const CONTROL_CLOSED_HEADLINE = "직접 조작이 끝났습니다";

/**
 * 창이 열려 있는 동안 세션 표면이 말할 것.
 *
 * 두 문장을 한 자리에 둔다. 첫째는 **왜 에이전트가 조용한가**이고, 그것이 이
 * 표시가 존재하는 이유다. 둘째는 **무엇이 여전히 참인가**로, 사람들이 곧바로
 * 묻는 두 번째 질문에 답한다: VM 은 계속 돌고 과금도 계속된다(증보 3 D6).
 * 그 사실을 말하지 않으면 「멈췄다」가 「꺼졌다」로 읽힌다.
 */
export const CONTROL_OPEN_DETAIL =
  "이 동안 에이전트는 이 세션의 화면을 보지 못하고 입력도 하지 못합니다. 호스트는 계속 실행 중이고 사용 시간도 계속 쌓입니다.";

/** 경계 이벤트만으로 그려진 표시라는 사실. 카피가 아니라 플래그다. */
export interface ControlWindowView {
  notice: ControlWindowNotice | null;
  /**
   * 이 화면이 창에 대해 **들은 것이 없다**는 뜻. 창이 없다는 뜻이 아니다.
   *
   * 경계 이벤트는 전송이라 이 화면을 연 뒤 도착한 것만 안다. 새로고침 직후에는
   * 언제나 참이고, 그때 「직접 조작 중인 사람 없음」이라고 단언하면 그것은
   * 화면이 모르는 것을 아는 척하는 것이다.
   */
  stale: boolean;
}

/**
 * 경계 이벤트 하나를 표시로 접는다.
 *
 * 이 세션의 것이 아니면 `null`. 세션 id 대조는 호출자가 하는 것이 아니라 여기서
 * 하는데, 이 판정을 화면에 두면 두 표면이 각자 대소문자 규칙을 갖게 되기
 * 때문이다(uuid 는 대소문자가 섞여 온다).
 */
export function controlWindowNotice(
  frame: WorkSessionControlFrame,
  sessionId: string
): ControlWindowNotice | null {
  if (frame.payload.session_id.toLowerCase() !== sessionId.toLowerCase()) {
    return null;
  }
  const startedAtMs = frame.payload.started_at;
  if (frame.payload.state === "opened") {
    return {
      state: "open",
      startedAtMs,
      endedAtMs: null,
      outcome: null,
      headline: CONTROL_OPEN_HEADLINE,
      detail: CONTROL_OPEN_DETAIL,
    };
  }
  const outcome = parseLoginHandoffOutcome(frame.payload.end_reason);
  return {
    state: "closed",
    startedAtMs,
    endedAtMs:
      typeof frame.payload.ended_at === "number" ? frame.payload.ended_at : null,
    outcome,
    headline: CONTROL_CLOSED_HEADLINE,
    // 원장 어휘 밖의 사유는 문장을 지어내지 않는다. 「끝났다」까지가 아는
    // 전부이고, 그 이상을 말하면 다음 배포의 새 사유를 오늘의 낱말로 오역한다.
    detail:
      outcome === null
        ? "에이전트가 이 세션에서 다시 실행됩니다."
        : LOGIN_HANDOFF_OUTCOME_DETAIL[outcome],
  };
}

/** 칩 한 낱말. 카드와 같은 표를 쓴다. */
export function controlWindowLabel(notice: ControlWindowNotice): string {
  return notice.outcome !== null
    ? LOGIN_HANDOFF_OUTCOME_LABEL[notice.outcome]
    : notice.state === "open"
      ? "조작 중"
      : "종료됨";
}

/**
 * 이 세션에 대해 도착한 경계 이벤트들에서 **가장 최근 하나**를 고른다.
 *
 * 열림과 닫힘은 같은 창의 두 사건이고, 화면이 답해야 하는 것은 「지금 어떤가」
 * 하나다. 둘 다 그리면 한 창이 두 줄이 되어 두 번 일어난 것처럼 읽힌다.
 *
 * 시각은 `ts` 가 아니라 **경계 그 자체**로 정렬한다. 닫힘 봉투의 `ts` 는 닫힌
 * 시각이고 열림 봉투의 `ts` 는 열린 시각이라 이미 단조롭지만, 같은 밀리초에
 * 두 봉투가 도착하는 경우(즉시 lapse)는 **닫힘이 이긴다** — 나중 사실이 화면에
 * 서야 한다.
 */
export function latestControlNotice(
  frames: readonly WorkSessionControlFrame[],
  sessionId: string
): ControlWindowNotice | null {
  let latest: ControlWindowNotice | null = null;
  for (const frame of frames) {
    const notice = controlWindowNotice(frame, sessionId);
    if (notice === null) continue;
    if (latest === null) {
      latest = notice;
      continue;
    }
    const at = notice.endedAtMs ?? notice.startedAtMs;
    const held = latest.endedAtMs ?? latest.startedAtMs;
    if (at > held || (at === held && notice.state === "closed")) {
      latest = notice;
    }
  }
  return latest;
}
