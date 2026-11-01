import { describe, expect, it } from "vitest";
import { UNFURL_MAX_CARDS } from "./unfurl";
import {
  UNFURL_PREVIEW_FAILED_MEMORY_MS,
  UNFURL_PREVIEW_OK_MEMORY_MS,
  UNFURL_PREVIEW_URL_MAX_BYTES,
  draftPreviewLinks,
  failedPreviewFor,
  unfurlPreviewMemoryMs,
} from "./unfurlDraft";

// =============================================================================
// 입력칸이 「이 글이 보내지면 서버가 카드로 만들 주소」를 서버와 같은 규칙으로 고르는가
// (ADR-0170 증보 2026-11-01 D22). 규칙이 갈라지면 미리보기에는 보이는데 보낸 뒤에는 카드가
// 안 생긴다. 그래서 서버의 시험(`momo-unfurl`의 `extract.rs`·`normalize.rs`)을 **같은 입력으로**
// 다시 돌리고, 서버 함수가 단계마다 하는 일을 한 줄씩 더 붙잡는다.
// =============================================================================

describe("draft preview links follow the server's extraction", () => {
  it("replays the four server extraction tests with the same input", () => {
    // keeps_three_and_drops_the_fourth
    const four =
      "a https://one.example/a b https://two.example/b c https://three.example/c d https://four.example/d";
    const kept = draftPreviewLinks(four);
    expect(kept).toHaveLength(UNFURL_MAX_CARDS);
    expect(kept.some((url) => url.includes("four"))).toBe(false);
    expect(kept).toEqual([
      "https://one.example/a",
      "https://two.example/b",
      "https://three.example/c",
    ]);

    // skips_fenced_and_inline_code
    expect(
      draftPreviewLinks(
        "see ```\nhttps://secret.example/in-fence\n``` and `https://secret.example/inline` plus https://public.example/ok"
      )
    ).toEqual(["https://public.example/ok"]);

    // skips_bare_emails
    const mail = draftPreviewLinks("write me at person@company.example or https://company.example/about");
    expect(mail).toEqual(["https://company.example/about"]);

    // strips_trailing_punctuation_and_dedupes
    expect(
      draftPreviewLinks("link https://Example.COM/Path. and again https://example.com/Path")
    ).toEqual(["https://example.com/Path"]);
  });

  it("shapes the address as the server's normalizer does", () => {
    const shaped: Array<[string, string]> = [
      // normalize.rs: lowercases_host_and_drops_fragment_and_default_port
      ["HTTPS://Example.COM:443/a/b#frag", "https://example.com/a/b"],
      ["https://example.com/", "https://example.com/"],
      ["https://example.com/path/", "https://example.com/path"],
      // keeps_query_string
      ["https://example.com/a?x=1&y=2", "https://example.com/a?x=1&y=2"],
      // a bare host gets its path, a trailing slash before the query goes, a query on a bare host
      ["https://example.com", "https://example.com/"],
      ["https://example.com/a/?x=1", "https://example.com/a?x=1"],
      ["https://example.com?x=1", "https://example.com/?x=1"],
      // only the default port of the scheme is dropped
      ["http://example.com:80/x", "http://example.com/x"],
      ["https://example.com:80/x", "https://example.com:80/x"],
      ["http://example.com:8080/x", "http://example.com:8080/x"],
      // the scheme is case-insensitive, the path is not touched
      ["HTTP://A.EXAMPLE/Mixed/Case", "http://a.example/Mixed/Case"],
    ];
    for (const [typed, normalized] of shaped) {
      expect(draftPreviewLinks(`see ${typed} now`), typed).toEqual([normalized]);
    }
    // The fragment never leaves the draft: two links that differ only by it are one link.
    expect(draftPreviewLinks("https://a.example/x#one https://a.example/x#two")).toEqual([
      "https://a.example/x",
    ]);
  });

  it("refuses what the server's parser refuses, so no preview is asked for a link that gets no card", () => {
    const refused = [
      "https://user:secret@example.com/path", // credentials are refused, not stripped
      "https://user@example.com/path", // with no password the port rule cannot catch it, the `@` rule does
      "https://example.com:99999/x", // not a port
      "https://example.com:abc/x",
      "https://example.com:/x", // an empty port
      "https:///only-a-path",
      "https://",
      "ftp://example.com/a",
      "mailto:a@example.com",
    ];
    for (const typed of refused) {
      expect(draftPreviewLinks(`see ${typed} now`), typed).toEqual([]);
    }
    // The 2048-byte bound counts UTF-8 bytes, after the fragment is dropped.
    const stem = "https://a.example/";
    const atBound = stem + "a".repeat(UNFURL_PREVIEW_URL_MAX_BYTES - stem.length);
    expect(draftPreviewLinks(atBound)).toEqual([atBound]);
    expect(draftPreviewLinks(`${atBound}a`)).toEqual([]);
    expect(draftPreviewLinks(`${atBound}#${"x".repeat(5000)}`)).toEqual([atBound]);
    // A Hangul syllable is three bytes: one fewer ASCII letter makes room for exactly one.
    const hangul = stem + "a".repeat(UNFURL_PREVIEW_URL_MAX_BYTES - stem.length - 3) + "가";
    expect(draftPreviewLinks(hangul)).toEqual([hangul]);
    expect(draftPreviewLinks(`${hangul}가`)).toEqual([]);
  });

  it("cuts the link where the server does: delimiters, unclosed code and the whitespace set", () => {
    // Delimiters and trailing punctuation the server trims.
    expect(draftPreviewLinks("<https://a.example/x>")).toEqual(["https://a.example/x"]);
    expect(draftPreviewLinks("(see https://a.example/x), then")).toEqual(["https://a.example/x"]);
    expect(draftPreviewLinks("[doc](https://a.example/x)")).toEqual(["https://a.example/x"]);
    expect(draftPreviewLinks("\"https://a.example/x\" 'https://b.example/y'")).toEqual([
      "https://a.example/x",
      "https://b.example/y",
    ]);
    // Nothing separates a link from what follows it without a space: it is part of the address.
    expect(draftPreviewLinks("https://a.example/x가")).toEqual(["https://a.example/x가"]);
    // An unclosed fence only loses its opening mark; an unclosed backtick eats the rest.
    expect(draftPreviewLinks("```\nhttps://a.example/x")).toEqual(["https://a.example/x"]);
    expect(draftPreviewLinks("see `https://a.example/x")).toEqual([]);
    expect(draftPreviewLinks("`one` https://a.example/x `two`")).toEqual(["https://a.example/x"]);
    // The ideographic space and the no-break space end a link (Rust's White_Space), the BOM does not.
    const ideographic = String.fromCharCode(0x3000);
    const noBreak = String.fromCharCode(0xa0);
    const bom = String.fromCharCode(0xfeff);
    expect(
      draftPreviewLinks(`https://a.example/x${ideographic}https://b.example/y${noBreak}https://c.example/z`)
    ).toEqual(["https://a.example/x", "https://b.example/y", "https://c.example/z"]);
    expect(draftPreviewLinks(`https://a.example/x${bom}tail`)).toHaveLength(1);
    expect(draftPreviewLinks("no link here, just words")).toEqual([]);
    expect(draftPreviewLinks("")).toEqual([]);
  });
});

describe("what a remembered answer is worth", () => {
  it("keeps a card longer than a failure, and both shorter than the server does", () => {
    const failed = failedPreviewFor("https://a.example/x");
    expect(failed).toEqual({ status: "failed", url: "https://a.example/x" });
    expect(unfurlPreviewMemoryMs(failed)).toBe(UNFURL_PREVIEW_FAILED_MEMORY_MS);
    expect(unfurlPreviewMemoryMs({ id: "p-1", url: "https://a.example/x", status: "ok" })).toBe(
      UNFURL_PREVIEW_OK_MEMORY_MS
    );
    // ADR-0170 D18: the server keeps `ok` 30 minutes and `failed` 2. A preview id dies with its entry.
    expect(UNFURL_PREVIEW_OK_MEMORY_MS).toBeLessThan(30 * 60 * 1000);
    expect(UNFURL_PREVIEW_FAILED_MEMORY_MS).toBeLessThanOrEqual(2 * 60 * 1000);
    expect(UNFURL_PREVIEW_FAILED_MEMORY_MS).toBeLessThan(UNFURL_PREVIEW_OK_MEMORY_MS);
  });
});
