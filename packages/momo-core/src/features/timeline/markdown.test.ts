import { describe, expect, it } from "vitest";
import {
  isPlainText,
  parseInline,
  parseMarkdown,
  safeHref,
  type Inline,
} from "./markdown";

function text(value: string): Inline {
  return { kind: "text", text: value };
}

describe("safeHref", () => {
  it("keeps the three schemes a message body may link to", () => {
    expect(safeHref("https://momo.example/docs")).toBe(
      "https://momo.example/docs"
    );
    expect(safeHref("http://127.0.0.1:28000/health")).toBe(
      "http://127.0.0.1:28000/health"
    );
    expect(safeHref("mailto:ops@momo.example")).toBe("mailto:ops@momo.example");
  });

  // The one injection channel a React renderer still has. These are the
  // payloads a hostile message body would actually carry.
  it("refuses every scheme that can execute or embed", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("  javascript:alert(1)  ")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("vbscript:msgbox(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
  });

  it("refuses a scheme split by a control character", () => {
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("java script:alert(1)")).toBeNull();
  });

  it("refuses a relative href: a message body has no base to resolve against", () => {
    expect(safeHref("/settings")).toBeNull();
    expect(safeHref("#/c/019f")).toBeNull();
    expect(safeHref("")).toBeNull();
  });
});

