import { useEffect, useId, useRef, useState } from "react";
import { Smile } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  setPresenceStatus,
  uuidEq,
  type PresenceStatus,
  type RosterMember,
} from "@momo/core/lib/api";
import {
  clampStatusText,
  clearCustomStatusWrite,
  CUSTOM_STATUS_CLEAR_LABEL,
  CUSTOM_STATUS_CANCEL_LABEL,
  CUSTOM_STATUS_DIALOG_DESCRIPTION,
  CUSTOM_STATUS_DIALOG_TITLE,
  CUSTOM_STATUS_EMOJI_CLEAR_LABEL,
  CUSTOM_STATUS_EMOJI_LABEL,
  CUSTOM_STATUS_EXPIRY_LABEL,
  CUSTOM_STATUS_PRESETS,
  CUSTOM_STATUS_SAVE_LABEL,
  CUSTOM_STATUS_SAVING_LABEL,
  CUSTOM_STATUS_TEXT_LABEL,
  CUSTOM_STATUS_TEXT_MAX,
  CUSTOM_STATUS_TEXT_PLACEHOLDER,
  customExpiryAtMs,
  customStatusClearFailureMessage,
  customStatusFailureMessage,
  localDateInputValue,
  localTimeInputValue,
  STATUS_EXPIRY_OPTIONS,
  statusExpiryAtMs,
  visibleCustomStatus,
  type StatusExpiryChoice,
} from "@momo/core/features/presence/customStatus";
import { Button } from "@/design/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  type DialogFocusTarget,
} from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";
import { Select } from "@/design/ui/select";
import { InlineBanner } from "@/features/common/States";
import { useOffline } from "@/features/common/useOffline";
import { EmojiPickerDialog } from "@/features/emoji/EmojiPickerDialog";

// Reading this as: settings dialog (sidebar profile card) for internal team
// users on web+Tauri, density 7/10, motion 2/10.

function applyCustomToRoster(
  rows: RosterMember[] | undefined,
  selfMemberId: string,
  patch: {
    statusEmoji?: string;
    statusText?: string;
    statusExpiresAtMs?: number;
  } | null
): RosterMember[] | undefined {
  return rows?.map((row) => {
    if (!uuidEq(row.id, selfMemberId)) return row;
    const next: RosterMember = { ...row };
    delete next.statusEmoji;
    delete next.statusText;
    delete next.statusExpiresAtMs;
    if (patch?.statusEmoji) next.statusEmoji = patch.statusEmoji;
    if (patch?.statusText) next.statusText = patch.statusText;
    if (patch?.statusExpiresAtMs !== undefined) {
      next.statusExpiresAtMs = patch.statusExpiresAtMs;
    }
    return next;
  });
}

function seedExpiryFields(
  expiresAtMs: number | undefined,
  now: number
): {
  expiry: StatusExpiryChoice;
  date: string;
  time: string;
} {
  const placeholder = now + 60 * 60_000;
  if (expiresAtMs === undefined || expiresAtMs < now) {
    return {
      expiry: "none",
      date: localDateInputValue(placeholder),
      time: localTimeInputValue(placeholder),
    };
  }
  return {
    expiry: "custom",
    date: localDateInputValue(expiresAtMs),
    time: localTimeInputValue(expiresAtMs),
  };
}

