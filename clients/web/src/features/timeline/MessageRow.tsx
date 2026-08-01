import { useMemo, useRef, useState } from "react";
import { threadRollup, type Message, type RosterMember } from "@/lib/api";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { InlineBanner } from "@/features/common/States";
import { AgentCard } from "./AgentCard";
import { ArtifactCard } from "./ArtifactCard";
import { MessageBody } from "./MessageBody";
import { CascadeNotice } from "./CascadeNotice";
import { turnRecordRunId } from "./cascadeModel";
import { rowPresentation } from "./rowModel";
import {
  canDeleteMessage,
  canEditMessage,
  canReactToMessage,
  canReplyToMessage,
  hasAnyAction,
} from "./model";
import {
  DeleteMessageDialog,
  MessageActionColumn,
  MessageActionSheet,
  ReactionPickerDialog,
  type MessageActionCallbacks,
} from "./MessageActions";
import { useRowRovingFocus } from "./rowFocus";
import { MessageEditor } from "./MessageEditor";
import { ReactionChips } from "./ReactionChips";
import type { ReactionChip } from "./reactions";
import {
  deleteFailureMessage,
  editFailureMessage,
  reactionFailureMessage,
} from "./actionCopy";
import { useLongPress } from "./useLongPress";
import { rememberLongPressLearned } from "./LongPressHint";
import { WorkSessionIdleCard } from "@/features/work/WorkSessionIdleCard";
import { workSessionIdleNotice } from "@/features/work/workSessionModel";

// =============================================================================
// One message row (R-1 §3). Humans and agents share the SAME grid and the same
// typography: agent identity is carried only by the --agent token (predawn
// slate-blue) on the avatar and handle, plus the "managed by {owner}"
// attribution. No bubble shape, no row background tint (design-taste-web §9).
//
// --agent is a measured token (MOMO-597): >= 90 degrees of OKLab hue away from
// the human --accent, so the two identities can never converge by a tweak.
// =============================================================================

const AGENT_TEXT = "text-agent";

function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  return `${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function relativeLabel(atMs: number, nowMs: number): string {
  const minutes = Math.max(0, Math.round((nowMs - atMs) / 60_000));
  if (minutes < 1) return "방금";
  if (minutes < 60) return `${minutes}분 전`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}시간 전`;
  return `${Math.round(hours / 24)}일 전`;
}

/** Shared with the pending row so an optimistic echo sits on the same grid. */
export function Avatar({
  member,
  name,
}: {
  member: RosterMember | null;
  name: string;
}) {
  const isAgent = member?.kind === "agent";
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-6 items-center justify-center rounded-sm text-meta font-semibold",
        isAgent ? "bg-agent-soft text-agent" : "bg-surface-hover text-ink"
      )}
    >
      {name.slice(0, 1)}
    </span>
  );
}

/**
 * Everything the row needs to act on its message (B11). Optional as a whole:
 * the work-session panel reuses `MessageRow` to render an event log, and an
 * event card is not something anyone reacts to or edits.
 */
export interface MessageRowActions {
  /** Whose "mine" this is — drives both the chips and the author-only actions. */
  myMemberId: string;
  /** Chips for THIS message, already derived (see `chipsFor`). */
  chips: ReactionChip[];
  /** Toggle one emoji. Optimistic upstream; a failure is reported back here. */
  onToggleReaction: (message: Message, emoji: string) => Promise<void> | void;
  onEditMessage: (message: Message, body: string) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
}

