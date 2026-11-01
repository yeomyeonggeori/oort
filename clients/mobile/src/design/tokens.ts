// =============================================================================
// The v0 shell's visual constants.
//
// These are not a new palette. They are the values `ConnectScreen` already shipped
// with in goal RN-C2, lifted out of that one file so the four screens this batch
// adds cannot each invent a slightly different grey. Nothing here is a guess about
// what the product should look like — that conversation belongs with 성재 and the
// design-taste skills, neither of which has an RN dialect yet.
//
// Two values below are NOT taste, they are constraints, and they are the reason
// this file exists rather than a handful of inline hex strings:
//
//   TOUCH_TARGET   44. The iOS HIG minimum, and the number every row, tab and
//                  button in this batch is measured against. A 32px row looks
//                  right in a screenshot and is missed by a thumb.
//   SAFE_GUTTER    the horizontal padding every screen shares, so that nothing
//                  in this app can produce a horizontal scroll — a list whose
//                  rows are 16px inset on one side and 24px on the other is how
//                  that starts.
// =============================================================================

import {
  contrast,
  fromOklch,
  mixOklab,
  normalizeHex,
  toOklch,
} from '@momo/core/design/color';
import {ELEVATION, GLASS_FALLBACK_OPACITY} from '@momo/core/design/themes';
import {DEFAULT_THEME_ID, ds2Roles, type Mode, type ThemeModeTokens} from './ds2Tokens';
import type {ThemeRef} from '@momo/core/design/themeResolve';
import {isThemeId} from '@momo/core/design/themes';
import {phoneThemeMode} from './themeCatalog';
import type {SignalValues} from '@momo/core/design/signal';
import {
  BACKDROP_SCRIM_ALPHA,
  FIT_MARGIN,
  NON_TEXT_MIN_ON_BACKDROP,
  TEXT_MIN_ON_BACKDROP,
  fitForeground,
  scrimColor,
  worstCaseBackdrops,
  minimumScrimAlpha,
  INK_MIN_ON_BACKDROP,
} from '@momo/core/design/scrim';

/** iOS HIG minimum tappable edge, in points. Not negotiable per-screen. */
export const TOUCH_TARGET = 44;

/** Shared horizontal inset. One number, so no two surfaces disagree. */
export const SAFE_GUTTER = 16;

/**
 * 컴포저 첨부 트레이가 차지할 수 있는 최대 높이.
 *
 * 웹의 같은 첨부 트레이 측정 `--spacing-tray-max`와 240으로 짝을 이룬다. 행 수를
 * `TOUCH_TARGET`에서 곱해 얻은 값이 아니라, 컴포저가 대화를 먹지 않게 제한하고
 * 초과분을 스크롤로 알리는 두 표면의 공용 상한이다 (#1703).
 */
export const ATTACHMENT_TRAY_MAX_HEIGHT = 240;

/**
 * 첨부의 Buzz 식 이미지 측정 (#3820). 웹 `--spacing-inline-image-*` 와 같은 뜻의 짝이되
 * 폰 폭에 맞춰 줄였다: 한 장은 폭 280 · 높이 320 안에서 비율을 지키고, 격자 타일은
 * 정사각(둘 이상 136, 5장부터 88)이다. 칩 썸네일은 웹 `--spacing-tray-thumb`(64)와
 * 같은 값이다.
 */
export const ATTACHMENT_INLINE_IMAGE = {
  maxWidth: 280,
  maxHeight: 320,
  tile: 136,
  tileSmall: 88,
} as const;
export const ATTACHMENT_CHIP_THUMB = 64;

/**
 * 콘텐츠 상자 한 변을 `TOUCH_TARGET` 으로 채우는 `hitSlop` 값 (감사 M-14).
 *
 * ## 왜 함수인가 — 6·6·4·4 가 어떻게 29pt 가 되었나
 *
 * 이 앱의 누를 것들은 두 규율 중 하나를 따르고 있었다. 큰 것은 `minHeight:
 * TOUCH_TARGET` 을 깔고 앉고(시트·버튼), 작은 것은 「높이를 올리면 줄이 두꺼워
 * 진다」는 이유로 `hitSlop` 으로 44 를 만든다(반응 칩·코드 복사). 후자가 옳은
 * 거래인데, 슬롭 숫자를 **손으로 적어 놓아서** 그 산수를 아무도 다시 확인하지
 * 않았다: `↳ 답글`(12pt 한 줄 ≈ 17pt)에 위아래 6 을 얹으면 29pt 다. 44 가 아니다.
 * 감사가 넷을 셌다 — 답글 표식 29 · 스레드 롤업 29 · 행 오류 닫기 33 · 반응 칩은
 * 세로만 44 이고 가로 미보증.
 *
 * 그래서 슬롭은 이제 **콘텐츠 크기에서 도출된다.** 호출부는 자기 상자의 변 길이를
 * 말하고 44 는 이 함수가 진다. 산수가 한 자리에 있으면 `TOUCH_TARGET` 이 바뀌어도
 * 같이 움직이고, 무엇보다 **테스트가 셀 수 있다** —
 * `__tests__/conversationHygiene.test.tsx` 가 실제 렌더 트리에서 슬롭을 읽어
 * 상자와 더한다.
 *
 * 올림인 이유: 17 은 홀수라 (44−17)/2 = 13.5 다. 반으로 나눈 실수를 그대로 쓰면
 * 두 변의 합이 44 에 1pt 못 미치는 반올림이 어디선가 일어난다. 넘치는 쪽으로 1pt
 * 트는 비용은 0 이고, 모자라는 쪽의 비용은 손가락이 옆 메시지를 누르는 것이다.
 */
export function slopTo(size: number): number {
  return Math.max(0, Math.ceil((TOUCH_TARGET - size) / 2));
}

