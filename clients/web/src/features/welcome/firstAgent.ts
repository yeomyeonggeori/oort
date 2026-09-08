import {
  HOSTED_AGENT_PORT_AUDIENCE,
  HOSTED_AUTH_MODE,
  type HostedAgentConnection,
  type HostedConnectionStatus,
} from "@momo/core/features/hostedAgents/model";
import {
  HOSTED_PRESETS,
  hostedPreset,
  type HostedPresetId,
} from "@momo/core/features/hostedAgents/presets";

// =============================================================================
// 로그인 뒤 「첫 에이전트 연결」 퍼널의 카드·감지 계약 (#2216).
//
// 화면 문장은 여기 한 곳. 티켓 id·파일 이름·플래그 이름은 화면 텍스트가 아니다.
// 감지 판정은 서버 status 만 본다. 클라가 「연결됨」을 먼저 말하지 않는다.
// =============================================================================

/** 로그인 뒤 first-run 순서. 킥오프는 웰컴 채널, 이 스테이지, 폰 연결. */
export const FIRST_AGENT_STAGE_ORDER = [
  "kickoff",
  "first-agent",
  "phone-link",
] as const;

export type FirstAgentStageId = (typeof FIRST_AGENT_STAGE_ORDER)[number];

export const DETECT_INITIAL_MS = 2_000;
export const DETECT_MAX_DELAY_MS = 30_000;
export const DETECT_CAP_MS = 5 * 60_000;

export const FIRST_AGENT_TITLE = "첫 에이전트 연결";
export const FIRST_AGENT_SKIP_SENTENCE =
  "나중에 설정 › 연결 › 에이전트 자격에서 이어갈 수 있습니다.";
export const FIRST_AGENT_SKIP_LABEL = "나중에";
export const FIRST_AGENT_CONTINUE_LABEL = "계속";
export const FIRST_AGENT_RECHECK_LABEL = "다시 확인";
export const FIRST_AGENT_RETRY_LABEL = "다시 시도";
export const FIRST_AGENT_MENTION_ACTION = "채널에서 첫 멘션 쓰기";
export const FIRST_AGENT_REENTRY_LABEL = "설정 › 연결 › 에이전트 자격";
export const FIRST_AGENT_REENTRY_HREF = "/settings?section=agents";
export const FIRST_AGENT_AI_HREF = "/settings?section=ai";

export const FIRST_AGENT_HEADING_ID = "first-agent-heading";
export const FIRST_AGENT_OFFLINE_REASON_ID = "first-agent-offline-reason";
export const FIRST_AGENT_ERROR_REASON_ID = "first-agent-error-reason";

export const FIRST_AGENT_LEAD_CARDS = "팀에 붙일 에이전트를 고르세요.";
export const FIRST_AGENT_LEAD_ISSUING = "연결 값을 에이전트 쪽에 넣으세요.";
export const FIRST_AGENT_LEAD_DETECTING =
  "에이전트가 연결 값으로 접속하면 이 화면이 바뀝니다.";
export const FIRST_AGENT_LEAD_CAP = "아직 감지되지 않았습니다.";
export const FIRST_AGENT_LEAD_MENTION = "감지된 에이전트에게 첫 멘션을 보냅니다.";

export const FIRST_AGENT_DETECTING_WAIT =
  "이 서버가 에이전트 접속을 확인하면 다음 화면으로 넘어갑니다.";

export const FIRST_AGENT_CHANNEL_PENDING =
  "이 에이전트가 답할 채널 승인이 아직 끝나지 않았습니다.";

export const FIRST_AGENT_LIST_ERROR = "연결 목록을 불러오지 못했습니다.";
export const FIRST_AGENT_OFFLINE_REASON =
  "연결이 끊겼습니다. 목록은 이어서 볼 수 있고, 발급은 다시 연결된 뒤에 할 수 있습니다.";

export const FIRST_AGENT_CAP_COPY =
  "5분이 지났습니다. 에이전트가 연결 값으로 접속했는지 다시 확인하세요.";
export const FIRST_AGENT_RECHECKING = "다시 확인 중…";

export const FIRST_AGENT_CONNECTED_CLAIM = "연결됨";

export const FIRST_AGENT_OPENAI_DETAIL =
  "설정 › AI 연결에서 이 서버의 provider를 붙입니다.";

export const FIRST_AGENT_GROK_WHAT_HAPPENS =
  "고르면 그록봇 연결 값을 발급합니다.";

export type FirstAgentCardId =
  | "claude-code"
  | "codex"
  | "grok"
  | "openai-compat";

