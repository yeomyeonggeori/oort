import type {TimelineStreamItem} from '@momo/core/features/timeline/model';

// =============================================================================
// 연달아 지워진 메시지를 한 줄로 접는다 (감사 M-1)
//
// 감사 캡처 `m-09`: 「삭제된 메시지」가 두 줄 연속으로 서 있다. 결함은 한 문장으로
// 적혀 있다 — *"지워진 것들이 지워지지 않은 것들만큼 자리를 차지한다."* 묘비는
// 메시지에 **대한** 서술이지 메시지가 아닌데, 다섯 개를 연달아 지우면 다섯 줄이
// 남는다.
//
// ## 왜 여기(폰 로컬)에 있는가 — 그리고 어디에 있어야 하는가
//
// **정본 자리는 코어다.** 같은 종류의 접기가 이미 거기 있다:
// `foldPausedNotices` + `buildTimelineItems` 가 연속된 「일시정지」 알림을 하나로
// 접고, 살아남은 행에 `pausedRepeat` 을 실어 준다. 이 파일은 그 함수의 삭제 판이고,
// 이름·모양·계약을 일부러 그대로 베꼈다(`suppressed` 없이 스트림에서 바로 접는
// 것만 다르다 — 여기서는 접을 대상이 이미 항목 배열이므로 한 번 도는 것으로 끝난다).
//
// 이 배치가 코어를 못 건드리는 이유는 설계가 아니라 **동시 작업**이다: 같은
// 사이클에 웹 워커가 `clients/web` + core 를 들고 돌고 있고, 패킷이 폰 워커의
// 전속 범위를 `clients/mobile/**` 로 못박았다. 그래서 폰 로컬로 우회하고 그 사실을
// 여기에 적어 둔다 — 다음 사람이 이것을 「폰만의 규칙」으로 읽지 않도록.
// **후속에서 코어로 올릴 때 웹이 같은 결함을 갖고 있는지 함께 본다.**
//
// ## 접기 규칙 (보수적으로)
//
// 접히는 것은 **한 저자 묶음 안에서 연달아 서 있는, 아무것도 더 말하지 않는
// 묘비**뿐이다. 셋 다 필요한 조건이다:
//
// 1. `startsGroup === false` — 묶음의 머리는 접지 않는다. 접으면 그 묶음의 작성자
//    줄이 사라지고, 살아남은 행이 **다른 사람의 묶음 밑으로** 끌려 들어간다.
//    이 조건 하나가 「누가 지웠는가」를 통째로 지킨다.
// 2. 답글 롤업이 없다 — 지워진 루트에도 답글은 남는다. 「답글 3개」는 방으로 가는
//    **문**이고, 문을 접어 없애는 것은 자리를 아끼는 것이 아니라 길을 없애는 것이다.
// 3. 반응이 없다 — 지워진 메시지에 달려 있던 반응은 사람들이 남긴 사실이다.
//
// 모르면 접지 않는 쪽이 안전한 방향이다. 접기는 되돌릴 수 있지만, 접혀서 안 보이게
// 된 문과 반응은 사람이 없다는 것조차 모른다.
//
// 그리고 **접기는 이 스트림에서만 일어난다.** 메시지 배열도, seq 도, 커서도, 읽음
// 위치도 접기를 모른다 — 코어의 알림 접기가 지키는 규율과 같다.
// =============================================================================

/**
 * 접힌 뒤에도 남는 행이 자기를 포함해 몇 개를 대신하는지.
 *
 * 코어 `TimelineItem` 을 확장하지 않고 **폰 스트림의 항목 타입**으로 따로 세운다:
 * 코어 타입에 필드를 더하는 것은 가산 변경이라도 계약 변경이고, 그 결정은 이
 * 배치의 것이 아니다(위 머리말).
 */
export type FoldedTimelineItem = TimelineStreamItem & {
  /** 이 묘비가 대신하는 삭제 메시지 수 (2 이상일 때만 있다). */
  deletedRepeat?: number;
};

/** 접기가 판정 대상으로 삼는 항목 — 메시지 행. */
export type MessageStreamItem = Extract<TimelineStreamItem, {kind: 'message'}>;

/** 이 묘비가 접혀도 잃는 것이 없는가 — 규칙 2·3. */
export interface DeletedRowFacts {
  /** 이 메시지 밑에 답글이 있는가. */
  hasRollup: boolean;
  /** 이 메시지에 반응이 달려 있는가. */
  hasReactions: boolean;
}

/**
 * 연속된 묘비를 접는다. 순수 함수이고 입력 배열은 그대로 둔다.
 *
 * @param items 코어가 만든 스트림.
 * @param factsFor 행 하나가 접혀도 되는지 판정할 재료. 목록만이 답할 수 있으므로
 *   (롤업은 스레드 맥락에서, 반응은 반응 표에서 온다) 주입으로 받는다.
 */
export function foldDeletedRuns(
  items: readonly TimelineStreamItem[],
  factsFor: (item: MessageStreamItem) => DeletedRowFacts,
): FoldedTimelineItem[] {
  const out: FoldedTimelineItem[] = [];
  /** 지금 열려 있는 묘비 묶음의 **출력 배열 안** 위치. 없으면 -1. */
  let runAt = -1;

  for (const item of items) {
    if (item.kind !== 'message' || item.message.state !== 'deleted') {
      // 구분선도, 대기 행도, 살아 있는 메시지도 전부 묶음을 끊는다. 사이에 무엇이
      // 하나라도 들어오면 그 둘은 「연달아」가 아니다.
      out.push(item);
      runAt = -1;
      continue;
    }
    const facts = factsFor(item);
    const foldable =
      runAt >= 0 && !item.startsGroup && !facts.hasRollup && !facts.hasReactions;
    if (!foldable) {
      // 접을 수 없는 묘비는 그려지고, **자기가 새 묶음의 머리가 된다.** 그래서
      // 「답글 달린 묘비」 하나가 가운데 끼어도 그 앞뒤가 각각 접힌다.
      out.push(item);
      runAt = out.length - 1;
      continue;
    }
    const head = out[runAt] as FoldedTimelineItem;
    out[runAt] = {...head, deletedRepeat: (head.deletedRepeat ?? 1) + 1};
  }

  return out;
}
