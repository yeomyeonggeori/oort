import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  Activity,
  Hash,
  Inbox,
  Lock,
  MessageSquare,
  Search,
  Settings,
  SquarePen,
  Users,
} from "lucide-react";
import type { Channel } from "@/lib/api";
import { useSession } from "@/app/session";
import {
  channelLabelParts,
  memberFor,
  unreadFor,
  useChannels,
  useDirectory,
  useReadStates,
  type Directory,
} from "@/features/workspace/useWorkspace";
import {
  elapsedLabel,
  useAgentWorkingSignals,
  useTickingNow,
  workingInChannel,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
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
 * Working pill on a channel row (R-1 §1, mac AgentWorkingChannelBadge). It reads
 * as the agent's clock rather than as a status dot: the number ticks once a
 * second because that is how fast the thing it measures changes, and it carries
 * the agent token so a turn is never confused with an unread count.
 *
 * With more than one agent working the same channel the count leads and the
 * clock belongs to the LONGEST running turn, which is the one a reader is most
 * likely to be waiting on.
 */
function AgentTurnBadge({
  active,
  directory,
  nowMs,
}: {
  active: AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
}) {
  if (active.length === 0) return null;
  const oldest = active[0];
  const name = memberFor(directory, oldest.memberId)?.displayName ?? "에이전트";
  const label =
    active.length > 1
      ? `에이전트 ${active.length}명이 작업 중입니다`
      : `${name}이(가) 작업 중입니다`;
  return (
    <span
      className="shrink-0 rounded-sm bg-agent-soft px-1 text-timestamp text-agent"
      data-numeric
      data-testid="agent-turn-badge"
      title={label}
    >
      {/* A bare aria-label on a generic span is not reliably announced, so the
          sentence a clock alone cannot carry is real (hidden) text. */}
      <span className="sr-only">{label} </span>
      {active.length > 1 ? `(${active.length}) ` : ""}
      {oldest.startedAtMs === undefined
        ? "작업 중"
        : elapsedLabel(oldest.startedAtMs, nowMs)}
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

  // One clock for the whole list, and only while an agent is actually working:
  // a per-row interval would mean ten timers to render one number each.
  const workingSignals = useAgentWorkingSignals();
  const nowMs = useTickingNow(workingSignals.size > 0);

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
            active={workingInChannel(workingSignals, channel.id, nowMs)}
            directory={directoryQuery.directory}
            nowMs={nowMs}
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

            <SidebarSection title="채널">
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
                <EmptyInvite
                  headline="첫 채널을 만들어 팀을 시작하세요."
                  actions={
                    <Button size="sm" asChild>
                      <Link to="/settings">채널 만들기</Link>
                    </Button>
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
                    className="flex size-6 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    <SquarePen className="size-4" />
                  </Link>
                }
              >
                {dms.map(rowFor)}
              </SidebarSection>
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