export interface FirstAgentCard {
  id: FirstAgentCardId;
  label: string;
  detail: string;
  /** Agent Port 위저드 프리셋. OpenAI 호환은 설정 › AI 연결이라 없다. */
  presetId: HostedPresetId | null;
  displayName: string;
  handle: string;
}

function grokPreset() {
  return hostedPreset("grok");
}

function genericPreset() {
  return hostedPreset("generic");
}

function grokCardDetail(): string {
  const note = grokPreset().unverifiedNote ?? "";
  return `${note} ${FIRST_AGENT_GROK_WHAT_HAPPENS}`.trim();
}

/** Claude Code·Codex 줄의 MCP 순서 문장. OpenAI 줄에는 묶지 않는다. */
export const FIRST_AGENT_GENERIC_HINT = genericPreset().detail;

export const FIRST_AGENT_CARDS: readonly FirstAgentCard[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: FIRST_AGENT_GENERIC_HINT,
    presetId: "generic",
    displayName: "Claude Code",
    handle: "claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    detail: FIRST_AGENT_GENERIC_HINT,
    presetId: "generic",
    displayName: "Codex",
    handle: "codex",
  },
  {
    id: "grok",
    label: grokPreset().label,
    detail: grokCardDetail(),
    presetId: "grok",
    displayName: grokPreset().label,
    handle: "grokbot",
  },
  {
    id: "openai-compat",
    label: "OpenAI 호환",
    detail: FIRST_AGENT_OPENAI_DETAIL,
    presetId: null,
    displayName: "OpenAI 호환",
    handle: "openai-compat",
  },
];

export function firstAgentCard(id: FirstAgentCardId): FirstAgentCard {
  return (
    FIRST_AGENT_CARDS.find((card) => card.id === id) ?? FIRST_AGENT_CARDS[0]!
  );
}

export function firstAgentLead(step: FirstAgentStep): string {
  if (step === "issuing") return FIRST_AGENT_LEAD_ISSUING;
  if (step === "detecting") return FIRST_AGENT_LEAD_DETECTING;
  if (step === "cap-exceeded") return FIRST_AGENT_LEAD_CAP;
  if (step === "mention" || step === "done") return FIRST_AGENT_LEAD_MENTION;
  return FIRST_AGENT_LEAD_CARDS;
}

/**
 * 그 도구에서 지금 할 일. `routine`/`provider` 는 그 프리셋이 쓰는 낱말일
 * 때만 따른다. 감지는 서버 상태만 따른다는 문장은 여기 주석이지 화면 문장이
 * 아니다.
 */
export function firstAgentDetectingDetail(
  cardId: FirstAgentCardId | null
): string {
  if (cardId === "grok") {
    return grokPreset().steps[0] ?? FIRST_AGENT_DETECTING_WAIT;
  }
  if (cardId === "claude-code" || cardId === "codex") {
    const card = firstAgentCard(cardId);
    return `${card.label} 원격 서버 설정에 주소와 연결 값을 넣고 한 번 실행하세요.`;
  }
  return "주소와 연결 값을 에이전트 쪽에 넣고 한 번 실행하세요.";
}

export function formatDetectPollWait(delayMs: number): string {
  return `${Math.round(delayMs / 1000)}초 뒤 다시 확인합니다`;
}

/** 프리셋 문구 정책: 네 줄 모두 고르면 생기는 일을 한 줄로 말하고, 단계는 카드에 없다. */
export function firstAgentCardsUseHostedPresets(): boolean {
  const grok = HOSTED_PRESETS.find((preset) => preset.id === "grok");
  const generic = HOSTED_PRESETS.find((preset) => preset.id === "generic");
  if (!grok || !generic) return false;
  const grokCard = firstAgentCard("grok");
  const claude = firstAgentCard("claude-code");
  const codex = firstAgentCard("codex");
  const openai = firstAgentCard("openai-compat");
  const recipe = generic.steps[1] ?? "";
  return (
    grokCard.label === grok.label &&
    Boolean(grok.unverifiedNote) &&
    grokCard.detail.includes(grok.unverifiedNote ?? "") &&
    grokCard.detail.includes(FIRST_AGENT_GROK_WHAT_HAPPENS) &&
    claude.detail === generic.detail &&
    codex.detail === generic.detail &&
    openai.detail === FIRST_AGENT_OPENAI_DETAIL &&
    !claude.detail.includes("아래") &&
    !codex.detail.includes("아래") &&
    !grokCard.detail.includes("아래") &&
    !openai.detail.includes("아래") &&
    claude.detail !== recipe &&
    codex.detail !== recipe &&
    grokCard.detail !== recipe &&
    openai.detail !== recipe &&
    !grokCard.detail.includes(generic.detail) &&
    !openai.detail.includes(generic.detail) &&
    FIRST_AGENT_GENERIC_HINT === generic.detail
  );
}

