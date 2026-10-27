import {SHEET, type Palette} from './tokens';

// =============================================================================
// 시트의 규칙 — **판정만**. 배선은 `PageSheet.tsx`·`sheetParts.tsx` 다 (#4318).
//
// `nav/edgeSwipe.ts` 와 같은 이유로 갈라 둔다: 규칙이 터치 핸들러와 Animated 값에 붙어 있으면
// 시험이 재생할 수 없고, 재생할 수 없는 방어는 죽어도 아무도 모른다. 끌어 닫기의 문턱이 한 번
// 조용히 바뀌어도(`>` 가 `>=` 가 되거나 값이 두 배가 되어도) 아래 단정이 빨개진다.
// =============================================================================

/** 시안 `.a-sheet{top:58px}` — 상태 막대 바로 아래. 큰 단의 위 끝이다. */
export const SHEET_TOP = 58;

// ---- 끌어 닫기 (#4612) ------------------------------------------------------
//
// 어디를 잡고 내려도 닫히는 시트의 **판정**: 누가 끌기를 가져가는가(머리·본문, 스크롤 넘겨받기), 손가락을 어떻게
// 따라가는가(고무줄), 놓았을 때 닫는가(거리·속도), 스크림이 얼마나 옅은가. 배선(PanResponder·Animated)은
// `PageSheet.tsx` 다.

/** 끌기를 가져가는 문턱(pt). 이보다 덜 움직인 손가락은 탭이거나 떨림이다 — 여기서 가져가면 머리 단추의 탭이 죽는다. */
export const SHEET_CLAIM_SLOP = 6;

/**
 * 시트 **높이의 이 비율을 넘게** 끌어 내리고 놓으면 닫는다.
 *
 * 근거는 셋이고 서로 다른 종류다.
 *   - 이슈 #4612 수용기준: 「시트 높이의 약 25~30%」. 이 값의 **출처는 이것**(작성자가 정한 값)이고, 25% 는 그 범위의
 *     가벼운 쪽이다 — 이 이슈가 고치려는 불만이 「안 내려간다」이기 때문이다.
 *   - Buzz(Flutter): `showBuzzModalBottomSheet` 는 `showModalBottomSheet` 의 기본값을 그대로 쓴다.
 *     `_kCloseProgressThreshold = 0.5`(flutter `material/bottom_sheet.dart`) — 높이의 **절반**. 우리보다 두 배 엄격한 비교값이다.
 *   - iOS `UISheetPresentationController`: 문턱 값을 **공개하지 않는다.** 그래서 이 주석은 「iOS 값」을 지어내지 않는다.
 *     시스템 시트와 나란히 놓고 대조하는 일은 실기·시뮬레이터(2단계)의 몫이다.
 *
 * 알아 둘 것: 큰 단(16 Pro 에서 ≈808pt)은 25% 가 ≈200pt 라 천천히 끄는 길은 길다 — 그 길이 싫으면 튕긴다
 * ({@link SHEET_DISMISS_VELOCITY}). 큰 단의 체감은 실기 확인 전까지 `runtime-unverified` 다.
 */
export const SHEET_DISMISS_RATIO = 0.25;

/**
 * 작은 시트에서 손가락이 스치기만 해도 닫히지 않게 하는 바닥(pt). 눌림 영역(44)보다 크게, 머리 줄(52)보다 약간 크게 둔다.
 * 25% 가 이보다 작은 시트(높이 256 미만)에만 닿는다.
 */
export const SHEET_DISMISS_MIN_DISTANCE = 64;

