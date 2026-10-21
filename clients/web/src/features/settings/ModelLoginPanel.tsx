import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, Loader2 } from "lucide-react";
import { fetchCohostedStatus } from "@momo/core/features/settings/cohostedAgent";
import { providerLoginName } from "@momo/core/features/settings/cohostedModels";
import {
  cancelLogin,
  fetchLoginTargets,
  loginErrorMessage,
  loginReasonLine,
  MODEL_LOGIN_COPY as COPY,
  MODEL_SHELL_COMMANDS,
  startLogin,
  type LoginStart,
  type LoginStatus,
  type ModelProvider,
} from "@momo/core/features/settings/loginRelay";
import { Button } from "@/design/ui/button";
import { InlineBanner } from "@/features/common/States";
import { AiLineRow, AiPill } from "./aiAccountsParts";
import { LoginRelaySession, type SessionCopy } from "./LoginRelaySession";

// Reading this as: settings › AI 연결 › 모델 인증 (instance operator only) for internal team users on
// web+Tauri, density 6/10, motion 1/10.

const HEADING_ID = "ai-model-login-title";

const SESSION_COPY: SessionCopy = {
  pasteSteps: COPY.pasteSteps,
  pasteLabel: COPY.pasteLabel,
  pasteHelp: COPY.pasteHelp,
  pasteSend: COPY.pasteSend,
};

type Active = { readonly provider: ModelProvider; readonly start: LoginStart };

/**
 * 「모델 인증」 (#4080 / ADR-0203 증보 2026-10-19 L4). 같은 서버의 Hermes가 연결된 뒤, 그 Hermes가 쓸 AI를 로그인으로
 * 정한다: Codex(기기 코드), Claude(주소 열기 + 돌아온 코드 붙여넣기), API 키(기존 키 추가로 안내만).
 *
 * 보임은 서버 답이다: 운영자가 아니면(403) 아무것도 그리지 않는다. 중계가 꺼져 있으면(409) 셸 명령을 보인다.
 * 시작 응답(주소·기기 코드)은 이 컴포넌트의 `active` 상태에만 있고 끝나면 비운다. query/mutation 에 담지 않는다.
 */
