import type { MessageRef, PlainMessageKey } from "../../i18n/keys";
import type { LocalHarnessId, LocalHarnessProbe } from "../hostedAgents/detect";
import { HARNESS_LABEL } from "./aiConnect";

// =============================================================================
// 로그인 모달 (#2816 OB2-10, ADR-0190 D3-f, ADR-0193 D2 개정 2026-09-27).
//
// [Claude Code로 로그인] → 모달 → 앱이 숨은 PTY에서 공식 CLI의 로그인 명령을
// 수정 없이 돌린다 → CLI가 시스템 브라우저를 열고 자기 localhost 콜백으로 끝난다
// → 셸의 상태 명령(#2813)이 로그인됨이면 「연결됐어요」.
//
// 이 파일은 화면이 그릴 것을 **결정**만 한다(순수 함수와 문장). PTY·타이머·셸
// 호출은 웹이 한다. 규율:
//
// - 버튼 이름은 로그인하는 주체(공식 CLI)를 말한다: 「Claude Code로 로그인」
//   「Codex로 로그인」. 「Claude로 로그인」「ChatGPT로 로그인」처럼 oort가
//   claude.ai·ChatGPT 로그인을 주는 것으로 읽히는 이름은 없다(ADR-0193 D2 개정).
//   평문만: 로고·브랜드 색·「Sign in with …」 모양이 없다.
// - 모달 문장은 사실만 적는다: 공식 CLI가 브라우저에서 로그인을 처리하고 oort는
//   로그인 정보를 보지 않는다. 제휴·보증으로 읽히는 말이 없다.
// - 판정은 CLI가 스스로 알린 상태 명령의 값뿐이다. 터미널 출력은 읽지 않는다.
// =============================================================================

/** 셸 `LOGIN_COMMANDS`의 방법. 브라우저 콜백, 또는 기기 코드(Codex만). */
export type HarnessLoginMethod = "browser" | "device";

/** 하네스마다 쓸 수 있는 방법. 셸 표(ADR-0190 D3-f A1·A3·A4)와 같다. */
export const HARNESS_LOGIN_METHODS: Record<LocalHarnessId, readonly HarnessLoginMethod[]> = {
  claude: ["browser"],
  codex: ["browser", "device"],
};

/**
 * 로그인 버튼. 로그인하는 것이 공식 CLI라는 것이 이름에 드러난다(ADR-0193 D2
 * 개정의 두 이름 그대로).
 */
export const LOGIN_ACTION_KEYS = {
  claude: "onboarding.harnessLogin.actionClaude",
  codex: "onboarding.harnessLogin.actionCodex",
} as const satisfies Record<LocalHarnessId, PlainMessageKey>;

export function loginActionKey(harness: LocalHarnessId): PlainMessageKey {
  return LOGIN_ACTION_KEYS[harness];
}

/** 브라우저에서 돌아오지 않으면 PTY를 끝내고 실패로 닫는다. */
export const HARNESS_LOGIN_TIMEOUT_MS = 5 * 60_000;
/** 「연결됐어요」를 보여 주고 모달이 저절로 닫히기까지. */
export const HARNESS_LOGIN_CONNECTED_CLOSE_MS = 1_600;

export type HarnessLoginFailure =
  /** 시간 제한이 지났다. 앱이 PTY를 끝냈다. */
  | "timeout"
  /** CLI가 끝났고 상태 명령이 로그인됨이 아니다. */
  | "not-logged-in"
  /** 이 앱에서 로그인 칸을 열지 못했다(PTY 없음·셸 거부). Phase 1로 물러난다. */
  | "spawn";

export type HarnessLoginPhase =
  | { phase: "waiting" }
  | { phase: "checking" }
  | { phase: "connected" }
  | { phase: "failed"; reason: HarnessLoginFailure };

/**
 * CLI가 끝난 뒤의 판정. 상태 명령(#2813)이 로그인됨이면 연결됨이다. 종료 코드는
 * 판정에 쓰지 않는다: 이미 로그인된 CLI가 0이 아닌 값으로 끝나도, 0으로 끝났는데
 * 로그인이 안 됐어도 사실은 상태 명령이 말한다(ADR-0190 D3-f 「완료 판정은 D3-a
 * 상태 명령이다」).
 */
export function harnessLoginVerdict(
  harness: LocalHarnessId,
  probes: readonly LocalHarnessProbe[] | null
): HarnessLoginPhase {
  const probe = probes?.find((row) => row.id === harness);
  return probe?.installed && probe.auth === "logged_in"
    ? { phase: "connected" }
    : { phase: "failed", reason: "not-logged-in" };
}

// ---- 문장 --------------------------------------------------------------------
// 코메토 말풍선은 해요체, 폼 라벨·안내는 합니다체(ADR-0193 D11).

// 문구는 `i18n/catalogs/<언어>/onboarding.json`의 `onboarding.harnessLogin.*`에 있다. 화면이 그릴 때 지금 언어로 푼다.
// 한국어 틀의 「{cli}가」·「{cli}를」은 닫힌 두 이름(Claude Code · Codex)에서 받침과 관계없이 같은 조사가 나오는 자리라 고정이다
// (ADR-0213 §4: 이름이 바뀌면 조사가 틀어지므로, 하네스를 더하는 사람이 이 틀을 다시 본다).