/**
 * 이 속도(**px/ms**)보다 빠르게 내려 튕기면 거리가 모자라도 닫는다.
 *
 * 단위가 함정이다. RN `PanResponder` 의 `vy` 와 이 파일의 속도는 px/ms 이고, Flutter 의 상수는 px/s 다:
 * `_kMinFlingVelocity = 700.0`(px/s, `bottom_sheet.dart`) = 0.7 px/ms. Buzz 가 이 값 그대로다. 사진 뷰어
 * (`viewerDismiss.ts`)가 같은 Buzz 값 700px/s 를 쓴다 — 앱의 「튕겨 닫기」가 한 가지 느낌이다. 옛 값 1.1(= 1100px/s)은
 * 그보다 무거웠다.
 *
 * 이 값은 {@link releaseVelocity} 가 구한 속도와 짝이다: Flutter 도 마지막 한 구간이 아니라 100ms 창으로 속도를 잰다.
 */
export const SHEET_DISMISS_VELOCITY = 0.7;

/** 시트를 이만큼(pt) **넘게** 내려 놓아야 거리로 닫힌다. 높이는 시트가 실제로 선 높이다. */
export function sheetDismissDistance(sheetHeight: number): number {
  return Math.max(SHEET_DISMISS_MIN_DISTANCE, sheetHeight * SHEET_DISMISS_RATIO);
}

/**
 * 손을 뗐을 때 시트를 닫는가. 거리와 속도 **어느 한쪽**이면 닫고, 둘 다 모자라면 제자리로 돌아온다. 경계값 자체는
 * 닫지 않는다 — 「넘어야」 닫는다.
 *
 * **단, 위로 튕기며 놓았으면 거리와 무관하게 열어 둔다**(planner 결정, #4612 코멘트 「속도 방향이 이겨요」): 문턱을 넘게
 * 내려 놓고도 놓는 순간 위로 {@link SHEET_DISMISS_VELOCITY} 보다 빠르게 쳐올린 손가락은 「아니, 닫지 않는다」고 말한 것이다.
 * 그 말을 거리를 근거로 뒤집지 않는다 — 같은 저장소의 가로 뒤로가기(`nav/edgeSwipe.ts` `settles`)가 같은 규칙이다
 * (「되돌리는 방향으로 튕겼으면 거리와 무관하게 취소」). Buzz(Flutter `_handleDragEnd`)는 방향을 보지 않고 진행률만 봐서 이
 * 경우를 닫는다 — 그쪽과 갈리는 자리이고, 갈리는 이유는 위의 결정이다.
 *
 * 위로 튕김의 문턱은 닫는 쪽과 **같은 크기·같은 경계**다(대칭): 정확히 −0.7 은 튕김이 아니라 거리가 정한다. 문턱 안쪽의
 * 작은 위쪽 속도(손가락 떨림)는 거리 판정을 뒤집지 못한다 — 천천히 내려 놓은 손이 떨렸다고 안 닫히면 이 이슈의 불만(안 내려간다)이
 * 되살아난다.
 *
 * @param offset 시트가 가 있는 곳(pt, 아래가 양수). 손가락이 아니라 **시트**의 이동이다(고무줄은 음수).
 * @param velocity 놓는 순간의 아래쪽 속도(px/ms). 위로 튕기면 음수다.
 * @param sheetHeight 시트가 실제로 선 높이(pt).
 */
export function shouldDismissSheet(offset: number, velocity: number, sheetHeight: number): boolean {
  if (velocity < -SHEET_DISMISS_VELOCITY) return false;
  return offset > sheetDismissDistance(sheetHeight) || velocity > SHEET_DISMISS_VELOCITY;
}

/**
 * 시트가 미끄러져 서고 나가는 기본 길이(ms). X·스크림·VoiceOver escape·행동 누름·끌기를 시작 때 속도 없이 놓은 닫기가 쓰고,
 * 놓고 닫는 슬라이드({@link releaseSlideMs})의 **상한**이다 — 천천히 놓은 끌기는 전과 같은 길이로 나간다.
 */
export const SHEET_SLIDE_MS = 260;

