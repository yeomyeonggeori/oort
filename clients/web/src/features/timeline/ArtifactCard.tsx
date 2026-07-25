import { useState } from "react";
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
import { formatCount } from "./agentCardModel";
import { StreamCaret, TurnChip } from "./StatusChip";
import { isProvisional, type ArtifactState } from "./rowModel";
import {
  isTruncated,
  omittedFileCount,
  type DiffArtifact,
  type DiffFile,
  type DiffLineKind,
  type ArtifactPresentation,
  type LinkArtifact,
  type OversizedArtifact,
} from "./artifacts";

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
  context: "text-ink",
};

/**
 * Focus ring for a control that lives INSIDE the clipping diff body.
 *
 * The house pattern is `outline-offset-2`, and it is invisible here: the body
 * is a `max-h-diff-body` scroll container, so its computed overflow clips both
 * axes, and a ring drawn 2px OUTSIDE a child's border box is cut off on every
 * edge that touches the container (the sticky file header lost its ring
 * entirely). Drawing the same 2px ring 2px INSIDE the border box puts it in
 * painted territory the container cannot clip.
 */
const INSET_FOCUS_RING =
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent";

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

function rememberOpen(key: string, open: boolean) {
  OPEN_FILES.delete(key);
  OPEN_FILES.set(key, open);
  if (OPEN_FILES.size > OPEN_FILES_LIMIT) {
    const oldest = OPEN_FILES.keys().next().value;
    if (oldest !== undefined) OPEN_FILES.delete(oldest);
  }
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
      data-numeric
      data-testid={testId}
      data-provisional={provisional ? "true" : undefined}
      className="shrink-0 font-mono text-timestamp font-semibold"
      aria-label={`${provisional ? "지금까지 " : ""}변경 줄, 추가 ${formatCount(
        additions
      )}줄, 삭제 ${formatCount(deletions)}줄`}
    >
      <span className="text-ok">+{formatCount(additions)}</span>{" "}
      <span className="text-danger">−{formatCount(deletions)}</span>
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
  const hidden = file.lineCount - file.lines.length;
  return (
    <details
      open={open}
      onToggle={(event) => {
        const next = event.currentTarget.open;
        setOpen(next);
        rememberOpen(storageKey, next);
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
          "sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-line bg-surface-raised px-3 py-1 hover:bg-surface-hover",
          INSET_FOCUS_RING
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
        // tabIndex because a scroll container with no focusable child is not
        // reachable from the keyboard in WebKit, which is the engine the Tauri
        // shell runs on: without it the right-hand half of a long line is
        // mouse-only (WCAG 2.1.1). role="group" with it, because ARIA forbids
        // naming a `generic` element, so on a bare <pre> the aria-label below is
        // dropped and the stop announces nothing at all.
        <pre
          tabIndex={0}
          role="group"
          aria-label={`${file.path} 변경 내용`}
          className={cn(
            "overflow-x-auto pb-1 font-mono text-meta",
            INSET_FOCUS_RING
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
 * Copy per status, and the split matters: `error` says what failed, `stalled`
 * says news has not arrived and refuses to call that a failure (ADR-0132), and
 * the in-flight statuses say the patch below is a running total. Only `error`
 * is allowed the danger colour.
 */
function StatusNote({ state }: { state: ArtifactState }) {
  const live = state.status === "thinking" || state.status === "streaming";
  let text: string;
  let danger = false;
  if (state.status === "error") {
    text =
      state.note ?? "이 변경을 끝내지 못했습니다. 아래 내용은 실패한 시점까지입니다.";
    danger = true;
  } else if (state.status === "stalled") {
    text = "아직 응답이 없습니다. 실패로 확정되지 않았습니다.";
    if (state.note) text += ` 마지막 신호: ${state.note}`;
  } else if (state.status === "cancelled") {
    text = "실행이 중단되어 여기까지만 도착했습니다.";
    if (state.note) text += ` 마지막 신호: ${state.note}`;
  } else if (state.status === "awaiting-approval") {
    text = "승인을 기다리는 중이라 아래 내용은 아직 확정이 아닙니다.";
    if (state.note) text += ` 마지막 신호: ${state.note}`;
  } else {
    text = "아직 받는 중입니다. 아래 내용과 숫자는 지금까지 도착한 부분입니다.";
    if (state.note) text += ` 마지막 신호: ${state.note}`;
  }
  return (
    <p
      data-testid="artifact-status-note"
      className={cn(
        "border-b border-line px-3 py-1 text-meta",
        danger ? "text-danger" : "text-ink-muted"
      )}
    >
      {text}
      {live && <StreamCaret />}
    </p>
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
      <div className="max-h-diff-body overflow-y-auto">
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

      <details className="border-t border-line" data-testid="artifact-diff-raw">
        <summary
          className={cn(
            "cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover",
            INSET_FOCUS_RING
          )}
        >
          원본 diff 보기
        </summary>
        <pre
          tabIndex={0}
          role="group"
          aria-label="원본 diff"
          className={cn(
            "max-h-pane overflow-auto px-3 pb-2 font-mono text-meta text-ink",
            INSET_FOCUS_RING
          )}
        >
          {diff.rawPatch}
        </pre>
      </details>
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

      <details className="border-t border-line" data-testid="artifact-diff-raw">
        <summary
          className={cn(
            "cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover",
            INSET_FOCUS_RING
          )}
        >
          원본 diff 보기
        </summary>
        <pre
          tabIndex={0}
          role="group"
          aria-label="원본 diff"
          className={cn(
            "max-h-pane overflow-auto px-3 pb-2 font-mono text-meta text-ink",
            INSET_FOCUS_RING
          )}
        >
          {oversized.rawPatch}
        </pre>
      </details>
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
function OpenLinkRow({ url }: { url: string }) {
  const [failed, setFailed] = useState(false);
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
          void openExternalUrl(url).then((opened) => setFailed(!opened));
        }}
        className={cn(
          "flex items-center gap-2 border-t border-line px-3 py-2 text-meta text-accent hover:bg-surface-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        )}
      >
        <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
        브라우저에서 열기
      </a>
      {failed && (
        <p
          role="alert"
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
}: {
  link: LinkArtifact;
  state: ArtifactState | null;
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

      {link.url && <OpenLinkRow url={link.url} />}

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
  return <LinkCard link={artifact} state={state} />;
}
