import { useState } from "react";
import type { FormEvent } from "react";
import type { JoinRequest } from "../api/client";
import { ApiError, joinInvite } from "../api/client";

// =============================================================================
// /join/<code> landing (MOMO-401, ADR-0119 W-5 / ADR-0121 D2-B).
//
// The invite code arrives as a prop — App.tsx captured it from the path
// segment and already REPLACED the address bar with "/" so the code survives
// neither in browser history nor in any subsequent request URL. It is a
// bearer secret: never log it, never put it in a query string; it leaves
// this page only inside the POST /v1/join body.
//
// Success (200 existing / 201 created) returns a session token pair per the
// canonical contract (openapi.yaml JoinResponse requires accessToken/
// refreshToken/realtimeWebSocketUrl), so joinInvite() applies the session
// and App swaps straight to the chat surface — the spec'd join-login path.
//
// Invite failures are mapped to DISTINCT Korean copy from the server error
// envelope: the HTTP status is canonical in the spec (404 invalid / 409
// exhausted-or-redeemed / 410 expired-or-revoked / 403 not eligible), and
// the envelope message (JoinRoutes.swift stable strings) splits the statuses
// that carry two meanings. Unrecognized messages fall back to the combined
// per-status copy — never to a raw English server string.
// =============================================================================

interface JoinPageProps {
  code: string;
  /** Join succeeded and the session is applied — parent drops the code. */
  onJoined: () => void;
  /** User chose the login form instead (optional email prefill). */
  onGoToLogin: (prefillEmail?: string) => void;
}

type JoinErrorKind =
  | "expired"
  | "revoked"
  | "gone"
  | "exhausted"
  | "already-redeemed"
  | "no-channels"
  | "invalid"
  | "forbidden"
  | "bad-input"
  | "rate-limited"
  | "network";

interface JoinError {
  kind: JoinErrorKind;
  copy: string;
  /** Offer the login shortcut (the account very likely already exists). */
  suggestLogin: boolean;
}

const ASK_ADMIN = "워크스페이스 관리자에게 새 초대 링크를 요청해 주세요.";

function classifyJoinError(cause: unknown): JoinError {
  if (!(cause instanceof ApiError)) {
    return {
      kind: "network",
      copy: "가입 요청을 보내지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요.",
      suggestLogin: false,
    };
  }
  const message = cause.message.toLowerCase();
  switch (cause.status) {
    case 404:
      return {
        kind: "invalid",
        copy: "유효하지 않은 초대 링크입니다. 링크 주소가 정확한지 초대한 사람에게 확인해 주세요.",
        suggestLogin: false,
      };
    case 410:
      if (message.includes("expired")) {
        return {
          kind: "expired",
          copy: `이 초대 링크는 만료되었습니다. ${ASK_ADMIN}`,
          suggestLogin: false,
        };
      }
      if (message.includes("revoked")) {
        return {
          kind: "revoked",
          copy: `이 초대 링크는 회수되었습니다. ${ASK_ADMIN}`,
          suggestLogin: false,
        };
      }
      return {
        kind: "gone",
        copy: `이 초대 링크는 만료되었거나 회수되었습니다. ${ASK_ADMIN}`,
        suggestLogin: false,
      };
    case 409:
      if (message.includes("exhausted")) {
        return {
          kind: "exhausted",
          copy: `이 초대 링크는 사용 횟수가 모두 소진되었습니다. ${ASK_ADMIN}`,
          suggestLogin: false,
        };
      }
      if (message.includes("already redeemed")) {
        return {
          kind: "already-redeemed",
          copy: "이미 이 초대로 가입한 계정입니다. 로그인해 주세요.",
          suggestLogin: true,
        };
      }
      if (message.includes("handle")) {
        return {
          kind: "bad-input",
          copy: "이미 사용 중인 핸들입니다. 아래에서 다른 핸들을 직접 정해 주세요.",
          suggestLogin: false,
        };
      }
      return {
        kind: "no-channels",
        copy: "지금은 합류할 수 있는 채널이 없습니다. 워크스페이스 관리자에게 문의해 주세요.",
        suggestLogin: false,
      };
    case 403:
      return {
        kind: "forbidden",
        copy: "이 초대로는 가입할 수 없는 계정입니다. 워크스페이스 관리자에게 문의해 주세요.",
        suggestLogin: false,
      };
    case 400:
      return {
        kind: "bad-input",
        copy: "입력한 정보를 다시 확인해 주세요.",
        suggestLogin: false,
      };
    case 429:
      return {
        kind: "rate-limited",
        copy: "시도가 너무 잦습니다. 잠시 후 다시 시도해 주세요.",
        suggestLogin: false,
      };
    default:
      return {
        kind: "network",
        copy: "가입에 실패했습니다. 잠시 후 다시 시도해 주세요.",
        suggestLogin: false,
      };
  }
}

function browserTimeZone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined;
  } catch {
    return undefined;
  }
}

export default function JoinPage({ code, onJoined, onGoToLogin }: JoinPageProps) {
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [handle, setHandle] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<JoinError | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const request: JoinRequest = {
        code,
        email: email.trim(),
        displayName: displayName.trim(),
        password,
      };
      const trimmedHandle = handle.trim();
      if (trimmedHandle !== "") request.handle = trimmedHandle;
      const timeZone = browserTimeZone();
      if (timeZone) request.timeZone = timeZone;
      await joinInvite(request);
      // Session applied from the JoinResponse pair; App swaps to ChatPage.
      onJoined();
    } catch (cause) {
      setError(classifyJoinError(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="screen-center">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-title">momo</h1>
        <p className="login-subtitle">
          초대 링크로 워크스페이스에 합류합니다.
        </p>

        <label className="field">
          <span className="field-label">이메일</span>
          <input
            data-testid="join-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">이름</span>
          <input
            data-testid="join-display-name"
            type="text"
            autoComplete="name"
            required
            maxLength={100}
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">비밀번호</span>
          <input
            data-testid="join-password"
            type="password"
            autoComplete="new-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">핸들 (선택)</span>
          <input
            data-testid="join-handle"
            type="text"
            placeholder="비워 두면 이메일에서 만듭니다"
            pattern="[a-z0-9_\-]{2,32}"
            title="소문자/숫자/_/- 2~32자"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
          />
        </label>

        {error !== null && (
          <div
            className="login-error join-error"
            data-testid="join-error"
            data-error-kind={error.kind}
            role="alert"
          >
            <p className="join-error-copy">{error.copy}</p>
            {error.suggestLogin && (
              <button
                type="button"
                className="ghost-button"
                data-testid="join-goto-login"
                onClick={() => onGoToLogin(email.trim() || undefined)}
              >
                로그인으로 이동
              </button>
            )}
          </div>
        )}

        <button
          data-testid="join-submit"
          className="primary-button"
          type="submit"
          disabled={submitting}
        >
          {submitting ? "가입 중…" : "가입하고 합류"}
        </button>

        <button
          type="button"
          className="ghost-button join-login-link"
          data-testid="join-login-link"
          onClick={() => onGoToLogin(email.trim() || undefined)}
        >
          이미 계정이 있나요? 로그인
        </button>
      </form>
    </div>
  );
}