export function ModelLoginPanel({
  workspaceId,
  agentId,
  offline,
  loggedIn = null,
}: {
  workspaceId: string;
  agentId: string;
  offline: boolean;
  /** 모델 목록 답이 말한 로그인된 제공자(#4145). 못 읽었으면 null: 아는 것이 없으니 아무것도 접지 않는다. */
  loggedIn?: ReadonlySet<string> | null;
}) {
  const client = useQueryClient();
  const targetsKey = ["login-relay", "model", workspaceId, agentId] as const;
  const targets = useQuery({
    queryKey: targetsKey,
    queryFn: () => fetchLoginTargets(workspaceId, agentId, "model"),
    retry: false,
    refetchOnWindowFocus: false,
    // 다시 연결될 때 읽기를 다시 하면 진행 중인 세션의 화면이 바뀐다. 이 화면은 사용자가 다시 읽는다.
    refetchOnReconnect: false,
  });
  const [active, setActive] = useState<Active | null>(null);
  const [ended, setEnded] = useState<LoginStatus | null>(null);
  const [startingFor, setStartingFor] = useState<ModelProvider | null>(null);
  const [startError, setStartError] = useState<{ provider: ModelProvider; message: string } | null>(null);
  const [confirmClaude, setConfirmClaude] = useState(false);
  // 단추가 사라지거나 블록이 닫힐 때 초점이 body 로 떨어지지 않게 옮길 자리.
  const startRefs = useRef<Partial<Record<ModelProvider, HTMLButtonElement | null>>>({});
  const confirmRef = useRef<HTMLButtonElement | null>(null);
  const resultRef = useRef<HTMLDivElement | null>(null);
  const lastProvider = useRef<ModelProvider | null>(null);
  const focusAfter = useRef<"start" | "result" | null>(null);
  const mounted = useRef(true);
  const readKind = targets.data?.kind;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // 목록을 읽지 못하는 상태(오류·숨김·꺼짐)에서는 시작 응답(주소·기기 코드)을 들고 있지 않는다.
  useEffect(() => {
    if (readKind !== "ready") setActive(null);
  }, [readKind]);
  useEffect(() => {
    if (confirmClaude && active === null) confirmRef.current?.focus();
  }, [confirmClaude, active]);
  useEffect(() => {
    if (active !== null || focusAfter.current === null) return;
    const target = focusAfter.current;
    focusAfter.current = null;
    if (target === "result") resultRef.current?.focus();
    else if (lastProvider.current) startRefs.current[lastProvider.current]?.focus();
  }, [active, confirmClaude]);

  if (targets.isPending) {
    return (
      <PanelShell>
        <div role="status" aria-live="polite" className="px-2 py-3 text-body text-ink-muted" data-testid="model-login-loading">
          {COPY.loading}
        </div>
      </PanelShell>
    );
  }
  const read = targets.data;
  if (targets.isError || read?.kind === "unknown") {
    return (
      <PanelShell>
        <InlineBanner
          message={COPY.loadError}
          actionLabel={COPY.retry}
          onAction={() => void targets.refetch()}
          testId="model-login-error"
        />
      </PanelShell>
    );
  }
  if (read === undefined || read.kind === "hidden") return null;
  if (read.kind === "not_cohosted") {
    return (
      <PanelShell>
        <AiLineRow last testId="model-login-not-cohosted">
          <span>{COPY.notCohosted}</span>
        </AiLineRow>
      </PanelShell>
    );
  }
  const knownIn = (provider: ModelProvider): boolean => loggedIn?.has(provider) === true;
  const allIn = MODEL_PROVIDERS.every(knownIn);
  const someIn = !allIn && MODEL_PROVIDERS.some(knownIn);
  if (read.kind === "off") {
    return (
      <PanelShell fold={allIn} partial={someIn}>
        <ShellFallback loggedIn={knownIn} />
      </PanelShell>
    );
  }

  const connectedOf = (provider: ModelProvider): boolean =>
    knownIn(provider) || read.targets.some((entry) => entry.target === provider && entry.connected);

  const begin = async (provider: ModelProvider) => {
    setStartingFor(provider);
    setStartError(null);
    setEnded(null);
    try {
      const start = await startLogin(workspaceId, agentId, "model", provider);
      if (!mounted.current) {
        // 시작이 도는 사이 화면이 사라졌다. 서버에 열린 로그인을 남기지 않는다.
        void cancelLogin(workspaceId, agentId, "model", start.loginId).catch(() => undefined);
        return;
      }
      lastProvider.current = provider;
      setActive({ provider, start });
      setConfirmClaude(false);
    } catch (error) {
      setStartError({ provider, message: loginErrorMessage(error) });
      // 중계가 그 사이 꺼졌으면 읽기를 다시 해서 셸 안내로 바꾼다.
      void client.invalidateQueries({ queryKey: targetsKey });
    } finally {
      setStartingFor(null);
    }
  };

  const busy = startingFor !== null || active !== null;
  const disabled = busy || offline;

  const startButton = (provider: ModelProvider, label: string, onClick: () => void) => (
    <Button
      ref={(node) => {
        startRefs.current[provider] = node;
      }}
      type="button"
      size="sm"
      variant="ghost"
      className="tap-target bg-surface shadow-sm"
      disabled={disabled}
      aria-disabled={disabled}
      onClick={onClick}
      data-testid={`model-login-start-${provider}`}
    >
      {startingFor === provider && <Loader2 aria-hidden="true" className="spinner-busy" />}
      {startingFor === provider ? COPY.starting : connectedOf(provider) ? COPY.relogin : label}
    </Button>
  );

  const sessionFor = (provider: ModelProvider) =>
    active !== null && active.provider === provider ? (
      <LoginRelaySession
        key={`${agentId}:${active.start.loginId}`}
        workspaceId={workspaceId}
        agentId={agentId}
        flow="model"
        start={active.start}
        copy={SESSION_COPY}
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
    ) : null;

  const resultFor = (provider: ModelProvider) =>
    ended !== null && active === null && lastProvider.current === provider ? (
      <div
        ref={resultRef}
        tabIndex={-1}
        className="mt-2 flex min-w-0 flex-col gap-1 break-keep border-t border-line px-2 py-3 focus-visible:focus-ring"
        role="status"
        data-testid="model-login-result"
        data-status={ended.status}
      >
        <span className="font-semibold text-ink">{loginReasonLine(ended)}</span>
        {ended.status === "done" && <span className="text-meta text-ink-muted">{COPY.doneNext}</span>}
      </div>
    ) : null;

  const pill = (provider: ModelProvider) => (
    <AiPill tone={connectedOf(provider) ? "ok" : "mute"}>
      {connectedOf(provider) ? COPY.connectedPill : COPY.notConnectedPill}
    </AiPill>
  );

  // 둘 다 로그인돼 있고 지금 진행 중인 로그인이 없으면 블록을 접는다. 다시 로그인은 펼쳐서 한다.
  const idle = !busy && !confirmClaude && ended === null;
  return (
    <PanelShell fold={allIn && idle} partial={someIn}>
      <p className="break-keep px-2 pb-2 pt-3 text-meta text-ink-muted">{COPY.lead}</p>
      <AiLineRow
        testId="model-login-codex"
        action={
          active?.provider === "openai-codex" ? undefined : startButton("openai-codex", COPY.start, () => void begin("openai-codex"))
        }
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{COPY.codexTitle}</span>
          {pill("openai-codex")}
        </span>
        <span className="text-meta text-ink-muted">{COPY.codexDetail}</span>
        {startError?.provider === "openai-codex" && <InlineBanner message={startError.message} testId="model-login-start-error" />}
        {sessionFor("openai-codex")}
        {resultFor("openai-codex")}
      </AiLineRow>
      <AiLineRow
        testId="model-login-claude"
        action={
          confirmClaude || active?.provider === "anthropic"
            ? undefined
            : startButton("anthropic", COPY.start, () => setConfirmClaude(true))
        }
      >
        <span className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{COPY.claudeTitle}</span>
          {pill("anthropic")}
        </span>
        <span className="text-meta text-ink-muted">{COPY.claudeDetail}</span>
        {startError?.provider === "anthropic" && <InlineBanner message={startError.message} testId="model-login-start-error" />}
        {sessionFor("anthropic")}
        {resultFor("anthropic")}
        {confirmClaude && active === null && (
          <span className="flex flex-col items-start gap-2 pt-2" data-testid="model-login-claude-terms">
            <span className="text-body text-ink">{COPY.claudeTerms}</span>
            <span className="flex flex-wrap items-center gap-2">
              <Button
                ref={confirmRef}
                type="button"
                size="sm"
                className="tap-target"
                disabled={disabled}
                aria-disabled={disabled}
                onClick={() => void begin("anthropic")}
                data-testid="model-login-claude-confirm"
              >
                {startingFor === "anthropic" && <Loader2 aria-hidden="true" className="spinner-busy" />}
                {startingFor === "anthropic" ? COPY.starting : COPY.claudeTermsAction}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="tap-target"
                onClick={() => {
                  lastProvider.current = "anthropic";
                  focusAfter.current = "start";
                  setConfirmClaude(false);
                }}
              >
                {COPY.cancel}
              </Button>
            </span>
          </span>
        )}
      </AiLineRow>
      <AiLineRow last testId="model-login-key">
        <span className="font-semibold">{COPY.keyTitle}</span>
        <span className="text-meta text-ink-muted">{COPY.keyDetail}</span>
      </AiLineRow>

      <div className="flex flex-col gap-2 px-2">
        {offline && <InlineBanner tone="neutral" message={COPY.offline} testId="model-login-offline" />}
      </div>
      <p className="break-keep px-2 pt-2 text-meta text-ink-muted">{COPY.teamNote}</p>
    </PanelShell>
  );
}

