import type { ChangeEvent, ReactNode, Ref } from "react";
import { Input } from "@/design/ui/input";
import { cn } from "@/design/lib/cn";
import { handleFieldError, isValidHandle, normalizeHandle } from "./identityCopy";

// Reading this as: onboarding / settings handle field for internal team users
// on web+Tauri, density 6/10, motion 2/10.
//
// The @ lives inside the box so the three field edges align. Input has no
// adornment slot; a relative wrapper is the smallest house-shaped substitute.

export function HandleField({
  id,
  value,
  onChange,
  error,
  errorId,
  describedBy,
  testId,
  errorTestId,
  previewTestId,
  offline = false,
  inputRef,
  label = "핸들",
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  error: string | null;
  errorId: string;
  describedBy?: string;
  testId: string;
  errorTestId: string;
  previewTestId?: string;
  offline?: boolean;
  inputRef?: Ref<HTMLInputElement>;
  label?: ReactNode;
}) {
  const normalized = normalizeHandle(value);
  const showPreview =
    value.length > 0 &&
    value !== normalized &&
    isValidHandle(normalized) &&
    handleFieldError(value) === null;

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    onChange(event.currentTarget.value);
  };

  return (
    <label htmlFor={id} className="flex flex-col gap-1 text-body">
      {typeof label === "string" ? (
        <span className="text-ink-muted">{label}</span>
      ) : (
        label
      )}
      <div className="relative">
        <span
          className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-ink-muted"
          aria-hidden="true"
        >
          @
        </span>
        <Input
          ref={inputRef}
          id={id}
          name="handle"
          value={value}
          autoComplete="username"
          spellCheck={false}
          disabled={offline}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            [error ? errorId : null, describedBy ?? null].filter(Boolean).join(" ") ||
            undefined
          }
          className="pl-8"
          data-testid={testId}
          onChange={handleChange}
        />
      </div>
      {showPreview ? (
        <p
          className="break-keep text-meta text-ink-muted"
          data-testid={previewTestId ?? `${testId}-preview`}
        >
          저장되는 핸들 @{normalized}
        </p>
      ) : null}
      {error ? (
        <p
          id={errorId}
          role="alert"
          className={cn("text-meta text-danger")}
          data-testid={errorTestId}
        >
          {error}
        </p>
      ) : null}
    </label>
  );
}
