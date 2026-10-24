import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import type { ScheduledErrorLine } from "@momo/core/features/scheduled/errors";
import { isScheduledStub } from "@momo/core/features/scheduled/events";
import { reviewAttachmentsLine } from "@momo/core/features/scheduled/model";
import {
  formatScheduledAt,
  scheduledZoneLine,
  sendAtFromInputs,
  sendAtInputs,
  sendAtProblemSentence,
  validateSendAt,
} from "@momo/core/features/scheduled/presets";
import { editBodyProblem, scheduledPatch } from "@momo/core/features/scheduled/request";
import type { ScheduledMessage, ScheduledPatch } from "@momo/core/features/scheduled/types";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { Skeleton } from "@/features/common/States";

// Reading this as: edit / confirm dialogs for one scheduled message, opened from the scheduled list,
// internal team users on web+Tauri, density 7/10, motion 2/10.

// =============================================================================
// 목록의 행 하나에 거는 대화상자 셋 (UI 명세 1.7·1.8, ADR-0208 D9·D14, #4215).
//
//   고치기        글 칸 + 시각. **글만 고칠 때는 어떤 행이든 `sendAtMs`를 보내지 않는다**(시각을 건드렸을 때만 싣는다:
//                 안 건드렸는데 보내면 마감이 가까운 대기 행은 `send_at_too_soon`이 되고, 실패 행은 시각을 주면
//                 되살아나 대기 50개에 센다). `sessions_ended` 행의 고치기에는 시각 칸이 없다: 시각을 주면 행이 되살아나
//                 내용 확인을 비켜 간다.
//   지우기        되돌릴 수 없는 확인.
//   내용 확인     **`sessions_ended` 행이 한 번 눌러 나가지 않게 하는 문이다**(ADR-0208 D14): 로그인이 끝나서 멈춘 예약이
//                 계정을 되찾은 뒤 말없이 나가면 멈춘 의미가 없다. 본문 전체·첨부 이름·채널·시각을 보인 **뒤에만**
//                 「지금 보내기」·「다시 예약」이 서버를 부른다. 본문이 아직 없으면(이벤트로만 안 행) 그 둘은 서지
//                 않는다: 보지 못한 것을 보내게 할 수 없다.
//
// 이 파일의 대화상자는 쓰지 않는다. 고른 것을 호출부(`ScheduledRoute`)로 올릴 뿐이고 쓰기 길과 그 실패 문장은
// 호출부가 갖는다. 요청이 나는 동안(`pending`)은 Esc·바깥 누름으로 닫히지 않고, 열려 있는 동안 행이 마감 30초 안에
// 들거나 이미 나가면(`lock`) 저장을 잠그고 해당 문장을 말한다.
// =============================================================================

/** 오류 줄. 잠금 > 호출부의 오류 순이다. */
function ErrorLines({ line }: { line: ScheduledErrorLine | null }) {
  if (line === null) return null;
  return (
    <div className="flex flex-col gap-1" role="alert">
      <p className="break-keep text-meta text-danger">{line.text}</p>
      {line.next !== undefined && <p className="break-keep text-meta text-ink-muted">{line.next}</p>}
    </div>
  );
}

function lockLine(lock: "open" | "tooLate" | "gone"): ScheduledErrorLine | null {
  if (lock === "tooLate") return { text: SCHEDULED_COPY.error.tooLate };
  if (lock === "gone") return { text: SCHEDULED_COPY.errors.alreadySent };
  return null;
}

// ---- 고치기 ------------------------------------------------------------------------------------

export interface ScheduledEditDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: DialogFocusTarget | null;
  /** 지금의 행. 열린 뒤 행이 사라졌으면 `undefined`(`lock: "gone"`). */
  row: ScheduledMessage | undefined;
  placeLabel: string;
  /** 시각 칸을 세우는가(`rowActions().editHasTime`: `sessions_ended` 행은 아니다). */
  hasTime: boolean;
  pending: boolean;
  error: ScheduledErrorLine | null;
  offline: boolean;
  lock: "open" | "tooLate" | "gone";
  onCommit: (patch: ScheduledPatch) => void;
  /** 닫힌 뒤 초점을 호출부가 정한다(행이 구획을 옮겨 열었던 단추가 사라졌을 때). 생략하면 열었던 단추로 돌아간다. */
  onCloseAutoFocus?: (event: Event) => void;
  nowMs?: number;
}

