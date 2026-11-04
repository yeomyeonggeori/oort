import { actorToken } from "@momo/core/features/inbox/model";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check } from "lucide-react";
import {
  fetchMessages,
  fetchThreadReplies,
  sendMessage,
  type Message,
} from "@momo/core/lib/api";
import {
  contextWindow,
  type MailboxEntry,
} from "@momo/core/features/inbox/mailbox";
import { attachmentPreviewLine } from "@momo/core/features/attachments/model";
import { isComposingEvent } from "@momo/core/features/chat/composerKeys";
import { hasRenderableBody } from "@momo/core/features/timeline/bodySlot";
import { replyFailureMessage } from "@momo/core/features/timeline/actionCopy";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { useApprovalBlockedLine } from "@/features/common/blockedLines";
import { InlineBanner, Skeleton } from "@/features/common/States";
import { Avatar } from "@/features/timeline/MessageRow";
import { MessageBody } from "@/features/timeline/MessageBody";
import { SystemLine } from "@/features/timeline/SystemLine";
import { isSystemLineMessage } from "@/features/timeline/systemLineRows";
import { ThreadComposer } from "@/features/timeline/ThreadComposer";
import {
  memberFor,
  useChannels,
  type Directory,
} from "@/features/workspace/useWorkspace";
import { actorNamesIn } from "./actorNames";
import { inboxTargetPath, watchForMessage } from "./anchor";
import { useSettledApproval } from "@/features/timeline/settledApprovals";
import { InboxApprovalActions } from "./InboxApprovalActions";
import { approvalRowControl, settledStatusLine } from "./approvalsPanel";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import { BlockedReason } from "@/features/common/BlockedReason";

// =============================================================================
// 인박스 오른쪽 패널 (#3663): 목록에서 고른 항목의 **맥락**.
//
//   DM       그 대화의 최근 메시지 + 답장 입력
//   멘션     나를 부른 메시지와 그 앞뒤 + 답장 입력(그 메시지를 인용 답장)
//   답글     내 글에 답·인용한 메시지와 그 앞뒤, 인용된 내 글 + 답장 입력
//   스레드   내 글과 그 스레드의 답글 + 스레드 답장(`ThreadComposer`)
//   처리할 일 무엇을 허락해 달라는지 + 결정 버튼(타임라인 카드와 같은 컨트롤)
//
// 채널 전체(`ChatShell`)를 끼우지 않는다. 그 셸은 라우트·읽음 동결·가상 스크롤을
// 쥐고 있어서 패널 안에서는 두 번째 셸이 된다. 여기는 맥락을 읽고 바로 답하는 데
// 필요한 만큼만이고, 더 보려면 「대화에서 보기」로 같은 메시지에 착지한다.
// =============================================================================

const CONTEXT_PAGE = 20;

/** 착지한 줄이 물드는 시간. 머무는 표식이 아니라 「여기예요」 한 번의 신호다. */
const FLASH_MS = 1_600;

/** 멘션·답글은 그 메시지를 인용해 답한다(ADR-0148): 어느 말에 대한 답인지 남는다. */
function quotesTarget(entry: MailboxEntry): boolean {
  return entry.kind === "mention" || entry.kind === "reply";
}

function timeText(ms: number): string {
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(ms);
}

