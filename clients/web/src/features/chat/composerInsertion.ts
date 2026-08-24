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

/**
 * [@] 버튼은 새 멘션 모델을 만들지 않는다. 선택이 있으면 선택 끝으로 캐럿을
 * 접어서 원문을 보존하고, 그 캐럿 앞이 비공백이면 공백과 `@`를 함께 넣는다.
 * 이 버튼이 `mentionQueryAt`의 「줄 시작 또는 공백 뒤 @만 멘션」 계약을 만족시키므로
 * 평범하게 `@`를 타이핑한 open/caret 경로를 그대로 이어받을 수 있다.
 */
export function insertMentionTriggerAtComposerSelection(
  value: string,
  selection: ComposerSelection
): ComposerInsertion {
  const boundedStart = Math.min(Math.max(selection.start, 0), value.length);
  const boundedEnd = Math.min(Math.max(selection.end, 0), value.length);
  const caret = Math.max(boundedStart, boundedEnd);
  const insertion = caret > 0 && !/\s/.test(value[caret - 1]) ? " @" : "@";
  return insertAtComposerSelection(
    value,
    { start: caret, end: caret },
    insertion
  );
}
