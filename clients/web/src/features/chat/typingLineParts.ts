import type { LocaleService } from "@momo/core/i18n";

// 「입력 중」 줄의 조각 (#5567). 사전 문장(`timeline.typing.*`)을 이름(거기 붙은 조사째) | 서술어로 나눈다 — 넘칠 때 잘리는
// 것은 앞쪽(이름)이고 서술어는 안 잘린다. 왜 이렇게 나누는지는 `TypingLine.tsx` 머리 주석에 있다.

/** 번역문에서 이름 자리를 찾는 표지(U+2063 INVISIBLE SEPARATOR). 사람이 이름에 넣을 수 없는 글자다. */
const NAME_MARK = "\u2063";

export interface TypingLineParts {
  /** 이름 앞 글. 한국어·영어 문장은 비어 있다. */
  before: string;
  /** 굵게 서는 첫 사람의 이름. 번역에 이름 자리가 없으면 빈 글이다. */
  name: string;
  /** 이름에 빈칸 없이 붙은 글(「님이」·「님」). 이름과 함께 잘린다. */
  attached: string;
  /** 이름 없이 서는 서술어. 잘리지 않는다. */
  tail: string;
  /** 보조기술이 읽는 온전한 문장. 말줄임표가 없다. */
  label: string;
}

/** 지금 치는 사람들의 표시 이름으로 줄의 조각을 만든다. 아무도 없으면 `null`. */
export function typingLineParts(
  format: LocaleService["formatMessage"],
  names: readonly string[]
): TypingLineParts | null {
  const first = names[0];
  if (first === undefined) return null;
  const others = names.length - 1;
  const sentence = (name: string) =>
    others === 0
      ? format("timeline.typing.one", { name })
      : format("timeline.typing.many", { name, count: others });
  const label = sentence(first).replace(/…$/u, "");
  const marked = sentence(NAME_MARK);
  const at = marked.indexOf(NAME_MARK);
  if (at < 0) {
    return { before: sentence(first), name: "", attached: "", tail: "", label };
  }
  const rest = marked.slice(at + NAME_MARK.length);
  const attached = /^\S*/u.exec(rest)?.[0] ?? "";
  return {
    before: marked.slice(0, at),
    name: first,
    attached,
    tail: rest.slice(attached.length),
    label,
  };
}
