import { useCallback, useRef, useState, type HTMLAttributes } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileDiff,
  FileX2,
  GitCommitHorizontal,
  GitPullRequest,
} from "lucide-react";
import { cn } from "@/design/lib/cn";
import { isDesktop, openExternalUrl } from "@/lib/tauri";
import { formatCount } from "@momo/core/features/timeline/agentCardModel";
import { StreamCaret, TurnChip } from "./StatusChip";
import { artifactNote, isProvisional, type ArtifactState } from "@momo/core/features/timeline/rowModel";
import {
  isTruncated,
  omittedFileCount,
  type DiffArtifact,
  type DiffFile,
  type DiffLineKind,
  type ArtifactPresentation,
  type LinkArtifact,
  type OversizedArtifact,
} from "@momo/core/features/timeline/artifacts";

// =============================================================================
// Artifact card (ADR-0126 D2 / MOMO-620, the web half of mac MOMO-518).
//
// It is the BODY of a message, not a floating panel: MessageRow keeps the
// shared grid, avatar and typography and this only fills the body slot, exactly
// as AgentCard does (design-taste-web §9). Same frame, same measure
// (max-w-pane-lg), same title-row-then-typed-rows-then-disclosure anatomy, so a
// diff card and a tool card read as one family instead of two designs.
//
// Four things this card refuses to do:
//   - it never claims a count it did not measure. The +N −N summary is the
//     SOURCE total even when the body is a truncated slice, `파일 N개` counts
//     every file in the source including the ones truncation emptied, and the
//     gap is stated in a banner rather than hidden (MomoCore honest-truncation
//     contract).
//   - it never reports a turn as finished when it was not. Whatever the tool or
//     turn card knew about the run rides along as `state` and lands as a chip
//     plus a note, so a failed patch keeps its failure and a streaming patch
//     says its counters are still moving (rowModel, ADR-0132).
//   - it never colors a line and calls that the information. Every changed line
//     still carries its own +/- character, so the diff survives a color-blind
//     reader and a grayscale screenshot.
//   - it never grows the row. The body scrolls inside max-h-diff-body and long
//     lines scroll inside their own file block, so neither the timeline row nor
//     the document ever gains a scroll axis from a large change (MOMO-610).
// =============================================================================

/**
 * Diff lines mounted eagerly. Files are opened from the top until this budget
 * is spent; the rest start collapsed and mount their lines on first open.
 *
 * The parser already caps the RENDERED slice at 500 lines, which bounds the
 * worst case. This second, smaller budget bounds the COMMON case: a card that
 * mounts 500 monospace rows costs a layout pass react-virtuoso then has to
 * measure, and a timeline holding several of those is where scroll frames go.
 * A collapsed file still shows its path and its true +N −N, so nothing is
 * hidden by folding it, only deferred.
 */
const EAGER_LINE_BUDGET = 200;

const LINE_CLASS: Readonly<Record<DiffLineKind, string>> = {
  addition: "text-ok",
  deletion: "text-danger",
  // Structure, not signal. --accent is this surface's ONE accent and the
  // timeline already spends it on the unread boundary and the current
  // workspace marker; a card with six hunk headers would outshout both
  // (design-taste-web §2, "one accent per surface"). The tint alone separates
  // a hunk header from the metadata lines around it.
  hunk: "bg-surface-hover text-ink-muted",
  metadata: "text-ink-muted",
  // Context recedes. It is the majority of the lines in a diff and none of the
  // change: at full ink strength it competed with the two colours that ARE the
  // information, and in a dense card the eye landed on the unchanged code
  // first. Muted, so +/- steps forward on weight as well as on hue.
  context: "text-ink-muted",
};

/**
 * Disclosure open state, kept OUTSIDE the React tree.
 *
 * react-virtuoso unmounts a row the moment it leaves the viewport, so a
 * component-local `useState` loses which files the reader opened as soon as
 * they scroll past their own card and back. Reviewing code is exactly the task
 * where you open a file, scroll to another message, and come back.
 *
 * Keyed by message id + file id, and only WRITTEN on a real toggle: a card
 * nobody touched leaves no entry, so the map holds what a person did rather
 * than everything they scrolled past. It is capped anyway, oldest entry first,
 * because a long session should not accumulate one entry per file forever.
 */
const OPEN_FILES = new Map<string, boolean>();
const OPEN_FILES_LIMIT = 500;

