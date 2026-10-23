import { useEffect, useId, useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { SCHEDULED_COPY } from "@momo/core/features/scheduled/copy";
import type { ScheduledErrorLine } from "@momo/core/features/scheduled/errors";
import {
  formatScheduledAt,
  scheduledZoneLine,
  sendAtFromInputs,
  sendAtInputs,
  sendAtProblemSentence,
  validateSendAt,
} from "@momo/core/features/scheduled/presets";
import { SCHEDULED_MAX_LEAD_MS } from "@momo/core/features/scheduled/types";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";

// Reading this as: confirm dialog for a scheduled send time, opened from the composer's send
// menu and from the scheduled list, internal team users on web+Tauri, density 7/10, motion 2/10.

// =============================================================================
// 보낼 시각을 고르는 대화상자 (UI 명세 1.4, ADR-0208 D2·D9, #4215).
//
// 한 컴포넌트가 세 번 쓰인다.
//   create  「보낼 시각 고르기」: 프리셋 아래 「직접 고르기…」, 그리고 **프리셋 요청이 실패했을 때** 같은 시각이
//           채워진 채 열려 오류 줄이 이유를 말한다(명세 0.5).
//   change  「보낼 시각 바꾸기」 · 확인 「변경하기」: 대기 행의 「시간 바꾸기」.
//   rearm   「다시 예약하기」: 보내지 못한 행의 「다시 예약」.
//
// 이 대화상자는 쓰지 않는다. 고른 시각(`atMs`)을 `onCommit`으로 올릴 뿐이고 쓰기 길과 그 실패 문장은 부르는
// 쪽이 갖는다. 서버가 같은 이유로 400을 주면 부르는 쪽이 `error`로 같은 문장을 넘긴다(명세 3.3).
//
// - 처음 값은 부르는 쪽이 정한다(새 예약은 내일 오전 9:00, 행은 그 행의 시각, 명세 0.6). **열려 있는 동안 바뀌지
//   않는 값**을 넘겨야 한다: 바뀌면 사람이 고른 칸이 처음 값으로 되돌아간다.
// - 결과 문장은 `sendAtFromInputs`가 내는 **실제로 걸릴 시각**에서 그린다. 없는 현지 시각(서머타임 시작의 빈
//   시각)은 앞으로 밀려 계산되므로 사람이 입력한 칸과 문장이 어긋날 수 있고, 문장이 이긴다(명세 0.2).
// - 요청이 나는 동안(`pending`)은 Esc·바깥 누름으로 닫히지 않고 확인 단추는 흐려지지 않고 `aria-busy`다.
// - 열려 있는 동안 행이 마감 30초 안에 들거나 이미 나가면(`lock`) 저장을 잠그고 해당 문장을 말한다.
// - 오프라인이면 확인이 흐리고 `dialog.offline` 한 줄이 오류 줄 자리에 선다(대화상자는 입력창의 오프라인 줄이
//   보이는 자리가 아니다).
// =============================================================================

export type ScheduleDialogMode = "create" | "change" | "rearm";

export interface ScheduleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: ScheduleDialogMode;
  /** 닫힐 때 초점이 돌아갈 곳(▾ 단추나 행의 단추). */
  opener: DialogFocusTarget | null;
  /** 어디로 가는 글인가: 채널은 「#일반」, DM은 「김인턴과의 대화」. */
  placeLabel: string;
  /** 글 미리보기. 첨부만 있는 예약은 빈 문자열이다. */
  preview: string;
  /** 두 칸의 처음 값. 열려 있는 동안 바뀌지 않는 값이어야 한다. */
  initialAtMs: number;
  /** 쓰기가 날고 있다. */
  pending: boolean;
  /** 서버나 호출부가 말하는 오류. 대화상자가 열린 채 이유를 말한다. */
  error: ScheduledErrorLine | null;
  offline: boolean;
  /**
   * 서버가 예약을 껐다(앞선 쓰기가 503 `scheduler_disabled`, `useScheduled`의 5분 기억). 「예약하기」가 흐리고 이유와 다음 행동이
   * 오류 줄 자리에 선다(명세 0.5 ③): 눌러도 같은 거절만 돌아오는 단추는 만들지 않는다. 기억이 끝나면 풀려 한 번 더 시도할 수 있다.
   */
  unavailable?: boolean;
  /** 열린 행의 잠금(`editLock`). 생략하면 열려 있다. */
  lock?: "open" | "tooLate" | "gone";
  /** 이 글에 모델 지정(`routing`)이 켜져 있다: 예약에는 담기지 않는다고 한 줄 말한다(ADR-0208 D1, 명세 0.4). */
  routingNote?: boolean;
  onCommit: (atMs: number) => void;
  /**
   * 닫힌 뒤 초점이 갈 곳을 호출부가 정하려 할 때(`preventDefault`). 행이 구획을 옮겨 가서 열었던 단추가 사라지는
   * 「다시 예약」이 쓴다. 생략하면 `opener`로 돌아간다.
   */
  onCloseAutoFocus?: (event: Event) => void;
  /** 시험이 시계를 고정한다. */
  nowMs?: number;
}

const TITLES: Record<ScheduleDialogMode, string> = {
  create: SCHEDULED_COPY.dialog.title,
  change: SCHEDULED_COPY.dialog.titleChange,
  rearm: SCHEDULED_COPY.dialog.titleRearm,
};

