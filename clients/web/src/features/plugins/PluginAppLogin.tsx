import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { fetchCohostedStatus } from "@momo/core/features/settings/cohostedAgent";
import {
  APP_LOGIN_COPY as COPY,
  appLoginTarget,
  appShellCommand,
  cancelLogin,
  fetchLoginTargets,
  loginErrorMessage,
  loginReasonLine,
  startLogin,
  type LoginStart,
  type LoginStatus,
} from "@momo/core/features/settings/loginRelay";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { StatusChip } from "@/features/settings/SettingsFields";
import { LoginRelaySession } from "@/features/settings/LoginRelaySession";

// Reading this as: 앱 상세 › 로그인 (instance operator only) for internal team users on web+Tauri,
// density 6/10, motion 1/10.

/**
 * 앱 상세의 「로그인」 (#4074 / ADR-0203 증보 2026-10-19 L4). 같은 서버의 Hermes에 연결돼 있고 이 사람이 운영자이며,
 * 이 앱이 Hermes의 로그인 대상으로 올라와 있을 때만 그린다(아니면 null: 로그인할 수 없는 앱에 단추를 세우지 않는다).
 * 흐름: 「로그인」 → 주소 열기 → 돌아온 주소 붙여넣기 → 연결 상태. 붙여넣은 주소와 시작 응답의 다룸은 모델 인증과
 * 같은 `LoginRelaySession`이 진다(상태·캐시·저장소에 남기지 않는다).
 *
 * 만료는 단정하지 않는다: 이 앱의 구글 OAuth가 테스트 모드(외부 사용자)인지 서버 신호가 없어서, 「~라면 7일쯤」으로 쓴다(#4069).
 */
