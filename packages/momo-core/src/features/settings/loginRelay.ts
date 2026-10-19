// =============================================================================
// Hermes 로그인 중계의 클라이언트 (#4080 모델 인증, #4074 앱 로그인 / ADR-0203 증보 2026-10-19, ADR-0004 증보 7).
//
// Wire contract (openapi.operator.yaml, #4079): `…/agents/{agent}/model-login` 와 `…/app-login`,
// 각각 GET 목록 · POST 시작 · POST …/{id}/complete · GET …/{id} 폴링 · DELETE …/{id} 취소.
//
// Rules this file holds:
//   1. 붙여넣은 값(`pasted`)과 기기 코드(`userCode`)는 oort를 한 번 지나가는 값이다. 이 파일은 그 값을
//      **돌려주거나 보관하지 않는다**: `completeLogin` 은 값을 본문으로 한 번 보내고 아무것도 돌려주지
//      않는다(상태만). 오류는 값을 담지 않고 고정 문장만 만든다. 호출 쪽은 react-query 의 mutation 으로
//      감싸지 않는다(변수·결과가 캐시에 남는다).
//   2. 모든 읽기는 운영자 전용이다. 403(운영자 아님)은 `hidden`, 화면은 아무것도 그리지 않는다.
//   3. 중계가 꺼져 있으면(409 `login_relay_off`) 화면은 셸 명령을 보인다(`off`).
//   4. 열기 전에 주소를 한 번 더 본다: https, 계정 정보 없음. 서버도 같은 일을 하지만 화면이 마지막 문이다.
// =============================================================================

import { ApiError } from "../../lib/api";
import { arrayField, bool, num, record, str } from "../../lib/wire";
import { settingsRequest } from "./api";

export type LoginFlow = "model" | "app";
export type LoginMode = "device" | "paste";
export type LoginStatusWord = "pending" | "submitted" | "done" | "failed" | "expired" | "cancelled";
export type LoginReason =
  | "state_mismatch"
  | "timeout"
  | "vendor_denied"
  | "exit_nonzero"
  | "exit_unsubmitted"
  | "cancelled"
  | "too_many_attempts"
  | "start_timeout"
  | "parse_failed"
  | "url_rejected"
  | "other";

/** 모델 인증이 고를 수 있는 구독 로그인. 값은 서버가 받는 provider 이름이다. */
export type ModelProvider = "openai-codex" | "anthropic";

export interface LoginTarget {
  readonly target: string;
  readonly connected: boolean;
}

export interface LoginStart {
  readonly loginId: string;
  readonly mode: LoginMode;
  readonly url: string;
  /** Codex 기기 코드. 이 응답에만 있다. 화면의 상태에만 두고 지울 때 지운다. */
  readonly userCode: string | null;
  /** 에포크 초. */
  readonly expiresAt: number;
}

export interface LoginStatus {
  readonly status: LoginStatusWord;
  readonly reason: LoginReason | null;
}

const STATUSES: readonly LoginStatusWord[] = ["pending", "submitted", "done", "failed", "expired", "cancelled"];
const REASONS: readonly LoginReason[] = [
  "state_mismatch",
  "timeout",
  "vendor_denied",
  "exit_nonzero",
  "exit_unsubmitted",
  "cancelled",
  "too_many_attempts",
  "start_timeout",
  "parse_failed",
  "url_rejected",
  "other",
];

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[]): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

export function targetsFromWire(value: unknown): LoginTarget[] | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.login_relay.targets.v0") return null;
  const list = arrayField(body, "targets");
  if (list === null) return null;
  const out: LoginTarget[] = [];
  for (const entry of list) {
    const name = str(entry, "target");
    const connected = bool(entry, "connected");
    if (name === undefined || connected === undefined) return null;
    out.push({ target: name, connected });
  }
  return out;
}

