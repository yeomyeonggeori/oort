import {
  ApiError,
  type AgentLiveness,
  type AgentLivenessState,
  type MembershipRole,
} from "../../lib/api";
import { elapsedSpan } from "./runPhase";

// =============================================================================
// liveness: 서버가 파생한 「지금 살아 있는가」(ADR-0200 D4)를 사람의 낱말로 옮기는
// 순수 함수들. 멤버 목록·에이전트 헤더·사이드바 행·작업 패널·폰이 같은 말을 하도록
// core에 둔다.
//
// 이 라벨은 **「연결됨」과 다른 사실**이다. 연결 상태(`status: active`)는 토큰이
// 한 번 증명됐다는 뜻이고 시간이 지나도 그대로다. 성재: 「토큰이 연결돼 있다고
// 연결이 아니라, 지금 살아있는지가 궁금한거야」. 서버는 수령·읽기·run 이벤트·ping이라는
// 자기 사실로 상태를 정하고, 이 모듈은 그 판정을 옮길 뿐 다시 판정하지 않는다.
//
// 「응답함 n분 전」의 n은 서버가 알려 준 `lastSignalAtMs`에서 온다. 클라이언트가
// 신호를 받은 때가 아니다(받은 때를 쓰면 라벨을 연 순간이 「방금」이 된다).
// =============================================================================

export type LivenessTone = "ok" | "neutral" | "warn";

export interface LivenessView {
  state: AgentLivenessState;
  /** 한 줄 라벨. 멤버 목록·헤더·패널이 그대로 쓴다. */
  text: string;
  /** 사이드바처럼 폭이 좁은 자리의 한두 낱말. */
  short: string;
  tone: LivenessTone;
  /** 라벨이 무엇을 뜻하는지 한 문장(툴팁·접근성 설명). */
  meaning: string;
}

const MEANING: Readonly<Record<AgentLivenessState, string>> = {
  responsive: "최근에 일을 확인했거나 가져갔다고 서버가 알려 줬어요.",
  alive_idle:
    "살아 있다는 신호는 보내지만 일은 가져가지 않고 있어요. 지금 맡길 일이 없을 수 있어요.",
  work_waiting:
    "가져갈 수 있는 일이 오래 기다리는데 아직 아무도 가져가지 않았어요.",
  woken_not_collected:
    "깨우는 신호는 닿았는데 일을 가져가지 않았어요. 다시 깨울 수 있어요.",
  quiet: "한동안 새 신호가 없어요. 돌아올 수 있어요.",
  unresponsive: "오랫동안 아무 신호가 없어요.",
  error: "서버가 에이전트의 호출을 거절했어요.",
  inactive: "이 에이전트의 연결이 꺼져 있어요.",
};

/**
 * 한 상태의 라벨.
 *
 *   responsive           응답함 n분 전
 *   alive_idle           살아 있음 · 대기 중
 *   work_waiting         일이 기다리는 중
 *   woken_not_collected  깨웠지만 아직 안 가져감
 *   unresponsive         응답 없음 n분 (신호가 아예 없으면 숫자 없이)
 *   quiet                조용함 · 마지막 응답 n분 전
 *   error                호출이 거절됨
 *   inactive             연결이 꺼져 있어요
 */
export function livenessView(
  liveness: Pick<AgentLiveness, "state" | "lastSignalAtMs">,
  nowMs: number
): LivenessView {
  const span =
    liveness.lastSignalAtMs === undefined
      ? undefined
      : elapsedSpan(liveness.lastSignalAtMs, nowMs);
  const base = (
    text: string,
    short: string,
    tone: LivenessTone
  ): LivenessView => ({
    state: liveness.state,
    text,
    short,
    tone,
    meaning: MEANING[liveness.state],
  });
  switch (liveness.state) {
    case "responsive":
      return base(
        span === undefined ? "방금 응답함" : `응답함 ${span} 전`,
        "응답함",
        "ok"
      );
    case "alive_idle":
      return base("살아 있음 · 대기 중", "살아 있음", "neutral");
    case "work_waiting":
      return base("일이 기다리는 중", "일이 밀림", "warn");
    case "woken_not_collected":
      return base("깨웠지만 아직 안 가져감", "안 가져감", "warn");
    case "unresponsive":
      return base(
        span === undefined ? "응답 없음" : `응답 없음 ${span}`,
        "응답 없음",
        "warn"
      );
    case "quiet":
      return base(
        span === undefined ? "조용함" : `조용함 · 마지막 응답 ${span} 전`,
        "조용함",
        "neutral"
      );
    case "error":
      return base("호출이 거절됨", "거절됨", "warn");
    case "inactive":
      return base("연결이 꺼져 있어요", "꺼짐", "neutral");
  }
}

