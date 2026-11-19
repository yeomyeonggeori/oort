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
import { ListGroup, ListRow, ListRowSkeleton } from "@/design/ui/list-row";
import { cn } from "@/design/lib/cn";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { LoadFailureBox } from "@/features/common/LoadFailureBox";
import { loadCauseOf } from "@/features/common/loadFailure";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { useOffline } from "@/features/common/useOffline";
import { Avatar } from "@/features/timeline/MessageRow";
import { useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { useSession } from "@/app/session";
import { newDmDraftKey, useHoldDraftOnEntry, useRestoredEntryDraft } from "@/lib/entryDrafts";
import { existingDmChannelId, newDmCandidates, peerDot } from "./newDmModel";
import {
  NewDmOpenContext,
  NewDmOpenStateContext,
} from "./useNewDm";
import { useOpenDm } from "./useOpenDm";
import { BlockedReason } from "@/features/common/BlockedReason";

// =============================================================================
// 새 다이렉트 메시지 (#3662, Buzz의 「To:」 선택 모달을 우리 문법으로).
//
// 사이드바 DM 머리의 +와 ⌘⇧K가 같은 이 모달을 연다. 받는 사람을 고르면:
//   · 그 사람과의 1:1 DM이 이미 목록에 있으면 → 바로 그 DM으로 간다.
//   · 없으면 → POST /dms(멱등, `useOpenDm`)로 만들고 그 DM으로 간다.
// 목록은 사람 · 에이전트로 나뉘고 이름·핸들로 거른다. 이미 DM이 있는 사람은 「대화 중」으로
// 말해 준다. 입력에서 ↓ 로 목록에 들어가고, 목록에서 ↑↓ 로 오가며, Enter 가 고른다.
// =============================================================================

/**
 * 받는 사람 한 줄 (#5782: 공용 목록 줄로). 제목은 이름, 보조 줄은 「@핸들 · 접속 낱말」, 끝 칸은 이미 대화
 * 중이면 「대화 중」. 이 줄에서 대화를 열다 실패하면 그 문장이 줄 바로 아래(같은 `li`)에 선다.
 */
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
  const t = useFormatMessage();
  const isAgent = member.kind === "agent";
  const dot = peerDot(member, Date.now());
  return (
    <ListRow
      data-testid="new-dm-row"
      data-new-dm-row=""
      data-member-id={member.id}
      data-member-kind={member.kind}
      data-has-dm={hasDm ? "" : undefined}
      aria-busy={pending || undefined}
      disabled={disabled}
      aria-label={`${member.displayName} @${member.handle}${
        dot ? `, ${dot.label}` : ""
      }, ${t(hasDm ? "memberList.newDm.continueAction" : "memberList.newDm.startAction")}`}
      onClick={() => onPick(member)}
      className="disabled:opacity-60"
      leading={<Avatar member={member} />}
      title={
        <span
          className={cn(
            "min-w-0 truncate font-semibold",
            isAgent ? "text-agent" : "text-ink"
          )}
        >
          {member.displayName}
        </span>
      }
      subtitle={dot ? `@${member.handle} · ${dot.label}` : `@${member.handle}`}
      trailing={
        hasDm ? (
          <span
            className="inline-flex items-center gap-1 text-meta text-ink-muted"
            data-testid="new-dm-has-dm"
          >
            <MessageSquare className="size-4" aria-hidden="true" />
            {t("memberList.newDm.hasDm")}
          </span>
        ) : null
      }
      after={
        failure ? (
          <p className="px-4 pb-2 text-meta text-danger" role="alert" data-testid="new-dm-error">
            {failure}
          </p>
        ) : null
      }
    />
  );
}

