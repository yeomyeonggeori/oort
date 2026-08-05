import { useMemo, useRef, useState } from "react";
import {
  threadRollup,
  type Message,
  type RosterMember,
  type ThreadRollup,
} from "@momo/core/lib/api";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { InlineBanner } from "@/features/common/States";
import { AgentCard } from "./AgentCard";
import { ArtifactCard } from "./ArtifactCard";
import { MessageBody } from "./MessageBody";
import { CascadeNotice } from "./CascadeNotice";
import { turnRecordRunId } from "@momo/core/features/timeline/cascadeModel";
import { rowPresentation } from "@momo/core/features/timeline/rowModel";
// 구분선의 판정은 코어가 갖는다 — 폰이 같은 값을 소비한다 (U1 M-2).
import {
  dayDividerLabel,
  dayDividerSegments,
  recoveryDividerSegments,
  unreadDividerSegments,
  DIVIDER_LABEL_SIDE,
  type DividerSegment,
} from "@momo/core/features/timeline/divider";
// 코어의 간격 숫자를 클래스로 옮긴 다리. CSP가 인라인 스타일을 막아서 생긴 두 벌이고,
// 갈라지지 않게 `spacing.test.ts`가 둘을 묶는다.
import {
  DAY_DIVIDER_PAD_CLASS,
  DIVIDER_GAP_CLASS,
  DIVIDER_RULE_CLASS,
  MARKER_DIVIDER_PAD_CLASS,
  ROW_CONTINUATION_PAD_CLASS,
  ROW_GROUP_START_PAD_CLASS,
} from "./spacing";
import {
  canDeleteMessage,
  canEditMessage,
  canReactToMessage,
  canReplyToMessage,
  hasAnyAction,
} from "@momo/core/features/timeline/model";
import {
  canQuoteMessage,
  resolveQuote,
} from "@momo/core/features/timeline/quote";
import { QuoteBlock } from "./QuoteBlock";
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
import type { ReactionChip } from "@momo/core/features/timeline/reactions";
import {
  deleteFailureMessage,
  editFailureMessage,
  reactionFailureMessage,
} from "@momo/core/features/timeline/actionCopy";
import { useLongPress } from "./useLongPress";
import { rememberLongPressLearned } from "./LongPressHint";
import { WorkSessionIdleCard } from "@/features/work/WorkSessionIdleCard";
import { workSessionIdleNotice } from "@momo/core/features/work/workSessionModel";

// =============================================================================
// One message row (R-1 §3). Humans and agents share the SAME grid and the same
// typography: agent identity is carried only by the --agent token (predawn
// slate-blue) on the avatar and handle, plus the "{owner} 님이 관리"
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

/**
 * 「답글 3개 · 마지막 5분 전」. 버튼으로도 글로도 그려지므로 문구는 한 곳에서
 * 나온다 (goal P3 1-1): 스레드를 열 수 있는 자리와 이미 열어 둔 자리가 같은 값을
 * 읽어야 두 표면이 서로 다른 말을 하지 않는다.
 */