export function startFromWire(value: unknown): LoginStart | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.login_relay.start.v0") return null;
  const loginId = str(body, "loginId");
  const mode = oneOf(str(body, "mode"), ["device", "paste"] as const);
  const url = str(body, "url");
  const expiresAt = num(body, "expiresAt");
  if (loginId === undefined || mode === null || url === undefined || expiresAt === undefined) return null;
  const code = str(body, "userCode");
  return { loginId, mode, url, userCode: code === undefined || code === "" ? null : code, expiresAt };
}

export function statusFromLoginWire(value: unknown): LoginStatus | null {
  const body = record(value);
  if (!body || str(body, "schema") !== "momo.login_relay.status.v0") return null;
  const status = oneOf(str(body, "status"), STATUSES);
  if (status === null) return null;
  return { status, reason: oneOf(str(body, "reason"), REASONS) };
}

/** 끝난 상태인가(폴링을 멈추고 코드·입력을 지운다). */
export function isLoginEnded(status: LoginStatusWord): boolean {
  return status === "done" || status === "failed" || status === "expired" || status === "cancelled";
}

// ---- 읽기 --------------------------------------------------------------------

export type TargetsRead =
  | { readonly kind: "ready"; readonly targets: readonly LoginTarget[] }
  | { readonly kind: "hidden" }
  | { readonly kind: "off" }
  | { readonly kind: "not_cohosted" }
  | { readonly kind: "unknown" };

function base(workspaceId: string, agentId: string, flow: LoginFlow): string {
  const segment = flow === "model" ? "model-login" : "app-login";
  return `/v1/workspaces/${encodeURIComponent(workspaceId)}/agents/${encodeURIComponent(agentId)}/${segment}`;
}

function loginPath(workspaceId: string, agentId: string, flow: LoginFlow, loginId: string, tail = ""): string {
  return `${base(workspaceId, agentId, flow)}/${encodeURIComponent(loginId)}${tail}`;
}

export async function fetchLoginTargets(
  workspaceId: string,
  agentId: string,
  flow: LoginFlow
): Promise<TargetsRead> {
  try {
    const targets = targetsFromWire(await settingsRequest<unknown>(base(workspaceId, agentId, flow)));
    return targets === null ? { kind: "unknown" } : { kind: "ready", targets };
  } catch (error) {
    if (error instanceof ApiError) {
      // 403: 운영자가 아니거나 이 에이전트를 연결한 운영자가 아니다. 404/405: 이 서버에는 길이 없다.
      if (error.status === 403 || error.status === 404 || error.status === 405) return { kind: "hidden" };
      if (error.status === 409 && error.code === "login_relay_off") return { kind: "off" };
      if (error.status === 409 && error.code === "login_not_cohosted") return { kind: "not_cohosted" };
      return { kind: "unknown" };
    }
    // 서버가 답하지 못한 경우(연결 끊김)는 이 패널의 일이 아니다.
    return { kind: "hidden" };
  }
}

// ---- 쓰기 --------------------------------------------------------------------

export async function startLogin(
  workspaceId: string,
  agentId: string,
  flow: LoginFlow,
  name: string
): Promise<LoginStart> {
  const body = flow === "model" ? { provider: name } : { app: name };
  const parsed = startFromWire(
    await settingsRequest<unknown>(base(workspaceId, agentId, flow), {
      method: "POST",
      body: JSON.stringify(body),
    })
  );
  if (parsed === null) throw new ApiError(502, "unreadable login answer");
  return parsed;
}

export async function pollLogin(
  workspaceId: string,
  agentId: string,
  flow: LoginFlow,
  loginId: string
): Promise<LoginStatus> {
  const parsed = statusFromLoginWire(await settingsRequest<unknown>(loginPath(workspaceId, agentId, flow, loginId)));
  if (parsed === null) throw new ApiError(502, "unreadable login status");
  return parsed;
}

export async function cancelLogin(
  workspaceId: string,
  agentId: string,
  flow: LoginFlow,
  loginId: string
): Promise<void> {
  await settingsRequest<unknown>(loginPath(workspaceId, agentId, flow, loginId), { method: "DELETE" });
}

