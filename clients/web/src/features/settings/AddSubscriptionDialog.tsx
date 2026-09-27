import { useEffect, useId, useRef, useState, type RefObject } from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { LOCAL_HARNESS_IDS } from "@momo/core/features/hostedAgents/detect";
import { loginActionLabel } from "@momo/core/features/onboarding/harnessLogin";
import {
  ADD_SUBSCRIPTION_CHIP,
  ADD_SUBSCRIPTION_CLI_LABEL,
  ADD_SUBSCRIPTION_GROK_CHIP,
  ADD_SUBSCRIPTION_LABEL_HINT,
  ADD_SUBSCRIPTION_LABEL_LABEL,
  ADD_SUBSCRIPTION_LEAD,
  ADD_SUBSCRIPTION_NOT_INSTALLED,
  ADD_SUBSCRIPTION_TITLE,
  normalizeProfileLabel,
  profileLabelProblem,
} from "@momo/core/features/settings/harnessProfiles";
import { cn } from "@/design/lib/cn";
import { Button } from "@/design/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/design/ui/dialog";
import { Input } from "@/design/ui/input";

// Reading this as: settings (AI 연결 · 내 계정) for internal team users on Tauri
// desktop, density 5/10, motion 1/10 (the dialog's own enter/exit only).

export interface AddSubscriptionDraft {
  harness: LocalHarnessId;
  label: string;
}

/**
 * 구독 추가 (#2878, 시안 §4 「1. 종류와 라벨」의 구독 쪽).
 *
 * CLI와 라벨을 고르면 부른 쪽이 그 라벨의 프로필 폴더를 만들고(셸) #2816 로그인
 * 모달을 그 프로필로 연다. 주 단추 이름은 로그인하는 주체다(「Claude Code로
 * 로그인」). API 키는 팀 연결 절의 「API 키 추가」가 맡는다(시안과의 차이 표).
 */
export function AddSubscriptionDialog({
  open,
  opener,
  installed,
  takenLabels,
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  open: boolean;
  opener: RefObject<HTMLElement | null>;
  /** 이 맥에 설치된 CLI. 없는 CLI의 칩은 흐리게 선다. */
  installed: readonly LocalHarnessId[];
  /** 하네스마다 이미 있는 프로필 라벨. */
  takenLabels: Readonly<Record<LocalHarnessId, readonly string[]>>;
  /** 로그인이 실패·취소돼 돌아왔을 때의 값. */
  initial: AddSubscriptionDraft | null;
  busy: boolean;
  /** 셸이 폴더를 만들지 못한 까닭(문장). */
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: AddSubscriptionDraft) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {open && (
        <DialogContent
          opener={opener.current}
          className="gap-4 p-6"
          data-testid="add-subscription-dialog"
        >
          <AddBody
            installed={installed}
            takenLabels={takenLabels}
            initial={initial}
            busy={busy}
            error={error}
            onCancel={onCancel}
            onSubmit={onSubmit}
          />
        </DialogContent>
      )}
    </Dialog>
  );
}

