import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
  type ReactNode,
} from "react";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { joinWithInvite, login, type LoginResponse } from "@momo/core/lib/api";
import { parseJoinFromPageUrl } from "@momo/core/features/auth/deepLink";
import {
  API_BASE_DEFAULT,
  CONFIGURED_WORKSPACE,
  DEV_EMAIL,
  DEV_PASSWORD,
  IS_TAURI,
  TEST_PREFILL_ACTIVE,
} from "@/lib/env";
import {
  SERVER_URL_PLACEHOLDER,
  getServerBase,
  normalizeServerUrl,
  requiresServerUrl,
  setServerBase,
} from "@/lib/serverBase";
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
import { DeviceLinkCard } from "@/features/settings/DeviceLinkCard";
import { RuntimeBadge } from "@/app/RuntimeBadge";
import { titlebarDragProps } from "@/app/sidebarPane";
import { UpdateNotice } from "@/features/updates/UpdateNotice";
import { DiscoveredServerList } from "./DiscoveredServerList";
import { useDiscoveredServers, type DiscoveredServer } from "./discovery";
import { LandingStep } from "./LandingStep";
import { OnboardingSlideTransition } from "./OnboardingSlideTransition";
import {
  gatewayPrefillFocus,
  initialOnboarding,
  progressLabel,
  transitionFor,
  type OnboardingPath,
  type OnboardingStep,
  type OnboardingTransitionDirection,
  type OnboardingTransitionEffect,
} from "./onboardingFlow";
import { readRecentServers, rememberRecentServer } from "./recentServers";
import { useJoinPrefill } from "./useJoinPrefill";
import {
  joinFailureCopy,
  prefillFocus,
  signInFailureCopy,
  type ConnectFailure,
  type ConnectField,
  type ConnectMode,
} from "@momo/core/features/auth/connectModel";

type ShellFocus = ConnectField | "next" | "choose-server" | "choose-invite";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 4/10 (S0 landing only; S1/S2 stay the connect form).

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

function readOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onStoreChange) => {
      const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
      mq.addEventListener("change", onStoreChange);
      return () => mq.removeEventListener("change", onStoreChange);
    },
    () => window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    () => false
  );
}

function readInitialOnboarding(): {
  step: OnboardingStep;
  path: OnboardingPath | null;
} {
  if (typeof window === "undefined") {
    return { step: "landing", path: null };
  }
  const prefill = parseJoinFromPageUrl(window.location.href);
  return initialOnboarding({
    hasStoredServer: getServerBase() !== null,
    hasInvitePrefill: Boolean(prefill?.inviteCode),
  });
}

const WORKSPACE_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

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

