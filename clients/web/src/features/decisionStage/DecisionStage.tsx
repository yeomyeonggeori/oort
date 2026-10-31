import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, ChevronLeft, ChevronRight, X } from "lucide-react";
import { useSession } from "@/app/session";
import { IS_TAURI } from "@/lib/env";
import { cn } from "@/design/lib/cn";
import { STAGE_HERO_WINDOW_MS } from "@/design/motion";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { EmptyInvite, InlineBanner, Skeleton } from "@/features/common/States";
import { useStageHero } from "@/features/attachments/useStageHero";
import { ApprovalActions, LinkOnce } from "@/features/timeline/ApprovalActions";
import { rememberSettledApproval, settledApprovalFor, useSettledApproval } from "@/features/timeline/settledApprovals";
import { requestBundleModel } from "@momo/core/features/timeline/requestBundle";
import {
  createDecisionStage, decisionStageModel, moveDecisionStage, nextPendingDecisionStage,
} from "@momo/core/features/timeline/decisionStage";
import type { DecisionOutcome } from "@momo/core/features/timeline/approvalDecision";
import type { SecretOnce } from "@momo/core/features/approvals/secretOnce";
import { approvalRoleCopy, roleRequiredCopy } from "@momo/core/features/approvals/actionRole";
import { formatMicroUsd } from "@momo/core/features/timeline/agentCardModel";
import {
  closeDecisionStage, decisionStageSnapshot, subscribeDecisionStage,
  type DecisionStageRequest,
} from "./openDecisionStage";
import { useDecisionStageDrag } from "./useDecisionStageDrag";
import "./DecisionStage.css";

/** 셸 한 곳에 둬요. 카드·칩은 openDecisionStage만 부르면 돼요. */
export function DecisionStageHost() {
  const snapshot = useSyncExternalStore(subscribeDecisionStage, decisionStageSnapshot, () => null);
  if (!snapshot) return null;
  return <DecisionStage
    key={snapshot.ticket}
    request={snapshot.request}
    open={snapshot.open}
    onClose={() => closeDecisionStage(snapshot.ticket)}
  />;
}