// =============================================================================
// 팔레트 — 두 스킴, 하나의 역할표, 원천은 core (ADR-0189 D5, DS2-2 #2714).
//
// 이 파일은 한때 웹 `tokens.css`(ADR-0174 여명 값)를 역할로 **번역한** 두 상수를
// 들었고, `paletteContrast.test.ts`가 그 CSS를 읽어 바이트로 맞췄다. 디자인 시스템
// 2.0에서 원천이 core 한 곳으로 모였다(`packages/momo-core/src/design/themes.ts`).
// 이제 두 팔레트는 손으로 적은 값이 아니라 core 표 **새벽하늘**(`dawnsky`, 기본
// 테마)의 두 모드에서 만들어진다. 웹을 거치지 않는다.
//
// ## 역할 대응
//
// 폰의 역할 이름은 그대로 두고(30개 파일의 `buildStyles`가 이 이름을 읽는다), 값의
// 출처만 core 역할로 바꾼다. 대응표는 `DS2_ROLE_MAP`에 **값으로** 있고, 시험이 같은
// 표를 읽어 core와 대조한다:
//
//   bg ← canvas-mid        surface ← surface          surfacePressed ← surface-pressed
//   border ← line          text ← ink                 textMuted ← ink-muted
//   textFaint ← line-strong
//   accent ← signal        accentText ← signal-text   accentSurface ← signal-soft
//   onAccent ← on-signal   agent ← agent              agentSurface ← agent-soft
//   warn ← warn            warnSurface ← warn-soft    danger ← danger
//   dangerSurface ← danger-soft                       dangerFill ← danger-fill
//   onDangerFill ← on-danger-fill                     ok ← ok     okSurface ← ok-soft
//   canvasTop/canvasBottom ← canvas-top/-bottom       surfaceMuted ← surface-muted
//   sheet ← sheet   icon ← icon   primary ← primary   onPrimary ← on-primary
//   glass ← glass   scrim ← scrim
//
// `accent`가 `signal`을 받는 것은 ADR-0189 D6의 이행 규칙 그대로다: 하나의
// `--accent`가 주 행동과 신호를 겸하던 것을 둘로 나누고, 이행 중에는 `accent`를
// `signal`의 별칭으로 둔다. 주 행동은 새 역할 `primary`(잉크)다.
//
// ## core에 짝이 없는 역할은 관계로 푼다 (발명 금지)
//
// `accentPressed`·`accentSurfaceStrong`·`warnBorder`·`dangerBorder`·`okBorder`·
// `dangerText`·`onWarn`은 core 표에 없다. 값을 손으로 고르지 않고 아래
// `derive*` 함수가 표의 값에서 계산한다 — 테마를 바꾸면 같이 움직인다:
//
//   accentPressed        signal의 색상각·채도 그대로, 명도 −0.0887(여명 때 두 스킴이
//                        같은 역할에 쓰던 걸음)
//   accentSurfaceStrong  signal-soft에서 signal 쪽으로 OKLab 25%
//   *Border              자기 soft에서 자기 tone 쪽으로 OKLab 35% — 채움보다 진하고
//                        tone보다 조용한, 채움을 끝내는 선
//   dangerText           danger에서 ink 쪽으로 OKLab 30% — 상자 안 문장은 상자 밖
//                        표식보다 한 단 더 읽힌다
//   onWarn               warn 채움 위에서 on-primary와 ink 중 대비가 큰 쪽(core가
//                        `on-danger-fill`을 고르는 규칙과 같다)
//
// 관계는 `paletteContrast.test.ts`가 두 스킴에서 같은 자로 잰다.
// =============================================================================

/**
 * 이 앱이 아는 색 역할의 전부. 두 팔레트가 **같은 키를 전부** 갖는다는 사실을
 * 타입이 진다 — 한쪽에만 있는 색은 컴파일되지 않는다.
 */
