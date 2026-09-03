import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import type { RosterMember } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { Input } from "@/design/ui/input";
import { Button } from "@/design/ui/button";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { useDirectory } from "@/features/workspace/useWorkspace";
import { CONTENT_CLASS, MemberRow, ROW_CLASS } from "./MemberRow";
import { countLabel, groupDirectory, hasOtherMembers } from "@momo/core/features/directory/model";
import { useOpenMemberProfile } from "./memberProfileContext";

// =============================================================================
// 멤버 디렉터리 (parity G-3 + G-4). The workspace roster as a list you can read,
// search and open a profile from. The card then starts a conversation. Agents
// are in it because agents ARE
// members (ADR-0131); they are grouped separately only so the two 김인턴 in this
// workspace, one human and one agent, do not read as duplicates.
//
// The source is the roster the sidebar already uses, so this surface adds a
// route and a view, not another read of the same thing.
// =============================================================================

// The section label above 사람 / 에이전트. Named because the loading state below
// has to reserve the same band it will occupy.
const SECTION_HEADING_CLASS =
  "border-b border-line px-4 py-1 text-meta font-medium text-ink-muted";

/** A bar of dead space, in the neutral surface the other skeletons use. */
const BAR_CLASS = "block rounded-sm bg-surface-hover";

/**
 * The roster, before it arrives, in the shape it will arrive in.
 *
 * The generic Skeleton was full-bleed 24px bars, so a 1600px window
 * predicted a 1328px-wide 24px row and then delivered a 640px-capped 41px one:
 * the list moved on BOTH axes at the moment of arrival, which is the jump a
 * skeleton exists to prevent (design-taste-web §5, loading is height-preserving
 * and never a light show). These placeholders are built from MemberRow's own
 * ROW_CLASS/CONTENT_CLASS, so the prediction cannot drift from the row, and the
 * band above them stands in for the 사람 heading that always precedes the first
 * row of a roster that has anyone in it.
 *
 * Person height is what is predicted, not agent height: the split between the
 * two is exactly what this client does not know yet, and 사람 is the section
 * that comes first.
 */
function DirectorySkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" data-testid="directory-skeleton">
      <div className={SECTION_HEADING_CLASS}>
        <span className={`${BAR_CLASS} h-4 w-8`} />
      </div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={ROW_CLASS} data-testid="skeleton-row">
          <span className={CONTENT_CLASS}>
            {/* Same size-6 square the shared Avatar draws. */}
            <span className={`${BAR_CLASS} size-6 shrink-0`} />
            <span className={`${BAR_CLASS} h-4 w-pane-sm`} />
          </span>
        </div>
      ))}
    </div>
  );
}

export function DirectoryRoute() {
  const { session, workspaceId, connStatus } = useSession();
  const rosterQuery = useDirectory(workspaceId);
  const openMemberProfile = useOpenMemberProfile();
  const [query, setQuery] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const navKey = useLocation().key;

  // 이름을 칠 곳에 캐럿을 둔다 (design-taste-web §6: every action has a keyboard
  // path). ⌘⇧K and the 다이렉트 메시지 헤더의 + land on this route to find a
  // profile by typing a name, and landing with focus on <body>
  // leaves that name 15 tabs away. Keyed on the navigation, not on mount, so a
  // second ⌘⇧K while the directory is already open focuses again instead of
  // doing nothing.
  useEffect(() => {
    searchRef.current?.focus();
  }, [navKey]);

  const groups = useMemo(
    () => groupDirectory(rosterQuery.directory.members, query),
    [rosterQuery.directory.members, query]
  );

  // What this client knows about the roster, read once. The header and the list
  // below branch on the SAME two facts, so the two halves of this screen cannot
  // end up saying different things about whether there is a roster at all.
  //
  // isPending, not isLoading: a fresh query's first render is pending with
  // fetchStatus `idle`, and isLoading is false there. Branching on isLoading
  // paints one frame of "이 워크스페이스에 아직 다른 멤버가 없습니다" (plus a
  // count of zero) before the request has even left.
  const roster = {
    pending: rosterQuery.isPending,
    failed: rosterQuery.error !== null,
  };
  const count = countLabel(groups, roster);

  const offline = connStatus === "disconnected";
  // The query as the person typed it, only stripped of the spaces around it.
  // Matching folds case (model.normalizeQuery); quoting the folded string back
  // would hand "KIM" the answer "kim" and quietly correct a search that was
  // never wrong.
  const searched = query.trim();
  const hasOthers = hasOtherMembers(
    rosterQuery.directory.members,
    session.member.id
  );

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

  function section(title: string, testId: string, members: RosterMember[]) {
    if (members.length === 0) return null;
    return (
      <section className="flex flex-col" data-testid={testId}>
        <h2 className={SECTION_HEADING_CLASS}>{title}</h2>
        <ul className="flex flex-col">
          {members.map((member) => (
            <MemberRow
              key={member.id}
              member={member}
              directory={rosterQuery.directory}
              selfMemberId={session.member.id}
              onOpenProfile={(target, opener) =>
                openMemberProfile(target.id, opener)
              }
            />
          ))}
        </ul>
      </section>
    );
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="directory-route">
      {/* Full pane, matching 인박스 and 활동: the title sits at the left edge and
          the count at the right. The 640px content cap this route used to carry
          stranded the count mid-pane and left a dead band beside every row on a
          wide window; 성재 결정(2026-08-10 검수 배치 2)이 전체폭으로 통일했다. The
          search field and rows below share the same full measure. */}
      <header className="border-b border-line px-4 py-2">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarDrawerToggle />
            <h1 className="text-body font-semibold">멤버</h1>
          </div>
          {/* Nothing at all while the roster is unknown: a header that counts to
              zero over a skeleton or over "명부를 불러오지 못했습니다" is the one
              screen saying two contradictory things (model.countLabel). */}
          {count !== null && (
            <span
              className="text-meta text-ink-muted"
              data-numeric
              data-testid="directory-count"
            >
              {count}
            </span>
          )}
        </div>
      </header>

      <div className="border-b border-line px-4 py-2">
        <Input
          ref={searchRef}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          aria-label="멤버 검색"
          placeholder="이름이나 핸들로 검색"
          data-testid="directory-search"
        />
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message="연결 끊김, 재연결 중입니다. 명부는 마지막으로 받은 상태이고, 새 대화는 연결이 돌아온 뒤 열립니다."
          testId="directory-offline"
        />
      )}

      <div
        ref={listRef}
        onKeyDown={onListKeyDown}
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="directory-list"
      >
        {roster.pending && groups.total === 0 ? (
          <DirectorySkeleton rows={6} />
        ) : roster.failed && groups.total === 0 ? (
          <InlineBanner
            message="멤버 명부를 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void rosterQuery.refetch()}
            testId="directory-error"
          />
        ) : !hasOthers ? (
          <EmptyInvite
            headline="이 워크스페이스에 아직 다른 멤버가 없습니다."
            detail="초대 링크를 만들어 팀을 부르면 여기에 명부가 쌓이고, 각 행에서 프로필과 대화를 열 수 있습니다."
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
            detail={`검색어 "${searched}"에 해당하는 이름이나 핸들이 없습니다. 다른 이름으로 검색하세요.`}
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
