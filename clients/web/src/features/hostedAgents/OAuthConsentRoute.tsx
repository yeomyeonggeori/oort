import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import type { LoginResponse } from "@momo/core/lib/api";
import { uuidEq } from "@momo/core/lib/api";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { ConnectPage } from "@/features/auth/ConnectPage";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
// useBrowserOffline, NOT useOffline: this route renders ABOVE AppShell, so there
// is no SessionProvider (useOffline reads the realtime rail via useSession and
// would crash) and no realtime rail to read. The browser's navigator.onLine is
// the only offline signal this surface has, and the right one.
import { useBrowserOffline } from "@/features/common/useOffline";
import { KeyValueRows } from "@/features/settings/SettingsFields";
import { useChannels } from "@/features/workspace/useWorkspace";
import type { SessionRestoreStatus } from "@/app/session";
import {
  approveHostedOauthConsent,
  denyHostedOauthConsent,
  previewHostedOauthConsent,
} from "@momo/core/features/hostedAgents/api";
import {
  channelApprovalChoices,
  type ApprovalChannelInput,
} from "@momo/core/features/hostedAgents/approval";
import {
  buildOauthApprove,
  buildOauthDeny,
  classifyOauthDecisionError,
  isOauthSessionExpired,
  normalizeOauthScopes,
  oauthCanDecide,
  oauthConsentConsequence,
  oauthConsentFacts,
  oauthConsentScreen,
  oauthRequestExpiry,
  oauthScopeChoices,
  parseOauthConsentPreview,
  parseOauthDecision,
  type OauthDecisionTerminal,
  OAUTH_CONSENT_AGENT_FALLBACK,
  OAUTH_CONSENT_AGENT_KEY,
  OAUTH_CONSENT_ALREADY_DECIDED_DETAIL,
  OAUTH_CONSENT_ALREADY_DECIDED_HEADLINE,
  OAUTH_CONSENT_APPROVE_BUSY,
  OAUTH_CONSENT_APPROVE_LABEL,
  OAUTH_CONSENT_CANDIDATE_DETAIL,
  OAUTH_CONSENT_CANDIDATE_LEGEND,
  OAUTH_CONSENT_CHANNELS_HINT,
  OAUTH_CONSENT_CHANNELS_LEGEND,
  OAUTH_CONSENT_CLIENT_NOTE,
  OAUTH_CONSENT_DENY_BUSY,
  OAUTH_CONSENT_DENY_LABEL,
  OAUTH_CONSENT_EXPIRED_DETAIL,
  OAUTH_CONSENT_EXPIRED_HEADLINE,
  OAUTH_CONSENT_LEAD,
  OAUTH_CONSENT_LOADING_SR,
  OAUTH_CONSENT_MISSING_DETAIL,
  OAUTH_CONSENT_MISSING_HEADLINE,
  OAUTH_CONSENT_NO_CANDIDATE_DETAIL,
  OAUTH_CONSENT_NO_CANDIDATE_HEADLINE,
  OAUTH_CONSENT_OFFLINE_NOTE,
  OAUTH_CONSENT_PICK_AGENT_HINT,
  OAUTH_CONSENT_RETURNING,
  OAUTH_CONSENT_SCOPES_HINT,
  OAUTH_CONSENT_SCOPES_LEGEND,
  OAUTH_CONSENT_SECURITY_NOTE,
  OAUTH_CONSENT_SIGNIN_DETAIL,
  OAUTH_CONSENT_TITLE,
  OAUTH_CONSENT_UNAVAILABLE_DETAIL,
  OAUTH_CONSENT_UNAVAILABLE_HEADLINE,
  OAUTH_CONSENT_WORKSPACE_FALLBACK,
  OAUTH_CONSENT_WORKSPACE_KEY,
} from "@momo/core/features/hostedAgents/oauthConsent";
import { hostedWorkspaceQuery } from "./hostedCredentialScope";
import { ChoiceList, type ChoiceListItem } from "./ChoiceList";
import { readOauthRequestId } from "./oauthConsentPath";