function rollupLabel(rollup: ThreadRollup): string {
  return `답글 ${rollup.replyCount}개 · 마지막 ${relativeLabel(
    rollup.lastReplyAtMs,
    Date.now()
  )}`;
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
  pausedRepeat,
  onOpenThread,
  onQuoteMessage,
  onJumpToMessage,
  quoteLookup,
  onOpenWorkSession,
  onResend,
  showRollup = true,
}: {
  message: Message;
  startsGroup: boolean;
  directory: Directory;
  actions?: MessageRowActions;
  /**
   * 이 「일시정지」 알림이 대신하는 알림 수 (goal P3 1-2, model.ts
   * `foldPausedNotices`). 앞선 반복은 그려지지 않고 이 줄 하나만 남으므로, 몇 번이
   * 응답 없이 지나갔는지는 이 줄이 말해야 한다.
   */
  pausedRepeat?: number;
  onOpenThread?: (message: Message) => void;
  /**
   * ADR-0148 - pin this row to the composer as a quote. Absent on surfaces with
   * no composer to pin to (the work-session event log), and the action is then
   * not offered at all rather than offered and dead.
   */
  onQuoteMessage?: (message: Message) => void;
  /**
   * 인용 블록을 눌러 원본으로 점프한다. 채널 표면이 이미 가진 앵커 기계를 그대로
   * 쓴다(`features/inbox/anchor.ts`), 그래서 못 찾았을 때의 문장도 이미 있는
   * 그것이다.
   */
  onJumpToMessage?: (messageId: string, seq: number | null) => void;
  /**
   * 실시간으로 도착한 인용 답글의 원본을 **화면에 이미 있는 행**에서 찾는다.
   *
   * `message.new`에는 원문이 실리지 않는다(ADR-0148 규칙 3: outbox 행에 본문을
   * 실으면 그게 곧 금지된 스냅샷이다). 그래서 라이브 인용은 이 조회로 풀리고,
   * 조회가 없거나 못 찾으면 블록은 「이 화면에 없습니다」라고 말한다 - 어느 경로도
   * 네트워크를 다시 때리지 않는다.
   */
  quoteLookup?: (messageId: string) => Message | undefined;
  onOpenWorkSession?: (sessionId: string) => void;
  /** Re-send a row the server marked `failed` (the composer's send path). */
  onResend?: (message: Message) => Promise<void> | void;
  /**
   * 이 행이 「답글 N개 · 마지막 …」을 그리는가 (goal RN-U2).
   *
   * 채널 타임라인에서는 참이다. 그 줄은 목록을 훑는 사람에게 **"여기 스레드가
   * 있다"** 를 알리는 유일한 장치이고, 없으면 답글이 달렸다는 사실이 목록 어디에도
   * 남지 않는다.
   *
   * 스레드 패널에서는 거짓이다 — 성재(iOS 실기기, 같은 제품 판단이므로 웹도 함께
   * 고친다): "답글에서 개수 업데이트는 굳이 왜 해? 목록에 나오면 몇 개의 reply가
   * 있는지는 자연스러운데, 답글에서 '답글 1개' 이런 식으로 보이는 건 자연스럽지 않은
   * 거 같아." 이미 그 스레드를 열어 둔 사람에게 그 줄이 나르는 정보는 0이다.
   *
   * **`onOpenThread` 와는 다른 축이다.** goal P3 1-1 이 그 핸들러가 없을 때 이 줄을
   * 버튼에서 글로 내린 것은 옳았지만(죽은 컨트롤을 없앴다), 그리는 조건 자체는
   * `rollup` 하나였으므로 글이 되어서도 계속 그려졌다. 문제는 눌리느냐가 아니라
   * **그 줄이 여기서 할 말이 없다**는 것이었고, 여기서 끊는 것이 그 조건이다.
   */
  showRollup?: boolean;
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
  const rollup = showRollup ? threadRollup(message) : null;
  const showsEditedMark = message.state === "edited" && !editing;
  // 하나로 접힌 반복 (goal P3 1-2). 한 번뿐이면 셀 것이 없으므로 아무 말도 하지
  // 않는다 — "1개"는 개수가 아니라 잡음이다.
  const repeatLabel =
    pausedRepeat !== undefined && pausedRepeat > 1
      ? `응답하지 못한 메시지 ${pausedRepeat}개`
      : null;
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
  // ADR-0148. 인용은 **받은 것으로** 그린다: 서버가 페이지에 동봉한 `replyTo`가
  // 있으면 그것, 없으면(라이브 프레임) 이미 로드된 같은 채널의 행. 어느 쪽도
  // 재조회가 아니고, 이 행에 fetch 씨앗이 아예 없다.
  const quote = resolveQuote(message, quoteLookup);

  // What this row is allowed to offer. The server decides for real (403/400);
  // these only decide what to draw, and `onOpenThread` gates 답글 because a
  // reply with nowhere to open is a dead end.
  const available = {
    reply: Boolean(actions && onOpenThread) && canReplyToMessage(message),
    // 답글과 **다른 축**이다: 이미 답글인 행도 인용할 수 있다(규칙 1). 컴포저에
    // 걸 곳이 없는 표면에서는 내놓지 않는다.
    quote: Boolean(actions && onQuoteMessage) && canQuoteMessage(message),
    react: Boolean(actions) && canReactToMessage(message),
    edit: Boolean(actions) && canEditMessage(message, actions?.myMemberId),
    delete: Boolean(actions) && canDeleteMessage(message, actions?.myMemberId),
  };
  const actionable = Boolean(actions) && hasAnyAction(available);

  const callbacks: MessageActionCallbacks = {
    onReply: () => onOpenThread?.(message),
    onQuote: () => onQuoteMessage?.(message),
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
        // 컨트롤이 없는 행은 자기 자신이 탭 정거장이 된다 (rowFocus.ts, 리뷰 W-4).
        // 정거장에는 보이는 링이 있어야 하고, 링은 **안쪽**에 그린다 — 행은
        // 스크롤 컨테이너 안에 있어서 바깥으로 2px 나간 링은 잘린다
        // (ArtifactCard가 diff 본문 안에서 같은 이유로 같은 선택을 한다).
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        actionable && "no-touch-callout",
        // 행 사이 간격은 코어가 정한다 (H-7 · `ROW_SPACE`). 진단이 실측한 값은 연속
        // 행 8px이고, 거기서 한 사람이 연달아 쓴 다섯 발화가 한 문단으로 뭉쳤다.
        // 클래스가 그 숫자와 어긋나면 `spacing.test.ts`가 붉다.
        startsGroup ? ROW_GROUP_START_PAD_CLASS : ROW_CONTINUATION_PAD_CLASS
      )}
    >
      {/* 거터. 그룹 머리 행에는 아바타가, 이어지는 행에는 **시각**이 온다 (H-3).
          `relative`인 이유는 그 시각이 24px 상자보다 넓기 때문이다 — 절대 배치로
          거터 오른끝에 붙이면 남는 글자는 행의 `px-4` 여백 쪽으로 흘러나가고, 그래서
          레이아웃을 한 픽셀도 밀지 않는다(H-2에서 배운 것과 같은 규칙). */}
      <div className="relative w-6 shrink-0">
        {startsGroup ? (
          <Avatar member={author} name={name} />
        ) : (
          <time
            dateTime={new Date(message.createdAtMs).toISOString()}
            data-numeric
            data-testid="row-time"
            // 이 시각이 **거터의 시계**라는 표시 (리뷰 W-4). hover가 없는 기기에서
            // 정지 상태로 서는 규칙이 이 속성에 걸려 있다 — tokens.css.
            data-row-clock=""
            // **DOM에는 언제나 있고 눈에만 조건부다.** 보조기술은 폰이 이미 모든 행의
            // 시각을 라벨에 넣고 있었고(진단 H-3의 아이러니: "VoiceOver는 아는 것을
            // 눈은 모른다"), 웹에서 그 값을 hover에만 두면 같은 비대칭을 반대로
            // 되풀이하는 것이다. 그래서 숨기는 것은 `opacity`이고 `hidden`이 아니다.
            //
            // 키보드에도 길을 준다: 행 안 어디에 포커스가 있어도 보이게 `focus-within`을
            // 함께 건다 — hover만 걸면 마우스 없는 사람에게는 없는 기능이 된다.
            className={cn(
              "absolute right-0 top-0 whitespace-nowrap text-timestamp text-ink-muted",
              "opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100",
              // 움직임을 줄여 달라고 한 사람에게는 페이드도 움직임이다.
              "motion-reduce:transition-none"
            )}
          >
            {timeLabel(message.createdAtMs)}
          </time>
        )}
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
            {/* 「누가」는 한 덩어리, 「언제」는 다른 덩어리 — 작성자 줄이 읽어야 할
                섬을 **둘**로 줄인다 (M-3 「작성자 줄이 과적재」).

                1차는 이름 · 관리자 · 시각이 `gap-2`로 나란히 선 세 개의 섬이었고,
                누가 말했는지 알려면 그 셋을 차례로 훑어야 했다. 관리자 병기는
                지울 수 없다 — 에이전트를 누가 책임지는지가 빠지면 1급 멤버 결정의
                회계가 사라진다(skill §9, 디렉터리·워크스트림이 쓰는 같은 문장).
                지우는 대신 **이름에 묶는다**: 가운뎃점이 둘을 한 신원 블록으로
                읽히게 하고, 시각만 따로 남는다. */}
            <span className="flex min-w-0 items-baseline gap-1">
              <span
                className={cn(
                  "truncate text-body font-semibold",
                  isAgent ? AGENT_TEXT : "text-ink"
                )}
              >
                {isAgent ? `@${author?.handle ?? name}` : name}
              </span>
              {owner && (
                <span className="truncate text-meta text-ink-muted">
                  · {owner.displayName} 님이 관리
                </span>
              )}
            </span>
            <time
              dateTime={new Date(message.createdAtMs).toISOString()}
              data-numeric
              data-testid="row-time"
              className="text-timestamp text-ink-muted"
            >
              {timeLabel(message.createdAtMs)}
            </time>
          </div>
        )}
        {/* 본문 **위**. 스레드 롤업이 본문 아래 꼬리에 있는 것과 대칭이고, 그
            대칭이 ADR-0148의 두 장치를 화면에서 갈라 놓는 첫 번째 축이다.
            tombstone에도 그린다: 지워진 메시지도 무언가를 가리켰다는 사실은
            지워지지 않는다. */}
        {quote && (
          <QuoteBlock
            block={quote}
            directory={directory}
            {...(onJumpToMessage ? { onJump: onJumpToMessage } : {})}
          />
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
            // `foldKey`가 메시지 id인 이유는 접힘 상태가 이 행보다 오래 살아야
            // 하기 때문이다: 긴 답을 펴 놓고 위 대화를 확인하러 갔다 오면
            // virtuoso는 그 사이에 이 행을 언마운트한다 (fold.ts).
            <MessageBody body={message.body ?? ""} foldKey={message.id} />
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
        {/* 꼬리는 한 줄이고, **그 한 줄은 칩 위에 있다** (R2 M6 + U1 H-6).
            R1은 「수정됨」과 「답글 N개」와 칩을 각각 자기 띠에 올려서, 한 줄짜리
            메시지 아래에 그 메시지보다 높은 세 겹의 꼬리가 쌓였다 — 본문이 자기
            부속물에 지는 그림이다. 칩은 누르는 것이라 자기 줄을 갖고, 읽기만 하는
            두 조각은 한 줄에 함께 앉는다.

            **순서는 그때 고치지 못했다.** 겹수는 줄었는데 칩이 여전히 위였고, 그래서
            「수정됨」이 반응 칩 **아래**로 밀려 본문과 떨어져 있었다(진단 H-6, 캡처
            `chat-light.png`: 본문 → 👍 2 → 수정됨). 「수정됨」은 **본문에 대한 서술**
            이므로 본문 바로 밑에 있어야 어느 메시지 것인지 되짚지 않는다. 칩은
            그 메시지에 대한 **남들의 반응**이라 한 겹 바깥이 맞다. */}
        {(showsEditedMark || rollup || repeatLabel) && (
          <div
            className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-muted"
            data-testid="message-meta"
          >
            {showsEditedMark && <span>수정됨</span>}
            {/* 접힌 반복의 개수 (goal P3 1-2). 알림 문장은 서버가 쓴 그대로 본문에
                남고, 이 조각은 그 문장이 몇 번 반복될 뻔했는지만 덧붙인다 —
                사라진 것은 같은 문장이지 사실이 아니다. */}
            {repeatLabel && (
              <span data-testid="paused-notice-repeat">{repeatLabel}</span>
            )}
            {rollup &&
              // 죽은 컨트롤을 만들지 않는다 (goal P3 1-1). 스레드 패널은
              // `onOpenThread`를 넘기지 않는데 — 이미 그 스레드를 열어 둔 자리라
              // "여는" 동작 자체가 없다 — R1은 그래도 <button>을 그렸다. 포커스가
              // 잡히고 hover에 반응하면서 눌러도 아무 일이 없는 버튼이었다.
              //
              // **그리고 스레드 패널은 이제 이 줄을 아예 그리지 않는다**
              // (goal RN-U2, `showRollup`). 위 `rollup` 이 그 자리에서 `null` 이므로
              // 여기까지 오지 않는다. 아래 <span> 갈래는 여전히 남는데, 롤업은
              // 있으나 열 곳이 없는 다른 표면(읽기 전용 마운트)이 그것이다 — 거기서
              // 「답글 3개 · 마지막 5분 전」은 읽을 값이 있는 문장이다.
              //
              // 행이 이미 쓰고 있는 규칙을 그대로 따른다: 위의 `available.reply`는
              // 핸들러가 없으면 답글 액션을 아예 내놓지 않는다("갈 곳 없는 답글은
              // 막다른 길이다"). 같은 이유로 여기서도 갈 곳이 있을 때만 버튼이고,
              // 없으면 읽는 글이다. 「답글 3개 · 마지막 5분 전」은 그 자체로 읽을
              // 값이므로 정보는 그대로 남고 없어지는 것은 가짜 어포던스뿐이다.
              (onOpenThread ? (
                <button
                  type="button"
                  onClick={() => onOpenThread(message)}
                  data-testid="thread-anchor"
                  data-row-action=""
                  className="rounded-sm hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                >
                  {rollupLabel(rollup)}
                </button>
              ) : (
                <span data-testid="thread-anchor">{rollupLabel(rollup)}</span>
              ))}
          </div>
        )}
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

// ---- 구분선 -----------------------------------------------------------------
//
// 셋 다 **판정을 갖지 않는다.** 무슨 낱말인지·어느 쪽에 서는지·얼마나 띄우는지는
// 코어 `timeline/divider.ts`가 정하고 폰이 같은 값을 소비한다 (U1 M-2: 「같은
// 제품인데 폰과 웹이 다른 얼굴을 한다」 — 각자 짓는 한 고쳐도 다시 벌어진다).

/**
 * 라벨 조각들. **`figure`에만 `data-numeric`이 붙는다.**
 *
 * 1차는 그 표지를 라벨 전체에 걸어 한글 음절까지 자릿폭 고정에 밀어 넣었다 — 같은
 * 레포가 이미 실측으로 적어 둔 결함이다(`workstreams/model.ts`의 `RunClock`
 * 독스트링: 「7월  29일」처럼 음절 사이가 벌어진다). 숫자만 고정하고 산문은 놓아 준다.
 */
function DividerLabel({ segments }: { segments: readonly DividerSegment[] }) {
  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === "figure" ? (
          <span key={index} data-numeric>
            {segment.text}
          </span>
        ) : (
          <span key={index}>{segment.text}</span>
        )
      )}
    </>
  );
}