/**
 * 놓고 닫는 슬라이드의 **하한**(ms). 모션 사다리 `instant`(120ms — `docs/design-system/README.md` 모션 표, 폰 사다리는 웹과 값이
 * 같다)다. 아주 빠른 튕김이 이보다 짧아지면 시트가 나가는 것이 아니라 끊겨 사라진다. 사다리 밖의 값을 지어내지 않고 한 칸을
 * 골랐다.
 */
export const SHEET_RELEASE_MIN_MS = 120;

/**
 * 손가락을 **놓고** 닫을 때 시트가 남은 거리를 미끄러져 나가는 시간(ms) — 놓은 속도를 이어 간다(planner 결정: 속도 기반
 * 지속 시간, 상하한). 남은 거리를 놓은 속도로 가는 데 걸리는 시간 `remaining / velocity` 를
 * [{@link SHEET_RELEASE_MIN_MS}, {@link SHEET_SLIDE_MS}] 로 가둔다. 이 길이와 짝인 곡선(`motion.ts` `FLING_OUT`)은 시작
 * 기울기가 1 이라, 시작 속도가 정확히 놓은 속도가 된다.
 *
 *   · 빠르게 쳐서 놓으면 그 속도로 나간다 → 짧다(하한까지). 튕긴 손가락 뒤에서 시트가 굼뜨게 따라 나가지 않는다.
 *   · 느리게 놓았거나 속도가 없으면(거리로만 닫은 끌기·멈췄다 놓음) 속도를 이을 것이 없으니 기본 길이다.
 *   · 속도를 모르는 값(NaN)·위쪽 속도는 이을 속도가 아니다 → 기본 길이. 남은 거리가 없거나 모르면 하한이다.
 *
 * @param remaining 시트가 나가야 할 남은 거리(pt, 양수). 슬라이드의 목적지 − 놓은 자리다.
 * @param velocity 놓는 순간의 아래쪽 속도(px/ms, {@link releaseVelocity}).
 */
export function releaseSlideMs(remaining: number, velocity: number): number {
  if (!(velocity > 0)) return SHEET_SLIDE_MS;
  if (!(remaining > 0)) return SHEET_RELEASE_MIN_MS;
  return Math.round(Math.min(SHEET_SLIDE_MS, Math.max(SHEET_RELEASE_MIN_MS, remaining / velocity)));
}

/** 시트가 위로 늘어나는 상한(pt). 시트 바닥 밑에 이만큼의 바탕을 깔아(`PageSheet`) 틈이 보이지 않게 한다. */
export const SHEET_RUBBER_MAX = 24;

/**
 * iOS `UIScrollView` 고무줄 식: `(1 − 1 / (x·c/d + 1)) · d`, c = 0.55. 널리 쓰이는 **역공학 값**이지 Apple 이 공개한
 * 식이 아니다. d 를 {@link SHEET_RUBBER_MAX} 로 두어 아무리 당겨도 그 위로 가지 않는다(점근선).
 */
export function rubberBand(distance: number): number {
  if (!(distance > 0)) return 0;
  return (1 - 1 / ((distance * 0.55) / SHEET_RUBBER_MAX + 1)) * SHEET_RUBBER_MAX;
}

/**
 * 끌기가 시작된 뒤 손가락이 `dy` 만큼 움직였을 때 시트가 가 있을 곳(pt, 아래가 양수).
 * 아래로는 **1:1**(손가락 이동 = 시트 이동), 위로는 고무줄 저항이다.
 *
 * 끌기를 가져가는 앞의 {@link SHEET_CLAIM_SLOP} 만큼은 흡수된다(UIScrollView 가 첫 문턱을 삼키는 것과 같다):
 * 시트가 처음 움직일 때 튀지 않고, 대신 손가락이 시트보다 그만큼 앞서 있다.
 */
export function sheetFollow(dy: number): number {
  return dy >= 0 ? dy : -rubberBand(-dy);
}

