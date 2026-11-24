import type { MessageRef, PlainMessageKey } from "../../i18n/keys";
import { takesFinalForm } from "../../lib/koreanParticle";
import type {
  LocalHarnessId,
  LocalHarnessProbe,
} from "../hostedAgents/detect";
import type { SubscriptionHarnessWire } from "../hostedAgents/model";

// =============================================================================
// D4 「AI 연결」 Phase 1 (#2814 OB2-8, ADR-0193 D2·D3·D4·D6·D11).
//
// 「누구의 AI로 생각할까요?」 한 질문. 구독은 이 맥의 공식 CLI 로그인을 감지해
// **내 개인 에이전트**(owner_only)로, 팀 에이전트는 API 키로 붙인다.
//
// 이 파일은 화면이 그릴 것을 **결정**만 한다(순수 함수). 셸 호출·타이머·요청은
// 웹이 한다. 규율:
//
// - 「Claude로 로그인」「ChatGPT로 로그인」을 만들 문장이 여기 없다(D2). 로그인은
//   공식 CLI가 끝낸다. 로그인이 필요한 줄의 행동은 「Claude Code로 로그인」
//   「Codex로 로그인」 하나이고, 앱 모달이 숨은 PTY에서 공식 로그인 명령을 돌린다
//   (#2816, `harnessLogin.ts`). PTY가 없으면 CLI 명령 한 줄을 복사하고 OS 터미널을
//   여는 Phase 1로 물러난다.
// - 알약은 CLI가 **스스로 알린** 종료 코드의 번역이다(ADR-0190 D3-a). oort는
//   토큰·자격 파일을 읽지 않는다.
// - 구독 줄은 세 게이트가 모두 열릴 때만 선다: 데스크탑 셸 · 빌드 플래그 · 서버
//   킬 스위치(`subscriptionAgentsEnabled === true`). 서버 값 부재는 꺼짐이다.
// =============================================================================

/** 목록 한 줄의 id. 순서는 `aiConnectRows`가 정한다. */
export type AiConnectRowId = "claude" | "codex" | "api-key" | "grok";

export const SUBSCRIPTION_ROW_IDS = ["claude", "codex"] as const satisfies readonly LocalHarnessId[];

export function isSubscriptionRow(id: AiConnectRowId): id is LocalHarnessId {
  return id === "claude" || id === "codex";
}

/** 셸 하네스 id → 서버 enum(openapi `subscriptionHarness`). */
export const SUBSCRIPTION_HARNESS_WIRE: Record<LocalHarnessId, SubscriptionHarnessWire> = {
  claude: "claude_code",
  codex: "codex",
};

/** 사람이 읽는 CLI 이름. 제품 이름이라 언어마다 같다(번역하는 문장이 아니다). */
export const HARNESS_LABEL: Record<LocalHarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** 「{이름}의 Claude」의 뒷말. 에이전트 표시 이름과 합류 문장이 쓴다. */
export const HARNESS_BRAIN: Record<LocalHarnessId, string> = {
  claude: "Claude",
  codex: "Codex",
};

// ---- 구독 줄 노출 (세 게이트) -----------------------------------------------

/**
 * - `rows`: 구독 두 줄이 맨 위에 선다.
 * - `desktop-only`: 웹(데스크탑 아님). 구독 줄 대신 「데스크탑 앱에서…」 한 줄.
 * - `server-off`: 서버 킬 스위치가 꺼졌거나 서버가 그 값을 모른다. 구독 줄을
 *   숨기고 API 키 줄이 맨 위, 이유 한 줄.
 * - `hidden`: 빌드 플래그로 구독 표면을 걷은 빌드(`VITE_MOMO_SUBSCRIPTION_AGENTS=0`,
 *   기본은 켬 #2870). 아무 말도 하지 않는다: 이 빌드에 없는 기능을 광고하지 않는다.
 */
export type SubscriptionSurface = "rows" | "desktop-only" | "server-off" | "hidden";

