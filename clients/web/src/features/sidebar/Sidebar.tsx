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
import { composedUnreadCount } from "@momo/core/features/readState/model";
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
  SidebarSortMenu,
} from "./SidebarSectionDialogs";
import {
  deriveSidebarSections,
  SECTION_CREATE_TITLE,
  sidebarEmptySectionHint,
  sidebarSectionCapMessage,
  SIDEBAR_PREFS_LOAD_RETRY_LABEL,
  SIDEBAR_STARRED_TOUCH_HINT,
} from "@momo/core/features/sidebar/sidebarSections";
import { useSidebarDrag, type SidebarDropAction } from "./sidebarDnd";
import { scheduleSidebarChannelRowFocus } from "./sidebarRowFocus";
import { useHoverNone } from "@/features/emoji/useHoverNone";
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
  const derived = useMemo(
    () =>
      deriveSidebarSections({
        prefs: sidebarPrefs.prefs,
        channels,
        dms,
      }),
    [sidebarPrefs.prefs, channels, dms]
  );
  // 캐스트 없음 (design-review #1932 N-2): 기본 두 섹션이 언제나 있다는 것은
  // 코어의 계약이고, 이제 **타입이** 그렇게 말한다.
  const renderedSections = derived.sections;
  const starredSection = derived.starred;
  const baseChannelSection = derived.base;
  const customSections = derived.custom;
  const dmSection = derived.dms;

  // 터치 표면에는 배치의 문(행 컨텍스트 메뉴)이 없다 - BT-1 이 서랍 스크롤과의
  // 충돌 때문에 의도적으로 닫아 둔 자리다. 그런데 만들기·이름 바꾸기·삭제는
  // 열려 있었다: 만들 수는 있는데 쓸 수 없는 그릇이고, 화면은 쓸 수 있다고
  // 말했다(design-review #1932 H-1). 배치를 줄 수 없는 표면에서는 섹션 편집
  // 자체를 내밀지 않는다. 로밍해 온 섹션은 그대로 그린다 - 읽는 것은 언제나
  // 참이고, 그 채널들을 여는 것이 폰에서 이 섹션이 하는 일이다.
  const touchSurface = useHoverNone();
  const canEditSections = sidebarPrefs.canEdit && !touchSurface;
  // 행 메뉴의 「섹션으로 이동」이 내미는 목적지들. 코어가 정한 차례 그대로다.
  const sectionChoices = useMemo(
    () => customSections.map((section) => ({ id: section.id, label: section.title })),
    [customSections]
  );

  // 끌어다 놓기 (BT-5 #1933). 문이 서는 조건은 편집 문과 **같은 하나**다
  // (`canEditSections`): 배치를 못 읽은 상태에서도, 터치 표면에서도 손잡이가
  // 없다. 떨어진 결과는 전부 위 훅의 변경 함수로 되돌아가므로 저장 경로는
  // 하나로 남는다(ADR-0177 D2 디바운스·롤백·배너를 그대로 탄다).
  const onSidebarDrop = useCallback(
    (action: SidebarDropAction) => {
      if (action.type === "place") {
        sidebarPrefs.moveChannel(action.channelId, action.sectionId);
        // **행을 옮기는 액션은 캐럿을 데리고 간다** — 이 규칙의 넷째 문
        // (design-review R2-1). 행 메뉴의 셋은 R1 에서 닫혔는데 드롭만 남아
        // 있었다: 실측으로 링크의 mousedown 이 캐럿을 끌리는 행으로 옮기고,
        // 그 행이 옮겨가면서 캐럿이 `<body>` 에 떨어졌다 — **끌지 않은 다른
        // 행에 캐럿이 있었어도** 같았다. 정본은 행 메뉴와 같은 모듈이다.
        scheduleSidebarChannelRowFocus(action.channelId);
      } else if (action.type === "star") {
        sidebarPrefs.toggleStar(action.channelId);
        scheduleSidebarChannelRowFocus(action.channelId);
      } else {
        // 섹션 차례는 행을 옮기지 않는다 — 옮겨 가는 것은 머리글이고, 머리글은
        // 정거장이 아니다(접기 버튼이 자기 자리에 그대로 남는다). 넘길 캐럿이
        // 없으므로 여기서는 부르지 않는다.
        sidebarPrefs.reorderSection(action.sectionId, action.targetId);
      }
    },
    [sidebarPrefs]
  );
  const drag = useSidebarDrag({
    enabled: canEditSections,
    onDrop: onSidebarDrop,
  });

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
        unreadCount: read ? composedUnreadCount(read) : 0,
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

  /**
   * 한 채널 행. `options.inStarredSection` 은 이 행이 **파생 「별표」 섹션에**
   * 그려지고 있다는 뜻이고, 그때는 끌 수 없다 (BT-5 #1933).
   *
   * 판정은 「눌러서 아무 일도 없는 문은 문이 아니다」다: 별표 섹션이 렌더 순위를
   * 먼저 가져가므로(코어 `deriveSidebarSections`), 별표 붙은 행을 다른 섹션에
   * 떨어뜨려도 payload 의 배치만 바뀌고 **화면에서는 아무 일도 일어나지 않는다**.
   * 사람은 그것을 실패로 읽는다. 배치를 바꾸고 싶으면 별표를 떼거나, 행 메뉴의
   * 「섹션으로 이동」 라디오를 쓴다 - 그 무리는 별표 행에도 그대로 서 있고 지금
   * 배치가 체크로 들린다.
   */
  function rowFor(
    channel: Channel,
    options: { inStarredSection?: boolean } = {}
  ) {
    const counts = unreadCountFor(channel);
    // A DM row is named after a person, and this workspace holds two members
    // called 김인턴, so the row carries the handle whenever the name alone does
    // not decide which one it is (channelLabelParts).
    const label = channelLabelParts(
      channel,
      directoryQuery.directory,
      session.member.id
    );
    const currentSectionId = sidebarPrefs.sectionIdFor(channel.id);
    const canDragRow =
      canEditSections &&
      channel.kind !== "dm" &&
      options.inStarredSection !== true;
    return (
      <SidebarRow
        key={channel.id}
        to={`/c/${channel.id}`}
        dragProps={
          canDragRow
            ? drag.dragProps({
                kind: "channel",
                channelId: channel.id,
                sectionId: currentSectionId,
              })
            : undefined
        }
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
            sections={canEditSections ? sectionChoices : undefined}
            currentSectionId={currentSectionId}
            onMoveToSection={
              canEditSections
                ? (sectionId) => sidebarPrefs.moveChannel(channel.id, sectionId)
                : undefined
            }
            starred={sidebarPrefs.isStarred(channel.id)}
            onToggleStar={
              canEditSections
                ? () => sidebarPrefs.toggleStar(channel.id)
                : undefined
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

            {/* 배치에 대해 사이드바가 하는 말은 **한 번에 하나**다.
 
                · 읽기 실패(design-review #1932 B-1): 배치를 한 번도 못 읽었다.
                  이 문장이 없던 동안 화면은 「섹션이 아직 없다」와 똑같이 생겼고,
                  그 위의 편집 하나가 서버의 배치를 통째로 지웠다. 편집 문은 위에서
                  이미 닫혔으므로 여기 남는 일은 **무슨 일인지 말하고 되돌아갈 길을
                  주는 것**이고, 「채널을 불러오지 못했습니다」와 같은 배너·같은
                  액션 문법이다.
                · 저장 실패: 되돌린 뒤라 화면은 이미 서버가 준 배치이고, 이 문장이
                  없으면 방금 만든 섹션이 조용히 사라진 것으로만 보인다.
 
                둘을 겹쳐 세우지 않는 이유: 읽지 못한 상태에서 훅이 쓰기를 거절할
                때 그 사유가 곧 읽기 실패라, 배너 둘이 같은 문장을 두 번 말하게
                된다. 읽기 실패가 더 근본이므로 그것이 이긴다. */}
            {sidebarPrefs.loadError ? (
              <InlineBanner
                message={sidebarPrefs.loadError}
                actionLabel={SIDEBAR_PREFS_LOAD_RETRY_LABEL}
                onAction={sidebarPrefs.retryLoad}
                testId="sidebar-prefs-load-error"
              />
            ) : sidebarPrefs.error ? (
              <InlineBanner
                message={sidebarPrefs.error}
                actionLabel="닫기"
                onAction={sidebarPrefs.dismissError}
                testId="sidebar-prefs-error"
              />
            ) : null}

            {/* 「별표」는 **파생**이다 (ADR-0177 D5 / BT-5 #1933): payload 에 이
                섹션은 없고 `starredChannelIds` 뿐이며, 코어가 그것을 목록으로
                조립한다. 맨 위에 서고, 비면 코어가 아예 내놓지 않는다 - 빈 그릇을
                그리지 않는 판정이 표면이 아니라 파생에 있어야 웹과 폰이 같은 수의
                섹션을 센다(`DerivedSidebarSections.sections` 머리말).

                이름 바꾸기도 삭제도 차례 바꾸기도 없다(기본 섹션 문법), 그래서
                ⋮ 가 없다. 대신 드롭은 받는다 - 여기 떨어뜨리는 것은 배치가 아니라
                별표를 붙이는 일이고, 그 뜻은 `resolveSidebarDrop` 이 갖는다. */}
            {starredSection.channels.length > 0 && (
              <SidebarSection
                title={starredSection.title}
                sectionId={starredSection.id}
                collapsed={collapsedSections[starredSection.id] === true}
                onCollapsedChange={(next) =>
                  setSidebarSectionCollapsed(starredSection.id, next)
                }
                unreadCount={sectionUnread(starredSection.id).unreadCount}
                mentionCount={sectionUnread(starredSection.id).mentionCount}
                dropProps={drag.dropProps({ kind: "starred", sectionId: null })}
              >
                {starredSection.channels.map((channel) =>
                  rowFor(channel, { inStarredSection: true })
                )}
                {/* 터치에는 **떼는 문이 없다**, 그리고 그 사실을 말한다
                    (design-review R1 M-1). 별표는 로밍하므로 넓은 화면에서 붙인
                    것이 폰 서랍에 그려지는데, 그 표면에는 행 메뉴도 드래그도 없다.
                    빈 커스텀 섹션이 터치에서 하는 말과 같은 문법·같은 자리다 -
                    표면이 자기 문에 대해 참말을 한다(BT-4 H-1 규율). */}
                {touchSurface && (
                  <li className="px-2 py-1 text-meta text-ink-muted">
                    {SIDEBAR_STARRED_TOUCH_HINT}
                  </li>
                )}
              </SidebarSection>
            )}

            <SidebarSection
              title={baseChannelSection.title}
              sectionId={baseChannelSection.id}
              collapsed={collapsedSections[baseChannelSection.id] === true}
              onCollapsedChange={(next) =>
                setSidebarSectionCollapsed(baseChannelSection.id, next)
              }
              dropProps={drag.dropProps({ kind: "channels", sectionId: null })}
              overlayOpen={
                createChannelOpen ||
                nameDialog?.mode === "create" ||
                openSectionMenu === baseChannelSection.id
              }
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
                      묻지 않는다 - 섹션은 멤버 소유라 누구나 만들 수 있다(D1).

                      **문이 서는 조건은 `canEditSections` 하나다**(B-1/H-1):
                      배치를 읽지 못한 동안에도, 배치를 줄 수 없는 표면에서도 이
                      문은 없다. 상한(50)은 다르다 - 그때는 문을 지우지 않고
                      비활성으로 남기고 **사유를 이름으로 든다**(M-3). 사라진 문과
                      아직 못 찾은 문을 사람은 구분하지 못한다. */}
                  {canEditSections && (
                    <button
                      ref={newSectionRef}
                      type="button"
                      disabled={!sidebarPrefs.canCreate}
                      onClick={() =>
                        setNameDialog({
                          mode: "create",
                          sectionId: null,
                          name: "",
                          opener: newSectionRef.current,
                        })
                      }
                      aria-label={
                        sidebarPrefs.canCreate
                          ? SECTION_CREATE_TITLE
                          : sidebarSectionCapMessage()
                      }
                      title={
                        sidebarPrefs.canCreate
                          ? SECTION_CREATE_TITLE
                          : sidebarSectionCapMessage()
                      }
                      data-testid="new-section"
                      data-section-action=""
                      className="tap-target flex size-control-sm items-center justify-center rounded-sm text-ink-muted transition-colors hover:bg-surface-hover focus-visible:focus-ring disabled:pointer-events-none disabled:opacity-50"
                    >
                      <FolderPlus className="size-4" aria-hidden="true" />
                    </button>
                  )}
                  {/* 정렬의 문은 **여기 하나**다 (BT-5 #1933). 값이 사이드바 전체에
                      하나뿐이라(payload 의 `sectionSort` 한 칸) 섹션마다 같은
                      라디오를 세우면 「이 섹션의 정렬」로 읽히고, 하나를 바꿀 때
                      전부 바뀌는 것이 결함이 된다. 이 헤더인 이유는 그것이 이미
                      **사이드바의 선반**이기 때문이다 - 「새 섹션」도 채널 섹션의
                      일이 아니라 사이드바의 일이고 같은 자리에 산다.

                      커스텀 섹션이 하나도 없어도 서야 한다: 정렬은 섹션을 만들어야
                      열리는 설정이 아니다.

                      **자기 글리프와 자기 이름을 갖는다**(design-review R1 M-2):
                      섹션 ⋮ 안에 들어 있던 동안에는 스크린리더가 「채널 섹션 메뉴」로
                      읽었고, 같은 ⋯ 이 섹션마다 다른 메뉴를 열었다. 근거는
                      `SidebarSortMenu` 머리말에 있다.

                      **터치에는 없다** — BT-4 H-1 의 규율을 그대로 승계한다. 정렬
                      자체는 손가락으로도 멀쩡히 동작하므로 이것은 「없는 문」이
                      아니라 **밀도 판정**이다: `hover: none` 에서는 헤더의 액션이
                      상시 마운트라(`shouldShowSectionActions`) 240px 서랍의 머리글에
                      아이콘이 하나 더 영구히 서고, 그 값을 두 번째 순위의 설정이
                      치를 이유가 없다. 폰이 정렬을 갖게 되는 날의 자리는 이 헤더가
                      아니라 폰의 설정 표면이다. */}
                  {canEditSections && (
                    <SidebarSortMenu
                      mode={sidebarPrefs.sortMode}
                      onChange={sidebarPrefs.setSortMode}
                      onOpenChange={(open) =>
                        setOpenSectionMenu(open ? baseChannelSection.id : null)
                      }
                    />
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
              {baseChannelSection.channels.map((channel) => rowFor(channel))}
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
                // 커스텀 섹션은 **둘 다** 한다: 채널을 받고(배치), 자기가 끌려
                // 가면 차례가 바뀐다. 두 뜻이 한 구역에 겹치는 것이 아니라
                // 「무엇이 떨어졌는가」가 가른다(`resolveSidebarDrop`).
                dropProps={drag.dropProps({
                  kind: "custom",
                  sectionId: section.id,
                })}
                headerDragProps={
                  canEditSections
                    ? drag.dragProps({ kind: "section", sectionId: section.id })
                    : undefined
                }
                action={
                  canEditSections ? (
                  <SidebarSectionMenu
                    sectionId={section.id}
                    title={section.title}
                    order={{
                      canUp: sidebarPrefs.canMoveSection(section.id, -1),
                      canDown: sidebarPrefs.canMoveSection(section.id, 1),
                      onMove: (delta) =>
                        sidebarPrefs.moveSection(section.id, delta),
                    }}
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
                  ) : undefined
                }
              >
                {/* **로딩은 빈 상태가 아니다** (design-review #1932 H-2). 채널
                    목록이 오는 동안 이 자리는 「비었다」고 말했고, 바로 스무 줄
                    위에서 기본 섹션은 같은 프레임에 스켈레톤을 그리고 있었다.
                    실제로 채널을 가진 섹션이 「여기로 옮기세요」라고 말하면
                    사람은 이미 있는 배치를 다시 만든다. 답이 위에 있으므로 그것을
                    쓴다 - 커스텀 섹션은 보통 짧으니 두 줄. */}
                {channelsQuery.isLoading && <SkeletonRows rows={2} />}
                {/* 빈 섹션은 만든 직후의 정상 상태다. 한 줄이 없으면 방금 만든
                    섹션이 고장난 것처럼 보인다. 낱말은 **표면마다 다르다**(H-1):
                    터치에는 우클릭이 없으므로 그 문장은 없는 동작을 지시한다.
                    채널 목록 자체가 실패했으면 아무 말도 하지 않는다 - 그 사실은
                    기본 섹션의 배너가 이미 한 번 말했고, 섹션마다 되풀이하면 한
                    번의 실패가 N개의 문장이 된다. */}
                {!channelsQuery.isLoading &&
                  !channelsQuery.error &&
                  section.channels.length === 0 && (
                    <li className="px-2 py-1 text-meta text-ink-muted">
                      {sidebarEmptySectionHint(!touchSurface)}
                    </li>
                  )}
                {section.channels.map((channel) => rowFor(channel))}
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
                {dmSection.channels.map((channel) => rowFor(channel))}
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
