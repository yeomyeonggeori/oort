import type { Message } from "@/lib/api";

// =============================================================================
// Artifact presentation model (ADR-0126 D2 / MOMO-620, the web half of the mac
// MOMO-518 card). Pure: no DOM, no fetch, no React, so the detection order and
// the truncation arithmetic are asserted by unit tests rather than by a
// screenshot.
//
// The CONTRACT is macOS's. `clients/Core/Sources/MomoCore/
// MessageArtifactPresentation.swift` is the source of truth for:
//   - the closed artifact vocabulary `artifact_kind: diff | commit | pr`,
//   - the props each kind reads (title / patch / branch / status / repository /
//     url|uri) and the legacy fallbacks (`kind` on a `type: artifact` row, and
//     `type: diff`),
//   - the conservative body sniff that promotes an unmarked message,
//   - the 200,000 byte source ceiling and the 500 rendered-line cap,
//   - the honest counts (`additions`/`deletions` count the FULL source, never
//     the rendered slice) that let a client say "N of M lines" instead of
//     quietly dropping the rest.
// This file mirrors it line for line; where the two ever disagree, mac wins and
// this is the file that is wrong. It is a straight port of the mirror that
// shipped with MOMO-518 (clients/web-legacy/src/timeline/artifacts.ts), moved
// onto the ADR-0133 client's `Message` type.
//
// Everything the parser cannot name it declines: a malformed or oversized
// source returns null and the row keeps its ordinary message rendering, which
// is the "카드 남발 금지" rule expressed as code.
// =============================================================================

export type ArtifactKind = "diff" | "commit" | "pr";

export type DiffLineKind =
  | "metadata"
  | "hunk"
  | "context"
  | "addition"
  | "deletion";

export interface DiffLine {
  id: number;
  kind: DiffLineKind;
  text: string;
}

export interface DiffFile {
  id: number;
  path: string;
  /** Full-file counts. Truncating the body never changes them. */
  additions: number;
  deletions: number;
  /**
   * Lines this file has in the SOURCE. `lines.length` is what survived display
   * truncation, so `lines.length < lineCount` means the file is cut and
   * `lines.length === 0` means only its path made it into the card.
   */
  lineCount: number;
  lines: DiffLine[];
}

export interface DiffArtifact {
  kind: "diff";
  title: string;
  /** Source-wide counts, honest even when `files` holds a truncated slice. */
  additions: number;
  deletions: number;
  /**
   * EVERY file in the source, in source order. Truncation empties a file's
   * `lines`, it never drops the file: a card that renders 10 of 12 files while
   * announcing "파일 10개" states a count it did not measure, which is the one
   * thing this model exists to prevent.
   */
  files: DiffFile[];
  /** Fence-stripped source, kept whole for the raw-payload disclosure. */
  rawPatch: string;
  /** Diff lines in the source before display truncation. */
  totalLineCount: number;
  /** Diff lines actually kept in `files`. */
  displayedLineCount: number;
}

/**
 * A patch past the source ceiling. Rendering side only, and it exists because
 * declining to parse must not mean declining to CONTAIN: without it a 200 KB
 * patch fell through to the plain body paragraph, which has no height cap, so
 * the largest change on the timeline was the one that grew the row without
 * limit (the exact inversion ArtifactCard's MOMO-610 promise rules out).
 *
 * It carries no files and no +/- counts on purpose. Nothing here was parsed, so
 * nothing here may be claimed; the card says how big the patch is and hands the
 * source to a bounded disclosure.
 */
export interface OversizedArtifact {
  kind: "oversized";
  title: string;
  /** Lines in the source patch. */
  totalLineCount: number;
  /** Bytes in the source patch, as the ceiling measured them. */
  byteCount: number;
  /** Fence-stripped source, whole, for the bounded disclosure. */
  rawPatch: string;
}

export interface LinkArtifact {
  kind: "commit" | "pr";
  title: string;
  branch?: string;
  status?: string;
  repository?: string;
  /** Only HTTPS URLs with no credential-like query key survive resolution. */
  url?: string;
  /**
   * The message carried a url/uri prop and this client refused it. Rendering
   * side only: the props read above is byte-identical to mac's, and this flag
   * exists so a card can say the link was dropped instead of silently showing
   * a pull request with no way to open it.
   */
  urlRejected: boolean;
  /**
   * Host of the refused address, when it parsed as a URL at all. A hostname is
   * not a credential (the query string that carried one is already gone), and
   * naming it turns "we refused a link" into something the reader can act on:
   * they can see whether it was the repository they expected.
   */
  rejectedHost?: string;
}