function ContextRow({
  message,
  directory,
  selfMemberId,
  highlighted,
  isTarget,
  targetRef,
}: {
  message: Message;
  directory: Directory;
  selfMemberId: string;
  highlighted: boolean;
  /** 이 항목이 가리키는 메시지. 패널이 열릴 때 여기로 스크롤한다. */
  isTarget: boolean;
  targetRef: React.MutableRefObject<HTMLLIElement | null>;
}) {
  // 목록 줄과 같은 해석(`actorNamesIn`): 에이전트는 타임라인처럼 `@핸들`이다.
  const actor = actorNamesIn(directory, message.authorMemberId);
  const member = memberFor(directory, message.authorMemberId);
  const name = actorToken(actor);
  const isAgent = actor.isAgent;
  const body =
    message.state === "deleted" ? "삭제된 메시지예요." : (message.body ?? "");
  // 글 없이 사진·파일만 보낸 메시지(#4294)는 이 줄이 빈 칸이 아니라 개수로 말한다. 본문이 있으면
  // 본문이 이기고, 지워진 줄은 첨부가 남아 있어도 위의 삭제 문장이 이긴다.
  const attachmentLine =
    message.state === "deleted" || hasRenderableBody(message.body)
      ? null
      : attachmentPreviewLine(message.attachments);
  return (
    <li
      ref={isTarget ? targetRef : undefined}
      data-testid="inbox-context-row"
      data-target={isTarget ? "true" : undefined}
      aria-current={isTarget ? "true" : undefined}
      data-highlighted={highlighted ? "true" : undefined}
      className={cn(
        "flex gap-3 rounded-md px-3 py-2",
        highlighted && "landed-surface"
      )}
    >
      <span className="shrink-0 pt-0.5">
        <Avatar member={member} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-baseline gap-2">
          <span
            className={cn(
              "text-body font-semibold",
              isAgent ? "text-agent" : "text-ink"
            )}
          >
            {name}
          </span>
          <span className="text-timestamp text-ink-muted" data-numeric>
            {timeText(message.createdAtMs)}
          </span>
        </span>
        <span
          className={cn(
            "text-body",
            message.state === "deleted" || attachmentLine !== null
              ? "text-ink-muted"
              : "text-ink"
          )}
        >
          {attachmentLine !== null ? (
            <span data-testid="inbox-context-attachments">{attachmentLine}</span>
          ) : (
            <MessageBody
              body={body}
              directory={directory}
              selfMemberId={selfMemberId}
              foldKey={message.id}
            />
          )}
        </span>
      </span>
    </li>
  );
}

// 방에 알리는 실행 중단 줄(#5128, 타임라인 #5079의 짝)은 누가 한 말이 아니다. 줄의 작성자는 멈춘 사람이라 행(아바타·이름·시각·본문)으로
// 그리면 그 사람이 쓴 글처럼 붙는다. 그래서 이 창에서도 타임라인과 같은 `SystemLine` 으로 가운데의 조용한 줄이 된다. 판정은 코어
// `isRunCancelledNotice` 하나(`isSystemLineMessage`: 줄로 그릴 본문이 없으면 일반 행으로 남는다).
//
// 항목 메시지의 신원(스크롤 기준 `targetRef`·`aria-current`·착지 면)은 `ContextRow` 만 든다. 줄은 그 신원을 달지 않는다.
//   - 줄은 항목이 될 길이 없다. 서버 투영은 `text`·`artifact` 만 항목으로 삼고(migration 126), `dmEntry` 는 대화형(`text`) 메시지만
//     대표로 고르고, 줄은 `root_id` 없이 쓰여 스레드 답글 목록에도 들지 않는다. 줄은 항목 행 옆에 설 뿐이다.
//   - 그래도 항목이 줄을 가리키면(투영이 바뀐 미래) 줄은 눌리거나 답할 곳이 없는 글줄이라 「현재」 표식·착지 면을 얹지 않는다. 패널은
//     대상을 못 찾은 때와 같은 길로 대화 끝으로 간다. 시험이 이 선택을 못 박는다.
// 초점 정거장도 아니다: 칸 안에 단추·링크·`tabindex` 가 없다. `data-testid` 도 글쓴이가 있는 행(`inbox-context-row`)과 달라서, 행을 세는
// 쪽(시험·캡처)이 줄을 행으로 세지 않는다. 이 창은 행을 이어 붙이지 않아(모든 행이 이름 머리를 든다) 타임라인의 묶음 규칙
// (`startGroupAfterSystemLine`)은 필요 없다.
function ContextSystemLine({ message }: { message: Message }) {
  return (
    <li data-testid="inbox-context-system-line">
      <SystemLine message={message} />
    </li>
  );
}

function useContextMessages(entry: MailboxEntry) {
  const { workspaceId } = useSession();
  return useQuery({
    queryKey: ["inbox-context", workspaceId, entry.key, entry.seq ?? 0],
    enabled: entry.kind !== "task",
    queryFn: async (): Promise<Message[]> => {
      if (entry.kind === "thread" && entry.rootId !== undefined) {
        const page = await fetchThreadReplies(
          workspaceId,
          entry.channelId,
          entry.rootId,
          undefined,
          CONTEXT_PAGE
        );
        return page.messages;
      }
      // 멘션은 그 메시지가 목록에 들어오도록 `before`를 seq 뒤로 조금 민다.
      const page = await fetchMessages(workspaceId, entry.channelId, {
        limit: CONTEXT_PAGE,
        ...(quotesTarget(entry) && entry.seq !== undefined
          ? { before: entry.seq + 3 }
          : {}),
      });
      return page.messages;
    },
  });
}

