import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { MessageSquare } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { groupDirectory } from "@momo/core/features/directory/model";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  restoreDialogOpenerFocus,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { Avatar } from "@/features/timeline/MessageRow";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { useSession } from "@/app/session";
import { existingDmChannelId, newDmCandidates, peerDot, PEER_DOT_LABEL } from "./newDmModel";
import {
  NewDmOpenContext,
  NewDmOpenStateContext,
} from "./useNewDm";
import { useOpenDm } from "./useOpenDm";

// =============================================================================
// 새 다이렉트 메시지 (#3662, Buzz의 「To:」 선택 모달을 우리 문법으로).
//
// 사이드바 DM 머리의 +와 ⌘⇧K가 같은 이 모달을 연다. 받는 사람을 고르면:
//   · 그 사람과의 1:1 DM이 이미 목록에 있으면 → 바로 그 DM으로 간다.
//   · 없으면 → POST /dms(멱등, `useOpenDm`)로 만들고 그 DM으로 간다.
// 목록은 사람 · 에이전트로 나뉘고 이름·핸들로 거른다. 이미 DM이 있는 사람은 「대화 중」으로
// 말해 준다. 입력에서 ↓ 로 목록에 들어가고, 목록에서 ↑↓ 로 오가며, Enter 가 고른다.
// =============================================================================

function PickRow({
  member,
  hasDm,
  pending,
  failure,
  disabled,
  onPick,
}: {
  member: RosterMember;
  hasDm: boolean;
  pending: boolean;
  failure: string | null;
  disabled: boolean;
  onPick: (member: RosterMember) => void;
}) {
  const isAgent = member.kind === "agent";
  const dot = peerDot(member, Date.now());
  return (
    <li className="flex flex-col border-b border-line last:border-b-0">
      <button
        type="button"
        data-testid="new-dm-row"
        data-new-dm-row=""
        data-member-id={member.id}
        data-member-kind={member.kind}
        data-has-dm={hasDm ? "" : undefined}
        aria-busy={pending || undefined}
        disabled={disabled}
        aria-label={`${member.displayName} @${member.handle}${
          hasDm ? ", 대화 이어가기" : ", 새 대화 시작"
        }`}
        onClick={() => onPick(member)}
        className="flex w-full items-center gap-3 px-4 py-2 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring disabled:opacity-60"
      >
        <Avatar member={member} />
        <span className="flex min-w-0 flex-1 items-baseline gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-body font-semibold",
              isAgent ? "text-agent" : "text-ink"
            )}
          >
            {member.displayName}
          </span>
          <span className="min-w-0 truncate text-meta text-ink-muted">@{member.handle}</span>
        </span>
        {dot ? (
          <span className="shrink-0 text-meta text-ink-muted">{PEER_DOT_LABEL[dot]}</span>
        ) : null}
        {hasDm ? (
          <span
            className="inline-flex shrink-0 items-center gap-1 text-meta text-ink-muted"
            data-testid="new-dm-has-dm"
          >
            <MessageSquare className="size-4" aria-hidden="true" />
            대화 중
          </span>
        ) : null}
      </button>
      {failure ? (
        <p className="px-4 pb-2 text-meta text-danger" role="alert" data-testid="new-dm-error">
          {failure}
        </p>
      ) : null}
    </li>
  );
}

