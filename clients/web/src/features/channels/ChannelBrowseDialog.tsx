import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { Check, Hash, Loader2 } from "lucide-react";
import type { Channel } from "@momo/core/lib/api";
import {
  browseChannels,
  channelBrowseLoadFailure,
  hiddenPublicChannels,
  splitBrowseRows,
  CHANNEL_BROWSE_QUERY_MAX,
  type BrowseChannel,
  type ChannelBrowseFailure,
} from "@momo/core/features/channels/browse";
import { looseTailIncludes } from "@momo/core/features/channels/nameSearch";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { memberFor, useChannels, useDirectory } from "@/features/workspace/useWorkspace";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useSession } from "@/app/session";
import {
  ChannelBrowseOpenContext,
  ChannelBrowseOpenStateContext,
  useJoinBrowsedChannel,
  type ChannelBrowseTarget,
} from "./useChannelBrowse";
import { useSetBrowseListed } from "./useSetBrowseListed";

// =============================================================================
// 채널 둘러보기 창 (ADR-0224 화면 · D3 · D4 · D10, #5842). Reading this as: a picker dialog in the shell for internal
// team members on web+Tauri, density 6, motion 2.
//
// 목록은 서버(`GET …/channels/browse`)가 준 줄 그대로다 — 켜진(browse_listed) · 보관 안 된 공개 채널만. 화면은 다른 목록
// (내 채널 캐시 등)을 섞지 않고, 서버가 참여 여부로 줄을 세우지 않으니 `isMember` 로 「참여하지 않은 채널」을 위로 나눈다.
//
// 움직이지 않기: 목록 자리는 높이가 정해진 한 칸이라 불러오는 중 · 비어 있음 · 실패 · 목록이 바뀌어도 창의 높이와 아래
// 단추 줄이 그대로다. 줄 하나의 실패는 그 줄의 둘째 층(멤버 수 자리)에 서고, 그 사이 꺼진 채널(404)은 줄을 걷되 같은 자리에
// 같은 두 층으로 문장이 선다 — 아래 줄이 올라오지 않는다. 새 거르기 말의 답을 기다리는 동안 앞 목록을 그대로 둔다.
//
// 한글 조합(트랙의 #5880 도우미): 서버에는 **확정된 글자**만 보낸다(조합이 시작된 순간의 값 — 마지막 음절은 다음 글쇠까지
// 조합 중이라 `compositionend` 만 기다리면 다 친 낱말이 늦게 간다). 조합 중에도 목록은 이미 받은 줄을 화면에서 좁힌다:
// 지금 칸 값으로, 마지막 글자는 `looseTailIncludes` 로 느슨하게(`디장` ↔ 디자인) — 줄이 조합 도중에 깜빡이지 않는다.
//
// #5843: 소유자 · 관리자에게는 목록 아래에 「둘러보기에 안 보이는 공개 채널」 묶음이 하나 더 선다. 줄은 서버의 둘러보기 목록이 아니라
// **내가 든** 꺼진 공개 채널(내 채널 목록에서 `kind == 'public' && browseListed === false`)이다 — 관리자가 들지 않은 채널은 서버도
// 이 길로 닿지 못한다(404). 켜면 응답의 채널이 내 채널 캐시에 서서 그 줄이 묶음에서 빠지고, 위 서버 목록은 다시 읽는다. 묶음이 비면
// 묶음 자체가 서지 않는다. 목록 자리는 `h-pane` 고정이라 묶음이 서고 걷혀도 창 높이는 그대로다.
// =============================================================================

/** 서버 거르기를 보내기 전에 쉬는 시간. 확정된 낱말을 이어 칠 때 글자마다 요청이 나가지 않게. */
const QUERY_SETTLE_MS = 250;

const GROUP_HEADING_CLASS = "border-b border-line px-4 py-1 text-meta font-medium text-ink-muted";

/** 화면에서 좁히기: 이름 · 주제에 그대로 들어 있거나, 조합 중인 마지막 글자까지 느슨하게 맞으면 남는다. */
function rowMatches(row: BrowseChannel, typed: string): boolean {
  const needle = typed.trim().toLowerCase();
  if (needle === "") return true;
  const fields = row.topic === undefined ? [row.name] : [row.name, row.topic];
  return fields.some((field) => field.toLowerCase().includes(needle) || looseTailIncludes(needle, field));
}

