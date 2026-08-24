import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { AtSign, SendHorizontal, Smile } from "lucide-react";
import type {
  MessageAttachment,
  RequestRouting,
  RosterMember,
} from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { useIsMobileShell } from "@/app/shellNav";
import type { Directory } from "@/features/workspace/useWorkspace";
import {
  composerKeyIntent,
  isComposingEvent,
} from "@momo/core/features/chat/composerKeys";
import type { RecipientKind } from "@momo/core/lib/koreanParticle";
import {
  COMPOSER_KEYS_HINT,
  COMPOSER_OFFLINE_COPY,
  HINT_SEPARATOR,
  composerFieldLabel,
} from "@momo/core/features/chat/composerCopy";
import { useFittedComposerPlaceholder } from "@/features/chat/placeholderFit";
import {
  agentTurnsInChannel,
  elapsedLabel,
  hasChannelTurn,
  useAgentWorkingSignals,
  useTickingNow,
  type AgentWorkingSignal,
} from "@/features/agents/agentWorkingSignal";
import {
  activityLines,
  activitySuffix,
  activityText,
  agentLabelAsSubject,
  TURN_STALE_SENTENCE,
  UNKNOWN_AGENT_NAME,
  type AgentActivityLine,
} from "@/features/agents/turnCopy";
import { memberFor, memberNameParts } from "@/features/workspace/useWorkspace";
import { openWorkPanel } from "@/features/agents/workLogStore";
import {
  MENTION_ROUTING_ROW_CLASS,
  MentionRoutingBar,
} from "@/features/routing/MentionRoutingBar";
import { useMentionRouting } from "@/features/routing/useMentionRouting";
import { mentionRoutingTarget } from "@momo/core/features/routing/mentionTargets";
import { routingPayload } from "@momo/core/features/routing/routingModel";
import type { QuoteDraft } from "@momo/core/features/timeline/quote";
import { QuoteChip } from "@/features/timeline/QuoteBlock";
import { TypingLine } from "@/features/chat/TypingLine";
import {
  composerMetaMode,
  keepPhoneDmHint,
} from "@/features/chat/composerMeta";
import { useTypingSend } from "@/features/chat/useTyping";
import { useTypingThreshold, useTypists } from "@/features/chat/typingStore";
import {
  COMPOSER_SEED_EVENT,
  clearDraft,
  readDraft,
  writeDraft,
} from "@/features/chat/draftStore";
import { rememberSendLearned, useSendHintNeeded } from "@/features/chat/sendHint";
import { useAutoGrow } from "@/features/timeline/useAutoGrow";
import { useOffline } from "@/features/common/useOffline";
import {
  AttachButton,
  AttachmentTray,
} from "@/features/attachments/AttachmentTray";
import {
  acknowledgeNotices,
  addFiles,
  clearSurface,
  dropDraft,
  retryDraft,
  surfaceKey,
  takeSent,
  useAttachmentSurface,
} from "@/features/attachments/draftStore";
import {
  sendBlockCopy,
  sendBlockReason,
} from "@momo/core/features/attachments/model";
import { useComposerDropZone } from "@/features/attachments/useComposerDropZone";
import {
  MentionAutocompleteList,
  useMentionAutocomplete,
} from "@/features/chat/MentionAutocomplete";
import { useComposerEmoji } from "@/features/chat/useComposerEmoji";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";

// =============================================================================
// Composer (R-1 §3). Send plus the @mention skeleton. ↵ sends, ⇧↵ is a line
// break, ⌘↵ still sends, Esc dismisses the mention list.
//
// ↵ was the line break until goal B8: every messenger a reader has used sends
// on it, so "왜 안 보내지" was the single most repeated moment of the QA sweep.
// The exception that makes the swap safe is the IME one, and it is big enough
// to live in its own tested file (composerKeys.ts): a 한글 sentence is composed
// before it is committed, and the Enter that commits it is the IME's keystroke,
// not a send.
//
// The mention list is hand-rolled rather than cmdk/Command: a Command popover
// owns its own input and would pull focus out of the textarea mid-sentence.
// This keeps the caret in the textarea and exposes a listbox for a11y.
//
// Sending is NOT owned here (M10): `onSend` is useTimeline's one send path, so
// the local echo, the seq reconcile and the failure state all live next to the
// timeline that renders them. The composer's job ends at clearing the input,
// which it does immediately: the message is already on screen as a pending row,
// and a composer that stays full while its message is visible below reads as if
// nothing happened.
//
// ## U4-f — 미완성이던 세 자리 (진단 H-10 / M-7)
//
// 1. **초안이 채널 전환에 살아남는다.** 본문이 `useState`에만 있어서, 반쯤 쓴
//    문단이 탭 한 번에 없어졌다. 저장 위치와 수명 정책은 `draftStore.ts`에.
// 2. **오프라인에서는 보내지 않는다.** `connStatus`를 읽고는 있었지만 활동바
//    표시에만 썼고, 전송 버튼의 유일한 비활성 조건은 빈 텍스트였다. 끊긴 채로
//    누른 전송은 실패 행 하나를 만들고 끝난다. 다만 **입력창은 잠그지 않는다** —
//    연결이 끊겼다고 글을 쓰지 못할 이유가 없고, 그동안 쓴 것은 초안이 지킨다.
// 3. **자라는 방식을 고친다.** 앞 판은 `text.split("\n").length`로 **하드 개행만**
//    셌다. 한국어 메시지는 줄바꿈 없이 한 문단으로 오고 창 폭에서 접히는 쪽이
//    흔하므로, 길게 감긴 한 줄 문단에서는 상자가 자라지 않았다. `scrollHeight`를
//    재는 `useAutoGrow`가 같은 레포에 있었고 스레드 컴포저와 수정 입력창은 이미
//    그것을 쓰고 있었다 — 컴포저만 안 썼다.
// =============================================================================