/**
 * 구분선의 뼈대. 라벨이 먼저, rule이 나중 — 그것이 `DIVIDER_LABEL_SIDE`가
 * `"leading"`이라는 말이다.
 *
 * 여백을 Tailwind 클래스가 아니라 `style`로 거는 이유는 그 값이 **두 클라의
 * 합의값**이기 때문이다. 클래스로 옮겨 적으면 코어의 숫자와 화면의 숫자가 두 벌이
 * 되고, 한쪽만 고치는 다음 goal에서 다시 갈라진다.
 */
function DividerRow({
  testId,
  segments,
  tone,
  padClass,
  extra,
}: {
  testId: string;
  segments: readonly DividerSegment[];
  tone: "muted" | "accent";
  /** 코어의 간격을 옮긴 클래스. 둘이 갈라지면 `spacing.test.ts`가 붉다. */
  padClass: string;
  extra?: Record<string, string | number>;
}) {
  return (
    <div
      className={cn(
        "flex items-center px-4 text-meta",
        padClass,
        DIVIDER_GAP_CLASS,
        tone === "accent" ? "font-medium text-accent" : "text-ink-muted"
      )}
      data-testid={testId}
      data-label-side={DIVIDER_LABEL_SIDE}
      {...extra}
    >
      <span className="shrink-0 whitespace-pre">
        <DividerLabel segments={segments} />
      </span>
      <span
        aria-hidden="true"
        className={cn(
          "flex-1",
          DIVIDER_RULE_CLASS,
          tone === "accent" ? "bg-accent" : "bg-line"
        )}
      />
    </div>
  );
}

