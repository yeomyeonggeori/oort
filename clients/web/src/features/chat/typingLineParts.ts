import type { LocaleService } from "@momo/core/i18n";

// 「작성 중」 줄의 조각 (#5567). 사전 문장(`timeline.typing.*`)을 이름(거기 붙은 조사째) | 서술어로 나눈다 — 넘칠 때 잘리는
// 것은 앞쪽(이름)이고 서술어는 안 잘린다. 왜 이렇게 나누는지는 `TypingLine.tsx` 머리 주석에 있다.

/**
 * 번역문에서 이름 자리를 찾는 표지(U+2063 INVISIBLE SEPARATOR, U+2064 INVISIBLE PLUS). 사람이 이름에 넣을 수 없는 글자다.
 * 이스케이프로 쓴다(#5582 R2-L1): 날 글자는 편집기·diff에서 빈 문자열로 보여, 누가 지우면 `indexOf`가 0을 돌려 조각이 조용히 틀어진다.
 */
const FIRST_MARK = "\u2063";
const SECOND_MARK = "\u2064";

/** 줄어드는 쪽의 한 조각. 이름이면 굵게 선다. */
export interface TypingLeadPiece {
  text: string;
  name: boolean;
}

export interface TypingLineParts {
  /** 줄어드는 쪽: 이름(들)과 그 사이 글, 마지막 이름에 빈칸 없이 붙은 글(「님이」)까지. 함께 잘린다. */
  lead: TypingLeadPiece[];
  /** 이름 없이 서는 서술어. 잘리지 않는다. */
  tail: string;
  /** 보조기술이 읽는 온전한 문장. 말줄임표가 없다. */
  label: string;
}

/**
 * 지금 치는 사람들의 표시 이름으로 줄의 조각을 만든다. 아무도 없으면 `null`.
 *
 * 한 사람은 그 이름, 둘은 두 이름 다(Slack·Discord와 폰 `typingVisualSegments`가 둘까지 부른다), 셋부터는 첫 이름 +
 * 「외 N명」이다(#5567 design-review M-2).
 */
export function typingLineParts(
  format: LocaleService["formatMessage"],
  names: readonly string[]
): TypingLineParts | null {
  const [first, second] = names;
  if (first === undefined) return null;
  const sentence = (a: string, b: string) =>
    names.length === 1
      ? format("timeline.typing.one", { name: a })
      : names.length === 2
        ? format("timeline.typing.two", { name: a, second: b })
        : format("timeline.typing.many", { name: a, count: names.length - 1 });
  const label = sentence(first, second ?? "").replace(/…$/u, "");
  const marked = sentence(FIRST_MARK, SECOND_MARK);
  const slots = [
    { at: marked.indexOf(FIRST_MARK), name: first },
    { at: marked.indexOf(SECOND_MARK), name: second ?? "" },
  ]
    .filter((slot) => slot.at >= 0)
    .sort((a, b) => a.at - b.at);
  const last = slots[slots.length - 1];
  if (last === undefined) {
    return { lead: [{ text: sentence(first, second ?? ""), name: false }], tail: "", label };
  }
  // 마지막 이름 뒤에 빈칸 없이 붙은 글(「님이」)까지가 앞부분이다. 영어는 붙은 글이 없어 「 are typing…」이 통째로 꼬리다.
  const afterLast = last.at + 1;
  const end = afterLast + (/^\S*/u.exec(marked.slice(afterLast))?.[0].length ?? 0);
  const lead: TypingLeadPiece[] = [];
  let cursor = 0;
  for (const slot of slots) {
    if (slot.at > cursor) lead.push({ text: marked.slice(cursor, slot.at), name: false });
    lead.push({ text: slot.name, name: true });
    cursor = slot.at + 1;
  }
  if (end > cursor) lead.push({ text: marked.slice(cursor, end), name: false });
  return { lead, tail: marked.slice(end), label };
}

/** 줄어드는 쪽의 칸 하나(#5582 R2-M1). 이름 칸은 넘치면 **자기 안에서** 말줄임되고, 이름 아닌 칸(사이 글)은 줄지 않는다. */
export interface TypingLeadCell {
  pieces: TypingLeadPiece[];
  name: boolean;
}

/**
 * 조각을 이름마다 한 칸으로 묶는다. 이름 칸 = 이름 + 거기 붙은(빈칸 없는) 글자(「님,」·「님이」)다.
 *
 * 붙은 글자가 이름과 같은 칸인 이유는 W-3이다: 조사는 이름에 붙는 의존 형태소라, 이름만 잘리고 조사가 남으면
 * 「윤가람 프로덕…님, 오민재님이」처럼 붙을 이름을 잃은 조사가 선다. 같은 칸이면 이름과 함께 잘려 「윤가람 프로덕… 오민재님이」가
 * 된다. 마지막 이름에 붙은 글자까지를 앞부분으로 보는 `typingLineParts`의 규칙과 같은 규칙을 이름마다 쓰는 것이다.
 */
export function typingLeadCells(lead: readonly TypingLeadPiece[]): TypingLeadCell[] {
  const cells: TypingLeadCell[] = [];
  for (const piece of lead) {
    if (piece.name) {
      cells.push({ pieces: [piece], name: true });
      continue;
    }
    let rest = piece.text;
    const previous = cells[cells.length - 1];
    if (previous?.name === true) {
      const attached = /^\S*/u.exec(rest)?.[0] ?? "";
      if (attached !== "") previous.pieces.push({ text: attached, name: false });
      rest = rest.slice(attached.length);
    }
    if (rest !== "") cells.push({ pieces: [{ text: rest, name: false }], name: false });
  }
  return cells;
}

/**
 * 입력창이 막혔을 때(기기 오프라인 · 서버에 닿지 못함) 같은 줄에 서는 문장을 문장 단위로 나눈다 (#5575 검수 H1).
 *
 * 줄은 한 줄 높이로 늘 잡아 둔 칸이라 좁은 폭에서 문장이 넘친다. 넘칠 때는 **문장을 통째로** 버리고 문장 안에서는 자르지 않는다(입력창
 * 자리표시와 같은 규칙, #1422): 각 문장이 줄바꿈 안 되는 한 덩어리로 서고, 들어가지 않는 문장은 숨은 둘째 줄로 내려간다. 조각마다 원문의
 * 빈칸을 그대로 지니므로 이어 붙이면 원문과 같다(보조기술 · `title`은 온전한 문장을 받는다). 문장 경계는 `Intl.Segmenter`가 언어별로 찾고,
 * 없는 환경에서는 문장 하나로 둔다.
 */
export function blockedLineSentences(text: string): string[] {
  const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
  if (Segmenter === undefined) return [text];
  const sentences = [...new Segmenter(undefined, { granularity: "sentence" }).segment(text)].map((part) => part.segment);
  return sentences.length > 0 ? sentences : [text];
}
