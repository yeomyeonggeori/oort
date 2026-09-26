// =============================================================================
// 코메토 표정 id → 그림 (폰). **표정 에셋 경로는 이 파일 한 곳에만 있다** (#2807).
//
// 웹 `clients/web/src/features/onboarding/guide/komettoExpressions.ts`와 같은 자리다.
// #2806(OB2-0)의 플랫 표정 여섯 장(투명 컷, 테마 공용). 폰 히어로 200pt@3x를 위해 600px이다.
// `clients/web/scripts/render-brand-icons.mjs`가 웹 576과 같은 합성에서 떠내고 검사한다.
// =============================================================================

import type {ImageSourcePropType} from 'react-native';
import type {KomettoExpression} from '@momo/core/features/onboarding/guide';

export const KOMETTO_EXPRESSION_ASSETS: Readonly<
  Record<KomettoExpression, ImageSourcePropType>
> = {
  idle: require('../../design/brand/kometto-faces/idle.png'),
  thinking: require('../../design/brand/kometto-faces/thinking.png'),
  happy: require('../../design/brand/kometto-faces/happy.png'),
  flustered: require('../../design/brand/kometto-faces/flustered.png'),
  working: require('../../design/brand/kometto-faces/working.png'),
  sleepy: require('../../design/brand/kometto-faces/sleepy.png'),
};

/** #2806 전의 임시본인가. */
export const KOMETTO_ASSETS_PLACEHOLDER = false;