export function MessageRow({
  message,
  startsGroup,
  directory,
  actions,
  onOpenThread,
  onOpenWorkSession,
  onResend,
}: {
  message: Message;
  startsGroup: boolean;
  directory: Directory;
  actions?: MessageRowActions;
  onOpenThread?: (message: Message) => void;
  onOpenWorkSession?: (sessionId: string) => void;
  /** Re-send a row the server marked `failed` (the composer's send path). */
  onResend?: (message: Message) => Promise<void> | void;
}) {
  const [resending, setResending] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editPending, setEditPending] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [deletePending, setDeletePending] = useState(false);
  // One slot for the failures that have nowhere else to sit (a reaction, a
  // delete). B8: a Korean sentence, never the wire string, and never a toast —
  // the message lives where the problem is.
  const [rowError, setRowError] = useState<string | null>(null);
  // The three overlays a row can raise. Local because they are per-row and
  // transient: hoisting them would make the timeline re-render every message
  // when one of them opens a sheet.
  const [sheetOpen, setSheetOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const author = memberFor(directory, message.authorMemberId);
  const isAgent = author?.kind === "agent";
  const name = author?.displayName ?? message.authorMemberId.slice(0, 8);
  const owner = isAgent ? memberFor(directory, author?.ownerHumanId) : null;
  const deleted = message.state === "deleted";
  const failed = message.state === "failed";
  const rollup = threadRollup(message);
  const showsEditedMark = message.state === "edited" && !editing;
  // Agent events render their structured body as a card in the SAME row (R-1
  // §4): tool runs, approvals, settled turn cost, and the ADR-0126 D2 code
  // artifacts. Which of those takes the slot, and what the winner has to carry
  // over from the loser, is decided by `rowPresentation` — a pure function with
  // its own tests, because this row got that precedence wrong once and turned
  // failing turns into clean diffs (rowModel.ts).
  //
  // Memoised because it is the one derivation in this row that is not O(1):
  // parsing a 700 line patch on every scroll-driven re-render is work the
  // virtualiser would pay for over and over. The message object is replaced
  // only when the server row changes, so it is the right key.
  const { card, artifact, artifactState, keepsBody } = useMemo(
    () => rowPresentation(message),
    [message]
  );
  const idleNotice = useMemo(() => workSessionIdleNotice(message), [message]);

  // What this row is allowed to offer. The server decides for real (403/400);
  // these only decide what to draw, and `onOpenThread` gates 답글 because a
  // reply with nowhere to open is a dead end.
  const available = {
    reply: Boolean(actions && onOpenThread) && canReplyToMessage(message),
    react: Boolean(actions) && canReactToMessage(message),
    edit: Boolean(actions) && canEditMessage(message, actions?.myMemberId),
    delete: Boolean(actions) && canDeleteMessage(message, actions?.myMemberId),
  };
  const actionable = Boolean(actions) && hasAnyAction(available);

  const callbacks: MessageActionCallbacks = {
    onReply: () => onOpenThread?.(message),
    onReact: (emoji) => {
      if (!actions) return;
      setRowError(null);
      void Promise.resolve(actions.onToggleReaction(message, emoji)).catch(
        (error: unknown) => setRowError(reactionFailureMessage(error))
      );
    },
    onEdit: () => {
      setEditError(null);
      setEditing(true);
    },
    onDelete: () => setConfirmOpen(true),
  };

  // The phone's summons. Armed only when there is something to summon, so a
  // long press on a tombstone does nothing rather than opening an empty sheet.
  const longPress = useLongPress(
    () => {
      // 이 기기는 제스처를 배웠다. 컴포저 위의 안내 한 줄은 스스로 사라진다.
      rememberLongPressLearned();
      setSheetOpen(true);
    },
    { enabled: actionable && !editing }
  );

  // Every control this row owns is one roving group, so the whole row costs the
  // keyboard a single tab stop no matter how many reactions it carries
  // (rowFocus.ts). The editor is deliberately outside the group: its textarea
  // and its 저장/취소 belong to a focused editing context and are reached by Tab
  // like any form.
  const rowRef = useRef<HTMLElement | null>(null);
  const onRowKeyDown = useRowRovingFocus(rowRef);

  return (
    // `data-message-id` is the row's second published identity (MOMO-677).
    // `seq` orders the channel and is what the inbox jumps by; a projection
    // that knows a message only by id (the workstream anchor thread) has no
    // seq to derive, so it addresses the row the way it actually knows it.
    // Lower-cased at the source: Swift sends UUIDs upper-cased and a CSS
    // attribute selector does not fold case.
    <article
      ref={rowRef}
      data-testid="timeline-message"
      data-seq={message.seq}
      data-message-id={message.id.toLowerCase()}
      data-author-kind={author?.kind ?? "unknown"}
      data-actionable={actionable ? "true" : undefined}
      onKeyDown={onRowKeyDown}
      {...(actionable ? longPress : {})}
      className={cn(
        // `group` lets the action trigger react to a hover anywhere on the row
        // rather than only on itself, which would be an affordance you can only
        // find by already being on it. `no-touch-callout` stops iOS raising its
        // own selection menu on top of the long-press sheet.
        "group flex gap-2 px-4 hover:bg-surface-hover",
        actionable && "no-touch-callout",
        startsGroup ? "pt-3 pb-1" : "py-1"
      )}
    >
      <div className="w-6 shrink-0">
        {startsGroup && <Avatar member={author} name={name} />}
      </div>
      {/* `data-row-body` is the box the capture gate measures the action gutter
          against: everything the author wrote lives inside it, so "the trigger
          starts where the body ends" is checkable rather than eyeballed. */}
      <div data-row-body className="min-w-0 flex-1">
        {startsGroup && (
          <div className="flex flex-wrap items-baseline gap-2">
            {/* 이름은 이름이다 (R1 M8). MOMO-626 1차에서 에이전트 이름을 라우팅
                다이얼로그를 여는 버튼으로 바꿨는데, 정지 상태에서는 텍스트와
                구분되지 않으면서 한 번의 클릭으로 설정을 열었고, 가상 리스트에서
                에이전트 그룹마다 탭 스톱이 하나씩 늘어 컴포저까지 가는 키보드
                경로가 길어졌다. SKILL §6은 행 레벨 액션을 ContextMenu에 두라고
                하는데 이 클라이언트에는 그 프리미티브가 없다(의존성에
                @radix-ui/react-context-menu 없음). 없는 것을 여기서 손으로 만드는
                대신 진입점을 제대로 생긴 세 곳에 둔다: 디렉터리 행의 [라우팅]
                버튼, 컴포저 멘션 줄의 "기본값 편집", 그리고 ⌘K 팔레트. */}
            <span
              className={cn(
                "text-body font-semibold",
                isAgent ? AGENT_TEXT : "text-ink"
              )}
            >
              {isAgent ? `@${author?.handle ?? name}` : name}
            </span>
            {owner && (
              <span className="text-meta text-ink-muted">
                managed by {owner.displayName}
              </span>
            )}
            <time
              dateTime={new Date(message.createdAtMs).toISOString()}
              data-numeric
              className="text-timestamp text-ink-muted"
            >
              {timeLabel(message.createdAtMs)}
            </time>
          </div>
        )}
        {keepsBody &&
          idleNotice === null &&
          // A tombstone is our sentence, not the author's, so it never goes
          // through the markdown path: "**삭제된 메시지**" is not a thing a
          // deleted row can say.
          (deleted ? (
            // Keeping the row is right: a hole in `seq` is indistinguishable
            // from one the client failed to receive. But R1 set this sentence in
            // body size and body leading, so the only thing separating "삭제된
            // 메시지" from a message someone actually wrote was its colour, and
            // at a glance the tombstone read as content (R2 M5). It keeps its
            // place and gives up its weight.
            <p className="break-words text-meta text-ink-muted">삭제된 메시지</p>
          ) : editing && actions ? (
            <MessageEditor
              initialBody={message.body ?? ""}
              pending={editPending}
              error={editError}
              onCancel={() => {
                setEditing(false);
                setEditError(null);
              }}
              onSave={(body) => {
                setEditPending(true);
                setEditError(null);
                void actions
                  .onEditMessage(message, body)
                  .then(() => setEditing(false))
                  .catch((error: unknown) =>
                    setEditError(editFailureMessage(error))
                  )
                  .finally(() => setEditPending(false));
              }}
            />
          ) : (
            <MessageBody body={message.body ?? ""} />
          ))}
        {idleNotice && (
          <WorkSessionIdleCard
            notice={idleNotice}
            onOpen={onOpenWorkSession}
          />
        )}
        {artifact ? (
          <ArtifactCard
            artifact={artifact}
            state={artifactState}
            storageKey={message.id}
          />
        ) : (
          card && <AgentCard card={card} directory={directory} />
        )}
        {/* Provider cascade (ADR-0135 D1). Outside the card/artifact branch on
            purpose: whichever of the two took the slot, a turn served by the
            second provider says so. Renders nothing for every other row. */}
        <CascadeNotice runId={turnRecordRunId(message)} />
        {actions && (
          <ReactionChips
            chips={actions.chips}
            disabled={deleted}
            onToggle={(emoji) => callbacks.onReact(emoji)}
            onOpenPicker={
              available.react ? () => setPickerOpen(true) : undefined
            }
          />
        )}
        {rowError && (
          <InlineBanner
            message={rowError}
            separator={false}
            actionLabel="닫기"
            onAction={() => setRowError(null)}
            testId="message-action-error"
          />
        )}
        {failed && (
          // The retry lives on the row, not in a banner far from it (R-1 §3
          // "전송 실패 [재시도]"). It runs the composer's send path, so a
          // resend is a new send with a fresh idempotency key, not a replay.
          <span
            className="flex flex-wrap items-center gap-2 text-meta text-danger"
            data-testid="message-failed"
          >
            전송 실패
            {message.body && onResend && (
              <button
                type="button"
                disabled={resending}
                data-testid="message-resend"
                data-row-action=""
                onClick={() => {
                  setResending(true);
                  void Promise.resolve(onResend(message)).finally(() =>
                    setResending(false)
                  );
                }}
                className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-50"
              >
                {resending ? "보내는 중…" : "다시 보내기"}
              </button>
            )}
          </span>
        )}
        {/* 꼬리는 한 줄이다 (R2 M6). R1은 「수정됨」과 「답글 N개」와 칩을 각각
            자기 띠에 올려서, 한 줄짜리 메시지 아래에 그 메시지보다 높은 세 겹의
            꼬리가 쌓였다 — 본문이 자기 부속물에 지는 그림이다. 칩은 누르는
            것이라 자기 줄을 갖고, 읽기만 하는 두 조각은 한 줄에 함께 앉는다. */}
        {(showsEditedMark || rollup) && (
          <div
            className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-muted"
            data-testid="message-meta"
          >
            {showsEditedMark && <span>수정됨</span>}
            {rollup && (
              <button
                type="button"
                onClick={() => onOpenThread?.(message)}
                data-testid="thread-anchor"
                data-row-action=""
                className="rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                답글 {rollup.replyCount}개 · 마지막{" "}
                {relativeLabel(rollup.lastReplyAtMs, Date.now())}
              </button>
            )}
          </div>
        )}
      </div>
      {actions && (
        <MessageActionColumn
          available={available}
          callbacks={callbacks}
          onOpenPicker={() => setPickerOpen(true)}
          hidden={editing}
        />
      )}
      {actions && actionable && (
        <>
          <MessageActionSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            preview={message.body?.trim() || "내용 없는 메시지"}
            available={available}
            callbacks={callbacks}
            onOpenPicker={() => setPickerOpen(true)}
          />
          <ReactionPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={(emoji) => callbacks.onReact(emoji)}
          />
          <DeleteMessageDialog
            open={confirmOpen}
            onOpenChange={setConfirmOpen}
            pending={deletePending}
            onConfirm={() => {
              if (!actions) return;
              setDeletePending(true);
              setRowError(null);
              void actions
                .onDeleteMessage(message)
                .then(() => setConfirmOpen(false))
                .catch((error: unknown) => {
                  setRowError(deleteFailureMessage(error));
                  setConfirmOpen(false);
                })
                .finally(() => setDeletePending(false));
            }}
          />
        </>
      )}
    </article>
  );
}

