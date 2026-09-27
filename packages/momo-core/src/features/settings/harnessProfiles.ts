import { attachParticle } from "../../lib/koreanParticle";
import {
  LOCAL_HARNESS_IDS,
  type LocalHarnessAuth,
  type LocalHarnessId,
  type LocalHarnessProbe,
} from "../hostedAgents/detect";
import { HARNESS_LABEL } from "../onboarding/aiConnect";

// =============================================================================
// 내 계정 · 이 맥 — 프로필 줄과 연결 해제 (#2878 AA-4, 시안 §3·§4, brief §3.4).
//
// 프로필 = 하네스별 설정 폴더 하나(ADR-0191 D1). 폴더를 정하는 것은 셸이다
// (`harness_profile.rs`): 웹은 하네스 id와 라벨만 넘긴다. 이 파일은 화면이 그릴
// 것을 **결정**만 한다(순수 함수와 문장).
//
// 줄은 두 종류다.
// - **기본 로그인**(`profile: null`): 사용자가 원래 터미널에서 쓰던 이 맥의 로그인.
//   oort 프로필이 아니다. 파괴적 행동은 「목록에서 빼기」뿐이고 로그아웃하지 않는다
//   (Q2). 뺀 목록은 이 기기에만 둔다.
// - **oort 프로필**(`profile: 라벨`): oort가 만든 폴더. 「연결 해제」는 숨은 PTY에서
//   공식 CLI 로그아웃 → 종료 코드 0 → 셸이 상태 명령으로 「로그인 안 됨」을 확인한
//   뒤에만 폴더를 지운다. 그 밖의 결말에서는 폴더가 남고 화면이 그 사실을 말한다.
// =============================================================================

/** 셸 `ProfileRef`와 같은 모양. 경로가 없다. */
export interface HarnessProfileRef {
  harness: LocalHarnessId;
  label: string;
}

/** 셸 `check_label`과 같은 한도. */
export const PROFILE_LABEL_MAX = 32;

/**
 * 라벨의 문제를 문장으로. 없으면 null. 셸이 같은 규칙으로 다시 거부하므로 이것은
 * 입력 칸 안내일 뿐이다(판정의 정본은 셸).
 */
export function profileLabelProblem(raw: string, taken: readonly string[] = []): string | null {
  const label = raw.normalize("NFC");
  if (label.trim() === "") return "라벨을 적어 주세요.";
  if ([...label].length > PROFILE_LABEL_MAX) return `라벨은 ${PROFILE_LABEL_MAX}자까지예요.`;
  if (label.trim() !== label) return "앞뒤 빈칸은 뺄게요.";
  if (label.startsWith(".")) return "라벨은 점(.)으로 시작할 수 없어요.";
  // eslint-disable-next-line no-control-regex
  if (/[/\\:\u0000-\u001f\u007f]/.test(label)) return "라벨에 / \\ : 는 쓸 수 없어요.";
  if (taken.includes(label)) return "이 이름의 계정이 이미 있어요.";
  return null;
}

/** 입력 칸 값 → 셸로 보낼 라벨. NFC로 한 번 고정해 로그인·로그아웃이 같은 글자를 쓴다. */
export function normalizeProfileLabel(raw: string): string {
  return raw.normalize("NFC");
}

function isHarness(value: unknown): value is LocalHarnessId {
  return (LOCAL_HARNESS_IDS as readonly unknown[]).includes(value);
}

export function normalizeProfileList(raw: unknown): HarnessProfileRef[] {
  if (!Array.isArray(raw)) return [];
  const out: HarnessProfileRef[] = [];
  for (const row of raw) {
    if (typeof row !== "object" || row === null) continue;
    const { harness, label } = row as Record<string, unknown>;
    if (!isHarness(harness) || typeof label !== "string") continue;
    if (profileLabelProblem(label) !== null) continue;
    out.push({ harness, label });
  }
  return out;
}

/** 셸 `RemoveOutcome`. 모르는 값은 「모름」으로 읽는다(폴더가 남았다고 본다). */
export type ProfileRemoveOutcome = "removed" | "still_signed_in" | "unknown";

