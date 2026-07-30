import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelRightClose, PanelRightOpen, X } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  resumeWorkSession,
  uuidEq,
  type Channel,
  type WorkHost,
  type WorkSession,
} from "@/lib/api";
import { useSession } from "@/app/session";
import {
  channelLabel,
  useChannels,
  useDirectory,
  type Directory,
} from "@/features/workspace/useWorkspace";
import {
  elapsedLabel,
  useTickingNow,
} from "@/features/agents/agentWorkingSignal";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  useSessionEvents,
  useWorkHosts,
  useWorkSessionRail,
  useWorkSessions,
} from "./useWorkSessions";
import {
  emptyStepsDetail,
  eventsForSession,
  foldSessionEvents,
  canReattachWorkSession,
  isSlowStep,
  lastLine,
  peekRows,
  ROW_STATE_LABEL,
  scopeSessions,
  sortSessions,
  workHostTrust,
  workHostName,
  workHostOnline,
  workSessionContinuityStatus,
  workSessionResumeTargets,
  type WorkScope,
  type WorkSessionEvent,
} from "./workSessionModel";
import {
  clockLabel,
  freshnessLabel,
  ROW_STATE_CLASS,
  SESSION_STATUS_CLASS,
  silenceLabel,
} from "./workSessionFormat";
import { HostPicker } from "./HostPicker";
import { WorkSessionDetail } from "./WorkSessionDetail";

// =============================================================================
// 작업 세션 패널 (AX-3 / MOMO-618). The web sibling of the mac Work Console
// drawer, in the shape the reference survey settled on: a right-hand secondary
// pane inside the channel surface, with the SCOPE LABEL ALWAYS ON SCREEN.
//
// The scope label is not a nicety. The reference implementation's own source
// says why it keeps one: an all-channels pane looks "wrong" without it, because
// it is indistinguishable from a channel pane showing the wrong channel. Both
// scopes are therefore rendered as a pair with the live one marked, and the
// line under them names the scope again in words next to the count.
//
// The list is for peeking and the detail is for reading. Choosing a row shows an
// inline preview UNDER that row without leaving the list (Claude Agent View's
// "do not lose your place"), and going in is a separate, named action. Choosing
// means clicking or pressing Enter: a preview that opens itself on hover moves
// every row below it while the cursor is still travelling, and reads a thread
// nobody asked for.
// =============================================================================

function ScopeButton({
  active,
  label,
  onClick,
  testId,
  flexible = false,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
  testId: string;
  /** Only the unbounded channel/DM label yields space to the fixed scopes. */
  flexible?: boolean;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "h-control-sm rounded-sm px-2 text-meta transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        flexible ? "min-w-0 flex-1 truncate" : "shrink-0",
        active
          ? "bg-accent-soft text-accent"
          : "text-ink-muted hover:bg-surface-hover"
      )}
    >
      {label}
    </button>
  );
}

/** DOM id of the peek a row controls, so the two are linked for a11y. */
function peekDomId(sessionId: string): string {
  return `work-peek-${sessionId.toLowerCase()}`;
}

/** Same idea for the host picker: the row's toggle controls exactly this group. */
function resumeHostsDomId(sessionId: string): string {
  return `work-resume-hosts-${sessionId.toLowerCase()}`;
}

function resumeHostsLabelDomId(sessionId: string): string {
  return `work-resume-hosts-label-${sessionId.toLowerCase()}`;
}

/**
 * One session in the list. Choosing it peeks; the preview under it carries the
 * action that actually opens it. A row is a button and nothing is nested inside
 * it, so the whole list stays reachable with Tab and arrow keys.
 *
 * Peeking is an EXPLICIT choice (click or Enter), never a hover and never a
 * focus. The preview is inserted under the row inside the same <li>, so opening
 * one pushes every row below it down by its full height; on hover that turned
 * running the cursor across the list into a 90px bounce per row, with the row
 * under the cursor changing identity mid-gesture, and each pass also fired a
 * `/replies` read for a session nobody had asked to see. `onFocus` had the same
 * two effects once per Tab stop.
 */