/**
 * Rows the shell failed to hand to a browser, kept outside the tree for the
 * same reason and with the same shape.
 *
 * R1 put the disclosure state out here and left the failure in a `useState`,
 * which meant the one message on the card that a person had to ACT on was the
 * one the timeline threw away: scroll past a "브라우저를 열지 못했습니다" row
 * and the address it printed for copying vanished with it.
 */
const OPEN_FAILURES = new Map<string, boolean>();
const OPEN_FAILURES_LIMIT = 100;

/** Newest wins, oldest evicted, so a long session cannot grow a map forever. */
function remember(
  map: Map<string, boolean>,
  key: string,
  value: boolean,
  limit: number
) {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
}

/**
 * True while the element really can scroll.
 *
 * Two things on this card hang off the answer, and both were wrong when it was
 * assumed rather than measured. A scroll container needs a tab stop because
 * WebKit gives it none (WCAG 2.1.1), but a block that FITS is not a scroll
 * container, and R1 put `tabIndex={0}` on every open file block: a six file
 * card grew up to six tab stops that moved nothing. And a container that does
 * scroll needs to say so, which is what `scrollbar-visible` is for.
 *
 * Measured on mount and on every resize of the box itself, which is what
 * changes the answer here: the line content is fixed once the row is rendered,
 * and the system font stack cannot reflow late (no webfont, SKILL §1).
 */
function useScrollable<T extends HTMLElement>() {
  const [scrollable, setScrollable] = useState(false);
  const node = useRef<T | null>(null);
  const observer = useRef<ResizeObserver | null>(null);

  const measure = useCallback(() => {
    const element = node.current;
    if (element === null) return;
    setScrollable(
      element.scrollWidth > element.clientWidth ||
        element.scrollHeight > element.clientHeight
    );
  }, []);

  // A callback ref, not an effect on a ref object: a file block mounts its
  // <pre> only when the disclosure is open, and an effect that ran once at card
  // mount would measure nothing and leave every hand-opened file without its
  // tab stop. This runs on the mount that actually happened.
  const ref = useCallback(
    (element: T | null) => {
      observer.current?.disconnect();
      observer.current = null;
      node.current = element;
      if (element === null) {
        setScrollable(false);
        return;
      }
      measure();
      if (typeof ResizeObserver === "undefined") return;
      observer.current = new ResizeObserver(measure);
      observer.current.observe(element);
    },
    [measure]
  );

  return { ref, scrollable, measure };
}

/**
 * The keyboard contract for a scroll container: a stop with a NAME, or nothing
 * at all. `role="group"` rides along with the tab stop because ARIA forbids
 * naming a `generic` element, so a bare focusable <pre> announces nothing.
 */
function scrollStop(
  scrollable: boolean,
  label: string
): HTMLAttributes<HTMLElement> {
  return scrollable ? { tabIndex: 0, role: "group", "aria-label": label } : {};
}

/**
 * `+N −N`. Mono and tabular so a column of file summaries reads down, and the
 * pair is one accessible label because "12" and "3" alone say nothing.
 * U+2212 MINUS SIGN, not a hyphen: it aligns with the digits at this size.
 *
 * The label names its UNIT. These are changed lines; the truncation banner two
 * rows below counts patch lines, which includes headers and context, and the
 * two numbers sit close enough that a reader will otherwise try to reconcile
 * them.
 *
 * `role="img"` so the label is actually spoken. A <span> is `generic`, ARIA
 * forbids naming a generic element, and Chrome exposing the name anyway is not
 * a licence to rely on it: WebKit is the engine the Tauri shell runs on, and it
 * is the one that drops the name and reads the digits raw. A leaf role also
 * hides the "+535 −87" glyphs the label already restates, so the pair is
 * announced once and as a sentence.
 *
 * "지금까지" is TEXT, not only a label and a data attribute. A provisional
 * count that looks identical to a settled one is a settled claim to the eye,
 * whatever the DOM says.
 */
