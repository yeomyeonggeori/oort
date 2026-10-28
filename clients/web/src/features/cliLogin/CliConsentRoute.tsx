import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { LoginResponse } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { ConnectPage } from "@/features/auth/ConnectPage";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
// useBrowserOffline, NOT useOffline: this route renders ABOVE AppShell, so there
// is no SessionProvider (useOffline reads the realtime rail via useSession and
// would crash). The browser's navigator.onLine is the only offline signal this
// surface has, and the right one.
import { useBrowserOffline } from "@/features/common/useOffline";
import { ChoiceList, type ChoiceListItem } from "@/features/hostedAgents/ChoiceList";
import { Field, KeyValueRows } from "@/features/settings/SettingsFields";
import type { SessionRestoreStatus } from "@/app/session";
import {
  approveCliConsent,
  denyCliConsent,
  previewCliConsent,
} from "@momo/core/features/cliLogin/api";
import {
  buildCliApprove,
  buildCliDeny,
  classifyCliDecisionError,
  cliCanApprove,
  cliCanDeny,
  cliConsentLifetime,
  cliConsentScreen,
  cliScopePresetChoices,
  effectiveCliPreset,
  isCliSessionExpired,
  parseCliConsentPreview,
  parseCliDecision,
  CLI_CONSENT_APPROVE_BUSY,
  CLI_CONSENT_APPROVE_LABEL,
  CLI_CONSENT_CHECK_NOTE,
  CLI_CONSENT_CLIENT_KEY,
  CLI_CONSENT_DENY_BUSY,
  CLI_CONSENT_DENY_LABEL,
  CLI_CONSENT_DEVICE_KEY,
  CLI_CONSENT_DEVICE_MISSING,
  CLI_CONSENT_DEVICE_NOTE,
  CLI_CONSENT_DISMISS_ACTION,
  CLI_CONSENT_HOST_KEY,
  CLI_CONSENT_LEAD,
  CLI_CONSENT_LOADING_SR,
  CLI_CONSENT_MEMBER_KEY,
  CLI_CONSENT_OFFLINE_NOTE,
  CLI_CONSENT_PASSWORD_HINT,
  CLI_CONSENT_PASSWORD_LABEL,
  CLI_CONSENT_PASSWORD_WRONG,
  CLI_CONSENT_RETRY_ACTION,
  CLI_CONSENT_RETURNING,
  CLI_CONSENT_SIGNIN_DETAIL,
  CLI_CONSENT_TITLE,
  CLI_CONSENT_WORKSPACE_KEY,
  CLI_DEFAULT_PRESET,
  CLI_PRESET_HINT,
  CLI_PRESET_LEGEND,
  CLI_TERMINAL_COPY,
  type CliScopePreset,
  type CliTerminalKind,
} from "@momo/core/features/cliLogin/consent";
import { oauthRequestExpiry } from "@momo/core/features/hostedAgents/oauthConsent";
import { readCliRequestId } from "./cliConsentPath";

// =============================================================================
// oort CLI 브라우저 로그인 동의 화면 (ADR-0216 D6-나, #4700).
//
// 터미널의 `oort login` 이 연 브라우저가 `/oauth/cli?request=<봉투>` 로 떨어진다.
// 로그인한 사람이 여기서 기기 이름·서버 호스트를 터미널의 값과 대조하고, 현재
// 비밀번호를 다시 확인한 뒤 「읽기만」(기본) 또는 「읽기와 보내기」로 허용하거나
// 거절한다. 판정과 문구는 전부 `@momo/core/features/cliLogin/consent` 에 있고, 이
// 파일은 그 위에 화면을 얇게 얹는다(hostedAgents/OAuthConsentRoute.tsx 와 같은
// 모양: design-taste-web §0, judgment in core).
//
// 이 화면은 HashRouter 밖에 산다(cliConsentPath.ts 머리말). App 이 라우터보다
// 먼저 경로를 보고 여기로 갈라지므로, 자기 세션 게이트를 직접 든다: 복원 중이면
// 로딩, 로그아웃이면 로그인, 로그인했으면 본문.
//
// ## 보안 척추
//
//   - URL 에서 읽는 것은 서버가 서명한 opaque request 하나뿐이다. 저장소·히스토리·
//     로그 어디에도 복제하지 않고, 현재 비밀번호도 상태 밖으로 나가지 않는다
//     (요청 본문으로만 가고, 결정이 끝나거나 틀리면 비운다).
//   - 사실은 그 request 로 **서버 preview** 에서 복원한다. 위조·만료·꺼짐·다른 종류
//     는 전부 같은 404 라 화면도 한 문장으로 접는다.
//   - 허용·거절은 명시 버튼이다. 닫기·뒤로·Esc 는 이 버튼을 부르지 않는 것과 같고
//     그것은 거절(capability 0)과 동등하다. 그래서 Esc 에 결정을 묶지 않는다.
//   - 결정은 하나만 낸다: `phase` ref 가 두 번째 요청을 막고 서버도 409 로
//     나머지를 무효화한다. 성공하면 서버가 준 redirectTo 로 `replace` 한다 — 단,
//     이 기기의 루프백 콜백(`http://127.0.0.1:<포트>/callback`)일 때만. 아니면
//     따라가지 않고 종료 화면을 그린다(consent.ts `safeCliRedirect`).
// =============================================================================

