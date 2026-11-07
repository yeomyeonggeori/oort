import { mountTextareaMirror } from "./composerFormatPosition";

// =============================================================================
// 캐럿이 입력칸의 **첫 화면 줄**에 있는가 (#5489 M1, 검증 7a-2).
//
// 이모티콘 추천 줄이 떠 있을 때 입력칸의 ↑ 는 (캐럿이 첫 줄이면) 그 줄로 들어간다(#5476, 코어 `composerKeyIntent` 의 `caretOnFirstLine`).
// 「첫 줄」을 앞에 줄바꿈이 없다는 것으로만 판단하면, 길게 감긴 한 문단(390 폭이면 25자 남짓에서 감긴다)의 둘째·셋째 **화면** 줄에서도 ↑ 가
// 줄로 가 버려 글을 ↑ 로 오를 수 없다(Esc 로 줄을 닫기 전까지). 그래서 줄바꿈 검사에 **화면 줄**을 더한다.
//
// textarea 의 캐럿은 DOM Range 가 아니라 좌표를 못 읽는다. 같은 박스·글꼴의 숨은 거울(`composerFormatPosition` 의 `mountTextareaMirror`, 서식 트레이와 같은
// 거울)에 캐럿 앞 글을 넣고 끝에 폭 0 표지를 둬 윗선을 잰 뒤, 글을 비워 표지가 글머리에 서게 해 윗선을 다시 잰다. 같은 줄이면 두 윗선이 같고 줄이 하나
// 내려갈 때마다 줄 높이만큼 벌어진다. 줄 높이·여백을 계산하지 않고 두 윗선의 차이만 보므로 글꼴·크기·줄 간격이 바뀌어도 판정이 같다.
//
// 모든 키마다 재지 않는다: 거울을 만들고 배치를 읽는 일이라, `Composer` 는 이 함수를 `caretOnFirstLine` 의 함수로 넘기고 코어(`composerKeyIntent`)가 줄이 떠 있는 맨 ↑ 에서만 한 번 부른다.
// =============================================================================

/** 거울에서 잰 값. 윗선은 뷰포트 기준 px 이고 차이만 쓴다. */
export interface CaretMarks {
  /** 글머리에 둔 표지의 윗선(첫 화면 줄). */
  startTop: number;
  /** 캐럿 자리에 둔 표지의 윗선. */
  caretTop: number;
  /** 표지 하나의 높이(글자 상자). 줄 높이보다 작거나 같아 문턱의 기준이 된다. */
  markHeight: number;
}

/**
 * 순수 판정: 캐럿 표지가 글머리 표지와 같은 화면 줄에 있는가. 둘째 줄의 윗선은 첫 줄보다 줄 높이만큼 아래이고, 줄 높이는 표지 높이(글자 상자)
 * 이상이다. 표지 높이의 절반을 문턱으로 삼아, 이모지가 든 줄의 기준선이 몇 px 어긋나도 같은 줄로 읽는다. 배치가 없는 환경(높이 0)에서는 문턱
 * 1px 아래라 같은 줄이다: 줄바꿈 검사의 답이 그대로 남는다.
 */
export function isCaretOnFirstLine({ startTop, caretTop, markHeight }: CaretMarks): boolean {
  return caretTop - startTop < Math.max(markHeight / 2, 1);
}

/**
 * 글머리와 캐럿 자리의 표지를 거울에서 잰다. 표지는 폭 0(U+200B)이라 감김을 바꾸지 않는다: 캐럿이 줄 끝에 있을 때 표지만 다음 줄로 밀려나는 일이 없다.
 * 같은 표지를 두 번 읽는다: 캐럿 앞 글이 있을 때(캐럿 자리)와 글을 비웠을 때(글머리 = 첫 화면 줄 맨 앞).
 */
function measureCaretMarks(textarea: HTMLTextAreaElement, before: string): CaretMarks {
  const { mirror, head, mark } = mountTextareaMirror(textarea, before, "\u200b");
  try {
    const caretRect = mark.getBoundingClientRect();
    const caretTop = caretRect.top;
    head.data = "";
    return { startTop: mark.getBoundingClientRect().top, caretTop, markHeight: caretRect.height };
  } finally {
    mirror.remove();
  }
}

/**
 * 캐럿(`selectionStart`)이 입력칸의 첫 화면 줄에 있다. 앞에 줄바꿈이 있으면 거울을 만들지 않고 아니라고 답한다. 줄바꿈이 없으면 글이 감겨 캐럿이
 * 둘째 줄 이후에 있는지 거울로 잰다.
 */
export function caretOnFirstVisualLine(textarea: HTMLTextAreaElement): boolean {
  const before = textarea.value.slice(0, textarea.selectionStart ?? 0);
  if (before.includes("\n")) return false;
  return isCaretOnFirstLine(measureCaretMarks(textarea, before));
}