/** 이 이하(pt)면 스크롤이 맨 위다. iOS 는 소수 픽셀 위에서 쉬기도 한다. */
export const SCROLL_TOP_EPSILON = 1;

/** 스크롤이 맨 위인가. 모르는 값(NaN)은 맨 위가 **아니다** — 모르면 본문이 스크롤하게 둔다(fail-closed). */
export function isScrolledToTop(offsetY: number): boolean {
  return offsetY <= SCROLL_TOP_EPSILON;
}

/** 내용이 뷰포트보다 이 이하(pt)로만 크면 넘치지 않은 것이다 — `SheetScroll` 의 「잘림 단서」·사진 카드의 문턱과 같은 1pt 다. */
export const SCROLL_FIT_SLACK = 1;

/**
 * 스크롤이 **실제로 스크롤될 수 있는가**(내용이 뷰포트를 넘치는가). 크기를 아직 모르면(레이아웃 전·알리지 않는 스크롤) **넘친다고 본다**
 * — 모르면 스크롤을 막지 않는 쪽이 안전하다(fail-closed, `claimsSheetTouchStart` 가 이 값으로 본문의 시작 응답자를 정한다).
 */
export function scrollOverflows(contentHeight: number, viewportHeight: number): boolean {
  if (!(viewportHeight > 0) || !(contentHeight >= 0)) return true;
  return contentHeight > viewportHeight + SCROLL_FIT_SLACK;
}

/** 손가락이 닿은 곳: 머리(손잡이·제목 줄)는 늘 시트의 것이고, 본문은 스크롤이 맨 위일 때만이다. */
export type DragZone = 'header' | 'body';

/**
 * 터치가 **시작되는 순간** 시트의 끌기 응답자가 응답자를 잡는가(`onStartShouldSetPanResponder` 의 판정).
 *
 * 이동 시점에 가져가는 길(`claimsSheetDrag`)만으로는 **시트가 안 끌린다** — 시뮬레이터가 잡았다(#4612 2단계, jest 는 응답자 플러그인을
 * 건너뛰어 못 잡는다). 이유는 둘이 겹친다.
 *   · RN `Modal` 은 시작 터치에서 스스로 응답자를 쥔다(`Modal.js` `_shouldSetResponder` → `true`, 「응답자 이벤트가 모달 밖으로 새지 않게」).
 *     그래서 시작 터치를 후손(Pressable·TextInput)이 잡지 않았으면 응답자는 **Modal 호스트**다.
 *   · 응답자 플러그인은 이동마다 「현재 응답자의 조상」에게만 가로채기를 묻는다(응답자 자신과 그 후손은 건너뛴다). 시트는 Modal 의
 *     후손이라, 응답자가 Modal 호스트인 터치에서는 시트의 `onMoveShouldSet…` 가 **한 번도 불리지 않는다.**
 * 그 결과 머리·손잡이·본문의 눌리지 않는 자리에서 시작한 끌기는 시트에 닿지 않았고, 목록 행처럼 Pressable 이 먼저 응답자가 된 터치만 시트가
 * (조상으로서) 가로챌 수 있었다. 해법은 시트가 **시작에서** 응답자를 잡는 것이다 — 시작 응답자는 버블 순서상 Modal 호스트보다 먼저다.
 *
 *   · 머리(손잡이 띠·제목 줄): 늘 잡는다. 눌리지 않는 자리라 탭은 어차피 할 일이 없다. 단추(X·✓) 위에서 시작한 터치는 단추가 먼저
 *     잡고, 시트는 이동에서 가로챈다(`claimsSheetDrag`) — 그 눌림이 취소된다.
 *   · 본문: **스크롤이 맨 위이고, 스크롤이 실제로 스크롤되지 않을 때만**(내용이 뷰포트에 들어갈 때만) 잡는다. 스크롤이 중간이면 잡지 않아
 *     Modal 호스트가 쥐던 옛 그대로이고 스크롤과 아무 간섭이 없다 — 「스크롤 중 끌기는 시트가 안 움직인다」가 구조로 보장된다.
 *   · 닫는 중에는 잡지 않는다(슬라이드를 끊으면 행동이 앞당겨 불린다).
 *
 * **왜 내용이 넘치면 본문은 잡지 않는가**(시뮬레이터가 잡은 둘째 결함, #4612 2단계): 시작 응답자는 본문 뿌리 `View` 이고 그것은 스크롤 뷰의
 * **조상**이다. iOS(Fabric)는 스크롤 뷰의 조상 중 하나라도 JS 응답자이면 그 터치의 네이티브 스크롤을 **시작도 못 하게** 막는다
 * (`RCTScrollViewComponentView` `_shouldDisableScrollInteraction` → `touchesShouldCancelInContentView:` NO). `onResponderGrant` 의 반환값
 * (`onShouldBlockNativeResponder`)은 iOS 에서 버려져서(`RCTMountingManager` 가 `blockNativeResponder` 를 쓰지 않는다) 고칠 수 없다.
 * 그래서 맨 위에서 눌리지 않는 자리를 짚고 위로 올리는 스크롤이 통째로 죽었다(실측: 같은 쓸기에서 스크롤 표본 0 ↔ 응답자를 끄면 91).
 * 내용이 뷰포트에 들어가면 스크롤할 것이 없으니 막혀도 잃는 것이 없다 — 짧은 시트(행동 시트·편집 시트)는 본문 어디서든 끌린다.
 * 내용이 넘치는 시트는 머리와, 행·단추처럼 후손이 먼저 응답자가 되는 자리(시트가 이동에서 가로챈다)에서 끌린다. 눌리지 않는 본문 자리의
 * 끌기는 **알려진 한계**다(스크롤과 끌기의 중재는 네이티브 제스처 인식기의 일이다 — gesture-handler 평가 #4645).
 *
 * 잡는다고 끌리는 것은 아니다: 잡은 응답자는 **얌전히 기다리다가**(armed) 이동이 `claimsSheetDrag` 의 조건을 채울 때 비로소 시트를 움직인다.
 */