function ChangeSummary({
  additions,
  deletions,
  provisional = false,
  testId,
}: {
  additions: number;
  deletions: number;
  /** The patch is still arriving, so these counts are a running total. */
  provisional?: boolean;
  testId?: string;
}) {
  return (
    <span
      role="img"
      data-numeric
      data-testid={testId}
      data-provisional={provisional ? "true" : undefined}
      className="shrink-0 text-timestamp font-semibold"
      aria-label={`${provisional ? "지금까지 " : ""}변경 줄, 추가 ${formatCount(
        additions
      )}줄, 삭제 ${formatCount(deletions)}줄`}
    >
      {provisional && <span className="mr-1 text-ink-muted">지금까지</span>}
      <span className="font-mono text-ok">+{formatCount(additions)}</span>{" "}
      <span className="font-mono text-danger">−{formatCount(deletions)}</span>
    </span>
  );
}

/**
 * One file. Native <details>, which is the platform disclosure primitive: it
 * ships the open state and the Space/Enter path already, so a Radix Collapsible
 * would only re-implement it behind a dependency (the same call AgentCard's
 * payload disclosure makes).
 *
 * The marker is drawn rather than inherited because a flex <summary> drops the
 * native triangle in WebKit, and the header needs flex to keep the path on the
 * left and the counts on the right.
 */
function DiffFileSection({
  file,
  storageKey,
  defaultOpen,
}: {
  file: DiffFile;
  storageKey: string;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(() => OPEN_FILES.get(storageKey) ?? defaultOpen);
  const lines = useScrollable<HTMLPreElement>();
  const hidden = file.lineCount - file.lines.length;
  return (
    <details
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        remember(OPEN_FILES, storageKey, next, OPEN_FILES_LIMIT);
      }}
      data-testid="artifact-diff-file"
      data-path={file.path}
    >
      {/* Sticky inside the scrolling body: a 200 line file otherwise carries
          its own path off the top of the card and leaves the reader scrolling
          code with no idea which file they are in. z-10 because a sticky box
          with no z-index creates no stacking context, and the next file's lines
          would paint straight over it. */}
      <summary
        className={cn(
          "sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-line bg-surface-raised px-3 py-1 press hover:bg-surface-hover",
          "focus-visible:focus-ring"
        )}
      >
        {open ? (
          <ChevronDown className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        ) : (
          <ChevronRight className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        )}
        <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink">
          {file.path}
        </span>
        <ChangeSummary additions={file.additions} deletions={file.deletions} />
      </summary>
      {open && (
        // Long lines scroll here, inside the file block. The lines are one <pre>
        // of block <code> rows so a hunk header's tint spans the full measure
        // (min-w-full) instead of ending where its text does.
        //
        // The tab stop is CONDITIONAL (see useScrollable): a file whose lines
        // fit has nothing to scroll, and a stop that moves nothing is a stop a
        // keyboard reader pays for six times on a six file card.
        //
        // scrollbar-visible is the affordance the platform withholds. macOS
        // overlay scrollbars stay invisible until you already scroll, so a line
        // cut at the right edge of the card looked exactly like a line that
        // ended there, with no hint that the rest existed.
        <pre
          ref={lines.ref}
          {...scrollStop(lines.scrollable, `${file.path} 변경 내용`)}
          className={cn(
            "scrollbar-visible overflow-x-auto pb-1 font-mono text-meta",
            "focus-visible:focus-ring"
          )}
        >
          {file.lines.map((line) => (
            <code
              key={line.id}
              data-line-kind={line.kind}
              className={cn(
                "block min-w-full whitespace-pre px-3",
                LINE_CLASS[line.kind]
              )}
            >
              {line.text === "" ? " " : line.text}
            </code>
          ))}
        </pre>
      )}
      {open && hidden > 0 && (
        <p
          data-numeric
          data-testid="artifact-diff-file-cut"
          className="border-b border-line px-3 py-1 text-meta text-ink-muted"
        >
          이 파일은 {formatCount(file.lines.length)}줄까지만 폈습니다. 나머지{" "}
          {formatCount(hidden)}줄은 아래 원본 diff에 있습니다.
        </p>
      )}
    </details>
  );
}

/**
 * A file the 500 line budget never reached. It is a ROW, not a disclosure:
 * there is nothing behind it to open, and a control that opens onto nothing is
 * worse than a line of text that says where the content actually is.
 */
function OmittedFileRow({ file }: { file: DiffFile }) {
  return (
    <div
      data-testid="artifact-diff-file"
      data-path={file.path}
      data-omitted="true"
      className="flex items-center gap-2 border-b border-line px-3 py-1"
    >
      <FileX2 className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
      <span className="min-w-0 flex-1 truncate font-mono text-meta text-ink-muted">
        {file.path}
      </span>
      <span className="shrink-0 text-timestamp text-ink-muted">원본 diff에만</span>
      <ChangeSummary additions={file.additions} deletions={file.deletions} />
    </div>
  );
}