export type DetectDelay = number | "cap";

/**
 * 다음 hosted get 까지의 대기. 경과가 상한이면 `"cap"`.
 * 상한을 빼면 이 함수는 숫자를 계속 돌려 무한 폴링이 된다.
 */
export function nextDetectDelayMs(elapsedMs: number, attempt: number): DetectDelay {
  if (elapsedMs >= DETECT_CAP_MS) return "cap";
  const delay = Math.min(
    DETECT_INITIAL_MS * 2 ** Math.max(0, attempt),
    DETECT_MAX_DELAY_MS
  );
  return delay;
}

export function isHostedDetected(status: HostedConnectionStatus): boolean {
  return status === "detected" || status === "active";
}

/** 이 퍼널은 서버가 detected/active 가 되기 전에 「연결됨」을 그리지 않는다. */
export function copyClaimsConnected(text: string): boolean {
  return text.includes(FIRST_AGENT_CONNECTED_CLAIM);
}

export type LiveHostedStatus = HostedConnectionStatus;

/**
 * 자동 통과는 감지 규칙과 같다. `pairing_pending` 은 자격만 발급된 상태라
 * 접속이 없는 사람에게 이 퍼널을 다시 보여야 한다.
 */
export function countsTowardAutoPass(status: HostedConnectionStatus): boolean {
  return isHostedDetected(status);
}

export function shouldAutoPass(
  connections: readonly { status: HostedConnectionStatus }[],
  providerConfigured = false
): boolean {
  if (providerConfigured) return true;
  return connections.some((row) => countsTowardAutoPass(row.status));
}

export type FirstAgentStep =
  | "cards"
  | "issuing"
  | "detecting"
  | "cap-exceeded"
  | "mention"
  | "done";

export type FirstAgentCapturePose =
  | "cards"
  | "one-time"
  | "detecting"
  | "cap-exceeded"
  | "done"
  | "loading"
  | "offline"
  | "error";

export const FIRST_AGENT_CAPTURE_POSES: readonly FirstAgentCapturePose[] = [
  "cards",
  "one-time",
  "detecting",
  "cap-exceeded",
  "done",
  "loading",
  "offline",
  "error",
];

export function parseFirstAgentCapturePose(
  raw: string | null
): FirstAgentCapturePose | null {
  if (raw === "cards") return "cards";
  if (raw === "one-time") return "one-time";
  if (raw === "detecting") return "detecting";
  if (raw === "cap-exceeded") return "cap-exceeded";
  if (raw === "done") return "done";
  if (raw === "loading") return "loading";
  if (raw === "offline") return "offline";
  if (raw === "error") return "error";
  return null;
}

export function readFirstAgentCapturePoseFromLocation(): FirstAgentCapturePose | null {
  if (import.meta.env.MODE !== "design") return null;
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  const query = hash.includes("?")
    ? hash.slice(hash.indexOf("?"))
    : typeof window === "undefined"
      ? ""
      : window.location.search;
  return parseFirstAgentCapturePose(new URLSearchParams(query).get("firstAgent"));
}

/** 캡처 전용 1회용 값. 제품 발급 경로의 비밀과 섞이지 않는다. */
export function firstAgentCaptureSecret(): string {
  if (import.meta.env.MODE !== "design") return "";
  return "momo_pair_v1.capture.once-only-fixture-do-not-repeat";
}

export function firstAgentCaptureAgent(): {
  agentMemberId: string;
  displayName: string;
  handle: string;
} {
  if (import.meta.env.MODE !== "design") {
    return { agentMemberId: "", displayName: "", handle: "" };
  }
  return {
    agentMemberId: "019f9a01-0000-7000-8000-000000000404",
    displayName: "김인턴",
    handle: "kim-intern",
  };
}

/** 캡처 `done` 픽스처. 명부의 그 에이전트 id 를 싣는다. 제품 경로는 쓰지 않는다. */
export function firstAgentCaptureDetected(
  pose: FirstAgentCapturePose | null = null
): HostedAgentConnection | null {
  if (import.meta.env.MODE !== "design") return null;
  if (pose !== "done") return null;
  const agent = firstAgentCaptureAgent();
  return {
    id: "019f9a01-0000-7000-8000-0000000005c1",
    agentMemberId: agent.agentMemberId,
    status: "detected",
    authMode: HOSTED_AUTH_MODE,
    audience: HOSTED_AGENT_PORT_AUDIENCE,
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
  };
}
