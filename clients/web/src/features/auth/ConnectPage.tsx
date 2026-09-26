import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";
import { ArrowLeft, FlaskConical } from "lucide-react";
import { usePrefersReducedMotion } from "@/design/hooks/usePrefersReducedMotion";
import {
  ApiError,
  changeMyDisplayName,
  joinWithInvite,
  login,
  type JoinResponse,
  type LoginResponse,
  type Member,
} from "@momo/core/lib/api";
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
  getServerBase,
  normalizeServerUrl,
  requiresServerUrl,
  setServerBase,
} from "@/lib/serverBase";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { RuntimeBadge } from "@/app/RuntimeBadge";
import {
  recordFirstRunPending,
  recordFreshSignupFirstRun,
} from "@/features/welcome/freshSignupFirstRun";
import { titlebarDragProps } from "@/app/sidebarPane";
import { UpdateNotice } from "@/features/updates/UpdateNotice";
import { onboardingDots } from "@momo/core/features/onboarding/guide";
import { KomettoGuide } from "@/features/onboarding/guide/KomettoGuide";
import { OnboardingDots } from "@/features/onboarding/guide/OnboardingDots";
import {
  ONBOARDING_ACTION_CLASS,
  ONBOARDING_FIELD_CLASS,
  OnboardingColumn,
  OnboardingFrame,
} from "@/features/onboarding/guide/OnboardingFrame";
import { useDiscovery } from "./discovery";
import { OnboardingSlideTransition } from "./OnboardingSlideTransition";
import {
  initialOnboarding,
  transitionFor,
  type OnboardingStep,
  type OnboardingTransitionDirection,
  type OnboardingTransitionEffect,
} from "./onboardingFlow";
import { readRecentServers, rememberRecentServer } from "./recentServers";
import { useJoinPrefill } from "./useJoinPrefill";
import {
  joinFailureCopy,
  signInFailureCopy,
  type ConnectFailure,
} from "@momo/core/features/auth/connectModel";
import {
  displayNameFieldError,
  displayNameSaveMessage,
} from "@momo/core/features/settings/model";
import {
  holdSessionRestore,
  releaseSessionRestore,
} from "./onboardingSessionHold";
import { classifyEntry } from "./entryInput";
import { claimHandoff, navigateTo } from "./claimHandoff";
import { connectGuide } from "./connectGuide";
import { OnboardingFieldBlock, ServerChip } from "./connectParts";
import { settleAfterJoin } from "./joinFollowUp";
import { WelcomeStep } from "./WelcomeStep";

// Reading this as: onboarding for internal team users on web+Tauri,
// density 5/10, motion 2/10.
//
// 로그인 전 온보딩 2.0 (ADR-0193 D7·D10·D11).
//   D0 welcome  (#2808) 한 칸이 팀 주소·초대 링크·claim 링크를 가른다
//   D1 sign-in  (#2809) 서버 칩 + 이메일 + 비밀번호. 필수 입력 화면 1
//   D1′ join    (#2810) 링크가 채운 서버·코드 + 이메일 + 새 비밀번호 + 표시 이름
// 옛 S0·S1(gateway)·S2(account)·S3(profile) 네 화면을 이 셋으로 합쳤다.

type Focus = "entry" | "email" | "password" | "profile-name" | "submit";

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

function readInitialStep(): OnboardingStep {
  if (typeof window === "undefined") return "welcome";
  const prefill = parseJoinFromPageUrl(window.location.href);
  return initialOnboarding({
    hasStoredServer: getServerBase() !== null,
    hasInvitePrefill: Boolean(prefill?.inviteCode),
  });
}

function pageHost(): string {
  return typeof window === "undefined" ? "" : window.location.host;
}

const WORKSPACE_ID_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

