import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Link } from "react-router-dom";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { AI_CONNECT_ROW_COPY, HARNESS_LABEL, type HarnessPill } from "@momo/core/features/onboarding/aiConnect";
import { loginFailedLine, loginWaitingLine } from "@momo/core/features/onboarding/harnessLogin";
import {
  DISCONNECT_FAILED_LINE,
  HARNESS_LOGIN_VIEW_LABEL,
  HOST_VIEW_LABEL,
  TOOLS_COPY,
  harnessLoginTone,
  harnessLoginView,
  hostDetail,
  hostTone,
  type DisconnectProgress,
  type HostView,
  type LoginProgress,
} from "@momo/core/features/ai/harnessCard";
import { Card } from "@/design/ui/card";
import { Button } from "@/design/ui/button";
import { AiLogo, AiPill, AiSource } from "@/features/settings/aiAccountsParts";
import { HarnessLoginDialog } from "@/features/welcome/harnessLogin/HarnessLoginDialog";
import type { LoginController, LoginControllerState } from "@/features/welcome/harnessLogin/loginController";
import type { UnlinkController, UnlinkControllerState } from "@/features/welcome/harnessLogin/unlinkController";
import type { HarnessSessionStore } from "./harnessSessionStore";
import { PersonalAgentRow, type PersonalAgentRowProps } from "./PersonalAgentRow";

// Reading this as: AI hub › 내 도구 for internal team users on Tauri desktop and the
// web tab, density 6/10, motion 1/10. One card per tool joins the login state (exit
// code of the official CLI) with the host state (server `online`), ADR-0198 D3.

const noopSubscribe = () => () => undefined;
const NO_LOGIN: LoginControllerState = {
  harness: "claude",
  method: "browser",
  paneId: "",
  status: { phase: "waiting" },
};
const NO_UNLINK: UnlinkControllerState = { harness: "claude", paneId: "", status: { phase: "confirm" } };

function useLoginState(ctl: LoginController | null): LoginControllerState | null {
  const state = useSyncExternalStore(
    ctl?.subscribe ?? noopSubscribe,
    ctl ? ctl.getState : () => NO_LOGIN,
    () => NO_LOGIN
  );
  return ctl ? state : null;
}

function useUnlinkState(ctl: UnlinkController | null): UnlinkControllerState | null {
  const state = useSyncExternalStore(
    ctl?.subscribe ?? noopSubscribe,
    ctl ? ctl.getState : () => NO_UNLINK,
    () => NO_UNLINK
  );
  return ctl ? state : null;
}

/** 컨트롤러의 로그인 진행 → 카드 판정 입력. 끝난 로그인(연결됨·실패)은 진행이 아니다. */
function loginProgressOf(state: LoginControllerState | null): LoginProgress {
  if (!state) return null;
  return state.status.phase === "waiting" || state.status.phase === "checking" ? state.status.phase : null;
}

/** 해제 컨트롤러의 상태 → 카드 판정 입력. */
function disconnectProgressOf(state: UnlinkControllerState | null): DisconnectProgress {
  if (!state) return { phase: "idle" };
  const status = state.status;
  switch (status.phase) {
    case "confirm":
      return { phase: "idle" };
    case "signing-out":
      return { phase: "signing-out" };
    case "removing":
      return { phase: "verifying" };
    case "done":
      return { phase: "done" };
    case "failed":
      return {
        phase: "failed",
        reason:
          status.reason === "still-signed-in"
            ? "still-logged-in"
            : status.reason === "remove-failed"
              ? "unknown"
              : status.reason,
      };
  }
}

export interface HarnessCardProps {
  harness: LocalHarnessId;
  /** 이 맥의 CLI를 다루는 데스크탑 화면인가. 웹은 호스트와 개인 에이전트만 말한다. */
  desktop: boolean;
  pill: HarnessPill;
  host: HostView;
  sessions: HarnessSessionStore;
  sessionsVersion: number;
  onRecheck: (id: LocalHarnessId) => void;
  /** 호스트 목록을 다시 읽는다(읽기 실패 줄의 「다시 읽기」). */
  onRetryHost: () => void;
  personal: Omit<PersonalAgentRowProps, "harness" | "title">;
}

