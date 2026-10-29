import { ApiError } from "../../lib/api";
import { NetworkError } from "../../lib/http";
import {
  bool,
  num,
  record,
  str,
  stringArrayField,
  WireShapeError,
} from "../../lib/wire";
import { DEFAULT_ROLE_LABELS } from "../directory/model";
import { oauthRequestExpiry } from "../hostedAgents/oauthConsent";

// =============================================================================
// 명령줄(oort CLI) 브라우저 로그인 동의 (ADR-0216 D6-나, #4700).
//
// 터미널의 `oort login`이 브라우저를 열면 서버가 서명한 요청 봉투 하나를 이 화면
// (`/oauth/cli?request=`)으로 넘기고, 로그인한 사람이 여기서 허용·거절을 정한다.
// 이 파일은 그 화면의 **판정과 문구**만 든다(모양은 hostedAgents/oauthConsent.ts와
// 같다). 화면은 그 위에 얇게 얹힌다.
//
// ## 규율 1: 화면이 아는 것은 서버가 preview로 돌려준 사실뿐이다
//
// URL에서 읽는 것은 서버가 서명한 opaque `request` 하나다. 클라이언트 이름·서버
// 호스트·워크스페이스·승인하는 나·범위는 전부 preview 응답에서 오고, 파서는 스프레드
// 가 아니라 이름 붙은 필드를 다시 짓는다. 비밀값은 어느 타입에도 실리지 않는다.
//
// ## 규율 2: 기기 이름은 연결하는 쪽이 정한 값이다
//
// `deviceName`은 CLI가 자기를 부른 이름이고 서버가 보증하지 않는다. 그래서 화면은
// 늘 그 사실을 같이 말하고(ADR-0180 C9), 글자는 보이는 모양을 속일 수 있는 제어·방향
// 문자를 걷어낸 뒤에만 그린다(`displayDeviceName`). 이 값과 서버 호스트를 터미널에
// 보이는 값과 대조하게 하는 것이 중계 피싱(ADR-0216 T4)의 방어다.
//
// ## 규율 3: 결정 뒤에 따라갈 곳은 이 기기의 루프백 콜백뿐이다
//
// 서버가 돌려준 `redirectTo`가 `http://127.0.0.1:<포트>/callback` 모양이 아니면
// 따라가지 않는다(`safeCliRedirect`). 서버를 믿더라도 브라우저를 다른 곳으로 보내는
// 마지막 한 걸음은 이 모양으로만 열린다.
// =============================================================================

// ---- 범위 -------------------------------------------------------------------

export const CLI_SCOPE_IDENTITY = "dev:identity";
export const CLI_SCOPE_CHANNELS_READ = "dev:channels:read";
export const CLI_SCOPE_MESSAGES_READ = "dev:messages:read";
export const CLI_SCOPE_MESSAGES_WRITE = "dev:messages:write";
export const CLI_SCOPE_INBOX_READ = "dev:inbox:read";

/** 서버 `DEV_SCOPES`와 같은 이름·같은 순서(openapi `DevScope`). */
export const CLI_SCOPES = [
  CLI_SCOPE_IDENTITY,
  CLI_SCOPE_CHANNELS_READ,
  CLI_SCOPE_MESSAGES_READ,
  CLI_SCOPE_MESSAGES_WRITE,
  CLI_SCOPE_INBOX_READ,
] as const;

export type CliScope = (typeof CLI_SCOPES)[number];

const READ_ONLY_SCOPES: readonly CliScope[] = [
  CLI_SCOPE_IDENTITY,
  CLI_SCOPE_CHANNELS_READ,
  CLI_SCOPE_MESSAGES_READ,
  CLI_SCOPE_INBOX_READ,
];

export function isCliScope(value: string): value is CliScope {
  return (CLI_SCOPES as readonly string[]).includes(value);
}

/** 이 빌드가 이름을 아는 범위만, 정규 순서로, 중복 없이. */
function keepKnownScopes(raw: readonly string[]): CliScope[] {
  const wanted = new Set<CliScope>();
  for (const scope of raw) {
    if (isCliScope(scope)) wanted.add(scope);
  }
  return CLI_SCOPES.filter((scope) => wanted.has(scope));
}

