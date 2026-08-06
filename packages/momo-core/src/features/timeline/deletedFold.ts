import { uuidEq } from "../../lib/api";
import type { DividerSegment } from "./divider";
import type { TimelineStreamItem } from "./model";

// =============================================================================
// 연달아 지워진 메시지를 한 줄로 접는다 — 두 클라이언트의 정본 (U4-6 · 감사 M-1).
//
// 감사 캡처 `m-09`: 「삭제된 메시지」가 두 줄 연속으로 서 있다. 결함은 한 문장으로
// 적혀 있다 — *"지워진 것들이 지워지지 않은 것들만큼 자리를 차지한다."* 묘비는
// 메시지에 **대한** 서술이지 메시지가 아닌데, 다섯 개를 연달아 지우면 다섯 줄이
// 남는다.
//
// ## 왜 이 파일이 코어로 올라왔나
//
// 처음 이 규칙이 landing 한 자리는 `clients/mobile/src/features/conversation/
// deletedFold.ts` 였고, 그 파일 머리말이 자기가 있어야 할 자리를 스스로 적어 두었다:
// *"정본 자리는 코어다."* 폰 로컬이었던 이유는 설계가 아니라 동시 작업이었다 —
// 같은 사이클에 웹 워커가 코어를 들고 돌고 있었다. 그 배치가 끝났으므로 옮긴다.
//
// **그리고 웹도 같은 결함을 갖고 있다.** 실측(U4-6W): 웹의 렌더 스트림은
// `buildTimelineItems` → `withTurnPlaceholders` 두 단계뿐이고 그 어디에도 삭제
// 접기가 없다. 연속 묘비 네 개를 심으면 `[data-testid="timeline-message"]` 가
// 네 개 선다(게이트 `gate-composer.mjs` 의 `[deleted]` 절이 그 수를 인쇄한다).
// 즉 이 파일이 코어에 있어야 할 이유는 「폰의 규칙을 공용으로 만든다」가 아니라
// **두 클라가 같은 결함을 갖고 있었다**는 사실이다.
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
// ## 「인용 대상이다」는 네 번째 조건이 **아니다** (design-review U4-5 H-1)
//
// 리뷰가 실측한 결함: 삭제 원본을 가리키는 인용은 점프 가능한데, 그 원본이 이
// 규칙에 접혀 들어가면 목록의 `findIndex` 가 빈손으로 돌아오고 화면은 「위로 올려
// 이전 대화를 더 불러오세요」라고 말한다 — 원본은 **이미 로드돼 있고 접혀 있을
// 뿐인데**. 두 방향이 있었다:
//
//   ① 규칙 4 로 「인용 대상인가」를 추가한다 — 인용된 묘비는 접지 않는다.
//   ② 점프가 빗나가면 그 묘비를 **대신해 서 있는 행**에 착지한다.
//
// **②를 골랐고, 승격도 그 선택을 그대로 들고 온다.** 규칙 2·3 과 ①은 겉모습만
// 같고 성질이 다르다:
//
//   * 롤업과 반응은 **그 행 위에 그려져 있던 것**이다. 접으면 화면에서 실제로
//     사라지므로, 접지 않는 것이 곧 손실을 막는 것이다. 「인용됐다」는 묘비 위에
//     아무것도 그리지 않는다 — 접어도 그 행이 잃는 표시가 없다. 잃는 것은 **목적지**
//     하나뿐이고, 목적지를 고치는 자리는 항법이지 접기가 아니다.
//   * ①은 **보이지 않는 성질이 보이는 배치를 지배**하게 만든다. 나중에 누가 옛
//     묘비를 인용하면 이미 접혀 있던 묶음이 소급해서 갈라지고, 갈라진 자리에는
//     그 이유를 말하는 표시가 없다 — 읽는 사람에게는 같아 보이는 묘비 둘 중 하나만
//     따로 서 있는 화면이다.
//   * 비용이 접기 전체에 걸린다. 감사가 든 예가 「다섯 개 연속 삭제」인데, 그중
//     셋이 인용돼 있으면 접기가 되돌려 주는 줄이 넷에서 하나로 준다. 항법 하나를
//     위해 접기의 값어치를 낸다.
//
// ②가 정직한 이유: 접힌 머리 행은 **원본이 지금 화면에서 서 있는 자리 그 자체**다.
// 「삭제된 메시지 3개」는 원본을 포함해서 하는 말이고, 사람이 누른 인용 블록은 이미
// 「삭제된 메시지」라고 말해 두었다. 그러므로 착지는 없는 것을 있다고 하지 않는다 —
// 반대로 ①이 없을 때의 옛 안내문(「위로 올려 불러오세요」)은 **거짓 지시**였다.
//
// **승격이 되돌려서는 안 되는 것이 정확히 이 지점이다** (#1105 인계). 코어판이
// `deletedFoldedIds` 를 빠뜨리면 그 엣지가 두 클라에 한꺼번에 재도입된다. 그래서
// 대리 착지는 이 파일의 **부수 기능이 아니라 계약**이고, 그 계약이 지켜지는지는
// `deletedFold.test.ts` 의 「진짜 없는 것은 여전히 없다」 단정과 짝을 이룬다:
// 대리 착지는 접힌 것만 답해야 하고, 애초에 로드되지 않은 메시지에 대해서는
// 여전히 `-1` 이어야 한다. 그 둘 중 하나만 참이면 이 함수는 거짓말을 한다.
//
// 그리고 **접기는 이 스트림에서만 일어난다.** 메시지 배열도, seq 도, 커서도, 읽음
// 위치도 접기를 모른다 — 코어의 알림 접기(`foldPausedNotices`)가 지키는 규율과 같다.
// =============================================================================