export interface Palette {
  /**
   * 이 팔레트가 서 있는 모드(라이트·다크). 색이 아니라 **분기용 사실**이다 — 모드마다
   * 갈라지는 몇 안 되는 자리(대화 바닥의 두 번째 정지점)가 팔레트 객체의 동일성을
   * 비교하던 것을 이 값으로 바꾼다. 테마가 셋이 되면서 「라이트 팔레트」는 하나가
   * 아니다.
   */
  mode: Mode;
  /**
   * 바닥이 **무엇 위에** 서는가 — `canvas`(기본, 테마의 그라데이션 바닥)와 `image`(사용자
   * 배경 뒤에 깔린 scrim, ADR-0189 증보 2). `image` 일 때 홈·대화의 바닥 스타일은 자기
   * 그라데이션과 불투명 채움을 걷고 `AppBackground` 가 바닥을 그린다. 글자 역할 색은
   * 이미 scrim 최악 합성 위 대비로 보정돼 있다(`paletteFrom` 의 `onImage`).
   */
  backdrop: 'canvas' | 'image';
  /**
   * scrim 면의 색 — 바닥색(`bg`)에 모드별 불투명도(`BACKDROP_SCRIM_ALPHA`)를 단 `#rrggbbaa`.
   * 사진·단색·그라데이션 **위에** 얹는다. 불투명도는 눈대중이 아니라 최악 입력(순흑·순백
   * 사진)에서 잉크 7:1 이 되는 최소값이다(`design/background/scrim.ts`).
   */
  backdropScrim: string;
  /** App background. */
  bg: string;
  /** Raised surface: cards, rows, the tab bar. 언제나 `bg` 보다 한 단 위다. */
  surface: string;
  /** A pressed surface, one step away from `surface` rather than a new hue. */
  surfacePressed: string;
  /** Hairlines and field borders. 배경 위에서 3:1 **아래** — 선이지 컨트롤이 아니다. */
  border: string;
  /** Primary body text. */
  text: string;
  /** Secondary text: labels, timestamps, the second line of a row. */
  textMuted: string;
  /**
   * Third-rank text: hints under a settled state, 그리고 인용의 규정선.
   *
   * 본문 AA(4.5)를 노리지 않는다 — 노리면 `textMuted` 와 같은 값이 된다. 대신
   * 웹이 컨트롤 테두리에 요구하는 **3:1** 을 지킨다(`--line-strong` 과 같은 자리).
   */
  textFaint: string;
  /**
   * 신호색(core `signal`) — 고른 것·안 읽음·경계·포커스 링. 커스텀 강조색(ADR-0174)이
   * 칠하는 것은 이 역할 계열(`accentText`·`accentSurface`·`onAccent`)이다.
   *
   * **주 버튼은 이 색이 아니다** — 주 행동은 `primary`(잉크)다. 옛 주석은 「the primary
   * button」이라 적었고 셸의 `PrimaryButton` 도 이 색이었다 — 같은 앱의 첫 화면·로그인·
   * 승인 알약(잉크)과 주 행동이 갈렸다(#5100).
   */
  accent: string;
  /** 눌린 accent 채움. */
  accentPressed: string;
  /** 배경 위에 **글자·글리프로** 서는 accent. 채움이 아니라 잉크다. */
  accentText: string;
  /**
   * accent 의 가장 부드러운 단. 내 반응 칩의 채움이 이 값이다 (감사 M-13).
   *
   * `surface`(중성 고도)와 뜻이 다르다: 이것은 **내가 참여했다**는 표시라 색을
   * 가진다. 칩이 서는 자리인 `surface` 위에서 다크 1.12:1 · 라이트 1.21:1.
   */
  accentSurface: string;
  /**
   * 같은 계열의 한 단 위. 검색 일치처럼 **찾아져야** 하는 강조에만 쓴다.
   *
   * 두 단을 두는 이유: `accentSurface` 는 이미 서 있는 칩을 물들이는 값이라
   * 조용해야 하고, 검색 일치는 사람이 눈으로 스캔해 찾아내야 하는 값이라
   * 조용하면 실패한다(`surface` 위 다크 1.36:1 대 1.12:1 · 라이트 1.41:1 대
   * 1.21:1). 웹의 `--line`/`--line-strong` 과 같은 종류의 쌍이다.
   */
  accentSurfaceStrong: string;
  /** accent 채움 위에 얹는 글자. */
  onAccent: string;
  /** Agent identity. Agents are members, and the product names them apart. */
  agent: string;
  /** 에이전트 태그의 채움 — `agent` 의 가장 부드러운 단. */
  agentSurface: string;
  /**
   * Something needs a person: unread counts, pending approvals.
   *
   * `accent` 와 같은 앰버 대역에 산다. 두 뜻(「여기를 보라」/「내가 한 것」)이 색으로
   * 얼마나 갈라지는지는 **웹이 정한다** — 두 값 다 웹 항이므로. 실측 색상각 차:
   * 다크 18.08° · 라이트 25.92°. 다크가 좁은 것은 웹 팔레트 자신의 성질이고
   * (`--warn` #d4a72c 대 `--accent` #f0a850), #1164 이전 폰 다크가 10.87° 로 그보다
   * 더 좁았던 것은 폰만의 결함이었다 (#1155 리뷰 N1).
   */
  warn: string;
  /**
   * 앰버의 가장 부드러운 단. 상태 칩(대기)의 채움이자 **인용 점프 착지 틴트**다
   * (#1076 — 색 선택 근거는 `MessageRow.tsx` 의 `rowLanded` 주석).
   */
  warnSurface: string;
  /** `warnSurface` 채움의 테두리. */
  warnBorder: string;
  /** 앰버 **채움** 위에 얹는 글자 — 멘션 배지의 숫자. */
  onWarn: string;
  /** A refusal or a failure. Never used for "not provided yet". */
  danger: string;
  dangerSurface: string;
  dangerBorder: string;
  /**
   * danger 상자 **안**의 글자 — `danger` 에서 배경 반대쪽으로 한 단 간 값.
   *
   * 상자 밖의 표식(「전송 실패」 한 낱말)과 상자 안의 문장(실패 사유 한 줄)은
   * 읽히는 시간이 다르다. 후자는 `dangerSurface` 위에서 다크 9.88:1 · 라이트
   * 7.59:1 이고 전자의 값(5.93 · 5.56)보다 위다 — 둘 다 AA 를 지나되 한 단 갈라 둔다.
   */
  dangerText: string;
  /**
   * 파괴 액션의 **채움** — 웹 `--danger-fill` (#1210 D2).
   *
   * `danger` 는 위험을 **말하는** 톤이고(글자·칩·점), 이것은 위험을 **실행하는**
   * 버튼의 바탕이다. 두 이름이 나뉜 것은 취향이 아니라 산술의 결과다: 웹이
   * `--danger-fill` 주석에 적어 둔 대로 전경 톤은 `warn` 보다 채도가 높아야 하고
   * 채움은 주 액션 `accent` 보다 낮아야 하는데, 다크에서 그 두 구간의 교집합이
   * 공집합이다.
   *
   * 이 역할이 폰에 없어서 무슨 일이 있었나 (감사 2026-08-09 §B-4 ②): 「거부 확정」
   * 과 「중단」 버튼이 쓸 채움이 없으니 **테두리 토큰**(`dangerBorder`)을 바탕으로
   * 썼다. 그 결과 다크에서 되돌릴 수 없는 거부 버튼이 카드 표면(`surface`) 위
   * 1.64:1 이고 그 옆의 승인 버튼(`accent`)이 8.12:1 이었다 — 파괴 쪽이 화면에서
   * 5배 조용했다(같은 두 값을 `bg` 위에서 재면 1.80 대 8.94다). 웹은
   * 같은 문제를 이 토큰의 신설로 닫았고(MOMO-642 R1 H-2), 폰의 동기화 가드는 그
   * 두 토큰을 **명시적으로 제외**한 채 통과하고 있었다. 가드가 자기 구멍을
   * 문서화하고 지나간 자리다.
   *
   * 값은 발명이 아니다 — core가 표에서 계산한 `danger-fill`이고(ADR-0189 D5),
   * `paletteContrast.test.ts` 가 core 표와 같은 값인지 대조한다.
   */
  dangerFill: string;
  /** 파괴 채움 위에 얹는 글자 — core `on-danger-fill`. */
  onDangerFill: string;
  /** A settled success. */
  ok: string;
  okSurface: string;
  okBorder: string;
  /**
   * 스크림 — 시트 뒤를 덮는 층.
   *
   * 색이 아니라 **방향**이다: 어느 스킴에서든 뒤를 어둡게 해서 앞의 시트가 앞으로
   * 나오게 한다. 그래서 라이트에서도 밝아지지 않는다 — 잉크를 알파와 함께 쓰고
   * (`text` 계열), `bg` 를 빌려 쓰지 않는다. `bg` 에 알파를 걸면 라이트에서
   * 스크림이 배경을 **밝혀** 시트가 뒤로 물러난다. 웹의 `--scrim` 이 같은 이유로
   * 자기 토큰을 갖는다.
   *
   * 알파가 스킴마다 다른 것도 웹과 같다: 밝은 종이를 24%(`3d`) 로 눌러 얻는 분리를
   * 이미 어두운 밤하늘에서 얻으려면 훨씬 짙어야 한다(62%, `9e`). 두 값 다 웹
   * `--scrim` 을 `#rrggbbaa` 로 옮긴 것이다 — RN 은 `rgb(… / …)` 를 모른다.
   *
   * 지켜야 하는 것은 비율이 아니라 **부호**이고, `paletteContrast.test.ts` 가 두
   * 스킴에서 그것을 합성해 잰다: 스크림은 모든 표면을 어둡게 하고, 스크림 걸린
   * 어떤 표면보다 시트(`surface`)가 밝다.
   */
  scrim: string;
  /** 그림자. 스킴과 무관하게 아래 방향이라 팔레트를 따라가지 않는다. */
  shadow: string;

