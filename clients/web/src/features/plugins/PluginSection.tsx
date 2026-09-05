import { type MutableRefObject, type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Loader2 } from "lucide-react";
import { useSession } from "@/app/session";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import {
  getPlugin,
  grantPluginScope,
  installPlugin,
  listPlugins,
  revokePluginInstall,
  revokePluginScope,
  type PluginCatalogItem,
  type PluginDetail,
  type PluginManifestTool,
  type PluginMutation,
  type PluginPolicyTool,
} from "@momo/core/lib/api";
import { SectionShell, StatusChip } from "@/features/settings/SettingsFields";
import { serverSaysAbsent } from "@momo/core/features/capabilities/serverSurfaces";
import { SurfaceUnavailableSection } from "@/features/capabilities/SurfaceUnavailable";
import {
  actionErrorForPlugin,
  activePluginScopes,
  administratorNames,
  approvalLabel,
  callerPolicySummary,
  declaredPluginScopes,
  focusPluginActionAfterErrorDismissal,
  focusPluginScopeChangeFallback,
  identifiableScopeSentence,
  isWorkspaceAdmin,
  nonAdminInstallGuidance,
  pluginActionButtonState,
  pluginActionConfirmation,
  pluginConsentScopeAction,
  pluginDetailErrorMessage,
  pluginMarketplaceNeedsDetailFocus,
  pluginRoleState,
  pluginScopeChangeFallbackKind,
  pluginScopeConsentCompletion,
  pluginScopeChangeMessage,
  pluginScopeChangeTone,
  remainingPluginScopes,
  riskLabel,
  settlePluginScopeChanges,
  scopeSentence,
  toolsForPluginScope,
  workspaceInstallationLabel,
  type PluginAction,
  type PluginRoleState,
  type PluginScopeChangeKind,
  type PluginScopeChangeOutcome,
  type PluginScopeConsentFailure,
} from "./model";

type Filter = "all" | "installed" | "permitted";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "모든 앱" },
  { id: "installed", label: "설치됨" },
  { id: "permitted", label: "내 권한" },
];

type PluginScopeConsent = {
  kind: PluginScopeChangeKind;
  plugin: PluginDetail;
  scopes: string[];
};

type PluginScopeChangeReceipt = {
  pluginId: string;
  kind: PluginScopeChangeKind;
  outcomes: PluginScopeChangeOutcome[];
};

type PluginManagementAction = Extract<PluginAction, { kind: "install" | "uninstall" }>;