export function ConnectPage({
  onLoggedIn,
}: {
  onLoggedIn: (session: LoginResponse) => void;
}) {
  const requiresServer = requiresServerUrl();
  const reducedMotion = usePrefersReducedMotion();
  const initialStep = useRef<OnboardingStep | null>(null);
  if (initialStep.current === null) initialStep.current = readInitialStep();
  const [step, setStep] = useState<OnboardingStep>(initialStep.current);
  const [direction, setDirection] =
    useState<OnboardingTransitionDirection>("forward");
  const [effect, setEffect] = useState<OnboardingTransitionEffect>("none");
  const [recent, setRecent] = useState(readRecentServers);

  // 이 화면이 향하는 서버. "" = 이 페이지를 낸 서버(웹 같은 출처).
  const [serverUrl, setServerUrl] = useState(
    () => getServerBase() ?? API_BASE_DEFAULT
  );
  const [entry, setEntry] = useState("");
  const [entryError, setEntryError] = useState<string | null>(null);
  // 서버 없이 코드만 받은 데스크탑: D0에서 서버를 마저 묻는다.
  const [pendingCode, setPendingCode] = useState<string | null>(null);
  const [email, setEmail] = useState(DEV_EMAIL);
  const [password, setPassword] = useState(DEV_PASSWORD);
  const [workspace, setWorkspace] = useState(CONFIGURED_WORKSPACE);
  const [workspaceOpen, setWorkspaceOpen] = useState(CONFIGURED_WORKSPACE !== "");
  const [inviteCode, setInviteCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<ConnectFailure | null>(null);
  const [fieldError, setFieldError] = useState<{
    field: "email" | "password";
    message: string;
  } | null>(null);
  const [pendingFocus, setPendingFocus] = useState<Focus | null>(null);
  // 가입은 됐고 표시 이름 저장만 실패한 상태(fail-forward). 계정이 생겼으므로
  // 이 화면은 더 이상 가입 폼이 아니다: 뒤로가 없고 이메일·비밀번호는 잠긴다.
  const [joined, setJoined] = useState<JoinResponse | null>(null);
  const [profileName, setProfileName] = useState("");
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileFailed, setProfileFailed] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const online = useSyncExternalStore(subscribeOnline, readOnline, () => true);
  const discovery = useDiscovery();
  const prefill = useJoinPrefill();

  const entryRef = useRef<HTMLInputElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const profileNameRef = useRef<HTMLInputElement>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const profileBusyRef = useRef(false);
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    return () => {
      releaseSessionRestore();
    };
  }, []);

  const focusLater = useCallback((field: Focus) => {
    setPendingFocus(field);
  }, []);

  const goTo = useCallback(
    (next: OnboardingStep) => {
      const move = transitionFor(stepRef.current, next, reducedMotion);
      setDirection(move.direction);
      setEffect(move.effect);
      setStep(next);
    },
    [reducedMotion]
  );

  useEffect(() => {
    if (!pendingFocus) return;
    const node = {
      entry: entryRef.current,
      email: emailRef.current,
      password: passwordRef.current,
      "profile-name": profileNameRef.current,
      submit: submitRef.current,
    }[pendingFocus];
    // 그 칸을 가진 화면이 마운트될 때까지 기다린다.
    if (!node) return;
    node.focus();
    setPendingFocus(null);
  }, [pendingFocus, step]);

  // 첫 그림의 커서: D0은 입력 칸, D1은 이메일(채워져 있으면 비밀번호), D1′은 이메일.
  useEffect(() => {
    const first = initialStep.current;
    if (first === "welcome") focusLater("entry");
    else if (first === "sign-in") {
      focusLater(DEV_EMAIL.trim() === "" ? "email" : "password");
    } else focusLater("email");
  }, [focusLater]);

  /** 서버를 이 기기의 선택으로 굳힌다. "" = 같은 출처(웹). */
  const commitServer = useCallback((base: string) => {
    if (base === "") {
      setServerBase(null);
      setServerUrl("");
      return;
    }
    const checked = normalizeServerUrl(base);
    if (!checked.ok) return;
    setServerBase(checked.base);
    setServerUrl(checked.base);
    rememberRecentServer(checked.base);
    setRecent(readRecentServers());
  }, []);

  const enterSignIn = useCallback(
    (base: string) => {
      commitServer(base);
      setFailure(null);
      setEntryError(null);
      setPendingCode(null);
      goTo("sign-in");
      focusLater(email.trim() === "" ? "email" : "password");
    },
    [commitServer, email, focusLater, goTo]
  );

  const enterJoin = useCallback(
    (base: string, code: string) => {
      commitServer(base);
      setInviteCode(code);
      setFailure(null);
      setEntryError(null);
      setPendingCode(null);
      goTo("join");
      focusLater("email");
    },
    [commitServer, focusLater, goTo]
  );

  // 딥링크(데스크탑 `oort://join`, 브라우저 `?code=`)가 이 화면을 연 뒤에도 새
  // 링크가 오면 다시 적용한다. 링크는 D0을 건너뛴다(ADR-0193 D7).
  useEffect(() => {
    if (!prefill) return;
    if (prefill.inviteCode !== "") {
      const base = prefill.serverUrl || getServerBase() || "";
      if (base === "" && requiresServer) {
        setPendingCode(prefill.inviteCode);
        goTo("welcome");
        focusLater("entry");
        return;
      }
      enterJoin(base, prefill.inviteCode);
      return;
    }
    if (prefill.serverUrl !== "") enterSignIn(prefill.serverUrl);
    // enterJoin/enterSignIn은 email을 읽는다. 새 링크가 올 때만 다시 돈다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  function onWelcomeSubmit() {
    setEntryError(null);
    const decision = classifyEntry(entry);
    switch (decision.kind) {
      case "empty":
        if (!requiresServer) {
          // 웹: 빈 칸은 「이 페이지의 서버」다(옛 S1의 「비워 두면 …」 그대로).
          if (pendingCode) enterJoin("", pendingCode);
          else enterSignIn("");
          return;
        }
        setEntryError("팀 주소나 초대 링크를 넣으세요. 예: https://team.example.com");
        focusLater("entry");
        return;
      case "server":
        if (pendingCode) enterJoin(decision.base, pendingCode);
        else enterSignIn(decision.base);
        return;
      case "invite": {
        const base = decision.serverUrl || getServerBase() || "";
        if (base === "" && requiresServer) {
          setPendingCode(decision.inviteCode);
          setEntry("");
          focusLater("entry");
          return;
        }
        enterJoin(base, decision.inviteCode);
        return;
      }
      case "claim": {
        const move = claimHandoff({
          origin: decision.origin,
          token: decision.token,
          pageOrigin: window.location.origin,
          isTauri: IS_TAURI,
        });
        if (move.serverBase !== undefined) setServerBase(move.serverBase);
        navigateTo(move.href);
        return;
      }
      case "invalid":
        setEntryError(decision.message);
        focusLater("entry");
        return;
    }
  }

  /**
   * D0로 돌아간다. 링크로 연 D1′에서 뒤로를 누르면 초대 코드를 들고 간다: D0이
   * 「초대 코드를 받았어요. 어느 팀 서버인가요?」로 이어받고 [계속]은 다시 D1′이다.
   * 코드 판정 오류의 [링크 다시 넣기]는 코드를 버린다(그 코드는 쓸 수 없다).
   */
  function backToWelcome(options: { keepInvite?: boolean } = {}) {
    setFailure(null);
    setFieldError(null);
    setPendingCode(options.keepInvite && step === "join" && inviteCode !== "" ? inviteCode : null);
    setEntry(serverUrl);
    goTo("welcome");
    focusLater("entry");
  }

  async function signIn() {
    setFailure(null);
    setFieldError(null);
    // 빈 칸은 서버에 묻기 전에 그 칸에서 말한다.
    if (email.trim() === "") {
      setFieldError({ field: "email", message: "이메일을 넣으세요." });
      focusLater("email");
      return;
    }
    if (password === "") {
      setFieldError({ field: "password", message: "비밀번호를 넣으세요." });
      focusLater("password");
      return;
    }
    setBusy(true);
    try {
      const session = await login(email, password, workspace);
      onLoggedIn(session);
    } catch (err) {
      const copy = signInFailureCopy(err);
      if (err instanceof ApiError && err.status === 401) {
        // 이메일·비밀번호 판정은 문제 자리(비밀번호 칸)에서 다음 행동과 함께 말한다.
        setFieldError({
          field: "password",
          message: `${copy.message} 비밀번호를 다시 넣고 들어가기를 누르세요.`,
        });
      } else {
        setFailure(copy);
      }
      // 비밀번호는 실패 뒤에 남기지 않는다(#2809). 다시 넣고 들어간다.
      setPassword("");
      focusLater("password");
    } finally {
      setBusy(false);
    }
  }

  function finishJoin(join: JoinResponse, member: Member) {
    onLoggedIn({ ...join, member });
    releaseSessionRestore();
  }

  async function patchProfileName(join: JoinResponse) {
    if (profileBusyRef.current) return;
    profileBusyRef.current = true;
    setProfileBusy(true);
    setProfileError(null);
    try {
      const member = await changeMyDisplayName(join.member.workspaceId, profileName);
      finishJoin(join, member);
    } catch (err) {
      setProfileFailed(true);
      setProfileError(
        `${displayNameSaveMessage(err)} 설정 › 프로필에서 언제든 바꿀 수 있어요.`
      );
      // 배너는 role="alert"이고 포커스 자리가 아니다. 이름 칸이 포커스 자리다.
      focusLater("profile-name");
    } finally {
      profileBusyRef.current = false;
      setProfileBusy(false);
    }
  }

  function wantsNamePatch(join: JoinResponse): boolean {
    const name = profileName.trim();
    return name !== "" && name !== join.member.displayName.trim();
  }

  async function join() {
    setFailure(null);
    setBusy(true);
    holdSessionRestore();
    let session: JoinResponse;
    try {
      session = await joinWithInvite(inviteCode, email, password);
    } catch (err) {
      releaseSessionRestore();
      const next = joinFailureCopy(err);
      setFailure(next);
      setBusy(false);
      if (next.suggestSignIn) {
        goTo("sign-in");
        focusLater("password");
      }
      return;
    }
    if (session.createdMember) {
      // 가입 성공 순간에 쓴다. 이름 저장보다 먼저, 한 번(#2301).
      recordFreshSignupFirstRun(session);
    } else {
      // 이미 있던 멤버의 재가입도 첫 실행 두 표지를 받는다.
      recordFirstRunPending(session.member.workspaceId);
    }
    // 활성 에이전트가 있으면 AI 연결을 건너뛴다(#2810, ADR-0185 c1).
    await settleAfterJoin(session.member.workspaceId);
    setBusy(false);
    if (session.createdMember && wantsNamePatch(session)) {
      setJoined(session);
      await patchProfileName(session);
      return;
    }
    finishJoin(session, session.member);
  }

  function onSignInSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    void signIn();
  }

  function onJoinSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || profileBusy) return;
    if (joined) {
      if (profileFailed || !wantsNamePatch(joined)) {
        finishJoin(joined, joined.member);
        return;
      }
      void patchProfileName(joined);
      return;
    }
    void join();
  }

  const profileFieldError =
    profileName.trim() === "" ? null : displayNameFieldError(profileName);

  const guide = connectGuide(
    step,
    {
      offline: !online,
      // 409 「이미 가입한 초대」로 D1에 넘어온 것은 실패가 아니라 안내다.
      failed:
        (failure !== null && !(step === "sign-in" && failure.suggestSignIn)) ||
        (step === "sign-in" && fieldError !== null) ||
        profileError !== null ||
        (step === "welcome" && entryError !== null),
      busy: busy || profileBusy,
    },
    {
      pendingInviteCode: pendingCode !== null,
      nameSaveFailed: joined !== null && profileError !== null,
      savingName: joined !== null && profileBusy,
    }
  );

  const notices = (
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
    </>
  );

  function failureBanner() {
    if (failure === null) return null;
    // 코드 판정(404/409/410/403)은 이 화면에 코드 칸이 없다. 다음 행동은 D0에서
    // 새 링크를 붙여 넣는 것이다.
    const relink = failure.onGateway === true;
    // 로그인 실패는 비밀번호를 비웠으므로 같은 입력으로 다시 보낼 것이 없다.
    const retry = step === "join" && failure.retryable && !busy;
    return (
      <InlineBanner
        tone="error"
        message={failure.message}
        actionLabel={relink ? "링크 다시 넣기" : retry ? "다시 시도" : undefined}
        onAction={relink ? () => backToWelcome() : retry ? () => void join() : undefined}
        testId="login-error"
      />
    );
  }

  const footer = (
    <div className="flex justify-end">
      <RuntimeBadge />
    </div>
  );

  const chipBase = serverUrl === "" ? `https://${pageHost()}` : serverUrl;

  const signInScreen = (
    <OnboardingColumn testId="onboarding-sign-in">
      <div data-onboarding-screen="sign-in" className="contents">
        <KomettoGuide as="h1" expression={guide.expression} line={guide.line} detail={guide.detail} />
        <ServerChip base={chipBase} onChange={() => backToWelcome()} changeDisabled={busy} />
        {notices}
        <form onSubmit={onSignInSubmit} className="flex flex-col gap-4" noValidate>
          <OnboardingFieldBlock
            id="connect-email"
            label="이메일"
            error={fieldError?.field === "email" ? fieldError.message : null}
            errorId="connect-email-error"
            errorTestId="login-email-error"
          >
            <Input
              id="connect-email"
              ref={emailRef}
              className={ONBOARDING_FIELD_CLASS}
              type="email"
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                if (fieldError?.field === "email") setFieldError(null);
              }}
              autoComplete="username"
              required
              aria-invalid={fieldError?.field === "email" || undefined}
              aria-describedby={fieldError?.field === "email" ? "connect-email-error" : undefined}
              data-testid="login-email"
            />
          </OnboardingFieldBlock>
          <OnboardingFieldBlock
            id="connect-password"
            label="비밀번호"
            error={fieldError?.field === "password" ? fieldError.message : null}
            errorId="connect-password-error"
            errorTestId="login-password-error"
          >
            <Input
              id="connect-password"
              ref={passwordRef}
              className={ONBOARDING_FIELD_CLASS}
              type="password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                if (fieldError?.field === "password") setFieldError(null);
              }}
              autoComplete="current-password"
              required
              aria-invalid={fieldError?.field === "password" || undefined}
              aria-describedby={fieldError?.field === "password" ? "connect-password-error" : undefined}
              data-testid="login-password"
            />
          </OnboardingFieldBlock>
          <div className="flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setWorkspaceOpen((open) => !open)}
              aria-expanded={workspaceOpen}
              aria-controls="connect-workspace-field"
              className="tap-target press self-start rounded-sm text-meta text-ink-muted underline underline-offset-4 hover:text-ink focus-visible:focus-ring"
              data-testid="login-workspace-toggle"
            >
              다른 워크스페이스로 로그인
            </button>
            {workspaceOpen && (
              <div id="connect-workspace-field">
                <OnboardingFieldBlock
                  id="connect-workspace"
                  label="워크스페이스 ID"
                  optional
                  hint="비워 두면 기본 워크스페이스로 연결합니다."
                  hintId="connect-workspace-hint"
                >
                  <Input
                    id="connect-workspace"
                    className={ONBOARDING_FIELD_CLASS}
                    value={workspace}
                    onChange={(e) => setWorkspace(e.target.value)}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={WORKSPACE_ID_PLACEHOLDER}
                    aria-describedby="connect-workspace-hint"
                    data-testid="login-workspace"
                  />
                </OnboardingFieldBlock>
              </div>
            )}
          </div>
          {failureBanner()}
          <Button
            ref={submitRef}
            type="submit"
            className={ONBOARDING_ACTION_CLASS}
            disabled={!online}
            aria-busy={busy || undefined}
            title={online ? undefined : "오프라인 상태에서는 연결할 수 없습니다."}
            data-testid="login-submit"
          >
            {busy ? "들어가는 중…" : "들어가기"}
          </Button>
        </form>
        {footer}
      </div>
    </OnboardingColumn>
  );

  const joinSubmitLabel = joined
    ? profileFailed
      ? "계속"
      : profileBusy
        ? "저장 중…"
        : "팀에 들어가기"
    : busy
      ? "들어가는 중…"
      : "팀에 들어가기";

  const joinScreen = (
    <OnboardingColumn testId="onboarding-join">
      <div data-onboarding-screen="join" className="contents">
        <KomettoGuide as="h1" expression={guide.expression} line={guide.line} detail={guide.detail} />
        <ServerChip base={chipBase} />
        {notices}
        <form onSubmit={onJoinSubmit} className="flex flex-col gap-4" noValidate>
          <OnboardingFieldBlock id="connect-email" label="이메일">
            <Input
              id="connect-email"
              ref={emailRef}
              className={ONBOARDING_FIELD_CLASS}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="username"
              readOnly={joined !== null}
              required
              data-testid="login-email"
            />
          </OnboardingFieldBlock>
          <OnboardingFieldBlock
            id="connect-password"
            label="비밀번호"
            hint="이 워크스페이스에서 쓸 비밀번호를 새로 정합니다."
            hintId="connect-password-hint"
          >
            <Input
              id="connect-password"
              ref={passwordRef}
              className={ONBOARDING_FIELD_CLASS}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              readOnly={joined !== null}
              required
              aria-describedby="connect-password-hint"
              data-testid="login-password"
            />
          </OnboardingFieldBlock>
          {profileError ? (
            <InlineBanner
              tone="error"
              message={profileError}
              messageId="onboarding-profile-banner-text"
              testId="onboarding-profile-banner"
              actionLabel="다시 시도"
              onAction={() => {
                if (!joined) return;
                setProfileFailed(false);
                void patchProfileName(joined);
              }}
              actionBusy={profileBusy}
            />
          ) : null}
          <OnboardingFieldBlock
            id="onboarding-profile-name"
            label="팀에서 보일 이름"
            optional
            hint={profileError ? undefined : "나중에 설정 › 프로필에서 바꿀 수 있습니다."}
            hintId="onboarding-profile-name-hint"
            error={profileFieldError}
            errorId="onboarding-profile-name-error"
            errorTestId="onboarding-profile-name-error"
          >
            <Input
              id="onboarding-profile-name"
              ref={profileNameRef}
              className={ONBOARDING_FIELD_CLASS}
              name="displayName"
              value={profileName}
              autoComplete="nickname"
              aria-invalid={profileFieldError ? true : undefined}
              aria-describedby={
                [
                  profileFieldError
                    ? "onboarding-profile-name-error"
                    : profileError
                      ? null
                      : "onboarding-profile-name-hint",
                  profileError ? "onboarding-profile-banner-text" : null,
                ]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
              data-testid="onboarding-profile-name"
              onChange={(e) => {
                setProfileName(e.target.value);
                if (profileFailed) {
                  setProfileFailed(false);
                  setProfileError(null);
                }
              }}
            />
          </OnboardingFieldBlock>
          {failureBanner()}
          <Button
            ref={submitRef}
            type="submit"
            className={ONBOARDING_ACTION_CLASS}
            // 진행 중은 aria-busy + 「…중」 문장이다. 흐리게 막지 않는다(States.tsx).
            disabled={
              joined && profileFailed
                ? false
                : !online || profileFieldError !== null
            }
            aria-busy={busy || profileBusy || undefined}
            title={online ? undefined : "오프라인 상태에서는 연결할 수 없습니다."}
            data-testid="login-submit"
          >
            {joinSubmitLabel}
          </Button>
          {joined === null && (
            <p className="break-keep text-center text-meta text-ink-muted" data-testid="join-sign-in-instead">
              이미 이 서버 계정이 있나요?{" "}
              <button
                type="button"
                className="tap-target press rounded-sm font-semibold text-signal-text underline underline-offset-4 focus-visible:focus-ring"
                onClick={() => {
                  setFailure(null);
                  goTo("sign-in");
                  focusLater(email.trim() === "" ? "email" : "password");
                }}
                data-testid="join-sign-in-link"
              >
                로그인
              </button>
            </p>
          )}
        </form>
        {footer}
      </div>
    </OnboardingColumn>
  );

  const welcomeScreen = (
    <WelcomeStep
      guide={guide}
      entry={entry}
      onEntryChange={(value) => {
        setEntry(value);
        setEntryError(null);
      }}
      entryError={entryError}
      onSubmit={onWelcomeSubmit}
      entryRef={entryRef}
      discovery={discovery}
      recent={recent}
      onPickServer={(base) => {
        if (pendingCode) enterJoin(base, pendingCode);
        else enterSignIn(base);
      }}
      sameOriginHint={!requiresServer}
      notices={notices}
      footer={footer}
    />
  );

  const dots =
    step === "sign-in"
      ? onboardingDots("login", "sign-in")
      : step === "join"
        ? onboardingDots("invite", "join")
        : null;
  const showBack = step !== "welcome" && joined === null;

  return (
    // overflow-x-clip (#2616)는 `OnboardingFrame`이 진다. 바닥은 새벽하늘 canvas,
    // 선 없는 56 머리 줄에 뒤로 · 진행 점(#2807). 바닥이 슬라이드 밖이라 전환 동안
    // 움직이지 않는다. D0은 점이 없고, 머리 줄은 창 드래그 자리로만 남는다.
    <OnboardingFrame
      top={
        <header
          className="onboarding-step-chrome"
          data-testid="onboarding-step-chrome"
          {...titlebarDragProps(IS_TAURI)}
        >
          {showBack ? (
            <Button
              type="button"
              variant="ghost"
              data-testid="onboarding-back"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={() => backToWelcome({ keepInvite: true })}
            >
              <ArrowLeft aria-hidden="true" />
              뒤로
            </Button>
          ) : (
            <span />
          )}
          <OnboardingDots dots={dots} />
          <span aria-hidden="true" />
        </header>
      }
    >
      <OnboardingSlideTransition
        transitionKey={step}
        direction={direction}
        effect={effect}
        className="flex w-full justify-center"
      >
        {step === "welcome"
          ? welcomeScreen
          : step === "sign-in"
            ? signInScreen
            : joinScreen}
      </OnboardingSlideTransition>
    </OnboardingFrame>
  );
}
