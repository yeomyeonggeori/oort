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
// "everything up to whitespace": Korean glues its particles straight onto a URL
// with no space (`.../run/9f2에 로그가`), and a whitespace-delimited scan
// swallowed 에 into the href.
//
// But stopping at the first non-ASCII character is not enough on its own,
// because the prefix is ALSO a valid URL. `https://ko.wikipedia.org/wiki/모모`
// would have linkified as `https://ko.wikipedia.org/wiki/` — a working control
// that goes to the wrong page, which is worse than the bug it replaced. So the
// scan's result is only used when what FOLLOWS it cannot be part of the URL
// (see `AMBIGUOUS_URL_TAIL`); a URL that runs into a letter of any script is
// left as literal text, complete and selectable, which is this file's stated
// failure mode everywhere else. A fully non-ASCII host (`https://동아리.한국/`)
// already behaved that way, so the two neighbouring cases now agree.
const BARE_URL = /^https?:\/\/[A-Za-z0-9\-._~:/?#@!$&*+,;=%]+/i;

/**
 * True when the character after a bare-URL match could still belong to the URL,
 * which makes the match a truncation rather than the whole address.
 *
 * Letters and digits of any script: `모` in a wiki path, `문` in a filename.
 * Punctuation, whitespace and end-of-line are not ambiguous, so a URL followed
 * by `를`, `)` or nothing links normally.
 */
function isAmbiguousUrlTail(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

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
      if (match && !isAmbiguousUrlTail(source[i + match[0].length])) {
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
// Three digits at most, no leading zero, and the number is captured.
//
// `\d{1,9}` matched `2026. 07. 30. 배포 예정`, the ordinary Korean way to write
// a date: the line became a one item ordered list, the year was eaten as the
// marker, and the reader saw "1." in front of a date they never numbered. The
// digit bound removes the year; `[1-9]` removes the zero padded month, because
// `09.` is a date and a list marker is never written with a leading zero.
//
// The captured number matters just as much: an agent quoting steps 3 and 4 of a
// runbook used to be renumbered to 1 and 2, which is the same harm in a
// different place. The author's start now rides through to the `<ol>`.
//
// What neither bound catches is `12. 25. 크리스마스 휴무`, so there is a second
// rule (`opensOrderedList`): a numbered line only starts a list when another
// numbered line follows it. A lone numbered line is far more often a date or a
// version than a list of one, and treating it as prose costs only the marker's
// indentation while rendering exactly what the author typed. Deciding this by
// LOOKAHEAD rather than by consuming and rewinding also means the block loop
// always advances, so there is no shape of input it can spin on.
const ORDERED = /^\s{0,3}([1-9]\d{0,2})[.)]\s+(.*)$/;

/** A numbered line only opens a list when another numbered line follows it. */
function opensOrderedList(lines: string[], at: number): boolean {
  return ORDERED.test(lines[at] ?? "") && ORDERED.test(lines[at + 1] ?? "");
}

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
      i += 1;
      // Runs to the closing fence, or to the end of the message. An unclosed
      // fence still renders as code: the author asked for a block, and the rest
      // of what they wrote is what they put in it. Nothing needs to remember
      // WHICH of the two happened, so nothing does.
      while (i < lines.length) {
        const candidate = FENCE.exec(lines[i]);
        if (candidate && candidate[1][0] === marker && candidate[2] === "") {
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({
        kind: "code",
        text: body.join("\n"),
        lang: fence[2] === "" ? null : fence[2],
      });
      continue;
    }

    const bulletMatch = BULLET.exec(line);
    const orderedMatch = bulletMatch ? null : ORDERED.exec(line);
    const ordered = orderedMatch !== null && opensOrderedList(lines, i);
    if (bulletMatch || ordered) {
      const start = ordered && orderedMatch ? Number(orderedMatch[1]) : 1;
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
      // The FIRST line is always taken. It reaches here only because the reader
      // above declined it (a lone numbered line that is really a date), and
      // breaking on it would leave `i` where it was.
      //
      // A later numbered line breaks the paragraph only when it actually opens
      // a list. Otherwise `09. 30. 스탠드업` followed by ordinary prose would
      // split into two blocks with a gap between them, which is not what an
      // author who typed two consecutive lines asked for.
      if (
        paragraph.length > 0 &&
        (current.trim() === "" ||
          FENCE.test(current) ||
          BULLET.test(current) ||
          opensOrderedList(lines, i))
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
  return !/[`*_[\]]|^\s{0,3}([1-9]\d{0,2}[.)]|[-*+])\s|https?:\/\//m.test(source);
}