// ---- preview 응답 -----------------------------------------------------------

/**
 * 동의 화면이 사람에게 보여 줄 사실 전부. **전부 서버에서 왔고**, 비밀값은 없다.
 * `deviceName`은 화면에 그려도 되는 모양으로 이미 걸렀고, 보내지 않았으면 null이다.
 */
export interface CliConsentPreview {
  clientName: string;
  serverHost: string;
  workspaceName: string;
  memberDisplayName: string;
  /** 서버가 보낸 역할을 한글로 푼 것. 모르는 역할이면 null(이름만 그린다). */
  roleLabel: string | null;
  deviceName: string | null;
  /** 요청이 담은 범위(이 빌드가 아는 것만). 허용할 수 있는 범위의 상한이다. */
  requestedScopes: CliScope[];
  /** 「읽기와 보내기」를 고를 수 있는가: 서버가 true라 했고 요청에 쓰기가 있을 때만. */
  canSend: boolean;
  expiresAtMs: number;
  accessMinutes: number;
  idleDays: number;
  maxDays: number;
}

function isDisplayUnsafe(codePoint: number): boolean {
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    (codePoint >= 0x200b && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2060 && codePoint <= 0x2064) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069) ||
    codePoint === 0xfeff
  );
}

/**
 * 연결하는 쪽이 정한 기기 이름을 화면에 그려도 되는 모양으로 건다. 제어 문자와
 * 보이는 순서를 뒤집거나 글자를 숨기는 방향·너비 없는 문자를 걷어내고 공백을 한
 * 칸으로 모은다. 남는 것이 없으면 null(이름을 보내지 않은 것과 같다).
 */