function AddBody({
  installed,
  takenLabels,
  initial,
  busy,
  error,
  onCancel,
  onSubmit,
}: {
  installed: readonly LocalHarnessId[];
  takenLabels: Readonly<Record<LocalHarnessId, readonly string[]>>;
  initial: AddSubscriptionDraft | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSubmit: (draft: AddSubscriptionDraft) => void;
}) {
  const firstInstalled = LOCAL_HARNESS_IDS.find((id) => installed.includes(id)) ?? "claude";
  const [harness, setHarness] = useState<LocalHarnessId>(initial?.harness ?? firstInstalled);
  const [label, setLabel] = useState(initial?.label ?? "");
  const [touched, setTouched] = useState(initial !== null);
  const labelId = useId();
  const hintId = `${labelId}-hint`;
  const errorId = `${labelId}-error`;
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const problem = profileLabelProblem(label, takenLabels[harness] ?? []);
  const shownProblem = touched ? (problem ?? error) : error;
  const harnessReady = installed.includes(harness);
  const blocked = busy || problem !== null || !harnessReady;

  const submit = () => {
    setTouched(true);
    if (blocked) return;
    onSubmit({ harness, label: normalizeProfileLabel(label) });
  };

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <DialogTitle className="text-title font-bold">{ADD_SUBSCRIPTION_TITLE}</DialogTitle>
        <DialogDescription className="break-keep text-body text-ink-muted">
          {ADD_SUBSCRIPTION_LEAD}
        </DialogDescription>
      </div>

      <fieldset className="flex min-w-0 flex-col gap-2">
        <legend className="pb-2 text-meta font-semibold text-ink">{ADD_SUBSCRIPTION_CLI_LABEL}</legend>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={ADD_SUBSCRIPTION_CLI_LABEL}>
          {LOCAL_HARNESS_IDS.map((id) => {
            const ready = installed.includes(id);
            const checked = harness === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={checked}
                aria-disabled={!ready || undefined}
                tabIndex={checked ? 0 : -1}
                className={cn(
                  "tap-target press inline-flex min-h-control items-center gap-1 rounded-full border px-3 text-body focus-visible:focus-ring",
                  checked
                    ? "border-signal bg-signal-soft font-semibold text-ink"
                    : "border-line-strong text-ink hover:bg-surface-hover",
                  !ready && "opacity-50 hover:bg-transparent"
                )}
                onClick={() => {
                  if (ready) setHarness(id);
                }}
                onKeyDown={(event) => {
                  if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
                  event.preventDefault();
                  const order = LOCAL_HARNESS_IDS.filter((row) => installed.includes(row));
                  const at = order.indexOf(harness);
                  const next = order[(at + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
                  if (next) {
                    setHarness(next);
                    (event.currentTarget.parentElement?.querySelector(`[data-harness="${next}"]`) as HTMLElement | null)?.focus();
                  }
                }}
                data-harness={id}
                data-testid={`add-subscription-cli-${id}`}
              >
                {ADD_SUBSCRIPTION_CHIP[id]}
                {!ready && <span className="text-meta text-ink-muted"> · {ADD_SUBSCRIPTION_NOT_INSTALLED}</span>}
              </button>
            );
          })}
          <span
            className="inline-flex min-h-control items-center rounded-full border border-line px-3 text-body text-ink-muted opacity-60"
            aria-disabled="true"
            data-testid="add-subscription-cli-grok"
          >
            {ADD_SUBSCRIPTION_GROK_CHIP}
          </span>
        </div>
      </fieldset>

      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={labelId} className="text-meta font-semibold text-ink">
          {ADD_SUBSCRIPTION_LABEL_LABEL}
        </label>
        <Input
          ref={inputRef}
          id={labelId}
          value={label}
          placeholder="예: 개인, 회사"
          maxLength={64}
          autoComplete="off"
          onChange={(event) => setLabel(event.target.value)}
          onBlur={() => setTouched(true)}
          aria-invalid={shownProblem ? true : undefined}
          aria-describedby={shownProblem ? `${errorId} ${hintId}` : hintId}
          data-testid="add-subscription-label"
        />
        {shownProblem && (
          <p id={errorId} className="break-keep text-meta text-danger" role="alert" data-testid="add-subscription-error">
            {shownProblem}
          </p>
        )}
        <p id={hintId} className="break-keep text-meta text-ink-muted">
          {ADD_SUBSCRIPTION_LABEL_HINT}
        </p>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
        <Button type="button" variant="ghost" onClick={onCancel} data-testid="add-subscription-cancel">
          취소
        </Button>
        <Button
          type="submit"
          aria-disabled={blocked || undefined}
          aria-busy={busy || undefined}
          className={cn(blocked && !busy && "opacity-50 hover:opacity-50")}
          data-testid="add-subscription-submit"
        >
          {loginActionLabel(harness)}
        </Button>
      </div>
    </form>
  );
}