/**
 * The run's state, on the artifact card that replaced the run's own card.
 *
 * The copy itself lives in rowModel as a total map over the status vocabulary,
 * because the version that lived here as an if/else chain had no branch for
 * `done` or `queued` and told a finished turn it was still arriving. What is
 * left in the component is the rendering: one tone, one caret.
 */
function StatusNote({ state }: { state: ArtifactState }) {
  const note = artifactNote(state);
  return (
    <p
      data-testid="artifact-status-note"
      data-status={state.status}
      className={cn(
        "border-b border-line px-3 py-1 text-meta",
        note.tone === "danger" ? "text-danger" : "text-ink-muted"
      )}
    >
      {note.text}
      {note.live && <StreamCaret />}
    </p>
  );
}

/**
 * The whole patch, folded. Shared by the diff and oversized cards, which are
 * the same disclosure over different reasons for it.
 *
 * `onToggle` re-measures because a closed <details> has no box to measure: the
 * tab stop and the scrollbar both have to be decided the moment it opens.
 */
function RawPatch({ patch }: { patch: string }) {
  const body = useScrollable<HTMLPreElement>();
  return (
    <details
      className="border-t border-line"
      data-testid="artifact-diff-raw"
      onToggle={body.measure}
    >
      <summary
        className={cn(
          "cursor-pointer px-3 py-2 text-meta text-ink-muted press hover:bg-surface-hover",
          "focus-visible:focus-ring"
        )}
      >
        원본 diff 보기
      </summary>
      <pre
        ref={body.ref}
        {...scrollStop(body.scrollable, "원본 diff")}
        className={cn(
          "scrollbar-visible max-h-pane overflow-auto px-3 pb-2 font-mono text-meta text-ink",
          "focus-visible:focus-ring"
        )}
      >
        {patch}
      </pre>
    </details>
  );
}

/** The status chip an artifact card wears, or nothing when there is no news. */
function ArtifactChip({ state }: { state: ArtifactState | null }) {
  return state === null ? null : <TurnChip status={state.status} />;
}

function DiffCard({
  diff,
  state,
  storageKey,
}: {
  diff: DiffArtifact;
  state: ArtifactState | null;
  storageKey: string;
}) {
  const truncated = isTruncated(diff);
  const omitted = omittedFileCount(diff);
  const provisional = isProvisional(state);
  let budget = EAGER_LINE_BUDGET;

  return (
    <section
      data-testid="artifact-card"
      data-artifact-kind="diff"
      data-total-lines={diff.totalLineCount}
      data-displayed-lines={diff.displayedLineCount}
      data-status={state?.status}
      aria-label={`${diff.title}, 파일 ${formatCount(
        diff.files.length
      )}개, 추가 ${formatCount(diff.additions)}줄, 삭제 ${formatCount(
        diff.deletions
      )}줄`}
      className="mt-2 max-w-pane-lg rounded-md border border-line bg-surface-raised"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FileDiff className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {diff.title}
        </span>
        <ArtifactChip state={state} />
        <ChangeSummary
          additions={diff.additions}
          deletions={diff.deletions}
          provisional={provisional}
          testId="artifact-diff-total"
        />
      </div>

      {state && <StatusNote state={state} />}

      {truncated && (
        // Honest banner, not a fade-out: the source is longer than the body and
        // the card says by how much, in the unit it is counting (patch lines,
        // headers and context included, which is NOT the +N −N above). The
        // whole patch is still reachable under 원본 diff 보기 below, so nothing
        // is lost, only folded.
        //
        // Not role="status": this is a static label that was already on screen
        // when the row mounted, and react-virtuoso re-mounts rows on every
        // scroll pass, so a live region here reads the same sentence aloud
        // again every time the card comes back into view.
        <p
          data-testid="artifact-diff-truncation"
          className="border-b border-line px-3 py-1 text-meta text-ink-muted"
        >
          <span data-numeric>
            패치 {formatCount(diff.totalLineCount)}줄 중{" "}
            {formatCount(diff.displayedLineCount)}줄을 폈습니다
            {omitted > 0 && `, 파일 ${formatCount(omitted)}개는 경로만 남겼습니다`}
            .
          </span>{" "}
          나머지는 아래 원본 diff에서 보세요.
        </p>
      )}

      {/* A MAXIMUM, not a fixed height: a three line change hugs its content and
          only a genuinely long one reaches the cap and scrolls, so the card
          never opens onto an empty band.

          No tabIndex: the tabindex-on-a-scroll-container rule applies to
          containers with no focusable descendant, and this one is full of
          <summary> elements. Adding one anyway bought a seventh tab stop per
          card that did nothing the next Tab did not already do. */}
      <div className="scrollbar-visible max-h-diff-body overflow-y-auto">
        {diff.files.map((file) => {
          if (file.lines.length === 0) {
            return <OmittedFileRow key={file.id} file={file} />;
          }
          const eager = budget > 0;
          budget -= file.lines.length;
          return (
            <DiffFileSection
              key={file.id}
              file={file}
              storageKey={`${storageKey}:${file.id}`}
              defaultOpen={eager}
            />
          );
        })}
      </div>

      <RawPatch patch={diff.rawPatch} />
    </section>
  );
}

