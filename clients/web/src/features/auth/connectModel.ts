import { ApiError } from "@/lib/api";

// =============================================================================
// Connect-screen decisions, kept out of the component so they can be tested
// without a DOM: which field to land on after a deep link, and what an invite
// failure actually says.
// =============================================================================

export type ConnectMode = "signIn" | "join";

export type ConnectField = "server" | "email" | "password" | "code";

/**
 * Where the cursor goes after a deep link filled what it could. The link
 * carries server and code, so the person should land on the first thing still
 * missing rather than at the top of a form that is already half done (same rule
 * as the mac chooser's `deepLinkPrefillFocus`).
 */
export function prefillFocus(form: {
  serverUrl: string;
  email: string;
  password: string;
  requiresServer: boolean;
}): ConnectField {
  if (form.requiresServer && form.serverUrl.trim() === "") return "server";
  if (form.email.trim() === "") return "email";
  if (form.password === "") return "password";
  return "code";
}

/** A failure the connect screen can state plainly, with what to do next. */
export interface ConnectFailure {
  message: string;
  /** The invite is spent or wrong, and signing in is the way forward. */
  suggestSignIn: boolean;
}

const ASK_ADMIN = "워크스페이스 관리자에게 새 초대 링크를 요청하세요.";

/**
 * Invite failures to distinct copy. The HTTP status is the canonical split in
 * the spec (404 invalid, 409 spent or already redeemed, 410 expired or revoked,
 * 403 not eligible) and the server's stable English message splits the two
 * statuses that carry two meanings. An unrecognised message falls back to the
 * per-status copy, never to a raw English string in front of the user.
 */
export function joinFailureCopy(cause: unknown): ConnectFailure {
  if (!(cause instanceof ApiError)) {
    return {
      message:
        "서버에 연결하지 못했습니다. 주소와 네트워크를 확인하고 다시 시도하세요.",
      suggestSignIn: false,
    };
  }
  const detail = cause.message.toLowerCase();
  switch (cause.status) {
    case 404:
      return {
        message:
          "유효하지 않은 초대 코드입니다. 초대한 사람에게 링크를 다시 확인하세요.",
        suggestSignIn: false,
      };
    case 410:
      if (detail.includes("expired")) {
        return { message: `만료된 초대입니다. ${ASK_ADMIN}`, suggestSignIn: false };
      }
      if (detail.includes("revoked")) {
        return { message: `회수된 초대입니다. ${ASK_ADMIN}`, suggestSignIn: false };
      }
      return {
        message: `더 이상 쓸 수 없는 초대입니다. ${ASK_ADMIN}`,
        suggestSignIn: false,
      };
    case 409:
      if (detail.includes("already redeemed")) {
        return {
          message: "이미 이 초대로 가입한 계정입니다. 로그인하세요.",
          suggestSignIn: true,
        };
      }
      if (detail.includes("exhausted")) {
        return {
          message: `사용 횟수가 모두 찬 초대입니다. ${ASK_ADMIN}`,
          suggestSignIn: false,
        };
      }
      return {
        message: `이 초대로는 가입할 수 없습니다. ${ASK_ADMIN}`,
        suggestSignIn: false,
      };
    case 403:
      return {
        message: `이 초대로는 가입 권한이 없습니다. ${ASK_ADMIN}`,
        suggestSignIn: false,
      };
    case 429:
      return {
        message: "요청이 너무 잦습니다. 잠시 후 다시 시도하세요.",
        suggestSignIn: false,
      };
    default:
      return { message: cause.message, suggestSignIn: false };
  }
}

/** Sign-in failures. 401 is the only one worth rewording. */
export function signInFailureCopy(cause: unknown): ConnectFailure {
  if (cause instanceof ApiError && cause.status === 401) {
    return {
      message: "이메일 또는 비밀번호가 맞지 않습니다.",
      suggestSignIn: false,
    };
  }
  if (cause instanceof ApiError) {
    return { message: cause.message, suggestSignIn: false };
  }
  return {
    message:
      "서버에 연결하지 못했습니다. 주소와 네트워크를 확인하고 다시 시도하세요.",
    suggestSignIn: false,
  };
}
