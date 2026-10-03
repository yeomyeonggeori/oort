import { ApiError } from "../../lib/api";
import { attachParticle, hasFinalConsonant } from "../../lib/koreanParticle";
import type { LocalHarnessId } from "../hostedAgents/detect";
import { HARNESS_LABEL, SUBSCRIPTION_HARNESS_WIRE } from "./aiConnect";

// =============================================================================
// 로그인 → 에이전트로 만들기, 한 모달 (#3389 AIH-5, ADR-0190 D3-h, ADR-0193
// D15-D17, 시안 claudedocs/ai-hub-2026-10/panel-flow).
//
// 「Claude Code로 로그인」 모달(#2816)이 끝나면 같은 창이 물어요: 「이 맥의 Claude
// Code를 @이름으로 부를 수 있게 할까요?」 → [@이름 만들기] → 서버에 `owner_only`
// 에이전트를 등록(D15) → 앱이 공식 CLI의 `mcp add-json`을 대신 실행(셸, 연결 값은
// argv·로그에 두지 않는다) → 끝.
//
// 이 파일은 화면이 그릴 것을 **결정**만 한다(순수 함수와 문장). 호출·셸·타이머는
// 웹의 `registerController`가 한다. 규율:
//
// - 질문 없이 만들지 않는다. 확인 단계는 건너뛸 수 없다(시험이 잠근다).
// - 서버가 말한 거절은 문장이 아니라 `error.code`로 가른다(D6·D15·D17).
// - 「멈춰 있어요」(Claude 기본 꺼짐, D17)와 「꺼져 있어요」(킬 스위치, D6)는 오류가
//   아니다. 로그인은 됐고 만들 수 없는 이유가 서버 쪽 결정이다. 빨강·경고 아이콘·
//   「실패」 어휘가 없고, 사람에게 남는 길(내 맥에서 직접 쓰기)만 말한다.
// - 로그인 정보는 oort에 저장하지 않는다는 말이 상시 보인다(ADR-0193 D2).
// =============================================================================

/** 서버가 이름 붙인 거절(ADR-0193 D15·D17). 문장이 아니라 코드다. */
export const CODE_SUBSCRIPTION_DISABLED = "subscription_agents_disabled";
export const CODE_CLAUDE_PAUSED = "claude_subscription_agent_paused";
export const CODE_AGENT_LIMIT = "subscription_agent_limit";
export const CODE_CLEANUP_PENDING = "subscription_agent_cleanup_pending";

/**
 * 등록이 거절된 까닭의 분류.
 *
 * - `paused`·`disabled`·`forbidden`: **차분한 상태**다(오류 모양이 아니다).
 * - `limit`·`cleanup`: 사람이 할 일이 있는 안내(오류 아님, 경고 톤 없음).
 * - `handle-taken`: 이름 칸으로 돌아가 인라인으로 말한다.
 * - `other`: 만들지 못했어요 + 다시 시도.
 */
export type RegisterRefusal =
  | "paused"
  | "disabled"
  | "forbidden"
  | "limit"
  | "cleanup"
  | "handle-taken"
  | "invalid-name"
  | "other";

export function classifyRegisterFailure(error: unknown): RegisterRefusal {
  if (!(error instanceof ApiError)) return "other";
  if (error.status === 403) return "forbidden";
  if (error.status === 400) return "invalid-name";
  if (error.status === 409) {
    switch (error.code) {
      case CODE_CLAUDE_PAUSED:
        return "paused";
      case CODE_SUBSCRIPTION_DISABLED:
        return "disabled";
      case CODE_AGENT_LIMIT:
        return "limit";
      case CODE_CLEANUP_PENDING:
        return "cleanup";
      // 코드 없는 409는 직접 정한 핸들이 이미 있다는 뜻이다(D15).
      case undefined:
        return "handle-taken";
      default:
        return "other";
    }
  }
  return "other";
}

/** 차분한 상태인가(빨강·경고 없이 그린다). */
export function isCalmRefusal(refusal: RegisterRefusal): boolean {
  return (
    refusal === "paused" ||
    refusal === "disabled" ||
    refusal === "forbidden" ||
    refusal === "limit" ||
    refusal === "cleanup"
  );
}

// ---- 이름 ----------------------------------------------------------------------

const HANDLE_RE = /^[a-z0-9_-]{2,32}$/;