const MODEL_PROVIDERS: readonly ModelProvider[] = ["openai-codex", "anthropic"];

/** `fold`: 모든 제공자가 로그인됐으면 한 줄로 접는다(#4145). 로그인할 일이 없는 화면이 맨 위를 차지하지 않게. */
function PanelShell({ children, fold = false, partial = false }: { children: React.ReactNode; fold?: boolean; partial?: boolean }) {
  if (fold) {
    return (
      <details className="group flex min-w-0 flex-col pt-4" aria-labelledby={HEADING_ID} data-testid="model-login" data-folded="">
        <summary
          className="-mx-1 flex w-full cursor-pointer list-none items-center gap-2 rounded-sm border-b border-line px-1 pb-2 text-body font-bold text-ink hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring [&::-webkit-details-marker]:hidden"
          data-testid="model-login-fold"
        >
          <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-ink-muted transition-transform group-open:rotate-90" />
          <span id={HEADING_ID}>{COPY.title}</span>
          <AiPill tone="ok">{COPY.allLoggedIn}</AiPill>
        </summary>
        {children}
      </details>
    );
  }
  return (
    <section className="flex min-w-0 flex-col pt-4" aria-labelledby={HEADING_ID} data-testid="model-login">
      <h4 id={HEADING_ID} className="flex items-center gap-2 border-b border-line pb-2 text-body font-bold text-ink">
        {COPY.title}
        {partial && <AiPill tone="mute">{COPY.someLoggedIn}</AiPill>}
      </h4>
      {children}
    </section>
  );
}

