import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, SkeletonRows } from "@/features/common/States";
import {
  EVENT_SUBSCRIPTION_KINDS,
  createEventSubscription,
  deleteEventSubscription,
  UNVERIFIED_CREATE_MESSAGE,
  deliveryFailureLine,
  destinationError,
  disabledReasonLine,
  eventKindLabel,
  eventKindPayload,
  eventKindsLabel,
  eventSubscriptionErrorMessage,
  eventSubscriptionState,
  eventSubscriptionStatus,
  listEventSubscriptions,
  normalizeDestination,
  setEventSubscriptionEnabled,
  type CreatedEventSubscription,
  type EventSubscription,
  type EventSubscriptionKind,
} from "@momo/core/features/settings/eventSubscriptions";
import { formatDay, isOperatorDenied } from "@momo/core/features/settings/model";
import {
  ConfirmButton,
  CopyButton,
  Field,
  KeyValueRows,
  OperatorNotice,
  SectionShell,
  StatusChip,
  Subsection,
} from "./SettingsFields";

// =============================================================================
// 설정 > 이벤트 구독 (#1202 워커 V, macOS MomoEventSubscriptionSettingsView 이식).
//
// The panel governs one thing: which workspace events oort pushes OUT to a
// third-party HTTPS address. Everything it draws is a projection of the four
// `event-subscriptions` operations; nothing new was added to the wire.
//
// Three things this surface is responsible for saying out loud, none of which
// the macOS original states in full and none of which is guessable from the UI:
//
//   1. 대상 = 워크스페이스. The delivery trigger has no channel predicate
//      (033_event_subscription.sql), so there is no channel picker to draw and
//      the scope is written as a sentence instead. Drawing a picker that the
//      server would ignore is the failure this panel exists to avoid.
//   2. 나가는 것 = 본문 포함. 멘션/승인 요청 projections carry the message body.
//      Each checkbox therefore names what that event actually sends, and no
//      event is pre-selected: opting a workspace's message text out of the
//      tenant is a decision, not a default.
//   3. 서명 비밀은 한 번. The secret is derived on create and never stored, so
//      it exists on this client for exactly one render pass. It lives in React
//      state, is never written to a query cache, a log, or storage, and the
//      block that shows it says what happens when it is gone.
//
// Permission is the server's answer, not this client's guess: a 403 on the list
// read swaps in the operator notice rather than a form whose save must fail.
// =============================================================================

const LINES = [
  "워크스페이스에서 일어난 일을 외부 HTTPS 주소로 보냅니다. 슬랙 알림, 사내 대시보드, 자동화 스크립트를 붙일 때 씁니다.",
  "구독은 워크스페이스 전체에 걸립니다. 채널 하나만 골라 보낼 수는 없습니다.",
];

type RowIssue = { id: string; message: string };

