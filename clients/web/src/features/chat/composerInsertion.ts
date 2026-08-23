export interface ComposerSelection {
  start: number;
  end: number;
}

export interface ComposerInsertion {
  value: string;
  caret: number;
}

/**
 * 선택 영역을 한 문자열로 바꾸고, 삽입한 문자열 바로 뒤의 캐럿을 돌려준다.
 *
 * 브라우저의 selectionStart/End와 String.length는 둘 다 UTF-16 code unit을 쓰므로
 * 이모지가 surrogate pair여도 별도 글자 수 변환을 하지 않는 것이 정확하다. 범위는
 * 방어적으로 본문 안으로 가두고, 역전된 선택은 정방향으로 고친다.
 */
export function insertAtComposerSelection(
  value: string,
  selection: ComposerSelection,
  insertion: string
): ComposerInsertion {
  const boundedStart = Math.min(Math.max(selection.start, 0), value.length);
  const boundedEnd = Math.min(Math.max(selection.end, 0), value.length);
  const start = Math.min(boundedStart, boundedEnd);
  const end = Math.max(boundedStart, boundedEnd);
  return {
    value: `${value.slice(0, start)}${insertion}${value.slice(end)}`,
    caret: start + insertion.length,
  };
}
