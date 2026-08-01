import { ApiError, type MembershipRole } from "@/lib/api";
import { NetworkError } from "@/lib/http";

// =============================================================================
// 에이전트 만들기 model (goal B5.3b, D-4). Everything the form decides without
// React lives here, so the rules are under test rather than inside a component.
//
// The rules are not invented. Each one is the server's own gate, read off the
// route that will run it (`routes/agents.rs::create` → `momo_settings::{
// normalized_join_display_name, normalized_requested_handle, validated_base_url}`
// and `momo_agent::{normalized_model, normalized_system_prompt,
// validate_agent_profile}`), which are in turn the Swift contract. A client that
// accepts what the server rejects turns a typo into an English 400 the reader
// cannot act on; a client that rejects what the server accepts makes a legal
// value look broken. Both are the same bug, and the channel form (features/
// channels/model.ts) already settled that this is where the rule lives.
//
// ONE rule is deliberately not mirrored: whether a loopback endpoint is allowed.
// That depends on the server's environment and its
// AGENT_PROVIDER_ALLOW_LOCAL_LOOPBACK flag, neither of which this client can
// read. Guessing either way would be a client-side policy nobody wrote, so a
// well-shaped loopback URL is accepted here and the server keeps the last word.
// =============================================================================

/** 다이얼로그를 닫아도 남는 입력. 지운 적 없는 글은 지워지지 않는다. */
export interface AgentDraft {
  displayName: string;
  handle: string;
  model: string;
  baseUrl: string;
  instructions: string;
}

export const EMPTY_AGENT_DRAFT: AgentDraft = {
  displayName: "",
  handle: "",
  model: "",
  baseUrl: "",
  instructions: "",
};

export const DISPLAY_NAME_MAX = 100;
export const HANDLE_MIN = 2;
export const HANDLE_MAX = 32;
export const MODEL_MAX = 200;
/** `normalized_system_prompt`: UTF-8 BYTES, not characters. */
export const SYSTEM_PROMPT_MAX_BYTES = 32_768;
/** `validate_agent_profile`: instructions are bounded in bytes too. */
export const INSTRUCTIONS_MAX_BYTES = 8_192;

/** Server alphabet, verbatim (`is_valid_handle`). */
const HANDLE_RE = /^[a-z0-9_-]+$/;

export type AgentDisplayNameIssue = "required" | "tooLong";
export type AgentHandleIssue = "required" | "length" | "unsupportedCharacters";
export type AgentModelIssue = "required" | "tooLong";
export type AgentBaseUrlIssue =
  | "required"
  | "shape"
  | "scheme"
  | "mockHost"
  | "plaintextRemote";
export type AgentTextIssue = "tooLong";

/** UTF-8 length, which is the unit both byte-bounded server fields use. */
export function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function normalizeAgentHandle(raw: string): string {
  return raw.trim().toLowerCase();
}

export function agentDisplayNameIssue(raw: string): AgentDisplayNameIssue | null {
  const value = raw.trim();
  if (value === "") return "required";
  // Characters, not bytes: the server counts `chars()`, so a 100자 Korean name
  // is legal even though it is 300 bytes.
  return [...value].length > DISPLAY_NAME_MAX ? "tooLong" : null;
}

export function agentHandleIssue(raw: string): AgentHandleIssue | null {
  const value = normalizeAgentHandle(raw);
  if (value === "") return "required";
  // Alphabet before length: "쓸 수 없는 글자" is the more actionable of the two
  // when a Korean handle is typed, and length would otherwise claim a 한글 handle
  // is merely too short.
  if (!HANDLE_RE.test(value)) return "unsupportedCharacters";
  const length = [...value].length;
  return length < HANDLE_MIN || length > HANDLE_MAX ? "length" : null;
}

export function agentModelIssue(raw: string): AgentModelIssue | null {
  const value = raw.trim();
  if (value === "") return "required";
  return [...value].length > MODEL_MAX ? "tooLong" : null;
}

interface UrlShape {
  scheme: string;
  host: string;
  hasUserinfo: boolean;
}

/**
 * The server's `split_url`, reduced to the three facts the gate above it reads.
 * `URL` is not used: it accepts `mailto:` and userinfo without complaint and
 * normalises away exactly the parts this gate exists to refuse.
 */