function SessionRow({
  session,
  hosts,
  channelName,
  peeked,
  live,
  nowMs,
  lastEventAtMs,
  summary,
  onPeek,
  rowRef,
}: {
  session: WorkSession;
  hosts: WorkHost[] | undefined;
  channelName: string;
  peeked: boolean;
  live: boolean;
  nowMs: number;
  lastEventAtMs: number | null;
  summary: string | null;
  onPeek: () => void;
  rowRef: (element: HTMLButtonElement | null) => void;
}) {
  const hostOnline = workHostOnline(session, hosts);
  const status = workSessionContinuityStatus(session, hosts);
  const effectiveLive = live && hostOnline !== false;
  const slow = effectiveLive && isSlowStep(session, lastEventAtMs, nowMs);
  const elapsed = elapsedLabel(session.startedAtMs, session.endedAtMs ?? nowMs);
  return (
    <button
      ref={rowRef}
      type="button"
      onClick={onPeek}
      aria-expanded={peeked}
      {...(peeked ? { "aria-controls": peekDomId(session.id) } : {})}
      data-testid="work-session-row"
      data-session-id={session.id}
      data-status={status.key}
      className={cn(
        "flex w-full min-w-0 flex-col gap-px px-4 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        peeked ? "bg-surface-hover" : "hover:bg-surface-hover"
      )}
    >
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-ink">
          {session.label}
        </span>
        <span
          className={cn(
            CHIP_CLASS,
            SESSION_STATUS_CLASS[status.key]
          )}
        >
          {status.label}
        </span>
        <span
          data-numeric
          data-slow={slow ? "" : undefined}
          data-testid="work-session-elapsed"
          className={cn(
            "shrink-0 font-mono text-timestamp",
            !effectiveLive
              ? "text-ink-muted"
              : slow
                ? "text-warn"
                : "text-ink-muted"
          )}
        >
          {elapsed}
        </span>
      </span>
      <span className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-meta text-ink-muted">{channelName}</span>
        {/* The survival signal is a WORD, not a hue. It used to be a color
            change on the clock with the explanation in a `title`, which a
            keyboard or screen reader user never reaches and which leaves colour
            carrying the state on its own (SKILL §6). */}
        {slow && lastEventAtMs !== null && (
          <span
            className="shrink-0 text-meta text-warn"
            data-testid="work-session-slow"
          >
            {/* Prose in sans, the figure tabular (tokens.md §4). It reticks
                every second, and an untagged "15초" growing to "15분 3초"
                shifts the summary beside it. */}
            신호 없음{" "}
            <span data-numeric>{silenceLabel(lastEventAtMs, nowMs)}</span>
          </span>
        )}
        {/* The rest is either the newest line the rail delivered, or the two
            facts the ledger row itself carries. It is never "아직 단계가
            없습니다": this row has not read the session thread, and absence of
            evidence would be stated here as evidence of absence. */}
        <span className="min-w-0 flex-1 truncate text-meta text-ink-muted">
          {summary ?? `${session.tool} · 시작 ${clockLabel(session.startedAtMs)}`}
        </span>
      </span>
    </button>
  );
}

