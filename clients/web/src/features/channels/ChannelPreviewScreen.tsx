import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Hash, Loader2, Paperclip } from "lucide-react";
import type { Channel } from "@momo/core/lib/api";
import {
  channelPreviewFailure,
  previewChannel,
  previewInReadingOrder,
  type ChannelPreviewFailure,
  type PreviewMessage,
} from "@momo/core/features/channels/browse";
import { deletedFoldLabel } from "@momo/core/features/timeline/deletedFold";
import { GONE_MEMBER_LABEL } from "@momo/core/features/workspace/directory";
import { SidebarDrawerToggle } from "@/app/SidebarDrawerToggle";
import { useSession } from "@/app/session";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { useLocaleService } from "@/i18n/useLocaleService";
import { useJoinBrowsedChannel } from "./useChannelBrowse";

// =============================================================================
// 공개 채널 미리 보기 (ADR-0224 D5 · 화면 웹 줄 ③, #5844). 참여하지 않은 켜진 공개 채널의 최근 글을 **읽기만** 하게 보여 주고,
// 아래 띠의 「참여」 하나로 들어간다. `/c/{id}` 자리에 서는 화면이다(`ChannelRoute` 가 고른다) — 둘러보기 창 · ⌘K · 링크 세 문이 모두
// 같은 주소로 와서 이 화면 하나를 지난다.
//
// ## 누를 수 있는 것은 둘뿐이다: 「참여」 · 「다시 시도」
// 입력창 · 반응 · 호버 동작 · 스레드 열기 · 첨부 열기 · 링크 카드 · 멘션 · 링크가 없다. 그래서 대화의 글 그리기 부품(`MessageRow`,
// 행동 · 인용 · 카드 · 반응을 한 몸에 지닌 1600줄)을 다시 쓰지 **못했다** — 폰 #5847 과 같은 결정이다. 같은 간격 · 글자 토큰, 같은
// 코어 문장(묘비 · 수정됨 · 답글 수)으로 읽기 전용 한 줄만 새로 그린다. 글은 평문 그대로다.
//
// ## 읽기만 한다
// 이 화면은 실시간 구독 · 읽음 위치 · 보고 있음 신호를 부르지 않는다(`ChatShell` 이 이 자리에 서지 않으므로 그 훅들이 돌지 않는다).
// 읽는 것은 미리 보기 한 번(`GET …/preview`)뿐이고, 새 글은 오지 않는다.
//
// ## 움직이지 않는 것
// 머리(`channel-head`)는 대화 화면과 같은 틀이라 이름 · 주제 · 멤버 수가 늦게 와도 높이가 그대로다. 아래 띠는 불러오는 중 · 글 없음 ·
// 실패 · 목록에서 같은 자리를 지키고, 404 에서는 단추만 빠지고 띠의 높이는 그대로다. 참여 실패 문장은 띠 **위** 한 줄이다.
// =============================================================================

type PreviewState = "loading" | "gone" | "error" | "empty" | "list";

function authorLabel(message: PreviewMessage): string {
  return message.author.displayName ?? GONE_MEMBER_LABEL;
}

/** 오늘이면 시각만, 아니면 날짜와 시각 — 폰 미리 보기(`ChannelPreviewScreen` 의 `useStamp`)와 같은 판단, 같은 언어 서비스(#5958). */
function usePreviewStamp(): (ms: number) => string {
  const locale = useLocaleService();
  return useCallback(
    (ms: number) => {
      const time = locale.formatTime(ms);
      return locale.formatDate(ms) === locale.formatDate(Date.now()) ? time : `${locale.formatDate(ms)} ${time}`;
    },
    [locale]
  );
}

