import {PixelRatio, StyleSheet, type StyleProp, type TextStyle} from 'react-native';

// =============================================================================
// 여러 줄 글의 줄 높이 **여유** (#5288, #4894)
//
// ## 증상
//
// 두 줄로 접힌 글이 첫 줄만 그려지고 오른쪽 끝에서 잘린 채(둘째 줄은 비고) 서 있다. 말풍선·카드는 두 줄 높이로 선다.
// 한국어도 영어도, `lineBreakStrategyIOS` 가 있어도 없어도 난다. v0.1.42 소식 상세(영어)의 한 문장과 5a 검수의 말풍선이 그랬다.
//
// ## 원인 (시뮬레이터 실측 — `measure/sentenceWrap.tsx`, 같은 절대 y 에서 여섯 전략을 맞댔다)
//
// 1. 글 상자의 **높이가 줄 수가 요구하는 높이보다 1e-4pt 단위로 낮게** 내려온다. 소식 상세의 그 문장은 `onLayout` 높이가
//    45.999755859375(= 46 − 2⁻¹²)였다. 줄 높이 23pt × 2줄 = 46pt, 요구보다 0.000244pt 낮다.
// 2. 그리는 쪽(`RCTTextLayoutManager drawAttributedString:`)은 그 높이를 그대로 TextKit 컨테이너 높이로 쓴다. 둘째 줄(23pt)이 컨테이너에
//    들지 않으니 첫 줄이 「컨테이너의 마지막 줄」이 되고, 그 줄은 컨테이너의 `NSLineBreakByClipping`(`maximumNumberOfLines == 0` 일 때의
//    값)으로 놓인다 — **줄바꿈 없이 한 줄로** 오른쪽 끝에서 잘린다. 둘째 줄은 아예 놓이지 않는다. 잰 높이(두 줄)와 그린 줄(한 줄)이 어긋난다.
// 3. 높이가 깎이는 곳은 Yoga 의 화소 격자 반올림이다(`yoga/algorithm/PixelGrid.cpp`). 글 노드(측정 함수가 있는 노드)는 높이가 화소의
//    정수배면 `floor(아래끝) − floor(위끝)` 로 잰다. 두 값은 각각 float32 로 잘려 돌아오고, 절대 y 가 4096 을 넘으면 float32 한 칸(ulp)이
//    2.4e-4pt 이상이라 그 차가 한 칸 모자랄 수 있다. 절대 y 의 1/3pt 소수 부분에 따라 나는 일이라 **같은 글이 어떤 줄에서는 멀쩡하고 어떤
//    줄에서는 잘린다**(보낸 사람 폰에서는 정상이었다는 #4894 의 말).
// 4. 줄 높이를 **정수**(23·18·16…)로 적는 글은 N 줄의 높이가 늘 화소의 정수배라 매번 이 길에 든다. 자연 줄 높이(소수)인 글은 측정이
//    올림(`ceil(높이 × 배율) / 배율`)해서 보통 여유가 남는다.
// 5. **같은 뿌리의 두 번째 얼굴**: 컨테이너 높이가 줄 수의 요구와 *정확히 같으면*(깎이지 않은 정수 줄 높이 글 전부) 줄바꿈 전략
//    (`hangul-word`·`standard`·`push-out`)이 꺼져 `none` 과 같은 줄을 낸다 — 한국어 779칸 모두 같았고 「자료/는」 같은 한 글자 고아 줄이
//    25칸에 났다. 컨테이너에 여유만 줘도(`minHeight`) 켜진다. 즉 `Sentence` 의 `hangul-word` 는 정수 줄 높이 본문에서 **그동안 켜지지 않았다.**
//    깎여서 모자라면 위 2 처럼 마지막 줄이 잘리고, 딱 맞으면 전략이 꺼진다 — 컨테이너에 여유가 없다는 같은 사실이다.
//
// ## 고침
//
// 줄 높이를 **0.01pt 낮춘다**. N 줄의 요구 높이가 0.01·N pt 줄어 화소 격자 높이(올림값)와의 사이에 0.01N pt 의 여유가 생기고(위 2·5 를 함께 푼다:
// 마지막 줄이 안 잘리고, 한국어 어절 줄바꿈이 **켜진다**), 측정 올림은
// 그대로 같은 정수배를 내므로 **글 상자 높이는 그대로**다(레이아웃 이동 0). 깎임은 float32 한 칸이라 절대 y 가 13만 pt 아래(칸 7.8e-3pt)면
// 이 여유보다 작다. 줄 간격이 0.01pt 달라지는 것은 3x 화면의 0.03 화소로 보이지 않는다.
//
// 근본 수리는 네이티브다(`PixelGrid.cpp` 가 double 차를 float 로 자르기 전에 계산하거나, 그리는 쪽 컨테이너 높이에 한 화소의 여유를 둔다 —
// patch-package + 네이티브 재빌드). 그 전까지 여러 줄 글을 그리는 부품이 이 함수를 지난다.
//
// ## 재는 법
//
//   sim-locked.sh measure/run-sentence-wrap.sh <udid> <태그> SENTENCE-WRAP <Metro 포트> <결과 폴더> large light \
//     -momoWrapSet en-notif-3 -momoWrapWidths 337.3333 -momoWrapBase 8000.3333 -momoWrapReps 96
//   (WRAP_CHECK_FLAGS="--clean sentence --by-y")  — 여유 없는 전략은 A(잰≠그림)가 나고 `sentence` 는 0 이다.
// =============================================================================

/** 줄 높이에서 덜어 내는 여유(pt). 깎임(float32 한 칸 — y < 13만 pt 에서 ≤ 7.8e-3pt)보다 크고, 3x 화소(0.33pt)의 3% 라 눈에 안 보인다. */
export const LINE_HEADROOM = 0.01;

/** 줄 높이가 화소 격자의 정수배인가 — 그때만 N 줄 높이가 화소의 정수배라 깎임에 맨몸이다. */
function onPixelGrid(lineHeight: number): boolean {
  const px = lineHeight * PixelRatio.get();
  return Math.abs(px - Math.round(px)) < 1e-6;
}

/** 숫자 줄 높이 하나에 여유를 준다(화소 격자에 안 선 값은 이미 여유가 있어 그대로). */
export function headroomLineHeight(lineHeight: number): number {
  return onPixelGrid(lineHeight) ? lineHeight - LINE_HEADROOM : lineHeight;
}

/**
 * 글 스타일의 줄 높이가 화소 격자의 정수배면 `LINE_HEADROOM` 만큼 낮춘 스타일을 덧붙여 돌려준다.
 * 줄 높이가 없거나(자연 줄 높이) 이미 소수면 받은 스타일을 그대로 돌려준다.
 */
export function withLineHeadroom(style: StyleProp<TextStyle>): StyleProp<TextStyle> {
  const lineHeight = StyleSheet.flatten(style)?.lineHeight;
  if (lineHeight === undefined || !onPixelGrid(lineHeight)) return style;
  return [style, {lineHeight: lineHeight - LINE_HEADROOM}];
}