export function PluginAppLogin({ pluginId, offline }: { pluginId: string; offline: boolean }) {
  const target = appLoginTarget(pluginId);
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const cohosted = useQuery({
    queryKey: ["cohosted-agent", workspaceId],
    queryFn: () => fetchCohostedStatus(workspaceId),
    retry: false,
    enabled: target !== null,
  });
  const read = cohosted.data;
  const agentId = read?.kind === "ready" ? read.status.connectedAgentId : null;
  const targetsKey = ["login-relay", "app", workspaceId, agentId] as const;
  const targets = useQuery({
    queryKey: targetsKey,
    queryFn: () => fetchLoginTargets(workspaceId, agentId ?? "", "app"),
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: target !== null && agentId !== null,
  });
  const [active, setActive] = useState<LoginStart | null>(null);
  const [ended, setEnded] = useState<LoginStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const startRef = useRef<HTMLButtonElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const focusAfter = useRef<"start" | "result" | null>(null);
  const mounted = useRef(true);
  const readKind = targets.data?.kind;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // 읽지 못하는 상태에서는 시작 응답(주소)을 들고 있지 않는다.
  useEffect(() => {
    if (readKind !== "ready") setActive(null);
  }, [readKind]);
  useEffect(() => {
    if (active !== null || focusAfter.current === null) return;
    const where = focusAfter.current;
    focusAfter.current = null;
    (where === "result" ? resultRef.current : startRef.current)?.focus();
  }, [active]);

  if (target === null || agentId === null) return null;
  if (targets.isPending) {
    return (
      <Shell>
        <p role="status" aria-live="polite" className="text-meta text-ink-muted" data-testid="app-login-loading">
          로그인 상태를 불러오고 있어요.
        </p>
      </Shell>
    );
  }
  const result = targets.data;
  if (targets.isError || result?.kind === "unknown") {
    return (
      <Shell>
        <InlineBanner
          message={COPY.loadError}
          actionLabel="다시 불러오기"
          onAction={() => void targets.refetch()}
          testId="app-login-error"
        />
      </Shell>
    );
  }
  if (result === undefined || result.kind === "hidden" || result.kind === "not_cohosted") return null;
  if (result.kind === "off") {
    return (
      <Shell>
        <ShellFallback target={target} />
      </Shell>
    );
  }
  const entry = result.targets.find((candidate) => candidate.target === target);
  // Hermes가 이 앱을 로그인 대상으로 모르면(설정에 없음) 눌러도 시작되지 않는다. 단추를 세우지 않는다.
  if (entry === undefined) return null;

  const begin = async () => {
    setStarting(true);
    setStartError(null);
    setEnded(null);
    try {
      const start = await startLogin(workspaceId, agentId, "app", target);
      if (!mounted.current) {
        void cancelLogin(workspaceId, agentId, "app", start.loginId).catch(() => undefined);
        return;
      }
      setActive(start);
    } catch (error) {
      setStartError(loginErrorMessage(error));
      void client.invalidateQueries({ queryKey: targetsKey });
    } finally {
      setStarting(false);
    }
  };
  const disabled = starting || active !== null || offline;

  return (
    <Shell>
      <div className="flex min-w-0 flex-wrap items-center gap-3" data-testid="app-login-row">
        <StatusChip tone={entry.connected ? "ok" : "muted"}>{entry.connected ? COPY.connected : COPY.notConnected}</StatusChip>
        <span className="flex-1" />
        {active === null && (
          <Button
            ref={startRef}
            type="button"
            size="sm"
            variant="ghost"
            className="tap-target bg-surface shadow-sm"
            disabled={disabled}
            aria-disabled={disabled}
            onClick={() => void begin()}
            data-testid="app-login-start"
          >
            {starting && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {entry.connected ? COPY.relogin : COPY.start}
          </Button>
        )}
      </div>
      {startError !== null && <InlineBanner message={startError} testId="app-login-start-error" />}
      {offline && <InlineBanner tone="neutral" message="연결이 끊긴 동안에는 로그인할 수 없어요." testId="app-login-offline" />}
      {active !== null && (
        <LoginRelaySession
          key={`${agentId}:${active.loginId}`}
          workspaceId={workspaceId}
          agentId={agentId}
          flow="app"
          start={active}
          copy={COPY}
          allowedHosts={null}
          onEnded={(status) => {
            focusAfter.current = "result";
            setActive(null);
            setEnded(status);
            if (status.status === "done") void client.invalidateQueries({ queryKey: targetsKey });
          }}
          onClose={() => {
            focusAfter.current = "start";
            setActive(null);
            setEnded(null);
          }}
        />
      )}
      {ended !== null && active === null && (
        <div
          ref={resultRef}
          tabIndex={-1}
          role="status"
          className="flex min-w-0 flex-col gap-1 px-2 py-3 focus-visible:focus-ring"
          data-testid="app-login-result"
          data-status={ended.status}
        >
          <span className="font-semibold text-ink">{ended.status === "done" ? "연결됐어요." : loginReasonLine(ended)}</span>
        </div>
      )}
      {(entry.connected || ended?.status === "failed" || ended?.status === "expired") && (
        <p className="text-meta text-ink-muted" data-testid="app-login-expiry">
          {COPY.externalTestingNote} {COPY.expiryUnknown}
        </p>
      )}
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="flex min-w-0 break-keep flex-col gap-3" aria-labelledby="app-login-title" data-testid="app-login">
      <h4 id="app-login-title" className="text-body font-semibold text-ink">
        {COPY.title}
      </h4>
      <p className="text-meta text-ink-muted">{COPY.lead}</p>
      {children}
    </section>
  );
}

/** 중계가 꺼진 서버: 셸 명령을 보인다(oort를 지나가는 값이 없다). */
function ShellFallback({ target }: { target: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (timer.current !== null) clearTimeout(timer.current);
  }, []);
  const command = appShellCommand(target);
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid="app-login-shell">
      <p className="text-body text-ink">{COPY.shellLead}</p>
      <code className="w-max max-w-full rounded-sm bg-muted-soft px-1 font-mono text-meta text-ink [overflow-wrap:anywhere]">{command}</code>
      <div aria-live="polite">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="tap-target bg-surface shadow-sm"
          onClick={() => {
            if (typeof navigator.clipboard?.writeText !== "function") return;
            void navigator.clipboard
              .writeText(command)
              .then(() => {
                setCopied(true);
                timer.current = setTimeout(() => setCopied(false), 2000);
              })
              .catch(() => undefined);
          }}
        >
          {copied ? "복사했어요" : COPY.shellCopy}
        </Button>
      </div>
    </div>
  );
}
