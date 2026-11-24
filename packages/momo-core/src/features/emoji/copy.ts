// =============================================================================
// 카탈로그가 없을 때 이모지 표면이 하는 말 (#1930 design-review H-2).
//
// 이 문장들은 피커(`EmojiPickerPanel`)가 먼저 썼고, 컴포저의 `:` 자동완성이
// 같은 카탈로그를 같은 방식으로(dynamic import·실패 가능) 싣는다. 자동완성은
// 그 셋 중 하나도 말하지 않아서, 카탈로그가 늦는 동안 친 `:thu` 가 Enter 에서
// 평문으로 나가고 영구 실패는 침묵으로 끝났다(리뷰 실측 3종).
//
// 문장을 새로 쓰지 않고 여기로 옮겨 둘이 함께 읽는 이유: 같은 사고를 두 표면이
// 다른 말로 설명하면 사람은 그것을 두 가지 고장으로 배운다. 옆 버튼의 피커가
// 「다시 시도」를 주는데 자동완성만 조용한 것이 정확히 이 결함이었다.
// =============================================================================

/** 문장은 사전(`emoji.json`)에 있고 이 표는 그 키다(#6058). 화면이 `formatMessage`로 풀어 그린다. */
import type { PlainMessageKey } from "../../i18n/keys";

export const EMOJI_CATALOG_COPY = {
  /** 카탈로그 청크를 못 실었다. */
  error: "emoji.catalog.error",
  /** 브라우저가 오프라인이라고 말한다 — 이 실패는 그 사실로 설명된다. */
  offline: "emoji.catalog.offline",
  retry: "common.action.retry",
  /** 카탈로그는 있는데 질의가 아무것도 못 맞췄다. */
  emptyHeadline: "emoji.catalog.emptyHeadline",
  emptyDetail: "emoji.catalog.emptyDetail",
} as const satisfies Record<string, PlainMessageKey>;
