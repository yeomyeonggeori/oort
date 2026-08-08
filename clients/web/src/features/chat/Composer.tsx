import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { SendHorizontal } from "lucide-react";
import type { RequestRouting, RosterMember } from "@momo/core/lib/api";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";
import { useSession } from "@/app/session";
import { useIsMobileShell } from "@/app/shellNav";
import type { Directory } from "@/features/workspace/useWorkspace";
import { composerKeyIntent, isComposingEvent } from "@momo/core/features/chat/composerKeys";
import { COMPOSER_OFFLINE_COPY } from "@momo/core/features/chat/composerCopy";
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
import { useTypingSend } from "@/features/chat/useTyping";
import { useTypingThreshold, useTypists } from "@/features/chat/typingStore";
import { clearDraft, readDraft, writeDraft } from "@/features/chat/draftStore";
import { rememberSendLearned, useSendHintNeeded } from "@/features/chat/sendHint";
import { useAutoGrow } from "@/features/timeline/useAutoGrow";
import { useOffline } from "@/features/common/useOffline";

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
const MENTION_LIMIT = 6;

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

interface MentionQuery {
  /** Index of the '@' that opened the query. */
  start: number;
  text: string;
}

/** The active @mention token at the caret, or null when there is none. */
export function mentionQueryAt(value: string, caret: number): MentionQuery | null {
  const upto = value.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at < 0) return null;
  if (at > 0 && !/\s/.test(upto[at - 1])) return null; // mid-word @ is not a mention
  const text = upto.slice(at + 1);
  if (/\s/.test(text)) return null;
  return { start: at, text };
}

