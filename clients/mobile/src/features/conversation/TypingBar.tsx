import {
  typingLead,
  typingNameCells,
  typingTail,
  type TypingNameCell,
  type TypingSegment,
} from '@momo/core/features/chat/typing';
import React, {useState} from 'react';
import {StyleSheet, Text, useWindowDimensions, View, type LayoutChangeEvent} from 'react-native';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {font, line as lineScale, SAFE_GUTTER, space, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {RESPONDING_DOTS_WIDTH, RespondingDots} from '../agents/RespondingDots';
import {CONV} from './convDesign';

// =============================================================================
// 「작성 중」 — 사람이 지금 무언가 치고 있다 (ADR-0149).
//
// ## 이 파일이 존재하는 진짜 이유: **낱말이 겹치면 안 된다**
//
// 이 대화 화면에는 이미 「작업 중」이 있다. `AgentActivityBar`가 그리는 줄이고,
// 그것은 **에이전트의 열린 턴**을 말한다 — `agent_run`으로 영속하는 상태이고,
// 옆에 「중단」 버튼이 붙는다. 이 파일이 그리는 「작성 중」은 **사람이 자판을
// 두드리고 있다**는 휘발 신호이고, 6초 뒤에 스스로 사라지며, 아무 버튼도 없다.
//
// ADR-0149: *"에이전트를 「작성 중」으로 흉내 내면 봇 래핑(ADR-0101이 거부한
// 것)이다. **사람은 작성 중, 에이전트는 작업 중** — 다른 말이어야 한다."*
//
// 서버는 이 경계를 403으로 강제한다(`routes/ephemeral.rs`의 `require_human`).
// 화면에서 그것을 무너뜨리는 방법은 하나뿐이다 — **같은 낱말을 쓰는 것.** 그래서
// 이 컴포넌트는 자기 문장을 짓지 않고 받는다. 문장을 짓는 자리가 둘이 되면
// 낱말도 둘이 되고, 그러면 웹과 폰이 다른 말을 하게 된다.
//
// ## 문장은 코어가 짓는다
//
// 몇 명부터 이름을 접는지는 코어의 고정 규칙(1명 · 2명 · 3명부터 「외 N명」)이고 화면은 서버 grant 의
// `aggregateThreshold` 를 읽지 않는다(`docs/design-system/typing-line.md` 3절). 이 파일에 들어오는 것은 코어가
// 지은 조각이고, 여기서 하는 일은 **어디에 어떤 무게로 놓을 것인가**뿐이다.
//
// ## 자리 — 컴포저 바로 위, 활동 줄 아래
//
// 두 줄이 함께 설 수 있다(사람이 치는 동안 에이전트가 일할 수 있다). 순서는
// 「작업 중」이 위, 「작성 중」이 아래다: 위의 줄은 **누를 것이 붙어 있는** 줄이고,
// 아래 줄은 6초 안에 사라지는 힌트다. 사라지는 것이 아래에 있어야 그것이 사라질
// 때 위의 줄이 움직이지 않는다 — 사람이 겨누고 있던 「중단」 버튼이 손가락 밑에서
// 이동하는 것은 이 화면에서 가장 비싼 흔들림이다.
//
// ## 자리를 **예약한다** (design-review H-3)
//
// 첫 판은 `null`을 돌려주며 이렇게 적었다 — *"빈 높이를 예약해 두면 대화 아래에
// 이유 없는 여백이 상시로 앉아 있게 되고, 폰에서 그 한 줄은 메시지 한 줄과 같은
// 값이다."* 그 계산에서 빠진 항이 있다: **여백의 값은 그 줄이 움직이는 것이
// 무엇을 밀어내는가**로 재야 한다.
//
// 이 줄이 나타나고 사라지면 그 아래 **컴포저 전체**가 위아래로 뛴다. 그리고 이
// 줄은 팀원이 치기 시작할 때마다, 멈추고 6초 뒤마다 — 즉 **남이 결정하는
// 박자로** 그렇게 한다. 키보드가 올라온 폰에서 그 아래에 있는 것은 **엄지 밑의
// 전송 버튼**이다.
//
// 이 판정을 이미 웹이 내렸고, **그 근거가 하필 폰이었다**(웹 리뷰: *"폰에서는 키보드가 올라온 상태에서 엄지
// 아래의 전송 버튼이 움직인다."* — 지금 웹의 같은 결정은 `tokens.css` `typing-line`의 고정 칸이다).
// 웹 리뷰가 폰을 들어 설득한 결정을 정작 폰이 반대로 구현했었다.
//
// 예약 높이는 **1줄**이다(웹과 같은 트레이드오프). 두 줄까지 예약하면 평소에 정말로 빈 띠가 생긴다. 그래서 줄의
// 글은 모두 한 줄로 서고(`numberOfLines`), 넘치면 이름 쪽이 줄어든다.
//
// ## 1줄은 **글자 크기 배율만큼** 1줄이다 (#5645, #5582 검수 M2)
//
// 앞 판의 예약은 `minHeight: 16` 고정이었고 글은 Dynamic Type 상한 없이 16 × 배율로 자랐다. 배율 1.35 면 줄이
// 설 때마다 약 5.6pt, 접근성 크기에서는 그 이상 대화가 밀렸다 돌아왔다 — 예약이 배율 1 에서만 참이었다. 이제 칸은
// `typingSlotHeight(배율)` = 줄 상자 16 × min(배율, 바 단추 상한 1.6)로 **고정 높이**(`height`)이고, 줄의 글은 모두 같은
// 상한(`maxFontSizeMultiplier`)에서 멈춘다. 그래서 같은 배율에서는 빈 줄 · 한 이름 · 두 이름 · 「외 N명」이 모두 같은
// 높이다. 바로 위 레일 칸(`railSlotHeight`)과 같은 식 · 같은 상한이라 두 줄이 함께 자라고 함께 멈춘다. `minHeight` 가
// 아니라 `height` 인 이유: 소수 배율에서 글 상자가 픽셀 올림으로 칸보다 0.3pt 커질 수 있고, 그것이 칸을 밀면 대화가
// 그만큼 움직인다. 상한을 두는 이유는 레일과 같다 — 상한이 없으면 가장 큰 글자(배율 3.571)에서 57pt 빈 띠가 늘 선다.
//
// ## 예약은 12, 줄 상자는 16 — 이 줄이 「마지막 행 → 알약」 간격 20 의 한가운데다 (#4264)
//
// 성재 실기(2026-10-23): 「타이핑하면서 채팅바랑 마지막 채팅 사이의 거리가 조금 과한 느낌」. 그 간격은 목록 꼬리 8 +
// 이 줄의 예약 20(줄 16 + 아래 4) + 컴포저 위 여백 8 = 36 이었다. H-3 의 약속(「나타나고 사라져도 아래가 안
// 움직인다」)은 줄이 **한 줄(16) 이상**을 예약해야 서므로, 이 줄을 없애지 않고는 20 에 닿지 않는다 — 그래서 다른
// 두 조각을 정리했다: 대화 화면은 목록 꼬리를 0 으로 받고(`CONV.conversationTail`), 이 줄은 아래 4 를 지고
// 있던 것을 **걷는다**. 줄 상자(`line.meta` 16)는 그대로인데 흐름에서는 `TYPING_RESERVE`(12)만 먹고, 상자의 아래
// `TYPING_OVERHANG`(4)는 컴포저가 늘 비워 두는 위 여백(8) 위에 걸친다 — 거기는 빈 자리다. 글이 서 있을 때
// (16 Pro 실측, 글자 기준) 마지막 글자 → 「작성 중」 글자 18 → 10pt, 「작성 중」 글자 → 알약 15 → 7pt 다. 여기 숫자는
// 글자 배율 1 의 값이다: 큰 글자에서는 줄 상자가 자란 만큼 흐름(`typingReserve`)이 자라고 걸침 4 는 그대로다.
//
// 걸친 만큼 **다음 형제가 올라와 겹친다.** 다음 형제가 컴포저 루트이면 겹치는 곳이 빈 위 여백이라 아무것도 안
// 가린다. 다음 형제가 중단 영수증·개인 호출 알림(`stopOutcome`)이면 그 글줄의 위 4 가 걸침을 받아야 하므로
// `ConversationScreen` 의 그 스타일이 위 여백 `TYPING_OVERHANG` 를 진다.
//
// 잠금: `__tests__/conversationGap.test.tsx` 가 화면의 실제 렌더 트리에서 세 조각의 합을 잰다.
// =============================================================================

/**
 * 글자 배율 1 에서 이 줄이 대화 화면의 도크 **흐름**에서 먹는 높이 — 비어 있어도, 글이 있어도 같다(H-3). 마지막 행 →
 * 알약 간격(`CONV.listPillGap`)에서 목록 꼬리와 컴포저 위 여백을 뺀 나머지다. 다른 배율은 `typingReserve`.
 */
export const TYPING_RESERVE =
  CONV.listPillGap - CONV.conversationTail - CONV.composerTopAir;

/**
 * 줄 상자가 흐름보다 큰 만큼. 컴포저 위 여백(`CONV.composerTopAir`)보다 작아야 알약에 안 닿는다. 글자 배율을 따라
 * 자라지 **않는다** — 자라면 큰 글자에서 걸침이 위 여백 8 을 넘어 알약 위로 내려앉는다. 자라는 몫은 흐름이 진다.
 */
export const TYPING_OVERHANG = lineScale.meta - TYPING_RESERVE;

/**
 * 줄 상자(칸)의 높이 (#5645). 줄 상자 하나(`line.meta` 16)를 글자 배율만큼 키우고 바 단추 상한(1.6)에서 멈춘다 — 줄의
 * 글이 모두 같은 상한(`maxFontSizeMultiplier`)을 달아서 글 상자도 정확히 이만큼이다. 레일 칸(`railSlotHeight`)과 같은 식.
 */
export function typingSlotHeight(fontScale: number): number {
  return lineScale.meta * Math.min(fontScale, BAR_CONTROL_MAX_SCALE);
}

/** 이 줄이 도크 흐름에서 먹는 높이(칸 − 걸침). 같은 배율에서는 줄이 비든 차든 같다. 배율 1 에서 `TYPING_RESERVE`. */
export function typingReserve(fontScale: number): number {
  return typingSlotHeight(fontScale) - TYPING_OVERHANG;
}

// =============================================================================
// 두 이름이 넘칠 때 — 짧은 이름은 온전히 남는다 (#5645, #5582 검수 M1)
//
// 앞 판은 이름 칸마다 `flexShrink: 1` 이었고, Yoga 는 넘친 폭을 **글 폭에 비례해** 나눈다. 그래서 긴 이름(309) + 짧은
// 이름(31)이 390 폭에 서면 짧은 이름도 28 로 줄어 세 글자 이름이 「이…」가 됐다(Yoga 계산). 웹은 `typing-names`
// (`grid-auto-columns: minmax(0, max-content)`)로 **남는 폭을 똑같이 나누되 자기 글 폭에서 멈춘다** — 짧은 이름은 온전하고
// 긴 이름만 준다. Yoga 에는 grid 가 없고, 「똑같이 나누되 글 폭에서 멈춤」은 어떤 flex 속성 조합으로도 안 나온다(줄임은 늘
// 글 폭 비례다). 그래서 폰은 **재고 셈한다**: 줄의 조각마다 제 글 폭을 숨은 거울(`useComposerInputLayout` 의 거울과 같은
// 꼴)로 재고, 줄 폭에서 나머지를 뺀 몫을 웹과 같은 규칙(`shareTypingNameWidths`)으로 나눠 이름 칸에 **명시 폭**을 준다.
//
// - 재는 것은 두 이름일 때뿐이다. 한 이름(「A」·「A 외 N명」)은 줄어드는 칸이 하나라 앞 판 그대로가 이미 같은 답이다.
// - 아직 못 쟀거나(첫 프레임) 다 들어가면 명시 폭이 없다 — 앞 판과 **같은 배치**다. 잰 값이 오면 이름 폭만 바뀌고 칸 높이는
//   그대로라 대화는 움직이지 않는다.
// =============================================================================

/**
 * 두 이름이 넘칠 때 이름마다 받을 폭. 남는 폭(`room`)을 이름 수로 똑같이 나누되 자기 글 폭(`naturals`)에서 멈추고, 멈춘
 * 이름이 남긴 몫은 나머지 이름이 다시 나눈다(웹 `minmax(0, max-content)` 칸과 같은 규칙). 다 들어가면 null(줄일 칸 없음).
 */
export function shareTypingNameWidths(
  naturals: readonly number[],
  room: number,
): number[] | null {
  const total = naturals.reduce((sum, width) => sum + width, 0);
  if (total <= room) return null;
  const widths = naturals.map(() => 0);
  let left = Math.max(0, room);
  let count = naturals.length;
  const ascending = naturals
    .map((width, index) => ({width, index}))
    .sort((a, b) => a.width - b.width);
  for (const {width, index} of ascending) {
    const take = Math.min(width, left / count);
    widths[index] = take;
    left -= take;
    count -= 1;
  }
  return widths;
}

/**
 * 이름 칸들이 나눠 가질 폭: 줄 폭에서 좌우 여백(`SAFE_GUTTER` × 2), 앞부분 · 점 · 꼬리 사이 둘(`space.xs` × 2), 점
 * (`RESPONDING_DOTS_WIDTH`), 꼬리, 이름 아닌 칸(쉼표 뒤 빈칸)을 뺀 것. 아래 `line` 스타일과 같은 수에서 나온다.
 */
export function typingNameRoom(
  lineWidth: number,
  tailWidth: number,
  textCellWidths: readonly number[],
): number {
  const fixed = textCellWidths.reduce((sum, width) => sum + width, 0);
  return lineWidth - 2 * SAFE_GUTTER - 2 * space.xs - RESPONDING_DOTS_WIDTH - tailWidth - fixed;
}

/** 거울이 잰 폭을 기억하는 열쇠. 같은 글 · 같은 옷(이름 칸 · 이름 아닌 칸 · 꼬리)이면 폭이 같다. */
function pieceKey(kind: 'name' | 'text' | 'tail', text: string): string {
  return `${kind}:${text}`;
}

/** 칸의 글(이름 + 거기 붙은 쉼표 같은 것). */
function cellText(cell: TypingNameCell): string {
  return cell.segments.map(segment => segment.text).join('');
}

/**
 * 칸마다 줄 명시 폭(이름 칸만, 이름 아닌 칸은 undefined). 아직 못 잰 조각이 있거나 줄 폭을 모르거나 다 들어가면 null —
 * 그때는 앞 판 배치 그대로다.
 */
function measuredNameWidths(
  cells: readonly TypingNameCell[],
  keys: readonly string[],
  tailKey: string,
  natural: Readonly<Record<string, number>>,
  lineWidth: number,
): (number | undefined)[] | null {
  const tailWidth = natural[tailKey];
  if (lineWidth <= 0 || tailWidth === undefined) return null;
  const widths = keys.map(key => natural[key]);
  if (widths.some(width => width === undefined)) return null;
  const nameIndexes = cells.flatMap((cell, index) => (cell.name ? [index] : []));
  const textWidths = cells.flatMap((cell, index) => (cell.name ? [] : [widths[index] ?? 0]));
  const shares = shareTypingNameWidths(
    nameIndexes.map(index => widths[index] ?? 0),
    typingNameRoom(lineWidth, tailWidth, textWidths),
  );
  if (shares === null) return null;
  const out: (number | undefined)[] = cells.map(() => undefined);
  nameIndexes.forEach((cellIndex, at) => {
    out[cellIndex] = shares[at];
  });
  return out;
}

/**
 * 컴포저 위 「작성 중」 한 줄.
 *
 * 화면 조각은 코어의 `typingVisualSegments`, 낭독 문장은 기존 `typingLabel`을 받는다.
 * 「A」·「A, B」·「A 외 N명」 뒤에 점과 「작성 중」이 선다. 자기 자신은 애초에
 * 여기 오지 않고(자기가 치는 것을 자기에게 알릴 이유가 없다), TTL이 지난 사람도
 * 오지 않는다(만료는 신호를 들고 있는 쪽의 일이다).
 */
export function TypingBar({
  segments,
  label,
  testID = 'composer-typing',
}: {
  /**
   * 코어가 지은 **조각들**. 이름과 나머지를 화면에서 다르게 칠할 수 있게 한다
   * (design-review M-4).
   *
   * 문장 전체를 한 문자열로 받던 첫 판에서는 「이름 색」이라는 대조축을 마크업에
   * 둘 수 없었다. 그 축이 없으면 **작업 중 줄이 없을 때** — 에이전트 턴이 없는
   * 대부분의 시각 — 사람 줄이 가진 단서는 「작성」과 「작업」을 가르는 한 음절과
   * 「님」뿐이 된다.
   *
   * 코어의 앞부분·서술어 경계를 그대로 그리고, 이름만 굵은 사람 잉크로 칠한다.
   */
  segments: readonly TypingSegment[];
  /**
   * 보조기술이 읽을 이름 (코어의 `typingLabel`). 문장과 같은 값이되 말줄임표가
   * 없다 — 스크린리더는 「…」을 「점점점」으로 읽거나 통째로 삼키고, 둘 다 이 줄이
   * 하려는 말이 아니다. 없으면 문장을 그대로 읽는다.
   */
  label?: string | null;
  testID?: string;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const {fontScale} = useWindowDimensions();
  // 줄 폭과 거울이 잰 조각 폭(#5645). 둘 다 두 이름이 넘칠 때 이름 칸의 몫을 셈하는 데만 쓴다.
  const [lineWidth, setLineWidth] = useState(0);
  const [natural, setNatural] = useState<Readonly<Record<string, number>>>({});
  const empty = segments.length === 0;
  const cells = typingNameCells(typingLead(segments));
  const tail = typingTail(segments);
  const keys = cells.map(cell => pieceKey(cell.name ? 'name' : 'text', cellText(cell)));
  const tailKey = pieceKey('tail', tail?.text ?? '');
  // 재는 것은 두 이름일 때뿐이다(한 이름은 줄어드는 칸이 하나라 앞 판 그대로가 같은 답이다).
  const measuring = cells.filter(cell => cell.name).length >= 2;
  const widths = measuring ? measuredNameWidths(cells, keys, tailKey, natural, lineWidth) : null;
  const onLine = (event: LayoutChangeEvent): void => {
    const next = event.nativeEvent.layout.width;
    setLineWidth(previous => (previous === next ? previous : next));
  };
  // 잰 폭을 기억한다. 지금 줄에 있는 조각만 남겨 기억이 쌓이지 않는다(이름이 바뀌면 바뀐 조각만 다시 잰다).
  const remember = (key: string, width: number): void =>
    setNatural(previous => {
      if (previous[key] === width) return previous;
      const next: Record<string, number> = {[key]: width};
      for (const kept of [...keys, tailKey]) {
        if (kept !== key && previous[kept] !== undefined) next[kept] = previous[kept];
      }
      return next;
    });
  // 이름 칸의 시험 표지. 이름마다 자기 한 줄 칸이다(#5582 R2-M1, 코어 `typingNameCells`).
  const nameCellTestID = `${testID}-name`;
  return (
    <View
      accessible={!empty}
      accessibilityRole="text"
      accessibilityElementsHidden={empty}
      importantForAccessibility={empty ? 'no-hide-descendants' : 'auto'}
      accessibilityLabel={empty ? undefined : label ?? segments.map(part => part.text).join('')}
      // 누르는 것이 없는 줄이다. 위 레일(`ActivityRailSlot`)의 손가락 슬롭이 이 줄 위로 내려오므로 이 줄이 터치를 가로채지 않게 한다(#4620).
      pointerEvents="none"
      // 칸 높이는 인라인이다 — 글자 배율을 곱한 값이라 스타일시트에 못 박지 못한다(레일 칸과 같다).
      style={[styles.line, {height: typingSlotHeight(fontScale)}]}
      onLayout={onLine}
      testID={testID}>
      {!empty ? (
        <>
          <View style={styles.lead}>
            {cells.map((cell, index) => {
              const width = widths?.[index];
              return (
                <Text
                  key={index}
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                  numberOfLines={1}
                  style={[cell.name ? styles.nameCell : styles.textCell, width !== undefined && {width}]}
                  testID={cell.name ? nameCellTestID : undefined}>
                  {cell.segments.map((segment, at) => (
                    <Text key={at} style={segment.kind === 'name' ? styles.name : undefined}>
                      {segment.text}
                    </Text>
                  ))}
                </Text>
              );
            })}
          </View>
          {/* 사람의 줄이라 점은 글자와 같은 흐린 잉크다(에이전트 색은 에이전트 줄에만, #5645). */}
          <RespondingDots human />
          <Text maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE} numberOfLines={1} style={styles.tail}>
            {tail?.text}
          </Text>
          {measuring ? (
            // 거울: 같은 글 · 같은 옷 · 같은 상한으로 그린 숨은 조각들. 흐름 밖(절대 배치)이라 줄을 밀지 않고, 보이지도
            // 읽히지도 눌리지도 않는다. 각 조각의 제 폭(줄어들기 전 폭)만 잰다.
            <View
              accessibilityElementsHidden
              importantForAccessibility="no-hide-descendants"
              pointerEvents="none"
              style={styles.mirror}
              testID={`${testID}-measure`}>
              {cells.map((cell, index) => (
                <Text
                  key={`${index}:${keys[index]}`}
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                  numberOfLines={1}
                  onLayout={event => remember(keys[index], event.nativeEvent.layout.width)}
                  style={cell.name ? styles.nameCell : styles.textCell}
                  testID={`${testID}-measure-${index}`}>
                  {cell.segments.map((segment, at) => (
                    <Text key={at} style={segment.kind === 'name' ? styles.name : undefined}>
                      {segment.text}
                    </Text>
                  ))}
                </Text>
              ))}
              <Text
                key={tailKey}
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                numberOfLines={1}
                onLayout={event => remember(tailKey, event.nativeEvent.layout.width)}
                style={styles.tail}
                testID={`${testID}-measure-tail`}>
                {tail?.text}
              </Text>
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  /**
   * meta 크기, 가장 흐린 글자. 이 줄은 **대화에 대한 서술**이지 대화가 아니다 —
   * 묘비·롤업·활동 줄이 이미 쓰고 있는 무게이고, 여기서 한 급이라도 올리면
   * 사람이 쓴 메시지와 경쟁하기 시작한다.
   */
  line: {
    paddingHorizontal: SAFE_GUTTER,
    flexDirection: 'row',
    alignItems: 'center',
    columnGap: space.xs,
    // 자리 예약의 실체 (H-3)는 인라인 `height`(`typingSlotHeight`)다: 줄이 비어도 그 높이가 남으므로 아래의 컴포저와
    // 위의 대화가 남의 키보드 박자로 움직이지 않는다.
    // 흐름에서는 `typingReserve` 만 먹는다 — 줄 상자의 아래 `TYPING_OVERHANG` 는 다음 형제의 위 여백 위에
    // 걸친다(머리말 「예약은 12, 줄 상자는 16」).
    marginBottom: -TYPING_OVERHANG,
  },
  // 앞부분: 이름 칸들이 한 줄로 선다. 줄어드는 것은 이 묶음이고, 그 안에서 이름 칸마다 줄어든다(`typingNameCells`).
  lead: {flexDirection: 'row', flexShrink: 1, minWidth: 0},
  // 이름 칸: 넘치면 자기 안에서 말줄임된다. 두 이름이 넘치면 셈한 명시 폭을 더 받는다(#5645).
  nameCell: {flexShrink: 1, fontSize: font.meta, lineHeight: lineScale.meta, color: color.textMuted},
  // 이름 아닌 칸(「 외 2명」·쉼표 뒤 빈칸): 줄지 않는다.
  textCell: {flexShrink: 0, fontSize: font.meta, lineHeight: lineScale.meta, color: color.textMuted},
  tail: {flexShrink: 0, fontSize: font.meta, lineHeight: lineScale.meta, color: color.textMuted},
  // 이름만 한 급 밝다 (M-4). 「작성」과 「작업」을 가르는 한 음절 말고 **눈에
  // 보이는 축**을 하나 준다 — 에이전트 줄은 이름을 agent 색으로 칠한다.
  name: {color: color.text, fontWeight: '700'},
  // 재는 거울(#5645): 흐름 밖에 서고 보이지 않는다. 조각마다 제 글 폭으로 서도록 세로로 쌓고 왼쪽에 붙인다.
  mirror: {position: 'absolute', top: 0, left: 0, opacity: 0, alignItems: 'flex-start'},
});
