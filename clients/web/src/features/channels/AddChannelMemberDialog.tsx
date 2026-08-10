import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { Check, Loader2 } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import {
  channelMemberCandidates,
  hasAddableMembers,
  isChannelMember,
} from "@momo/core/features/channels/memberAdd";
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
import { cn } from "@/design/lib/cn";
import { Avatar } from "@/features/timeline/MessageRow";
import { memberFor, useDirectory, type Directory } from "@/features/workspace/useWorkspace";
import { useSession } from "@/app/session";
import {
  AddChannelMemberOpenContext,
  AddChannelMemberOpenStateContext,
  useAddChannelMember,
  type AddChannelMemberTarget,
} from "./useAddChannelMember";

// =============================================================================
// 채널에 멤버 추가 다이얼로그 (검수 #2). Reading this as: a roster picker for
// internal team users on web+Tauri, density 6, motion 2.
//
// What this repairs is the same shape of dead end 채널 만들기 had. "멤버
// 초대하기" sent the reader to /settings, whose 초대 링크 생성기 is a
// workspace-level invite, not "add these people to this channel". The action
// now happens where it is offered: pick from the workspace roster and the
// person is in the channel, optimistically, before the server answers.
//
// The list is the directory's own vocabulary (channelMemberCandidates =
// groupDirectory minus me): humans and agents split, an agent named by its
// handle and attributed to its owner, because this roster really holds two
// 김인턴. Someone already in the channel stays in the list, shown "멤버" rather
// than removed, so the row you just added flips in place instead of vanishing.
//
// Workspace-level invite (bringing new people INTO the workspace) is a
// different act and stays in 설정 > 멤버; this dialog only moves existing
// members into a channel.
// =============================================================================

