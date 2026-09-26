import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import {
  COPIED_LABEL,
  COPY_ACTION_LABEL,
  HARNESS_LOGIN_COMMAND,
  OPEN_TERMINAL_LABEL,
  loginCommandAria,
} from "@momo/core/features/onboarding/aiConnect";
import { expressionForState } from "@momo/core/features/onboarding/guide";
import {
  HARNESS_LOGIN_CONNECTED_CLOSE_MS,
  HARNESS_LOGIN_METHODS,
  LOGIN_CANCEL_LABEL,
  LOGIN_CHECKING_LINE,
  LOGIN_CLOSE_LABEL,
  LOGIN_CODE_HINT,
  LOGIN_CODE_LABEL,
  LOGIN_CODE_SENT_STATUS,
  LOGIN_CODE_SUBMIT_LABEL,
  LOGIN_CODE_TOGGLE_LABEL,
  LOGIN_CONNECTED_LINE,
  LOGIN_DEVICE_LABEL,
  LOGIN_DONE_LABEL,
  LOGIN_RETRY_LABEL,
  LOGIN_TERMINAL_HIDE_LABEL,
  LOGIN_TERMINAL_SHOW_LABEL,
  loginAcceptsCode,
  loginConnectedDetail,
  loginDialogTitle,
  loginFailedDetail,
  loginFailedLine,
  loginWaitingDetail,
  loginWaitingLine,
  type HarnessLoginMethod,
  type HarnessLoginPhase,
} from "@momo/core/features/onboarding/harnessLogin";
import { keyPlatformOf } from "@momo/core/features/workbench/keymap";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import { loadBrowserMirror } from "@/features/workbench/local/localSessions";
import { LocalTerminalPane } from "@/features/workbench/local/LocalTerminalPane";
import { desktopPty, detectLocalHarnesses, openTerminalApp } from "@/lib/tauri";
import { createLoginController, type LoginController } from "./loginController";

// Reading this as: onboarding (AI 연결 · 로그인 모달) for internal team users on
// Tauri desktop, density 5/10, motion 1/10 (the dialog's own enter/exit only).

/** design 캡처가 세우는 모달 상태. 캡처는 PTY를 만들지 않는다. */
export interface HarnessLoginFixture {
  status: HarnessLoginPhase;
  method?: HarnessLoginMethod;
}

/**
 * 로그인 모달 (#2816, ADR-0190 D3-f, ADR-0193 D2 개정).
 *
 * 열리면 숨은 PTY에서 공식 CLI 로그인 명령을 돌린다. CLI가 시스템 브라우저를
 * 열고 자기 localhost 콜백으로 끝나면 상태 명령으로 확인해 「연결됐어요」로
 * 닫힌다. 기본 흐름에는 터미널이 보이지 않는다: 「터미널로 보기」를 눌렀을
 * 때만 그 PTY를 그린다(기기 코드 흐름은 코드가 터미널에 나오므로 펼쳐서 연다).
 *
 * 로고·브랜드 색·「Sign in with …」 모양이 없다. 문장은 사실만 말한다.
 */
export function HarnessLoginDialog({
  harness,
  method = "browser",
  onClose,
  onConnected,
  onFallbackStarted,
  fixture,
}: {
  /** 로그인할 CLI. null이면 닫혀 있다. */
  harness: LocalHarnessId | null;
  method?: HarnessLoginMethod;
  onClose: () => void;
  /** 상태 명령이 로그인됨을 알렸다. 부른 쪽이 목록을 다시 묻는다. */
  onConnected: (harness: LocalHarnessId) => void;
  /** PTY가 없어 Phase 1(명령 복사 + OS 터미널)로 넘겼다. 부른 쪽이 재확인을 켠다. */
  onFallbackStarted: (harness: LocalHarnessId) => void;
  fixture?: HarnessLoginFixture | null;
}) {
  return (
    <Dialog
      open={harness !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {harness !== null && (
        <LoginDialogBody
          key={harness}
          harness={harness}
          method={fixture?.method ?? method}
          onClose={onClose}
          onConnected={onConnected}
          onFallbackStarted={onFallbackStarted}
          fixture={fixture ?? null}
        />
      )}
    </Dialog>
  );
}

const IDLE_STATE = { status: { phase: "waiting" } as HarnessLoginPhase, paneId: "" };

function useController(
  harness: LocalHarnessId,
  method: HarnessLoginMethod,
  fixture: HarnessLoginFixture | null
): LoginController | null {
  const controller = useMemo(
    () =>
      fixture
        ? null
        : createLoginController(harness, method, {
            pty: desktopPty,
            loadMirror: loadBrowserMirror,
            detect: detectLocalHarnesses,
          }),
    // 한 번 열린 모달은 한 컨트롤러를 쓴다(방법 바꾸기는 retry가 한다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => {
    if (!controller) return;
    controller.open();
    return () => controller.dispose();
  }, [controller]);
  return controller;
}

