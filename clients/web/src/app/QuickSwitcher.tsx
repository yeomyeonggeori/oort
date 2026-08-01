import { useEffect, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import {
  Activity,
  Bot,
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
import { switcherPeople } from "@/features/directory/model";
import { useOpenDm } from "@/features/directory/useOpenDm";
import { canCreateChannelNow } from "@/features/channels/model";
import {
  useCreateChannelOpen,
  useOpenCreateChannel,
} from "@/features/channels/useCreateChannel";
import {
  useAgentProfileOpen,
  useOpenAgentProfile,
} from "@/features/routing/useAgentProfile";
import { InlineBanner } from "@/features/common/States";
import { isSurfaceProvided } from "@/features/capabilities/serverSurfaces";

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

export function QuickSwitcher({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
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
  // 두 훅을 각각 부른 뒤 합친다: ||를 그대로 쓰면 단축 평가 때문에 두 번째
  // 훅이 어떤 렌더에서는 호출되지 않는다.
  const createChannelOpen = useCreateChannelOpen();
  const agentProfileOpen = useAgentProfileOpen();
  const formDialogOpen = createChannelOpen || agentProfileOpen;

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
      if (!event.metaKey && !event.ctrlKey) return;
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
      if (event.shiftKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(false);
        navigate("/directory");
        return;
      }
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
      // ⌘, opens settings (R-1 §1 keyboard path).
      if (event.key === ",") {
        event.preventDefault();
        navigate("/settings");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, onOpenChange, navigate, formDialogOpen]);

  const searchProvided = isSurfaceProvided("messageSearch");

  function go(path: string) {
    onOpenChange(false);
    navigate(path);
  }

  // 채널 만들기 다이얼로그와 같은 앵커(left-1/2 top-8 max-w-pane-md)에 번갈아
  // 뜨는 오버레이라, 스크림도 라운드도 폭도 하나여야 한다. rounded-lg = 다이얼로그가
  // 토큰 역할표의 답이고(references/tokens.md §4), bg-scrim은 다크에서 배경을
  // 오히려 밝히던 bg-ink/20을 대신하며, 512px은 스톡 스케일의 이름 없는 숫자가
  // 아니라 이름을 가진 오버레이 측정선이다(R2 M7).
  return (
    <Command.Dialog
      open={open}
      onOpenChange={onOpenChange}
      label="검색과 이동"
      overlayClassName="fixed inset-0 bg-scrim"
      contentClassName="fixed left-1/2 top-8 w-full max-w-pane-md -translate-x-1/2 rounded-lg border border-line bg-surface-raised text-ink shadow-lg"
      data-testid="quick-switcher"
    >
      <Command.Input
        placeholder="채널, 사람, 설정으로 이동"
        data-testid="quick-switcher-input"
        className="w-full border-b border-line bg-transparent px-4 py-3 text-body focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent placeholder:text-ink-muted"
      />

      {/* A DM that failed to open keeps the palette up: the message belongs next
       * to the name that was picked, not behind a dialog that closed itself. */}
      {dm.error && (
        <InlineBanner message={dm.error.message} testId="switcher-dm-error" />
      )}

      <Command.List
        className={`max-h-pane overflow-y-auto p-2 ${groupHeadingClass}`}
      >
        <Command.Empty className="px-2 py-3 text-body text-ink-muted">
          일치하는 채널이나 사람이 없습니다. 다른 이름으로 검색하세요.
        </Command.Empty>

        <Command.Group heading="이동">
          {/* 메시지 검색은 팔레트 안에서 실행되지 않고 자기 표면으로 데려간다
              (goal B12 H5). 이 리스트는 이미 받아 둔 목록을 cmdk가 동기로 걸러
              내는 자리라, 서버에 묻고 기다리는 검색을 여기 끼워 넣으면 로딩·
              오류·빈 결과가 갈 곳이 없다. 편승은 진입점까지다. */}
          {searchProvided && (
            <Command.Item
              className={itemClass}
              value="메시지 검색 찾기 search messages"
              data-testid="switcher-message-search"
              onSelect={() => go("/search")}
            >
              <Search className="size-4 opacity-70" />
              메시지 검색
            </Command.Item>
          )}
          <Command.Item className={itemClass} onSelect={() => go("/inbox")}>
            <Inbox className="size-4 opacity-70" />
            인박스
          </Command.Item>
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
                requestAnimationFrame(openCreateChannel);
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
    </Command.Dialog>
  );
}