export function claimsSheetTouchStart(args: {
  zone: DragZone;
  closing: boolean;
  scrollOffsets: readonly number[];
  /** 등록된 스크롤 중 내용이 넘치는(또는 크기를 아직 모르는) 것이 하나라도 있는가 — `scrollOverflows`. */
  scrollsOverflow: boolean;
}): boolean {
  if (args.closing) return false;
  if (args.zone === 'header') return true;
  if (args.scrollsOverflow) return false;
  return args.scrollOffsets.length > 0 && args.scrollOffsets.every(isScrolledToTop);
}

/**
 * 이 이동으로 시트가 끌기를 가져가는가(`onMoveShouldSetPanResponderCapture` 의 판정).
 *
 *   · 닫는 중이 아니다(슬라이드가 끊기면 행동이 앞당겨 불린다)
 *   · 손가락이 하나다
 *   · **아래로** 문턱({@link SHEET_CLAIM_SLOP})을 넘었고 세로가 가로보다 크다(가로 스와이프는 가져가지 않는다)
 *   · 본문이면 — 등록된 세로 스크롤이 **하나 이상** 있고 **모두** 맨 위다.
 *
 * 마지막 조건이 스크롤 넘겨받기다: 스크롤이 중간이면 본문이 스크롤하고, 맨 위일 때 아래로 끌면 시트가 따라온다.
 * 등록된 스크롤이 **없으면 가져가지 않는다**(fail-closed): 본문의 스크롤이 시트에 알려지지 않은 채(날 `FlatList`) 가져가면,
 * 목록을 위로 되감던 손가락이 시트를 끌어 내리는 회귀가 생긴다. 알려진 것만 가져간다.
 */
