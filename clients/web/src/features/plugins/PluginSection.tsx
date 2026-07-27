import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
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
} from "@/lib/api";
import { SectionShell, StatusChip } from "@/features/settings/SettingsFields";
import {
  actionErrorForPlugin,
  administratorNames,
  approvalLabel,
  callerPolicySummary,
  isWorkspaceAdmin,
  nonAdminInstallGuidance,
  pluginActionConfirmation,
  pluginDetailErrorMessage,
  pluginRoleState,
  riskLabel,
  scopeSentence,
  workspaceInstallationLabel,
  type PluginAction,
  type PluginRoleState,
} from "./model";

type Filter = "all" | "installed" | "permitted";
const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "모든 앱" },
  { id: "installed", label: "설치됨" },
  { id: "permitted", label: "내 권한" },
];

function declaredScopes(detail: PluginDetail): string[] {
  return [...new Set(detail.tools.flatMap((tool) => tool.scopes))];
}

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
  const [confirming, setConfirming] = useState<Extract<PluginAction, {
    kind: "uninstall" | "revokeGrant";
  }> | null>(null);
  const [focusDetailFor, setFocusDetailFor] = useState<string | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

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

  const mutation = useMutation({
    mutationFn: async (action: PluginAction) => {
      if (action.kind === "install") return installPlugin(workspaceId, action.pluginId);
      if (action.kind === "uninstall") return revokePluginInstall(workspaceId, action.pluginId);
      if (action.kind === "grant") return grantPluginScope(workspaceId, action.pluginId, action.scope);
      return revokePluginScope(workspaceId, action.pluginId, action.scope);
    },
    onSuccess: async () => {
      setConfirming(null);
      await client.invalidateQueries({ queryKey: ["plugins", workspaceId.toLowerCase()] });
    },
    // A failed destructive action must return to the inline banner in the
    // panel. Keeping its confirmation dialog open would hide the error behind
    // the scrim and leave no next action in the context that failed.
    onError: () => setConfirming(null),
  });

  useEffect(() => {
    if (focusDetailFor !== selectedId || !detailRef.current || detailsQuery.isPending) return;
    if (window.matchMedia("(width < 1024px)").matches) {
      detailRef.current.scrollIntoView({ block: "start" });
      detailRef.current.focus({ preventScroll: true });
    }
    setFocusDetailFor(null);
  }, [detailsQuery.isPending, focusDetailFor, selectedId]);

  const lines = [
    "워크스페이스에 설치할 앱과 내 사용 권한을 관리합니다.",
    "앱이 연결할 외부 도메인과 현재 내게 허용된 도구 정책을 함께 확인할 수 있습니다.",
  ];

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
          <ul className="flex flex-col overflow-hidden rounded-md border border-line" data-testid="plugin-list">
            {visible.map((plugin) => {
              const policy = catalogQuery.data?.toolsByPlugin.get(plugin.pluginId);
              const active = plugin.pluginId === selectedId;
              return (
                <li key={plugin.pluginId} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    disabled={mutation.isPending}
                    onClick={() => {
                      setSelectedId(plugin.pluginId);
                      setFocusDetailFor(plugin.pluginId);
                    }}
                    aria-current={active ? "true" : undefined}
                    className={active
                      ? "plugin-marketplace-row flex w-full flex-col gap-2 bg-accent-soft p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      : "plugin-marketplace-row flex w-full flex-col gap-2 p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-wait"}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="flex size-control shrink-0 items-center justify-center rounded-sm border border-line bg-surface-raised text-body font-semibold text-ink" aria-hidden="true">
                        {plugin.iconText?.trim() || plugin.name.trim().charAt(0).toLocaleUpperCase()}
                      </span>
                      <span className="text-body font-semibold text-ink">{plugin.name}</span>
                      {plugin.official && <StatusChip tone="accent">공식</StatusChip>}
                      <StatusChip tone={plugin.enabled ? "ok" : "muted"}>{workspaceInstallationLabel(plugin)}</StatusChip>
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
              className="focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
                hasMyAccess={(catalogQuery.data.toolsByPlugin.get(selected.pluginId)?.length ?? 0) > 0}
                busy={mutation.isPending}
                actionError={mutation.isError
                  ? actionErrorForPlugin(mutation.variables, selected.pluginId, mutation.error)
                  : null}
                onDismissActionError={() => mutation.reset()}
                onAction={(action) => {
                  if (action.kind === "uninstall" || action.kind === "revokeGrant") setConfirming(action);
                  else mutation.mutate(action);
                }}
              />
            </div>
          )}
        </div>
      )}

      <ConfirmPluginAction
        action={confirming}
        pending={mutation.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && mutation.mutate(confirming)}
      />
    </SectionShell>
  );
}

