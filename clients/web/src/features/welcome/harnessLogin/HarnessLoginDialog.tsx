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
import { remoteProfileLoginLine } from "@momo/core/features/settings/remoteWorkProfile";
import {
  PROFILE_LOGIN_SPAWN_DETAIL,
  profileLoginLine,
} from "@momo/core/features/settings/harnessProfiles";
import {
  desktopPty,
  detectLocalHarnesses,
  harnessProfileRemoteStatus,
  harnessProfileStatus,
  openTerminalApp,
} from "@/lib/tauri";
import { createLoginController, type LoginController } from "./loginController";
import {
  RegisterStepBody,
  type RegisterContext,
  type RegisterFixture,
} from "./RegisterStepBody";

export type { RegisterContext, RegisterFixture } from "./RegisterStepBody";

// Reading this as: onboarding (AI 연결 · 로그인 모달) for internal team users on
// Tauri desktop, density 5/10, motion 1/10 (the dialog's own enter/exit only).

/** design 캡처가 세우는 모달 상태. 캡처는 PTY를 만들지 않는다. */
export interface HarnessLoginFixture {
  status: HarnessLoginPhase;
  method?: HarnessLoginMethod;
  /** 로그인 뒤 「에이전트로 만들기」 단계를 세운다(컨트롤러 없이). */
  register?: RegisterFixture;
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
  profile = null,
  remote = false,
  method = "browser",
  onClose,
  onConnected,
  onFallbackStarted,
  focusAfterConnected,
  onLoginEnded,
  fixture,
  register = null,
  startAt = "login",
}: {
  /** 로그인할 CLI. null이면 닫혀 있다. */
  harness: LocalHarnessId | null;
  /**
   * 있으면 로그인이 끝난 뒤 같은 창이 「이 맥의 Claude Code를 @이름으로 부를 수 있게
   * 할까요?」로 이어진다(#3389). 기본 위치 로그인에만 준다(프로필·원격 작업 로그인은
   * 다른 설정 폴더라 이 연결의 대상이 아니다). 없으면 예전처럼 「연결됐어요」 뒤 닫힌다.
   */
  register?: RegisterContext | null;
  /** `register`: 이미 로그인된 CLI에서 곧바로 확인 단계로 연다. */
  startAt?: "login" | "register";
  /**
   * oort 프로필 라벨(#2878, 시안 §3 「재연동 연결 지점」·§4 2a). 계정 목록이 넘기는
   * 것은 이것 하나다. 셸이 그 폴더를 CLI의 설정 폴더로 넘기고, 완료 판정도 그
   * 폴더로 돌린 상태 명령이다. 없으면 이 맥의 기본 위치(온보딩·채팅 카드).
   */
  profile?: string | null;
  /**
   * `profile`이 이 맥의 「원격 작업」 계정 라벨이다(#3157). 셸이 workd의 원격 작업용
   * 폴더로 로그인하고, 완료 판정도 그 폴더의 상태 명령이다. 기본 AI 표가 연다.
   */
  remote?: boolean;
  /**
   * 연결된 뒤 모달이 닫힐 때 초점을 받을 곳. 연 단추가 사라지는 목록(다시 로그인)이
   * 쓴다. 없으면 AI 연결 화면의 그 줄 라디오, 그것도 없으면 연 단추.
   */
  focusAfterConnected?: () => HTMLElement | null;
  /**
   * 모달이 닫힌 뒤 로그인 CLI가 정말 끝났는지(#2996 재검수 M-1). 끝나야 부른 쪽이
   * 방금 만든 폴더를 치울 수 있다. false = 제한 시간 안에 끝나지 않았다.
   */
  onLoginEnded?: (ended: boolean) => void;
  method?: HarnessLoginMethod;
  onClose: () => void;
  /** 상태 명령이 로그인됨을 알렸다. 부른 쪽이 목록을 다시 묻는다. */
  onConnected: (harness: LocalHarnessId) => void;
  /** PTY가 없어 Phase 1(명령 복사 + OS 터미널)로 넘겼다. 부른 쪽이 재확인을 켠다. */
  onFallbackStarted: (harness: LocalHarnessId) => void;
  fixture?: HarnessLoginFixture | null;
}) {
  const guardRef = useRef(false);
  return (
    <Dialog
      open={harness !== null}
      onOpenChange={(open) => {
        // 만드는 중이거나 한 번만 보이는 값이 떠 있을 때는 Esc·바깥 누름으로 닫지 않는다.
        // 단추(「완료」)로는 닫힌다.
        if (!open && !guardRef.current) onClose();
      }}
    >
      {harness !== null && (
        <LoginDialogBody
          key={`${harness}/${profile ?? ""}/${remote ? "remote" : "local"}`}
          harness={harness}
          profile={profile}
          remote={remote}
          focusAfterConnected={focusAfterConnected}
          onLoginEnded={onLoginEnded}
          method={fixture?.method ?? method}
          onClose={onClose}
          onConnected={onConnected}
          onFallbackStarted={onFallbackStarted}
          fixture={fixture ?? null}
          guardRef={guardRef}
          register={profile === null && !remote ? register : null}
          startAt={profile === null && !remote && register ? startAt : "login"}
        />
      )}
    </Dialog>
  );
}

const IDLE_STATE = { status: { phase: "waiting" } as HarnessLoginPhase, paneId: "" };

