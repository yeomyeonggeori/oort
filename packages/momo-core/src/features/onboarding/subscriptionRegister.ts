import { ApiError } from "../../lib/api";
import type { MessageKey } from "../../i18n/generated/messages";
import type { LocaleService } from "../../i18n/context";
import type { MessageRef, PlainMessageKey } from "../../i18n/keys";
import { hasFinalConsonant } from "../../lib/koreanParticle";
import type { LocalHarnessId } from "../hostedAgents/detect";
import { CLAUDE_PAUSED_ERROR_CODE, HARNESS_LABEL, SUBSCRIPTION_HARNESS_WIRE } from "./aiConnect";

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
export const CODE_CLAUDE_PAUSED = CLAUDE_PAUSED_ERROR_CODE;
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

/** 이름 칸의 문제(문장의 키) 또는 null. 서버 `is_valid_handle`과 같다. */
export function agentHandleProblem(raw: string): PlainMessageKey | null {
  const value = normalizeAgentHandle(raw);
  if (value === "") return "onboarding.subscriptionRegisterName.required";
  if (value.length < 2) return "onboarding.subscriptionRegisterName.tooShort";
  if (value.length > 32) return "onboarding.subscriptionRegisterName.tooLong";
  if (!HANDLE_RE.test(value)) return "onboarding.subscriptionRegisterName.charset";
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

/**
 * 한국어 틀의 조사(이/가 · 을/를)를 고르는 값. 고르는 것은 틀의 `select`이고, 받침 판정은 기존 조사 함수
 * (`hasFinalConsonant`)가 한다(영어 틀은 같은 인자를 쓰지 않는다).
 */
function finalForm(word: string): "final" | "other" {
  return hasFinalConsonant(word) ? "final" : "other";
}

/** 「으로/로」를 고르는 값: 받침이 없거나 ㄹ 받침이면 `other`(로), 아니면 `euro`(으로). */
export function instrumentForm(word: string): "euro" | "other" {
  if (!hasFinalConsonant(word)) return "other";
  const last = word.trim().charCodeAt(word.trim().length - 1);
  const rieul =
    last >= HANGUL_FIRST && last <= HANGUL_LAST && (last - HANGUL_FIRST) % 28 === 8;
  return rieul ? "other" : "euro";
}

/** 이 파일의 문장 하나: 키와 값. 화면이 그릴 때 `formatMessage(message.key, message.values as never)`로 푼다. */
export type RegisterMessage = MessageRef<
  Extract<MessageKey, `onboarding.subscriptionRegister${string}`>
>;

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
  | { step: "confirm"; problem?: PlainMessageKey }
  | { step: "registering"; stage: "server" | "cli" }
  | { step: "done"; handle: string; displayName: string }
  | { step: "existing"; handle: string }
  | { step: "manual"; handle: string; why: ManualWhy }
  | { step: "calm"; refusal: RegisterRefusal }
  | { step: "failed" };

/** 수동 단계에 온 까닭. 문장이 다르다. */
export type ManualWhy = "codex" | "cli-failed" | "cli-missing" | "unsupported";

// ---- 문장 (해요체, 가운뎃점 구분, 줄표 없음) -----------------------------------

export function confirmTitle(harness: LocalHarnessId, handle: string): RegisterMessage {
  const cli = HARNESS_LABEL[harness];
  return {
    key: "onboarding.subscriptionRegisterConfirm.title",
    values: { cli, cliJosa: finalForm(cli), handle, josa: instrumentForm(handle) },
  };
}

export const CONFIRM_NAME_LABEL_KEY =
  "onboarding.subscriptionRegisterConfirm.nameLabel" satisfies PlainMessageKey;
export const CONFIRM_NAME_HINT_KEY =
  "onboarding.subscriptionRegisterConfirm.nameHint" satisfies PlainMessageKey;

export function confirmBullets(harness: LocalHarnessId): readonly RegisterMessage[] {
  return [
    { key: "onboarding.subscriptionRegisterConfirm.bulletOnlyMe" },
    {
      key: "onboarding.subscriptionRegisterConfirm.bulletCost",
      values: { cli: HARNESS_LABEL[harness] },
    },
    { key: "onboarding.subscriptionRegisterConfirm.bulletMacOn" },
    { key: "onboarding.subscriptionRegisterConfirm.noStore" },
  ];
}

export const CONFIRM_LATER_KEY =
  "onboarding.subscriptionRegisterConfirm.later" satisfies PlainMessageKey;

export function confirmCreateLabel(handle: string): RegisterMessage {
  return { key: "onboarding.subscriptionRegisterConfirm.create", values: { handle } };
}

export function loggedInLine(harness: LocalHarnessId): RegisterMessage {
  const cli = HARNESS_LABEL[harness];
  return {
    key: "onboarding.subscriptionRegisterProgress.loggedIn",
    values: { cli, josa: finalForm(cli) },
  };
}

export function registeringLine(handle: string): RegisterMessage {
  return {
    key: "onboarding.subscriptionRegisterProgress.registering",
    values: { handle, josa: finalForm(handle) },
  };
}

export const REGISTERING_SERVER_STAGE_KEY =
  "onboarding.subscriptionRegisterProgress.serverStage" satisfies PlainMessageKey;
export function registeringCliStage(harness: LocalHarnessId): RegisterMessage {
  return {
    key: "onboarding.subscriptionRegisterProgress.cliStage",
    values: { cli: HARNESS_LABEL[harness] },
  };
}

export function doneLine(handle: string): RegisterMessage {
  return {
    key: "onboarding.subscriptionRegisterDone.line",
    values: { handle, josa: finalForm(handle) },
  };
}

export function doneDetail(harness: LocalHarnessId, handle: string): RegisterMessage {
  const cli = HARNESS_LABEL[harness];
  return {
    key: "onboarding.subscriptionRegisterDone.detail",
    values: { cli, cliJosa: finalForm(cli), handle, josa: instrumentForm(handle) },
  };
}

export const DONE_AGENTS_KEY =
  "onboarding.subscriptionRegisterDone.agents" satisfies PlainMessageKey;
export const DONE_CLOSE_KEY = "onboarding.subscriptionRegisterDone.close" satisfies PlainMessageKey;

export function existingLine(handle: string): RegisterMessage {
  return {
    key: "onboarding.subscriptionRegisterDone.existing",
    values: { handle, josa: finalForm(handle) },
  };
}

export const EXISTING_DETAIL_KEY =
  "onboarding.subscriptionRegisterDone.existingDetail" satisfies PlainMessageKey;

// 수동 단계
export function manualLine(handle: string, why: ManualWhy): RegisterMessage {
  // 「만들었어요」는 코덱스일 때 그 한 문장이고, 그 밖에는 「연결만 직접 해 주세요」가 이어진다.
  return why === "codex"
    ? doneLine(handle)
    : {
        key: "onboarding.subscriptionRegisterManual.lineYourself",
        values: { handle, josa: finalForm(handle) },
      };
}

export function manualDetail(harness: LocalHarnessId, why: ManualWhy): RegisterMessage {
  const cli = HARNESS_LABEL[harness];
  switch (why) {
    case "codex":
      return {
        key: "onboarding.subscriptionRegisterManual.detailCodex",
        values: { cli, cliJosa: finalForm(cli) },
      };
    case "cli-missing":
      return { key: "onboarding.subscriptionRegisterManual.detailCliMissing", values: { cli } };
    case "unsupported":
      return { key: "onboarding.subscriptionRegisterManual.detailUnsupported" };
    default:
      return {
        key: "onboarding.subscriptionRegisterManual.detailCliFailed",
        values: { cli, cliJosa: finalForm(cli) },
      };
  }
}

/** 접힌 「직접 하려면」 링크. */
export const MANUAL_DISCLOSURE_KEY =
  "onboarding.subscriptionRegisterManual.disclosure" satisfies PlainMessageKey;
export const MANUAL_DISCLOSURE_HIDE_KEY =
  "onboarding.subscriptionRegisterManual.hide" satisfies PlainMessageKey;

// 차분한 상태 (오류 어휘 없음)
export const CALM_BADGE_KEYS = {
  paused: "onboarding.subscriptionRegisterCalm.badgePaused",
  disabled: "onboarding.subscriptionRegisterCalm.badgeDisabled",
} as const satisfies Record<"paused" | "disabled", PlainMessageKey>;

export function calmLine(refusal: RegisterRefusal, harness: LocalHarnessId): RegisterMessage {
  const cli = HARNESS_LABEL[harness];
  switch (refusal) {
    case "paused":
      return { key: "onboarding.subscriptionRegisterCalm.linePaused", values: { cli } };
    case "disabled":
      return { key: "onboarding.subscriptionRegisterCalm.lineDisabled" };
    case "forbidden":
      return { key: "onboarding.subscriptionRegisterCalm.lineForbidden" };
    case "limit":
      return { key: "onboarding.subscriptionRegisterCalm.lineLimit", values: { cli } };
    default:
      return { key: "onboarding.subscriptionRegisterCalm.lineCleanup" };
  }
}

export function calmDetail(refusal: RegisterRefusal, harness: LocalHarnessId): RegisterMessage {
  const cli = HARNESS_LABEL[harness];
  switch (refusal) {
    case "paused":
      return { key: "onboarding.subscriptionRegisterCalm.detailPaused", values: { cli } };
    case "disabled":
      return { key: "onboarding.subscriptionRegisterCalm.detailDisabled", values: { cli } };
    case "forbidden":
      return { key: "onboarding.subscriptionRegisterCalm.detailForbidden", values: { cli } };
    case "limit":
      return { key: "onboarding.subscriptionRegisterCalm.detailLimit" };
    default:
      return { key: "onboarding.subscriptionRegisterCalm.detailCleanup" };
  }
}

export const CALM_CLOSE_KEY = DONE_CLOSE_KEY;

// 실패 (오류 모양은 여기뿐이다). 사유는 문장이라 키로 들고, 이 문장이 풀어 넣는다.
export function failedLine(reason: string): RegisterMessage {
  return { key: "onboarding.subscriptionRegisterFailed.line", values: { reason } };
}

export const FAILED_REASON_DEFAULT_KEY =
  "onboarding.subscriptionRegisterFailed.reasonDefault" satisfies PlainMessageKey;
export const FAILED_REASON_NAME_KEY =
  "onboarding.subscriptionRegisterFailed.reasonName" satisfies PlainMessageKey;
/** 다시 시도: 공용 낱말. */
export const FAILED_RETRY_KEY = "common.action.retry" satisfies PlainMessageKey;
/** 닫기: 대화 상자를 닫는 단추라 공용 낱말이다. */
export const FAILED_CLOSE_KEY = "common.action.close" satisfies PlainMessageKey;

export const HANDLE_TAKEN_KEY =
  "onboarding.subscriptionRegisterName.taken" satisfies PlainMessageKey;
export const NAME_INVALID_KEY =
  "onboarding.subscriptionRegisterName.invalid" satisfies PlainMessageKey;

// 시안의 상시 줄
export const REGISTER_NO_STORE_KEY =
  "onboarding.subscriptionRegisterConfirm.noStore" satisfies PlainMessageKey;

/** 선택 단계 둘 이상일 때 스크린리더 안내. 사유를 글로 풀어 넣으므로 글을 푸는 함수를 받는다. */
export function registerLiveMessage(
  formatMessage: LocaleService["formatMessage"],
  step: RegisterStep,
  harness: LocalHarnessId,
  handle: string
): string {
  const say = (message: RegisterMessage): string =>
    formatMessage(message.key, message.values as never);
  switch (step.step) {
    case "confirm":
      return say(confirmTitle(harness, handle));
    case "registering":
      return say(registeringLine(handle));
    case "done":
      return say(doneLine(step.handle));
    case "existing":
      return say(existingLine(step.handle));
    case "manual":
      return say(manualLine(step.handle, step.why));
    case "calm":
      return say(calmLine(step.refusal, harness));
    default:
      return say(failedLine(formatMessage(FAILED_REASON_DEFAULT_KEY)));
  }
}

// ---- 첫 창 (에이전트 화면·설정의 「내 구독으로 에이전트 만들기」) ---------------------

export const START_TITLE_KEY = "onboarding.subscriptionRegisterStart.title" satisfies PlainMessageKey;
export const START_DETAIL_KEY =
  "onboarding.subscriptionRegisterStart.detail" satisfies PlainMessageKey;
export const START_CREATE_KEY =
  "onboarding.subscriptionRegisterStart.create" satisfies PlainMessageKey;
export const START_INSTALL_KEY =
  "onboarding.subscriptionRegisterStart.install" satisfies PlainMessageKey;
export const START_CLOSE_KEY = "common.action.close" satisfies PlainMessageKey;