function MySessionRow({
  session,
  hosts,
  channelName,
  openingThread,
  resumeOpen,
  resumeTargets,
  resumingHostId,
  resumeError,
  onOpenDetail,
  onOpenThread,
  onToggleResume,
  onResume,
  detailRef,
}: {
  session: WorkSession;
  hosts: WorkHost[];
  channelName: string;
  openingThread: boolean;
  resumeOpen: boolean;
  resumeTargets: WorkHost[];
  resumingHostId: string | null;
  resumeError: string | null;
  onOpenDetail: () => void;
  onOpenThread: () => void;
  onToggleResume: () => void;
  onResume: (hostId: string) => void;
  detailRef: (element: HTMLButtonElement | null) => void;
}) {
  const status = workSessionContinuityStatus(session, hosts);
  const hostName = workHostName(session, hosts) ?? "알 수 없는 호스트";
  const hostOnline = workHostOnline(session, hosts);
  const canReattach = canReattachWorkSession(session, hosts);
  const orphaned = session.status === "orphaned";
  // 고를 것이 실제로 있을 때만 폼이 그려진다. 없으면 그 자리에 문장이 오고,
  // 토글은 가리킬 그룹이 없다(아래 aria-controls, 2R M4).
  const hasTargets = resumeTargets.length > 0;
  const errorRef = useRef<HTMLParagraphElement>(null);

  // 실패한 재개의 포커스 복구 (2R H1). 확정 버튼은 진행 중에도 enabled라 대개
  // 그대로 남아 있고, 그러면 사람이 그것을 쥔 채다 — 빼앗지 않는다. 자격 호스트가
  // 마지막 하나였고 그 사이에 사라졌다면 폼째로 언마운트되고 포커스가 <body>로
  // 떨어지는데, 그때만 오류 문장이 받는다. 판정은 이 파일이 스코프 변경에서 쓰는
  // stranded와 같은 형태다.
  useEffect(() => {
    if (resumeError === null) return;
    const active = document.activeElement;
    if (active !== null && active !== document.body) return;
    errorRef.current?.focus({ preventScroll: true });
  }, [resumeError]);

  return (
    <li
      className="border-b border-line px-4 py-2"
      data-testid="my-work-session-row"
      data-session-id={session.id}
      data-status={status.key}
      data-host-online={
        hostOnline === null ? "unknown" : hostOnline ? "true" : "false"
      }
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-body text-ink">
          {session.label}
        </span>
        <span
          className={cn(
            CHIP_CLASS,
            SESSION_STATUS_CLASS[status.key]
          )}
          data-testid="my-work-session-status"
        >
          {status.label}
        </span>
      </div>
      <p className="mt-1 flex min-w-0 items-baseline gap-1 text-meta text-ink-muted">
        {/* Shrink-only, never grow: the interpunct-separated fields read as ONE
            sentence, so letting the name grow splits the line into a left/right
            pair on short names (design-review 851-2R High). The unbounded name
            is still the first truncation victim because every sibling is
            shrink-0. */}
        <span
          className="min-w-0 truncate"
          data-testid="my-work-session-host"
        >
          {hostName}
        </span>
        <span className="shrink-0">·</span>
        <span className="shrink-0" data-testid="my-work-session-host-state">
          {hostOnline === true
            ? "온라인"
            : hostOnline === false
              ? "응답 없음"
              : "상태 확인 필요"}
        </span>
        <span className="shrink-0">·</span>
        <span className="shrink-0" data-testid="my-work-session-tool">
          {session.tool}
        </span>
      </p>
      <p className="flex min-w-0 items-baseline gap-1 text-meta text-ink-muted">
        <span className="min-w-0 truncate">{channelName}</span>
        <span className="shrink-0">· 시작</span>
        <span data-numeric className="shrink-0 font-mono">
          {clockLabel(session.startedAtMs)}
        </span>
      </p>
      <div className="mt-2 flex flex-wrap justify-end gap-2">
        <Button
          ref={detailRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpenDetail}
          data-testid="my-work-session-detail"
        >
          {canReattach ? "이어서 보기" : "세션 상세"}
        </Button>
        {/* 열기 전에는 이 토글이 이 행의 결정이므로 채움이고, 열린 뒤에는 결정이
            확정 버튼으로 옮겨가므로 ghost로 물러난다. 라벨도 함께 바뀐다 —
            `aria-expanded={true}`인데 이름이 아직 "새 호스트에서 재개"면 보이는
            이름과 안내되는 상태가 어긋난다(2R M9). 작업 흐름 상세의 같은 토글이
            쓰는 규칙 그대로이고, 컨트롤을 공유하면서 그 컨트롤이 존재하는 이유인
            규칙만 쪼갤 수는 없다. 고아가 아닌 행의 `세션 스레드`는 이 행의
            결정이 아니므로 계속 outline이다. */}
        <Button
          type="button"
          variant={orphaned ? (resumeOpen ? "ghost" : "default") : "outline"}
          size="sm"
          onClick={orphaned ? onToggleResume : onOpenThread}
          disabled={openingThread || resumingHostId !== null}
          aria-expanded={orphaned ? resumeOpen : undefined}
          {...(orphaned && resumeOpen && hasTargets
            ? { "aria-controls": resumeHostsDomId(session.id) }
            : {})}
          data-testid="my-work-session-thread"
        >
          {openingThread
            ? "스레드 여는 중"
            : orphaned
              ? resumeOpen
                ? "호스트 선택 닫기"
                : "새 호스트에서 재개"
              : "세션 스레드"}
        </Button>
      </div>
      {orphaned && resumeOpen && (
        // 이 블록은 이 행에서 가장 긴 한국어 산문을 담는다. 어절에서 끊는 규칙은
        // 이 컨테이너가 갖고(word-break는 상속된다), 긴 토큰을 받아내는
        // break-words는 각 문단이 갖는다 — 한 엘리먼트에 함께 두면
        // tailwind-merge가 하나를 지운다(MOMO-676 M-5). 쌍둥이 표면의 같은
        // 문장들은 `<section class="break-keep">` 아래에 있는데 이쪽만 없어서,
        // 261px 실측에서 재개 오류의 `확인한`이 음절에서 쪼개졌다(2R M5).
        <div
          className="mt-2 break-keep rounded-md border border-line bg-surface-raised px-3 py-2"
          data-testid="work-session-resume-targets"
        >
          <p className="break-words text-meta text-ink">
            Git 계보만 새 호스트로 이어집니다.
          </p>
          <p className="mt-1 break-words text-meta text-ink-muted">
            이전 호스트의 터미널 상태와 미커밋 변경은 옮겨지지 않습니다.
          </p>
          {resumeError !== null && (
            <p
              ref={errorRef}
              tabIndex={-1}
              className="mt-2 break-words text-meta text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              role="alert"
            >
              {resumeError}
            </p>
          )}
          {!hasTargets ? (
            <p className="mt-2 break-words text-meta text-ink-muted">
              온라인인 다른 호스트가 없습니다. 호스트를 연결한 뒤 다시
              시도하세요.
            </p>
          ) : (
            // 작업 흐름 상세의 이어받기와 같은 컨트롤이다(HostPicker). 두 표면이
            // 제안하는 act가 같고 그 아래 두 줄의 문장은 이미 한 글자까지 같게
            // 쓰기로 한 것이라, 컨트롤만 두 벌로 두면 같은 약속이 두 가지 무게와
            // 두 가지 폭으로 보인다.
            <HostPicker
              id={resumeHostsDomId(session.id)}
              labelId={resumeHostsLabelDomId(session.id)}
              copy={{
                group: "재개할 호스트",
                confirm: "재개",
                action: (name) => `${name}에서 재개`,
                busy: (name) => `${name}에서 재개하는 중`,
              }}
              targets={resumeTargets}
              busyHostId={resumingHostId}
              onPick={onResume}
              selectTestId="work-session-resume-host-select"
              confirmTestId="work-session-resume-confirm"
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The peek: the last few lines, and the one action that leaves the list.
 *
 * It reads the session thread itself rather than borrowing the list's live
 * buffer, which is what makes it honest: an empty peek here means the thread
 * WAS read and holds nothing, and the query it uses is keyed exactly like the
 * detail's, so opening the session after peeking costs no second round trip.
 * That shared read is also why the page budget (5 x 200) is the detail's and
 * not a preview's: one read serves both, and it only fires when a row is
 * explicitly chosen.
 *
 * When that budget runs out the rows in hand are the thread's HEAD, because
 * /replies pages oldest first with a seq cursor and the server offers no
 * descending order. The tail of a truncated read is therefore a thousand events
 * old, and three lines of it presented with no caption read as "the latest".
 * So a truncated peek says so before its rows, in the same words the detail
 * uses.
 */
function SessionPeek({
  session,
  hosts,
  liveEvents,
  onOpen,
}: {
  session: WorkSession;
  hosts: WorkHost[] | undefined;
  liveEvents: readonly WorkSessionEvent[];
  onOpen: () => void;
}) {
  const { workspaceId } = useSession();
  const mine = useMemo(
    () => eventsForSession(liveEvents, session.id),
    [liveEvents, session.id]
  );
  const query = useSessionEvents(workspaceId, session, mine);
  const truncated = query.truncated;
  const rows = useMemo(
    () => foldSessionEvents(query.events, session, truncated).rows,
    [query.events, session, truncated]
  );
  const tail = peekRows(rows);
  const canReattach = canReattachWorkSession(session, hosts);
  return (
    <div
      id={peekDomId(session.id)}
      className="border-y border-line bg-surface-raised px-4 py-2"
      data-testid="work-session-peek"
      data-session-id={session.id}
    >
      {query.isPending ? (
        <SkeletonRows rows={2} className="p-0" />
      ) : query.error !== null ? (
        <p className="text-meta text-danger" role="alert">
          진행 내역을 불러오지 못했습니다.
        </p>
      ) : tail.length === 0 ? (
        // Fail-closed here too (X-11 / MOMO-546). An empty stream from a remote
        // host is not a quiet session, it is a relay this client cannot vouch
        // for, and the peek is exactly where that difference would be missed.
        <p className="text-meta text-ink-muted" data-testid="work-peek-empty">
          {workHostTrust(session, hosts) !== "local"
            ? "진행 내역 중계가 검증되지 않은 호스트입니다. 세션 원장만 확인할 수 있습니다."
            : `아직 진행 내역이 없습니다. ${emptyStepsDetail(session, hosts)}`}
        </p>
      ) : (
        <>
          {truncated && (
            <p
              className="pb-1 text-meta text-warn"
              data-testid="work-peek-truncated"
            >
              진행 내역이 많아 앞부분만 불러왔습니다. 아래는 최근 단계가
              아닙니다.
            </p>
          )}
          <ul className="flex flex-col gap-1">
            {tail.map((row) => (
              <li key={row.id} className="flex items-baseline gap-2">
                <span
                  data-numeric
                  className="shrink-0 font-mono text-timestamp text-ink-muted"
                >
                  {clockLabel(row.atMs)}
                </span>
                <span className="min-w-0 flex-1 truncate text-meta text-ink">
                  {row.headline}
                </span>
                {/* Same chip rule as the detail: a `message` row is the agent's
                    own text and a `note` is a status line, so neither is a step
                    with a state. Chipping a message 진행 중 turned the ledger's
                    "this session is still open" into "these words are arriving
                    now", which is a claim about the stream that the list row
                    above (신호 없음 N) may be denying in the same breath. */}
                {row.kind !== "message" && row.kind !== "note" && (
                  <span
                    data-testid="work-peek-chip"
                    className={cn(
                      "shrink-0 rounded-sm px-1 text-timestamp",
                      ROW_STATE_CLASS[row.state]
                    )}
                  >
                    {ROW_STATE_LABEL[row.state]}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="flex justify-end pt-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={onOpen}
          data-testid="work-session-open"
        >
          {canReattach ? "이어서 보기" : "전체 보기"}
        </Button>
      </div>
    </div>
  );
}

export function WorkPanel({
  channelId,
  scope: requestedScope,
  onScopeChange,
  selectedId,
  onSelectedIdChange,
  openingThreadId,
  threadOpenError,
  onOpenThread,
  onClose,
}: {
  /** The open channel, or null when the route has none. */
  channelId: string | null;
  /**
   * Scope and selection live in ChatShell, not here. Closing the panel unmounts
   * it, and holding them locally meant every close threw away the range you had
   * chosen and the session you were reading: reopening dropped an all-workspace
   * view back to the current channel, which is frequently an empty list.
   */
  scope: WorkScope;
  onScopeChange: (scope: WorkScope) => void;
  selectedId: string | null;
  onSelectedIdChange: (sessionId: string | null) => void;
  openingThreadId: string | null;
  threadOpenError: string | null;
  onOpenThread: (session: WorkSession) => void;
  onClose: () => void;
}) {
  const { session: auth, workspaceId, connStatus } = useSession();
  const channelsQuery = useChannels(workspaceId);
  const directoryQuery = useDirectory(workspaceId);
  const sessionsQuery = useWorkSessions(workspaceId);
  const hostsQuery = useWorkHosts(workspaceId);
  const projectionsPending = sessionsQuery.isPending || hostsQuery.isPending;
  const projectionError = sessionsQuery.error ?? hostsQuery.error;

  // With no open channel there is no channel scope to be in, whatever the
  // remembered preference says.
  const scope: WorkScope =
    channelId === null && requestedScope === "channel" ? "all" : requestedScope;
  const [peekId, setPeekId] = useState<string | null>(null);
  const [resumeSessionId, setResumeSessionId] = useState<string | null>(null);
  const [resumingHostId, setResumingHostId] = useState<string | null>(null);
  const [resumeError, setResumeError] = useState<string | null>(null);

  /**
   * The pane takes the whole chat surface instead of its 320px strip.
   *
   * MOMO-619 R1 H2: 320px is the right default for a column of session rows and
   * the wrong one for the read-only terminal inside the detail, which showed 37
   * of the 80 columns the host writes at, folding an ordinary pytest line onto
   * two rows. The same full-surface geometry already existed below 900px, which
   * meant the panel got NARROWER as the window got wider; this makes it a
   * choice at any width.
   *
   * Unlike scope and selection it is deliberately NOT lifted into ChatShell: it
   * covers the channel, and a pane that silently reopens on top of the
   * conversation days later is a state nobody asked to persist. Closing the
   * panel is also the way out of it.
   */
  const [wide, setWide] = useState(false);

  // ---- focus ownership -----------------------------------------------------
  // Every step in and out of this panel hands the caret somewhere explicit. It
  // used to fall to <body>: entering the detail left focus nowhere, which also
  // took Escape (handled on the <aside>) out of reach, so the one keyboard path
  // into the detail disabled the keyboard path back out of it. Closing the
  // panel stranded the caret the same way instead of returning it to the
  // toggle that opened it. The house rule is already the other one:
  // design/ui/dialog.tsx captures its opener and restores it.
  const asideRef = useRef<HTMLElement>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const openerRef = useRef<HTMLElement | null>(null);
  if (openerRef.current === null && typeof document !== "undefined") {
    const active = document.activeElement;
    openerRef.current = active instanceof HTMLElement ? active : null;
  }
  const [restoreRowId, setRestoreRowId] = useState<string | null>(null);

  const closePanel = useCallback(() => {
    const opener = openerRef.current;
    onClose();
    if (opener?.isConnected) opener.focus();
  }, [onClose]);

  const closeDetail = useCallback(() => {
    const id = selectedId;
    onSelectedIdChange(null);
    if (id !== null) setRestoreRowId(id);
  }, [selectedId, onSelectedIdChange]);

  useEffect(() => {
    if (restoreRowId === null) return;
    setRestoreRowId(null);
    const row = rowRefs.current.get(restoreRowId.toLowerCase());
    // A session that left the list while it was open (scope change, ended and
    // filtered out) has no row to go back to; the panel itself takes the caret
    // so the next Tab starts here rather than at the top of the document.
    (row ?? asideRef.current)?.focus();
  }, [restoreRowId]);

  const sessions = useMemo(
    () => sortSessions(sessionsQuery.data ?? []),
    [sessionsQuery.data]
  );
  const visible = useMemo(
    () => scopeSessions(sessions, scope, channelId, auth.member.id),
    [sessions, scope, channelId, auth.member.id]
  );
  const rail = useWorkSessionRail(workspaceId, sessions, channelId);

  const live = connStatus === "connected";
  const hasRunning = visible.some((session) => session.status === "running");
  // One clock for the panel, mounted only while something is actually running
  // and the rail is up: a clock that keeps counting on a dead socket is
  // measuring our optimism (agentWorkingSignal.useTickingNow).
  const nowMs = useTickingNow(live && hasRunning);

  const channels = useMemo(
    () => [...channelsQuery.groups.channels, ...channelsQuery.groups.dms],
    [channelsQuery.groups]
  );
  const nameOf = useMemo(() => {
    const directory: Directory = directoryQuery.directory;
    return (id: string): string => {
      const channel: Channel | undefined = channels.find((c) => uuidEq(c.id, id));
      if (!channel) return "다른 채널";
      const label = channelLabel(channel, directory, auth.member.id);
      return channel.kind === "dm" ? label : `#${label}`;
    };
  }, [channels, directoryQuery.directory, auth.member.id]);

  const scopeLabel = channelId === null ? "전체" : nameOf(channelId);
  // Looked up inside the CURRENT scope, not the whole workspace, so the body
  // can never render a session the scope control above it excludes, not even
  // for the frame before the effect below clears the selection.
  const selected =
    selectedId === null
      ? null
      : visible.find((session) => uuidEq(session.id, selectedId)) ?? null;

  // A detail view of a session THIS LIST no longer holds is a view of nothing.
  //
  // It used to check membership of the whole workspace, which let the header
  // and the body disagree: switching the scope to #A while a session from #B
  // was open left the body on #B under a scope control insisting on #A. The
  // scope label is rendered at all times precisely so a reader never has to
  // wonder which range they are looking at, so it cannot be allowed to point
  // somewhere the pane below it is not.
  //
  // Focus is only recovered when it was STRANDED. The detail is gone by the
  // time this runs (`selected` is scoped too), so the question is not where the
  // caret was but where it is: on <body> means it went down with the detail and
  // the panel takes it back, anywhere else means the reader is holding it. That
  // second case is the scope button they just pressed, and pulling focus off it
  // mid-gesture would be the panel answering a click by taking the keyboard.
  useEffect(() => {
    if (selectedId === null || sessionsQuery.isPending) return;
    if (visible.some((session) => uuidEq(session.id, selectedId))) return;
    const active = document.activeElement;
    const stranded = active === null || active === document.body;
    onSelectedIdChange(null);
    if (stranded) setRestoreRowId(selectedId);
  }, [selectedId, visible, sessionsQuery.isPending, onSelectedIdChange]);

  useEffect(() => {
    setPeekId(null);
    setResumeSessionId(null);
    setResumeError(null);
  }, [scope, channelId]);

  const resumeOnHost = useCallback(
    async (session: WorkSession, targetHostId: string) => {
      if (resumingHostId !== null) return;
      setResumingHostId(targetHostId);
      setResumeError(null);
      try {
        const resumed = await resumeWorkSession(
          workspaceId,
          session.id,
          targetHostId
        );
        await sessionsQuery.refetch();
        setResumeSessionId(null);
        onSelectedIdChange(resumed.id);
      } catch {
        setResumeError(
          "새 호스트에서 재개하지 못했습니다. 호스트 상태를 확인한 뒤 다시 시도하세요."
        );
      } finally {
        setResumingHostId(null);
      }
    },
    [
      onSelectedIdChange,
      resumingHostId,
      sessionsQuery,
      workspaceId,
    ]
  );

  /**
   * Folded rows per session, so the row summary and the peek agree exactly.
   *
   * The key carries the session's STATUS as well as its id, because the fold
   * reads it: a running session promotes its newest tool row to the present
   * tense (workSessionModel), and a finished one does not. Keyed on the id
   * alone the cache only ever refreshed when `rail.liveEvents` changed, which
   * covers running to ended (the `work.session.ended` frame sweeps that
   * session's live events out) but not running to orphaned: a host whose
   * heartbeat expires publishes no frame at all and is discovered by the 60s
   * poll, so the chip would flip to 호스트 연결 끊김 while the summary beside
   * it still said 명령 실행 중.
   */
  const foldedFor = useMemo(() => {
    const cache = new Map<
      string,
      { rows: ReturnType<typeof foldSessionEvents>["rows"]; lastEventAtMs: number | null }
    >();
    return (session: WorkSession) => {
      const key = `${session.id.toLowerCase()}:${session.status}`;
      const hit = cache.get(key);
      if (hit) return hit;
      const mine: WorkSessionEvent[] = eventsForSession(
        rail.liveEvents,
        session.id
      );
      const folded = foldSessionEvents(mine, session);
      const value = { rows: folded.rows, lastEventAtMs: folded.lastEventAtMs };
      cache.set(key, value);
      return value;
    };
  }, [rail.liveEvents]);

  const updatedAt = sessionsQuery.dataUpdatedAt;

  return (
    <aside
      ref={asideRef}
      tabIndex={-1}
      aria-label="작업 세션"
      data-testid="work-panel"
      data-scope={scope}
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        // Escape steps back one level rather than closing everything: out of the
        // detail to the list, out of the peek to the plain list, then out.
        if (selectedId !== null) {
          event.stopPropagation();
          closeDetail();
        } else if (peekId !== null) {
          event.stopPropagation();
          setPeekId(null);
        } else {
          closePanel();
        }
      }}
      data-wide={wide ? "" : undefined}
      className="work-pane flex h-full shrink-0 flex-col border-l border-line bg-surface"
    >
      <header className="flex flex-col gap-1 border-b border-line px-4 py-2">
        <div className="flex items-center justify-between gap-2">
          <h2 className="min-w-0 flex-1 truncate text-body font-semibold">
            작업 세션
          </h2>
          {/* Icon only, so it carries its own name, and `aria-pressed` because
              it is a state and not a one-way action. Hidden below 900px, where
              the pane is already the whole surface (tokens.css). */}
          <button
            type="button"
            onClick={() => setWide((current) => !current)}
            aria-pressed={wide}
            aria-label={wide ? "패널 좁게 보기" : "패널 넓게 보기"}
            data-testid="work-panel-wide"
            className="pane-wide-toggle flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {wide ? (
              <PanelRightClose className="size-4" />
            ) : (
              <PanelRightOpen className="size-4" />
            )}
          </button>
          <button
            type="button"
            onClick={closePanel}
            aria-label="작업 세션 닫기"
            data-testid="work-panel-close"
            className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <X className="size-4" />
          </button>
        </div>
        {/* The pair is one control, so it is announced as one: without the
            group a screen reader reads "#agent-lab, 눌림, 버튼" then "전체,
            버튼" with nothing saying what the two are choosing between. */}
        <div
          role="group"
          aria-label="범위"
          className="flex min-w-0 items-center gap-1"
          data-testid="work-scope"
        >
          <ScopeButton
            active={scope === "channel"}
            label={scopeLabel}
            onClick={() => onScopeChange("channel")}
            testId="work-scope-channel"
            flexible
          />
          <ScopeButton
            active={scope === "all"}
            label="전체"
            onClick={() => onScopeChange("all")}
            testId="work-scope-all"
          />
          <ScopeButton
            active={scope === "mine"}
            label="내 세션"
            onClick={() => onScopeChange("mine")}
            testId="work-scope-mine"
          />
        </div>
        {/* The count is a claim about the server, so it waits for the server.
            While the list is loading there is no number here at all.
            The scope is NOT repeated here: it is one control away, above, and
            saying it twice cost a whole line of a 320px column.

            When the read FAILS the line does NOT disappear. Dropping it was an
            over-correction: the duplicate sentence was the problem ("확인하지
            못했습니다" beside "불러오지 못했습니다" reads as two faults), but
            the timestamp is not a duplicate of anything the banner says. It is
            the only thing on screen that dates the rows still standing under
            the error, each of them wearing a 실행 중 chip and a clock that goes
            on counting, so it matters most exactly when the read failed. What
            it says then is what it is: the moment the list last came back. */}
        {sessionsQuery.isPending ? (
          <p className="text-meta text-ink-muted" data-testid="work-panel-summary">
            세션을 불러오는 중입니다.
          </p>
        ) : updatedAt > 0 ? (
          <p className="text-meta text-ink-muted" data-testid="work-panel-summary">
            세션{" "}
            <span data-numeric className="font-mono">
              {visible.length}
            </span>
            개 ·{" "}
            {sessionsQuery.error === null ? "마지막 갱신" : "마지막으로 확인한 시각"}{" "}
            <span data-numeric className="font-mono">
              {freshnessLabel(updatedAt)}
            </span>
          </p>
        ) : null}
      </header>

      {!live && (
        <InlineBanner
          tone="neutral"
          message="연결이 끊겨 갱신이 멈췄습니다. 아래는 마지막으로 확인된 상태입니다."
          testId="work-panel-offline"
        />
      )}

      {rail.uncovered.length > 0 && (
        <p
          className="border-b border-line px-4 py-1 text-meta text-ink-muted"
          data-testid="work-coverage-notice"
        >
          실시간 표시가 한도에 닿았습니다. 일부 채널의 세션은 새로고침될 때만
          갱신됩니다.
        </p>
      )}

      {threadOpenError !== null && (
        <InlineBanner
          message={threadOpenError}
          testId="work-thread-open-error"
        />
      )}

      {selected !== null ? (
        <WorkSessionDetail
          session={selected}
          hosts={hostsQuery.data}
          directory={directoryQuery.directory}
          channelName={nameOf(selected.channelId)}
          liveEvents={rail.liveEvents}
          live={live}
          nowMs={nowMs}
          wide={wide}
          onWideChange={setWide}
          onBack={closeDetail}
        />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          {projectionsPending && (
            <SkeletonRows rows={4} className="p-4" />
          )}
          {projectionError !== null && (
            <InlineBanner
              message={
                sessionsQuery.error !== null
                  ? "세션 목록을 불러오지 못했습니다."
                  : "호스트 상태를 불러오지 못했습니다."
              }
              actionLabel="다시 시도"
              onAction={() => {
                if (sessionsQuery.error !== null) void sessionsQuery.refetch();
                if (hostsQuery.error !== null) void hostsQuery.refetch();
              }}
              testId="work-panel-error"
            />
          )}
          {!projectionsPending &&
            projectionError === null &&
            scope === "mine" &&
            hostsQuery.data?.length === 0 &&
            visible.length === 0 && (
              <EmptyInvite
                headline="등록된 작업 호스트가 없습니다."
                detail="코드 실행 호스트를 연결하면 내 활성 세션을 이어서 볼 수 있습니다."
                testId="work-panel-hosts-empty"
              />
            )}
          {!projectionsPending &&
            projectionError === null &&
            !(scope === "mine" &&
              hostsQuery.data?.length === 0 &&
              visible.length === 0) &&
            visible.length === 0 && (
              <EmptyInvite
                headline={
                  scope === "mine"
                    ? "현재 이어갈 내 세션이 없습니다."
                    : scope === "all"
                    ? "이 워크스페이스에는 아직 작업 세션이 없습니다."
                    : "이 채널에는 아직 작업 세션이 없습니다."
                }
                detail={
                  scope === "mine"
                    ? "내가 시작한 실행 중, 대기 중 또는 연결이 끊긴 세션이 여기에 표시됩니다."
                    : scope === "channel"
                    ? "다른 채널의 세션은 전체 범위에서 볼 수 있습니다."
                    : "에이전트가 작업을 시작하면 여기에 세션이 쌓입니다."
                }
                actions={
                  scope === "channel" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onScopeChange("all")}
                      data-testid="work-empty-all"
                    >
                      전체 범위로 보기
                    </Button>
                  ) : undefined
                }
                testId="work-panel-empty"
              />
            )}
          {scope === "mine" &&
            !projectionsPending &&
            projectionError === null &&
            visible.length > 0 && (
              <ul data-testid="my-work-session-list">
                {visible.map((session) => (
                  <MySessionRow
                    key={session.id}
                    session={session}
                    hosts={hostsQuery.data ?? []}
                    channelName={nameOf(session.channelId)}
                    openingThread={uuidEq(openingThreadId ?? undefined, session.id)}
                    resumeOpen={uuidEq(
                      resumeSessionId ?? undefined,
                      session.id
                    )}
                    resumeTargets={workSessionResumeTargets(
                      session,
                      hostsQuery.data ?? [],
                      auth.member.id
                    )}
                    resumingHostId={resumingHostId}
                    resumeError={
                      uuidEq(resumeSessionId ?? undefined, session.id)
                        ? resumeError
                        : null
                    }
                    onOpenDetail={() => onSelectedIdChange(session.id)}
                    onOpenThread={() => onOpenThread(session)}
                    onToggleResume={() => {
                      setResumeError(null);
                      setResumeSessionId((current) =>
                        uuidEq(current ?? undefined, session.id)
                          ? null
                          : session.id
                      );
                    }}
                    onResume={(hostId) => void resumeOnHost(session, hostId)}
                    detailRef={(element) => {
                      const key = session.id.toLowerCase();
                      if (element) rowRefs.current.set(key, element);
                      else rowRefs.current.delete(key);
                    }}
                  />
                ))}
              </ul>
            )}
          {scope !== "mine" &&
            !projectionsPending &&
            projectionError === null &&
            visible.length > 0 && (
            <ul data-testid="work-session-list">
              {visible.map((session) => {
                const folded = foldedFor(session);
                const peeked = uuidEq(session.id, peekId ?? undefined);
                return (
                  <li key={session.id} className="border-b border-line">
                    <SessionRow
                      session={session}
                      hosts={hostsQuery.data}
                      channelName={nameOf(session.channelId)}
                      peeked={peeked}
                      live={live}
                      nowMs={nowMs}
                      lastEventAtMs={folded.lastEventAtMs}
                      summary={lastLine(folded.rows)}
                      onPeek={() => setPeekId(peeked ? null : session.id)}
                      rowRef={(element) => {
                        const key = session.id.toLowerCase();
                        if (element) rowRefs.current.set(key, element);
                        else rowRefs.current.delete(key);
                      }}
                    />
                    {peeked && (
                      <SessionPeek
                        session={session}
                        hosts={hostsQuery.data}
                        liveEvents={rail.liveEvents}
                        onOpen={() => onSelectedIdChange(session.id)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </aside>
  );
}