export function normalizeRemoveOutcome(raw: unknown): ProfileRemoveOutcome {
  return raw === "removed" || raw === "still_signed_in" ? raw : "unknown";
}

// ---- 목록 --------------------------------------------------------------------

export type MyAccountRow =
  | { kind: "default"; key: string; harness: LocalHarnessId; profile: null }
  | { kind: "profile"; key: string; harness: LocalHarnessId; profile: string };

/**
 * 내 계정 줄. 기본 로그인은 설치된 CLI마다 한 줄(뺀 것은 없다), 그 뒤에 프로필이
 * 하네스 순서·라벨 순서로 선다. 프로필 줄은 CLI가 없어져도 남는다(폴더가 있으니까).
 */
export function myAccountRows(input: {
  probes: readonly LocalHarnessProbe[];
  profiles: readonly HarnessProfileRef[];
  hiddenDefaults: readonly LocalHarnessId[];
}): MyAccountRow[] {
  const rows: MyAccountRow[] = [];
  for (const id of LOCAL_HARNESS_IDS) {
    const probe = input.probes.find((row) => row.id === id);
    if (probe?.installed && !input.hiddenDefaults.includes(id)) {
      rows.push({ kind: "default", key: `default:${id}`, harness: id, profile: null });
    }
  }
  for (const id of LOCAL_HARNESS_IDS) {
    const labels = input.profiles
      .filter((row) => row.harness === id)
      .map((row) => row.label)
      .sort((a, b) => a.localeCompare(b, "ko"));
    for (const label of labels) {
      rows.push({ kind: "profile", key: `profile:${id}/${label}`, harness: id, profile: label });
    }
  }
  return rows;
}

/** 계정 이름(구독의 주인 서비스). brief §3.2 「Claude」「ChatGPT」. */
export const ACCOUNT_LABEL: Record<LocalHarnessId, string> = {
  claude: "Claude",
  codex: "ChatGPT",
};

/** 줄 이름: 「Claude」(기본 로그인), 「Claude · 회사」(프로필). 시안 §3. */
export function myAccountRowTitle(row: Pick<MyAccountRow, "harness" | "profile">): string {
  return row.profile === null
    ? ACCOUNT_LABEL[row.harness]
    : `${ACCOUNT_LABEL[row.harness]} · ${row.profile}`;
}

/** 줄 둘째 줄(출처 알약 「구독」 뒤). 시안 §4 2a 「Claude Code CLI」. */
export function myAccountRowDetail(row: Pick<MyAccountRow, "harness" | "profile">): string {
  const cli = `${HARNESS_LABEL[row.harness]} CLI`;
  return row.profile === null ? `이 맥의 기본 로그인 · ${cli}` : `oort 계정 폴더 · ${cli}`;
}

// ---- 뺀 기본 로그인(이 기기) ------------------------------------------------------

export const HIDDEN_DEFAULTS_STORAGE_KEY = "oort.aiAccounts.hiddenDefaults.v1";

export function parseHiddenDefaults(raw: string | null): LocalHarnessId[] {
  if (raw === null) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? LOCAL_HARNESS_IDS.filter((id) => value.includes(id)) : [];
  } catch {
    return [];
  }
}

export function serializeHiddenDefaults(ids: readonly LocalHarnessId[]): string {
  return JSON.stringify(LOCAL_HARNESS_IDS.filter((id) => ids.includes(id)));
}

export function restoreHiddenLine(count: number): string {
  return `목록에서 뺀 이 맥 기본 로그인 ${count}개 다시 보이기`;
}

// ---- 해제 확인 창(시안 §3 왼쪽) ------------------------------------------------------

/** 공식 CLI 이름(문장 속 「누가 로그아웃하는가」). */
export const HARNESS_CLI_NAME: Record<LocalHarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

/** 터미널에서 쓰는 명령 이름(「터미널에서 쓰던 claude 로그인」). */
export const HARNESS_BIN_NAME: Record<LocalHarnessId, string> = {
  claude: "claude",
  codex: "codex",
};