/** 서버 `harness_name_suffix`와 같은 꼬리. */
const NAME_SUFFIX: Record<LocalHarnessId, string> = { claude: "claude", codex: "codex" };

/**
 * 칸에 미리 채울 이름. 서버 `default_name_candidates`의 첫 후보와 같은 규칙
 * (`<내 핸들>-claude`, 32자 안)이다. 겹치면 서버가 -2…를 붙이므로, 사람이 고치지
 * 않았다면 이 값을 보내지 않고 서버가 정한 이름을 응답에서 읽는다.
 */
export function defaultAgentHandle(harness: LocalHarnessId, memberHandle: string): string {
  const tail = `-${NAME_SUFFIX[harness]}`;
  const budget = Math.max(2, 32 - tail.length - 3);
  let head = memberHandle
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, budget);
  if (head.length < 2) head = "my";
  return `${head}${tail}`;
}

export function normalizeAgentHandle(raw: string): string {
  return raw.trim().replace(/^@+/, "").trim().toLowerCase();
}

/** 이름 칸의 문제(문장) 또는 null. 서버 `is_valid_handle`과 같다. */
export function agentHandleProblem(raw: string): string | null {
  const value = normalizeAgentHandle(raw);
  if (value === "") return "이름을 적어 주세요.";
  if (value.length < 2) return "두 글자 이상으로 적어 주세요.";
  if (value.length > 32) return "32자까지 쓸 수 있어요.";
  if (!HANDLE_RE.test(value)) return "영문 소문자, 숫자, - 와 _ 만 쓸 수 있어요.";
  return null;
}

/** 요청에 `handle`을 실을지: 사람이 기본값에서 바꿨을 때만. */
export function handleToSend(typed: string, defaultHandle: string): string | undefined {
  const value = normalizeAgentHandle(typed);
  return value === normalizeAgentHandle(defaultHandle) ? undefined : value;
}

/** 요청 본문. 기본 이름이면 `handle`·`displayName`이 없다(서버가 -2… 를 정한다). */
export function registerRequestBody(input: {
  harness: LocalHarnessId;
  deviceId: string;
  deviceLabel?: string | null;
  typedHandle: string;
  defaultHandle: string;
}): {
  harness: "claude_code" | "codex";
  deviceId: string;
  deviceLabel?: string;
  handle?: string;
} {
  const handle = handleToSend(input.typedHandle, input.defaultHandle);
  return {
    harness: SUBSCRIPTION_HARNESS_WIRE[input.harness],
    deviceId: input.deviceId,
    ...(input.deviceLabel ? { deviceLabel: input.deviceLabel } : {}),
    ...(handle !== undefined ? { handle } : {}),
  };
}

// ---- 조사 ----------------------------------------------------------------------

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;

/** 「으로/로」: 받침이 없거나 ㄹ 받침이면 로. */
export function attachInstrument(word: string): string {
  if (!hasFinalConsonant(word)) return `${word}로`;
  const last = word.trim().charCodeAt(word.trim().length - 1);
  const rieul =
    last >= HANGUL_FIRST && last <= HANGUL_LAST && (last - HANGUL_FIRST) % 28 === 8;
  return rieul ? `${word}로` : `${word}으로`;
}

// ---- 단계 ----------------------------------------------------------------------

/**
 * 로그인 뒤의 단계.
 *
 * - `confirm`: 이름을 묻는다. **여기서 사람이 누르기 전에는 아무것도 만들지 않는다.**
 * - `registering`: 서버 등록 → CLI 연결(Claude만).
 * - `done`: 만들었고 앱이 CLI 연결까지 했다(Claude).
 * - `existing`: 이미 이 맥의 에이전트가 있었다. 값을 새로 받지 않았다.
 * - `manual`: 만들었고, 연결은 사람이 한다(Codex의 두 칸, 또는 CLI 연결 실패 폴백).
 * - `calm`: 만들지 않았고 오류가 아니다(`RegisterRefusal`의 차분한 것들).
 * - `failed`: 만들지 못했다. 다시 시도.
 */
export type RegisterStep =
  | { step: "confirm"; problem?: string }
  | { step: "registering"; stage: "server" | "cli" }
  | { step: "done"; handle: string; displayName: string }
  | { step: "existing"; handle: string }
  | { step: "manual"; handle: string; why: ManualWhy }
  | { step: "calm"; refusal: RegisterRefusal }
  | { step: "failed" };

