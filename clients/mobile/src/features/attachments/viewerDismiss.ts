// =============================================================================
// 사진 뷰어: 아래로 쓸어 닫기 — **규칙만** (#4293). 배선은 `useViewerDismiss.ts`,
// 화면은 `AttachmentViewer.tsx` 다.
//
// 베타 테스터가 뷰어에 갇혔다. 위쪽 단추가 상태 막대 밑에 깔려 눌리지 않았는데, 닫는 길이
// 그 단추 하나뿐이었다. 길이 하나뿐이면 그 길이 가려지는 날 사람이 갇힌다 — 그래서
// **손가락으로 쓸어 내리는 길**을 하나 더 둔다. 이 파일은 그 길의 판정이다.
//
// ## 값은 Buzz 모바일의 것이다
//
// `mobile/lib/features/channels/media_viewer_page.dart` 가 정한 값을 그대로 옮긴다.
// 이 저장소가 값을 새로 지어내지 않는 것은 「사진을 내려서 닫는다」의 감각이 이미
// 한 번 다듬어진 것이기 때문이다.
//
//   _dismissThreshold      = 100.0   → {@link DISMISS_DISTANCE_PT}
//   _dismissVelocity       = 700.0   → {@link DISMISS_VELOCITY_PT_PER_S}
//   _backgroundFadeDivisor = 300.0   → {@link BACKDROP_FADE_DISTANCE_PT} (바닥 0.3)
//   chromeOpacity          = 1 - dy/160        → {@link CHROME_FADE_DISTANCE_PT}
//   imageScale             = 1 - progress*0.1  → {@link SHRINK_AT_BOTTOM}
//
// ## 왜 규칙이 컴포넌트 밖에 있는가
//
// `nav/edgeSwipe.ts` 가 같은 이유로 갈라 뒀다: 판정이 터치 핸들러에 붙어 있으면 테스트로
// 재생할 수 없고, 재생할 수 없는 방어는 죽어도 아무도 모른다. 이 제스처는 그 옆에 하나 더
// 있다 — 가로 페이지 넘김(ScrollView)과 같은 손가락을 두고 다툰다. **가로가 앞서면 가져가지
// 않는다**는 것이 이 파일이 지키는 약속이고, `__tests__/viewerDismiss.test.ts` 가 그 약속을
// 재생한다.
//
// ## 방향은 문턱을 처음 넘는 순간 한 번 정해진다
//
// 손가락이 8pt 안에 있는 동안은 탭이거나 떨림이라 아무것도 정하지 않는다. 어느 축으로든 처음
// 문턱을 넘는 순간 **방향이 정해지고 되돌리지 않는다.** 아래로(세로가 가로보다 크게) 갔으면
// 뷰어가 가져가고, 그 밖의 모든 것(가로로 갔다·위로 갔다·꺼져 있다)은 이 손가락의 남은
// 일생 동안 뷰어의 일이 아니다. 되돌릴 길을 두지 않는 이유는 `edgeSwipe.ts` 의 「세로가 먼저
// 움직였으면 영영 탈락」과 같다: 가로로 페이지를 넘기던 손가락이 비스듬히 내려오다 사진을 닫아
// 버리는 것이 이 배치가 고치려는 문제보다 나쁘다.
//
// ## 확대 중에는 끈다 (#4769)
//
// 이 뷰어는 두 손가락 확대와 두 번 탭으로 확대한다(`viewerZoom.ts`). 그래서 {@link ViewerDragContext.enabled}
// 는 확대 중이면 거짓이다 — 확대된 사진을 끌어 옮기려는 손가락이 뷰어를 닫아 버리면 안 되기 때문이다
// (`AttachmentViewer` 가 `dismissEnabled && !zoomed` 를 이 한 칸에 넘긴다). 손가락이 둘 이상이면(핀치의
// 시작) 확대 여부와 무관하게 가져가지 않는다.
// =============================================================================

/** 터치를 처음 댄 점에서 이만큼(pt) **넘게** 내려갔으면 놓았을 때 닫는다. Buzz `_dismissThreshold`. */
export const DISMISS_DISTANCE_PT = 100;

/**
 * 놓는 순간 아래로 이 속도(pt/s)를 **넘게** 움직였으면 거리와 무관하게 닫는다. Buzz
 * `_dismissVelocity`.
 *
 * 단위가 함정이다: React Native `PanResponder` 의 `gestureState.vy` 는 **px/ms** 다
 * (`PageSheet` 의 `DISMISS_VELOCITY = 1.1` 이 1100pt/s 인 이유). 이슈의 700pt/s 는
 * `0.7` 이다. 이 상수는 pt/s 로 적고 비교하는 자리({@link settles})에서 한 번 환산한다.
 */
