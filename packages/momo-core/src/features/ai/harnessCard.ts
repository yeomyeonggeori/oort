import type { LocalHarnessId, LocalHarnessProbe } from "../hostedAgents/detect";
import type { HarnessPill } from "../onboarding/aiConnect";

// =============================================================================
// AI 허브 「내 도구」 하네스 카드 (ADR-0198 D3, #3568).
//
// 한 카드가 로그인 상태와 호스트 상태를 함께 말한다. 순수 함수만 있고 셸 호출·요청·
// 타이머는 웹이 한다. 규율:
//
// - 로그인 상태는 공식 CLI 상태 명령의 **종료 코드**만 본다(`detect_local_harnesses`가
//   이미 그렇게 돌린다). 만료와 미로그인은 구분하지 못하므로 둘 다 「다시 인증」이다.
// - 「연결 안 됨」은 **로그아웃 뒤 상태 명령이 로그인 아님을 알린 다음에만** 말한다
//   (`disconnectVerdict`). 로그아웃 CLI가 0으로 끝났다는 사실만으로는 말하지 않는다.
// - 호스트 상태는 서버 work host 읽기의 `online` 한 식을 그대로 읽는다. 서버는 구독
//   로그인 상태를 알지 못하고, 이 카드도 그것을 올리지 않는다.
// =============================================================================

// ---- 로그인 ---------------------------------------------------------------------

export type HarnessLoginView =
  | "connected"
  | "reauth"
  | "disconnected"
  | "logging-in"
  | "disconnecting"
  | "checking"
  | "unknown"
  | "not-installed";

/** 모달 컨트롤러가 알리는 로그인 진행. null이면 진행 중인 로그인이 없다. */
export type LoginProgress = "waiting" | "checking" | null;

/** 연결 끊기 진행. `idle`이면 시도한 적 없다. */
export type DisconnectProgress =
  | { phase: "idle" }
  | { phase: "signing-out" }
  | { phase: "verifying" }
  | { phase: "done" }
  | { phase: "failed"; reason: DisconnectFailure };

export type DisconnectFailure =
  | "logout-failed"
  | "still-logged-in"
  | "unknown"
  | "spawn"
  | "timeout";

export function harnessLoginView(input: {
  pill: HarnessPill;
  login: LoginProgress;
  disconnect: DisconnectProgress;
}): HarnessLoginView {
  const { pill, login, disconnect } = input;
  if (disconnect.phase === "signing-out" || disconnect.phase === "verifying") return "disconnecting";
  if (login !== null) return "logging-in";
  if (pill === "install") return "not-installed";
  if (pill === "ready") return "connected";
  if (pill === "checking") return "checking";
  if (pill === "recheck") return "unknown";
  // 로그인 아님. 끊기를 마치고 확인된 뒤에만 「연결 안 됨」이다.
  return disconnect.phase === "done" ? "disconnected" : "reauth";
}

export const HARNESS_LOGIN_VIEW_LABEL: Record<HarnessLoginView, string> = {
  connected: "연결됨",
  reauth: "다시 인증",
  disconnected: "연결 안 됨",
  "logging-in": "로그인 중",
  disconnecting: "연결 끊는 중",
  checking: "확인하는 중",
  unknown: "확인 못 했어요",
  "not-installed": "설치 안 됨",
};

/** 알약 색 갈래 (`AiPillTone`과 같은 낱말). */
export function harnessLoginTone(view: HarnessLoginView): "ok" | "warn" | "mute" | "run" {
  switch (view) {
    case "connected":
      return "ok";
    case "reauth":
      return "warn";
    case "logging-in":
    case "disconnecting":
    case "checking":
      return "run";
    default:
      return "mute";
  }
}

/**
 * 연결 끊기 판정. 로그아웃 CLI가 정상(0)으로 끝났고, **그 뒤에** 상태 명령이 로그인이
 * 아님을 알린 때만 `done`이다. 아직 로그인이면 `still-logged-in`, 상태 명령이 답하지
 * 않으면 `unknown`(끊겼다고 말하지 않는다).
 */
export function disconnectVerdict(
  harness: LocalHarnessId,
  exit: { code: number | null; signal: string | null } | null,
  probes: readonly LocalHarnessProbe[] | null
): DisconnectProgress {
  if (exit === null || exit.signal !== null || exit.code !== 0) {
    return { phase: "failed", reason: "logout-failed" };
  }
  const probe = probes?.find((row) => row.id === harness);
  if (!probe || !probe.installed || probe.auth === "unknown") {
    return { phase: "failed", reason: "unknown" };
  }
  return probe.auth === "logged_in"
    ? { phase: "failed", reason: "still-logged-in" }
    : { phase: "done" };
}

export const DISCONNECT_FAILED_LINE: Record<DisconnectFailure, string> = {
  "logout-failed": "로그아웃이 끝나지 않았어요. 로그인은 그대로예요.",
  "still-logged-in": "로그아웃한 뒤에도 아직 로그인돼 있어요.",
  unknown: "로그아웃 뒤 상태를 확인하지 못했어요.",
  spawn: "이 앱에서 로그아웃을 시작하지 못했어요.",
  timeout: "로그아웃이 제때 끝나지 않아 멈췄어요.",
};