export function ScheduleDialog({
  open,
  onOpenChange,
  mode,
  opener,
  placeLabel,
  preview,
  initialAtMs,
  pending,
  error,
  offline,
  unavailable = false,
  lock = "open",
  routingNote = false,
  onCommit,
  onCloseAutoFocus,
  nowMs,
}: ScheduleDialogProps) {
  const dateId = useId();
  const timeId = useId();
  const [date, setDate] = useState("");
  const [time, setTime] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const inputs = sendAtInputs(initialAtMs);
    setDate(inputs.date);
    setTime(inputs.time);
    setLocalError(null);
  }, [open, initialAtMs]);

  const now = nowMs ?? Date.now();
  const atMs = sendAtFromInputs(date, time);
  const sentence = atMs === null ? "" : SCHEDULED_COPY.dialog.preview(formatScheduledAt(atMs, now).full);
  const zone = scheduledZoneLine(atMs ?? initialAtMs);
  const locked = lock !== "open";
  const busy = pending || offline || locked || unavailable;

  // 오류 줄 자리는 하나다: 잠금 > 오프라인 > 예약을 끈 서버 > 호출부의 오류 > 확인 전 검증.
  const shown: ScheduledErrorLine | null = locked
    ? { text: lock === "tooLate" ? SCHEDULED_COPY.error.tooLate : SCHEDULED_COPY.errors.alreadySent }
    : offline
      ? { text: SCHEDULED_COPY.dialog.offline }
      : unavailable
        ? { text: SCHEDULED_COPY.disabled.unavailable.reason, next: SCHEDULED_COPY.disabled.unavailable.next }
        : (error ?? (localError === null ? null : { text: localError }));

  const commit = (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    const chosen = sendAtFromInputs(date, time);
    const problem = validateSendAt(chosen, nowMs ?? Date.now());
    if (problem !== null || chosen === null) {
      setLocalError(sendAtProblemSentence(problem ?? "invalid"));
      return;
    }
    setLocalError(null);
    onCommit(chosen);
  };

  const commitLabel = mode === "change" ? SCHEDULED_COPY.dialog.commitChange : SCHEDULED_COPY.dialog.commit;
  const savingLabel = mode === "change" ? SCHEDULED_COPY.edit.saving : SCHEDULED_COPY.dialog.saving;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // 요청이 나는 동안은 Esc도 바깥 누름도 닫지 않는다. 결과를 모르는 채 화면이 사라지면 안 된다.
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent
        opener={opener}
        data-testid="schedule-dialog"
        className="gap-3 p-4"
        {...(onCloseAutoFocus === undefined ? {} : { onCloseAutoFocus })}
      >
        <DialogTitle>{TITLES[mode]}</DialogTitle>
        <DialogDescription className="break-keep">{SCHEDULED_COPY.dialog.description}</DialogDescription>

        <div className="flex min-w-0 flex-col gap-1">
          <p className="min-w-0 truncate text-meta font-semibold text-ink" data-testid="schedule-dialog-place">
            {placeLabel}
          </p>
          {preview !== "" && (
            <p className="line-clamp-2 break-keep text-meta text-ink-muted" data-testid="schedule-dialog-preview">
              {preview}
            </p>
          )}
        </div>

        <form className="flex min-w-0 flex-col gap-3" onSubmit={commit} noValidate>
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={dateId} className="text-meta text-ink-muted">
                {SCHEDULED_COPY.dialog.date}
              </label>
              <Input
                id={dateId}
                type="date"
                value={date}
                max={sendAtInputs(now + SCHEDULED_MAX_LEAD_MS).date}
                disabled={pending || offline || unavailable}
                onChange={(event) => {
                  setDate(event.target.value);
                  setLocalError(null);
                }}
                data-testid="schedule-dialog-date"
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
                disabled={pending || offline || unavailable}
                onChange={(event) => {
                  setTime(event.target.value);
                  setLocalError(null);
                }}
                data-testid="schedule-dialog-time"
              />
            </div>
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <p
              className="text-body text-ink"
              aria-live="polite"
              data-numeric
              data-testid="schedule-dialog-result"
            >
              {sentence === "" ? "\u00a0" : sentence}
            </p>
            <p className="text-meta text-ink-muted" data-testid="schedule-dialog-zone">
              {zone}
            </p>
            {routingNote && (
              <p className="break-keep text-meta text-ink-muted" data-testid="schedule-dialog-routing-note">
                {SCHEDULED_COPY.menu.routingNote}
              </p>
            )}
            {shown !== null && (
              <div className="flex flex-col gap-1" role="alert" data-testid="schedule-dialog-error">
                <p className="break-keep text-meta text-danger">{shown.text}</p>
                {shown.next !== undefined && (
                  <p className="break-keep text-meta text-ink-muted">{shown.next}</p>
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              data-testid="schedule-dialog-cancel"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              {SCHEDULED_COPY.dialog.cancel}
            </Button>
            <Button
              type="submit"
              disabled={offline || locked || unavailable}
              aria-busy={pending || undefined}
              data-testid="schedule-dialog-commit"
            >
              {pending && <Loader2 aria-hidden="true" className="spinner-busy" />}
              {pending ? savingLabel : commitLabel}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