export function PluginSection({ offline }: { offline: boolean }) {
  const { workspaceId, session } = useSession();
  const client = useQueryClient();
  const directoryQuery = useDirectory(workspaceId);
  const me = memberFor(directoryQuery.directory, session.member.id);
  const roleState = pluginRoleState({
    isPending: directoryQuery.isPending,
    isError: directoryQuery.isError,
    role: me?.role,
  });
  const canManage = roleState === "known" && isWorkspaceAdmin(me?.role);
  const managerNames = administratorNames(directoryQuery.directory.members);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<Extract<PluginAction, { kind: "uninstall" }> | null>(null);
  const [consenting, setConsenting] = useState<PluginScopeConsent | null>(null);
  const [consentError, setConsentError] = useState<PluginScopeConsentFailure | null>(null);
  const [scopeChange, setScopeChange] = useState<PluginScopeChangeReceipt | null>(null);
  const [scopeFocusAfterChange, setScopeFocusAfterChange] = useState<PluginScopeChangeKind | null>(null);
  const [revealDetailFor, setRevealDetailFor] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const actionErrorRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement | null>(null);
  const grantScopeButtonRef = useRef<HTMLButtonElement | null>(null);
  const revokeScopeButtonRef = useRef<HTMLButtonElement | null>(null);

  const catalogQuery = useQuery({
    queryKey: ["plugins", workspaceId.toLowerCase()],
    queryFn: () => listPlugins(workspaceId),
    retry: false,
  });

  const visible = useMemo(() => {
    const catalog = catalogQuery.data;
    if (!catalog) return [];
    const text = query.trim().toLocaleLowerCase();
    return catalog.plugins.filter((plugin) => {
      const permitted = (catalog.toolsByPlugin.get(plugin.pluginId)?.length ?? 0) > 0;
      const matchesFilter = filter === "all" ||
        (filter === "installed" && plugin.installed) ||
        (filter === "permitted" && permitted);
      const haystack = [plugin.name, plugin.description, ...plugin.recommendedFor]
        .join(" ")
        .toLocaleLowerCase();
      return matchesFilter && (!text || haystack.includes(text));
    });
  }, [catalogQuery.data, filter, query]);

  useEffect(() => {
    if (visible.length === 0) {
      setSelectedId(null);
    } else if (!selectedId || !visible.some((plugin) => plugin.pluginId === selectedId)) {
      setSelectedId(visible[0].pluginId);
    }
  }, [selectedId, visible]);

  const selected = visible.find((plugin) => plugin.pluginId === selectedId) ?? null;
  const detailsQuery = useQuery({
    queryKey: ["plugins", workspaceId.toLowerCase(), selectedId],
    queryFn: () => getPlugin(workspaceId, selectedId ?? ""),
    enabled: selectedId !== null,
    retry: false,
  });

  const mutation = useMutation<PluginMutation | PluginScopeChangeOutcome[], unknown, PluginAction>({
    mutationFn: async (action: PluginAction) => {
      if (action.kind === "install") return installPlugin(workspaceId, action.pluginId);
      if (action.kind === "uninstall") return revokePluginInstall(workspaceId, action.pluginId);
      if (action.kind === "grantScopes") {
        return settlePluginScopeChanges(action.scopes, (scope) =>
          grantPluginScope(workspaceId, action.pluginId, scope)
        );
      }
      return settlePluginScopeChanges(action.scopes, (scope) =>
        revokePluginScope(workspaceId, action.pluginId, scope)
      );
    },
    onSuccess: async (data, action) => {
      setConfirming(null);
      if (action.kind === "grantScopes" || action.kind === "revokeScopes") {
        const kind = action.kind === "grantScopes" ? "grant" : "revoke";
        const outcomes = data as PluginScopeChangeOutcome[];
        const completion = pluginScopeConsentCompletion(outcomes);
        // Keep a receipt even when the dialog stays open. If the user stops
        // after a full failure, the panel still records that an attempt ran.
        setScopeChange({ pluginId: action.pluginId, kind, outcomes });
        if (completion.dismissDialog) {
          setConsenting(null);
          setConsentError(null);
          if (outcomes.every((outcome) => outcome.succeeded)) {
            setScopeFocusAfterChange(kind);
          }
        } else {
          setConsentError({ error: completion.error, causes: completion.causes });
        }
      }
      await client.invalidateQueries({ queryKey: ["plugins", workspaceId.toLowerCase()] });
    },
    // A failed destructive action must return to the inline banner in the
    // panel. Keeping its confirmation dialog open would hide the error behind
    // the scrim and leave no next action in the context that failed.
    onError: () => setConfirming(null),
  });

  const actionError = mutation.isError
    ? actionErrorForPlugin(mutation.variables, selectedId ?? "", mutation.error)
    : null;

  useEffect(() => {
    if (revealDetailFor !== selectedId || !detailRef.current || detailsQuery.isPending) return;
    const scrollViewport = detailRef.current.closest<HTMLElement>("[data-settings-scroll-viewport]");
    const viewport = scrollViewport?.getBoundingClientRect() ?? {
      top: 0,
      bottom: window.innerHeight,
    };
    if (pluginMarketplaceNeedsDetailFocus(detailRef.current.getBoundingClientRect(), viewport)) {
      detailRef.current.scrollIntoView({ block: "start" });
    }
    setRevealDetailFor(null);
  }, [detailsQuery.isPending, revealDetailFor, selectedId]);

  // On a one-column panel an inline mutation error may land just below the
  // trigger that caused it. The message must be in view, not merely mounted.
  useEffect(() => {
    if (!actionError) return;
    const frame = window.requestAnimationFrame(() => {
      actionErrorRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [actionError]);

  useEffect(() => {
    if (!scopeFocusAfterChange) return;
    // A full grant removes its "내 사용 허용" opener and adds "내 권한 회수"
    // (the inverse is true for a full revoke). The replacement describes the
    // new state and remains available after the catalog refetch, unlike the
    // opener that would otherwise leave focus on <body>.
    const fallbackKind = pluginScopeChangeFallbackKind(scopeFocusAfterChange);
    const fallback = () => fallbackKind === "grant"
      ? grantScopeButtonRef.current
      : revokeScopeButtonRef.current;
    if (focusPluginScopeChangeFallback(fallback())) {
      setScopeFocusAfterChange(null);
      return;
    }
    // Catalog and detail refetches may settle on different frames. During that
    // gap the complementary button exists but is disabled by the sibling-write
    // lock, and calling focus() is a no-op. Wait for the busy state to clear and
    // retry from its dependency instead of treating the call as arrival.
    if (mutation.isPending) return;
    let cancelled = false;
    let attempts = 0;
    let frame = 0;
    const retry = () => {
      if (cancelled) return;
      if (focusPluginScopeChangeFallback(fallback())) {
        setScopeFocusAfterChange(null);
        return;
      }
      attempts += 1;
      if (attempts < 4) {
        frame = window.requestAnimationFrame(retry);
        return;
      }
      // A malformed response can remove both actions. The selected detail is a
      // stable, named destination and is safer than abandoning focus on body.
      detailRef.current?.focus();
      setScopeFocusAfterChange(null);
    };
    frame = window.requestAnimationFrame(retry);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [catalogQuery.data, detailsQuery.data, mutation.isPending, scopeFocusAfterChange]);

  const lines = [
    "워크스페이스에 설치할 앱과 내 사용 권한을 관리합니다.",
    "앱이 연결할 외부 도메인과 현재 내게 허용된 도구 정책을 함께 확인할 수 있습니다.",
  ];

  // 미제공일 때의 머리말. 위 두 줄을 그대로 쓰면 구획이 스스로를 반박한다:
  // "관리합니다 / 확인할 수 있습니다"라고 현재형으로 약속해 놓고 바로 아래에서
  // "설치를 받지 않습니다"라고 부정하는 화면이 된다. 정직화 배치가 남길 수 있는
  // 가장 민망한 자국이라, 접을 때는 설명 줄도 함께 접는다.
  //
  // 다른 세 표면(작업 흐름·활동·에이전트 허브)에는 이 문제가 없다. 그쪽 머리말은
  // 라벨 한 단어뿐이라 부정할 본문을 갖고 있지 않다.
  const unavailableLines = [
    "이 서버에서는 앱을 설치하거나 권한을 관리할 수 없습니다.",
  ];

  // 이 서버가 앱 표면을 싣지 않았다 (goal B12). 판정은 정적 표가 아니라 **서버가
  // 방금 준 답**으로 한다: 이 패널은 게이트가 실제로 답하는 서버 앞에서도 서고
  // (gate-shell-layout이 여기서 권한 동의 다이얼로그를 잰다), 그 서버에서는
  // 목록이 정상으로 그려져야 하기 때문이다. 즉 여기는 이중 방어의 (b)다.
  //
  // 접는 것은 배너 한 줄이 아니라 **구획 전체**다. 검색 상자와 보기 필터를 남겨
  // 두면 없는 목록을 거르는 컨트롤이 되고, 그것이 패킷이 금지한 빈 껍데기다.
  //
  // 고치는 문장: "앱 목록을 읽지 못했습니다. 서버 연결을 확인한 뒤 다시
  // 시도하세요." 연결은 멀쩡했고 확인할 것도 다시 시도할 것도 없었다.
  if (serverSaysAbsent(catalogQuery.error)) {
    return (
      <SectionShell title="앱" lines={unavailableLines} wide>
        <SurfaceUnavailableSection
          surface="plugins"
          testId="plugins-unavailable"
          // SectionShell의 헤더는 자기 상자의 왼쪽 끝에 붙는데 EmptyInvite는
          // 스스로 px-4를 갖는다. 그대로 두면 빈 상태만 제목보다 16px 안으로
          // 들어가 앉는다(design-review M).
          flush
        />
      </SectionShell>
    );
  }

  return (
    <SectionShell title="앱" lines={lines} wide>
      <div className="plugin-marketplace-controls">
        <label className="flex min-w-0 flex-col gap-1" htmlFor="plugin-search">
          <span className="text-meta text-ink-muted">앱 검색</span>
          <Input
            id="plugin-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="이름 또는 용도 검색"
          />
        </label>
        <label className="flex min-w-0 flex-col gap-1" htmlFor="plugin-filter">
          <span className="text-meta text-ink-muted">보기</span>
          <Select
            id="plugin-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value as Filter)}
          >
            {FILTERS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </Select>
        </label>
      </div>

      {catalogQuery.isPending && <PluginMarketplaceSkeleton />}
      {catalogQuery.isError && (
        <InlineBanner
          message="앱 목록을 읽지 못했습니다. 서버 연결을 확인한 뒤 다시 시도하세요."
          actionLabel="다시 시도"
          onAction={() => void catalogQuery.refetch()}
          testId="plugins-error"
        />
      )}
      {catalogQuery.data && visible.length === 0 && (
        <EmptyInvite
          headline="설치할 수 있는 앱이 없습니다."
          detail={catalogQuery.data.plugins.length === 0
            ? "서버에 등록된 앱이 아직 없습니다."
            : "검색어나 보기를 바꿔 다른 앱을 확인하세요."}
          actions={catalogQuery.data.plugins.length > 0 ? (
            <Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>
              필터 지우기
            </Button>
          ) : undefined}
          testId="plugins-empty"
        />
      )}
      {catalogQuery.data && visible.length > 0 && (
        <div className="plugin-marketplace-layout">
          {/* 한국어 산문은 어절에서 끊는다(MOMO-676 M-5). word-break는 상속되므로
              표면의 뿌리에 한 번만 선언하고, 식별자를 담은 자식(스코프 id, URL,
              도메인)은 자기 자리에서 break-all로 이 규칙을 덮는다. ASCII는
              keep-all의 영향을 받지 않으므로 영문 매니페스트 문구도 안전하다. */}
          <ul className="flex break-keep flex-col overflow-hidden rounded-md border border-line" data-testid="plugin-list">
            {visible.map((plugin) => {
              const policy = catalogQuery.data?.toolsByPlugin.get(plugin.pluginId);
              const active = plugin.pluginId === selectedId;
              return (
                <li key={plugin.pluginId} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    data-testid={`plugin-catalog-${plugin.pluginId}`}
                    disabled={mutation.isPending}
                    onClick={() => {
                      // 입력 방식으로 가르지 않는다. onClick은 키보드 Enter/Space에서도
                      // 발화하고, 이 목록에는 로빙 화살표 선택이 없어 "탭하며 지나가다
                      // 스크롤이 흔들린다"는 위험이 없다. 포인터로만 핸드오프하면
                      // 키보드 사용자는 Enter를 눌러도 상세가 폴드 밖에 남는다(4R H-1).
                      // 실제로 스크롤할지는 아래 가시성 판정이 rect로 결정한다.
                      setSelectedId(plugin.pluginId);
                      setRevealDetailFor(plugin.pluginId);
                    }}
                    aria-current={active ? "true" : undefined}
                    className={active
                      ? "plugin-marketplace-row flex w-full flex-col gap-2 bg-accent-soft p-3 text-left active:bg-surface-pressed focus-visible:focus-ring"
                      : "plugin-marketplace-row flex w-full flex-col gap-2 p-3 text-left active:bg-surface-pressed focus-visible:focus-ring disabled:cursor-wait"}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="flex size-control shrink-0 items-center justify-center rounded-sm border border-line bg-surface-raised text-body font-semibold text-ink" aria-hidden="true">
                        {plugin.iconText?.trim() || plugin.name.trim().charAt(0).toLocaleUpperCase()}
                      </span>
                      <span className="text-body font-semibold text-ink">{plugin.name}</span>
                      {plugin.official && <StatusChip tone="accent">공식</StatusChip>}
                      {/* 다이얼로그와 같은 중립 톤이다(MOMO-676 M-1). MOMO-642 7이
                          동의 다이얼로그의 같은 문자열을 ok 초록에서 내린 근거는
                          "위험 칩과 경쟁하지 않는 다른 표면"이었는데, 마켓플레이스는
                          1200px 위에서 2컬럼이라 이 행과 상세의 위험도·승인 칩이 한
                          뷰포트에 함께 선다: 근거가 성립하지 않는다. 더 나쁜 것은 같은
                          문장이 표면마다 색이 달랐다는 점이다 — 행에서 초록, 다이얼로그
                          에서 회색이면 사실 진술이 아니라 상태가 변한 것처럼 읽힌다.
                          칩은 색 없이도 말한다: 설치됨/비활성/미설치는 세 문자열이
                          이미 구분하고 있고(StatusChip은 색에만 의미를 싣지 않는다),
                          이 표면에서 색은 위험 신호의 것이다. */}
                      <StatusChip tone="muted">{workspaceInstallationLabel(plugin)}</StatusChip>
                    </span>
                    <span className="text-meta text-ink-muted">{plugin.description}</span>
                    <span className="flex flex-wrap gap-2 text-meta text-ink-muted">
                      <span>{callerPolicySummary(policy)}</span>
                      {plugin.egressDomains.length > 0 && <span>외부 연결: {plugin.egressDomains.join(", ")}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <div
              ref={detailRef}
              tabIndex={-1}
              aria-label={`${selected.name} 상세`}
            >
              <PluginDetailPanel
                plugin={selected}
                detail={detailsQuery.data}
                isPending={detailsQuery.isPending}
                isError={detailsQuery.isError}
                error={detailsQuery.error}
                onRetry={() => void detailsQuery.refetch()}
                canManage={canManage}
                roleState={roleState}
                managerNames={managerNames}
                onRetryDirectory={() => void directoryQuery.refetch()}
                offline={offline}
                policyTools={catalogQuery.data.toolsByPlugin.get(selected.pluginId) ?? []}
                busy={mutation.isPending}
                pendingAction={mutation.isPending ? mutation.variables : undefined}
                actionError={actionError}
                scopeChange={scopeChange?.pluginId === selected.pluginId ? scopeChange : null}
                onDismissScopeChange={() => setScopeChange(null)}
                actionErrorRef={actionErrorRef}
                onDismissActionError={() => {
                  mutation.reset();
                  window.requestAnimationFrame(() => {
                    focusPluginActionAfterErrorDismissal(actionButtonRef.current);
                  });
                }}
                onAction={(action, actionButton) => {
                  actionButtonRef.current = actionButton;
                  if (action.kind === "uninstall") setConfirming(action);
                  else mutation.mutate(action);
                }}
                onOpenScopeConsent={(consent, actionButton) => {
                  actionButtonRef.current = actionButton;
                  setScopeChange(null);
                  setConsentError(null);
                  setConsenting(consent);
                }}
                grantScopeButtonRef={grantScopeButtonRef}
                revokeScopeButtonRef={revokeScopeButtonRef}
              />
            </div>
          )}
        </div>
      )}

      {confirming && (
        <ConfirmPluginAction
          action={confirming}
          pending={mutation.isPending}
          opener={actionButtonRef.current}
          onCancel={() => setConfirming(null)}
          onConfirm={() => mutation.mutate(confirming)}
        />
      )}
      {consenting && (
        <PluginScopeConsentDialog
          consent={consenting}
          managerNames={managerNames}
          pending={mutation.isPending}
          opener={actionButtonRef.current}
          error={consentError}
          onCancel={() => {
            setConsentError(null);
            setConsenting(null);
          }}
          onDismissError={() => setConsentError(null)}
          onConfirm={(selectedScopes) => {
            const action = pluginConsentScopeAction({
              kind: consenting.kind,
              pluginId: consenting.plugin.pluginId,
              pluginName: consenting.plugin.name,
              declaredScopes: consenting.scopes,
              selectedScopes,
              confirmed: true,
            });
            if (action) {
              setConsentError(null);
              mutation.mutate(action);
            }
          }}
        />
      )}
    </SectionShell>
  );
}

function PluginDetailPanel({
  plugin, detail, isPending, isError, error, onRetry, canManage, roleState,
  managerNames, onRetryDirectory, offline, policyTools, busy, pendingAction, actionError,
  scopeChange, onDismissScopeChange, actionErrorRef, onDismissActionError, onAction, onOpenScopeConsent,
  grantScopeButtonRef, revokeScopeButtonRef,
}: {
  plugin: PluginCatalogItem;
  detail: PluginDetail | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  canManage: boolean;
  roleState: PluginRoleState;
  managerNames: string[];
  onRetryDirectory: () => void;
  offline: boolean;
  policyTools: PluginPolicyTool[];
  busy: boolean;
  pendingAction: PluginAction | undefined;
  actionError: string | null;
  scopeChange: PluginScopeChangeReceipt | null;
  onDismissScopeChange: () => void;
  actionErrorRef: RefObject<HTMLDivElement>;
  onDismissActionError: () => void;
  onAction: (action: PluginManagementAction, actionButton: HTMLButtonElement) => void;
  onOpenScopeConsent: (consent: PluginScopeConsent, actionButton: HTMLButtonElement) => void;
  grantScopeButtonRef: MutableRefObject<HTMLButtonElement | null>;
  revokeScopeButtonRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  if (isPending) return <Skeleton ready={false} rows={3} />;
  if (isError || !detail) {
    return (
      <InlineBanner
        message={isError ? pluginDetailErrorMessage(error) : "앱 상세 정보를 읽지 못했습니다."}
        actionLabel="다시 시도"
        onAction={onRetry}
        testId="plugin-detail-error"
      />
    );
  }

  const scopes = declaredPluginScopes(detail.tools);
  const activeScopes = activePluginScopes(detail.tools, policyTools);
  return (
    <section className="flex min-w-0 break-keep flex-col gap-3 rounded-md border border-line bg-surface-raised p-4" aria-label={`${plugin.name} 상세`} data-testid="plugin-detail">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-body font-semibold text-ink">{detail.name}</h3>
            {detail.official && <StatusChip tone="accent">공식</StatusChip>}
          </div>
          <p className="text-meta text-ink-muted">버전 {detail.version}</p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 lg:items-end">
          <PluginActions
            plugin={plugin}
            detail={detail}
            scopes={scopes}
            activeScopes={activeScopes}
            canManage={canManage}
            roleState={roleState}
            managerNames={managerNames}
            onRetryDirectory={onRetryDirectory}
            offline={offline}
            busy={busy}
            pendingAction={pendingAction}
            onAction={onAction}
            onOpenScopeConsent={onOpenScopeConsent}
            grantScopeButtonRef={grantScopeButtonRef}
            revokeScopeButtonRef={revokeScopeButtonRef}
          />
          {scopeChange && (
            <InlineBanner
              tone={pluginScopeChangeTone(scopeChange.outcomes)}
              message={pluginScopeChangeMessage(scopeChange.kind, scopeChange.outcomes)}
              actionLabel="결과 닫기"
              onAction={onDismissScopeChange}
              testId="plugin-scope-change-result"
            />
          )}
          {actionError && (
            <div ref={actionErrorRef}>
              <InlineBanner
                message={actionError}
                actionLabel="오류 닫기"
                onAction={onDismissActionError}
                testId="plugin-action-error"
              />
            </div>
          )}
        </div>
      </div>

      <dl className="flex flex-col gap-2">
        {detail.publisherName && <DetailRow label="배포자" value={detail.publisherVerified ? `${detail.publisherName}, oort 레지스트리가 확인함` : detail.publisherName} />}
        {detail.license && <DetailRow label="라이선스" value={detail.license} />}
        {detail.provenanceURL && <DetailLink label="출처" href={detail.provenanceURL} />}
        {detail.termsURL && <DetailLink label="이용약관" href={detail.termsURL} />}
        {detail.privacyPolicyURL && <DetailLink label="개인정보 처리방침" href={detail.privacyPolicyURL} />}
        {detail.egressDomains.length > 0 && <DetailRow label="외부 연결" value={detail.egressDomains.join(", ")} />}
      </dl>

      <div className="flex flex-col gap-2">
        <h4 className="text-body font-semibold text-ink">도구와 권한</h4>
        {detail.tools.length === 0 ? (
          <p className="text-body text-ink-muted">서버가 표시할 도구 정보를 보내지 않았습니다.</p>
        ) : (
          <ul className="flex flex-col overflow-hidden rounded-md border border-line">
            {detail.tools.map((tool) => <ToolRow key={tool.name} tool={tool} />)}
          </ul>
        )}
      </div>
    </section>
  );
}

/** The catalog lands as a two-column decision surface, so its wait keeps both
 * the list and the chosen-app panel in place instead of jumping from 128px. */
function PluginMarketplaceSkeleton() {
  return (
    <div className="plugin-marketplace-layout" aria-hidden="true" data-testid="plugin-marketplace-skeleton">
      <div className="flex flex-col overflow-hidden rounded-md border border-line">
        {Array.from({ length: 5 }, (_, index) => (
          <div key={index} className="flex flex-col gap-2 border-b border-line p-3 last:border-b-0">
            <div className="h-4 w-pane-sm rounded-sm bg-surface-hover" />
            <div className="h-3 rounded-sm bg-surface-hover" />
            <div className="h-3 w-pane rounded-sm bg-surface-hover" />
          </div>
        ))}
      </div>
      <div className="flex flex-col gap-3 rounded-md border border-line bg-surface-raised p-4">
        <div className="h-4 w-pane-sm rounded-sm bg-surface-hover" />
        <div className="h-3 w-pane rounded-sm bg-surface-hover" />
        <div className="h-3 rounded-sm bg-surface-hover" />
        <div className="h-control-lg rounded-sm bg-surface-hover" />
        <div className="h-control-lg rounded-sm bg-surface-hover" />
      </div>
    </div>
  );
}

function PluginActions({
  plugin, detail, scopes, activeScopes, canManage, roleState, managerNames,
  onRetryDirectory, offline, busy, pendingAction, onAction, onOpenScopeConsent,
  grantScopeButtonRef, revokeScopeButtonRef,
}: {
  plugin: PluginCatalogItem;
  detail: PluginDetail;
  scopes: string[];
  activeScopes: string[];
  canManage: boolean;
  roleState: PluginRoleState;
  managerNames: string[];
  onRetryDirectory: () => void;
  offline: boolean;
  busy: boolean;
  pendingAction: PluginAction | undefined;
  onAction: (action: PluginManagementAction, actionButton: HTMLButtonElement) => void;
  onOpenScopeConsent: (consent: PluginScopeConsent, actionButton: HTMLButtonElement) => void;
  grantScopeButtonRef: MutableRefObject<HTMLButtonElement | null>;
  revokeScopeButtonRef: MutableRefObject<HTMLButtonElement | null>;
}) {
  const available = plugin.installed && plugin.enabled;
  const managementAction: PluginManagementAction = available
    ? { kind: "uninstall", pluginId: plugin.pluginId, pluginName: plugin.name }
    : { kind: "install", pluginId: plugin.pluginId, pluginName: plugin.name };
  const grantableScopes = remainingPluginScopes(scopes, activeScopes);
  const isPending = (action: PluginManagementAction) => busy && pendingAction?.kind === action.kind
    && pendingAction.pluginId === action.pluginId;
  const isBlockedBySibling = (action: PluginManagementAction) => busy && !isPending(action);
  const isScopePending = (kind: PluginScopeChangeKind) => busy
    && pendingAction?.pluginId === plugin.pluginId
    && (kind === "grant" ? pendingAction.kind === "grantScopes" : pendingAction.kind === "revokeScopes");
  const isScopeBlockedBySibling = (kind: PluginScopeChangeKind) => busy && !isScopePending(kind);

  const roleUnknownNotice = roleState === "unknown" && (
    <PluginRoleUnknownNotice onRetry={onRetryDirectory} />
  );

  if (!available) {
    return (
      <div className="flex flex-col gap-2" aria-busy={busy || undefined}>
        {roleState === "checking" && <p className="text-meta text-ink-muted" role="status">관리자 권한을 확인하는 중입니다.</p>}
        {roleUnknownNotice}
        {roleState === "known" && !canManage && (
          <p className="max-w-pane text-meta text-ink-muted">{nonAdminInstallGuidance(managerNames)}</p>
        )}
        {canManage && (
          <div key="plugin-actions" className="flex flex-wrap items-center gap-2">
            <PluginActionButton
              key="management"
              action={managementAction}
              label={plugin.installed ? "다시 활성화" : "워크스페이스에 설치"}
              busy={isPending(managementAction)}
              blocked={isBlockedBySibling(managementAction)}
              offline={offline}
              onAction={onAction}
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2" aria-busy={busy || undefined}>
      {roleUnknownNotice}
      {scopes.length === 0 && <p className="max-w-pane text-meta text-ink-muted">허용할 권한이 없습니다.</p>}
      {activeScopes.length > 0 && (
        <p className="max-w-pane text-meta text-ink-muted">
          현재 허용: {activeScopes.map(identifiableScopeSentence).join(", ")}
        </p>
      )}
      <div key="plugin-actions" className="flex flex-wrap items-center gap-2">
        {grantableScopes.length > 0 && <PluginScopeConsentButton
          kind="grant"
          detail={detail}
          scopes={grantableScopes}
          label={activeScopes.length > 0 ? "권한 추가" : "내 사용 허용"}
          busy={isScopePending("grant")}
          blocked={isScopeBlockedBySibling("grant")}
          offline={offline}
          onOpen={onOpenScopeConsent}
          buttonRef={(button) => { grantScopeButtonRef.current = button; }}
          testId="plugin-scope-grant"
        />}
        {activeScopes.length > 0 && <PluginScopeConsentButton
          kind="revoke"
          detail={detail}
          scopes={activeScopes}
          label="내 권한 회수"
          variant="outline"
          busy={isScopePending("revoke")}
          blocked={isScopeBlockedBySibling("revoke")}
          offline={offline}
          onOpen={onOpenScopeConsent}
          buttonRef={(button) => { revokeScopeButtonRef.current = button; }}
          testId="plugin-scope-revoke"
        />}
        {canManage && (
          // 채움은 **커밋의 것**이다(MOMO-642 10). 이 표면에는 제거가 둘 있는데
          // 하나(`내 권한 회수`)는 조용한 아웃라인 오프너였고 다른 하나
          // (`설치 해제`)는 파괴 채움이었다. 둘 다 확인 다이얼로그를 여는 오프너
          // 이므로 여기서 지워지는 것은 아무것도 없다: 무게가 붙어야 할 자리는
          // 실제로 쓰는 버튼, 즉 각자의 확인 버튼이다. 그래서 두 오프너는 같은
          // 아웃라인이고, 차이는 커밋에서 말한다 — 내 정책만 바꾸는 회수는 액센트
          // 채움, 워크스페이스 전원의 권한을 함께 거두는 설치 해제는 파괴 채움.
          // (--danger-fill 자체는 그대로다. 바뀐 것은 그 채움을 누가 입느냐다.)
          <PluginActionButton
            key="management"
            action={managementAction}
            label="설치 해제"
            variant="outline"
            busy={isPending(managementAction)}
            blocked={isBlockedBySibling(managementAction)}
            offline={offline}
            onAction={onAction}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Scope changes are deliberately a separate control from installation: opening
 * it records the actual button for WebKit focus restoration, but it does not
 * construct a POST action. Only the dialog's explicit confirmation can do so.
 */
function PluginScopeConsentButton({
  kind,
  detail,
  scopes,
  label,
  variant = "default",
  busy,
  blocked,
  offline,
  onOpen,
  buttonRef,
  testId,
}: {
  kind: PluginScopeChangeKind;
  detail: PluginDetail;
  scopes: string[];
  label: string;
  variant?: "default" | "outline";
  busy: boolean;
  blocked: boolean;
  offline: boolean;
  onOpen: (consent: PluginScopeConsent, actionButton: HTMLButtonElement) => void;
  buttonRef?: (button: HTMLButtonElement | null) => void;
  testId?: string;
}) {
  const state = pluginActionButtonState({ busy, offline, blocked });
  return (
    <Button
      ref={buttonRef}
      variant={variant}
      size="sm"
      disabled={state.disabled}
      aria-busy={state.ariaBusy}
      data-testid={testId}
      onClick={(event) => {
        if (busy || offline || blocked) return;
        onOpen({ kind, plugin: detail, scopes }, event.currentTarget);
      }}
    >
      {busy && <Loader2 aria-hidden="true" className="spinner-busy" />}
      {busy ? "변경 중" : label}
    </Button>
  );
}

function PluginRoleUnknownNotice({ onRetry }: { onRetry: () => void }) {
  return (
    <InlineBanner
      message="내 역할을 확인하지 못했습니다. 설치 권한을 판단할 수 없습니다."
      actionLabel="역할 다시 확인"
      onAction={onRetry}
      testId="plugin-role-error"
    />
  );
}

/**
 * The management button keeps its element identity while an install becomes an
 * uninstall (and back). Busy is therefore a visible in-button state, not an
 * unmount or `disabled` transition that would throw keyboard focus to body.
 */
function PluginActionButton({
  action,
  label,
  variant = "default",
  busy,
  blocked,
  offline,
  onAction,
}: {
  action: PluginManagementAction;
  label: string;
  variant?: "default" | "outline" | "destructive";
  busy: boolean;
  blocked: boolean;
  offline: boolean;
  onAction: (action: PluginManagementAction, actionButton: HTMLButtonElement) => void;
}) {
  const state = pluginActionButtonState({ busy, offline, blocked });
  return (
    <Button
      variant={variant}
      size="sm"
      disabled={state.disabled}
      aria-busy={state.ariaBusy}
      onClick={(event) => {
        if (busy || offline || blocked) return;
        onAction(action, event.currentTarget);
      }}
    >
      {busy && <Loader2 aria-hidden="true" className="spinner-busy" />}
      {busy ? "변경 중" : label}
    </Button>
  );
}

type ScopeBadge = {
  label: string;
  tone: "muted" | "warn" | "danger";
};

function scopeRiskAndApprovalBadges(tools: readonly PluginManifestTool[]): ScopeBadge[] {
  const badges = tools.flatMap((tool): ScopeBadge[] => {
    const approval = approvalLabel(tool.approvalTier);
    const result: ScopeBadge[] = [];
    if (approval) {
      result.push({
        label: `승인: ${approval}`,
        tone: tool.approvalTier === "network_write"
          ? "danger"
          : tool.approvalTier === "workspace_write" ? "warn" : "muted",
      });
    }
    if (tool.risk) {
      result.push({
        label: `위험도: ${riskLabel(tool.risk)}`,
        tone: tool.risk === "admin" ? "danger" : tool.risk === "write" ? "warn" : "muted",
      });
    }
    return result;
  });
  return [...new Map(badges.map((badge) => [badge.label, badge])).values()];
}

function ToolRow({ tool }: { tool: PluginManifestTool }) {
  const badges = scopeRiskAndApprovalBadges([tool]);
  return (
    <li className="flex flex-col gap-1 border-b border-line p-3 last:border-b-0">
      <span className="text-body font-medium text-ink">{tool.name}</span>
      {tool.description && <span className="text-meta text-ink-muted">{tool.description}</span>}
      <span className="text-meta text-ink-muted">
        {tool.scopes.map(identifiableScopeSentence).join(", ")}
      </span>
      {badges.length > 0 && (
        <span className="flex flex-wrap gap-1">
          {badges.map((badge) => (
            <StatusChip key={badge.label} tone={badge.tone}>{badge.label}</StatusChip>
          ))}
        </span>
      )}
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex min-w-0 flex-col gap-px"><dt className="text-meta text-ink-muted">{label}</dt><dd className="break-all text-body text-ink">{value}</dd></div>;
}

function DetailLink({ label, href }: { label: string; href: string }) {
  return <div className="flex min-w-0 flex-col gap-px"><dt className="text-meta text-ink-muted">{label}</dt><dd><a className="break-all text-body text-ink underline decoration-line-strong underline-offset-2 hover:text-ink focus-visible:focus-ring" href={href} rel="noreferrer" target="_blank">{href}</a></dd></div>;
}

function PluginScopeConsentDialog({
  consent,
  managerNames,
  pending,
  opener,
  error,
  onCancel,
  onDismissError,
  onConfirm,
}: {
  consent: PluginScopeConsent;
  managerNames: string[];
  pending: boolean;
  /** The button that opened this programmatic dialog, never activeElement guesswork. */
  opener: HTMLButtonElement | null;
  error: PluginScopeConsentFailure | null;
  onCancel: () => void;
  onDismissError: () => void;
  onConfirm: (scopes: string[]) => void;
}) {
  const [selectedScopes, setSelectedScopes] = useState<string[]>(() => consent.scopes);
  const actionErrorRef = useRef<HTMLDivElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);
  const isGrant = consent.kind === "grant";
  const selected = new Set(selectedScopes);
  const hasSelection = selectedScopes.length > 0;
  const canConfirm = !pending && hasSelection;
  const appIcon = consent.plugin.iconText?.trim()
    || consent.plugin.name.trim().charAt(0).toLocaleUpperCase();

  useEffect(() => {
    if (!error) return;
    const frame = window.requestAnimationFrame(() => {
      actionErrorRef.current?.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [error]);

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent
        opener={opener}
        // SettingsRoute owns Escape outside this modal. Stop it here so an
        // approval cannot accidentally dismiss the whole settings route.
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => { if (pending) event.preventDefault(); }}
        // 결정 표면 전체가 한국어 산문이다(MOMO-676 M-5). 스코프 id와 URL은
        // 자기 자리의 break-all로 이 규칙을 덮는다.
        className="break-keep"
        data-testid="plugin-scope-consent"
      >
        {/* Keep only an orientation anchor and one server-backed trust signal
            fixed. Installation is workspace state, not publisher-authored
            identity; all explanatory and publisher detail remains after the
            decision scopes so the first permission evidence stays above fold. */}
        <div className="flex items-start gap-2 border-b border-line p-4">
          <DialogTitle className="min-w-0 flex-1" data-testid="plugin-scope-consent-title">
            {isGrant ? `${consent.plugin.name} 앱에 권한을 허용할까요?` : `${consent.plugin.name} 앱 권한을 회수할까요?`}
          </DialogTitle>
          {isGrant && consent.plugin.installed && consent.plugin.enabled && (
            // 중립 톤이다. 이건 상태 진술이지 승인 권유가 아니다. ok 초록으로
            // 두면 폴드 위 유일한 색이 "설치됨"에 붙어, 아래 위험도 칩보다 먼저
            // 눈에 들어오며 승인을 권하는 것처럼 읽혔다(MOMO-642 7). 이 화면에서
            // 색은 위험 신호의 것이다.
            <span data-testid="plugin-scope-installation-signal">
              <StatusChip tone="muted">워크스페이스 설치됨</StatusChip>
            </span>
          )}
        </div>

        <div
          className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4 scroll-pt-1"
          aria-busy={pending || undefined}
          data-testid="plugin-scope-consent-body"
          onFocusCapture={(event) => {
            // Radix FocusScope moves focus with preventScroll, so a ring can
            // exist below this inner viewport after autofocus or Tab wrapping.
            // Make the scroll owner follow the focused body control explicitly;
            // the fixed footer never enters this handler.
            const target = event.target;
            if (!(target instanceof HTMLElement)) return;
            window.requestAnimationFrame(() => {
              target.scrollIntoView({ block: "nearest" });
            });
          }}
        >
          <fieldset className="flex flex-col gap-2" aria-busy={pending || undefined}>
            <legend className="text-body font-semibold text-ink">
              {isGrant ? "허용할 권한" : "회수할 권한"}
            </legend>
            <p className="text-meta text-ink-muted">
              {isGrant
                ? "권한마다 연결된 도구와 데이터 범위를 확인한 뒤 계속하세요."
                : "회수하면 선택한 권한에 연결된 아래 도구를 더 이상 사용할 수 없습니다."}
            </p>
            {/* The ONE live region for selection state. Unchecking the last box
                used to say the same thing three times in one keystroke: this
                count, a second role="status" hint that mounted underneath it,
                and the confirm button's own aria-describedby pointing at that
                hint (MOMO-642 6). The requirement now lives where the blocked
                action is, as the button's own label, and this line reports the
                count. One change, one announcement. */}
            <p
              className="text-meta text-ink-muted"
              role="status"
              aria-live="polite"
              data-testid="plugin-scope-selection-count"
            >
              {consent.scopes.length}개 중 {selectedScopes.length}개 선택
            </p>
            <ul className="flex flex-col overflow-hidden rounded-md border border-line">
              {consent.scopes.map((scope) => {
                const scopeTools = toolsForPluginScope(consent.plugin.tools, scope);
                const scopeBadges = scopeRiskAndApprovalBadges(scopeTools);
                const checked = selected.has(scope);
                return (
                  <li
                    key={scope}
                    className="border-b border-line p-3 last:border-b-0"
                    data-testid={`plugin-scope-row-${scope}`}
                  >
                    {/* 진행 중에는 포인터에도 사실대로 말한다. 쓰기 중 체크박스는
                        aria-disabled="true"에 onChange가 조기 반환하는데,
                        cursor-default는 "여긴 클릭 대상이 아님"까지만 말하고
                        "지금은 못 바꿈"은 말하지 않아 포인터 사용자만 모르는
                        상태였다(MOMO-642 3). 체크 표시 자체는 흐리지 않는다 —
                        지금 서버로 보내는 중인 선택이 무엇인지가 그 상태다.
                        커서는 wait다(MOMO-676 M-2). not-allowed는 "이건 원래 안
                        되는 것"이라 말하지만 이 잠김은 쓰기가 끝나면 풀린다. 같은
                        파일의 카탈로그 행이 같은 조건(이 뮤테이션 진행 중)에
                        disabled:cursor-wait를 쓰고 있어, 한 조건에 커서가 둘이라는
                        모순이기도 했다. 한 조건, 한 커서. */}
                    <label className={`flex items-start gap-2 ${pending ? "cursor-wait" : "cursor-pointer hover:bg-surface-hover active:bg-surface-pressed"}`}>
                      <input
                        type="checkbox"
                        checked={checked}
                        aria-disabled={pending || undefined}
                        onChange={(event) => {
                          // Keep a focused checkbox mounted and focusable while
                          // the write is in flight. A disabled control would
                          // drop keyboard focus to body in the desktop shell.
                          if (pending) return;
                          setSelectedScopes((current) => event.target.checked
                            ? [...current, scope]
                            : current.filter((item) => item !== scope));
                        }}
                        className="mt-px size-4 shrink-0 rounded-sm border-line-strong accent-accent focus-visible:focus-ring"
                        data-testid={`plugin-scope-${scope}`}
                      />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="text-body font-medium text-ink">{scopeSentence(scope)}</span>
                        <span className="break-all font-mono text-timestamp text-ink-muted">{scope}</span>
                        {/* 결정 문구는 이 클라이언트의 문장이다(MOMO-642 9).
                            여기 있던 줄은 매니페스트의 tools[].description,
                            즉 배포자가 자기 언어로 쓴 자유 문구였고, 출하 시드
                            4종 전부 영문이라 한국어 결정 화면에 영어가 섞였다.
                            제3자 매니페스트가 어떤 언어로 오든 같은 일이 난다.
                            그래서 이 줄은 그 권한이 여는 도구를 **식별**한다:
                            무엇을 허용하는지는 위의 권한 문장과 아래의 위험도·
                            승인 칩이 한국어로 말하고, 도구는 바로 위 스코프 id와
                            같은 방식으로 이름 그대로 선다. 배포자가 쓴 산문은
                            지워지지 않고 증거 표면(앱 상세 > 도구와 권한)에
                            남는다 — 결정 표면과 증거 표면의 구분은 회수
                            다이얼로그에서 배포자·라이선스·출처를 걷어낸 것과
                            같은 선이다(MOMO-642 8). */}
                        {scopeTools.length > 0 && (
                          <span className="text-meta text-ink-muted">
                            연결된 도구:{" "}
                            <span className="break-all font-mono">
                              {scopeTools.map((tool) => tool.name).join(", ")}
                            </span>
                          </span>
                        )}
                        {scopeBadges.length > 0 && (
                          <span
                            className="flex flex-wrap gap-1"
                            data-testid={`plugin-scope-badges-${scope}`}
                          >
                            {scopeBadges.map((badge) => (
                              <StatusChip key={badge.label} tone={badge.tone}>
                                {badge.label}
                              </StatusChip>
                            ))}
                          </span>
                        )}
                      </span>
                    </label>
                  </li>
                );
              })}
            </ul>
          </fieldset>

          <div className="flex flex-col gap-3">
            {/* 악수 글리프는 캡션과 한 몸이다. 4R이 고정 헤더를 제목만 남기면서
                이 장식은 권한 목록과 설명 사이에 라벨 없이 떠 있었고, 회수
                다이얼로그에서도 그려져 연결을 끊는 화면에서 momo→앱 화살표가
                반대말을 했다(MOMO-642 1). 이제 문장 옆에 서서 그 문장이 캡션이
                되고, 방향이 반대인 회수에서는 그리지 않는다. */}
            {isGrant ? (
              <div className="flex items-center gap-3">
                <span className="flex shrink-0 items-center gap-2" aria-hidden="true">
                  <span
                    className="flex h-control shrink-0 items-center justify-center whitespace-nowrap rounded-sm border border-line bg-surface-hover px-2 text-meta font-semibold text-ink"
                    data-testid="plugin-scope-momo-mark"
                  >
                    oort
                  </span>
                  <ArrowRight className="size-4 text-ink-muted" />
                  <span className="flex size-control shrink-0 items-center justify-center rounded-sm border border-line bg-surface-hover text-body font-semibold text-ink">{appIcon}</span>
                </span>
                <DialogDescription className="min-w-0 flex-1">
                  선택한 권한의 도구가 내 사용자 정책에 추가됩니다.
                </DialogDescription>
              </div>
            ) : (
              <DialogDescription>
                선택한 권한으로 사용할 수 있던 도구가 내 사용자 정책에서 제거됩니다.
              </DialogDescription>
            )}
            {isGrant && consent.plugin.installed && consent.plugin.enabled && managerNames.length > 0 && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-meta text-ink-muted">
                  문의할 수 있는 관리자: {managerNames.join(", ")}
                </span>
              </div>
            )}
          </div>

          {error && (
            <div ref={actionErrorRef}>
              <InlineBanner
                message={error.error}
                // 원인이 여럿이면 그것은 목록이다(MOMO-676 M-4). 배너가 ul/li로
                // 그리므로 여기서 넘기는 것은 문장 배열이지 서식이 아니다 —
                // "• "를 붙이거나 \n으로 잇던 자리가 이 prop이다.
                items={error.causes}
                actionLabel="오류 닫기"
                onAction={() => {
                  onDismissError();
                  // The banner was caused by this unchanged confirmation. Its
                  // button remains the retry affordance, so return focus here
                  // after dismissal instead of leaving it in the scrolling body.
                  window.requestAnimationFrame(() => {
                    focusPluginActionAfterErrorDismissal(confirmButtonRef.current);
                  });
                }}
                testId="plugin-scope-consent-error"
              />
            </div>
          )}

          {/* 배포자·라이선스·출처·도메인·약관은 **허용하는 결정의 근거**다
              (MOMO-642 8). 회수는 그 근거를 따지는 자리가 아니다: 누가 만들었고
              어떤 라이선스이며 어디로 나가는지는 연결을 끊겠다는 결정을 하나도
              바꾸지 않고, 결정과 무관한 여섯 줄이 "무엇을 잃는가"를 아래로 민다.
              앱 상세 패널이 이 증거를 언제든 그대로 보여주므로 사라지는 정보는
              없다. */}
          {isGrant && (
            <dl className="flex flex-col gap-2 border-t border-line pt-3">
              {consent.plugin.publisherName && <DetailRow label="배포자" value={consent.plugin.publisherVerified ? `${consent.plugin.publisherName}, oort 레지스트리가 확인함` : consent.plugin.publisherName} />}
              {consent.plugin.license && <DetailRow label="라이선스" value={consent.plugin.license} />}
              {consent.plugin.provenanceURL && <DetailLink label="출처" href={consent.plugin.provenanceURL} />}
              {consent.plugin.egressDomains.length > 0 && <DetailRow label="외부 연결" value={consent.plugin.egressDomains.join(", ")} />}
              {consent.plugin.termsURL && <DetailLink label="이용약관" href={consent.plugin.termsURL} />}
              {consent.plugin.privacyPolicyURL && <DetailLink label="개인정보 처리방침" href={consent.plugin.privacyPolicyURL} />}
            </dl>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line p-4">
          <Button
            variant="outline"
            size="sm"
            aria-disabled={pending || undefined}
            // 한 푸터, 한 폭(MOMO-676 M-3). 결정 버튼이 라벨로 상태를 말하느라
            // 최소 폭을 갖는데 취소만 내용 폭(47px)이면 푸터가 3:1로 기울고,
            // 시스템 다이얼로그의 형태(양쪽 동일 폭)에서도 벗어난다. 강조는
            // 채움이 하지 폭이 하지 않는다.
            className={cn("min-w-action", pending && "opacity-50")}
            data-testid="plugin-scope-cancel"
            onClick={() => { if (!pending) onCancel(); }}
          >
            취소
          </Button>
          <Button
            ref={confirmButtonRef}
            size="sm"
            aria-disabled={!pending && !hasSelection ? true : undefined}
            aria-busy={pending || undefined}
            // 막힌 이유를 말하는 문장은 이 라벨 하나뿐이다(MOMO-642 6이 중복
            // 힌트 <p>와 aria-describedby를 지운 뒤로). 그런데 그것을 흐리게 만든
            // 것이 opacity-50이었다: 채움과 라벨이 함께 50%로 합성돼 요구 문장이
            // 라이트 2.20:1 / 다크 3.21:1까지 내려갔고, 이 PR 이전 같은 요구가
            // 서 있던 text-ink-muted 본문(5.7:1)보다도 못 읽혔다. WCAG는 비활성
            // 컨트롤을 면제하지만, 이 클라이언트가 스스로 지키는 기준 아래로
            // 내려간 유일한 문장이 하필 "왜 못 하는가"인 것은 설계 결함이다
            // (MOMO-642 R1 H-1).
            //
            // 그래서 흐리게 하는 대신 **강조를 거둔다**: 결정이 불가능한 동안
            // 버튼은 주 액션의 채움을 잃고 조용한 액센트 표면에 앉는다. 자리와
            // 색 계열은 그대로여서 여전히 "결정의 자리"로 읽히고, 라벨은 13.17:1
            // (라이트) / 12.45:1(다크)로 올라온다. 두 값은 tokens.contrast가
            // 이미 재고 있는 --ink x --accent-soft 쌍이다 — 합성된 불투명도는
            // 어떤 테스트도 볼 수 없지만 이 쌍은 회귀하면 잡힌다.
            //
            // announce는 늘리지 않는다: 요구는 여전히 라벨에만 있고, 개수는
            // 위의 단 하나뿐인 live region에만 있다.
            //
            // min-w-action pins the footer geometry. This label states the
            // decision state, so it changed width by 24px between "권한을 하나
            // 이상 선택" and "선택한 권한 허용" and dragged 취소 sideways under
            // the pointer on every toggle of the last checkbox (MOMO-642 2).
            // The minimum clears the longest label, so only the text moves.
            //
            // 진행 중은 여전히 풀 컨트라스트다: 스피너와 "변경 중" 라벨이 유일한
            // 진행 신호다.
            className={cn(
              "min-w-action",
              !hasSelection && "bg-accent-soft text-ink hover:opacity-100"
            )}
            data-testid="plugin-scope-confirm"
            onClick={() => {
              if (!canConfirm) return;
              onConfirm(selectedScopes);
            }}
          >
            {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {pending
              ? "변경 중"
              : !hasSelection
                ? "권한을 하나 이상 선택"
                : isGrant ? "선택한 권한 허용" : "선택한 권한 회수"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmPluginAction({ action, pending, opener, onCancel, onConfirm }: {
  action: Extract<PluginAction, { kind: "uninstall" }>;
  pending: boolean;
  /** 이 확인을 연 버튼. activeElement 추정은 WebKit에서 <body>가 되므로 명시한다(4R H-2). */
  opener: HTMLButtonElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = pluginActionConfirmation(action);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent
        opener={opener}
        // Escape is owned by this confirmation. Letting it reach SettingsRoute
        // would close the route while this dialog (or its pending write) remains.
        onEscapeKeyDown={(event) => event.stopPropagation()}
        // 제목과 설명이 한국어 산문이다(MOMO-676 M-5).
        className="break-keep"
      >
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
          {/* 같은 규칙이지만 같은 숫자는 아니다(MOMO-676 M-3). 규칙은 "한 푸터의
              두 버튼은 같은 폭, 그 폭은 그 푸터가 보일 수 있는 가장 긴 라벨이
              정한다"이고, 144px는 동의 다이얼로그의 "권한을 하나 이상 선택"
              (실측 127px)에서 나온 값이다. 이 푸터의 실측은 취소 47px · 설치
              해제 69px · 스피너를 단 "변경 중" 82px이라 라벨 스왑이 13px밖에
              안 움직이는데, 144px를 빌려오면 47px 옆에 144px가 서서 3:1이 된다.
              여기 가장 긴 상태를 14px 여유로 담는 96px를 양쪽이 함께 쓴다. */}
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" className="min-w-action-sm" disabled={pending} onClick={onCancel}>취소</Button>
            <Button
              variant="destructive"
              size="sm"
              aria-busy={pending || undefined}
              className="min-w-action-sm"
              onClick={() => { if (!pending) onConfirm(); }}
            >
              {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {pending ? "변경 중" : copy.confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
