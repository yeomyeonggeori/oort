import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
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
import { AttachmentList } from "./AttachmentList";
import { MessageBody } from "./MessageBody";
// 살릴 본문이 있는지의 판정은 코어가 갖는다 — 폰이 같은 답을 소비한다 (#1478).
import { hasRenderableBody } from "@momo/core/features/timeline/bodySlot";
import { CascadeNotice } from "./CascadeNotice";
import { turnRecordRunId } from "@momo/core/features/timeline/cascadeModel";
import { rowPresentation } from "@momo/core/features/timeline/rowModel";
import { streamStopMark } from "@momo/core/features/timeline/streamStop";
// 구분선의 판정은 코어가 갖는다 — 폰이 같은 값을 소비한다 (U1 M-2).
import {
  dayDividerLabel,
  dayDividerSegments,
  recoveryDividerLabel,
  recoveryDividerSegments,
  unreadDividerSegments,
  DIVIDER_LABEL_SIDE,
  DIVIDER_TONE,
  type DividerSegment,
  type DividerTone,
} from "@momo/core/features/timeline/divider";
// 코어의 **역할**을 이 팔레트의 토큰으로 옮긴 다리 (D-2). 값이 갈라지면
// `dividerTone.test.ts`가 `tokens.css`를 읽어 붉게 만든다.
import { DIVIDER_TONE_CLASS } from "./dividerTone";
// 접기의 문구도 코어가 갖는다 — 폰이 자기 파일에서 조사를 붙이기 시작하면 같은
// 접기가 두 얼굴을 갖는다(U1 M-2가 구분선에서 겪은 실패 양식).
import { deletedFoldSegments } from "@momo/core/features/timeline/deletedFold";
// 아바타의 계약도 코어가 갖는다 (진단 H-11): 어떤 주소를 이미지로 믿는가,
// 무엇을 이니셜로 삼는가, 사람과 에이전트를 무엇으로 가르는가.
import { avatarIdentity } from "@momo/core/features/workspace/avatar";
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
  canPinMessage,
  canReactToMessage,
  canReplyToMessage,
  hasAnyAction,
} from "@momo/core/features/timeline/model";
import {
  PIN_EMPTY_BODY_TEXT,
  PIN_ROW_MARK,
} from "@momo/core/features/timeline/pins";
import {
  canQuoteMessage,
  resolveQuote,
} from "@momo/core/features/timeline/quote";
import { QuoteBlock } from "./QuoteBlock";
import {
  DeleteMessageDialog,
  MessageActionColumn,
  MessageActionContextMenu,
  MessageActionSheet,
  type MessageActionCallbacks,
} from "./MessageActions";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { useOpenMemberProfile } from "@/features/directory/memberProfileContext";
import { useRowRovingFocus } from "./rowFocus";
import { MessageEditor } from "./MessageEditor";
import { ReactionChips } from "./ReactionChips";
import type { ReactionChip } from "@momo/core/features/timeline/reactions";
import {
  deleteFailureMessage,
  editFailureMessage,
  pinFailureMessage,
  reactionFailureMessage,
} from "@momo/core/features/timeline/actionCopy";
import { useLongPress } from "./useLongPress";
import { rememberLongPressLearned } from "./LongPressHint";
import { WorkSessionIdleCard } from "@/features/work/WorkSessionIdleCard";
import type { OpenWorkSession } from "@/features/work/openWorkSession";
import { workSessionIdleNotice } from "@momo/core/features/work/workSessionModel";
import { selectionIsWithinRow } from "./messageContextMenuModel";
import type { MessageUnfurl } from "@momo/core/features/timeline/unfurl";
import { UnfurlCards } from "./UnfurlCards";

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

/**
 * A selected message belongs to the browser's native context menu.
 *
 * Radix's trigger is disabled before the contextmenu event reaches it, so it
 * never calls preventDefault in this branch. That preserves the browser's own
 * selection copy commands instead of replacing them with whole-message actions.
 */