export function SetStatusDialog({
  open,
  onOpenChange,
  workspaceId,
  selfMemberId,
  selfMember,
  opener,
  nowMs,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  selfMemberId: string;
  selfMember: RosterMember | null | undefined;
  opener: DialogFocusTarget | null;
  nowMs?: number;
}) {
  const client = useQueryClient();
  const offline = useOffline();
  const textId = useId();
  const expiryId = useId();
  const dateId = useId();
  const timeId = useId();
  const emojiButtonRef = useRef<HTMLButtonElement>(null);
  const seededOpenRef = useRef(false);
  const [emoji, setEmoji] = useState("");
  const [text, setText] = useState("");
  const [expiry, setExpiry] = useState<StatusExpiryChoice>("none");
  const [date, setDate] = useState("");
  const [time, setTime] = useState("18:00");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  const declared: PresenceStatus = selfMember?.presenceStatus ?? "auto";
  const clock = nowMs ?? Date.now();
  const storedVisible = selfMember
    ? visibleCustomStatus(selfMember, clock)
    : null;
  const canClear = storedVisible !== null;

  useEffect(() => {
    if (!open) {
      seededOpenRef.current = false;
      return;
    }
    if (seededOpenRef.current) return;
    seededOpenRef.current = true;
    // Seed on the open event only. Roster identity changes (optimistic
    // write, error rollback) must not wipe the draft or the error banner
    // (design-review #1889 B-1). The seed walks the same read-edge as the
    // card and directory (H-2): an expired stamp does not come back.
    const now = nowMs ?? Date.now();
    const visible = selfMember ? visibleCustomStatus(selfMember, now) : null;
    setEmoji(visible?.emoji ?? "");
    setText(visible?.text ?? "");
    setFailed(null);
    setCustomError(null);
    setPickerOpen(false);
    const seeded = seedExpiryFields(
      visible ? selfMember?.statusExpiresAtMs : undefined,
      now
    );
    setExpiry(seeded.expiry);
    setDate(seeded.date);
    setTime(seeded.time);
  }, [open, selfMember, nowMs]);

  const mutation = useMutation({
    mutationFn: (write: Parameters<typeof setPresenceStatus>[1]) =>
      setPresenceStatus(workspaceId, write),
    onMutate: async (write) => {
      await client.cancelQueries({ queryKey: ["roster", workspaceId] });
      const previous = client.getQueryData<RosterMember[]>(["roster", workspaceId]);
      const clearing =
        write.statusEmoji === null &&
        write.statusText === null &&
        write.statusExpiresAtMs === null;
      client.setQueryData<RosterMember[]>(["roster", workspaceId], (rows) =>
        applyCustomToRoster(
          rows,
          selfMemberId,
          clearing
            ? null
            : {
                statusEmoji: write.statusEmoji ?? undefined,
                statusText: write.statusText ?? undefined,
                statusExpiresAtMs: write.statusExpiresAtMs ?? undefined,
              }
        )
      );
      return { previous };
    },
    onError: (_error, _write, context) => {
      if (context?.previous) {
        client.setQueryData(["roster", workspaceId], context.previous);
      }
    },
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ["roster", workspaceId] });
    },
  });

  const busy = mutation.isPending || offline;

  const commit = async (write: Parameters<typeof setPresenceStatus>[1], fail: string) => {
    if (busy) return;
    setFailed(null);
    try {
      await mutation.mutateAsync(write);
      onOpenChange(false);
    } catch {
      setFailed(fail);
    }
  };

  const save = () => {
    if (busy) return;
    const trimmed = clampStatusText(text);
    let expiresAtMs: number | null = null;
    if (expiry === "30m" || expiry === "1h" || expiry === "today") {
      expiresAtMs = statusExpiryAtMs(expiry, nowMs ?? Date.now());
    } else if (expiry === "custom") {
      const custom = customExpiryAtMs(date, time);
      if (custom === null) {
        setCustomError("날짜와 시간을 확인하세요.");
        return;
      }
      if (custom < (nowMs ?? Date.now())) {
        setCustomError("지난 시각은 고를 수 없습니다. 다른 시각을 고르세요.");
        return;
      }
      expiresAtMs = custom;
    }
    setCustomError(null);
    if (emoji.trim() === "" && trimmed === "") {
      void commit(clearCustomStatusWrite(declared), customStatusClearFailureMessage());
      return;
    }
    void commit(
      {
        status: declared,
        statusEmoji: emoji.trim() === "" ? null : emoji,
        statusText: trimmed === "" ? null : trimmed,
        statusExpiresAtMs: expiresAtMs,
      },
      customStatusFailureMessage()
    );
  };

  return (
    <>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (mutation.isPending) return;
          onOpenChange(next);
        }}
      >
        <DialogContent
          opener={opener}
          data-testid="set-status-dialog"
          className="gap-3 p-4"
        >
          <DialogTitle>{CUSTOM_STATUS_DIALOG_TITLE}</DialogTitle>
          <DialogDescription>{CUSTOM_STATUS_DIALOG_DESCRIPTION}</DialogDescription>

          {offline && (
            <InlineBanner
              tone="neutral"
              message="연결이 끊겨 지금은 상태를 바꿀 수 없습니다."
              testId="set-status-offline"
            />
          )}
          {failed && (
            <InlineBanner message={failed} testId="set-status-error" />
          )}

          <div className="flex flex-wrap items-center gap-2">
            <Button
              ref={emojiButtonRef}
              type="button"
              variant="outline"
              size="sm"
              className="tap-target"
              disabled={busy}
              aria-label={CUSTOM_STATUS_EMOJI_LABEL}
              data-testid="set-status-emoji"
              onClick={() => setPickerOpen(true)}
            >
              {emoji ? (
                <span aria-hidden="true">{emoji}</span>
              ) : (
                <Smile aria-hidden="true" />
              )}
            </Button>
            {emoji ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="tap-target"
                disabled={busy}
                data-testid="set-status-emoji-clear"
                onClick={() => setEmoji("")}
              >
                {CUSTOM_STATUS_EMOJI_CLEAR_LABEL}
              </Button>
            ) : null}
          </div>

          <div
            className="flex flex-wrap gap-2"
            role="group"
            aria-label="상태 프리셋"
          >
            {CUSTOM_STATUS_PRESETS.map((preset) => (
              <Button
                key={preset.id}
                type="button"
                size="sm"
                variant="secondary"
                className="tap-target"
                disabled={busy}
                data-testid={`set-status-preset-${preset.id}`}
                onClick={() => {
                  setEmoji(preset.emoji);
                  setText(preset.label);
                }}
              >
                <span aria-hidden="true">{preset.emoji}</span>
                {preset.label}
              </Button>
            ))}
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={textId} className="text-meta text-ink-muted">
              {CUSTOM_STATUS_TEXT_LABEL} (선택, {CUSTOM_STATUS_TEXT_MAX}자)
            </label>
            <textarea
              id={textId}
              value={text}
              maxLength={CUSTOM_STATUS_TEXT_MAX}
              rows={2}
              disabled={busy}
              placeholder={CUSTOM_STATUS_TEXT_PLACEHOLDER}
              onChange={(event) => setText(event.target.value)}
              className="tap-target w-full resize-y rounded-sm border border-line-strong bg-transparent px-3 py-2 text-body text-ink placeholder:text-ink-muted focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
              data-testid="set-status-text"
            />
          </div>

          <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={expiryId} className="text-meta text-ink-muted">
              {CUSTOM_STATUS_EXPIRY_LABEL}
            </label>
            <Select
              id={expiryId}
              value={expiry}
              disabled={busy}
              data-testid="set-status-expiry"
              onChange={(event) =>
                setExpiry(event.currentTarget.value as StatusExpiryChoice)
              }
            >
              {STATUS_EXPIRY_OPTIONS.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </Select>
          </div>

          {expiry === "custom" ? (
            <div className="flex flex-wrap gap-2">
              <div className="flex min-w-0 flex-col gap-1">
                <label htmlFor={dateId} className="text-meta text-ink-muted">
                  날짜
                </label>
                <Input
                  id={dateId}
                  type="date"
                  value={date}
                  disabled={busy}
                  onChange={(event) => setDate(event.target.value)}
                  data-testid="set-status-custom-date"
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
                  disabled={busy}
                  onChange={(event) => setTime(event.target.value)}
                  data-testid="set-status-custom-time"
                />
              </div>
            </div>
          ) : null}
          {customError ? (
            <p className="text-meta text-danger" role="alert">
              {customError}
            </p>
          ) : null}

          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button
              type="button"
              variant="secondary"
              data-testid="set-status-cancel"
              onClick={() => onOpenChange(false)}
            >
              {CUSTOM_STATUS_CANCEL_LABEL}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !canClear}
              data-testid="set-status-clear"
              onClick={() =>
                void commit(
                  clearCustomStatusWrite(declared),
                  customStatusClearFailureMessage()
                )
              }
            >
              {CUSTOM_STATUS_CLEAR_LABEL}
            </Button>
            <Button
              type="button"
              disabled={busy}
              data-testid="set-status-save"
              onClick={save}
            >
              {mutation.isPending
                ? CUSTOM_STATUS_SAVING_LABEL
                : CUSTOM_STATUS_SAVE_LABEL}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <EmojiPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onPick={(picked) => setEmoji(picked)}
        opener={emojiButtonRef.current}
        purpose="status"
        testId="set-status-emoji-picker"
      />
    </>
  );
}
