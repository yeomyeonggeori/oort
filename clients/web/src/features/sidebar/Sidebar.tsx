import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import {
  Activity,
  Bot,
  Hash,
  Inbox,
  Lock,
  MessageSquare,
  FolderPlus,
  Milestone,
  Plus,
  Search,
  SquareTerminal,
  SquarePen,
  Users,
  X,
} from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { uuidEq, type Channel } from "@momo/core/lib/api";
import { fetchWorkspace } from "@momo/core/features/settings/api";
import { useSession } from "@/app/session";
import { isSidebarTreeInert } from "@/app/sidebarPane";
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
  workspaceIdentityKey,
  useReadStates,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { canCreateChannelNow } from "@momo/core/features/channels/model";
import {
  useCreateChannelOpen,
  useOpenCreateChannel,
} from "@/features/channels/useCreateChannel";
import {
  isSurfaceProvided,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { UpdateBadge } from "@/features/updates/UpdateBadge";
import { SidebarRow, SidebarSection } from "./SidebarRow";
import { SidebarRowContextMenu } from "./SidebarRowContextMenu";
import { openChannelId } from "./openChannel";
import { roveSidebarRows } from "./sidebarRoving";
import { WorkspaceRail } from "./WorkspaceRail";
import { ProfileCard } from "./ProfileCard";
import { sectionUnreadTotals } from "./sidebarSectionModel";
import { useSidebarPrefs } from "./useSidebarPrefs";
import {
  SectionDeleteConfirmDialog,
  SectionNameDialog,
  SidebarSectionMenu,
} from "./SidebarSectionDialogs";
import {
  deriveSidebarSections,
  SECTION_CREATE_TITLE,
  type RenderedSidebarSection,
} from "@momo/core/features/sidebar/sidebarSections";
import {
  setSidebarSectionCollapsed,
  useSidebarSectionsCollapsed,
} from "./sidebarSectionPreference";
import {
  connectionBarClass,
  connectionCopy,
  showsConnectionBar,
} from "./connStatusIndicator";
import { Button } from "@/design/ui/button";
import type { DialogFocusTarget } from "@/design/ui/dialog";
import { cn } from "@/design/lib/cn";
import { MOVE_UNREAD_CHANNEL_SHORTCUT } from "@/app/keyboardShortcuts";
import { ShortcutHelpDialog } from "@/app/ShortcutHelpDialog";
import { DraftsNavItem } from "@/features/drafts/DraftsNavItem";

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
  channelPaneCollapsed,
  treeHidden,
}: {
  onOpenQuickSwitcher: () => void;
  channelPaneCollapsed: boolean;
  treeHidden: boolean;
}) {
  const { session, workspaceId, connStatus } = useSession();
  const navigate = useNavigate();
  const navRef = useRef<HTMLDivElement>(null);

  // 폰에서 이 사이드바는 서랍이다 (goal B6). 닫혀 있는 동안에는 화면 밖으로
  // 밀려 있을 뿐 DOM에는 남아 있으므로(스크롤 위치와 마운트를 지킨다), 탭 순서와
  // 접근성 트리에서는 `inert`로 빠져야 한다. 데스크톱 접힘(#1864)도 같다: 폭 0
  // 열 안의 검색·행·프로필로 Tab이 들어가면 안 된다. 접힘 전환이 끝나면
  // `hidden`이 트리를 페인트/기하에서 빼 0폭 overflow 상자의 가로 스크롤을
  // 남기지 않는다. 펼침은 hidden을 먼저 걷고 다음 프레임에 폭을 연다.
  const { isMobile, drawerOpen, closeDrawer } = useShellNav();
  const asDrawer = isMobile;
  const drawerRef = useInertWhile<HTMLDivElement>(
    isSidebarTreeInert({
      asDrawer,
      drawerOpen,
      collapsed: channelPaneCollapsed,
    })
  );
  const closeRef = useRef<HTMLButtonElement>(null);
  const collapsedSections = useSidebarSectionsCollapsed();

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
    queryKey: workspaceIdentityKey(workspaceId),
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
  const createChannelOpen = useCreateChannelOpen();
  const newChannelRef = useRef<HTMLButtonElement>(null);
  const rosterSettled = !directoryQuery.isPending;
  const canCreate = canCreateChannelNow(rosterSettled, selfMember?.role);

  // 사이드바 조직화 (ADR-0177 / BT-4 #1932). 부트스트랩 GET 이 도착하기 전에는
  // 배치가 비어 있고, 그때 파생은 오늘까지의 두 섹션과 정확히 같은 것을 돌려준다
  // - 그래서 로딩 중에도 목록이 흔들리지 않는다.
  const sidebarPrefs = useSidebarPrefs(workspaceId);
  const renderedSections = useMemo(
    () =>
      deriveSidebarSections({
        prefs: sidebarPrefs.prefs,
        channels,
        dms,
      }),
    [sidebarPrefs.prefs, channels, dms]
  );
  const baseChannelSection = renderedSections.find(
    (section) => section.kind === "channels"
  ) as RenderedSidebarSection;
  const customSections = renderedSections.filter(
    (section) => section.kind === "custom"
  );
  const dmSection = renderedSections.find(
    (section) => section.kind === "dms"
  ) as RenderedSidebarSection;
  // 행 메뉴의 「섹션으로 이동」이 내미는 목적지들. 코어가 정한 차례 그대로다.
  const sectionChoices = useMemo(
    () => customSections.map((section) => ({ id: section.id, label: section.title })),
    [customSections]
  );

  // 섹션 CRUD 의 열림 상태. 다이얼로그는 사이드바 트리 **밖에** 산다 - 섹션을
  // 지우는 다이얼로그가 그 섹션의 서브트리 안에 있으면 확인을 누르는 순간 자기가
  // 함께 언마운트된다(#1937 H-1 이 채널 나가기에서 치른 값).
  const [nameDialog, setNameDialog] = useState<{
    mode: "create" | "rename";
    sectionId: string | null;
    name: string;
    opener: DialogFocusTarget | null;
  } | null>(null);
  const [deleteDialog, setDeleteDialog] = useState<{
    sectionId: string;
    name: string;
    opener: DialogFocusTarget | null;
  } | null>(null);
  // 메뉴가 열려 있는 섹션. 그동안 그 헤더의 호버 클러스터를 붙들어 둔다.
  const [openSectionMenu, setOpenSectionMenu] = useState<string | null>(null);
  const newSectionRef = useRef<HTMLButtonElement>(null);

  // ⌥↑/⌥↓: jump between channels that actually have unread (P11 / Slack
  // grammar). Ordering follows the rendered list so the traversal is visible -
  // 커스텀 섹션이 생기면 순회도 그 차례로 함께 옮겨간다(ADR-0177 D4 통합).
  const ordered = useMemo(
    () => renderedSections.flatMap((section) => section.channels),
    [renderedSections]
  );

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

  // 행이 보여 주는 안 읽음과 메뉴가 내놓는 「읽음 처리」는 같은 사실이어야 한다
  // (BT-1 / #1929). 배지를 0으로 접는 그 규칙 — 읽고 있는 채널은 읽은 것이다
  // (`openChannel.ts`) — 을 메뉴도 함께 읽는다. 배지가 없는 행이 「읽음 처리」를
  // 내놓으면 둘 중 하나는 거짓말이다.
  const readStateFor = useCallback(
    (channel: Channel) => {
      if (openId !== null && uuidEq(channel.id, openId)) return null;
      return unreadFor(readStates.byChannel, channel.id);
    },
    [openId, readStates.byChannel]
  );

  const unreadChannels = useMemo(
    () => ordered.filter((c) => unreadCountFor(c).unreadCount > 0),
    [ordered, unreadCountFor]
  );
  // ⌥↓ walks this list even when a section is folded. The collapsed header
  // therefore carries the same aggregate the keyboard already visits (M-2).
  //
  // 커스텀 섹션도 같은 자를 쓴다: 접힌 헤더가 이고 있는 수는 그 섹션이 **실제로
  // 그리는 행들**의 합이어야 하고, 배치가 그 목록을 바꾼다.
  const unreadBySection = useMemo(() => {
    const totals = new Map<
      string,
      { unreadCount: number; mentionCount: number }
    >();
    for (const section of renderedSections) {
      totals.set(
        section.id,
        sectionUnreadTotals(section.channels.map(unreadCountFor))
      );
    }
    return totals;
  }, [renderedSections, unreadCountFor]);
  const sectionUnread = useCallback(
    (id: string) =>
      unreadBySection.get(id) ?? { unreadCount: 0, mentionCount: 0 },
    [unreadBySection]
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!MOVE_UNREAD_CHANNEL_SHORTCUT.matches(event)) return;
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

  /**
   * Roving arrow traversal across every row in the sidebar.
   *
   * 규칙과 그 **경계**는 `sidebarRoving.ts` 가 갖는다. 경계가 정본에 있어야
   * 하는 이유는 그 파일 머리말에 있다 — 요약하면, 행이 연 컨텍스트 메뉴는
   * 포털이라 DOM 으로는 밖에 있는데 React 트리로는 여기 자손이라, 메뉴 안에서
   * 누른 ↓ 가 여기까지 올라와 메뉴를 지우고 캐럿을 남의 행으로 옮겼다
   * (design-review #1937 B-1 실측).
   */
  const onNavKeyDown = useCallback((event: React.KeyboardEvent) => {
    roveSidebarRows(navRef.current, event);
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
        // 행에서 바로 조작하는 문 (BT-1 / #1929). 트리거는 링크를 감싸는
        // block 상자이고 탭 정거장이 아니라, 로빙 tabindex 도 ⌥↑↓ 순회도
        // 정거장이 늘지 않는다.
        wrapLink={(link) => (
          <SidebarRowContextMenu
            workspaceId={workspaceId}
            channel={channel}
            title={label.text}
            selfMemberId={session.member.id}
            selfRole={selfMember?.role}
            readState={readStateFor(channel)}
            sections={sectionChoices}
            currentSectionId={sidebarPrefs.sectionIdFor(channel.id)}
            onMoveToSection={(sectionId) =>
              sidebarPrefs.moveChannel(channel.id, sectionId)
            }
          >
            {link}
          </SidebarRowContextMenu>
        )}
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
        avatarUrl={workspaceQuery.data?.avatarUrl}
        hidden={treeHidden}
      />

      <div
        id="sidebar-channel-pane"
        hidden={treeHidden}
        data-sidebar-channel-pane
        data-testid="sidebar-channel-pane"
        className="flex h-full w-full min-w-0 flex-col border-r border-line bg-surface-sidebar"
      >
        <div className="flex items-center gap-2 border-b border-line p-2">
          {/* 데스크톱 접기 토글은 타이틀바에 한 자리만 산다 (#1864). 여기 두면
              접는 순간 입구가 사라진다. */}
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
                적어 두면 그만큼의 폭을 쓰면서 아무것도 알려주지 않는다.

                #1384: 이 앱의 키 힌트 표기는 한 벌이고(코어 `composerCopy.ts`
                의 「키보드 힌트의 표기법」) 이 자리가 이미 그 표기다 —
                `wide-only` · `text-meta` · `text-ink-muted` · 테두리 없는 산문.
                동사가 없는 이유는 이 조각을 담은 버튼의 이름이 곧 동사라서다
                ("검색과 이동"). 힌트 줄에서는 `<키>로 <동사>`로 적는다. */}
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
            className="mobile-only tap-target flex size-control shrink-0 items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
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
              <DraftsNavItem />
              <SidebarRow to="/activity" icon={<Activity className="size-4" />} label="활동" testId="nav-activity" />
              <SidebarRow to="/directory" icon={<Users className="size-4" />} label="멤버" testId="nav-directory" />
              <SidebarRow to="/agents" icon={<Bot className="size-4" />} label="에이전트" testId="nav-agents" />
              {/* TC-1 (#1758): 전역 작업 세션 목록. 채널 헤더 터미널은
                  도크이고, 우측 WorkPanel 은 이 경로의 `open-work-panel` 이
                  연다. 표면 삭제 금지. */}
              <SidebarRow
                to="/work"
                icon={<SquareTerminal className="size-4" />}
                label="작업 콘솔"
                testId="nav-work-console"
              />
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

            {/* 저장 실패는 사이드바가 그 자리에서 말한다 (§5, 토스트가 아니다).
                되돌린 뒤라 화면은 이미 서버가 준 배치이고, 이 문장이 없으면
                사람이 방금 만든 섹션이 조용히 사라진 것으로만 보인다. */}
            {sidebarPrefs.error && (
              <InlineBanner
                message={sidebarPrefs.error}
                actionLabel="닫기"
                onAction={sidebarPrefs.dismissError}
                testId="sidebar-prefs-error"
              />
            )}

            <SidebarSection
              title={baseChannelSection.title}
              sectionId={baseChannelSection.id}
              collapsed={collapsedSections[baseChannelSection.id] === true}
              onCollapsedChange={(next) =>
                setSidebarSectionCollapsed(baseChannelSection.id, next)
              }
              overlayOpen={createChannelOpen || nameDialog?.mode === "create"}
              unreadCount={sectionUnread(baseChannelSection.id).unreadCount}
              mentionCount={sectionUnread(baseChannelSection.id).mentionCount}
              action={
                <>
                  {canCreate ? (
                  /* size-control-sm(28px): WCAG 2.2 최소 타깃 24px에 딱 걸치던
                     크기를 하우스 컨트롤 높이로 올린다. 사이드바의 아이콘 버튼
                     셋(+ · 새 DM)이 같은 규격이다. 설정은 프로필 카드 행으로
                     이사했다. */
                  <button
                    ref={newChannelRef}
                    type="button"
                    onClick={() => openCreateChannel(newChannelRef.current)}
                    aria-label="새 채널 만들기"
                    title="새 채널 만들기"
                    data-testid="new-channel"
                    data-section-action=""
                    className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
                  >
                    <Plus className="size-4" aria-hidden="true" />
                  </button>
                  ) : rosterSettled ? null : (
                    /* 명부를 기다리는 동안 자리만 지킨다. 호버 클러스터가 열렸을
                       때만 마운트되므로 rest 헤더 높이는 흔들리지 않는다. */
                    <span aria-hidden="true" className="block size-control-sm" />
                  )}
                  {/* 섹션을 만드는 문은 여기 하나다 (ADR-0177 D4). 채널을 만드는
                      +와 나란히 서지만 다른 일이다: +는 워크스페이스에 방을
                      만들고, 이것은 **내 사이드바**를 정리한다. 그래서 권한을
                      묻지 않는다 - 섹션은 멤버 소유라 누구나 만들 수 있다(D1). */}
                  {sidebarPrefs.canCreate && (
                    <button
                      ref={newSectionRef}
                      type="button"
                      onClick={() =>
                        setNameDialog({
                          mode: "create",
                          sectionId: null,
                          name: "",
                          opener: newSectionRef.current,
                        })
                      }
                      aria-label={SECTION_CREATE_TITLE}
                      title={SECTION_CREATE_TITLE}
                      data-testid="new-section"
                      data-section-action=""
                      className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
                    >
                      <FolderPlus className="size-4" aria-hidden="true" />
                    </button>
                  )}
                </>
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
                        onClick={() => openCreateChannel()}
                        data-testid="sidebar-create-channel"
                      >
                        채널 만들기
                      </Button>
                    ) : undefined
                  }
                  testId="channels-empty"
                />
              )}
              {baseChannelSection.channels.map(rowFor)}
            </SidebarSection>

            {/* 커스텀 섹션 (ADR-0177 D1/D4). 기본 「채널」과 DM 사이에 서는 이유는
                코어의 `deriveSidebarSections` 머리말에 있다 - 섹션 하나를 만들
                때 목록의 대부분이 아래로 밀리지 않게. 접기·unread 집계·호버
                액션·⌥↑↓ 는 기본 섹션과 **같은 기계**를 탄다: 이 루프가 넘기는
                프롭이 위 SidebarSection 이 받는 것과 한 벌이다. */}
            {customSections.map((section) => (
              <SidebarSection
                key={section.id}
                title={section.title}
                sectionId={section.id}
                collapsed={collapsedSections[section.id] === true}
                onCollapsedChange={(next) =>
                  setSidebarSectionCollapsed(section.id, next)
                }
                overlayOpen={
                  openSectionMenu === section.id ||
                  nameDialog?.sectionId === section.id ||
                  deleteDialog?.sectionId === section.id
                }
                unreadCount={sectionUnread(section.id).unreadCount}
                mentionCount={sectionUnread(section.id).mentionCount}
                action={
                  <SidebarSectionMenu
                    sectionId={section.id}
                    title={section.title}
                    onOpenChange={(open) =>
                      setOpenSectionMenu(open ? section.id : null)
                    }
                    onRename={(opener) =>
                      setNameDialog({
                        mode: "rename",
                        sectionId: section.id,
                        name: section.title,
                        opener,
                      })
                    }
                    onDelete={(opener) =>
                      setDeleteDialog({
                        sectionId: section.id,
                        name: section.title,
                        opener,
                      })
                    }
                  />
                }
              >
                {/* 빈 섹션은 만든 직후의 정상 상태다. 「채널을 여기로 옮기세요」
                    한 줄이 없으면 방금 만든 섹션이 고장난 것처럼 보인다. */}
                {section.channels.length === 0 && (
                  <li className="px-2 py-1 text-meta text-ink-muted">
                    채널 행을 우클릭해 이 섹션으로 옮길 수 있습니다.
                  </li>
                )}
                {section.channels.map(rowFor)}
              </SidebarSection>
            ))}

            {/* DM 0개면 섹션 자체를 접는다 (R-1 §1 빈 상태). 그때의 시작 경로는
                위의 멤버 행과 ⌘⇧K다. */}
            {dmSection.channels.length > 0 && (
              <SidebarSection
                title={dmSection.title}
                sectionId={dmSection.id}
                collapsed={collapsedSections[dmSection.id] === true}
                onCollapsedChange={(next) =>
                  setSidebarSectionCollapsed(dmSection.id, next)
                }
                unreadCount={sectionUnread(dmSection.id).unreadCount}
                mentionCount={sectionUnread(dmSection.id).mentionCount}
                action={
                  <Link
                    to="/directory"
                    aria-label="새 다이렉트 메시지 시작"
                    title="새 다이렉트 메시지 (⌘⇧K)"
                    data-testid="new-dm"
                    data-section-action=""
                    className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring"
                  >
                    <SquarePen className="size-4" aria-hidden="true" />
                  </Link>
                }
              >
                {dmSection.channels.map(rowFor)}
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

        {/* The identity row is "who I am". Two DIFFERENT facts can appear here and
            ADR-0160 keeps them apart (guard 6) — 6b design-review H1 is what made
            the separation real rather than asserted:
            • the presence badge (③) is on the avatar: the declared status
              (auto/away/dnd) as a ROUND badge, the universally read presence
              spot. It is the only thing on this row that is ever green.
            • the connection indicator (①, moved here in 6a) is a BAR next to
              the card, and only when the rail is unhealthy.
            UX-D4 (#1756) made the whole row the profile-card trigger: status
            radios, the rail's 워크스페이스 추가, and settings live in that
            card. The collapse control lives on the titlebar (#1864). */}
        <div className="safe-area-bottom flex items-center gap-2 border-t border-line p-2">
          <ProfileCard
            workspaceId={workspaceId}
            selfMemberId={session.member.id}
            selfMember={selfMember}
            selfName={selfName}
            connected={connStatus === "connected"}
          />
          {/* Bound to real connStatus, never decorative (SKILL §8): the colour and
              the accessible name both derive from the status, and while connected
              the element is not rendered at all. 12x4 bar = the workspace rail's
              marker grammar, deliberately not the avatar badge's circle.
              shrink-0 keeps it in place while a long name truncates. */}
          {showsConnectionBar(connStatus) && (
            <span
              data-testid="conn-status"
              data-status={connStatus}
              role="img"
              aria-label={connectionCopy(connStatus)}
              title={connectionCopy(connStatus)}
              className={cn(
                "h-1 w-3 shrink-0 rounded-full",
                connectionBarClass(connStatus)
              )}
            />
          )}
          <ShortcutHelpDialog />
        </div>
      </div>

      {/* 섹션 다이얼로그는 목록 **밖에** 산다. 안에 두면 삭제 확인이 자기가 지우는
          섹션의 서브트리 안에 있게 되고, 확인을 누르는 순간 함께 언마운트된다 -
          #1937 H-1 이 채널 나가기에서 정확히 그 값을 치렀다. */}
      <SectionNameDialog
        mode={nameDialog?.mode ?? "create"}
        open={nameDialog !== null}
        initialName={nameDialog?.name ?? ""}
        opener={nameDialog?.opener ?? null}
        onOpenChange={(next) => {
          if (!next) setNameDialog(null);
        }}
        onSubmit={(name) => {
          if (nameDialog?.mode === "rename" && nameDialog.sectionId) {
            sidebarPrefs.renameSection(nameDialog.sectionId, name);
          } else {
            sidebarPrefs.createSection(name);
          }
        }}
      />
      <SectionDeleteConfirmDialog
        open={deleteDialog !== null}
        name={deleteDialog?.name ?? ""}
        opener={deleteDialog?.opener ?? null}
        onOpenChange={(next) => {
          if (!next) setDeleteDialog(null);
        }}
        onConfirm={() => {
          if (deleteDialog) sidebarPrefs.deleteSection(deleteDialog.sectionId);
        }}
      />
    </div>
  );
}