export function CliConsentRoute({
  status,
  session,
  onLoggedIn,
}: {
  status: SessionRestoreStatus;
  session: LoginResponse | null;
  onLoggedIn: (session: LoginResponse) => void;
}) {
  // URL 에서 한 번만 읽고, 컴포넌트 수명 동안 붙든다. 어디에도 다시 쓰지 않는다.
  const [requestId] = useState(() => readCliRequestId(window.location.search));

  // 결정 중 401 로 세션이 끊긴 경우. 이 클라이언트의 요청은 refresh 회전을 타지
  // 않으므로(호스티드 동의와 같다) 본문이 401 을 만나면 여기로 올려 로그인 화면을
  // 다시 세운다. 로그인이 끝나면 이 표시를 내리고, 같은 request 로 본문이 다시
  // 마운트된다.
  const [sessionLost, setSessionLost] = useState(false);
  const onSessionExpired = useCallback(() => setSessionLost(true), []);
  const titleRef = useRef<HTMLHeadingElement>(null);

  if (
    requestId !== null &&
    status !== "restoring" &&
    (session === null || sessionLost)
  ) {
    // 로그인 화면은 앱이 늘 전체 폭으로 그리는 화면이다. 동의 본문의 좁은 칼럼 안에
    // 넣으면 두 칼럼 온보딩이 오른쪽에서 잘린다(캡처로 확인). 그래서 칼럼을 두르지
    // 않고, 안내 한 줄만 그 위에 얹는다.
    return (
      <div className="flex min-h-full w-full flex-col">
        <InlineBanner
          tone="neutral"
          message={CLI_CONSENT_SIGNIN_DETAIL}
          testId="cli-consent-signin"
        />
        <ConnectPage
          onLoggedIn={(next) => {
            setSessionLost(false);
            onLoggedIn(next);
          }}
        />
      </div>
    );
  }

  return (
    <ConsentFrame titleRef={titleRef}>
      {requestId === null ? (
        <ConsentTerminal terminal="not-found" />
      ) : status === "restoring" || session === null ? (
        <ConsentLoading />
      ) : (
        <ConsentBody
          session={session}
          requestId={requestId}
          titleRef={titleRef}
          onSessionExpired={onSessionExpired}
        />
      )}
    </ConsentFrame>
  );
}

/** 페이지 정체성. 어떤 상태에서도 이 제목이 이 표면의 이름이다. */
function ConsentFrame({
  titleRef,
  children,
}: {
  /** 폼이 서면 초점을 받는 제목. 긴 폼에서 첫 포커스가 문맥을 화면 밖으로 밀지 않게 한다. */
  titleRef: RefObject<HTMLHeadingElement>;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-col gap-6 p-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1
          ref={titleRef}
          tabIndex={-1}
          className="break-keep text-title font-semibold text-ink"
          data-testid="cli-consent-title"
        >
          {CLI_CONSENT_TITLE}
        </h1>
        <p className="break-keep text-body text-ink-muted">{CLI_CONSENT_LEAD}</p>
      </header>
      {children}
    </div>
  );
}

function ConsentLoading() {
  return (
    <div role="status" data-testid="cli-consent-loading">
      <span className="sr-only">{CLI_CONSENT_LOADING_SR}</span>
      <Skeleton ready={false} rows={5} className="p-0" />
    </div>
  );
}