const MIN_ROWS = 1;
const MAX_ROWS = 6;

/**
 * 연결이 끊겨 있을 때 전송 자리에서 하는 말. **이름만 여기 있고 값은 코어에
 * 있다** (U4-6 리뷰 H-1).
 *
 * 이 파일이 들고 있던 문장은 "…쓰던 글은 그대로 남습니다."였고, 같은 주에 폰이
 * 자기 파일에 같은 이름으로 한 절이 더 있는 문장을 지었다. 리뷰가 그 갈라짐을
 * 실측했고, 값은 `APPROVAL_OFFLINE_COPY` 가 이미 걸어 둔 길로 올라갔다 —
 * 고른 문장과 고른 이유는 `@momo/core/features/chat/composerCopy` 가 적는다.
 * 요약하면 **이 앱의 오프라인 문장에는 모양이 있고**(지금 못 하는 것 → 다시
 * 연결되면 여기서 할 수 있는 것) 이 파일의 문장에는 그 뒷절이 없었다.
 *
 * 이름을 남기는 이유: 이 줄은 세 자리에서 쓰인다(버튼 `title` · 아래 한 줄 ·
 * 게이트가 찾는 `data-testid`). 값을 세 번 적는 대신 이름 하나를 쓴다.
 */
export { COMPOSER_OFFLINE_COPY };

/**
 * 컴포저 힌트 판. 데스크톱에서는 U-8 공유 액션 슬롯이고, 폰 DM에서는 기존처럼
 * 그릇 바로 위의 상시 안내다. `sharedRow`가 두 배치의 경계를 DOM에도 남긴다.
 */
function ComposerHint({
  directory,
  dmAgent,
  keysHintNeeded,
  sharedRow,
}: {
  directory: Directory;
  dmAgent: RosterMember | null;
  keysHintNeeded: boolean;
  sharedRow: boolean;
}) {
  return (
    <p
      id="composer-hint"
      // 공유 판은 액션 아이콘과 보내기 사이에서 이미 예약된 가로폭만 쓴다. 별도
      // 26px 행을 두면 ↵를 배운 뒤에도 타임라인과 그릇 사이에 죽은 밴드가 남는다.
      // 폰 DM 판만 그릇 위에 서므로 기존 텍스트 기둥 인셋(px-6)을 유지한다.
      className={cn(
        sharedRow
          ? "min-w-0 flex-1 truncate text-right text-meta text-ink-muted"
          : "px-6 pb-2 text-meta text-ink-muted",
        !dmAgent && "wide-only"
      )}
      data-testid="composer-hint"
      data-composer-meta-slot={sharedRow ? "" : undefined}
    >
      {dmAgent && (
        <span data-testid="composer-dm-hint">
          멘션 없이 바로 말하면{" "}
          {agentLabelAsSubject(
            memberNameParts(directory, dmAgent.id, dmAgent.displayName)
          )}{" "}
          답합니다
        </span>
      )}
      {keysHintNeeded && (
        <span className="wide-only" data-testid="composer-keys-hint">
          {dmAgent ? HINT_SEPARATOR : ""}
          {COMPOSER_KEYS_HINT}
        </span>
      )}
    </p>
  );
}

/**
 * Composer activity bar (R-1 §3, mac AgentWorkingComposerBar). One flat meta
 * line per open turn, drawn from what the agent actually wrote, with its clock
 * beside its own label.
 *
 * It does NOT rotate. The mac bar cycles agent x headline pairs every five
 * seconds because a SwiftUI composer footer has one line to spend; on the web
 * that same loop is content that mutates on a timer, which needs a pause
 * control to meet WCAG 2.2.2, has no keyboard path when the pause is a hover,
 * and prints a "1/3" pager that reads as a slideshow inside a work tool. Two or
 * three stacked lines say more, sit still, and need no controls at all. Nothing
 * here animates, so there is no reduced-motion branch to diverge from.
 *
 * The bar states a turn even before a headline exists ("김인턴이 작업 중" plus a
 * clock is a true thing the reader wants) and states an approval wait as an
 * approval wait, never as work.
 *
 * OFFLINE (SKILL §5) is a state this bar has to SHOW, not merely encode. The
 * first cut expressed a dead rail by hiding the clock and rewriting an
 * aria-label, which for an awaiting_approval turn is a no-op on screen: the
 * line "Hermes가 승인을 기다립니다" was pixel-identical either way, so the app
 * kept asserting agent state on a socket that was gone. Now the agent token
 * comes off the name (the same demotion the sidebar pill makes: a remembered
 * claim must not look as confirmed as a live one) and one warn-colored line
 * says why, in place, which is what an offline banner is (§5) and not a toast.
 */