export function subscriptionSurface(input: {
  isDesktop: boolean;
  buildFlag: boolean;
  /** `WorkspaceIdentity.subscriptionAgentsEnabled`. 아직 모르면 null. */
  serverEnabled: boolean | null;
}): SubscriptionSurface {
  if (!input.buildFlag) return "hidden";
  if (!input.isDesktop) return "desktop-only";
  if (input.serverEnabled !== true) return "server-off";
  return "rows";
}

/**
 * 줄 순서와 묶음 (ADR-0198 D1·D3·D7, #3697). 에이전트(그록봇·API 키 팀 에이전트)가 먼저,
 * 구독으로 로그인한 CLI는 「내 도구」 묶음으로 그 아래에 선다. 구독 줄이 에이전트
 * 1순위로 보이던 ADR-0193 D6의 순서를 ADR-0198이 대체했다.
 */
export function aiConnectRows(surface: SubscriptionSurface): readonly AiConnectRowId[] {
  if (surface === "rows") return ["api-key", "grok", "claude", "codex"];
  return ["api-key", "grok"];
}

export type AiConnectRowGroup = "agents" | "tools";

export function aiConnectRowGroup(id: AiConnectRowId): AiConnectRowGroup {
  return isSubscriptionRow(id) ? "tools" : "agents";
}

export const AI_CONNECT_GROUP_KEYS = {
  agents: "onboarding.aiConnectGroup.agents",
  tools: "onboarding.aiConnectGroup.tools",
} as const satisfies Record<AiConnectRowGroup, PlainMessageKey>;

// ---- 알약 ---------------------------------------------------------------------

/**
 * 구독 줄의 상태 알약 다섯(이슈 #2814 계약, Buzz SetupStep 문법).
 * 한 알약이 한 행동이다: 설치 필요 → 설치 안내 열기, 로그인 필요 → 줄 아래의
 * 로그인 버튼, 다시 확인 → 다시 묻기. 확인 중·준비됨은 행동이 없다.
 */
export type HarnessPill = "install" | "login" | "checking" | "ready" | "recheck";

export const HARNESS_PILL_KEYS = {
  install: "onboarding.aiConnectPill.install",
  login: "onboarding.aiConnectPill.login",
  checking: "onboarding.aiConnectPill.checking",
  ready: "onboarding.aiConnectPill.ready",
  recheck: "common.action.checkAgain",
} as const satisfies Record<HarnessPill, PlainMessageKey>;

/**
 * 감지 결과 + 로그인 대기 상태 → 알약.
 *
 * - 아직 한 번도 못 물었으면(`probe === null`) 확인 중.
 * - 미설치 → 설치 필요. 로그인됨 → 준비됨.
 * - Phase 1(터미널 복사) 뒤 2초 재확인이 도는 동안 → 확인 중.
 * - 그 창(120초)이 끝났으면 → 다시 확인.
 * - 설치돼 있는데 CLI가 답하지 않음(`unknown`: 시간 초과 등) → 다시 확인.
 */
export function harnessPill(
  probe: LocalHarnessProbe | null,
  watch: { polling: boolean; expired: boolean } = { polling: false, expired: false }
): HarnessPill {
  if (probe === null) return "checking";
  if (!probe.installed) return "install";
  if (probe.auth === "logged_in") return "ready";
  if (watch.polling) return "checking";
  if (probe.auth === "unknown") return "recheck";
  return watch.expired ? "recheck" : "login";
}

/** 줄을 고를 수 있는가. 구독 줄은 CLI가 로그인됨을 알린 때만. */
export function subscriptionRowSelectable(pill: HarnessPill): boolean {
  return pill === "ready";
}

// ---- 로그인 재확인 타이밍 (Buzz: SIGN IN 뒤 2초 폴링, 120초 뒤 CHECK AGAIN) ----

export const LOGIN_POLL_INTERVAL_MS = 2_000;
export const LOGIN_POLL_WINDOW_MS = 120_000;

/**
 * 직전 확인이 **끝난 뒤** 다음 확인까지의 대기. 창이 지났으면 `"stop"`.
 * 상태 명령은 최대 6초가 걸리므로 간격이 아니라 완료 기준으로 잰다(겹침 없음).
 */
