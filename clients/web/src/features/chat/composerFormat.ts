import type { ComposerSelection } from "./composerInsertion";
import { mentionQueryAt } from "./MentionAutocomplete";

// =============================================================================
// 컴포저 선택 서식 (#1902). textarea 의 selectionStart/End 에 마크다운 접사를
// 넣고 빼는 순수 함수. TipTap 이 아니고, 렌더러가 실제로 소비하는 문법만 다룬다
// (`packages/momo-core` markdown: **bold**, *italic*, `code`, [text](url)).
// =============================================================================

export type ComposerFormatKind = "bold" | "italic" | "code" | "link";

export interface ComposerFormatResult {
  value: string;
  start: number;
  end: number;
}

const AFFIX: Record<
  Exclude<ComposerFormatKind, "link">,
  { prefix: string; suffix: string }
> = {
  bold: { prefix: "**", suffix: "**" },
  italic: { prefix: "*", suffix: "*" },
  code: { prefix: "`", suffix: "`" },
};

/** 링크 삽입 뒤 고를 자리. 렌더러의 href 가 아니라 사람이 덮어쓸 자리표시. */
export const COMPOSER_FORMAT_LINK_HREF = "url";

export function shouldShowComposerFormatTray({
  value,
  start,
  end,
  mentionVisible,
}: {
  value: string;
  start: number;
  end: number;
  mentionVisible: boolean;
}): boolean {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  if (from === to) return false;
  if (value.slice(from, to).trim() === "") return false;
  if (mentionVisible) return false;
  // @ 트리거 중이면 목록이 비어도 트레이를 올리지 않는다. 선택이 멘션 쿼리와
  // 겹치면 자동완성이 서식보다 앞선다.
  if (
    mentionQueryAt(value, from) !== null ||
    mentionQueryAt(value, to) !== null
  ) {
    return false;
  }
  return true;
}

function boundSelection(
  value: string,
  selection: ComposerSelection
): { from: number; to: number } {
  const a = Math.min(Math.max(selection.start, 0), value.length);
  const b = Math.min(Math.max(selection.end, 0), value.length);
  return { from: Math.min(a, b), to: Math.max(a, b) };
}

/**
 * `*` / `**` / `` ` `` 처럼 같은 글자의 런은 더 긴 런의 일부가 아니어야 한다.
 * `**hello**` 에 기울임을 걸면 바깥 `*` 한 겹을 해제하는 것이 아니라
 * `***hello***` 로 감싼다.
 */
function isExactRun(value: string, index: number, run: string): boolean {
  if (run.length === 0) return false;
  if (value.slice(index, index + run.length) !== run) return false;
  const mark = run[0];
  if (![...run].every((char) => char === mark)) return true;
  if (index > 0 && value[index - 1] === mark) return false;
  if (index + run.length < value.length && value[index + run.length] === mark) {
    return false;
  }
  return true;
}

function unwrapAffix(
  value: string,
  from: number,
  to: number,
  prefix: string,
  suffix: string
): ComposerFormatResult | null {
  if (
    to - from > prefix.length + suffix.length &&
    isExactRun(value, from, prefix) &&
    isExactRun(value, to - suffix.length, suffix)
  ) {
    const inner = value.slice(from + prefix.length, to - suffix.length);
    if (inner.length > 0) {
      return {
        value: `${value.slice(0, from)}${inner}${value.slice(to)}`,
        start: from,
        end: from + inner.length,
      };
    }
  }
  const outerFrom = from - prefix.length;
  const outerTo = to + suffix.length;
  if (
    outerFrom >= 0 &&
    outerTo <= value.length &&
    isExactRun(value, outerFrom, prefix) &&
    isExactRun(value, to, suffix)
  ) {
    const selected = value.slice(from, to);
    return {
      value: `${value.slice(0, outerFrom)}${selected}${value.slice(outerTo)}`,
      start: outerFrom,
      end: outerFrom + selected.length,
    };
  }
  return null;
}

function wrapAffix(
  value: string,
  from: number,
  to: number,
  prefix: string,
  suffix: string
): ComposerFormatResult {
  const selected = value.slice(from, to);
  return {
    value: `${value.slice(0, from)}${prefix}${selected}${suffix}${value.slice(to)}`,
    start: from + prefix.length,
    end: to + prefix.length,
  };
}

const LINK_WHOLE = /^\[([^\]\n]+)\]\(([^)\n]*)\)$/;

function findLinkWrap(
  value: string,
  from: number,
  to: number
): { wrapFrom: number; wrapTo: number; label: string } | null {
  const selected = value.slice(from, to);
  const whole = LINK_WHOLE.exec(selected);
  if (whole) {
    return { wrapFrom: from, wrapTo: to, label: whole[1] };
  }
  if (from > 0 && value[from - 1] === "[") {
    const close = /^\]\(([^)\n]*)\)/.exec(value.slice(to));
    if (
      close &&
      selected.length > 0 &&
      !selected.includes("]") &&
      !selected.includes("\n")
    ) {
      return {
        wrapFrom: from - 1,
        wrapTo: to + close[0].length,
        label: selected,
      };
    }
  }
  if (
    to < value.length &&
    value[to] === ")" &&
    from > 0 &&
    value[from - 1] === "(" &&
    from >= 2 &&
    value[from - 2] === "]"
  ) {
    const closeBracket = from - 2;
    const openBracket = value.lastIndexOf("[", closeBracket - 1);
    if (openBracket >= 0 && openBracket < closeBracket) {
      const label = value.slice(openBracket + 1, closeBracket);
      if (label.length > 0 && !label.includes("\n")) {
        return { wrapFrom: openBracket, wrapTo: to + 1, label };
      }
    }
  }
  return null;
}

function toggleLink(
  value: string,
  from: number,
  to: number
): ComposerFormatResult {
  const existing = findLinkWrap(value, from, to);
  if (existing) {
    return {
      value: `${value.slice(0, existing.wrapFrom)}${existing.label}${value.slice(existing.wrapTo)}`,
      start: existing.wrapFrom,
      end: existing.wrapFrom + existing.label.length,
    };
  }
  const selected = value.slice(from, to);
  const insertion = `[${selected}](${COMPOSER_FORMAT_LINK_HREF})`;
  const hrefStart = from + 1 + selected.length + 2;
  return {
    value: `${value.slice(0, from)}${insertion}${value.slice(to)}`,
    start: hrefStart,
    end: hrefStart + COMPOSER_FORMAT_LINK_HREF.length,
  };
}

/**
 * 선택 영역에 서식을 걸거나, 이미 감싸져 있으면 푼다. 빈 선택·공백만 선택은
 * 무동작(`null`). 적용 뒤 선택은 접사 안쪽(링크는 url 자리)을 가리킨다.
 */
export function toggleComposerFormat(
  value: string,
  selection: ComposerSelection,
  kind: ComposerFormatKind
): ComposerFormatResult | null {
  const { from, to } = boundSelection(value, selection);
  if (from === to) return null;
  if (value.slice(from, to).trim() === "") return null;
  if (kind === "link") return toggleLink(value, from, to);
  const { prefix, suffix } = AFFIX[kind];
  return (
    unwrapAffix(value, from, to, prefix, suffix) ??
    wrapAffix(value, from, to, prefix, suffix)
  );
}
