import { useEffect, useRef, useState } from "react";
import { expressionSetPlanView, type ExpressionSetMotion, type ExpressionSetPlanCard, type ExpressionSetPlanState } from "@momo/core/features/expressions/set";
import { expressionDecisionRequest } from "@momo/core/features/expressions/setWire";
import type { AgentApprovalCard, ApprovalStatus } from "@momo/core/features/timeline/agentCardModel";
import { newDecisionId } from "@momo/core/features/timeline/approvalDecision";
import type { MessageKey } from "@momo/core/i18n";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useFormatMessage } from "@/i18n/useFormatMessage";
import { rememberSettledApproval, useSettledApproval } from "@/features/timeline/settledApprovals";
import { useExpressions } from "./context";
import { ExpressionSetReferences } from "./ExpressionSetReferences";
import { emptyPlanEdit, planEditValid, planRevisionFields, planSlotKept, type PlanEdit } from "./planRevision";
import { Decided, OPEN, sendSetDecision, Status, type PlainKey } from "./setCards";

/**
 * 세트 계획 카드 (ADR-0218 §12 L2.5·L19, #5462): 사람이 한 번 보는 카드다. 계획이 저장된 뒤 **아무것도 만들기 전에** 서버가 대화에 올린다.
 * 대화에 서는 길은 기존 행동 승인 카드다(`AgentCard`가 `expression.set.plan`을 여기로 보낸다). 새 경로는 없다.
 *
 * 보이는 것: 제목, 컨셉, 장면 줄(정지는 장면 글, GIF는 바탕과 움직임), 만들 그림 N장(숫자만), 보낼 참조 그림의 썸네일과 장수. 참조가 있으면 얼굴 없음 선언이
 * **매번** 보이고, 그 멤버의 첫 참조 세트면 고지 두 줄이 더 보인다(`noticeDue`: 서버가 멤버별 기록으로 계산한다. 이 화면은 읽기만 한다).
 * 버튼 셋: 「이대로 만들기」(승인) · 「장면 고치기」(새 계획) · 「취소」(거절). **「이대로 만들기」 전에는 아무 그림도 Hermes로 가지 않는다**(L19.3): 서버의 불변식이다.
 *
 * 앱 안에서만 확정한다(L2.5 결정 방식, A44): 웹은 이미 앱이고 카드를 본 채로 누르는 곳이라 이 카드의 단추가 곧 그 자리다. 잠금 화면·푸시에서의 결정은 서버가
 * 403으로 거절하고 이 화면과 무관하다. 받은함처럼 카드를 보여 주지 않는 곳의 일반 승인 단추는 이 칸이 고치지 않는다(인계에 적었다).
 *
 * 이 파일에는 상태 이름 같은 문자열이 없다(직접 문구 장부: 새 파일은 0줄). 표의 키는 속성 이름이고, 갈래는 숫자다.
 */
const Mode = { view: 0, edit: 1 } as const;

const MOTION_LABEL = {
  bounce: "expressions.plan.motionBounce",
  wobble: "expressions.plan.motionWobble",
  pulse: "expressions.plan.motionPulse",
  sparkle: "expressions.plan.motionSparkle",
} as const satisfies Record<ExpressionSetMotion, MessageKey>;
/** 계획 카드가 스스로 말하는 끝난 상태(서버가 메시지를 고쳐 쓴 뒤). */
const PLAN_STATE_LINE = {
  planned: "expressions.set.settledExpired",
  confirmed: "expressions.plan.confirmed",
  cancelled: "expressions.plan.closed",
  expired: "expressions.set.settledExpired",
} as const satisfies Record<ExpressionSetPlanState, MessageKey>;
/** 방금 이 화면이 결정한 승인 상태가 말하는 것. */
const STATUS_LINE = {
  pending: "expressions.set.settledExpired",
  approved: "expressions.plan.confirmed",
  rejected: "expressions.plan.closed",
  expired: "expressions.set.settledExpired",
  cancelled: "expressions.plan.closed",
} as const satisfies Record<ApprovalStatus, MessageKey>;