/** Day separator. A rule with the date inline, not a centered pill. */
export function DayDivider({ atMs }: { atMs: number }) {
  const d = new Date(atMs);
  return (
    <div className="flex items-center gap-3 px-4 py-3" data-testid="day-divider">
      <span className="text-meta text-ink-muted" data-numeric>
        {d.getFullYear()}년 {d.getMonth() + 1}월 {d.getDate()}일
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}

/** Unread boundary. Count is server truth (P7), never a local tally. */
export function UnreadDivider({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2" data-testid="unread-divider">
      <span className="text-meta font-medium text-accent" data-numeric>
        새 메시지 {count}개, 여기까지 읽음
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-accent" />
    </div>
  );
}

/**
 * Reconnect marker. `seq` is exact because the server issues it, so the user is
 * told precisely how far the timeline was restored instead of being left to
 * wonder what a clock-skewed "since 5s ago" window missed (R-1 §3).
 */
export function RecoveryDivider({
  seq,
  source,
}: {
  seq: number;
  source: "replay" | "backfill";
}) {
  return (
    <div
      className="flex items-center gap-3 px-4 py-2"
      data-testid="recovery-divider"
      data-seq={seq}
      data-source={source}
    >
      <span className="text-meta text-ink-muted" data-numeric>
        재연결됨, seq {seq}까지 복구
      </span>
      <span aria-hidden="true" className="h-px flex-1 bg-line" />
    </div>
  );
}