describe("parseInline", () => {
  it("reads mention tokens with authored bytes and a case-folded handle", () => {
    expect(parseInline("@Hermes와 @kim-intern 에게")).toEqual([
      { kind: "mention", handle: "hermes", raw: "@Hermes" },
      text("와 "),
      { kind: "mention", handle: "kim-intern", raw: "@kim-intern" },
      text(" 에게"),
    ]);
    expect(parseInline("**@Hermes 확인**")).toEqual([
      {
        kind: "strong",
        children: [
          { kind: "mention", handle: "hermes", raw: "@Hermes" },
          text(" 확인"),
        ],
      },
    ]);
  });

  it("keeps unmatched at-sign forms as literal text", () => {
    for (const body of [
      "person@example.com",
      "앞(@hermes)뒤",
      "@",
      "@김인턴",
      "문장@hermes",
    ]) {
      expect(parseInline(body), body).toEqual([text(body)]);
    }
  });

  it("keeps mention-looking text literal inside code", () => {
    expect(parseInline("`@hermes` @hermes")).toEqual([
      { kind: "code", text: "@hermes" },
      text(" "),
      { kind: "mention", handle: "hermes", raw: "@hermes" },
    ]);
    expect(parseMarkdown("```\n@hermes\n```")).toEqual([
      { kind: "code", text: "@hermes", lang: null },
    ]);
  });

  it("reads bold, italic and code", () => {
    expect(parseInline("**굵게** 그리고 *soon* 그리고 `코드`")).toEqual([
      { kind: "strong", children: [text("굵게")] },
      text(" 그리고 "),
      { kind: "em", children: [text("soon")] },
      text(" 그리고 "),
      { kind: "code", text: "코드" },
    ]);
  });

  // Italic on a run with no Latin renders pixel-identically to plain text (the
  // system Korean face has no italic and we do not let the browser fake one), so
  // consuming the asterisks would DELETE the author's emphasis instead of
  // restyling it. Bold is exempt: weight is real on every face.
  it("leaves italic markers literal when the run has no Latin to slant", () => {
    expect(parseInline("실패하면 *즉시* 되돌립니다")).toEqual([
      text("실패하면 *즉시* 되돌립니다"),
    ]);
    expect(parseInline("*v2 배포*")).toEqual([
      { kind: "em", children: [text("v2 배포")] },
    ]);
    expect(parseInline("**즉시** 되돌립니다")).toEqual([
      { kind: "strong", children: [text("즉시")] },
      text(" 되돌립니다"),
    ]);
  });

  // The reported symptom: an agent answers in markdown and the channel shows
  // the asterisks. Bold inside a Korean sentence has no ASCII word boundary to
  // lean on, so this is the case that has to work.
  it("reads bold that is glued to Korean text", () => {
    expect(parseInline("결론은 **실패**입니다")).toEqual([
      text("결론은 "),
      { kind: "strong", children: [text("실패")] },
      text("입니다"),
    ]);
  });

  it("leaves an unclosed or empty run as literal text", () => {
    expect(parseInline("2 ** 3 = 8")).toEqual([text("2 ** 3 = 8")]);
    expect(parseInline("**미완성")).toEqual([text("**미완성")]);
    expect(parseInline("`열린 코드")).toEqual([text("`열린 코드")]);
  });

  it("does not turn an identifier's underscores into emphasis", () => {
    expect(parseInline("run_id_field")).toEqual([text("run_id_field")]);
    expect(parseInline("__init__ 을 봅니다")).toEqual([
      { kind: "strong", children: [text("init")] },
      text(" 을 봅니다"),
    ]);
  });

  it("keeps markup literal inside a code span", () => {
    expect(parseInline("`**not bold**`")).toEqual([
      { kind: "code", text: "**not bold**" },
    ]);
  });

  it("reads a markdown link and a bare url", () => {
    expect(parseInline("[문서](https://momo.example/a)를 보세요")).toEqual([
      {
        kind: "link",
        href: "https://momo.example/a",
        children: [text("문서")],
      },
      text("를 보세요"),
    ]);
    expect(parseInline("https://momo.example/a 를 보세요")).toEqual([
      {
        kind: "link",
        href: "https://momo.example/a",
        children: [text("https://momo.example/a")],
      },
      text(" 를 보세요"),
    ]);
  });

  it("keeps a link whose target is unsafe as plain text", () => {
    expect(parseInline("[클릭](javascript:alert(1))")).toEqual([
      text("[클릭](javascript:alert(1))"),
    ]);
  });

  // Korean glues its particles onto the preceding word with no space, so a
  // whitespace-delimited URL scan puts 에/에서/를 inside the href.
  //
  // The fix cannot be "stop at the first non-ASCII character" on its own: the
  // prefix is also a valid URL, so a Korean PATH would have linkified to a
  // working control that opens a different page. Both shapes end as literal
  // text, which is the whole file's failure mode.
  it("leaves a url that runs into Korean as literal text", () => {
    for (const body of [
      "https://momo.example/run/9f2에 로그가 있습니다",
      "https://ko.wikipedia.org/wiki/모모",
      "https://momo.notion.site/배포-체크리스트-abc123",
      "https://github.com/momo/repo/blob/main/문서.md",
      "https://동아리.한국/공지",
    ]) {
      expect(parseInline(body), body).toEqual([text(body)]);
    }
  });

  it("still links a url that ends where the sentence resumes", () => {
    expect(parseInline("https://momo.example/run/9f2 에 로그가")).toEqual([
      {
        kind: "link",
        href: "https://momo.example/run/9f2",
        children: [text("https://momo.example/run/9f2")],
      },
      text(" 에 로그가"),
    ]);
    expect(parseInline("(https://momo.example/a)")).toEqual([
      text("("),
      {
        kind: "link",
        href: "https://momo.example/a",
        children: [text("https://momo.example/a")],
      },
      text(")"),
    ]);
  });

  it("drops trailing sentence punctuation from a bare url", () => {
    expect(parseInline("https://momo.example/a.")).toEqual([
      {
        kind: "link",
        href: "https://momo.example/a",
        children: [text("https://momo.example/a")],
      },
      text("."),
    ]);
  });

  it("nests emphasis inside a link label and bold inside italic", () => {
    expect(parseInline("[**중요**](https://momo.example)")).toEqual([
      {
        kind: "link",
        href: "https://momo.example/",
        children: [{ kind: "strong", children: [text("중요")] }],
      },
    ]);
  });

  // The rewind path (a lone numbered line handed back to the paragraph reader)
  // is the one place this parser can fail to make progress. 3375 three-line
  // combinations of every block starter were run against it with no hang and no
  // line lost or duplicated; these are the shapes that exercise the rewind.
  it("makes progress through consecutive lines that are not lists", () => {
    // Consecutive prose lines stay ONE paragraph, marker-looking or not: the
    // numbered line only breaks the block when it really opens a list.
    expect(parseMarkdown("09. 30. 스탠드업\n장소는 그대로입니다\n가")).toEqual([
      {
        kind: "paragraph",
        lines: [
          [text("09. 30. 스탠드업")],
          [text("장소는 그대로입니다")],
          [text("가")],
        ],
      },
    ]);
    expect(parseMarkdown("1. 하나\n- 둘")).toEqual([
      { kind: "paragraph", lines: [[text("1. 하나")]] },
      { kind: "list", ordered: false, start: 1, items: [[text("둘")]] },
    ]);
  });

  it("terminates on a pathological run of delimiters", () => {
    const out = parseInline("*".repeat(200));
    expect(Array.isArray(out)).toBe(true);
  });
});