  // ---- DS2에서 새로 생긴 역할 (ADR-0189 D1·D2) -----------------------------
  // 아래 열은 core 표의 역할을 이름만 camelCase로 옮긴 것이다. 셸(떠 있는 탭바·
  // FAB·페이지 시트)이 처음 쓰고, 홈·대화(DS2-3·DS2-4)가 뒤따른다.

  /** 바닥 그라데이션의 위 정지점(core `canvas-top`). `bg`가 가운데 정지점이다. */
  canvasTop: string;
  /** 바닥 그라데이션의 아래 정지점(core `canvas-bottom`). 스크롤 페이드가 이 색으로 녹는다. */
  canvasBottom: string;
  /** 표면 한 단 아래의 조용한 채움(core `surface-muted`). */
  surfaceMuted: string;
  /** 페이지 시트의 바탕(core `sheet`). */
  sheet: string;
  /** 글자 없는 아이콘(core `icon`). 비텍스트 3:1. */
  icon: string;
  /**
   * 주 행동의 채움 — 잉크(core `primary`). FAB·보내기·주 버튼(ADR-0189 D1).
   *
   * `accent`와 다른 역할이다. `accent`는 신호(안 읽음·멘션)이고, 주 행동은 테마와
   * 커스텀이 바꾸지 않는 잉크다(D3 「주 버튼 검정」).
   */
  primary: string;
  /** 잉크 채움 위의 글자·글리프(core `on-primary`). */
  onPrimary: string;
  /** 유리 재료의 틴트(core `glass`, `#rrggbbaa`). 블러 위에 한 겹 얹는다. */
  glass: string;
  /**
   * 블러를 못 쓸 때의 유리 — `surface` 94% 불투명(core `GLASS_FALLBACK_OPACITY`).
   * 투명도 줄이기가 켜지면 이것도 아니라 불투명 `surface`다(D7).
   */
  glassFallback: string;
  /** 유리의 가장자리 한 줄(시안 `--glassLine`). 테마 밖의 셸 상수다. */
  glassLine: string;
  /**
   * 고도 두 단(ADR-0179 D6) — RN `boxShadow` 문자열. 색이 아니라 그림자 레시피다.
   *
   * 라이트는 core `ELEVATION`의 두 레시피 그대로다. 다크는 시안 A `.A.dark`의
   * `--sh1`·`--sh2`다: core 는 「다크에서 윗면 하이라이트를 더한다」까지만 적고,
   * 따뜻한 갈색 그림자(`rgba(30,24,20,…)`)는 어두운 바닥 위에서 보이지 않으므로
   * 시안은 다크 그림자를 검정으로 짙게 다시 적었다. 시안을 따른다.
   */
  elevationRest: string;
  elevationFloat: string;
}


/** 팔레트 역할 → core 역할. 시험이 이 표를 그대로 읽어 core와 대조한다. */
export const DS2_ROLE_MAP = {
  bg: 'canvas-mid',
  canvasTop: 'canvas-top',
  canvasBottom: 'canvas-bottom',
  surface: 'surface',
  surfaceMuted: 'surface-muted',
  surfacePressed: 'surface-pressed',
  sheet: 'sheet',
  border: 'line',
  text: 'ink',
  textMuted: 'ink-muted',
  textFaint: 'line-strong',
  icon: 'icon',
  primary: 'primary',
  onPrimary: 'on-primary',
  accent: 'signal',
  accentText: 'signal-text',
  accentSurface: 'signal-soft',
  onAccent: 'on-signal',
  agent: 'agent',
  agentSurface: 'agent-soft',
  warn: 'warn',
  warnSurface: 'warn-soft',
  danger: 'danger',
  dangerSurface: 'danger-soft',
  dangerFill: 'danger-fill',
  onDangerFill: 'on-danger-fill',
  ok: 'ok',
  okSurface: 'ok-soft',
} as const satisfies Partial<Record<keyof Palette, string>>;

/** 시안 A `.A.dark`의 `--sh1`·`--sh2` (Palette 주석). */
const DARK_ELEVATION = {
  rest: 'inset 0 1px 0 rgba(255,255,255,.04), 0 10px 28px -12px rgba(0,0,0,.6)',
  float: 'inset 0 1px 0 rgba(255,255,255,.06), 0 18px 44px -12px rgba(0,0,0,.75)',
} as const;

/** 유리 한 줄(시안 `--glassLine`). 테마 표 밖이라 여기서 모드별로 든다. */
const GLASS_LINE: Readonly<Record<Mode, string>> = {
  light: 'rgba(255,255,255,.7)',
  dark: 'rgba(255,255,255,.07)',
};

