import "./expressionSet.css";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Check, ImageOff } from "lucide-react";
import { isAnimatedExpression, LEGACY_EXPRESSION_KIND, recommendExpressionKind } from "@momo/core/features/expressions/kind";
import {
  expressionSetCard, expressionSetChoices, expressionSetSlotDraft, readySlots,
  type ExpressionSetApproval, type ExpressionSetGrayCode, type ExpressionSetResult, type ExpressionSetSlot,
} from "@momo/core/features/expressions/set";
import { expressionDecisionRequest, expressionSetResultFromReceipt } from "@momo/core/features/expressions/setWire";
import { EXPRESSION_KINDS, type ExpressionKind } from "@momo/core/features/expressions/types";
import { newDecisionId } from "@momo/core/features/timeline/approvalDecision";
import type { AgentApprovalCard, ApprovalStatus } from "@momo/core/features/timeline/agentCardModel";
import type { MessageKey } from "@momo/core/i18n";
import { Button } from "@/design/ui/button";
import { SegmentedControl } from "@/design/ui/segmented-control";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { rememberSettledApproval, useSettledApproval } from "@/features/timeline/settledApprovals";
import { useExpressions } from "./context";
import { ExpressionImage } from "./ExpressionImage";
import { ExpressionSetReferences } from "./ExpressionSetReferences";
import { Decided, OPEN, sendSetDecision, Status, type PlainKey } from "./setCards";

/**
 * 세트 카드 (ADR-0218 §12 L5~L7, #5462): 팀 AI가 올린 그림 세트를 사람이 **한 번** 승인하고, 서버는 고른 것만 등록한다.
 * 대화에 서는 길은 기존 행동 승인 카드다(`AgentCard`가 `expression.set.create`를 여기로 보낸다). 새 경로·새 화면 자리는 없다.
 *
 * 규칙(코어 `expressionSetCard`·`expressionSetChoices`가 판정하고 이 화면은 그린다):
 *  - 기본은 준비된 칸 전부 선택이다. 칸별로 빼고 다시 넣을 수 있고, 선택이 0이면 등록은 꺼진다. 한 세트에는 두 번째 승인이 없다.
 *  - 회색 칸(L7)은 같은 크기의 자리를 차지하지만 선택·올리기·다시 시도가 없다. 사유는 한 줄이고 재시도를 권하지 않는다.
 *  - 종류(작은/큰 이모티콘)는 고른 칸 전체에 한 번 정한다. 고르지 않으면 칸마다 서버와 같은 추천(J4)을 보낸다.
 *  - 결과 줄은 숫자만이다(L5.5). 같은 이름·정원 초과로 건너뛴 것은 서버가 건너뛰고 개수만 말한다.
 *  - 이름 목록이 모두 보인다(L9): 한 번의 승인이 최대 40개 이름을 영구 예약하므로 줄이거나 접지 않는다.
 *
 * 이 파일에는 상태 이름 같은 문자열이 없다(직접 문구 장부: 새 파일은 0줄). 표의 키는 속성 이름이고, 갈래는 숫자, 모양은 `expressionSet.css`가 읽는다.
 */
const GRID_COLUMNS = 4;
/** 방향키: 칸 수만큼 이동. 키 이름은 속성 이름이다. */
const STEP = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: GRID_COLUMNS, ArrowUp: -GRID_COLUMNS } as const;
/** Home은 첫 칸, End는 끝 칸(-1). */
const EDGE = { Home: 0, End: -1 } as const;
/** 종류 고르개에서 아무 것도 고르지 않은 상태의 값: 고른 칸의 추천이 갈릴 때. 글자가 없어서 문구로 세지지 않고, 두 선택지 어느 것과도 같지 않다. */
const MIXED = "-";

const GRAY_LINE = {
  refused: "expressions.set.grayRefused",
  failed: "expressions.set.grayFailed",
  not_made: "expressions.set.grayNotMade",
  base_missing: "expressions.set.grayBaseMissing",
} as const satisfies Record<ExpressionSetGrayCode, PlainKey>;
/** 이 빌드가 모르는 사유는 「만들지 못했어요」다: 빈 줄이 아니다. */
const grayKey = (code: ExpressionSetGrayCode): PlainKey => GRAY_LINE[code] ?? GRAY_LINE.failed;
const KIND_LABEL = { emoji: "expressions.kind.emoji", sticker: "expressions.kind.sticker" } as const satisfies Record<ExpressionKind, MessageKey>;
/** 끝난 카드가 하는 말(결과를 읽을 수 없을 때). */
const SETTLED_LINE = {
  pending: "expressions.set.settledExpired",
  approved: "expressions.set.settledDone",
  rejected: "expressions.set.settledDeclined",
  expired: "expressions.set.settledExpired",
  cancelled: "expressions.set.settledDone",
} as const satisfies Record<ApprovalStatus, PlainKey>;

