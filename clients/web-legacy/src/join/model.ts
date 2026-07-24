import { ApiError } from "../api/client";

export interface JoinFormValues {
  email: string;
  displayName: string;
  handle: string;
  password: string;
}

export type JoinErrorKind =
  | "expired"
  | "revoked"
  | "gone"
  | "exhausted"
  | "already-redeemed"
  | "no-channels"
  | "invalid"
  | "banned"
  | "forbidden"
  | "bad-input"
  | "rate-limited"
  | "network"
  | "conflict"
  | "unknown";

export interface JoinError {
  kind: JoinErrorKind;
  copy: string;
  suggestLogin: boolean;
  terminal: boolean;
}

const ASK_ADMIN = "워크스페이스 관리자에게 새 초대 링크를 요청해 주세요.";
const HANDLE_PATTERN = /^[a-z0-9_-]{2,32}$/;

function decodeCode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Read an invite once without logging it or mutating browser history. */
export function inviteCodeFromUrl(url: URL): string | null {
  const queryCode = url.pathname === "/join" ? url.searchParams.get("code") : null;
  if (queryCode !== null && queryCode.trim() !== "") return queryCode.trim();

  const pathMatch = /^\/(?:i|join)\/([^/]+)\/?$/.exec(url.pathname);
  if (pathMatch === null) return null;
  return decodeCode(pathMatch[1]).trim() || null;
}

export function validateJoinForm(values: JoinFormValues): string | null {
  const email = values.email.trim();
  if (email === "" || !email.includes("@")) {
    return "이메일 주소를 확인해 주세요.";
  }
  const displayName = values.displayName.trim();
  if (displayName === "" || displayName.length > 100) {
    return "표시 이름은 1자 이상 100자 이하로 입력해 주세요.";
  }
  const handle = values.handle.trim();
  if (handle !== "" && !HANDLE_PATTERN.test(handle)) {
    return "핸들은 소문자, 숫자, 밑줄, 하이픈으로 2자 이상 32자 이하로 입력해 주세요.";
  }
  if (values.password.length === 0 || values.password.length > 1024) {
    return "비밀번호는 1자 이상 1024자 이하로 입력해 주세요.";
  }
  return null;
}

export function classifyJoinError(cause: unknown): JoinError {
  if (!(cause instanceof ApiError)) {
    return {
      kind: "network",
      copy: "가입 요청을 보내지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.",
      suggestLogin: false,
      terminal: false,
    };
  }
  const message = cause.message.toLowerCase();
  switch (cause.status) {
    case 404:
      return {
        kind: "invalid",
        copy: "유효하지 않은 초대 링크입니다. 링크 주소를 초대한 사람에게 확인해 주세요.",
        suggestLogin: false,
        terminal: true,
      };
    case 410:
      if (message.includes("expired")) {
        return {
          kind: "expired",
          copy: `이 초대 링크는 만료되었습니다. ${ASK_ADMIN}`,
          suggestLogin: false,
          terminal: true,
        };
      }
      if (message.includes("revoked")) {
        return {
          kind: "revoked",
          copy: `이 초대 링크는 회수되었습니다. ${ASK_ADMIN}`,
          suggestLogin: false,
          terminal: true,
        };
      }
      return {
        kind: "gone",
        copy: `이 초대 링크는 더 이상 사용할 수 없습니다. ${ASK_ADMIN}`,
        suggestLogin: false,
        terminal: true,
      };
    case 409:
      if (message.includes("exhausted")) {
        return {
          kind: "exhausted",
          copy: `이 초대 링크는 사용 횟수가 모두 소진되었습니다. ${ASK_ADMIN}`,
          suggestLogin: false,
          terminal: true,
        };
      }
      if (message.includes("already redeemed")) {
        return {
          kind: "already-redeemed",
          copy: "이미 이 초대로 가입한 계정입니다. 로그인해 주세요.",
          suggestLogin: true,
          terminal: true,
        };
      }
      if (message.includes("handle")) {
        return {
          kind: "bad-input",
          copy: "이미 사용 중인 핸들입니다. 다른 핸들을 입력해 주세요.",
          suggestLogin: false,
          terminal: false,
        };
      }
      if (message.includes("no joinable") || message.includes("channels")) {
        return {
          kind: "no-channels",
          copy: "지금은 합류할 수 있는 채널이 없습니다. 워크스페이스 관리자에게 문의해 주세요.",
          suggestLogin: false,
          terminal: true,
        };
      }
      return {
        kind: "conflict",
        copy: "이 초대로는 지금 가입할 수 없습니다. 워크스페이스 관리자에게 문의해 주세요.",
        suggestLogin: false,
        terminal: true,
      };
    case 403:
      if (message.includes("banned")) {
        return {
          kind: "banned",
          copy: "이 워크스페이스에서 차단된 계정입니다. 새 초대로 다시 가입할 수 없습니다.",
          suggestLogin: false,
          terminal: true,
        };
      }
      return {
        kind: "forbidden",
        copy: "이 초대로는 가입할 수 없는 계정입니다. 워크스페이스 관리자에게 문의해 주세요.",
        suggestLogin: false,
        terminal: true,
      };
    case 400:
      return {
        kind: "bad-input",
        copy: "입력한 정보를 다시 확인해 주세요.",
        suggestLogin: false,
        terminal: false,
      };
    case 429:
      return {
        kind: "rate-limited",
        copy: "시도가 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
        suggestLogin: false,
        terminal: false,
      };
    default:
      return {
        kind: "unknown",
        copy: "가입에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        suggestLogin: false,
        terminal: false,
      };
  }
}