export function loginPollNext(elapsedMs: number): number | "stop" {
  if (elapsedMs >= LOGIN_POLL_WINDOW_MS) return "stop";
  return LOGIN_POLL_INTERVAL_MS;
}

/**
 * PTY가 없을 때(Phase 1 폴백) 복사해 OS 터미널에서 칠 명령. 앱 모달이 숨은
 * PTY에서 돌리는 로그인 명령(셸 `LOGIN_COMMANDS`, ADR-0190 D3-f)과 같은 입구다.
 * oort가 로그인을 대신하지 않는다.
 */
export const HARNESS_LOGIN_COMMAND: Record<LocalHarnessId, string> = {
  claude: "claude auth login --claudeai",
  codex: "codex login",
};

/** 설치 필요 알약이 여는 공식 설치 안내(https만, 셸 `open_external_url`). */
export const HARNESS_INSTALL_URL: Record<LocalHarnessId, string> = {
  claude: "https://docs.anthropic.com/en/docs/claude-code/setup",
  codex: "https://developers.openai.com/codex/cli",
};

// ---- 연결 명령 ----------------------------------------------------------------

/** Agent Port MCP 서버 이름. 사람이 CLI의 MCP 목록에서 보는 이름이다. */
export const AGENT_PORT_MCP_NAME = "oort";

/**
 * 셸 명령에 그대로 넣어도 되는 값인가. 주소는 `agentPortEndpoint`가 이미
 * 거른 http(s) 주소, 연결 값은 서버가 준 토큰이다. 둘 중 하나라도 셸이 해석할
 * 글자를 담으면 명령을 짓지 않는다(추측한 이스케이프보다 짓지 않는 편이 낫다).
 */
const COMMAND_SAFE_URL = /^https?:\/\/[A-Za-z0-9.\-:[\]/_~%]+$/;
const COMMAND_SAFE_TOKEN = /^[A-Za-z0-9._~\-+/=]+$/;

export type SubscriptionConnectPlan =
  | { kind: "command"; command: string }
  | { kind: "fields"; endpoint: string; credential: string };

/**
 * 합류 ① 「연결 명령 한 줄」.
 *
 * - Claude Code: `claude mcp add --scope user --transport http oort <주소>
 *   --header "Authorization: Bearer <연결 값>"`. `--scope user`가 없으면 명령을
 *   친 폴더에만 붙는다(기본 `local`).
 * - Codex: `codex mcp add`에는 헤더 옵션이 없다(`--bearer-token-env-var`뿐,
 *   codex-cli 0.156 `--help`). 한 줄 명령을 지어내지 않고 주소·연결 값 두 칸을
 *   준다(runtime-unverified, PR 본문).
 *
 * 값이 셸에 안전하지 않으면 두 칸으로 물러난다.
 */
export function subscriptionConnectPlan(
  harness: LocalHarnessId,
  endpoint: string,
  credential: string
): SubscriptionConnectPlan {
  const safe = COMMAND_SAFE_URL.test(endpoint) && COMMAND_SAFE_TOKEN.test(credential);
  if (harness === "claude" && safe) {
    return {
      kind: "command",
      command: `claude mcp add --scope user --transport http ${AGENT_PORT_MCP_NAME} ${endpoint} --header "Authorization: Bearer ${credential}"`,
    };
  }
  return { kind: "fields", endpoint, credential };
}

// ---- 구독으로 쓰는 에이전트 정체성 -----------------------------------------------------

const HANDLE_MAX = 32;
const HANDLE_OK = /^[a-z0-9_-]+$/;

function handleBase(memberHandle: string, harness: LocalHarnessId): string {
  const suffix = `-${harness}`;
  const cleaned = memberHandle.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
  const head = cleaned.slice(0, HANDLE_MAX - suffix.length - 2);
  const base = head === "" ? harness : `${head}${suffix}`;
  return HANDLE_OK.test(base) && base.length >= 2 ? base : `my-${harness}`;
}