export function ConnectPage({
  onLoggedIn,
}: {
  onLoggedIn: (session: LoginResponse) => void;
}) {
  const requiresServer = requiresServerUrl();
  const reducedMotion = usePrefersReducedMotion();
  const started = useRef(readInitialOnboarding());
  const [step, setStep] = useState<OnboardingStep>(started.current.step);
  const [path, setPath] = useState<OnboardingPath | null>(started.current.path);
  const [direction, setDirection] =
    useState<OnboardingTransitionDirection>("forward");
  const [effect, setEffect] = useState<OnboardingTransitionEffect>("none");
  const [recent, setRecent] = useState(readRecentServers);

  const [serverUrl, setServerUrl] = useState(
    () => getServerBase() ?? API_BASE_DEFAULT
  );
  const [email, setEmail] = useState(DEV_EMAIL);
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [workspace, setWorkspace] = useState(CONFIGURED_WORKSPACE);
  const [workspaceOpen, setWorkspaceOpen] = useState(CONFIGURED_WORKSPACE !== "");
  const [inviteCode, setInviteCode] = useState("");
  const [mode, setMode] = useState<ConnectMode>(
    started.current.path === "invite" ? "join" : "signIn"
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);
  const [pendingFocus, setPendingFocus] = useState<ShellFocus | null>(null);
  const [phoneLinkSession, setPhoneLinkSession] = useState<LoginResponse | null>(
    null
  );

  const online = useSyncExternalStore(subscribeOnline, readOnline, () => true);
  const discovered = useDiscoveredServers();
  const prefill = useJoinPrefill();

  const serverRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const chooseServerRef = useRef<HTMLButtonElement>(null);
  const chooseInviteRef = useRef<HTMLButtonElement>(null);

  const typed = useRef({ serverUrl, email, password });
  typed.current = { serverUrl, email, password };
  const stepRef = useRef(step);
  stepRef.current = step;

  const focusLater = useCallback((field: ShellFocus) => {
    setPendingFocus(field);
  }, []);

  const goTo = useCallback(
    (next: OnboardingStep, nextPath?: OnboardingPath) => {
      const move = transitionFor(step, next, reducedMotion);
      setDirection(move.direction);
      setEffect(move.effect);
      setStep(next);
      if (nextPath) setPath(nextPath);
    },
    [reducedMotion, step]
  );

  useEffect(() => {
    if (!pendingFocus) return;
    const node = {
      server: serverRef.current,
      email: emailRef.current,
      password: passwordRef.current,
      code: codeRef.current,
      next: nextRef.current,
      "choose-server": chooseServerRef.current,
      "choose-invite": chooseInviteRef.current,
    }[pendingFocus];
    // Stay pending until the step that owns the node has mounted. Clearing
    // on a miss is what made the old single-form prefillFocus a silent no-op
    // on S1 (email/password refs are not in the tree).
    if (!node) return;
    node.focus();
    setPendingFocus(null);
  }, [pendingFocus, step]);

  useEffect(() => {
    if (!prefill) return;
    if (prefill.serverUrl !== "") {
      setServerUrl(prefill.serverUrl);
      setServerError(null);
    }
    const openedByInvite = prefill.inviteCode !== "";
    if (openedByInvite) {
      setInviteCode(prefill.inviteCode);
      setMode("join");
      setPath("invite");
      // Replay mask-reveal only when this link actually leaves S0. A cold
      // start that already opened on S1 must not animate a step that did
      // not change.
      if (stepRef.current === "landing") {
        const move = transitionFor("landing", "gateway", reducedMotion);
        setDirection(move.direction);
        setEffect(move.effect);
        setStep("gateway");
      }
    }
    setFailure(null);
    const serverUrlNow = prefill.serverUrl || typed.current.serverUrl;
    const landsOnGateway = openedByInvite || stepRef.current === "gateway";
    if (landsOnGateway) {
      focusLater(
        gatewayPrefillFocus({
          serverUrl: serverUrlNow,
          inviteCode: prefill.inviteCode,
          requiresServer,
          joinPath: openedByInvite,
        })
      );
    } else {
      focusLater(
        prefillFocus({
          serverUrl: serverUrlNow,
          email: typed.current.email,
          password: typed.current.password,
          requiresServer,
        })
      );
    }
  }, [prefill, requiresServer, focusLater, reducedMotion]);

  function selectDiscovered(server: DiscoveredServer) {
    setServerUrl(server.base);
    setServerError(null);
    setFailure(null);
    focusLater(email.trim() === "" ? "email" : "password");
  }

  function commitServer(): boolean {
    const raw = serverUrl.trim();
    if (raw === "") {
      if (requiresServer) {
        setServerError("서버 주소를 입력하세요.");
        focusLater("server");
        return false;
      }
      setServerBase(null);
      return true;
    }
    const checked = normalizeServerUrl(raw);
    if (!checked.ok) {
      setServerError(checked.message);
      focusLater("server");
      return false;
    }
    setServerBase(checked.base);
    setServerUrl(checked.base);
    rememberRecentServer(checked.base);
    setRecent(readRecentServers());
    return true;
  }

  async function attempt() {
    setFailure(null);
    setServerError(null);
    if (!commitServer()) return;
    setBusy(true);
    try {
      const session =
        mode === "join"
          ? await joinWithInvite(inviteCode, email, password)
          : await login(email, password, workspace);
      if (mode === "join") setPhoneLinkSession(session);
      else onLoggedIn(session);
    } catch (err) {
      const next = mode === "join" ? joinFailureCopy(err) : signInFailureCopy(err);
      setFailure(next);
      if (next.onGateway) {
        goTo("gateway");
        focusLater("code");
      } else if (next.suggestSignIn) {
        setMode("signIn");
      }
    } finally {
      setBusy(false);
    }
  }

  function onGatewaySubmit(e: FormEvent) {
    e.preventDefault();
    setFailure(null);
    if (!commitServer()) return;
    if (path === "invite" && inviteCode.trim() === "") {
      focusLater("code");
      return;
    }
    goTo("account");
    focusLater("email");
  }

  function onAccountSubmit(e: FormEvent) {
    e.preventDefault();
    void attempt();
  }

  const serverHint = requiresServer
    ? "데스크톱 앱은 접속할 서버 주소가 필요합니다."
    : "비워 두면 이 페이지를 제공한 주소로 연결합니다.";
  const submitLabel =
    mode === "join"
      ? busy
        ? "참여 중…"
        : "초대 코드로 참여"
      : busy
        ? "로그인 중…"
        : "로그인";
  const progress = progressLabel(step);
  const joinPath = path === "invite" || mode === "join";

  function serverField() {
    return (
      <div className="flex flex-col gap-1">
        <label htmlFor="connect-server" className="text-body">
          <FieldLabel optional>서버 주소</FieldLabel>
        </label>
        <Input
          id="connect-server"
          ref={serverRef}
          type="text"
          inputMode="url"
          autoComplete="url"
          spellCheck={false}
          placeholder={SERVER_URL_PLACEHOLDER}
          value={serverUrl}
          onChange={(e) => {
            setServerUrl(e.target.value);
            setServerError(null);
          }}
          aria-invalid={serverError !== null || undefined}
          aria-describedby={
            serverError ? "connect-server-error" : "connect-server-hint"
          }
          data-testid="login-server"
        />
        {serverError ? (
          <p
            id="connect-server-error"
            role="alert"
            className="text-meta text-danger"
            data-testid="login-server-error"
          >
            {serverError}
          </p>
        ) : (
          <p
            id="connect-server-hint"
            className="text-meta text-ink-muted"
            data-testid="connect-server-hint"
          >
            {serverHint}
          </p>
        )}
        {recent.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-2" data-testid="connect-recent-servers">
            {recent.map((base) => (
              <button
                key={base}
                type="button"
                className="tap-target inline-flex items-center rounded-sm bg-muted-soft px-2 py-1 text-meta text-ink hover:bg-surface-hover focus-visible:focus-ring"
                data-testid="connect-recent-server"
                onClick={() => {
                  setServerUrl(base);
                  setServerError(null);
                  setFailure(null);
                }}
              >
                {base.replace(/^https?:\/\//, "")}
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  const cardShared = (
    <>
      <UpdateNotice />
      {TEST_PREFILL_ACTIVE && (
        <InlineBanner
          tone="neutral"
          icon={<FlaskConical className="size-4" aria-hidden />}
          message={
            DEV_EMAIL !== ""
              ? `테스트 프리필이 켜진 빌드입니다. ${DEV_EMAIL}로 미리 채웠습니다.`
              : "테스트 프리필이 켜진 빌드입니다. 비밀번호를 미리 채웠습니다."
          }
          testId="connect-test-prefill"
        />
      )}
      {!online && (
        <InlineBanner
          tone="neutral"
          message="오프라인입니다. 네트워크가 연결되면 다시 시도하세요."
          testId="connect-offline"
        />
      )}
      {discovered.length > 0 && (
        <DiscoveredServerList
          servers={discovered}
          onSelect={selectDiscovered}
        />
      )}
    </>
  );

  const failureBanner =
    failure === null ? null : (
      <InlineBanner
        tone="error"
        message={failure.message}
        actionLabel={failure.retryable && !busy ? "다시 시도" : undefined}
        onAction={
          failure.retryable && !busy ? () => void attempt() : undefined
        }
        testId="login-error"
      />
    );

  const gatewayCard = (
    <Card className="mx-auto w-full max-w-sm" data-testid="onboarding-gateway">
      <CardHeader>
        <h1 className="brand-lockup flex items-center gap-2 font-semibold leading-none tracking-tight">
          <OortMark className="size-6 shrink-0 text-accent" />
          <span className="text-title">oort</span>
        </h1>
        <CardDescription>
          {joinPath
            ? "초대 코드로 워크스페이스에 참여합니다."
            : "서버를 고른 뒤 로그인합니다."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {cardShared}
        <form onSubmit={onGatewaySubmit} className="flex flex-col gap-6">
          {serverField()}
          {joinPath && (
            <label className="flex flex-col gap-1 text-body">
              <FieldLabel>초대 코드</FieldLabel>
              <Input
                ref={codeRef}
                value={inviteCode}
                onChange={(e) => setInviteCode(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                required
                data-testid="login-invite-code"
              />
            </label>
          )}
          {failure?.onGateway && failureBanner}
          <Button ref={nextRef} type="submit" data-testid="onboarding-next">
            다음
          </Button>
        </form>
        <div className="flex justify-end border-t border-line pt-4">
          <RuntimeBadge />
        </div>
      </CardContent>
    </Card>
  );

  const accountCard = (
    <Card className="mx-auto w-full max-w-sm" data-testid="onboarding-account">
      <CardHeader>
        <h1 className="brand-lockup flex items-center gap-2 font-semibold leading-none tracking-tight">
          <OortMark className="size-6 shrink-0 text-accent" />
          <span className="text-title">oort</span>
        </h1>
        <CardDescription>
          {mode === "join"
            ? "초대 코드로 워크스페이스에 참여합니다."
            : "가입할 때 쓴 이메일로 로그인합니다."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {cardShared}
        <form onSubmit={onAccountSubmit} className="flex flex-col gap-6">
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1 text-body">
              <FieldLabel>이메일</FieldLabel>
              <Input
                ref={emailRef}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
                required
                aria-describedby="connect-email-hint"
                data-testid="login-email"
              />
              <span
                id="connect-email-hint"
                className="text-meta text-ink-muted"
                data-testid="login-email-hint"
              >
                워크스페이스에 초대받은 주소
              </span>
            </label>
            <label className="flex flex-col gap-1 text-body">
              <FieldLabel>비밀번호</FieldLabel>
              <Input
                ref={passwordRef}
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete={
                  mode === "join" ? "new-password" : "current-password"
                }
                required
                aria-describedby="connect-password-hint"
                data-testid="login-password"
              />
              <span
                id="connect-password-hint"
                className="text-meta text-ink-muted"
                data-testid="login-password-hint"
              >
                {mode === "join"
                  ? "이 워크스페이스에서 쓸 비밀번호를 새로 정합니다"
                  : "가입할 때 정한 비밀번호"}
              </span>
            </label>
            {mode === "signIn" && (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => setWorkspaceOpen((open) => !open)}
                  aria-expanded={workspaceOpen}
                  aria-controls="connect-workspace-field"
                  className="self-start rounded-sm text-meta text-ink-muted underline underline-offset-4 focus-visible:focus-ring"
                  data-testid="login-workspace-toggle"
                >
                  다른 워크스페이스로 로그인
                </button>
                {workspaceOpen && (
                  <div
                    id="connect-workspace-field"
                    className="flex flex-col gap-1"
                  >
                    <label htmlFor="connect-workspace" className="text-body">
                      <FieldLabel optional>워크스페이스 ID</FieldLabel>
                    </label>
                    <Input
                      id="connect-workspace"
                      value={workspace}
                      onChange={(e) => setWorkspace(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={WORKSPACE_ID_PLACEHOLDER}
                      aria-describedby="connect-workspace-hint"
                      data-testid="login-workspace"
                    />
                    <p
                      id="connect-workspace-hint"
                      className="text-meta text-ink-muted"
                      data-testid="login-workspace-hint"
                    >
                      비워 두면 기본 워크스페이스로 연결합니다.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-col gap-3">
            {failure && !failure.onGateway && failureBanner}
            <Button
              type="submit"
              disabled={busy || !online}
              title={
                online ? undefined : "오프라인 상태에서는 연결할 수 없습니다."
              }
              data-testid="login-submit"
            >
              {submitLabel}
            </Button>
          </div>
        </form>
        <div className="flex justify-end border-t border-line pt-4">
          <RuntimeBadge />
        </div>
      </CardContent>
    </Card>
  );

  const slide = (
    <OnboardingSlideTransition
      transitionKey={`${step}-${path ?? "none"}`}
      direction={direction}
      effect={effect}
      containerClassName={step === "landing" ? "min-h-full" : undefined}
      className={
        step === "landing" ? "min-h-full w-full" : "flex w-full justify-center"
      }
    >
      {step === "landing" ? (
        <LandingStep
          serverChoiceRef={chooseServerRef}
          inviteChoiceRef={chooseInviteRef}
          onChooseServer={() => {
            setMode("signIn");
            goTo("gateway", "server");
            focusLater("server");
          }}
          onChooseInvite={() => {
            setMode("join");
            goTo("gateway", "invite");
            focusLater("code");
          }}
        />
      ) : step === "gateway" ? (
        gatewayCard
      ) : (
        accountCard
      )}
    </OnboardingSlideTransition>
  );

  if (step === "landing") {
    return slide;
  }

  if (phoneLinkSession) {
    return (
      <div className="flex min-h-full flex-col bg-surface">
        <header
          className="onboarding-step-chrome"
          data-testid="onboarding-step-chrome"
          {...titlebarDragProps(IS_TAURI)}
        >
          {progress && (
            <p
              className="text-meta text-ink-muted"
              data-testid="onboarding-progress"
              data-numeric
            >
              {progress}
            </p>
          )}
        </header>
        <div className="flex flex-1 items-center justify-center p-6">
          <div
            className="flex w-full max-w-2xl flex-col gap-4"
            data-testid="onboarding-phone-link"
          >
            <div className="flex flex-col gap-1">
              <h2 className="text-title font-semibold text-ink">폰에서도 쓰기</h2>
              <p className="break-keep text-body text-ink-muted">
                같은 계정으로 폰을 붙이려면 지금 QR을 만들 수 있습니다. 나중에 설정
                기기에서도 열 수 있습니다.
              </p>
            </div>
            <DeviceLinkCard offline={!online} />
            <Button
              type="button"
              onClick={() => onLoggedIn(phoneLinkSession)}
              data-testid="onboarding-enter-app"
            >
              앱으로 들어가기
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-full flex-col bg-surface">
      <header
        className="onboarding-step-chrome"
        data-testid="onboarding-step-chrome"
        {...titlebarDragProps(IS_TAURI)}
      >
        <Button
          type="button"
          variant="ghost"
          data-testid="onboarding-back"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            if (step === "account") {
              goTo("gateway");
              focusLater(path === "invite" ? "code" : "server");
            } else {
              goTo("landing");
              focusLater(
                path === "invite" ? "choose-invite" : "choose-server"
              );
            }
          }}
        >
          <ArrowLeft aria-hidden="true" />
          뒤로
        </Button>
        {progress && (
          <p
            className="text-meta text-ink-muted"
            data-testid="onboarding-progress"
            data-numeric
          >
            {progress}
          </p>
        )}
      </header>
      <div className="flex flex-1 items-center justify-center p-6">{slide}</div>
    </div>
  );
}