export type ArtifactPresentation =
  | DiffArtifact
  | LinkArtifact
  | OversizedArtifact;

/** Source ceiling. Past this the message stays a message (MomoCore parity). */
const MAX_SOURCE_BYTES = 200_000;

/** Diff lines kept for rendering; the overflow is counted, never hidden. */
const MAX_RENDERED_LINES = 500;

const SENSITIVE_URL_KEYS = [
  "token",
  "capability",
  "authorization",
  "signature",
  "secret",
  "api_key",
  "apikey",
];

function propString(
  props: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = props?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function bounded(value: string | undefined, maximum: number) {
  return value !== undefined && value.length <= maximum ? value : undefined;
}

function byteLength(source: string): number {
  return new TextEncoder().encode(source).byteLength;
}

/**
 * Explicit `artifact_kind` first, then the legacy typed-message shape. Both
 * lookups are case-insensitive and closed to the three ADR-0126 values, so an
 * unknown kind is not an artifact rather than a fourth card.
 */
function artifactKind(message: Message): ArtifactKind | undefined {
  const explicit = propString(message.props, "artifact_kind")?.toLowerCase();
  if (explicit === "diff" || explicit === "commit" || explicit === "pr") {
    return explicit;
  }
  const legacy = propString(message.props, "kind")?.toLowerCase();
  if (
    message.type === "artifact" &&
    (legacy === "diff" || legacy === "commit" || legacy === "pr")
  ) {
    return legacy;
  }
  return message.type === "diff" ? "diff" : undefined;
}

/**
 * HTTPS only, no embedded credentials, no credential-shaped query key, no
 * fragment. A link the client cannot vouch for is not rendered as one
 * (ADR-0004: provider credentials never flow through a client surface).
 */
function safeHttpsUrl(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.hostname === "" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    for (const key of url.searchParams.keys()) {
      const lower = key.toLowerCase();
      if (SENSITIVE_URL_KEYS.some((fragment) => lower.includes(fragment))) {
        return undefined;
      }
    }
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Strip exactly one wrapping ```diff / ```patch fence, never a nested one. */
function stripSingleDiffFence(source: string): string {
  const lines = source.split("\n");
  if (lines.length < 3) return source;
  const opening = lines[0]?.trim().toLowerCase();
  if (
    (opening === "```diff" || opening === "```patch") &&
    lines.at(-1)?.trim() === "```"
  ) {
    return lines.slice(1, -1).join("\n");
  }
  return source;
}

/**
 * Anchored pre-filter for the sniff below: the only four ways a body can open
 * and still be a diff. Anchored, so it reads the first bytes and stops.
 */
const DIFF_HEAD_RE = /^(```(diff|patch)|diff --git |--- )/i;

/**
 * The promotion bar for an UNMARKED message (MomoCore `looksLikeUnifiedDiff`).
 * It is deliberately narrow: either the body is fenced as ```diff/```patch, or
 * its first content line is a real `diff --git ` / `--- ` header, AND the body
 * carries hunk or ---/+++ header structure. A message that merely mentions a
 * `+` line keeps its plain rendering.
 *
 * Cheapest test first, and that ordering is load-bearing rather than tidy:
 * MessageRow's useMemo is thrown away every time react-virtuoso unmounts a row,
 * so a channel of long prose used to re-encode every body to UTF-8 on every
 * scroll pass just to learn it was not a diff. The head match rejects those
 * before anything touches the whole string. The size ceiling moved OUT of this
 * function entirely: an oversized patch IS a diff, it is just one this client
 * renders as `oversized` rather than parsing.
 */
function looksLikeUnifiedDiff(raw: string): boolean {
  const trimmed = raw.trim();
  if (!DIFF_HEAD_RE.test(trimmed)) return false;
  const source = stripSingleDiffFence(trimmed);
  if (
    source === trimmed &&
    !(trimmed.startsWith("diff --git ") || trimmed.startsWith("--- "))
  ) {
    // The head looked like a fence but was not one (```diffs, ```patched), and
    // what is left does not open with a real header.
    return false;
  }
  const lines = source.split("\n");
  const hunk = lines.some((line) => line.startsWith("@@"));
  const git = lines.some((line) => line.startsWith("diff --git "));
  const headers =
    lines.some((line) => line.startsWith("--- ")) &&
    lines.some((line) => line.startsWith("+++ "));
  return (git && (hunk || headers)) || (headers && hunk);
}

function normalizedPath(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let path = raw.trim();
  if (path === "") return undefined;
  if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
    path = path.slice(1, -1);
  }
  if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
  if (path.startsWith("/") && path !== "/dev/null") {
    path = path.split("/").at(-1) ?? "이름 없는 파일";
  }
  return path === "/dev/null" ? undefined : path;
}

/**
 * `diff --git a/x b/y` -> the two paths. Split on the FIRST space only, the way
 * MomoCore does (`maxSplits: 1`), so a path containing a space is kept whole on
 * the right side instead of being cut at the second space.
 */
function diffGitPaths(line: string): [string, string] | undefined {
  const payload = line.slice("diff --git ".length);
  const space = payload.indexOf(" ");
  if (space < 0) return undefined;
  return [payload.slice(0, space), payload.slice(space + 1)];
}

interface PendingFile {
  oldPath?: string;
  newPath?: string;
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

/**
 * Fence-strip, weigh, then parse. A source past the ceiling becomes the
 * `oversized` card instead of falling through to the unbounded body paragraph.
 */
function diffArtifact(
  raw: string,
  rawTitle: string | undefined
): DiffArtifact | OversizedArtifact | null {
  const source = stripSingleDiffFence(raw);
  const byteCount = byteLength(source);
  if (byteCount > MAX_SOURCE_BYTES) {
    return {
      kind: "oversized",
      title: bounded(rawTitle, 200) ?? "코드 변경",
      totalLineCount: source.split("\n").length,
      byteCount,
      rawPatch: source,
    };
  }
  return parseDiff(source, rawTitle);
}

function parseDiff(source: string, rawTitle: string | undefined): DiffArtifact | null {
  const lines = source.split("\n");

  const files: DiffFile[] = [];
  let current: PendingFile | undefined;
  let sawGit = false;
  let sawHunk = false;

  const append = () => {
    if (current === undefined || current.lines.length === 0) return;
    files.push({
      id: files.length,
      path:
        normalizedPath(
          current.newPath === "/dev/null" ? current.oldPath : current.newPath
        ) ??
        normalizedPath(current.oldPath) ??
        "이름 없는 파일",
      additions: current.additions,
      deletions: current.deletions,
      lineCount: current.lines.length,
      lines: current.lines,
    });
  };

  for (const [id, line] of lines.entries()) {
    if (line.startsWith("diff --git ")) {
      append();
      const paths = diffGitPaths(line);
      current = {
        ...(paths ? { oldPath: paths[0], newPath: paths[1] } : {}),
        additions: 0,
        deletions: 0,
        lines: [{ id, kind: "metadata", text: line }],
      };
      sawGit = true;
      continue;
    }
    if (line.startsWith("--- ")) {
      current ??= { additions: 0, deletions: 0, lines: [] };
      current.oldPath = line.slice(4).split("\t", 1)[0];
      current.lines.push({ id, kind: "metadata", text: line });
      continue;
    }
    if (line.startsWith("+++ ")) {
      current ??= { additions: 0, deletions: 0, lines: [] };
      current.newPath = line.slice(4).split("\t", 1)[0];
      current.lines.push({ id, kind: "metadata", text: line });
      continue;
    }
    if (current === undefined) continue;
    let kind: DiffLineKind = "metadata";
    if (line.startsWith("@@")) {
      kind = "hunk";
      sawHunk = true;
    } else if (line.startsWith("+")) {
      kind = "addition";
      current.additions += 1;
    } else if (line.startsWith("-")) {
      kind = "deletion";
      current.deletions += 1;
    } else if (line.startsWith(" ") || line === "") {
      kind = "context";
    }
    current.lines.push({ id, kind, text: line });
  }
  append();
  if (files.length === 0 || (!sawGit && !sawHunk)) return null;

  const totalLineCount = files.reduce((sum, file) => sum + file.lines.length, 0);
  const { renderedFiles, displayedLineCount } = truncateForDisplay(
    files,
    MAX_RENDERED_LINES
  );

  return {
    kind: "diff",
    title: bounded(rawTitle, 200) ?? "코드 변경",
    files: renderedFiles,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
    rawPatch: source,
    totalLineCount,
    displayedLineCount,
  };
}

/**
 * Keeps the first `limit` diff lines in source order and empties the overflow.
 *
 * Every file survives, including the ones the budget never reached: they come
 * back with `lines: []` and their real `lineCount`, `additions` and `deletions`
 * intact. Dropping them from the array instead (the first cut of this function)
 * made `files.length` a count of what fit rather than a count of what changed,
 * and the card then announced that number as the size of the change while two
 * files were missing from the list with nothing saying so.
 */
function truncateForDisplay(
  files: DiffFile[],
  limit: number
): { renderedFiles: DiffFile[]; displayedLineCount: number } {
  const total = files.reduce((sum, file) => sum + file.lines.length, 0);
  if (total <= limit) return { renderedFiles: files, displayedLineCount: total };

  let remaining = limit;
  const renderedFiles: DiffFile[] = files.map((file) => {
    if (remaining >= file.lines.length) {
      remaining -= file.lines.length;
      return file;
    }
    const kept = file.lines.slice(0, remaining);
    remaining = 0;
    return { ...file, lines: kept };
  });
  const displayedLineCount = renderedFiles.reduce(
    (sum, file) => sum + file.lines.length,
    0
  );
  return { renderedFiles, displayedLineCount };
}

/** True when the body holds fewer lines than the source. */
export function isTruncated(diff: DiffArtifact): boolean {
  return diff.displayedLineCount < diff.totalLineCount;
}

/** Files whose lines were dropped entirely: only the path is on the card. */
export function omittedFileCount(diff: DiffArtifact): number {
  return diff.files.filter(
    (file) => file.lines.length === 0 && file.lineCount > 0
  ).length;
}

/** Hostname of an address, when it parses at all. Never the query string. */
function urlHost(raw: string): string | undefined {
  try {
    const host = new URL(raw).hostname;
    return host === "" ? undefined : host;
  } catch {
    return undefined;
  }
}

function linkArtifact(kind: "commit" | "pr", message: Message): LinkArtifact {
  const branch = bounded(propString(message.props, "branch"), 120);
  const status = bounded(propString(message.props, "status"), 80);
  const repository = bounded(propString(message.props, "repository"), 160);
  const rawUrl =
    propString(message.props, "url") ?? propString(message.props, "uri");
  const url = safeHttpsUrl(rawUrl);
  const rejectedHost =
    rawUrl !== undefined && url === undefined
      ? bounded(urlHost(rawUrl), 160)
      : undefined;
  return {
    kind,
    title:
      bounded(propString(message.props, "title"), 200) ??
      (kind === "commit" ? "커밋" : "풀 리퀘스트"),
    ...(branch ? { branch } : {}),
    ...(status ? { status } : {}),
    ...(repository ? { repository } : {}),
    ...(url ? { url } : {}),
    urlRejected: rawUrl !== undefined && url === undefined,
    ...(rejectedHost ? { rejectedHost } : {}),
  };
}

/**
 * The artifact this message renders as, or null when it is an ordinary message.
 * Mirrors MomoCore `MessageArtifactPresentation.resolve` detection order:
 * explicit kind, then the typed message shape, then the conservative body sniff.
 *
 * A deleted row never becomes a card: the tombstone is the whole story, the
 * same rule `agentCardModel` already applies.
 */
export function resolveArtifact(message: Message): ArtifactPresentation | null {
  if (message.state === "deleted") return null;

  const explicit = artifactKind(message);
  if (explicit === "commit" || explicit === "pr") {
    return linkArtifact(explicit, message);
  }
  if (explicit === "diff") {
    const source = propString(message.props, "patch") ?? message.body;
    return source === undefined
      ? null
      : diffArtifact(source, propString(message.props, "title"));
  }
  if (message.body === undefined || !looksLikeUnifiedDiff(message.body)) {
    return null;
  }
  return diffArtifact(message.body, propString(message.props, "title"));
}

/**
 * True when the plain message body still renders above the card.
 *
 * A diff card built from the message BODY already shows that body, so repeating
 * it as prose above the card would print the same patch twice. Every other case
 * (a diff carried in `props.patch`, a commit/PR link) leaves the author's own
 * sentence in place: the card is structured metadata beside the sentence, not a
 * replacement for it. This is the one place the web card deliberately reads
 * differently from the mac card, which replaces the body in all cases; the
 * props contract above is untouched by it.
 */
export function artifactKeepsBody(
  message: Message,
  artifact: ArtifactPresentation
): boolean {
  if (artifact.kind !== "diff" && artifact.kind !== "oversized") return true;
  return propString(message.props, "patch") !== undefined;
}