export const DISMISS_VELOCITY_PT_PER_S = 700;

const MS_PER_S = 1000;

/**
 * 가져가기 시작하는 문턱(pt). 이보다 덜 움직인 손가락은 탭이거나 떨림이다 — 여기서
 * 가져가면 닫기·공유 단추의 탭이 죽는다. `PageSheet` 의 끌어내리기(6)보다 약간 넓게 둔
 * 것은 이 화면에 가로로 넘기는 손가락이 흔하기 때문이다.
 */
export const CLAIM_SLOP_PT = 8;

/** 끄는 동안 배경(`bg`)이 옅어지는 거리. Buzz `_backgroundFadeDivisor`. 1 - d/300 이 바닥에 닿는 곳까지 선형. */
export const BACKDROP_FADE_DISTANCE_PT = 300;
/** 배경이 옅어지는 바닥. 완전히 투명해지면 뒤 대화가 뷰어를 이기고 사진이 떠 보인다. Buzz `clamp(0.3, 1.0)`. */
export const BACKDROP_MIN_OPACITY = 0.3;
/** 위쪽 단추 띠가 사라지는 거리. 사진을 끌 때 단추가 손가락 곁에 남아 있지 않게 한다. Buzz `1 - dy/160`. */
export const CHROME_FADE_DISTANCE_PT = 160;
/** 화면 바닥까지 끌었을 때 사진이 줄어드는 비율. Buzz `imageScale = 1 - progress * 0.1`. */
export const SHRINK_AT_BOTTOM = 0.1;

export interface DragPoint {
  x: number;
  y: number;
}

export interface ViewerDragState {
  /** 손가락을 처음 댄 점(page 좌표). 손가락이 없으면 null. */
  origin: DragPoint | null;
  /** 이 손가락이 뷰어를 가져갔다. */
  claimed: boolean;
  /**
   * 이 손가락은 뷰어의 것이 아니다 — 손가락이 둘이 되었거나, 처음 문턱을 넘은 방향이 아래가
   * 아니었거나, 꺼져 있었다. 손을 뗄 때까지 다시 가져가지 않는다.
   */
  dead: boolean;
}

export const IDLE: ViewerDragState = {origin: null, claimed: false, dead: false};

export type ViewerDragInput =
  | {kind: 'down'; touches: number; point: DragPoint}
  | {kind: 'move'; touches: number; point: DragPoint};

export interface ViewerDragContext {
  /** 쓸어 닫기가 켜져 있는가. 확대 중이면 거짓이다(#4769 — `AttachmentViewer` 가 넘긴다). */
  enabled: boolean;
}

export interface ViewerDragResult {
  state: ViewerDragState;
  /** 이 이동으로 뷰어가 손가락을 가져가는가(또는 이미 가져갔는가). */
  claims: boolean;
  /** 화면이 가 있어야 할 아래쪽 거리(pt, 0 이상). */
  offset: number;
  /** 가져간 손가락이 취소됐다(둘째 손가락). 호출부는 제자리로 돌려놓는다. */
  cancelled: boolean;
}

/** 손가락을 따라가는 거리: 아래로만 따라가고 위로는 가지 않는다(Buzz `clamp(0, height)`). */
export function followY(dy: number, height: number): number {
  return Math.min(Math.max(0, dy), height);
}

/**
 * 손가락 하나의 한 걸음. 순수 함수 — `PanResponder` 는 한 줄도 개입하지 않는다.
 *
 * 가져가는 조건(전부여야 한다):
 *   · 켜져 있다 ({@link ViewerDragContext.enabled})
 *   · 손가락이 하나다(둘이면 핀치다)
 *   · **아래로** 문턱({@link CLAIM_SLOP_PT})을 처음 넘었다
 *   · 그때 세로가 가로보다 크다 — 이것이 가로 페이지 넘김을 지킨다
 *
 * 가져간 뒤에는 방향을 다시 묻지 않는다(대각선으로 끌어도 뷰어가 손가락을 따라간다).
 */