function splitUrl(raw: string): UrlShape | null {
  const value = raw.trim();
  const separator = value.indexOf("://");
  if (separator <= 0) return null;
  const scheme = value.slice(0, separator);
  if (!/^[A-Za-z0-9+\-.]+$/.test(scheme)) return null;
  const rest = value.slice(separator + 3);
  const authorityEnd = rest.search(/[/?#]/);
  const authority = authorityEnd === -1 ? rest : rest.slice(0, authorityEnd);
  if (authority === "") return null;
  const hasUserinfo = authority.includes("@");
  const hostPort = hasUserinfo
    ? authority.slice(authority.lastIndexOf("@") + 1)
    : authority;
  const host = hostPort.startsWith("[")
    ? hostPort.slice(1, hostPort.indexOf("]"))
    : hostPort.split(":")[0];
  if (host === "" || host === undefined) return null;
  return { scheme: scheme.toLowerCase(), host: host.toLowerCase(), hasUserinfo };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

export function agentBaseUrlIssue(raw: string): AgentBaseUrlIssue | null {
  const value = raw.trim();
  if (value === "") return "required";
  const parts = splitUrl(value);
  if (parts === null || parts.hasUserinfo || /[?#]/.test(value)) return "shape";
  if (parts.scheme !== "http" && parts.scheme !== "https") return "scheme";
  if (parts.host.includes("mock")) return "mockHost";
  if (!LOOPBACK_HOSTS.has(parts.host) && parts.scheme !== "https") {
    return "plaintextRemote";
  }
  return null;
}

export function systemPromptIssue(raw: string): AgentTextIssue | null {
  return utf8Bytes(raw) > SYSTEM_PROMPT_MAX_BYTES ? "tooLong" : null;
}

export function instructionsIssue(raw: string): AgentTextIssue | null {
  return utf8Bytes(raw) > INSTRUCTIONS_MAX_BYTES ? "tooLong" : null;
}

// ---- field copy -------------------------------------------------------------

export function agentDisplayNameIssueMessage(
  issue: AgentDisplayNameIssue
): string {
  switch (issue) {
    case "required":
      return "에이전트가 뭐라고 불릴지 입력하세요.";
    case "tooLong":
      return `표시 이름은 ${DISPLAY_NAME_MAX}자 이내여야 합니다.`;
  }
}

export function agentHandleIssueMessage(issue: AgentHandleIssue): string {
  switch (issue) {
    case "required":
      return "핸들을 입력하세요. 사람들이 이 이름으로 에이전트를 부릅니다.";
    case "length":
      return `핸들은 ${HANDLE_MIN}자 이상 ${HANDLE_MAX}자 이내여야 합니다.`;
    case "unsupportedCharacters":
      return "핸들에는 영문 소문자, 숫자, 하이픈, 밑줄만 쓸 수 있습니다.";
  }
}

export function agentModelIssueMessage(issue: AgentModelIssue): string {
  switch (issue) {
    case "required":
      return "이 에이전트가 쓸 모델 이름을 입력하세요.";
    case "tooLong":
      return `모델 이름은 ${MODEL_MAX}자 이내여야 합니다.`;
  }
}

export function agentBaseUrlIssueMessage(issue: AgentBaseUrlIssue): string {
  switch (issue) {
    case "required":
      return "이 에이전트를 실행할 게이트웨이 주소를 입력하세요.";
    case "shape":
      return "주소는 scheme://host 형태여야 하고, 계정 정보나 물음표 뒤 값은 넣을 수 없습니다.";
    case "scheme":
      return "주소는 http:// 또는 https:// 로 시작해야 합니다.";
    case "mockHost":
      return "목 프로바이더 주소는 쓸 수 없습니다. 실제 게이트웨이 주소를 입력하세요.";
    case "plaintextRemote":
      return "외부 주소는 https:// 여야 합니다. http는 같은 기기(localhost)에서만 쓸 수 있습니다.";
  }
}

export function systemPromptIssueMessage(): string {
  return `시스템 프롬프트는 UTF-8 기준 ${SYSTEM_PROMPT_MAX_BYTES.toLocaleString(
    "ko-KR"
  )} bytes 이내여야 합니다.`;
}

export function instructionsIssueMessage(): string {
  return `지시문은 UTF-8 기준 ${INSTRUCTIONS_MAX_BYTES.toLocaleString(
    "ko-KR"
  )} bytes 이내여야 합니다.`;
}

// ---- who may do this at all -------------------------------------------------

/**
 * May this member create an agent?
 *
 * `routes::agents::create` runs `require_human` and then a workspace owner/admin
 * check, so a plain member's every attempt ends in 403. An absent role is
 * treated as allowed for the same reason the channel form does: the roster marks
 * `role` optional, and hiding the action because a field did not arrive is worse
 * than letting the server answer. `kind` is not optional though, and an agent
 * principal is refused before the role is even read.
 */
export function canCreateAgent(
  kind: "human" | "agent",
  role: MembershipRole | undefined
): boolean {
  if (kind !== "human") return false;
  if (role === undefined) return true;
  return role === "owner" || role === "admin";
}

/** The same question while the roster may still be in flight (channels R2 M5). */
export function canCreateAgentNow(
  rosterSettled: boolean,
  kind: "human" | "agent",
  role: MembershipRole | undefined
): boolean {
  if (!rosterSettled) return false;
  return canCreateAgent(kind, role);
}

// ---- refusals ---------------------------------------------------------------

export type CreateAgentField = "handle" | "model" | "baseUrl" | null;

/**
 * A rejected creation, addressed to a place on the form.
 *
 * `field` is what makes this inline rather than a banner: a taken handle is a
 * statement about the handle box, so it is shown under the handle box with the
 * value still in it.
 */
export interface CreateAgentFailure {
  field: CreateAgentField;
  message: string;
}

/**
 * Which box a 400 is about.
 *
 * The server answers 400 with its own English sentence and that sentence names
 * the field (`model must contain 1...200 characters`, `baseUrl must use
 * http:// or https://`). The form already validated with the same rules, so a
 * 400 means the two drifted: the sentence is not echoed, but the ADDRESS in it
 * is still the most useful thing the server said, and it decides where the
 * Korean sentence lands.
 */
function fieldForBadRequest(message: string): CreateAgentField {
  if (/baseurl/i.test(message)) return "baseUrl";
  if (/handle/i.test(message)) return "handle";
  if (/\bmodel\b/i.test(message)) return "model";
  return null;
}

export function createAgentFailure(error: unknown): CreateAgentFailure {
  if (error instanceof ApiError) {
    if (error.status === 409) {
      return {
        field: "handle",
        message: "같은 핸들의 멤버가 이미 있습니다. 다른 핸들로 다시 시도하세요.",
      };
    }
    if (error.status === 400) {
      const field = fieldForBadRequest(error.message);
      if (field === "baseUrl") {
        return {
          field,
          message:
            "서버가 이 주소를 거절했습니다. 외부 주소는 https여야 하고, localhost는 포트를 함께 적어야 합니다.",
        };
      }
      if (field === "handle") {
        return {
          field,
          message:
            "서버가 이 핸들을 거절했습니다. 영문 소문자, 숫자, 하이픈, 밑줄로 2자 이상 32자 이내여야 합니다.",
        };
      }
      if (field === "model") {
        return {
          field,
          message: "서버가 이 모델 이름을 거절했습니다. 200자 이내로 다시 적으세요.",
        };
      }
      return {
        field: null,
        message: "서버가 이 내용을 거절했습니다. 입력한 값을 확인하고 다시 시도하세요.",
      };
    }
    if (error.status === 403) {
      return {
        field: null,
        message:
          "에이전트를 만들 권한이 없습니다. 워크스페이스 오너나 관리자에게 요청하세요.",
      };
    }
    if (error.status === 404 || error.status === 405) {
      // The route itself is absent (diff matrix D-4). Saying "다시 시도하세요"
      // here would send someone into a loop that cannot end.
      return {
        field: null,
        message:
          "이 서버는 아직 에이전트 만들기를 지원하지 않습니다. 서버 버전을 확인하세요.",
      };
    }
    if (error.status === 429) {
      return {
        field: null,
        message: "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.",
      };
    }
  }
  if (error instanceof NetworkError) {
    // The transport already writes measured copy for "nothing answered"
    // (timeout vs unreachable, with the deadline in seconds).
    return {
      field: null,
      message: `에이전트를 만들지 못했습니다. ${error.message}`,
    };
  }
  return {
    field: null,
    message: "에이전트를 만들지 못했습니다. 잠시 뒤에 다시 시도하세요.",
  };
}