/** `rgba(r,g,b,a)` → `#rrggbbaa`. 스크림과 유리를 폰의 표기로 옮긴다. */
export function rgbaToHex8(value: string): string {
  const found = /^rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)$/.exec(
    value.trim(),
  );
  if (!found) throw new Error(`not an rgba() color: ${value}`);
  const byte = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');
  return (
    '#' +
    byte(Number(found[1])) +
    byte(Number(found[2])) +
    byte(Number(found[3])) +
    byte(Number(found[4]) * 255)
  );
}

function lower(hex: string): string {
  return normalizeHex(hex);
}

/**
 * 한 테마 × 모드의 core 표에서 폰 팔레트를 만든다.
 *
 * `signal` 을 주면 core `resolveSignal` 이 보정한 신호 네 값이 표의 신호를 **덮는다**
 * (ADR-0189 D3: 커스텀은 `signal` 네 값만 바꾼다). 덮는 자리는 `accent` 계열 네 역할
 * 뿐이고 `primary`(잉크)는 그대로다. 파생 역할(`accentPressed`·`accentSurfaceStrong`)은
 * 덮은 뒤의 값에서 계산되므로 따로 손대지 않는다.
 */
export function paletteFrom(
  theme: ThemeRef | ThemeModeTokens,
  mode: Mode,
  signal?: SignalValues | null,
  onImage = false,
): Palette {
  if (typeof theme === 'string') mode = phoneThemeMode(theme, mode);
  const roles = ds2Roles(theme, mode);
  const role = (name: string): string => {
    const value = roles[name];
    if (value === undefined) throw new Error(`core ${theme}/${mode} 에 ${name} 이 없다`);
    return value;
  };
  const mapped = {} as Record<keyof typeof DS2_ROLE_MAP, string>;
  for (const [key, coreRole] of Object.entries(DS2_ROLE_MAP)) {
    mapped[key as keyof typeof DS2_ROLE_MAP] = lower(role(coreRole));
  }
  if (signal) {
    mapped.accent = lower(signal.signal);
    mapped.accentText = lower(signal['signal-text']);
    mapped.accentSurface = lower(signal['signal-soft']);
    mapped.onAccent = lower(signal['on-signal']);
  }
  const onPrimary = mapped.onPrimary;
  const ink = mapped.text;
  const bestInk = (fill: string) =>
    contrast(onPrimary, fill) >= contrast(ink, fill) ? onPrimary : ink;
  const firstParty = typeof theme === 'string' && isThemeId(theme);
  // RN은 알파를 8bit로 칠해요. 하한보다 얇아지지 않게 카탈로그는 올림해요.
  const backdropAlpha = firstParty ? BACKDROP_SCRIM_ALPHA[mode]
    : Math.ceil(minimumScrimAlpha(mapped.bg, ink, INK_MIN_ON_BACKDROP) * 255) / 255;
  // 사진이 3%도 남지 않는 테마는 기본 바닥으로 보여요(청사진 §5.6-c).
  const imageActive = onImage && backdropAlpha < 0.97;
  if (imageActive) {
    // 사용자 배경이 깔린 동안(ADR-0189 증보 2): 바닥 위에 **직접** 서는 글자·표식 색을
    // scrim 최악 합성(순흑·순백 사진) 위 대비로 맞춘다. 명도만 움직이고 색상각은 지킨다.
    // 잉크(`text`)는 scrim 불투명도 자체가 7:1 을 지키므로 손대지 않는다.
    const hosts = worstCaseBackdrops(mapped.bg, backdropAlpha);
    const fit = (hex: string, min: number) => fitForeground(hex, hosts, min, mode);
    for (const name of ['textMuted', 'accentText', 'agent', 'warn', 'danger', 'ok'] as const) {
      mapped[name] = fit(mapped[name], TEXT_MIN_ON_BACKDROP + FIT_MARGIN);
    }
    for (const name of ['textFaint', 'icon', 'accent'] as const) {
      mapped[name] = fit(mapped[name], NON_TEXT_MIN_ON_BACKDROP + FIT_MARGIN);
    }
    mapped.onAccent = bestInk(mapped.accent);
  }
  const signalFill = mapped.accent;
  const pressedFrom = toOklch(signalFill);

  return {
    ...mapped,
    mode,
    backdrop: imageActive ? 'image' : 'canvas',
    backdropScrim: scrimColor(mapped.bg, backdropAlpha),
    accentPressed: fromOklch({...pressedFrom, L: pressedFrom.L - 0.0887}),
    accentSurfaceStrong: mixOklab(mapped.accentSurface, signalFill, 0.25),
    warnBorder: mixOklab(mapped.warnSurface, mapped.warn, 0.35),
    onWarn: bestInk(mapped.warn),
    dangerBorder: mixOklab(mapped.dangerSurface, mapped.danger, 0.35),
    dangerText: mixOklab(mapped.danger, ink, 0.3),
    okBorder: mixOklab(mapped.okSurface, mapped.ok, 0.35),
    scrim: rgbaToHex8(role('scrim')),
    glass: rgbaToHex8(role('glass')),
    glassFallback:
      mapped.surface +
      Math.round(GLASS_FALLBACK_OPACITY * 255)
        .toString(16)
        .padStart(2, '0'),
    glassLine: rgbaToHex8(GLASS_LINE[mode]),
    elevationRest: mode === 'light' ? ELEVATION.rest : DARK_ELEVATION.rest,
    elevationFloat: mode === 'light' ? ELEVATION.float : DARK_ELEVATION.float,
    shadow: '#000000',
  };
}

/**
 * 새벽하늘의 밤. core `THEMES.dawnsky.dark`에서 만든다(파일 머리 주석).
 *
 * 여명(ADR-0174)의 밤이 들던 값과 그것이 세 번에 걸쳐 온 길(#1153·#1155·#1164)은
 * git 이력에 있다. 그 판이 지키던 **관계**는 시험에 그대로 남아 새 값을 잰다.
 */
export const darkPalette: Palette = paletteFrom(DEFAULT_THEME_ID, 'dark');

/**
 * 새벽하늘의 낮. core `THEMES.dawnsky.light`에서 만든다.
 *
 * 순백(#ffffff)도 순흑(#000000)도 쓰지 않는다 — 종이의 흰색은 core의 `surface`
 * (`#fffefc`)다.
 */
