import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  ApiError,
  endWorkSession,
  resumeWorkSession,
  sendThreadReply,
  uuidEq,
  type WorkHost,
  type WorkSession,
} from "@momo/core/lib/api";
import { useSession } from "@/app/session";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { elapsedLabel } from "@/features/agents/agentWorkingSignal";
import { CHIP_CLASS } from "@/features/common/chip";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useSessionWorkstream } from "@/features/workstreams/useWorkstreams";
import { ObserverTerminal } from "./ObserverTerminal";
import { useSessionEvents } from "./useWorkSessions";
import {
  composeExcerpt,
  emptyStepsDetail,
  eventsForSession,
  foldSessionEvents,
  isSlowStep,
  ROW_STATE_LABEL,
  workHostName,
  workHostOnline,
  workHostTrust,
  workSessionContinuityStatus,
  type WorkEventRow,
  type WorkSessionEvent,
} from "@momo/core/features/work/workSessionModel";
import {
  clockLabel,
  ROW_STATE_CLASS,
  SESSION_STATUS_CLASS,
  silenceLabel,
} from "@momo/core/features/work/workSessionFormat";
import {
  HANDOFF_COPY,
  handoffVerb,
  sessionVerdict,
  showsOneWayNote,
  takeoverFailureCopy,
  takeoverOneWayCopy,
  takeoverTargets,
} from "@momo/core/features/work/sessionHandoff";
import { TakeoverBlock } from "./TakeoverBlock";

// =============================================================================
// 세션 상세 (AX-3 / MOMO-618): what one work session did, in the order it did
// it, as the SERVER projection allows it to be told.
//
// LAYOUT RULE (MOMO-610, "the shell is the window and the panes scroll", held
// INSIDE the pane too): this surface is ONE scroll column plus one pinned
// action bar. Nothing else is fixed chrome. It first shipped as five stacked
// fixed blocks (title, meta list, host banner, plan, then the ledger in the
// only scroll box) totalling 568px above and below the reading area, which at
// 900x600 left 32px of ledger, and at 760x480 pushed the action bar out of the
// pane entirely. Fixed chrome that outgrows its content is the same bug the
// shell gate exists to catch, one level down: the document did not scroll, the
// content simply had nowhere to be.
//
// So the ledger facts sit in a native <details> disclosure, everything except
// the action bar scrolls, and only the two things you steer by (the back path
// and the session's state) are sticky. The excerpt form scrolls WITH the ledger
// for the same reason, one step further in: as a second fixed block it stood at
// 265px against a 240px ledger at 900x600, squeezing the very rows it exists to
// quote. It is a disclosure under the steps now, not chrome over them.
//
// Three things this surface deliberately does not do:
//   - it never renders `message.body` for a typed row. The server writes those
//     in English ("Approval requested", "ACP session update"); the Korean copy
//     is derived from the typed props instead (workSessionModel).
//   - it never offers a turn-scoped stop it cannot perform. There is no server
//     path from a work session to its agent run (see SessionActions), so no
//     control and no sentence about one: naming a capability only to withdraw
//     it in the next clause is a coming-soon note wearing a status line.
//   - it never draws a remote host's silence as a quiet session. The normalised
//     ACP relay for workd hosts is still in flight (X-11 / MOMO-546), so an
//     unverified stream says so (fail-closed).
// =============================================================================

const EXCERPT_FIELD_ID = "work-excerpt-body";
const EXCERPT_FORM_ID = "work-excerpt-form";

function MetaRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 px-4 py-1">
      <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-words text-meta text-ink">{children}</dd>
    </div>
  );
}

