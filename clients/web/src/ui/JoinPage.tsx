import { useState } from "react";
import type { FormEvent } from "react";
import type { JoinRequest } from "../api/client";
import { joinInvite } from "../api/client";
import {
  classifyJoinError,
  validateJoinForm,
} from "../join/model";
import type { JoinError } from "../join/model";

// =============================================================================
// /join?code=<code> landing (Goal #593, ADR-0119 W-5 / ADR-0121 D2).
//
// The invite code arrives as a prop — App.tsx captured it from the path
// or the /i/<code> SPA fallback and never logs it. It is a bearer secret that
// leaves this page only inside the POST /v1/join body. App removes it from
// browser history after the join succeeds.
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
      const validationError = validateJoinForm({
        email,
        displayName,
        handle,
        password,
      });
      if (validationError !== null) {
        setError({
          kind: "bad-input",
          copy: validationError,
          suggestLogin: false,
          terminal: false,
        });
        return;
      }
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
          maxLength={1024}
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

        {!error?.terminal && (
          <button
            data-testid="join-submit"
            className="primary-button"
            type="submit"
            disabled={submitting}
          >
            {submitting ? "가입 중…" : "가입하고 합류"}
          </button>
        )}

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