/** 모달 제목(스크린리더 이름). 버튼과 같은 말이다. */
export function loginDialogTitleKey(harness: LocalHarnessId): PlainMessageKey {
  return loginActionKey(harness);
}

export function loginWaitingLineKey(method: HarnessLoginMethod): PlainMessageKey {
  return method === "device"
    ? "onboarding.harnessLogin.waitingDevice"
    : "onboarding.harnessLogin.waitingBrowser";
}

/** 기다림의 사실 문장: 누가 로그인을 처리하고 oort는 무엇을 보지 않는가. */
export function loginWaitingDetail(
  harness: LocalHarnessId
): MessageRef<"onboarding.harnessLogin.waitingDetail"> {
  return { key: "onboarding.harnessLogin.waitingDetail", values: { cli: HARNESS_LABEL[harness] } };
}

export const LOGIN_CHECKING_KEY = "onboarding.harnessLogin.checking" satisfies PlainMessageKey;

export const LOGIN_CONNECTED_KEY = "onboarding.harnessLogin.connected" satisfies PlainMessageKey;
export function loginConnectedDetail(
  harness: LocalHarnessId
): MessageRef<"onboarding.harnessLogin.connectedDetail"> {
  return { key: "onboarding.harnessLogin.connectedDetail", values: { cli: HARNESS_LABEL[harness] } };
}

export function loginFailedLineKey(reason: HarnessLoginFailure): PlainMessageKey {
  switch (reason) {
    case "timeout":
      return "onboarding.harnessLogin.failedTimeout";
    case "spawn":
      return "onboarding.harnessLogin.failedSpawn";
    default:
      return "onboarding.harnessLogin.failedDefault";
  }
}

export function loginFailedDetail(
  harness: LocalHarnessId,
  reason: HarnessLoginFailure
): MessageRef<
  | "onboarding.harnessLogin.timeoutDetail"
  | "onboarding.harnessLogin.spawnDetail"
  | "onboarding.harnessLogin.notLoggedInDetail"
> {
  switch (reason) {
    case "timeout":
      return { key: "onboarding.harnessLogin.timeoutDetail" };
    case "spawn":
      return { key: "onboarding.harnessLogin.spawnDetail" };
    default:
      return {
        key: "onboarding.harnessLogin.notLoggedInDetail",
        values: { cli: HARNESS_LABEL[harness] },
      };
  }
}

// 취소 · 다시 시도 · 닫기(대화 상자를 닫는 쪽)는 공용 낱말이다.
export const LOGIN_CANCEL_KEY = "common.action.cancel" satisfies PlainMessageKey;
/** 「내 도구」 카드에서 연 모달: 창만 닫고 로그인은 카드에서 계속된다. */
export const LOGIN_DETACH_KEY = "onboarding.harnessLogin.detach" satisfies PlainMessageKey;
export const LOGIN_RETRY_KEY = "common.action.retry" satisfies PlainMessageKey;
export const LOGIN_CLOSE_KEY = "common.action.close" satisfies PlainMessageKey;
export const LOGIN_DONE_KEY = "onboarding.harnessLogin.done" satisfies PlainMessageKey;
/** Codex의 브라우저 콜백이 안 될 때의 대안(ADR-0190 D3-f A4). */
export const LOGIN_DEVICE_KEY = "onboarding.harnessLogin.deviceCode" satisfies PlainMessageKey;

/** 접힘 링크. 「터미널에서 로그인」은 이 링크로 남는다(ADR-0193 D2 개정). */
export const LOGIN_TERMINAL_SHOW_KEY = "onboarding.harnessLogin.terminalShow" satisfies PlainMessageKey;
export const LOGIN_TERMINAL_HIDE_KEY = "onboarding.harnessLogin.terminalHide" satisfies PlainMessageKey;

/** 코드 붙여 넣기 폴백: CLI가 콜백 대신 코드를 요구할 때. */
export const LOGIN_CODE_TOGGLE_KEY = "onboarding.harnessLogin.codeToggle" satisfies PlainMessageKey;
export const LOGIN_CODE_LABEL_KEY = "onboarding.harnessLogin.codeLabel" satisfies PlainMessageKey;
export const LOGIN_CODE_HINT_KEY = "onboarding.harnessLogin.codeHint" satisfies PlainMessageKey;
export const LOGIN_CODE_SUBMIT_KEY = "onboarding.harnessLogin.codeSubmit" satisfies PlainMessageKey;
export const LOGIN_CODE_SENT_KEY = "onboarding.harnessLogin.codeSent" satisfies PlainMessageKey;

/** 코드 입력을 보여 줄 하네스. Codex의 브라우저 흐름은 코드를 묻지 않는다. */
export function loginAcceptsCode(harness: LocalHarnessId, method: HarnessLoginMethod): boolean {
  return harness === "claude" && method === "browser";
}

/** 로그인 필요 줄의 한 줄(버튼 옆). */
export const LOGIN_ROW_HINT_KEY = "onboarding.harnessLogin.rowHint" satisfies PlainMessageKey;