/** 중계가 꺼진 서버: 셸 명령을 보인다. 값이 아니라 명령이고 oort를 지나가는 것이 없다. */
function ShellFallback({ loggedIn }: { loggedIn: (provider: ModelProvider) => boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (command: string) => {
    if (typeof navigator.clipboard?.writeText !== "function") return;
    void navigator.clipboard.writeText(command).then(() => {
      setCopied(command);
      setTimeout(() => setCopied(null), 2000);
    });
  };
  const rows: ReadonlyArray<{ provider: ModelProvider; title: string; command: string }> = [
    { provider: "openai-codex", title: COPY.codexTitle, command: MODEL_SHELL_COMMANDS["openai-codex"] },
    { provider: "anthropic", title: COPY.claudeTitle, command: MODEL_SHELL_COMMANDS.anthropic },
  ];
  // 로그인된 제공자는 명령 없이 「로그인됨」 한 줄로 접고, 로그인 안 된 제공자만 명령을 보인다(#4145).
  const todo = rows.filter((row) => !loggedIn(row.provider));
  return (
    <div data-testid="model-login-shell">
      {todo.length > 0 && <p className="break-keep px-2 pb-2 pt-3 text-body text-ink">{COPY.shellLead}</p>}
      {rows
        .filter((row) => loggedIn(row.provider))
        .map((row) => (
          <AiLineRow key={row.command} testId={`model-login-in-${row.provider}`} last={todo.length === 0 && row === rows[rows.length - 1]}>
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{providerLoginName(row.provider)}</span>
              <AiPill tone="ok">{COPY.connectedPill}</AiPill>
            </span>
          </AiLineRow>
        ))}
      {todo.map((row) => (
        <AiLineRow
          key={row.command}
          testId={`model-login-todo-${row.provider}`}
          action={
            <Button type="button" size="sm" variant="ghost" className="tap-target bg-surface shadow-sm" onClick={() => copy(row.command)}>
              {copied === row.command ? COPY.copied : COPY.shellCopy}
            </Button>
          }
        >
          <span className="font-semibold">{row.title}</span>
          <code className="w-max max-w-full rounded-sm bg-muted-soft px-1 font-mono text-meta text-ink [overflow-wrap:anywhere]">
            {row.command}
          </code>
        </AiLineRow>
      ))}
      {todo.length > 0 && (
        <AiLineRow last>
          <span className="text-meta text-ink-muted">{COPY.shellAfter}</span>
        </AiLineRow>
      )}
    </div>
  );
}

/**
 * 웰컴 흐름용 문(#4080): 같은 서버의 Hermes가 이미 연결돼 있고 이 사람이 운영자일 때만 모델 인증을 보인다.
 * 설정 카드와 같은 질문(`["cohosted-agent", ws]`)을 쓰므로 한 번 읽은 답을 나눈다. 아니면 아무것도 그리지 않는다.
 */
export function CohostedModelLogin({ workspaceId, offline }: { workspaceId: string; offline: boolean }) {
  const status = useQuery({
    queryKey: ["cohosted-agent", workspaceId],
    queryFn: () => fetchCohostedStatus(workspaceId),
    retry: false,
  });
  const read = status.data;
  if (read?.kind !== "ready" || read.status.connectedAgentId === null) return null;
  return <ModelLoginPanel workspaceId={workspaceId} agentId={read.status.connectedAgentId} offline={offline} />;
}
