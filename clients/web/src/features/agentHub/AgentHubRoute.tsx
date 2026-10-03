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
import { Link, useSearchParams } from "react-router-dom";
import { AI_HUB_NAV_COPY } from "@momo/core/features/ai/aiHubModel";
import { Bot, Loader2 } from "lucide-react";
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
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import {
  useAgentWorkingSignals,
  useTickingNow,
} from "@/features/agents/agentWorkingSignal";
import { AgentTurnBadge } from "@/features/agents/AgentTurnBadge";
import { openWorkPanel } from "@/features/agents/workLogStore";
import type { AgentWorkingSignal } from "@momo/core/features/agents/workingSignal";
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
} from "@momo/core/features/routing/routingModel";
import {
  isAgentProfileMissing,
  useAgentProfile,
} from "@/features/routing/useAgentProfile";
import {
  fetchAgentProfile,
  fetchAgentRunDetail,
  fetchAgentRunSummaries,
  putAgentPause,
  uuidEq,
  type AgentProfile,
  type AgentRun,
  type AgentRunSummary,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  agentMembers,
  effectiveEffortLabel,
  effectiveModelLabel,
  lifecycleLabel,
  mergeRunPages,
  normalizedId,
  runStatusLabel,
  signalsForAgent,
  type AgentHubSection,
} from "@momo/core/features/agents/hubModel";
import { AgentChannelsSection } from "./AgentChannelsSection";
import { EnabledToolsSection } from "./EnabledToolsSection";
import { StatusChip } from "./StatusChip";
import { useAgentToolCatalog } from "./useAgentToolCatalog";
import { toolsProfilePut } from "./enabledToolsModel";
import { canCreateAgentNow } from "./createModel";
import { rosterStatusView } from "@/features/aiHub/aiAgentsModel";
import { CreateAgentFlow } from "@/features/aiHub/CreateAgentFlow";
import { GrokBotInvite } from "@/features/hostedAgents/GrokBotInvite";
import { HostedAgentWizard } from "@/features/hostedAgents/HostedAgentWizard";
import { HostedConnectionSection } from "@/features/hostedAgents/HostedConnectionSection";
import type { HostedWizardLaunch } from "@/features/hostedAgents/hostedWizardLaunch";
import { HOSTED_WIZARD_TITLE } from "@momo/core/features/hostedAgents/wizard";
import { SubscriptionAgentEntryButton } from "@/features/welcome/SubscriptionAgentEntry";
import {
  isSurfaceProvided,
  type SurfaceId,
} from "@momo/core/features/capabilities/serverSurfaces";

/**
 * 허브의 탭 셋과 각 탭이 서 있는 서버 표면 (goal B12).
 *
 * 프로필은 표면을 적지 않는다: 그 탭의 읽기/쓰기는 이 서버에 있고, 편집 가능
 * 여부는 이미 자기 프로브가 판정한다(features/routing/capability.ts ④).
 * 이력은 이 서버에 경로가 없으면 열자마자 오류라서 표면으로 접는다. (예전 메모리 탭은
 * #3170에서 없어졌다: 팀 기억은 `/memory` 브라우저가 맡는다.)
 */
const SECTIONS: {
  id: AgentHubSection;
  label: string;
  surface?: SurfaceId;
  /** 소유자·관리자에게만 서는 탭인가. */
  operatorOnly?: boolean;
}[] = [
  { id: "profile", label: "프로필" },
  { id: "history", label: "이력", surface: "agentRunHistory" },
  // 연결 탭은 호스티드 연결의 **수명**이 사는 자리다: 해제와 정리 확인
  // (HAP-UX2 / #1362). 그 세 경로는 전부 human owner/admin 을 요구하므로 그 밖의
  // 멤버에게 세우면 열자마자 403 이고, 그것은 "미제공"이 아니라 "고장"으로 읽힌다.
  //
  // 호스티드 연결이 없는 에이전트에게도 탭이 서는 것은 의도다. 로스터를 넘길
  // 때마다 탭이 생겼다 사라지면 그 자리가 무엇인지 배울 수 없고, 열었을 때의 빈
  // 상태가 "이 에이전트는 이 워크스페이스가 직접 실행한다"는 답을 준다.
  {
    id: "connection",
    label: "연결",
    surface: "hostedAgentPairing",
    operatorOnly: true,
  },
];