// ---- 호스트 ---------------------------------------------------------------------

export type HostView = "on" | "off" | "unregistered" | "checking" | "unknown";

export const HOST_VIEW_LABEL: Record<HostView, string> = {
  on: "내 맥 켜짐",
  off: "내 맥 꺼짐",
  unregistered: "미등록",
  checking: "내 맥 확인 중",
  unknown: "내 맥 확인 못 했어요",
};

export const HOST_VIEW_DETAIL: Record<HostView, string> = {
  on: "작업을 이 맥으로 바로 시킬 수 있어요.",
  off: "맥이 켜질 때까지 이 맥으로는 작업을 시킬 수 없어요.",
  unregistered: "이 맥을 작업 호스트로 등록하면 폰에서도 시킬 수 있어요.",
  checking: "",
  unknown: "서버에서 호스트 목록을 읽지 못했어요.",
};

export function hostTone(view: HostView): "ok" | "mute" | "run" {
  return view === "on" ? "ok" : view === "checking" ? "run" : "mute";
}

export interface HostRowLike {
  scope: string;
  ownerMemberId: string;
  revokedAtMs?: number;
  online: boolean;
}

/**
 * 내 호스트 상태. 내 것 = 범위가 member이고 소유자가 나이며 취소되지 않은 행.
 * 켜짐은 서버가 준 `online`(90초 heartbeat 창) 그대로다. 이 함수가 시간을 재지 않는다.
 */
export function myHostView(
  read: { state: "loading" } | { state: "error" } | { state: "ok"; hosts: readonly HostRowLike[] },
  memberId: string
): HostView {
  if (read.state === "loading") return "checking";
  if (read.state === "error") return "unknown";
  const mine = read.hosts.filter(
    (host) =>
      host.scope === "member" &&
      host.ownerMemberId.toLowerCase() === memberId.toLowerCase() &&
      !host.revokedAtMs
  );
  if (mine.length === 0) return "unregistered";
  return mine.some((host) => host.online) ? "on" : "off";
}

// ---- 개인 에이전트 (ADR-0198 증보 1 D7, P2 #3591) -----------------------------------

export type PersonalHarnessWire = "claude_code" | "codex";

export const PERSONAL_HARNESS_WIRE: Record<LocalHarnessId, PersonalHarnessWire> = {
  claude: "claude_code",
  codex: "codex",
};

export interface PersonalAgentSummary {
  id: string;
  handle: string;
  displayName: string;
  harness: PersonalHarnessWire;
  enabled: boolean;
  label: string;
}

/** 별칭은 멤버 핸들이다: 소문자 a-z 0-9 _ - 로 2~32자. 소문자로 접는다. */
export const PERSONAL_ALIAS_PATTERN = /^[a-z0-9_-]{2,32}$/;

export function normalizePersonalAlias(raw: string): string {
  return raw.trim().replace(/^@/, "").toLowerCase();
}

export function personalAliasValid(alias: string): boolean {
  return PERSONAL_ALIAS_PATTERN.test(alias);
}

export const PERSONAL_AGENT_COPY = {
  toggleLabel: "개인 에이전트로 쓰기",
  toggleHint: "별칭을 붙이면 어느 채널에서든 나만 @로 부를 수 있어요. 내 맥이 켜져 있을 때만 답해요.",
  aliasLabel: "별칭",
  aliasHint: "영문 소문자, 숫자, _, - 로 2자에서 32자까지예요.",
  aliasInvalid: "영문 소문자, 숫자, _, - 로 2자에서 32자까지 적어 주세요.",
  enable: "개인 에이전트 켜기",
  disable: "개인 에이전트 끄기",
  cancel: "취소",
  badge: "개인",
  badgeHint: "나만 부를 수 있어요",
  off: "꺼 둔 개인 에이전트",
  unavailable: "이 서버에서는 아직 개인 에이전트를 켤 수 없어요. 서버가 업데이트되면 열려요.",
  loadFailed: "개인 에이전트 상태를 읽지 못했어요.",
  needsLogin: "먼저 이 도구를 연결해야 켤 수 있어요.",
} as const;

export function personalAgentErrorLine(code: string | null): string {
  switch (code) {
    case "personal_agent_alias_taken":
      return "이미 쓰는 별칭이에요. 다른 별칭을 적어 주세요.";
    case "personal_agent_exists":
      return "이 도구에는 이미 개인 에이전트가 있어요. 목록을 새로 불러올게요.";
    case "personal_agent_suspended":
      return "관리자가 이 개인 에이전트를 정지했어요. 관리자가 풀어야 다시 켤 수 있어요.";
    case "personal_agent_not_found":
      return "개인 에이전트를 찾지 못했어요. 목록을 새로 불러올게요.";
    default:
      return "개인 에이전트를 바꾸지 못했어요. 잠시 뒤 다시 시도해 주세요.";
  }
}
