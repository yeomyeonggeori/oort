import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Button } from "@/design/ui/button";
import { useEscapeLayer } from "@/design/ui/escapeLayer";
import { cn } from "@/design/lib/cn";
import { useClipboardCopy } from "@/design/hooks/useClipboardCopy";
import { choiceRadiosHintId } from "./fieldIds";

// =============================================================================
// Presentational parts shared by the settings sections (R-1 §5). Flat rows and
// typed key-value lists, no card per row: elevation is reserved for grouping.
// =============================================================================

/**
 * One on/off row in a bordered settings group. The NAME is the checkbox's
 * accessible name; the sentence is its description. Kept apart so a screen
 * reader does not run the whole paragraph together as one label.
 */
export function SettingsToggleRow({
  testId,
  name,
  description,
  checked,
  disabled,
  describedBy,
  onToggle,
}: {
  testId: string;
  name: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  /** Id of a shared reason (offline, etc.) pointed at by several rows. */
  describedBy?: string;
  onToggle: (next: boolean) => void;
}) {
  const nameId = `${testId}-name`;
  const descId = `${testId}-desc`;
  return (
    <div
      className={cn(
        "flex min-w-0 items-start gap-3 border-b border-line p-3 last:border-b-0",
        checked ? "bg-accent-soft" : "hover:bg-surface-hover"
      )}
      data-state={checked ? "on" : "off"}
    >
      <input
        type="checkbox"
        id={testId}
        checked={checked}
        disabled={disabled}
        aria-labelledby={nameId}
        aria-describedby={describedBy ? `${descId} ${describedBy}` : descId}
        onChange={(event) => onToggle(event.target.checked)}
        className="mt-1 accent-accent focus-visible:focus-ring"
        data-testid={testId}
      />
      <label htmlFor={testId} className="flex min-w-0 cursor-pointer flex-col gap-px">
        <span id={nameId} className="text-body text-ink">
          {name}
        </span>
        <span id={descId} className="break-keep text-meta text-ink-muted">
          {description}
        </span>
      </label>
    </div>
  );
}

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
  const hintId = hint ? choiceRadiosHintId(name) : undefined;
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
              className="mt-1 accent-accent focus-visible:focus-ring"
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
        className="h-control-sm w-full min-w-0 rounded-sm border border-line-strong bg-surface-raised px-2 text-body text-ink focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
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
 *
 * 진행과 잠금은 다른 축이다 (#1558). This component spent a year as the cited
 * precedent for that grammar (#1486, #1541, `ConfirmButton.busy` above) while
 * itself folding the two into one `blocked = !canSave || busy` — so a save in
 * flight wore `aria-busy` and `aria-disabled` at once and the one progress word
 * on the screen sat dead under `opacity-50`, reading as 「당신은 이걸 못 한다」
 * mid-write (the #1403 리뷰 H-1 class, measured on `work-host-save`: 「저장 중」
 * · aria-busy=true · aria-disabled=true · opacity 0.5). The axes are now what
 * the consumers were always told they were:
 *
 *   - 잠금 (`!canSave`): dims, announces `aria-disabled`. Nothing is dirty, or
 *     the save cannot go — 「당신은 이걸 못 한다」.
 *   - 진행 (`busy`): swaps the word, announces `aria-busy`, changes nothing
 *     about the paint — 「지금 일어나는 중」.
 *
 * Both still swallow the click in the handler; a second Enter during a write
 * must not fire a duplicate save, and the guard is the handler's job precisely
 * because native `disabled` is not available (focus). `type="submit"` so a
 * field Enter inside a form reaches that same handler (the click+submit pair
 * is the consumer's re-entry guard, not a second native disable). The consumer
 * side of the same discipline: `canSave` must never be computed FROM the
 * in-flight state (`dirty && !save.isPending` smuggles the fold back through
 * the prop); `settingsFieldsBusy.test.ts` scans every call site for that.
 */
export function SaveButton({
  label,
  busyLabel = "저장 중",
  canSave,
  busy,
  onSave,
  testId,
  size = "sm",
}: {
  /** Verb-first and scope-bearing: two blocks on one panel need two names. */
  label: string;
  busyLabel?: string;
  canSave: boolean;
  busy?: boolean;
  onSave: () => void;
  testId?: string;
  /**
   * Profile's display-name save is a form primary (goal P3): `default` grows
   * to 44px under 600px. Other settings saves stay `sm`.
   */
  size?: "sm" | "default";
}) {
  return (
    <Button
      type="submit"
      size={size}
      aria-disabled={!canSave || undefined}
      aria-busy={busy || undefined}
      className={cn(!canSave && "opacity-50")}
      onClick={() => {
        if (!canSave || busy) return;
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
  const { copied, copy } = useClipboardCopy(value);

  // The visible text carries the result, so the accessible name has to move
  // with it: a fixed aria-label would leave a screen reader on "복사" after the
  // copy already happened.
  const text = copied ? `${label}됨` : label;

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={() => void copy()}
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
 *
 * Both steps have to survive the keyboard, which is what the first version
 * missed (PR 1203 design review H2). Step one replaces itself with step two, so
 * the button that was focused stops existing and the browser drops focus to
 * `document.body`: a keyboard reader who pressed Enter on 지우기 was returned to
 * the top of the document and had to Tab back to a row it could no longer tell
 * from its neighbours. Two things answer that here, and they belong here rather
 * than in each caller because every caller has the same problem:
 *
 *   - Focus MOVES to the question, not to the destructive button. The group is
 *     what was just opened, its accessible name is the question, and landing on
 *     it means the thing announced is "지우면 되돌릴 수 없습니다" rather than the
 *     button that does it. Landing on 지우기 itself would make Enter-Enter
 *     destroy a row, which is the guard this component exists to be.
 *   - Cancel RETURNS focus to the trigger. Backing out of a question should put
 *     the reader where the question found them. So does confirming, so that
 *     focus is never on `document.body` while the request is in flight; where it
 *     goes once the ROW itself is gone is the caller's to say, because the
 *     caller is the only one that knows what the row was next to (PR 1203 R2
 *     M-R1).
 *
 * Esc while the question stands is the third, and it is answered here now. It
 * used to close the whole settings surface (PR 1203 R2 M-R2, measured again
 * after this branch met #1205: question open → Esc → `settings-route` gone,
 * focus on `document.body`, question and list with it). Standing the focus on
 * the question is what makes that keypress read as "cancel this", so the wrong
 * outcome was this component's making — but the fix belongs to whoever owns
 * Esc, and #1205 gave the house an owner: `useEscapeLayer`, one capture-phase
 * listener over a layer stack, with the settings shell standing down whenever
 * `escapeIsClaimed()`. So the question CLAIMS A LAYER while it is open, and the
 * shell's Esc is a layer below it.
 *
 * The layer is pushed per open question, not per mounted button, so N rows
 * mid-confirmation are N layers and each Esc takes the topmost one. Its handler
 * is `close`, which is the same exit 취소 uses: the reader is put back on the
 * trigger, not dropped on `document.body`.
 *
 * `busy` is the third state this control can be in, and it used not to exist.
 * A form with two branches — 관측만 기록(직접 저장) / 처분 확정(이 질문) — showed
 * the word 「저장하는 중」 on one branch and nothing at all on the other: the
 * disposition branch had only the FORM's `aria-busy`, which is read aloud and
 * seen by nobody. One form does not get two answers to "is it happening?", so
 * the busy word `SaveButton` already carries is here too.
 */
export function ConfirmButton({
  label,
  ariaLabel,
  subject,
  describedBy,
  question,
  confirmLabel,
  confirmDestructive = true,
  busy,
  busyLabel = "저장 중",
  onConfirm,
  onAskingChange,
  disabled,
  testId,
}: {
  label: string;
  /**
   * Full accessible name for a button one list renders per row. "삭제" eight
   * times is eight identical stops in the tab order, and the row a screen
   * reader is about to act on is not recoverable from the button alone. Must
   * contain the visible label so speech input still matches it.
   *
   * Prefer `subject`, which names the row once and carries it through BOTH
   * steps; this stays for callers whose question is already row-qualified.
   */
  ariaLabel?: string;
  /**
   * What the destructive action belongs to — the row discriminator, same
   * convention as `CopyButton`.
   *
   * It qualifies all three accessible names (trigger, question group, confirm),
   * because the identity of the row is not something that may be dropped
   * halfway through the interaction. A list rendering this per row otherwise
   * reaches step two as N groups named by one identical sentence and N buttons
   * named "지우기", at the exact moment the reader most needs to know which one
   * is about to go.
   */
  subject?: string;
  /**
   * Id of a sentence that explains why this control is currently unusable.
   *
   * For a list that greys N rows for ONE reason: repeating the sentence per row
   * is the same fact N times on one screen, and dropping it leaves a grey
   * control that reads as "you may not" (PR 1203 R2 N-R4). Written once, pointed
   * at from every control it applies to.
   */
  describedBy?: string;
  question: string;
  confirmLabel: string;
  /**
   * Is the confirmed action the irreversible/destructive one? Drives ONLY the
   * confirm button's color — the two-step guard is identical either way.
   *
   * Defaults to `true` because that is what every original caller meant: this
   * control exists to guard a delete. But a two-step question is also the right
   * shape for an irreversible NON-destructive commit (봇을 남깁니다 protects the
   * chat history yet still can't be re-decided), and painting that answer the
   * same red as delete tells the reader the wrong thing about what they chose.
   * The caller passes the disposition's own `destructive` flag (MOMO cleanup
   * ledger, design-review M1).
   */
  confirmDestructive?: boolean;
  /**
   * The confirmed write is in flight.
   *
   * Deliberately NOT folded into `disabled`, which is what several callers do
   * today (`disabled={offline || busy}`): the two say opposite things. `disabled`
   * dims and means 「당신은 이걸 못 한다」; a write that is HAPPENING is not a
   * refusal, and painting it grey kills the one progress word on the screen
   * under `opacity-50` (#1403 리뷰 H-1, and the sibling save button in
   * `CleanupArtifactRow` was fixed for exactly this). So `busy` swaps the word,
   * sets `aria-busy`, and changes nothing about the paint.
   *
   * It still swallows the click. A second Enter during an in-flight write must
   * not re-open the question or fire `onConfirm` again, and the guard is silent
   * for the same reason the paint is unchanged — the house pattern is
   * `aria-busy` + an early-return guard, never native `disabled` (which would
   * drop focus from the very hand that just pressed Enter).
   */
  busy?: boolean;
  /**
   * The word shown while `busy`. Same default as `SaveButton`; pass the verb
   * this button's own action deserves when 저장 is not what is happening.
   */
  busyLabel?: string;
  onConfirm: () => void;
  /**
   * The confirmation opened or closed. For a caller that has to quiet OTHER
   * actions on the same row while an irreversible one is being asked about.
   */
  onAskingChange?: (asking: boolean) => void;
  disabled?: boolean;
  testId?: string;
}) {
  const [asking, setAsking] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const groupRef = useRef<HTMLDivElement | null>(null);
  // Both exits land on the trigger. Confirming does too: the row may take a
  // round trip to disappear, and until it does the trigger is still the place
  // the reader was. If the row then goes, the CALLER moves focus on.
  const restoreFocus = useRef(false);

  function close() {
    restoreFocus.current = true;
    setAsking(false);
    onAskingChange?.(false);
  }

  useEffect(() => {
    if (asking) {
      groupRef.current?.focus({ preventScroll: true });
    } else if (restoreFocus.current) {
      restoreFocus.current = false;
      triggerRef.current?.focus({ preventScroll: true });
    }
  }, [asking]);

  // Esc cancels the question and nothing else (see the docstring). The layer
  // stands only while `asking`, so once the question is gone Esc is the shell's
  // again on the very next press.
  useEscapeLayer(asking, close);

  // The visible text carries the state, so the accessible name has to move with
  // it — the same rule `CopyButton` follows when it becomes 복사됨. That is why
  // the names below are BUILT FROM these two words rather than from `label` and
  // `confirmLabel`: the row keeps its identity through the write and the verb is
  // the only thing that changes, so a list mid-save still says WHICH row is
  // saving without a second string having to be kept in step by hand.
  const triggerText = busy ? busyLabel : label;
  const confirmText = busy ? busyLabel : confirmLabel;
  // `ariaLabel` is the one name that cannot follow: it is a whole sentence for
  // the STOPPED action, written once by the caller. Leaving it up during the
  // write would put "삭제" in the accessible name of a button reading 「저장 중」
  // — the label-in-name failure (WCAG 2.5.3). It is set down for the duration
  // and the button's own word becomes its name; a caller that needs the row to
  // stay audible through a save passes `subject`, which does follow.
  const rowName = subject ? `${subject} ${triggerText}` : undefined;
  const triggerName = busy ? rowName : (ariaLabel ?? rowName);

  if (!asking) {
    return (
      <Button
        ref={triggerRef}
        type="button"
        variant="outline"
        size="sm"
        // aria-disabled, not native `disabled`: a gated trigger that leaves the
        // tab order takes its `describedBy` (the blocked reason) out of reach,
        // and a person who cannot open the question also cannot hear why. Same
        // rule as SaveButton — stays focusable, announces unavailable, no-ops.
        //
        // Busy is NOT in that expression. It is the state this button is in
        // right after the question closed on it (`close()` runs before
        // `onConfirm`), so the trigger is where the reader is standing when the
        // write goes out — and where the progress word has to appear.
        aria-disabled={disabled || undefined}
        aria-busy={busy || undefined}
        aria-label={triggerName}
        aria-describedby={disabled ? describedBy : undefined}
        className={cn(disabled && "opacity-50")}
        onClick={() => {
          if (disabled || busy) return;
          setAsking(true);
          onAskingChange?.(true);
        }}
        data-testid={testId}
      >
        {triggerText}
      </Button>
    );
  }

  // The question names the group, so two rows mid-confirmation stay two
  // distinct groups instead of four anonymous 빼기/취소 stops. With a `subject`
  // they stay distinct even when the question itself is one shared sentence.
  return (
    <div
      ref={groupRef}
      tabIndex={-1}
      className="flex flex-wrap items-center gap-2 rounded-sm focus-visible:focus-ring"
      role="group"
      aria-label={subject ? `${subject} ${question}` : question}
      data-testid={testId ? `${testId}-question` : undefined}
    >
      <span className="text-meta text-ink">{question}</span>
      {/* Confirming closes the question first, so this button is normally gone
          by the time `busy` turns true — the trigger is what the reader is left
          holding. It carries the same busy grammar anyway, because a caller
          whose write is already in flight from somewhere else on the row can
          have the question standing over it, and a confirm button that neither
          says so nor refuses the second Enter is a duplicate write. */}
      <Button
        type="button"
        variant={confirmDestructive ? "destructive" : "default"}
        size="sm"
        aria-disabled={disabled || undefined}
        aria-busy={busy || undefined}
        aria-label={subject ? `${subject} ${confirmText}` : undefined}
        aria-describedby={disabled ? describedBy : undefined}
        className={cn(disabled && "opacity-50")}
        onClick={() => {
          if (disabled || busy) return;
          close();
          onConfirm();
        }}
        data-testid={testId ? `${testId}-confirm` : undefined}
      >
        {confirmText}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        aria-label={subject ? `${subject} ${confirmLabel} 취소` : undefined}
        onClick={close}
      >
        취소
      </Button>
    </div>
  );
}
