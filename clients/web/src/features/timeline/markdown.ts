// =============================================================================
// Minimal message markdown (goal B8 H6). Pure: text in, a tree out.
//
// WHY A PARSER AND NOT A LIBRARY. The renderer beside this file (MessageBody)
// turns this tree into React elements. It never builds an HTML string and there
// is no `dangerouslySetInnerHTML` anywhere in this client, so markup injection
// is not "sanitised away", it is structurally impossible: every leaf is a React
// text node and React escapes those. The one channel that could still carry an
// attack is a URL, and `safeHref` is a scheme allowlist rather than a blocklist.
// A markdown-to-HTML library would have inverted that: it would hand back a
// string this client would have to trust, plus a sanitiser to trust with it,
// for two dependencies and roughly 40 kB. This file is ~200 lines and adds no
// dependency at all (measured bundle delta is in the PR body).
//
// WHAT IT IS NOT. Not CommonMark. Deliberately absent, each for a reason:
//   * headings — a message is not a document, and an accidental "#" at the
//     start of a line must not become a display-sized line in a dense timeline;
//   * images — a remote <img> is a network request to a third party from inside
//     a channel: an off-origin read receipt, and blocked by the shipped CSP
//     (img-src 'self' data:) anyway, so it would render as a broken box;
//   * tables, footnotes, html — a message body is prose, a list, or code.
//
// The grammar is what agents actually emit and what people actually type:
// **bold**, *italic*, `code`, ``` fences, - / 1. lists, [text](url), and bare
// http(s) links. Anything unmatched stays literal text, which is the only safe
// failure mode for a parser reading other people's writing: an unclosed ** is a
// pair of asterisks, never a swallowed rest-of-message.
// =============================================================================

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "code"; text: string }
  | { kind: "link"; href: string; children: Inline[] };

export type Block =
  | { kind: "paragraph"; lines: Inline[][] }
  | { kind: "code"; text: string; lang: string | null }
  | {
      kind: "list";
      ordered: boolean;
      /** The number the author started at. 1 for a bullet list. */
      start: number;
      items: Inline[][];
    };

/**
 * Control characters and whitespace anywhere in a URL, which is how a scheme
 * gets smuggled past a naive prefix test (`java\tscript:`). Written as a scan
 * rather than a regex because a control-character class is itself a lint error,
 * and because the intent reads better as a range than as an escape sequence.
 */
function hasControlOrSpace(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** Schemes a link may carry. Everything else renders as plain text. */
const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);

/**
 * The href a link may be given, or null when it may not be a link at all.
 *
 * An allowlist over `URL`'s own parse, not a regex over the raw string: the
 * parser lower-cases the scheme and decodes the percent-escapes for us, so
 * `JaVaScRiPt:` and `java%0ascript:` are both just `javascript:` by the time
 * the check runs. A relative href is rejected too (no base is meaningful for a
 * message body), which keeps `[a](/settings)` as literal text rather than a
 * link into a route this parser knows nothing about.
 */