export function claimsSheetDrag(args: {
  zone: DragZone;
  dx: number;
  dy: number;
  touches: number;
  closing: boolean;
  scrollOffsets: readonly number[];
}): boolean {
  if (args.closing || args.touches !== 1) return false;
  if (!(args.dy > SHEET_CLAIM_SLOP) || !(Math.abs(args.dy) > Math.abs(args.dx))) return false;
  if (args.zone === 'header') return true;
  return args.scrollOffsets.length > 0 && args.scrollOffsets.every(isScrolledToTop);
}

/** 끌기 도중의 한 표본: 위치(pt)와 시각(ms). 시각은 터치 이벤트의 `timestamp` 다. */
export interface DragSample {
  y: number;
  t: number;
}

/** 속도를 재는 창(ms). Flutter `VelocityTracker._horizonMilliseconds`. */
export const VELOCITY_HORIZON_MS = 100;
/** 이보다 오래 멈췄다 놓으면 속도는 0 이다(ms). Flutter `_assumePointerMoveStoppedMilliseconds`. */
export const VELOCITY_STOPPED_MS = 40;
/** 속도를 믿으려면 필요한 표본 수. Flutter `_minSampleSize`. */
export const VELOCITY_MIN_SAMPLES = 3;

/**
 * 놓는 순간의 속도(px/ms, 아래가 양수).
 *
 * 왜 `PanResponder` 의 `vy` 가 아닌가: 그 값은 **마지막 move 한 구간**의 속도이고 놓을 때 다시 구하지 않는다
 * (RN `PanResponder.js` `_updateGestureStateOnMove`). 그래서 (1) 멈췄다 놓아도 마지막 구간의 속도가 남아 튕김으로 읽히고,
 * (2) 이벤트가 몰려 와 구간이 1~2ms 면 1pt 떨림이 1px/ms 가 된다. Flutter 의 `VelocityTracker` 는 그래서 창으로 잰다 —
 * 같은 규칙: 마지막 표본이 놓은 때보다 40ms 넘게 전이면 0, 마지막 표본에서 100ms 안(표본 사이가 40ms 이하로 이어진 것만)의
 * 표본 3개 이상으로 속도를 구한다. Flutter 는 2차 곡선을 맞추고 우리는 **1차(최소제곱 기울기)** 다 — 단순화이고, 두
 * 값의 감각 차이는 2단계 실기 확인이다.
 */
export function releaseVelocity(samples: readonly DragSample[], releaseAt: number): number {
  const newest = samples[samples.length - 1];
  if (newest === undefined) return 0;
  if (releaseAt - newest.t > VELOCITY_STOPPED_MS) return 0;
  const recent: DragSample[] = [newest];
  for (let i = samples.length - 2; i >= 0; i--) {
    const sample = samples[i];
    const next = recent[recent.length - 1];
    if (newest.t - sample.t > VELOCITY_HORIZON_MS || next.t - sample.t > VELOCITY_STOPPED_MS) break;
    recent.push(sample);
  }
  if (recent.length < VELOCITY_MIN_SAMPLES) return 0;
  const n = recent.length;
  const meanT = recent.reduce((sum, s) => sum + s.t, 0) / n;
  const meanY = recent.reduce((sum, s) => sum + s.y, 0) / n;
  let covariance = 0;
  let variance = 0;
  for (const s of recent) {
    covariance += (s.t - meanT) * (s.y - meanY);
    variance += (s.t - meanT) ** 2;
  }
  return variance === 0 ? 0 : covariance / variance;
}

/**
 * 스크림(배경)의 불투명도. 시트가 `travel`(pt) 내려간 만큼 **비례해** 옅어지고, 시트가 제 높이만큼 내려가 화면을 나가는
 * 순간 0 이다. 고무줄로 위로 늘어난 때(음수)는 더 짙어지지 않는다.
 *
 * 화면 높이가 아니라 **시트 높이**로 나눈다: 짧은 시트를 화면 높이로 나누면 시트가 다 나가도록 스크림이 거의 그대로다.
 * `PageSheet` 의 `Animated` 보간은 같은 두 점(`[0, 높이] → [1, 0]`)을 쓴다.
 */