/**
 * 「{내 표시 이름}의 Claude」와 겹치지 않는 핸들. `taken`은 명부의 핸들(소문자)
 * 집합이다. 겹치면 `-2`부터 붙인다. 서버가 그래도 409(핸들)를 주면 호출부가
 * 그 핸들을 `taken`에 더해 다시 부른다.
 */
export function subscriptionAgentIdentity(
  harness: LocalHarnessId,
  member: { displayName: string; handle: string },
  taken: ReadonlySet<string>
): { displayName: string; handle: string } {
  const owner = member.displayName.trim() === "" ? member.handle : member.displayName.trim();
  const displayName = `${owner}의 ${HARNESS_BRAIN[harness]}`;
  const base = handleBase(member.handle, harness);
  if (!taken.has(base)) return { displayName, handle: base };
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base.slice(0, HANDLE_MAX - String(n).length - 1)}-${n}`;
    if (!taken.has(candidate)) return { displayName, handle: candidate };
  }
  return { displayName, handle: `${base.slice(0, HANDLE_MAX - 9)}-${Date.now() % 1e8}` };
}

/**
 * 합류 요청의 409는 셋이다(서버 `hosted_agent_connections.rs`): 킬 스위치가
 * 꺼짐, Claude 구독 에이전트가 멈춰 있음(기본 꺼짐, ADR-0193 D17), 핸들이 이미 있음.
 * 서버가 이름 붙인 거절은 **코드**(`error.code`)로 가른다: 문장은 바뀔 수 있다.
 * 코드 없는 409만 서버 영어 문장으로 분류한다(model.ts 규율 3). 문장은 화면에
 * 그리지 않는다.
 */
export type SubscriptionJoinRefusal =
  | "subscription-off"
  | "claude-paused"
  | "handle-taken"
  | "other";

/** 서버가 Claude 구독 에이전트를 닫아 둘 때의 `error.code`(ADR-0193 D17). */
export const CLAUDE_PAUSED_ERROR_CODE = "claude_subscription_agent_paused";

export function classifyJoinConflict(error: {
  message: string;
  code?: string | undefined;
}): SubscriptionJoinRefusal {
  if (error.code === CLAUDE_PAUSED_ERROR_CODE) return "claude-paused";
  if (error.code !== undefined) {
    // 이름 붙은 다른 거절은 핸들 충돌이 아니다. 모르는 코드는 다시 시도하지 않는다.
    return /subscription agents are disabled/i.test(error.message) ? "subscription-off" : "other";
  }
  if (/subscription agents are disabled/i.test(error.message)) return "subscription-off";
  if (/handle already exists/i.test(error.message)) return "handle-taken";
  return "other";
}

// ---- 코메토 문장 --------------------------------------------------------------

export const AI_CONNECT_QUESTION_KEY = "onboarding.aiConnectStage.question" satisfies PlainMessageKey;
export const AI_CONNECT_QUESTION_DETAIL_KEY =
  "onboarding.aiConnectStage.questionDetail" satisfies PlainMessageKey;
export const AI_CONNECT_PROBING_KEY = "onboarding.aiConnectStage.probing" satisfies PlainMessageKey;

const FOUND_LINE_KEYS = {
  claude: "onboarding.aiConnectStage.foundClaude",
  codex: "onboarding.aiConnectStage.foundCodex",
} as const satisfies Record<LocalHarnessId, PlainMessageKey>;

export function aiConnectFoundKey(harness: LocalHarnessId): PlainMessageKey {
  return FOUND_LINE_KEYS[harness];
}

export interface AiConnectRowCopy {
  titleKey: PlainMessageKey;
  detailKey: PlainMessageKey;
  /** 줄 머리의 글자 타일(시안 `.opt .lg`)의 키. */
  markKey: PlainMessageKey;
}

export const AI_CONNECT_ROW_COPY = {
  claude: {
    titleKey: "onboarding.aiConnectRow.claudeTitle",
    detailKey: "onboarding.aiConnectRow.cliDetail",
    markKey: "onboarding.aiConnectRow.claudeMark",
  },
  codex: {
    titleKey: "onboarding.aiConnectRow.codexTitle",
    detailKey: "onboarding.aiConnectRow.cliDetail",
    markKey: "onboarding.aiConnectRow.codexMark",
  },
  "api-key": {
    titleKey: "onboarding.aiConnectRow.apiKeyTitle",
    detailKey: "onboarding.aiConnectRow.apiKeyDetail",
    markKey: "onboarding.aiConnectRow.apiKeyMark",
  },
  grok: {
    titleKey: "onboarding.aiConnectRow.grokTitle",
    detailKey: "onboarding.aiConnectRow.grokDetail",
    markKey: "onboarding.aiConnectRow.grokMark",
  },
} as const satisfies Record<AiConnectRowId, AiConnectRowCopy>;

/** API 키 줄의 알약: 설정 화면으로 가는 줄이라는 표지. */
export const API_KEY_PILL_KEY = "onboarding.aiConnectStage.apiKeyPill" satisfies PlainMessageKey;
/** 그록봇이 이 맥에서 감지되지 않았을 때(데스크탑만). */
export const GROK_NOT_INSTALLED_PILL_KEY =
  "onboarding.aiConnectStage.grokNotInstalledPill" satisfies PlainMessageKey;

export const AI_CONNECT_BOUNDARY_NOTE_KEY =
  "onboarding.aiConnectStage.boundaryNote" satisfies PlainMessageKey;

export const AI_CONNECT_DESKTOP_ONLY_NOTE_KEY =
  "onboarding.aiConnectStage.desktopOnlyNote" satisfies PlainMessageKey;

export const AI_CONNECT_SERVER_OFF_NOTE_KEY =
  "onboarding.aiConnectStage.serverOffNote" satisfies PlainMessageKey;

export const COPY_ACTION_KEY = "onboarding.aiConnectCopy.copy" satisfies PlainMessageKey;
export const COPIED_KEY = "onboarding.aiConnectCopy.copied" satisfies PlainMessageKey;
export const OPEN_TERMINAL_KEY = "onboarding.aiConnectCopy.openTerminal" satisfies PlainMessageKey;

const LOGIN_ARIA_KEYS = {
  claude: "onboarding.aiConnectCopy.loginAriaClaude",
  codex: "onboarding.aiConnectCopy.loginAriaCodex",
} as const satisfies Record<LocalHarnessId, PlainMessageKey>;

export function loginCommandAriaKey(harness: LocalHarnessId): PlainMessageKey {
  return LOGIN_ARIA_KEYS[harness];
}

export const LOGIN_OPENED_STATUS_KEY =
  "onboarding.aiConnectCopy.loginOpenedStatus" satisfies PlainMessageKey;
export const TERMINAL_OPEN_FAILED_KEY =
  "onboarding.aiConnectCopy.terminalOpenFailed" satisfies PlainMessageKey;

export function primaryActionKey(id: AiConnectRowId | null): PlainMessageKey {
  switch (id) {
    case "claude":
      return "onboarding.aiConnectStage.primaryClaude";
    case "codex":
      return "onboarding.aiConnectStage.primaryCodex";
    case "api-key":
      return "onboarding.aiConnectStage.primaryApiKey";
    case "grok":
      return "onboarding.aiConnectStage.primaryGrok";
    default:
      return AI_CONNECT_CONTINUE_KEY;
  }
}

export const AI_CONNECT_SKIP_KEY = "onboarding.aiConnectStage.skip" satisfies PlainMessageKey;
export const AI_CONNECT_REENTRY_KEY = "onboarding.aiConnectStage.reentry" satisfies PlainMessageKey;
export const AI_CONNECT_SKIPPED_KEY =
  "onboarding.aiConnectStage.skippedLine" satisfies PlainMessageKey;

/** 관리자가 아닌 멤버(#3697): 연결 목록이 403이라 목록을 세우지 않고 요청 안내만 한다. */
export const AI_CONNECT_NON_ADMIN_LINE_KEY =
  "onboarding.aiConnectStage.nonAdminLine" satisfies PlainMessageKey;
export const AI_CONNECT_NON_ADMIN_DETAIL_KEY =
  "onboarding.aiConnectStage.nonAdminDetail" satisfies PlainMessageKey;
export const AI_CONNECT_CONTINUE_KEY = "onboarding.aiConnectStage.continue" satisfies PlainMessageKey;

// ---- 재진입 (#2870, RCA 1-b·1-c) -------------------------------------------
//
// AI과 에이전트 화면에서 같은 화면을 다시 연다. 온보딩의 [지금은
// 건너뛰기]는 재진입에서 [닫기]가 되고, 진행 점 자리에 [뒤로]가 선다.

export const AI_CONNECT_BACK_KEY = "onboarding.aiConnectStage.back" satisfies PlainMessageKey;
/** 화면을 닫는 단추라 공용 「닫기」다. */
export const AI_CONNECT_CLOSE_KEY = "common.action.close" satisfies PlainMessageKey;

/** AI 맨 위 블록의 제목·설명·행동. 해요체(ADR-0193 D11 구독 문구). */
export const SUBSCRIPTION_ENTRY_TITLE_KEY =
  "onboarding.aiConnectEntry.title" satisfies PlainMessageKey;
export const SUBSCRIPTION_ENTRY_DETAIL_KEY =
  "onboarding.aiConnectEntry.detail" satisfies PlainMessageKey;
export const SUBSCRIPTION_ENTRY_ACTION_KEY =
  "onboarding.aiConnectEntry.action" satisfies PlainMessageKey;

// ---- 합류 세 상태 (같은 화면) -------------------------------------------------

export type SubscriptionJoinPhase =
  | "creating"
  | "connect"
  | "waiting"
  | "cap"
  | "joined"
  | "error";

const JOIN_CONNECT_KEYS = {
  claude: "onboarding.aiConnectJoin.connectClaude",
  codex: "onboarding.aiConnectJoin.connectCodex",
} as const satisfies Record<LocalHarnessId, PlainMessageKey>;

export function joinConnectKey(harness: LocalHarnessId): PlainMessageKey {
  return JOIN_CONNECT_KEYS[harness];
}

const JOIN_CONNECT_DETAIL_KEYS = {
  claude: "onboarding.aiConnectJoin.connectDetailClaude",
  codex: "onboarding.aiConnectJoin.connectDetailCodex",
} as const satisfies Record<LocalHarnessId, PlainMessageKey>;

export function joinConnectDetailKey(harness: LocalHarnessId): PlainMessageKey {
  return JOIN_CONNECT_DETAIL_KEYS[harness];
}

/** ② 감지 대기. 기다리는 쪽은 CLI(Claude Code·Codex) 또는 그록봇이다. */
export type JoinWaitingSubject = LocalHarnessId | "grok";

const JOIN_WAITING_KEYS = {
  claude: "onboarding.aiConnectJoin.waitingClaude",
  codex: "onboarding.aiConnectJoin.waitingCodex",
  grok: "onboarding.aiConnectJoin.waitingGrok",
} as const satisfies Record<JoinWaitingSubject, PlainMessageKey>;

export function joinWaitingKey(subject: JoinWaitingSubject): PlainMessageKey {
  return JOIN_WAITING_KEYS[subject];
}

export const AI_CONNECT_LIST_ERROR_KEY = "onboarding.aiConnectList.error" satisfies PlainMessageKey;
export const AI_CONNECT_OFFLINE_KEY = "onboarding.aiConnectList.offline" satisfies PlainMessageKey;
export const GROK_LABEL_KEY = "onboarding.aiConnectHarness.grok" satisfies PlainMessageKey;
export const CONNECT_COMMAND_ARIA_KEY =
  "onboarding.aiConnectCopy.commandAria" satisfies PlainMessageKey;
export const CONNECT_HANDED_OFF_STATUS_KEY =
  "onboarding.aiConnectCopy.handedOffStatus" satisfies PlainMessageKey;

export const JOIN_CREATING_KEY = "onboarding.aiConnectJoin.creating" satisfies PlainMessageKey;
export const JOIN_CAP_KEY = "onboarding.aiConnectJoin.cap" satisfies PlainMessageKey;
export const JOIN_CAP_DETAIL_KEY = "onboarding.aiConnectJoin.capDetail" satisfies PlainMessageKey;
export const JOIN_ERROR_KEY = "onboarding.aiConnectJoin.error" satisfies PlainMessageKey;
export const JOIN_OFF_KEY = "onboarding.aiConnectJoin.off" satisfies PlainMessageKey;
/** Claude 줄만 닫혀 있을 때(ADR-0193 D17). 오류가 아니라 서버 쪽 결정이다. */
export const JOIN_CLAUDE_PAUSED_KEY =
  "onboarding.aiConnectJoin.claudePaused" satisfies PlainMessageKey;
/** 줄 알약(짧게: 좁은 폭에서 제목이 쪼개지지 않는다)과 줄 설명. 서버가 닫아 둔 줄은 고를 수 없다. */
export const CLAUDE_PAUSED_PILL_KEY =
  "onboarding.aiConnectJoin.claudePausedPill" satisfies PlainMessageKey;
export const CLAUDE_PAUSED_DETAIL_KEY =
  "onboarding.aiConnectJoin.claudePausedDetail" satisfies PlainMessageKey;
export const JOIN_RECHECK_KEY = "common.action.checkAgain" satisfies PlainMessageKey;
export const JOIN_RETRY_KEY = "common.action.retry" satisfies PlainMessageKey;
export const JOIN_BACK_KEY = "onboarding.aiConnectJoin.back" satisfies PlainMessageKey;

/**
 * 「{이름}이/가 들어왔어요」. 이름은 사람이 정한 글이라 받침에 따라 이/가가 갈린다: 고르는 것은 한국어 틀의
 * `josa`이고, 받침 판정은 호출부(여기)가 기존 조사 함수로 계산해 넘긴다(영어는 같은 인자를 쓰지 않는다).
 */
export function joinJoinedMessage(
  agentDisplayName: string
): MessageRef<"onboarding.aiConnectJoin.joined"> {
  return {
    key: "onboarding.aiConnectJoin.joined",
    values: { name: agentDisplayName, josa: takesFinalForm(agentDisplayName) ? "final" : "other" },
  };
}

export const JOIN_JOINED_DETAIL_KEY =
  "onboarding.aiConnectJoin.joinedDetail" satisfies PlainMessageKey;

// ---- 개인 에이전트 켜기 (ADR-0198 증보 1 D7·T3, #3713) ------------------------------
//
// 「내 도구」 줄의 주 행동은 호스티드 구독 에이전트 생성(Agent Port)이 아니라 P2 개인
// 에이전트 켜기다. 로그인은 공식 CLI가 이미 끝냈고(`준비됨` 줄만 고를 수 있다), 서버는
// 하네스 로그인을 모른다. 별칭이 곧 핸들이고, 부르는 것은 나만, 답은 내 맥이 켜져
// 있을 때만이다.
export const PERSONAL_ENABLING_KEY = "onboarding.aiConnectPersonal.enabling" satisfies PlainMessageKey;
/** 개인 에이전트가 켜졌을 때의 설명: 「나만 부를 수 있어요」와 「내 맥이 켜져 있을 때만 답해요」를 한 문장 묶음으로. */
export const JOIN_JOINED_PERSONAL_DETAIL_KEY =
  "onboarding.aiConnectJoin.joinedPersonalDetail" satisfies PlainMessageKey;
/** 서버에 개인 에이전트 라우트가 없을 때(404/405): 줄을 고를 수 없게 하고 이유를 말한다. */
export const PERSONAL_UNAVAILABLE_KEY =
  "onboarding.aiConnectPersonal.unavailable" satisfies PlainMessageKey;
export const PERSONAL_UNAVAILABLE_DETAIL_KEY =
  "onboarding.aiConnectPersonal.unavailableDetail" satisfies PlainMessageKey;

export const CONNECT_ENDPOINT_KEY = "onboarding.aiConnectCopy.endpoint" satisfies PlainMessageKey;
export const CONNECT_CREDENTIAL_KEY = "onboarding.aiConnectCopy.credential" satisfies PlainMessageKey;
