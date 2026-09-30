import { useEffect, useRef, useState } from "react";
import { Button } from "@/design/ui/button";
import { Input } from "@/design/ui/input";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { InlineBanner } from "@/features/common/States";
import { Field } from "@/features/settings/SettingsFields";
import {
  MEMORY_RESET_ADMIN_ONLY,
  MEMORY_RESET_AUDIT,
  MEMORY_RESET_BUSY,
  MEMORY_RESET_CANCEL,
  MEMORY_RESET_CONFIRM_BUTTON,
  MEMORY_RESET_CONFIRM_LABEL,
  MEMORY_RESET_DELETES,
  MEMORY_RESET_FROM_NOW,
  MEMORY_RESET_KEEPS_FORGOTTEN,
  MEMORY_RESET_KEEPS_SWITCHES,
  MEMORY_RESET_LEAD,
  MEMORY_RESET_OFFLINE,
  MEMORY_RESET_TRIGGER,
  memoryResetConfirmed,
  memoryResetDoneCounts,
  memoryResetDoneMessage,
  memoryResetFailure,
} from "@momo/core/features/memory/presentation";
import { useResetWorkspaceMemory } from "./useMemory";

// =============================================================================
// 기억 초기화 (ADR-0196 D9, #3212). owner/admin only.
//
// idle -> confirming (typed word) -> running -> done | one of the failures.
// The server has the last word: `expectedEpoch` is the one the settings showed,
// so a second press (409) erases nothing, and a 403 from a stale role table says
// who may. A member sees a sentence, never a button.
// =============================================================================

const PANEL_ID = "memory-reset";
const REASON_ID = "memory-reset-reason";

export function MemoryResetPanel({
  workspaceId,
  canReset,
  offline,
  epoch,
}: {
  workspaceId: string;
  canReset: boolean;
  offline: boolean;
  epoch: number;
}) {
  const reset = useResetWorkspaceMemory(workspaceId);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const restoreFocus = useRef(false);
  const running = reset.isPending;
  const failure = reset.isError ? memoryResetFailure(reset.error) : null;
  const armed = memoryResetConfirmed(typed);

  function close() {
    restoreFocus.current = true;
    setConfirming(false);
    setTyped("");
  }

  useEffect(() => {
    if (confirming) {
      inputRef.current?.focus({ preventScroll: true });
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [confirming]);

  // Esc backs out of the question and nothing else; an in-flight erase cannot be backed out of.
  useEscapeLayer(confirming && !running, close);

  function submit() {
    if (!armed || running || offline) return;
    reset.mutate(epoch, {
      onSuccess: () => close(),
      onError: (error) => {
        const kind = memoryResetFailure(error).kind;
        // A stale epoch or a 403 ends the question: the state on screen is not the server's any more.
        if (kind === "stale" || kind === "forbidden") close();
      },
    });
  }

  const doneEpoch = reset.isSuccess ? reset.data.epoch : null;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid={PANEL_ID}>
      <div className="flex min-w-0 flex-col gap-1">
        <p className="break-keep text-meta text-ink-muted">{MEMORY_RESET_LEAD}</p>
        <ul className="flex list-disc flex-col gap-px pl-4 marker:text-ink-muted">
          {[
            MEMORY_RESET_DELETES,
            MEMORY_RESET_KEEPS_SWITCHES,
            MEMORY_RESET_KEEPS_FORGOTTEN,
            MEMORY_RESET_FROM_NOW,
            MEMORY_RESET_AUDIT,
          ].map((line) => (
            <li key={line} className="break-keep text-meta text-ink-muted">
              {line}
            </li>
          ))}
        </ul>
      </div>

      {doneEpoch !== null && reset.data && (
        <p
          role="status"
          className="break-keep text-meta text-ink"
          data-testid="memory-reset-done"
        >
          {memoryResetDoneMessage(doneEpoch)} {memoryResetDoneCounts(reset.data)}
        </p>
      )}

      {!canReset ? (
        <p className="break-keep text-meta text-ink-muted" data-testid="memory-reset-admin-only">
          {MEMORY_RESET_ADMIN_ONLY}
        </p>
      ) : !confirming ? (
        <div className="flex min-w-0 flex-col items-start gap-1">
          {offline && (
            <p id={REASON_ID} className="text-meta text-ink-muted" data-testid="memory-reset-offline">
              {MEMORY_RESET_OFFLINE}
            </p>
          )}
          <Button
            ref={triggerRef}
            type="button"
            variant="outline"
            size="sm"
            aria-disabled={offline || undefined}
            aria-describedby={offline ? REASON_ID : undefined}
            className={offline ? "opacity-50 text-danger" : "text-danger"}
            onClick={() => {
              if (offline) return;
              reset.reset();
              setConfirming(true);
            }}
            data-testid="memory-reset-open"
          >
            {MEMORY_RESET_TRIGGER}
          </Button>
        </div>
      ) : (
        <form
          className="flex min-w-0 flex-col gap-3 rounded-md border border-danger p-3"
          aria-label="기억 초기화 확인"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
          data-testid="memory-reset-confirm"
        >
          <Field label={MEMORY_RESET_CONFIRM_LABEL} htmlFor="memory-reset-word">
            <Input
              id="memory-reset-word"
              ref={inputRef}
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              readOnly={running}
              data-testid="memory-reset-word"
            />
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              variant="destructive"
              size="sm"
              aria-disabled={!armed || offline || undefined}
              aria-busy={running || undefined}
              className={!armed || offline ? "opacity-50" : undefined}
              data-testid="memory-reset-submit"
            >
              {running ? MEMORY_RESET_BUSY : MEMORY_RESET_CONFIRM_BUTTON}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-disabled={running || undefined}
              className={running ? "opacity-50" : undefined}
              onClick={() => {
                if (!running) close();
              }}
              data-testid="memory-reset-cancel"
            >
              {MEMORY_RESET_CANCEL}
            </Button>
          </div>
        </form>
      )}
      {/* Under the controls it belongs to, so a retry never has to look upward for the reason. */}
      {failure !== null && (
        <div data-kind={failure.kind} data-testid="memory-reset-error-kind">
          <InlineBanner message={failure.message} testId="memory-reset-error" />
        </div>
      )}
    </div>
  );
}