function ReplyBox({
  entry,
  onSent,
}: {
  entry: MailboxEntry;
  onSent: () => void;
}) {
  const { workspaceId } = useSession();
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = draft.trim();

  const send = useCallback(async () => {
    if (body.length === 0 || sending) return;
    setSending(true);
    setError(null);
    try {
      await sendMessage(
        workspaceId,
        entry.channelId,
        crypto.randomUUID(),
        body,
        // 멘션은 그 메시지를 인용해 답한다(ADR-0148): 어느 말에 대한 답인지 남는다.
        quotesTarget(entry) && entry.messageId !== undefined
          ? { replyToId: entry.messageId }
          : undefined
      );
      setDraft("");
      onSent();
    } catch (err) {
      setError(replyFailureMessage(err));
    } finally {
      setSending(false);
    }
  }, [body, sending, workspaceId, entry, onSent]);

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-3">
      {error && (
        <InlineBanner message={error} tone="error" testId="inbox-reply-error" />
      )}
      <div className="flex items-end gap-2">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            if (isComposingEvent(event.nativeEvent)) return;
            event.preventDefault();
            void send();
          }}
          rows={2}
          aria-label={quotesTarget(entry) ? "이 메시지에 답장" : "메시지 입력"}
          placeholder={
            quotesTarget(entry)
              ? "이 메시지에 답장해요"
              : `${entry.channelLabel}에게 메시지 보내기`
          }
          data-testid="inbox-reply-input"
          className="min-h-control max-h-40 flex-1 resize-none rounded-lg border border-line bg-surface px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring"
        />
        <Button
          size="sm"
          onClick={() => void send()}
          disabled={body.length === 0 || sending}
          data-testid="inbox-reply-send"
        >
          보내기
        </Button>
      </div>
    </div>
  );
}