/** 글 한 줄(읽기 전용). 낭독은 줄 전체가 한 덩어리 — 글쓴이, 시각, 수정됨, 본문, 첨부 이름, 잠김 문장, 답글 수 차례다. */
export function PreviewRow({ message }: { message: PreviewMessage }) {
  const formatMessage = useFormatMessage();
  const author = authorLabel(message);
  const stamp = usePreviewStamp();
  const time = stamp(message.createdAtMs);
  const edited = message.edited && !message.deleted ? formatMessage("timeline.edited.mark") : undefined;
  const locked = message.attachmentNames.length > 0 ? formatMessage("channels.preview.attachmentLocked") : undefined;
  const replies =
    message.replyCount > 0 ? formatMessage("timeline.thread.replyCount", { count: message.replyCount }) : undefined;
  const text = message.deleted ? deletedFoldLabel(undefined) : (message.body ?? "").trim();
  const spoken = [author, time, edited, text, ...message.attachmentNames, locked, replies].filter(Boolean).join(", ");

  return (
    <li
      className="mx-1 flex flex-col gap-1 rounded-lg px-3 py-2"
      aria-label={spoken}
      data-testid="channel-preview-message"
      data-message-id={message.id}
    >
      <div aria-hidden="true" className="flex min-w-0 items-baseline gap-2">
        <span className={cn("truncate text-body font-semibold", message.author.kind === "agent" ? "text-agent" : "text-ink")}>
          {author}
        </span>
        <time
          dateTime={new Date(message.createdAtMs).toISOString()}
          data-numeric
          className="shrink-0 whitespace-nowrap text-timestamp text-ink-muted"
        >
          {time}
        </time>
      </div>
      {message.deleted ? (
        <p aria-hidden="true" className="break-words text-meta text-ink-muted" data-testid="tombstone">
          {text}
        </p>
      ) : (
        <p aria-hidden="true" className="whitespace-pre-wrap break-words text-body text-ink">
          {text}
        </p>
      )}
      {message.attachmentNames.length > 0 && (
        <ul aria-hidden="true" className="flex min-w-0 flex-col gap-1">
          {message.attachmentNames.map((name, index) => (
            <li key={`${index}-${name}`} className="flex min-w-0 items-center gap-2 text-meta text-ink-muted">
              <Paperclip className="size-4 shrink-0" />
              <span className="truncate">{name}</span>
            </li>
          ))}
          <li className="text-meta text-ink-muted" data-testid="channel-preview-locked">
            {locked}
          </li>
        </ul>
      )}
      {(edited || replies) && (
        <div aria-hidden="true" className="flex flex-wrap items-center gap-2 text-meta text-ink-muted">
          {edited && <span data-testid="channel-preview-edited">{edited}</span>}
          {replies && <span data-testid="channel-preview-replies">{replies}</span>}
        </div>
      )}
    </li>
  );
}