/**
 * 접힌 뒤에도 남는 행이 자기를 포함해 몇 개를 대신하는지.
 *
 * `TimelineItem` 유니온을 넓히지 않고 **한 겹 위의 항목 타입**으로 세운다. 이유는
 * `withTurnPlaceholders` 가 `TurnPlaceholderItem` 에 대해 이미 적어 둔 것과 같다:
 * 유니온을 넓히면 네 종류를 `if` 로 걷어낸 뒤 남은 것을 메시지로 단정하는 기존
 * 소비자들이 한꺼번에 타입 오류가 된다. 접기를 쓰는 표면만 이 타입을 쓰고, 쓰지
 * 않는 표면은 `TimelineStreamItem` 을 그대로 쓴다.
 */
export type FoldedTimelineItem = TimelineStreamItem & {
  /** 이 묘비가 대신하는 삭제 메시지 수 (2 이상일 때만 있다). */
  deletedRepeat?: number;
  /**
   * 이 행 **안으로** 접혀 들어간 메시지들의 id — 자기 id 는 빼고 (U4-5 H-1).
   *
   * 개수(`deletedRepeat`)는 화면이 쓰고, 이 배열은 **항법**이 쓴다: 인용 점프가
   * 목적지를 못 찾았을 때 「그 메시지를 대신해 서 있는 행이 어느 것인가」를 답할
   * 수 있는 유일한 재료다. 화면에는 나가지 않는다 — 행은 자기가 무엇을 흡수했는지
   * 알 필요가 없다.
   */
  deletedFoldedIds?: readonly string[];
};