function CandidateRow({
  member,
  directory,
  channelId,
  pending,
  failure,
  offline,
  onAdd,
  onBecameMember,
}: {
  member: RosterMember;
  directory: Directory;
  channelId: string;
  pending: boolean;
  failure: string | undefined;
  offline: boolean;
  onAdd: (memberId: string) => void;
  /** This row just flipped to "멤버"; the panel decides where the caret goes. */
  onBecameMember: (memberId: string, rowEl: HTMLElement) => void;
}) {
  const isAgent = member.kind === "agent";
  const owner = isAgent ? memberFor(directory, member.ownerHumanId) : null;
  const already = isChannelMember(member, channelId);

  // 낙관적 추가로 [추가] 버튼이 "멤버" 표시로 바뀌면 그 버튼은 언마운트되고
  // 키보드 포커스가 <body>로 떨어진다 — 여러 명을 넣는 피커에서 매번 맨 위부터
  // Tab을 다시 해야 했다(design-review F-2). 뒤집힘을 커밋 직후(레이아웃 이펙트,
  // paint 전)에 잡아 패널에 알리고, 패널이 다음 추가 가능 버튼으로 캐럿을
  // 옮긴다. 같은 프레임에서 옮기므로 포커스가 사라진 프레임이 그려지지 않는다.
  const rowRef = useRef<HTMLLIElement>(null);
  const wasAlready = useRef(already);
  useLayoutEffect(() => {
    const was = wasAlready.current;
    wasAlready.current = already;
    if (!was && already && rowRef.current) {
      onBecameMember(member.id, rowRef.current);
    }
  }, [already, member.id, onBecameMember]);

  return (
    <li
      ref={rowRef}
      className="flex flex-col border-b border-line last:border-b-0"
      data-testid="add-member-row"
      data-member-id={member.id}
      data-member-kind={member.kind}
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Avatar member={member} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex flex-wrap items-baseline gap-2">
            <span
              className={cn(
                "text-body font-semibold",
                isAgent ? "text-agent" : "text-ink"
              )}
            >
              {member.displayName}
            </span>
            <span className="text-meta text-ink-muted">@{member.handle}</span>
          </span>
          {owner && (
            <span className="text-meta text-ink-muted">
              {owner.displayName} 님이 관리
            </span>
          )}
        </span>

        {already ? (
          // 이미 채널에 있는 사람. 지운 적 없는 행을 목록에서 빼는 대신, 왜 추가
          // 버튼이 없는지를 그 자리에서 말한다. Check는 장식이 아니라 "여기 있음".
          <span
            className="inline-flex shrink-0 items-center gap-1 text-meta text-ink-muted"
            data-testid="add-member-present"
          >
            <Check className="size-4" aria-hidden="true" />
            멤버
          </span>
        ) : (
          // 진행 중은 비활성이 아니라 바쁜 것이다(CreateChannelDialog와 같은
          // 규칙): disabled로 흐려지면 라벨 대비가 떨어지는데 그 라벨이 유일한
          // 진행 신호다. aria-busy로 상태를 말하고, 중복 발화는 훅이 막는다.
          // 오프라인만 진짜 disabled다 — 이유는 위 배너가 이미 말한다.
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={offline}
            aria-busy={pending || undefined}
            aria-label={`${member.displayName} @${member.handle}, 채널에 추가`}
            onClick={() => onAdd(member.id)}
            data-testid="add-member-button"
            data-member-id={member.id}
          >
            {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {pending ? "추가 중" : "추가"}
          </Button>
        )}
      </div>

      {failure && (
        // 이 멤버에 대한 거절은 이 멤버의 행 아래에 붙는다(토스트 아님). 다시
        // [추가]를 누르면 훅이 이 문구를 지우고 재시도한다. role="alert"라 캐럿을
        // 훔치지 않고도 스크린리더가 실패를 읽는다.
        <p
          className="px-4 pb-2 text-meta text-danger"
          role="alert"
          data-testid="add-member-error"
          data-member-id={member.id}
        >
          {failure}
        </p>
      )}
    </li>
  );
}

const SECTION_HEADING_CLASS =
  "border-b border-line px-4 py-1 text-meta font-medium text-ink-muted";

function AddChannelMemberPanel({
  target,
  onOpenChange,
}: {
  target: AddChannelMemberTarget;
  onOpenChange: (open: boolean) => void;
}) {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
  const rosterQuery = useDirectory(workspaceId);
  const directory = rosterQuery.directory;
  const { pendingIds, failures, add } = useAddChannelMember(target.id);
  const offline = useOffline();
  const [query, setQuery] = useState("");

  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  // 사용자가 방금 추가를 누른 멤버. 그 행이 "멤버"로 뒤집힐 때에만 캐럿을 옮기고,
  // 배경 갱신(남이 추가)으로 뒤집힌 행에서는 훔치지 않게 하는 표식이다.
  const focusAfterFlip = useRef<string | null>(null);

  const anyPending = pendingIds.size > 0;

  const roster = {
    pending: rosterQuery.isPending,
    failed: rosterQuery.error !== null,
  };
  const groups = useMemo(
    () => channelMemberCandidates(directory.members, session.member.id, query),
    [directory.members, session.member.id, query]
  );
  const anyAddable = hasAddableMembers(
    directory.members,
    target.id,
    session.member.id
  );

  const handleAdd = useCallback(
    (memberId: string) => {
      focusAfterFlip.current = memberId;
      void add(memberId);
    },
    [add]
  );

  const onBecameMember = useCallback(
    (memberId: string, rowEl: HTMLElement) => {
      if (focusAfterFlip.current !== memberId) return;
      focusAfterFlip.current = null;
      const list = listRef.current;
      if (!list) return;
      const buttons = Array.from(
        list.querySelectorAll<HTMLElement>('[data-testid="add-member-button"]')
      );
      // 다음(이 행 뒤) 추가 버튼으로, 없으면 이전 버튼으로, 그것도 없으면(전원
      // 추가 완료) 검색 칸으로. 한 번의 Tab도 없이 다음 사람을 추가할 수 있다.
      const following = buttons.find(
        (b) =>
          (rowEl.compareDocumentPosition(b) &
            Node.DOCUMENT_POSITION_FOLLOWING) !==
          0
      );
      const preceding = [...buttons]
        .reverse()
        .find(
          (b) =>
            (rowEl.compareDocumentPosition(b) &
              Node.DOCUMENT_POSITION_PRECEDING) !==
            0
        );
      (following ?? preceding ?? searchRef.current)?.focus();
    },
    []
  );

  const section = useCallback(
    (title: string, testId: string, members: RosterMember[]) => {
      if (members.length === 0) return null;
      return (
        <section className="flex flex-col" data-testid={testId}>
          <h2 className={SECTION_HEADING_CLASS}>{title}</h2>
          <ul className="flex flex-col">
            {members.map((member) => (
              <CandidateRow
                key={member.id}
                member={member}
                directory={directory}
                channelId={target.id}
                pending={pendingIds.has(member.id)}
                failure={failures.get(member.id)}
                offline={offline}
                onAdd={handleAdd}
                onBecameMember={onBecameMember}
              />
            ))}
          </ul>
        </section>
      );
    },
    [directory, target.id, pendingIds, failures, offline, handleAdd, onBecameMember]
  );

  let body: ReactNode;
  if (roster.pending && groups.total === 0) {
    body = <SkeletonRows rows={6} className="p-4" />;
  } else if (roster.failed && groups.total === 0) {
    body = (
      <InlineBanner
        message="멤버 명부를 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={() => void rosterQuery.refetch()}
        testId="add-member-roster-error"
      />
    );
  } else if (groups.total === 0) {
    // 워크스페이스에 나 말고 아무도 없다. 채널에 넣을 사람 자체가 없으므로,
    // 다음 행동(워크스페이스에 사람을 부르기)으로 데려가는 액션을 하나 둔다 —
    // 그건 설정의 워크스페이스 초대라, 눌러서 그리 보내고 이 다이얼로그는 닫는다.
    // 카피만 있고 액션이 없으면 이 배치가 없애려던 막다른 길이 여기서 재발한다
    // (design-review F-1, 오르트 구름 §4).
    body = (
      <EmptyInvite
        headline="이 워크스페이스에 다른 멤버가 없습니다."
        detail="먼저 워크스페이스에 멤버를 초대하면 이 채널에 추가할 수 있습니다."
        actions={
          <Button
            size="sm"
            onClick={() => {
              navigate("/settings?section=members");
              onOpenChange(false);
            }}
            data-testid="add-member-invite-workspace"
          >
            멤버 초대하기
          </Button>
        }
        testId="add-member-empty-workspace"
      />
    );
  } else if (groups.matched === 0) {
    body = (
      <EmptyInvite
        headline="일치하는 멤버가 없습니다."
        detail={`검색어 "${query.trim()}"에 해당하는 이름이나 핸들이 없습니다. 다른 이름으로 검색하세요.`}
        actions={
          <Button variant="outline" size="sm" onClick={() => setQuery("")}>
            검색 지우기
          </Button>
        }
        testId="add-member-no-match"
      />
    );
  } else {
    body = (
      <>
        {/* 검색 없이 열었는데 추가할 사람이 하나도 없다면(전원이 이미 이 채널에
            있음), 목록이 전부 "멤버"로 보이는 이유를 한 줄로 먼저 말한다. */}
        {!anyAddable && query.trim() === "" && (
          <p
            className="border-b border-line px-4 py-2 text-meta text-ink-muted"
            data-testid="add-member-all-present"
          >
            이 워크스페이스의 모든 멤버가 이미 이 채널에 있습니다.
          </p>
        )}
        {section("사람", "add-member-people", groups.people)}
        {section("에이전트", "add-member-agents", groups.agents)}
      </>
    );
  }

  return (
    <DialogContent
      data-testid="add-channel-member-dialog"
      // 추가가 진행 중일 때는 닫기를 막는다(CreateChannelDialog와 같은 규칙,
      // design-review F-3): 열려 있는 패널이 실패를 인라인으로 되돌려 보여주는데,
      // 그 사이 Esc나 바깥 클릭으로 닫으면 실패가 아무도 안 보는 곳에서 조용히
      // 롤백된다. 추가는 REST 한 번이라 이 잠금은 짧다.
      onEscapeKeyDown={(event) => {
        if (anyPending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (anyPending) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>멤버 추가</DialogTitle>
        <DialogDescription>
          {target.name} 채널에 워크스페이스 멤버를 추가합니다.
        </DialogDescription>
      </div>

      {/* 오프라인이면 추가할 수 없다고 말하고 버튼을 잠근다. 추가는 REST 한 번이고
          그 경로에는 데드라인이 걸려 있어(lib/http) 끊긴 채로 누르면 실패가
          돌아온다. 명부는 마지막으로 받은 상태로 계속 읽힌다(P15). */}
      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 멤버 추가는 다시 연결된 뒤에 할 수 있습니다."
          testId="add-member-offline"
        />
      )}

      <div className="border-b border-line p-4">
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="멤버 검색"
          placeholder="이름이나 핸들로 검색"
          autoComplete="off"
          spellCheck={false}
          data-testid="add-member-search"
        />
      </div>

      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="add-member-list"
      >
        {body}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={anyPending}
          onClick={() => onOpenChange(false)}
          data-testid="add-member-close"
        >
          닫기
        </Button>
      </div>
    </DialogContent>
  );
}

/**
 * Holds the one add-member dialog for the whole signed-in shell and hands its
 * entry points the verb that opens it, with the channel they mean. Mirrors
 * CreateChannelProvider: one dialog, one piece of state, no entry point can go
 * stale.
 */
export function AddChannelMemberProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<AddChannelMemberTarget | null>(null);
  const open = target !== null;
  const openAddMember = useCallback(
    (next: AddChannelMemberTarget) => setTarget(next),
    []
  );
  const onOpenChange = useCallback((next: boolean) => {
    // 열림 상태만 여기서 되돌린다. 검색어와 진행 중 상태는 패널이 열려 있는
    // 동안에만 존재하도록 열릴 때만 마운트한다(아래 `open &&`).
    if (!next) setTarget(null);
  }, []);

  return (
    <AddChannelMemberOpenContext.Provider value={openAddMember}>
      <AddChannelMemberOpenStateContext.Provider value={open}>
        {children}
      </AddChannelMemberOpenStateContext.Provider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {/* 열려 있는 동안에만 마운트한다: 이전에 친 검색어와 실패가 다음 열기까지
            따라오지 않고, 여는 순간의 activeElement가 곧 "무엇이 이걸 열었나"라
            닫을 때 캐럿이 그리로 돌아간다(dialog.tsx). */}
        {open && (
          <AddChannelMemberPanel target={target} onOpenChange={onOpenChange} />
        )}
      </Dialog>
    </AddChannelMemberOpenContext.Provider>
  );
}
