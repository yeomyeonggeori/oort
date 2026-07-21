import { useState } from "react";
import type { FormEvent } from "react";
import { ApiError, login } from "../api/client";
import { getServerUrl, verifyServer } from "../config/server";

interface LoginPageProps {
  /** Prefill from the /join/<code> landing (MOMO-401) — email only, never a secret. */
  initialEmail?: string | undefined;
  onUseInviteCode: (code: string) => void;
}

export default function LoginPage({ initialEmail, onUseInviteCode }: LoginPageProps) {
  const [serverUrl, setServerUrl] = useState(getServerUrl);
  const [email, setEmail] = useState(initialEmail ?? "");
  const [password, setPassword] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [inviteCode, setInviteCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      await verifyServer(serverUrl);
      await login(email.trim(), password, workspace);
      // Success: the session store notifies App, which swaps to ChatPage.
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError("이메일 또는 비밀번호가 올바르지 않습니다.");
      } else if (cause instanceof ApiError && cause.status === 429) {
        setError("시도가 너무 잦습니다. 잠시 후 다시 시도해 주세요.");
      } else if (cause instanceof ApiError) {
        setError(`서버가 로그인을 처리하지 못했습니다 (HTTP ${cause.status}). 서버 설정을 확인해 주세요.`);
      } else if (cause instanceof Error) {
        setError(`서버 연결을 확인하지 못했습니다. ${cause.message}`);
      } else {
        setError("로그인에 실패했습니다. 서버 주소와 네트워크 상태를 확인해 주세요.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function handleInvite() {
    if (submitting || inviteCode.trim() === "") return;
    setSubmitting(true);
    setError(null);
    try {
      await verifyServer(serverUrl);
      onUseInviteCode(inviteCode.trim());
    } catch (cause) {
      const detail = cause instanceof Error ? ` ${cause.message}` : "";
      setError(`초대 서버에 연결하지 못했습니다.${detail}`);
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
          <span className="field-label">서버</span>
          <input
            data-testid="login-server"
            type="url"
            inputMode="url"
            autoComplete="url"
            required
            value={serverUrl}
            onChange={(event) => setServerUrl(event.target.value)}
          />
          <span className="field-help">HTTPS 주소를 사용하세요. localhost는 HTTP도 됩니다.</span>
        </label>

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
          <span className="field-label">초대 코드 (선택)</span>
          <input
            data-testid="login-invite-code"
            type="password"
            autoComplete="off"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value)}
          />
          <span className="field-help">입력하면 로그인 대신 초대 가입으로 이동합니다.</span>
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
        {inviteCode.trim() !== "" && (
          <button
            data-testid="join-with-code"
            className="ghost-button"
            type="button"
            disabled={submitting}
            onClick={() => void handleInvite()}
          >
            초대 코드로 가입
          </button>
        )}
      </form>
    </div>
  );
}
