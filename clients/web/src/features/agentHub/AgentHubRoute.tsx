import {
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bot, Loader2, Search } from "lucide-react";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import {
  useAgentWorkingSignals,
  useTickingNow,
} from "@/features/agents/agentWorkingSignal";
import { AgentTurnBadge } from "@/features/agents/AgentTurnBadge";
import {
  memberFor,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import {
  useAgentEditingCapability,
  useAllowedAgentModels,
  useRoutingCapability,
} from "@/features/routing/capability";
import { RoutingFields } from "@/features/routing/RoutingFields";
import {
  INHERIT_DRAFT,
  agentEffortInheritLabel,
  agentModelInheritLabel,
  draftEquals,
  draftFromProfile,
  effectiveModel,
  effortsForModel,
  knownAgentModels,
  modelOptions,
  type RoutingDraft,
} from "@/features/routing/routingModel";
import {
  isAgentProfileMissing,
  useAgentProfile,
} from "@/features/routing/useAgentProfile";
import {
  fetchAgentProfile,
  fetchAgentRunDetail,
  fetchAgentRunSummaries,
  invalidateMemory,
  listAgentMemories,
  listMemoryVisibilityGrants,
  putAgentPause,
  searchAgentMemories,
  uuidEq,
  type AgentProfile,
  type AgentRun,
  type AgentRunSummary,
  type MemoryItem,
  type RosterMember,
} from "@/lib/api";
import {
  agentMembers,
  canInvalidateMemory,
  effectiveEffortLabel,
  effectiveModelLabel,
  lifecycleLabel,
  memoryKindLabel,
  memoryScopeLabel,
  mergeRunPages,
  normalizedId,
  runStatusLabel,
  signalsForAgent,
  type AgentHubSection,
} from "./model";
import { AgentChannelsSection } from "./AgentChannelsSection";
import {
  EMPTY_AGENT_DRAFT,
  canCreateAgentNow,
  type AgentDraft,
} from "./createModel";
import { CreateAgentDialog } from "./CreateAgentDialog";
import {
  isSurfaceProvided,
  type SurfaceId,
} from "@/features/capabilities/serverSurfaces";

/**
 * 허브의 탭 셋과 각 탭이 서 있는 서버 표면 (goal B12).
 *
 * 프로필은 표면을 적지 않는다: 그 탭의 읽기/쓰기는 이 서버에 있고, 편집 가능
 * 여부는 이미 자기 프로브가 판정한다(features/routing/capability.ts ④).
 * 메모리와 이력은 이 서버에 경로가 없어서 열면 언제나 오류였다.
 */
const SECTIONS: { id: AgentHubSection; label: string; surface?: SurfaceId }[] = [
  { id: "profile", label: "프로필" },
  { id: "memory", label: "메모리", surface: "agentMemory" },
  { id: "history", label: "이력", surface: "agentRunHistory" },
];

/** 이 서버에서 실제로 답이 오는 탭만. */
const VISIBLE_SECTIONS = SECTIONS.filter(
  (item) => item.surface === undefined || isSurfaceProvided(item.surface)
);

const DATE_TIME = new Intl.DateTimeFormat("ko-KR", {
  dateStyle: "medium",
  timeStyle: "short",
});

function profileKey(workspaceId: string, agentMemberId: string) {
  return [
    "agent-profile",
    normalizedId(workspaceId),
    normalizedId(agentMemberId),
  ] as const;
}

function StatusChip({
  children,
  tone = "neutral",
  testId,
}: {
  children: React.ReactNode;
  tone?: "neutral" | "agent" | "warn";
  testId?: string;
}) {
  return (
    <span
      className={cn(
        "rounded-sm px-1 text-timestamp",
        tone === "neutral" && "border border-line text-ink-muted",
        tone === "agent" && "bg-agent-soft text-agent",
        tone === "warn" && "border border-warn text-warn"
      )}
      data-testid={testId}
    >
      {children}
    </span>
  );
}

function AgentHubLoading({
  message,
  rows,
  className,
}: {
  message: string;
  rows: number;
  className?: string;
}) {
  return (
    <div role="status">
      <span className="sr-only">{message}</span>
      <SkeletonRows rows={rows} className={className} />
    </div>
  );
}

function AgentListRow({
  agent,
  profile,
  profilePending,
  profileFailed,
  selected,
  signals,
  live,
  onSelect,
}: {
  agent: RosterMember;
  profile: AgentProfile | null;
  profilePending: boolean;
  profileFailed: boolean;
  selected: boolean;
  signals: ReturnType<typeof signalsForAgent>;
  live: boolean;
  onSelect: () => void;
}) {
  const current = signals[0];
  const lifecycle = lifecycleLabel(agent, profile, profilePending, profileFailed);
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
          selected ? "bg-accent-soft" : "hover:bg-surface-hover"
        )}
        data-testid="agent-hub-agent-row"
        data-agent-id={normalizedId(agent.id)}
      >
        <span
          className="flex size-control shrink-0 items-center justify-center rounded-sm bg-agent-soft text-agent"
          aria-hidden="true"
        >
          <Bot className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
              {agent.displayName}
            </span>
            <StatusChip>{lifecycle}</StatusChip>
          </span>
          <span className="truncate text-meta text-ink-muted">@{agent.handle}</span>
          {current && (
            <span className="flex items-center gap-1">
              <AgentTurnBadge
                state={current.state}
                text={current.state === "working" ? "작업 중" : "승인 대기"}
                label={
                  current.state === "working"
                    ? `${agent.displayName} 에이전트가 작업 중입니다.`
                    : `${agent.displayName} 에이전트가 승인을 기다립니다.`
                }
                live={live}
                testId="agent-hub-current-work"
              />
              {signals.length > 1 && (
                <span className="text-timestamp text-ink-muted" data-numeric>
                  {signals.length}개 채널
                </span>
              )}
            </span>
          )}
        </span>
      </button>
    </li>
  );
}