function chunk<T>(items: readonly T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let at = 0; at < items.length; at += size) rows.push(items.slice(at, at + size));
  return rows;
}

export function ExpressionSetApprovalCard({ card, set, result }: { card: AgentApprovalCard; set: ExpressionSetApproval | null; result: ExpressionSetResult | null }) {
  const { store, offline } = useExpressions();
  const formatMessage = useFormatMessage();
  const remembered = useSettledApproval(card.approvalId);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [errorLine, setErrorLine] = useState<PlainKey | null>(null);
  const [localResult, setLocalResult] = useState<ExpressionSetResult | null>(null);
  const [kindChoice, setKindChoice] = useState<ExpressionKind | null>(null);
  const [active, setActive] = useState(0);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());
  const tiles = useRef<Array<HTMLButtonElement | null>>([]);

  // 다른 워크스페이스의 묶음은 그리지 않는다: 이 저장소의 그림 경로로는 열 수 없고, 열 수 있는 척하면 안 된다.
  const usable = set !== null && store !== null && set.workspaceId === store.workspaceId ? set : null;
  const ready = useMemo(() => (usable ? readySlots(usable) : []), [usable]);
  const readyIndexes = useMemo(() => ready.map((slot) => slot.index), [ready]);
  const [selected, setSelected] = useState<ReadonlySet<number>>(() => new Set(readyIndexes));
  // 다른 세트가 오면 기본(전부)으로 돌아간다. 같은 세트의 메시지 갱신은 고른 것을 지킨다.
  const setId = usable?.setId ?? null;
  useEffect(() => { setSelected(new Set(readyIndexes)); setKindChoice(null); setActive(0); }, [setId]); // eslint-disable-line react-hooks/exhaustive-deps
  const drafts = useMemo(() => new Map(ready.map((slot) => [slot.index, expressionSetSlotDraft(usable!, slot)])), [ready, usable]);
  const recommended = useMemo(() => new Map(ready.map((slot) => [slot.index, recommendExpressionKind(slot.media.large)])), [ready]);

  useEffect(() => {
    const ends = [card.expiresAtMs, usable?.expiresAtMs].filter((value): value is number => value !== undefined && value > 0);
    if (ends.length === 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, Math.min(...ends) - Date.now())));
    return () => window.clearTimeout(timer);
  }, [card.expiresAtMs, usable?.expiresAtMs]);

  const status = remembered?.status ?? card.status;
  // 열려 있다 = 아직 결정되지 않았고 카드의 기한도 묶음의 기한도 지나지 않았다. 기한은 시계가 아니라 서버가 박은 값이다.
  const pending = OPEN[status] && (!card.expiresAtMs || now < card.expiresAtMs) && (usable === null || now < usable.expiresAtMs);
  const view = usable ? expressionSetCard(usable, now, pending) : null;
  const slots = usable ? [...usable.slots].sort((a, b) => a.index - b.index) : [];
  const stranger = usable !== null && usable.subjectMemberId !== null && usable.subjectMemberId !== store?.memberId;
  const blocked = busy || offline;
  // 종류: 사람이 고른 값이 있으면 고른 칸 전부에, 없으면 칸마다 추천(서버가 같은 규칙으로 정할 값)을 보낸다.
  const kinds = Object.fromEntries([...selected].map((index) => [index, kindChoice ?? recommended.get(index) ?? LEGACY_EXPRESSION_KIND])) as Record<number, ExpressionKind>;
  const choices = usable && pending ? expressionSetChoices(usable, now, { only: [...selected], kinds }) : null;
  const picked = choices?.length ?? 0;
  const canRegister = picked > 0 && !blocked && !stranger;
  const picks = new Set([...selected].map((index) => recommended.get(index)));
  const shownKind: string = kindChoice ?? (picks.size === 1 ? [...picks][0]! : MIXED);
  const allSelected = readyIndexes.length > 0 && readyIndexes.every((index) => selected.has(index));

  function toggle(index: number) {
    if (!pending || busy) return;
    setSelected((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  }
  function onGridKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = Object.hasOwn(STEP, event.key) ? STEP[event.key as keyof typeof STEP] : undefined;
    const edge = Object.hasOwn(EDGE, event.key) ? EDGE[event.key as keyof typeof EDGE] : undefined;
    if (step === undefined && edge === undefined) return;
    event.preventDefault();
    const from = tiles.current.findIndex((node) => node !== null && node === document.activeElement);
    const to = edge !== undefined ? (edge < 0 ? slots.length - 1 : edge) : from < 0 ? 0 : from + (step ?? 0);
    if (to < 0 || to >= slots.length) return;
    setActive(to);
    tiles.current[to]?.focus();
  }
  async function decide(approve: boolean) {
    if (!store || !card.approvalId || !pending || lock.current || offline) return;
    if (approve && (!choices || stranger)) return;
    lock.current = true; setBusy(true); setErrorLine(null);
    // 같은 결정을 다시 누르면 같은 키라 서버가 첫 영수증을 돌려준다. 고른 것이 바뀌면 다른 결정이라 새 키다.
    const pin = approve ? JSON.stringify(choices) : "";
    const key = keys.current.get(pin) ?? newDecisionId(); keys.current.set(pin, key);
    try {
      const outcome = await sendSetDecision(expressionDecisionRequest(store.base, card.approvalId, key, approve ? { approve: true, expressionChoices: choices } : { approve: false }));
      if (outcome.kind === Decided.failed) { if (outcome.freshKey) keys.current.delete(pin); setErrorLine(outcome.line); return; }
      if (outcome.kind === Decided.settled) { rememberSettledApproval(card.approvalId, { status: outcome.status }); return; }
      if (approve) setLocalResult(expressionSetResultFromReceipt(outcome.receipt));
      rememberSettledApproval(card.approvalId, { status: approve ? Status.approved : Status.rejected });
      await store.refresh();
    } finally { lock.current = false; setBusy(false); }
  }

  if (!store) return <p className="text-body">{formatMessage("expressions.set.unreadable")}</p>;
  const title = usable?.title ?? card.title;
  const shownResult = localResult ?? result;
  const settledLine = shownResult
    ? shownResult.skipped.length === 0
      ? formatMessage("expressions.set.resultSaved", { count: shownResult.registered.length })
      : formatMessage("expressions.set.resultSavedSkipped", { saved: shownResult.registered.length, skipped: shownResult.skipped.length })
    : formatMessage(SETTLED_LINE[status]);
  const summary = view
    ? [formatMessage("expressions.set.summaryReady", { count: view.ready }), view.gray > 0 ? formatMessage("expressions.set.summaryGray", { count: view.gray }) : null].filter(Boolean).join(" · ")
    : null;

  return <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3" aria-label={title} data-testid="expression-set" data-open={String(pending)}>
    <header className="flex flex-col gap-1">
      <p className="text-body font-semibold">{title}</p>
      {summary !== null && pending && <p className="text-meta text-ink-muted" data-numeric data-testid="expression-set-summary">{summary}</p>}
    </header>
    {pending && usable === null && <>
      <p role="alert" className="text-body" data-testid="expression-set-unreadable">{formatMessage("expressions.set.unreadable")}</p>
      <div className="flex justify-end">
        <Button type="button" variant="secondary" disabled={blocked} onClick={() => { void decide(false); }} data-testid="expression-set-decline">{formatMessage("expressions.set.decline")}</Button>
      </div>
    </>}
    {pending && usable !== null && <>
      {usable.references.length > 0 && <div className="flex flex-wrap items-center gap-3" data-testid="expression-set-source">
        <ExpressionSetReferences references={usable.references} workspaceId={store.workspaceId} channelId={card.channelId} offline={offline} />
        <span className="text-meta text-ink-muted" data-numeric>{formatMessage("expressions.set.referenceCount", { count: usable.references.length })}</span>
      </div>}
      <p className="break-words text-meta text-ink-muted" data-testid="expression-set-prompt">{formatMessage("expressions.set.agentText", { prompt: usable.prompt })}</p>
      <div role="grid" aria-label={formatMessage("expressions.set.gridLabel", { title: usable.title })} aria-multiselectable="true" onKeyDown={onGridKeyDown} className="flex flex-col gap-2" data-testid="expression-set-grid">
        {chunk(slots, GRID_COLUMNS).map((row, rowAt) => <div role="row" key={row[0]?.index ?? rowAt} className="grid grid-cols-4 gap-2">
          {row.map((slot, columnAt) => {
            const position = rowAt * GRID_COLUMNS + columnAt;
            return <SetTile key={slot.index} slot={slot} position={position} active={active === position} checked={selected.has(slot.index)} editable={!busy}
              draft={drafts.get(slot.index) ?? null} onToggle={() => toggle(slot.index)} onFocusTile={() => setActive(position)} buttonRef={(node) => { tiles.current[position] = node; }} />;
          })}
        </div>)}
      </div>
      {readyIndexes.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="text-meta">{formatMessage("expressions.kind.legend")}</span>
          <SegmentedControl legend={formatMessage("expressions.kind.legend")} testId="expression-set-kind" className="min-w-0" disabled={blocked || picked === 0}
            value={shownKind} onValueChange={(next) => { if (next !== MIXED) setKindChoice(next as ExpressionKind); }}
            options={EXPRESSION_KINDS.map((value) => ({ value: value as string, label: formatMessage(KIND_LABEL[value]) }))} />
        </div>
        {readyIndexes.length > 1 && <Button type="button" variant="ghost" size="sm" disabled={blocked} data-testid="expression-set-select-all"
          onClick={() => setSelected(allSelected ? new Set() : new Set(readyIndexes))}>{formatMessage(allSelected ? "expressions.set.selectNone" : "expressions.set.selectAll")}</Button>}
      </div>}
      <p className="text-meta text-ink-muted" data-testid="expression-set-rights">{formatMessage("expressions.set.rights")}</p>
      {stranger && <p className="text-meta text-ink-muted">{formatMessage("expressions.set.faceOnly")}</p>}
      {offline && <p role="status" className="text-meta text-ink-muted">{formatMessage("expressions.set.offline")}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="secondary" disabled={blocked} onClick={() => { void decide(false); }} data-testid="expression-set-decline">{formatMessage("expressions.set.decline")}</Button>
        <Button type="button" disabled={!canRegister} onClick={() => { void decide(true); }} data-testid="expression-set-register">
          {busy ? formatMessage("expressions.set.registering") : formatMessage("expressions.set.register", { count: picked })}
        </Button>
      </div>
    </>}
    {!pending && <p role="status" className="text-body" data-testid="expression-set-settled" data-numeric>{settledLine}</p>}
    {errorLine !== null && <p role="alert" className="text-meta text-danger" data-testid="expression-set-error">{formatMessage(errorLine)}</p>}
  </section>;
}

/**
 * 격자의 한 칸. 준비된 칸은 눌러서 고르고 빼는 단추(`aria-pressed`)이고, 회색 칸은 같은 자리를 차지하되 `aria-disabled`다:
 * 방향키가 건너뛰지 않게 포커스는 받고(사유를 읽어 주려고), 눌러도 아무 일도 없다. 구분은 색에만 기대지 않는다(점선·아이콘·글).
 * 고른 상태는 체크 상자와 굵은 테두리가 말하고(`expressionSet.css`가 `aria-pressed`를 읽는다), 읽는 쪽에는 `aria-pressed`와 칸의 `aria-selected`가 말한다.
 */
function SetTile({ slot, position, active, checked, editable, draft, onToggle, onFocusTile, buttonRef }: {
  slot: ExpressionSetSlot; position: number; active: boolean; checked: boolean; editable: boolean; draft: ReturnType<typeof expressionSetSlotDraft> | null;
  onToggle: () => void; onFocusTile: () => void; buttonRef: (node: HTMLButtonElement | null) => void;
}) {
  const formatMessage = useFormatMessage();
  const gray = slot.code !== null;
  const reason = gray ? formatMessage(grayKey(slot.code)) : null;
  const label = gray
    ? formatMessage("expressions.set.cellGray", { reason: reason!, displayName: slot.displayName })
    : formatMessage("expressions.set.cellReady", { displayName: slot.displayName, name: slot.name });
  return <div role="gridcell" aria-selected={gray ? undefined : checked} aria-colindex={(position % GRID_COLUMNS) + 1} className="min-w-0">
    <button type="button" ref={buttonRef} tabIndex={active ? 0 : -1} aria-label={label} aria-pressed={gray ? undefined : checked} aria-disabled={gray || !editable ? true : undefined}
      data-gray={gray ? "" : undefined} data-testid="expression-set-tile" data-index={slot.index} onClick={() => { if (!gray && editable) onToggle(); }} onFocus={onFocusTile}
      className="expression-set-tile press relative flex flex-col items-center gap-1 rounded-md p-2 text-center focus-visible:focus-ring">
      {!gray && <span aria-hidden="true" className="expression-set-check absolute left-1 top-1 flex size-4 items-center justify-center rounded-sm"><Check className="size-3" /></span>}
      <span className="expression-set-picture flex items-center justify-center" aria-hidden="true">
        {draft ? <ExpressionImage item={draft} size="medium" still /> : <ImageOff className="size-6 text-ink-muted" />}
      </span>
      <span className="break-words text-meta font-semibold text-ink" aria-hidden="true">{slot.displayName}</span>
      <span className="break-all font-mono text-timestamp text-ink-muted" aria-hidden="true">{`:${slot.name}:`}</span>
      {draft !== null && isAnimatedExpression(draft) && <span className="rounded-sm bg-surface-muted px-1 text-timestamp font-semibold text-ink-muted" aria-hidden="true">{formatMessage("expressions.set.badgeGif")}</span>}
      {reason !== null && <span className="break-words text-timestamp text-ink-muted" aria-hidden="true">{reason}</span>}
    </button>
  </div>;
}
