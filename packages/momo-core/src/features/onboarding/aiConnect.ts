import { attachParticle } from "../../lib/koreanParticle";
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
//   공식 CLI가 터미널에서 끝낸다. 로그인이 필요한 줄의 행동은 「터미널에서 로그인」
//   하나이고, 그것은 CLI 명령 한 줄을 복사하고 OS 터미널을 여는 것이다.
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

/** 사람이 읽는 CLI 이름. */
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
 * - `hidden`: 빌드 플래그가 꺼진 빌드(팀 배포). #2815 랜딩 전 노출 금지. 아무
 *   말도 하지 않는다 — 아직 없는 기능을 광고하지 않는다.
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

/** 줄 순서. 구독 줄이 서면 맨 위, 아니면 API 키 줄이 맨 위다(D6). */
export function aiConnectRows(surface: SubscriptionSurface): readonly AiConnectRowId[] {
  if (surface === "rows") return ["claude", "codex", "api-key", "grok"];
  return ["api-key", "grok"];
}

// ---- 알약 ---------------------------------------------------------------------

/**
 * 구독 줄의 상태 알약 다섯(이슈 #2814 계약, Buzz SetupStep 문법).
 * 한 알약이 한 행동이다: 설치 필요 → 설치 안내 열기, 로그인 필요 → 터미널에서
 * 로그인, 다시 확인 → 다시 묻기. 확인 중·준비됨은 행동이 없다.
 */
export type HarnessPill = "install" | "login" | "checking" | "ready" | "recheck";

export const HARNESS_PILL_LABEL: Record<HarnessPill, string> = {
  install: "설치 필요",
  login: "로그인 필요",
  checking: "확인 중…",
  ready: "준비됨",
  recheck: "다시 확인",
};

/**
 * 감지 결과 + 로그인 대기 상태 → 알약.
 *
 * - 아직 한 번도 못 물었으면(`probe === null`) 확인 중.
 * - 미설치 → 설치 필요. 로그인됨 → 준비됨.
 * - 「터미널에서 로그인」 뒤 2초 재확인이 도는 동안 → 확인 중.
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
 * 「터미널에서 로그인」이 복사하는 명령. 공식 CLI의 로그인 입구 그대로다
 * (`claude`는 첫 실행에서 로그인을 연다, `codex login`). oort가 로그인을
 * 대신하지 않는다.
 */