export function AgentHubRoute() {
  const { workspaceId, connStatus, session } = useSession();
  const offline = useOffline();
  const railLive = connStatus === "connected";
  const directoryQuery = useDirectory(workspaceId);
  const agents = useMemo(
    () => agentMembers(directoryQuery.directory.members),
    [directoryQuery.directory.members]
  );
  const profiles = useQueries({
    queries: agents.map((agent) => ({
      queryKey: profileKey(workspaceId, agent.id),
      queryFn: () => fetchAgentProfile(workspaceId, agent.id),
      staleTime: 30_000,
      retry: false,
    })),
  });
  const profileByAgent = useMemo(
    () =>
      new Map(
        agents.map((agent, index) => [
          normalizedId(agent.id),
          {
            data: profiles[index]?.data ?? null,
            pending: profiles[index]?.isPending ?? true,
            failed:
              (profiles[index]?.isError ?? false) &&
              !isAgentProfileMissing(profiles[index]?.error),
          },
        ])
      ),
    [agents, profiles]
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [section, setSection] = useState<AgentHubSection>("profile");
  const [creating, setCreating] = useState(false);
  const [agentDraft, setAgentDraft] = useState<AgentDraft>(EMPTY_AGENT_DRAFT);
  const allSignals = useAgentWorkingSignals();
  // 만들 수 없는 사람에게 [만들기]를 내주지 않는다: `routes::agents::create`는
  // human + owner/admin을 요구하므로 그 밖의 모든 시도는 403으로 끝난다. 명부가
  // 아직 오지 않은 동안에는 아무 말도 하지 않는다 — 한 프레임 보여 줬다 거두는
  // 제안이 한 박자 늦게 도착하는 제안보다 나쁘다(MOMO-614 R2 M5).
  const rosterSettled = !directoryQuery.isPending;
  const mayCreate = canCreateAgentNow(
    rosterSettled,
    session.member.kind,
    memberFor(directoryQuery.directory, session.member.id)?.role
  );
  // This clock expires remembered signals even while the rail is down. Color
  // certainty is handled separately by AgentTurnBadge's `live` input.
  const nowMs = useTickingNow(allSignals.size > 0);

  useEffect(() => {
    setSelectedId((current) => {
      if (
        current !== null &&
        agents.some((agent) => uuidEq(agent.id, current))
      ) {
        return current;
      }
      return agents[0] ? normalizedId(agents[0].id) : null;
    });
  }, [agents]);

  const selected =
    agents.find((agent) => uuidEq(agent.id, selectedId ?? undefined)) ?? null;

  return (
    <div
      className="flex min-w-0 flex-1 flex-col"
      data-testid="agent-hub-route"
    >
      <header className="border-b border-line px-4 py-2">
        <div className="flex w-full max-w-pane-lg flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex min-w-0 items-center gap-2">
              <SidebarDrawerToggle />
              <h1 className="text-body font-semibold text-ink">에이전트</h1>
            </div>
            <p className="text-meta text-ink-muted">
              워크스페이스 에이전트를 만들고, 상태와 기억, 작업 이력을 한 곳에서
              봅니다.
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-3">
            {!directoryQuery.isPending && !directoryQuery.isError && (
              <span className="text-meta text-ink-muted" data-numeric>
                {agents.length}명
              </span>
            )}
            {mayCreate && (
              <Button
                type="button"
                size="sm"
                onClick={() => setCreating(true)}
                data-testid="agent-hub-create"
              >
                에이전트 만들기
              </Button>
            )}
          </div>
        </div>
      </header>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 마지막으로 받은 내용은 계속 볼 수 있고, 변경은 다시 연결된 뒤에 할 수 있습니다."
          testId="agent-hub-offline"
        />
      )}

      <div className="agent-hub-layout">
        <aside className="agent-hub-roster">
          {directoryQuery.isPending && agents.length === 0 ? (
            <AgentHubLoading
              message="에이전트 명부를 불러오는 중입니다."
              rows={5}
              className="p-4"
            />
          ) : directoryQuery.isError && agents.length === 0 ? (
            <InlineBanner
              message="에이전트 명부를 불러오지 못했습니다."
              actionLabel="다시 시도"
              onAction={() => void directoryQuery.refetch()}
              testId="agent-hub-roster-error"
            />
          ) : agents.length === 0 ? (
            <EmptyInvite
              headline="이 워크스페이스에는 에이전트가 없습니다."
              detail={
                mayCreate
                  ? "에이전트를 만들고 채널에 넣으면 그 채널에서 멘션할 수 있습니다."
                  : "에이전트는 워크스페이스 오너나 관리자가 만들 수 있습니다."
              }
              actions={
                mayCreate ? (
                  <Button size="sm" onClick={() => setCreating(true)}>
                    에이전트 만들기
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void directoryQuery.refetch()}
                  >
                    명부 다시 불러오기
                  </Button>
                )
              }
              testId="agent-hub-empty"
            />
          ) : (
            <ul>
              {agents.map((agent) => {
                const state = profileByAgent.get(normalizedId(agent.id));
                return (
                  <AgentListRow
                    key={normalizedId(agent.id)}
                    agent={agent}
                    profile={state?.data ?? null}
                    profilePending={state?.pending ?? true}
                    profileFailed={state?.failed ?? false}
                    selected={uuidEq(agent.id, selectedId ?? undefined)}
                    signals={signalsForAgent(allSignals, agent.id, nowMs)}
                    live={railLive}
                    onSelect={() => setSelectedId(normalizedId(agent.id))}
                  />
                );
              })}
            </ul>
          )}
        </aside>

        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {selected && (
            <>
              <div className="border-b border-line px-4 py-2">
                <div className="flex w-full max-w-pane-lg items-center justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <h2 className="truncate text-title font-semibold text-ink">
                      {selected.displayName}
                    </h2>
                    <p className="truncate text-meta text-ink-muted">
                      @{selected.handle}
                    </p>
                  </div>
                  <nav
                    className="shrink-0"
                    aria-label={`${selected.displayName} 상세`}
                  >
                    <ul className="flex gap-1 whitespace-nowrap">
                      {VISIBLE_SECTIONS.map((item) => (
                        <li key={item.id} className="shrink-0">
                          <button
                            type="button"
                            onClick={() => setSection(item.id)}
                            aria-current={section === item.id ? "page" : undefined}
                            className={cn(
                              "rounded-sm px-3 py-1 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                              section === item.id
                                ? "bg-accent-soft text-ink"
                                : "text-ink-muted hover:bg-surface-hover"
                            )}
                            data-testid={`agent-hub-tab-${item.id}`}
                          >
                            {item.label}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </nav>
                </div>
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto">
                {section === "profile" && (
                  <AgentProfileSection
                    key={normalizedId(selected.id)}
                    agent={selected}
                    directory={directoryQuery.directory}
                    offline={offline}
                    signals={signalsForAgent(allSignals, selected.id, nowMs)}
                    live={railLive}
                  />
                )}
                {section === "memory" && (
                  <AgentMemorySection
                    key={normalizedId(selected.id)}
                    agent={selected}
                    directory={directoryQuery.directory}
                    offline={offline}
                    onOpenProfile={() => setSection("profile")}
                  />
                )}
                {section === "history" && (
                  <AgentHistorySection
                    key={normalizedId(selected.id)}
                    agent={selected}
                    onOpenProfile={() => setSection("profile")}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <CreateAgentDialog
        open={creating}
        onOpenChange={setCreating}
        draft={agentDraft}
        setDraft={setAgentDraft}
        // 만든 뒤 그 에이전트를 연다. 방금 만든 것이 화면에 없으면 만든 것이
        // 아니고, 다음 행동(채널에 넣기)이 바로 그 판에 있다.
        onCreated={(created) => {
          setSelectedId(normalizedId(created.id));
          setSection("profile");
        }}
      />
    </div>
  );
}

function AgentProfileSection({
  agent,
  directory,
  offline,
  signals,
  live,
}: {
  agent: RosterMember;
  directory: Directory;
  offline: boolean;
  signals: ReturnType<typeof signalsForAgent>;
  live: boolean;
}) {
  const { workspaceId } = useSession();
  const client = useQueryClient();
  const handle = useAgentProfile(agent.id);
  const routingCapability = useRoutingCapability();
  const allowedModels = useAllowedAgentModels(agent.id);
  const savedDraft = handle.profile
    ? draftFromProfile(handle.profile)
    : handle.missing
      ? INHERIT_DRAFT
      : null;
  const [draft, setDraft] = useState<RoutingDraft | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const currentDraft = draft ?? savedDraft;
  const currentInstructions =
    instructions ?? handle.profile?.instructions ?? (handle.missing ? "" : null);
  const instructionBytes =
    currentInstructions === null
      ? 0
      : new TextEncoder().encode(currentInstructions).length;
  const dirty =
    currentDraft !== null &&
    savedDraft !== null &&
    currentInstructions !== null &&
    (!draftEquals(currentDraft, savedDraft) ||
      currentInstructions !== (handle.profile?.instructions ?? ""));

  const pauseMutation = useMutation({
    mutationFn: (paused: boolean) =>
      putAgentPause(workspaceId, agent.id, paused),
    onSuccess: (profile) => {
      client.setQueryData(profileKey(workspaceId, agent.id), profile);
    },
  });

  const table = routingCapability.table;
  const inheritedModel = agent.agentModel ?? "";
  const models = modelOptions(
    table,
    inheritedModel,
    knownAgentModels(directory.members),
    allowedModels
  );
  const modelForEfforts =
    currentDraft === null
      ? inheritedModel
      : effectiveModel(currentDraft, inheritedModel);
  const effortReady =
    routingCapability.support === "ready" && routingCapability.table !== null;
  // 이 서버가 프로필 쓰기와 일시정지를 실제로 받는가(capability.ts ④). 확정된
  // ready가 아니면 쓰기 컨트롤은 잠긴다: 읽을 수 있다는 사실이 저장할 수 있다는
  // 뜻은 아니고, 여기가 그 둘이 갈라지는 유일한 화면이다.
  const editing = useAgentEditingCapability(agent.id);
  const editable = editing.support === "ready";
  const editDisabledReason = offline
    ? "연결이 끊긴 동안에는 바꿀 수 없습니다."
    : editing.support === "checking"
      ? "이 서버가 프로필 편집을 받는지 확인 중입니다."
      : (editing.reason ?? null);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (
      currentDraft === null ||
      currentInstructions === null ||
      handle.saving ||
      offline ||
      !editable ||
      !dirty
    ) {
      return;
    }
    if (instructionBytes > 8_192) {
      setLocalError("지시문은 UTF-8 기준 8KB 이하로 줄여야 합니다.");
      return;
    }
    setLocalError(null);
    const input = {
      instructions: currentInstructions,
      enabledTools: handle.profile?.enabledTools ?? [],
      triggers: handle.profile?.triggers ?? { mention: true as const },
      ...(currentDraft.model === null ? {} : { modelPref: currentDraft.model }),
      ...(currentDraft.effort === null
        ? {}
        : { effortPref: currentDraft.effort }),
    };
    const result = await handle.replace(input);
    if (result.effortUnsupported) {
      setDraft({ model: currentDraft.model, effort: null });
    }
  }

  if (handle.isPending) {
    return (
      <AgentHubLoading
        message="에이전트 프로필을 불러오는 중입니다."
        rows={6}
        className="max-w-pane-lg p-4"
      />
    );
  }
  if (handle.error || currentDraft === null || currentInstructions === null) {
    return (
      <InlineBanner
        message="에이전트 프로필을 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={handle.refetch}
        testId="agent-hub-profile-error"
      />
    );
  }

  const profilePaused = handle.profile?.paused ?? false;
  const pausePending = pauseMutation.isPending;
  const currentWork = signals[0];
  const owner = memberFor(directory, agent.ownerHumanId);

  return (
    <div className="flex max-w-pane-lg flex-col gap-6 p-4">
      {handle.missing && (
        <InlineBanner
          tone="neutral"
          separator={false}
          message={
            editable
              ? "아직 저장된 프로필이 없습니다. 변경을 저장하면 프로필이 만들어집니다."
              : "아직 저장된 프로필이 없습니다."
          }
          testId="agent-hub-profile-empty"
        />
      )}
      {/* 편집 표면이 없거나 확인되지 않은 서버에서는 그 사실을 먼저 말한다.
          이 배너가 없던 동안 화면은 "저장하면 만들어집니다"라고 약속하고 404를
          돌려줬다 — 프로필 읽기가 200을 답한다는 사실만으로 쓰기까지 있다고
          가정한 결과다(capability.ts ④).

          `checking`에는 아무 배너도 띄우지 않는다: 아직 결론이 아닌 상태를
          띄우면 프로필을 열 때마다 배너가 한 번 깜빡인다. 그동안 컨트롤은
          잠겨 있고, 그 이유는 상자 옆 사유가 말한다. 오프라인도 여기 오지
          않는다 — 라우트 상단 배너가 이미 그 사실을 말하고 있고, 같은 사실을
          두 번 말하면 둘 중 하나는 반드시 낡는다. */}
      {(editing.support === "absent" || editing.support === "unknown") && (
        <InlineBanner
          tone={editing.support === "absent" ? "neutral" : "error"}
          separator={false}
          message={
            editing.support === "absent"
              ? `${editing.reason ?? ""} 프로필 편집과 일시정지는 서버를 올린 뒤에 할 수 있습니다. 채널 배치는 지금도 됩니다.`.trim()
              : (editing.reason ?? "이 서버가 프로필 편집을 받는지 확인하지 못했습니다.")
          }
          {...(editing.support === "unknown"
            ? { actionLabel: "다시 확인", onAction: editing.recheck }
            : {})}
          testId="agent-hub-edit-unsupported"
        />
      )}
      {pauseMutation.isError && (
        <InlineBanner
          separator={false}
          message="에이전트 상태를 바꾸지 못했습니다. 연결을 확인하고 다시 시도하세요."
          testId="agent-hub-pause-error"
        />
      )}

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-body font-semibold text-ink">상태</h3>
          <p className="text-meta text-ink-muted">
            일시정지하면 새 멘션과 작업이 이 에이전트로 전달되지 않습니다.
          </p>
        </div>
        {/* 프로필 카드: 멘션하기 전에 확인하는 다섯 가지를 한 판에 둔다. 값이
            없는 칸은 비워 두지 않고 왜 없는지 말한다(model.ts의 세 함수). */}
        <dl className="flex flex-col gap-2 text-body" data-testid="agent-hub-profile-card">
          <div className="grid grid-cols-3 gap-2">
            <dt className="min-w-0 text-ink-muted">상태</dt>
            <dd
              className="col-span-2 min-w-0 text-ink"
              data-testid="agent-hub-lifecycle"
            >
              {lifecycleLabel(agent, handle.profile, false, false)}
            </dd>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <dt className="min-w-0 text-ink-muted">모델</dt>
            <dd
              className="col-span-2 min-w-0 break-words text-ink"
              data-testid="agent-hub-model-summary"
            >
              {effectiveModelLabel(handle.profile, agent)}
            </dd>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <dt className="min-w-0 text-ink-muted">추론 강도</dt>
            <dd
              className="col-span-2 min-w-0 text-ink"
              data-testid="agent-hub-effort-summary"
            >
              {effectiveEffortLabel(handle.profile, effortReady)}
            </dd>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <dt className="min-w-0 text-ink-muted">관리 주체</dt>
            <dd
              className="col-span-2 min-w-0 text-ink"
              data-testid="agent-hub-owner-summary"
            >
              {owner ? `${owner.displayName} (@${owner.handle})` : "확인할 수 없음"}
            </dd>
          </div>
          <div className="grid grid-cols-3 gap-2">
            <dt className="min-w-0 text-ink-muted">현재 작업</dt>
            <dd
              className="col-span-2 min-w-0 text-ink"
              data-testid="agent-hub-work-summary"
            >
              {currentWork ? (
                <AgentTurnBadge
                  state={currentWork.state}
                  text={
                    currentWork.state === "working" ? "작업 중" : "승인 대기"
                  }
                  label={
                    currentWork.state === "working"
                      ? `${agent.displayName} 에이전트가 작업 중입니다.`
                      : `${agent.displayName} 에이전트가 승인을 기다립니다.`
                  }
                  live={live}
                />
              ) : (
                "현재 확인된 작업 없음"
              )}
            </dd>
          </div>
        </dl>
        <Button
          type="button"
          variant={profilePaused ? "default" : "outline"}
          size="sm"
          className="self-start"
          disabled={offline || !editable}
          aria-busy={pausePending || undefined}
          onClick={() => {
            if (!pausePending) pauseMutation.mutate(!profilePaused);
          }}
          data-testid="agent-hub-pause"
        >
          {pausePending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {pausePending
            ? profilePaused
              ? "재개 중"
              : "일시정지 중"
            : profilePaused
              ? "에이전트 재개"
              : "에이전트 일시정지"}
        </Button>
      </section>

      <AgentChannelsSection agent={agent} offline={offline} />

      <form onSubmit={submit} className="flex flex-col gap-6">
        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-body font-semibold text-ink">지시문</h3>
            <p className="text-meta text-ink-muted">
              이 에이전트가 답변과 작업에서 따를 워크스페이스 지시입니다.
            </p>
          </div>
          <label htmlFor="agent-hub-instructions" className="sr-only">
            에이전트 지시문
          </label>
          <textarea
            id="agent-hub-instructions"
            value={currentInstructions}
            onChange={(event) => {
              setInstructions(event.target.value);
              setLocalError(null);
              handle.clearFailure();
            }}
            rows={7}
            disabled={offline || !editable}
            className={cn(
              "w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
              // Offline dims the SURFACE, not the text. The house rule for a
              // disabled control is opacity-50, but here that also greys the
              // cached instructions the offline banner promises you can still
              // read. Dropping the dimming entirely (design-review 2R High)
              // made this the only control in the client that looks operable
              // while disabled. Muting the field's ground and border keeps the
              // "not now" signal where it belongs and leaves the words legible.
              "disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-hover disabled:opacity-100"
            )}
            placeholder="답변 방식, 검증 기준, 작업 경계를 적습니다."
            data-testid="agent-hub-instructions"
          />
          <p
            className={cn(
              "text-meta",
              instructionBytes > 8_192 ? "text-danger" : "text-ink-muted"
            )}
            data-numeric
          >
            UTF-8 {instructionBytes.toLocaleString("ko-KR")} / 8,192 bytes
          </p>
        </section>

        <section className="flex flex-col gap-3">
          <div>
            <h3 className="text-body font-semibold text-ink">모델</h3>
            <p className="text-meta text-ink-muted">
              비워 두면 에이전트 기본 모델 {inheritedModel || "미지정"}을 사용합니다.
            </p>
          </div>
          <RoutingFields
            idPrefix="agent-hub-routing"
            table={table}
            models={models}
            allowedModelsReceived={allowedModels !== null}
            inheritedModel={inheritedModel}
            modelInheritLabel={agentModelInheritLabel(inheritedModel)}
            effortInheritLabel={agentEffortInheritLabel(
              table ? effortsForModel(table, modelForEfforts).defaultEffort : null
            )}
            draft={currentDraft}
            onChange={(next) => {
              setDraft(next);
              setLocalError(null);
              handle.clearFailure();
            }}
            modelDisabled={offline || !editable}
            modelDisabledReason={editDisabledReason}
            effortDisabled={!effortReady || offline || !editable}
            effortDisabledReason={
              // 두 축 모두 없는 서버에서 강도 상자가 말해야 하는 것은 강도
              // 이야기가 아니라 "여기서는 아무것도 저장되지 않는다"이다. 쓰기
              // 표면 판정이 먼저 서는 이유가 그것이다.
              !editable
                ? editDisabledReason
                : routingCapability.reason ??
                  "이 서버가 추론 강도 변경을 지원하는지 확인 중입니다."
            }
            modelError={
              handle.failure?.field === "model"
                ? handle.failure.message
                : null
            }
          />
        </section>

        {(localError ||
          (handle.failure !== null && handle.failure.field !== "model")) && (
          <p role="alert" className="text-body text-danger">
            {localError ?? handle.failure?.message}
          </p>
        )}
        <Button
          type="submit"
          size="sm"
          className="self-start"
          disabled={offline || !editable || !dirty || instructionBytes > 8_192}
          aria-busy={handle.saving || undefined}
          data-testid="agent-hub-profile-save"
        >
          {handle.saving && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {handle.saving ? "저장 중" : "프로필 변경 저장"}
        </Button>
      </form>

      <PermissionsSection agent={agent} profile={handle.profile} />

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-body font-semibold text-ink">예약 작업</h3>
        <p className="text-body text-ink-muted" data-testid="agent-hub-schedule">
          {handle.profile?.triggers.schedule === undefined
            ? "예약된 작업이 없습니다. 예약 실행기는 아직 구현되지 않았습니다."
            : "예약 정보가 저장되어 있습니다. 실행기는 아직 구현되지 않았습니다."}
        </p>
      </section>
    </div>
  );
}

function PermissionsSection({
  agent,
  profile,
}: {
  agent: RosterMember;
  profile: AgentProfile | null;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="text-body font-semibold text-ink">권한</h3>
        <p className="text-meta text-ink-muted">
          서버가 공개한 capability와 프로필의 도구 제한을 읽기 전용으로 보여 줍니다.
        </p>
      </div>
      <dl className="flex flex-col gap-3 text-body">
        <div className="flex flex-col gap-1">
          <dt className="text-ink-muted">공개 capability</dt>
          <dd className="flex flex-wrap gap-1">
            {agent.capabilities.length === 0 ? (
              <span className="text-ink">공개된 capability 없음</span>
            ) : (
              agent.capabilities.map((capability) => (
                <StatusChip key={capability}>{capability}</StatusChip>
              ))
            )}
          </dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-ink-muted">프로필 도구 제한</dt>
          <dd className="flex flex-wrap gap-1">
            {!profile || profile.enabledTools.length === 0 ? (
              <span className="text-ink">
                {profile
                  ? "허용된 도구 없음"
                  : "프로필이 없어 별도 제한이 저장되지 않음"}
              </span>
            ) : (
              profile.enabledTools.map((tool) => (
                <StatusChip key={tool}>{tool}</StatusChip>
              ))
            )}
          </dd>
        </div>
      </dl>
      {/* 앱 표면은 진입점을 감추지 않고 **서버의 답으로** 접는다 (goal B12,
          이중 방어 (b)). 이 링크가 데려가는 패널은 앱 목록을 못 받으면 그
          자리에서 이유를 말하므로, 여기서 미리 판정할 필요가 없다. 정적 판정은
          사이드바의 작업 흐름처럼 **일급 목적지**에만 쓴다: 설정의 한 줄과
          달리 그것은 셸의 상시 네비게이션이고, 죽은 채로 서 있는 값이 다르다. */}
      <Button variant="outline" size="sm" className="self-start" asChild>
        <Link to="/settings?section=plugins">설정의 앱에서 권한 보기</Link>
      </Button>
    </section>
  );
}

function AgentMemorySection({
  agent,
  directory,
  offline,
  onOpenProfile,
}: {
  agent: RosterMember;
  directory: Directory;
  offline: boolean;
  onOpenProfile: () => void;
}) {
  const { workspaceId, session } = useSession();
  const client = useQueryClient();
  const [queryText, setQueryText] = useState("");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [searchError, setSearchError] = useState<string | null>(null);
  const [openGrantsFor, setOpenGrantsFor] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<MemoryItem | null>(null);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<string | null>(null);
  const isSearch = submittedQuery.length >= 2;
  const query = useQuery({
    queryKey: [
      "agent-memories",
      normalizedId(workspaceId),
      normalizedId(agent.id),
      submittedQuery,
    ],
    queryFn: async () =>
      isSearch
        ? (await searchAgentMemories(
            workspaceId,
            agent.id,
            submittedQuery
          )).map((hit) => hit.memory)
        : listAgentMemories(workspaceId, agent.id),
    retry: false,
  });
  const invalidateMutation = useMutation({
    mutationFn: (memoryId: string) => invalidateMemory(workspaceId, memoryId),
    onSuccess: async () => {
      setConfirming(null);
      setActionError(null);
      setReceipt("메모리를 무효화했습니다. 출처와 변경 이력은 남아 있습니다.");
      await client.invalidateQueries({
        queryKey: [
          "agent-memories",
          normalizedId(workspaceId),
          normalizedId(agent.id),
        ],
      });
    },
    onError: (error) => {
      setConfirming(null);
      setActionError(
        error instanceof Error
          ? error.message
          : "메모리를 무효화하지 못했습니다."
      );
    },
  });

  function submitSearch(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = queryText.trim();
    if (trimmed.length === 1) {
      setSearchError("검색어를 두 글자 이상 입력하세요.");
      return;
    }
    setSearchError(null);
    setSubmittedQuery(trimmed);
  }

  return (
    <div className="flex max-w-pane-lg flex-col">
      <form
        onSubmit={submitSearch}
        className="flex items-start gap-2 border-b border-line p-4"
        role="search"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <label htmlFor="agent-memory-search" className="sr-only">
            에이전트 메모리 검색
          </label>
          <Input
            id="agent-memory-search"
            type="search"
            value={queryText}
            onChange={(event) => {
              setQueryText(event.target.value);
              setSearchError(null);
            }}
            placeholder="기억 내용 검색"
            aria-invalid={searchError ? true : undefined}
            aria-describedby={searchError ? "agent-memory-search-error" : undefined}
            data-testid="agent-memory-search"
          />
          {searchError && (
            <p
              id="agent-memory-search-error"
              role="alert"
              className="text-meta text-danger"
            >
              {searchError}
            </p>
          )}
        </div>
        <Button type="submit" variant="outline" size="sm">
          <Search aria-hidden="true" />
          검색
        </Button>
        {submittedQuery && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setQueryText("");
              setSubmittedQuery("");
              setSearchError(null);
            }}
          >
            검색 지우기
          </Button>
        )}
      </form>

      {actionError && (
        <InlineBanner
          message={actionError}
          actionLabel="닫기"
          onAction={() => setActionError(null)}
          testId="agent-memory-action-error"
        />
      )}
      {receipt && (
        <InlineBanner
          tone="neutral"
          message={receipt}
          actionLabel="닫기"
          onAction={() => setReceipt(null)}
          testId="agent-memory-receipt"
        />
      )}

      {query.isPending ? (
        <AgentHubLoading
          message={
            isSearch
              ? "메모리 검색 결과를 불러오는 중입니다."
              : "메모리 목록을 불러오는 중입니다."
          }
          rows={5}
          className="p-4"
        />
      ) : query.isError ? (
        <InlineBanner
          message={
            isSearch
              ? "메모리 검색 결과를 불러오지 못했습니다."
              : "메모리 목록을 불러오지 못했습니다."
          }
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="agent-memory-error"
        />
      ) : query.data.length === 0 ? (
        <EmptyInvite
          headline={
            isSearch
              ? `"${submittedQuery}" 검색 결과가 없습니다.`
              : "이 에이전트에 연결된 메모리가 없습니다."
          }
          detail={
            isSearch
              ? "다른 표현으로 검색하거나 전체 목록으로 돌아가세요."
              : "대화에서 검증된 기억이 만들어지면 여기에 표시됩니다."
          }
          actions={
            isSearch ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setQueryText("");
                  setSubmittedQuery("");
                }}
              >
                전체 목록 보기
              </Button>
            ) : (
              <Button variant="outline" size="sm" onClick={onOpenProfile}>
                프로필 보기
              </Button>
            )
          }
          testId={isSearch ? "agent-memory-zero" : "agent-memory-empty"}
        />
      ) : (
        <ul data-testid="agent-memory-list">
          {query.data.map((memory) => {
            const mayInvalidate = canInvalidateMemory(
              memberFor(directory, session.member.id)?.role,
              session.member.id,
              memory.createdByMemberId
            );
            return (
              <li
                key={memory.id}
                className="flex flex-col gap-3 border-b border-line px-4 py-3"
                data-testid="agent-memory-row"
                data-memory-id={memory.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="mb-1 flex flex-wrap gap-1">
                      <StatusChip>{memoryScopeLabel(memory.scope)}</StatusChip>
                      <StatusChip>{memoryKindLabel(memory.kind)}</StatusChip>
                      {memory.invalidAtMs !== undefined && (
                        <StatusChip>무효화됨</StatusChip>
                      )}
                    </div>
                    <p className="whitespace-pre-wrap break-words text-body text-ink">
                      {memory.body}
                    </p>
                    <p className="mt-1 text-meta text-ink-muted">
                      확인도{" "}
                      <span data-numeric>
                        {Math.round(memory.confidence * 100)}%
                      </span>
                      , {DATE_TIME.format(memory.updatedAtMs)}
                    </p>
                  </div>
                  {mayInvalidate && memory.invalidAtMs === undefined && (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      disabled={offline}
                      onClick={(event) => {
                        setOpener(event.currentTarget);
                        setConfirming(memory);
                        setReceipt(null);
                        setActionError(null);
                      }}
                      data-testid="agent-memory-invalidate"
                    >
                      무효화
                    </Button>
                  )}
                </div>
                <div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setOpenGrantsFor((current) =>
                        uuidEq(current ?? undefined, memory.id)
                          ? null
                          : memory.id
                      )
                    }
                    aria-expanded={uuidEq(openGrantsFor ?? undefined, memory.id)}
                  >
                    {uuidEq(openGrantsFor ?? undefined, memory.id)
                      ? "공개 범위 접기"
                      : "공개 범위 보기"}
                  </Button>
                  {uuidEq(openGrantsFor ?? undefined, memory.id) && (
                    <MemoryGrantList
                      workspaceId={workspaceId}
                      memoryId={memory.id}
                      directory={directory}
                    />
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirming && (
        <MemoryInvalidationDialog
          memory={confirming}
          opener={opener}
          pending={invalidateMutation.isPending}
          onCancel={() => {
            if (!invalidateMutation.isPending) setConfirming(null);
          }}
          onConfirm={() => {
            if (!invalidateMutation.isPending) {
              invalidateMutation.mutate(confirming.id);
            }
          }}
        />
      )}
    </div>
  );
}

function MemoryGrantList({
  workspaceId,
  memoryId,
  directory,
}: {
  workspaceId: string;
  memoryId: string;
  directory: Directory;
}) {
  const query = useQuery({
    queryKey: [
      "memory-grants",
      normalizedId(workspaceId),
      normalizedId(memoryId),
    ],
    queryFn: () => listMemoryVisibilityGrants(workspaceId, memoryId),
    retry: false,
  });
  if (query.isPending) {
    return (
      <AgentHubLoading
        message="메모리 공개 범위를 불러오는 중입니다."
        rows={2}
        className="px-0 py-2"
      />
    );
  }
  if (query.isError) {
    return (
      <InlineBanner
        separator={false}
        message="이 메모리의 공개 범위를 읽을 수 없습니다."
        actionLabel="다시 시도"
        onAction={() => void query.refetch()}
        testId="memory-grants-error"
      />
    );
  }
  if (query.data.length === 0) {
    return (
      <p className="px-3 py-2 text-meta text-ink-muted" data-testid="memory-grants-empty">
        명시적으로 추가된 공개 범위가 없습니다.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1 px-3 py-2" data-testid="memory-grants-list">
      {query.data.map((grant) => {
        const grantee = memberFor(directory, grant.granteeId);
        return (
          <li key={grant.id} className="flex items-center justify-between gap-2 text-meta">
            <span className="text-ink">
              {grantee
                ? `${grantee.displayName} (@${grantee.handle})`
                : grant.granteeKind === "agent"
                  ? "명부에서 찾을 수 없는 에이전트"
                  : "명부에서 찾을 수 없는 멤버"}
            </span>
            <span className="text-ink-muted">
              {grant.revokedAtMs === undefined ? "공개 중" : "회수됨"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function MemoryInvalidationDialog({
  memory,
  opener,
  pending,
  onCancel,
  onConfirm,
}: {
  memory: MemoryItem;
  opener: HTMLButtonElement | null;
  pending: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !pending) onCancel();
    }}>
      <DialogContent
        opener={opener}
        onEscapeKeyDown={(event) => {
          event.stopPropagation();
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <div className="flex flex-col gap-3 p-4">
          <DialogTitle>이 메모리를 무효화할까요?</DialogTitle>
          <DialogDescription>
            이후 답변에서 사용하지 않게 표시합니다. 출처와 변경 이력은 삭제되지
            않습니다.
          </DialogDescription>
          <p className="line-clamp-3 text-body text-ink">{memory.body}</p>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={pending}
              onClick={onCancel}
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              aria-busy={pending || undefined}
              onClick={() => {
                if (!pending) onConfirm();
              }}
              data-testid="agent-memory-invalidate-confirm"
            >
              {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {pending ? "무효화 중" : "메모리 무효화"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function AgentHistorySection({
  agent,
  onOpenProfile,
}: {
  agent: RosterMember;
  onOpenProfile: () => void;
}) {
  const { workspaceId } = useSession();
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [opener, setOpener] = useState<HTMLButtonElement | null>(null);
  const query = useInfiniteQuery({
    queryKey: [
      "agent-run-history",
      normalizedId(workspaceId),
      normalizedId(agent.id),
    ],
    queryFn: ({ pageParam }) =>
      fetchAgentRunSummaries(
        workspaceId,
        agent.id,
        typeof pageParam === "string" ? pageParam : undefined
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
  const runs = query.data ? mergeRunPages(query.data.pages) : [];

  return (
    <div className="flex max-w-pane-lg flex-col">
      {query.isPending ? (
        <AgentHubLoading
          message="에이전트 작업 이력을 불러오는 중입니다."
          rows={6}
          className="p-4"
        />
      ) : query.isError ? (
        <InlineBanner
          message="에이전트 작업 이력을 불러오지 못했습니다."
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="agent-history-error"
        />
      ) : runs.length === 0 ? (
        <EmptyInvite
          headline="표시할 작업 이력이 없습니다."
          detail="현재 참여 중인 채널에서 이 에이전트가 실행한 작업이 생기면 최신순으로 표시됩니다."
          actions={
            <Button variant="outline" size="sm" onClick={onOpenProfile}>
              프로필 보기
            </Button>
          }
          testId="agent-history-empty"
        />
      ) : (
        <>
          <ul data-testid="agent-history-list">
            {runs.map((run) => (
              <HistoryRow
                key={run.id}
                run={run}
                onOpen={(button) => {
                  setOpener(button);
                  setSelectedRunId(run.id);
                }}
              />
            ))}
          </ul>
          {query.hasNextPage && (
            <div className="p-4">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-busy={query.isFetchingNextPage || undefined}
                onClick={() => {
                  if (!query.isFetchingNextPage) void query.fetchNextPage();
                }}
                data-testid="agent-history-more"
              >
                {query.isFetchingNextPage && (
                  <Loader2 aria-hidden="true" className="spinner-busy" />
                )}
                {query.isFetchingNextPage ? "불러오는 중" : "더 보기"}
              </Button>
            </div>
          )}
        </>
      )}

      {selectedRunId && (
        <AgentRunDetailDialog
          workspaceId={workspaceId}
          runId={selectedRunId}
          opener={opener}
          onClose={() => setSelectedRunId(null)}
        />
      )}
    </div>
  );
}

function HistoryRow({
  run,
  onOpen,
}: {
  run: AgentRunSummary;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const live =
    run.status === "running" ||
    run.status === "queued" ||
    run.status === "awaiting_approval";
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={(event) => onOpen(event.currentTarget)}
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        data-testid="agent-history-row"
        data-run-id={run.id}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink">
            {run.triggerSummary ?? "제목이 기록되지 않은 실행"}
          </span>
          <span className="mt-1 block text-meta text-ink-muted">
            {DATE_TIME.format(run.createdAtMs)}
          </span>
        </span>
        <StatusChip
          tone={
            run.status === "awaiting_approval"
              ? "warn"
              : live
                ? "agent"
                : "neutral"
          }
        >
          {runStatusLabel(run.status)}
        </StatusChip>
      </button>
    </li>
  );
}

function AgentRunDetailDialog({
  workspaceId,
  runId,
  opener,
  onClose,
}: {
  workspaceId: string;
  runId: string;
  opener: HTMLButtonElement | null;
  onClose: () => void;
}) {
  const query = useQuery({
    queryKey: [
      "agent-run-detail",
      normalizedId(workspaceId),
      normalizedId(runId),
    ],
    queryFn: () => fetchAgentRunDetail(workspaceId, runId),
    retry: false,
  });
  return (
    <Dialog open onOpenChange={(open) => {
      if (!open) onClose();
    }}>
      <DialogContent opener={opener}>
        <div className="flex flex-col gap-1 border-b border-line p-4">
          <DialogTitle>작업 상세</DialogTitle>
          <DialogDescription>
            이 작업의 실행 상태와 기록된 작업 요약을 봅니다.
          </DialogDescription>
        </div>
        {query.isPending ? (
          <AgentHubLoading
            message="작업 상세를 불러오는 중입니다."
            rows={5}
            className="p-4"
          />
        ) : query.isError ? (
          <InlineBanner
            message="작업 상세를 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="agent-run-detail-error"
          />
        ) : (
          <RunDetail run={query.data} />
        )}
        <div className="flex justify-end gap-2 border-t border-line p-4">
          {query.data && (
            <Button variant="outline" size="sm" asChild>
              <Link to={`/c/${query.data.channelId}`} onClick={onClose}>
                채널 열기
              </Link>
            </Button>
          )}
          <Button type="button" size="sm" onClick={onClose}>
            상세 닫기
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function RunDetail({ run }: { run: AgentRun }) {
  const title =
    typeof run.input?.title === "string"
      ? run.input.title
      : typeof run.input?.prompt === "string"
        ? run.input.prompt
        : "제목이 기록되지 않은 실행";
  const brief = typeof run.input?.brief === "string" ? run.input.brief : null;
  return (
    <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
      <div>
        <p className="text-body font-medium text-ink">{title}</p>
        {brief && <p className="mt-1 whitespace-pre-wrap text-body text-ink-muted">{brief}</p>}
      </div>
      <dl className="flex flex-col gap-2 text-body">
        <RunDetailField label="상태">
          {runStatusLabel(run.status)}
        </RunDetailField>
        <RunDetailField label="시작">
          {DATE_TIME.format(run.startedAtMs ?? run.createdAtMs)}
        </RunDetailField>
        <RunDetailField label="단계" numeric>
          {run.stepCount} / {run.maxSteps}
        </RunDetailField>
        <RunDetailField label="종료">
          {run.finishedAtMs === undefined
            ? "아직 종료되지 않음"
            : DATE_TIME.format(run.finishedAtMs)}
        </RunDetailField>
      </dl>
    </div>
  );
}

function RunDetailField({
  label,
  children,
  numeric = false,
}: {
  label: string;
  children: React.ReactNode;
  numeric?: boolean;
}) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="min-w-0 text-ink-muted">{label}</dt>
      <dd
        className="col-span-2 min-w-0 text-ink"
        data-numeric={numeric ? "" : undefined}
      >
        {children}
      </dd>
    </div>
  );
}
