import { useState, type FormEvent, type ReactNode } from "react";
import { claimOwnerPassword, type LoginResponse } from "@momo/core/lib/api";
import { claimFailureCopy, type ClaimFailure } from "@momo/core/features/auth/claimModel";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from "@/design/ui/card";
import { OortMark } from "@/design/brand/OortMark";
import { InlineBanner } from "@/features/common/States";
import { useBrowserOffline } from "@/features/common/useOffline";
import { readClaimToken } from "./claimPath";

// Reading this as: onboarding claim-password form for self-host operators on
// web+Tauri, density 6/10, motion 2/10.

function FieldLabel({
  children,
  optional = false,
}: {
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <span className="flex items-baseline gap-2">
      <span className="text-ink-muted">{children}</span>
      <span className="text-meta text-ink-muted">
        {optional ? "선택" : "필수"}
      </span>
    </span>
  );
}

function openConnectScreen() {
  window.location.replace("/");
}

export function ClaimPage({
  onLoggedIn,
}: {
  onLoggedIn: (session: LoginResponse) => void;
}) {
  const token = readClaimToken(window.location.pathname);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [mismatch, setMismatch] = useState(false);
  const [failure, setFailure] = useState<ClaimFailure | null>(null);
  const offline = useBrowserOffline();

  const missingToken = token === null;
  const showForm = !missingToken && (failure === null || failure.keepForm);

  async function attempt() {
    if (token === null) return;
    if (password !== confirm) {
      setMismatch(true);
      setFailure(null);
      return;
    }
    setMismatch(false);
    setFailure(null);
    setBusy(true);
    try {
      const session = await claimOwnerPassword(token, password);
      window.history.replaceState(null, "", "/");
      onLoggedIn(session);
    } catch (err) {
      setFailure(claimFailureCopy(err));
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    void attempt();
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <h1 className="flex items-center gap-2 font-semibold leading-none tracking-tight">
            <OortMark className="size-6 shrink-0 text-accent" />
            <span className="text-title">oort</span>
          </h1>
          <CardDescription>
            {showForm
              ? "첫 비밀번호를 설정합니다."
              : "이 링크로는 비밀번호를 설정할 수 없습니다."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {offline && (
            <InlineBanner
              tone="neutral"
              message="오프라인입니다. 네트워크가 연결되면 다시 시도하세요."
              testId="claim-offline"
            />
          )}

          {missingToken && (
            <InlineBanner
              tone="error"
              message="이 링크는 유효하지 않습니다. 받은 주소를 그대로 여세요."
              testId="claim-missing-token"
            />
          )}

          {showForm ? (
            <form onSubmit={onSubmit} className="flex flex-col gap-6">
              {failure && (
                <InlineBanner
                  tone="error"
                  message={failure.message}
                  testId="claim-error"
                />
              )}
              <div className="flex flex-col gap-3">
                <label htmlFor="claim-password" className="flex flex-col gap-1 text-body">
                  <FieldLabel>새 비밀번호</FieldLabel>
                  <Input
                    id="claim-password"
                    type="password"
                    autoComplete="new-password"
                    maxLength={1024}
                    value={password}
                    onChange={(e) => {
                      setPassword(e.target.value);
                      setMismatch(false);
                    }}
                    required
                    data-testid="claim-password"
                  />
                </label>
                <label htmlFor="claim-confirm" className="flex flex-col gap-1 text-body">
                  <FieldLabel>비밀번호 확인</FieldLabel>
                  <Input
                    id="claim-confirm"
                    type="password"
                    autoComplete="new-password"
                    maxLength={1024}
                    value={confirm}
                    onChange={(e) => {
                      setConfirm(e.target.value);
                      setMismatch(false);
                    }}
                    required
                    aria-invalid={mismatch || undefined}
                    aria-describedby={mismatch ? "claim-mismatch" : undefined}
                    data-testid="claim-confirm"
                  />
                  {mismatch && (
                    <p
                      id="claim-mismatch"
                      role="alert"
                      className="text-meta text-danger"
                      data-testid="claim-mismatch"
                    >
                      두 칸의 비밀번호가 같지 않습니다.
                    </p>
                  )}
                </label>
              </div>
              <Button
                type="submit"
                disabled={busy || offline || password === "" || confirm === ""}
                data-testid="claim-submit"
              >
                {busy ? "설정 중…" : "비밀번호 설정"}
              </Button>
            </form>
          ) : (
            <>
              {failure && (
                <InlineBanner
                  tone="error"
                  message={failure.message}
                  testId="claim-error"
                />
              )}
              <Button
                type="button"
                onClick={openConnectScreen}
                data-testid="claim-open-connect"
              >
                로그인 화면 열기
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