export const HARNESS_LOGIN_COMMAND: Record<LocalHarnessId, string> = {
  claude: "claude",
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

// ---- 구독 에이전트 정체성 -----------------------------------------------------

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
 * 합류 요청의 409는 둘이다(서버 `hosted_agent_connections.rs`): 킬 스위치가
 * 꺼짐, 또는 핸들이 이미 있음. 서버 영어 문장은 화면에 그리지 않고 **분류**에만
 * 쓴다(model.ts 규율 3).
 */
export type SubscriptionJoinRefusal = "subscription-off" | "handle-taken" | "other";

export function classifyJoinConflict(message: string): SubscriptionJoinRefusal {
  if (/subscription agents are disabled/i.test(message)) return "subscription-off";
  if (/handle already exists/i.test(message)) return "handle-taken";
  return "other";
}

// ---- 코메토 문장 --------------------------------------------------------------

export const AI_CONNECT_QUESTION = "누구의 AI로 생각할까요?";
export const AI_CONNECT_QUESTION_DETAIL = "에이전트가 누구의 AI로 생각할지 골라요.";
export const AI_CONNECT_PROBING_LINE = "이 맥의 CLI를 확인하고 있어요.";

export function aiConnectFoundLine(harness: LocalHarnessId): string {
  return `이 맥에서 ${attachParticle(HARNESS_LABEL[harness], "object")} 찾았어요.`;
}

export interface AiConnectRowCopy {
  title: string;
  detail: string;
  /** 줄 머리의 글자 타일(시안 `.opt .lg`). */
  mark: string;
}

export const AI_CONNECT_ROW_COPY: Record<AiConnectRowId, AiConnectRowCopy> = {
  claude: {
    title: "Claude Code · 내 구독",
    detail: "이 맥의 공식 CLI · 나만 부르는 개인 에이전트",
    mark: "C",
  },
  codex: {
    title: "Codex · 내 구독",
    detail: "이 맥의 공식 CLI · 나만 부르는 개인 에이전트",
    mark: "X",
  },
  "api-key": {
    title: "API 키 · 팀 에이전트",
    detail: "Anthropic·OpenAI 키 · 팀 누구나 부를 수 있어요",
    mark: "키",
  },
  grok: {
    title: "그록봇",
    detail: "그록봇 앱을 팀에 초대해요",
    mark: "G",
  },
};

/** API 키 줄의 알약: 설정 화면으로 가는 줄이라는 표지. */
export const API_KEY_PILL_LABEL = "설정";
/** 그록봇이 이 맥에서 감지되지 않았을 때(데스크탑만). */
export const GROK_NOT_INSTALLED_PILL_LABEL = "설치 안 됨";

export const AI_CONNECT_BOUNDARY_NOTE =
  "상태는 CLI가 스스로 알려 준 값이에요. oort는 로그인 정보를 읽거나 옮기지 않아요. 구독으로 도는 에이전트는 나만 부를 수 있고, 팀 모두가 부를 에이전트는 API 키로 붙여요.";

export const AI_CONNECT_DESKTOP_ONLY_NOTE =
  "데스크탑 앱에서 이 맥의 Claude Code를 붙일 수 있어요.";

export const AI_CONNECT_SERVER_OFF_NOTE =
  "이 서버는 지금 구독 에이전트를 받지 않아요. 팀 에이전트는 API 키로 붙여요.";

export const LOGIN_ACTION_LABEL = "터미널에서 로그인";
export const COPY_ACTION_LABEL = "복사";
export const COPIED_LABEL = "복사됨";
export const OPEN_TERMINAL_LABEL = "터미널에서 열기";

export function loginCommandAria(harness: LocalHarnessId): string {
  return `${HARNESS_LABEL[harness]} 로그인 명령`;
}

export const LOGIN_OPENED_STATUS =
  "명령을 복사했습니다. 터미널에 붙여 넣고 로그인을 마치면 이 줄이 바뀝니다.";
export const TERMINAL_OPEN_FAILED =
  "터미널을 열지 못했습니다. 명령을 복사해 직접 여세요.";

export function primaryActionLabel(id: AiConnectRowId | null): string {
  switch (id) {
    case "claude":
      return "Claude Code를 내 에이전트로";
    case "codex":
      return "Codex를 내 에이전트로";
    case "api-key":
      return "API 키로 연결하기";
    case "grok":
      return "그록봇 초대하기";
    default:
      return "계속";
  }
}

export const AI_CONNECT_SKIP_LABEL = "지금은 건너뛰기";
export const AI_CONNECT_REENTRY = "나중에 설정 › AI 연결에서 이어갈 수 있습니다.";
export const AI_CONNECT_SKIPPED_LINE = "설정 › AI 연결에서 언제든 이어서 할 수 있어요.";
export const AI_CONNECT_CONTINUE_LABEL = "계속";

// ---- 합류 세 상태 (같은 화면) -------------------------------------------------

export type SubscriptionJoinPhase =
  | "creating"
  | "connect"
  | "waiting"
  | "cap"
  | "joined"
  | "error";

export function joinConnectLine(harness: LocalHarnessId): string {
  return harness === "claude"
    ? "터미널에서 이 명령을 한 번 실행해 주세요."
    : "Codex의 MCP 서버에 이 주소와 연결 값을 넣어 주세요.";
}

export function joinConnectDetail(harness: LocalHarnessId): string {
  return `${attachParticle(HARNESS_LABEL[harness], "subject")} 이 연결로 oort에 들어와요. 연결 값은 지금 한 번만 보여요.`;
}

/** ② 감지 대기. `label`은 CLI 이름(Claude Code·Codex) 또는 그록봇. */
export function joinWaitingLine(label: string): string {
  return `${attachParticle(label, "subject")} oort에 들어오기를 기다리고 있어요.`;
}

export const AI_CONNECT_LIST_ERROR_LINE = "연결 목록을 불러오지 못했어요.";
export const GROK_LABEL = "그록봇";
export const CONNECT_COMMAND_ARIA = "연결 명령";
export const CONNECT_HANDED_OFF_STATUS =
  "명령을 복사했습니다. 터미널에 붙여 넣어 실행하세요.";

export const JOIN_CREATING_LINE = "연결을 준비하고 있어요.";
export const JOIN_CAP_LINE = "5분 동안 들어오지 않았어요.";
export const JOIN_CAP_DETAIL = "명령을 실행했는지 확인하고 다시 확인을 눌러 주세요.";
export const JOIN_ERROR_LINE = "연결을 만들지 못했어요.";
export const JOIN_OFF_LINE = "지금은 이 서버에서 구독 에이전트를 쓸 수 없어요.";
export const JOIN_RECHECK_LABEL = "다시 확인";
export const JOIN_RETRY_LABEL = "다시 시도";
export const JOIN_BACK_LABEL = "다른 AI 고르기";

export function joinJoinedLine(agentDisplayName: string): string {
  return `${attachParticle(agentDisplayName, "subject")} 들어왔어요.`;
}

export const JOIN_JOINED_DETAIL = "나만 부를 수 있는 개인 에이전트예요.";

export const CONNECT_ENDPOINT_LABEL = "주소";
export const CONNECT_CREDENTIAL_LABEL = "연결 값";
