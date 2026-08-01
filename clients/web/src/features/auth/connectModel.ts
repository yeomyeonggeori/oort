import { ApiError } from "@/lib/api";
import { NetworkError } from "@/lib/http";

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
  /**
   * Pressing again with the SAME input could work: nothing answered, or the
   * server answered with its own fault. A rejected password or a spent invite
   * is not retryable — the input has to change first — so the error offers no
   * retry there and the person edits the field instead.
   */
  retryable: boolean;
}

const ASK_ADMIN = "워크스페이스 관리자에게 새 초대 링크를 요청하세요.";

/**
 * The transport never got an answer (MOMO-609). `NetworkError` already carries
 * user-facing copy that names which of the two happened — the deadline blew, or
 * the address answered nothing — so it is passed through rather than flattened
 * into one sentence that fits neither.
 */
function transportFailure(cause: unknown): ConnectFailure | null {
  if (cause instanceof NetworkError) {
    return { message: cause.message, suggestSignIn: false, retryable: true };
  }
  if (cause instanceof ApiError) return null;
  // Anything else reaching here is a client-side fault (a malformed response
  // body, say). It still ends the busy state with something actionable.
  return {
    message: "서버 응답을 읽지 못했습니다. 주소를 확인하고 다시 시도하세요.",
    suggestSignIn: false,
    retryable: true,
  };
}

/**
 * Invite failures to distinct copy. The HTTP status is the canonical split in
 * the spec (404 invalid, 409 spent or already redeemed, 410 expired or revoked,
 * 403 not eligible) and the server's stable English message splits the two
 * statuses that carry two meanings. An unrecognised message falls back to the
 * per-status copy, never to a raw English string in front of the user.
 */
export function joinFailureCopy(cause: unknown): ConnectFailure {
  const transport = transportFailure(cause);
  if (transport) return transport;
  const failure = cause as ApiError;
  const detail = failure.message.toLowerCase();
  switch (failure.status) {
    case 404:
      return {
        message:
          "유효하지 않은 초대 코드입니다. 초대한 사람에게 링크를 다시 확인하세요.",
        suggestSignIn: false,
        retryable: false,
      };
    case 410:
      if (detail.includes("expired")) {
        return {
          message: `만료된 초대입니다. ${ASK_ADMIN}`,
          suggestSignIn: false,
          retryable: false,
        };
      }
      if (detail.includes("revoked")) {
        return {
          message: `회수된 초대입니다. ${ASK_ADMIN}`,
          suggestSignIn: false,
          retryable: false,
        };
      }
      return {
        message: `더 이상 쓸 수 없는 초대입니다. ${ASK_ADMIN}`,
        suggestSignIn: false,
        retryable: false,
      };
    case 409:
      if (detail.includes("already redeemed")) {
        return {
          message: "이미 이 초대로 가입한 계정입니다. 로그인하세요.",
          suggestSignIn: true,
          retryable: false,
        };
      }
      if (detail.includes("exhausted")) {
        return {
          message: `사용 횟수가 모두 찬 초대입니다. ${ASK_ADMIN}`,
          suggestSignIn: false,
          retryable: false,
        };
      }
      return {
        message: `이 초대로는 가입할 수 없습니다. ${ASK_ADMIN}`,
        suggestSignIn: false,
        retryable: false,
      };
    case 403:
      return {
        message: `이 초대로는 가입 권한이 없습니다. ${ASK_ADMIN}`,
        suggestSignIn: false,
        retryable: false,
      };
    case 429:
      return {
        message: "요청이 너무 잦습니다. 잠시 뒤에 다시 시도하세요.",
        suggestSignIn: false,
        retryable: false,
      };
    default:
      // goal B13 (QA M/L): this branch used to return `failure.message`, which
      // is the server's own English sentence ("invalid credentials", "member is
      // suspended"). The doc comment above already promised it never did, and
      // the promise is now true: an unmapped status says what happened in the
      // language of the form, and the raw string stays where it is useful — the
      // network tab.
      return {
        message: unmappedMessage(failure.status, ASK_ADMIN),
        suggestSignIn: false,
        retryable: failure.status >= 500,
      };
  }
}

/** The admin to ask when a sign-in, rather than an invite, is the thing stuck. */
const ASK_ADMIN_SIGN_IN = "워크스페이스 관리자에게 문의하세요.";

/**
 * Copy for a status nothing above claimed.
 *
 * Split into its own function because both surfaces need it and because the one
 * distinction worth keeping from the raw string is the one a person can act on:
 * a 5xx is worth retrying and a 4xx is not.
 */
function unmappedMessage(status: number, askAdmin: string): string {
  return status >= 500
    ? "서버에서 오류가 났습니다. 잠시 뒤에 다시 시도하세요."
    : `요청을 처리하지 못했습니다. ${askAdmin}`;
}

/** Sign-in failures. 401 and 403 carry the two answers a person can act on. */
export function signInFailureCopy(cause: unknown): ConnectFailure {
  const transport = transportFailure(cause);
  if (transport) return transport;
  const failure = cause as ApiError;
  if (failure.status === 401) {
    return {
      message: "이메일 또는 비밀번호가 맞지 않습니다.",
      suggestSignIn: false,
      retryable: false,
    };
  }
  // goal B13 R2 High 1. The server now refuses a `workspace` that was supplied
  // and is not a workspace id, instead of parsing it, discarding it and signing
  // the person into the demo workspace without a word. Keyed on the server's
  // stable English wording — the same technique `joinFailureCopy` uses for 410 —
  // rather than on the bare 400, because a body-shape rejection is also a 400
  // and does not deserve this sentence.
  if (
    failure.status === 400 &&
    failure.message.toLowerCase().includes("workspace")
  ) {
    return {
      message:
        "워크스페이스 ID 형식이 아닙니다. 비워 두면 기본 워크스페이스로 연결합니다.",
      suggestSignIn: false,
      retryable: false,
    };
  }
  if (failure.status === 403) {
    // `PasswordLogin::Suspended` — the credential is right and the account is
    // not usable, which is a different sentence and a different next step from
    // "the password is wrong".
    return {
      message: `이 계정은 지금 로그인할 수 없습니다. ${ASK_ADMIN_SIGN_IN}`,
      suggestSignIn: false,
      retryable: false,
    };
  }
  return {
    message: unmappedMessage(failure.status, ASK_ADMIN_SIGN_IN),
    suggestSignIn: false,
    retryable: failure.status >= 500,
  };
}
