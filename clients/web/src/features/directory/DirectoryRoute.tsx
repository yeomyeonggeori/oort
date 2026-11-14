import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation } from "react-router-dom";
import { Search } from "lucide-react";
import type { RosterMember } from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { useOffline } from "@/features/common/useOffline";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { Input } from "@/design/ui/input";
import { Button } from "@/design/ui/button";
import { ListGroup, ListRowSkeleton } from "@/design/ui/list-row";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { EmptyInvite, InlineBanner } from "@/features/common/States";
import { LoadFailureBox } from "@/features/common/LoadFailureBox";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import { causeOfFailure } from "@momo/core/features/connection/failure";
import { deviceOnlineNow } from "@/lib/deviceOnline";
import { memberFor, useDirectory } from "@/features/workspace/useWorkspace";
import { MemberRow } from "./MemberRow";
import { countLabel, hasOtherMembers } from "@momo/core/features/directory/model";
import { canSearchByEmail, groupMemberList } from "./memberListModel";
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

/** A bar of dead space, in the neutral surface the other skeletons use. */
const BAR_CLASS = "inline-block rounded-sm bg-surface-hover align-middle";

/**
 * The roster, before it arrives, in the shape it will arrive in (#5782).
 *
 * The placeholders are the shared list row's own skeleton inside the same group
 * card, under a label band built from the label's own line box: the row height
 * is the two line boxes (`text-body` + `text-meta`) and the 32 avatar circle in
 * both, so the list does not move on either axis when the roster lands
 * (design-taste-web §5, loading is height-preserving and never a light show).
 * The old placeholder drew a 24 square beside rows whose avatar is 32.
 *
 * Person height is what is predicted, not agent height: the split between the
 * two is exactly what this client does not know yet, and 사람 is the group that
 * comes first. Both kinds are two layers now, so the prediction holds for both.
 */
function DirectorySkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div aria-hidden="true" data-testid="directory-skeleton">
      <ListGroup
        label={<span className={`${BAR_CLASS} h-2 w-8`} />}
        testId="directory-skeleton-group"
      >
        {Array.from({ length: rows }, (_, i) => (
          <ListRowSkeleton key={i} testId="skeleton-row" />
        ))}
      </ListGroup>
    </div>
  );
}

export function DirectoryRoute() {
  const { session, workspaceId } = useSession();
  const t = useFormatMessage();
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

  // 이 보는 사람의 역할(명부의 내 줄). 이메일을 보고 이메일로 찾는 것은 게스트가 아닐 때뿐이다(#5782).
  const viewerRole = memberFor(rosterQuery.directory, session.member.id)?.role;
  const byEmail = canSearchByEmail(viewerRole);
  const groups = useMemo(
    () => groupMemberList(rosterQuery.directory.members, query, viewerRole),
    [rosterQuery.directory.members, query, viewerRole]
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

  const offline = useOffline();
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

  function section(label: string, testId: string, members: RosterMember[]) {
    if (members.length === 0) return null;
    return (
      <ListGroup label={label} count={members.length} testId={testId}>
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
      </ListGroup>
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
            <h1 className="text-body font-semibold">{t("memberList.page.title")}</h1>
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

      {/* 검색 칸: 앞에 돋보기, 그릇은 공용 Input 그대로(입력 그릇의 `--line-strong`). 아이콘은 글자를 가리지
          않게 칸 안쪽 여백(32)에 앉고 누름을 칸으로 흘린다. 폭은 줄 묶음과 같은 판 안이되 본문 판 한 칸
          (`max-w-pane-md`)에서 멈춘다 — 화면 끝까지 늘어난 큰 칸이 옛 모양이었다(QA 13). */}
      <div className="px-4 pb-2 pt-4">
        <div className="relative max-w-pane-md">
          <Search
            aria-hidden="true"
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
          />
          <Input
            ref={searchRef}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            aria-label={t("memberList.search.label")}
            placeholder={t(
              byEmail
                ? "memberList.search.placeholder"
                : "memberList.search.placeholderGuest"
            )}
            className="pl-8"
            data-testid="directory-search"
          />
        </div>
      </div>

      {offline && (
        <InlineBanner
          tone="neutral"
          message={t("memberList.state.offline")}
          testId="directory-offline"
        />
      )}

      <div
        ref={listRef}
        onKeyDown={onListKeyDown}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-4 pb-6 pt-2"
        data-testid="directory-list"
      >
        {roster.pending && groups.total === 0 ? (
          <DirectorySkeleton rows={6} />
        ) : roster.failed && groups.total === 0 ? (
          <LoadFailureBox
            titleKey={CONNECTION_KEYS.loadMembersTitle}
            cause={causeOfFailure(rosterQuery.error, deviceOnlineNow())}
            onRetry={() => void rosterQuery.refetch()}
            testId="directory-error"
          />
        ) : !hasOthers ? (
          <EmptyInvite
            headline={t("memberList.empty.headline")}
            detail={t("memberList.empty.detail")}
            actions={
              <Button size="sm" asChild>
                <Link to="/settings?section=members">{t("memberList.empty.invite")}</Link>
              </Button>
            }
            testId="directory-empty"
          />
        ) : groups.matched === 0 ? (
          <EmptyInvite
            headline={t("memberList.noMatch.headline")}
            detail={t(
              byEmail ? "memberList.noMatch.detail" : "memberList.noMatch.detailGuest",
              { query: searched }
            )}
            actions={
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                {t("memberList.noMatch.clear")}
              </Button>
            }
            testId="directory-no-match"
          />
        ) : (
          <>
            {section(t("memberList.group.people"), "directory-people", groups.people)}
            {section(t("memberList.group.agents"), "directory-agents", groups.agents)}
          </>
        )}
      </div>
    </div>
  );
}