export function ChannelPreviewScreen({ channelId, loadingOnly = false }: { channelId: string; loadingOnly?: boolean }) {
  const { workspaceId } = useSession();
  const formatMessage = useFormatMessage();
  const offline = useOffline();
  const client = useQueryClient();

  // 열 때마다 새로 읽는다(`gcTime: 0`): 이 화면은 실시간이 없어 캐시를 쥐고 있으면 낡은 글을 보인다. 재시도는 꺼 둔다 — 404 · 403 은
  // 다시 해도 같고, 그 밖은 사람이 「다시 시도」로 정한다.
  const query = useQuery({
    queryKey: ["channel-preview", workspaceId, channelId],
    queryFn: () => previewChannel(workspaceId, channelId),
    // 내 채널 목록으로 「정말 내 채널이 아니다」가 가려지기 전에는 읽지 않는다(`ChannelRoute`).
    enabled: !loadingOnly,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnReconnect: false,
  });

  const failure: ChannelPreviewFailure | null = useMemo(
    () => (query.isError ? channelPreviewFailure(query.error) : null),
    [query.isError, query.error]
  );
  const preview = query.data ?? null;
  const messages = useMemo(() => (preview ? previewInReadingOrder(preview.messages) : []), [preview]);
  const state: PreviewState = query.isPending
    ? "loading"
    : failure !== null
      ? failure.kind === "notFound" ? "gone" : "error"
      : messages.length === 0
        ? "empty"
        : "list";

  const onJoined = useCallback((_channel: Channel) => undefined, []);
  const join = useJoinBrowsedChannel(onJoined);
  const pending = join.pending.has(channelId);
  const joinFailure = join.failures.get(channelId);

  // 서버가 「이미 멤버」라고 답하면(내 채널 목록이 낡았던 것이다) 목록을 다시 읽어 대화로 넘어간다.
  useEffect(() => {
    if (preview?.channel.isMember) void client.invalidateQueries({ queryKey: ["channels", workspaceId] });
  }, [preview, client, workspaceId]);

  // 열리면 맨 아래(최신 글). 최대 50개에 쪽 나눔이 없어 한 번이면 정확하다.
  const scrollRef = useRef<HTMLDivElement>(null);
  const scrolledFor = useRef<string | null>(null);
  useLayoutEffect(() => {
    const host = scrollRef.current;
    if (state !== "list" || host === null || scrolledFor.current === channelId) return;
    scrolledFor.current = channelId;
    host.scrollTop = host.scrollHeight;
  }, [state, channelId]);

  const name = preview?.channel.name;
  const topic = preview?.channel.topic;
  const memberCount = preview?.channel.memberCount;
  const joinSentence = joinFailure ? formatMessage(joinFailure.key, joinFailure.values as never) : null;
  const canJoin = state !== "gone" && !(state === "error" && failure?.kind === "forbidden");

  let body;
  if (state === "loading") {
    body = (
      <div role="status" data-testid="channel-preview-loading">
        <span className="sr-only">{formatMessage("channels.preview.loading")}</span>
        <Skeleton ready={false} rows={5} className="px-4 py-3" />
      </div>
    );
  } else if (state === "gone") {
    body = (
      <EmptyInvite
        heading
        headline={formatMessage("channels.preview.notFound")}
        testId="channel-preview-gone"
      />
    );
  } else if (state === "error" && failure !== null) {
    const retryable = failure.kind !== "forbidden";
    body = (
      <InlineBanner
        message={formatMessage(failure.key, failure.values as never)}
        {...(retryable
          ? { actionLabel: formatMessage("channels.browse.retry"), onAction: () => void query.refetch() }
          : {})}
        testId="channel-preview-error"
        className="m-4"
      />
    );
  } else if (state === "empty") {
    body = <EmptyInvite headline={formatMessage("channels.preview.empty")} testId="channel-preview-empty" />;
  } else {
    body = (
      <ol aria-label={formatMessage("channels.preview.listAria", { name: name ?? "" })} data-testid="channel-preview-list" className="py-2">
        {messages.map((message) => (
          <PreviewRow key={message.id} message={message} />
        ))}
      </ol>
    );
  }

  return (
    <div className="relative flex min-w-0 flex-1">
      <div className="chat-region flex flex-1 flex-col" data-testid="channel-preview" data-state={state}>
        <header
          data-testid="channel-header"
          className="channel-head flex min-w-0 flex-wrap items-center gap-y-1 py-1.5"
        >
          <div className="channel-head-main flex items-center gap-2">
            <SidebarDrawerToggle />
            <span aria-hidden="true" className="shrink-0 text-ink" data-head-icon="">
              <Hash className="size-4" />
            </span>
            <div className="channel-head-body flex items-center gap-2">
              <h1
                className="channel-head-title min-w-0 truncate text-ink"
                {...(name === undefined ? { "aria-hidden": true } : {})}
                data-testid="channel-preview-title"
              >
                {name ?? "\u00A0"}
              </h1>
              {topic !== undefined && (
                <div className="channel-head-tail">
                  <span className="channel-head-topic wide-only ms-1 flex-1" title={topic} data-testid="channel-preview-topic">
                    {topic}
                  </span>
                </div>
              )}
            </div>
          </div>
          <div className="channel-head-tools flex items-center justify-end gap-2">
            {memberCount !== undefined && (
              <span className="text-meta text-ink-muted" data-numeric data-testid="channel-preview-members">
                {formatMessage("channels.browse.memberCount", { count: memberCount })}
              </span>
            )}
          </div>
        </header>
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto" data-testid="channel-preview-body">
          {body}
        </div>
        {joinSentence !== null && (
          <p
            role="alert"
            className="shrink-0 break-keep px-4 pb-2 text-meta text-danger"
            data-testid="channel-preview-join-error"
          >
            {joinSentence}
          </p>
        )}
        <div
          className="flex shrink-0 items-center gap-3 border-t border-line px-4 py-3"
          data-testid="channel-preview-band"
        >
          <p className={cn("min-w-0 flex-1 break-keep text-body text-ink-muted", !canJoin && "invisible")}>
            {formatMessage("channels.preview.joinBand")}
          </p>
          <div className="tap-target flex h-pill shrink-0 items-center">
            {canJoin && (
              <Button
                disabled={offline}
                aria-busy={pending || undefined}
                aria-label={name === undefined ? undefined : formatMessage("channels.browse.joinAria", { name })}
                onClick={() => void join.join(channelId)}
                data-testid="channel-preview-join"
              >
                {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
                {formatMessage(joinFailure && joinFailure.kind !== "notFound" ? "channels.browse.retry" : "channels.browse.join")}
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
