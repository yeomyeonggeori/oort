import { useCallback, useEffect, useMemo, useRef } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, Hash, Inbox, Lock, MessageSquare, Search, Settings } from "lucide-react";
import type { Channel } from "@/lib/api";
import { useSession } from "@/app/session";
import {
  channelLabel,
  memberFor,
  unreadFor,
  useChannels,
  useDirectory,
  useReadStates,
} from "@/features/workspace/useWorkspace";
import {
  elapsedLabel,
  useAgentWorkingSignals,
  workingInChannel,
} from "@/features/agents/agentWorkingSignal";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { WorkspaceRail } from "./WorkspaceRail";
import { Button } from "@/design/ui/button";

// =============================================================================
// Sidebar (R-1 §1): workspace header, the two global surfaces (인박스 / 활동),
// channels, DMs, and the settings entry. Real momowebqa data throughout: the
// unread numbers come from the server read-state projection (P7), never from a
// local count, so they match on every device.
// =============================================================================

function AgentTurnBadge({ channelId }: { channelId: string }) {
  const signals = useAgentWorkingSignals();
  const active = workingInChannel(signals, channelId);
  if (active.length === 0) return null;
  const oldest = active[0];
  return (
    <span
      className="shrink-0 text-timestamp text-ink-muted"
      data-numeric
      data-testid="agent-turn-badge"
      title="에이전트가 턴을 진행 중입니다"
    >
      {elapsedLabel(oldest.startedAtMs, Date.now())}
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
    const label = channelLabel(channel, directoryQuery.directory, session.member.id);
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
        label={label}
        unreadCount={read?.unreadCount ?? 0}
        mentionCount={read?.mentionCount ?? 0}
        trailing={<AgentTurnBadge channelId={channel.id} />}
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

            {/* DM 0개면 섹션 자체를 접는다 (R-1 §1 빈 상태). */}
            {dms.length > 0 && (
              <SidebarSection title="다이렉트 메시지">{dms.map(rowFor)}</SidebarSection>
            )}
          </nav>
        </div>

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