export const lightPalette: Palette = paletteFrom(DEFAULT_THEME_ID, 'light');

/**
 * 다크 스킴의 **낱값**.
 *
 * 앱 코드는 이것을 읽지 않는다 — 화면에 그리는 색은 `useStyles(buildStyles)` 가
 * 그때의 스킴에서 고른다(`design/theme.tsx`). 이 별칭이 남아 있는 자리는 렌더
 * 밖에서 값 자체를 물어야 하는 곳뿐이다: 대비를 재는 테스트, 그리고 두 스킴을
 * 나란히 세우는 하네스.
 *
 * `src/` 안에서 이것을 다시 import 하면 그 화면만 스킴을 안 따라가게 된다.
 * 그래서 규칙은 취향이 아니라 기계다 — `__tests__/themeSwitch.test.tsx` 가
 * `src/` 전수를 훑어 이 이름의 import 를 0 으로 단정한다.
 */
export const color: Palette = darkPalette;

// 배경 표의 원천도 core 한 곳이에요(AP-6).
export {WALLPAPER_SOLIDS as BACKDROP_SOLIDS, WALLPAPER_PRESETS as BACKDROP_PRESETS} from '@momo/core/design/wallpaper';

export const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
} as const;

export const radius = {
  sm: 6,
  md: 8,
  pill: 999,
} as const;

/**
 * 디자인 시스템 2.0 폰 반경 사다리 (ADR-0189 D6, themes-2.0 §5).
 *
 * `radius`(여명 3단)와 따로 둔다: 그 표는 웹 `--radius-*`와 이름을 대조하는
 * 시험(`designSystem.test.ts`)이 아직 읽고, ADR-0189 D6은 폰·웹 반경의 값 대조를
 * 폐기했다 — 이름만 공유하고 값은 플랫폼마다다. DS2 화면(셸부터)은 이 사다리를 쓴다.
 */
export const ds2Radius = {
  /** 배지·태그. */
  badge: 10,
  /** 행 선택·입력. */
  row: 14,
  /** 카드·묶음. */
  card: 20,
  /**
   * 컴포저 — 원 반경 18 + 원 ↔ 알약 가장자리 9 (#4179). 시안 A 의 26 이던 것을 Buzz 실측
   * (한 줄 높이 53.3pt)에 맞춰 올렸다: 두 원이 끝 반원과 동심이려면 반경이 원 반경 + 사방
   * 여백이어야 한다(`CONV.composerRadius`, 관계는 `composerPill.test.tsx`).
   */
  composer: 27,
  /** 페이지 시트 위 모서리. */
  sheet: 30,
  pill: 999,
} as const;

/**
 * 폰 타입 크기 — 역할 표 하나 (#3774, `docs/design-system/typography-proposal.md` §3.3).
 *
 * 예전에는 `font`(여명 6단)와 `ds2Type`(DS2 8단)이 따로 살며 17·18, 24·26, 12·12.5 처럼
 * 한 뜻에 두 값이 있었다. 이제 이 객체가 유일한 크기 표다. `body-strong` 은 크기 키가
 * 아니다 — `font.body` 에 `fontWeight: '600'` 을 얹는다. `code` 도 `font.meta` +
 * `fontFamily: 'Menlo'` + `line.code` 다.
 *
 * 본문 16 은 iOS Body(17)보다 한 단 작은 **메신저 밀도**로 고른 값이다(카카오톡·
 * Telegram 계열 본문 크기에 맞춤). 「iOS 입력창이 줌을 멈추는 크기」라는 예전 근거는
 * Safari/WebView 규칙이라 RN `TextInput` 에는 적용되지 않는다.
 *
 * 굵기는 600/700 만 쓴다(800 폐지). 상한 정책: 크롬(탭바·헤더·버튼)만
 * `maxFontSizeMultiplier` 를 갖고, 본문·메시지·입력은 상한이 없다(`atoms.tsx`).
 */
export const font = {
  /**
   * SAS 4자리처럼 두 화면 사이에서 비교하는 숫자 — 표면을 지배해야 한다. 홈 큰 제목.
   * 700, 자간 −0.02em.
   */
  display: 30,
  /** 화면·시트 제목. 700, 자간 −0.02em. */
  title: 22,
  /** 섹션 머리·행 제목. 600. */
  heading: 17,
  /** 본문·입력. 400(강조는 600). */
  body: 16,
  /** 라벨·보조 문장. 500~600. */
  label: 13,
  /** 시각·핸들·주석. 400. */
  meta: 12,
  /** 배지·태그·알약 안 글자. 500, 자간 +0.02em. */
  caption: 11,
} as const;

/**
 * 줄 높이 스케일 (u44 리뷰 M-2).
 *
 * ## 왜 이름이 필요했나
 *
 * `font` 는 처음부터 있었지만 **줄 높이는 없었다.** 그래서 대화 표면에는
 * 17·18·19·22 가 손으로 적힌 채 흩어져 있었고, 리뷰가 그중 하나를 잡아냈다 —
 * 행 시각의 `lineHeight: 22` 가 「이 배치가 추가한 유일한 스케일 밖 숫자」이고
 * 같은 파일의 다른 보조 텍스트는 17/18 을 쓴다는 지적이다. 값 하나를 고치는
 * 것으로는 다음번에 같은 일이 다시 일어난다.
 *
 * ## 이 세 값이 하는 일은 정렬이다
 *
 * RN(iOS)은 `lineHeight` 가 붙은 `Text` 의 글자를 그 줄 상자 **가운데**에 놓는다.
 * 그래서 두 조각이 한 줄로 읽히려면 둘이 **선언된 같은 줄 상자**를 같은 y 에서
 * 시작해야 한다 — 폰에는 컨테이너를 건너뛰는 baseline 정렬이 없으므로(웹의
 * `align-items: baseline` 에 해당하는 것이 절대 배치된 형제에는 닿지 않는다),
 * 「같은 상자, 같은 원점」이 실제로 쓸 수 있는 가장 강한 규율이다. 행 시각이
 * 작성자 줄과 어긋났던 것이 정확히 이것을 안 지켰기 때문이고, 이제 두 쪽이 같은
 * 이름을 든다(`MessageRow` 의 `rowTime` 주석에 실측이 있다).
 *
 * 값은 #3774 역할 표(§3.3)다. 본문 문단·목록은 23, 카드 주석은 16, 코드는 17.
 */