function PluginDetailPanel({
  plugin, detail, isPending, isError, error, onRetry, canManage, roleState,
  managerNames, onRetryDirectory, offline, hasMyAccess, busy, actionError,
  onDismissActionError, onAction,
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
  hasMyAccess: boolean;
  busy: boolean;
  actionError: string | null;
  onDismissActionError: () => void;
  onAction: (action: PluginAction) => void;
}) {
  if (isPending) return <SkeletonRows rows={3} />;
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

  const scopes = declaredScopes(detail);
  const singleScope = scopes.length === 1 ? scopes[0] : null;
  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-md border border-line bg-surface-raised p-4" aria-label={`${plugin.name} 상세`} data-testid="plugin-detail">
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
            singleScope={singleScope}
            scopeCount={scopes.length}
            hasMyAccess={hasMyAccess}
            canManage={canManage}
            roleState={roleState}
            managerNames={managerNames}
            onRetryDirectory={onRetryDirectory}
            offline={offline}
            busy={busy}
            onAction={onAction}
          />
          {actionError && (
            <InlineBanner
              message={actionError}
              actionLabel="오류 닫기"
              onAction={onDismissActionError}
              testId="plugin-action-error"
            />
          )}
        </div>
      </div>

      <dl className="flex flex-col gap-2">
        {detail.publisherName && <DetailRow label="배포자" value={detail.publisherVerified ? `${detail.publisherName}, momo 레지스트리가 확인함` : detail.publisherName} />}
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
  plugin, singleScope, scopeCount, hasMyAccess, canManage, roleState, managerNames,
  onRetryDirectory, offline, busy, onAction,
}: {
  plugin: PluginCatalogItem;
  singleScope: string | null;
  scopeCount: number;
  hasMyAccess: boolean;
  canManage: boolean;
  roleState: PluginRoleState;
  managerNames: string[];
  onRetryDirectory: () => void;
  offline: boolean;
  busy: boolean;
  onAction: (action: PluginAction) => void;
}) {
  if (busy) return <p className="text-meta text-ink-muted" role="status">변경 중</p>;
  if (!plugin.installed || !plugin.enabled) {
    if (roleState === "checking") return <p className="text-meta text-ink-muted" role="status">관리자 권한을 확인하는 중입니다.</p>;
    if (roleState === "unknown") {
      return (
        <InlineBanner
          message="내 역할을 확인하지 못했습니다. 설치 권한을 판단할 수 없습니다."
          actionLabel="역할 다시 확인"
          onAction={onRetryDirectory}
          testId="plugin-role-error"
        />
      );
    }
    if (!canManage) return <p className="max-w-pane text-meta text-ink-muted">{nonAdminInstallGuidance(managerNames)}</p>;
    return <Button size="sm" disabled={offline} onClick={() => onAction({
      kind: "install", pluginId: plugin.pluginId, pluginName: plugin.name,
    })}>
      {plugin.installed ? "다시 활성화" : "워크스페이스에 설치"}
    </Button>;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {singleScope ? (
        <Button
          variant="outline"
          size="sm"
          disabled={offline}
          onClick={() => onAction(hasMyAccess
            ? { kind: "revokeGrant", pluginId: plugin.pluginId, pluginName: plugin.name, scope: singleScope }
            : { kind: "grant", pluginId: plugin.pluginId, pluginName: plugin.name, scope: singleScope })}
        >
          {hasMyAccess ? "내 권한 회수" : "내 사용 허용"}
        </Button>
      ) : (
        <p className="max-w-pane text-meta text-ink-muted">
          {scopeCount > 1
            ? "여러 권한은 플러그인 연결 동의 화면이 추가된 뒤에 선택합니다. 현재 이 화면에서는 변경할 수 없습니다."
            : "허용할 권한이 없습니다."}
        </p>
      )}
      {canManage && <Button variant="destructive" size="sm" disabled={offline} onClick={() => onAction({
        kind: "uninstall", pluginId: plugin.pluginId, pluginName: plugin.name,
      })}>
        설치 해제
      </Button>}
    </div>
  );
}

function ToolRow({ tool }: { tool: PluginManifestTool }) {
  const tiers = [approvalLabel(tool.approvalTier), tool.risk ? `위험도 ${riskLabel(tool.risk)}` : null]
    .filter((value): value is string => value !== null);
  return (
    <li className="flex flex-col gap-1 border-b border-line p-3 last:border-b-0">
      <span className="text-body font-medium text-ink">{tool.name}</span>
      {tool.description && <span className="text-meta text-ink-muted">{tool.description}</span>}
      <span className="text-meta text-ink-muted">
        {tool.scopes.map(scopeSentence).join(", ")}{tiers.length > 0 ? `, ${tiers.join(", ")}` : ""}
      </span>
    </li>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return <div className="flex min-w-0 flex-col gap-px"><dt className="text-meta text-ink-muted">{label}</dt><dd className="break-all text-body text-ink">{value}</dd></div>;
}

function DetailLink({ label, href }: { label: string; href: string }) {
  return <div className="flex min-w-0 flex-col gap-px"><dt className="text-meta text-ink-muted">{label}</dt><dd><a className="break-all text-body text-ink underline decoration-line-strong underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent" href={href} rel="noreferrer" target="_blank">{href}</a></dd></div>;
}

function ConfirmPluginAction({ action, pending, onCancel, onConfirm }: {
  action: Extract<PluginAction, { kind: "uninstall" | "revokeGrant" }> | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const copy = action ? pluginActionConfirmation(action) : null;
  return (
    <Dialog open={action !== null} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent>
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>{copy?.title}</DialogTitle>
          <DialogDescription>{copy?.description}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>취소</Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>
              {pending ? "변경 중" : copy?.confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
