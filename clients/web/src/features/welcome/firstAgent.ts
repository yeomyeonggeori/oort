import type { HostedConnectionStatus } from "@momo/core/features/hostedAgents/model";
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
export const FIRST_AGENT_LEAD =
  "팀에 붙일 에이전트를 고르세요. 나중에 설정 › 연결 › 에이전트 자격에서 이어갈 수 있습니다.";
export const FIRST_AGENT_SKIP_LABEL = "나중에";
export const FIRST_AGENT_CONTINUE_LABEL = "계속";
export const FIRST_AGENT_REENTRY_LABEL = "설정 › 연결 › 에이전트 자격";
export const FIRST_AGENT_REENTRY_HREF = "/settings?section=agents";
export const FIRST_AGENT_AI_HREF = "/settings?section=ai";

export const FIRST_AGENT_DETECTING_HEADLINE =
  "에이전트가 연결 값으로 접속하면 이 화면이 바뀝니다.";
export const FIRST_AGENT_DETECTING_DETAIL =
  "provider 설정에 값을 넣고 커넥터나 routine을 한 번 실행하세요. 감지는 서버 상태만 따릅니다.";

export const FIRST_AGENT_CAP_COPY =
  "아직 감지되지 않았습니다. 설정 › 연결 › 에이전트 자격에서 이어갈 수 있습니다.";

export const FIRST_AGENT_CONNECTED_CLAIM = "연결됨";

export const FIRST_AGENT_OPENAI_DETAIL =
  "에이전트가 사용할 provider를 이 서버 전체에 하나로 연결합니다.";

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
  const grok = grokPreset();
  return [grok.detail, grok.unverifiedNote].filter(Boolean).join(" ");
}

export const FIRST_AGENT_CARDS: readonly FirstAgentCard[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    detail: genericPreset().detail,
    presetId: "generic",
    displayName: "Claude Code",
    handle: "claude-code",
  },
  {
    id: "codex",
    label: "Codex",
    detail: genericPreset().detail,
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

/** 프리셋 문구 정책: Grok 은 미확인이고, 카드는 HOSTED_PRESETS 를 복제하지 않는다. */
export function firstAgentCardsUseHostedPresets(): boolean {
  const grok = HOSTED_PRESETS.find((preset) => preset.id === "grok");
  const generic = HOSTED_PRESETS.find((preset) => preset.id === "generic");
  if (!grok || !generic) return false;
  const grokCard = firstAgentCard("grok");
  const claude = firstAgentCard("claude-code");
  return (
    grokCard.label === grok.label &&
    grokCard.detail.includes(grok.detail) &&
    Boolean(grok.unverifiedNote && grokCard.detail.includes(grok.unverifiedNote)) &&
    claude.detail === generic.detail
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

export function countsTowardAutoPass(status: HostedConnectionStatus): boolean {
  return (
    status === "pairing_pending" ||
    status === "detected" ||
    status === "active"
  );
}

export function shouldAutoPass(
  connections: readonly { status: HostedConnectionStatus }[]
): boolean {
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
  | "done";

export const FIRST_AGENT_CAPTURE_POSES: readonly FirstAgentCapturePose[] = [
  "cards",
  "one-time",
  "detecting",
  "cap-exceeded",
  "done",
];

/** 캡처 전용 1회용 값. 제품 발급 경로의 비밀과 섞이지 않는다. */
export const FIRST_AGENT_CAPTURE_SECRET =
  "momo_pair_v1.capture.once-only-fixture-do-not-repeat";

export function parseFirstAgentCapturePose(
  raw: string | null
): FirstAgentCapturePose | null {
  if (raw === "cards") return "cards";
  if (raw === "one-time") return "one-time";
  if (raw === "detecting") return "detecting";
  if (raw === "cap-exceeded") return "cap-exceeded";
  if (raw === "done") return "done";
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