export function matchMembers(
  members: RosterMember[],
  query: string,
  limit = MENTION_LIMIT
): RosterMember[] {
  const needle = query.trim().toLowerCase();
  const active = members.filter((m) => m.status === "active");
  const matched = needle
    ? active.filter(
        (m) =>
          m.handle.toLowerCase().includes(needle) ||
          m.displayName.toLowerCase().includes(needle)
      )
    : active;
  return matched.slice(0, limit);
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
      // `px-6`은 위 두 줄(힌트·작성 중)과 같은 값이다. 이 줄은 원래 `px-4`였고 그때는
      // 「두 줄 사이의 우연한 4px」이었는데, 「작성 중」이 그 사이에 끼면서 스택이
      // 왼쪽 모서리를 두 개 갖게 됐다 — 입력창 아래 12px 회색 3행이 서로 다른
      // 세로선에 서는 모양이다 (design-review PR 1059 H-3). 정답은 이 파일이 힌트
      // 줄에 이미 적어 뒀다: 폼의 `p-3` + 텍스트에어리어의 `px-3` = 24px.
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
                className="flex min-w-0 items-baseline gap-2 rounded-sm text-left hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
    options?: { routing?: RequestRouting; replyToId?: string }
  ) => Promise<void> | void;
}) {
  // 초안은 이 채널의 것이다. 첫 렌더에서 바로 읽는 이유는 한 프레임의 빈 입력창이
  // 「초안이 없다」로 읽히기 때문이다 — 그 프레임에 사람이 타이핑을 시작하면 복원이
  // 그 글자를 덮어쓴다.
  const [text, setText] = useState(() => readDraft(workspaceId, channelId));
  const [caret, setCaret] = useState(0);
  const [highlight, setHighlight] = useState(0);
  const [mentionOpen, setMentionOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
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

  const query = mentionOpen ? mentionQueryAt(text, caret) : null;
  const candidates = useMemo(
    () => (query ? matchMembers(directory.members, query.text) : []),
    [query, directory.members]
  );
  const showMentions = candidates.length > 0;
  /** 힌트 줄에 남은 조각이 하나라도 있는가. 없으면 그 줄은 서지 않는다. */
  const hasHint = dmAgent !== null || keysHintNeeded;

  // 실제로 차지한 높이를 재서 자란다 (진단 H-10 / 감사 M-7). 앞 판의 `\n` 세기는
  // **접힌 줄을 못 봤다** — 한국어 메시지는 줄바꿈 없이 한 문단으로 오고 창 폭에서
  // 세 줄로 접히는 쪽이 흔하다. 같은 함수를 스레드 컴포저와 수정 입력창이 이미
  // 쓰고 있었고, 여기만 자기 산수를 갖고 있었다.
  useAutoGrow(inputRef, text, { minRows: MIN_ROWS, maxRows: MAX_ROWS });

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
    setCaret(restored.length);
    setMentionOpen(false);
    const save = () => writeDraft(workspaceId, channelId, textRef.current);
    window.addEventListener("pagehide", save);
    return () => {
      window.removeEventListener("pagehide", save);
      save();
    };
  }, [workspaceId, channelId]);

  function applyMention(member: RosterMember) {
    if (!query) return;
    const next = `${text.slice(0, query.start)}@${member.handle} ${text.slice(caret)}`;
    setText(next);
    setMentionOpen(false);
    const position = query.start + member.handle.length + 2;
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  }

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
    setMentionOpen(false);
    routing.reset();
    onCancelQuote();
    // 화면에서 사라진 글은 저장소에서도 사라진다. 여기서 지우지 않으면 이 채널을
    // 다시 열 때 방금 보낸 문장이 입력창에 복원돼 두 번 보내진다.
    clearDraft(workspaceId, channelId);
    void onSend(body, {
      ...(payload ? { routing: payload } : {}),
      ...(replyToId === undefined ? {} : { replyToId }),
    });
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    const body = text.trim();
    if (!body || offline) return;
    submit(body);
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
        mentionsOpen: showMentions,
        justComposed: justComposedRef.current,
        enterSends: !isMobile,
        quoteOpen: quote !== null,
      }
    );

    switch (intent) {
      case "send": {
        event.preventDefault();
        // ↵가 무엇인지 이 사람은 이제 안다 (감사 M-7). 버튼으로 보낸 것은 세지
        // 않는다 — 그 사람은 키가 어디 있는지 아직 모르고, 힌트 줄은 정확히 그
        // 사람을 위한 것이다. 오프라인이라 보내지 못한 누름도 세지 않는다: 배운
        // 것은 「이 키가 전송이다」인데 그 누름은 그것을 보여 주지 못했다.
        const body = text.trim();
        if (body && !offline) {
          rememberSendLearned();
          submit(body);
        }
        return;
      }
      case "mention-accept":
        event.preventDefault();
        applyMention(candidates[Math.min(highlight, candidates.length - 1)]);
        return;
      case "mention-next":
        event.preventDefault();
        setHighlight((h) => (h + 1) % candidates.length);
        return;
      case "mention-prev":
        event.preventDefault();
        setHighlight((h) => (h - 1 + candidates.length) % candidates.length);
        return;
      case "mention-close":
        event.preventDefault();
        setMentionOpen(false);
        return;
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
    <div className="safe-area-bottom border-t border-line">
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

      <form onSubmit={onSubmit} className="relative flex items-end gap-2 p-3">
        {showMentions && (
          <ul
            role="listbox"
            aria-label="멤버 언급"
            data-testid="mention-list"
            className="absolute bottom-full left-3 mb-2 w-pane-sm overflow-hidden rounded-md border border-line bg-surface-raised p-1 shadow-lg"
          >
            {candidates.map((member, index) => (
              <li key={member.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={index === highlight}
                  data-testid="mention-option"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    applyMention(member);
                  }}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left text-body",
                    index === highlight
                      ? "bg-accent-soft text-ink"
                      : "text-ink"
                  )}
                >
                  <span className="truncate">@{member.handle}</span>
                  <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
                    {member.displayName}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        <label className="sr-only" htmlFor="composer-input">
          {channelLabel}에 보낼 메시지
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
            setText(next);
            setCaret(event.target.selectionStart ?? 0);
            setMentionOpen(true);
            setHighlight(0);
            // 초안은 **입력마다** 남는다. 디바운스를 걸지 않는 이유는 이 저장이
            // 문자열 하나를 동기로 쓰는 일이고(같은 저장소에 세션 기록이 이미 이
            // 방식으로 산다), 디바운스가 사는 창이 정확히 「마지막 몇 글자를
            // 잃는 창」이기 때문이다.
            writeDraft(workspaceId, channelId, next);
            // 「작성 중」은 **키에서만** 나간다 (ADR-0149). 타이머가 없으므로 입력이
            // 멈추면 송신도 멈추고, 흐림·탭 전환·언마운트에 끌 것이 없다. 소멸은
            // TTL이 하고 「정지」 신호는 계약에 없다.
            typing.onInput();
          }}
          onSelect={(event) =>
            setCaret((event.target as HTMLTextAreaElement).selectionStart ?? 0)
          }
          onKeyDown={onKeyDown}
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
          placeholder={`${channelLabel}에 메시지 보내기`}
          aria-describedby={hasHint ? "composer-hint" : undefined}
          data-testid="composer-input"
          className="tap-target min-w-0 flex-1 resize-none rounded-md border border-line-strong bg-transparent px-3 py-2 text-body leading-relaxed placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        />
        <Button
          type="submit"
          size="icon"
          className="tap-target"
          // 오프라인에서는 보낼 수 없다 (진단 H-10). 누르면 실패 행 하나를 만들고
          // 끝나므로, 막고 **왜**를 아래 한 줄이 말한다. 입력창은 잠그지 않는다:
          // 연결이 끊겼다고 글을 못 쓸 이유가 없고, 그동안 쓴 것은 초안이 지킨다.
          disabled={text.trim().length === 0 || offline}
          aria-label="메시지 보내기"
          title={
            offline
              ? COMPOSER_OFFLINE_COPY
              : isMobile
                ? "메시지 보내기"
                : "메시지 보내기 (Enter)"
          }
          data-testid="composer-send"
        >
          <SendHorizontal />
        </Button>
      </form>

      {/* 왜 못 보내는지는 버튼 옆이 아니라 버튼 **아래** 한 줄이다: 비활성 버튼은
          자기가 왜 비활성인지 말하지 못하고, `title`은 포인터가 있어야 열린다.
          토스트가 아닌 이유는 이 앱의 규율이다 — 문제가 있는 자리에 문장이 산다.
          `role="status"`인 것은 이것이 사고가 아니라 상태라서다. */}
      {offline && (
        <p
          role="status"
          className="px-6 pb-2 text-meta text-warn"
          data-testid="composer-offline"
        >
          {COMPOSER_OFFLINE_COPY}
        </p>
      )}

      {/* Enter가 보내기가 된 이상, 줄바꿈이 어디로 갔는지 이 자리에서 말해야
          한다. 한 줄이고, 입력창 바로 아래이며, 조용하다: 이 힌트는 알림이
          아니라 키 배치의 설명이다. 폰에는 화면 키보드의 줄바꿈 키가 따로 있고
          ⌘도 없으므로 좁은 폭에서는 접는다.

          goal B13(QA H7): 에이전트와의 1:1 DM에서는 멘션 없이도 답한다는 사실이
          한 조각 더 붙는다. 새 줄이 아니라 같은 줄인 이유 — 둘 다 "이 입력창이
          어떻게 동작하는가"이고, 설명이 두 줄이 되는 순간 안내가 아니라 배너다.
          이쪽은 wide-only가 아니다: ⌘ 없는 기기에도 이 규칙은 그대로 있고,
          폰에서 멘션을 타이핑하는 수고는 오히려 더 크다.

          감사 M-7: 키 배치 설명은 **배운 사람에게는 사라진다**(`sendHint.ts`).
          DM 문장은 그 규칙 밖이다 — 그것은 키가 아니라 **이 방의 성질**이라 방마다
          다르고, 한 번 배워서 끝나지 않는다. 그래서 이 줄은 조각 둘이 각자 사라질
          수 있고, 둘 다 없으면 <p> 자체가 서지 않는다: 빈 문단의 pb-2는 8px짜리
          죽은 공간이고, `aria-describedby`가 가리키는 빈 요소는 보조기술에 아무
          말도 하지 않는 이름이다. */}
      {hasHint && (
        <p
          id="composer-hint"
          // px-6 = 폼의 p-3(12px) + 텍스트에어리어의 px-3(12px). 힌트의 첫 글자가
          // 플레이스홀더의 첫 글자와 같은 세로선에 선다. px-4는 어느 쪽 모서리와도
          // 맞지 않아 4px 어긋난 줄로 보였다.
          //
          // DM 문장이 없을 때는 줄 전체가 wide-only다(기존 동작 그대로). 안쪽
          // span에만 걸면 좁은 폭에서 빈 <p>의 pb-2가 남아 8px 죽은 공간이 된다.
          className={cn(
            "px-6 pb-2 text-meta text-ink-muted",
            !dmAgent && "wide-only"
          )}
          data-testid="composer-hint"
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
              {dmAgent ? " · " : ""}Enter로 보내기, Shift+Enter로 줄바꿈
            </span>
          )}
        </p>
      )}

      {/* 사람이 위, 에이전트가 아래. 같은 구역에 나란히 두는 것이 「작성 중」과
          「작업 중」을 사람이 배우는 유일한 자리다 (TypingLine의 머리 주석). */}
      <TypingLine
        memberIds={typists}
        threshold={typingThreshold}
        directory={directory}
      />

      <AgentActivityBar
        turns={turns}
        directory={directory}
        nowMs={nowMs}
        live={railLive}
      />
    </div>
  );
}
