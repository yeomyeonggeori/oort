import { useMemo, useState } from "react";
import { threadRollup, type Message, type RosterMember } from "@/lib/api";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { cn } from "@/design/lib/cn";
import { AgentCard } from "./AgentCard";
import { ArtifactCard } from "./ArtifactCard";
import { CascadeNotice } from "./CascadeNotice";
import { turnRecordRunId } from "./cascadeModel";
import { rowPresentation } from "./rowModel";

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

export function MessageRow({
  message,
  startsGroup,
  directory,
  onOpenThread,
  onResend,
}: {
  message: Message;
  startsGroup: boolean;
  directory: Directory;
  onOpenThread?: (message: Message) => void;
  /** Re-send a row the server marked `failed` (the composer's send path). */
  onResend?: (message: Message) => Promise<void> | void;
}) {
  const [resending, setResending] = useState(false);
  const author = memberFor(directory, message.authorMemberId);
  const isAgent = author?.kind === "agent";
  const name = author?.displayName ?? message.authorMemberId.slice(0, 8);
  const owner = isAgent ? memberFor(directory, author?.ownerHumanId) : null;
  const deleted = message.state === "deleted";
  const failed = message.state === "failed";
  const rollup = threadRollup(message);
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

  return (
    <article
      data-testid="timeline-message"
      data-seq={message.seq}
      data-author-kind={author?.kind ?? "unknown"}
      className={cn(
        "flex gap-2 px-4 hover:bg-surface-hover",
        startsGroup ? "pt-3 pb-1" : "py-1"
      )}
    >
      <div className="w-6 shrink-0">
        {startsGroup && <Avatar member={author} name={name} />}
      </div>
      <div className="min-w-0 flex-1">
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
        {keepsBody && (
          <p
            className={cn(
              "whitespace-pre-wrap break-words text-body leading-relaxed",
              deleted && "text-ink-muted"
            )}
          >
            {deleted ? "삭제된 메시지" : message.body}
          </p>
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
        {message.state === "edited" && (
          <span className="text-meta text-ink-muted">수정됨</span>
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
        {rollup && (
          <button
            type="button"
            onClick={() => onOpenThread?.(message)}
            data-testid="thread-anchor"
            className="mt-1 rounded-sm text-meta text-ink-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            답글 {rollup.replyCount}개 · 마지막{" "}
            {relativeLabel(rollup.lastReplyAtMs, Date.now())}
          </button>
        )}
      </div>
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
