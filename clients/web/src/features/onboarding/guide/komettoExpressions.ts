// =============================================================================
// 코메토 표정 id → 그림. **표정 에셋 경로는 이 파일 한 곳에만 있다** (#2807).
//
// #2806(OB2-0)의 플랫 표정 여섯 장이 들어오기 전에는 여섯 id가 모두 owner가 고른
// K6 플랫 배지(`docs/brand/kometto/K6-flat-dark.png`에서 오려 낸 576px 래스터,
// `KomettoMark`와 같은 파일)를 가리킨다. 자산이 들어오면 아래 import 여섯 줄과
// `KOMETTO_ASSETS_PLACEHOLDER`만 바뀐다. 컴포넌트는 손대지 않는다.
//
// 규격(#2806 Acceptance): 표정마다 투명 배경 576px PNG, 32px 미만 사용 금지.
// =============================================================================

import type { KomettoExpression } from "@momo/core/features/onboarding/guide";
import k6Badge from "@/assets/brand/kometto-badge.png";

export const KOMETTO_EXPRESSION_ASSETS: Readonly<Record<KomettoExpression, string>> = {
  idle: k6Badge,
  thinking: k6Badge,
  happy: k6Badge,
  flustered: k6Badge,
  working: k6Badge,
  sleepy: k6Badge,
};

/** #2806 전의 임시본인가. 갤러리가 「임시본」 표기를 이 값으로 가른다. */
export const KOMETTO_ASSETS_PLACEHOLDER = true;