/**
 * 이 사람이 생존 라벨의 경고에 **할 수 있는 일이 있는가**: 다시 깨울 수 있는 owner/admin 이다
 * (`WakeAgentButton`). 할 수 있는 일이 없는 경고는 소음이다(design-review U3 M-3).
 */
export function mayActOnLiveness(role: MembershipRole | undefined): boolean {
  return role === "owner" || role === "admin";
}

/**
 * 보는 사람에게 맞춘 톤. 경고색(`warn`)은 **할 수 있는 일이 있는 상태**의 색이라 그 사람에게만 경고로
 * 읽히고, 그 밖의 멤버에게는 같은 사실이 중립이다. 웹·폰의 라벨과 DM 행의 상태 점이 이 한 규칙을 읽는다
 * (#3964: 규칙이 라벨마다 한 벌씩 있던 자리를 한 곳으로).
 */
export function livenessToneFor(
  view: Pick<LivenessView, "tone">,
  mayAct: boolean
): LivenessTone {
  return view.tone === "warn" && !mayAct ? "neutral" : view.tone;
}

/** 접근성 이름: 라벨과 뜻을 한 문장으로. */
export function livenessAccessibleName(view: LivenessView): string {
  return `${view.text}. ${view.meaning}`;
}

/** 관리자 상세에만 오는 닫힌 거절 코드 → 문장. 모르는 코드는 문장을 만들지 않는다. */
const TOOL_ERROR_TEXT: Record<string, string> = {
  unavailable: "에이전트 포트가 일시적으로 쓸 수 없다고 답했어요",
  not_authorized: "에이전트 자격증명이 권한이 없다고 답했어요",
};

export function toolErrorText(code: string | undefined): string | undefined {
  return code === undefined ? undefined : TOOL_ERROR_TEXT[code];
}

// ---- 다시 깨우기 -------------------------------------------------------------

export const WAKE_LABEL = "다시 깨우기";

/**
 * 깨울 필요가 있는가: 켜진 연결이면 서버가 거절하지 않는다. 이미 응답 중인 에이전트에게는
 * 권하지 않는다(깨우는 한 번 한 번이 소유자의 벤더 사용량을 쓴다, ADR-0200 D4).
 */
export function canOfferWake(state: AgentLivenessState): boolean {
  return state !== "responsive" && state !== "inactive";
}

/** 한 번 깨운 뒤 다음에 깨울 수 있을 때까지. 서버가 준 때를 쓰고 우리가 세지 않는다. */
export function wakeCooldownLabel(
  nextAllowedAtMs: number,
  nowMs: number
): string | undefined {
  const remaining = Math.ceil((nextAllowedAtMs - nowMs) / 1000);
  if (remaining <= 0) return undefined;
  if (remaining <= 60) return `${remaining}초 뒤에 다시 깨울 수 있어요`;
  const minutes = Math.ceil(remaining / 60);
  return `${minutes}분 뒤에 다시 깨울 수 있어요`;
}

export const WAKE_REQUESTED_SENTENCE =
  "깨우는 신호를 보냈어요. 에이전트가 일을 가져가는지는 잠시 뒤 라벨이 알려 줘요.";

/**
 * 429의 이유. 서버는 두 한도(연결당 60초 쿨다운 · 시간당 5회)를 같은 429로 답하고 기다릴
 * 초만 준다. 60초를 넘게 기다려야 하면 쿨다운이 아니라 시간당 한도다.
 */
export function wakeLimitedText(retryAfterSeconds: number): string {
  return retryAfterSeconds > 60
    ? "시간당 깨우기 한도에 닿았어요."
    : "방금 깨웠어요.";
}

/** 깨우기 거절의 문장. 문장은 서버가 아니라 여기서 쓴다(서버는 코드만 준다). */
export function wakeFailureText(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) {
      // 서버는 「도어벨이 꺼져 있다」와 「깨울 권한이 없다」를 같은 404로 답한다(모르는
      // 연결을 탐침하지 못하게). 그래서 두 가능성을 모두 말하고 하나를 단정하지 않는다.
      return "깨우지 못했어요. 이 서버가 도어벨을 쓰지 않거나, 깨울 권한이 없을 수 있어요.";
    }
    if (error.status === 409) {
      return "깨울 수 없어요. 연결이 꺼져 있거나 도어벨이 등록되어 있지 않아요.";
    }
    if (error.status === 403) {
      return "이 에이전트를 깨울 권한이 없어요.";
    }
  }
  return "다시 깨우지 못했어요. 잠시 뒤에 다시 해 주세요.";
}