export function ExpressionPlanCard({ card, plan }: { card: AgentApprovalCard; plan: ExpressionSetPlanCard | null }) {
  const { store, offline } = useExpressions();
  const formatMessage = useFormatMessage();
  const remembered = useSettledApproval(card.approvalId);
  const [now, setNow] = useState(Date.now());
  const [mode, setMode] = useState<number>(Mode.view);
  const [edit, setEdit] = useState<PlanEdit>(emptyPlanEdit);
  const [busy, setBusy] = useState(false);
  const [errorLine, setErrorLine] = useState<PlainKey | null>(null);
  const lock = useRef(false);
  const keys = useRef(new Map<string, string>());

  // 다른 워크스페이스의 계획은 그리지 않는다: 이 저장소로는 참조 그림의 대화를 열 수 없다.
  const usable = plan !== null && store !== null && plan.workspaceId === store.workspaceId ? plan : null;
  const planId = usable?.setId ?? null;
  useEffect(() => { setMode(Mode.view); setEdit(emptyPlanEdit()); }, [planId]);
  useEffect(() => {
    const ends = [card.expiresAtMs, usable?.expiresAtMs].filter((value): value is number => value !== undefined && value > 0);
    if (ends.length === 0) return;
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, Math.min(2147483647, Math.min(...ends) - Date.now())));
    return () => window.clearTimeout(timer);
  }, [card.expiresAtMs, usable?.expiresAtMs]);

  const status = remembered?.status ?? card.status;
  const view = usable ? expressionSetPlanView(usable, now) : null;
  // 열려 있다 = 아직 결정되지 않았고, 카드의 기한이 지나지 않았고, 계획이 아직 답을 기다린다(서버가 확정·취소·만료로 바꾸면 닫힌다).
  const open = OPEN[status] && (!card.expiresAtMs || now < card.expiresAtMs) && (view === null || view.canConfirm);
  const blocked = busy || offline;

  async function decide(fields: Record<string, unknown>, settled: ApprovalStatus) {
    if (!store || !card.approvalId || !open || lock.current || offline) return;
    lock.current = true; setBusy(true); setErrorLine(null);
    // 같은 결정을 다시 누르면 같은 키라 서버가 첫 영수증을 돌려준다. 고친 내용이 바뀌면 다른 결정이라 새 키다.
    const pin = JSON.stringify(fields);
    const key = keys.current.get(pin) ?? newDecisionId(); keys.current.set(pin, key);
    try {
      const outcome = await sendSetDecision(expressionDecisionRequest(store.base, card.approvalId, key, fields));
      if (outcome.kind === Decided.failed) { if (outcome.freshKey) keys.current.delete(pin); setErrorLine(outcome.line); return; }
      rememberSettledApproval(card.approvalId, { status: outcome.kind === Decided.settled ? outcome.status : settled });
    } finally { lock.current = false; setBusy(false); }
  }

  if (!store) return <p className="text-body">{formatMessage("expressions.set.unreadable")}</p>;
  const title = usable ? formatMessage("expressions.plan.heading", { title: usable.title }) : card.title;
  // 승인이 이미 끝났다고 말하면(방금 이 화면이 결정했거나 메시지가 그렇게 말하면) 그 상태가, 아직 대기라면 계획이 스스로 말하는 상태(확정·취소·만료)가 말한다.
  const settledLine = formatMessage(OPEN[status] && view ? PLAN_STATE_LINE[view.state] : STATUS_LINE[status]);
  const slotName = (index: number) => usable?.slots.find((slot) => slot.index === index)?.displayName ?? "";
  const editing = mode === Mode.edit;
  const keptReferences = usable ? usable.references.filter((reference) => !edit.removedReferences.includes(reference.attachmentId)) : [];

  // `break-keep`(M1, #5527 검수 7c): 한국어는 어절에서 꺾는다. 글자 하나 위에서 줄이 바뀌면 「메신/저」처럼 낱말이 끊긴다. 상속이라 카드 안의 모든 글 줄이 같다.
  return <section className="flex break-keep flex-col gap-3 rounded-lg border border-line bg-surface p-3" aria-label={title} data-testid="expression-plan" data-open={String(open)}>
    <p className="break-keep text-body font-semibold">{title}</p>
    {open && usable === null && <>
      <p role="alert" className="text-body" data-testid="expression-plan-unreadable">{formatMessage("expressions.set.unreadable")}</p>
      <div className="flex justify-end">
        <Button type="button" variant="secondary" disabled={blocked} onClick={() => { void decide({ approve: false }, Status.rejected); }} data-testid="expression-plan-cancel">{formatMessage("expressions.plan.cancel")}</Button>
      </div>
    </>}
    {open && usable !== null && view !== null && !editing && <>
      <dl className="flex flex-col gap-2">
        <div className="flex flex-col gap-1">
          <dt className="text-meta font-semibold text-ink-muted">{formatMessage("expressions.plan.concept")}</dt>
          <dd className="break-keep text-body" data-testid="expression-plan-concept">{usable.prompt}</dd>
        </div>
        <div className="flex flex-col gap-1">
          <dt className="text-meta font-semibold text-ink-muted">{formatMessage("expressions.plan.scenes")}</dt>
          <dd>
            <ol className="flex list-decimal flex-col gap-1 pl-6" data-testid="expression-plan-scenes">
              {[...usable.slots].sort((a, b) => a.index - b.index).map((slot) => <li key={slot.index} className="break-keep text-body" data-testid="expression-plan-scene">
                <span className="font-semibold">{slot.displayName}</span>{" "}
                <span className="text-ink-muted">{slot.scene !== null ? slot.scene : formatMessage("expressions.plan.gif", { base: slotName(slot.baseIndex ?? -1), motion: slot.motion ? formatMessage(MOTION_LABEL[slot.motion]) : "" })}</span>
              </li>)}
            </ol>
          </dd>
        </div>
      </dl>
      <p className="text-meta text-ink-muted" data-numeric data-testid="expression-plan-pictures">{formatMessage("expressions.plan.pictures", { count: usable.slots.length })}</p>
      {view.referencesLine !== null && <div className="flex flex-col gap-2" data-testid="expression-plan-references">
        <div className="flex flex-wrap items-center gap-3">
          <ExpressionSetReferences references={usable.references} workspaceId={store.workspaceId} channelId={card.channelId} offline={offline} />
          <span className="text-meta text-ink-muted" data-numeric data-testid="expression-plan-references-line">{formatMessage("expressions.plan.references", { count: usable.references.length })}</span>
        </div>
        {view.declareLine !== null && <p className="text-meta" data-testid="expression-plan-declare">{formatMessage("expressions.plan.declare")}</p>}
      </div>}
      {view.noticeLines.length > 0 && <div className="flex flex-col gap-1 text-meta text-ink-muted" data-testid="expression-plan-notice">
        <p>{formatMessage("expressions.plan.notice")}</p>
        <p>{formatMessage("expressions.plan.kept")}</p>
      </div>}
      {offline && <p role="status" className="text-meta text-ink-muted">{formatMessage("expressions.set.offline")}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" disabled={blocked || !view.canCancel} onClick={() => { void decide({ approve: false }, Status.rejected); }} data-testid="expression-plan-cancel">{formatMessage("expressions.plan.cancel")}</Button>
        <Button type="button" variant="secondary" disabled={blocked || !view.canRevise} onClick={() => setMode(Mode.edit)} data-testid="expression-plan-revise">{formatMessage("expressions.plan.revise")}</Button>
        <Button type="button" disabled={blocked || !view.canConfirm} onClick={() => { void decide({ approve: true }, Status.approved); }} data-testid="expression-plan-confirm">{formatMessage("expressions.plan.confirm")}</Button>
      </div>
    </>}
    {open && usable !== null && editing && <div className="flex flex-col gap-3" data-testid="expression-plan-edit">
      <ExpressionSetReferences references={keptReferences} workspaceId={store.workspaceId} channelId={card.channelId} offline={offline}
        onRemove={(attachmentId) => setEdit((current) => ({ ...current, removedReferences: [...current.removedReferences, attachmentId] }))} />
      <ul className="flex flex-col gap-2">
        {[...usable.slots].sort((a, b) => a.index - b.index).map((slot) => {
          const kept = planSlotKept(usable, edit, slot.index);
          // 움직일 정지 칸이 빠진 GIF는 스스로 켤 수 없다: 바탕이 돌아와야 같이 돌아온다.
          const follows = slot.scene === null && slot.baseIndex !== null && !planSlotKept(usable, edit, slot.baseIndex);
          return <li key={slot.index} className="flex flex-col gap-1 border-t border-line pt-2" data-testid="expression-plan-edit-slot">
            <div className="flex items-center gap-2">
              <label className="flex shrink-0 items-center rounded-md p-1 hover:bg-surface-hover active:bg-surface-pressed">
                <input type="checkbox" className="accent-primary focus-visible:focus-ring" checked={kept} disabled={blocked || follows} data-testid="expression-plan-edit-include"
                  aria-label={formatMessage("expressions.plan.editInclude", { displayName: edit.names[slot.index] ?? slot.displayName })}
                  onChange={() => setEdit((current) => { const dropped = new Set(current.dropped); if (dropped.has(slot.index)) dropped.delete(slot.index); else dropped.add(slot.index); return { ...current, dropped }; })} />
              </label>
              <Input value={edit.names[slot.index] ?? slot.displayName} maxLength={40} disabled={blocked || !kept} data-testid="expression-plan-edit-name"
                aria-label={formatMessage("expressions.plan.editName", { index: slot.index + 1 })}
                onChange={(event) => setEdit((current) => ({ ...current, names: { ...current.names, [slot.index]: event.target.value } }))} />
            </div>
            {slot.scene !== null && <textarea rows={2} maxLength={300} value={edit.scenes[slot.index] ?? slot.scene} disabled={blocked || !kept} data-testid="expression-plan-edit-scene"
              aria-label={formatMessage("expressions.plan.editScene", { index: slot.index + 1 })}
              className="w-full resize-y rounded-lg border border-line-strong bg-transparent px-3 py-2 text-body text-ink focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              onChange={(event) => setEdit((current) => ({ ...current, scenes: { ...current.scenes, [slot.index]: event.target.value } }))} />}
          </li>;
        })}
      </ul>
      {offline && <p role="status" className="text-meta text-ink-muted">{formatMessage("expressions.set.offline")}</p>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMode(Mode.view); setEdit(emptyPlanEdit()); }} data-testid="expression-plan-edit-back">{formatMessage("expressions.plan.editBack")}</Button>
        <Button type="button" disabled={blocked || !planEditValid(usable, edit)} onClick={() => { void decide(planRevisionFields(usable, edit), Status.rejected); }} data-testid="expression-plan-edit-submit">{formatMessage("expressions.plan.editSubmit")}</Button>
      </div>
    </div>}
    {!open && <p role="status" className="text-body" data-testid="expression-plan-settled">{settledLine}</p>}
    {errorLine !== null && <p role="alert" className="text-meta text-danger" data-testid="expression-plan-error">{formatMessage(errorLine)}</p>}
  </section>;
}