function PlanBlock({ plan }: { plan: ReturnType<typeof foldSessionEvents>["plan"] }) {
  if (plan.length === 0) return null;
  return (
    <section className="border-b border-line px-4 py-2" data-testid="work-plan">
      <h4 className="pb-1 text-meta text-ink-muted">계획</h4>
      <ul className="flex flex-col gap-1">
        {plan.map((item, index) => (
          <li
            key={`${index}-${item.content}`}
            className="flex items-baseline gap-2"
            data-plan-status={item.status}
          >
            <span
              className={cn(
                "shrink-0 text-timestamp",
                item.status === "completed"
                  ? "text-ok"
                  : item.status === "in_progress"
                    ? "text-warn"
                    : "text-ink-muted"
              )}
            >
              {item.status === "completed"
                ? "완료"
                : item.status === "in_progress"
                  ? "진행 중"
                  : "대기"}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 break-words text-meta",
                item.status === "completed" ? "text-ink-muted" : "text-ink"
              )}
            >
              {item.content}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * One projected step. Past tense once it is over, present tense while it runs,
 * and the third branch when it failed, with the state as a text-first chip. The
 * raw tool name never reaches a rendered string at all, tooltip included: it is
 * internal vocabulary (SKILL §7) and its whole job is to pick the Korean copy.
 *
 * A `message` row is the agent's own text, folded from every `agent.partial`
 * delta of one answer, so it keeps the line breaks the agent wrote
 * (`whitespace-pre-wrap`) and, while the stream is still open, ends in a caret
 * rather than a chip: streaming text gets a caret, not a list of fragments and
 * not a shimmer (SKILL §4).
 *
 * `streamOpen` is what makes that caret honest. tokens.md §5b defines it as
 * "information about a stream still being open", so it may only blink while
 * this client can still observe one arriving. The row state alone cannot say
 * that: it is promoted from the SERVER ledger (`session.status === "running"`),
 * which stays true through a nineteen minute silence and through a dropped
 * socket. Both of those are already stated in words at the top of the pane, and
 * a caret blinking under those sentences would be the only moving thing on
 * screen, claiming letters are arriving right now.
 */
function EventRow({ row, streamOpen }: { row: WorkEventRow; streamOpen: boolean }) {
  const streaming = row.kind === "message" && row.state === "running" && streamOpen;
  return (
    <li
      className="flex items-baseline gap-2 border-b border-line px-4 py-1 last:border-b-0"
      data-testid="work-event-row"
      data-row-kind={row.kind}
      data-row-state={row.state}
    >
      <span
        data-numeric
        className="shrink-0 font-mono text-timestamp text-ink-muted"
      >
        {clockLabel(row.atMs)}
      </span>
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "break-words",
            row.kind === "message"
              ? "whitespace-pre-wrap text-body text-ink"
              : "text-meta text-ink"
          )}
        >
          {row.headline}
        </span>
        {streaming && (
          <span
            aria-hidden="true"
            data-testid="work-stream-caret"
            className="caret-stream pl-px text-body text-accent"
          >
            ▌
          </span>
        )}
        {row.detail && row.detail !== row.headline && (
          <span className="block break-words text-meta text-ink-muted">
            {row.detail}
          </span>
        )}
      </span>
      {row.kind !== "message" && row.kind !== "note" && (
        <span
          data-testid="work-row-chip"
          data-state={row.state}
          className={cn(
            CHIP_CLASS,
            ROW_STATE_CLASS[row.state]
          )}
        >
          {ROW_STATE_LABEL[row.state]}
        </span>
      )}
    </li>
  );
}

/**
 * Share an excerpt into the session thread. The text is EDITABLE before it is
 * sent, because the person sharing is the last check on what lands in the
 * channel ledger; this is the same contract as the mac excerpt sheet, and it
 * uses the same write path (a thread reply on the session's root message).
 *
 * It lives at the END of the scroll column rather than pinned under it, so the
 * steps it quotes stay scrollable while it is open, and it takes the caret on
 * open (which is also what scrolls it into view).
 */
function ExcerptForm({
  session,
  rows,
  onDone,
}: {
  session: WorkSession;
  rows: readonly WorkEventRow[];
  onDone: (shared: boolean) => void;
}) {
  const { workspaceId } = useSession();
  const [text, setText] = useState(() => composeExcerpt(session, rows));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    fieldRef.current?.focus();
    // Focusing the field only guarantees the FIELD is on screen. Aligning the
    // form's end brings the send control with it, which is what a pinned bar
    // used to do for free and is the one thing worth keeping from it.
    formRef.current?.scrollIntoView({ block: "end" });
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (pending) return;
    const trimmed = text.trim();
    if (trimmed === "") {
      setError("공유할 내용이 없습니다.");
      return;
    }
    setPending(true);
    setError(null);
    try {
      await sendThreadReply(
        workspaceId,
        session.channelId,
        session.rootMessageId,
        crypto.randomUUID(),
        trimmed
      );
      onDone(true);
    } catch {
      setError("발췌를 스레드에 보내지 못했습니다. 다시 시도하세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form
      ref={formRef}
      id={EXCERPT_FORM_ID}
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-line p-4"
      data-testid="work-excerpt-form"
    >
      <label htmlFor={EXCERPT_FIELD_ID} className="text-meta text-ink-muted">
        발췌 내용
      </label>
      {/* Korean prose in the sans stack, not `font-mono` (tokens.md §4): a
          monospaced face renders 한글 with visibly stretched gaps between
          syllables, so "세션을 시작함" reads as if it were double spaced. This
          is the text the author proof-reads before it lands in the channel
          ledger, and nothing in it is a column of figures that needs aligning.
          It opens at four rows and resizes: the form scrolls with the ledger
          now, but a short window should still show the send control. */}
      <textarea
        ref={fieldRef}
        id={EXCERPT_FIELD_ID}
        value={text}
        rows={4}
        onChange={(event) => setText(event.target.value)}
        disabled={pending}
        spellCheck={false}
        data-testid="work-excerpt-body"
        className="w-full resize-y rounded-sm border border-line-strong bg-surface-raised p-2 text-meta text-ink focus-visible:focus-ring"
      />
      <p className="text-meta text-ink-muted">
        토큰, 비밀번호, 개인 경로가 없는지 확인하세요. 공유하면 채널 스레드
        원장에 저장됩니다.
      </p>
      {error && (
        <p role="alert" className="text-meta text-danger" data-testid="work-excerpt-error">
          {error}
        </p>
      )}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => onDone(false)}
          data-testid="work-excerpt-cancel"
        >
          취소
        </Button>
        <Button
          type="submit"
          size="sm"
          aria-busy={pending || undefined}
          data-testid="work-excerpt-send"
        >
          {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
          {pending ? "보내는 중" : "스레드에 공유"}
        </Button>
      </div>
    </form>
  );
}

/**
 * The write actions this release can actually perform.
 *
 * "이 턴만 중단" is what the reference calls Stop current turn: interrupt the
 * step without killing the process. momo's server has exactly one cancel, and
 * it takes an `agent_run` id; a work session exposes no run id anywhere (the
 * `run_id` inside its ACP events IS the session id, enforced server-side and
 * verified against momowebqa: /agent-runs/{sessionId}/cancel answers 404).
 *
 * That fact lives here, in the code, and nowhere on screen. It shipped first as
 * a permanently disabled button, then as the two line sentence that replaced
 * it ("이 턴만 중단: 서버에 이 세션의 턴만 중단하는 경로가 아직 없습니다"),
 * which is worse in the way that matters: the product has never offered a
 * turn-scoped stop, so the sentence introduced a capability purely in order to
 * withdraw it, on every running session, in a 320px column. That is a
 * coming-soon note plus an implementation excuse (SKILL §7 internal
 * vocabulary), not a status. 세션 종료 is the different thing this pane really
 * can do (the process, not the turn), behind a two step confirmation, and it
 * states its own reason when it is unavailable.
 */
function SessionActions({
  session,
  onExcerpt,
  excerptOpen,
  excerptRef,
}: {
  session: WorkSession;
  onExcerpt: () => void;
  excerptOpen: boolean;
  excerptRef: React.RefObject<HTMLButtonElement>;
}) {
  const { session: auth, workspaceId } = useSession();
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const running = session.status === "running" || session.status === "idle";
  const owner = uuidEq(session.memberId, auth.member.id);
  const endReason = !running
    ? session.status === "orphaned"
      // Same M1 rule as observerStream: orphaned is resumable, not closed.
      ? "호스트 연결이 끊긴 세션입니다."
      : "이미 닫힌 세션입니다."
    : !owner
      ? "세션을 시작한 사람만 종료할 수 있습니다."
      : null;

  async function end() {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      await endWorkSession(workspaceId, session.id);
      setEnded(true);
      setArmed(false);
    } catch {
      setError("세션을 종료하지 못했습니다. 다시 시도하세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-line px-4 py-2">
      <div className="flex flex-wrap items-center gap-2">
        {!armed ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={endReason !== null || ended}
            onClick={() => setArmed(true)}
            data-testid="work-end-session"
          >
            세션 종료
          </Button>
        ) : (
          <span className="flex items-center gap-2" data-testid="work-end-confirm">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setArmed(false)}
              data-testid="work-end-cancel"
            >
              취소
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              aria-busy={pending || undefined}
              onClick={() => void end()}
              data-testid="work-end-commit"
            >
              {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {pending ? "종료하는 중" : "종료 확정"}
            </Button>
          </span>
        )}
        <Button
          ref={excerptRef}
          type="button"
          variant="outline"
          size="sm"
          onClick={onExcerpt}
          aria-expanded={excerptOpen}
          {...(excerptOpen ? { "aria-controls": EXCERPT_FORM_ID } : {})}
          data-testid="work-excerpt-open"
        >
          발췌 공유
        </Button>
      </div>

      {/* Each unavailable action states its own reason, on its own line. One
          merged sentence would leave the reader guessing which action it is
          about. */}
      {armed && (
        <p className="text-meta text-ink" data-testid="work-end-warning">
          세션 종료는 턴 하나가 아니라 이 세션 전체를 끝냅니다. 호스트에서
          실행 중이던 작업도 함께 정리됩니다.
        </p>
      )}
      {endReason !== null && !ended && (
        <p className="text-meta text-ink-muted" data-testid="work-end-reason">
          세션 종료: {endReason}
        </p>
      )}
      {ended && (
        <p role="status" className="text-meta text-ink-muted" data-testid="work-end-done">
          종료를 서버에 기록했습니다.
        </p>
      )}
      {error && (
        <p role="alert" className="text-meta text-danger" data-testid="work-end-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * 이 상세에서 이어하기 — 두 동사 (ADR-0154 D3, #1137).
 *
 * 상세는 서랍의 세션 카드가 **첫 클릭으로 도착하는 곳**이다(`?work=`). 그래서
 * 여기서 동선이 끊기면 서랍의 「대기」 카드는 목적지가 막다른 길인 카드가 된다:
 * 앞 판에서 고아 세션을 그 경로로 열면 인수할 방법이 없어 목록으로 되돌아가야
 * 했고, 목록은 서랍이 온 곳이 아니다.
 *
 * **재개 쪽에는 블록이 없다.** 이 화면이 곧 그 동사의 결과이기 때문이다 —
 * 진행 내역이 아래에 있고 관전 터미널이 그 위에 있다. 이미 서 있는 곳으로
 * 데려가는 버튼은 동선이 아니라 소음이다.
 */
function HandoffSection({
  session,
  hosts,
  onResumed,
}: {
  session: WorkSession;
  hosts: readonly WorkHost[] | undefined;
  onResumed: (sessionId: string) => void;
}) {
  const { session: auth, workspaceId } = useSession();
  const [open, setOpen] = useState(false);
  const [busyHostId, setBusyHostId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 판정을 한 번 내고 그 값을 그대로 나른다 (R1 N1). 앞 판은 동사를 먼저 뽑은
  // 뒤 `verb === "resume" ? "reattach" : null` 로 판정을 **되짚어** 만들었다. 지금은
  // 두 값이 같은 뜻이라 맞지만, 판정이 넷째 값을 갖는 날 이 되짚기는 조용히 틀린
  // 답을 만든다 — 되짚을 필요가 없는 값을 되짚는 것 자체가 그 위험이다.
  const verdict = sessionVerdict(session, hosts);
  const verb = handoffVerb(verdict);
  const targets = takeoverTargets(session, hosts ?? [], auth.member.id);
  const oneWay = showsOneWayNote(verdict, session, hosts, auth.member.id);
  const domId = `work-detail-takeover-${session.id.toLowerCase()}`;

  async function takeover(targetHostId: string) {
    if (busyHostId !== null) return;
    setBusyHostId(targetHostId);
    setError(null);
    try {
      const resumed = await resumeWorkSession(
        workspaceId,
        session.id,
        targetHostId
      );
      setOpen(false);
      onResumed(resumed.id);
    } catch (caught) {
      setError(
        takeoverFailureCopy(
          caught instanceof ApiError ? caught.status : undefined,
          caught instanceof Error ? caught.message : undefined
        )
      );
    } finally {
      setBusyHostId(null);
    }
  }

  // 살아 있는 남의 기기 세션에 서는 비대칭 고지(ADR-0154 D4). 인수 버튼이 왜
  // 없는지에 대한 답이고, 이것이 없으면 그 부재는 결함으로 읽힌다.
  //
  // 문구는 **상태를 받는다** (R1 M1). 같은 화면의 칩이 「완료 · 대기 중」이라고
  // 적어 둔 세션 위에서 「실행 중인 세션은」이라고 말하던 것이 앞 판이고, 그
  // 문장은 이어서 사람이 걸을 수 없는 길까지 가리켰다. 코어 주석에 실측이 있다.
  if (oneWay) {
    return (
      <p
        className="border-b border-line px-4 py-2 break-keep break-words text-meta text-ink-muted"
        data-testid="work-detail-one-way"
      >
        {takeoverOneWayCopy(session.status)}
      </p>
    );
  }

  if (verb !== "takeover") return null;

  return (
    <section className="border-b border-line px-4 py-2" data-testid="work-detail-handoff">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-meta text-ink-muted">{HANDOFF_COPY.takeover.verb}</h2>
        <Button
          type="button"
          variant={open ? "ghost" : "default"}
          size="sm"
          onClick={() => setOpen((was) => !was)}
          disabled={busyHostId !== null}
          aria-expanded={open}
          {...(open ? { "aria-controls": domId } : {})}
          data-testid="work-detail-takeover-toggle"
        >
          {open ? "호스트 선택 닫기" : HANDOFF_COPY.takeover.button}
        </Button>
      </div>
      {open && (
        <TakeoverBlock
          session={session}
          hosts={hosts}
          targets={targets}
          busyHostId={busyHostId}
          error={error}
          onPick={(hostId) => void takeover(hostId)}
          domId={domId}
          labelId={`${domId}-label`}
          testId="work-detail-takeover"
        />
      )}
    </section>
  );
}

export function WorkSessionDetail({
  session,
  hosts,
  directory,
  channelName,
  liveEvents,
  live,
  nowMs,
  wide,
  onWideChange,
  onBack,
  openingThread,
  onOpenThread,
  headingLevel = 3,
  threadActionCopy = {
    idle: "세션 스레드",
    busy: "세션 스레드 여는 중",
  },
  onResumed,
}: {
  session: WorkSession;
  hosts: WorkHost[] | undefined;
  directory: Directory;
  channelName: string;
  liveEvents: readonly WorkSessionEvent[];
  /** The realtime rail is connected, so what is on screen is confirmed. */
  live: boolean;
  nowMs: number;
  /** The pane is at full surface width. Owned by WorkPanel, read by 관전. */
  wide: boolean;
  onWideChange: (wide: boolean) => void;
  onBack: () => void;
  /** 이 세션의 채널 스레드를 여는 요청이 이미 나가 있다. */
  openingThread: boolean;
  /**
   * 채널 스레드로 (R1 H2 부수).
   *
   * 목록 행에서 이 길이 사라진 것은 동사가 선 행에 세 번째 버튼을 세우지 않기
   * 위해서였다. 하지만 상세는 세션 **원장**이고 스레드는 **채널 대화**다 —
   * 서로를 대신하지 않는다. 그래서 그 길을 목적지에서 다시 낸다: 이 화면은 어차피
   * 모든 행이 도착하는 한 곳이고, 채널 이름을 이미 말하고 있다.
   */
  onOpenThread: () => void;
  /** Page routes use h2; the channel panel keeps its existing h3 hierarchy. */
  headingLevel?: 2 | 3;
  /**
   * 같은 상세를 채널 패널 밖에서 재사용할 때의 정직한 목적지 이름.
   * 기본값은 기존 패널의 실제 스레드 열기이고, 작업 콘솔 라우트는 메시지 앵커로
   * 이동하므로 그 동사를 별도로 말한다. 상세 본문과 터미널은 한 벌 그대로다.
   */
  threadActionCopy?: { idle: string; busy: string };
  /**
   * 인수가 성공했다 — 후계 세션의 id. 서버가 **새 행**을 만들기 때문에 필요한
   * 콜백이다(원본은 `ended`로 닫히고 새 id가 돌아온다). 이 화면이 스스로
   * 갈아타지 않고 목록 소유자에게 넘기는 이유는 선택 상태가 거기 있기 때문이고,
   * 여기서 바꾸면 목록과 상세가 서로 다른 세션을 가리킨다.
   */
  onResumed: (sessionId: string) => void;
}) {
  const { workspaceId } = useSession();
  const mine = useMemo(
    () => eventsForSession(liveEvents, session.id),
    [liveEvents, session.id]
  );
  const query = useSessionEvents(workspaceId, session, mine);
  // 이 실행이 어느 목표에 속하는지 (MOMO-679). 반대 방향 — 목표에서 실행으로 —
  // 은 작업 흐름 상세의 이력 행이 이미 걸어주지만, 돌아오는 길이 없어서 이 표면은
  // 사이드바로만 도달 가능했다(PR 918 R1 M5).
  const goalQuery = useSessionWorkstream(workspaceId, session.id);
  const goal = goalQuery.data ?? null;
  const truncated = query.truncated;
  const folded = useMemo(
    () => foldSessionEvents(query.events, session, truncated),
    [query.events, session, truncated]
  );

  const [excerptOpen, setExcerptOpen] = useState(false);
  const [shared, setShared] = useState(false);
  const excerptRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setExcerptOpen(false);
    setShared(false);
  }, [session.id]);

  // Entering the detail takes the caret with it. Without this the pane swapped
  // its contents and left focus on a button that no longer exists, so the
  // browser dropped it on <body>: the Escape handler on the <aside> stopped
  // receiving keys and the documented step back (상세 -> 리스트 -> 밖) was dead
  // for exactly the readers who need it. The back control is the right landing
  // spot because it is both the heading's neighbour and the way out.
  const backRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    backRef.current?.focus();
  }, [session.id]);

  const status = workSessionContinuityStatus(session, hosts);
  const trust = workHostTrust(session, hosts);
  const hostName = workHostName(session, hosts);
  const hostOnline = workHostOnline(session, hosts);
  const owner = memberFor(directory, session.memberId);
  // Once the thread has actually been read, a session with no events at all has
  // been silent since it started, and that start IS the last known signal. Until
  // the read lands there is no last signal to be late, so no tone change.
  //
  // And the survival signal is only meaningful on a relay we can vouch for: on a
  // remote host "10초 넘게 새 신호가 없습니다" would be a claim about a channel
  // this client cannot hear, which is the same fail-closed rule as the banner.
  const lastSignalAtMs =
    folded.lastEventAtMs ?? (query.isSuccess ? session.startedAtMs : null);
  const slow =
    live &&
    hostOnline !== false &&
    trust === "local" &&
    isSlowStep(session, lastSignalAtMs, nowMs);
  const elapsed = elapsedLabel(
    session.startedAtMs,
    session.endedAtMs ?? nowMs
  );
  // The one condition under which a blinking caret is a true statement: the
  // rail is up, the relay is one we can vouch for, and something arrived within
  // the survival window. Drop any of the three and the caret goes; the pane
  // already says why in words (the offline banner, the silence line, the
  // unverified host banner), and those sentences are the honest version of what
  // the caret was claiming.
  const streamOpen =
    live && hostOnline !== false && trust === "local" && !slow;
  const Heading = headingLevel === 2 ? "h2" : "h3";

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-live={live ? "" : undefined}
      data-testid="work-detail"
    >
      {/* ONE scroll column. Everything above the ledger scrolls with it; only
          the two things you steer by stay put. */}
      <div
        className="min-h-0 flex-1 overflow-y-auto"
        data-testid="work-detail-scroll"
      >
        <div className="sticky top-0 z-10 border-b border-line bg-surface">
          <div className="flex items-center gap-2 px-4 py-2">
            <button
              ref={backRef}
              type="button"
              onClick={onBack}
              aria-label="세션 목록으로"
              data-testid="work-detail-back"
              className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:focus-ring"
            >
              <ArrowLeft className="size-4" />
            </button>
            <Heading className="min-w-0 flex-1 truncate text-body font-medium text-ink">
              {session.label}
            </Heading>
            {/* The clock rides with the title rather than living in the meta
                list: it is the one number that keeps changing, and it is the
                one the survival signal colours. */}
            <span
              data-numeric
              data-slow={slow ? "" : undefined}
              data-testid="work-detail-elapsed"
              className={cn(
                "shrink-0 font-mono text-timestamp",
                !live ? "text-ink-muted" : slow ? "text-warn" : "text-ink-muted"
              )}
            >
              {elapsed}
            </span>
            <span
              className={cn(CHIP_CLASS, SESSION_STATUS_CLASS[status.key])}
              data-testid="work-detail-status"
              data-status={status.key}
            >
              {status.label}
            </span>
          </div>
          {/* The measured silence, not the threshold that triggered it. */}
          {slow && lastSignalAtMs !== null && (
            <p
              className="px-4 pb-2 text-meta text-warn"
              data-testid="work-detail-slow"
            >
              {/* The figure is tagged, the prose is not (tokens.md §4): this
                  line is re-rendered every second, so "15분 26초" changing to
                  "15분 27초" shifts the sentence after it unless the digits are
                  tabular. Korean prose stays in the sans stack. */}
              마지막 신호 뒤{" "}
              <span data-numeric>{silenceLabel(lastSignalAtMs, nowMs)}</span>{" "}
              동안 조용합니다. 세션은 아직 실행 중입니다.
            </p>
          )}
        </div>

        {/* 이 세션이 무엇을 위한 실행인지, 그리고 그 목표로 돌아가는 길.
            원장에서 목표로 가는 링크가 하나도 없으면 작업 흐름 표면은
            사이드바에서 출발할 때만 도달 가능하고, 그러면 "이 실행은 누가
            인수할 수 있나"를 여기서 물은 사람이 갈 데가 없다. 목표에 묶이지
            않은 세션은 이 줄을 갖지 않는다 — 명시적 생성은 아직 없으므로
            (ADR-0143 P2) 그것이 흔한 상태다. */}
        {goal !== null && (
          <p className="border-b border-line text-meta text-ink-muted">
            <Link
              to={`/workstreams/${goal.id}`}
              className="block truncate px-4 py-1 hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
              data-testid="work-detail-workstream"
              data-workstream-id={goal.id}
            >
              목표 · <span className="text-ink">{goal.goal}</span>
            </Link>
          </p>
        )}

        {/* 채널 스레드 (R1 H2 부수). 목표 줄과 **같은 모양**인 이유는 같은
            종류의 사실이기 때문이다: 이 세션이 어디에 걸려 있는지. 목표는 왜
            하는 일인지이고 스레드는 그 일이 오간 대화이며, 둘 다 목적지지 동사가
            아니다.

            이 줄이 여기 있는 이유는 목록 행에서 스레드 버튼이 사라졌기 때문이다.
            동사가 선 행에 세 번째 버튼을 세우지 않는 대신, 그 행들이 전부 도착하는
            한 곳에서 길을 다시 낸다. 진행 중에도 disabled 로 만들지 않는다
            (tokens.md §5b): 이 줄이 유일한 길이고, Chromium 은 포커스된 요소가
            disabled 가 되는 순간 blur 하므로 키보드 사용자는 Enter 직후 문서
            최상단으로 떨어진다. 중복 요청은 핸들러가 막는다. */}
        <p className="border-b border-line text-meta text-ink-muted">
          <button
            type="button"
            onClick={() => {
              if (!openingThread) onOpenThread();
            }}
            aria-busy={openingThread}
            className="block w-full truncate px-4 py-1 text-left hover:bg-surface-hover hover:text-ink focus-visible:focus-ring"
            data-testid="work-detail-thread"
          >
            {openingThread ? threadActionCopy.busy : threadActionCopy.idle} ·{" "}
            <span className="text-ink">{channelName}</span>
          </button>
        </p>

        {/* 이어하기 (ADR-0154 D3). 목표 줄 **바로 아래**이고 세션 정보보다
            위다: 이 자리에 온 사람이 고아 세션에서 물을 것은 「이걸 어떻게
            이어가지」이고, 그 답이 접힌 <details> 아래에 있으면 없는 것과
            같다. 재개가 성립하는 세션에는 아무것도 그리지 않는다 — 이 화면이
            이미 그 동사의 결과다. */}
        <HandoffSection
          session={session}
          hosts={hosts}
          onResumed={onResumed}
        />

        {/* The ledger facts, behind the platform's own disclosure control. They
            are reference material you check once, and as always-open chrome
            they cost more height than the ledger they describe. */}
        <details className="border-b border-line" data-testid="work-detail-meta">
          <summary className="cursor-pointer px-4 py-1 text-meta text-ink-muted hover:bg-surface-hover focus-visible:focus-ring">
            세션 정보 · {channelName}
          </summary>
          <dl className="pb-1">
            <MetaRow label="채널">{channelName}</MetaRow>
            <MetaRow label="도구">{session.tool}</MetaRow>
            <MetaRow label="시작한 사람">
              {owner?.displayName ?? "알 수 없는 멤버"}
            </MetaRow>
            <MetaRow label={session.endedAtMs === undefined ? "경과" : "실행 시간"}>
              <span data-numeric className="font-mono">
                {elapsed}
              </span>
            </MetaRow>
            {hostName !== null && <MetaRow label="호스트">{hostName}</MetaRow>}
            {session.exitCode !== undefined && (
              <MetaRow label="마지막 실행 결과">
                <span data-numeric className="font-mono">
                  {session.exitCode}
                </span>
              </MetaRow>
            )}
            {/* 관전 N is NOT repeated here. It lives in the 터미널 관전 block
                below, next to the sentence that says what the server actually
                counted (grants issued in the last minute, not people watching).
                A bare number in a meta list cannot carry that qualifier and
                would read as a headcount. */}
          </dl>
        </details>

        {/* 관전 (MOMO-619 / ADR-0126 D1). It sits above the ledger because it
            is the live surface and the ledger is the record, and it obeys the
            layout rule at the top of this file by being SMALL until asked: a
            header line plus one sentence, and the 320px terminal only after
            someone starts watching. Nothing here is fixed chrome; it scrolls
            with everything else.

            It is also deliberately ABOVE the unverified-host banner. That
            banner is a statement about the STEP LEDGER underneath it, and the
            terminal is a different path entirely: capability plus a direct
            socket to the host, no relay in between. Drawn under the banner it
            read as the thing the banner was doubting. */}
        {(session.status === "running" || session.status === "idle") &&
        hostOnline === false ? (
          /* 다음 행동은 **이 화면 안에** 있다 (R1 H2).
             앞 판은 「목록으로 돌아가 '세션 스레드'를 선택하면」이라고 적었는데,
             그 버튼은 이 티켓에서 동사가 선 행에서 사라졌다. 이 배너가 서는 조건
             (running|idle + 호스트 응답 없음)은 대개 재개가 성립하는 행이고,
             그런 행에는 스레드 버튼이 없다 — 돌아가 봐야 그 이름이 없다.
             그리고 애초에 돌아갈 이유가 없다: 진행 내역은 이 배너 바로 아래에
             있고, 채널 대화는 위의 세션 스레드 줄이 연다. */
          <InlineBanner
            tone="neutral"
            message="호스트 응답이 없어 터미널을 관전할 수 없습니다. 아래 진행 내역에서 이 세션에 기록된 단계를 계속 확인하세요."
            testId="work-host-offline"
          />
        ) : (
          <ObserverTerminal
            session={session}
            hostName={hostName}
            wide={wide}
            onWideChange={onWideChange}
          />
        )}

        {/* Fail-closed (X-11 / MOMO-546): a remote host's event relay is not a
            verified path yet, so this panel refuses to read its empty stream as
            a quiet session. It says "the steps below", not "everything here":
            the terminal above is not relayed and a live stream sitting under
            "여기 보이는 것은 세션 원장뿐입니다" made that sentence false
            (measured on momowebqa 2026-07-26, a workd host streaming into the
            terminal while the banner claimed only the ledger was visible). */}
        {trust !== "local" && (
          <InlineBanner
            tone="neutral"
            message={
              trust === "remote"
                ? // Tense follows the ledger. "실행 중인 세션입니다" under a
                  // 종료됨 chip is a small lie the banner used to tell on every
                  // finished remote session (seen on momowebqa 2026-07-26).
                  `원격 호스트에서 ${
                    session.status === "running"
                      ? "실행 중인"
                      : session.status === "idle"
                        ? "대기 중인"
                        : "실행된"
                  } 세션입니다. 진행 내역 중계는 아직 검증되지 않았으므로, 아래 단계 목록에는 세션 원장에 남은 것만 나옵니다.`
                : "이 세션의 호스트를 확인하지 못했습니다. 아래 진행 내역이 모두 도착했는지 보장할 수 없습니다."
            }
            testId="work-host-unverified"
          />
        )}

        <PlanBlock plan={folded.plan} />

        {query.isPending && <SkeletonRows rows={5} className="p-4" />}
        {query.error !== null && (
          <InlineBanner
            message="진행 내역을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="work-detail-error"
          />
        )}
        {truncated && (
          <InlineBanner
            tone="neutral"
            message="진행 내역이 많아 앞부분만 불러왔습니다. 최근 항목 일부는 아직 표시되지 않았고, 마지막 단계가 지금 실행 중인지도 확인할 수 없습니다."
            testId="work-detail-truncated"
          />
        )}
        {!query.isPending &&
          query.error === null &&
          folded.rows.length === 0 &&
          trust === "local" && (
            <EmptyInvite
              headline="아직 진행 내역이 없습니다."
              detail={emptyStepsDetail(session, hosts)}
              testId="work-detail-empty"
            />
          )}
        {folded.rows.length > 0 && (
          <ul data-testid="work-event-list">
            {folded.rows.map((row) => (
              <EventRow key={row.id} row={row} streamOpen={streamOpen} />
            ))}
          </ul>
        )}

        {/* The excerpt form is the last block of the SCROLL column, not a
            second pinned bar: it quotes the rows above it, and chrome that
            outgrows the reading area is the bug the layout rule at the top of
            this file exists to prevent. */}
        {excerptOpen && (
          <ExcerptForm
            session={session}
            rows={folded.rows}
            onDone={(sent) => {
              setExcerptOpen(false);
              if (sent) setShared(true);
              excerptRef.current?.focus();
            }}
          />
        )}
      </div>

      {shared && (
        <p
          role="status"
          className="border-t border-line px-4 py-2 text-meta text-ink-muted"
          data-testid="work-excerpt-done"
        >
          발췌를 세션 스레드에 공유했습니다.
        </p>
      )}

      <SessionActions
        session={session}
        excerptOpen={excerptOpen}
        excerptRef={excerptRef}
        onExcerpt={() => {
          setShared(false);
          setExcerptOpen((open) => !open);
        }}
      />
    </div>
  );
}
