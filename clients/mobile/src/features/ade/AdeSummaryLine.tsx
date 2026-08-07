import {
  adeSummaryLabel,
  adeSummarySegments,
  type AdeSummarySegmentKind,
} from '@momo/core/features/work/adeControl';
import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {font, line, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {useAdeControl} from './useAdeControl';

// =============================================================================
// 대화 화면의 **한 줄** (ADR-0154 D2 — 성재 수정: "대화 공간에는 '실행 중인 작업
// 1개…' 같은 summary로 보이고 클릭하면 drawer 형태").
//
// 3층의 첫 층이다. 이 줄이 나르는 정보는 **개수와 상태 두 가지**이고, 그 이상은
// 아래층의 몫이다: 무엇이 도는지는 관제 목록이, 어떻게 도는지는 데스크톱의
// 터미널이 말한다(ADR-0137 D5 가 폰에서 PTY 를 내렸다).
//
// ## 왜 컴포저 액세서리 스택이 아니라 헤더 아래인가 (실측)
//
// 컴포저 위에는 이미 줄이 쌓여 있다 — 위에서부터 `AgentActivityBar`(작업 중),
// `TypingBar`(작성 중), 중단 영수증, 롱프레스 힌트. 그 스택에 끼우지 않은 이유가
// 셋이고, 셋 다 그 스택이 스스로 적어 둔 규율에서 나온다.
//
//  1. **스코프가 다르다.** 그 스택의 모든 줄은 **이 채널**에 대한 말이다
//     (`agentTurnsInChannel` 로 좁힌다). 이 줄은 워크스페이스 전역 집계다. 나란히
//     세우면 「김인턴이 작업 중」 바로 위에 「실행 중인 작업 3개」가 서고, 두 줄은
//     같은 낱말로 다른 모집단을 세게 된다 — 읽는 사람에게 그 3 은 이 방의 3 이다.
//  2. **그 스택은 엄지 밑에서 움직이면 안 되는 자리다.** design-review M-5/H-3 이
//     이미 그 자리를 정리했다: 나타나고 사라지는 줄이 캐럿과 「중단」 버튼을 밀지
//     않도록 자리를 **예약**한 것이 그 수리다. 반면 이 줄의 계약은 코어가 정한
//     대로 **자리를 예약하지 않는 것**이다(`adeSummarySegments`: 없을 때 아무 말도
//     하지 말라). 예약하지 않는 줄을 예약된 스택에 끼우면 둘 중 하나를 어긴다.
//  3. **여기서는 아무것도 밀지 않는다.** 컴포저는 `ConversationLayout` 의 바닥에
//     고정돼 있고 타임라인은 바닥 정렬이라, 헤더 아래에서 이 줄이 생겼다 사라지며
//     바뀌는 것은 목록의 가용 높이뿐이다 — 읽던 줄은 제자리에 남는다. 웹이 라우트
//     맨 위를 고른 논거가 폰에서도 그대로 성립하는 이유이고, 실제로 성립하는지는
//     `__tests__/adeControlSurface.test.tsx` 가 컴포저 도크의 스타일을 열기 전후로
//     비교해서 잰다.
//
// ## 시계를 마운트하지 않는다
//
// 이 줄은 숫자를 세지 경과를 인쇄하지 않으므로 1Hz 가 필요 없다. 다시 그려져야
// 하는 순간은 **사실이 바뀐 때**이고, 그때는 스토어가(publish·clear·15초 sweep)
// 또는 질의가 이미 렌더를 일으킨다. 에이전트 탭이 같은 판단을 같은 이유로 적어
// 두었다 — 초당 한 번 다시 그리는 목록은 아무도 안 보는 화면의 배터리다.
//
// ## live 영역이 아니다
//
// `accessibilityLiveRegion`/`announceForAccessibility` 를 걸지 않는다. 갱신이 잦고
// 낭독이 사람의 작업을 끊는다. 문장은 접근성 트리에 있으므로 읽으려는 사람은
// 언제든 읽을 수 있다. 반드시 알아야 하는 전이(승인 요청·멘션)는 이 줄이 아니라
// 인박스와 푸시의 몫이다.
// =============================================================================

/**
 * 조각 종류 -> 표지. 대기만 색을 입는다.
 *
 * 폰의 앰버는 「사람이 필요하다」이고(`tokens.ts`: "Something needs a person:
 * unread counts, pending approvals"), 그것이 D1 이 `blocked` 에 준 뜻과 같은
 * 문장이다. 웹이 같은 자리에 accent 를 쓰는 것을 그대로 베끼지 않는 이유는 폰에서
 * accent 가 「내가 한 것」이기 때문이다(`conversationHygiene` 이 인용 착지 틴트에서
 * 같은 판정을 이미 적었다) — 같은 색이 두 앱에서 다른 것을 뜻하면 베끼는 쪽이
 * 틀린다.
 */
const buildSegmentStyle = (
  color: Palette,
): Readonly<Record<AdeSummarySegmentKind, {color: string}>> => ({
  plain: {color: color.textMuted},
  count: {color: color.text},
  blocked: {color: color.warn},
  blockedCount: {color: color.warn},
});

export function AdeSummaryLine({
  onPress,
}: {
  onPress: () => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const segmentStyle = useStyles(buildSegmentStyle);
  // 시계 없는 렌더의 자기 시각(위 머리말). 이 값은 만료 격자로 양자화되어 들어간다.
  const {counts} = useAdeControl(Date.now(), false);
  const segments = adeSummarySegments(counts);
  const label = adeSummaryLabel(counts);

  // 살아 있는 작업이 없으면 **줄 자체가 없다.** 빈 띠도 남기지 않는다 — 판정은
  // 코어의 것이고(`adeSummarySentence` 가 null 이면 줄이 없다), 그 근거는
  // `adeSummarySegments` 주석에 셋으로 적혀 있다.
  if (segments.length === 0 || label === null) return null;

  return (
    <Pressable
      accessibilityRole="button"
      // 보조기술이 읽는 것은 이것 하나다. 아래 보이는 조각들은 폭에 따라 잘릴 수
      // 있고, 잘린 문장을 읽어 주는 것은 이 줄이 하려는 말이 아니다. `Pressable`
      // 은 기본이 `accessible` 이라 안쪽 조각들은 이 라벨로 합쳐진다.
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID="ade-summary">
      <Text
        style={styles.text}
        numberOfLines={1}
        ellipsizeMode="tail"
        testID="ade-summary-text">
        {segments.map((segment, index) => (
          <Text key={index} style={segmentStyle[segment.kind]}>
            {segment.text}
          </Text>
        ))}
      </Text>
      {/* 오른쪽 꺾쇠 하나. 상태 점이 아니라 **방향**이라 장식이 아니고, 방향이
          오른쪽인 것은 이 컨트롤이 여는 것이 접히는 서랍이 아니라 **덮는 화면**
          이기 때문이다(iOS 의 disclosure indicator 가 뜻하는 그것). 헤더의 「‹」와
          같은 글리프 가족이라 아이콘 자산이 하나도 들어오지 않는다. */}
      <Text style={styles.chevron}>›</Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  row: {
    // 헤더 아래에 붙는 한 줄. `TOUCH_TARGET` 을 깔고 앉는다 — 이 앱의 모든 누를
    // 것이 지는 바닥이고, 12pt 글자 한 줄은 그것 없이는 17pt 다.
    minHeight: TOUCH_TARGET,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingHorizontal: SAFE_GUTTER,
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    backgroundColor: color.bg,
  },
  pressed: {backgroundColor: color.surfacePressed},
  text: {flex: 1, fontSize: font.meta, lineHeight: line.meta},
  chevron: {fontSize: font.heading, lineHeight: line.body, color: color.textFaint},
});