export function scrimOpacity(travel: number, sheetHeight: number): number {
  if (!(sheetHeight > 0)) return 1;
  return Math.min(1, Math.max(0, 1 - travel / sheetHeight));
}

/**
 * 시트가 실제로 선 높이를 아직 재지 못했을 때의 어림(pt): 큰 단은 위 끝에서 바닥까지, 중간 단은 고정 높이, 내용 맞춤은
 * 그 위 끝(상한). 레이아웃 이벤트가 오면 잰 값이 이긴다. 시험이 레이아웃 없이도 같은 답을 내게 하는 값이기도 하다.
 */
export function estimatedSheetHeight(frame: SheetFrame, windowHeight: number): number {
  if (frame.top !== undefined) return Math.max(0, windowHeight - frame.top);
  return frame.height ?? frame.maxHeight ?? windowHeight;
}

/** 내용 맞춤 · 중간 · 큰. 시트가 얼마나 화면을 차지하는가. */
export type SheetHeight = 'fit' | 'medium' | 'large';

/** 시트 상자의 세로 배치. 아래는 화면 바닥에 붙고, 키보드가 올라와 있으면 키보드 윗면에 붙는다. */
export interface SheetFrame {
  /** 큰 단: 위 끝 고정. */
  top?: number;
  /** 중간 단: 높이 고정(목록이 걸러져도 시트가 뛰지 않는다). */
  height?: number;
  /** 내용 맞춤 단: 내용 높이, 이 위로는 안에서 스크롤. */
  maxHeight?: number;
  /** 키보드가 올라와 있을 때만 있다: 시트의 바닥이 화면 바닥에서 이만큼(= 키보드 높이) 떠 있다. */
  bottom?: number;
}

/**
 * 큰 단이 시작하는 위 끝(화면 위에서 pt). 상태 막대가 58보다 깊은 기기(다이내믹 아일랜드)에서는 그
 * 아래 4pt — 58 은 시안 기기(상태 막대 54)의 값이라 그 위에 올리면 시계와 겹친다. 키보드로 올라온
 * 시트도 이 선을 넘지 않는다(머리의 X 가 시계 뒤로 들어가면 닫을 수 없다).
 */
export function sheetTop(insetTop: number): number {
  return Math.max(SHEET_TOP, insetTop + 4);
}

/**
 * 단계별 상자.
 *
 *   large   위 58 에서 바닥까지.
 *   medium  화면의 9/16(Buzz). 고정 높이.
 *   fit     내용 높이, 화면의 85% 위로는 안에서 스크롤. 배경 탭으로 닫는 길이 그 나머지로 남는다.
 *
 * ## 키보드 (`keyboardHeight` > 0) — **중간·내용 맞춤 단만** 올린다
 *
 * 시트의 **바닥이 키보드 윗면에 앉는다**(`bottom` = 키보드 높이). 그러면 시트 안의 입력 칸은 시트 바닥보다
 * 아래일 수 없으니 키보드 위에 있다. 시트가 위로 자라지는 못하게 막는다: 높이(최대 높이)를 「키보드 위 ~ 큰 단의
 * 위 끝」 사이(`room`)로 줄인다(SE 에서는 9/16 = 375 의 중간 단이 키보드 260 위의 칸 349 로 줄어든다).
 * 키보드가 없으면(0) 옛 상자 그대로다 — `bottom` 은 아예 없고, 그릇의 `bottom: 0` 이 그 자리를 지킨다.
 *
 * **큰 단은 올리지 않는다.** 큰 단의 몸은 스크롤이고 입력이 있는 큰 단은 이미 제 키보드 처리를 갖는다
 * (`automaticallyAdjustKeyboardInsets` — 작업 맡기기·맥에 보내기). 거기에 시트 바닥까지 올리면 RN 이 알림 순간의
 * 위치로 잡은 인셋이 시트가 올라간 뒤에도 남아 같은 키보드를 두 번 피한다(코드 검수 #4318 M1). 큰 단 시트를
 * 옮기는 #4458 이 시트마다 정한다.
 */