function AgentActivityBar({
  turns,
  directory,
  nowMs,
  live,
}: {
  turns: AgentWorkingSignal[];
  directory: Directory;
  nowMs: number;
  /** The realtime rail is connected, so a clock is measuring something. */
  live: boolean;
}) {
  const { lines, overflowCount, summary } = useMemo(
    () =>
      activityLines(turns, (memberId) =>
        memberNameParts(directory, memberId, UNKNOWN_AGENT_NAME)
      ),
    [turns, directory]
  );

  if (lines.length === 0) return null;

  return (
    <ul
      // `px-6`은 폼의 `p-3` + 텍스트에어리어의 `px-3` = 24px이다. 작업 줄은
      // textarea 텍스트 기둥에 서고, 작성 중·키 힌트는 #1749에서 액션 행 가운데
      // 슬롯으로 내려갔다.
      className="flex flex-col gap-1 px-6 pb-2"
      // The offline sentence is a real list item below, so it is announced in
      // reading order rather than glued onto the list's name and read twice.
      aria-label={summary}
      data-testid="composer-working"
      data-live={live ? "" : undefined}
    >
      {lines.map((line) => {
        const turn = turns.find((t) => t.memberId === line.memberId);
        const runId = turn?.runId;
        const body = (
          <>
            <ActivityText line={line} live={live} />
            {live && line.state === "working" && line.startedAtMs !== undefined && (
              <span className="shrink-0 text-timestamp" data-numeric>
                {elapsedLabel(line.startedAtMs, nowMs)}
              </span>
            )}
          </>
        );
        return (
          <li key={line.key} className="flex text-meta text-ink-muted">
            {/* 작업 패널 진입점 ① (goal WEB-WP1). 이 줄은 이미 "지금 무슨 일이
                일어나고 있는가"이고, 그 과정을 펼쳐 보는 자리도 여기다.
                run을 특정하지 못한 턴은 버튼이 되지 않는다: 눌러도 아무 일이
                없는 컨트롤은 고장 난 버튼으로 읽힌다. */}
            {turn === undefined || runId === undefined ? (
              <span className="flex min-w-0 items-baseline gap-2">{body}</span>
            ) : (
              <button
                type="button"
                onClick={(event) =>
                  openWorkPanel(
                    {
                      runId,
                      memberId: turn.memberId,
                      channelId: turn.channelId,
                      origin: "activity",
                      // 이 줄이 이미 그리고 있는 시계와 같은 값이다. 패널이 자기
                      // 힘으로는 얻을 수 없는 유일한 값이라 여기서 넘겨준다.
                      ...(turn.startedAtMs !== undefined
                        ? { startedAtMs: turn.startedAtMs }
                        : {}),
                    },
                    // 닫을 때 캐럿이 돌아올 자리. WebKit은 클릭으로 버튼에
                    // 포커스를 주지 않으므로 추정에 맡기지 않는다.
                    event.currentTarget
                  )
                }
                // 이름을 명시한다. 자식에 맡기면 접근성 이름에 1초마다 바뀌는
                // 시계가 들어가고, 보조기술이 그 줄을 초당 한 번 다시 읽는다.
                aria-label={`${activityText(line)}. 진행 과정 열기`}
                data-testid="composer-working-open"
                className="flex min-w-0 items-baseline gap-2 rounded-sm text-left hover:bg-surface-hover focus-visible:focus-ring"
              >
                {body}
              </button>
            )}
          </li>
        );
      })}
      {overflowCount > 0 && (
        <li className="text-meta text-ink-muted">
          외 <span data-numeric>{overflowCount}</span>명
        </li>
      )}
      {!live && (
        <li className="text-meta text-warn" data-testid="composer-working-stale">
          {TURN_STALE_SENTENCE}
        </li>
      )}
    </ul>
  );
}

/**
 * The line itself. `min-w-0 truncate` without `flex-1`, so the clock sits right
 * after the text it belongs to: a right-aligned number a screen away from its
 * label stops reading as a card and starts reading as a banner (tokens.md §4).
 */
function ActivityText({
  line,
  live,
}: {
  line: AgentActivityLine;
  live: boolean;
}) {
  return (
    <span className="min-w-0 truncate" title={activityText(line)}>
      {/* Offline the name drops to the row's own ink-muted: agent identity is a
          claim about who is acting right now, and nobody is acting right now. */}
      <span className={live ? "text-agent" : undefined}>{line.name.name}</span>
      {line.name.handle && (
        <span className="text-ink-muted">({line.name.handle})</span>
      )}
      {activitySuffix(line)}
    </span>
  );
}