/** Web and Tauri use the same Radix focus trap and S1 hero lifecycle. */
export function DecisionStage({ request, open, onClose }: {
  request: DecisionStageRequest;
  open: boolean;
  onClose: () => void;
}) {
  const { workspaceId, connStatus } = useSession();
  const [nowMs, setNowMs] = useState(Date.now);
  const [selection, setSelection] = useState(() => createDecisionStage(
    request.cards.map((entry) => ({
      id: entry.id, bundle: requestBundleModel(entry.card, { ...request.context, nowMs }),
    })), request.selectedId
  ));
  const selectedEntry = request.cards.find((entry) => entry.id === selection.selectedId) ?? request.cards[0];
  const activeReceipt = useSettledApproval(selectedEntry?.card.approvalId);
  const cards = useMemo(() => request.cards.map((entry) => {
    const receipt = entry === selectedEntry ? activeReceipt : settledApprovalFor(entry.card.approvalId);
    const card = receipt ? {
      ...entry.card, ...receipt,
      bundle: { ...entry.card.bundle, status: receipt.status },
    } : entry.card;
    return { id: entry.id, bundle: requestBundleModel(card, { ...request.context, nowMs }) };
  }), [request.cards, request.context, nowMs, selectedEntry, activeReceipt]);
  const model = decisionStageModel(selection, cards);
  const current = model.current;
  const entry = request.cards.find((candidate) => candidate.id === current?.id);
  const [feedback, setFeedback] = useState<{
    id: string; text: string; approved: boolean; secretOnce?: SecretOnce;
  } | null>(null);
  const [complete, setComplete] = useState(false);
  const [unconfirmedId, setUnconfirmedId] = useState<string | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const announcementRef = useRef<HTMLParagraphElement>(null);
  const activeId = useRef(current?.id);
  activeId.current = current?.id;
  const hero = useStageHero({ open, selectedId: current?.id ?? null, source: request.source, onClose });
  const { state: stage, content, panel, enter, noPhoto, requestClose: closeHero } = hero;
  const offline = connStatus !== "connected";
  const sameWorkspace = workspaceId === request.workspaceId;
  const sending = () => Boolean(panel.current?.querySelector("[data-decision][data-busy]"));
  const navigable = () => open && stage.phase === "open" && !feedback && !complete && !sending();
  const requestClose = () => closeHero(false);
  const move = (direction: "next" | "previous") => {
    if (!navigable()) return;
    setSelection((previous) => moveDecisionStage(previous, cards, direction));
  };
  const drag = useDecisionStageDrag(content, navigable, (action) => {
    if (action === "close") requestClose();
    else if (action === "next" || action === "previous") move(action);
  });
  const articleRef = useCallback((node: HTMLElement | null) => { content.current = node; }, [content]);
  const panelRef = useCallback((node: HTMLDivElement | null) => { panel.current = node; }, [panel]);

  useEffect(() => {
    if (open && !sameWorkspace) onClose();
  }, [open, sameWorkspace, onClose]);
  useEffect(() => {
    if (!open) return;
    // 만료·남은 시간은 초 단위로 흔들지 않아요. 탭으로 돌아오면 즉시 다시 읽어요.
    const refresh = () => setNowMs(Date.now());
    const timer = window.setInterval(refresh, 60_000);
    const expiries = request.cards.flatMap(({ card }) =>
      card.expiresAtMs !== undefined && card.expiresAtMs > nowMs ? [card.expiresAtMs] : []
    );
    const expires = expiries.length > 0
      ? window.setTimeout(refresh, Math.min(Math.min(...expiries) - nowMs, 60_000)) : null;
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      if (expires !== null) window.clearTimeout(expires);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [open, request.cards, nowMs]);
  useEffect(() => {
    // 비어 있는 로딩 무대가 처음 목록을 받았을 때만 열린 목록을 정해요.
    if (selection.cardIds.length === 0 && cards.length > 0) {
      setSelection(createDecisionStage(cards, request.selectedId));
    }
  }, [selection.cardIds.length, cards, request.selectedId]);
  useLayoutEffect(() => {
    if (stage.phase === "open" && content.current) content.current.removeAttribute("inert");
    if (stage.phase !== "opening") return;
    if (content.current) {
      content.current.setAttribute("inert", ""); // hero 복제본의 접힘 단추도 포커스를 받지 않아요.
      enter();
    }
    else noPhoto();
  }, [stage.phase, current?.id, request.loading, enter, noPhoto, content]);
  useEffect(() => {
    if (stage.phase === "open") headingRef.current?.focus({ preventScroll: true });
  }, [stage.phase, current?.id]);
  useEffect(() => {
    if (!open) {
      setFeedback(null); // 1회 값은 닫힌 무대에 남기지 않아요.
      return;
    }
    if (!feedback) return;
    announcementRef.current?.focus({ preventScroll: true });
    // 1회 링크는 자동 넘김으로 잃지 않아요. 이 값은 React state에만 있어요.
    if (feedback.secretOnce) return;
    const timer = window.setTimeout(() => {
      setFeedback(null);
      if (model.allProcessed) setComplete(true);
      else setSelection((previous) => nextPendingDecisionStage(previous, cards));
    }, STAGE_HERO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [open, feedback, model.allProcessed, cards]);
  useEffect(() => {
    if (!open || !complete) return;
    announcementRef.current?.focus({ preventScroll: true });
    const timer = window.setTimeout(() => closeHero(false), STAGE_HERO_WINDOW_MS);
    return () => window.clearTimeout(timer);
  }, [open, complete, closeHero]);

  function settled(id: string, outcome: DecisionOutcome) {
    const target = request.cards.find((candidate) => candidate.id === id);
    if (!target || outcome.kind === "error") return;
    // 상태 없는 성공 응답으로 승인을 추측하지 않고, 기존 영수증만 모델로 돌려요.
    if (outcome.status && outcome.status !== "pending") {
      setUnconfirmedId(null);
      rememberSettledApproval(target.card.approvalId, {
        status: outcome.status,
        decidedAtMs: outcome.decidedAtMs,
        decidedByMemberId: outcome.decidedByMemberId,
        note: outcome.note,
      });
      if (activeId.current === id) {
        const approved = outcome.kind === "committed" && outcome.status === "approved";
        setFeedback({
          id, approved,
          text: outcome.note ?? (approved ? "승인했어요" : outcome.status === "rejected" ? "거부했어요" : "결정 상태가 바뀌었어요"),
          ...(approved && outcome.result?.secretOnce ? { secretOnce: outcome.result.secretOnce } : {}),
        });
      }
    } else setUnconfirmedId(id);
    request.onSettled?.(id, outcome);
  }

  const ready = !request.loading && !request.error;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) requestClose(); }}>
      <DialogContent
        ref={panelRef}
        opener={request.opener}
        motion=""
        overlayRef={hero.scrim}
        overlayMotion={cn("decision-stage-scrim", (stage.phase === "opening" || stage.phase === "closed") && "opacity-0")}
        className="lightbox-panel left-0 top-0 h-full max-w-none translate-x-0 overflow-hidden rounded-none border-0 bg-transparent"
        data-decision-stage=""
        data-stage-phase={stage.phase}
        data-testid="decision-stage"
        onOpenAutoFocus={(event) => { event.preventDefault(); closeRef.current?.focus(); }}
        onEscapeKeyDown={(event) => { event.preventDefault(); requestClose(); }}
        onClickCapture={drag.onClickCapture}
        onKeyDown={(event) => {
          if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey ||
            (event.target as Element).closest("input, textarea, select, [contenteditable=true]")) return;
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            event.preventDefault();
            move(event.key === "ArrowRight" ? "next" : "previous");
          }
        }}
      >
        <div ref={hero.backdrop} aria-hidden="true" className={cn("pointer-events-none absolute inset-0 bg-lightbox-stage", (stage.phase === "opening" || stage.phase === "closed") && "opacity-0")} />
        <div className="decision-stage-layout relative min-w-0">
          <header className="flex items-center justify-end gap-3" data-desktop-shell={IS_TAURI ? "" : undefined}>
            {/* 눌리는 것만 눌리는 모양이다 (#4986). 이 제목은 닫기 단추와 같은 유리 알약이고 동사구(「결정 보기」)라
                누르는 단추로 읽혔다. 대화상자의 이름은 낭독용으로 두고(사진 라이트박스와 같은 문법), 눈에 보이는
                첫 줄은 카드의 질문이다. */}
            <DialogTitle className="sr-only">결정 보기</DialogTitle>
            <Button ref={closeRef} type="button" variant="ghost" size="icon" className="glass tap-target" aria-label="결정 무대 닫기" onClick={requestClose}>
              <X className="size-4" aria-hidden="true" />
            </Button>
          </header>
          <DialogDescription className="sr-only">왼쪽과 오른쪽 화살표로 넘겨 보고, Esc로 닫아요. 결정은 거부 또는 승인 버튼을 눌러요.</DialogDescription>
          <main className="flex min-h-0 min-w-0 overflow-y-auto overscroll-contain" onClick={(event) => { if (event.target === event.currentTarget) requestClose(); }}>
            <article ref={articleRef} className="m-auto flex w-full max-w-pane-md flex-col gap-4 rounded-2xl bg-surface p-6 text-body text-ink shadow-lg" data-testid="decision-stage-card">
              {offline ? <InlineBanner tone="neutral" separator={false} message="연결이 없어요. 내용을 살펴보고 연결되면 결정해 주세요." testId="decision-stage-offline" /> : null}
              {request.loading ? <Skeleton ready={false} rows={4} /> : request.error ? (
                <InlineBanner separator={false} message={request.error} actionLabel={request.onRetry ? "다시 불러오기" : undefined} onAction={request.onRetry} />
              ) : complete ? (
                <p ref={announcementRef} role="status" tabIndex={-1} className="flex items-center gap-2 focus-visible:focus-ring"><Check className="size-4" aria-hidden="true" />모두 처리했어요</p>
              ) : current && entry ? (
                <>
                  {/* Radix owns modal/focus; only this noninteractive card area needs custom drag tracking. */}
                  <div className="decision-stage-drag flex flex-col gap-4 break-keep" data-testid="decision-stage-drag" {...drag.bindings}>
                    <h3 ref={headingRef} tabIndex={-1} className="text-title font-semibold focus-visible:focus-ring">{current.bundle.headline}</h3>
                    <dl className="flex flex-wrap gap-2" aria-label="바뀌는 값">
                      {current.bundle.valueChips.map((value, index) => <div key={index} className="rounded-md bg-muted-soft px-3 py-2 text-meta" aria-label={value.labelText}>
                        <dt className="text-ink-muted">{value.label}</dt>
                        <dd className="break-words">{value.before !== undefined ? <><span className="text-ink-muted">{value.before}</span><span aria-hidden="true"> → </span></> : null}{value.after ?? value.value}</dd>
                      </div>)}
                    </dl>
                    <div className="flex flex-col gap-1"><h4 className="font-semibold">왜</h4><p>{entry.card.action?.rationale ?? entry.card.summary ?? "요청 사유가 아직 없어요."}</p></div>
                  </div>
                  <details key={current.id} className="break-keep text-meta">
                    <summary className="cursor-pointer rounded-md py-2 hover:bg-surface-hover active:bg-surface-pressed focus-visible:focus-ring">생각 줄 · 자세히{current.bundle.moreValues > 0 ? ` (${current.bundle.moreValues}개 더)` : ""}</summary>
                    <dl className="flex flex-col gap-2 py-2">
                      {current.bundle.details.rows.map((row, index) => <div key={index}><dt className="text-ink-muted">{row.label}</dt><dd className="break-words">{row.value}</dd></div>)}
                    </dl>
                    {current.bundle.details.withheld > 0 ? <p className="text-ink-muted">민감한 실행 정보는 표시하지 않아요.</p> : null}
                  </details>
                  {/* 타임라인 카드의 「자세히」는 펼침 단추다. 무대의 펼침은 위의 「생각 줄 · 자세히」 하나뿐이라, 같은
                      글자를 눌리지 않는 줄에 또 그리지 않는다(#4986). */}
                  {current.bundle.remainingLine ? <p className="break-keep text-meta text-ink-muted" data-testid="decision-stage-remaining">{current.bundle.remainingLine}</p> : null}
                  {entry.card.action?.requiredRole ? <p className="text-meta text-ink-muted">{approvalRoleCopy(entry.card.action.requiredRole)}</p> : null}
                  {entry.card.isReversible !== undefined ? <p className="text-meta">{entry.card.isReversible ? "되돌릴 수 있어요" : "실행하면 되돌릴 수 없어요"}</p> : null}
                  {entry.card.estimatedMicroUsd !== undefined ? <p className="text-meta">예상 비용 <span data-numeric="" className="font-mono">{formatMicroUsd(entry.card.estimatedMicroUsd)}</span></p> : null}
                  {current.bundle.waitingFor ? <p role="status" className="text-meta text-ink-muted">{current.bundle.waitingFor}</p> : null}
                  {unconfirmedId === current.id ? <InlineBanner separator={false} tone="neutral" message="결정 상태를 확인하지 못했어요. 닫고 다시 열어 주세요." /> : null}
                  {current.bundle.state !== "approval" && !feedback ? <p role="status" className="text-meta">{current.bundle.sentence}</p> : null}
                  {feedback?.id === current.id ? <>
                    <p ref={announcementRef} role="status" tabIndex={-1} className="flex items-center gap-2 focus-visible:focus-ring">{feedback.approved ? <Check className="size-4" aria-hidden="true" /> : null}{feedback.text}</p>
                    {feedback.secretOnce ? <>
                      <LinkOnce secret={feedback.secretOnce} />
                      <Button type="button" onClick={() => { setFeedback(null); if (model.allProcessed) setComplete(true); else setSelection(nextPendingDecisionStage(selection, cards)); }}>다음 결정 보기</Button>
                    </> : null}
                  </> : null}
                </>
              ) : <EmptyInvite headline="지금 살펴볼 결정이 없어요." actions={<Button type="button" onClick={requestClose}>돌아가기</Button>} />}
            </article>
          </main>
          <div className="flex min-w-0 justify-center">
            {ready && sameWorkspace && stage.phase === "open" && current?.bundle.canDecide && current.bundle.state === "approval" && !offline && !feedback && !complete ? (
              <div className="glass w-full max-w-pane-md rounded-2xl">
                <ApprovalActions key={current.id} approvalId={current.bundle.approvalId!} execution={entry?.card.execution}
                  lead="결정은 버튼을 눌러요" className="p-3" testIdPrefix="decision-stage"
                  forbiddenCopy={entry?.card.action?.requiredRole ? roleRequiredCopy(entry.card.action.requiredRole) : null}
                  onSettled={(outcome) => settled(current.id, outcome)} />
              </div>
            ) : null}
          </div>
          {/* 넘겨 볼 결정이 없으면(로딩·오류·빈 무대) 줄 자체를 세우지 않는다. 눌러도 아무 일 없는 화살표와 「0건」이
              불러오는 동안 서 있었다 (#4986). */}
          {model.cards.length > 0 ? <nav aria-label="결정 넘겨 보기" className="flex min-w-0 flex-col items-center gap-2">
            <div className="flex max-w-full items-center gap-2">
              <Button type="button" variant="ghost" size="icon" className="decision-stage-step glass shrink-0" aria-label="이전 결정" aria-disabled={model.index <= 0 || undefined} onClick={() => move("previous")}><ChevronLeft className="size-4" aria-hidden="true" /></Button>
              <div className="decision-stage-thumbnails" role="group" aria-label="결정 썸네일">
                {model.cards.map((card) => <Button key={card.id} type="button" variant="ghost" className="decision-stage-thumbnail glass shrink-0 px-3" aria-label={card.bundle.headline} aria-current={card.id === current?.id ? "true" : undefined} onClick={() => { if (navigable()) setSelection((previous) => ({ ...previous, selectedId: card.id })); }}>
                  <span className="truncate">{card.bundle.headline}</span>{card.bundle.state !== "approval" ? <span className="text-timestamp">{card.bundle.word}</span> : null}
                </Button>)}
              </div>
              <Button type="button" variant="ghost" size="icon" className="decision-stage-step glass shrink-0" aria-label="다음 결정" aria-disabled={model.index >= model.cards.length - 1 || undefined} onClick={() => move("next")}><ChevronRight className="size-4" aria-hidden="true" /></Button>
            </div>
            <p role="status" data-numeric="" className="glass rounded-full px-3 py-1 font-mono text-meta">{model.positionLabel}</p>
          </nav> : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
