import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/design/ui/button";
import { cn } from "@/design/lib/cn";

// =============================================================================
// Presentational parts shared by the settings sections (R-1 §5). Flat rows and
// typed key-value lists, no card per row: elevation is reserved for grouping.
// =============================================================================

/** Section title plus the one or two lines that explain what it governs. */
export function SectionShell({
  title,
  lines,
  children,
}: {
  title: string;
  lines: string[];
  children: ReactNode;
}) {
  // A settings form is read line by line, so the panel keeps a measure instead
  // of stretching a slug field across a 1280px window.
  return (
    <section className="flex min-w-0 max-w-2xl flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-title font-semibold text-ink">{title}</h2>
        {lines.map((line) => (
          <p key={line} className="text-body text-ink-muted">
            {line}
          </p>
        ))}
      </div>
      {children}
    </section>
  );
}

/**
 * A block inside a section. One settings section can govern more than one thing
 * (코드 실행 호스트 governs the engine, the host-loss policy and the registry),
 * and three h2 sections in the nav for one subject would be worse than one
 * section with a real heading hierarchy inside it.
 */
export function Subsection({
  title,
  lines,
  children,
}: {
  title: string;
  lines?: string[];
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-col gap-px">
        <h3 className="text-body font-semibold text-ink">{title}</h3>
        {lines?.map((line) => (
          <p key={line} className="text-meta text-ink-muted">
            {line}
          </p>
        ))}
      </div>
      {children}
    </section>
  );
}

/**
 * Label above control, not a fixed label column: a Korean label and a full URL
 * do not share one width without truncating or an off-grid fixed size.
 */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string;
  htmlFor: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-meta text-ink-muted">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-meta text-ink-muted">{hint}</p>}
      {error && (
        <p className="text-meta text-danger" role="alert" id={`${htmlFor}-error`}>
          {error}
        </p>
      )}
    </div>
  );
}

export type ChipTone = "ok" | "warn" | "danger" | "accent" | "muted";

const CHIP_TONE: Record<ChipTone, string> = {
  ok: "border-ok text-ok",
  warn: "border-warn text-warn",
  danger: "border-danger text-danger",
  accent: "border-line bg-accent-soft text-ink",
  muted: "border-line text-ink-muted",
};

/** Text-first status chip. Never pulses, never carries meaning in color alone. */
export function StatusChip({
  tone,
  children,
}: {
  tone: ChipTone;
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm border px-2 py-px text-timestamp font-medium",
        CHIP_TONE[tone]
      )}
    >
      {children}
    </span>
  );
}

export interface KeyValue {
  key: string;
  value: ReactNode;
  numeric?: boolean;
}

