import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  Hash,
  Inbox,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SquarePen,
  Users,
} from "lucide-react";
import type { Channel } from "@/lib/api";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import {
  agentTurnsInChannel,
  useAgentWorkingSignals,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import {
  agentTurnBadgeCopy,
  UNKNOWN_AGENT_NAME,
} from "@/features/agents/turnCopy";
import { agentCoverage } from "@/features/agents/agentRail";
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
import { canCreateChannel } from "@/features/channels/model";
import { useOpenCreateChannel } from "@/features/channels/useCreateChannel";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { UpdateBadge } from "@/features/updates/UpdateBadge";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { WorkspaceRail } from "./WorkspaceRail";
import { Button } from "@/design/ui/button";

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
  const label = live
    ? copy.label
    : `${copy.label} 연결이 끊겨 갱신이 멈췄습니다. 마지막으로 확인된 상태입니다.`;
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1",
        // Offline (SKILL §5): the pill keeps saying what was last confirmed, but
        // it drops the status color, so a remembered claim does not sit on the
        // row looking exactly as live as a confirmed one.
        !live && "text-ink-muted",
        live && copy.state === "working" && "bg-agent-soft text-agent",
        live && copy.state === "awaiting_approval" && "border border-warn text-warn",
        // Last, and deliberately: tailwind-merge files an unknown text-* class
        // under text-COLOR, so a role written before a color is deleted from the
        // output. cn() now knows these five roles (design/lib/cn.ts) and this
        // order survives either way.
        "text-timestamp"
      )}
      data-testid="agent-turn-badge"
      data-live={live ? "" : undefined}
      data-state={copy.state}
      title={label}
    >
      {/* A bare aria-label on a generic span is not reliably announced, so the
          sentence is real (hidden) text, and the compact half is hidden from
          assistive tech rather than read twice. */}
      <span className="sr-only">{label}</span>
      <span aria-hidden="true">{copy.text}</span>
    </span>
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

  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const readStates = useReadStates(workspaceId);
  const { channels, dms } = channelsQuery.groups;

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
  const openCreateChannel = useOpenCreateChannel();
  const canCreate = canCreateChannel(selfMember?.role);

  // ⌥↑/⌥↓: jump between channels that actually have unread (P11 / Slack
  // grammar). Ordering follows the rendered list so the traversal is visible.
  const ordered = useMemo(() => [...channels, ...dms], [channels, dms]);
  const unreadChannels = useMemo(
    () =>
      ordered.filter((c) => (unreadFor(readStates.byChannel, c.id)?.unreadCount ?? 0) > 0),
    [ordered, readStates.byChannel]
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
    const read = unreadFor(readStates.byChannel, channel.id);
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
        unreadCount={read?.unreadCount ?? 0}
        mentionCount={read?.mentionCount ?? 0}
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
    <div className="flex h-full">
      <WorkspaceRail workspaceName={selfName} connStatus={connStatus} />

      <div className="flex h-full w-full min-w-0 flex-col border-r border-line bg-surface-sidebar">
        <div className="border-b border-line p-2">
          <Button
            variant="outline"
            size="sm"
            className="w-full justify-between"
            onClick={onOpenQuickSwitcher}
            data-testid="open-quick-switcher"
          >
            <span className="flex items-center gap-2">
              <Search className="size-4" />
              검색과 이동
            </span>
            <span className="text-meta text-ink-muted">⌘K</span>
          </Button>
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
          className="min-h-0 flex-1 overflow-y-auto"
          data-testid="channel-list"
        >
          <nav aria-label="워크스페이스 탐색">
            <ul className="flex flex-col px-2 py-2">
              <SidebarRow to="/inbox" icon={<Inbox className="size-4" />} label="인박스" testId="nav-inbox" />
              <SidebarRow to="/activity" icon={<Activity className="size-4" />} label="활동" testId="nav-activity" />
              <SidebarRow to="/directory" icon={<Users className="size-4" />} label="멤버" testId="nav-directory" />
            </ul>

            <SidebarSection
              title="채널"
              action={
                canCreate ? (
                  <button
                    type="button"
                    onClick={openCreateChannel}
                    aria-label="새 채널 만들기"
                    title="새 채널 만들기"
                    data-testid="new-channel"
                    className="flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <Plus className="size-4" />
                  </button>
                ) : undefined
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
              {!channelsQuery.isLoading && !channelsQuery.error && channels.length === 0 && (
                canCreate ? (
                  <EmptyInvite
                    headline="첫 채널을 만들어 팀을 시작하세요."
                    actions={
                      <Button size="sm" onClick={openCreateChannel}>
                        채널 만들기
                      </Button>
                    }
                    testId="channels-empty"
                  />
                ) : (
                  <EmptyInvite
                    headline="아직 채널이 없습니다."
                    detail="채널은 워크스페이스 오너나 관리자가 만들 수 있습니다."
                    testId="channels-empty"
                  />
                )
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
                    className="flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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

        <div className="flex items-center gap-2 border-t border-line p-2">
          <span
            className="flex size-6 shrink-0 items-center justify-center rounded-sm bg-surface-hover text-meta font-semibold"
            aria-hidden="true"
          >
            {selfName.slice(0, 1)}
          </span>
          <span className="min-w-0 flex-1 truncate text-body" data-testid="self-name">
            {selfName}
          </span>
          <Link
            to="/settings"
            aria-label="설정 열기"
            title="설정 (⌘,)"
            data-testid="nav-settings"
            className="flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Settings className="size-4" />
          </Link>
        </div>
      </div>
    </div>
  );
}
