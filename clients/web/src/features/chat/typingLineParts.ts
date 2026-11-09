import type { LocaleService } from "@momo/core/i18n";

// 「작성 중」 줄의 조각 (#5567). 사전 문장(`timeline.typing.*`)을 이름(거기 붙은 조사째) | 서술어로 나눈다 — 넘칠 때 잘리는
// 것은 앞쪽(이름)이고 서술어는 안 잘린다. 왜 이렇게 나누는지는 `TypingLine.tsx` 머리 주석에 있다.

/** 번역문에서 이름 자리를 찾는 표지(U+2063 INVISIBLE SEPARATOR, U+2064 INVISIBLE PLUS). 사람이 이름에 넣을 수 없는 글자다. */
const FIRST_MARK = "⁣";
const SECOND_MARK = "⁤";

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