export function ScheduledEditDialog({
  open,
  onOpenChange,
  opener,
  row,
  placeLabel,
  hasTime,
  pending,
  error,
  offline,
  lock,
  onCommit,
  onCloseAutoFocus,
  nowMs,
}: ScheduledEditDialogProps) {
  const bodyId = useId();
  const dateId = useId();
  const timeId = useId();
  const [body, setBody] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [touched, setTouched] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  // 한글 조합 중의 Esc는 대화상자를 닫지 않는다(조합을 취소하는 키다).
  const composing = useRef(false);
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!open) {
      seededFor.current = null;
      return;
    }
    if (row === undefined || seededFor.current === row.id) return;
    seededFor.current = row.id;
    const inputs = sendAtInputs(row.sendAtMs);
    setBody(row.body ?? "");
    setDate(inputs.date);
    setTime(inputs.time);
    setTouched(false);
    setLocalError(null);
  }, [open, row]);

  const now = nowMs ?? Date.now();
  const locked = lock !== "open";
  const busy = pending || offline || locked;
  const chosen = hasTime && touched ? sendAtFromInputs(date, time) : null;
  const shown: ScheduledErrorLine | null =
    lockLine(lock) ??
    (offline
      ? { text: SCHEDULED_COPY.dialog.offline }
      : (error ?? (localError === null ? null : { text: localError })));

  const commit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy || row === undefined) return;
    if (editBodyProblem(row, body) === "empty") {
      setLocalError(SCHEDULED_COPY.errors.emptyMessage);
      return;
    }
    let sendAtMs: number | undefined;
    if (hasTime && touched) {
      const picked = sendAtFromInputs(date, time);
      const problem = validateSendAt(picked, nowMs ?? Date.now());
      if (problem !== null || picked === null) {
        setLocalError(sendAtProblemSentence(problem ?? "invalid"));
        return;
      }
      sendAtMs = picked;
    }
    // 바뀐 것만 싣는다: 글만 고치면 `sendAtMs`가 없고, 아무것도 안 바뀌었으면 요청이 없다.
    const patch = scheduledPatch(row, { body, ...(sendAtMs === undefined ? {} : { sendAtMs }) });
    if (patch === null) {
      onOpenChange(false);
      return;
    }
    setLocalError(null);
    onCommit(patch);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        opener={opener}
        data-testid="scheduled-edit-dialog"
        className="gap-3 p-4"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
        onEscapeKeyDown={(event) => {
          if (composing.current) event.preventDefault();
        }}
      >
        <DialogTitle>{SCHEDULED_COPY.edit.title}</DialogTitle>
        <p className="min-w-0 truncate text-meta font-semibold text-ink" data-testid="scheduled-edit-place">
          {placeLabel}
        </p>
        <form className="flex min-w-0 flex-col gap-3" onSubmit={commit} noValidate>
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={bodyId} className="sr-only">
              {SCHEDULED_COPY.review.bodyLabel}
            </label>
            <textarea
              id={bodyId}
              value={body}
              rows={4}
              disabled={pending || offline}
              onChange={(event) => {
                setBody(event.target.value);
                setLocalError(null);
              }}
              onCompositionStart={() => {
                composing.current = true;
              }}
              onCompositionEnd={() => {
                composing.current = false;
              }}
              className="scrollbar-visible tap-target w-full resize-y rounded-lg border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="scheduled-edit-body"
            />
            {/* 보이는 한 줄이 곧 이 대화상자의 설명이다: 숨은 설명과 같은 문장을 두 번 두면 낭독이 두 번 읽는다. */}
            <DialogDescription className="break-keep text-meta" data-testid="scheduled-edit-attach-note">
              {SCHEDULED_COPY.edit.attachNote}
            </DialogDescription>
          </div>

          {hasTime && (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap gap-2">
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={dateId} className="text-meta text-ink-muted">
                    {SCHEDULED_COPY.dialog.date}
                  </label>
                  <Input
                    id={dateId}
                    type="date"
                    value={date}
                    disabled={pending || offline}
                    onChange={(event) => {
                      setDate(event.target.value);
                      setTouched(true);
                      setLocalError(null);
                    }}
                    data-testid="scheduled-edit-date"
                  />
                </div>
                <div className="flex min-w-0 flex-col gap-1">
                  <label htmlFor={timeId} className="text-meta text-ink-muted">
                    {SCHEDULED_COPY.dialog.time}
                  </label>
                  <Input
                    id={timeId}
                    type="time"
                    value={time}
                    disabled={pending || offline}
                    onChange={(event) => {
                      setTime(event.target.value);
                      setTouched(true);
                      setLocalError(null);
                    }}
                    data-testid="scheduled-edit-time"
                  />
                </div>
              </div>
              {chosen !== null && (
                <p className="text-body text-ink" aria-live="polite" data-numeric data-testid="scheduled-edit-result">
                  {SCHEDULED_COPY.dialog.preview(formatScheduledAt(chosen, now).full)}
                </p>
              )}
              {/* 시각을 고르는 자리는 시간대를 늘 적는다(명세 0.2). 칸을 건드리기 전에는 그 행의 시각 기준이다. */}
              <p className="text-meta text-ink-muted" data-testid="scheduled-edit-zone">
                {scheduledZoneLine(chosen ?? row?.sendAtMs ?? now)}
              </p>
            </div>
          )}

          <ErrorLines line={shown} />

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              disabled={pending}
              data-testid="scheduled-edit-cancel"
              onClick={() => onOpenChange(false)}
            >
              {SCHEDULED_COPY.dialog.cancel}
            </Button>
            <Button
              type="submit"
              disabled={offline || locked}
              aria-busy={pending || undefined}
              data-testid="scheduled-edit-commit"
            >
              {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {pending ? SCHEDULED_COPY.edit.saving : SCHEDULED_COPY.edit.commit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ---- 지우기 ------------------------------------------------------------------------------------

export function ScheduledDeleteDialog({
  open,
  onOpenChange,
  opener,
  pending,
  error,
  offline,
  onConfirm,
  onCloseAutoFocus,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: DialogFocusTarget | null;
  pending: boolean;
  error: ScheduledErrorLine | null;
  offline: boolean;
  onConfirm: () => void;
  /** 지운 행의 다음 행으로 초점을 보내려고 호출부가 가로챈다. 생략하면 열었던 단추로 돌아간다. */
  onCloseAutoFocus?: (event: Event) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        opener={opener}
        data-testid="scheduled-delete-dialog"
        className="gap-3 p-4"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogTitle>{SCHEDULED_COPY.delete.title}</DialogTitle>
        <DialogDescription className="break-keep">{SCHEDULED_COPY.delete.body}</DialogDescription>
        <ErrorLines line={offline ? { text: SCHEDULED_COPY.dialog.offline } : error} />
        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            disabled={pending}
            data-testid="scheduled-delete-cancel"
            onClick={() => onOpenChange(false)}
          >
            {SCHEDULED_COPY.dialog.cancel}
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={offline}
            aria-busy={pending || undefined}
            data-testid="scheduled-delete-confirm"
            onClick={onConfirm}
          >
            {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
            {pending ? SCHEDULED_COPY.delete.pending : SCHEDULED_COPY.delete.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---- 내용 확인 (`sessions_ended`) -------------------------------------------------------------------

export interface ScheduledReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  opener: DialogFocusTarget | null;
  row: ScheduledMessage | undefined;
  placeLabel: string;
  /** 작업이 나는 중인 단추. */
  pending: "sendNow" | "delete" | null;
  error: ScheduledErrorLine | null;
  offline: boolean;
  onSendNow: () => void;
  onRearm: () => void;
  onDelete: () => void;
  /** 보내거나 지운 행의 다음 행으로 초점을 보내려고 호출부가 가로챈다. 생략하면 열었던 단추로 돌아간다. */
  onCloseAutoFocus?: (event: Event) => void;
  nowMs?: number;
}

export function ScheduledReviewDialog({
  open,
  onOpenChange,
  opener,
  row,
  placeLabel,
  pending,
  error,
  offline,
  onSendNow,
  onRearm,
  onDelete,
  onCloseAutoFocus,
  nowMs,
}: ScheduledReviewDialogProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const deleteRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const confirmLabelId = useId();
  const [confirming, setConfirming] = useState(false);
  const backToDelete = useRef(false);
  const now = nowMs ?? Date.now();
  const busy = pending !== null;
  // 본문을 아직 못 읽었다(이벤트로만 안 행): 보지 못한 것을 보내거나 다시 걸게 하지 않는다.
  const loading = row === undefined || isScheduledStub(row);

  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);
  useEffect(() => {
    if (confirming) cancelRef.current?.focus();
    else if (backToDelete.current) {
      backToDelete.current = false;
      deleteRef.current?.focus();
    }
  }, [confirming]);

  const attachments = row === undefined ? null : reviewAttachmentsLine(row);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        opener={opener}
        data-testid="scheduled-review-dialog"
        className="gap-3 p-4"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
        // 열리면 초점은 제목이다(명세 1.8). 본문 스크롤 영역이 첫 탭 정거장이다.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          titleRef.current?.focus();
        }}
        // 지우기 확인이 서 있는 동안 Esc는 확인만 취소하고 초점을 「지우기」로 되돌린다. 한 번 더 누르면 닫힌다.
        onEscapeKeyDown={(event) => {
          if (!confirming) return;
          event.preventDefault();
          backToDelete.current = true;
          setConfirming(false);
        }}
      >
        <DialogTitle ref={titleRef} tabIndex={-1} className="focus-visible:focus-ring">
          {SCHEDULED_COPY.review.title}
        </DialogTitle>
        <DialogDescription className="break-keep">{SCHEDULED_COPY.review.body}</DialogDescription>

        <div className="flex min-w-0 flex-col gap-1">
          <p className="min-w-0 truncate text-meta font-semibold text-ink" data-testid="scheduled-review-place">
            {placeLabel}
          </p>
          {loading ? (
            <Skeleton ready={false} rows={3} className="py-1" />
          ) : (
            <div
              // 본문 전체. 길면 이 상자만 스크롤하고(탭 정거장이다) 대화상자는 늘지 않는다.
              //
              // `scrollbar-visible`이 이 상자의 안전장치다: macOS의 오버레이 스크롤바는 스크롤을 **시작해야** 보여서,
              // 넘치는 상자가 열리는 순간에는 맨 아래 줄이 곧 글의 끝으로 읽힌다(design-review #4215 H1: 본문 65줄 중
              // 13줄만 보이는 상자가 막대도 페이드도 없이 끝났다). 이 대화상자는 「본문 전체를 보기 전에는 나가지
              // 않는다」(ADR-0208 D14)의 문이라 사람이 일부만 보고 「지금 보내기」를 누르는 길이 바로 이 결함이다.
              // 막대가 자리를 차지해 항상 보인다(`tokens.css`의 `scrollbar-visible`, 컨텍스트 메뉴·`ArtifactCard`와 같은 처방).
              tabIndex={0}
              role="region"
              aria-label={SCHEDULED_COPY.review.bodyLabel}
              className="scrollbar-visible max-h-pane overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-line px-3 py-2 text-body text-ink focus-visible:focus-ring"
              data-testid="scheduled-review-body"
            >
              {row.body ?? ""}
            </div>
          )}
          {attachments !== null && (
            <p className="break-keep text-meta text-ink-muted" data-testid="scheduled-review-attachments">
              {attachments}
            </p>
          )}
          {row !== undefined && (
            <p className="text-meta text-ink-muted" data-numeric data-testid="scheduled-review-when">
              {SCHEDULED_COPY.review.when(formatScheduledAt(row.sendAtMs, now).full)}
            </p>
          )}
        </div>

        <ErrorLines line={offline ? { text: SCHEDULED_COPY.dialog.offline } : error} />

        {confirming ? (
          // 푸터가 확인 줄로 바뀐다(대화상자는 겹치지 않는다). 그룹 이름이 「예약을 지울까요?」라서 초점이 「취소」에
          // 닿을 때 그룹 이름과 단추 이름이 함께 읽힌다(새로 붙는 `aria-live`에 기대지 않는다).
          <div
            role="group"
            aria-labelledby={confirmLabelId}
            className="flex min-w-0 flex-col gap-2"
            data-testid="scheduled-review-confirm"
          >
            <p id={confirmLabelId} className="text-body font-semibold text-ink">
              {SCHEDULED_COPY.delete.title}
            </p>
            <p className="break-keep text-meta text-ink-muted">{SCHEDULED_COPY.delete.body}</p>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                ref={cancelRef}
                type="button"
                variant="secondary"
                disabled={busy}
                data-testid="scheduled-review-confirm-cancel"
                onClick={() => {
                  backToDelete.current = true;
                  setConfirming(false);
                }}
              >
                {SCHEDULED_COPY.dialog.cancel}
              </Button>
              <Button
                type="button"
                variant="destructive"
                disabled={offline}
                aria-busy={pending === "delete" || undefined}
                data-testid="scheduled-review-confirm-delete"
                onClick={onDelete}
              >
                {pending === "delete" && <Loader2 aria-hidden="true" className="spinner-busy" />}
                {pending === "delete" ? SCHEDULED_COPY.delete.pending : SCHEDULED_COPY.delete.confirm}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap justify-between gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              disabled={busy}
              data-testid="scheduled-review-close"
              onClick={() => onOpenChange(false)}
            >
              {SCHEDULED_COPY.review.close}
            </Button>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                ref={deleteRef}
                type="button"
                variant="secondary"
                disabled={busy}
                data-testid="scheduled-review-delete"
                onClick={() => setConfirming(true)}
              >
                {SCHEDULED_COPY.action.delete}
              </Button>
              {/* 본문을 보이기 전에는 이 둘이 서지 않는다(ADR-0208 D14). 로딩 중에는 흐리다. */}
              <Button
                type="button"
                variant="secondary"
                disabled={loading || busy || offline}
                data-testid="scheduled-review-rearm"
                onClick={onRearm}
              >
                {SCHEDULED_COPY.action.rearm}
              </Button>
              <Button
                type="button"
                disabled={loading || busy || offline}
                aria-busy={pending === "sendNow" || undefined}
                data-testid="scheduled-review-send-now"
                onClick={onSendNow}
              >
                {pending === "sendNow" && <Loader2 aria-hidden="true" className="spinner-busy" />}
                {pending === "sendNow" ? SCHEDULED_COPY.list.sending : SCHEDULED_COPY.action.sendNow}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