/**
 * 붙여넣은 값을 한 번 보낸다. **값은 이 함수 밖으로 나가지 않는다**: 돌려주는 것은 상태 낱말뿐이고
 * 던지는 오류는 고정 문장이다(서버 문장도 값을 되풀이하지 않지만, 여기서는 코드만 쓴다).
 */
export async function completeLogin(
  workspaceId: string,
  agentId: string,
  flow: LoginFlow,
  loginId: string,
  pasted: string
): Promise<LoginStatus> {
  const parsed = statusFromLoginWire(
    await settingsRequest<unknown>(loginPath(workspaceId, agentId, flow, loginId, "/complete"), {
      method: "POST",
      body: JSON.stringify({ pasted }),
    })
  );
  if (parsed === null) throw new ApiError(502, "unreadable login status");
  return parsed;
}

/** 붙여넣기 칸이 보내도 되는 모양인가(서버의 모양 검사와 같다: 비어 있지 않고, 2048자 이하, 줄바꿈 없음). */
export function pasteLooksSendable(value: string): boolean {
  return value.trim() !== "" && value.length <= 2048 && !/[\r\n]/.test(value);
}

// ---- 주소 -------------------------------------------------------------------

export interface SafeLoginUrl {
  readonly href: string;
  /** 강조해 보일 호스트. 사용자는 이 낱말을 보고 벤더 주소인지 판단한다. */
  readonly host: string;
}

/** https 이고 계정 정보가 없는 주소만 연다. 서버가 한 번 걸러도 화면이 한 번 더 본다. */
export function safeLoginUrl(raw: string, allowedHosts?: readonly string[]): SafeLoginUrl | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") return null;
    if (allowedHosts !== undefined && !allowedHosts.includes(parsed.hostname)) return null;
    return { href: parsed.href, host: parsed.host };
  } catch {
    return null;
  }
}

/** 모델 로그인이 여는 벤더 주소의 호스트(ADR-0203 증보 L2 ②, 서버 허용목록과 같다). 벤더가 바꾸면 함께 갱신한다. */
export const MODEL_LOGIN_HOSTS: readonly string[] = ["auth.openai.com", "claude.ai"];

/**
 * 화면이 셀 수 있는 수명(초). 서버 시각 `expiresAt`는 이 기기의 시계와 어긋날 수 있어서 시작 순간에 한 번만 길이로
 * 바꾼다(0 이하이거나 15분보다 길면 시계가 어긋난 것으로 보고 5분). 이후는 이 기기의 경과 시간만 쓴다.
 */
export function loginTtlSeconds(expiresAt: number, nowMs: number): number {
  const raw = expiresAt - nowMs / 1000;
  return raw > 0 && raw <= 900 ? Math.ceil(raw) : 300;
}

/** 남은 초. 지났으면 0. */
export function secondsLeft(expiresAt: number, nowMs: number): number {
  return Math.max(0, Math.ceil(expiresAt - nowMs / 1000));
}

// ---- 셸 대체 경로 -------------------------------------------------------------

/** 중계가 꺼져 있을 때 보여 주는 명령(ADR-0203 증보 L1 (c)). 값이 아니라 명령이다. */
export const MODEL_SHELL_COMMANDS: Readonly<Record<ModelProvider, string>> = {
  "openai-codex": "railway ssh -- hermes auth add openai-codex --type oauth --no-browser",
  anthropic: "railway ssh -- hermes auth add anthropic --type oauth --no-browser",
};

/** 앱 상세(플러그인 id)에서 Hermes의 MCP 서버 이름으로. 이 셋은 `mcp_login_probe.py` 경로가 필요하다(#4067). */
export const GOOGLE_APP_TARGETS: Readonly<Record<string, string>> = {
  "com.momo.plugins.gmail": "gmail",
  "com.momo.plugins.google-calendar": "google_calendar",
  "com.momo.plugins.google-drive": "google_drive",
};

export function appLoginTarget(pluginId: string): string | null {
  return GOOGLE_APP_TARGETS[pluginId] ?? null;
}