export function HarnessCard({ harness, desktop, pill, host, sessions, sessionsVersion, onRecheck, onRetryHost, personal }: HarnessCardProps) {
  void sessionsVersion; // 보관소가 바뀌면 이 카드가 다시 그려진다.
  const loginCtl = sessions.getSnapshot().login(harness);
  const unlinkCtl = sessions.getSnapshot().unlink(harness);
  const loginState = useLoginState(loginCtl);
  const unlinkState = useUnlinkState(unlinkCtl);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  // 누른 단추가 사라지는 자리(확인 상자·로그인 중 줄)에서 초점이 body로 떨어지지 않게,
  // 다음 그림 뒤에 옮길 곳의 이름을 들고 있다(design-review High: 키보드 초점 유실).
  const [focusSlot, setFocusSlot] = useState<string | null>(null);
  useEffect(() => {
    if (focusSlot === null) return;
    const target = document.querySelector<HTMLElement>(
      `[data-testid="tool-card-${harness}"] [data-focus-slot="${focusSlot}"]`
    );
    if (target) {
      target.focus();
      setFocusSlot(null);
    }
  }, [focusSlot, harness, loginState, unlinkState, confirming]);
  const name = HARNESS_LABEL[harness];
  const titleId = useId();

  const login = loginProgressOf(loginState);
  const disconnect = disconnectProgressOf(unlinkState);
  const view = harnessLoginView({ pill, login, disconnect });
  const loginPhase = loginState?.status.phase ?? null;
  const loginFailed = loginState?.status.phase === "failed" ? loginState.status : null;

  // 끝나는 순간(끊기 완료·실패, 로그인 연결)에 초점이 있던 줄이 사라지면 다음 행동으로 옮긴다.
  const lostFocus = () => document.activeElement === null || document.activeElement === document.body;
  const previousDisconnect = useRef(disconnect.phase);
  useEffect(() => {
    const was = previousDisconnect.current;
    previousDisconnect.current = disconnect.phase;
    const wasBusy = was === "signing-out" || was === "verifying";
    if (!wasBusy || !lostFocus()) return;
    if (disconnect.phase === "failed") setFocusSlot("disconnecting");
    else if (disconnect.phase === "done") setFocusSlot("login");
  }, [disconnect.phase]);

  // 로그인이 끝나면 한 번 다시 묻고 보관소를 비운다(모달은 마지막 상태를 그대로 보인다).
  const handledConnected = useRef<LoginController | null>(null);
  useEffect(() => {
    if (loginPhase !== "connected" || !loginCtl || handledConnected.current === loginCtl) return;
    handledConnected.current = loginCtl;
    if (lostFocus()) setFocusSlot("disconnect");
    onRecheck(harness);
    sessions.dismissLogin(harness);
  }, [loginPhase, loginCtl, harness, onRecheck, sessions]);

  // 끊기가 확인된 뒤 알약을 다시 묻는다.
  const handledDone = useRef<UnlinkController | null>(null);
  useEffect(() => {
    if (disconnect.phase !== "done" || !unlinkCtl || handledDone.current === unlinkCtl) return;
    handledDone.current = unlinkCtl;
    onRecheck(harness);
  }, [disconnect.phase, unlinkCtl, harness, onRecheck]);

  const startLogin = () => {
    sessions.dismissDisconnect(harness);
    sessions.startLogin(harness);
    setDialogOpen(true);
  };
  const cancelLogin = () => {
    setDialogOpen(false);
    sessions.dismissLogin(harness);
    setFocusSlot("login");
  };

  const needsLogin = view === "reauth" || view === "disconnected" || view === "unknown";
  const hostTexts = hostDetail(host, desktop);
  const personalOn = personal.agent?.enabled === true;

  return (
    <Card
      className="flex min-w-0 flex-col gap-3 p-card"
      data-testid={`tool-card-${harness}`}
      data-login={desktop ? view : "remote"}
      data-host={host}
      data-personal={personalOn ? "on" : "off"}
      role="group"
      aria-labelledby={titleId}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-full items-center gap-3 sm:basis-0">
          <AiLogo mark={AI_CONNECT_ROW_COPY[harness].mark} />
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span id={titleId} className="break-keep text-body font-semibold text-ink">
                {name}
              </span>
              {personalOn && (
                <span data-testid={`tool-card-${harness}-personal-badge`}>
                  <AiSource>개인</AiSource>
                </span>
              )}
              {personalOn && personal.agent && (
                <span className="break-all text-meta text-ink-muted" data-testid={`tool-card-${harness}-alias`}>
                  @{personal.agent.handle}
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="ms-auto flex shrink-0 flex-wrap items-center gap-2">
          {desktop && (
            <span data-testid={`tool-card-${harness}-login-pill`} data-view={view}>
              <AiPill tone={harnessLoginTone(view)}>{HARNESS_LOGIN_VIEW_LABEL[view]}</AiPill>
            </span>
          )}
          <span data-testid={`tool-card-${harness}-host-pill`} data-view={host}>
            <AiPill tone={hostTone(host)}>{HOST_VIEW_LABEL[host]}</AiPill>
          </span>
        </div>
      </div>

      {hostTexts !== "" && (
        <p className="break-keep text-meta text-ink-muted" data-testid={`tool-card-${harness}-host-detail`}>
          {hostTexts}
          {host === "unregistered" && desktop && (
            <>
              {" "}
              <Link
                to="/settings?section=devices"
                className="press underline underline-offset-2 focus-visible:focus-ring"
                data-testid={`tool-card-${harness}-register-host`}
              >
                {TOOLS_COPY.registerHost}
              </Link>
            </>
          )}
        </p>
      )}

      {host === "unknown" && (
        <div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="tap-target"
            onClick={onRetryHost}
            data-testid={`tool-card-${harness}-host-retry`}
          >
            {TOOLS_COPY.hostRetry}
          </Button>
        </div>
      )}

      {!desktop && (
        <p className="break-keep text-meta text-ink-muted" data-testid={`tool-card-${harness}-web-note`}>
          {TOOLS_COPY.webLoginNote}
        </p>
      )}

      {desktop && view === "logging-in" && (
        <p className="break-keep text-meta text-ink" role="status" data-testid={`tool-card-${harness}-progress`}>
          {loginState?.status.phase === "checking" ? "로그인을 확인하고 있어요." : loginWaitingLine(loginState?.method ?? "browser")}
        </p>
      )}
      {desktop && loginFailed && (
        <p
          className="break-keep text-meta text-ink"
          role="alert"
          tabIndex={-1}
          data-focus-slot="login-open"
          data-testid={`tool-card-${harness}-login-failed`}
        >
          {loginFailedLine(loginFailed.reason)}
        </p>
      )}
      {desktop && disconnect.phase === "failed" && (
        <p
          className="break-keep text-meta text-ink"
          role="alert"
          tabIndex={-1}
          data-focus-slot="disconnecting"
          data-testid={`tool-card-${harness}-disconnect-failed`}
        >
          {DISCONNECT_FAILED_LINE[disconnect.reason]}
        </p>
      )}
      {desktop && view === "disconnecting" && (
        <p
          className="break-keep text-meta text-ink"
          role="status"
          tabIndex={-1}
          data-focus-slot="disconnecting"
          data-testid={`tool-card-${harness}-disconnecting`}
        >
          {disconnect.phase === "verifying" ? "로그인이 풀렸는지 확인하고 있어요." : "로그아웃하고 있어요."}
        </p>
      )}
      {desktop && view === "not-installed" && (
        <p className="break-keep text-meta text-ink-muted">{TOOLS_COPY.notInstalled}</p>
      )}
      {desktop && view === "unknown" && (
        <p className="break-keep text-meta text-ink-muted">{TOOLS_COPY.checkFailed}</p>
      )}

      {desktop && (
        <div className="flex min-w-0 flex-wrap items-center gap-2" data-testid={`tool-card-${harness}-actions`}>
          {needsLogin && loginFailed === null && (
            <Button
              type="button"
              size="sm"
              className="tap-target"
              onClick={startLogin}
              data-focus-slot="login"
              data-testid={`tool-card-${harness}-login`}
            >
              {TOOLS_COPY.login}
            </Button>
          )}
          {loginFailed !== null && (
            <>
              <Button
                type="button"
                size="sm"
                className="tap-target"
                onClick={() => {
                  sessions.dismissLogin(harness);
                  startLogin();
                }}
                data-testid={`tool-card-${harness}-login-retry`}
              >
                {TOOLS_COPY.retry}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="tap-target"
                onClick={() => sessions.dismissLogin(harness)}
                data-testid={`tool-card-${harness}-login-dismiss`}
              >
                {TOOLS_COPY.dismiss}
              </Button>
            </>
          )}
          {view === "logging-in" && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="tap-target"
                onClick={() => setDialogOpen(true)}
                data-focus-slot="login-open"
                data-testid={`tool-card-${harness}-open`}
              >
                {TOOLS_COPY.open}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="tap-target"
                onClick={cancelLogin}
                data-testid={`tool-card-${harness}-cancel`}
              >
                {TOOLS_COPY.cancel}
              </Button>
            </>
          )}
          {view === "connected" && !confirming && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="tap-target"
              onClick={() => {
                setConfirming(true);
                setFocusSlot("disconnect-keep");
              }}
              data-focus-slot="disconnect"
              data-testid={`tool-card-${harness}-disconnect`}
            >
              {TOOLS_COPY.disconnect}
            </Button>
          )}
          {disconnect.phase === "failed" && (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="tap-target"
                onClick={() => sessions.startDisconnect(harness)}
                data-testid={`tool-card-${harness}-disconnect-retry`}
              >
                {TOOLS_COPY.retry}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="tap-target"
                onClick={() => sessions.dismissDisconnect(harness)}
                data-testid={`tool-card-${harness}-disconnect-dismiss`}
              >
                {TOOLS_COPY.dismiss}
              </Button>
            </>
          )}
        </div>
      )}

      {desktop && view === "connected" && confirming && (
        <div
          className="flex min-w-0 flex-col gap-2 rounded-lg bg-surface-muted px-3 py-2"
          role="group"
          aria-label={TOOLS_COPY.disconnect}
          data-testid={`tool-card-${harness}-disconnect-confirm`}
        >
          <p className="break-keep text-meta text-ink">{TOOLS_COPY.disconnectWarn}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="destructive"
              className="tap-target"
              onClick={() => {
                setConfirming(false);
                sessions.startDisconnect(harness);
                setFocusSlot("disconnecting");
              }}
              data-testid={`tool-card-${harness}-disconnect-go`}
            >
              {TOOLS_COPY.disconnectConfirm}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="tap-target"
              onClick={() => {
                setConfirming(false);
                setFocusSlot("disconnect");
              }}
              data-focus-slot="disconnect-keep"
              data-testid={`tool-card-${harness}-disconnect-keep`}
            >
              {TOOLS_COPY.disconnectKeep}
            </Button>
          </div>
        </div>
      )}

      <PersonalAgentRow harness={harness} title={name} {...personal} />

      {desktop && (
        <HarnessLoginDialog
          harness={dialogOpen && loginCtl ? harness : null}
          controller={loginCtl}
          onCancel={cancelLogin}
          onClose={() => {
            // 창이 닫히면 초점은 카드의 다음 행동으로(연 단추는 이미 사라졌다).
            setDialogOpen(false);
            setFocusSlot("login-open");
          }}
          onConnected={() => undefined}
          onFallbackStarted={onRecheck}
        />
      )}
    </Card>
  );
}