function useSelectionWithinRow(ref: RefObject<HTMLElement | null>): boolean {
  const [selected, setSelected] = useState(false);
  useEffect(() => {
    const update = () =>
      setSelected(selectionIsWithinRow(ref.current, document.getSelection()));
    update();
    document.addEventListener("selectionchange", update);
    return () => document.removeEventListener("selectionchange", update);
  }, [ref]);
  return selected;
}

/** Mirrors tokens.css `pointer-only`: touch keeps the long-press sheet. */
function useHoverContextMenu(): boolean {
  const [matches, setMatches] = useState(
    () =>
      typeof window !== "undefined" && window.matchMedia("(hover: hover)").matches
  );
  useEffect(() => {
    const query = window.matchMedia("(hover: hover)");
    const update = () => setMatches(query.matches);
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return matches;
}

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

/**
 * 발화자의 얼굴 (진단 H-11). Shared with the pending row so an optimistic echo
 * sits on the same grid.
 *
 * 진단이 실측한 결함 셋이 여기서 닫힌다:
 *
 *  1. **24px 정사각 이니셜은 아바타로 읽히지 않았다.** 캡처에서 워크스페이스
 *     스위처의 「곽」과 메시지 아바타의 「곽」이 같은 크기·같은 모양으로 충돌했다.
 *     이제 `AVATAR_SIZE`(32)이고, 그 값과 근거는 코어에 있다.
 *  2. **이니셜이 uuid 첫 글자가 될 수 있었다** — `name.slice(0, 1)` 에 명부에서
 *     못 찾은 작성자의 uuid 앞 8자가 들어왔다. 이제 이니셜 판정은 코어가 하고,
 *     글자로 시작하지 않으면 이니셜을 **그리지 않는다**: 모르는 것을 아는 척하지
 *     않는 자리다.
 *  3. **`avatarUrl` 경로가 아예 없었다** — 타입에만 있고 소비처도 `<img>` 도 0.
 *     이제 실을 수 있는 주소면 그린다. 「실을 수 있는가」를 코어가 먼저 판정하는
 *     이유는 배포 CSP(`img-src 'self' data:`)가 다른 오리진을 **조용히** 거절해
 *     깨진 상자만 남기기 때문이다.
 *
 * 정체는 색과 **모양** 둘로 나른다(`AVATAR_SHAPE`): 사람은 원, 에이전트는 둥근
 * 사각. 색만으로 가르면 색각 이상이 있는 사람에게 구분이 없다. 모르는 작성자는
 * 사람 쪽 모양을 빌리되 정체 색을 쓰지 않는다 — 모양은 색보다 약한 주장이다.
 *
 * `aria-hidden`은 그대로다. 이름은 바로 옆 작성자 줄이 글자로 말하고, 아바타가
 * 그것을 한 번 더 읽으면 보조기술은 모든 행에서 이름을 두 번 듣는다.
 */
export function Avatar({ member }: { member: RosterMember | null }) {
  const identity = avatarIdentity(
    member,
    typeof location === "undefined" ? null : location.origin
  );
  return (
    <span
      aria-hidden="true"
      data-testid="row-avatar"
      data-avatar-kind={identity.kind}
      className={cn(
        // size-8 = AVATAR_SIZE(32). 두 값이 갈라지면 `avatarSize.test.ts`가 붉다.
        "flex size-8 items-center justify-center overflow-hidden text-meta font-semibold",
        identity.kind === "agent" ? "rounded-sm" : "rounded-full",
        identity.kind === "agent" && "bg-agent-soft text-agent",
        identity.kind === "human" && "bg-surface-hover text-ink",
        // 모르는 작성자: 정체 색 없이 배경만. 이름도 이니셜도 주장하지 않는다.
        identity.kind === "unknown" && "bg-surface-hover text-ink-muted"
      )}
    >
      {identity.imageUrl !== null ? (
        <img
          src={identity.imageUrl}
          alt=""
          // 상자를 채우되 비율은 지킨다. 정사각이 아닌 사진이 늘어나면 그 얼굴은
          // 그 사람이 아니다.
          className="size-full object-cover"
        />
      ) : identity.fallback.kind === "initial" ? (
        identity.fallback.text
      ) : (
        // 모른다. 글자를 그리지 않고 자리만 지킨다 — 이 자리에 들어갈 「?」는
        // 물음이 아니라 잡음이고, 옆 줄이 이미 uuid 앞자리를 이름 자리에 쓰고
        // 있으므로 같은 사실을 두 번 말하게 된다.
        <span className="size-2 rounded-full bg-line-strong" />
      )}
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
  /**
   * 이슈 #1112 — whether THIS message is pinned, already derived (see
   * `isPinned`). Passed in rather than looked up here for the same reason
   * `chips` is: the row must not hold the channel's whole pin map, or every pin
   * anywhere re-renders every row.
   */
  pinned: boolean;
  /** Pin or unpin. The direction is `pinned`'s; a failure is reported here. */
  onTogglePin: (message: Message) => Promise<void> | void;
  onEditMessage: (message: Message, body: string) => Promise<void>;
  onDeleteMessage: (message: Message) => Promise<void>;
  onRemoveUnfurls?: (message: Message) => Promise<void>;
}

export function MessageRow({
  message,
  startsGroup,
  directory,
  actions,
  pausedRepeat,
  deletedRepeat,
  deletedFoldedIds,
  unfurls = [],
  foldLinkPreviews = false,
  runEnded = false,
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
  /**
   * 이 묘비가 자기를 포함해 대신하는 삭제 메시지 수 (감사 M-1, 코어
   * `deletedFold.ts`). 접기 판정은 목록이 하고 이 행은 그 결과를 말하기만 한다.
   */
  deletedRepeat?: number;
  /**
   * 이 행 **안으로** 접혀 들어간 메시지들의 id.
   *
   * 화면에는 나가지 않는다. DOM에 나가는 이유는 **항법** 하나다: 삭제 원본을
   * 가리킨 인용 점프가 그 원본의 행을 못 찾았을 때, 「그 메시지를 대신해 서 있는
   * 행」을 이 속성으로 찾는다(`inbox/anchor.ts`의 대리 착지 — 폰이 U4-5 H-1에서
   * 고친 거짓 지시가 웹에서 재현되지 않게 하는 자리다).
   */
  deletedFoldedIds?: readonly string[];
  /** ADR-0170 projection for this row; failed/blocked are kept for quiet render. */
  unfurls?: readonly MessageUnfurl[];
  /** Personal, device-local render choice. It never changes server fetching. */
  foldLinkPreviews?: boolean;
  /**
   * ADR-0155 — 이 메시지를 쓴 run 이 **끝난 것을 보았는가**.
   *
   * 목록이 넣는다(`Timeline`). 행이 직접 스토어를 구독하면 아무 run 이나 끝날 때
   * 화면의 모든 줄이 다시 그려진다. 기본값 `false` 는 「모른다」이고, 모를 때
   * 아무 말도 하지 않는 것이 이 판정의 보수적인 쪽이다 — 스레드 패널이나 작업
   * 패널처럼 레일을 읽지 않는 표면은 이 값을 넣지 않는다.
   */
  runEnded?: boolean;
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
  onOpenWorkSession?: OpenWorkSession;
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
  const [pickerOpener, setPickerOpener] = useState<HTMLElement | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const openMemberProfile = useOpenMemberProfile();
  const author = memberFor(directory, message.authorMemberId);
  const isAgent = author?.kind === "agent";
  const name = author?.displayName ?? message.authorMemberId.slice(0, 8);
  const owner = isAgent ? memberFor(directory, author?.ownerHumanId) : null;
  const deleted = message.state === "deleted";
  const failed = message.state === "failed";
  // 살릴 본문이 실제로 있는가 (이슈 #1465 → #1478). 자격(`keepsBody`)과 다른
  // 물음이고, 왜 `trim()`인지와 부재·빈 문자열·공백이 각각 몇 픽셀이었는지는
  // 코어의 `features/timeline/bodySlot.ts`에. 폰이 같은 함수를 부른다.
  const hasBody = hasRenderableBody(message.body);
  // Same meaning as the phone action sheet: only the author's raw markdown,
  // and never an empty string or a tombstone. The shared hook is also what the
  // settings CopyButton uses, so the two-second 「복사됨」 receipt cannot drift.
  const canCopy = Boolean(actions) && !deleted && hasBody;
  const { copied, copy: copyMessage } = useClipboardCopy(message.body ?? "");
  // ADR-0151 — 서버가 완료된 것만 실어 준다. 없으면 빈 배열이고, 빈 배열은
  // `AttachmentList`가 아무것도 그리지 않는다.
  const attachments = message.attachments ?? [];
  const rollup = showRollup ? threadRollup(message) : null;
  const showsEditedMark = message.state === "edited" && !editing;
  // 이슈 #1146 M3 — 이 행이 고정돼 있다는 흔적. 왜 그리는지·왜 이 줄인지·왜
  // accent가 아닌지는 코어의 `PIN_ROW_MARK` 독스트링에 있다.
  //
  // 지워진 행에는 그리지 않는다: 서버가 삭제와 함께 pin 행을 쓸어내므로 묘비가
  // 「고정됨」을 다는 창은 프레임이 도착하기까지의 몇 밀리초뿐이고, 그 몇 밀리초에
  // 하는 말은 이미 참이 아니다.
  const showsPinMark = Boolean(actions?.pinned) && !deleted;
  // ADR-0155 — 멈춘 답. 왜 이 낱말인지·왜 accent 가 아닌지는 코어의
  // `streamStop.ts` 헤더에 있다. 묘비에는 그리지 않는다: 저자가 지운 메시지에
  // 대고 「중단됨」이라고 말하는 것은 이미 없는 본문을 서술하는 것이다.
  const stopMark = deleted ? null : streamStopMark(message, runEnded);
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
    // 이슈 #1112. 작성자 관문이 없다 — 고정은 채널의 사실이고, 푸는 것도 누구나
    // 할 수 있다(서버가 같은 규칙을 강제한다).
    pin: Boolean(actions) && canPinMessage(message),
    edit: Boolean(actions) && canEditMessage(message, actions?.myMemberId),
    delete: Boolean(actions) && canDeleteMessage(message, actions?.myMemberId),
  };
  const actionable =
    Boolean(actions) && (hasAnyAction(available) || canCopy);

  const callbacks: MessageActionCallbacks = {
    onReply: () => onOpenThread?.(message),
    onQuote: () => onQuoteMessage?.(message),
    onCopy: () => {
      setRowError(null);
      void copyMessage().then((ok) => {
        if (!ok) {
          setRowError(
            "메시지를 복사하지 못했습니다. 텍스트를 선택해 복사하세요."
          );
        }
      });
    },
    onReact: (emoji) => {
      if (!actions) return;
      setRowError(null);
      void Promise.resolve(actions.onToggleReaction(message, emoji)).catch(
        (error: unknown) => setRowError(reactionFailureMessage(error))
      );
    },
    onPin: () => {
      if (!actions) return;
      setRowError(null);
      void Promise.resolve(actions.onTogglePin(message)).catch(
        (error: unknown) => setRowError(pinFailureMessage(error))
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
  const selectionWithinRow = useSelectionWithinRow(rowRef);
  const openReactionPicker = (opener?: HTMLElement | null) => {
    // 메뉴 항목은 다이얼로그가 열릴 때 포털과 함께 사라진다. 그 항목을 opener로
    // 잡으면 Esc 뒤 포커스가 body로 떨어지므로, 남아 있는 반응 추가 버튼 또는
    // 메시지 행을 명시적으로 돌려줄 자리로 잡는다.
    setPickerOpener(opener ?? rowRef.current);
    setPickerOpen(true);
  };
  const hoverContextMenu = useHoverContextMenu();

  // `data-message-id` is the row's second published identity (MOMO-677).
  // `seq` orders the channel and is what the inbox jumps by; a projection
  // that knows a message only by id (the workstream anchor thread) has no
  // seq to derive, so it addresses the row the way it actually knows it.
  // Lower-cased at the source: Swift sends UUIDs upper-cased and a CSS
  // attribute selector does not fold case.
  return (
    <MessageActionContextMenu
      enabled={
        actionable && hoverContextMenu && !selectionWithinRow && !editing
      }
      available={available}
      canCopy={canCopy}
      copied={copied}
      pinned={Boolean(actions?.pinned)}
      callbacks={callbacks}
      onOpenPicker={() => openReactionPicker()}
    >
      <article
      ref={rowRef}
      data-testid="timeline-message"
      data-seq={message.seq}
      data-message-id={message.id.toLowerCase()}
      // 대리 착지의 열쇠 (U4-5 H-1). 공백으로 이은 목록이라 CSS `~=`가 낱개를
      // 고를 수 있고, 그래서 항법이 상태를 새로 만들지 않고 이미 있는 감시자를
      // 그대로 쓴다. 접힌 것이 없으면 속성 자체가 없다.
      data-deleted-folded-ids={
        deletedFoldedIds && deletedFoldedIds.length > 0
          ? deletedFoldedIds.map((id) => id.toLowerCase()).join(" ")
          : undefined
      }
      data-author-kind={author?.kind ?? "unknown"}
      data-actionable={actionable ? "true" : undefined}
      onKeyDown={onRowKeyDown}
      // State disables the Radix trigger before a normal right-click. The
      // capture guard covers the same gesture synchronously if React has not
      // committed the immediately preceding selectionchange yet.
      onContextMenuCapture={(event) => {
        if (selectionIsWithinRow(rowRef.current, document.getSelection())) {
          event.stopPropagation();
        }
      }}
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
        "focus-visible:focus-ring",
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
      <div className="relative w-8 shrink-0">
        {startsGroup ? (
          author ? (
            <button
              type="button"
              data-testid="row-avatar-profile"
              data-row-action=""
              aria-label={`${author.displayName} @${author.handle} 프로필 열기`}
              title={`${author.displayName} @${author.handle} 프로필 열기`}
              onClick={(event) =>
                openMemberProfile(author.id, event.currentTarget)
              }
              className={cn(
                "focus-visible:focus-ring",
                isAgent ? "rounded-sm" : "rounded-full"
              )}
            >
              <Avatar member={author} />
            </button>
          ) : (
            <Avatar member={author} />
          )
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
            {/* 이름은 이름이다 (R1 M8). 프로필 진입점은 옆의 아바타다. 그 버튼은
                `data-row-action` 로 이 행의 기존 로빙 그룹에 합류하므로 메시지마다
                탭 정거장을 하나씩 늘리지 않는다. 행 액션은 우클릭 ContextMenu와
                기존 ⋯ 메뉴가 같은 목록을 공유하고, 이름 자체는 계속 읽는 글이다. */}
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
            // 연달아 지워진 것들은 **한 줄**로 접힌다 (감사 M-1: 지워진 것들이
            // 지워지지 않은 것들만큼 자리를 차지한다). 문구도 접기 규칙도 코어에
            // 있으므로 폰과 같은 문장이 나온다.
            <p
              className="break-words text-meta text-ink-muted"
              data-testid="tombstone"
              data-deleted-repeat={deletedRepeat}
            >
              <DividerLabel segments={deletedFoldSegments(deletedRepeat)} />
            </p>
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
          ) : hasBody ? (
            // `foldKey`가 메시지 id인 이유는 접힘 상태가 이 행보다 오래 살아야
            // 하기 때문이다: 긴 답을 펴 놓고 위 대화를 확인하러 갔다 오면
            // virtuoso는 그 사이에 이 행을 언마운트한다 (fold.ts).
            <MessageBody body={message.body ?? ""}
              directory={directory}
              foldKey={message.id}
              selfMemberId={actions?.myMemberId}
            />
          ) : (
            // 살릴 본문이 없으면 칸을 만들지 않는다 (이슈 #1465 · 코어
            // `bodySlot.ts`). `keepsBody`는 「본문을 살릴 자격」이지 「살릴 본문이
            // 있다」가 아니다 — 요약 없는 완료 리포트가 그 둘이 갈라지는 유일한
            // 자리이고, 거기서 웹은 글자 없는 문단을 하나 세우고 폰은 세우지 않았다.
            null
          ))}
        {/* 첨부는 본문 **바로 아래**다 (ADR-0151 D2). 카드·아티팩트보다 앞인
            이유는 순서가 안쪽에서 바깥쪽이기 때문이다: 파일은 작성자가 이 메시지에
            직접 붙인 것이고, 그 아래 카드들은 그 메시지에 **대해** 서버가 말하는
            것이다. 삭제된 행에는 그리지 않는다 — 묘비는 본문을 지운 자리이고,
            거기 파일 카드가 남아 있으면 지워진 것이 무엇인지 말이 어긋난다. */}
        {!deleted && attachments.length > 0 && (
          <AttachmentList
            channelId={message.channelId}
            attachments={attachments}
          />
        )}
        {!deleted && unfurls.length > 0 && (
          <UnfurlCards
            unfurls={unfurls}
            folded={foldLinkPreviews}
            canRemove={
              Boolean(actions?.onRemoveUnfurls) &&
              actions?.myMemberId.toLowerCase() ===
                message.authorMemberId.toLowerCase()
            }
            {...(actions?.onRemoveUnfurls
              ? { onRemove: () => actions.onRemoveUnfurls?.(message) ?? Promise.resolve() }
              : {})}
          />
        )}
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
          card && (
            <AgentCard
              card={card}
              directory={directory}
              {...(onOpenWorkSession !== undefined
                ? { onOpenWorkSession }
                : {})}
            />
          )
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
        {(stopMark || showsEditedMark || showsPinMark || rollup || repeatLabel) && (
          <div
            className="mt-1 flex flex-wrap items-center gap-2 text-meta text-ink-muted"
            data-testid="message-meta"
          >
            {/* 「수정됨」보다 **앞**이다. 순서 규칙은 안쪽에서 바깥쪽이고, 이보다
                안쪽인 서술은 없다 — 이 낱말은 본문이 여기서 끝났다고 말한다.
                꼬리의 다른 조각들은 그 본문에 **대해** 말한다. */}
            {stopMark && <span data-testid="stream-stop-mark">{stopMark}</span>}
            {showsEditedMark && <span>수정됨</span>}
            {/* 「수정됨」 다음, 「답글 N개」 앞 — 본문에 대한 서술 다음이고 바깥
                스레드로 나가는 문 앞이다. 안쪽에서 바깥쪽으로. */}
            {showsPinMark && (
              <span data-testid="pin-mark">{PIN_ROW_MARK}</span>
            )}
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
                  className="rounded-sm hover:text-ink focus-visible:focus-ring"
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
              available.react ? openReactionPicker : undefined
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
                className="rounded-sm underline underline-offset-2 hover:text-ink focus-visible:focus-ring disabled:opacity-50"
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
          canCopy={canCopy}
          copied={copied}
          pinned={Boolean(actions?.pinned)}
          callbacks={callbacks}
          onOpenPicker={() => openReactionPicker()}
          hidden={editing}
        />
      )}
      {actions && actionable && (
        <>
          <MessageActionSheet
            open={sheetOpen}
            onOpenChange={setSheetOpen}
            preview={message.body?.trim() || PIN_EMPTY_BODY_TEXT}
            available={available}
            canCopy={canCopy}
            copied={copied}
            pinned={Boolean(actions?.pinned)}
            callbacks={callbacks}
            onOpenPicker={() => openReactionPicker()}
          />
          <EmojiPickerDialog
            open={pickerOpen}
            onOpenChange={setPickerOpen}
            onPick={(emoji) => callbacks.onReact(emoji)}
            opener={pickerOpener}
            purpose="reaction"
            testId="reaction-picker"
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
    </MessageActionContextMenu>
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
 * **N-1 정정:** 이 자리의 앞 독스트링은 여백을 「`style`로 건다」고 적고 있었는데
 * 구현은 `padClass`를 받는다. 1차의 잔해였고, `spacing.ts` 머리말이 정반대
 * 결정(CSP가 인라인 스타일을 막아 길은 클래스뿐이다)을 이미 설명하고 있었다.
 * 지금 참인 것만 남긴다: 간격의 정본은 코어이고 이 파일은 그 번역을 받는다.
 *
 * **색도 같은 구조가 됐다 (D-2).** `tone`은 이제 토큰 이름이 아니라 코어가 정한
 * **역할**(`DividerTone`)이고, 그 역할이 이 팔레트의 어느 토큰인지는
 * `dividerTone.ts` 한 자리가 답한다. 「accent인가」를 여기서 묻던 앞 판은 어느
 * 토큰인지만 말하고 왜 그 토큰인지는 말하지 않았다 — 팔레트를 손대는 사람에게
 * 안읽음 경계가 걸려 있다는 사실이 어디에도 없었다.
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
  /** 코어의 역할. 토큰은 `dividerTone.ts`가, 계약은 그 테스트가 잠근다. */
  tone: DividerTone;
  /** 코어의 간격을 옮긴 클래스. 둘이 갈라지면 `spacing.test.ts`가 붉다. */
  padClass: string;
  extra?: Record<string, string | number>;
}) {
  const paint = DIVIDER_TONE_CLASS[tone];
  return (
    <div
      className={cn(
        "flex items-center px-4 text-meta",
        padClass,
        DIVIDER_GAP_CLASS,
        paint.label
      )}
      data-testid={testId}
      data-label-side={DIVIDER_LABEL_SIDE}
      // 게이트가 이 줄의 색을 잴 때 「무엇이어야 하는가」를 함께 읽는다. 값이
      // 아니라 역할이므로 이 속성은 팔레트가 바뀌어도 같은 말을 한다.
      data-tone={tone}
      {...extra}
    >
      <span className="shrink-0 whitespace-pre">
        <DividerLabel segments={segments} />
      </span>
      <span
        aria-hidden="true"
        data-divider-rule=""
        className={cn("flex-1", DIVIDER_RULE_CLASS, paint.rule)}
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
      tone={DIVIDER_TONE.day}
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

/**
 * Unread boundary. Count is server truth (P7), never a local tally.
 *
 * 세 구분선 중 **경계를 그리는 색을 지는 것은 이 줄 하나**다 (D-2). 그 판정은
 * 코어에 있고 여기서는 이름으로 받는다 — 이 파일이 「accent」라고 적고 있던 동안
 * 그 선택은 팔레트를 손대는 사람에게 보이지 않았다.
 */
export function UnreadDivider({ count }: { count: number }) {
  return (
    <DividerRow
      testId="unread-divider"
      segments={unreadDividerSegments(count)}
      tone={DIVIDER_TONE.unread}
      padClass={MARKER_DIVIDER_PAD_CLASS}
    />
  );
}

/**
 * Reconnect marker.
 *
 * **C-1: 문장에서 seq가 빠졌다.** 이 표지는 자기가 확인한 것들 **아래**에
 * 앵커되므로 「어디까지」는 이 줄의 위치가 이미 답한다 — 화면의 어느 행도 자기
 * seq를 그리지 않으므로 그 숫자는 대조할 대상이 없었다. 근거 전문은 코어
 * `recoveryDividerSegments` 독스트링에.
 *
 * `data-seq`는 남는다. 그것은 문구가 아니라 **진단 값**이고, seq 게이트가 이
 * 속성으로 복구 지점을 확인한다 (SKILL §4가 여는 예외가 정확히 그 자리다).
 *
 * 낭독은 위치를 볼 수 없으므로 `aria-label`이 「이 줄 위까지」로 그 자리를 말로
 * 되돌려 준다 — 날짜 구분선이 절대 날짜를 함께 말하는 것과 같은 판단이다.
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
      tone={DIVIDER_TONE.recovery}
      padClass={MARKER_DIVIDER_PAD_CLASS}
      extra={{
        "data-seq": seq,
        "data-source": source,
        "aria-label": recoveryDividerLabel(source),
        role: "separator",
      }}
    />
  );
}