/** 이 서버에서 실제로 답이 오는 탭만. */
const VISIBLE_SECTIONS = SECTIONS.filter(
  (item) => item.surface === undefined || isSurfaceProvided(item.surface)
);

/**
 * 이 서버가 호스티드 연결 라우트를 싣고 있는가 (goal B12 의 이중 방어 (a)).
 *
 * 없는 서버에 붙었을 때 진입점을 세우면 사람은 다이얼로그를 열어 목록 404 를
 * 마주하고, 그것은 "미제공"이 아니라 "고장"으로 읽힌다. 표가 틀린 경우는
 * 마법사 안에서 `serverSaysAbsent` 로 접힌다.
 */
const hostedPairingProvided = isSurfaceProvided("hostedAgentPairing");

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
      <Skeleton ready={false} rows={rows} className={className} />
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
  viewerId,
}: {
  agent: RosterMember;
  profile: AgentProfile | null;
  profilePending: boolean;
  profileFailed: boolean;
  selected: boolean;
  signals: ReturnType<typeof signalsForAgent>;
  live: boolean;
  onSelect: () => void;
  viewerId: string;
}) {
  const current = signals[0];
  // 「AI」 표와 같은 우선순위: 문의 중·맥 꺼짐 같은 서버 사유가 있으면 「활성」보다 앞선다.
  const server = rosterStatusView(agent, viewerId);
  const serverSpecific = server !== null && server.label !== "활성";
  const lifecycle = serverSpecific
    ? server.label
    : lifecycleLabel(agent, profile, profilePending, profileFailed);
  return (
    <li className="border-b border-line">
      <button
        type="button"
        onClick={onSelect}
        aria-current={selected ? "page" : undefined}
        className={cn(
          "flex w-full items-start gap-3 px-4 py-3 text-left focus-visible:focus-ring",
          selected
            ? "bg-accent-soft active:bg-surface-pressed"
            : "hover:bg-surface-hover active:bg-surface-pressed"
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
            <StatusChip
              tone={
                serverSpecific && server.tone !== "mute"
                  ? server.tone
                  : lifecycle === "활성"
                    ? "ok"
                    : "neutral"
              }
            >
              {lifecycle}
            </StatusChip>
          </span>
          <span className="truncate text-meta text-ink-muted">@{agent.handle}</span>
          {current && (
            <span className="flex items-center gap-1">
              <AgentTurnBadge
                state={current.state}
                text={current.state === "working" ? "작업 중" : "승인 대기"}
                label={
                  current.state === "working"
                    ? `${agent.displayName} 에이전트가 작업 중이에요.`
                    : `${agent.displayName} 에이전트가 승인을 기다려요.`
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
  // `/agents?agent=<id>` 로 오면 그 에이전트를 먼저 연다(「AI」 표의 이름 링크).
  const [searchParams, setSearchParams] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get("agent")?.toLowerCase() ?? null);
  const [section, setSection] = useState<AgentHubSection>("profile");
  const [creating, setCreating] = useState(false);
  const [createOpener, setCreateOpener] = useState<HTMLElement | null>(null);
  // 호스티드 연결은 「에이전트 만들기」와 **다른 물건**이라 다른 버튼이다: 하나는
  // 이 워크스페이스가 실행할 에이전트를 만들고, 하나는 남이 실행 중인 에이전트를
  // 들인다. 한 다이얼로그의 탭으로 합치면 만들기 폼 위에 pairing 상태가 얹히고,
  // 되돌릴 수 없는 값(연결 값)이 되돌릴 수 있는 폼과 같은 Esc 를 나눠 갖는다.
  const [pairing, setPairing] = useState(false);
  const [pairingOpener, setPairingOpener] = useState<HTMLButtonElement | null>(null);
  const [wizardLaunch, setWizardLaunch] = useState<HostedWizardLaunch | null>(
    null
  );
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

  // 운영자 전용 탭은 `mayCreate` 와 같은 판정을 쓴다: 세 해제 경로도 만들기와
  // 같은 human owner/admin 관문 뒤에 있다. 명부가 오기 전에는 서지 않고
  // (위 주석의 같은 이유), 서지 않는 탭이 골라져 있으면 프로필로 되돌린다 —
  // 그러지 않으면 몸통이 비어 있는 상세가 남는다.
  const sections = VISIBLE_SECTIONS.filter(
    (item) => item.operatorOnly !== true || mayCreate
  );
  const activeSection = sections.some((item) => item.id === section)
    ? section
    : "profile";

  useEffect(() => {
    setSelectedId((current) => {
      // 명부가 오기 전(비어 있음)에는 고르지 않는다: `?agent=` 로 온 선택을 지우면 첫 줄로 바뀐다.
      if (agents.length === 0) return current;
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
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex min-w-0 items-center gap-2">
              <SidebarDrawerToggle />
              <h1 className="text-body font-semibold text-ink">에이전트</h1>
            </div>
            <p className="text-meta text-ink-muted">
              워크스페이스 에이전트를 만들고, 상태와 기억, 작업 이력을 한 곳에서
              봐요.{" "}
              <Link
                to="/ai/agents"
                className="underline underline-offset-4 press focus-visible:focus-ring"
                data-testid="agent-hub-to-ai"
              >
                {AI_HUB_NAV_COPY.agentsPageLine}
              </Link>
            </p>
          </div>
          {/* 머리 행동이 셋이 되며(#2870) 폰 폭에서 줄을 넘긴다. */}
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {!directoryQuery.isPending && !directoryQuery.isError && (
              <span className="text-meta text-ink-muted" data-numeric>
                {agents.length}명
              </span>
            )}
            {mayCreate && <SubscriptionAgentEntryButton from="agents" />}
            {mayCreate && hostedPairingProvided && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={(event) => {
                  setWizardLaunch(null);
                  setPairingOpener(event.currentTarget);
                  setPairing(true);
                }}
                data-testid="agent-hub-hosted-pairing"
              >
                {HOSTED_WIZARD_TITLE}
              </Button>
            )}
            {mayCreate && (
              <Button
                type="button"
                size="sm"
                onClick={(event) => {
                  setCreateOpener(event.currentTarget);
                  setCreating(true);
                }}
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
          message="연결이 끊겼어요. 마지막으로 받은 내용은 계속 볼 수 있고, 변경은 다시 연결된 뒤에 할 수 있어요."
          testId="agent-hub-offline"
        />
      )}

      {mayCreate && hostedPairingProvided && (
        <GrokBotInvite
          mayCreate={mayCreate}
          offline={offline}
          members={directoryQuery.directory.members}
          onLaunch={(next, opener) => {
            setWizardLaunch(next);
            setPairingOpener(opener);
            setPairing(true);
          }}
        />
      )}

      <div className="agent-hub-layout">
        <aside className="agent-hub-roster">
          {directoryQuery.isPending && agents.length === 0 ? (
            <AgentHubLoading
              message="에이전트 명부를 불러오는 중이에요."
              rows={5}
              className="p-4"
            />
          ) : directoryQuery.isError && agents.length === 0 ? (
            <InlineBanner
              message="에이전트 명부를 불러오지 못했어요."
              actionLabel="다시 시도"
              onAction={() => void directoryQuery.refetch()}
              testId="agent-hub-roster-error"
            />
          ) : agents.length === 0 ? (
            <EmptyInvite
              headline="이 워크스페이스에는 에이전트가 없어요."
              detail={
                mayCreate
                  ? "에이전트를 만들고 채널에 넣으면 그 채널에서 멘션할 수 있어요."
                  : "에이전트는 워크스페이스 소유자나 관리자가 만들 수 있어요."
              }
              actions={
                mayCreate ? (
                  <Button
                    size="sm"
                    onClick={(event) => {
                      setCreateOpener(event.currentTarget);
                      setCreating(true);
                    }}
                  >
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
                    onSelect={() => {
                      setSelectedId(normalizedId(agent.id));
                      // `?agent=` 로 열렸다면 주소도 따라간다(기록을 쌓지 않고 바꾼다).
                      if (searchParams.has("agent")) {
                        setSearchParams({ agent: normalizedId(agent.id) }, { replace: true });
                      }
                    }}
                    viewerId={session.member.id}
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
                <div className="flex w-full items-center justify-between gap-3">
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
                      {sections.map((item) => (
                        <li key={item.id} className="shrink-0">
                          <button
                            type="button"
                            onClick={() => setSection(item.id)}
                            aria-current={
                              activeSection === item.id ? "page" : undefined
                            }
                            className={cn(
                              "rounded-sm px-3 py-1 text-body press focus-visible:focus-ring",
                              activeSection === item.id
                                ? "bg-accent-soft text-ink active:bg-surface-pressed"
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
                {activeSection === "profile" && (
                  <AgentProfileSection
                    key={normalizedId(selected.id)}
                    agent={selected}
                    directory={directoryQuery.directory}
                    offline={offline}
                    signals={signalsForAgent(allSignals, selected.id, nowMs)}
                    live={railLive}
                  />
                )}
                {activeSection === "history" && (
                  <AgentHistorySection
                    key={normalizedId(selected.id)}
                    agent={selected}
                    onOpenProfile={() => setSection("profile")}
                  />
                )}
                {activeSection === "connection" && (
                  <HostedConnectionSection
                    key={normalizedId(selected.id)}
                    agentMemberId={normalizedId(selected.id)}
                    agentLabel={selected.displayName}
                    offline={offline}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>

      <CreateAgentFlow
        open={creating}
        onOpenChange={setCreating}
        mayCreate={mayCreate}
        opener={createOpener}
        // 만든 뒤 그 에이전트를 연다. 방금 만든 것이 화면에 없으면 만든 것이
        // 아니고, 다음 행동(채널에 넣기)이 바로 그 판에 있다.
        onCreated={(created) => {
          setSelectedId(normalizedId(created.id));
          setSection("profile");
        }}
      />

      <HostedAgentWizard
        open={pairing}
        onOpenChange={(open) => {
          setPairing(open);
          if (!open) setWizardLaunch(null);
        }}
        opener={pairingOpener}
        launch={wizardLaunch}
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
  const catalogQuery = useAgentToolCatalog();
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
    ? "연결이 끊긴 동안에는 바꿀 수 없어요."
    : editing.support === "checking"
      ? "이 서버가 프로필 편집을 받는지 확인 중이에요."
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
      setLocalError("지시문은 UTF-8 기준 8KB 이하로 줄여야 해요.");
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
        message="에이전트 프로필을 불러오는 중이에요."
        rows={6}
        className="p-4"
      />
    );
  }
  if (handle.error || currentDraft === null || currentInstructions === null) {
    return (
      <InlineBanner
        message="에이전트 프로필을 불러오지 못했어요."
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
    <div className="flex flex-col gap-6 p-4">
      {handle.missing && (
        <InlineBanner
          tone="neutral"
          separator={false}
          message={
            editable
              ? "아직 저장된 프로필이 없어요. 변경을 저장하면 프로필이 만들어져요."
              : "아직 저장된 프로필이 없어요."
          }
          testId="agent-hub-profile-empty"
        />
      )}
      {/* 편집 표면이 없거나 확인되지 않은 서버에서는 그 사실을 먼저 말한다.
          이 배너가 없던 동안 화면은 "저장하면 만들어져요"라고 약속하고 404를
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
              ? `${editing.reason ?? ""} 프로필 편집과 일시정지는 서버를 올린 뒤에 할 수 있어요. 채널 배치는 지금도 돼요.`.trim()
              : (editing.reason ?? "이 서버가 프로필 편집을 받는지 확인하지 못했어요.")
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
          message="에이전트 상태를 바꾸지 못했어요. 연결을 확인하고 다시 시도하세요."
          testId="agent-hub-pause-error"
        />
      )}

      <section className="flex flex-col gap-3">
        <div>
          <h3 className="text-body font-semibold text-ink">상태</h3>
          <p className="text-meta text-ink-muted">
            일시정지하면 새 멘션과 작업이 이 에이전트로 전달되지 않아요.
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
                <CurrentWorkValue
                  agentName={agent.displayName}
                  work={currentWork}
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
              이 에이전트가 답변과 작업에서 따를 워크스페이스 지시예요.
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
              "w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring",
              // Offline dims the SURFACE, not the text. The house rule for a
              // disabled control is opacity-50, but here that also greys the
              // cached instructions the offline banner promises you can still
              // read. Dropping the dimming entirely (design-review 2R High)
              // made this the only control in the client that looks operable
              // while disabled. Muting the field's ground and border keeps the
              // "not now" signal where it belongs and leaves the words legible.
              "disabled:cursor-not-allowed disabled:border-line disabled:bg-surface-hover disabled:opacity-100"
            )}
            placeholder="답변 방식, 검증 기준, 작업 경계를 적어요."
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
              비워 두면 에이전트 기본 모델 {inheritedModel || "미지정"}을 사용해요.
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
                  "이 서버가 추론 강도 변경을 지원하는지 확인 중이에요."
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

      <EnabledToolsSection
        catalog={
          catalogQuery.data?.kind === "ready" ? catalogQuery.data.tools : null
        }
        catalogStatus={
          catalogQuery.isPending
            ? "loading"
            : (catalogQuery.data?.kind ?? "absent")
        }
        catalogMessage={
          catalogQuery.data?.kind === "forbidden" ||
          catalogQuery.data?.kind === "unknown"
            ? catalogQuery.data.message
            : null
        }
        enabledTools={handle.profile?.enabledTools ?? []}
        emptyLabel={
          handle.profile
            ? "허용된 도구 없음"
            : "프로필이 없어 별도 제한이 저장되지 않음"
        }
        offline={offline}
        editable={editable}
        editDisabledReason={editDisabledReason}
        onRetryCatalog={() => {
          void catalogQuery.refetch();
        }}
        save={async (tools) => {
          const built = toolsProfilePut(handle.profile, tools);
          if (!built.ok) {
            return {
              ok: false as const,
              forbidden: false,
              message: built.message,
            };
          }
          const result = await handle.replace(built.input);
          if (result.ok) return { ok: true as const };
          return {
            ok: false as const,
            forbidden: result.forbidden,
            message: result.forbidden
              ? "이 계정으로는 이 에이전트의 도구 허용을 바꿀 수 없어요."
              : (handle.failure?.message ??
                "도구 허용을 저장하지 못했어요. 연결을 확인하고 다시 시도하세요."),
          };
        }}
      />

      <PermissionsSection agent={agent} />

      <section className="flex flex-col gap-2 border-t border-line pt-4">
        <h3 className="text-body font-semibold text-ink">예약 작업</h3>
        <p className="text-body text-ink-muted" data-testid="agent-hub-schedule">
          {handle.profile?.triggers.schedule === undefined
            ? "예약된 작업이 없어요. 예약 실행기는 아직 구현되지 않았어요."
            : "예약 정보가 저장되어 있어요. 실행기는 아직 구현되지 않았어요."}
        </p>
      </section>
    </div>
  );
}

/**
 * 「현재 작업」 값 한 칸, 그리고 작업 패널 진입점 ② (goal WEB-WP1).
 *
 * run을 특정하지 못한 신호는 배지 그대로 둔다: 열 run이 없는데 버튼을 내주면
 * 눌러도 아무 일이 없고, 그런 컨트롤은 고장 난 버튼으로 읽힌다.
 */
function CurrentWorkValue({
  agentName,
  work,
  live,
}: {
  agentName: string;
  work: AgentWorkingSignal;
  live: boolean;
}) {
  const badge = (
    <AgentTurnBadge
      state={work.state}
      text={work.state === "working" ? "작업 중" : "승인 대기"}
      label={
        work.state === "working"
          ? `${agentName} 에이전트가 작업 중이에요.`
          : `${agentName} 에이전트가 승인을 기다려요.`
      }
      live={live}
    />
  );
  const runId = work.runId;
  if (runId === undefined) return badge;
  return (
    <button
      type="button"
      onClick={(event) =>
        openWorkPanel(
          {
            runId,
            memberId: work.memberId,
            channelId: work.channelId,
            origin: "hub",
            // 패널이 자기 힘으로는 얻을 수 없는 값(여는 프레임은 run id가 알려지기
            // 전에 지나간다). 레일이 봤다면 여기서 넘겨준다.
            ...(work.startedAtMs !== undefined
              ? { startedAtMs: work.startedAtMs }
              : {}),
          },
          // 닫을 때 캐럿이 돌아올 자리(WebKit은 클릭으로 포커스를 주지 않는다).
          event.currentTarget
        )
      }
      // 배지의 접근성 문장이 통째로 이름이 되면 오프라인일 때 두 문장으로 늘어난다.
      // 이 컨트롤의 이름은 이 컨트롤이 하는 일이다.
      aria-label={`${agentName} 에이전트의 진행 과정 열기`}
      data-testid="agent-hub-work-open"
      className="flex items-center gap-1 rounded-sm text-left press hover:bg-surface-hover focus-visible:focus-ring"
    >
      {badge}
      <span className="text-timestamp text-ink-muted">진행 과정 보기</span>
    </button>
  );
}

function PermissionsSection({
  agent,
}: {
  agent: RosterMember;
}) {
  return (
    <section className="flex flex-col gap-3 border-t border-line pt-4">
      <div>
        <h3 className="text-body font-semibold text-ink">권한</h3>
        <p className="text-meta text-ink-muted">
          서버가 공개한 capability이에요. 앱 권한은 설정에서 봐요.
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
      </dl>
      {/* 앱 표면은 진입점을 감추지 않고 **서버의 답으로** 접는다 (goal B12,
          이중 방어 (b)). 이 링크가 데려가는 패널은 앱 목록을 못 받으면 그
          자리에서 이유를 말하므로, 여기서 미리 판정할 필요가 없다. 정적 판정은
          사이드바의 작업 흐름처럼 **일급 목적지**에만 쓴다: 설정의 한 줄과
          달리 그것은 셸의 상시 네비게이션이고, 죽은 채로 서 있는 값이 다르다. */}
      <Button variant="outline" size="sm" className="self-start" asChild>
        <Link to="/ai/external">AI의 외부 연결에서 권한 보기</Link>
      </Button>
    </section>
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
    <div className="flex flex-col">
      {query.isPending ? (
        <AgentHubLoading
          message="에이전트 작업 이력을 불러오는 중이에요."
          rows={6}
          className="p-4"
        />
      ) : query.isError ? (
        <InlineBanner
          message="에이전트 작업 이력을 불러오지 못했어요."
          actionLabel="다시 시도"
          onAction={() => void query.refetch()}
          testId="agent-history-error"
        />
      ) : runs.length === 0 ? (
        <EmptyInvite
          headline="표시할 작업 이력이 없어요."
          detail="현재 참여 중인 채널에서 이 에이전트가 실행한 작업이 생기면 최신순으로 표시돼요."
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
        className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring"
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
            이 작업의 실행 상태와 기록된 작업 요약을 봐요.
          </DialogDescription>
        </div>
        {query.isPending ? (
          <AgentHubLoading
            message="작업 상세를 불러오는 중이에요."
            rows={5}
            className="p-4"
          />
        ) : query.isError ? (
          <InlineBanner
            message="작업 상세를 불러오지 못했어요."
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
