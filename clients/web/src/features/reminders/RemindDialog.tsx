import { useEffect, useId, useState } from "react";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import {
  customDueAtMs,
  localDateInputValue,
  reminderPresetDueAtMs,
  REMINDER_PRESETS,
  type ReminderPresetId,
} from "@momo/core/features/reminders/presets";
import {
  clampReminderNote,
  REMINDER_CUSTOM_LABEL,
  REMINDER_MENU_LABEL,
  REMINDER_NOTE_MAX,
} from "@momo/core/features/reminders/model";

// Reading this as: message overflow / inbox snooze dialog for internal team
// users on web+Tauri, density 7/10, motion 2/10.

export function RemindDialog({
  open,
  onOpenChange,
  mode,
  preview,
  pending,
  error,
  onCommit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  mode: "create" | "snooze";
  preview?: string;
  pending: boolean;
  error: string | null;
  onCommit: (dueAtMs: number, note: string) => void;
}) {
  const noteId = useId();
  const dateId = useId();
  const timeId = useId();
  const offline = useOffline();
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("09:00");
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const seed = Date.now() + 24 * 60 * 60_000;
    setNote("");
    setDate(localDateInputValue(seed));
    setTime("09:00");
    setCustomError(null);
  }, [open]);

  const commitPreset = (id: ReminderPresetId) => {
    if (pending || offline) return;
    onCommit(reminderPresetDueAtMs(id, Date.now()), clampReminderNote(note));
  };

  const commitCustom = () => {
    if (pending || offline) return;
    const dueAtMs = customDueAtMs(date, time);
    if (dueAtMs === null) {
      setCustomError("날짜와 시간을 확인하세요.");
      return;
    }
    if (dueAtMs <= Date.now()) {
      setCustomError("지난 시각은 고를 수 없습니다. 다른 시각을 고르세요.");
      return;
    }
    setCustomError(null);
    onCommit(dueAtMs, clampReminderNote(note));
  };

  const title = mode === "snooze" ? "알림 미루기" : REMINDER_MENU_LABEL;
  const description =
    mode === "snooze"
      ? "이 알림을 다시 볼 시각을 고릅니다."
      : "이 메시지를 다시 볼 시각을 고릅니다.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="remind-dialog" className="gap-3 p-4">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        {preview ? (
          <p
            className="line-clamp-2 text-meta text-ink-muted"
            data-testid="remind-dialog-preview"
          >
            {preview}
          </p>
        ) : null}

        {offline && (
          <InlineBanner
            tone="neutral"
            message="연결이 끊겨 지금은 알림을 저장할 수 없습니다."
            testId="remind-dialog-offline"
          />
        )}
        {error && (
          <InlineBanner message={error} testId="remind-dialog-error" />
        )}

        {mode === "create" && (
          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={noteId} className="text-meta text-ink-muted">
              메모 (선택, {REMINDER_NOTE_MAX}자)
            </label>
            <textarea
              id={noteId}
              value={note}
              maxLength={REMINDER_NOTE_MAX}
              rows={2}
              disabled={pending || offline}
              onChange={(event) => setNote(event.target.value)}
              className="w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              placeholder="왜 다시 보는지"
              data-testid="remind-note"
            />
          </div>
        )}

        <div className="flex flex-wrap gap-2" role="group" aria-label="알림 시각">
          {REMINDER_PRESETS.map((preset) => (
            <Button
              key={preset.id}
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending || offline}
              onClick={() => commitPreset(preset.id)}
              data-testid={`remind-preset-${preset.id}`}
            >
              {preset.label}
            </Button>
          ))}
        </div>

        <div className="flex min-w-0 flex-col gap-2 border-t border-line pt-3">
          <p className="text-meta text-ink-muted">{REMINDER_CUSTOM_LABEL}</p>
          <div className="flex flex-wrap gap-2">
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={dateId} className="text-meta text-ink-muted">
                날짜
              </label>
              <Input
                id={dateId}
                type="date"
                value={date}
                disabled={pending || offline}
                onChange={(event) => setDate(event.target.value)}
                data-testid="remind-custom-date"
              />
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <label htmlFor={timeId} className="text-meta text-ink-muted">
                시간
              </label>
              <Input
                id={timeId}
                type="time"
                value={time}
                disabled={pending || offline}
                onChange={(event) => setTime(event.target.value)}
                data-testid="remind-custom-time"
              />
            </div>
          </div>
          {customError ? (
            <p className="text-meta text-danger" role="alert">
              {customError}
            </p>
          ) : null}
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button
            type="button"
            variant="secondary"
            data-testid="remind-dialog-cancel"
            onClick={() => onOpenChange(false)}
          >
            취소
          </Button>
          <Button
            type="button"
            disabled={pending || offline}
            data-testid="remind-dialog-custom-commit"
            onClick={commitCustom}
          >
            {pending ? "저장 중…" : "이 시각에 알림"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
