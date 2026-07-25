import { useState, type FormEvent } from "react";
import { login, type LoginResponse } from "@/lib/api";
import { API_BASE, DEFAULT_WORKSPACE, DEV_EMAIL, DEV_PASSWORD } from "@/lib/env";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/design/ui/card";
import { RuntimeBadge } from "@/app/RuntimeBadge";

export function LoginPage({
  onLoggedIn,
}: {
  onLoggedIn: (session: LoginResponse) => void;
}) {
  const [email, setEmail] = useState(DEV_EMAIL);
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [workspace, setWorkspace] = useState(DEFAULT_WORKSPACE);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const session = await login(email, password, workspace);
      onLoggedIn(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : "로그인 실패");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-title">momo</CardTitle>
            <RuntimeBadge />
          </div>
          {/* Default is same-origin, and then there is nothing to state: an
              empty segment left a dangling separator on screen. The build's
              own identity lives in the RuntimeBadge tooltip, not in copy. */}
          {API_BASE !== "" && (
            <CardDescription data-testid="login-api-base">
              서버 {API_BASE}
            </CardDescription>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-body">
              <span className="text-ink-muted">이메일</span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                data-testid="login-email"
              />
            </label>
            <label className="flex flex-col gap-1 text-body">
              <span className="text-ink-muted">비밀번호</span>
              <Input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                data-testid="login-password"
              />
            </label>
            <label className="flex flex-col gap-1 text-body">
              <span className="text-ink-muted">워크스페이스</span>
              <Input
                value={workspace}
                onChange={(e) => setWorkspace(e.target.value)}
                data-testid="login-workspace"
              />
            </label>
            {error && (
              <p
                className="text-body text-danger"
                data-testid="login-error"
              >
                {error}
              </p>
            )}
            <Button type="submit" disabled={busy} data-testid="login-submit">
              {busy ? "로그인 중…" : "로그인"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