export const UNLINK_CONFIRM_LABEL = "연결 해제";
export const UNLINK_BUSY_LABEL = "해제하는 중";
export const REMOVE_FROM_LIST_LABEL = "목록에서 빼기";
export const RELOGIN_LABEL = "다시 로그인";

export function unlinkDialogTitle(row: Pick<MyAccountRow, "harness" | "profile">): string {
  return row.profile === null
    ? `${myAccountRowTitle(row)} 기본 로그인을 목록에서 뺄까요?`
    : `${myAccountRowTitle(row)} 연결을 해제할까요?`;
}

/** 시안 §3 문장 그대로(프로필), 기본 로그인은 로그아웃하지 않는다는 문장. */
export function unlinkDialogBody(row: Pick<MyAccountRow, "harness" | "profile">): string {
  const bin = HARNESS_BIN_NAME[row.harness];
  if (row.profile === null) {
    return `이 목록에서만 뺍니다. 로그아웃하지 않아요. 터미널에서 쓰던 ${bin} 로그인은 그대로예요.`;
  }
  return `이 계정 전용 폴더의 로그인을 ${HARNESS_CLI_NAME[row.harness]}로 로그아웃하고 목록에서 뺍니다. 터미널에서 쓰던 ${bin} 로그인은 그대로예요.`;
}

// ---- 해제 진행(숨은 PTY) --------------------------------------------------------------

/** 로그아웃이 이보다 오래 걸리면 PTY를 끝내고 실패로 둔다. */
export const HARNESS_LOGOUT_TIMEOUT_MS = 60_000;

export type UnlinkFailure =
  /** 공식 CLI가 0이 아닌 값으로 끝났다(또는 신호로 끝났다). */
  | "logout-failed"
  /** 로그아웃 뒤에도 상태 명령이 로그인됨이다. */
  | "still-signed-in"
  /** 상태 명령이 답하지 않았다(없음·시간 초과). */
  | "unknown"
  /** 이 앱에서 로그아웃 칸을 열지 못했다. */
  | "spawn"
  /** 시간 제한이 지났다. 앱이 PTY를 끝냈다. */
  | "timeout"
  /** 로그아웃은 됐는데 셸이 폴더를 지우지 못했다. */
  | "remove-failed";

export type UnlinkPhase =
  | { phase: "confirm" }
  | { phase: "signing-out" }
  | { phase: "removing" }
  | { phase: "done" }
  | { phase: "failed"; reason: UnlinkFailure };

/** PTY가 끝났을 때: 종료 코드 0이면 폴더 정리로, 아니면 실패(폴더 유지). */
export function unlinkAfterExit(exit: { code: number | null; signal: string | null } | null): UnlinkPhase {
  return exit !== null && exit.signal === null && exit.code === 0
    ? { phase: "removing" }
    : { phase: "failed", reason: "logout-failed" };
}

/** 셸의 삭제 결과 → 끝 상태. */
export function unlinkAfterRemove(outcome: ProfileRemoveOutcome): UnlinkPhase {
  switch (outcome) {
    case "removed":
      return { phase: "done" };
    case "still_signed_in":
      return { phase: "failed", reason: "still-signed-in" };
    default:
      return { phase: "failed", reason: "unknown" };
  }
}

export const UNLINK_SIGNING_OUT_LINE = "로그아웃하고 있어요.";
export function unlinkSigningOutDetail(harness: LocalHarnessId): string {
  return `${attachParticle(HARNESS_CLI_NAME[harness], "subject")} 이 계정 폴더에서 로그아웃하고 있어요. oort는 로그인 정보를 보지 않아요.`;
}
export const UNLINK_REMOVING_LINE = "로그아웃을 확인하고 폴더를 정리하고 있어요.";