export function appShellCommand(app: string): string {
  return Object.values(GOOGLE_APP_TARGETS).includes(app)
    ? `railway ssh -- runuser -u hermes -- /opt/hermes/.venv/bin/python /opt/data/mcp_login_probe.py ${app}`
    : `railway ssh -- hermes mcp login -- ${app}`;
}

// ---- 문장 -------------------------------------------------------------------

export const MODEL_LOGIN_COPY = {
  title: "모델 인증",
  lead: "Hermes가 쓸 AI를 고르고 로그인해요. 로그인 정보는 Hermes에만 남고 oort에는 저장되지 않아요.",
  teamNote: "이 Hermes는 팀 전체가 함께 써요. 사용량은 로그인한 구독에서 나가요.",
  codexTitle: "Codex 로그인",
  codexDetail: "주소를 열고 화면의 기기 코드를 입력해요.",
  claudeTitle: "Claude 로그인",
  claudeDetail: "주소를 열고 돌아온 코드를 붙여넣어요.",
  keyTitle: "API 키",
  keyDetail: "API 키는 설정의 AI 화면에서 팀 키로 넣어요. 키는 이 서버에 저장되고 여기에는 나타나지 않아요.",
  relogin: "다시 로그인",
  connectedPill: "로그인됨",
  notConnectedPill: "로그인 안 됨",
  start: "로그인 시작",
  starting: "시작하는 중이에요",
  /** Claude 시작 전 한 줄(ADR-0203 증보 Q2). */
  claudeTerms: "이 로그인은 운영자 본인 구독이며 약관 책임은 운영자에게 있어요.",
  claudeTermsAction: "확인하고 시작",
  openUrl: "주소 열기",
  copyUrl: "주소 복사",
  copied: "복사했어요",
  hostLead: "열리는 곳",
  deviceCodeLabel: "기기 코드",
  copyCode: "코드 복사",
  deviceSteps: "주소를 열고 위 기기 코드를 입력해 승인해 주세요. 승인되면 이 화면이 알려 줘요.",
  pasteSteps: "주소를 열어 로그인하면 코드가 보여요. 그 값을 여기에 붙여넣어 주세요.",
  pasteLabel: "돌아온 코드",
  pasteHelp: "붙여넣은 값은 한 번 전달되고 바로 지워져요.",
  pasteSend: "붙여넣은 코드 보내기",
  pasteSending: "보내는 중이에요",
  waiting: "승인을 기다리고 있어요.",
  waitingPaste: "붙여넣을 코드를 기다리고 있어요.",
  submitted: "확인하고 있어요.",
  cancel: "취소",
  done: "로그인됐어요.",
  doneNext: "Hermes가 이 로그인으로 답하도록 모델이 이 서비스로 설정돼 있는지 확인해 주세요. 새 로그인이 바로 안 잡히면 Hermes를 다시 시작해 주세요.",
  again: "다시 시도",
  loading: "로그인 상태를 불러오고 있어요.",
  loadError: "로그인 상태를 불러오지 못했어요.",
  retry: "다시 불러오기",
  offline: "연결이 끊긴 동안에는 로그인할 수 없어요.",
  notCohosted: "같은 서버에 연결한 Hermes 에이전트에서만 로그인할 수 있어요.",
  shellLead: "이 서버에서는 화면 로그인이 꺼져 있어요. Railway 터미널에서 이 명령으로 로그인해 주세요.",
  shellCopy: "명령 복사",
  shellAfter: "명령이 안내하는 주소를 열고 코드를 입력하면 끝나요. 로그인 값은 oort를 지나지 않아요.",
} as const;