export const line = {
  /**
   * **행의 머리줄** — 작성자 이름(13)과 행 시각(12)이 *한 줄로 읽혀야* 하는 자리.
   *
   * 이 값이 따로 있는 이유는 실측이다(iPhone 17 Pro, px/3, `u44-group.png`).
   * 두 조각을 같은 줄에 세우는 것은 **선언된 같은 상자를 공유하는 것**이지 그
   * 상자의 크기가 아니었다: 14·15·16·17·18 을 다 세워 봐도 어긋남은 언제나 같은
   * 값(광학 중심 +0.33pt)이고, 바뀌는 것은 **그룹 머리의 높이뿐**이었다
   * (본문 상단 300·303·306·308·311px). 선언하지 않으면 어긋남이 +2.67pt 로
   * 돌아온다 — 그것이 리뷰가 「2~3pt 아래」로 잰 값이다.
   *
   * 그래서 값은 「가장 싼 것」으로 고른다. 15 는 13pt 글자의 자연 줄 상자 바로
   * 위라 잘리지 않으면서, 그룹 머리에 **2pt** 만 더한다. `label`(18)을 그대로
   * 쓰면 같은 정렬을 얻고 4.67pt 를 낸다 — 이 제품이 세로를 두고 이미 여러 번
   * 치른 거래(절대 배치된 시각·32pt 칩·24pt 코드 복사)를 생각하면 그쪽이 비싸다.
   */
  head: 15,
  /** `font.meta`(12) 한 줄. 카드 주석·행 오류·누를 것의 라벨. 코드는 `code`. */
  meta: 16,
  /** `font.label`(13) 한 줄 **문장**. 묘비. */
  label: 18,
  /** `font.body`(16) 한 줄. 본문 문단·목록·「작업 중」. 22 → 23 (#3774, 1.44). */
  body: 23,
  /** `font.caption`(11) 한 줄. */
  caption: 14,
  /** `font.heading`(17) 한 줄. */
  heading: 22,
  /** `font.title`(22) 한 줄. */
  title: 28,
  /** `font.display`(30) 한 줄. */
  display: 36,
  /** Menlo 12 코드 — `meta`(16)와 뜻이 다르다: 고정폭이라 한 단 더 숨 쉰다. */
  code: 17,
} as const;

// =============================================================================
// 시트·페이지 머리와 묶음 부품의 치수 (#4318).
//
// Buzz(Apache-2.0)의 `buzz_sheet_header.dart`·`buzz_navigation_metrics.dart`·
// `app_list_card.dart`·`app_list.dart`·`buzz_action_tile.dart`·`modal_presentation.dart` 에서
// 구조와 값만 읽어 우리 눈금으로 옮겼다(RN 으로 다시 짠다, 코드는 가져오지 않는다). 값은 이
// 한 곳에서 이름으로 나가고, 부품(`SheetChrome`·`sheetParts`)은 숫자를 새로 쓰지 않는다 —
// 간격·반경 스윕(`designSystem.test.ts`)이 새 파일의 격자 밖 리터럴을 0 으로 둔다.
//
// 색은 한 줄도 없다. 부품이 읽는 역할은 전부 `Palette` 다: 시트 바탕 `sheet` 위에 카드·입력·
// 원형 단추가 `surface` 로 선다(Buzz `utilitySurfaceThemeData` 가 시트와 컨테이너의 두 면을
// 맞바꾸는 것과 같은 구조).
// =============================================================================
export const SHEET = {
  /**
   * 머리 줄 높이. Buzz `buzzNavigationRowHeight` 56 에서 손잡이 띠(`PageSheet` 의 위 여백)가 이미
   * 들고 있는 몫을 덜어 `TOUCH_TARGET + space.sm`(52). 단추 40 이 줄 가운데에 선다.
   */
  headerRow: TOUCH_TARGET + space.sm,
  /** 원형 단추의 눈에 보이는 지름 — Buzz `IosGlassNavigationButton.controlSize` 40. 눌림 영역은 44. */
  circle: 40,
  /**
   * 머리 줄 아래에서 첫 내용까지 더하는 위 여백. 머리 줄(52)에서 원(40)이 위아래 6 만 남기므로 원 아래 끝에서 첫
   * 내용까지는 6 + 12 = 18 이다(Buzz 약 19 · 페이지 전시의 머리→타일 18). 이 값이 없으면 6 이라 원이 첫 카드의
   * 모서리에 닿을 듯했다(design-review #4318 r1 M1).
   */
  bodyTop: space.md,
  /** 카드 안쪽 가로 여백 — Buzz `AppListCard._inset` 16. 우리 공용 여백과 같은 값이다. */
  cardInset: SAFE_GUTTER,
  /** 행 앞 아이콘 칸의 폭 — Buzz 22. 이모지도 같은 칸에 선다. */
  iconSlot: 22,
  /** 아이콘 칸과 글자 사이 — Buzz `Grid.xs` 16. */
  iconGap: space.lg,
  /**
   * 행의 최소 높이. Buzz 는 위아래 16 + 글자 한 줄이고, 우리는 본문 한 줄(23)에 위아래 12 를
   * 주고 `TOUCH_TARGET + space.sm` 아래로는 내려가지 않게 한다 — 실측 캡처의 한 줄 행(≈52pt).
   */
  rowMinHeight: TOUCH_TARGET + space.sm,
  /** 큰 행동 타일 최소 높이 — Buzz `BuzzActionTile` `68 + 8·2`. */
  tileMinHeight: 84,
  /** 입력 알약의 최소 높이 — Buzz 검색 칸 45, 우리는 눌림 최소 44. */
  pillMinHeight: TOUCH_TARGET,
  /** 안쪽 구분선 알파(16진 두 자리, 12%) — Buzz `onSurface.withValues(alpha: 0.12)`. 글자색에 얹어 두 모드에서 읽힌다. */
  dividerAlpha: '1f',
  /** 내용 맞춤 시트의 최대 높이(화면 비율) — 두 옛 시트가 쓰던 0.85. 넘치면 안에서 스크롤한다. */
  fitMaxRatio: 0.85,
  /** 중간 단의 높이(화면 비율) — Buzz `scrollControlDisabledMaxHeightRatio` 9/16. */
  mediumRatio: 9 / 16,
  /**
   * 키보드 윗변의 둥근 모서리 반경보다 큰 값(실측 쐐기가 24 에 맞는다, design-review #4318 r3 L1·r4 L2). 키보드 위에 앉은 시트는
   * 이만큼 더 아래(키보드 뒤)까지 `sheet` 색을 깐다 — 안 그러면 키보드 모서리 바깥으로 스크림이 쐐기 모양으로 비친다.
   */
  keyboardCorner: 28,
} as const;