export function EventSubscriptionSection({
  workspaceId,
  offline,
}: {
  workspaceId: string;
  offline: boolean;
}) {
  const client = useQueryClient();
  const queryKey = ["settings", "event-subscriptions", workspaceId];
  const subscriptions = useQuery({
    queryKey,
    queryFn: () => listEventSubscriptions(workspaceId),
    retry: false,
  });

  const [issued, setIssued] = useState<CreatedEventSubscription | null>(null);
  const [rowIssue, setRowIssue] = useState<RowIssue | null>(null);

  // The one-time secret can render below the fold on a short window, and it is
  // the only chance anyone gets to read it. Same landing as the invite code.
  const issuedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!issued || !issuedRef.current) return;
    issuedRef.current.focus({ preventScroll: true });
    issuedRef.current.scrollIntoView({ block: "nearest" });
  }, [issued]);

  const invalidate = () => void client.invalidateQueries({ queryKey });

  const toggle = useMutation({
    mutationFn: (input: { subscription: EventSubscription; enabled: boolean }) =>
      setEventSubscriptionEnabled(
        workspaceId,
        input.subscription.id,
        input.enabled
      ),
    onMutate: () => setRowIssue(null),
    onSuccess: invalidate,
    onError: (error, input) =>
      setRowIssue({
        id: input.subscription.id,
        message: eventSubscriptionErrorMessage(
          input.enabled ? "enable" : "disable",
          error
        ),
      }),
  });

  const remove = useMutation({
    mutationFn: (subscription: EventSubscription) =>
      deleteEventSubscription(workspaceId, subscription.id),
    onMutate: () => setRowIssue(null),
    onSuccess: (_deleted, subscription) => {
      // A deleted row's secret is dead material; do not leave it on screen.
      setIssued((current) =>
        current?.eventSubscription.id === subscription.id ? null : current
      );
      invalidate();
    },
    onError: (error, subscription) =>
      setRowIssue({
        id: subscription.id,
        message: eventSubscriptionErrorMessage("delete", error),
      }),
  });

  // A 403 is the server answering the whole panel, so it replaces the whole
  // panel: drawing a create form whose save is guaranteed to fail is worse than
  // saying who can.
  if (subscriptions.isError && isOperatorDenied(subscriptions.error)) {
    return (
      <SectionShell title="이벤트 구독" lines={LINES}>
        <OperatorNotice
          who="이벤트 구독은 워크스페이스 오너나 관리자만 만들고 지울 수 있습니다."
          contact="외부로 보낼 이벤트가 필요하면 워크스페이스 관리자에게 요청하세요."
        />
      </SectionShell>
    );
  }

  const rows = subscriptions.data ?? [];
  const busy = toggle.isPending || remove.isPending;

  // Every branch below is the LIST's answer, and only the list's. The form
  // outlives all of them (design review #1203 M5): a 503 on the read says
  // nothing about POST /event-subscriptions, and letting one failed GET take
  // the form away leaves a panel with no action on it at all. It also stops the
  // panel from jumping a form's height when three skeleton rows resolve.
  return (
    <SectionShell title="이벤트 구독" lines={LINES}>
      {subscriptions.isPending ? (
        <SkeletonRows rows={3} />
      ) : subscriptions.isError ? (
        <InlineBanner
          message={eventSubscriptionErrorMessage("load", subscriptions.error)}
          actionLabel="다시 불러오기"
          onAction={() => void subscriptions.refetch()}
          testId="event-subscription-error"
        />
      ) : rows.length === 0 ? (
        <EmptyInvite
          headline="보내는 구독이 아직 없습니다."
          detail="아래에서 받을 주소와 이벤트를 고르면 그때부터 전송이 시작됩니다."
          className="px-0"
          testId="event-subscription-empty"
        />
      ) : (
        <ul
          className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
          data-testid="event-subscription-list"
        >
          {rows.map((subscription) => (
            <SubscriptionRow
              key={subscription.id}
              subscription={subscription}
              offline={offline}
              busy={busy}
              issue={rowIssue?.id === subscription.id ? rowIssue.message : null}
              onToggle={(enabled) => toggle.mutate({ subscription, enabled })}
              onDelete={() => remove.mutate(subscription)}
            />
          ))}
        </ul>
      )}

      {/* The form is a second thing this panel governs, not more of the list.
          Without a heading the only word marking the boundary was the commit
          button's label, at the very bottom (design review #1203 N2). */}
      <Subsection title="새 구독 만들기">
        <CreateForm
          workspaceId={workspaceId}
          offline={offline}
          onReloadList={() => void subscriptions.refetch()}
          onCreated={(created) => {
            setRowIssue(null);
            setIssued(created);
            invalidate();
          }}
        />
      </Subsection>

      {issued && (
        <OneTimeSecret
          focusRef={issuedRef}
          created={issued}
          onDismiss={() => setIssued(null)}
        />
      )}
    </SectionShell>
  );
}

// --- 목록 --------------------------------------------------------------------