function LoginDialogBody({
  harness,
  method,
  onClose,
  onConnected,
  onFallbackStarted,
  fixture,
}: {
  harness: LocalHarnessId;
  method: HarnessLoginMethod;
  onClose: () => void;
  onConnected: (harness: LocalHarnessId) => void;
  onFallbackStarted: (harness: LocalHarnessId) => void;
  fixture: HarnessLoginFixture | null;
}) {
  const controller = useController(harness, method, fixture);
  const live = useSyncExternalStore(
    controller?.subscribe ?? noopSubscribe,
    controller?.getState ?? (() => IDLE_STATE),
    () => IDLE_STATE
  );
  const status = fixture?.status ?? live.status;
  const currentMethod = controller ? controller.getState().method : method;
  const lineId = useId();
  const [terminalOpen, setTerminalOpen] = useState(method === "device");
  const connectedRef = useRef(false);
  // 상태마다 키보드의 첫 자리(design-review M1): 기다림 = 취소, 실패 = 다시 시도
  // (없으면 닫기), 연결됨 = 완료. 접힘 링크가 Enter를 먼저 받지 않게 한다.
  const primaryRef = useRef<HTMLButtonElement>(null);
  const focusPrimary = () => primaryRef.current?.focus();
  useEffect(() => {
    focusPrimary();
  }, [status.phase]);

  // 연결됨: 부른 쪽에 한 번 알리고, 잠깐 보여 준 뒤 닫는다.
  useEffect(() => {
    if (fixture || status.phase !== "connected" || connectedRef.current) return;
    connectedRef.current = true;
    onConnected(harness);
    const timer = window.setTimeout(onClose, HARNESS_LOGIN_CONNECTED_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [fixture, status.phase, harness, onClose, onConnected]);

  const guide = guideFor(harness, currentMethod, status);
  const spawnFailed = status.phase === "failed" && status.reason === "spawn";
  // 캡처(픽스처)는 PTY가 없어 접힘 링크만 그린다.
  const canShowTerminal =
    !spawnFailed && status.phase !== "connected" && (controller === null || live.paneId !== "");
  const showCode =
    status.phase === "waiting" && loginAcceptsCode(harness, currentMethod) && !terminalOpen;
  const deviceAvailable =
    status.phase === "failed" &&
    !spawnFailed &&
    currentMethod === "browser" &&
    HARNESS_LOGIN_METHODS[harness].includes("device");

  const retry = (next: HarnessLoginMethod = currentMethod) => {
    if (next === "device") setTerminalOpen(true);
    controller?.retry(next);
  };

  return (
    <DialogContent
      className="harness-login gap-4 p-6"
      aria-describedby={lineId}
      data-testid="harness-login-dialog"
      data-phase={status.phase}
      onEscapeKeyDown={() => onClose()}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        focusPrimary();
      }}
      onCloseAutoFocus={(event) => {
        // 연결된 뒤에는 모달을 연 단추가 사라진다(줄이 준비됨이 된다). 캐럿을
        // 그 줄의 라디오로 옮긴다(design-review M2).
        if (!connectedRef.current) return;
        const radio = document.getElementById(`ai-connect-${harness}`);
        if (radio) {
          event.preventDefault();
          radio.focus();
        }
      }}
    >
      <DialogTitle className="sr-only">{loginDialogTitle(harness)}</DialogTitle>
      <KomettoGuide
        expression={guide.expression}
        line={guide.line}
        detail={guide.detail}
        lineId={lineId}
        lineTestId="harness-login-line"
      />

      {/* 보조 링크 한 묶음(design-review L4). */}
      <div className="flex min-w-0 flex-col gap-2">
        {showCode && <CodeField onSubmit={(code) => controller?.submitCode(code)} />}

        {spawnFailed && (
          <FallbackRow
            harness={harness}
            onStarted={() => {
              onFallbackStarted(harness);
              onClose();
            }}
          />
        )}

        {canShowTerminal && (
          <div className="flex min-w-0 flex-col gap-2">
            <button
              type="button"
              className="harness-login-disclosure press focus-visible:focus-ring"
              aria-expanded={terminalOpen}
              aria-controls={terminalOpen ? `${lineId}-terminal` : undefined}
              onClick={() => setTerminalOpen((open) => !open)}
              data-testid="harness-login-terminal-toggle"
            >
              {terminalOpen ? LOGIN_TERMINAL_HIDE_LABEL : LOGIN_TERMINAL_SHOW_LABEL}
            </button>
            {terminalOpen && controller !== null && (
              <div
                id={`${lineId}-terminal`}
                className="harness-login-terminal"
                data-testid="harness-login-terminal"
              >
                <LocalTerminalPane
                  key={live.paneId}
                  pane={{ id: live.paneId, index: 1, focused: true, maximized: false }}
                  platform={keyPlatformOf(navigator.platform || navigator.userAgent)}
                  sessions={controller.sessions}
                  label={`${loginDialogTitle(harness)} 터미널`}
                  restartable={false}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        {deviceAvailable && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            onClick={() => retry("device")}
            data-testid="harness-login-device"
          >
            {LOGIN_DEVICE_LABEL}
          </Button>
        )}
        {status.phase === "connected" ? (
          <Button ref={primaryRef} type="button" onClick={onClose} data-testid="harness-login-done">
            {LOGIN_DONE_LABEL}
          </Button>
        ) : status.phase === "failed" ? (
          <>
            <Button
              ref={spawnFailed ? primaryRef : undefined}
              type="button"
              variant="outline"
              className="ai-connect-secondary"
              onClick={onClose}
              data-testid="harness-login-close"
            >
              {LOGIN_CLOSE_LABEL}
            </Button>
            {!spawnFailed && (
              <Button
                ref={primaryRef}
                type="button"
                onClick={() => retry()}
                data-testid="harness-login-retry"
              >
                {LOGIN_RETRY_LABEL}
              </Button>
            )}
          </>
        ) : (
          <Button
            ref={primaryRef}
            type="button"
            variant="outline"
            className="ai-connect-secondary"
            onClick={onClose}
            data-testid="harness-login-cancel"
          >
            {LOGIN_CANCEL_LABEL}
          </Button>
        )}
      </div>
    </DialogContent>
  );
}

function noopSubscribe(): () => void {
  return () => undefined;
}

function guideFor(
  harness: LocalHarnessId,
  method: HarnessLoginMethod,
  status: HarnessLoginPhase
): { expression: ReturnType<typeof expressionForState>; line: string; detail?: string } {
  switch (status.phase) {
    case "waiting":
      return {
        expression: expressionForState("checking"),
        line: loginWaitingLine(method),
        detail: loginWaitingDetail(harness),
      };
    case "checking":
      return { expression: expressionForState("checking"), line: LOGIN_CHECKING_LINE };
    case "connected":
      return {
        expression: expressionForState("success"),
        line: LOGIN_CONNECTED_LINE,
        detail: loginConnectedDetail(harness),
      };
    default:
      return {
        expression: expressionForState("trouble"),
        line: loginFailedLine(status.reason),
        detail: loginFailedDetail(harness, status.reason),
      };
  }
}

/**
 * CLI가 콜백 대신 코드를 요구할 때의 입력 칸 하나. 기본은 접혀 있다(기본 흐름은
 * 브라우저 콜백). 보낸 코드는 PTY 입력으로만 가고, 이 칸의 값은 곧바로 비운다.
 */
function CodeField({
  onSubmit,
}: {
  onSubmit: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  if (!open) {
    return (
      <button
        type="button"
        className="harness-login-disclosure press focus-visible:focus-ring"
        onClick={() => setOpen(true)}
        data-testid="harness-login-code-toggle"
      >
        {LOGIN_CODE_TOGGLE_LABEL}
      </button>
    );
  }
  return (
    <form
      className="flex min-w-0 flex-col gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        if (code.trim() === "") return;
        onSubmit(code);
        setCode("");
        setSent(true);
      }}
      data-testid="harness-login-code-form"
    >
      <label htmlFor={inputId} className="text-meta text-ink-muted">
        {LOGIN_CODE_LABEL}
      </label>
      <div className="flex min-w-0 items-center gap-2">
        <Input
          id={inputId}
          value={code}
          onChange={(event) => {
            setCode(event.target.value);
            setSent(false);
          }}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-describedby={hintId}
          autoFocus
          className="min-w-0 flex-1 font-mono"
          data-testid="harness-login-code-input"
        />
        <Button
          type="submit"
          variant="outline"
          disabled={code.trim() === ""}
          data-testid="harness-login-code-submit"
        >
          {LOGIN_CODE_SUBMIT_LABEL}
        </Button>
      </div>
      <p id={hintId} className="break-keep text-meta text-ink-muted" role="status">
        {sent ? LOGIN_CODE_SENT_STATUS : LOGIN_CODE_HINT}
      </p>
    </form>
  );
}

/**
 * Phase 1 폴백(PTY가 없는 빌드·플랫폼, 셸 거부): 공식 로그인 명령을 복사하고 OS
 * 터미널을 연다. oort는 CLI를 실행하지 않는다(셸 `open_terminal_app`은 인자가 없다).
 */
function FallbackRow({
  harness,
  onStarted,
}: {
  harness: LocalHarnessId;
  onStarted: () => void;
}) {
  const command = HARNESS_LOGIN_COMMAND[harness];
  const { copied, copy } = useClipboardCopy(command);
  return (
    <div
      className="ai-connect-term"
      role="group"
      aria-label={loginCommandAria(harness)}
      data-testid="harness-login-fallback"
    >
      <code className="min-w-0 flex-1 truncate">
        <span aria-hidden="true">$ </span>
        {command}
      </code>
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ai-connect-term-action ai-connect-secondary"
        onClick={() => {
          void (async () => {
            await copy();
            await openTerminalApp();
            onStarted();
          })();
        }}
        data-testid="harness-login-fallback-open"
      >
        {OPEN_TERMINAL_LABEL}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="ai-connect-term-action"
        aria-label={`${loginCommandAria(harness)} ${copied ? COPIED_LABEL : COPY_ACTION_LABEL}`}
        onClick={() => void copy()}
      >
        {copied ? COPIED_LABEL : COPY_ACTION_LABEL}
      </Button>
    </div>
  );
}