describe("parseMarkdown", () => {
  it("keeps authored line breaks inside one paragraph", () => {
    expect(parseMarkdown("첫 줄\n둘째 줄")).toEqual([
      { kind: "paragraph", lines: [[text("첫 줄")], [text("둘째 줄")]] },
    ]);
  });

  it("reads a fenced code block with its language", () => {
    expect(parseMarkdown("```rust\nlet a = 1;\n```")).toEqual([
      { kind: "code", text: "let a = 1;", lang: "rust" },
    ]);
  });

  it("renders an unclosed fence as code rather than swallowing it", () => {
    expect(parseMarkdown("```\nhalf a block")).toEqual([
      { kind: "code", text: "half a block", lang: null },
    ]);
  });

  it("keeps markup literal inside a fence", () => {
    expect(parseMarkdown("```\n**not bold**\n```")).toEqual([
      { kind: "code", text: "**not bold**", lang: null },
    ]);
  });

  it("reads bullet and ordered lists", () => {
    // A bullet list of one is still a list: `-` at the start of a line has no
    // second life as a date the way a number does.
    expect(parseMarkdown("- 하나")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [[text("하나")]] },
    ]);
    expect(parseMarkdown("- 하나\n- 둘")).toEqual([
      { kind: "list", ordered: false, start: 1, items: [[text("하나")], [text("둘")]] },
    ]);
    expect(parseMarkdown("1. 하나\n2. 둘")).toEqual([
      { kind: "list", ordered: true, start: 1, items: [[text("하나")], [text("둘")]] },
    ]);
  });

  // A number the author typed is content. Renumbering an agent's quotation of
  // steps 3 and 4 into 1 and 2 is the timeline telling a reader something the
  // author did not say.
  it("keeps the number the author started at", () => {
    expect(parseMarkdown("3. 세 번째 단계\n4. 네 번째 단계")).toEqual([
      {
        kind: "list",
        ordered: true,
        start: 3,
        items: [[text("세 번째 단계")], [text("네 번째 단계")]],
      },
    ]);
  });

  // `2026. 07. 30.` is how a Korean date is written, and it used to become a
  // one item ordered list whose marker ate the year. Four guards hold this
  // down: the digit bound, the no-leading-zero rule, the "another numbered line
  // must follow" rule, and the date-tail rule.
  it("does not read a Korean date as an ordered list", () => {
    for (const body of [
      "2026. 07. 30. 배포 예정",
      "09. 30. 스탠드업",
      "12. 25. 크리스마스 휴무",
      "1. 혼자 있는 번호는 목록이 아니다",
    ]) {
      expect(parseMarkdown(body), body).toEqual([
        { kind: "paragraph", lines: [[text(body)]] },
      ]);
    }
    // `isPlainText` is the fast path, not a verdict: it only decides whether the
    // parser runs at all, and both routes render the same paragraph. It answers
    // true where the marker itself cannot match, and hands the ambiguous ones to
    // the parser, which is the thing that actually knows.
    expect(isPlainText("2026. 07. 30. 배포 예정")).toBe(true);
    expect(isPlainText("09. 30. 스탠드업")).toBe(true);
  });

  // Two date lines in a row satisfied "a numbered line follows a numbered line",
  // became an <ol start=12>, and the browser renumbered the second one: the
  // author wrote `12. 31. 종무식` and the reader saw `13. 31. 종무식`. Inventing a
  // date is the same harm as renumbering a runbook.
  it("does not read consecutive dates as an ordered list", () => {
    expect(parseMarkdown("12. 25. 크리스마스 휴무\n12. 31. 종무식")).toEqual([
      {
        kind: "paragraph",
        lines: [[text("12. 25. 크리스마스 휴무")], [text("12. 31. 종무식")]],
      },
    ]);
    expect(parseMarkdown("8. 1. 회의\n8. 5. 데모")).toEqual([
      { kind: "paragraph", lines: [[text("8. 1. 회의")], [text("8. 5. 데모")]] },
    ]);
  });

  // …and a date sitting on top of a real list must not be absorbed into it and
  // renumbered there, which would also renumber the genuine items below it.
  it("does not absorb a date line into the list beneath it", () => {
    expect(parseMarkdown("12. 25. 크리스마스 휴무\n1. 백업\n2. 배포")).toEqual([
      { kind: "paragraph", lines: [[text("12. 25. 크리스마스 휴무")]] },
      { kind: "list", ordered: true, start: 1, items: [[text("백업")], [text("배포")]] },
    ]);
  });

  it("separates a list from the prose around it", () => {
    expect(parseMarkdown("확인할 것:\n- 로그\n\n끝")).toEqual([
      { kind: "paragraph", lines: [[text("확인할 것:")]] },
      { kind: "list", ordered: false, start: 1, items: [[text("로그")]] },
      { kind: "paragraph", lines: [[text("끝")]] },
    ]);
  });

  it("does not read a subtraction as a bullet", () => {
    expect(parseMarkdown("3-1 = 2")).toEqual([
      { kind: "paragraph", lines: [[text("3-1 = 2")]] },
    ]);
  });
});

describe("isPlainText", () => {
  it("passes an ordinary sentence and stops at any markup", () => {
    expect(isPlainText("배포 끝났습니다. 로그 확인 부탁해요.")).toBe(true);
    expect(isPlainText("person@example.com 과 @김인턴")).toBe(true);
    expect(isPlainText("@hermes 확인 부탁해요.")).toBe(false);
    expect(isPlainText("**굵게**")).toBe(false);
    expect(isPlainText("`코드`")).toBe(false);
    expect(isPlainText("- 항목")).toBe(false);
    expect(isPlainText("1. 항목")).toBe(false);
    expect(isPlainText("https://momo.example")).toBe(false);
  });
});
