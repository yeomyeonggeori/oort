import { useCallback, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import type { RosterMember } from "@/lib/api";
import { useSession } from "@/app/session";
import { Input } from "@/design/ui/input";
import { Button } from "@/design/ui/button";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { MemberRow } from "./MemberRow";
import {
  countLabel,
  groupDirectory,
  hasOtherMembers,
  normalizeQuery,
} from "./model";
import { useOpenDm } from "./useOpenDm";

// =============================================================================
// 멤버 디렉터리 (parity G-3 + G-4). The workspace roster as a list you can read,
// search and start a conversation from. Agents are in it because agents ARE
// members (ADR-0131); they are grouped separately only so the two 김인턴 in this
// workspace, one human and one agent, do not read as duplicates.
//
// The source is the roster the sidebar already uses, so this surface adds a
// route and a view, not another read of the same thing.
// =============================================================================

export function DirectoryRoute() {
  const { session, workspaceId, connStatus } = useSession();
  const rosterQuery = useDirectory(workspaceId);
  const { pendingMemberId, error: dmError, openDm } = useOpenDm();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const groups = useMemo(
    () => groupDirectory(rosterQuery.directory.members, query),
    [rosterQuery.directory.members, query]
  );

  const offline = connStatus === "disconnected";
  const trimmed = normalizeQuery(query);
  const hasOthers = hasOtherMembers(
    rosterQuery.directory.members,
    session.member.id
  );
  const failedMember = dmError
    ? memberFor(rosterQuery.directory, dmError.memberId)
    : null;

  /** ↑/↓ walks the rows; the search box hands focus down on ArrowDown. */
  const focusRow = useCallback((step: number, from: number | null) => {
    const rows = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-directory-row]") ??
        []
    );
    if (rows.length === 0) return false;
    const index = from ?? rows.indexOf(document.activeElement as HTMLElement);
    rows[(Math.max(index, 0) + step + rows.length) % rows.length]?.focus();
    return true;
  }, []);

  const onListKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (focusRow(event.key === "ArrowDown" ? 1 : -1, null)) {
        event.preventDefault();
      }
    },
    [focusRow]
  );

  const onSearchKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "ArrowDown") return;
      if (focusRow(0, 0)) event.preventDefault();
    },
    [focusRow]
  );

  function startDm(member: RosterMember) {
    void openDm(member);
  }

  function section(title: string, testId: string, members: RosterMember[]) {
    if (members.length === 0) return null;
    return (
      <section className="flex flex-col" data-testid={testId}>
        <h2 className="border-b border-line px-4 py-1 text-meta font-medium text-ink-muted">
          {title}
        </h2>
        <ul className="flex flex-col">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              directory={rosterQuery.directory}
              selfMemberId={session.member.id}
              pending={pendingMemberId === member.id}
              onOpenDm={startDm}
            />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="directory-route">
      <header className="flex items-center justify-between gap-3 border-b border-line px-4 py-2">
        <h1 className="text-body font-semibold">멤버</h1>
        <span className="text-meta text-ink-muted" data-testid="directory-count">
          {countLabel(groups)}
        </span>
      </header>

      <div className="border-b border-line px-4 py-2">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="멤버 검색"
          placeholder="이름이나 핸들로 검색"
          data-testid="directory-search"
          // A search field that runs the full width of a 1600px pane reads as a
          // web form; capped, it reads as a control on a work surface.
          className="max-w-pane-lg"
        />
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결 끊김, 재연결 중입니다. 명부는 마지막으로 받은 상태이고, 새 대화는 연결이 돌아온 뒤 열립니다."
          testId="directory-offline"
        />
      )}

      {dmError && (
        <InlineBanner
          message={dmError.message}
          actionLabel={failedMember ? "다시 시도" : undefined}
          onAction={failedMember ? () => startDm(failedMember) : undefined}
          testId="directory-dm-error"
        />
      )}

      <div
        ref={listRef}
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="directory-list"
      >
        {rosterQuery.isLoading && groups.total === 0 ? (
          <SkeletonRows rows={6} className="p-4" />
        ) : rosterQuery.error && groups.total === 0 ? (
          <InlineBanner
            message="멤버 명부를 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void rosterQuery.refetch()}
            testId="directory-error"
          />
        ) : !hasOthers ? (
          <EmptyInvite
            headline="이 워크스페이스에 아직 다른 멤버가 없습니다."
            detail="초대 링크를 만들어 팀을 부르면 여기에 명부가 쌓이고, 각 행에서 바로 대화를 열 수 있습니다."
            actions={
              <Button size="sm" asChild>
                <Link to="/settings?section=members">멤버 초대하기</Link>
              </Button>
            }
            testId="directory-empty"
          />
        ) : groups.matched === 0 ? (
          <EmptyInvite
            headline="일치하는 멤버가 없습니다."
            detail={`"${trimmed}"로 이름과 핸들을 찾았습니다. 다른 이름으로 검색하세요.`}
            actions={
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                검색 지우기
              </Button>
            }
            testId="directory-no-match"
          />
        ) : (
          <>
            {section("사람", "directory-people", groups.people)}
            {section("에이전트", "directory-agents", groups.agents)}
          </>
        )}
      </div>
    </div>
  );
}