export function displayDeviceName(raw: string): string | null {
  const spaced = raw.replace(/\s+/g, " ");
  const kept = Array.from(spaced)
    .filter((char) => !isDisplayUnsafe(char.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return kept === "" ? null : kept;
}

function roleLabelOf(role: string | undefined): string | null {
  if (role === undefined) return null;
  return Object.prototype.hasOwnProperty.call(DEFAULT_ROLE_LABELS, role)
    ? DEFAULT_ROLE_LABELS[role as keyof typeof DEFAULT_ROLE_LABELS]
    : null;
}

/**
 * preview 한 줄을 이름 붙은 필드로 다시 짓는다 (규율 1). 필수 칸이 하나라도 빠지면
 * 반쯤 그린 화면 대신 `WireShapeError`를 던진다: 신뢰를 내주는 자리라 읽지 못한
 * 필드가 있으면 아무것도 그리지 않는 것이 맞다.
 */
export function parseCliConsentPreview(wire: unknown): CliConsentPreview {
  const row = record(wire);
  const clientName = str(row, "clientName");
  const serverHost = str(row, "serverHost");
  const workspaceName = str(row, "workspaceName");
  const memberDisplayName = str(row, "memberDisplayName");
  const requestedRaw = stringArrayField(row, "requestedScopes");
  const canSendWire = bool(row, "canSend");
  const expiresAtMs = num(row, "expiresAtMs");
  const accessMinutes = num(row, "accessMinutes");
  const idleDays = num(row, "idleDays");
  const maxDays = num(row, "maxDays");
  const rawDeviceName = row?.deviceName;
  if (
    !clientName ||
    !serverHost ||
    !workspaceName ||
    !memberDisplayName ||
    requestedRaw === null ||
    canSendWire === undefined ||
    expiresAtMs === undefined ||
    accessMinutes === undefined ||
    idleDays === undefined ||
    maxDays === undefined ||
    (rawDeviceName !== undefined &&
      rawDeviceName !== null &&
      typeof rawDeviceName !== "string")
  ) {
    throw new WireShapeError();
  }
  const requestedScopes = keepKnownScopes(requestedRaw);
  // 아는 범위가 하나도 없는 요청은 허용해도 열리는 것이 없다. 그 버튼을 그리지 않는다.
  if (requestedScopes.length === 0) throw new WireShapeError();
  return {
    clientName,
    serverHost,
    workspaceName,
    memberDisplayName,
    roleLabel: roleLabelOf(str(row, "role")),
    deviceName:
      typeof rawDeviceName === "string" ? displayDeviceName(rawDeviceName) : null,
    requestedScopes,
    canSend: canSendWire && requestedScopes.includes(CLI_SCOPE_MESSAGES_WRITE),
    expiresAtMs,
    accessMinutes,
    idleDays,
    maxDays,
  };
}

// ---- 허용 범위(프리셋 둘) ---------------------------------------------------

/** 고르는 것은 프리셋 둘뿐이다. 채널 고르기는 이번 범위 밖이다(ADR-0216 후속). */
export type CliScopePreset = "read" | "read-send";

export const CLI_DEFAULT_PRESET: CliScopePreset = "read";

/** 프리셋을 허용했을 때 실제로 열리는 범위: 읽기만은 요청 ∩ 읽기, 보내기는 요청 전체. */
export function cliGrantedScopes(
  requested: readonly CliScope[],
  preset: CliScopePreset
): CliScope[] {
  if (preset === "read-send") return [...requested];
  return requested.filter((scope) => READ_ONLY_SCOPES.includes(scope));
}

export interface CliScopePresetChoice {
  id: CliScopePreset;
  label: string;
  detail: string;
  disabled?: boolean;
}

const SCOPE_PLAIN: Record<CliScope, string> = {
  [CLI_SCOPE_IDENTITY]: "내가 누구인지 확인",
  [CLI_SCOPE_CHANNELS_READ]: "채널 목록 읽기",
  [CLI_SCOPE_MESSAGES_READ]: "채널의 메시지와 스레드 읽기",
  [CLI_SCOPE_MESSAGES_WRITE]: "내 이름으로 메시지 보내기",
  [CLI_SCOPE_INBOX_READ]: "받은 편지함 읽기",
};

/** 허용했을 때 열리는 일을 사람 말로, 정규 순서로. */
export function cliScopeSentences(granted: readonly CliScope[]): string[] {
  return CLI_SCOPES.filter((scope) => granted.includes(scope)).map(
    (scope) => SCOPE_PLAIN[scope]
  );
}

/**
 * 프리셋 둘과 그 설명. 설명은 **이 요청이 실제로 담은 범위**에서 풀어쓴다: 요청에
 * 받은 편지함이 없으면 「읽기만」의 설명에도 없다. 그래서 고르는 줄이 곧 허용되는
 * 일의 목록이고, 따로 결과 상자를 두지 않는다.
 */
export function cliScopePresetChoices(
  preview: Pick<CliConsentPreview, "canSend" | "requestedScopes">
): CliScopePresetChoice[] {
  const reads = cliScopeSentences(cliGrantedScopes(preview.requestedScopes, "read"));
  const readSend = cliScopeSentences(
    cliGrantedScopes(preview.requestedScopes, "read-send")
  );
  return [
    {
      id: "read",
      label: CLI_PRESET_READ_LABEL,
      detail: `${reads.join(CLI_SCOPE_JOINER)}. ${CLI_PRESET_READ_CLOSED}`,
    },
    {
      id: "read-send",
      label: CLI_PRESET_SEND_LABEL,
      detail: preview.canSend
        ? `${readSend.join(CLI_SCOPE_JOINER)}. ${CLI_PRESET_SEND_CAUTION}`
        : CLI_PRESET_SEND_UNAVAILABLE,
      ...(preview.canSend ? {} : { disabled: true }),
    },
  ];
}

/** 고른 프리셋을 쓸 수 있는 값으로 접는다. 고를 수 없는 프리셋은 「읽기만」으로 돌아간다. */
export function effectiveCliPreset(
  preset: CliScopePreset,
  preview: Pick<CliConsentPreview, "canSend">
): CliScopePreset {
  return preset === "read-send" && !preview.canSend ? "read" : preset;
}

// ---- 전송 본문 --------------------------------------------------------------

/**
 * approve 본문. 「읽기만」은 `approvedScopes`를 **싣지 않는다**: 서버는 생략을
 * 「읽기만 ∩ 요청」으로 읽고, 빈 배열이나 null은 400이다. 「읽기와 보내기」는
 * 요청 범위 전체를 싣는다(서버가 허용 ⊆ 요청을 다시 검사한다).
 */
export interface CliApproveRequest {
  request: string;
  currentPassword: string;
  approvedScopes?: CliScope[];
}

export interface CliDenyRequest {
  request: string;
}

export function buildCliApprove(input: {
  request: string;
  currentPassword: string;
  preset: CliScopePreset;
  requestedScopes: readonly CliScope[];
}): CliApproveRequest {
  const body: CliApproveRequest = {
    request: input.request,
    currentPassword: input.currentPassword,
  };
  if (input.preset === "read-send") body.approvedScopes = [...input.requestedScopes];
  return body;
}

export function buildCliDeny(request: string): CliDenyRequest {
  return { request };
}

// ---- 결정 응답과 돌아갈 곳 --------------------------------------------------

/**
 * 따라가도 되는 콜백 주소면 그 주소를 직렬화한 문자열, 아니면 null (규율 3).
 *
 * 맞아야 하는 것: scheme `http`, 호스트 정확히 `127.0.0.1`, 포트 명시, 경로 정확히
 * `/callback`, 계정 정보(`user@`) 없음, 조각(`#`) 없음. `localhost`·`[::1]`·https·
 * 다른 경로는 모두 거절이다. 포트 목록은 서버가 정확 일치로 쥐고 있어 여기 복사하지
 * 않는다. 돌려주는 값은 입력 문자열이 아니라 파서가 직렬화한 `href`다: 검사한 것과
 * 브라우저가 여는 것이 같은 한 줄이 되게 한다.
 */
export function safeCliRedirect(redirectTo: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(redirectTo);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.port === "" ||
    parsed.pathname !== "/callback" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.hash !== ""
  ) {
    return null;
  }
  return parsed.href;
}

/** 서버가 200으로 답했지만 따라갈 수 있는 돌아갈 곳이 아니다. 결정은 이미 기록됐다. */
export class CliRedirectRefusedError extends Error {
  constructor() {
    super("redirect refused");
    this.name = "CliRedirectRefusedError";
  }
}

export interface CliDecisionResult {
  /** 안전하다고 확인한 루프백 콜백(`code`/`error`·`state`·`iss`만 싣는다). */
  redirectTo: string;
}

/**
 * decision 응답을 읽는다. 허용과 거절 모두 `{redirectTo}`다. 칸이 없으면
 * `WireShapeError`, 안전한 콜백이 아니면 `CliRedirectRefusedError`: 둘 다 서버가
 * 이미 결정을 기록한 뒤라 화면은 다시 시도시키지 않고 종료로 접는다.
 */
export function parseCliDecision(wire: unknown): CliDecisionResult {
  const redirectTo = str(record(wire), "redirectTo");
  if (!redirectTo) throw new WireShapeError();
  const safe = safeCliRedirect(redirectTo);
  if (safe === null) throw new CliRedirectRefusedError();
  return { redirectTo: safe };
}

// ---- 오류 ------------------------------------------------------------------

/**
 * 서버가 이름 붙여 거절한 `ApiError`. 429·503이 `Retry-After`로 알려 준 기다릴 초를
 * 함께 든다(오류 본문에는 초가 없다).
 */
export class CliLoginApiError extends ApiError {
  readonly retryAfterSeconds: number | undefined;
  constructor(
    status: number,
    message: string,
    code: string | undefined,
    retryAfterSeconds?: number
  ) {
    super(status, message, code);
    this.name = "CliLoginApiError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** 서버가 확정한 거절 코드(`error.code`). 문장은 바뀔 수 있어도 코드는 그렇지 않다. */
export const CLI_ERROR_ACCESS_DENIED = "dev_access_denied";
export const CLI_ERROR_PASSWORD_INCORRECT = "current_password_incorrect";
export const CLI_ERROR_PASSWORD_UNAVAILABLE = "current_password_unavailable";
export const CLI_ERROR_REQUEST_NOT_FOUND = "dev_login_request_not_found";
export const CLI_ERROR_ALREADY_DECIDED = "dev_login_already_decided";
export const CLI_ERROR_CREDENTIAL_LIMIT = "dev_credential_limit";

export type CliConsentAction = "preview" | "approve" | "deny";

/** 그 자리에서 끝나는 화면. 다시 눌러도 달라지지 않는다. */
export type CliTerminalKind =
  | "not-found"
  | "already-decided"
  | "access-denied"
  | "password-unavailable"
  | "redirect-refused"
  | "expired";

function retryAfterOf(error: unknown): number | undefined {
  return error instanceof CliLoginApiError ? error.retryAfterSeconds : undefined;
}

/** 「N초 뒤」·「약 N분 뒤」. 모르면 null. */
export function cliRetryWhen(seconds: number | undefined): string | null {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 1) return null;
  const whole = Math.ceil(seconds);
  if (whole <= 90) return `${whole}초 뒤`;
  return `약 ${Math.ceil(whole / 60)}분 뒤`;
}

function waitSentence(error: unknown): string {
  const when = cliRetryWhen(retryAfterOf(error));
  return when === null
    ? CLI_CONSENT_RETRY_LATER
    : `${when}에 다시 시도해 주세요.`;
}

/**
 * 거절이 아닌 실패(막힌 것이 아니라 다시 해 볼 수 있는 것)를 한 문장으로.
 * STATUS와 코드로만 가르고 서버 문장은 이어 붙이지 않는다.
 */
export function cliConsentFailureMessage(
  action: CliConsentAction,
  error: unknown
): string {
  const prefix = cliActionPrefix(action);
  if (error instanceof NetworkError) return `${prefix} ${error.message}`;
  if (error instanceof WireShapeError) return `${prefix} ${CLI_CONSENT_RERUN}`;
  if (error instanceof ApiError) {
    if (error.status === 400) return `${prefix} ${CLI_CONSENT_RERUN}`;
    if (error.status === 429) {
      return `${prefix} 요청이 너무 잦아요. ${waitSentence(error)}`;
    }
    if (error.status === 503) {
      return `${prefix} 서버가 잠깐 바빠요. ${waitSentence(error)}`;
    }
    if (error.status === 409 && error.code === CLI_ERROR_CREDENTIAL_LIMIT) {
      return CLI_CONSENT_CREDENTIAL_LIMIT;
    }
  }
  return `${prefix} ${CLI_CONSENT_RETRY_LATER}`;
}

function cliActionPrefix(action: CliConsentAction): string {
  switch (action) {
    case "preview":
      return "로그인 요청을 불러오지 못했어요.";
    case "approve":
      return "허용을 저장하지 못했어요.";
    case "deny":
      return "거절을 저장하지 못했어요.";
  }
}

/** 로그인 세션이 끝난 경우. 화면은 이때만 다시 로그인으로 되돌린다. */
export function isCliSessionExpired(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/**
 * 어떤 오류든 「이 요청은 여기서 끝났다」로 접히는 것이면 그 종류.
 *
 *   404 → 없는 요청(만료·위조·꺼짐·다른 종류는 서버가 한 문장으로 답한다)
 *   409 → 이미 처리됨. 코드가 `dev_credential_limit`이면 여기가 아니다.
 *   403 → 코드가 비밀번호 쪽이면 각자 자리로, 그 밖의 403은 이 워크스페이스에서
 *         이 사람이 만들 수 없는 것으로 접는다.
 *   돌아갈 곳이 안전하지 않음 → 결정이 이미 기록된 뒤라 다시 시도시키지 않는다.
 * 그 밖(401·429·503·400·네트워크·읽지 못한 preview)은 null이다. 결정 응답을 읽지
 * 못한 경우는 `classifyCliDecisionError`가 같은 종료로 접는다.
 */
export function cliTerminalOf(error: unknown): CliTerminalKind | null {
  if (error instanceof CliRedirectRefusedError) return "redirect-refused";
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) return "not-found";
  if (error.status === 409) {
    return error.code === CLI_ERROR_CREDENTIAL_LIMIT ? null : "already-decided";
  }
  if (error.status === 403) {
    if (error.code === CLI_ERROR_PASSWORD_INCORRECT) return null;
    if (error.code === CLI_ERROR_PASSWORD_UNAVAILABLE) return "password-unavailable";
    return "access-denied";
  }
  return null;
}

export type CliDecisionOutcome =
  | { kind: "session-expired" }
  | { kind: "terminal"; terminal: CliTerminalKind }
  | { kind: "wrong-password" }
  | { kind: "failure"; message: string };

/**
 * 결정(허용·거절) 실패를 어떻게 접는가.
 *
 *   401 → 로그인으로 되돌린다.
 *   403 `current_password_incorrect` → 폼에 남아 비밀번호만 다시 받는다.
 *   종료로 접히는 것(`cliTerminalOf`) → 종료 화면.
 *   그 밖 → 폼 위 배너로 사유와 기다릴 시간을 말한다.
 */
export function classifyCliDecisionError(
  action: Exclude<CliConsentAction, "preview">,
  error: unknown
): CliDecisionOutcome {
  if (isCliSessionExpired(error)) return { kind: "session-expired" };
  if (
    error instanceof ApiError &&
    error.status === 403 &&
    error.code === CLI_ERROR_PASSWORD_INCORRECT
  ) {
    return { kind: "wrong-password" };
  }
  // 200인데 읽을 수 없는 응답: 서버가 결정을 기록했을 수 있어 다시 누르게 하지 않는다.
  if (error instanceof WireShapeError) {
    return { kind: "terminal", terminal: "redirect-refused" };
  }
  const terminal = cliTerminalOf(error);
  if (terminal !== null) return { kind: "terminal", terminal };
  return { kind: "failure", message: cliConsentFailureMessage(action, error) };
}

// ---- 화면 선택 (순수) -------------------------------------------------------

export type CliConsentScreen =
  | { kind: "loading" }
  | { kind: "returning" }
  | { kind: "form" }
  | { kind: "terminal"; terminal: CliTerminalKind }
  | { kind: "retry"; message: string };

export interface CliConsentScreenInput {
  /** 결정(허용·거절)이 낸 종료. 있으면 폼으로 되돌아가지 않는다. */
  decisionTerminal: CliTerminalKind | null;
  /** 결정이 성공해 터미널로 돌아가는 중. */
  returning: boolean;
  previewPending: boolean;
  /** preview 오류. 성공·대기면 null. */
  previewError: unknown;
  data: CliConsentPreview | null;
  nowMs: number;
}

/**
 * 지금 그릴 화면. 우선순위가 곧 보안이다: 결정이 이미 종료를 냈으면 되돌아갈 폼이
 * 없고, 401은 (라우트 효과가 로그인으로 되돌리므로) 로딩으로 덮여 재시도 배너를
 * 그리지 않으며, 만료된 요청에는 허용 버튼을 세우지 않는다.
 */
export function cliConsentScreen(input: CliConsentScreenInput): CliConsentScreen {
  if (input.decisionTerminal !== null) {
    return { kind: "terminal", terminal: input.decisionTerminal };
  }
  if (input.returning) return { kind: "returning" };
  if (input.previewPending) return { kind: "loading" };
  if (input.previewError !== null && input.previewError !== undefined) {
    if (isCliSessionExpired(input.previewError)) return { kind: "loading" };
    const terminal = cliTerminalOf(input.previewError);
    if (terminal !== null) return { kind: "terminal", terminal };
    return {
      kind: "retry",
      message: cliConsentFailureMessage("preview", input.previewError),
    };
  }
  if (input.data === null) return { kind: "loading" };
  if (oauthRequestExpiry(input.data.expiresAtMs, input.nowMs).expired) {
    return { kind: "terminal", terminal: "expired" };
  }
  return { kind: "form" };
}

export interface CliDecideEnablement {
  /** 비밀번호 칸에 무엇이든 들어 있다(허용에만 필요하다). */
  hasPassword: boolean;
  offline: boolean;
  /** 허용·거절 요청이 떠 있다. */
  busy: boolean;
  /** 이미 하나의 결정을 냈다(중복 방지 ref). */
  decided: boolean;
}

/** 허용을 지금 누를 수 있는가. 비밀번호가 있고 셋 모두 막지 않을 때만. */
export function cliCanApprove(input: CliDecideEnablement): boolean {
  return input.hasPassword && !input.offline && !input.busy && !input.decided;
}

/** 거절은 비밀번호 없이도 누를 수 있다. 거절은 아무 권한도 열지 않는다. */
export function cliCanDeny(input: Omit<CliDecideEnablement, "hasPassword">): boolean {
  return !input.offline && !input.busy && !input.decided;
}

// ---- 문구 -------------------------------------------------------------------

export const CLI_CONSENT_TITLE = "터미널 로그인 승인";

export const CLI_CONSENT_LEAD =
  "터미널의 oort CLI가 내 계정으로 이 워크스페이스에 연결하려고 해요.";

/** 중계 피싱을 막는 한 줄(ADR-0216 T4): 터미널에 보이는 값과 대조한다. */
export const CLI_CONSENT_CHECK_NOTE =
  "터미널에 표시된 서버 주소와 기기 이름이 아래와 같을 때만 허용해 주세요. 다르거나 내가 시작한 로그인이 아니면 허용하지 말고 거절해 주세요.";

export const CLI_CONSENT_CLIENT_KEY = "클라이언트";
export const CLI_CONSENT_HOST_KEY = "서버 호스트";
export const CLI_CONSENT_DEVICE_KEY = "기기 이름";
export const CLI_CONSENT_DEVICE_MISSING = "기기 이름을 보내지 않았어요";
export const CLI_CONSENT_WORKSPACE_KEY = "워크스페이스";
export const CLI_CONSENT_MEMBER_KEY = "승인하는 사람";

/** 기기 이름이 보증된 값이 아니라는 사실. 이름이 있든 없든 늘 붙는다. */
export const CLI_CONSENT_DEVICE_NOTE = "기기 이름은 연결하는 쪽이 정한 값이에요.";

export const CLI_PRESET_LEGEND = "허용할 범위";
export const CLI_PRESET_HINT =
  "허용한 뒤에는 범위를 바꿀 수 없어서, 바꾸려면 새로 연결해야 해요.";
export const CLI_PRESET_READ_LABEL = "읽기만";
export const CLI_PRESET_SEND_LABEL = "읽기와 보내기";
/** 설명 안에서 허용되는 일들을 잇는 구분자. */
export const CLI_SCOPE_JOINER = " · ";
export const CLI_PRESET_READ_CLOSED = "보내기, 고치기, 지우기와 설정 변경은 할 수 없어요.";
export const CLI_PRESET_SEND_CAUTION =
  "보낸 메시지는 바로 전송되고 고치거나 지울 수 없어요. 멘션은 에이전트를 깨울 수 있어요.";
export const CLI_PRESET_SEND_UNAVAILABLE =
  "이 로그인 요청에는 메시지 보내기가 들어 있지 않아서 고를 수 없어요.";

/** 연결의 수명. 숫자는 서버가 preview로 준 값이다. */
export function cliConsentLifetime(preview: {
  maxDays: number;
  idleDays: number;
  accessMinutes: number;
}): string {
  return `연결은 최대 ${preview.maxDays}일 유지되고, ${preview.idleDays}일 동안 쓰지 않으면 끊겨요. 로그인 상태는 ${preview.accessMinutes}분마다 자동으로 갱신돼요. 비밀번호를 바꾸면 이 연결도 바로 끊겨요.`;
}

export const CLI_CONSENT_PASSWORD_LABEL = "현재 비밀번호";
export const CLI_CONSENT_PASSWORD_HINT =
  "허용하기 전에 내 비밀번호를 한 번 더 확인해요.";
export const CLI_CONSENT_PASSWORD_WRONG =
  "비밀번호가 맞지 않아요. 다시 입력해 주세요.";

export const CLI_CONSENT_APPROVE_LABEL = "허용";
export const CLI_CONSENT_APPROVE_BUSY = "허용 중";
export const CLI_CONSENT_DENY_LABEL = "거절";
export const CLI_CONSENT_DENY_BUSY = "거절 중";

export const CLI_CONSENT_OFFLINE_NOTE =
  "연결이 끊겼어요. 허용과 거절은 다시 연결된 뒤에 할 수 있어요.";

export const CLI_CONSENT_RETRY_LATER = "잠시 뒤에 다시 시도해 주세요.";

/** 다시 눌러도 달라지지 않는 실패의 다음 걸음. */
export const CLI_CONSENT_RERUN = "터미널에서 oort login을 다시 실행해 주세요.";

export const CLI_CONSENT_CREDENTIAL_LIMIT =
  "이 계정으로 로그인한 기기가 너무 많아요. 쓰지 않는 기존 연결을 정리한 뒤 다시 시도해 주세요.";

/** 결정 뒤 터미널로 돌아가는 짧은 종료. */
export const CLI_CONSENT_RETURNING =
  "결정을 저장했어요. 터미널로 돌아가는 중이에요.";

export const CLI_CONSENT_SIGNIN_DETAIL =
  "이 로그인 요청을 확인하려면 먼저 이 워크스페이스에 로그인해야 해요. 로그인하면 이 요청으로 돌아와요.";

export const CLI_CONSENT_LOADING_SR = "로그인 요청을 불러오는 중이에요.";

export const CLI_CONSENT_RETRY_ACTION = "다시 시도";
export const CLI_CONSENT_DISMISS_ACTION = "닫기";

export interface CliTerminalCopy {
  headline: string;
  detail: string;
}

/** 종료 화면의 문구. 모두 「아무것도 허용되지 않았다」를 먼저 말한다. */
export const CLI_TERMINAL_COPY: Readonly<Record<CliTerminalKind, CliTerminalCopy>> = {
  "not-found": {
    headline: "요청이 만료됐거나 올바르지 않아요.",
    detail:
      "이 화면에서는 아무것도 허용되지 않았어요. 터미널에서 oort login을 다시 실행해 주세요.",
  },
  expired: {
    headline: "이 로그인 요청이 만료됐어요.",
    detail:
      "만료된 요청은 허용할 수 없어요. 터미널에서 oort login을 다시 실행해 주세요.",
  },
  "already-decided": {
    headline: "이미 처리된 요청이에요.",
    detail:
      "결정은 한 번만 기록돼요. 필요하면 터미널에서 oort login을 다시 실행해 주세요.",
  },
  "access-denied": {
    headline: "이 워크스페이스에서는 명령줄 접근을 만들 수 없어요.",
    detail:
      "관리자가 허용해야 쓸 수 있어요. 필요하면 워크스페이스 관리자에게 문의해 주세요. 이 화면에서는 아무것도 허용되지 않았어요.",
  },
  "password-unavailable": {
    headline: "이 계정은 비밀번호를 확인할 수 없어요.",
    detail:
      "이 계정에는 비밀번호가 없어서 허용 전에 확인할 수 없어요. 지금은 이 방법으로 명령줄에 연결할 수 없고, 이 화면에서는 아무것도 허용되지 않았어요.",
  },
  "redirect-refused": {
    headline: "터미널로 돌아갈 주소를 확인하지 못했어요.",
    detail:
      "서버 응답에서 이 기기의 터미널(127.0.0.1)로 돌아가는 주소를 확인하지 못해서 따라가지 않았어요. 터미널에서 oort login을 다시 실행해 주세요.",
  },
};