/**
 * 그 자리에서 끝나는 화면. 제목 h1 은 프레임이 이미 세웠으므로 여기 headline 은
 * `<p>` 다(States.EmptyInvite 규율). 결정 뒤에 폼이 이 화면으로 바뀌므로 알림 역할을
 * 달아 스크린리더가 바뀐 결과를 읽게 한다.
 */
function ConsentTerminal({ terminal }: { terminal: CliTerminalKind }) {
  const copy = CLI_TERMINAL_COPY[terminal];
  return (
    <div role="alert" data-testid="cli-consent-terminal" data-terminal={terminal}>
      <EmptyInvite className="px-0" headline={copy.headline} detail={copy.detail} />
    </div>
  );
}

// ---- 본문 -------------------------------------------------------------------

function ConsentBody({
  session,
  requestId,
  titleRef,
  onSessionExpired,
}: {
  session: LoginResponse;
  requestId: string;
  titleRef: RefObject<HTMLHeadingElement>;
  /** 401 을 만나면 라우트에 알려 로그인 화면을 다시 세운다. */
  onSessionExpired: () => void;
}) {
  // 워크스페이스는 승인하는 세션의 것이다(호스티드 동의와 같다).
  const workspaceId = session.member.workspaceId;
  const offline = useBrowserOffline();
  const passwordRef = useRef<HTMLInputElement>(null);

  const [preset, setPreset] = useState<CliScopePreset>(CLI_DEFAULT_PRESET);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  // 결정 시점에 서버가 낸 종료(409 이미 처리됨·404·403·안전하지 않은 돌아갈 곳).
  // 배너가 아니라 종료 화면이라, 버튼이 함께 서 자기모순을 그리지 않는다.
  const [decisionTerminal, setDecisionTerminal] = useState<CliTerminalKind | null>(
    null
  );
  // 틀린 비밀번호 뒤에 칸으로 초점을 되돌리는 신호(효과가 이 숫자의 변화를 본다).
  const [refocusTick, setRefocusTick] = useState(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  // 결정의 단계. `idle` 만 새 요청을 만들 수 있다. `inflight` 는 요청이 떠 있는 동안이고
  // (같은 틱의 두 번째 누름은 아직 렌더되지 않은 busy 를 못 보므로 ref 가 막는다),
  // `done` 은 결정이 끝난 뒤(성공·종료)다. 폼으로 돌아오는 실패만 `idle` 로 되돌린다.
  const phase = useRef<"idle" | "inflight" | "done">("idle");

  const preview = useQuery({
    queryKey: ["cli-consent", "preview", workspaceId, requestId],
    queryFn: async () =>
      parseCliConsentPreview(await previewCliConsent(workspaceId, requestId)),
    // 서명된 일회성 봉투다. 되묻지 않고, 언마운트에서 캐시에 남기지 않는다.
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    // 오프라인을 쿼리 클라이언트가 조용히 멈춰 세우게 두지 않는다(기본 `online` 은
    // 요청을 붙들고 로딩만 그린다). 닿지 못하면 NetworkError 로 바로 실패해 「다시
    // 시도」 배너가 서고, 오프라인 안내와 버튼 잠금은 이 화면이 직접 한다.
    networkMode: "always",
  });
  const data = preview.data ?? null;

  // 사람이 읽는 동안 만료가 지날 수 있다. 분 단위 표시라 30초 간격이면 충분하다.
  useEffect(() => {
    if (data === null) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [data]);

  // preview 가 401 이면(세션 만료) 로그인 화면으로 되돌린다. render 중이 아니라
  // 효과에서 올려 상태 갱신을 렌더 밖으로 뺀다.
  const previewError = preview.isError ? preview.error : null;
  useEffect(() => {
    if (previewError !== null && isCliSessionExpired(previewError)) {
      onSessionExpired();
    }
  }, [previewError, onSessionExpired]);

  function finishDecision(redirectTo: string) {
    phase.current = "done";
    setPassword("");
    setReturning(true);
    // 히스토리에 이 화면을 남기지 않는다: 뒤로가기가 승인 화면으로 돌아오지 않게.
    window.location.replace(redirectTo);
  }

  /** 결정 실패의 갈림은 코어가 정한다: 401 로그인, 종료, 틀린 비밀번호, 배너. */
  function handleDecisionError(action: "approve" | "deny", error: unknown) {
    const outcome = classifyCliDecisionError(action, error);
    switch (outcome.kind) {
      case "session-expired":
        onSessionExpired();
        return;
      case "terminal":
        phase.current = "done";
        setPassword("");
        setDecisionTerminal(outcome.terminal);
        return;
      case "wrong-password":
        phase.current = "idle";
        setPassword("");
        setPasswordError(CLI_CONSENT_PASSWORD_WRONG);
        setRefocusTick((tick) => tick + 1);
        return;
      case "failure":
        phase.current = "idle";
        setFailure(outcome.message);
        return;
    }
  }

  const approve = useMutation({
    mutationFn: async () => {
      if (data === null) throw new Error("no preview");
      const body = buildCliApprove({
        request: requestId,
        currentPassword: password,
        preset: effectiveCliPreset(preset, data),
        requestedScopes: data.requestedScopes,
      });
      return parseCliDecision(await approveCliConsent(workspaceId, body));
    },
    onSuccess: (result) => finishDecision(result.redirectTo),
    onError: (error) => handleDecisionError("approve", error),
    networkMode: "always",
  });

  const deny = useMutation({
    mutationFn: async () =>
      parseCliDecision(await denyCliConsent(workspaceId, buildCliDeny(requestId))),
    onSuccess: (result) => finishDecision(result.redirectTo),
    onError: (error) => handleDecisionError("deny", error),
    networkMode: "always",
  });

  const busy = approve.isPending || deny.isPending;

  // ---- 상태 갈림 ----
  // 어느 화면인가는 코어의 순수 selector 가 정한다. 컴포넌트는 결과를 그리기만 한다.
  const screen = cliConsentScreen({
    decisionTerminal,
    returning,
    previewPending: preview.isPending,
    previewError,
    data,
    nowMs,
  });

  // 첫 포커스는 제목이다. 비밀번호 칸은 폼 맨 아래라, 거기로 초점을 주면 브라우저가
  // 그 칸을 보이게 스크롤해 제목과 대조 안내가 화면 밖으로 밀린다(캡처로 확인).
  // 제목에서 시작해 Tab 으로 범위 → 비밀번호 → 거절·허용 순서로 간다.
  const formShown = screen.kind === "form";
  useEffect(() => {
    if (formShown) titleRef.current?.focus();
  }, [formShown, titleRef]);
  // 틀린 비밀번호 뒤에는 칸을 비우고 초점을 되돌려 바로 다시 입력하게 한다.
  useEffect(() => {
    if (refocusTick > 0) passwordRef.current?.focus();
  }, [refocusTick]);

  switch (screen.kind) {
    case "loading":
      return <ConsentLoading />;
    case "returning":
      return (
        <p
          role="status"
          className="break-keep text-body text-ink"
          data-testid="cli-consent-returning"
        >
          {CLI_CONSENT_RETURNING}
        </p>
      );
    case "terminal":
      return <ConsentTerminal terminal={screen.terminal} />;
    case "retry":
      return (
        <InlineBanner
          separator={false}
          message={screen.message}
          actionLabel={CLI_CONSENT_RETRY_ACTION}
          onAction={() => void preview.refetch()}
          testId="cli-consent-preview-error"
        />
      );
    case "form":
      break;
  }
  // selector 가 "form" 을 낼 때만 여기 닿고, 그때 data 는 non-null·만료 전이다.
  // 아래는 타입 좁힘용 가드(도달 불가).
  if (data === null) return <ConsentLoading />;

  const decided = phase.current === "done";
  const canApprove = cliCanApprove({
    hasPassword: password.length > 0,
    offline,
    busy,
    decided,
  });
  const canDeny = cliCanDeny({ offline, busy, decided });

  function submitApprove() {
    if (!canApprove || phase.current !== "idle") return;
    phase.current = "inflight";
    setFailure(null);
    setPasswordError(null);
    approve.mutate();
  }

  function submitDeny() {
    if (!canDeny || phase.current !== "idle") return;
    phase.current = "inflight";
    setFailure(null);
    setPasswordError(null);
    deny.mutate();
  }

  const expiry = oauthRequestExpiry(data.expiresAtMs, nowMs);
  const effective = effectiveCliPreset(preset, data);
  const presetItems: ChoiceListItem[] = cliScopePresetChoices(data).map((choice) => ({
    id: choice.id,
    label: choice.label,
    detail: choice.detail,
    ...(choice.disabled ? { disabled: true } : {}),
  }));

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        submitApprove();
      }}
      data-testid="cli-consent-form"
    >
      {offline && (
        <InlineBanner
          tone="neutral"
          message={CLI_CONSENT_OFFLINE_NOTE}
          testId="cli-consent-offline"
        />
      )}
      {failure && (
        <InlineBanner
          message={failure}
          actionLabel={CLI_CONSENT_DISMISS_ACTION}
          onAction={() => setFailure(null)}
          testId="cli-consent-failure"
        />
      )}

      {/* 중계 피싱을 막는 대조 안내와, 대조할 사실들. 전부 서버가 준 값이다. */}
      <div className="flex min-w-0 flex-col gap-3">
        <p
          className="text-meta text-ink-muted"
          data-numeric
          data-testid="cli-consent-expiry"
        >
          {expiry.label}
        </p>
        <p className="break-keep text-body text-ink" data-testid="cli-consent-check-note">
          {CLI_CONSENT_CHECK_NOTE}
        </p>
        <KeyValueRows
          rows={[
            { key: CLI_CONSENT_CLIENT_KEY, value: data.clientName, prose: true },
            { key: CLI_CONSENT_HOST_KEY, value: data.serverHost, numeric: true },
            {
              key: CLI_CONSENT_DEVICE_KEY,
              value: data.deviceName ?? CLI_CONSENT_DEVICE_MISSING,
            },
            { key: CLI_CONSENT_WORKSPACE_KEY, value: data.workspaceName, prose: true },
            {
              key: CLI_CONSENT_MEMBER_KEY,
              value:
                data.roleLabel === null
                  ? data.memberDisplayName
                  : `${data.memberDisplayName} · ${data.roleLabel}`,
              prose: true,
            },
          ]}
        />
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid="cli-consent-device-note"
        >
          {CLI_CONSENT_DEVICE_NOTE}
        </p>
      </div>

      <ChoiceList
        name="cli-preset"
        legend={CLI_PRESET_LEGEND}
        hint={CLI_PRESET_HINT}
        multiple={false}
        items={presetItems}
        selected={[effective]}
        onChange={(next) => {
          const id = next[0];
          if (id === "read" || id === "read-send") setPreset(id);
        }}
        disabled={busy}
        testId="cli-preset"
      />

      <p
        className="break-keep text-meta text-ink-muted"
        data-testid="cli-consent-lifetime"
      >
        {cliConsentLifetime(data)}
      </p>

      <Field
        label={CLI_CONSENT_PASSWORD_LABEL}
        htmlFor="cli-consent-password"
        hint={CLI_CONSENT_PASSWORD_HINT}
        error={passwordError}
      >
        <Input
          ref={passwordRef}
          id="cli-consent-password"
          type="password"
          autoComplete="current-password"
          value={password}
          readOnly={busy}
          onChange={(event) => {
            setPassword(event.target.value);
            if (passwordError !== null) setPasswordError(null);
          }}
          data-testid="cli-consent-password"
        />
      </Field>

      {/*
        허용은 주 버튼이고 AlertDialog 확인 단계를 두지 않는다: 이 표면 자체가
        리다이렉트로 도달한 전용 동의 페이지이고, 위의 대조 안내·결과 문장과 현재
        비밀번호 입력이 §6 이 요구하는 숙고를 대신한다(호스티드 동의의 M3-b 와 같다).
        aria-disabled+opacity-50 은 disabled 로 포커스를 떨구지 않고 사유를 화면에
        남기기 위해서다. 거절은 비밀번호 없이도 눌린다(아무 권한도 열지 않는다).
      */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          aria-disabled={!canDeny || undefined}
          aria-busy={deny.isPending || undefined}
          className={cn(!canDeny && "opacity-50")}
          onClick={submitDeny}
          data-testid="cli-consent-deny"
        >
          {deny.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {deny.isPending ? CLI_CONSENT_DENY_BUSY : CLI_CONSENT_DENY_LABEL}
        </Button>
        <Button
          type="submit"
          aria-disabled={!canApprove || undefined}
          aria-busy={approve.isPending || undefined}
          className={cn(!canApprove && "opacity-50")}
          data-testid="cli-consent-approve"
        >
          {approve.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {approve.isPending ? CLI_CONSENT_APPROVE_BUSY : CLI_CONSENT_APPROVE_LABEL}
        </Button>
      </div>
    </form>
  );
}
