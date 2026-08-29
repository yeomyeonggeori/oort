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

export interface ComposerFormatItemState {
  pressed: boolean;
  disabled: boolean;
  disabledReason: string | null;
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
export const COMPOSER_FORMAT_LINK_HREF = "링크주소";

/** 자리표시가 아직 안 바뀐 동안 힌트 줄에만 띄운다. 전송은 막지 않는다. */
export const COMPOSER_FORMAT_LINK_HINT = "링크 주소를 채워 보내세요";

export const COMPOSER_FORMAT_ITALIC_DISABLED_REASON =
  "기울임은 영문이나 숫자가 있는 선택에만 적용됩니다";

/**
 * 코어 파서와 같은 자 (`packages/momo-core/.../markdown.ts` `renderable`).
 * `run === 2`(굵게)이거나 라틴/숫자가 있는 기울임만 렌더한다.
 */
const ITALIC_RENDERABLE = /[A-Za-z0-9]/;

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
 * 선택 안쪽으로 접사를 밀어 넣을 구간. 앞뒤 공백은 남기고, 줄을 넘는 선택은
 * 줄 단위로 나눈다(빈 줄 제외). 코어는 닫는 접사 앞 공백을 거부하고 인라인을
 * 줄 단위로만 파싱한다.
 */
export function formatLineSegments(
  value: string,
  from: number,
  to: number
): Array<{ from: number; to: number }> {
  const segments: Array<{ from: number; to: number }> = [];
  let cursor = from;
  const inner = value.slice(from, to);
  const parts = inner.split("\n");
  for (let i = 0; i < parts.length; i += 1) {
    const line = parts[i] ?? "";
    let lineFrom = cursor;
    let lineTo = cursor + line.length;
    while (lineFrom < lineTo && /\s/.test(value[lineFrom] ?? "")) lineFrom += 1;
    while (lineTo > lineFrom && /\s/.test(value[lineTo - 1] ?? "")) lineTo -= 1;
    if (lineFrom < lineTo) segments.push({ from: lineFrom, to: lineTo });
    cursor += line.length;
    if (i < parts.length - 1) cursor += 1;
  }
  return segments;
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

function unwrapEdit(
  value: string,
  from: number,
  to: number,
  prefix: string,
  suffix: string
): { from: number; to: number; insert: string } | null {
  if (
    to - from > prefix.length + suffix.length &&
    isExactRun(value, from, prefix) &&
    isExactRun(value, to - suffix.length, suffix)
  ) {
    const inner = value.slice(from + prefix.length, to - suffix.length);
    if (inner.length > 0) {
      return { from, to, insert: inner };
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
    return {
      from: outerFrom,
      to: outerTo,
      insert: value.slice(from, to),
    };
  }
  return null;
}

type SegmentEdit = {
  from: number;
  to: number;
  insert: string;
  caretFrom: number;
  caretTo: number;
};

function applySegmentEdits(
  value: string,
  edits: SegmentEdit[],
  select: "span" | "first"
): ComposerFormatResult {
  let next = value;
  let offset = 0;
  let selStart = -1;
  let selEnd = -1;
  for (const edit of edits) {
    const from = edit.from + offset;
    const to = edit.to + offset;
    next = `${next.slice(0, from)}${edit.insert}${next.slice(to)}`;
    const caretStart = from + edit.caretFrom;
    const caretEnd = from + edit.caretTo;
    if (selStart < 0) {
      selStart = caretStart;
      selEnd = caretEnd;
    } else if (select === "span") {
      selEnd = caretEnd;
    }
    offset += edit.insert.length - (edit.to - edit.from);
  }
  return { value: next, start: selStart, end: selEnd };
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

function linkUnwrapEdit(
  value: string,
  from: number,
  to: number
): { from: number; to: number; insert: string } | null {
  const existing = findLinkWrap(value, from, to);
  if (!existing) return null;
  return {
    from: existing.wrapFrom,
    to: existing.wrapTo,
    insert: existing.label,
  };
}

function toggleLinkSegments(
  value: string,
  segments: Array<{ from: number; to: number }>
): ComposerFormatResult | null {
  const unwrapped = segments
    .map((segment) => linkUnwrapEdit(value, segment.from, segment.to))
    .filter((edit): edit is NonNullable<typeof edit> => edit !== null);
  if (unwrapped.length === segments.length) {
    return applySegmentEdits(
      value,
      unwrapped.map((edit) => ({
        from: edit.from,
        to: edit.to,
        insert: edit.insert,
        caretFrom: 0,
        caretTo: edit.insert.length,
      })),
      "span"
    );
  }
  const edits: SegmentEdit[] = [];
  for (const segment of segments) {
    if (linkUnwrapEdit(value, segment.from, segment.to)) continue;
    const selected = value.slice(segment.from, segment.to);
    const insertion = `[${selected}](${COMPOSER_FORMAT_LINK_HREF})`;
    const hrefStart = 1 + selected.length + 2;
    edits.push({
      from: segment.from,
      to: segment.to,
      insert: insertion,
      caretFrom: hrefStart,
      caretTo: hrefStart + COMPOSER_FORMAT_LINK_HREF.length,
    });
  }
  if (edits.length === 0) return null;
  return applySegmentEdits(value, edits, "first");
}

function isItalicRenderable(inner: string): boolean {
  // markdown.ts:249 `const renderable = run === 2 || /[A-Za-z0-9]/.test(inner)`
  // 기울임은 run === 1 이므로 라틴/숫자 검사와 같다.
  return ITALIC_RENDERABLE.test(inner);
}

function toggleAffixSegments(
  value: string,
  segments: Array<{ from: number; to: number }>,
  prefix: string,
  suffix: string,
  kind: Exclude<ComposerFormatKind, "link">
): ComposerFormatResult | null {
  const unwrapped = segments
    .map((segment) =>
      unwrapEdit(value, segment.from, segment.to, prefix, suffix)
    )
    .filter((edit): edit is NonNullable<typeof edit> => edit !== null);
  if (unwrapped.length === segments.length) {
    return applySegmentEdits(
      value,
      unwrapped.map((edit) => ({
        from: edit.from,
        to: edit.to,
        insert: edit.insert,
        caretFrom: 0,
        caretTo: edit.insert.length,
      })),
      "span"
    );
  }
  const edits: SegmentEdit[] = [];
  for (const segment of segments) {
    if (unwrapEdit(value, segment.from, segment.to, prefix, suffix)) continue;
    const inner = value.slice(segment.from, segment.to);
    if (kind === "italic" && !isItalicRenderable(inner)) continue;
    edits.push({
      from: segment.from,
      to: segment.to,
      insert: `${prefix}${inner}${suffix}`,
      caretFrom: prefix.length,
      caretTo: prefix.length + inner.length,
    });
  }
  if (edits.length === 0) return null;
  if (edits.length > 1) {
    for (const edit of edits) {
      edit.caretFrom = 0;
      edit.caretTo = edit.insert.length;
    }
  }
  return applySegmentEdits(value, edits, "span");
}

export function composerFormatHasPendingLink(value: string): boolean {
  return value.includes(`](${COMPOSER_FORMAT_LINK_HREF})`);
}

export function composerFormatItemState(
  value: string,
  selection: ComposerSelection,
  kind: ComposerFormatKind
): ComposerFormatItemState {
  const { from, to } = boundSelection(value, selection);
  const segments = formatLineSegments(value, from, to);
  if (segments.length === 0) {
    return { pressed: false, disabled: false, disabledReason: null };
  }
  if (kind === "link") {
    const pressed = segments.every(
      (segment) => findLinkWrap(value, segment.from, segment.to) !== null
    );
    return { pressed, disabled: false, disabledReason: null };
  }
  const { prefix, suffix } = AFFIX[kind];
  const pressed = segments.every(
    (segment) =>
      unwrapEdit(value, segment.from, segment.to, prefix, suffix) !== null
  );
  if (kind !== "italic") {
    return { pressed, disabled: false, disabledReason: null };
  }
  const canWrap = segments.some((segment) =>
    isItalicRenderable(value.slice(segment.from, segment.to))
  );
  const disabled = !pressed && !canWrap;
  return {
    pressed,
    disabled,
    disabledReason: disabled ? COMPOSER_FORMAT_ITALIC_DISABLED_REASON : null,
  };
}

/**
 * 선택 영역에 서식을 걸거나, 이미 감싸져 있으면 푼다. 빈 선택·공백만 선택은
 * 무동작(`null`). 적용 뒤 선택은 접사 안쪽(링크는 자리표시)을 가리킨다.
 */
export function toggleComposerFormat(
  value: string,
  selection: ComposerSelection,
  kind: ComposerFormatKind
): ComposerFormatResult | null {
  const { from, to } = boundSelection(value, selection);
  if (from === to) return null;
  if (value.slice(from, to).trim() === "") return null;
  const segments = formatLineSegments(value, from, to);
  if (segments.length === 0) return null;
  if (kind === "link") return toggleLinkSegments(value, segments);
  const { prefix, suffix } = AFFIX[kind];
  return toggleAffixSegments(value, segments, prefix, suffix, kind);
}
