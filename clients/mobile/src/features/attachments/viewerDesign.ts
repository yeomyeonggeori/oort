import { absoluteDayLabel } from '@momo/core/features/timeline/divider';
import { clockLabel } from '@momo/core/features/work/workSessionFormat';
import type { GlassTone } from '../../design/glass';
import { photoStage, space, TOUCH_TARGET } from '../../design/tokens';

// =============================================================================
// 사진 뷰어의 무대와 치수 (#4297) — 카카오톡 아이폰 사진 미리보기를 본으로 삼은 모양.
//
//   검정 무대 위에 사진이 화면 가득 서고, 막대는 없다. 조작은 사진 **위에 떠 있는** 반투명 유리다:
//     위     왼쪽 둥근 유리 ‹(뒤로) + 보낸 사람 이름·날짜·시각
//     아래   (두 장 이상) 썸네일 줄 + 「N장 중 n번」, 맨 아래 왼쪽 둥근 유리 [저장] · 오른쪽 둥근 유리 [공유]
//   사진을 한 번 누르면 위·아래 조작이 같이 사라지고 다시 나타난다.
//
// ## 무대 색은 테마와 무관하다 — `Palette` 가 아니라 `tokens.ts` 의 `photoStage` 다
//
// 라이트·다크 어느 테마에서도 같은 검정 무대이고 그 위의 글자·유리도 한 벌이다. 값과 근거(`Palette` 밖인 이유)는 `design/tokens.ts`
// 의 `photoStage` 에 있다 — 앱에서 hex 가 사는 곳은 그 파일 하나다(`conversationHygiene.test.tsx` M-13). 웹에 짝이 없는 폰 전용 값이라
// **값이 아니라 지키는 관계**를 시험이 잰다(`docs/design-system/README.md` §6 「폰에 값을 더할 때」).
//
// ## 치수 — 숫자는 이름으로만 스타일에 들어간다
//
// `photoCardDesign.ts` 와 같은 이유다: 스타일시트에 숫자를 흩으면 `designSystem.test.ts` 의 스윕이 「격자 밖 리터럴」로 세고,
// 다음 사람이 「이 44 는 어디서 왔나」를 한 자리에서 읽지 못한다. 키 이름이 `gap`·`padding` 이 아닌 것은 그 스윕이 키 이름을
// 속성으로 읽기 때문이다.
// =============================================================================

/** 무대 위의 색. 테마와 무관하다(`design/tokens.ts` 의 `photoStage`). */
export const VIEWER_STAGE = photoStage;

/** 무대 위 유리의 톤(`design/glass.tsx` 의 `GlassTone`). 세 갈래(블러 틴트·대체·불투명)가 모두 어둡다. */
export const VIEWER_GLASS_TONE: GlassTone = {
  scheme: 'dark',
  ...photoStage.glass,
};

export const VIEWER = {
  /** 둥근 유리 단추의 지름 — 터치 최소와 같다(카카오톡 ≈ 44). */
  control: TOUCH_TARGET,
  /** 조작이 화면(안전 영역) 가장자리에서 떨어진 가로 거리. */
  edge: space.lg,
  /** 위쪽 띠: 단추와 이름 사이. */
  stampOffset: space.md,
  /** 아래쪽: 홈 인디케이터(안전 영역) 위로 더 띄우는 거리. */
  bottomLift: space.sm,
  /** 아래쪽 덩어리(안내·썸네일 줄·캡션·단추 줄) 사이의 세로 거리. */
  stackStep: space.sm,
  /** 썸네일 한 변. 누르는 대상이라 터치 최소다. */
  thumb: TOUCH_TARGET,
  /** 썸네일 사이 거리. */
  thumbStep: space.xs,
  /** 고른 썸네일의 테두리 두께(카카오톡의 「굵은 테두리」). 안 고른 것도 같은 두께의 투명 테두리라 고를 때 자리가 안 움직인다. */
  thumbRing: 2,
  /** 안 고른 썸네일의 불투명도. */
  thumbDim: 0.72,
  /** 캡션 앞 사진 글리프의 크기. */
  captionGlyph: 16,
  /** 조작 덩어리 둘레로 스크림이 더 번지는 거리 — 글자 줄에서 갑자기 끊기지 않고 부드럽게 풀린다(띠 모양의 경계가 남지 않는다). */
  scrimReach: space.xl * 3,
  /** 상태 안내(내려받는 중·실패) 알약의 안쪽 여백 — 어떤 사진 위에서도 읽히도록 어두운 면을 깐다. */
  noticePadX: space.md,
  noticePadY: space.xs,
} as const;

