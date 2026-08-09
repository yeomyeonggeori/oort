import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
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
  wide = false,
}: {
  title: string;
  lines: string[];
  children: ReactNode;
  /** Catalog/detail surfaces need both columns in the same viewport. */
  wide?: boolean;
}) {
  // A settings form is read line by line, so the panel keeps a measure instead
  // of stretching a slug field across a 1280px window.
  return (
    <section className={cn("flex min-w-0 flex-col gap-4", wide ? "max-w-none" : "max-w-2xl")}>
      {/* 제목과 설명은 한국어 산문이므로 음절이 아니라 어절에서 끊는다
          (MOMO-676 M-5). 헤더 블록에만 걸고 children에는 걸지 않는다: 아래에는
          슬러그·토큰·수치처럼 산문이 아닌 값이 있고, 그것들은 각자의 규칙을
          갖는다. word-break는 상속되므로 한 번의 선언으로 두 줄 다 덮인다. */}
      <div className="flex break-keep flex-col gap-1">
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
 *
 * The error is BOUND to the control, not merely placed under it. `role="alert"`
 * reads the message once, at the moment it appears; a person who tabs back to
 * that input ten seconds later gets nothing from a live region that already
 * fired. `aria-describedby` is what makes the input carry its own error every
 * time it takes focus, and `aria-invalid` is what makes it announce itself as
 * the field that is wrong. The clone is how a shared wrapper does that without
 * every call site repeating two ids: an explicitly passed value always wins, so
 * a caller that describes its input itself is never overwritten.
 *
 * The hint STAYS while the error shows. It used to be swapped out, which
 * deleted "예: https://api.example.com/v1" at the exact moment "주소는 http://
 * 또는 https:// 로 시작해야 합니다." appeared: the format rule was withdrawn
 * from the one person who had just proved they needed it.
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
  const errorId = `${htmlFor}-error`;
  const hintId = `${htmlFor}-hint`;
  // The hint is part of the control's accessible description, not decoration
  // beside it. It mattered the moment a field arrived whose hint IS the task
  // ("~/.codex/auth.json 내용을 그대로"): describing only the error tells a
  // screen-reader user what went wrong and never what to put in the box.
  // Order is hint-then-error so the instruction is heard before the complaint.
  const describedBy =
    [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") ||
    undefined;
  const control =
    describedBy && isValidElement<AriaDescribable>(children)
      ? cloneElement(children, {
          "aria-invalid": error
            ? (children.props["aria-invalid"] ?? true)
            : children.props["aria-invalid"],
          "aria-describedby": children.props["aria-describedby"] ?? describedBy,
        })
      : children;
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={htmlFor} className="text-meta text-ink-muted">
        {label}
      </label>
      {control}
      {hint && (
        <p id={hintId} className="break-keep text-meta text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p className="text-meta text-danger" role="alert" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}

/** The two attributes `Field` sets on whatever control it was handed. */
interface AriaDescribable {
  "aria-invalid"?: boolean | "true" | "false";
  "aria-describedby"?: string;
}

export type ChipTone = "ok" | "warn" | "danger" | "accent" | "muted";

const CHIP_TONE: Record<ChipTone, string> = {
  ok: "border-ok text-ok",
  warn: "border-warn text-warn",
  danger: "border-danger text-danger",
  accent: "border-line bg-accent-soft text-ink",
  muted: "border-line text-ink-muted",
};

/**
 * Text-first status chip. Never pulses, never carries meaning in color alone.
 *
 * The 11px `text-timestamp` used to be deleted here by the class merge, which
 * files an unknown `text-*` as a color and let `text-ok` replace it: the chip
 * rendered at whatever it inherited (14px measured). `cn` now knows momo's text
 * roles, so a role replaces a role and a color replaces a color. See
 * `src/design/lib/cn.ts`.
 */
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
  /**
   * The value is a Korean SENTENCE, not a slug/token/number.
   *
   * `break-all` is right for the things this list was built for — a base URL, a
   * masked tail, an id — and wrong for prose: measured at 390px it split words
   * mid-syllable ("갱/신합니다"). Prose breaks at word boundaries, exactly as
   * `SectionShell` already decided for the header block (MOMO-676 M-5).
   */
  prose?: boolean;
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
              "min-w-0 text-body text-ink",
              row.prose ? "break-keep" : "break-all",
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
  busy,
  hint,
  testId,
}: {
  name: string;
  legend: string;
  choices: RadioChoice[];
  value: string;
  onChange: (id: string) => void;
  disabled?: boolean;
  /**
   * A write is in flight. This is deliberately NOT `disabled`: disabling a
   * focused control drops focus to <body>, and a keyboard user who changes a
   * setting would be thrown to the top of the panel on every save. The group
   * announces itself busy and keeps the focus ring where the person left it.
   */
  busy?: boolean;
  /** Save state in words: 상속 중 / 저장 중 / 아직 저장되지 않음. */
  hint?: string;
  testId?: string;
}) {
  const hintId = hint ? `${name}-hint` : undefined;
  return (
    <fieldset
      className="flex min-w-0 flex-col gap-1"
      disabled={disabled}
      aria-describedby={hintId}
      aria-busy={busy || undefined}
      data-testid={testId}
    >
      {/* The legend names the group, so two of these on one panel are two
          distinct radiogroups to a screen reader instead of two anonymous
          lists of the same three option names. */}
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
      {hint && (
        <p id={hintId} role="status" className="text-meta text-ink-muted">
          {hint}
        </p>
      )}
    </fieldset>
  );
}

export interface SelectChoice {
  id: string;
  label: string;
  /**
   * Rendered but not selectable. A stored value the server would now reject
   * (a revoked host, an id that left the registry) still has to appear, or the
   * control renders blank and the panel stops saying what is in force.
   */
  disabled?: boolean;
}

/**
 * Label above a full-width native select.
 *
 * Full width is the point, not a shrug: a select sized to its content lets the
 * LONGEST OPTION decide the column, so two of these in one panel line up at two
 * different left edges depending on which hosts happen to be registered that
 * day. Width belongs to the panel, the value does not.
 *
 * Native `<select>`: this bundle carries no Radix Select, and the platform
 * control already gives type-ahead, arrow keys, the collapsed value as its own
 * label, and a popup that a screen reader announces as a listbox. The only
 * thing added here is the token skin.
 */
export function SelectField({
  id,
  label,
  ariaLabel,
  hint,
  hintTone = "muted",
  value,
  choices,
  onChange,
  disabled,
  busy,
  testId,
}: {
  id: string;
  label: string;
  /**
   * Full accessible name when the visible label repeats across scopes ("재개
   * 대상" twice). Must contain the visible label so speech input still matches.
   */
  ariaLabel?: string;
  hint?: ReactNode;
  /**
   * `danger` when the value in the control is one the server will refuse: that
   * is an error state living where the problem is (SKILL §5), not a footnote,
   * so it takes --danger and role="alert" instead of muted meta text. The same
   * panel already draws save failures that way, and one panel gets one rule.
   */
  hintTone?: "muted" | "danger";
  value: string;
  choices: SelectChoice[];
  onChange: (id: string) => void;
  disabled?: boolean;
  /** In flight. Never disables: see the note on ChoiceRadios.busy. */
  busy?: boolean;
  testId?: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-meta text-ink-muted">
        {label}
      </label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        aria-label={ariaLabel}
        aria-describedby={hint ? `${id}-hint` : undefined}
        aria-busy={busy || undefined}
        data-testid={testId}
        className="h-control-sm w-full min-w-0 rounded-sm border border-line-strong bg-surface-raised px-2 text-body text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        {choices.map((choice) => (
          <option key={choice.id} value={choice.id} disabled={choice.disabled}>
            {choice.label}
          </option>
        ))}
      </select>
      {hint && (
        <p
          id={`${id}-hint`}
          role={hintTone === "danger" ? "alert" : "status"}
          className={cn(
            "text-meta",
            hintTone === "danger" ? "text-danger" : "text-ink-muted"
          )}
          data-hint-tone={hintTone}
        >
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * The commit control of an explicitly saved settings block.
 *
 * `aria-disabled` rather than `disabled`, because this button is the one that
 * turns itself off: the moment its own save lands nothing is dirty any more, and
 * a FOCUSED element that becomes `disabled` drops focus to <body>, throwing a
 * keyboard user back to the top of the panel on every successful save. It stays
 * in the tab order, announces itself unavailable, and the click is a no-op.
 */
export function SaveButton({
  label,
  busyLabel = "저장 중",
  canSave,
  busy,
  onSave,
  testId,
}: {
  /** Verb-first and scope-bearing: two blocks on one panel need two names. */
  label: string;
  busyLabel?: string;
  canSave: boolean;
  busy?: boolean;
  onSave: () => void;
  testId?: string;
}) {
  const blocked = !canSave || Boolean(busy);
  return (
    <Button
      type="button"
      size="sm"
      aria-disabled={blocked || undefined}
      aria-busy={busy || undefined}
      className={cn(blocked && "opacity-50")}
      onClick={() => {
        if (blocked) return;
        onSave();
      }}
      data-testid={testId}
    >
      {busy ? busyLabel : label}
    </Button>
  );
}

/**
 * Copy with inline confirmation. Toast stacks are banned, so the button itself
 * reports the result and resets after two seconds.
 */
export function CopyButton({
  value,
  label = "복사",
  subject,
  testId,
}: {
  value: string;
  label?: string;
  /**
   * What the copied value belongs to. One list renders one copy button per row,
   * and three buttons all named "호스트 ID 복사" are three identical stops in the
   * tab order. The visible label stays short; the accessible name carries the
   * row.
   *
   * It has to be something that is actually unique per row: a display name is
   * not, because the work host registry writes a NEW row on every pairing and
   * the live workspace holds three rows called "성재 iMac, 집 작업실". Callers
   * pass the discriminator with the name (see `workHostIdTail`).
   */
  subject?: string;
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

  // The visible text carries the result, so the accessible name has to move
  // with it: a fixed aria-label would leave a screen reader on "복사" after the
  // copy already happened.
  const text = copied ? `${label}됨` : label;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={copy}
      aria-label={subject ? `${subject} ${text}` : undefined}
      data-testid={testId}
    >
      {text}
    </Button>
  );
}

/**
 * Two-step confirmation for a destructive action. The first click only asks;
 * nothing irreversible ever happens on a single unguarded click.
 */
export function ConfirmButton({
  label,
  ariaLabel,
  question,
  confirmLabel,
  onConfirm,
  disabled,
  testId,
}: {
  label: string;
  /**
   * Full accessible name for a button one list renders per row. "삭제" eight
   * times is eight identical stops in the tab order, and the row a screen
   * reader is about to act on is not recoverable from the button alone. Must
   * contain the visible label so speech input still matches it.
   */
  ariaLabel?: string;
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
        aria-label={ariaLabel}
        onClick={() => setAsking(true)}
        data-testid={testId}
      >
        {label}
      </Button>
    );
  }

  // The question names the group, so two rows mid-confirmation stay two
  // distinct groups instead of four anonymous 빼기/취소 stops.
  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={question}
    >
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