function SubscriptionRow({
  subscription,
  offline,
  busy,
  issue,
  onToggle,
  onDelete,
}: {
  subscription: EventSubscription;
  offline: boolean;
  busy: boolean;
  issue: string | null;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const status = eventSubscriptionStatus(subscription);
  const state = eventSubscriptionState(subscription);
  const reason = disabledReasonLine(subscription);
  const failures = deliveryFailureLine(subscription.deliveryFailureCount);
  // The destination is what distinguishes two rows, so it is what a per-row
  // control has to carry in its accessible name: three "지우기" stops in a tab
  // order are three identical stops, and the row about to be destroyed is not
  // recoverable from the button alone. Passed as `subject` so it survives into
  // the confirmation step too (design review #1203 H2) — dropping the row's
  // identity at the moment the question is asked is the worst place to drop it.
  const subject = `${eventKindsLabel(subscription.eventKinds)} ${subscription.url}`;
  // A destructive question is being asked about THIS row; nothing else on the
  // row stands beside it while it is open (design review #1203 N4).
  const [confirming, setConfirming] = useState(false);

  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
      data-testid="event-subscription-row"
      data-state={state}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="min-w-0 break-keep text-body font-medium text-ink">
          {eventKindsLabel(subscription.eventKinds)}
        </span>
        <StatusChip tone={status.tone}>{status.label}</StatusChip>
        <span className="text-meta text-ink-muted" data-numeric>
          {formatDay(subscription.createdAtMs)} 만듦
        </span>
      </div>

      {/* The address is a token, not prose: it breaks anywhere and keeps the
          monospace column, so two rows pointing at the same host are told
          apart by their path rather than by squinting. */}
      {/* No `data-numeric`: tokens.md §4 gives tabular figures to things that
          ARE figures (the date below is one), not to everything that happens to
          be monospaced (design review #1203 N3). */}
      <p
        className="min-w-0 break-all font-mono text-meta text-ink-muted"
        data-testid="event-subscription-url"
      >
        {subscription.url}
      </p>

      {/* The count and the reason are two facts, not one sentence: joined into
          one line they read as a run-on whose number arrives after the advice
          it should have preceded. Tight rows (gap-px) so two lines cost one. */}
      {(failures || reason) && (
        <div
          className="flex min-w-0 flex-col gap-px"
          data-testid="event-subscription-reason"
        >
          {failures && (
            <p className="text-meta text-ink-muted" data-numeric>
              {failures}
            </p>
          )}
          {reason && (
            <p
              className={cn(
                "min-w-0 break-keep text-meta",
                state === "needs_review" ? "text-danger" : "text-ink-muted"
              )}
            >
              {reason}
            </p>
          )}
        </div>
      )}

      {issue && (
        <p className="break-keep text-meta text-danger" role="alert">
          {issue}
        </p>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offline || busy || confirming}
          aria-label={
            subscription.enabled
              ? `${subject} 전송 멈추기`
              : `${subject} 다시 보내기`
          }
          onClick={() => onToggle(!subscription.enabled)}
          data-testid="event-subscription-toggle"
        >
          {subscription.enabled ? "전송 멈추기" : "다시 보내기"}
        </Button>
        <ConfirmButton
          label="구독 지우기"
          subject={subject}
          question="지우면 전송이 즉시 끊기고 되돌릴 수 없습니다."
          confirmLabel="지우기"
          disabled={offline || busy}
          onConfirm={onDelete}
          onAskingChange={setConfirming}
          testId="event-subscription-delete"
        />
        {/* Both row controls go grey offline, so the reason stands with them —
            the same rule this file already applied to the create button, and
            the one it had not applied here (design review #1203 H3). A control
            that greys with nothing beside it reads as "you may not", which is a
            different and wrong sentence about a permission this reader has. */}
        {offline && !confirming && (
          <span
            className="break-keep text-meta text-ink-muted"
            data-testid="event-subscription-row-offline"
          >
            연결이 끊겨 지금은 멈추거나 지울 수 없습니다.
          </span>
        )}
      </div>
    </li>
  );
}

// --- 만들기 ------------------------------------------------------------------

function CreateForm({
  workspaceId,
  offline,
  onReloadList,
  onCreated,
}: {
  workspaceId: string;
  offline: boolean;
  /** The next move the unverified-create sentence names. See below. */
  onReloadList: () => void;
  onCreated: (created: CreatedEventSubscription) => void;
}) {
  const urlFieldId = useId();
  const kindsId = useId();
  const [url, setUrl] = useState("");
  const [kinds, setKinds] = useState<EventSubscriptionKind[]>([]);
  // Only after a submit attempt: complaining about an address while it is still
  // being typed is a rule stated at the worst possible moment.
  const [attempted, setAttempted] = useState(false);

  const create = useMutation({
    mutationFn: () =>
      createEventSubscription(workspaceId, { url, eventKinds: kinds }),
    onSuccess: (created) => {
      setUrl("");
      setKinds([]);
      setAttempted(false);
      onCreated(created);
    },
  });

  const urlProblem = destinationError(url);
  const noKinds = kinds.length === 0;
  const createFailure = create.isError
    ? eventSubscriptionErrorMessage("create", create.error)
    : null;

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setAttempted(true);
    if (!normalizeDestination(url) || noKinds) return;
    create.mutate();
  }

  function toggleKind(kind: EventSubscriptionKind, on: boolean) {
    setKinds((current) =>
      on
        ? [...current, kind]
        : current.filter((existing) => existing !== kind)
    );
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-3"
      onSubmit={submit}
      data-testid="event-subscription-create-form"
    >
      <Field
        label="받을 주소"
        htmlFor={urlFieldId}
        hint="운영 서버는 공개 https 주소만 받습니다. 저장 전에 서버가 주소를 확인하며, 사내망이나 로컬 주소는 거절됩니다."
        error={attempted ? urlProblem : null}
      >
        <Input
          id={urlFieldId}
          name="url"
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder="https://hooks.example.com/oort"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          className="font-mono"
          data-testid="event-subscription-url-input"
        />
      </Field>

      <fieldset
        className="flex min-w-0 flex-col gap-1"
        disabled={create.isPending}
        aria-describedby={`${kindsId}-hint`}
        data-testid="event-subscription-kinds"
      >
        <legend className="pb-1 text-meta text-ink-muted">보낼 이벤트</legend>
        {/* Native checkboxes in one bordered group: this bundle carries no Radix
            Checkbox, and the platform control already gives the space toggle,
            the group a screen reader announces, and a focus ring. A card per
            option would be the web-card tell and cost the density. */}
        <div className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line">
          {EVENT_SUBSCRIPTION_KINDS.map((kind) => {
            const id = `${kindsId}-${kind}`;
            const checked = kinds.includes(kind);
            const payload = eventKindPayload(kind);
            return (
              <label
                key={kind}
                htmlFor={id}
                className={cn(
                  "flex min-w-0 cursor-pointer items-start gap-2 border-b border-line p-2 last:border-b-0",
                  checked ? "bg-accent-soft" : "hover:bg-surface-hover"
                )}
              >
                <input
                  type="checkbox"
                  id={id}
                  name="eventKinds"
                  value={kind}
                  checked={checked}
                  onChange={(event) => toggleKind(kind, event.target.checked)}
                  className="mt-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                />
                {/* Two clauses, and every option gets both: what content
                    leaves, then which identifiers ride along. A partial
                    enumeration wearing a complete list's grammar was the H1 of
                    the #1203 review — 멘션 shipped `mention_member_ids` without
                    saying so, and named 채널/작성자 while 승인 요청 kept quiet
                    about the identical fields. The shape is the promise: three
                    options answering the same two questions in the same order
                    cannot silently answer one of them for only some of them. */}
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="text-body text-ink">{eventKindLabel(kind)}</span>
                  <span className="break-keep text-meta text-ink-muted">
                    {payload.content}
                  </span>
                  <span className="break-keep text-meta text-ink-muted">
                    {payload.identifiers}
                  </span>
                </span>
              </label>
            );
          })}
        </div>
        <p id={`${kindsId}-hint`} className="break-keep text-meta text-ink-muted">
          고른 이벤트는 워크스페이스 밖으로 나갑니다. 받는 쪽을 믿을 수 있을 때만
          만드세요.
        </p>
        {attempted && noKinds && (
          <p className="text-meta text-danger" role="alert">
            보낼 이벤트를 하나 이상 고르세요.
          </p>
        )}
      </fieldset>

      {create.isError && (
        <div className="flex min-w-0 flex-col items-start gap-2">
          <p
            className="break-keep text-meta text-danger"
            role="alert"
            data-testid="event-subscription-create-error"
          >
            {createFailure}
          </p>
          {/* The unverified-create sentence tells the reader to re-read the
              list and delete a row if it is there. That instruction had no
              control on a panel that loaded fine (design review #1203 M1) —
              the only 다시 불러오기 lived in the error state, which is exactly
              the state this is not. It appears for that message alone: a reload
              button next to a 400 would be advice for a different problem. */}
          {createFailure === UNVERIFIED_CREATE_MESSAGE && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onReloadList}
              data-testid="event-subscription-create-reload"
            >
              목록 다시 불러오기
            </Button>
          )}
        </div>
      )}

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={offline || create.isPending}
          aria-busy={create.isPending || undefined}
          data-testid="event-subscription-create"
        >
          {create.isPending ? "만드는 중" : "구독 만들기"}
        </Button>
        {/* The button is disabled offline, so the reason has to be next to it:
            a control that went grey with no sentence reads as "you may not do
            this" rather than "this cannot be sent right now".

            Two nodes, not one with a switching role (design review #1203 N1):
            the standing hint is a static caption and had no business being a
            live region, while the offline sentence is the one thing here worth
            announcing. An EMPTY live region that fills is the shape that
            announces reliably, and it says nothing at all while online. */}
        {!offline && (
          <span className="break-keep text-meta text-ink-muted">
            만들면 서명 비밀이 한 번만 표시됩니다.
          </span>
        )}
        <span
          className="break-keep text-meta text-ink-muted"
          role="status"
          data-testid="event-subscription-create-offline"
        >
          {offline
            ? "서버와 연결이 끊겨 지금은 만들 수 없습니다. 다시 연결되면 그대로 보내집니다."
            : ""}
        </span>
      </div>
    </form>
  );
}