function NewDmPanel({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { session, workspaceId } = useSession();
  const roster = useDirectory(workspaceId);
  const channels = useChannels(workspaceId);
  const navigate = useNavigate();
  const dm = useOpenDm();
  const offline = useOffline();
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const candidates = useMemo(
    () => newDmCandidates(roster.directory.members, session.member.id),
    [roster.directory.members, session.member.id]
  );
  const groups = useMemo(() => groupDirectory(candidates, query), [candidates, query]);
  const busy = dm.pendingMemberId !== null;

  const pick = useCallback(
    async (member: RosterMember) => {
      const existing = existingDmChannelId(
        channels.groups.dms,
        session.member.id,
        member.id
      );
      if (existing !== null) {
        navigate(`/c/${existing}`);
        onOpenChange(false);
        return;
      }
      if (await dm.openDm(member)) onOpenChange(false);
    },
    [channels.groups.dms, session.member.id, navigate, onOpenChange, dm]
  );

  const rows = () =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-new-dm-row]") ?? []);

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      rows()[0]?.focus();
    } else if (event.key === "Enter") {
      // 거른 결과가 정확히 한 명이면 Enter 한 번으로 고른다.
      const all = [...groups.people, ...groups.agents];
      if (all.length === 1) {
        event.preventDefault();
        void pick(all[0]);
      }
    }
  }

  function onListKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const list = rows();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    event.preventDefault();
    if (event.key === "ArrowDown") list[Math.min(at + 1, list.length - 1)]?.focus();
    else if (at === 0) searchRef.current?.focus();
    else list[at - 1]?.focus();
  }

  const section = (title: string, testId: string, members: RosterMember[]) =>
    members.length === 0 ? null : (
      <section className="flex flex-col" data-testid={testId}>
        <h2 className="border-b border-line px-4 py-1 text-meta font-medium text-ink-muted">
          {title}
        </h2>
        <ul className="flex flex-col">
          {members.map((member) => (
            <PickRow
              key={member.id}
              member={member}
              hasDm={
                existingDmChannelId(channels.groups.dms, session.member.id, member.id) !==
                null
              }
              pending={dm.pendingMemberId === member.id}
              failure={dm.error?.memberId === member.id ? dm.error.message : null}
              disabled={busy}
              onPick={(m) => void pick(m)}
            />
          ))}
        </ul>
      </section>
    );

  let body: ReactNode;
  if (roster.isPending && candidates.length === 0) {
    body = <Skeleton ready={false} rows={6} className="p-4" />;
  } else if (roster.error !== null && candidates.length === 0) {
    body = (
      <InlineBanner
        message="멤버 명부를 불러오지 못했습니다."
        actionLabel="다시 시도"
        onAction={() => void roster.refetch()}
        testId="new-dm-roster-error"
      />
    );
  } else if (candidates.length === 0) {
    body = (
      <EmptyInvite
        headline="대화할 다른 멤버가 없습니다."
        detail="워크스페이스에 멤버를 초대하면 여기서 바로 대화를 시작할 수 있습니다."
        actions={
          <Button
            size="sm"
            onClick={() => {
              navigate("/settings?section=members");
              onOpenChange(false);
            }}
          >
            멤버 초대하기
          </Button>
        }
        testId="new-dm-empty-workspace"
      />
    );
  } else if (groups.matched === 0) {
    body = (
      <EmptyInvite
        headline="일치하는 멤버가 없습니다."
        detail={`검색어 "${query.trim()}"에 해당하는 이름이나 핸들이 없습니다.`}
        actions={
          <Button variant="outline" size="sm" onClick={() => setQuery("")}>
            검색 지우기
          </Button>
        }
        testId="new-dm-no-match"
      />
    );
  } else {
    body = (
      <>
        {section("사람", "new-dm-people", groups.people)}
        {section("에이전트", "new-dm-agents", groups.agents)}
      </>
    );
  }

  return (
    <DialogContent
      data-testid="new-dm-dialog"
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        searchRef.current?.focus();
      }}
      onEscapeKeyDown={(event) => {
        if (busy) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (busy) event.preventDefault();
      }}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>새 다이렉트 메시지</DialogTitle>
        <DialogDescription>
          대화할 멤버나 에이전트를 고르세요. 이미 대화 중이면 그 대화로 이동해요.
        </DialogDescription>
      </div>

      {offline ? (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겼습니다. 이미 대화 중인 사람에게는 갈 수 있어요."
          testId="new-dm-offline"
        />
      ) : null}

      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <label htmlFor="new-dm-to" className="shrink-0 text-meta font-medium text-ink-muted">
          받는 사람
        </label>
        <Input
          id="new-dm-to"
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder="이름이나 핸들로 검색"
          autoComplete="off"
          spellCheck={false}
          data-testid="new-dm-search"
        />
      </div>

      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- 방향키 위임만 한다 */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="new-dm-list"
        onKeyDown={onListKeyDown}
      >
        {body}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onOpenChange(false)}
          data-testid="new-dm-close"
        >
          닫기
        </Button>
      </div>
    </DialogContent>
  );
}

/** 셸이 들고 있는 새 DM 모달 하나. 열려 있는 동안에만 패널을 마운트한다(검색어·실패가 따라오지 않게). */
export function NewDmProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openerRef = useRef<DialogFocusTarget | null>(null);
  const openNewDm = useCallback((opener?: DialogFocusTarget | null) => {
    openerRef.current = opener ?? null;
    setOpen(true);
  }, []);
  const onOpenChange = useCallback((next: boolean) => {
    setOpen(next);
    if (next) return;
    const opener = openerRef.current;
    queueMicrotask(() => restoreDialogOpenerFocus(opener));
  }, []);
  return (
    <NewDmOpenContext.Provider value={openNewDm}>
      <NewDmOpenStateContext.Provider value={open}>{children}</NewDmOpenStateContext.Provider>
      <Dialog open={open} onOpenChange={onOpenChange}>
        {open && <NewDmPanel onOpenChange={onOpenChange} />}
      </Dialog>
    </NewDmOpenContext.Provider>
  );
}