export function Composer({
  workspaceId,
  channelId,
  directory,
  channelLabel,
  recipient,
  dmAgent,
  quote,
  onCancelQuote,
  onSend,
}: {
  /** ADR-0149 - 「작성 중」 발행은 워크스페이스로 스코프된 라우트다. */
  workspaceId: string;
  /** Scopes the agent working signal to this channel; sending goes via onSend. */
  channelId: string;
  directory: Directory;
  channelLabel: string;
  /**
   * 이 label 이 **방 이름인가 사람 이름인가** (#1384). DM 의 label 은 상대의
   * displayName 이므로(`channelLabelParts`) 조사가 갈린다: 방은 에, 사람은
   * 에게. 기본값을 두지 않는 것은 의도다 — 모르는 채로 그린 화면이 「hermes에
   * 메시지 보내기」였고, 조사는 한국어 독자에게 렌더링 디테일이 아니다.
   */
  recipient: RecipientKind;
  /**
   * The agent this channel answers without an @mention
   * (`dmAutoReplyAgent`), or null. Present only to decide one sentence of
   * hint copy: the routing decision is the server's and is never taken here.
   */
  dmAgent: RosterMember | null;
  /**
   * ADR-0148 - 이 글이 가리키는 메시지, 또는 null. 채널 표면이 들고 있는 이유는
   * 인용을 거는 행위가 **타임라인에서** 일어나고 컴포저는 마운트/언마운트되기
   * 때문이다: 여기 두면 스레드를 열었다 닫는 사이에 걸어 둔 인용이 사라진다.
   */
  quote: QuoteDraft | null;
  onCancelQuote: () => void;
  /**
   * useTimeline's send: inserts the local echo, then reconciles by seq.
   * `routing` is ADR-0134 D1's per-request override and is undefined for every
   * send that inherits, which is every send this ticket did not change.
   * `replyToId` is the quote binding and travels the same one write path.
   */
  onSend: (
    body: string,
    options?: {
      routing?: RequestRouting;
      replyToId?: string;
      attachments?: MessageAttachment[];
    }
  ) => Promise<void> | void;
}) {
  // 초안은 이 채널의 것이다. 첫 렌더에서 바로 읽는 이유는 한 프레임의 빈 입력창이
  // 「초안이 없다」로 읽히기 때문이다 — 그 프레임에 사람이 타이핑을 시작하면 복원이
  // 그 글자를 덮어쓴다.
  const [text, setText] = useState(() => readDraft(workspaceId, channelId));
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const mentions = useMentionAutocomplete({
    value: text,
    members: directory.members,
    inputRef,
    onValueChange: (next) => {
      setText(next);
      writeDraft(workspaceId, channelId, next);
    },
  });
  const setMentionCaret = mentions.setCaret;
  const closeMentions = mentions.close;
  const emoji = useComposerEmoji({
    value: text,
    inputRef,
    onValueChange: mentions.replaceValue,
  });
  // Raised by `compositionend`, lowered by the next `keyup` (composerKeys.ts).
  // In WebKit, which is the Tauri shell's engine, `compositionend` is dispatched
  // BEFORE the keydown of the Enter that committed the composition, so by the
  // time we see that keydown `isComposing` is already false. This ref is the
  // only thing standing between a 한글 sentence and being posted half-written.
  const justComposedRef = useRef(false);

  // The clock is mounted for THIS channel's turns, not the workspace's: the
  // store is workspace-wide, and gating on its size alone re-rendered the
  // composer once a second because an agent was busy in a channel nobody here
  // is looking at. The membership test is clock-free, so it can decide whether
  // to start the clock before there is one.
  //
  // `useTickingNow` returns the render's own clock whatever the argument says;
  // the argument only buys the 1Hz re-render. That is what makes the same
  // `nowMs` safe to hand to the staleness filter. Handing it a value the tick
  // captured meant that with the rail down (no tick) the clock froze at the
  // moment the socket died, `isStaleSignal` compared two fixed numbers, and the
  // 90s TTL could never fire on this surface at all. Now every render, from
  // whatever cause, re-reads the wall clock and drops what has gone quiet.
  const { session, connStatus } = useSession();
  // 폰에서는 Enter가 계속 줄바꿈이다 (goal B8 H4). 소프트 키보드에는 Shift+Enter가
  // 없어서, Enter를 전송으로 바꾸면 여러 줄 쓰기를 통째로 없애게 된다. 힌트 줄도
  // 같은 중단점에서 접히므로 화면과 키가 어긋나지 않는다.
  const isMobile = useIsMobileShell();
  const railLive = connStatus === "connected";
  // 레일 상태와 **다른 질문**이다. `railLive`는 웹소켓이 붙어 있는가이고, 전송은
  // REST POST로 나간다 — 레일이 재연결 중이어도 그 POST는 멀쩡히 성공한다. 여기서
  // 필요한 것은 「이 요청이 나갈 수 있는가」이고, 그 답을 가장 잘 아는 것은 브라우저
  // 자신(`navigator.onLine`)과 레일이 재연결을 포기한 종단 절단 둘의 합이다
  // (`useOffline`, 승인 경로가 같은 판단을 한다).
  const offline = useOffline();
  // 키 배치 설명이 아직 필요한가 (감사 M-7). 이 기기에서 ↵로 한 번 보내면 꺼진다.
  const keysHintNeeded = useSendHintNeeded();
  const signals = useAgentWorkingSignals();

  // ── 첨부 (ADR-0151 D2) ────────────────────────────────────────────────────
  //
  // 트레이는 이 컴포넌트 밖에 산다(`draftStore.ts`). 30 MB 를 60% 올려 둔 상태에서
  // 스레드를 열었다 닫는 것이 그 60% 를 버릴 이유가 아니고, 이 컴포넌트는 채널
  // 전환에 언마운트되지 않으므로 상태가 여기 있으면 채널마다 갈라지지도 않는다.
  const trayKey = surfaceKey(workspaceId, channelId);
  const tray = useAttachmentSurface(trayKey);
  const attachTarget = useMemo(
    () => ({ workspaceId, channelId }),
    [workspaceId, channelId]
  );
  const onFiles = (files: File[], batch?: { folders?: number }) =>
    addFiles(trayKey, attachTarget, files, batch);
  // 오프라인에서는 새 파일을 받지 않는다. 전송과 같은 이유이고 더 직접적이다:
  // 업로드는 네트워크 세 왕복이라, 끊긴 채로 시작하면 세 번 다 실패한다.
  const drop = useComposerDropZone(onFiles, !offline);
  const attachBlock = sendBlockReason(tray.drafts);
  // 발치의 문장과 버튼의 툴팁이 **한 곳**에서 난다. 갈라 두면 하나만 고쳐지고,
  // 리뷰 M-1 이 잡은 "없는 버튼을 가리키는 안내"가 툴팁에만 남는다.
  const attachBlockCopy = sendBlockCopy(tray.drafts);

  // ── 「작성 중」 (ADR-0149) ────────────────────────────────────────────────
  //
  // 송신은 레일이 살아 있을 때만 한다. 소켓이 죽어 있으면 발행은 REST로 나가지만
  // 아무도 그것을 구독하고 있지 않으므로, 그 요청은 서버 rate limit만 먹는다.
  const me = session.member.id;
  const typing = useTypingSend(workspaceId, channelId, { enabled: railLive });
  const typists = useTypists({
    channelId,
    myMemberId: me,
    // 에이전트를 화면에서 떨군다. 서버가 403으로 막지만 이것은 화면의 방어다:
    // 그려지는 순간 「사람은 작성 중, 에이전트는 작업 중」이 화면에서 깨진다.
    // 명부에 없는 id도 떨군다 - 이름 없는 「누군가 작성 중」은 정보가 0이다.
    isEligible: (memberId) => memberFor(directory, memberId)?.kind === "human",
  });
  const typingThreshold = useTypingThreshold();
  const nowMs = useTickingNow(hasChannelTurn(signals, channelId) && railLive);
  const turns = agentTurnsInChannel(signals, channelId, nowMs);

  /**
   * 작성 중이 아닐 때 공유 액션 슬롯을 힌트가 차지하는가 (U-8 · #1749).
   *
   * 폰에서 키 힌트는 원래 보이지 않는다. 빈 슬롯과 `TypingLine`은 모두 이미 높이가
   * 정해진 액션 행 안에서 바뀌므로 사람의 타이핑이 시작돼도 컴포저가 움직이지 않는다.
   * DM 힌트는 폭과 무관한 방의 성질이므로 기존처럼 폰에도 남는다.
   */
  const metaMode = composerMetaMode({
    typistCount: typists.length,
    hasDmHint: dmAgent !== null,
    keysHintNeeded,
    isMobile,
  });
  const persistentPhoneDmHint = keepPhoneDmHint({
    hasDmHint: dmAgent !== null,
    isMobile,
  });
  const showComposerHint = persistentPhoneDmHint || metaMode === "hint";

  // 실제로 차지한 높이를 재서 자란다 (진단 H-10 / 감사 M-7). 앞 판의 `\n` 세기는
  // **접힌 줄을 못 봤다** — 한국어 메시지는 줄바꿈 없이 한 문단으로 오고 창 폭에서
  // 세 줄로 접히는 쪽이 흔하다. 같은 함수를 스레드 컴포저와 수정 입력창이 이미
  // 쓰고 있었고, 여기만 자기 산수를 갖고 있었다.
  useAutoGrow(inputRef, text, { minRows: MIN_ROWS, maxRows: MAX_ROWS });

  // 사람이 친 글은 상자가 자라서 받고(위), 빈 상자의 문장은 **줄어들어서** 받는다
  // (#1422). 상자가 좁으면 코어가 이름 붙인 절을 통째로 버린다 — 어느 절을 언제
  // 버리는지는 코어의 규칙이고, 여기 있는 것은 이 상자에서 무엇이 드는지를 답할
  // 수 있는 자뿐이다(`placeholderFit.ts`).
  const placeholder = useFittedComposerPlaceholder(
    inputRef,
    channelLabel,
    recipient
  );

  // 1회 오버라이드는 지금 이 글이 부르는 에이전트에 붙는다(ADR-0134 D1). 대상은
  // 확정된 멘션이 아니라 **텍스트에 남아 있는 멘션**에서 다시 계산한다: 사람이
  // 고른 뒤 그 핸들을 지웠다면 붙일 요청 자체가 없어졌기 때문이다.
  const routingTarget = useMemo(
    () => mentionRoutingTarget(text, directory.members),
    [text, directory.members]
  );
  const routing = useMentionRouting(routingTarget);

  // 줄이 한 번 생기면 이 글을 다 쓸 때까지 자리를 비워 둔다.
  //
  // 멘션을 확정했다 지웠다 하는 동안 줄이 붙었다 떨어지면 입력창이 캐럿 아래에서
  // 세로로 튄다(R1 M11). 한 번의 작성에서 이동은 한 번이면 충분하고, 그 한 번은
  // 사람이 에이전트를 부른 순간이다. 비어 있는 자리는 구분선 하나이고 아무것도
  // 주장하지 않는다. 글을 비우거나 보내면 자리도 함께 사라진다.
  const [rowReserved, setRowReserved] = useState(false);
  const hasTarget = routingTarget.kind !== "none";
  useEffect(() => {
    if (hasTarget) setRowReserved(true);
    else if (text.trim() === "") setRowReserved(false);
  }, [hasTarget, text]);

  // ── 초안 (U4-f · 진단 H-10) ────────────────────────────────────────────────
  //
  // 이 컴포넌트는 채널을 옮겨도 **언마운트되지 않는다**(ChatShell이 key를 걸지
  // 않는다). 그래서 「떠나기」와 「들어오기」를 이 효과 하나가 진다: 정리 함수가
  // 떠나는 채널에 지금 글을 남기고, 본문이 들어오는 채널의 글을 꺼낸다. 두 일을
  // 한 효과에 두는 이유는 순서가 load-bearing이기 때문이다 — 갈라 두면 복원된
  // 글이 떠나는 채널의 열쇠로 저장되는 순서가 만들어질 수 있다.
  //
  // 의존성에 `text`가 없는 것도 의도다. 넣으면 이 효과가 타이핑마다 돌면서 매
  // 글자에 채널을 새로 여는 셈이 된다. 지금 글은 `textRef`가 나르고, 저장은
  // 아래 `onChange`가 매 입력마다 이미 한다 — 여기 정리 함수는 **마지막 한 번**을
  // 보장하는 자리다(마지막 입력과 전환 사이에 아무 일도 없어야 한다는 가정을
  // 두지 않는다).
  //
  // `pagehide`가 함께 있는 이유: 창을 닫거나 탭을 치우는 손은 정리 함수를 부르지
  // 않는다. `beforeunload`가 아닌 이유는 모바일 사파리가 bfcache로 들어갈 때
  // 그것을 부르지 않기 때문이고, 그 차이만큼 글이 사라진다.
  const textRef = useRef(text);
  textRef.current = text;
  useEffect(() => {
    const restored = readDraft(workspaceId, channelId);
    setText(restored);
    setMentionCaret(restored.length);
    closeMentions();
    const save = () => writeDraft(workspaceId, channelId, textRef.current);
    window.addEventListener("pagehide", save);
    const onSeed = (event: Event) => {
      const detail = (event as CustomEvent<{
        workspaceId: string;
        channelId: string;
        text: string;
      }>).detail;
      if (!detail) return;
      if (detail.workspaceId !== workspaceId || detail.channelId !== channelId) {
        return;
      }
      if (textRef.current.trim() !== "") return;
      setText(detail.text);
      setMentionCaret(detail.text.length);
      closeMentions();
    };
    window.addEventListener(COMPOSER_SEED_EVENT, onSeed);
    return () => {
      window.removeEventListener("pagehide", save);
      window.removeEventListener(COMPOSER_SEED_EVENT, onSeed);
      save();
    };
  }, [workspaceId, channelId, setMentionCaret, closeMentions]);

  /**
   * 지금 이 전송이 나갈 수 있는가.
   *
   * 본문이 비어도 첨부가 있으면 보낼 수 있다(파일만 보내는 메시지). 반대로,
   * 올라가는 중이거나 실패한 첨부가 하나라도 있으면 본문이 있어도 못 보낸다 —
   * 서버가 첨부 한 건의 거절에 메시지째 롤백하므로, 그 롤백을 만나기 전에
   * 화면이 먼저 말하는 쪽이 낫다.
   */
  const hasReadyAttachments =
    tray.drafts.length > 0 && attachBlock === null;
  const canSend =
    !offline &&
    attachBlock === null &&
    (text.trim().length > 0 || hasReadyAttachments);

  function submit(body: string) {
    // 오버라이드는 이 전송분과 함께 떠난다. 값을 먼저 읽어 두고 상태를 비우는
    // 순서인 이유는 "1회"라는 라벨이 지켜져야 하기 때문이다: 보낸 뒤에도 줄이
    // 켜져 있으면 다음 메시지가 고른 적 없는 강도로 나간다.
    const payload = routingPayload(routing.draft);
    // 인용도 같은 성질이다: 이 전송분과 함께 떠난다. 한 번 인용했다고 다음 글도
    // 같은 메시지를 가리키면, 사람이 고르지 않은 주장을 대화에 넣는 것이다.
    const replyToId = quote?.targetId;
    // Clear first, send second. The echo row carries the message from here on,
    // including its failure state and its retry, so there is nothing left for
    // the composer to hold on to.
    setText("");
    mentions.close();
    routing.reset();
    onCancelQuote();
    // 화면에서 사라진 글은 저장소에서도 사라진다. 여기서 지우지 않으면 이 채널을
    // 다시 열 때 방금 보낸 문장이 입력창에 복원돼 두 번 보내진다.
    clearDraft(workspaceId, channelId);
    // 첨부도 이 전송분과 함께 떠난다. 꺼내는 것과 트레이를 비우는 것이 한
    // 함수인 이유는 그 사이에 렌더가 끼면 이미 보낸 파일이 한 프레임 동안 트레이에
    // 남고, 그 프레임에 전송을 한 번 더 누를 수 있기 때문이다.
    const sent = takeSent(trayKey);
    void onSend(body, {
      ...(payload ? { routing: payload } : {}),
      ...(replyToId === undefined ? {} : { replyToId }),
      ...(sent.attachments.length === 0
        ? {}
        : { attachments: sent.attachments }),
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!canSend) return;
    submit(text.trim());
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // Self-healing: only Enter and Tab can be the key that commits a
    // composition, so any other key proves we are past one. Without this a
    // composition ended by something other than a keystroke (clicking send
    // mid-syllable) could leave the guard raised, and the next deliberate Enter
    // would be swallowed. `justComposed` is not read for these keys, so
    // clearing it before the decision changes nothing about this keystroke.
    if (event.key !== "Enter" && event.key !== "Tab") {
      justComposedRef.current = false;
    }
    const intent = composerKeyIntent(
      {
        key: event.key,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        composing: isComposingEvent(event.nativeEvent),
      },
      {
        mentionsOpen: mentions.visible,
        justComposed: justComposedRef.current,
        enterSends: !isMobile,
        quoteOpen: quote !== null,
      }
    );

    if (mentions.handleIntent(intent)) {
      event.preventDefault();
      return;
    }

    switch (intent) {
      case "send": {
        event.preventDefault();
        // ↵가 무엇인지 이 사람은 이제 안다 (감사 M-7). 버튼으로 보낸 것은 세지
        // 않는다 — 그 사람은 키가 어디 있는지 아직 모르고, 힌트 줄은 정확히 그
        // 사람을 위한 것이다. 오프라인이라 보내지 못한 누름도 세지 않는다: 배운
        // 것은 「이 키가 전송이다」인데 그 누름은 그것을 보여 주지 못했다.
        if (canSend) {
          rememberSendLearned();
          submit(text.trim());
        }
        return;
      }
      case "quote-cancel":
        // Esc는 「지금 열려 있는 것을 닫는다」이고, 멘션 목록이 닫혀 있을 때 이
        // 컴포저에 열려 있는 것은 인용이다. 취소 버튼과 같은 일을 하는 두 번째
        // 길이며, 키보드에만 있는 쪽이다 (ADR-0148 미결 3).
        event.preventDefault();
        onCancelQuote();
        return;
      // "newline" and "pass" are both the textarea's own behaviour, and that is
      // the point: an IME keystroke is never intercepted, not even to be
      // re-dispatched.
      case "newline":
      case "pass":
        return;
    }
  }

  return (
    // `safe-area-bottom` (goal B6): 폰에서 컴포저는 셸의 마지막 줄이고, 그 아래는
    // iOS 홈 인디케이터다. 안전 영역만큼 물러나지 않으면 전송 버튼의 아랫부분이
    // 시스템 제스처 영역에 들어가 눌리지 않는다.
    <div
      // 드롭은 컴포저 **전체**가 받는다. 텍스트에어리어만 받으면 트레이나 힌트 줄
      // 위에 놓은 파일이 브라우저의 기본 동작으로 넘어가 새 탭에서 열린다.
      onDragEnter={drop.onDragEnter}
      onDragOver={drop.onDragOver}
      onDragLeave={drop.onDragLeave}
      onDrop={drop.onDrop}
      data-dragging={drop.dragging ? "" : undefined}
      className={cn(
        "safe-area-bottom border-t border-line",
        // 강조는 배경 한 겹이다. 점선 테두리와 가운데 정렬된 큼직한 안내는
        // 랜딩 페이지의 문법이고, 이 자리에서 필요한 것은 "여기 놓으면 된다"를
        // 말하는 최소한이다.
        drop.dragging && "bg-accent-soft"
      )}
      data-testid="composer"
    >
      {/* 첨부 트레이 (ADR-0151 D2). 인용 칩보다 **위**다: 순서는 여전히
          맥락 → 처리 → 입력이고, 파일은 이 메시지가 무엇을 나르는가라서 인용보다
          한 겹 바깥이다. 첨부가 없으면 서지 않는다. */}
      <AttachmentTray
        drafts={tray.drafts}
        rejected={tray.rejected}
        folders={tray.folders}
        onRemove={(localId) => dropDraft(trayKey, localId)}
        onRetry={(localId) => retryDraft(trayKey, attachTarget, localId)}
        onClear={() => clearSurface(trayKey)}
        onAcknowledgeNotices={() => acknowledgeNotices(trayKey)}
      />
      {/* 인용 칩 (ADR-0148). 라우팅 줄보다 **위**에 온다: 라우팅은 "이 글이 어떻게
          처리되는가"고 인용은 "이 글이 무엇에 대한 것인가"라서, 읽는 순서가
          맥락 -> 처리 -> 입력이다. */}
      {quote && (
        <QuoteChip
          block={quote.block}
          directory={directory}
          onCancel={onCancelQuote}
        />
      )}
      {/* 입력창 바로 위: 이번 메시지에 무엇이 적용되는지가 글을 쓰는 자리에서
          보여야 한다. Cursor가 모델 피커를 입력창 하단 바에 둔 이유와 같고
          (레퍼런스 §2), 상속 상태에서도 사라지지 않는 이유는 "바꾸지 않으면
          무엇이 되는가"가 이 줄의 본래 내용이기 때문이다. */}
      {hasTarget ? (
        <MentionRoutingBar
          channelId={channelId}
          target={routingTarget}
          draft={routing.draft}
          onDraftChange={routing.setDraft}
        />
      ) : (
        rowReserved && (
          <div
            className={MENTION_ROUTING_ROW_CLASS}
            aria-hidden="true"
            data-testid="composer-routing-reserved"
          />
        )
      )}

      {/* 상태 행은 그릇 위에 선다. 힌트·작성 중 교대 슬롯은 액션 행 안으로 내려가
          별도 26px 예약 띠를 만들지 않는다. 마지막 컨트롤 뒤에는 p-3+safe-area만 둔다. */}
      {offline && (
        <p
          role="status"
          className="px-6 pb-2 text-meta text-warn"
          data-testid="composer-offline"
        >
          {COMPOSER_OFFLINE_COPY}
        </p>
      )}

      {persistentPhoneDmHint && (
        <ComposerHint
          directory={directory}
          dmAgent={dmAgent}
          keysHintNeeded={keysHintNeeded}
          sharedRow={false}
        />
      )}
      <AgentActivityBar
        turns={turns}
        directory={directory}
        nowMs={nowMs}
        live={railLive}
      />

      <form onSubmit={onSubmit} className="relative p-3">
        <MentionAutocompleteList
          id="composer-mention-list"
          candidates={mentions.candidates}
          highlight={mentions.highlight}
          onChoose={mentions.choose}
          testId="mention-list"
          optionTestId="mention-option"
        />
        <div
          className="rounded-md border border-line-strong bg-surface-raised focus-within:focus-ring"
          data-testid="composer-frame"
          onClick={(event) => {
            // 버튼과 그 자식(svg/path)은 자기 액션을 가진다. 나머지 그릇 면적은 한
            // 입력 컨트롤의 일부이므로 액션 행의 빈 폭을 눌러도 캐럿을 돌려준다.
            if (
              event.target instanceof Element &&
              event.target.closest("button")
            ) {
              return;
            }
            inputRef.current?.focus();
          }}
        >
          <label className="sr-only" htmlFor="composer-input">
            {composerFieldLabel(channelLabel, recipient)}
          </label>
          <textarea
            id="composer-input"
            ref={inputRef}
            value={text}
            // `rows`는 최소 높이만 정한다. 실제 높이는 `useAutoGrow`가 내용에서 재고,
            // 그래서 접힌 줄까지 함께 자란다.
            rows={MIN_ROWS}
            onChange={(event) => {
              const next = event.target.value;
              mentions.onTextChange(next, event.target.selectionStart ?? 0);
              // 초안은 **입력마다** 남는다. 디바운스를 걸지 않는 이유는 이 저장이
              // 문자열 하나를 동기로 쓰는 일이고(같은 저장소에 세션 기록이 이미 이
              // 방식으로 산다), 디바운스가 사는 창이 정확히 「마지막 몇 글자를
              // 잃는 창」이기 때문이다.
              // 「작성 중」은 **키에서만** 나간다 (ADR-0149). 타이머가 없으므로 입력이
              // 멈추면 송신도 멈추고, 흐림·탭 전환·언마운트에 끌 것이 없다. 소멸은
              // TTL이 하고 「정지」 신호는 계약에 없다.
              typing.onInput();
            }}
            onSelect={(event) =>
              mentions.setCaret(
                (event.target as HTMLTextAreaElement).selectionStart ?? 0
              )
            }
            onKeyDown={onKeyDown}
            // 스크린샷을 ⌘V 로 넣는 것은 이 도구를 쓰는 사람이 하루에 몇 번씩 하는
            // 일이다. 글이 함께 온 붙여넣기는 가로채지 않는다(`useComposerDropZone`).
            onPaste={drop.onPaste}
            // The composition window, in three lines. `compositionstart` closes
            // the guard (a new session cannot be a stale commit), `compositionend`
            // opens it, and any key release closes it again, which bounds the
            // guard to the single keystroke that can sit between those two events.
            onCompositionStart={() => {
              justComposedRef.current = false;
            }}
            onCompositionEnd={() => {
              justComposedRef.current = true;
            }}
            onKeyUp={() => {
              justComposedRef.current = false;
            }}
            // A composition abandoned by clicking away leaves the guard raised;
            // it must not still be raised when the caret comes back.
            onBlur={() => {
              justComposedRef.current = false;
            }}
            // 빈 상자는 **어디로 가는지**와 **@가 무엇인지**를 함께 말한다
            // (#1384). 문장과 그 문장을 고른 이유(폭 산술 포함)는 코어가 든다 —
            // 이 자리는 렌더만 한다. 좁은 상자에서 **무엇이 사라지는지**도 코어의
            // 규칙이다(#1422): 절을 통째로 버리고 절 안에서는 자르지 않는다.
            // `composer-placeholder` 의 `1lh`(#1418)는 그 뒤에 남는 마지막
            // 방어선이다 — 머리 절 하나도 안 드는 폭에서 글리프 반노출을 막는다.
            placeholder={placeholder}
            aria-autocomplete="list"
            aria-expanded={mentions.visible}
            aria-controls={mentions.visible ? "composer-mention-list" : undefined}
            aria-activedescendant={
              mentions.visible
                ? `composer-mention-list-option-${mentions.highlight}`
                : undefined
            }
            aria-describedby={showComposerHint ? "composer-hint" : undefined}
            data-testid="composer-input"
            // 포커스 표시는 한 컨트롤인 바깥 그릇이 진다. 안쪽 textarea의 UA
            // outline까지 남기면 그릇 안에 두 번째 상자가 생긴다.
            className="tap-target composer-placeholder block w-full min-w-0 resize-none rounded-sm bg-transparent px-3 py-2 text-body leading-relaxed outline-none placeholder:text-ink-muted focus-visible:outline-none"
          />
          <div
            className="flex items-center justify-between gap-2 pb-2 pl-1 pr-2"
            data-testid="composer-actions"
          >
            <div className="flex items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="tap-target shrink-0"
                aria-label="멘션 넣기"
                title="멘션 넣기"
                data-testid="composer-mention-trigger"
                onClick={mentions.insertTrigger}
              >
                <AtSign aria-hidden="true" />
              </Button>
              {/* 클립은 액션 행의 왼쪽이다. 넣는 것은 앞, 보내는 것은 뒤라는
                  기존 순서를 한 그릇 안에서도 그대로 지킨다. */}
              <AttachButton onPick={onFiles} disabled={offline} />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="tap-target shrink-0"
                aria-label="이모지 넣기"
                title="이모지 넣기"
                data-testid="composer-emoji-trigger"
                onClick={(event) => {
                  mentions.close();
                  emoji.openPicker(event.currentTarget);
                }}
              >
                <Smile aria-hidden="true" />
              </Button>
            </div>
            {metaMode === "hint" ? (
              <ComposerHint
                directory={directory}
                dmAgent={dmAgent}
                keysHintNeeded={keysHintNeeded}
                sharedRow
              />
            ) : (
              <TypingLine
                memberIds={metaMode === "typing" ? typists : []}
                threshold={typingThreshold}
                directory={directory}
              />
            )}
            <Button
              type="submit"
              size="icon"
              className="tap-target shrink-0"
              // 오프라인에서는 보낼 수 없다 (진단 H-10). 누르면 실패 행 하나를 만들고
              // 끝나므로, 막고 **왜**를 위 한 줄이 말한다. 입력창은 잠그지 않는다:
              // 연결이 끊겼다고 글을 못 쓸 이유가 없고, 그동안 쓴 것은 초안이 지킨다.
              disabled={!canSend}
              aria-label="메시지 보내기"
              title={
                offline
                  ? COMPOSER_OFFLINE_COPY
                  : (attachBlockCopy ??
                    (isMobile ? "메시지 보내기" : "메시지 보내기 (Enter)"))
              }
              data-testid="composer-send"
            >
              <SendHorizontal />
            </Button>
          </div>
        </div>
      </form>

      <EmojiPickerDialog
        open={emoji.open}
        onOpenChange={emoji.setOpen}
        onPick={emoji.pick}
        opener={emoji.opener}
        anchor={emoji.anchor}
        purpose="insert"
        testId="composer-emoji-picker"
      />
    </div>
  );
}
