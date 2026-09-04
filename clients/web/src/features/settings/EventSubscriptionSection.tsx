import { useEffect, useId, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
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
  const [removed, setRemoved] = useState("");
  const offlineReasonId = useId();
  // 이 목록이 잠기는 사실은 **둘**이다: 연결이 끊긴 것과, 이 목록이 방금 보낸
  // 앞선 쓰기. 둘째에는 문장이 없어서 그 이유로 잠긴 이웃 줄들은 사유 없이
  // 회색이었다 (#1542 · #1540 design-review M①). `HostedConnectionSection` 이
  // `CLEANUP_BUSY_NOTE` 로 세운 것과 같은 모양이다 — 문장은 한 번 서고, 그것
  // 때문에 잠긴 컨트롤들이 전부 그 하나를 가리키며, 한 번에 하나만 선다.
  const busyReasonId = useId();

  // The one-time secret can render below the fold on a short window, and it is
  // the only chance anyone gets to read it. Same landing as the invite code.
  const issuedRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!issued || !issuedRef.current) return;
    issuedRef.current.focus({ preventScroll: true });
    issuedRef.current.scrollIntoView({ block: "nearest" });
  }, [issued]);

  // Where the keyboard goes once a deleted row stops existing (R2 M-R1).
  //
  // `ConfirmButton` puts focus back on the trigger, which is right until the
  // round trip finishes and takes the trigger's row with it. Only this
  // component knows what the row was NEXT TO, so it picks the landing before
  // the delete goes out and applies it when the list actually changes: the row
  // below, else the row above, else the address field of the form — the one
  // control still on screen when the list empties.
  const listRef = useRef<HTMLUListElement | null>(null);
  const createUrlRef = useRef<HTMLInputElement | null>(null);
  const landing = useRef<string | null>(null);
  useEffect(() => {
    const target = landing.current;
    if (target === null) return;
    landing.current = null;
    if (target === "") {
      createUrlRef.current?.focus({ preventScroll: true });
      return;
    }
    listRef.current
      ?.querySelector<HTMLElement>(
        `[data-row-id="${CSS.escape(target)}"] [data-testid="event-subscription-toggle"]`
      )
      ?.focus({ preventScroll: true });
  }, [subscriptions.data]);

  const invalidate = () => void client.invalidateQueries({ queryKey });

  const toggle = useMutation({
    mutationFn: (input: { subscription: EventSubscription; enabled: boolean }) =>
      setEventSubscriptionEnabled(
        workspaceId,
        input.subscription.id,
        input.enabled
      ),
    onMutate: () => {
      setRowIssue(null);
      setRemoved("");
    },
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
    onMutate: () => {
      setRowIssue(null);
      setRemoved("");
    },
    onSuccess: (_deleted, subscription) => {
      // A deleted row's secret is dead material; do not leave it on screen.
      setIssued((current) =>
        current?.eventSubscription.id === subscription.id ? null : current
      );
      // Nothing on screen says an irreversible thing succeeded — the row simply
      // stops being there, which a screen reader does not narrate. Say it, and
      // name the row that went so it is not confusable with any other delete.
      setRemoved(`${rowSubject(subscription)} 구독을 지웠습니다.`);
      const rows = subscriptions.data ?? [];
      const gone = rows.findIndex((row) => row.id === subscription.id);
      const next = rows[gone + 1] ?? rows[gone - 1];
      landing.current = next?.id ?? "";
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
  // 진행은 잠금이 아니다 (#1403 리뷰 H-1 / #1486 문법). `busy` 는 목록 전체의
  // 사실이라 그것을 줄의 지우기 버튼에 그대로 넘기면, 지우기를 누른 그 줄이
  // **자기가 켠 busy 로 자신을 잠근다** — 유일한 진행 낱말이 흐림 아래에서 죽고
  // 낭독은 「지우는 중, 사용 안 함」이 된다.
  //
  // 그래서 진행은 목록이 아니라 **줄**의 사실로 좁힌다: 지금 날고 있는 삭제가
  // 어느 줄의 것인지는 mutation 이 들고 있는 variables 가 안다. 나머지 줄에게는
  // 그 쓰기가 여전히 잠금이고, 그것이 옳다 — 그 줄들은 진행 중이 아니라 앞선
  // 쓰기 때문에 지금 못 하는 것이다.
  const removingId = remove.isPending ? (remove.variables?.id ?? null) : null;
  // 켜고 끄기도 같은 사실이다 (#1541). `ConfirmButton` 이 아니라 raw 트리거라
  // #1502 의 좌표 밖에 있었고, 그래서 **한 줄 안에서 옆 버튼과 다른 문법**을 쓰고
  // 있었다: 옆의 지우기는 진행을 낱말로 말하는데 이쪽은 자기가 켠 `busy` 를
  // native `disabled` 로 되받아, 멈추기를 누른 줄이 멈춘 라벨을 든 채 흐려지고
  // tab order 에서 빠지며 방금 누른 손에서 초점이 <body> 로 떨어졌다.
  const togglingId = toggle.isPending
    ? (toggle.variables?.subscription.id ?? null)
    : null;

  // Every branch below is the LIST's answer, and only the list's. The form
  // outlives all of them (design review #1203 M5): a 503 on the read says
  // nothing about POST /event-subscriptions, and letting one failed GET take
  // the form away leaves a panel with no action on it at all. It also stops the
  // panel from jumping a form's height when three skeleton rows resolve.
  return (
    <SectionShell title="이벤트 구독" lines={LINES}>
      {subscriptions.isPending ? (
        <Skeleton ready={false} rows={3} />
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
          ref={listRef}
          className="flex min-w-0 flex-col overflow-hidden rounded-md border border-line"
          data-testid="event-subscription-list"
        >
          {rows.map((subscription, index) => (
            <SubscriptionRow
              key={subscription.id}
              subscription={subscription}
              offline={offline}
              busy={busy}
              removing={removingId === subscription.id}
              toggling={togglingId === subscription.id}
              // The reason a row's controls are grey is one fact, so it is
              // written once and pointed at from all of them (R2 N-R4). Three
              // rows made it three sentences; twenty would make it twenty.
              //
              // 사실이 둘이므로 문장도 둘이고(오프라인 · 앞선 쓰기), 한 줄이 둘
              // 다 쓴다 — 한 번에 하나만 서므로 화면에 문장은 언제나 하나다.
              offlineReasonId={offlineReasonId}
              busyReasonId={busyReasonId}
              writesLockReason={index === 0}
              issue={rowIssue?.id === subscription.id ? rowIssue.message : null}
              onToggle={(enabled) => toggle.mutate({ subscription, enabled })}
              onDelete={() => remove.mutate(subscription)}
            />
          ))}
        </ul>
      )}

      {/* A row that stops existing is the only sign the delete worked, and a
          screen reader does not narrate an absence (R2 M-R1). Not visible: the
          list already SHOWS the answer, and a standing line repeating it would
          be an announcement nobody asked to keep. House shape for exactly this
          — `sr-only` + `role="status"` — as in 사용량's quota block. */}
      <p
        className="sr-only"
        role="status"
        data-testid="event-subscription-removed"
      >
        {removed}
      </p>

      {/* The form is a second thing this panel governs, not more of the list.
          Without a heading the only word marking the boundary was the commit
          button's label, at the very bottom (design review #1203 N2). */}
      <Subsection title="새 구독 만들기">
        <CreateForm
          workspaceId={workspaceId}
          offline={offline}
          urlRef={createUrlRef}
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

const OFFLINE_ROW_REASON = "연결이 끊겨 지금은 멈추거나 지울 수 없습니다.";

/**
 * 형제 쓰기로 잠긴 줄들이 가리키는 두 번째 사유 (#1542).
 *
 * 위 문장과 **같은 자리**에 서고 한 번에 하나만 선다. 잠기는 사실이 둘인데 문장이
 * 하나뿐이던 동안, 이웃 줄의 회색은 아무 말도 하지 않았다 — 잠긴 컨트롤이
 * `aria-disabled` 로 tab order 에 남게 된 뒤로 그 침묵은 더 크게 들린다: 초점은
 * 닿는데 왜 못 하는지는 화면 어디에도 없다.
 *
 * 낱말이 「지우기」나 「멈추기」가 아니라 「누른 것」인 이유는
 * `CLEANUP_BUSY_NOTE` 가 적어 둔 것과 같다: 이 잠금을 켜는 쓰기는 둘이고(켜고
 * 끄기, 지우기) 그중 무엇이 날고 있는지 이 문장은 알지 못한다. 뒷문장은 위
 * 오프라인 문장의 동사를 그대로 받는다 — 같은 목록의 같은 두 행동이다.
 */
const BUSY_ROW_REASON =
  "앞서 누른 것이 아직 끝나지 않았습니다. 그것이 끝나면 이어서 멈추거나 지울 수 있습니다.";

/**
 * What tells two rows apart, and therefore what every per-row control has to
 * carry in its accessible name.
 *
 * Three "지우기" stops in a tab order are three identical stops, and the row
 * about to be destroyed is not recoverable from the button alone. Module scope
 * because the delete announcement names the row that went, and it has to be the
 * same name the button used (design review #1203 H2, R2 M-R1).
 */
function rowSubject(subscription: EventSubscription): string {
  return `${eventKindsLabel(subscription.eventKinds)} ${subscription.url}`;
}

function SubscriptionRow({
  subscription,
  offline,
  busy,
  removing,
  toggling,
  offlineReasonId,
  busyReasonId,
  writesLockReason,
  issue,
  onToggle,
  onDelete,
}: {
  subscription: EventSubscription;
  offline: boolean;
  busy: boolean;
  /**
   * 지금 날고 있는 삭제가 **이 줄의 것**인가.
   *
   * `busy` 와 갈라져 있는 이유가 이 goal 이다 (#1502): 목록의 사실(`busy`)로
   * 줄의 버튼을 잠그면 지우기를 누른 줄이 자기가 켠 진행으로 자신을 잠근다.
   * 진행은 낱말과 `aria-busy` 가 지고, 잠금은 나머지 줄들의 몫이다.
   */
  removing: boolean;
  /** 지금 날고 있는 켜고 끄기가 **이 줄의 것**인가. 같은 갈라내기 (#1541). */
  toggling: boolean;
  /** Id of the one offline sentence this list writes. */
  offlineReasonId: string;
  /** Id of the one 「앞선 쓰기」 sentence this list writes (#1542). */
  busyReasonId: string;
  /** This row is the one that renders both of them. */
  writesLockReason: boolean;
  issue: string | null;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const status = eventSubscriptionStatus(subscription);
  const state = eventSubscriptionState(subscription);
  const reason = disabledReasonLine(subscription);
  const failures = deliveryFailureLine(subscription.deliveryFailureCount);
  const subject = rowSubject(subscription);
  // A destructive question is being asked about THIS row; nothing else on the
  // row stands beside it while it is open (design review #1203 N4).
  const [confirming, setConfirming] = useState(false);

  /**
   * 잠긴 컨트롤이 가리키는 문장 하나 (#1542).
   *
   * 잠그는 사실이 둘이라 문장도 둘이고, **한 번에 하나만** 선다 — 한 잠금에 두
   * 이유를 대면 어느 쪽도 답이 아니게 된다. 오프라인이 이기는 이유는 정리 장부의
   * `lockReasonId` 와 같다: 오프라인이면 앞선 쓰기도 어차피 도착하지 못한다.
   *
   * `mine` 은 이 컨트롤 자신의 쓰기가 날고 있는가다. 참이면 이 컨트롤은 잠긴 것이
   * 아니라 **진행 중**이고, 진행 중에 「왜 못 하는지」를 읽어 주면 하지 못하는
   * 중이라는 뜻이 된다.
   *
   * 질문이 열려 있어 잠긴 경우(`confirming`)에 아무것도 고르지 않는 것은 그
   * 잠금의 사유가 **바로 옆에 서 있기 때문**이다: 질문 자체가 자기 이름을 가진
   * 노드로 그 자리에 있고, 그것을 문장으로 한 번 더 적으면 같은 말이 둘이 된다.
   */
  function lockReason(mine: boolean): string | undefined {
    if (offline) return offlineReasonId;
    return busy && !mine ? busyReasonId : undefined;
  }

  // 진행은 잠금이 아니다 (#1486 회전이 세운 문법 · #1541). 갈라내는 식은 이
  // 레포가 이미 쓰던 `locked = 잠금들 || (busy && !내_진행)` 이다.
  const toggleLocked = offline || confirming || (busy && !toggling);
  // 보이는 낱말이 상태를 지므로 낭독되는 이름도 그것을 따라 움직인다 —
  // `ConfirmButton` 이 `triggerText` 로 하는 것과 같은 규칙이다(WCAG 2.5.3:
  // 「전송 멈추기」가 이름인 채로 글자만 「멈추는 중」이 되면 label-in-name 이
  // 깨진다). 낱말꼴은 #1501 정본 — 멈추다·보내다는 고유어라 「-는 중」이다.
  const toggleText = toggling
    ? subscription.enabled
      ? "멈추는 중"
      : "보내는 중"
    : subscription.enabled
      ? "전송 멈추기"
      : "다시 보내기";

  return (
    <li
      className="flex min-w-0 flex-col gap-2 border-b border-line p-3 last:border-b-0"
      data-testid="event-subscription-row"
      data-row-id={subscription.id}
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
        {/* 진행은 낱말과 `aria-busy` 가 지고, 잠금은 `aria-disabled` + 흐림 +
            사유 + 가드가 진다 (#1486 회전 · #1541). native `disabled` 가 아닌
            이유는 둘이다: ①잠긴 버튼이 tab order 를 떠나면 바로 아래 사유 문장이
            키보드·AT 로 닿을 수 없는 곳에 놓이고, ②초점을 쥔 채 잠기면 방금 누른
            손에서 초점이 <body> 로 떨어진다. 옆의 지우기(`ConfirmButton`)가 이미
            그 문법이라, 이 버튼만 native `disabled` 인 동안 한 줄 안에 두 문법이
            서 있었다. 클릭을 막는 일은 가드가 진다. */}
        <Button
          type="button"
          variant="outline"
          size="sm"
          aria-disabled={toggleLocked || undefined}
          aria-busy={toggling || undefined}
          aria-label={`${subject} ${toggleText}`}
          aria-describedby={lockReason(toggling)}
          className={cn(toggleLocked && "opacity-50")}
          onClick={() => {
            if (toggleLocked || toggling) return;
            onToggle(!subscription.enabled);
          }}
          data-testid="event-subscription-toggle"
        >
          {toggleText}
        </Button>
        <ConfirmButton
          label="구독 지우기"
          subject={subject}
          describedBy={lockReason(removing)}
          question="지우면 전송이 즉시 끊기고 되돌릴 수 없습니다."
          confirmLabel="지우기"
          disabled={offline || (busy && !removing)}
          busy={removing}
          // 한자어 동작명사가 없는 자리라 고유어 동사가 「-는 중」을 쓴다 (#1501).
          // `subject` 가 함께 서 있으므로 목록 한복판에서도 낭독은 「…구독 지우는
          // 중」 — 어느 줄이 지워지는 중인지가 남는다.
          busyLabel="지우는 중"
          onConfirm={onDelete}
          onAskingChange={setConfirming}
          testId="event-subscription-delete"
        />
        {/* Both row controls go grey offline, so the reason stands with them —
            the same rule this file already applied to the create button, and
            the one it had not applied here (design review #1203 H3). A control
            that greys with nothing beside it reads as "you may not", which is a
            different and wrong sentence about a permission this reader has.

            Written by the first row and pointed at by every row's controls
            (R2 N-R4): one fact repeated per row is the same sentence three
            times on a three-row screen and twenty on a twenty-row one, and the
            control that needs it most is the one whose reader is standing on
            it — which `aria-describedby` reaches wherever the row sits. Also
            shown while a question is open, because the 지우기 in that question
            greys along with everything else (R2 N-R3).

            두 문장이 같은 자리에 서고 한 번에 하나만 그려진다 (#1542): 오프라인이
            아닐 때에만 「앞선 쓰기」 문장이 설 수 있으므로, 두 사실이 동시에 참인
            프레임에서도 화면의 사유는 하나다. 형제 정리 장부가 목록 머리에서 같은
            일을 한다(`OFFLINE_NOTE_ID` / `BUSY_NOTE_ID`). */}
        {offline && writesLockReason && (
          <span
            id={offlineReasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid="event-subscription-row-offline"
          >
            {OFFLINE_ROW_REASON}
          </span>
        )}
        {!offline && busy && writesLockReason && (
          <span
            id={busyReasonId}
            className="break-keep text-meta text-ink-muted"
            data-testid="event-subscription-row-busy"
          >
            {BUSY_ROW_REASON}
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
  urlRef,
  onReloadList,
  onCreated,
}: {
  workspaceId: string;
  offline: boolean;
  /** Landing for a delete that emptied the list — see `landing` above. */
  urlRef: React.Ref<HTMLInputElement>;
  /** The next move the unverified-create sentence names. See below. */
  onReloadList: () => void;
  onCreated: (created: CreatedEventSubscription) => void;
}) {
  const urlFieldId = useId();
  const kindsId = useId();
  // 잠긴 만들기가 가리키는 사유. 아래 오프라인 문장이 이 id 를 진다 — 목록 쪽
  // 두 사유(`offlineReasonId`/`busyReasonId`)와 같은 배선이고, 여기서 잠그는
  // 사실은 오프라인 하나뿐이라 문장도 하나다.
  const offlineReasonId = useId();
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
    // `aria-disabled` 는 클릭도 Enter 도 막지 않는다(그것이 요점이다 — 초점을
    // 잃지 않는다). 그래서 거절은 여기서 한다. 주소 칸에서 누른 Enter(암묵적
    // 제출)도 같은 쓰기를 내므로 `onClick` 이 아니라 폼이 가드를 진다.
    //
    // 잠금(`offline`)보다 먼저 서면 안 되는 것이 `setAttempted` 다: 보낼 수 없는
    // 프레임에서 아직 다 적지도 않은 주소에 대고 규칙을 말하는 꼴이 된다.
    if (offline || create.isPending) return;
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
          ref={urlRef}
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
                  "flex min-w-0 cursor-pointer items-start gap-2 border-b border-line p-2 last:border-b-0 hover:bg-surface-hover active:bg-surface-pressed",
                  checked && "bg-accent-soft"
                )}
              >
                {/* The NAME is the kind; the two clauses are the DESCRIPTION.
                    Wrapping everything in the label made the accessible name
                    the whole block — up to 104 characters that a screen reader
                    ran together as "승인 요청 메시지 본문과…", so the option lost
                    the word that identifies it (R2 N-R2). Splitting keeps both
                    clauses and gives the checkbox back its own name. */}
                <input
                  type="checkbox"
                  id={id}
                  name="eventKinds"
                  value={kind}
                  checked={checked}
                  aria-labelledby={`${id}-name`}
                  aria-describedby={`${id}-content ${id}-ids`}
                  onChange={(event) => toggleKind(kind, event.target.checked)}
                  className="mt-1 accent-accent focus-visible:focus-ring"
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
                  <span id={`${id}-name`} className="text-body text-ink">
                    {eventKindLabel(kind)}
                  </span>
                  <span
                    id={`${id}-content`}
                    className="break-keep text-meta text-ink-muted"
                  >
                    {payload.content}
                  </span>
                  <span
                    id={`${id}-ids`}
                    className="break-keep text-meta text-ink-muted"
                  >
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
        {/* 이 줄의 목록 쪽 형제들은 #1541 에서 이미 갈라졌는데 만들기만 남아
            있었다 (#1559). native `disabled` 는 진행 프레임에서 두 가지를 한꺼번에
            한다: 낱말(「만드는 중」)을 흐림 아래에 두어 「지금 일어나는 중」을
            「당신은 이걸 못 한다」로 바꿔 읽히게 하고, 버튼을 tab order 에서 빼
            바로 아래 오프라인 사유가 키보드·AT 로 닿지 않는 자리에 놓는다.
            잠그는 사실은 오프라인 하나이고, 진행은 낱말과 `aria-busy` 가 진다. */}
        <Button
          type="submit"
          size="sm"
          aria-disabled={offline || undefined}
          aria-busy={create.isPending || undefined}
          aria-describedby={offline ? offlineReasonId : undefined}
          className={cn(offline && "opacity-50")}
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
        {/* 「다시 연결되면 그대로 보내집니다」였다 — 지키지 못하는 약속이다
            (#1559 회전 1 · design-review #1595 H4). 이 클라이언트에 오프라인 큐는
            존재하지 않고(`networkMode` 도 `onlineManager` 도 없다), 위 `submit` 은
            `create.mutate()` 앞에서 하드 리턴하므로 오프라인에서 누른 것은
            어디에도 쌓이지 않는다. 다시 연결된 뒤 이 사람이 한 번 더 눌러야 한다.

            이 goal 이 이 span 에 id 를 달고 버튼의 `aria-describedby` 를 물리면서
            그 문장은 화면의 캡션에서 **AT 사용자가 듣는 권위 있는 사유**로
            올라갔다 — 거짓말을 승격시키는 배선이었다. 올바른 문장은 같은 커밋의
            형제 파일이 이미 갖고 있었다(`InviteSection.OFFLINE_CREATE_REASON` 의
            독스트링이 같은 판정을 적는다). */}
        <span
          id={offlineReasonId}
          className="break-keep text-meta text-ink-muted"
          role="status"
          data-testid="event-subscription-create-offline"
        >
          {offline
            ? "서버와 연결이 끊겨 지금은 만들 수 없습니다. 다시 연결되면 이어서 만들 수 있습니다."
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
      className="flex min-w-0 flex-col gap-3 rounded-md border border-ok bg-surface-raised p-4 focus-visible:focus-ring"
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