/**
 * A patch past the 200,000 byte ceiling. Nothing was parsed, so nothing is
 * claimed: no file list, no +N −N. What the card CAN say is how big it is and
 * where the text went, and it says that inside the same bounded frame every
 * other artifact uses, which is the whole point. Before this existed the
 * largest patch on the timeline was the one that rendered as an unbounded
 * paragraph.
 */
function OversizedCard({
  oversized,
  state,
}: {
  oversized: OversizedArtifact;
  state: ArtifactState | null;
}) {
  const kb = Math.round(oversized.byteCount / 1_024);
  return (
    <section
      data-testid="artifact-card"
      data-artifact-kind="oversized"
      data-status={state?.status}
      aria-label={`${oversized.title}, 표시하기에 너무 큰 변경`}
      className="mt-2 max-w-pane-lg rounded-md border border-line bg-surface-raised"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <FileDiff className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {oversized.title}
        </span>
        <ArtifactChip state={state} />
      </div>

      {state && <StatusNote state={state} />}

      <p
        data-testid="artifact-oversized-note"
        className="px-3 py-2 text-meta text-ink-muted"
      >
        <span data-numeric>
          변경이 커서 파일별로 나누지 않았습니다. 패치 {formatCount(
            oversized.totalLineCount
          )}
          줄, {formatCount(kb)}KB.
        </span>{" "}
        아래에서 원문을 그대로 볼 수 있습니다.
      </p>

      <RawPatch patch={oversized.rawPatch} />
    </section>
  );
}

/**
 * One typed key/value row. The link card is metadata, never a JSON dump.
 *
 * `mono` is per row, not per card: a repository path and a branch name are
 * identifiers and read better in the mono face, while `status` arrives as a
 * human sentence ("리뷰 대기", "main에 머지됨"). Setting mono and break-all on
 * that put Korean prose in a code face and let it break mid-word.
 */
function MetaRow({
  label,
  mono = false,
  children,
}: {
  label: string;
  mono?: boolean;
  children: string;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 px-3 py-1">
      <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
      <dd
        className={cn(
          "min-w-0 flex-1 text-meta text-ink",
          mono ? "break-all font-mono" : "break-words"
        )}
      >
        {children}
      </dd>
    </div>
  );
}

/**
 * `브라우저에서 열기`, in both shells.
 *
 * A plain anchor is correct in a browser tab and dead in the Tauri shell: wry
 * does not implement WKWebView's new-window request, so `target="_blank"`
 * silently does nothing there. The desktop path therefore goes through the Rust
 * command (clients/desktop/src-tauri/src/opener.rs), which is where OS
 * behaviour belongs (design-taste-web §1), and the anchor keeps its native
 * behaviour everywhere else.
 *
 * If the shell cannot open it, the row says so and shows the address, because
 * the next step available to the reader is to copy it.
 */