// =============================================================================
// MCP OAuth 2.1 resource-owner consent 화면 (goal HAP-UX4 / #1369).
//
// provider 리다이렉트가 `/oauth/consent?request=<봉투>` 로 떨어뜨린 사람에게, 이
// 워크스페이스의 오너/관리자가 무엇을 승인하는지 보여주고 approve/deny 를 받는다.
// 판정과 문구는 전부 `@momo/core/features/hostedAgents/oauthConsent` 에 있고, 이
// 파일은 그 위에 화면을 얇게 얹는다(design-taste-web §0: judgment in core).
//
// 이 화면은 HashRouter 밖에 산다(oauthConsentPath.ts 머리말). App 이 라우터보다
// 먼저 경로를 보고 여기로 갈라지므로, 이 컴포넌트는 자기 세션 게이트를 직접 든다:
// 복원 중이면 로딩, 로그아웃이면 로그인, 로그인했으면 본문.
//
// ## 보안 척추 (acceptance)
//
//   - URL 에서 읽는 것은 서버가 서명한 opaque request id 하나뿐이다. 저장소·
//     히스토리·로그 어디에도 복제하지 않는다. provider 리다이렉트의 다른 값은
//     보지 않는다(oauthConsentPath.readOauthRequestId).
//   - 상태는 그 id 로 **서버 preview** 에서 복원한다. 만료·위조·재생·타
//     워크스페이스·비관리자·OAuth 비활성은 전부 같은 404 라, 화면도 한 문장으로
//     접는다(non-enumerable). 어느 실패도 static bearer 로 내려가지 않는다.
//   - approve/deny 는 명시 버튼이다. 닫기·뒤로·타임아웃은 이 버튼을 부르지 않는
//     것과 같고, 그것은 거부(capability 0)와 동등하다.
//   - 결정은 하나만 낸다: `decided` 가 두 번째 요청을 막고, 서버도 409 로 나머지를
//     무효화한다. 성공하면 서버가 준 redirectTo 로 `replace` 한다(히스토리에 이
//     화면을 남기지 않아 뒤로가기가 여기로 돌아오지 않는다).
// =============================================================================

export function OAuthConsentRoute({
  status,
  session,
  onLoggedIn,
}: {
  status: SessionRestoreStatus;
  session: LoginResponse | null;
  onLoggedIn: (session: LoginResponse) => void;
}) {
  // URL 에서 한 번만 읽고, 컴포넌트 수명 동안 붙든다. 어디에도 다시 쓰지 않는다.
  const [requestId] = useState(() => readOauthRequestId(window.location.search));

  // 결정 중 401 로 세션이 끊긴 경우. 이 클라이언트의 hostedRequest 는 refresh
  // 파이프라인을 타지 않아 세션 스토어의 authExpired 를 세우지 않으므로(그래서 상단
  // 세션 게이트가 저절로 다시 열리지 않는다), 본문이 401 을 만나면 여기로 올려
  // 로그인 화면을 다시 세운다(design-review H1). 로그인이 끝나면 이 표시를 내리고
  // 상위 세션을 갱신해, 같은 request id 로 본문이 다시 마운트된다.
  const [sessionLost, setSessionLost] = useState(false);
  // 효과 의존성이라 정체성을 고정한다(불필요한 재실행 방지).
  const onSessionExpired = useCallback(() => setSessionLost(true), []);

  // 로그아웃 사용자는 기존 로그인 화면으로 보낸 뒤 같은 요청으로 돌아온다. URL 은
  // 그대로라(로그인은 화면 이동이 아니다) 로그인 뒤 이 라우트가 같은 request id 로
  // 다시 그려진다.
  if (
    requestId !== null &&
    status !== "restoring" &&
    (session === null || sessionLost)
  ) {
    return (
      <div className="mx-auto flex min-h-full w-full max-w-lg flex-col">
        <InlineBanner
          tone="neutral"
          message={OAUTH_CONSENT_SIGNIN_DETAIL}
          testId="oauth-consent-signin"
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
    <ConsentFrame>
      {requestId === null ? (
        <ConsentTerminal
          headline={OAUTH_CONSENT_MISSING_HEADLINE}
          detail={OAUTH_CONSENT_MISSING_DETAIL}
          testId="oauth-consent-missing"
        />
      ) : status === "restoring" || session === null ? (
        <ConsentLoading />
      ) : (
        <ConsentBody
          session={session}
          requestId={requestId}
          onSessionExpired={onSessionExpired}
        />
      )}
    </ConsentFrame>
  );
}

/** 페이지 정체성. 어떤 상태에서도 이 제목이 이 표면의 이름이다. */
function ConsentFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto flex min-h-full w-full max-w-lg flex-col gap-6 p-4">
      <header className="flex min-w-0 flex-col gap-1">
        <h1 className="break-keep text-title font-semibold text-ink">
          {OAUTH_CONSENT_TITLE}
        </h1>
        <p className="break-keep text-body text-ink-muted">{OAUTH_CONSENT_LEAD}</p>
      </header>
      {children}
    </div>
  );
}