/** 접기가 판정 대상으로 삼는 항목 — 메시지 행. */
export type MessageStreamItem = Extract<TimelineStreamItem, { kind: "message" }>;

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
  factsFor: (item: MessageStreamItem) => DeletedRowFacts
): FoldedTimelineItem[] {
  const out: FoldedTimelineItem[] = [];
  /** 지금 열려 있는 묘비 묶음의 **출력 배열 안** 위치. 없으면 -1. */
  let runAt = -1;

  for (const item of items) {
    if (item.kind !== "message" || item.message.state !== "deleted") {
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
    out[runAt] = {
      ...head,
      deletedRepeat: (head.deletedRepeat ?? 1) + 1,
      // 흡수한 id 를 적어 둔다 (U4-5 H-1). 묶음은 짧으므로(연속 삭제 몇 개) 매번
      // 새 배열을 만드는 값이 목록 전체를 다시 훑는 색인보다 싸고, 접기가 순수
      // 함수라는 성질을 지킨다.
      deletedFoldedIds: [...(head.deletedFoldedIds ?? []), item.message.id],
    };
  }

  return out;
}

/**
 * 이 메시지를 **대신해 서 있는** 행의 위치. 접혀 들어간 적이 없으면 `-1`.
 *
 * 자기 행이 목록에 그대로 있는 경우는 여기서 답하지 않는다 — 그것은 호출자의
 * 평범한 `findIndex` 가 이미 답했고, 이 함수는 그 뒤에 오는 **두 번째 질문**이다:
 * *"없다면, 누가 그것을 대신하고 있나?"* 두 질문을 한 함수로 합치지 않는 이유는
 * 호출자가 그 둘을 다르게 읽어야 하기 때문이다(직접 착지 vs 대리 착지).
 *
 * 그리고 이 함수는 **접힌 것만** 답한다. 애초에 로드되지 않은 메시지에는 여전히
 * `-1` 이고, 그래야 호출자의 「더 위쪽에 있습니다」가 참인 자리에서만 뜬다.
 *
 * 대소문자는 접는다 — 와이어가 섞어 보낸다(Swift `uuidString` 은 대문자).
 */
export function foldedStandInIndex(
  items: readonly FoldedTimelineItem[],
  messageId: string
): number {
  return items.findIndex((item) =>
    (item.deletedFoldedIds ?? []).some((id) => uuidEq(id, messageId))
  );
}

/**
 * 묘비가 자기 자신을 포함해 몇 개를 대신하는지 말하는 문구. 하나면 아무 말도 하지
 * 않는다 — 「1개」는 개수가 아니라 잡음이다.
 *
 * 두 클라가 같은 문장을 말해야 하므로 여기 둔다: 폰이 자기 파일에서
 * `삭제된 메시지 ${n}개` 를 짓고 웹이 자기 파일에서 다른 조사를 붙이는 순간, 같은
 * 접기가 두 얼굴을 갖는다 (U1 M-2 가 구분선에서 겪은 실패 양식 그대로다).
 */
export const DELETED_TOMBSTONE_COPY = "삭제된 메시지";

export function deletedFoldLabel(deletedRepeat: number | undefined): string {
  return deletedRepeat !== undefined && deletedRepeat > 1
    ? `${DELETED_TOMBSTONE_COPY} ${deletedRepeat}개`
    : DELETED_TOMBSTONE_COPY;
}

/**
 * 같은 문장을 **숫자와 산문으로 갈라서**. `DividerSegment` 를 빌려 쓰는 것은
 * 이름이 아니라 성질 때문이다: 이 레포에서 「자릿폭을 고정할 숫자가 섞인 라벨」의
 * 모양은 그 타입 하나이고(`divider.ts` 머리말), 「개」에까지 `tabular-nums` 가
 * 걸리면 한글 음절 사이가 벌어진다는 실측도 거기 적혀 있다.
 *
 * 문자열 판(`deletedFoldLabel`)이 함께 남는 이유는 낭독과 테스트가 문자열을
 * 요구하기 때문이고, 둘이 갈라지지 않게 이 함수가 그 문자열을 조립해 낸다.
 */
export function deletedFoldSegments(
  deletedRepeat: number | undefined
): DividerSegment[] {
  if (deletedRepeat === undefined || deletedRepeat <= 1) {
    return [{ kind: "prose", text: DELETED_TOMBSTONE_COPY }];
  }
  return [
    { kind: "prose", text: `${DELETED_TOMBSTONE_COPY} ` },
    { kind: "figure", text: `${deletedRepeat}` },
    { kind: "prose", text: "개" },
  ];
}