/** Typed key-value rows. Raw payload dumps are banned from operator surfaces. */
export function KeyValueRows({ rows }: { rows: KeyValue[] }) {
  return (
    <dl className="flex flex-col gap-2">
      {rows.map((row) => (
        <div key={row.key} className="flex min-w-0 flex-col gap-px">
          <dt className="text-meta text-ink-muted">{row.key}</dt>
          <dd
            className={cn(
              "min-w-0 break-all text-body text-ink",
              row.numeric && "font-mono"
            )}
            data-numeric={row.numeric ? "" : undefined}
          >
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The 403 answer. An operator surface that the signed-in member may not touch
 * says who can, instead of showing a form whose save will always fail.
 */
export function OperatorNotice({
  who,
  contact,
}: {
  /** Full sentence: Korean particles depend on the noun, so callers write it. */
  who: string;
  contact: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-md border border-line bg-surface-raised p-4"
      data-testid="operator-notice"
      role="status"
    >
      <p className="text-body text-ink">{who}</p>
      <p className="text-body text-ink-muted">{contact}</p>
    </div>
  );
}

export interface RadioChoice {
  id: string;
  label: string;
  detail: string;
}

/**
 * Native radios inside a fieldset rather than a custom control: this bundle
 * carries no Radix RadioGroup, and the platform control already gives arrow-key
 * roving, the grouping a screen reader announces, and a focus ring.
 */
export function ChoiceRadios({
  name,
  legend,
  choices,
  value,
  onChange,
  disabled,
}: {
  name: string;
  legend: string;
  choices: RadioChoice[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-1" disabled={disabled}>
      <legend className="pb-1 text-meta text-ink-muted">{legend}</legend>
      {/* One bordered group with hairline rows, not a card per option: a box
          around every row is the web-card AI-tell and costs density. */}
      <div className="flex flex-col overflow-hidden rounded-md border border-line">
        {choices.map((choice) => (
          <label
            key={choice.id}
            htmlFor={`${name}-${choice.id}`}
            className={cn(
              "flex min-w-0 cursor-pointer items-start gap-2 border-b border-line p-2 last:border-b-0",
              value === choice.id ? "bg-accent-soft" : "hover:bg-surface-hover"
            )}
          >
            <input
              type="radio"
              id={`${name}-${choice.id}`}
              name={name}
              value={choice.id}
              checked={value === choice.id}
              onChange={() => onChange(choice.id)}
              className="mt-1 accent-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            />
            <span className="flex min-w-0 flex-col gap-px">
              <span className="text-body text-ink">{choice.label}</span>
              <span className="text-meta text-ink-muted">{choice.detail}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

export interface SelectChoice {
  id: string;
  label: string;
}

/**
 * One-line choice on a row, for a setting whose options are a closed list but
 * which does not deserve a fieldset of its own (the tier policy has two scopes,
 * so radios would put six rows on screen for two decisions).
 *
 * Native `<select>`: this bundle carries no Radix Select, and the platform
 * control already gives type-ahead, arrow keys, the collapsed value as its own
 * label, and a popup that a screen reader announces as a listbox. The only
 * thing added here is the token skin.
 */
export function SelectRow({
  id,
  label,
  hint,
  value,
  choices,
  onChange,
  disabled,
  testId,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  value: string;
  choices: SelectChoice[];
  onChange: (id: string) => void;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-b-0">
      <div className="flex min-w-0 flex-col gap-px">
        <label htmlFor={id} className="text-body text-ink">
          {label}
        </label>
        {hint && (
          <span id={`${id}-hint`} className="text-meta text-ink-muted">
            {hint}
          </span>
        )}
      </div>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-describedby={hint ? `${id}-hint` : undefined}
        data-testid={testId}
        className="h-control-sm min-w-0 shrink-0 rounded-sm border border-line-strong bg-surface-raised px-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Copy with inline confirmation. Toast stacks are banned, so the button itself
 * reports the result and resets after two seconds.
 */
export function CopyButton({
  value,
  label = "복사",
  testId,
}: {
  value: string;
  label?: string;
  testId?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard permission can be denied; the value stays selectable on screen.
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      data-testid={testId}
    >
      {copied ? "복사됨" : label}
    </Button>
  );
}

/**
 * Two-step confirmation for a destructive action. The first click only asks;
 * nothing irreversible ever happens on a single unguarded click.
 */
export function ConfirmButton({
  label,
  question,
  confirmLabel,
  onConfirm,
  disabled,
  testId,
}: {
  label: string;
  question: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
  testId?: string;
}) {
  const [asking, setAsking] = useState(false);

  if (!asking) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={disabled}
        onClick={() => setAsking(true)}
        data-testid={testId}
      >
        {label}
      </Button>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" role="group">
      <span className="text-meta text-ink">{question}</span>
      <Button
        type="button"
        variant="destructive"
        size="sm"
        disabled={disabled}
        onClick={() => {
          setAsking(false);
          onConfirm();
        }}
        data-testid={testId ? `${testId}-confirm` : undefined}
      >
        {confirmLabel}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setAsking(false)}
      >
        취소
      </Button>
    </div>
  );
}