// =============================================================================
// 사진 뷰어의 무대 (#4297) — 테마와 무관한 색 한 벌.
//
// 사진은 어두운 방에서 가장 잘 보인다(iOS 사진 앱·카카오톡이 라이트 모드에서도 검정 무대를 쓰는 이유). 그래서 이 표면은 라이트·다크
// 어느 테마에서도 같은 검정이고, 그 위의 글자·유리도 한 벌이다. `Palette` 의 역할(`bg`·`text`)을 읽으면 라이트 테마에서 흰 바닥에 흰
// 사진이 놓이거나 검정 바닥 위에 검정 글자가 선다 — 그래서 `Palette` 밖의 이름이다. 웹에 짝이 없는 폰 전용 값이라 **값이 아니라 지키는
// 관계**를 시험이 잰다(`docs/design-system/README.md` §6 「폰에 값을 더할 때」, `attachmentViewer.test.tsx` 「⑧ 검정 무대는 테마와
// 무관하다」): ① 무대는 두 테마에서 같다 ② 무대 위 글자·글리프는 무대와 7:1 이상 ③ 유리의 불투명·대체 면 위 글리프도 7:1 이상.
//
// hex 는 이 파일에만 둔다(`conversationHygiene.test.tsx` M-13). 소비처는 `features/attachments/viewerDesign.ts` 하나다.
// =============================================================================
export const photoStage = {
  /** 무대 바닥. 순흑. */
  bg: '#000000',
  /** 글리프·이름. 무대와 21:1. */
  ink: '#FFFFFF',
  /** 날짜·시각·캡션. 순흑 위 합성값이 ≈ #CCCCCC 이라 13:1 안팎이다. */
  inkMuted: 'rgba(255, 255, 255, 0.8)',
  /** 글자 곁의 가는 그림자 — 스크림(`scrim`)이 못 닿는 가장자리의 보조다. */
  inkShadow: 'rgba(0, 0, 0, 0.5)',
  /** 내려받기 실패 안내. 라이트 테마의 `danger`(진한 빨강)는 검정 위에서 어두워 따로 둔다. 순흑 위 9.6:1. */
  danger: '#FF8A80',
  /** 고른 썸네일의 테두리. 카카오톡 노랑은 쓰지 않는다 — 흰색이 어떤 사진 위에서도 선다. */
  ring: '#FFFFFF',
  /** 썸네일이 서기 전의 자리. */
  thumbPlaceholder: 'rgba(255, 255, 255, 0.14)',
  /** 유리 단추를 누르는 동안의 채움. */
  pressedFill: 'rgba(255, 255, 255, 0.18)',
  /** 유리 단추의 가는 테두리. */
  glassBorder: 'rgba(255, 255, 255, 0.22)',
  /**
   * 조작 뒤의 어두운 스크림 — 밝은 사진(스크린샷의 흰 바탕) 위에서도 글자가 읽히게 한다. 어두운 사진 위에서는 보이지 않는다. 새 의존이
   * 없다(`experimental_backgroundImage` 는 셸이 이미 쓴다, `ShellChrome.tsx`). 두 겹이다.
   *
   * ① **판**(`plateau`): 조작 덩어리 **안**(글자·단추가 서는 자리)을 가득 덮는다. 덩어리가 글자와 함께 자라므로(접근성 큰 글씨에서는
   *    이름·날짜 줄이 단추보다 높다) 글자가 어느 크기로 서든 판 위에 있다 — 대비가 기기·글자 크기의 산수에 안 걸린다.
   *    `[바깥 끝, 안쪽 끝]` 의 검정 불투명도다. 안쪽 끝(글자가 서는 가장 밝은 자리) 0.55 에서 순백 사진 위 흰 글자는 4.7:1, 날짜·캡션의
   *    80% 흰색은 3.7:1 이다(시험이 **그려지는 색**으로 잰다).
   * ② **자락**(`fade`): 덩어리 **밖**으로 풀린다. `[위치, 불투명도]` 마디 — 위치는 덩어리 끝이 0, 사라지는 곳이 1. 끝은 완만하게 0 으로
   *    눕는다(기울기가 0 에 닿는다): 선형으로 끊으면 밝은 사진 위에서 끝 선이 줄무늬(마하 띠)로 보인다.
   */
  scrim: {
    /** 스크림의 색 — 검정(`rgba()` 의 r, g, b). */
    rgb: '0, 0, 0',
    plateau: [0.6, 0.55],
    fade: [
      [0, 0.55],
      [0.3, 0.47],
      [0.55, 0.33],
      [0.75, 0.18],
      [0.9, 0.06],
      [0.97, 0.01],
      [1, 0],
    ],
  },
  /**
   * 무대 위 유리의 세 갈래 색(`design/glass.tsx` 의 `GlassTone`이 받는다). 어두운 틴트라 라이트 테마에서도 흰 글리프가 선다. 불투명
   * (투명도 줄이기)과 대체(블러 모듈 없음)도 밝은 `surface` 가 아니라 이 어두운 면이라 **밝은 면 위 밝은 글리프**가 되지 않는다.
   */
  glass: {
    tint: 'rgba(28, 28, 30, 0.55)',
    fallback: 'rgba(28, 28, 30, 0.94)',
    opaque: '#2C2C2E',
  },
} as const;
