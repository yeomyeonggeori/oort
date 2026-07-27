import { useEffect, useMemo, useState } from "react";
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
  type PluginPolicyTool,
} from "@/lib/api";
import { errorMessage } from "@/features/settings/model";
import { SectionShell, StatusChip } from "@/features/settings/SettingsFields";

type Filter = "all" | "installed" | "permitted";
type PendingAction =
  | { kind: "install" }
  | { kind: "uninstall" }
  | { kind: "grant"; scope: string }
  | { kind: "revokeGrant"; scope: string };

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "모든 앱" },
  { id: "installed", label: "설치됨" },
  { id: "permitted", label: "내 권한" },
];

function isWorkspaceAdmin(role: string | undefined): boolean {
  return role === "owner" || role === "admin";
}

function riskLabel(risk: string): string {
  if (risk === "read") return "읽기";
  if (risk === "write") return "쓰기";
  if (risk === "admin") return "관리자";
  return "정보 없음";
}

function approvalLabel(tier: string | undefined): string | null {
  if (tier === "read_only") return "읽기 전용";
  if (tier === "workspace_write") return "워크스페이스 쓰기";
  if (tier === "network_write") return "네트워크 쓰기";
  return null;
}

/** Swift marketplace's `github:read` → `github 읽기 권한` rule, unchanged. */
function scopeSentence(scope: string): string {
  const [resource, action] = scope.split(":", 2);
  if (!resource || !action) return "사용 권한 1개";
  const name = resource.replaceAll("_", " ");
  if (action === "read") return `${name} 읽기 권한`;
  if (action === "write") return `${name} 쓰기 권한`;
  return `${name} 사용 권한`;
}

function declaredScopes(detail: PluginDetail): string[] {
  return [...new Set(detail.tools.flatMap((tool) => tool.scopes))];
}

function riskSummary(tools: PluginPolicyTool[] | undefined): string {
  if (!tools?.length) return "내 권한 없음";
  const risks = [...new Set(tools.map((tool) => riskLabel(tool.risk)))];
  return `위험도 ${risks.join(", ")}`;
}

function installationLabel(plugin: PluginCatalogItem): string {
  if (!plugin.installed) return "설치 안 됨";
  return plugin.enabled ? "사용 가능" : "비활성";
}