export const APP_LOGIN_COPY = {
  title: "로그인",
  lead: "이 앱이 쓰는 계정으로 로그인해요. 로그인 정보는 Hermes에만 남고 oort에는 저장되지 않아요.",
  start: "로그인",
  relogin: "다시 로그인",
  pasteSteps: "주소를 열어 로그인하면 브라우저 주소창이 바뀌어요. 그 주소 전체를 복사해 여기에 붙여넣어 주세요.",
  pasteLabel: "돌아온 주소",
  pasteHelp: "붙여넣은 주소는 한 번 전달되고 바로 지워져요.",
  pasteSend: "붙여넣은 주소 보내기",
  connected: "연결됨",
  notConnected: "연결 안 됨",
  loadError: "로그인 상태를 불러오지 못했어요.",
  externalTestingNote:
    "이 앱의 구글 OAuth가 테스트 모드(외부 사용자)라면 로그인이 7일쯤 뒤에 만료될 수 있어요. 만료되면 이 화면에서 다시 로그인하면 돼요.",
  expiryUnknown: "만료 시점은 알 수 없어요. 연결이 끊긴 것처럼 보이면 다시 로그인해 주세요.",
  shellLead: "이 서버에서는 화면 로그인이 꺼져 있어요. Railway 터미널에서 이 명령으로 로그인해 주세요.",
  shellCopy: "명령 복사",
} as const;

/** 고정 문장. 서버·값에서 온 낱말을 되풀이하지 않는다. */
export function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    switch (error.code) {
      case "login_relay_off":
        return "이 서버는 로그인 중계가 꺼져 있어요.";
      case "login_not_cohosted":
        return MODEL_LOGIN_COPY.notCohosted;
      case "login_in_progress":
        return "이 대상의 로그인이 이미 진행 중이에요. 끝내거나 취소한 뒤 다시 시작해 주세요.";
      case "connector_trial_members":
        return "앱 로그인은 사람 멤버가 한 명일 때만 할 수 있어요. 앱 토큰이 사람별로 나뉘지 않아요.";
      case "connector_trial_shared":
        return "같은 Hermes에 다른 에이전트가 연결돼 있어 앱 로그인을 열 수 없어요.";
      case "state_mismatch":
        return "붙여넣은 값이 이 로그인에서 받은 것이 아니에요. 열린 로그인 창의 값을 다시 복사해 주세요.";
      case "bad_paste":
      case "redirect_mismatch":
      case "extra_params":
        return "붙여넣은 값의 모양이 맞지 않아요. 로그인 창이 보여 준 값을 그대로 붙여넣어 주세요.";
      case "already_submitted":
      case "login_not_pending":
      case "not_paste_mode":
        return "지금은 값을 붙여넣을 수 없는 로그인이에요.";
      case "login_not_found":
        return "이 로그인은 없거나 이미 끝나서 지워졌어요. 처음부터 다시 시작해 주세요.";
      case "login_forbidden":
        return "다른 운영자가 시작한 로그인이에요.";
      default:
        break;
    }
    if (error.status === 403) return "로그인은 이 서버의 운영자만 할 수 있어요.";
    if (error.status === 429) return "너무 자주 시도했어요. 잠시 뒤에 다시 시도해 주세요.";
    if (error.status === 502) return "로그인을 시작하지 못했어요. 터미널 명령으로 로그인할 수 있어요.";
  }
  return "로그인하지 못했어요. 잠시 뒤에 다시 시도해 주세요.";
}

/** 끝난 로그인의 이유 한 줄(닫힌 낱말 집합). */
export function loginReasonLine(status: LoginStatus): string {
  switch (status.status) {
    case "done":
      return MODEL_LOGIN_COPY.done;
    case "expired":
      return "시간이 지나 로그인이 닫혔어요. 처음부터 다시 시작해 주세요.";
    case "cancelled":
      return "로그인을 취소했어요.";
    default:
      break;
  }
  switch (status.reason) {
    case "state_mismatch":
      return "붙여넣은 값이 이 로그인에서 받은 것이 아니었어요. 처음부터 다시 시작해 주세요.";
    case "vendor_denied":
      return "로그인 화면에서 승인되지 않았어요. 다시 시작해 주세요.";
    case "timeout":
      return "시간이 지나 로그인이 닫혔어요. 처음부터 다시 시작해 주세요.";
    case "too_many_attempts":
      return "붙여넣기를 여러 번 틀려서 로그인을 닫았어요. 처음부터 다시 시작해 주세요.";
    default:
      return "로그인이 끝나지 않았어요. 다시 시작해 주세요.";
  }
}
