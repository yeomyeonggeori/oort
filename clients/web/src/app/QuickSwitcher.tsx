import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { AnimatePresence, usePresence, useReducedMotion } from "motion/react";
import {
  Activity,
  Bot,
  FileText,
  Hash,
  Inbox,
  Lock,
  MessageSquare,
  Plus,
  Search,
  Settings,
  User,
  Users,
} from "lucide-react";
import { useSession } from "@/app/session";
import {
  channelLabelParts,
  dmPeer,
  memberFor,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { switcherPeople } from "@momo/core/features/directory/model";
import { useOpenDm } from "@/features/directory/useOpenDm";
import { canCreateChannelNow } from "@momo/core/features/channels/model";
import {
  useCreateChannelOpen,
  useOpenCreateChannel,
} from "@/features/channels/useCreateChannel";
import { useAddChannelMemberOpen } from "@/features/channels/useAddChannelMember";
import {
  useAgentProfileOpen,
  useOpenAgentProfile,
} from "@/features/routing/useAgentProfile";
import { useAddWorkspaceOpen } from "@/features/workspace/useAddWorkspace";
import { useDraftsPanel } from "@/features/drafts/useDraftsPanel";
import { InlineBanner } from "@/features/common/States";
import {
  isSurfaceProvided,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import {
  channelIdInPath,
  searchEntryLabel,
  searchRoutePath,
} from "@momo/core/features/search/searchModel";
import {
  OPEN_NEW_DM_SHORTCUT,
  OPEN_QUICK_SWITCHER_SHORTCUT,
  OPEN_SETTINGS_SHORTCUT,
} from "@/app/keyboardShortcuts";
import { rememberSettingsOpener } from "@/features/settings/settingsFocus";
import { Dialog, DialogOverlay, DialogPortal } from "@/design/ui/dialog";
import { MODAL_CONTENT_MOTION } from "@/design/motion";
import { cn } from "@/design/lib/cn";

// =============================================================================
// ⌘K quick switcher (R-1 §공통계약, ADR-0133 stack: cmdk). Channels, DMs, people
// and the global surfaces in one list. Arrow keys move, Enter opens, Esc closes:
// cmdk owns that grammar, so no custom key handling beyond the ⌘K toggle.
//
// 사람 (parity G-3/G-4) is a section of the SAME palette rather than a second
// picker: "누구와 이야기할까"는 "어디로 갈까"의 한 갈래다. Choosing a person goes
// through the same useOpenDm path a directory row uses, so an existing
// conversation is reused instead of a second one being created.
// =============================================================================

// cmdk writes data-disabled on the item it refuses to select. Without a rule
// for it an unselectable name rendered exactly like a selectable one, so the
// list showed rows that answer nothing to Enter and look like rows that do.
// opacity-50 is the same dimming Button, Input and the directory row already
// use for disabled, so the palette does not invent a second dialect for the
// same state; and dimmed text below AA is what WCAG 1.4.3 exempts inactive
// controls for, which is exactly what this row is.
const itemClass =
  "flex cursor-default items-center gap-2 rounded-sm px-2 py-1 text-body " +
  "text-ink data-[selected=true]:bg-accent-soft " +
  "data-[selected=true]:text-ink data-[disabled=true]:opacity-50";

// cmdk renders the group label into a [cmdk-group-heading] element it owns, so
// it is styled from the list rather than by a className we could pass. Same
// weight as the sidebar section header (SidebarSection): a section label is a
// section label wherever it appears.
const groupHeadingClass =
  "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 " +
  "[&_[cmdk-group-heading]]:text-meta [&_[cmdk-group-heading]]:font-medium " +
  "[&_[cmdk-group-heading]]:text-ink-muted";

/**
 * 메시지 검색이라는 목적지의 이름 (이슈 #1146 N4).
 *
 * 이 팔레트가 「멤버 ↔ 디렉터리」에서 세운 규칙 그대로다 — 한 목적지는 이름이
 * 하나이고, 그 이름은 **도착하는 표면이 쓰는 말**이다. 다른 점은 이번엔 그 말을
 * 여기 적지 않고 코어의 표면 판정표에서 든다는 것뿐이다: 이 항목·사이드바 줄·
 * 라우트의 제목이 각자 적으면 셋이 갈라지고, 실제로 사이드바가 갈라져 있었다.
 */
const SEARCH_SURFACE_NAME = serverSurface("messageSearch").label;

function PaletteLayer({
  onOpenChange,
  children,
}: {
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [isPresent, safeToRemove] = usePresence();
  const reduceMotion = useReducedMotion();
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isPresent) return;
    // Decide from the hook before reading overlayRef. Deleting this
    // branch reddens jsdom; Chromium still detaches via the duration-0
    // setTimeout fallback (R6 B-1 / R7). Mark the taken path on the
    // overlay; duration is not a discriminator.
    if (reduceMotion) {
      // data-exit-path: written only inside the exit window, removed
      // with the node, read by panelMotion.test.ts.
      overlayRef.current?.setAttribute("data-exit-path", "reduce");
      safeToRemove();
      return;
    }
    const node = overlayRef.current;
    if (!node) {
      safeToRemove();
      return;
    }
    node.setAttribute("data-exit-path", "timeout");
    const raw = getComputedStyle(node).animationDuration;
    const parsed = Number.parseFloat(raw);
    const duration =
      Number.isFinite(parsed) && parsed > 0
        ? raw.includes("ms")
          ? parsed
          : parsed * 1000
        : 0;
    const onEnd = (event: AnimationEvent) => {
      if (event.target !== node) return;
      safeToRemove();
    };
    node.addEventListener("animationend", onEnd);
    const fallback = window.setTimeout(() => safeToRemove(), duration);
    return () => {
      node.removeEventListener("animationend", onEnd);
      window.clearTimeout(fallback);
    };
  }, [isPresent, reduceMotion, safeToRemove]);

  return (
    <Dialog
      open={isPresent}
      onOpenChange={onOpenChange}
    >
      {/* DialogContent inherits portal forceMount. Without it Radix Presence
          removes the content itself and the jsdom "still mounted at 20 ms"
          assertion passes regardless of the effect. forceMount keeps the
          guard meaningful (the palette's exit is owned by our effect, not
          by Radix), not the branch reachable. */}
      <DialogPortal forceMount>
        <DialogOverlay
          ref={overlayRef}
          data-testid="quick-switcher-overlay"
        />
        <DialogPrimitive.Content
          aria-label="검색과 이동"
          data-testid="quick-switcher"
          className={cn(
            "fixed left-1/2 top-8 w-full max-w-pane-md -translate-x-1/2 rounded-lg border border-line bg-surface-raised text-ink shadow-lg",
            MODAL_CONTENT_MOTION
          )}
          onCloseAutoFocus={(event) => {
            // restoreRef in QuickSwitcher is the owner (#1997 H-2). Swallow
            // Radix's default so it does not race that effect. Do not restore
            // here: a second path made the red proof green.
            event.preventDefault();
          }}
        >
          {children}
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}

export function QuickSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
  const location = useLocation();
  const { showNav: showDrafts } = useDraftsPanel();
  const { groups } = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const { directory } = directoryQuery;
  const dm = useOpenDm();
  const { clearError } = dm;

  // 채널 만들기 has a seat in the palette because ⌘K is the house grammar for
  // "every action has a keyboard path" (SKILL §6) and this action only had Tab.
  // Same permission rule as the sidebar +, from the same function, so the
  // palette never offers what the server would answer with 403, and the same
  // silence while the roster is still in flight (R2 M5).
  const openCreateChannel = useOpenCreateChannel();
  const canCreate = canCreateChannelNow(
    !directoryQuery.isPending,
    memberFor(directory, session.member.id)?.role
  );

  // 폼 다이얼로그가 떠 있는 동안 전역 단축키는 물러선다 (R2 M4).
  // 세 훅을 각각 부른 뒤 합친다: ||를 그대로 쓰면 단축 평가 때문에 뒤 훅이
  // 어떤 렌더에서는 호출되지 않는다.
  const createChannelOpen = useCreateChannelOpen();
  const addMemberOpen = useAddChannelMemberOpen();
  const agentProfileOpen = useAgentProfileOpen();
  const addWorkspaceOpen = useAddWorkspaceOpen();
  const formDialogOpen =
    createChannelOpen || addMemberOpen || agentProfileOpen || addWorkspaceOpen;

  // 에이전트 라우팅도 팔레트에 자리가 있다 (R1 M7). 같은 규칙이 채널 만들기를
  // 여기에 앉혔고(SKILL §6 "모든 액션에 키보드 경로"), 이 액션은 그것보다 더
  // 절실하다: 타임라인의 이름은 이제 이름일 뿐이므로 마우스 없이 이 다이얼로그에
  // 닿는 길은 디렉터리로 이동한 뒤 행을 타고 들어가는 것뿐이었다.
  const openAgentProfile = useOpenAgentProfile();
  const agents = useMemo(
    () =>
      directory.members.filter(
        (member) => member.kind === "agent" && member.status === "active"
      ),
    [directory.members]
  );

  // Everyone already reachable as a DM row. Those rows are the conversation,
  // so the 사람 section below lists the people you have not talked to yet.
  const peersWithDm = useMemo(
    () =>
      groups.dms
        .map((channel) => dmPeer(channel, directory, session.member.id)?.id)
        .filter((id): id is string => id !== undefined),
    [groups.dms, directory, session.member.id]
  );

  // Who a DM can be opened with, decided by the directory's own rule rather
  // than by a second filter that would drift from it (model.switcherPeople).
  const people = useMemo(
    () => switcherPeople(directory.members, session.member.id, peersWithDm),
    [directory.members, session.member.id, peersWithDm]
  );

  // 지금 서 있는 채널 — 「이 채널에서 검색」이 뜻하는 그 채널 (#1931).
  //
  // 주소로 판정한다. 팔레트는 채널 표면의 자식이 아니라 셸의 형제이므로 열려
  // 있는 채널을 prop으로 받을 길이 없고, 주소는 그 사실의 정본이다. 목록에서
  // 못 찾은 id는 **버린다**: 이름을 모르는 채널을 「이 채널에서 검색」이라고
  // 부를 수는 있어도, 그 줄은 사람이 어디로 가는지 모르는 채로 누르는 줄이 된다.
  const currentChannel = useMemo(() => {
    const channelId = channelIdInPath(location.pathname);
    if (channelId === null) return null;
    return (
      [...groups.channels, ...groups.dms].find(
        (channel) => channel.id.toLowerCase() === channelId.toLowerCase()
      ) ?? null
    );
  }, [location.pathname, groups.channels, groups.dms]);

  // A failed DM belongs to the attempt that failed, not to the palette. The
  // palette outlives its openings — cmdk unmounts the dialog contents but this
  // component stays — so nothing else would ever clear the banner, and a ⌘K
  // opened to jump to a channel would start with an error already given up on.
  useEffect(() => {
    if (!open) clearError();
  }, [open, clearError]);

  // 닫으면 캐럿이 원래 있던 곳으로 돌아간다. cmdk의 Command.Dialog는 Radix
  // Content에 onCloseAutoFocus를 넘길 통로가 없고, Radix 기본 복귀는 존재하지
  // 않는 DialogTrigger를 향하므로 팔레트를 닫은 사람은 문서 처음부터 다시 Tab을
  // 시작해야 했다. 여는 순간의 activeElement를 렌더 중에 잡아둔다: 이 시점은
  // cmdk의 포커스 스코프가 아직 아무것도 옮기기 전이다.
  const restoreRef = useRef<HTMLElement | null>(null);
  if (open && restoreRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    restoreRef.current = active instanceof HTMLElement ? active : null;
  }
  useEffect(() => {
    if (open) return;
    const target = restoreRef.current;
    restoreRef.current = null;
    if (target?.isConnected) target.focus();
  }, [open]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      // 모달 폼이 떠 있으면 이 셋 중 어느 것도 발화하지 않는다. 팔레트는 폼
      // 위에 겹쳐 뜨면서 캐럿을 가져갔고, 거기서 채널을 고르면 폼을 열어둔 채
      // 다른 채널로 이동했다. ⌘⇧K와 ⌘,도 같은 이유로 같은 사고를 낸다.
      // 폼을 닫는 키는 Esc 하나면 충분하다 (R2 M4).
      if (formDialogOpen) return;
      // ⌘⇧K = 새 다이렉트 메시지 (R-1 §1 키보드 경로). It lands on the member
      // directory, which is where a DM starts, and the directory puts the caret
      // in its search field on arrival (DirectoryRoute), so this shortcut ends
      // where its name promises: at a box you can type a name into. Checked
      // BEFORE ⌘K, because the shifted key still reports as "k" and would
      // otherwise toggle the palette.
      if (OPEN_NEW_DM_SHORTCUT.matches(event)) {
        event.preventDefault();
        onOpenChange(false);
        navigate("/directory");
        return;
      }
      if (OPEN_QUICK_SWITCHER_SHORTCUT.matches(event)) {
        event.preventDefault();
        onOpenChange(!open);
      }
      // ⌘, opens settings (R-1 §1 keyboard path). Already on /settings it
      // must not push another history entry: 「앱으로 돌아가기」 is navigate(-1),
      // so a stacked /settings would eat the first click (#1867 H-1).
      if (OPEN_SETTINGS_SHORTCUT.matches(event)) {
        event.preventDefault();
        const already = location.pathname === "/settings";
        if (open) {
          rememberSettingsOpener(restoreRef.current);
          onOpenChange(false);
        } else if (!already) {
          rememberSettingsOpener();
        }
        if (already) return;
        navigate("/settings");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange, navigate, formDialogOpen, location.pathname]);

  const searchProvided = isSurfaceProvided("messageSearch");
  // 팔레트에 친 말. 메시지 검색으로 넘길 때 그대로 들고 간다.
  const [typed, setTyped] = useState("");

  function go(path: string) {
    const toSettings = path === "/settings" || path.startsWith("/settings?");
    if (toSettings && location.pathname === "/settings") {
      onOpenChange(false);
      return;
    }
    if (toSettings) rememberSettingsOpener(restoreRef.current);
    onOpenChange(false);
    navigate(path);
  }

  // 채널 만들기 다이얼로그와 같은 앵커(left-1/2 top-8 max-w-pane-md)에 번갈아
  // 뜨는 오버레이라, 스크림도 라운드도 폭도 하나여야 한다. rounded-lg = 다이얼로그가
  // 토큰 역할표의 답이고(references/tokens.md §4), bg-scrim은 다크에서 배경을
  // 오히려 밝히던 bg-ink/20을 대신하며, 512px은 스톡 스케일의 이름 없는 숫자가
  // 아니라 이름을 가진 오버레이 측정선이다(R2 M7).
  return (
    <AnimatePresence>
      {open ? (
    <PaletteLayer onOpenChange={onOpenChange}>
      <Command label="검색과 이동">
      {/* 입력은 팔레트 안에 또 하나의 진한 상자를 그리지 않는다 (#1753 H-1).
          팔레트는 모달이고 입력이 유일한 포커스 대상이라, 열려 있는 동안 링은
          상시 점등이 되어 정보가 0이다 — 링 없이 hairline 구분선만 남긴다.
          placeholder가 입력 목적을 계속 눈에 보이게 한다. */}
      <div
        className="border-b border-line"
        data-testid="quick-switcher-input-vessel"
      >
        <Command.Input
          value={typed}
          onValueChange={setTyped}
          placeholder="채널, 사람, 설정으로 이동"
          data-testid="quick-switcher-input"
          className="w-full bg-transparent px-4 py-3 text-body outline-none placeholder:text-ink-muted focus-visible:outline-none"
        />
      </div>

      {/* A DM that failed to open keeps the palette up: the message belongs next
       * to the name that was picked, not behind a dialog that closed itself. */}
      {dm.error && (
        <InlineBanner message={dm.error.message} testId="switcher-dm-error" />
      )}

      <Command.List
        className={`max-h-pane overflow-y-auto p-2 ${groupHeadingClass}`}
      >
        {/* 이 팔레트는 **이름**만 거른다(채널·사람·설정). 그래서 빈 상태에서
            "다른 이름으로 검색하세요"로 끝내면, 사이드바에 검색이 둘 있는데
            둘 중 어느 것도 메시지 본문을 찾아 주지 않는 것처럼 읽힌다. 여기가
            두 검색이 만나는 자연스러운 접합점이라, 막다른 길 대신 넘길 곳을
            말한다 (goal B12 R1). */}
        <Command.Empty className="px-2 py-3 text-body text-ink-muted">
          {/* 이 문장은 **다른 줄을 이름으로 가리킨다.** 그 이름을 여기 손으로
              적으면 가리키는 쪽과 가리켜지는 쪽이 갈라지고, 안내는 화면에 없는
              곳을 가리키게 된다 (이슈 #1146 N4 — 1차의 사이드바가 「검색」이라
              적고 있는 동안 이 문장은 「메시지 검색」을 가리키고 있었다). */}
          {searchProvided
            ? `이름이 일치하는 채널이나 사람이 없습니다. 메시지 본문은 아래 ${SEARCH_SURFACE_NAME}에서 찾을 수 있습니다.`
            : "일치하는 채널이나 사람이 없습니다. 다른 이름으로 검색하세요."}
        </Command.Empty>

        {/* 메시지 검색은 팔레트 안에서 실행되지 않고 자기 표면으로 데려간다
            (goal B12 H5). 이 리스트는 이미 받아 둔 목록을 cmdk가 동기로 걸러
            내는 자리라, 서버에 묻고 기다리는 검색을 여기 끼워 넣으면 로딩·
            오류·빈 결과가 갈 곳이 없다. 편승은 진입점까지다.

            **자기 그룹으로 나와 앉은 이유** (R1 B-2, base 결함): cmdk는 이름이
            아무것도 안 맞으면 그 그룹에 `hidden`을 걸고, `forceMount`된 항목은
            DOM에 남지만 상자가 0×0이 된다. 「이동」 안에 있던 동안 이 줄은
            **키보드는 닿는데 눈은 못 보는 컨트롤**이었고(Enter는 동작했다),
            바로 위 `Command.Empty`의 문장은 화면에 없는 곳을 가리켰다. 항목의
            `forceMount`만으로는 고쳐지지 않는다 — 그룹도 함께 살아남아야 한다.
            (cmdk의 `Item`은 `props.forceMount ?? groupContext.forceMount`라
            그룹의 값을 물려받는다. 그래서 실제로 일하는 것은 아래 그룹의
            `forceMount`이고, 항목에 쓴 것은 이 줄이 언젠가 그룹 밖으로
            옮겨져도 혼자 살아남게 하는 보험이다.)

            그리고 그 생존이 여기서는 예외가 아니라 규칙이다: 이 두 줄은 정확히
            **이름으로 못 찾았을 때 쓰라고 있는** 줄들이라, 걸러져 사라지면
            필요한 바로 그 순간에 없다. 「이동」의 나머지 항목은 반대로 이름이
            안 맞으면 사라지는 것이 맞으므로 그 그룹에 남는다.

            그룹 머리글이 표면 이름을 **한 번** 말하고(#1146 N4), 두 줄은 각자
            범위만 말한다. `Command.Empty`가 「아래 {SEARCH_SURFACE_NAME}에서
            찾을 수 있습니다」라고 가리키는 그 이름이 이 머리글이다. */}
        {searchProvided && (
          <Command.Group heading={SEARCH_SURFACE_NAME} forceMount>
            <Command.Item
              className={itemClass}
              value={`${SEARCH_SURFACE_NAME} 전체에서 검색 찾기 search messages everywhere`}
              data-testid="switcher-message-search"
              forceMount
              onSelect={() => go(searchRoutePath(typed))}
            >
              <Search className="size-4 opacity-70" />
              {/* 두 줄이 같은 동사를 쓴다(R1 N-1). 같은 그룹에 나란히 선 두
                  줄이 같은 행동을 「검색」과 「찾기」로 갈라 부르던 자리다.
                  범위 이름은 표면의 칩과 **같은 한 줄**에서 온다
                  (`searchScopeLabel`) — 진입점이 「이 채널에서」라 하고 도착한
                  칩이 다른 말을 하면 사람은 매번 대조해야 한다. */}
              {searchEntryLabel("workspace", null, typed)}
            </Command.Item>
            {/* 채널 안에서 ⌘K를 열었다면 「이 채널에서」로 곧장 갈 수 있다
                (BT-3 / #1931). 이 줄이 검색 범위의 **유일한 진입 배선**이다:
                범위 자체는 표면의 칩이 쥐고 있고, 여기서 하는 일은 도착할 때의
                범위를 주소에 실어 보내는 것뿐이다.

                형제 줄과 **같은 규율**로 산다(R1 B-1). 1차 판본은 이 줄에만
                `forceMount`를 주지 않았고, 그래서 사람이 **찾으려는 말**을 치는
                순간 떨어져 나갔다 — 질의가 컨트롤 자기 이름과 겹칠 때만 사는
                줄이었다. 「질의를 들고 채널 범위로 인계」가 이 줄의 용도인데
                질의가 있으면 없어졌으니, 의도와 렌더가 서로 반대였다. */}
            {currentChannel !== null && (
              <Command.Item
                className={itemClass}
                value={`${SEARCH_SURFACE_NAME} 이 채널에서 검색 찾기 search in this channel`}
                data-testid="switcher-message-search-channel"
                forceMount
                onSelect={() => go(searchRoutePath(typed, currentChannel.id))}
              >
                <Search className="size-4 opacity-70" />
                {searchEntryLabel(
                  "channel",
                  {
                    channelId: currentChannel.id,
                    label: currentChannel.name ?? null,
                    isDirect: currentChannel.kind === "dm",
                    peer: null,
                  },
                  typed
                )}
              </Command.Item>
            )}
          </Command.Group>
        )}

        <Command.Group heading="이동">
          <Command.Item className={itemClass} onSelect={() => go("/inbox")}>
            <Inbox className="size-4 opacity-70" />
            인박스
          </Command.Item>
          {showDrafts && (
            <Command.Item
              className={itemClass}
              value="초안 drafts"
              data-testid="switcher-drafts"
              onSelect={() => go("/drafts")}
            >
              <FileText className="size-4 opacity-70" />
              초안
            </Command.Item>
          )}
          <Command.Item className={itemClass} onSelect={() => go("/activity")}>
            <Activity className="size-4 opacity-70" />
            활동
          </Command.Item>
          {/* 멤버, the same word the sidebar row and the route's own h1 use.
              One destination cannot have three names, and the surface people
              arrive at says 멤버, so that is the name (R-1 어휘 계승). The
              older wording stays in `value` as a search alias, so typing
              디렉터리 or 명부 still finds it. */}
          <Command.Item
            className={itemClass}
            value="멤버 디렉터리 명부"
            onSelect={() => go("/directory")}
          >
            <Users className="size-4 opacity-70" />
            멤버
          </Command.Item>
          <Command.Item className={itemClass} onSelect={() => go("/settings")}>
            <Settings className="size-4 opacity-70" />
            설정
          </Command.Item>
        </Command.Group>

        {canCreate && (
          <Command.Group heading="만들기">
            <Command.Item
              className={itemClass}
              value="채널 만들기 새 채널 create channel"
              data-testid="switcher-create-channel"
              onSelect={() => {
                onOpenChange(false);
                // 한 프레임 뒤에 연다. 같은 커밋에서 팔레트가 닫히고 폼이
                // 열리면 두 포커스 스코프가 겹쳐, 폼이 "무엇이 나를 열었나"로
                // 사라지는 중인 팔레트 입력을 잡는다. 팔레트가 먼저 캐럿을
                // 제자리에 돌려놓은 다음 열려야 닫을 때도 그 자리로 돌아간다.
                requestAnimationFrame(() => openCreateChannel());
              }}
            >
              <Plus className="size-4 opacity-70" />
              채널 만들기
            </Command.Item>
          </Command.Group>
        )}

        {agents.length > 0 && (
          <Command.Group heading="에이전트 설정">
            {agents.map((agent) => (
              <Command.Item
                key={agent.id}
                value={`${agent.displayName} ${agent.handle} 라우팅 모델 추론 강도 routing model effort`}
                className={itemClass}
                data-testid="switcher-agent-routing"
                data-member-id={agent.id}
                onSelect={() => {
                  onOpenChange(false);
                  // 채널 만들기와 같은 이유로 한 프레임 뒤에 연다: 같은 커밋에서
                  // 팔레트가 닫히고 폼이 열리면 두 포커스 스코프가 겹친다.
                  requestAnimationFrame(() => openAgentProfile(agent.id));
                }}
              >
                <Bot className="size-4 text-agent" />
                {agent.displayName} 라우팅
                <span className="text-meta text-ink-muted">@{agent.handle}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}

        <Command.Group heading="채널">
          {groups.channels.map((channel) => (
            <Command.Item
              key={channel.id}
              value={`${channel.name ?? ""} ${channel.id}`}
              className={itemClass}
              onSelect={() => go(`/c/${channel.id}`)}
            >
              {channel.kind === "private" ? (
                <Lock className="size-4 opacity-70" />
              ) : (
                <Hash className="size-4 opacity-70" />
              )}
              {channel.name ?? "이름 없는 채널"}
            </Command.Item>
          ))}
        </Command.Group>

        {groups.dms.length > 0 && (
          <Command.Group heading="다이렉트 메시지">
            {groups.dms.map((channel) => {
              // Same rule as the sidebar and the directory: the name decides
              // the row only when the workspace has one member by that name.
              // Here it never has, so the handle rides along and the agent 김인턴
              // and the human 김인턴 stop being two identical lines.
              const label = channelLabelParts(
                channel,
                directory,
                session.member.id
              );
              return (
                <Command.Item
                  key={channel.id}
                  value={`${label.text} ${label.handle ?? ""} ${channel.id}`}
                  className={itemClass}
                  data-testid="switcher-dm"
                  data-channel-id={channel.id}
                  onSelect={() => go(`/c/${channel.id}`)}
                >
                  <MessageSquare className="size-4 opacity-70" />
                  <span className={label.isAgent ? "text-agent" : undefined}>
                    {label.text}
                  </span>
                  {label.handle && (
                    <span className="text-meta text-ink-muted">
                      {label.handle}
                    </span>
                  )}
                </Command.Item>
              );
            })}
          </Command.Group>
        )}

        {people.length > 0 && (
          <Command.Group heading="사람">
            {people.map(({ member, selectable, reason }) => (
              <Command.Item
                key={member.id}
                value={`${member.displayName} ${member.handle} ${member.id}`}
                className={itemClass}
                data-testid="switcher-person"
                data-member-id={member.id}
                data-member-kind={member.kind}
                // cmdk skips a disabled item for arrow keys, Enter and click,
                // while keeping it in the filtered list: the name is still
                // findable, it just is not an action.
                disabled={!selectable}
                onSelect={() => {
                  void dm.openDm(member).then((opened) => {
                    if (opened) onOpenChange(false);
                  });
                }}
              >
                {/* Agent identity is the --agent token on the glyph and nothing
                 * else: same row, same type as a human (design-taste-web §9). */}
                {member.kind === "agent" ? (
                  <Bot className="size-4 text-agent" />
                ) : (
                  <User className="size-4 opacity-70" />
                )}
                {member.displayName}
                <span className="text-meta text-ink-muted">
                  @{member.handle}
                </span>
                {/* Same word the directory row uses, same token, so the two
                 * surfaces do not invent two vocabularies for one status. */}
                {reason && <span className="text-meta text-warn">{reason}</span>}
                {dm.pendingMemberId === member.id && (
                  <span className="text-meta text-ink-muted">여는 중</span>
                )}
              </Command.Item>
            ))}
          </Command.Group>
        )}
      </Command.List>
    </Command>
    </PaletteLayer>
      ) : null}
    </AnimatePresence>
  );
}
