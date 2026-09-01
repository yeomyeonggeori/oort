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
import { relativeLabel } from "@momo/core/features/inbox/model";
import {
  channelLabel,
  memberFor,
  useChannels,
  useDirectory,
} from "@/features/workspace/useWorkspace";
import { FilterTabs } from "@/features/common/FilterTabs";
import { uuidEq, type MessageSearchHit } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import {
  serverSaysAbsent,
  serverSurface,
} from "@momo/core/features/capabilities/serverSurfaces";
import { SurfaceUnavailableSection } from "@/features/capabilities/SurfaceUnavailable";
import {
  ESCALATE_TO_WORKSPACE_DETAIL,
  ESCALATE_TO_WORKSPACE_LABEL,
  leadsWithEllipsis,
  trailsWithEllipsis,
  noResultsCopy,
  NO_RESULTS_SCOPE_NOTE,
  searchPlaceholder,
  searchScopeTabs,
  SHORT_QUERY_HINT,
  snippetSegments,
  type SearchChannelContext,
} from "@momo/core/features/search/searchModel";
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

/**
 * 이 목적지의 이름 — 사이드바 줄과 팔레트 항목이 읽는 그 한 줄 (이슈 #1146 N4).
 *
 * 표면 판정표가 이미 「사용자가 이 표면을 부르는 이름」을 들고 있으므로 여기서
 * 다시 짓지 않는다. 셋이 각자 적으면 한 목적지가 이름을 셋 갖고, 실제로 1차의
 * 사이드바가 「검색」이라고 적어 그 값을 치렀다.
 */
const SEARCH_SURFACE_NAME = serverSurface("messageSearch").label;

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
        className="tap-target flex flex-col gap-1 break-keep border-b border-line px-4 py-3 text-left transition-colors hover:bg-surface-hover focus-visible:focus-ring"
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
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const inputRef = useRef<HTMLInputElement>(null);

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  // `?channel=`은 채널에서 들어왔다는 인계다 (#1931). 팔레트의 「이 채널에서
  // 검색」이 싣고, 이 표면이 범위 칩의 기본값으로 받는다.
  //
  // 못 푼 id를 조용히 버리지 않는다: 그러면 사람이 고른 범위를 화면이 되돌리고,
  // 되돌린 사실은 아무 데도 적히지 않는다. 이름만 id 앞자리로 대신하고(행이
  // 이미 그렇게 한다) 범위는 그대로 둔 채 서버에 묻는다 — 읽을 수 없는 채널이면
  // 서버가 404로 답하고 그것이 참말이다.
  const scopedChannel: SearchChannelContext | null = useMemo(() => {
    const requested = params.get("channel");
    if (requested === null || requested.trim() === "") return null;
    const channel = channels.find((c) => uuidEq(c.id, requested));
    if (!channel) {
      return {
        channelId: requested,
        label: requested.slice(0, 8),
        isDirect: false,
      };
    }
    return {
      channelId: channel.id,
      label: channelLabel(channel, directoryQuery.directory, session.member.id),
      isDirect: channel.kind === "dm",
    };
    // 첫 렌더의 주소만 읽는다. 목록이 늦게 도착해 이름이 채워지는 것은 반영해야
    // 하므로 `channels`/`directory`는 의존성에 남는다.
  }, [params, channels, directoryQuery.directory, session.member.id]);

  const search = useMessageSearch(params.get("q") ?? "", scopedChannel);
  const scopeTabs = useMemo(
    () => searchScopeTabs(scopedChannel),
    [scopedChannel]
  );

  // 도착하면 캐럿이 입력 상자에 있다. 검색 표면에 와서 처음 하는 일은 언제나
  // 타자이고, 멤버 디렉터리가 같은 이유로 같은 것을 한다.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
        {/* 도착한 표면이 자기 이름을 말한다 — 그리고 그 말은 사이드바 줄·팔레트
            항목과 **같은 한 줄**에서 온다 (이슈 #1146 N4). */}
        <h1 className="text-body font-semibold" data-testid="search-title">
          {SEARCH_SURFACE_NAME}
        </h1>
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
            // 이 밭의 이름도 이 표면의 이름이다 (이슈 #1146 N4).
            aria-label={SEARCH_SURFACE_NAME}
            // 범위를 좁혀 뒀다면 안내문이 그 채널의 **이름**을 말한다. 칩은
            // 「이 채널에서」까지만 말할 수 있고(알약이 이름 길이를 따라
            // 출렁이면 안 되므로), 「이 채널」이 어느 채널인지는 여기서 답한다.
            placeholder={searchPlaceholder(search.scope, scopedChannel)}
            className="ps-8"
            data-testid="search-input"
          />
        </div>

        {/* 범위 칩은 채널을 들고 왔을 때만 있다. 좁힐 대상이 없는 자리에
            「이 채널에서」를 세우면 누를 수 없는 칩이 하나 생기고, 그것은
            컨트롤이 아니라 장식이다.

            인박스 탭·작업 흐름 필터와 **같은 컨트롤**이다(FilterTabs): 값만
            이 표면의 것이고 키보드 계약(정거장 1개, ←/→ 이동)과 기하는 그
            컨트롤의 것이다. */}
        {scopedChannel !== null && (
          <div className="mt-2">
            <FilterTabs
              spec={scopeTabs}
              value={search.scope}
              onChange={search.setScope}
            />
          </div>
        )}
      </form>

      {/* 범위 칩이 지배하는 패널. 탭은 선택된 값만 자기 패널을 가리키므로
          (FilterTabs) 여기 id는 하나면 되고, 실제로 이 표면의 결과 자리는
          범위와 무관하게 하나다. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        {...(scopedChannel === null
          ? {}
          : {
              id: scopeTabs.panelId(search.scope),
              role: "tabpanel",
              "aria-labelledby": scopeTabs.tabId(search.scope),
            })}
      >
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

        {search.phase === "empty" &&
          // 좁힌 범위에서 빈손인 것과 전체에서 빈손인 것은 다른 소식이다.
          // 앞은 「옆 채널을 보라」이고 뒤는 「내가 속한 곳에는 없다」인데, 한
          // 문장으로 뭉뚱그리면 앞의 경우에 사람이 검색을 그만둔다.
          (search.scope === "channel" && scopedChannel !== null ? (
            <EmptyInvite
              headline={noResultsCopy(
                search.query,
                search.scope,
                scopedChannel
              )}
              detail={ESCALATE_TO_WORKSPACE_DETAIL}
              // 승격은 **한 번의 누름**이다. 문구만 두고 컨트롤을 두지 않으면
              // 「전체에서 찾아보세요」는 칩을 다시 찾아 누르라는 숙제이고,
              // 이 표면은 방금 그 사람의 질의를 이미 들고 있다. 질의는 그대로
              // 남으므로 다시 칠 일도 없다.
              actions={
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => search.setScope("workspace")}
                  data-testid="search-empty-escalate"
                >
                  {ESCALATE_TO_WORKSPACE_LABEL}
                </Button>
              }
              testId="search-empty"
              dataAttrs={{ "data-scope": "channel" }}
            />
          ) : (
            <EmptyInvite
              headline={noResultsCopy(search.query)}
              detail={NO_RESULTS_SCOPE_NOTE}
              testId="search-empty"
              dataAttrs={{ "data-scope": "workspace" }}
            />
          ))}

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