/**
 * Day separator. A rule with the date inline, not a centered pill.
 *
 * **`nowMs`를 받는 것이 H-4의 수리다.** 「오늘」인지 아는 데는 그 행의 시각만으로
 * 부족하고, 그것이 1차가 절대 표기만 그린 이유였다 — 오늘 대화를 보면서 「2026년 8월
 * 5일」을 읽고 그게 오늘인지 스스로 계산해야 했다. 상대 표기 함수는 이 파일에 이미
 * 있었고(`relativeLabel`) 스레드 롤업만 그것을 쓰고 있었다.
 */
export function DayDivider({ atMs, nowMs }: { atMs: number; nowMs: number }) {
  return (
    <DividerRow
      testId="day-divider"
      segments={dayDividerSegments(atMs, nowMs)}
      tone="muted"
      padClass={DAY_DIVIDER_PAD_CLASS}
      extra={{
        // 눈은 「오늘」을 읽고 보조기술은 절대 날짜를 읽는다. 화면을 되돌아볼 수 없는
        // 사람에게 상대 표현만 남기는 것은 정보를 빼는 것이다 (typing 줄과 같은 판단).
        "aria-label": dayDividerLabel(atMs, nowMs),
        role: "separator",
      }}
    />
  );
}

/** Unread boundary. Count is server truth (P7), never a local tally. */
export function UnreadDivider({ count }: { count: number }) {
  return (
    <DividerRow
      testId="unread-divider"
      segments={unreadDividerSegments(count)}
      tone="accent"
      padClass={MARKER_DIVIDER_PAD_CLASS}
    />
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
    <DividerRow
      testId="recovery-divider"
      segments={recoveryDividerSegments(seq, source)}
      tone="muted"
      padClass={MARKER_DIVIDER_PAD_CLASS}
      extra={{ "data-seq": seq, "data-source": source }}
    />
  );
}
