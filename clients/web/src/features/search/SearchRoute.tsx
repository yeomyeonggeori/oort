import { useEffect, useMemo, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import { useSession } from "@/app/session";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import {
  EmptyInvite,
  InlineBanner,
  SkeletonRows,
} from "@/features/common/States";
import { searchHitPath } from "@/features/inbox/anchor";
import { relativeLabel } from "@/features/inbox/model";
import {
  channelLabel,
  memberFor,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { uuidEq, type MessageSearchHit } from "@/lib/api";
import { NetworkError } from "@/lib/http";
import { serverSaysAbsent } from "@/features/capabilities/serverSurfaces";
import { SurfaceUnavailableSection } from "@/features/capabilities/SurfaceUnavailable";
import {
  leadsWithEllipsis,
  trailsWithEllipsis,
  noResultsCopy,
  NO_RESULTS_SCOPE_NOTE,
  SHORT_QUERY_HINT,
  snippetSegments,
} from "./searchModel";
import { useMessageSearch } from "./useMessageSearch";

// =============================================================================
// 메시지 검색 (goal B12 H5).
//
// Design read: 검색 결과 목록 표면, 사내 팀 사용자(web+Tauri), 밀도 6/10, 모션 2/10.
//
// ⌘K 팔레트가 이미 있지만 이 표면은 그 안이 아니라 자기 라우트에 산다. 팔레트는
// **이미 받아 둔 목록을 cmdk가 클라이언트에서 걸러내는** 이동 장치이고(채널·사람·
// 설정), 메시지 검색은 서버에 묻고 기다리고 페이지를 넘기는 일이다. 둘을 한
// 리스트에 넣으면 cmdk의 동기 필터가 비동기 결과와 싸우고, 로딩·오류·빈 결과라는
// 세 상태가 갈 곳이 없어진다. 대신 팔레트에는 **이 표면으로 오는 자리**를 둔다
// (QuickSwitcher의 "메시지 검색"): 편승은 하되 흉내는 내지 않는다.
// =============================================================================

/** 한 줄. 채널 · 작성자 · 시각 · 본문 스니펫, 그리고 눌러서 원문으로. */
function HitRow({
  hit,
  query,
  channelName,
  authorName,
  isAgent,
  nowMs,
}: {
  hit: MessageSearchHit;
  query: string;
  channelName: string;
  authorName: string;
  isAgent: boolean;
  nowMs: number;
}) {
  const segments = snippetSegments(hit.snippet, hit.matchOffset, query);
  return (
    <li>
      <Link
        // msg와 seq를 함께 싣는다: 앞은 찾는 데, 뒤는 **못 찾았을 때 이유를
        // 말하는 데** 쓰인다 (ChatShell의 anchorMissed).
        to={searchHitPath(hit.channelId, hit.messageId, hit.seq)}
        // `tap-target`은 폰에서만 이 행을 44px로 세운다. 사이드바 행이 같은
        // 유틸리티를 같은 이유로 쓴다.
        className="tap-target flex flex-col gap-1 break-keep border-b border-line px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        data-testid="search-hit"
        data-channel-id={hit.channelId}
        data-message-id={hit.messageId}
      >
        <span className="flex flex-wrap items-baseline gap-2">
          <span className="min-w-0 truncate text-meta font-medium text-ink">
            {channelName}
          </span>
          {/* 에이전트 정체성은 --agent 토큰뿐이다. 행 모양도 배경도 바꾸지 않는다. */}
          <span
            className={`min-w-0 truncate text-meta ${
              isAgent ? "text-agent" : "text-ink-muted"
            }`}
          >
            {authorName}
          </span>
          <span className="text-timestamp text-ink-muted" data-numeric>
            {relativeLabel(hit.createdAtMs, nowMs)}
          </span>
        </span>
        <span className="break-words text-body text-ink">
          {leadsWithEllipsis(hit.matchOffset) && (
            <span className="text-ink-muted" aria-hidden="true">
              …
            </span>
          )}
          {segments.before}
          {segments.match !== "" && (
            // 강조는 배경 톤 하나로 끝낸다. 굵게까지 겹치면 한국어 본문에서
            // 글자가 번져 보이고, 이 행에서 무거워야 할 것은 본문이 아니라
            // 채널 이름이다.
            <mark className="bg-accent-soft text-ink" data-testid="search-match">
              {segments.match}
            </mark>
          )}
          {segments.after}
          {trailsWithEllipsis(hit.snippet, query) && (
            <span className="text-ink-muted" aria-hidden="true">
              …
            </span>
          )}
        </span>
      </Link>
    </li>
  );
}

export function SearchRoute() {
  const { session, workspaceId } = useSession();
  // ⌘K 팔레트가 이름으로 못 찾았을 때 친 말을 그대로 들고 넘어온다. 넘겨받고도
  // 빈 상자를 보여주면 그 인계는 인계가 아니라 초기화다.
  const [params] = useSearchParams();
  const search = useMessageSearch(params.get("q") ?? "");
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const inputRef = useRef<HTMLInputElement>(null);

  // 도착하면 캐럿이 입력 상자에 있다. 검색 표면에 와서 처음 하는 일은 언제나
  // 타자이고, 멤버 디렉터리가 같은 이유로 같은 것을 한다.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  const nowMs = Date.now();

  function channelNameFor(channelId: string): string {
    const channel = channels.find((c) => uuidEq(c.id, channelId));
    // 못 푼 id는 id로 보여준다. 이름을 지어내지 않는다.
    if (!channel) return channelId.slice(0, 8);
    return channelLabel(channel, directoryQuery.directory, session.member.id);
  }

  function authorFor(memberId: string): { name: string; isAgent: boolean } {
    const member = memberFor(directoryQuery.directory, memberId);
    if (!member) return { name: memberId.slice(0, 8), isAgent: false };
    return { name: member.displayName, isAgent: member.kind === "agent" };
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="search-route">
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        <SidebarDrawerToggle />
        <h1 className="text-body font-semibold">메시지 검색</h1>
      </header>

      {/* `role="search"`을 form이 갖는다. 제출은 막는다: 결과는 타자를 멈추면
          이미 와 있고, Enter가 페이지를 새로 고치면 그 결과가 사라진다. */}
      <form
        role="search"
        className="border-b border-line px-4 py-3"
        onSubmit={(event) => event.preventDefault()}
      >
        <div className="relative">
          <Search
            className="pointer-events-none absolute start-3 top-2 size-4 text-ink-muted"
            aria-hidden="true"
          />
          <Input
            ref={inputRef}
            type="search"
            value={search.raw}
            onChange={(event) => search.setRaw(event.target.value)}
            aria-label="메시지 검색"
            placeholder="메시지 내용으로 검색"
            className="ps-8"
            data-testid="search-input"
          />
        </div>
      </form>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {search.phase === "idle" && (
          <EmptyInvite
            headline="메시지를 검색합니다."
            detail="내가 속한 채널에 오간 말 중에서 찾습니다. 단어 일부만 입력해도 됩니다."
            testId="search-idle"
          />
        )}

        {search.phase === "tooShort" && (
          <EmptyInvite headline={SHORT_QUERY_HINT} testId="search-too-short" />
        )}

        {search.phase === "searching" && (
          <SkeletonRows rows={5} className="p-4" />
        )}

        {search.phase === "error" &&
          // 미제공과 장애는 다른 문장이다. 이 서버가 검색 라우트를 싣고 있다는
          // 것은 판정표의 사실이지만, 표가 서버보다 앞서 갔을 수 있다. 그때는
          // 오류가 아니라 미제공으로 접는다 (이중 방어의 (b)).
          (serverSaysAbsent(search.error) ? (
            <SurfaceUnavailableSection
              surface="messageSearch"
              testId="search-unavailable"
            />
          ) : (
            <InlineBanner
              message={
                search.error instanceof NetworkError
                  ? search.error.message
                  : "검색하지 못했습니다. 잠시 뒤 다시 시도하세요."
              }
              actionLabel="다시 시도"
              onAction={search.retry}
              testId="search-error"
            />
          ))}

        {search.phase === "empty" && (
          <EmptyInvite
            headline={noResultsCopy(search.query)}
            detail={NO_RESULTS_SCOPE_NOTE}
            testId="search-empty"
          />
        )}

        {search.phase === "results" && (
          <>
            <ul data-testid="search-results">
              {search.hits.map((hit) => {
                const author = authorFor(hit.authorMemberId);
                return (
                  <HitRow
                    key={hit.messageId}
                    hit={hit}
                    query={search.query}
                    channelName={channelNameFor(hit.channelId)}
                    authorName={author.name}
                    isAgent={author.isAgent}
                    nowMs={nowMs}
                  />
                );
              })}
            </ul>
            {search.hasMore && (
              <div className="px-4 py-3">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={search.loadMore}
                  aria-busy={search.isLoadingMore || undefined}
                  data-testid="search-load-more"
                >
                  {search.isLoadingMore ? "불러오는 중" : "더 보기"}
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
