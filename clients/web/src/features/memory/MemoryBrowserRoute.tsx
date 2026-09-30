import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import { useSession } from "@/app/session";
import { useShellNav } from "@/app/shellNav";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { memberFor, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import type { MemoryItem } from "@momo/core/features/memory/model";
import {
  BROWSER_ALL_CHANNELS,
  BROWSER_ALL_KINDS,
  BROWSER_BACK_TO_LIST,
  BROWSER_EMPTY_DETAIL,
  BROWSER_EMPTY_HEADLINE,
  BROWSER_LEAD,
  BROWSER_OFFLINE,
  BROWSER_LOAD_MORE,
  BROWSER_NO_MATCH_DETAIL,
  BROWSER_NO_MATCH_HEADLINE,
  BROWSER_PAUSED_LINK,
  BROWSER_PAUSED_NOTICE,
  BROWSER_PERSONAL_SPACE,
  BROWSER_PICK_ONE,
  BROWSER_SEARCH_LABEL,
  BROWSER_SEARCH_NOTE,
  BROWSER_SEARCH_PLACEHOLDER,
  BROWSER_TITLE,
  MEMORY_KIND_OPTIONS,
  MEMORY_STATUS_OPTIONS,
  isMemoryKind,
  isMemoryStatus,
  itemReadError,
  memoryKindLabel,
} from "@momo/core/features/memory/browser";
import {
  TIMELINE_VIEW_LIST,
  TIMELINE_VIEW_TIMELINE,
} from "@momo/core/features/memory/timeline";
import { DecisionTimeline } from "./DecisionTimeline";
import { MemoryItemDetailPane } from "./MemoryItemDetailPane";
import { useMemoryItemList, useMemorySettings } from "./useMemory";

// =============================================================================
// 기억 브라우저 (ADR-0196 D12 V4, #3170): 목록 · 필터 · 검색 · 상세.
//
// 왜 설정의 한 절이 아니라 자기 라우트인가. 설정의 절은 한 칸짜리 폼 목록이라 「목록을
// 훑다가 하나를 열어 근거와 이력을 보고 고친다」는 좌우 두 칸 흐름을 담을 자리가 없고,
// 주소로 한 기억을 가리킬 수도 없다(제안 카드의 「기억 보기」, 근거 역링크가 모두 주소를
// 쓴다). 그래서 `/memory`가 목록과 상세를 함께 들고, 상태는 전부 주소의 쿼리에 산다
// (`channel · kind · status · q · item`). 설정 › 기억은 일시정지 스위치를 그대로 들고
// 이 화면으로 가는 길을 준다.
//
// 폰 폭에서는 한 칸씩이다: 기억을 고르면 상세만 보이고 「목록으로」가 돌려준다.
// =============================================================================

const ROW_CLASS =
  "flex w-full min-w-0 flex-col gap-1 border-b border-line px-4 py-3 text-left hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring";

const DAY = new Intl.DateTimeFormat("ko-KR", { month: "long", day: "numeric" });

export function MemoryBrowserRoute() {
  const { workspaceId, connStatus } = useSession();
  const { isMobile } = useShellNav();
  const offline = useOffline() || connStatus === "disconnected";
  const [params, setParams] = useSearchParams();
  const channelId = params.get("channel") ?? "";
  const kindParam = params.get("kind");
  const statusParam = params.get("status");
  const kind = isMemoryKind(kindParam) ? kindParam : undefined;
  const status = isMemoryStatus(statusParam) ? statusParam : "active";
  const q = params.get("q") ?? "";
  const itemId = params.get("item");
  // 결정 타임라인(V5)은 같은 라우트의 다른 보기다: 채널 필터만 함께 쓰고 종류·상태·검색은 접는다.
  const timelineView = params.get("view") === "timeline";

  const [searchText, setSearchText] = useState(q);
  const [notice, setNotice] = useState<string | null>(null);
  const [focusDetail, setFocusDetail] = useState(false);

  // 주소가 바뀌면(뒤로 가기) 입력 칸도 따라간다.
  useEffect(() => setSearchText(q), [q]);

  // 입력이 멈춘 뒤에 주소로 옮긴다. 글자마다 요청을 보내지 않는다.
  useEffect(() => {
    const trimmed = searchText.trim();
    if (trimmed === q) return;
    const timer = window.setTimeout(() => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (trimmed === "") next.delete("q");
          else next.set("q", trimmed);
          return next;
        },
        { replace: true }
      );
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchText, q, setParams]);

  function setParam(name: string, value: string | null) {
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value === null || value === "") next.delete(name);
      else next.set(name, value);
      return next;
    });
  }

  const channels = useChannels(workspaceId);
  const directory = useDirectory(workspaceId).directory;
  const settings = useMemorySettings(workspaceId);
  const channelNames = useMemo(() => {
    const map = new Map<string, string>();
    for (const channel of [...channels.groups.channels, ...channels.groups.dms]) {
      map.set(channel.id.toLowerCase(), channel.name ?? "");
    }
    return map;
  }, [channels.groups]);

  const list = useMemoryItemList(workspaceId, {
    ...(channelId !== "" ? { channelId } : {}),
    ...(kind !== undefined ? { kind } : {}),
    status,
    ...(q.trim() !== "" ? { q: q.trim() } : {}),
  });
  const items: MemoryItem[] = list.data?.pages.flatMap((page) => page.items) ?? [];
  const searching = q.trim() !== "";
  const filtered = channelId !== "" || kind !== undefined || status !== "active" || searching;
  const readError = list.isError ? itemReadError(list.error, "list") : null;

  function itemChannelLabel(item: MemoryItem): string {
    if (item.spaceKind === "personal") return BROWSER_PERSONAL_SPACE;
    const name = channelNames.get(item.channelId.toLowerCase());
    return name !== undefined && name !== "" ? `# ${name}` : "채널";
  }

  const showDetail = itemId !== null;
  const showList = !isMobile || !showDetail;
  const showDetailPane = !isMobile || showDetail;

  return (
    <div className="flex min-w-0 flex-1 flex-col" data-testid="memory-browser">
      <header className="border-b border-line px-4 py-2">
        <div className="flex w-full items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <SidebarDrawerToggle />
            <h1 className="text-body font-semibold">{BROWSER_TITLE}</h1>
          </div>
          <Link
            to="/settings?section=memory"
            className="tap-target inline-flex h-control-sm items-center rounded-md px-3 text-meta text-ink-muted press hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
            data-testid="memory-browser-settings"
          >
            기억 설정
          </Link>
        </div>
      </header>

      {settings.data?.me.paused === true && (
        <div
          className="flex flex-wrap items-center gap-3 border-b border-line bg-surface-muted px-4 py-2"
          data-testid="memory-browser-paused"
        >
          <p className="break-keep text-meta text-ink">{BROWSER_PAUSED_NOTICE}</p>
          <Link
            to="/settings?section=memory"
            className="text-meta text-ink underline underline-offset-2 press focus-visible:focus-ring"
          >
            {BROWSER_PAUSED_LINK}
          </Link>
        </div>
      )}

      {notice !== null && (
        <InlineBanner
          tone="neutral"
          message={notice}
          actionLabel="닫기"
          onAction={() => setNotice(null)}
          testId="memory-browser-notice"
        />
      )}

      {offline && (
        <InlineBanner
          tone="neutral"
          message={BROWSER_OFFLINE}
          testId="memory-browser-offline"
        />
      )}

      <div className="flex min-h-0 flex-1">
        {showList && (
          <section
            aria-label="기억 목록"
            className={cn(
              "flex min-h-0 min-w-0 flex-col",
              isMobile ? "flex-1" : "w-pane-picker shrink-0 border-r border-line"
            )}
            data-testid="memory-browser-list-pane"
          >
            <div className="flex flex-col gap-2 border-b border-line px-4 py-3">
              <div
                role="group"
                aria-label="보기 방식"
                className="flex gap-2"
                data-testid="memory-browser-views"
              >
                {(
                  [
                    { value: null, label: TIMELINE_VIEW_LIST },
                    { value: "timeline", label: TIMELINE_VIEW_TIMELINE },
                  ] as const
                ).map((view) => {
                  const active = (view.value === "timeline") === timelineView;
                  return (
                    <Button
                      key={view.label}
                      type="button"
                      size="sm"
                      variant={active ? "secondary" : "ghost"}
                      className="tap-target"
                      aria-pressed={active}
                      onClick={() => setParam("view", view.value)}
                      data-testid={`memory-browser-view-${view.value ?? "list"}`}
                    >
                      {view.label}
                    </Button>
                  );
                })}
              </div>
              <p className="break-keep text-meta text-ink-muted">{BROWSER_LEAD}</p>
              {!timelineView && (
              <Input
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                aria-label={BROWSER_SEARCH_LABEL}
                placeholder={BROWSER_SEARCH_PLACEHOLDER}
                data-testid="memory-browser-search"
              />
              )}
              <div className="grid grid-cols-2 gap-2">
                <Select
                  aria-label="채널"
                  className="col-span-2"
                  value={channelId}
                  onChange={(event) => setParam("channel", event.target.value)}
                  data-testid="memory-browser-filter-channel"
                >
                  <option value="">{BROWSER_ALL_CHANNELS}</option>
                  {channels.groups.channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      # {channel.name}
                    </option>
                  ))}
                </Select>
                {!timelineView && (
                <Select
                  aria-label="종류"
                  value={kind ?? ""}
                  onChange={(event) => setParam("kind", event.target.value)}
                  data-testid="memory-browser-filter-kind"
                >
                  <option value="">{BROWSER_ALL_KINDS}</option>
                  {MEMORY_KIND_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                )}
                {!timelineView && (
                <Select
                  aria-label="상태"
                  value={status}
                  onChange={(event) =>
                    setParam("status", event.target.value === "active" ? null : event.target.value)
                  }
                  disabled={searching}
                  data-testid="memory-browser-filter-status"
                >
                  {MEMORY_STATUS_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </Select>
                )}
              </div>
              {searching && !timelineView && (
                <p className="break-keep text-meta text-ink-muted" data-testid="memory-browser-search-note">
                  {BROWSER_SEARCH_NOTE}
                </p>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto" data-testid="memory-browser-list">
              {timelineView ? (
                <DecisionTimeline
                  workspaceId={workspaceId}
                  channelId={channelId}
                  selectedItemId={itemId}
                  channelNames={channelNames}
                  onOpenItem={(id) => {
                    setFocusDetail(isMobile);
                    setParam("item", id);
                  }}
                />
              ) : list.isPending ? (
                <Skeleton ready={false} rows={6} />
              ) : readError !== null ? (
                <InlineBanner
                  tone={readError.kind === "absent" ? "neutral" : "error"}
                  message={readError.message}
                  {...(readError.kind === "absent"
                    ? {}
                    : { actionLabel: "다시 시도", onAction: () => void list.refetch() })}
                  testId="memory-browser-error"
                />
              ) : items.length === 0 ? (
                filtered ? (
                  <EmptyInvite
                    headline={BROWSER_NO_MATCH_HEADLINE}
                    detail={BROWSER_NO_MATCH_DETAIL}
                    actions={
                      <Button
                        variant="outline"
                        size="sm"
                        className="tap-target"
                        onClick={() => {
                          setSearchText("");
                          setParams(new URLSearchParams(), { replace: false });
                        }}
                      >
                        필터 지우기
                      </Button>
                    }
                    testId="memory-browser-no-match"
                  />
                ) : (
                  <EmptyInvite
                    headline={BROWSER_EMPTY_HEADLINE}
                    detail={BROWSER_EMPTY_DETAIL}
                    testId="memory-browser-empty"
                  />
                )
              ) : (
                <>
                  <ul>
                    {items.map((item) => {
                      const selected = itemId?.toLowerCase() === item.id.toLowerCase();
                      return (
                        <li key={item.id}>
                          <button
                            type="button"
                            className={cn(ROW_CLASS, selected && "bg-surface-muted")}
                            aria-current={selected ? "true" : undefined}
                            data-testid="memory-browser-row"
                            data-item-id={item.id}
                            onClick={() => {
                              // 폰에서는 목록이 사라지므로 캐럿을 상세로 옮긴다. 데스크탑은 목록에
                              // 남아 화살표로 훑을 수 있게 둔다.
                              setFocusDetail(isMobile);
                              setParam("item", item.id);
                            }}
                          >
                            <span className="flex flex-wrap items-center gap-2">
                              <span className="rounded-full bg-surface-muted px-2 py-1 text-meta text-ink-muted">
                                {memoryKindLabel(item.kind)}
                              </span>
                              {(item.retiredAtMs !== undefined || item.supersededById !== undefined) && (
                                <span className="text-meta text-ink-muted">지난 버전</span>
                              )}
                            </span>
                            <span className="line-clamp-2 break-keep text-body text-ink">
                              {item.body}
                            </span>
                            <span className="text-meta text-ink-muted">
                              {itemChannelLabel(item)} · {DAY.format(item.recordedAtMs)}
                              {item.editedByMemberId !== undefined
                                ? ` · 고친 사람 ${memberFor(directory, item.editedByMemberId)?.displayName ?? "알 수 없는 멤버"}`
                                : ""}
                            </span>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                  {list.hasNextPage && (
                    <div className="px-4 py-3">
                      <Button
                        variant="outline"
                        size="sm"
                        className="tap-target"
                        aria-busy={list.isFetchingNextPage || undefined}
                        onClick={() => {
                          if (!list.isFetchingNextPage) void list.fetchNextPage();
                        }}
                        data-testid="memory-browser-more"
                      >
                        {BROWSER_LOAD_MORE}
                      </Button>
                    </div>
                  )}
                </>
              )}
            </div>
          </section>
        )}

        {showDetailPane && (
          <section
            aria-label="기억 상세"
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            data-testid="memory-browser-detail-pane"
          >
            {isMobile && showDetail && (
              <div className="border-b border-line px-4 py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  className="tap-target -ml-3"
                  onClick={() => setParam("item", null)}
                  data-testid="memory-browser-back"
                >
                  <ArrowLeft aria-hidden="true" />
                  {BROWSER_BACK_TO_LIST}
                </Button>
              </div>
            )}
            {itemId === null ? (
              items.length > 0 ? (
                <p className="break-keep px-4 py-6 text-body text-ink-muted" data-testid="memory-browser-pick">
                  {BROWSER_PICK_ONE}
                </p>
              ) : null
            ) : (
              <MemoryItemDetailPane
                key={itemId}
                workspaceId={workspaceId}
                itemId={itemId}
                offline={offline}
                channelNames={channelNames}
                onOpenItem={(id) => setParam("item", id)}
                focusOnMount={focusDetail}
                onChanged={({ nextItemId, message }) => {
                  setNotice(message);
                  setFocusDetail(nextItemId !== null);
                  setParam("item", nextItemId);
                  // 상세가 사라지면 캐럿은 목록의 검색 칸으로 간다(닫힌 곳에 남지 않게).
                  if (nextItemId === null) {
                    window.setTimeout(() => {
                      document
                        .querySelector<HTMLElement>('[data-testid="memory-browser-search"]')
                        ?.focus();
                    }, 0);
                  }
                }}
              />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