/** 수동 단계에 온 까닭. 문장이 다르다. */
export type ManualWhy = "codex" | "cli-failed" | "cli-missing" | "unsupported";

// ---- 문장 (해요체, 가운뎃점 구분, 줄표 없음) -----------------------------------

export function confirmTitle(harness: LocalHarnessId, handle: string): string {
  return `이 맥의 ${attachParticle(HARNESS_LABEL[harness], "object")} @${attachInstrument(handle)} 부를 수 있게 할까요?`;
}

export const CONFIRM_NAME_LABEL = "에이전트 이름";
export const CONFIRM_NAME_HINT = "채널에서 @이름으로 불러요. 영문 소문자, 숫자, - 와 _ 를 써요.";

export function confirmBullets(harness: LocalHarnessId): readonly string[] {
  return [
    "나만 부를 수 있어요. 다른 멤버가 부르면 안내 문구가 나가요.",
    `비용은 내 ${HARNESS_LABEL[harness]} 구독에서 나가요. 팀 키는 쓰지 않아요.`,
    "이 맥이 켜져 있고 oort가 열려 있을 때만 답해요.",
    "로그인 정보는 oort에 저장하지 않아요.",
  ];
}

export const CONFIRM_LATER_LABEL = "나중에";

export function confirmCreateLabel(handle: string): string {
  return `@${handle} 만들기`;
}

export function loggedInLine(harness: LocalHarnessId): string {
  return `${attachParticle(HARNESS_LABEL[harness], "subject")} 로그인됐어요.`;
}

export function registeringLine(handle: string): string {
  return `@${handle}${hasFinalConsonant(handle) ? "을" : "를"} 만들고 있어요.`;
}

export const REGISTERING_SERVER_STAGE = "에이전트 만들기";
export function registeringCliStage(harness: LocalHarnessId): string {
  return `${HARNESS_LABEL[harness]}에 연결 걸기`;
}

export function doneLine(handle: string): string {
  return `@${handle}${hasFinalConsonant(handle) ? "을" : "를"} 만들었어요.`;
}

export function doneDetail(harness: LocalHarnessId, handle: string): string {
  return `${attachParticle(HARNESS_LABEL[harness], "object")} 15분 안에 한 번 열면 연결돼요. 그 뒤 채널에서 @${attachInstrument(handle)} 불러 보세요. 15분이 지나면 여기서 다시 눌러 주세요.`;
}

export const DONE_AGENTS_LABEL = "에이전트 보기";
export const DONE_CLOSE_LABEL = "완료";

export function existingLine(handle: string): string {
  return `이미 @${handle}${particleSubject(handle)} 있어요.`;
}

export const EXISTING_DETAIL = "이 맥의 에이전트라서 새로 만들지 않았어요.";

function particleSubject(word: string): string {
  return hasFinalConsonant(word) ? "이" : "가";
}

// 수동 단계
export function manualLine(handle: string, why: ManualWhy): string {
  const made = `@${handle}${hasFinalConsonant(handle) ? "을" : "를"} 만들었어요.`;
  switch (why) {
    case "codex":
      return made;
    default:
      return `${made} 연결만 직접 해 주세요.`;
  }
}

export function manualDetail(harness: LocalHarnessId, why: ManualWhy): string {
  const cli = HARNESS_LABEL[harness];
  switch (why) {
    case "codex":
      return `${attachParticle(cli, "object")} 쓰려면 MCP 서버에 이 주소와 연결 값을 넣어 주세요. 연결 값은 지금 한 번만 보여요.`;
    case "cli-missing":
      return `이 맥에서 ${cli}를 찾지 못해 앱이 연결하지 못했어요. 아래 명령을 터미널에서 한 번 실행해 주세요.`;
    case "unsupported":
      return `이 환경에서는 앱이 연결을 걸 수 없어요. 아래 명령을 터미널에서 한 번 실행해 주세요.`;
    default:
      return `앱이 ${attachParticle(cli, "object")} 연결하지 못했어요. 아래 명령을 터미널에서 한 번 실행해 주세요. 연결 값은 지금 한 번만 보여요.`;
  }
}

