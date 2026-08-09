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
  deliveryFailureLine,
  destinationError,
  disabledReasonLine,
  eventKindDetail,
  eventKindLabel,
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

  if (subscriptions.isPending) {
    return (
      <SectionShell title="이벤트 구독" lines={LINES}>
        <SkeletonRows rows={3} />
      </SectionShell>
    );
  }

  if (subscriptions.isError) {
    return (
      <SectionShell title="이벤트 구독" lines={LINES}>
        {isOperatorDenied(subscriptions.error) ? (
          <OperatorNotice
            who="이벤트 구독은 워크스페이스 오너나 관리자만 만들고 지울 수 있습니다."
            contact="외부로 보낼 이벤트가 필요하면 워크스페이스 관리자에게 요청하세요."
          />
        ) : (
          <InlineBanner
            message={eventSubscriptionErrorMessage("load", subscriptions.error)}
            actionLabel="다시 불러오기"
            onAction={() => void subscriptions.refetch()}
            testId="event-subscription-error"
          />
        )}
      </SectionShell>
    );
  }

  const rows = subscriptions.data;
  const busy = toggle.isPending || remove.isPending;

  return (
    <SectionShell title="이벤트 구독" lines={LINES}>
      {rows.length === 0 ? (
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

      <CreateForm
        workspaceId={workspaceId}
        offline={offline}
        onCreated={(created) => {
          setRowIssue(null);
          setIssued(created);
          invalidate();
        }}
      />

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
  // recoverable from the button alone.
  const subject = `${eventKindsLabel(subscription.eventKinds)} ${subscription.url}`;

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
      <p
        className="min-w-0 break-all font-mono text-meta text-ink-muted"
        data-numeric
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

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={offline || busy}
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
          ariaLabel={`${subject} 구독 지우기`}
          question="지우면 전송이 즉시 끊기고 되돌릴 수 없습니다."
          confirmLabel="지우기"
          disabled={offline || busy}
          onConfirm={onDelete}
          testId="event-subscription-delete"
        />
      </div>
    </li>
  );
}

// --- 만들기 ------------------------------------------------------------------

function CreateForm({
  workspaceId,
  offline,
  onCreated,
}: {
  workspaceId: string;
  offline: boolean;
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
                <span className="flex min-w-0 flex-col gap-px">
                  <span className="text-body text-ink">{eventKindLabel(kind)}</span>
                  <span className="break-keep text-meta text-ink-muted">
                    {eventKindDetail(kind)}
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
        <p
          className="break-keep text-meta text-danger"
          role="alert"
          data-testid="event-subscription-create-error"
        >
          {eventSubscriptionErrorMessage("create", create.error)}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
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
            this" rather than "this cannot be sent right now". */}
        <span className="break-keep text-meta text-ink-muted" role="status">
          {offline
            ? "서버와 연결이 끊겨 지금은 만들 수 없습니다. 다시 연결되면 그대로 보내집니다."
            : "만들면 서명 비밀이 한 번만 표시됩니다."}
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
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onDismiss}
          data-testid="event-subscription-secret-dismiss"
        >
          저장했습니다
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
