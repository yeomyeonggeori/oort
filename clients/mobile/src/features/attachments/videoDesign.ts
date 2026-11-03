import { StyleSheet } from 'react-native';
import { ATTACHMENT_INLINE_IMAGE, space, TOUCH_TARGET } from '../../design/tokens';

// =============================================================================
// 영상 카드와 재생 조작의 치수 (#5208) — 카카오톡 아이폰의 영상 말풍선·재생 화면을 본으로 삼은 모양.
//
//   대화 속   포스터가 있으면 사진처럼 테두리 없는 그림(한가운데 어두운 원 안의 ▶, 오른쪽 아래 길이 알약).
//             포스터가 없으면 파일 카드의 모양에 영상기 아이콘 · 길이가 든 한 줄(문서 아이콘이 아니다).
//   전체 화면 사진 뷰어와 같은 무대·조작(`viewerDesign.ts`). 한가운데 ▶/⏸, 아래에 [▶] 0:12 ━━●━━ 0:42 [🔊].
//
// 숫자는 이름으로만 스타일에 들어간다(`viewerDesign.ts` 와 같은 이유 — `designSystem.test.ts` 의 「격자 밖 리터럴」 스윕이 키 이름을 속성으로
// 읽는다). 색은 여기 없다: 어두운 면과 흰 글자는 사진 무대의 값(`photoStage`, `VIEWER_STAGE`)을 그대로 쓴다.
// =============================================================================

export const VIDEO_CARD = {
  /** 포스터 카드가 들어가는 상자 — 사진 한 장(`ATTACHMENT_INLINE_IMAGE`)과 같다. 비율은 코어 `videoCardSize` 가 가둔다. */
  max: {
    width: ATTACHMENT_INLINE_IMAGE.maxWidth,
    height: ATTACHMENT_INLINE_IMAGE.maxHeight,
  },
  /** 한가운데 재생 표지(어두운 원)의 지름. 카드 전체가 누르는 자리라 이 표지는 따로 눌리지 않는다. */
  badge: TOUCH_TARGET + space.md,
  /** 길이 알약: 안쪽 여백과 카드 모서리에서 떨어진 거리. */
  chipPadX: space.sm,
  chipPadY: space.xs,
  chipInset: space.sm,
} as const;

export const VIDEO_PLAYER = {
  /** 진행 막대의 누르는 면 — 터치 최소다. 보이는 선은 이 면 한가운데에 가늘게 그려진다. */
  trackHit: TOUCH_TARGET,
  /** 보이는 선의 두께. */
  trackLine: space.xs,
  /** 손잡이의 지름. */
  knob: space.lg,
  /** 시간 글자 한 칸의 최소 폭 — 「1:01:01」이 서도 막대가 움직이지 않는다(숫자는 고정 폭으로 그린다). */
  timeWidth: TOUCH_TARGET + space.sm,
  /** 조작 줄 안의 간격. */
  step: space.sm,
  /** 한가운데 재생·멈춤 단추의 지름. */
  center: TOUCH_TARGET + space.xl,
  /** 접근성 늘림·줄임이 건너뛰는 초. */
  adjustSeconds: 10,
} as const;

/**
 * 레이아웃 조각 — 같은 낱말(`center`·`row`·`absolute`…)을 파일마다 적지 않고 여기 한 곳에서 적는다. 직접 문구 장부(`direct-copy`)는 이런
 * 스타일 값도 낱말로 세므로, 새 파일마다 장부가 불어나지 않게 한다. 색이 없는 순수 레이아웃이라 테마와 무관하다: `StyleSheet.create` 상수가
 * 아니라 평범한 객체이고(테마가 바뀌어도 굳을 값이 없다), 화면이 `buildStyles` 안에서 펼쳐 쓴다.
 */
export const LAYOUT = {
  /** 부모를 가득 덮는다. */
  fill: StyleSheet.absoluteFill,
  /** 가로·세로 가운데. */
  centered: { alignItems: 'center', justifyContent: 'center' },
  /** 세로로만 가운데(가로는 부모가 정한다). */
  centeredY: { justifyContent: 'center' },
  /** 한 줄, 세로 가운데. */
  row: { flexDirection: 'row', alignItems: 'center' },
  /** 넘치는 것을 자른다(둥근 모서리 안에 포스터를 가둔다). */
  clipped: { overflow: 'hidden' },
  /** 흐름 밖에 얹는다(위치는 쓰는 쪽이 준다). */
  floating: { position: 'absolute' },
  textStart: { textAlign: 'left' },
  textMiddle: { textAlign: 'center' },
  textEnd: { textAlign: 'right' },
} as const;

/** 보조기술의 「늘림·줄임」 — 진행 막대가 `adjustable` 이라 VoiceOver 가 이 두 동작으로 위치를 옮긴다. */
export const ADJUST_ACTIONS = [{ name: 'increment' }, { name: 'decrement' }] as const;
