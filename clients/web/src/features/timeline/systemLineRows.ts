import type { TimelineItem } from "@momo/core/features/timeline/model";
import { isRunCancelledNotice } from "@momo/core/features/timeline/runCancelNotice";
import type { Message } from "@momo/core/lib/api";

// =============================================================================
// 웹 대화가 **시스템 줄로 그리는 행**의 판정과 그 둘레의 묶음 규칙 (#5079, 폰 #5067의 짝).
//
// 판정은 코어(`isRunCancelledNotice`)가 든다 — 서버 표식(`type: system` · `props.kind`)을 읽는 일이라 폰과 웹이
// 같은 함수를 쓴다. 이 파일은 웹이 그 위에 얹는 두 가지만 든다: 줄로 그릴 **말이 있는가**, 그리고 **다음 행의 묶음**.
// =============================================================================

/**
 * 말풍선 대신 가운데의 시스템 줄(`SystemLine`)로 그릴 행인가. 서버가 문장을 안 줬으면(본문 없음·지워진 행) 줄로 그릴 말이
 * 없다 — 그때는 숨기지 않고 일반 행으로 남는다: 조용히 사라지는 서버 행보다 못생긴 행이 낫다.
 */
export function isSystemLineMessage(
  message: Pick<Message, "type" | "props" | "body">
): boolean {
  return isRunCancelledNotice(message) && (message.body ?? "").trim() !== "";
}

/**
 * 시스템 줄 **바로 다음 행은 새 묶음으로 시작한다**.
 *
 * 줄의 작성자는 멈춘 사람이라서, 코어의 저자 묶음 판정은 그 줄을 「그 사람의 직전 글」로 본다. 멈춘 사람이 곧바로(5분 안에)
 * 새 글을 쓰면 그 글이 이어지는 행이 되어 이름 머리(아바타·이름)가 걷히는데, 위에는 가운데의 시스템 줄이 있다 — 누구의
 * 글인지 읽을 근거가 없는 행이 된다(코어 `buildTimelineItems`의 구분선 규칙이 막으려던 같은 일). 중단 줄은 구분선처럼
 * 묶음을 끊는다. 대기 행(`pending`)도 같다: 확정 전후로 이름 머리가 깜빡이지 않도록 같은 규칙을 받는다.
 *
 * 코어 `buildTimelineItems`를 고치지 않는 이유: 그 스트림은 폰 대화와 읽음 계산(`readState`)도 쓰고, 이 줄을 시스템 줄로
 * 그릴지는 표면이 정하는 일이라 묶음 규칙도 표면 쪽에 둔다. 날짜·안 읽음·복구 구분선은 이미 스스로 다음 행의 묶음을
 * 끊으므로 여기서 건드리지 않는다. 바꿀 것이 없으면 입력 배열을 그대로 돌려준다(호출자의 memo 를 지킨다).
 *
 * 제네릭인 이유: 목록은 삭제 접기(`foldDeletedRuns`)가 얹은 필드를 든 채로 이 규칙을 받는다. 행을 새 객체로 바꿀 때 그 필드를
 * 잃지 않는다(펼쳐서 `startsGroup` 만 덮는다).
 */
export function startGroupAfterSystemLine<T extends TimelineItem>(items: T[]): T[] {
  let afterSystemLine = false;
  let changed = false;
  const next = items.map((item): T => {
    if (item.kind !== "message" && item.kind !== "pending") return item;
    const needsStart = afterSystemLine && !item.startsGroup;
    afterSystemLine =
      item.kind === "message" && isSystemLineMessage(item.message);
    if (!needsStart) return item;
    changed = true;
    return { ...item, startsGroup: true };
  });
  return changed ? next : items;
}