export function safeHref(raw: string): string | null {
  const value = raw.trim();
  if (value === "" || hasControlOrSpace(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  return SAFE_SCHEMES.has(url.protocol) ? url.toString() : null;
}

const MAX_DEPTH = 4;

function runLength(text: string, from: number, char: string): number {
  let n = 0;
  while (text[from + n] === char) n += 1;
  return n;
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char);
}

/** Where an emphasis run closes, or -1. Content must be non-blank and tight. */
function closingIndex(text: string, start: number, delim: string): number {
  let from = start;
  for (;;) {
    const at = text.indexOf(delim, from);
    if (at < 0) return -1;
    const content = text.slice(start, at);
    // `** **` is two literal runs, not empty bold; `**a **` closes on a
    // delimiter that follows a space, which CommonMark also refuses.
    if (content.trim() === "" || /\s$/.test(content)) {
      from = at + delim.length;
      continue;
    }
    return at;
  }
}

// ASCII URL characters only (RFC 3986 unreserved + sub-delims + a few), NOT
// "everything up to whitespace". Korean glues its particles straight onto a
// URL with no space (`.../run/9f2에 로그가`), so a whitespace-delimited scan
// swallowed 에 into the href and produced a live link to a 404 — and in the
// Tauri shell handed that address to the OS. Hangul and CJK are outside this
// set, so the link now ends where the URL ends. `()[]{}<>"'` stay out because
// they are markdown's own punctuation around a link.
const BARE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/i;

/**
 * Inline nodes for one line. `depth` bounds nesting so a pathological body
 * (`****************…`) cannot recurse without end; past the bound the
 * remaining delimiters are literal text, which is what they look like anyway.
 */
export function parseInline(source: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  let i = 0;

  const flush = () => {
    if (buffer !== "") {
      out.push({ kind: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < source.length) {
    const char = source[i];

    // Code spans bind tightest: nothing inside one is markup, which is the
    // whole point of quoting it.
    if (char === "`") {
      const fence = runLength(source, i, "`");
      const close = source.indexOf("`".repeat(fence), i + fence);
      if (close > i) {
        const text = source.slice(i + fence, close);
        if (text !== "") {
          flush();
          out.push({ kind: "code", text });
          i = close + fence;
          continue;
        }
      }
    }

    if (char === "[" && depth < MAX_DEPTH) {
      const label = source.indexOf("]", i + 1);
      if (label > i && source[label + 1] === "(") {
        const close = source.indexOf(")", label + 2);
        if (close > label) {
          const href = safeHref(source.slice(label + 2, close));
          const text = source.slice(i + 1, label);
          if (href !== null && text !== "") {
            flush();
            out.push({ kind: "link", href, children: parseInline(text, depth + 1) });
            i = close + 1;
            continue;
          }
        }
      }
    }

    if ((char === "h" || char === "H") && !isWordChar(source[i - 1])) {
      const match = BARE_URL.exec(source.slice(i));
      if (match) {
        // Trailing sentence punctuation belongs to the sentence, not the URL.
        const raw = match[0].replace(/[.,;:!?]+$/, "");
        const href = safeHref(raw);
        if (href !== null) {
          flush();
          out.push({ kind: "link", href, children: [{ kind: "text", text: raw }] });
          i += raw.length;
          continue;
        }
      }
    }

    if ((char === "*" || char === "_") && depth < MAX_DEPTH) {
      const run = Math.min(runLength(source, i, char), 2);
      const delim = char.repeat(run);
      // `_` is a word character in identifiers (snake_case, __init__), so it
      // only opens emphasis at a word boundary. `*` has no such life.
      const boundaryOk = char === "*" || !isWordChar(source[i - 1]);
      if (boundaryOk && !/\s/.test(source[i + run] ?? " ")) {
        const close = closingIndex(source, i + run, delim);
        if (close > 0) {
          const after = source[close + delim.length];
          if (char === "*" || !isWordChar(after)) {
            const inner = source.slice(i + run, close);
            flush();
            out.push({
              kind: run === 2 ? "strong" : "em",
              children: parseInline(inner, depth + 1),
            });
            i = close + delim.length;
            continue;
          }
        }
      }
    }

    buffer += char;
    i += 1;
  }

  flush();
  return out;
}

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+-]*)\s*$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
// At most THREE digits, and the number is captured.
//
// `\d{1,9}` matched `2026. 07. 30. 배포 예정`, which is the ordinary Korean way
// to write a date. The line became a one item ordered list, the year was eaten
// as the marker, and the reader saw "1." in front of a date they never
// numbered. Nothing on screen said a transform had happened. A list marker in a
// chat message is a small number; a four digit run at the start of a line is
// very likely a year.
//
// The captured number matters just as much: an agent quoting steps 3 and 4 of a
// runbook used to be renumbered to 1 and 2, which is the same class of harm in
// a different place. The author's start now rides through to the `<ol>`.
const ORDERED = /^\s{0,3}(\d{1,3})[.)]\s+(.*)$/;

/**
 * Block structure. Consecutive non-blank lines are one paragraph and keep their
 * own line breaks (a chat message's newlines are authored, unlike a document's),
 * so the renderer can preserve them without `whitespace-pre-wrap` swallowing
 * the list and code layout beside them.
 */
export function parseMarkdown(source: string): Block[] {
  const lines = source.split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1][0];
      const body: string[] = [];
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const candidate = FENCE.exec(lines[i]);
        if (candidate && candidate[1][0] === marker && candidate[2] === "") {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      // An unclosed fence still renders as code: the author asked for a block
      // and the rest of the message is what they put in it.
      void closed;
      blocks.push({
        kind: "code",
        text: body.join("\n"),
        lang: fence[2] === "" ? null : fence[2],
      });
      continue;
    }

    const bulletMatch = BULLET.exec(line);
    const orderedMatch = bulletMatch ? null : ORDERED.exec(line);
    if (bulletMatch || orderedMatch) {
      const ordered = orderedMatch !== null;
      const start = orderedMatch ? Number(orderedMatch[1]) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const current = lines[i];
        const match = ordered ? ORDERED.exec(current) : BULLET.exec(current);
        if (!match) break;
        items.push(parseInline(ordered ? match[2] : match[1]));
        i += 1;
      }
      blocks.push({ kind: "list", ordered, start, items });
      continue;
    }

    const paragraph: Inline[][] = [];
    while (i < lines.length) {
      const current = lines[i];
      if (
        current.trim() === "" ||
        FENCE.test(current) ||
        BULLET.test(current) ||
        ORDERED.test(current)
      ) {
        break;
      }
      paragraph.push(parseInline(current));
      i += 1;
    }
    blocks.push({ kind: "paragraph", lines: paragraph });
  }

  return blocks;
}

/**
 * True when the body carries nothing this parser would style. The renderer uses
 * it to keep the plain path byte-identical to what shipped before: an ordinary
 * sentence must not start paying for a tree walk, and must not change shape.
 */
export function isPlainText(source: string): boolean {
  return !/[`*_[\]]|^\s{0,3}(\d{1,3}[.)]|[-*+])\s|https?:\/\//m.test(source);
}