function useSettled(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (value === settled) return;
    const timer = window.setTimeout(() => setSettled(value), QUERY_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [value, settled]);
  return settled;
}

function BrowseRow({
  row,
  pending,
  failure,
  gone,
  offline,
  onJoin,
  onOpen,
}: {
  row: BrowseChannel;
  pending: boolean;
  failure: ChannelBrowseFailure | undefined;
  /** 참여가 404 로 돌아왔다(그 사이 꺼졌거나 보관됨): 줄은 걷히고 같은 자리에 문장이 선다. */
  gone: boolean;
  offline: boolean;
  onJoin: (channelId: string) => void;
  onOpen: (channelId: string) => void;
}) {
  const formatMessage = useFormatMessage();
  const failed = failure !== undefined && !gone;
  const second = gone
    ? formatMessage("channels.browse.joinNotFound")
    : failed
      ? formatMessage(failure.key, failure.values as never)
      : [formatMessage("channels.browse.memberCount", { count: row.memberCount }), row.topic]
          .filter((part) => part !== undefined && part !== "")
          .join(" · ");

  return (
    <li
      className="flex flex-col border-b border-line last:border-b-0"
      data-testid="channel-browse-row"
      data-channel-id={row.id}
      data-member={row.isMember ? "" : undefined}
      data-gone={gone ? "" : undefined}
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Hash className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2 text-body">
            <span className={cn("min-w-0 truncate font-semibold", gone ? "text-ink-muted" : "text-ink")}>
              {row.name}
            </span>
            {row.isDefault && !gone && (
              <span className={cn(CHIP_CLASS, "bg-muted-soft text-ink-muted")} data-testid="channel-browse-default">
                {formatMessage("channels.browse.default")}
              </span>
            )}
          </span>
          {/* 둘째 층은 늘 한 줄 자리다: 멤버 수 · 주제, 또는 그 줄의 실패 문장. 실패가 그 자리를 갈아 끼우므로 줄 높이가 그대로다.
              실패 문장만 줄바꿈을 허락한다(잘린 이유는 읽을 수 없다) — 좁은 폭에서만 그 줄이 자란다. */}
          <span
            className={cn(
              "block min-w-0 text-meta",
              gone || failed ? "break-keep text-danger" : "truncate text-ink-muted",
              gone && "text-ink-muted"
            )}
            role={gone || failed ? "alert" : undefined}
            data-testid={gone || failed ? "channel-browse-row-error" : "channel-browse-row-meta"}
          >
            {second}
          </span>
        </span>
        {gone ? null : row.isMember ? (
          <span className="flex shrink-0 items-center gap-2">
            <span className="inline-flex items-center gap-1 text-meta text-ink-muted" data-testid="channel-browse-joined">
              <Check className="size-4" aria-hidden="true" />
              {formatMessage("channels.browse.joined")}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0"
              aria-label={formatMessage("channels.browse.openAria", { name: row.name })}
              onClick={() => onOpen(row.id)}
              data-browse-action=""
              data-testid="channel-browse-open"
            >
              {formatMessage("channels.browse.open")}
            </Button>
          </span>
        ) : (
          // 진행 중은 비활성이 아니라 바쁜 것이다(멤버 추가 창과 같은 규칙): 흐려진 라벨은 「못 한다」로 읽힌다. 겹친 누름은 훅이
          // 버린다. 오프라인만 진짜 disabled 이고 이유는 위 띠가 말한다.
          <Button
            size="sm"
            variant="outline"
            className="shrink-0"
            disabled={offline}
            aria-busy={pending || undefined}
            aria-label={formatMessage("channels.browse.joinAria", { name: row.name })}
            onClick={() => onJoin(row.id)}
            data-browse-action=""
            data-testid="channel-browse-join"
          >
            {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {formatMessage(failed ? "channels.browse.retry" : "channels.browse.join")}
          </Button>
        )}
      </div>
    </li>
  );
}

/** 묶음의 한 줄: 내가 든 꺼진 공개 채널 + 「둘러보기에 보이기」 단추. 실패는 둘째 층(주제 자리)을 갈아 끼워 줄 높이가 그대로다. */
function HiddenRow({
  channel,
  pending,
  failure,
  offline,
  onShow,
}: {
  channel: Channel;
  pending: boolean;
  failure: string | undefined;
  offline: boolean;
  onShow: (channelId: string) => void;
}) {
  const formatMessage = useFormatMessage();
  const name = channel.name ?? "";
  return (
    <li
      className="flex flex-col border-b border-line last:border-b-0"
      data-testid="channel-browse-hidden-row"
      data-channel-id={channel.id}
    >
      <div className="flex items-center gap-3 px-4 py-2">
        <Hash className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="min-w-0 truncate text-body font-semibold text-ink">{name}</span>
          {failure !== undefined ? (
            <span className="block min-w-0 break-keep text-meta text-danger" role="alert" data-testid="channel-browse-hidden-error">
              {failure}
            </span>
          ) : channel.topic !== undefined && channel.topic !== "" ? (
            <span className="block min-w-0 truncate text-meta text-ink-muted">{channel.topic}</span>
          ) : null}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0"
          disabled={offline}
          aria-busy={pending || undefined}
          aria-label={formatMessage("channels.browse.switchShowAria", { name })}
          onClick={() => onShow(channel.id)}
          data-browse-action=""
          data-testid="channel-browse-hidden-show"
        >
          {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {formatMessage(failure !== undefined ? "channels.browse.retry" : "channels.browse.switchLabel")}
        </Button>
      </div>
    </li>
  );
}

function ChannelBrowsePanel({
  target,
  onClose,
}: {
  target: ChannelBrowseTarget;
  onClose: () => void;
}) {
  const { session, workspaceId } = useSession();
  const navigate = useNavigate();
  const formatMessage = useFormatMessage();
  const offline = useOffline();
  const { directory } = useDirectory(workspaceId);
  const role = memberFor(directory, session.member.id)?.role;
  const isAdmin = role === "owner" || role === "admin";

  const initial = (target.query ?? "").slice(0, CHANNEL_BROWSE_QUERY_MAX);
  // 칸 값(`typed`)과 서버에 보낼 확정된 값(`committed`)은 조합 중에만 갈린다.
  const [typed, setTyped] = useState(initial);
  const [committed, setCommitted] = useState(initial);
  const composing = useRef(false);
  const serverQuery = useSettled(committed.trim());

  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [gone, setGone] = useState<ReadonlySet<string>>(() => new Set());

  // 소유자 · 관리자의 「둘러보기에 안 보이는 공개 채널」 묶음(#5843).
  const { groups } = useChannels(workspaceId);
  const browseSwitch = useSetBrowseListed(workspaceId);
  const [switchFailures, setSwitchFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const showInBrowse = useCallback(
    (channelId: string) => {
      setSwitchFailures((current) => {
        if (!current.has(channelId)) return current;
        const next = new Map(current);
        next.delete(channelId);
        return next;
      });
      void browseSwitch.run(channelId, true).then((result) => {
        if (result === null || result.ok) return;
        const message = formatMessage(result.failure.key, result.failure.values as never);
        setSwitchFailures((current) => new Map(current).set(channelId, message));
      });
    },
    [browseSwitch, formatMessage]
  );

  const { pending, failures, join } = useJoinBrowsedChannel(useCallback(() => onClose(), [onClose]));

  // 창이 열려 있는 동안에만 산다(`gcTime: 0`): 열 때마다 다시 읽는다 — 관리자가 방금 켠 채널이 다음에 열 때 보인다.
  const query = useInfiniteQuery({
    queryKey: ["channel-browse", workspaceId, serverQuery],
    queryFn: ({ pageParam }) => browseChannels(workspaceId, { q: serverQuery, cursor: pageParam }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor,
    placeholderData: keepPreviousData,
    gcTime: 0,
    staleTime: 0,
    retry: false,
  });

  const rows = useMemo(
    () => (query.data?.pages ?? []).flatMap((page) => page.channels).filter((row) => rowMatches(row, typed)),
    [query.data, typed]
  );
  const { notJoined, joined } = splitBrowseRows(rows);
  const hidden = useMemo(
    () =>
      isAdmin
        ? hiddenPublicChannels(groups.channels).filter((channel) =>
            rowMatches({ id: channel.id, name: channel.name ?? "", topic: channel.topic, memberCount: 0, isMember: true, isDefault: false }, typed)
          )
        : [],
    [isAdmin, groups.channels, typed]
  );

  const handleJoin = useCallback(
    (channelId: string) => {
      void join(channelId);
    },
    [join]
  );
  const handleOpen = useCallback(
    (channelId: string) => {
      onClose();
      navigate(`/c/${channelId}`);
    },
    [navigate, onClose]
  );

  // 404 는 그 줄을 걷는다(같은 자리에 문장). 그 밖의 실패는 줄에 남아 다시 시도를 받는다.
  useEffect(() => {
    const notFound = [...failures].filter(([, failure]) => failure.kind === "notFound").map(([id]) => id);
    if (notFound.length === 0) return;
    setGone((current) => {
      if (notFound.every((id) => current.has(id))) return current;
      const next = new Set(current);
      for (const id of notFound) next.add(id);
      return next;
    });
  }, [failures]);

  /** 위아래 글쇠: 거르기 칸 → 줄의 단추들 사이. Enter 는 단추가 스스로 받는다(참여 / 열기). */
  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (event.nativeEvent.isComposing) return;
    const actions = Array.from(
      listRef.current?.querySelectorAll<HTMLElement>("[data-browse-action]:not([disabled])") ?? []
    );
    const stops: HTMLElement[] = [...(searchRef.current ? [searchRef.current] : []), ...actions];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    const next = event.key === "ArrowDown" ? Math.min(at + 1, stops.length - 1) : Math.max(at - 1, 0);
    if (next === at) return;
    event.preventDefault();
    stops[next].focus();
  }, []);

  const anyPending = pending.size > 0;
  const typedQuery = typed.trim();

  const group = (label: string, testId: string, members: BrowseChannel[]): ReactNode =>
    members.length === 0 ? null : (
      <section className="flex flex-col" data-testid={testId}>
        <h3 className={GROUP_HEADING_CLASS}>{label}</h3>
        <ul className="flex flex-col">
          {members.map((row) => (
            <BrowseRow
              key={row.id}
              row={row}
              pending={pending.has(row.id)}
              failure={failures.get(row.id)}
              gone={gone.has(row.id)}
              offline={offline}
              onJoin={handleJoin}
              onOpen={handleOpen}
            />
          ))}
        </ul>
      </section>
    );

  let body: ReactNode;
  if (query.isPending) {
    body = <Skeleton ready={false} rows={5} className="p-4" />;
  } else if (query.isError && rows.length === 0) {
    const failure = channelBrowseLoadFailure(query.error);
    body = (
      <InlineBanner
        message={formatMessage(failure.key, failure.values as never)}
        actionLabel={formatMessage("channels.browse.retry")}
        onAction={() => void query.refetch()}
        actionBusy={query.isFetching}
        separator={false}
        testId="channel-browse-error"
      />
    );
  } else if (rows.length === 0 && typedQuery !== "") {
    body = (
      <EmptyInvite
        headline={formatMessage("channels.browse.noMatch", { query: typedQuery })}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setTyped("");
              setCommitted("");
              searchRef.current?.focus();
            }}
            data-testid="channel-browse-clear"
          >
            {formatMessage("channels.browse.clearSearch")}
          </Button>
        }
        testId="channel-browse-no-match"
      />
    );
  } else {
    body = (
      <>
        {/* 참여하지 않은 공개 채널이 없다는 것이 이 창의 빈 상태다(출시 직후 흔하다, ADR-0224 D10). 이미 든 채널은 아래에
            그대로 남는다. 소유자 · 관리자에게는 이미 있는 채널을 여는 길을 한 줄 더 말한다. */}
        {notJoined.length === 0 && typedQuery === "" && (
          <EmptyInvite
            headline={formatMessage("channels.browse.emptyHeadline")}
            detail={isAdmin ? formatMessage("channels.browse.emptyAdminDetail") : undefined}
            testId="channel-browse-empty"
            dataAttrs={{ "data-admin": isAdmin ? "true" : "false" }}
          />
        )}
        {group(formatMessage("channels.browse.groupNotJoined"), "channel-browse-not-joined", notJoined)}
        {group(formatMessage("channels.browse.groupJoined"), "channel-browse-joined-group", joined)}
        {hidden.length > 0 && (
          <section className="flex flex-col" data-testid="channel-browse-hidden-group">
            <h3 className={GROUP_HEADING_CLASS}>{formatMessage("channels.browse.hiddenGroup")}</h3>
            <ul className="flex flex-col">
              {hidden.map((channel) => (
                <HiddenRow
                  key={channel.id}
                  channel={channel}
                  pending={browseSwitch.pending.has(channel.id)}
                  failure={switchFailures.get(channel.id)}
                  offline={offline}
                  onShow={showInBrowse}
                />
              ))}
            </ul>
          </section>
        )}
        {query.hasNextPage && (
          <div className="flex flex-col items-start gap-2 px-4 py-3">
            {query.isFetchNextPageError && (
              <p className="text-meta text-danger" role="alert" data-testid="channel-browse-more-error">
                {(() => {
                  const failure = channelBrowseLoadFailure(query.error);
                  return formatMessage(failure.key, failure.values as never);
                })()}
              </p>
            )}
            <Button
              variant="outline"
              size="sm"
              aria-busy={query.isFetchingNextPage || undefined}
              onClick={() => {
                if (!query.isFetchingNextPage) void query.fetchNextPage();
              }}
              data-browse-action=""
              data-testid="channel-browse-more"
            >
              {query.isFetchingNextPage && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {formatMessage(query.isFetchNextPageError ? "channels.browse.retry" : "channels.browse.loadMore")}
            </Button>
          </div>
        )}
      </>
    );
  }

  return (
    <DialogContent
      data-testid="channel-browse-dialog"
      opener={target.opener}
      onOpenAutoFocus={(event) => {
        // 창이 열리면 거르기 칸에 캐럿이 선다.
        event.preventDefault();
        searchRef.current?.focus();
      }}
      // 참여가 나가 있는 동안은 닫지 않는다(멤버 추가 창과 같은 규칙): 실패는 그 줄이 말해야 하고, 성공은 그 채널로 데려간다.
      onEscapeKeyDown={(event) => {
        if (anyPending) event.preventDefault();
      }}
      onInteractOutside={(event) => {
        if (anyPending) event.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      <div className="flex flex-col gap-1 border-b border-line p-4">
        <DialogTitle>{formatMessage("channels.browse.title")}</DialogTitle>
        <DialogDescription>{formatMessage("channels.browse.description")}</DialogDescription>
      </div>

      {offline && (
        <InlineBanner tone="neutral" message={formatMessage("channels.browse.offline")} testId="channel-browse-offline" />
      )}

      <div className="border-b border-line p-4">
        <Input
          ref={searchRef}
          type="search"
          value={typed}
          maxLength={CHANNEL_BROWSE_QUERY_MAX}
          onChange={(event) => {
            const value = event.target.value;
            setTyped(value);
            if (!composing.current && !(event.nativeEvent as InputEvent).isComposing) setCommitted(value);
          }}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={(event) => {
            composing.current = false;
            setCommitted(event.currentTarget.value);
          }}
          aria-label={formatMessage("channels.browse.searchLabel")}
          placeholder={formatMessage("channels.browse.searchPlaceholder")}
          autoComplete="off"
          spellCheck={false}
          data-testid="channel-browse-search"
        />
      </div>

      {/* 높이가 정해진 목록 자리(`h-pane`): 네 상태가 같은 칸을 쓴다. */}
      <div
        ref={listRef}
        className="h-pane overflow-y-auto"
        aria-busy={query.isFetching || undefined}
        data-testid="channel-browse-list"
      >
        {body}
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-line p-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={anyPending}
          onClick={onClose}
          data-testid="channel-browse-close"
        >
          {formatMessage("channels.browse.close")}
        </Button>
      </div>
    </DialogContent>
  );
}

/**
 * 셸에 한 벌만 있는 둘러보기 창. 문(사이드바 +, ⌘K)은 여는 동사만 받는다. 열려 있는 동안에만 패널을 마운트한다 — 이전에
 * 친 거르기 말과 실패가 다음 열기로 따라오지 않고, 목록은 열 때마다 새로 읽는다.
 */
export function ChannelBrowseProvider({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<ChannelBrowseTarget | null>(null);
  const open = target !== null;
  const openBrowse = useCallback((next?: ChannelBrowseTarget) => setTarget(next ?? {}), []);
  const close = useCallback(() => setTarget(null), []);

  return (
    <ChannelBrowseOpenContext.Provider value={openBrowse}>
      <ChannelBrowseOpenStateContext.Provider value={open}>{children}</ChannelBrowseOpenStateContext.Provider>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
      >
        {target !== null && <ChannelBrowsePanel target={target} onClose={close} />}
      </Dialog>
    </ChannelBrowseOpenContext.Provider>
  );
}