function ConsentLoading() {
  return (
    <div role="status" data-testid="oauth-consent-loading">
      <span className="sr-only">{OAUTH_CONSENT_LOADING_SR}</span>
      <SkeletonRows rows={5} className="p-0" />
    </div>
  );
}

/**
 * capability 0 종료 화면. 제목 h1 은 프레임이 이미 세웠으므로 여기 headline 은
 * `heading=false`(기본)로 `<p>` 다 (States.EmptyInvite 규율).
 */
function ConsentTerminal({
  headline,
  detail,
  testId,
}: {
  headline: string;
  detail: string;
  testId: string;
}) {
  return (
    <EmptyInvite
      className="px-0"
      headline={headline}
      detail={detail}
      testId={testId}
    />
  );
}

// ---- 본문 -------------------------------------------------------------------

function ConsentBody({
  session,
  requestId,
  onSessionExpired,
}: {
  session: LoginResponse;
  requestId: string;
  /** 401 을 만나면 라우트에 알려 로그인 화면을 다시 세운다(design-review H1). */
  onSessionExpired: () => void;
}) {
  const workspaceId = session.member.workspaceId;
  const offline = useBrowserOffline();
  const { groups } = useChannels(workspaceId);
  const workspace = useQuery(hostedWorkspaceQuery(workspaceId));

  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [scopeSelection, setScopeSelection] = useState<string[]>([]);
  const [channelSelection, setChannelSelection] = useState<string[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  // 결정 시점에 서버가 낸 종료(409 이미 결정됨 · 404/403 사라진 요청). 배너가 아니라
  // 종료 화면이라, 버튼이 함께 서 자기모순을 그리지 않는다(design-review H1/M2).
  const [decisionTerminal, setDecisionTerminal] =
    useState<OauthDecisionTerminal | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const decided = useRef(false);

  /** 결정 실패의 갈림은 코어가 정한다: 401 은 로그인, 409/404/403 은 종료, 나머지 배너. */
  function handleDecisionError(action: "approve" | "deny", error: unknown) {
    const outcome = classifyOauthDecisionError(action, error);
    if (outcome.kind === "session-expired") {
      onSessionExpired();
      return;
    }
    if (outcome.kind === "terminal") {
      decided.current = true;
      setDecisionTerminal(outcome.terminal);
      return;
    }
    setFailure(outcome.message);
  }

  const preview = useQuery({
    queryKey: ["oauth-consent", "preview", workspaceId, requestId],
    queryFn: async () =>
      parseOauthConsentPreview(
        await previewHostedOauthConsent(workspaceId, requestId)
      ),
    // 서명된 일회성 봉투다. 되묻지 않고, 언마운트에서 캐시에 남기지 않는다.
    retry: false,
    gcTime: 0,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
  const data = preview.data ?? null;

  // preview 가 오면 요청된 상한을 기본 선택으로, candidate 가 하나면 그것을 고른다.
  //
  // M3-a (사람 승인, 의도된 자세): scope 기본값은 provider 가 **요청한** 집합이다.
  // 이것은 "grant-all" pre-check 가 아니다 — 요청 밖 권한은 아예 목록에 없고(넓힐 수
  // 없다), 각 권한은 개별 줄로 좁힐 수 있으며, 채널은 빈 선택으로 시작한다. OAuth
  // consent 의 올바른 기본은 "요청된 것을 확인·축소"이지 최소권한으로 되묻는 것이
  // 아니다. 접속(required)은 잠겨 있고, 결과 문장이 정확히 무엇을 여는지 말한다.
  useEffect(() => {
    if (data === null) return;
    setScopeSelection([...data.requestedScopes]);
    setChannelSelection([]);
    if (data.candidates.length === 1) {
      setConnectionId(data.candidates[0]?.connectionId ?? null);
    }
  }, [data]);

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
    if (previewError !== null && isOauthSessionExpired(previewError)) {
      onSessionExpired();
    }
  }, [previewError, onSessionExpired]);

  const channelInputs = useMemo<ApprovalChannelInput[]>(() => {
    const named = groups.channels.map((channel) => ({
      id: channel.id,
      label: `#${channel.name ?? "채널"}`,
      kind: channel.kind,
    }));
    const dms = groups.dms.map((channel) => ({
      id: channel.id,
      label: channel.name ?? "1:1 대화",
      kind: channel.kind,
    }));
    return [...named, ...dms];
  }, [groups.channels, groups.dms]);

  function finishDecision(redirectTo: string) {
    if (decided.current) return;
    decided.current = true;
    setReturning(true);
    // 히스토리에 이 화면을 남기지 않는다: 뒤로가기가 승인 화면으로 돌아오지 않게.
    window.location.replace(redirectTo);
  }

  const approve = useMutation({
    mutationFn: async () => {
      if (data === null || connectionId === null) throw new Error("no selection");
      const body = buildOauthApprove(
        requestId,
        connectionId,
        data.requestedScopes,
        scopeSelection,
        channelInputs,
        channelSelection
      );
      return parseOauthDecision(
        await approveHostedOauthConsent(workspaceId, body),
        { connectionId }
      );
    },
    onSuccess: (result) => finishDecision(result.redirectTo),
    onError: (error) => handleDecisionError("approve", error),
  });

  const deny = useMutation({
    mutationFn: async () => {
      if (connectionId === null) throw new Error("no selection");
      return parseOauthDecision(
        await denyHostedOauthConsent(
          workspaceId,
          buildOauthDeny(requestId, connectionId)
        ),
        { connectionId }
      );
    },
    onSuccess: (result) => finishDecision(result.redirectTo),
    onError: (error) => handleDecisionError("deny", error),
  });

  const busy = approve.isPending || deny.isPending;

  // ---- 상태 갈림 ----
  // 어느 화면인가는 코어의 순수 selector 가 정한다(coordinator H1: 이 판단이
  // 검증되도록). 컴포넌트는 그 결과를 그리기만 한다.
  const screen = oauthConsentScreen({
    decisionTerminal,
    returning,
    previewPending: preview.isPending,
    previewError: preview.isError ? preview.error : null,
    data,
    nowMs,
  });
  switch (screen.kind) {
    case "loading":
      return <ConsentLoading />;
    case "returning":
      return (
        <p
          role="status"
          className="break-keep text-body text-ink"
          data-testid="oauth-consent-returning"
        >
          {OAUTH_CONSENT_RETURNING}
        </p>
      );
    case "already-decided":
      return (
        <ConsentTerminal
          headline={OAUTH_CONSENT_ALREADY_DECIDED_HEADLINE}
          detail={OAUTH_CONSENT_ALREADY_DECIDED_DETAIL}
          testId="oauth-consent-already-decided"
        />
      );
    case "unavailable":
      return (
        <ConsentTerminal
          headline={OAUTH_CONSENT_UNAVAILABLE_HEADLINE}
          detail={OAUTH_CONSENT_UNAVAILABLE_DETAIL}
          testId="oauth-consent-unavailable"
        />
      );
    case "retry":
      return (
        <InlineBanner
          separator={false}
          message={screen.message}
          actionLabel="다시 시도"
          onAction={() => void preview.refetch()}
          testId="oauth-consent-preview-error"
        />
      );
    case "expired":
      return (
        <ConsentTerminal
          headline={OAUTH_CONSENT_EXPIRED_HEADLINE}
          detail={OAUTH_CONSENT_EXPIRED_DETAIL}
          testId="oauth-consent-expired"
        />
      );
    case "no-candidate":
      return (
        <ConsentTerminal
          headline={OAUTH_CONSENT_NO_CANDIDATE_HEADLINE}
          detail={OAUTH_CONSENT_NO_CANDIDATE_DETAIL}
          testId="oauth-consent-no-candidate"
        />
      );
    case "form":
      break;
  }
  // selector 가 "form" 을 낼 때만 여기 닿고, 그때 data 는 non-null·만료 전·candidate
  // 있음이 보장된다. 아래는 타입 좁힘용 가드(도달 불가).
  if (data === null) return <ConsentLoading />;
  const expiry = oauthRequestExpiry(data.expiresAtMs, nowMs);

  const selectedCandidate = data.candidates.find((candidate) =>
    uuidEq(candidate.connectionId, connectionId ?? "")
  );
  const agentLabel = selectedCandidate?.agentDisplayName ?? OAUTH_CONSENT_AGENT_FALLBACK;
  const approvedScopes = normalizeOauthScopes(data.requestedScopes, scopeSelection);
  const approvedChannelCount = channelApprovalChoices(channelInputs).filter(
    (choice) => !choice.disabled && channelSelection.includes(choice.id)
  ).length;
  // 에이전트를 고른 뒤에만, 온라인이고, 다른 결정이 떠 있지 않고, 아직 결정을
  // 내지 않았을 때만 누를 수 있다. 판정은 코어가 든다(oauthCanDecide 테스트가 못).
  const canDecide = oauthCanDecide({
    connectionId,
    offline,
    busy,
    decided: decided.current,
  });

  const scopeItems: ChoiceListItem[] = oauthScopeChoices(data.requestedScopes).map(
    (choice) => ({
      id: choice.id,
      label: choice.label,
      detail: choice.required
        ? `${choice.detail} ${choice.requiredReason ?? ""}`.trim()
        : choice.detail,
      ...(choice.required ? { locked: true } : {}),
    })
  );
  const channelItems: ChoiceListItem[] = channelApprovalChoices(channelInputs).map(
    (choice) => ({
      id: choice.id,
      label: choice.label,
      detail: choice.detail,
      ...(choice.disabled ? { disabled: true } : {}),
    })
  );

  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="oauth-consent-form">
      {offline && (
        <InlineBanner
          tone="neutral"
          message={OAUTH_CONSENT_OFFLINE_NOTE}
          testId="oauth-consent-offline"
        />
      )}
      {failure && (
        <InlineBanner
          message={failure}
          actionLabel="닫기"
          onAction={() => setFailure(null)}
          testId="oauth-consent-failure"
        />
      )}

      <p className="text-meta text-ink-muted" data-numeric data-testid="oauth-consent-expiry">
        {expiry.label}
      </p>

      {/* 워크스페이스와 전용 에이전트: 이 인가가 묶이는 두 정체성. */}
      <KeyValueRows
        rows={[
          {
            key: OAUTH_CONSENT_WORKSPACE_KEY,
            value: workspace.data?.name ?? OAUTH_CONSENT_WORKSPACE_FALLBACK,
            prose: true,
          },
          ...(selectedCandidate
            ? [
                {
                  key: OAUTH_CONSENT_AGENT_KEY,
                  value: selectedCandidate.agentDisplayName,
                  prose: true,
                },
              ]
            : []),
        ]}
      />

      {/* 요청한 외부 클라이언트·돌아갈 주소·자원·인가 서버. 전부 서버/운영자 값. */}
      <KeyValueRows
        rows={oauthConsentFacts(data).map((fact) => ({
          key: fact.key,
          value: fact.value,
          numeric: fact.token,
          prose: !fact.token,
        }))}
      />
      <p className="break-keep text-meta text-ink-muted" data-testid="oauth-consent-client-note">
        {OAUTH_CONSENT_CLIENT_NOTE}
      </p>

      <p className="break-keep text-body text-ink" data-testid="oauth-consent-security-note">
        {OAUTH_CONSENT_SECURITY_NOTE}
      </p>

      {/* candidate 가 여럿이면 어느 전용 에이전트로 접속을 허용할지 고른다. */}
      {data.candidates.length > 1 && (
        <ChoiceList
          name="oauth-candidate"
          legend={OAUTH_CONSENT_CANDIDATE_LEGEND}
          hint={OAUTH_CONSENT_PICK_AGENT_HINT}
          multiple={false}
          items={data.candidates.map((candidate) => ({
            id: candidate.connectionId,
            label: candidate.agentDisplayName,
            detail: OAUTH_CONSENT_CANDIDATE_DETAIL,
          }))}
          selected={connectionId ? [connectionId] : []}
          onChange={(next) => setConnectionId(next[0] ?? null)}
          disabled={busy}
          testId="oauth-candidates"
        />
      )}

      <ChoiceList
        name="oauth-scopes"
        legend={OAUTH_CONSENT_SCOPES_LEGEND}
        hint={OAUTH_CONSENT_SCOPES_HINT}
        multiple
        items={scopeItems}
        selected={approvedScopes}
        onChange={setScopeSelection}
        disabled={busy}
        testId="oauth-scopes"
      />

      {channelItems.length > 0 && (
        <ChoiceList
          name="oauth-channels"
          legend={OAUTH_CONSENT_CHANNELS_LEGEND}
          hint={OAUTH_CONSENT_CHANNELS_HINT}
          multiple
          items={channelItems}
          selected={channelSelection}
          onChange={setChannelSelection}
          disabled={busy}
          testId="oauth-channels"
        />
      )}

      <div className="flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface-hover p-3">
        <p className="break-keep text-body text-ink" data-testid="oauth-consent-consequence">
          {oauthConsentConsequence(agentLabel, approvedChannelCount, approvedScopes)}
        </p>
      </div>

      {/*
        M3-b (의도된 자세): approve 는 주 버튼이고 AlertDialog 확인 단계를 두지
        않는다. 이 표면 자체가 provider 리다이렉트로 도달한 **전용 consent 페이지**라
        (앰비언트 UI 안의 버튼이 아니다), 위의 보안 문구·결과 문장·전체 검토가 §6 이
        요구하는 숙고를 대신한다. 실제 OAuth consent 화면이 그렇고, 이 번들에는
        AlertDialog primitive 도 없다. aria-disabled+opacity-50 은 wizard 의
        CloseAction 선례와 같다(Nit: 이미 올바름) — disabled 로 포커스를 떨구지 않고
        사유는 화면에 남긴다.
      */}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={!canDecide || undefined}
          aria-busy={deny.isPending || undefined}
          className={cn(!canDecide && "opacity-50")}
          onClick={() => {
            if (!canDecide || decided.current) return;
            deny.mutate();
          }}
          data-testid="oauth-consent-deny"
        >
          {deny.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {deny.isPending ? OAUTH_CONSENT_DENY_BUSY : OAUTH_CONSENT_DENY_LABEL}
        </Button>
        <Button
          type="button"
          size="sm"
          aria-disabled={!canDecide || undefined}
          aria-busy={approve.isPending || undefined}
          className={cn(!canDecide && "opacity-50")}
          onClick={() => {
            if (!canDecide || decided.current) return;
            approve.mutate();
          }}
          data-testid="oauth-consent-approve"
        >
          {approve.isPending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {approve.isPending ? OAUTH_CONSENT_APPROVE_BUSY : OAUTH_CONSENT_APPROVE_LABEL}
        </Button>
      </div>
    </div>
  );
}
