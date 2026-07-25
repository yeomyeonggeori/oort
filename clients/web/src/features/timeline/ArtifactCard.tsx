import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  FileDiff,
  GitCommitHorizontal,
  GitPullRequest,
} from "lucide-react";
import { cn } from "@/design/lib/cn";
import { formatCount } from "./agentCardModel";
import {
  isTruncated,
  type DiffArtifact,
  type DiffFile,
  type DiffLineKind,
  type ArtifactPresentation,
  type LinkArtifact,
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
// Three things this card refuses to do:
//   - it never claims a count it did not measure. The +N −N summary is the
//     SOURCE total even when the body is a truncated slice, and the gap is
//     stated in a banner rather than hidden (MomoCore honest-truncation
//     contract).
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
  hunk: "bg-surface-hover text-accent",
  metadata: "text-ink-muted",
  context: "text-ink",
};

/**
 * `+N −N`. Mono and tabular so a column of file summaries reads down, and the
 * pair is one accessible label because "12" and "3" alone say nothing.
 * U+2212 MINUS SIGN, not a hyphen: it aligns with the digits at this size.
 */
function ChangeSummary({
  additions,
  deletions,
  testId,
}: {
  additions: number;
  deletions: number;
  testId?: string;
}) {
  return (
    <span
      data-numeric
      data-testid={testId}
      className="shrink-0 font-mono text-timestamp font-semibold"
      aria-label={`추가 ${formatCount(additions)}줄, 삭제 ${formatCount(
        deletions
      )}줄`}
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
  defaultOpen,
}: {
  file: DiffFile;
  defaultOpen: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
      data-testid="artifact-diff-file"
      data-path={file.path}
    >
      {/* Sticky inside the scrolling body: a 200 line file otherwise carries
          its own path off the top of the card and leaves the reader scrolling
          code with no idea which file they are in. z-10 because a sticky box
          with no z-index creates no stacking context, and the next file's lines
          would paint straight over it. */}
      <summary className="sticky top-0 z-10 flex cursor-pointer items-center gap-2 border-b border-line bg-surface-raised px-3 py-1 hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
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
        // mouse-only (WCAG 2.1.1).
        <pre
          tabIndex={0}
          aria-label={`${file.path} 변경 내용`}
          className="overflow-x-auto pb-1 font-mono text-meta focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
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
    </details>
  );
}

function DiffCard({ diff }: { diff: DiffArtifact }) {
  const truncated = isTruncated(diff);
  let budget = EAGER_LINE_BUDGET;

  return (
    <section
      data-testid="artifact-card"
      data-artifact-kind="diff"
      data-total-lines={diff.totalLineCount}
      data-displayed-lines={diff.displayedLineCount}
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
        <ChangeSummary
          additions={diff.additions}
          deletions={diff.deletions}
          testId="artifact-diff-total"
        />
      </div>

      {truncated && (
        // Honest banner, not a fade-out: the source is longer than the body and
        // the card says by how much. The whole patch is still reachable under
        // 원본 diff 보기 below, so nothing is lost, only folded.
        <p
          role="status"
          data-testid="artifact-diff-truncation"
          className="border-b border-line px-3 py-1 text-meta text-ink-muted"
        >
          <span data-numeric>
            전체 {formatCount(diff.totalLineCount)}줄 중{" "}
            {formatCount(diff.displayedLineCount)}줄 표시
          </span>
        </p>
      )}

      {/* A MAXIMUM, not a fixed height: a three line change hugs its content and
          only a genuinely long one reaches the cap and scrolls, so the card
          never opens onto an empty band. Focusable for the same reason as the
          per-file scroller below. */}
      <div
        tabIndex={0}
        aria-label="변경 내용"
        className="max-h-diff-body overflow-y-auto focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        {diff.files.map((file) => {
          const eager = budget > 0;
          budget -= file.lines.length;
          return (
            <DiffFileSection key={file.id} file={file} defaultOpen={eager} />
          );
        })}
      </div>

      <details className="border-t border-line" data-testid="artifact-diff-raw">
        <summary className="cursor-pointer px-3 py-2 text-meta text-ink-muted hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
          원본 diff 보기
        </summary>
        <pre
          tabIndex={0}
          aria-label="원본 diff"
          className="max-h-pane overflow-auto px-3 pb-2 font-mono text-meta text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          {diff.rawPatch}
        </pre>
      </details>
    </section>
  );
}

/** One typed key/value row. The link card is metadata, never a JSON dump. */
function MetaRow({ label, children }: { label: string; children: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2 px-3 py-1">
      <dt className="shrink-0 text-meta text-ink-muted">{label}</dt>
      <dd className="min-w-0 flex-1 break-all font-mono text-meta text-ink">
        {children}
      </dd>
    </div>
  );
}

/**
 * Commit / pull request. v0 parses the props the message already carries and
 * asks GitHub nothing, so the card shows what the sender stated and never
 * invents a review state it has not fetched.
 */
function LinkCard({ link }: { link: LinkArtifact }) {
  const isCommit = link.kind === "commit";
  const Icon = isCommit ? GitCommitHorizontal : GitPullRequest;
  return (
    <section
      data-testid="artifact-card"
      data-artifact-kind={link.kind}
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
        <span className="shrink-0 rounded-sm bg-surface-hover px-2 py-px text-timestamp font-medium text-ink-muted">
          {isCommit ? "커밋" : "PR"}
        </span>
      </div>

      {(link.repository || link.branch || link.status) && (
        <dl className="py-1">
          {link.repository && <MetaRow label="저장소">{link.repository}</MetaRow>}
          {link.branch && <MetaRow label="브랜치">{link.branch}</MetaRow>}
          {link.status && <MetaRow label="상태">{link.status}</MetaRow>}
        </dl>
      )}

      {link.url && (
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer noopener"
          data-testid="artifact-link-open"
          className="flex items-center gap-2 border-t border-line px-3 py-2 text-meta text-accent hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        >
          <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
          브라우저에서 열기
        </a>
      )}

      {link.urlRejected && (
        // Say why the link is missing instead of showing a pull request with no
        // door. The refusal is this client's (https only, no credential-shaped
        // query), so it states its own rule rather than blaming the sender.
        <p
          data-testid="artifact-link-rejected"
          className="border-t border-line px-3 py-2 text-meta text-ink-muted"
        >
          링크를 열지 않습니다. https 주소가 아니거나 자격증명이 담긴 주소입니다.
        </p>
      )}
    </section>
  );
}

export function ArtifactCard({ artifact }: { artifact: ArtifactPresentation }) {
  return artifact.kind === "diff" ? (
    <DiffCard diff={artifact} />
  ) : (
    <LinkCard link={artifact} />
  );
}