function useController(
  harness: LocalHarnessId,
  profile: string | null,
  remote: boolean,
  method: HarnessLoginMethod,
  fixture: HarnessLoginFixture | null,
  onLoginEnded: ((ended: boolean) => void) | undefined,
  skipLogin: boolean
): LoginController | null {
  const endedRef = useRef(onLoginEnded);
  endedRef.current = onLoginEnded;
  const controller = useMemo(
    () =>
      fixture || skipLogin
        ? null
        : createLoginController(
            harness,
            method,
            {
              pty: desktopPty,
              loadMirror: loadBrowserMirror,
              // 판정은 로그인한 그 폴더의 상태 명령이다(프로필이면 그 프로필).
              detect:
                profile === null
                  ? detectLocalHarnesses
                  : async () => [
                      await (remote ? harnessProfileRemoteStatus : harnessProfileStatus)({
                        harness,
                        label: profile,
                      }),
                    ],
            },
            profile,
            remote
          ),
    // 한 번 열린 모달은 한 컨트롤러를 쓴다(방법 바꾸기는 retry가 한다).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );
  useEffect(() => {
    if (!controller) return;
    controller.open();
    return () => {
      controller.dispose();
      const report = endedRef.current;
      if (report) void controller.whenEnded().then(report);
    };
  }, [controller]);
  return controller;
}

function LoginDialogBody({
  harness,
  profile,
  remote,
  focusAfterConnected,
  onLoginEnded,
  method,
  onClose,
  onConnected,
  onFallbackStarted,
  fixture,
  register,
  startAt,
  guardRef,
}: {
  register: RegisterContext | null;
  startAt: "login" | "register";
  guardRef: { current: boolean };
  harness: LocalHarnessId;
  profile: string | null;
  remote: boolean;
  focusAfterConnected: (() => HTMLElement | null) | undefined;
  onLoginEnded: ((ended: boolean) => void) | undefined;
  method: HarnessLoginMethod;
  onClose: () => void;
  onConnected: (harness: LocalHarnessId) => void;
  onFallbackStarted: (harness: LocalHarnessId) => void;
  fixture: HarnessLoginFixture | null;
}) {
  const skipLogin = register !== null && startAt === "register";
  const controller = useController(
    harness,
    profile,
    remote,
    method,
    fixture,
    onLoginEnded,
    skipLogin
  );
  // 로그인 뒤의 「에이전트로 만들기」 단계(#3389). 로그인을 막 마쳤는지(`fresh`)에 따라
  // 첫 줄의 「로그인됐어요」가 달라진다.
  const [stage, setStage] = useState<"login" | "register">(
    register !== null && (startAt === "register" || fixture?.register) ? "register" : "login"
  );
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
    // 에이전트로 만들 수 있는 로그인은 닫지 않고 같은 창에서 물어본다.
    if (register !== null) {
      setStage("register");
      return;
    }
    const timer = window.setTimeout(onClose, HARNESS_LOGIN_CONNECTED_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [fixture, status.phase, harness, onClose, onConnected, register]);

  const guide = guideFor(harness, currentMethod, status, profile);
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

  if (stage === "register" && register !== null) {
    return (
      <DialogContent
        className="harness-login gap-4 p-6"
        data-testid="harness-login-dialog"
        data-phase="register"
        onEscapeKeyDown={(event) => {
          if (guardRef.current) event.preventDefault();
          else onClose();
        }}
        onInteractOutside={(event) => {
          if (guardRef.current) event.preventDefault();
        }}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        <DialogTitle className="sr-only">{loginDialogTitle(harness)}</DialogTitle>
        <RegisterStepBody
          onGuard={(guarded) => {
            guardRef.current = guarded;
          }}
          harness={harness}
          context={register}
          onClose={onClose}
          fixture={fixture?.register ?? null}
          showLoggedIn={startAt !== "register"}
        />
      </DialogContent>
    );
  }

  return (
    <DialogContent
      className="harness-login gap-4 p-6"
      aria-describedby={lineId}
      data-testid="harness-login-dialog"
      data-phase={status.phase}
      data-profile={profile ?? undefined}
      data-lane={remote ? "remote" : undefined}
      onEscapeKeyDown={() => onClose()}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        focusPrimary();
      }}
      onCloseAutoFocus={(event) => {
        // 연결된 뒤에는 모달을 연 단추가 사라진다(줄이 준비됨이 된다). 캐럿을
        // 그 줄의 라디오로 옮긴다(design-review M2).
        if (!connectedRef.current) return;
        const target = focusAfterConnected?.();
        if (target) {
          event.preventDefault();
          target.focus();
          return;
        }
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
      {/* 어느 계정 폴더에 로그인하는지(프로필이 둘 이상이면 헷갈린다). */}
      {profile !== null && (
        <p className="break-keep text-meta text-ink-muted [overflow-wrap:anywhere]" data-testid="harness-login-profile">
          {remote ? remoteProfileLoginLine(harness, profile) : profileLoginLine(harness, profile)}
        </p>
      )}

      {/* 보조 링크 한 묶음(design-review L4). */}
      <div className="flex min-w-0 flex-col gap-2">
        {showCode && <CodeField onSubmit={(code) => controller?.submitCode(code)} />}

        {spawnFailed && profile === null && (
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
            onClick={(event) => {
              // [다시 시도]를 두 번 누르면 둘째 누름이 같은 자리에 새로 선 [취소]에
              // 떨어진다(#2902 L1). 겹 누름의 둘째부터는 취소로 받지 않는다.
              if (event.detail > 1) return;
              onClose();
            }}
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
  status: HarnessLoginPhase,
  profile: string | null
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
        // 프로필 폴더로 로그인하는 복사 명령은 없다: 기본 위치 명령을 주면 다른
        // 계정 폴더에 로그인된다(#2878).
        detail:
          profile !== null && status.reason === "spawn"
            ? PROFILE_LOGIN_SPAWN_DETAIL
            : loginFailedDetail(harness, status.reason),
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
