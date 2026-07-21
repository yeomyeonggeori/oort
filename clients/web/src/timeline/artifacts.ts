import type { TimelineMessage } from "./model";

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
  additions: number;
  deletions: number;
  lines: DiffLine[];
}

export type ArtifactPresentation =
  | {
      kind: "diff";
      title: string;
      additions: number;
      deletions: number;
      files: DiffFile[];
    }
  | {
      kind: "commit" | "pr";
      title: string;
      branch?: string;
      status?: string;
      repository?: string;
      url?: string;
    };

const MAX_SOURCE_BYTES = 200_000;
const MAX_LINE_COUNT = 2_000;
const MAX_FILE_COUNT = 100;
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

function artifactKind(message: TimelineMessage): ArtifactKind | undefined {
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

function looksLikeUnifiedDiff(raw: string): boolean {
  const trimmed = raw.trim();
  const source = stripSingleDiffFence(trimmed);
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) return false;
  const lines = source.split("\n");
  const first = lines.find((line) => line.trim() !== "");
  if (
    first === undefined ||
    !(
      source !== trimmed ||
      first.startsWith("diff --git ") ||
      first.startsWith("--- ")
    )
  ) {
    return false;
  }
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
    path = path.split("/").at(-1) ?? "Changed file";
  }
  return path === "/dev/null" ? undefined : path;
}

function parseDiff(
  raw: string,
  rawTitle: string | undefined
): Extract<ArtifactPresentation, { kind: "diff" }> | null {
  const source = stripSingleDiffFence(raw);
  if (new TextEncoder().encode(source).byteLength > MAX_SOURCE_BYTES) return null;
  const lines = source.split("\n");
  if (lines.length > MAX_LINE_COUNT) return null;

  interface PendingFile {
    oldPath?: string;
    newPath?: string;
    additions: number;
    deletions: number;
    lines: DiffLine[];
  }
  const files: DiffFile[] = [];
  let current: PendingFile | undefined;
  let sawGit = false;
  let sawHunk = false;
  const append = () => {
    if (current === undefined || current.lines.length === 0) return;
    if (files.length >= MAX_FILE_COUNT) return;
    files.push({
      id: files.length,
      path:
        normalizedPath(
          current.newPath === "/dev/null" ? current.oldPath : current.newPath
        ) ??
        normalizedPath(current.oldPath) ??
        "Changed file",
      additions: current.additions,
      deletions: current.deletions,
      lines: current.lines,
    });
  };

  for (const [id, line] of lines.entries()) {
    if (line.startsWith("diff --git ")) {
      append();
      if (files.length >= MAX_FILE_COUNT) return null;
      const paths = line.slice("diff --git ".length).split(" ", 2);
      current = {
        ...(paths[0] ? { oldPath: paths[0] } : {}),
        ...(paths[1] ? { newPath: paths[1] } : {}),
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
  return {
    kind: "diff",
    title: bounded(rawTitle, 200) ?? "Code changes",
    files,
    additions: files.reduce((sum, file) => sum + file.additions, 0),
    deletions: files.reduce((sum, file) => sum + file.deletions, 0),
  };
}

/** Mirrors MomoCore MessageArtifactPresentation's closed detection order. */
export function resolveArtifact(
  message: TimelineMessage
): ArtifactPresentation | null {
  const explicit = artifactKind(message);
  if (explicit === "commit" || explicit === "pr") {
    const branch = bounded(propString(message.props, "branch"), 120);
    const status = bounded(propString(message.props, "status"), 80);
    const repository = bounded(propString(message.props, "repository"), 160);
    const url = safeHttpsUrl(
      propString(message.props, "url") ?? propString(message.props, "uri")
    );
    return {
      kind: explicit,
      title:
        bounded(propString(message.props, "title"), 200) ??
        (explicit === "commit" ? "Commit" : "Pull request"),
      ...(branch ? { branch } : {}),
      ...(status ? { status } : {}),
      ...(repository ? { repository } : {}),
      ...(url ? { url } : {}),
    };
  }
  if (explicit === "diff") {
    const source = propString(message.props, "patch") ?? message.body;
    return source === undefined
      ? null
      : parseDiff(source, propString(message.props, "title"));
  }
  if (message.body === undefined || !looksLikeUnifiedDiff(message.body)) {
    return null;
  }
  return parseDiff(message.body, propString(message.props, "title"));
}