/**
 * 스크림의 **자락**(덩어리 밖으로 풀리는 부분)의 검정 불투명도. `fraction` 은 덩어리 끝 0 → 사라지는 곳 1(`photoStage.scrim.fade` 의 위치와
 * 같다). 마디 사이는 선형이다. 화면은 같은 표를 `linear-gradient` 로 그리고(`viewerScrimFade`), 시험은 이 함수로 단조롭게 풀리는지 잰다.
 */
export function viewerScrimFadeAlpha(fraction: number): number {
  const stops = photoStage.scrim.fade;
  const last = stops[stops.length - 1] as readonly [number, number];
  if (fraction <= stops[0][0]) return stops[0][1];
  if (fraction >= last[0]) return last[1]; // 끝 마디는 보간하지 않는다(부동소수 찌꺼기 없이 정확히 0)
  for (let i = 1; i < stops.length; i += 1) {
    const [at, alpha] = stops[i] as readonly [number, number];
    const [from, fromAlpha] = stops[i - 1] as readonly [number, number];
    if (fraction <= at)
      return (
        fromAlpha + ((alpha - fromAlpha) * (fraction - from)) / (at - from)
      );
  }
  return stops[stops.length - 1]?.[1] ?? 0;
}

const black = (alpha: number) => `rgba(${photoStage.scrim.rgb}, ${alpha})`;

/**
 * 스크림의 **판** — 조작 덩어리 안을 가득 덮는 그라데이션. `down` 은 위쪽 덩어리(맨 위가 가장 어둡다), `up` 은 아래쪽 덩어리(맨 아래가
 * 가장 어둡다). 판이 없으면 밝은 사진(스크린샷의 흰 바탕) 위에서 흰 이름·시각이 사라진다.
 */
export function viewerScrimPlateau(direction: 'down' | 'up'): string {
  const [outer, inner] = photoStage.scrim.plateau;
  return `linear-gradient(${direction === 'down' ? 180 : 0}deg, ${black(
    outer,
  )} 0%, ${black(inner)} 100%)`;
}

/** 스크림의 **자락** — 덩어리 밖에서 판의 안쪽 끝 불투명도로 시작해 0 으로 풀린다. `down` 은 아래로, `up` 은 위로 풀린다. */
export function viewerScrimFade(direction: 'down' | 'up'): string {
  const marks = photoStage.scrim.fade.map(
    ([at, alpha]) => `${black(alpha)} ${at * 100}%`,
  );
  return `linear-gradient(${direction === 'down' ? 180 : 0}deg, ${marks.join(
    ', ',
  )})`;
}

/** 글자 곁의 가는 그림자 — 스크림이 못 닿는 가장자리의 보조다(이름·시각·캡션이 같은 모양을 쓴다). */
export const VIEWER_TEXT_SHADOW = {
  textShadowColor: photoStage.inkShadow,
  textShadowOffset: { width: 0, height: 1 },
  textShadowRadius: 3,
} as const;

/** 「3장 중 2번」 — 위치는 1부터다. */
export function viewerCaption(position: number, total: number): string {
  return `${total}장 중 ${position}번`;
}

/** 보조기술이 읽는 위치. */
export function viewerCaptionLabel(position: number, total: number): string {
  return `${total}장 중 ${position}번째 사진`;
}

/**
 * 「2026년 10월 29일 14:55」. 날짜는 앱 전체가 쓰는 한 가지 철자다(`absoluteDayLabel` — 「2026. 10. 29.」를 따로 지으면 한 앱에
 * 두 철자가 산다, `divider.ts`). 시각은 행 시각과 같은 24시간 HH:MM 이다.
 */
export function viewerStamp(sentAtMs: number): string {
  return `${absoluteDayLabel(sentAtMs)} ${clockLabel(sentAtMs)}`;
}

/**
 * 썸네일 줄을 고른 장이 가운데 오도록 미는 거리. 줄이 화면보다 짧으면 0(줄이 스스로 가운데에 선다), 넘치면 양 끝에서 멈춘다.
 * 줄의 가로 폭은 창 폭에서 양쪽 여백을 뺀 값이라 레이아웃 측정을 기다리지 않는다(첫 렌더부터 맞는 자리에 선다).
 */
export function viewerStripOffset(
  index: number,
  count: number,
  viewport: number,
): number {
  const content =
    count * VIEWER.thumb + Math.max(0, count - 1) * VIEWER.thumbStep;
  if (content <= viewport) return 0;
  const center = index * (VIEWER.thumb + VIEWER.thumbStep) + VIEWER.thumb / 2;
  return Math.min(Math.max(0, center - viewport / 2), content - viewport);
}