export function InboxDetail({
  entry,
  directory,
  offline,
  onBack,
  onToggleRead,
  onDecided,
  readBusy,
}: {
  entry: MailboxEntry;
  directory: Directory;
  offline: boolean;
  /** 좁은 화면에서 목록으로 돌아간다. 넓은 화면에서는 주지 않는다. */
  onBack?: () => void;
  onToggleRead: (entry: MailboxEntry) => void;
  /** 결정 응답이 닿았다. `approvalId`는 이 패널이 결정한 승인이다(라우트의 안내가 어느 승인의 것인지 안다, #5174 L5). */
  onDecided: (outcome: DecisionOutcome, approvalId: string) => void;
  readBusy: boolean;
}) {
  const { session, workspaceId } = useSession();
  const client = useQueryClient();
  const channelsQuery = useChannels(workspaceId);
  const context = useContextMessages(entry);
  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );

  // 패널은 항목 메시지를 중심으로 연다(#3694): 멘션·답글은 앞 몇 개·뒤 몇 개만,
  // DM·스레드는 받은 대화 전체를 보이되 항목 메시지(없으면 끝)로 스크롤한다.
  const view = useMemo(() => {
    const sorted = (context.data ?? [])
      .filter((m) => m.type === "text" || m.type === "system")
      .sort((a, b) => a.seq - b.seq);
    return contextWindow(
      sorted,
      entry.kind === "thread"
        ? { seq: entry.seq }
        : { messageId: entry.messageId, seq: entry.seq },
      { window: quotesTarget(entry) }
    );
  }, [context.data, entry]);
  const messages = view.rows;
  const targetId =
    view.targetIndex >= 0 ? messages[view.targetIndex]?.id : undefined;

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const targetRef = useRef<HTMLLIElement | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const landedFor = useRef<string | null>(null);

  // 항목이 바뀌면 그 메시지로 스크롤하고 잠깐 물들인다. 같은 항목의 새로고침(답장 뒤
  // 재조회)은 다시 튀지 않는다: 항목 키 + 목표 id가 같으면 한 번만.
  useEffect(() => {
    if (context.isLoading) return;
    const box = scrollRef.current;
    const landing = `${entry.key}|${targetId ?? "end"}`;
    if (!box || landedFor.current === landing) return;
    const row = targetRef.current;
    if (row && targetId !== undefined) {
      box.scrollTop = Math.max(
        0,
        row.offsetTop - (box.clientHeight - row.clientHeight) / 2
      );
      // DM의 마지막 말은 늘 그 자리이므로 물들이지 않는다. 멘션·답글·스레드만.
      if (entry.kind !== "dm") setFlashKey(landing);
    } else {
      box.scrollTop = box.scrollHeight;
    }
    landedFor.current = landing;
  }, [context.isLoading, entry.key, entry.kind, targetId, messages.length]);

  useEffect(() => {
    if (flashKey === null) return;
    const timer = window.setTimeout(() => setFlashKey(null), FLASH_MS);
    return () => window.clearTimeout(timer);
  }, [flashKey]);

  const refresh = useCallback(() => {
    void client.invalidateQueries({
      queryKey: ["inbox-context", workspaceId, entry.key],
    });
  }, [client, workspaceId, entry.key]);

  // 이 클라이언트가 이미 결정한 승인(#5092): 결정이 닿은 뒤 원장이 다시 답하기 전에도(재조회가 오는 동안,
  // 또는 오프라인·실패로 답이 오지 않는 동안) 패널은 고른 줄의 스냅샷으로 같은 `approvalId`를 들고 있다.
  // 영수증이 있으면 컨트롤 대신 결정 결과가 서고, 이미 결정된 건에 두 번째 결정이 나가지 못한다.
  // 원장이 답한 뒤에는 `InboxRoute`가 이 승인을 선택에서 놓아 패널 자체가 닫힌다(#5116).
  const settledReceipt = useSettledApproval(entry.task?.approvalId);
  const settledLine =
    settledReceipt === null ? null : settledStatusLine(settledReceipt.status);
  // 막았을 때 결정 단추 자리의 한 줄: 막은 원인(기기 오프라인 · 서버에 닿지 못함)을 말한다(#5239). 타임라인 카드와 같은 문장이다.
  const blockedLine = useApprovalBlockedLine();
  const control =
    entry.task === undefined
      ? null
      : approvalRowControl(entry.task, {
          offline,
          settled: settledLine !== null,
        });

  // 결정이 닿으면 눌린 컨트롤은 이 렌더에서 결과 줄로 바뀌며 사라진다. 초점이 body로
  // 떨어지지 않게 패널이 받는다(`AgentCard`가 같은 순간에 카드로 받는 것과 같다). 결과는
  // 위의 `inbox-decision-note`(role=status)가 한 번 읽어 주므로 초점은 결과 줄이 아니라
  // 패널 자신에게 놓는다: 같은 문장이 라이브 리전과 초점으로 두 번 들리지 않는다.
  const panelRef = useRef<HTMLElement | null>(null);

  return (
    <section
      ref={panelRef}
      tabIndex={-1}
      aria-label="인박스 맥락"
      data-testid="inbox-detail"
      data-kind={entry.kind}
      className="flex min-h-0 min-w-0 flex-1 flex-col focus-visible:focus-ring"
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-2">
        {onBack && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onBack}
            aria-label="목록으로"
            data-testid="inbox-detail-back"
          >
            <ArrowLeft className="size-4" aria-hidden="true" />
          </Button>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="truncate text-body font-semibold text-ink">
            {entry.typeLabel}
          </h2>
          <p className="truncate text-meta text-ink-muted">{entry.reason}</p>
        </div>
        {/* 서버 투영에는 안 읽음으로 되돌리는 길이 없다(v1): 읽은 항목에는 버튼이 없다. */}
        {entry.kind !== "task" && !(entry.itemId !== undefined && !entry.unread) && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onToggleRead(entry)}
            disabled={readBusy || entry.seq === undefined}
            data-testid="inbox-toggle-read"
          >
            {entry.unread ? "읽음으로 표시" : "안 읽음으로 표시"}
          </Button>
        )}
        <Link
          to={inboxTargetPath(
            // 카드로 직접 가는 것은 처리할 일뿐이다. 멘션·답글의 착지는 seq 그대로다.
            entry.kind === "task"
              ? entry
              : { channelId: entry.channelId, seq: entry.seq }
          )}
          onClick={() => {
            if (entry.seq !== undefined) watchForMessage(entry.seq);
          }}
          data-testid="inbox-open-conversation"
          className="press inline-flex h-control-sm items-center rounded-sm px-3 text-body text-ink hover:bg-surface-hover focus-visible:focus-ring"
        >
          대화에서 보기
        </Link>
      </header>

      <div
        ref={scrollRef}
        data-testid="inbox-detail-scroll"
        className="relative min-h-0 flex-1 overflow-y-auto px-2 py-3"
      >
        {entry.kind === "task" ? (
          <div className="flex flex-col gap-3 px-2" data-testid="inbox-task">
            <p className="text-body text-ink">
              <span
                className={cn(
                  "font-semibold",
                  entry.actorIsAgent ? "text-agent" : "text-ink"
                )}
              >
                {entry.actor}
              </span>{" "}
              {entry.preview}
            </p>
            <p className="text-meta text-ink-muted">
              {entry.channelLabel}
              {entry.timeLabel ? ` · ${entry.timeLabel}` : ""}
            </p>
            {entry.task?.detail && (
              <p className="text-body text-ink-muted">{entry.task.detail}</p>
            )}
            {entry.task?.note && (
              <p className="text-meta text-warn" data-testid="inbox-task-note">
                {entry.task.note}
              </p>
            )}
            {entry.task?.managedBy && (
              <p className="text-meta text-ink-muted">
                {entry.task.managedBy} 님이 관리하는 에이전트예요.
              </p>
            )}
            {control?.kind === "decide" && entry.task && (
              <InboxApprovalActions
                approvalId={control.approvalId}
                onSettled={(outcome) => {
                  panelRef.current?.focus();
                  onDecided(outcome, control.approvalId);
                }}
                execution={entry.task.execution}
              />
            )}
            {settledLine !== null && (
              <p className="text-body text-ink" data-testid="inbox-approval-settled">
                <Check
                  className="mr-2 inline size-4 align-text-bottom"
                  aria-hidden="true"
                />
                {settledLine}
              </p>
            )}
            {control?.kind === "offline" && (
              <p
                className="text-meta text-ink-muted break-keep"
                data-testid="inbox-approval-offline"
              >
                {blockedLine}
              </p>
            )}
          </div>
        ) : (
          <>
            {entry.kind === "reply" && entry.quotedPreview && (
              <div
                className="mx-2 mb-2 rounded-md border border-line px-3 py-2"
                data-testid="inbox-quoted"
              >
                <p className="text-meta text-ink-muted">내가 쓴 글</p>
                <p
                  className={cn(
                    "text-body",
                    entry.quotedDeleted ? "text-ink-muted" : "text-ink"
                  )}
                >
                  {entry.quotedPreview}
                </p>
              </div>
            )}
            {entry.kind === "thread" && entry.rootPreview && (
              <div
                className="mx-2 mb-2 rounded-md border border-line px-3 py-2"
                data-testid="inbox-thread-root"
              >
                <p className="text-meta text-ink-muted">내가 쓴 글</p>
                <p className="text-body text-ink">{entry.rootPreview}</p>
              </div>
            )}
            <Skeleton ready={!context.isLoading} rows={3} className="p-2">
              {context.isError ? (
                <InlineBanner
                  message="대화를 불러오지 못했어요."
                  actionLabel="다시 시도"
                  onAction={() => void context.refetch()}
                  testId="inbox-context-error"
                />
              ) : messages.length === 0 ? (
                <p className="px-3 text-body text-ink-muted">
                  보여 줄 메시지가 없어요.
                </p>
              ) : (
                <ul className="flex flex-col" data-testid="inbox-context">
                  {messages.map((message) =>
                    isSystemLineMessage(message) ? (
                      <ContextSystemLine key={message.id} message={message} />
                    ) : (
                      <ContextRow
                        key={message.id}
                        message={message}
                        directory={directory}
                        selfMemberId={session.member.id}
                        isTarget={message.id === targetId}
                        targetRef={targetRef}
                        highlighted={
                          message.id === targetId &&
                          flashKey === `${entry.key}|${targetId}`
                        }
                      />
                    )
                  )}
                </ul>
              )}
            </Skeleton>
          </>
        )}
      </div>

      {entry.kind === "thread" && entry.rootId !== undefined ? (
        <div className="border-t border-line px-4 py-3">
          <ThreadComposer
            workspaceId={workspaceId}
            channelId={entry.channelId}
            rootId={entry.rootId}
            directory={directory}
            channels={channels}
            onSent={refresh}
          />
        </div>
      ) : entry.kind === "task" ? null : offline ? (
        <p
          className="border-t border-line px-4 py-3 text-meta text-ink-muted"
          data-testid="inbox-reply-offline"
        >
          <BlockedReason frame="inboxReply" />
        </p>
      ) : (
        <ReplyBox entry={entry} onSent={refresh} />
      )}
    </section>
  );
}
