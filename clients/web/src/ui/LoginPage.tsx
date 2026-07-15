import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, login } from "../api/client";

interface LoginPageProps {
  /** Prefill from the /join/<code> landing (MOMO-401) — email only, never a secret. */
  initialEmail?: string | undefined;
}

export default function LoginPage({ initialEmail }: LoginPageProps) {
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await login(email.trim(), password, workspace);
      // Success: the session store notifies App, which swaps to ChatPage.
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      } else if (cause instanceof ApiError && cause.status === 429) {
        setError("시도가 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
      } else {
        setError("로그인에 실패했습니다. 네트워크 상태를 확인해 주세요.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="screen-center">
      <form className="login-card" onSubmit={handleSubmit}>
        <h1 className="login-title">momo</h1>
        <p className="login-subtitle">워크스페이스에 로그인</p>

        <label className="field">
          <span className="field-label">이메일</span>
          <input
            data-testid="login-email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">비밀번호</span>
          <input
            data-testid="login-password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <label className="field">
          <span className="field-label">워크스페이스 ID (선택)</span>
          <input
            data-testid="login-workspace"
            type="text"
            placeholder="비워 두면 기본 워크스페이스"
            value={workspace}
            onChange={(event) => setWorkspace(event.target.value)}
          />
        </label>

        {error !== null && (
          <p className="login-error" data-testid="login-error" role="alert">
            {error}
          </p>
        )}

        <button
          data-testid="login-submit"
          className="primary-button"
          type="submit"
          disabled={submitting}
        >
          {submitting ? "로그인 중…" : "로그인"}
        </button>
      </form>
    </div>
  );
}
