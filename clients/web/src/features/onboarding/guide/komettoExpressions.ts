// =============================================================================
// 코메토 표정 id → 그림. **표정 에셋 경로는 이 파일 한 곳에만 있다** (#2807).
//
// #2806(OB2-0)의 플랫 표정 여섯 장이다. owner가 고른 K6 플랫(`docs/brand/kometto/
// K6-flat-dark.png`)의 얼굴 창 안 눈만 바꾸고, 배지 원판을 걷어 낸 투명 컷이다(M2).
// 576px RGBA, 테마 공용. `clients/web/scripts/render-brand-icons.mjs`가 떠내고 검사한다.
// 규격: `docs/brand/kometto/faces/expressions.md`. 32px 미만 사용 금지.
// =============================================================================

import type { KomettoExpression } from "@momo/core/features/onboarding/guide";
import flustered from "@/assets/brand/kometto-faces/flustered.png";
import happy from "@/assets/brand/kometto-faces/happy.png";
import idle from "@/assets/brand/kometto-faces/idle.png";
import sleepy from "@/assets/brand/kometto-faces/sleepy.png";
import thinking from "@/assets/brand/kometto-faces/thinking.png";
import working from "@/assets/brand/kometto-faces/working.png";

export const KOMETTO_EXPRESSION_ASSETS: Readonly<Record<KomettoExpression, string>> = {
  idle,
  thinking,
  happy,
  flustered,
  working,
  sleepy,
};

/** #2806 전의 임시본인가. 갤러리가 「임시본」 표기를 이 값으로 가른다. */
export const KOMETTO_ASSETS_PLACEHOLDER = false;