// --- 서명 비밀 (1회) ---------------------------------------------------------

/**
 * The create response is the only place this value ever exists on the client:
 * the server derives it from a non-secret reference and stores neither. It is
 * held in component state, never in the query cache, and disappears with the
 * panel. The block therefore has to be findable (it takes focus), copyable in
 * one action, and honest about what happens when it is dismissed.
 */
function OneTimeSecret({
  focusRef,
  created,
  onDismiss,
}: {
  /** Not named `ref`: React 18 does not hand a bare `ref` prop to a function
   *  component, so it would silently arrive as `undefined` and the block would
   *  never take focus. */
  focusRef: React.Ref<HTMLDivElement>;
  created: CreatedEventSubscription;
  onDismiss: () => void;
}) {
  return (
    <div
      ref={focusRef}
      tabIndex={-1}
      role="status"
      className="flex min-w-0 flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      data-testid="event-subscription-secret"
    >
      <p className="break-keep text-body text-ink">
        구독을 만들었습니다. 서명 비밀은 이 화면에서만 볼 수 있으니 지금
        옮겨두세요.
      </p>

      <KeyValueRows
        rows={[
          { key: "서명 비밀", value: created.secret, numeric: true },
          { key: "받을 주소", value: created.eventSubscription.url, numeric: true },
          {
            key: "보낼 이벤트",
            value: eventKindsLabel(created.eventSubscription.eventKinds),
            prose: true,
          },
          {
            key: "서명 방식",
            value: `${created.algorithm}, 버전 ${created.signatureVersion}`,
            numeric: true,
          },
        ]}
      />

      <div className="flex flex-wrap items-center gap-2">
        <CopyButton
          value={created.secret}
          label="서명 비밀 복사"
          subject={created.eventSubscription.url}
          testId="event-subscription-copy-secret"
        />
        {/* "저장했습니다" was a past-tense statement, so it read as a caption
            beside a copy button rather than the control that destroys the only
            copy of this value (design review #1203 M3). Ghost is the house
            shape for 취소·닫기 and those read as controls because they are
            verbs; this one now is too. The accessible name says which 닫기,
            since the settings header has one as well. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="서명 비밀 닫기"
          onClick={onDismiss}
          data-testid="event-subscription-secret-dismiss"
        >
          닫기
        </Button>
      </div>

      <p className="break-keep text-meta text-ink-muted">
        받는 쪽은 이 비밀로 요청 서명을 확인합니다. 비밀 관리 도구에 넣은 뒤 이
        블록을 닫으세요. 다시 볼 수 없으며, 잃어버리면 구독을 지우고 새로
        만들어야 합니다. 목록에는 주소와 상태만 남습니다.
      </p>
    </div>
  );
}