export function unlinkFailedLine(reason: UnlinkFailure): string {
  switch (reason) {
    case "logout-failed":
      return "로그아웃하지 못했어요.";
    case "still-signed-in":
      return "아직 로그인돼 있어요.";
    case "unknown":
      return "로그인 상태를 확인하지 못했어요.";
    case "spawn":
      return "이 앱에서 로그아웃을 열지 못했어요.";
    case "timeout":
      return "로그아웃이 끝나지 않았어요.";
    case "remove-failed":
      return "로그아웃은 했지만 폴더를 지우지 못했어요.";
  }
}

/** 실패 설명. 폴더가 남았다는 사실을 늘 말한다. */
export function unlinkFailedDetail(harness: LocalHarnessId, reason: UnlinkFailure): string {
  const cli = HARNESS_CLI_NAME[harness];
  switch (reason) {
    case "logout-failed":
      return `${attachParticle(cli, "subject")} 로그아웃을 마치지 못했다고 알려 왔어요. 계정 폴더는 그대로 두었어요.`;
    case "still-signed-in":
      return `${attachParticle(cli, "subject")} 아직 로그인됨이라고 알려 와서 계정 폴더를 지우지 않았어요.`;
    case "unknown":
      return `${attachParticle(cli, "subject")} 상태에 답하지 않아 계정 폴더를 지우지 않았어요. 잠시 뒤 다시 시도해 주세요.`;
    case "spawn":
      return "계정 폴더는 그대로 두었어요.";
    case "timeout":
      return "1분 안에 끝나지 않아 멈췄어요. 계정 폴더는 그대로 두었어요.";
    case "remove-failed":
      return "목록에는 「로그인 필요」로 남아요. 다시 해제하면 폴더를 지웁니다.";
  }
}

export const UNLINK_DONE_STATUS = "연결을 해제했어요.";

// ---- 구독 추가(시안 §4 1) ----------------------------------------------------------------

export const ADD_SUBSCRIPTION_TITLE = "구독 추가";
export const ADD_SUBSCRIPTION_LEAD =
  "Claude Pro·Max, ChatGPT Plus·Pro. 브라우저에서 각 회사의 공식 CLI로 로그인합니다. 나만 씁니다.";
export const ADD_SUBSCRIPTION_CLI_LABEL = "어느 CLI인가요?";
export const ADD_SUBSCRIPTION_LABEL_LABEL = "라벨";
export const ADD_SUBSCRIPTION_LABEL_HINT =
  "같은 CLI에 계정을 여러 개 둘 수 있어요. 목록에서 이 이름으로 구분합니다.";
export const ADD_SUBSCRIPTION_CHIP: Record<LocalHarnessId, string> = {
  claude: "Claude Code",
  codex: "Codex (ChatGPT)",
};
export const ADD_SUBSCRIPTION_GROK_CHIP = "Grok · 준비 중";
export const ADD_SUBSCRIPTION_NOT_INSTALLED = "설치 안 됨";
/** 셸이 폴더를 만들지 못했을 때. */
export function addSubscriptionCreateFailed(raw: string): string {
  return /already exists/.test(raw)
    ? "이 이름의 계정이 이미 있어요."
    : "이 맥에 계정 폴더를 만들지 못했어요.";
}

/** 줄의 상태 → 파괴적 행동 이름. */
export function destructiveActionLabel(row: Pick<MyAccountRow, "profile">): string {
  return row.profile === null ? REMOVE_FROM_LIST_LABEL : UNLINK_CONFIRM_LABEL;
}

/** 줄이 「다시 로그인」 버튼을 세우는가(로그인 필요·재확인). */
export function rowNeedsLogin(auth: LocalHarnessAuth | undefined, installed: boolean): boolean {
  return installed && auth === "needs_login";
}

/**
 * 프로필 로그인 칸을 열지 못했을 때. 기본 위치의 복사 명령을 주지 않는다: 그
 * 명령은 이 계정 폴더가 아니라 터미널의 기본 로그인에 로그인한다.
 */
export const PROFILE_LOGIN_SPAWN_DETAIL =
  "이 계정 폴더로는 앱 안에서만 로그인할 수 있어요. 앱을 다시 연 뒤 시도해 주세요.";