export function PluginSection({ offline }: { offline: boolean }) {
  const { workspaceId, session } = useSession();
  const client = useQueryClient();
  const directoryQuery = useDirectory(workspaceId);
  const me = memberFor(directoryQuery.directory, session.member.id);
  const canManage = isWorkspaceAdmin(me?.role);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<PendingAction | null>(null);

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
    mutationFn: async (action: PendingAction) => {
      if (!selectedId) throw new Error("플러그인을 먼저 선택하세요.");
      if (action.kind === "install") return installPlugin(workspaceId, selectedId);
      if (action.kind === "uninstall") return revokePluginInstall(workspaceId, selectedId);
      if (action.kind === "grant") return grantPluginScope(workspaceId, selectedId, action.scope);
      return revokePluginScope(workspaceId, selectedId, action.scope);
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

  const lines = [
    "워크스페이스에 설치할 앱과 내 사용 권한을 관리합니다.",
    "앱이 연결할 외부 도메인과 현재 내게 허용된 도구 정책을 함께 확인할 수 있습니다.",
  ];

  return (
    <SectionShell title="앱" lines={lines}>
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 이미 읽은 앱은 계속 볼 수 있지만 변경은 다시 연결된 뒤에 할 수 있습니다."
          testId="plugins-offline"
        />
      )}

      <div className="flex flex-wrap items-end gap-3">
        <label className="flex min-w-0 flex-1 flex-col gap-1" htmlFor="plugin-search">
          <span className="text-meta text-ink-muted">앱 검색</span>
          <Input
            id="plugin-search"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="이름 또는 용도 검색"
          />
        </label>
        <label className="flex w-full max-w-pane flex-col gap-1" htmlFor="plugin-filter">
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

      {catalogQuery.isPending && <SkeletonRows rows={4} />}
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
          actions={
            <Button variant="outline" size="sm" onClick={() => { setQuery(""); setFilter("all"); }}>
              필터 지우기
            </Button>
          }
          testId="plugins-empty"
        />
      )}
      {catalogQuery.data && visible.length > 0 && (
        <div className="flex min-w-0 flex-col gap-4">
          <ul className="flex flex-col overflow-hidden rounded-md border border-line" data-testid="plugin-list">
            {visible.map((plugin) => {
              const policy = catalogQuery.data?.toolsByPlugin.get(plugin.pluginId);
              const active = plugin.pluginId === selectedId;
              return (
                <li key={plugin.pluginId} className="border-b border-line last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setSelectedId(plugin.pluginId)}
                    aria-current={active ? "true" : undefined}
                    className={active
                      ? "flex w-full flex-col gap-2 bg-accent-soft p-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                      : "flex w-full flex-col gap-2 p-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="flex size-control shrink-0 items-center justify-center rounded-sm border border-line bg-surface-raised text-body font-semibold text-ink" aria-hidden="true">
                        {plugin.iconText?.trim() || plugin.name.trim().charAt(0).toLocaleUpperCase()}
                      </span>
                      <span className="text-body font-semibold text-ink">{plugin.name}</span>
                      {plugin.official && <StatusChip tone="accent">공식</StatusChip>}
                      <StatusChip tone={plugin.enabled ? "ok" : "muted"}>{installationLabel(plugin)}</StatusChip>
                    </span>
                    <span className="text-body text-ink-muted">{plugin.description}</span>
                    <span className="flex flex-wrap gap-2 text-meta text-ink-muted">
                      <span>{riskSummary(policy)}</span>
                      {plugin.egressDomains.length > 0 && <span>외부 연결: {plugin.egressDomains.join(", ")}</span>}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>

          {selected && (
            <PluginDetailPanel
              plugin={selected}
              detail={detailsQuery.data}
              isPending={detailsQuery.isPending}
              isError={detailsQuery.isError}
              error={detailsQuery.error}
              onRetry={() => void detailsQuery.refetch()}
              canManage={canManage}
              roleKnown={!directoryQuery.isPending}
              offline={offline}
              hasMyAccess={(catalogQuery.data.toolsByPlugin.get(selected.pluginId)?.length ?? 0) > 0}
              busy={mutation.isPending}
              onAction={(action) => {
                if (action.kind === "uninstall" || action.kind === "revokeGrant") setConfirming(action);
                else mutation.mutate(action);
              }}
            />
          )}
        </div>
      )}

      <ConfirmPluginAction
        action={confirming}
        pending={mutation.isPending}
        onCancel={() => setConfirming(null)}
        onConfirm={() => confirming && mutation.mutate(confirming)}
      />
      {mutation.isError && (
        <InlineBanner
          message={errorMessage(mutation.error)}
          actionLabel="오류 닫기"
          onAction={() => mutation.reset()}
          testId="plugin-action-error"
        />
      )}
    </SectionShell>
  );
}

function PluginDetailPanel({
  plugin, detail, isPending, isError, error, onRetry, canManage, roleKnown,
  offline, hasMyAccess, busy, onAction,
}: {
  plugin: PluginCatalogItem;
  detail: PluginDetail | undefined;
  isPending: boolean;
  isError: boolean;
  error: unknown;
  onRetry: () => void;
  canManage: boolean;
  roleKnown: boolean;
  offline: boolean;
  hasMyAccess: boolean;
  busy: boolean;
  onAction: (action: PendingAction) => void;
}) {
  if (isPending) return <SkeletonRows rows={3} />;
  if (isError || !detail) {
    return (
      <InlineBanner
        message={isError ? errorMessage(error) : "앱 상세 정보를 읽지 못했습니다."}
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
          <h3 className="text-body font-semibold text-ink">{detail.name}</h3>
          <p className="text-meta text-ink-muted">버전 {detail.version}</p>
        </div>
        <PluginActions
          plugin={plugin}
          singleScope={singleScope}
          scopeCount={scopes.length}
          hasMyAccess={hasMyAccess}
          canManage={canManage}
          roleKnown={roleKnown}
          offline={offline}
          busy={busy}
          onAction={onAction}
        />
      </div>

      <dl className="flex flex-col gap-2">
        {detail.publisherName && <DetailRow label="배포자" value={detail.publisherVerified ? `${detail.publisherName}, 확인됨` : detail.publisherName} />}
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

function PluginActions({
  plugin, singleScope, scopeCount, hasMyAccess, canManage, roleKnown, offline, busy, onAction,
}: {
  plugin: PluginCatalogItem;
  singleScope: string | null;
  scopeCount: number;
  hasMyAccess: boolean;
  canManage: boolean;
  roleKnown: boolean;
  offline: boolean;
  busy: boolean;
  onAction: (action: PendingAction) => void;
}) {
  if (busy) return <p className="text-meta text-ink-muted" role="status">변경 중</p>;
  if (!plugin.installed || !plugin.enabled) {
    if (!roleKnown) return <p className="text-meta text-ink-muted">관리자 권한을 확인하는 중입니다.</p>;
    if (!canManage) return <p className="text-meta text-ink-muted">관리자 설치 필요</p>;
    return <Button size="sm" disabled={offline} onClick={() => onAction({ kind: "install" })}>
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
            ? { kind: "revokeGrant", scope: singleScope }
            : { kind: "grant", scope: singleScope })}
        >
          {hasMyAccess ? "내 권한 회수" : "내 사용 허용"}
        </Button>
      ) : (
        <p className="text-meta text-ink-muted">
          {scopeCount > 1 ? "여러 권한은 이 화면에서 변경할 수 없습니다." : "허용할 권한이 없습니다."}
        </p>
      )}
      {canManage && <Button variant="destructive" size="sm" disabled={offline} onClick={() => onAction({ kind: "uninstall" })}>
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
  action: PendingAction | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const destructive = action?.kind === "uninstall" || action?.kind === "revokeGrant";
  const title = action?.kind === "uninstall" ? "앱 설치를 해제할까요?" : "내 권한을 회수할까요?";
  const description = action?.kind === "uninstall"
    ? "이 앱과 관련된 모든 멤버 권한이 함께 회수됩니다."
    : "이 권한으로 사용할 수 있던 도구가 즉시 사라집니다.";
  return (
    <Dialog open={destructive} onOpenChange={(open) => { if (!open && !pending) onCancel(); }}>
      <DialogContent>
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
          <div className="flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={pending} onClick={onCancel}>취소</Button>
            <Button variant="destructive" size="sm" disabled={pending} onClick={onConfirm}>
              {pending ? "변경 중" : "회수하기"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