export function sheetFrame(
  height: SheetHeight,
  windowHeight: number,
  insetTop: number,
  keyboardHeight = 0,
): SheetFrame {
  const top = sheetTop(insetTop);
  if (height === 'large') return {top};
  const lift = keyboardHeight > 0 ? {bottom: keyboardHeight} : {};
  const room = Math.max(0, windowHeight - keyboardHeight - top);
  switch (height) {
    case 'medium':
      return {
        height: Math.min(Math.floor(windowHeight * SHEET.mediumRatio), room),
        ...lift,
      };
    case 'fit':
      return {
        maxHeight: Math.min(Math.floor(windowHeight * SHEET.fitMaxRatio), room),
        ...lift,
      };
  }
}

/** 카드 안의 앞 칸: 없음 · 아이콘 칸(22) · 그보다 넓은 앞 요소(아바타)의 폭. */
export type CardInset = 'plain' | 'icon' | number;

/**
 * 구분선이 카드 왼쪽에서 얼마나 들어가 시작하는가. 앞 칸이 있는 카드는 그 칸을 비켜 글자 열에
 * 맞추고(Buzz `AppListCard._dividerIndent`), 없는 카드는 카드 안쪽 여백에 맞춘다.
 */
export function dividerIndent(inset: CardInset): number {
  if (inset === 'plain') return SHEET.cardInset;
  const lead = inset === 'icon' ? SHEET.iconSlot : inset;
  return SHEET.cardInset + lead + SHEET.iconGap;
}

/** 목록의 한 줄이 묶음 카드에서 어디에 서는가 — 바깥 모서리와 구분선이 이것으로 갈린다. */
export type CardPosition = 'only' | 'first' | 'middle' | 'last';

export function cardPosition(index: number, count: number): CardPosition {
  if (count <= 1) return 'only';
  if (index <= 0) return 'first';
  if (index >= count - 1) return 'last';
  return 'middle';
}

/**
 * 원형 단추의 채움과 가장자리 — 「떠 있다」는 것의 토큰 근거.
 *
 * 라이트의 원은 `surface` 가 바탕 `sheet` 위에 서고 `elevationRest` 그림자가 띄운다. 다크에서는
 * 그림자가 보이지 않는다(`tokens.ts` `DARK_ELEVATION` 주석: 따뜻한 그림자는 어두운 바닥 위에서
 * 사라진다). 게다가 다크의 `surface` 는 `sheet` 와 새벽하늘 1.076 · 흑연 1.035 로 **라이트의
 * 1.109 · 1.083 보다 덜 갈린다**. 그래서 다크는 한 단 위 `surfaceMuted`(1.234 · 1.119)로 채우고
 * 윗면의 가장자리 한 줄(`glassLine`)을 더한다. 관계(다크의 원이 라이트의 원보다 바탕에서 덜
 * 구분되지 않는다)는 값이 아니라 시험이 모든 테마에서 잰다(`sheetKit.test.tsx`).
 */
export function circleLook(color: Palette): {fill: string; ring: string} {
  return color.mode === 'dark'
    ? {fill: color.surfaceMuted, ring: color.glassLine}
    : {fill: color.surface, ring: 'transparent'};
}

/** 묶음 카드의 가장자리. 라이트는 채움 차이로 충분하고, 다크는 그림자가 없으니 가는 선(`border`)이 가른다. */
export function cardRing(color: Palette): string {
  return color.mode === 'dark' ? color.border : 'transparent';
}
