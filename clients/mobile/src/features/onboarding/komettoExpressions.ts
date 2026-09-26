// =============================================================================
// 코메토 표정 id → 그림 (폰). **표정 에셋 경로는 이 파일 한 곳에만 있다** (#2807).
//
// 웹 `clients/web/src/features/onboarding/guide/komettoExpressions.ts`와 같은 자리다.
// #2806(OB2-0)의 플랫 표정 여섯 장이 들어오기 전에는 여섯 id가 모두 K6 플랫 배지를
// 가리킨다. `kometto-guide-k6.png`는 웹 `assets/brand/kometto-badge.png`(576px,
// `docs/brand/kometto/K6-flat-dark.png`에서 오려 낸 래스터)와 바이트가 같은 사본이다.
// 사이드바 배지(`kometto-badge*.png`)는 44pt 한 자리용이라 72·200에서 번진다.
//
// 자산이 들어오면 아래 require 여섯 줄과 `KOMETTO_ASSETS_PLACEHOLDER`만 바뀐다.
// =============================================================================

import type {ImageSourcePropType} from 'react-native';
import type {KomettoExpression} from '@momo/core/features/onboarding/guide';

const K6_BADGE: ImageSourcePropType = require('../../design/brand/kometto-guide-k6.png');

export const KOMETTO_EXPRESSION_ASSETS: Readonly<
  Record<KomettoExpression, ImageSourcePropType>
> = {
  idle: K6_BADGE,
  thinking: K6_BADGE,
  happy: K6_BADGE,
  flustered: K6_BADGE,
  working: K6_BADGE,
  sleepy: K6_BADGE,
};

/** #2806 전의 임시본인가. */
export const KOMETTO_ASSETS_PLACEHOLDER = true;
