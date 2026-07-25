import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2 } from "lucide-react";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import {
  endWorkSession,
  sendThreadReply,
  uuidEq,
  type WorkHost,
  type WorkSession,
} from "@/lib/api";
import { useSession } from "@/app/session";
import { memberFor, type Directory } from "@/features/workspace/useWorkspace";
import { elapsedLabel } from "@/features/agents/agentWorkingSignal";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import { useSessionEvents } from "./useWorkSessions";
import {
  composeExcerpt,
  eventsForSession,
  foldSessionEvents,
  isSlowStep,
  ROW_STATE_LABEL,
  workHostName,
  workHostTrust,
  workSessionStatus,
  type WorkEventRow,
  type WorkSessionEvent,
} from "./workSessionModel";
import {
  clockLabel,
  ROW_STATE_CLASS,
  SESSION_STATUS_CLASS,
} from "./workSessionFormat";

// =============================================================================
// 세션 상세 (AX-3 / MOMO-618): what one work session did, in the order it did
// it, as the SERVER projection allows it to be told.
//
// Three things this surface deliberately does not do:
//   - it never renders `message.body` for a typed row. The server writes those
//     in English ("Approval requested", "ACP session update"); the Korean copy
//     is derived from the typed props instead (workSessionModel).
//   - it never offers a turn-scoped stop it cannot perform. There is no
//     server path from a work session to its agent run, so the action states
//     WHY rather than sitting there greyed out with no reason (reference survey
//     §3-A: the two unavailable reasons are shown apart).
//   - it never draws a remote host's silence as a quiet session. The normalised
//     ACP relay for workd hosts is still in flight (X-11 / MOMO-546), so an
//     unverified stream says so (fail-closed).
// =============================================================================

const EXCERPT_FIELD_ID = "work-excerpt-body";

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
 * and the third branch when it failed, with the state as a text-first chip.
 * The raw tool name never reaches the headline: it is internal vocabulary and
 * lives in the row's title attribute for a developer reading over a shoulder.
 */
function EventRow({ row }: { row: WorkEventRow }) {
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
            row.kind === "message" ? "text-body text-ink" : "text-meta text-ink"
          )}
          {...(row.toolName ? { title: row.toolName } : {})}
        >
          {row.headline}
        </span>
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
            "shrink-0 rounded-sm px-2 py-px text-timestamp font-medium",
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
      onSubmit={submit}
      className="flex flex-col gap-2 border-t border-line p-4"
      data-testid="work-excerpt-form"
    >
      <label htmlFor={EXCERPT_FIELD_ID} className="text-meta text-ink-muted">
        발췌 내용
      </label>
      <textarea
        id={EXCERPT_FIELD_ID}
        value={text}
        rows={8}
        onChange={(event) => setText(event.target.value)}
        disabled={pending}
        spellCheck={false}
        data-testid="work-excerpt-body"
        className="w-full resize-y rounded-sm border border-line-strong bg-surface-raised p-2 font-mono text-meta text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
 * The two write actions, and the difference between them stated in words.
 *
 * "이 턴만 중단" is what the reference calls Stop current turn: interrupt the
 * step without killing the process. momo's server has exactly one cancel, and
 * it takes an `agent_run` id; a work session exposes no run id anywhere (the
 * `run_id` inside its ACP events IS the session id, enforced server-side and
 * verified against momowebqa: /agent-runs/{sessionId}/cancel answers 404). So
 * the action is disabled WITH ITS REASON rather than being a dead control, and
 * 세션 종료 is offered beside it as the different thing it is.
 */
function SessionActions({
  session,
  onExcerpt,
  excerptOpen,
}: {
  session: WorkSession;
  onExcerpt: () => void;
  excerptOpen: boolean;
}) {
  const { session: auth, workspaceId } = useSession();
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ended, setEnded] = useState(false);

  const running = session.status === "running";
  const owner = uuidEq(session.memberId, auth.member.id);
  const endReason = !running
    ? "이미 끝난 세션입니다."
    : !owner
      ? "세션을 시작한 사람만 종료할 수 있습니다."
      : null;
  const stopReason = !running
    ? "실행 중인 세션에서만 중단할 수 있습니다."
    : "서버에 이 세션의 턴만 중단하는 경로가 아직 없습니다.";

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
    <div className="flex flex-col gap-2 border-t border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          data-testid="work-stop-turn"
        >
          이 턴만 중단
        </Button>
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
          type="button"
          variant="outline"
          size="sm"
          onClick={onExcerpt}
          aria-expanded={excerptOpen}
          data-testid="work-excerpt-open"
        >
          발췌 공유
        </Button>
      </div>

      {/* Each unavailable action states its own reason, on its own line. One
          merged sentence would leave the reader guessing which button it is
          about, and a bare disabled control leaves them guessing everything. */}
      <p className="text-meta text-ink-muted" data-testid="work-stop-reason">
        이 턴만 중단: {stopReason}
      </p>
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