/** 접힌 「직접 하려면」 링크. */
export const MANUAL_DISCLOSURE_LABEL = "직접 하려면";
export const MANUAL_DISCLOSURE_HIDE_LABEL = "접기";

// 차분한 상태 (오류 어휘 없음)
export const CALM_BADGE: Record<"paused" | "disabled", string> = {
  paused: "회색 · 문의 중",
  disabled: "꺼짐 · 서버 설정",
};

export function calmLine(refusal: RegisterRefusal, harness: LocalHarnessId): string {
  switch (refusal) {
    case "paused":
      return `이 서버에서는 ${HARNESS_LABEL[harness]} 구독으로 쓰는 에이전트가 잠시 멈춰 있어요.`;
    case "disabled":
      return "이 서버에서는 구독으로 쓰는 에이전트가 꺼져 있어요.";
    case "forbidden":
      return "에이전트로 만드는 건 워크스페이스 관리자가 해요.";
    case "limit":
      return `${HARNESS_LABEL[harness]} 구독으로 쓰는 에이전트가 이미 다섯 개예요.`;
    default:
      return "이 에이전트는 연결을 마저 끊은 뒤에 다시 만들 수 있어요.";
  }
}

export function calmDetail(refusal: RegisterRefusal, harness: LocalHarnessId): string {
  const cli = HARNESS_LABEL[harness];
  switch (refusal) {
    case "paused":
      return `서비스 제공자에게 사용 범위를 문의하는 동안 서버 운영자가 닫아 둔 기능이에요. 로그인은 그대로 되어 있고, 내 맥의 ${cli}는 터미널에서 직접 쓸 수 있어요.`;
    case "disabled":
      return `서버 운영자가 켜면 쓸 수 있어요. 로그인은 그대로 되어 있고, 내 맥의 ${cli}는 터미널에서 직접 쓸 수 있어요.`;
    case "forbidden":
      return `로그인은 됐어요. 내 맥의 ${cli}는 터미널에서 직접 쓸 수 있어요. 에이전트로 부르려면 관리자에게 부탁해 주세요.`;
    case "limit":
      return "쓰지 않는 에이전트를 먼저 정리해 주세요.";
    default:
      return "에이전트 화면에서 끊기를 마무리해 주세요.";
  }
}

export const CALM_CLOSE_LABEL = "완료";

// 실패 (오류 모양은 여기뿐이다)
export function failedLine(reason: string): string {
  return `만들지 못했어요: ${reason}`;
}

export const FAILED_REASON_DEFAULT = "서버에 닿지 못했어요";
export const FAILED_REASON_NAME = "이름을 쓸 수 없어요";
export const FAILED_RETRY_LABEL = "다시 시도";
export const FAILED_CLOSE_LABEL = "닫기";

export const HANDLE_TAKEN_PROBLEM = "이미 쓰는 이름이에요. 다른 이름을 적어 주세요.";
export const NAME_INVALID_PROBLEM = "이 이름은 쓸 수 없어요. 영문 소문자, 숫자, - 와 _ 로 적어 주세요.";

// 시안의 상시 줄
export const REGISTER_NO_STORE_NOTE = "로그인 정보는 oort에 저장하지 않아요.";

/** 선택 단계 둘 이상일 때 스크린리더 안내. */
export function registerLiveMessage(step: RegisterStep, harness: LocalHarnessId, handle: string): string {
  switch (step.step) {
    case "confirm":
      return confirmTitle(harness, handle);
    case "registering":
      return registeringLine(handle);
    case "done":
      return doneLine(step.handle);
    case "existing":
      return existingLine(step.handle);
    case "manual":
      return manualLine(step.handle, step.why);
    case "calm":
      return calmLine(step.refusal, harness);
    default:
      return failedLine(FAILED_REASON_DEFAULT);
  }
}

// ---- 첫 창 (에이전트 화면·설정의 「내 구독으로 에이전트 만들기」) ---------------------

export const START_TITLE = "내 구독으로 에이전트 만들기";
export const START_DETAIL =
  "이 맥에서 로그인한 Claude Code나 Codex를 채널에서 @로 부를 수 있게 해요. 나만 부를 수 있어요.";
export const START_CREATE_LABEL = "에이전트로 만들기";
export const START_INSTALL_LABEL = "설치 안내";
export const START_CLOSE_LABEL = "닫기";
