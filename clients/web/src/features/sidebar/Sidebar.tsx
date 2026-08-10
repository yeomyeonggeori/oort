import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  Hash,
  Inbox,
  Lock,
  MessageSquare,
  Milestone,
  Plus,
  Search,
  Settings,
  SquarePen,
  Users,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { uuidEq, type Channel } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { useSession } from "@/app/session";
import { useInertWhile, useShellNav } from "@/app/shellNav";
import {
  agentTurnsInChannel,
  useAgentWorkingSignals,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import { AgentTurnBadge as AgentTurnStatusBadge } from "@/features/agents/AgentTurnBadge";
import {
  agentTurnBadgeCopy,
  UNKNOWN_AGENT_NAME,
} from "@/features/agents/turnCopy";
import { agentCoverage } from "@momo/core/features/agents/agentRail";
import { agentTurnFixtureMode } from "@/features/agents/turnFixture";
import {
  channelLabelParts,
  memberFor,
  memberNameParts,
  unreadFor,
  useChannels,
  useDirectory,
  useReadStates,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { canCreateChannelNow } from "@momo/core/features/channels/model";
import { useOpenCreateChannel } from "@/features/channels/useCreateChannel";
import {
  isSurfaceProvided,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { UpdateBadge } from "@/features/updates/UpdateBadge";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { openChannelId } from "./openChannel";
import { WorkspaceRail } from "./WorkspaceRail";
import { connectionCopy, connectionDotClass } from "./connStatusIndicator";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// =============================================================================
// Sidebar (R-1 §1): workspace header, the two global surfaces (인박스 / 활동),
// the member directory, channels, DMs, and the settings entry. Real momowebqa
// data throughout: the unread numbers come from the server read-state
// projection (P7), never from a local count, so they match on every device.
//
// 멤버 sits with the global surfaces rather than above the channel list: it is a
// place you go, not a thing you are subscribed to, and it is the only entry
// point to starting a DM. The + on the 다이렉트 메시지 header is the second door
// to the same surface, next to the DMs a person already has (parity G-3/G-4).
// =============================================================================

/**
 * Turn pill on a channel row (R-1 §1, mac AgentWorkingChannelBadge). It says
 * the state in words and carries no digits: the cell to its right is an unread
 * count, and a second unlabelled number on the same row is a second count to
 * anyone reading quickly. Who and how many is in the accessible name; the
 * per-turn clocks are in the composer, which has the width for them.
 *
 * Two live states, two token colors (SKILL §9). 작업 중 is the agent acting and
 * wears the agent token; 승인 대기 is the run stopped on a decision only the
 * reader can make, which is a status, not an identity, so it wears --warn and
 * an outline instead of a fill. The word carried both states at 240px, and one
 * word is a thin difference between "nothing for you to do" and "this is
 * blocked on you".
 */
function AgentTurnBadge({
  turns,
  directory,
  live,
}: {
  turns: AgentWorkingSignal[];
  directory: Directory;
  /** The realtime rail is connected, so this state is confirmed, not remembered. */
  live: boolean;
}) {
  const copy = agentTurnBadgeCopy(turns, (memberId) =>
    memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME)
  );
  if (!copy) return null;
  return (
    <AgentTurnStatusBadge
      state={copy.state}
      text={copy.text}
      label={copy.label}
      live={live}
      testId="agent-turn-badge"
    />
  );
}

export function Sidebar({
  onOpenQuickSwitcher,
}: {
  onOpenQuickSwitcher: () => void;
}) {
  const { session, workspaceId, connStatus } = useSession();
  const navigate = useNavigate();
  const navRef = useRef<HTMLDivElement>(null);

  // 폰에서 이 사이드바는 서랍이다 (goal B6). 닫혀 있는 동안에는 화면 밖으로
  // 밀려 있을 뿐 DOM에는 남아 있으므로(스크롤 위치와 마운트를 지킨다), 탭 순서와
  // 접근성 트리에서는 `inert`로 빠져야 한다. 보이지 않는 것을 읽을 수 있게 두면
  // 스크린리더 사용자는 열지도 않은 서랍 안을 걷는다.
  const { isMobile, drawerOpen, closeDrawer } = useShellNav();
  const asDrawer = isMobile;
  const drawerRef = useInertWhile<HTMLDivElement>(asDrawer && !drawerOpen);
  const closeRef = useRef<HTMLButtonElement>(null);

  // 열리면 캐럿이 서랍 안으로 들어간다. 첫 정거장은 닫기 버튼이다: 잘못 열었을
  // 때 되돌리는 길이 첫 번째여야 하고, 그 다음이 검색과 채널 목록이다.
  useEffect(() => {
    if (asDrawer && drawerOpen) closeRef.current?.focus();
  }, [asDrawer, drawerOpen]);

  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);
  const { channels, dms } = channelsQuery.groups;

  // 레일이 그리는 이름은 워크스페이스의 것이다 (검수 피드백 #4a-1). 소스는 이미
  // 있는 GET /v1/workspaces/{ws} 이고, 설정 > 워크스페이스가 쓰는 것과 같은
  // 쿼리 키라 캐시를 나눠 써 중복 페치가 없다. 그전엔 이 자리에 selfName(사용자
  // 표시명)이 꽂혀 있어 현재 워크스페이스 타일이 사용자 이니셜을 그렸다.
  const workspaceQuery = useQuery({
    queryKey: ["settings", "workspace", workspaceId],
    queryFn: () => fetchWorkspace(workspaceId),
    retry: false,
  });

  const selfMember = memberFor(directoryQuery.directory, session.member.id);
  const selfName = selfMember?.displayName ?? session.member.displayName;

  // No clock in the sidebar at all: the pill is a word, so nothing here ticks.
  // Staleness is still checked, from the render's own clock, and the rail's 15s
  // sweep re-publishes the store, which is what re-renders this list.
  const turnSignals = useAgentWorkingSignals();
  const railLive = connStatus === "connected";
  const nowMs = Date.now();

  // What the subscription cap left out (agentRail MAX_AGENT_SUBSCRIPTIONS).
  // Same pure function and the same inputs the rail subscribes with, so the two
  // cannot disagree about which rows are actually being watched.
  const uncovered = useMemo(
    () => agentCoverage([...channels, ...dms], directoryQuery.directory.members).uncovered,
    [channels, dms, directoryQuery.directory.members]
  );

  // The capture seam (?agentwork=), if this build has one at all. The turns on
  // screen are then fabricated, so the surface says so rather than passing for
  // real agent activity (the ?stress= path renames the channel header for the
  // same reason).
  const fixtureMode = agentTurnFixtureMode();

  // Only an owner/admin can create one (ChannelRoutes.requireWorkspaceAdmin),
  // so a plain member is told who can instead of being handed a + that always
  // ends in 403. That is the dead end this ticket removes, not a new one.
  // 명부가 도착하기 전에는 아직 아무것도 내밀지 않는다 (R2 M5); 그동안 헤더의
  // 액션 자리는 아래에서 같은 크기의 빈 칸이 지킨다.
  const openCreateChannel = useOpenCreateChannel();
  const rosterSettled = !directoryQuery.isPending;
  const canCreate = canCreateChannelNow(rosterSettled, selfMember?.role);

  // ⌥↑/⌥↓: jump between channels that actually have unread (P11 / Slack
  // grammar). Ordering follows the rendered list so the traversal is visible.
  const ordered = useMemo(() => [...channels, ...dms], [channels, dms]);

  // 지금 읽고 있는 채널 (goal B8 H10). ChatShell이 커서를 올리는 PUT은 왕복이
  // 걸리고 실패할 수도 있으므로, 그 사이 사이드바는 화면에 떠 있는 그 채널에
  // "새 메시지 1"을 붙인다. 읽고 있는 것은 읽은 것이다. 나머지 행은 그대로
  // 서버가 세고(P7), 이 규칙은 오직 열려 있는 한 행에만 적용된다.
  const routePath = useLocation().pathname;
  const openId = openChannelId(
    routePath,
    channels[0]?.id ?? dms[0]?.id ?? null
  );
  const unreadCountFor = useCallback(
    (channel: Channel) => {
      if (openId !== null && uuidEq(channel.id, openId)) {
        return { unreadCount: 0, mentionCount: 0 };
      }
      const read = unreadFor(readStates.byChannel, channel.id);
      return {
        unreadCount: read?.unreadCount ?? 0,
        mentionCount: read?.mentionCount ?? 0,
      };
    },
    [openId, readStates.byChannel]
  );

  const unreadChannels = useMemo(
    () => ordered.filter((c) => unreadCountFor(c).unreadCount > 0),
    [ordered, unreadCountFor]
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!event.altKey || event.metaKey || event.ctrlKey) return;
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (unreadChannels.length === 0) return;
      event.preventDefault();
      const current = window.location.hash.replace(/^#/, "");
      const index = unreadChannels.findIndex((c) =>
        current.toLowerCase().endsWith(c.id.toLowerCase())
      );
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next =
        index < 0
          ? unreadChannels[event.key === "ArrowDown" ? 0 : unreadChannels.length - 1]
          : unreadChannels[
              (index + step + unreadChannels.length) % unreadChannels.length
            ];
      navigate(`/c/${next.id}`);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [unreadChannels, navigate]);

  /** Roving arrow traversal across every row in the sidebar. */
  const onNavKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const rows = Array.from(
      navRef.current?.querySelectorAll<HTMLElement>("[data-sidebar-row]") ?? []
    );
    if (rows.length === 0) return;
    const index = rows.indexOf(document.activeElement as HTMLElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    const next = rows[(Math.max(index, 0) + step + rows.length) % rows.length];
    event.preventDefault();
    next?.focus();
  }, []);

  function rowFor(channel: Channel) {
    const counts = unreadCountFor(channel);
    // A DM row is named after a person, and this workspace holds two members
    // called 김인턴, so the row carries the handle whenever the name alone does
    // not decide which one it is (channelLabelParts).
    const label = channelLabelParts(
      channel,
      directoryQuery.directory,
      session.member.id
    );
    return (
      <SidebarRow
        key={channel.id}
        to={`/c/${channel.id}`}
        icon={
          channel.kind === "dm" ? (
            <MessageSquare className="size-4" />
          ) : channel.kind === "private" ? (
            <Lock className="size-4" />
          ) : (
            <Hash className="size-4" />
          )
        }
        label={label.text}
        handle={label.handle}
        agent={label.isAgent}
        unreadCount={counts.unreadCount}
        mentionCount={counts.mentionCount}
        trailing={
          <AgentTurnBadge
            turns={agentTurnsInChannel(turnSignals, channel.id, nowMs)}
            directory={directoryQuery.directory}
            live={railLive}
          />
        }
        testId="channel-item"
        dataAttrs={{ "data-channel-id": channel.id }}
      />
    );
  }

  return (
    <div
      ref={drawerRef}
      id="sidebar-drawer"
      className="sidebar-drawer flex h-full"
      data-open={asDrawer && drawerOpen ? "" : undefined}
      data-testid="sidebar"
    >
      <WorkspaceRail
        workspace={{
          name: workspaceQuery.data?.name,
          isPending: workspaceQuery.isPending,
          isError: workspaceQuery.isError,
        }}
        workspaceId={workspaceId}
      />

      <div className="flex h-full w-full min-w-0 flex-col border-r border-line bg-surface-sidebar">
        <div className="flex items-center gap-2 border-b border-line p-2">
          <Button
            variant="outline"
            size="sm"
            className="tap-target min-w-0 flex-1 justify-between"
            onClick={onOpenQuickSwitcher}
            data-testid="open-quick-switcher"
          >
            <span className="flex items-center gap-2">
              <Search className="size-4" />
              검색과 이동
            </span>
            {/* 폰에는 ⌘ 키가 없다 (goal B6). 누를 수 없는 단축키를 컨트롤에
                적어 두면 그만큼의 폭을 쓰면서 아무것도 알려주지 않는다. */}
            <span className="wide-only text-meta text-ink-muted">⌘K</span>
          </Button>
          {/* 폰에서만 서는 닫기 (goal B6). 넓은 창에서 사이드바는 닫히는 것이
              아니라 그냥 거기 있으므로, 이 버튼은 그때 아무 일도 하지 않는다. */}
          <button
            ref={closeRef}
            type="button"
            onClick={closeDrawer}
            aria-label="채널 목록 닫기"
            title="채널 목록 닫기"
            data-testid="close-sidebar-drawer"
            className="mobile-only tap-target flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        {fixtureMode !== null && (
          <p
            className="border-b border-line px-2 py-1 text-meta text-warn"
            data-testid="agent-fixture-notice"
          >
            {fixtureMode === "live"
              ? "에이전트 활동 픽스처: 아래 턴과 연결 상태는 실제가 아닙니다."
              : "에이전트 활동 픽스처: 아래 턴은 실제가 아니고 레일은 끊긴 상태입니다."}
          </p>
        )}

        <div
          ref={navRef}
          onKeyDown={onNavKeyDown}
          // 목록에서 무언가를 골랐으면 서랍은 할 일을 마쳤다. 라우트가 바뀌는
          // 경우는 셸이 이미 닫지만(AppShell의 routePath 효과), **이미 열려 있는
          // 채널**을 다시 고르면 주소가 그대로라 그 효과는 돌지 않는다. 그때도
          // 사람이 한 일은 "이 채널을 보겠다"이므로 서랍은 비켜야 한다.
          onClick={(event) => {
            if (!asDrawer || !drawerOpen) return;
            if ((event.target as Element).closest("a")) closeDrawer();
          }}
          // `overscroll-contain` (goal B9): 채널 목록 끝에서 계속 미는 손가락이
          // 서랍 바깥으로 넘어가지 않는다 — 덮인 표면이 함께 움직이면 서랍이 종이
          // 한 장이 아니라 창처럼 느껴진다. 타임라인이 같은 이유로 같은 것을 쓴다.
          className="overscroll-contain min-h-0 flex-1 overflow-y-auto"
          data-testid="channel-list"
        >
          <nav aria-label="워크스페이스 탐색">
            <ul className="flex flex-col px-2 py-2">
              <SidebarRow to="/inbox" icon={<Inbox className="size-4" />} label="인박스" testId="nav-inbox" />
              <SidebarRow to="/activity" icon={<Activity className="size-4" />} label="활동" testId="nav-activity" />
              <SidebarRow to="/directory" icon={<Users className="size-4" />} label="멤버" testId="nav-directory" />
              <SidebarRow to="/agents" icon={<Bot className="size-4" />} label="에이전트" testId="nav-agents" />
              {/* 메시지 검색 (goal B12 H5). 전역 목적지인 이유는 인박스와 같다:
                  가는 곳이지 구독하는 것이 아니다.

                  **이름을 짓지 않고 받아 온다** (이슈 #1146 N4). 1차의 이 줄은
                  「검색」이라고 적었는데, 도착하는 라우트의 제목도 팔레트의 항목도
                  폰의 화면도 전부 「메시지 검색」이었다 — 한 목적지에 이름이 둘이면
                  사람은 그것을 두 기능으로 센다. 바로 위 줄의 「검색과 이동」과
                  나란히 서면 더 나빠서, 「검색」은 그 팔레트의 짧은 이름처럼 읽혔다.
                  게다가 팔레트의 빈 상태는 이 줄을 **이름으로 가리킨다**(「메시지
                  본문은 아래 메시지 검색에서 찾을 수 있습니다」) — 가리키는 이름이
                  화면에 없으면 그 안내는 없는 곳을 가리킨 것이다.

                  판정은 팔레트가 「멤버 ↔ 디렉터리」에서 이미 내렸다: 사람이
                  **도착하는 표면이 쓰는 말**이 그 목적지의 이름이다. 그 말은 코어의
                  표면 판정표에 이미 한 줄로 있으므로(`serverSurface`), 여기서 다시
                  적지 않고 그것을 든다. */}
              {isSurfaceProvided("messageSearch") && (
                <SidebarRow
                  to="/search"
                  icon={<Search className="size-4" />}
                  label={serverSurface("messageSearch").label}
                  testId="nav-search"
                />
              )}
              {/* 작업 흐름 sits with the global destinations for the reason
                  에이전트 does (MOMO-652): it is a place you GO, not a thing you
                  are subscribed to. It is also the one work surface that cannot
                  live in the channel drawer beside it — 작업 세션 is scoped to
                  the channel you are already in and, in its most used range, to
                  your own sessions, while someone looking for work to pick up is
                  by definition looking for work that is not theirs (ADR-0143).

                  이 서버가 작업 흐름을 싣지 않으면 줄 자체를 세우지 않는다
                  (goal B12). 비활성으로 남겨 두는 선택지도 있었지만, 흐릿한 줄은
                  "권한이 없다"로 읽히고 그것은 사실이 아니다: 없는 것은 권한이
                  아니라 기능이다. 주소를 직접 열면 라우트가 이유를 말한다. */}
              {isSurfaceProvided("workstreams") && (
                <SidebarRow to="/workstreams" icon={<Milestone className="size-4" />} label="작업 흐름" testId="nav-workstreams" />
              )}
            </ul>

            <SidebarSection
              title="채널"
              action={
                canCreate ? (
                  /* size-control-sm(28px): WCAG 2.2 최소 타깃 24px에 딱 걸치던
                     크기를 하우스 컨트롤 높이로 올린다. 사이드바의 아이콘 버튼
                     셋(+, 새 DM, 설정)이 같은 규격이다. */
                  <button
                    type="button"
                    onClick={openCreateChannel}
                    aria-label="새 채널 만들기"
                    title="새 채널 만들기"
                    data-testid="new-channel"
                    className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Plus className="size-4" />
                  </button>
                ) : rosterSettled ? undefined : (
                  /* 명부를 기다리는 동안 자리만 지킨다. 이 칸이 비면 헤더가
                     18px로 줄었다가 명부가 오는 순간 28px로 뛰어, 아직
                     아무것도 하지 않은 사람의 채널 목록이 한 번 내려앉는다. */
                  <span aria-hidden="true" className="block size-control-sm" />
                )
              }
            >
              {channelsQuery.isLoading && <SkeletonRows rows={4} />}
              {channelsQuery.error && (
                <InlineBanner
                  message="채널을 불러오지 못했습니다."
                  actionLabel="다시 시도"
                  onAction={() => void channelsQuery.refetch()}
                  testId="channels-error"
                />
              )}
              {/* 빈 상태는 한 줄 + 액션 하나다 (SKILL §5). R-1에서는 그 액션을
                  본문 하나로 몰고 여기에는 "+ 또는 ⌘K로 만듭니다."라고만 썼는데,
                  좁은 창이나 스크롤된 상태에서는 그 본문 버튼이 화면 밖일 수
                  있고, 서술형 문장은 지시가 아니며, 문장 첫머리의 +는 글머리표로
                  읽혔다(R2 M6). 그래서 액션을 여기에도 두되 outline이다: 액센트
                  하나는 본문에만 있어 200px 간격으로 primary 둘이 다투지 않고,
                  여기 있는 것은 같은 일로 가는 조용한 두 번째 문이다.
                  만들 수 없는 멤버에게는 여전히 이 목록이 비었다는 사실뿐이고,
                  누가 만들 수 있는지는 본문이 한 번만 말한다. */}
              {!channelsQuery.isLoading && !channelsQuery.error && channels.length === 0 && (
                <EmptyInvite
                  headline="채널 목록이 비어 있습니다."
                  actions={
                    canCreate ? (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={openCreateChannel}
                        data-testid="sidebar-create-channel"
                      >
                        채널 만들기
                      </Button>
                    ) : undefined
                  }
                  testId="channels-empty"
                />
              )}
              {channels.map(rowFor)}
            </SidebarSection>

            {/* DM 0개면 섹션 자체를 접는다 (R-1 §1 빈 상태). 그때의 시작 경로는
                위의 멤버 행과 ⌘⇧K다. */}
            {dms.length > 0 && (
              <SidebarSection
                title="다이렉트 메시지"
                action={
                  <Link
                    to="/directory"
                    aria-label="새 다이렉트 메시지 시작"
                    title="새 다이렉트 메시지 (⌘⇧K)"
                    data-testid="new-dm"
                    className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <SquarePen className="size-4" />
                  </Link>
                }
              >
                {dms.map(rowFor)}
              </SidebarSection>
            )}

            {/* The turn pill covers a bounded number of (channel, agent) pairs.
                Past that bound a row's empty trailing cell means "not watched",
                which looks exactly like "quiet" and is not the same fact, so the
                list names the gap instead of leaving the reader to assume the
                friendlier reading (SKILL §9). Renders nothing until the cap
                actually cuts, which no workspace this size reaches. */}
            {uncovered.length > 0 && (
              <p
                className="px-4 py-2 text-meta text-ink-muted"
                data-testid="agent-coverage-notice"
                title={`에이전트 활동 미표시: ${uncovered
                  .map((c) => c.name ?? c.id)
                  .join(", ")}`}
              >
                에이전트 활동 표시가 한도에 닿았습니다. 위 목록 아래쪽 채널 일부는
                작업 중이어도 표시되지 않습니다.
              </p>
            )}
          </nav>
        </div>

        {/* Above the identity row, not below it: a new build is news, and news
            belongs where the eye already lands when it leaves the channel list.
            Renders nothing at all unless there is something to act on. */}
        <UpdateBadge />

        {/* The identity row is "who I am". The connection dot (①) moved here from
            the workspace rail (검수 #6 / 프레즌스 6a) because "am I attached" reads
            truest next to identity; the load-bearing disconnect signal stays with
            the shell's ConnectionBanner, so nothing is lost on any viewport.
            6b seam: the self declared-status control (away/dnd, ADR-0160 ③) lands
            adjacent here without moving the dot — the avatar below becomes its
            click target, or a button slot opens between the name and the dot. 6a
            adds no presence vocabulary; only the connection indicator moved. */}
        <div className="safe-area-bottom flex items-center gap-2 border-t border-line p-2">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-meta font-semibold"
            aria-hidden="true"
          >
            {selfName.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-body" data-testid="self-name">
            {selfName}
          </span>
          {/* Bound to real connStatus, never decorative (SKILL §8): color and
              accessible name always derive from the status. shrink-0 keeps it in
              place while a long name truncates. */}
          <span
            data-testid="conn-status"
            data-status={connStatus}
            role="img"
            aria-label={connectionCopy(connStatus)}
            title={connectionCopy(connStatus)}
            className={cn(
              "size-2 shrink-0 rounded-sm",
              connectionDotClass(connStatus)
            )}
          />
          <Link
            to="/settings"
            aria-label="설정 열기"
            title="설정 (⌘,)"
            data-testid="nav-settings"
            className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Settings className="size-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