export function WorkSessionDetail({
  session,
  hosts,
  directory,
  channelName,
  liveEvents,
  live,
  nowMs,
  onBack,
}: {
  session: WorkSession;
  hosts: WorkHost[] | undefined;
  directory: Directory;
  channelName: string;
  liveEvents: readonly WorkSessionEvent[];
  /** The realtime rail is connected, so what is on screen is confirmed. */
  live: boolean;
  nowMs: number;
  onBack: () => void;
}) {
  const { workspaceId } = useSession();
  const mine = useMemo(
    () => eventsForSession(liveEvents, session.id),
    [liveEvents, session.id]
  );
  const query = useSessionEvents(workspaceId, session, mine);
  const folded = useMemo(
    () => foldSessionEvents(query.events, session),
    [query.events, session]
  );

  const [excerptOpen, setExcerptOpen] = useState(false);
  const [shared, setShared] = useState(false);
  useEffect(() => {
    setExcerptOpen(false);
    setShared(false);
  }, [session.id]);

  const status = workSessionStatus(session);
  const trust = workHostTrust(session, hosts);
  const hostName = workHostName(session, hosts);
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
    live && trust === "local" && isSlowStep(session, lastSignalAtMs, nowMs);
  const elapsed = elapsedLabel(
    session.startedAtMs,
    session.endedAtMs ?? nowMs
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="work-detail">
      <div className="flex items-center gap-2 border-b border-line px-4 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label="세션 목록으로"
          data-testid="work-detail-back"
          className="flex size-6 shrink-0 items-center justify-center rounded-sm text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ArrowLeft className="size-4" />
        </button>
        <h3 className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {session.label}
        </h3>
        <span
          className={cn("shrink-0 rounded-sm px-2 py-px text-timestamp font-medium", SESSION_STATUS_CLASS[status.key])}
          data-testid="work-detail-status"
          data-status={status.key}
        >
          {status.label}
        </span>
      </div>

      <dl className="border-b border-line py-1">
        <MetaRow label="채널">{channelName}</MetaRow>
        <MetaRow label="도구">{session.tool}</MetaRow>
        <MetaRow label="시작한 사람">
          {owner?.displayName ?? "알 수 없는 멤버"}
        </MetaRow>
        <MetaRow label={session.endedAtMs === undefined ? "경과" : "실행 시간"}>
          <span
            data-numeric
            data-slow={slow ? "" : undefined}
            data-testid="work-detail-elapsed"
            className={cn(
              "font-mono",
              !live ? "text-ink-muted" : slow ? "text-warn" : "text-ink"
            )}
          >
            {elapsed}
          </span>
          {slow && (
            <span className="pl-2 text-meta text-warn" data-testid="work-detail-slow">
              10초 넘게 새 신호가 없습니다. 아직 실행 중입니다.
            </span>
          )}
        </MetaRow>
        {hostName !== null && <MetaRow label="호스트">{hostName}</MetaRow>}
        {session.exitCode !== undefined && (
          <MetaRow label="종료 코드">
            <span data-numeric className="font-mono">
              {session.exitCode}
            </span>
          </MetaRow>
        )}
        {session.observerGrantCount > 0 && (
          <MetaRow label="관전">
            <span data-numeric className="font-mono">
              {session.observerGrantCount}
            </span>
          </MetaRow>
        )}
      </dl>

      {/* Fail-closed (X-11 / MOMO-546): a remote host's event relay is not a
          verified path yet, so this panel refuses to read its empty stream as a
          quiet session. The ledger facts above are still the server's. */}
      {trust !== "local" && (
        <InlineBanner
          tone="neutral"
          message={
            trust === "remote"
              ? "원격 호스트에서 실행 중인 세션입니다. 진행 내역 중계는 아직 검증되지 않았으므로, 여기 보이는 것은 세션 원장뿐입니다."
              : "이 세션의 호스트를 확인하지 못했습니다. 진행 내역이 모두 도착했는지 보장할 수 없습니다."
          }
          testId="work-host-unverified"
        />
      )}

      <PlanBlock plan={folded.plan} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.isPending && <SkeletonRows rows={5} className="p-4" />}
        {query.error !== null && (
          <InlineBanner
            message="진행 내역을 불러오지 못했습니다."
            actionLabel="다시 시도"
            onAction={() => void query.refetch()}
            testId="work-detail-error"
          />
        )}
        {query.truncated && (
          <InlineBanner
            tone="neutral"
            message="진행 내역이 많아 앞부분만 불러왔습니다. 최근 항목 일부는 아직 표시되지 않았습니다."
            testId="work-detail-truncated"
          />
        )}
        {!query.isPending &&
          query.error === null &&
          folded.rows.length === 0 &&
          trust === "local" && (
            <EmptyInvite
              headline="아직 진행 내역이 없습니다."
              detail="에이전트가 첫 단계를 보고하면 여기에 한 줄씩 쌓입니다."
              testId="work-detail-empty"
            />
          )}
        {folded.rows.length > 0 && (
          <ul data-testid="work-event-list">
            {folded.rows.map((row) => (
              <EventRow key={row.id} row={row} />
            ))}
          </ul>
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

      {excerptOpen ? (
        <ExcerptForm
          session={session}
          rows={folded.rows}
          onDone={(sent) => {
            setExcerptOpen(false);
            if (sent) setShared(true);
          }}
        />
      ) : (
        <SessionActions
          session={session}
          excerptOpen={excerptOpen}
          onExcerpt={() => {
            setShared(false);
            setExcerptOpen(true);
          }}
        />
      )}
    </div>
  );
}