function NewDmPanel({ onOpenChange }: { onOpenChange: (open: boolean) => void }) {
  const { session, workspaceId } = useSession();
  const t = useFormatMessage();
  const roster = useDirectory(workspaceId);
  const channels = useChannels(workspaceId);
  const navigate = useNavigate();
  const dm = useOpenDm();
  const offline = useOffline();
  // 알림 클릭이 닫은 대화상자였다면 쓰던 검색어로 선다(#5058). 사람이 닫기로 닫은 대화상자는 평소처럼 빈 채로 선다 —
  // 이 모달은 열려 있는 동안에만 마운트돼 검색어가 따라오지 않는 것이 본래 약속이고, 맡기는 것은 방송이 올 때뿐이다.
  const draftKey = newDmDraftKey(workspaceId);
  const restoredQuery = useRestoredEntryDraft<string>(draftKey);
  const [query, setQuery] = useState(restoredQuery ?? "");
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const candidates = useMemo(
    () => newDmCandidates(roster.directory.members, session.member.id),
    [roster.directory.members, session.member.id]
  );
  const groups = useMemo(() => groupDirectory(candidates, query), [candidates, query]);
  const busy = dm.pendingMemberId !== null;
  // 대화를 여는 요청이 나가 있으면 곧 끝나는 일이라(성공하면 검색어는 쓰임을 다했다) 맡기지 않는다.
  useHoldDraftOnEntry<string>(draftKey, () => (!busy && query.trim() !== "" ? query : undefined));

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

  // 묶음은 공용 머리글 + 그릇(#5782). 대화 상자 안이라 카드가 아니라 시트 채움 그릇이다(README §2.14 ②).
  const section = (title: string, testId: string, members: RosterMember[]) =>
    members.length === 0 ? null : (
      <ListGroup label={title} count={members.length} surface="sheet" testId={testId}>
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
      </ListGroup>
    );

  let body: ReactNode;
  if (roster.isPending && candidates.length === 0) {
    // 도착할 줄과 같은 상자(아바타 32 · 두 줄 상자)라 명부가 와도 목록이 움직이지 않는다(#5782).
    body = (
      <div aria-hidden="true" data-testid="new-dm-skeleton">
        <ListGroup label={<span className="inline-block h-2 w-8 rounded-sm bg-surface-hover align-middle" />} surface="sheet">
          {Array.from({ length: 6 }, (_, i) => (
            <ListRowSkeleton key={i} testId="skeleton-row" />
          ))}
        </ListGroup>
      </div>
    );
  } else if (roster.error !== null && candidates.length === 0) {
    body = (
      <LoadFailureBox
        titleKey={CONNECTION_KEYS.loadMembersTitle}
        cause={loadCauseOf(roster.error)}
        onRetry={() => void roster.refetch()}
        testId="new-dm-roster-error"
      />
    );
  } else if (candidates.length === 0) {
    body = (
      <EmptyInvite
        headline={t("memberList.newDm.emptyHeadline")}
        detail={t("memberList.newDm.emptyDetail")}
        actions={
          <Button
            size="sm"
            onClick={() => {
              navigate("/settings?section=members");
              onOpenChange(false);
            }}
          >
            {t("memberList.empty.invite")}
          </Button>
        }
        testId="new-dm-empty-workspace"
      />
    );
  } else if (groups.matched === 0) {
    body = (
      <EmptyInvite
        headline={t("memberList.noMatch.headline")}
        detail={t("memberList.newDm.noMatchDetail", { query: query.trim() })}
        actions={
          <Button variant="outline" size="sm" onClick={() => setQuery("")}>
            {t("memberList.noMatch.clear")}
          </Button>
        }
        testId="new-dm-no-match"
      />
    );
  } else {
    body = (
      <>
        {section(t("memberList.group.people"), "new-dm-people", groups.people)}
        {section(t("memberList.group.agents"), "new-dm-agents", groups.agents)}
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
        <DialogTitle>{t("memberList.newDm.title")}</DialogTitle>
        <DialogDescription>
          {t("memberList.newDm.description")}
        </DialogDescription>
      </div>

      {offline ? (
        <InlineBanner
          tone="neutral"
          message={<BlockedReason frame="openExistingDm" />}
          testId="new-dm-offline"
        />
      ) : null}

      <div className="flex items-center gap-3 border-b border-line px-4 py-3">
        <label htmlFor="new-dm-to" className="shrink-0 text-meta font-medium text-ink-muted">
          {t("memberList.newDm.toLabel")}
        </label>
        <Input
          id="new-dm-to"
          ref={searchRef}
          type="text"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={t("memberList.newDm.placeholder")}
          autoComplete="off"
          spellCheck={false}
          data-testid="new-dm-search"
        />
      </div>

      <div
        ref={listRef}
        className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-3"
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
          {t("memberList.newDm.close")}
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