function OpenLinkRow({ url, storageKey }: { url: string; storageKey: string }) {
  const key = `${storageKey}:${url}`;
  const [failed, setFailed] = useState(() => OPEN_FAILURES.get(key) === true);
  // Announced only when the failure happens while this row is mounted. A
  // restored failure is the same sentence the reader already saw, and
  // react-virtuoso re-mounts rows on every scroll pass, so keeping role="alert"
  // on it would interrupt a screen reader again on every return trip.
  const [announce, setAnnounce] = useState(false);
  return (
    <>
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        data-testid="artifact-link-open"
        onClick={(event) => {
          if (!isDesktop()) return;
          event.preventDefault();
          setFailed(false);
          OPEN_FAILURES.delete(key);
          void openExternalUrl(url).then((opened) => {
            remember(OPEN_FAILURES, key, !opened, OPEN_FAILURES_LIMIT);
            setFailed(!opened);
            setAnnounce(!opened);
          });
        }}
        className={cn(
          "flex items-center gap-2 border-t border-line px-3 py-2 text-meta text-accent press hover:bg-surface-hover",
          "focus-visible:focus-ring"
        )}
      >
        <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
        브라우저에서 열기
      </a>
      {failed && (
        <p
          {...(announce ? { role: "alert" } : {})}
          data-testid="artifact-link-failed"
          className="border-t border-line px-3 py-2 text-meta text-danger"
        >
          브라우저를 열지 못했습니다. 이 주소를 복사해 브라우저에 붙여넣으세요.{" "}
          <span className="break-all font-mono">{url}</span>
        </p>
      )}
    </>
  );
}

/**
 * Commit / pull request. v0 parses the props the message already carries and
 * asks GitHub nothing, so the card shows what the sender stated and never
 * invents a review state it has not fetched.
 */
function LinkCard({
  link,
  state,
  storageKey,
}: {
  link: LinkArtifact;
  state: ArtifactState | null;
  storageKey: string;
}) {
  const isCommit = link.kind === "commit";
  const Icon = isCommit ? GitCommitHorizontal : GitPullRequest;
  return (
    <section
      data-testid="artifact-card"
      data-artifact-kind={link.kind}
      data-status={state?.status}
      aria-label={[
        isCommit ? "커밋" : "풀 리퀘스트",
        link.title,
        link.repository,
        link.branch,
        link.status,
      ]
        .filter((part): part is string => Boolean(part))
        .join(", ")}
      className="mt-2 max-w-pane-lg rounded-md border border-line bg-surface-raised"
    >
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <Icon className="size-4 shrink-0 text-ink-muted" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-body font-medium text-ink">
          {link.title}
        </span>
        <ArtifactChip state={state} />
        <span className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp font-medium text-ink-muted">
          {isCommit ? "커밋" : "PR"}
        </span>
      </div>

      {state && <StatusNote state={state} />}

      {(link.repository || link.branch || link.status) && (
        <dl className="py-1">
          {link.repository && (
            <MetaRow label="저장소" mono>
              {link.repository}
            </MetaRow>
          )}
          {link.branch && (
            <MetaRow label="브랜치" mono>
              {link.branch}
            </MetaRow>
          )}
          {link.status && <MetaRow label="상태">{link.status}</MetaRow>}
        </dl>
      )}

      {link.url && <OpenLinkRow url={link.url} storageKey={storageKey} />}

      {link.urlRejected && (
        // Say why the link is missing instead of showing a pull request with no
        // door, name the host so the reader can tell whether it was even the
        // repository they expected, and end on the move that is actually
        // available to them (design-taste-web §5).
        <p
          data-testid="artifact-link-rejected"
          className="border-t border-line px-3 py-2 text-meta text-ink-muted"
        >
          링크를 열지 않습니다. https 주소가 아니거나 자격증명이 담긴 주소입니다.
          {link.rejectedHost && (
            <>
              {" "}
              주소의 호스트는 <span className="font-mono">{link.rejectedHost}</span>
              입니다.
            </>
          )}{" "}
          보낸 사람에게 https 링크로 다시 보내달라고 요청하세요.
        </p>
      )}
    </section>
  );
}

export function ArtifactCard({
  artifact,
  state = null,
  storageKey,
}: {
  artifact: ArtifactPresentation;
  /** Turn state hoisted from the card this artifact outranked (rowModel). */
  state?: ArtifactState | null;
  /** Stable per-message key for the disclosure state kept outside the tree. */
  storageKey: string;
}) {
  if (artifact.kind === "diff") {
    return <DiffCard diff={artifact} state={state} storageKey={storageKey} />;
  }
  if (artifact.kind === "oversized") {
    return <OversizedCard oversized={artifact} state={state} />;
  }
  return <LinkCard link={artifact} state={state} storageKey={storageKey} />;
}