export function viewerDragStep(
  state: ViewerDragState,
  input: ViewerDragInput,
  context: ViewerDragContext,
  height: number,
): ViewerDragResult {
  // 둘째 손가락(핀치의 시작): 새 터치가 닿을 때도, 이미 닿은 채 움직일 때도 같다.
  // 가져간 뒤라면 취소(제자리로), 가져가기 전이라면 영영 가져가지 않는다. 시작점을
  // 새로 잡지 않는다 — 둘째 손가락의 점이 첫 손가락의 시작점을 덮어쓰면 안 된다.
  if (input.touches > 1) {
    return {
      state: {origin: state.origin ?? input.point, claimed: false, dead: true},
      claims: false,
      offset: 0,
      cancelled: state.claimed,
    };
  }

  if (input.kind === 'down') {
    return {
      state: {origin: input.point, claimed: false, dead: false},
      claims: false,
      offset: 0,
      cancelled: false,
    };
  }

  if (state.dead || state.origin === null) {
    return {state, claims: false, offset: 0, cancelled: false};
  }

  const dx = input.point.x - state.origin.x;
  const dy = input.point.y - state.origin.y;

  if (state.claimed) {
    return {
      state,
      claims: true,
      offset: followY(dy, height),
      cancelled: false,
    };
  }

  // 문턱 안: 탭이거나 떨림이다. 아직 아무것도 정하지 않는다 — 다음 걸음이 정한다.
  if (Math.max(Math.abs(dx), Math.abs(dy)) <= CLAIM_SLOP_PT) {
    return {state, claims: false, offset: 0, cancelled: false};
  }

  // 문턱을 처음 넘은 순간 방향이 정해진다. 아래로 가고 세로가 가로보다 크면 가져가고,
  // 그 밖에는 이 손가락의 남은 일생 동안 뷰어의 일이 아니다.
  const claims = context.enabled && dy > CLAIM_SLOP_PT && dy > Math.abs(dx);
  if (!claims) {
    return {
      state: {...state, dead: true},
      claims: false,
      offset: 0,
      cancelled: false,
    };
  }
  return {
    state: {...state, claimed: true},
    claims: true,
    offset: followY(dy, height),
    cancelled: false,
  };
}

/**
 * 놓았을 때: 닫는가, 제자리로 돌아가는가.
 *
 * `offset` 은 터치를 처음 댄 점에서 잰 아래쪽 거리(pt), `velocityPtPerMs` 는
 * `PanResponder` 의 `gestureState.vy` 그대로(px/ms)다. 둘 중 **하나라도** 문턱을
 * 넘으면 닫는다(Buzz `dragOffset > threshold || velocity > dismissVelocity`).
 */
export function settles(args: {
  offset: number;
  velocityPtPerMs: number;
}): 'dismiss' | 'snap' {
  if (args.offset > DISMISS_DISTANCE_PT) return 'dismiss';
  if (args.velocityPtPerMs * MS_PER_S > DISMISS_VELOCITY_PT_PER_S) return 'dismiss';
  return 'snap';
}

// ---- 끄는 동안의 모양: 한 값(`offset`)에서 파생하는 세 곡선 ----------------------
//
// `Animated.Value.interpolate` 가 그대로 먹는 모양(`inputRange`·`outputRange`)으로 적고,
// 시험은 {@link evaluate} 로 같은 표를 읽는다. 표가 한 군데라 화면과 시험이 어긋나지 않는다.
// 모두 `extrapolate: 'clamp'` 로 쓴다(표 밖에서는 끝 값).

export interface Stops {
  inputRange: [number, number];
  outputRange: [number, number];
}

/** 뷰어 바닥(`bg`)의 불투명도: 1 → 0.3 (210pt 에서 바닥, 이후 그대로). */
export function backdropStops(): Stops {
  return {
    inputRange: [0, BACKDROP_FADE_DISTANCE_PT * (1 - BACKDROP_MIN_OPACITY)],
    outputRange: [1, BACKDROP_MIN_OPACITY],
  };
}

/** 위쪽 단추 띠의 불투명도: 1 → 0 (160pt 에서 사라진다). */
export function chromeStops(): Stops {
  return {inputRange: [0, CHROME_FADE_DISTANCE_PT], outputRange: [1, 0]};
}

/** 사진의 크기: 1 → 0.9 (화면 높이만큼 끌었을 때). */
export function scaleStops(height: number): Stops {
  return {
    inputRange: [0, Math.max(1, height)],
    outputRange: [1, 1 - SHRINK_AT_BOTTOM],
  };
}

/** 표를 읽는다: 두 점 사이는 선형, 밖은 끝 값(`extrapolate: 'clamp'`). */
export function evaluate(stops: Stops, x: number): number {
  const [x0, x1] = stops.inputRange;
  const [y0, y1] = stops.outputRange;
  if (x <= x0) return y0;
  if (x >= x1) return y1;
  return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}
