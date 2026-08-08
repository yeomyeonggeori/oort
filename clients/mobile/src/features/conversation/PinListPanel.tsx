import {
  PIN_EMPTY_BODY_TEXT,
  PIN_LIST_EMPTY_DETAIL,
  PIN_LIST_EMPTY_HEADLINE,
  PIN_LIST_FAILED_DETAIL,
  PIN_LIST_FAILED_HEADLINE,
  pinExcerpt,
  pinList,
  pinListHeaderLabel,
  pinStampLabel,
  pinStampSegments,
  type PinListStatus,
  type PinMap,
  type PinnedMessage,
} from '@momo/core/features/timeline/pins';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo} from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {EmptyState, ErrorState, Screen, ScreenHeader} from '../../design/atoms';
import {font, line, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {EdgeSwipeBack} from '../../nav/EdgeSwipeBack';
import {appNote} from './appVoice';

// =============================================================================
// 채널의 고정 목록 (이슈 #1112 · 후속 #1146) — 폰 몫.
//
// ## 왜 바텀 시트가 아니라 덮는 화면인가 (이 앱이 이미 적어 둔 관례)
//
// `AdeControlPanel` 머리말이 두 관례를 실측해 두었고, 그 판정을 그대로 쓴다:
//
//   `Modal transparent` + 바텀 시트   화면에 있는 **한 대상**에 대한 행동의 묶음.
//     (`MessageActionSheet`)          길이가 고정이고, 닫으면 있던 자리로 온다.
//   `EdgeSwipeBack` + `Screen`        **가는 곳**. 훑어보는 목록이고 거기서 다른
//     (`ThreadPanel`·`SearchScreen`)  데로 떠난다. 자기 헤더와 뒤로가기를 갖는다.
//
// 고정 목록은 두 번째다. 길이가 채널당 0~100 사이에서 변하고(서버 상한), 항목마다
// 하는 일이 **여기서 나가는 것**이다. 시트로 만들면 85% 높이 안에 스크롤을 하나 더
// 접어 넣게 되는데 그 아래에는 이미 스크롤하는 타임라인이 있다.
//
// 웹은 같은 목록을 헤더 버튼의 드롭다운으로 낸다. 두 앱이 다른 껍데기를 쓰는 것은
// 분열이 아니라 각자의 관례다 — 마우스가 여는 메뉴는 320px 안에서 열리고 닫히지만,
// 엄지가 여는 목록은 화면이어야 100개를 훑을 수 있다. 안에 든 낱말과 순서는 코어의
// 같은 함수(`pinList`·`pinListHeaderLabel`)에서 오므로 두 화면이 다른 말을 하지
// 않는다.
//
// ## #1146 M2 — 못 불러온 목록은 「없다」고 말하지 않는다
//
// 1차는 `/pins` 가 실패해도 조용히 빈 지도로 남았고, 그래서 오프라인에서 이 화면을
// 연 사람은 「고정한 메시지가 없습니다」를 읽었다. 채널에 고정이 열 개 있어도.
// 읽은 사람은 고정이 지워졌다고 결론 내린다. 이제 상태를 받아 셋을 갈라 그리고,
// 실패한 목록에 프레임으로 들어온 항목이 있으면 **둘 다** 그린다.
//
// ## 누르면 원본으로 간다 — 그리고 새 항법을 만들지 않는다
//
// `onJump`는 대화 화면이 인용 점프에 이미 쓰는 `jumpTarget` 기계를 그대로 태운다.
// 못 찾았을 때의 문장도 그 자리(`quote-jump-missed`)에 이미 있다. 고정 목록이
// 자기만의 「못 찾았습니다」를 새로 그리면 같은 사실을 두 군데서 말하게 된다.
// =============================================================================

/** 한 줄이 감당할 만큼만. 나머지는 원본에 있고, 한 번 누르면 거기로 간다. */
const EXCERPT_MAX_CHARS = 80;

/**
 * 이 줄이 **누구의 말인가**.
 *
 * 자르는 규칙은 코어의 것이다(`pinExcerpt` — 서로게이트를 반토막 내지 않는 절단).
 * 여기 남는 것은 **격**뿐이다: 본문이 있으면 저자의 말이고, 없으면 앱의 서술이며,
 * 앱의 서술은 `※` 를 달고 흐린 색으로 선다(`appVoice.ts`). 카드 안에서 그 둘이
 * 같은 결로 서면 사람은 앱의 해명을 남의 말로 읽는다.
 */
function excerptLine(body: string | null): {text: string; ours: boolean} {
  const excerpt = pinExcerpt(body, EXCERPT_MAX_CHARS);
  return excerpt.empty
    ? {text: appNote(excerpt.text), ours: true}
    : {text: excerpt.text, ours: false};
}

export function PinListPanel({
  pins,
  status,
  directory,
  nowMs,
  onJump,
  onClose,
  onRetry,
}: {
  pins: PinMap;
  /** 이슈 #1146 M2 — 빈 지도가 무엇을 뜻하는지 아는 유일한 값. */
  status: PinListStatus;
  directory: Directory;
  /** 도장이 「오늘」인지 아는 데 필요한 값. 대화 화면의 시계를 그대로 받는다. */
  nowMs: number;
  /** 원본으로 간다. 대화 화면의 기존 점프 기계를 그대로 탄다. */
  onJump: (messageId: string, seq: number) => void;
  onClose: () => void;
  /** 목록만 다시 읽는다(채널 전체가 아니라). 실패 문장 뒤의 행동. */
  onRetry: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const entries = useMemo(() => pinList(pins), [pins]);

  const openEntry = useCallback(
    (entry: PinnedMessage) => {
      // 목록은 물러나고 그 줄이 열린다. 둘이 겹쳐 서면 위가 아래를 가린 채로
      // 남고, 사람은 방금 누른 것이 어디 갔는지 모른다 (작업 목록과 같은 규칙).
      onClose();
      onJump(entry.messageId, entry.seq);
    },
    [onClose, onJump],
  );

  return (
    // 스레드 패널·작업 목록과 같은 층·같은 제스처. 대화의 엣지 스와이프 래퍼와
    // 부모-자식으로 겹치고 안쪽이 이긴다는 판정은 `EdgeSwipeBack` 이 스스로 한다.
    <EdgeSwipeBack
      style={styles.overlay}
      onBack={onClose}
      testID="pin-list-pane">
      <Screen>
        <ScreenHeader
          title={pinListHeaderLabel(entries.length, status)}
          onBack={onClose}
          // 「뒤로」가 아니다. 덮고 있는 표면은 자기가 무엇을 닫는지 말한다.
          backLabel="고정 목록 닫기"
          titleTestID="pin-list-title"
        />
        <FlatList
          data={entries}
          keyExtractor={entry => entry.messageId}
          testID="pin-list"
          contentContainerStyle={styles.listBody}
          // 실패는 목록 **위에** 선다 (이슈 #1146 M2). 빈 자리를 차지하는 것이
          // 아니라 머리에 서는 이유는, 프레임으로 들어온 항목이 있을 수 있기
          // 때문이다 — 「가진 것은 이게 전부가 아니다」와 「가진 것은 이것들이다」는
          // 둘 다 참이고, 둘 다 말해야 한다.
          //
          // `ErrorState` 를 쓰는 것은 스레드 패널이 답글을 못 불러왔을 때 하는
          // 것과 같다: 무슨 일이 있었는지와 다음에 할 일이 한 블록에 있고,
          // 「다시 시도」는 그 원자가 스스로 그린다.
          ListHeaderComponent={
            status === 'failed' ? (
              <ErrorState
                headline={PIN_LIST_FAILED_HEADLINE}
                detail={PIN_LIST_FAILED_DETAIL}
                onRetry={onRetry}
                testID="pin-list-failed"
              />
            ) : null
          }
          ListEmptyComponent={
            // 셋 중 하나만 말한다. **실패했을 때 「없습니다」를 함께 말하지 않는
            // 것**이 이 갈래의 요점이고(둘은 서로 반대되는 주장이다), 아직
            // 불러오는 중일 때도 마찬가지다 — 한 번의 REST 왕복은 문장을 세울
            // 만큼 길지 않고, 그 사이에 「없습니다」를 그리면 다음 순간 스스로를
            // 뒤집는다.
            status === 'ready' ? (
              <EmptyState
                // 두 조각을 코어에서 든다. 제목을 손으로 적으면 설명과 갈라지고,
                // 한 문자열을 둘 다에 넘기면 같은 문장이 두 번 인쇄된다(실측).
                headline={PIN_LIST_EMPTY_HEADLINE}
                detail={PIN_LIST_EMPTY_DETAIL}
                testID="pin-list-empty"
              />
            ) : null
          }
          renderItem={({item}) => {
            const name = memberNameParts(
              directory,
              item.authorMemberId,
              '알 수 없는 멤버',
            ).name;
            const excerpt = excerptLine(item.body);
            return (
              <Pressable
                accessibilityRole="button"
                // 이름 하나로 무엇이 열릴지 다 말한다: 화면에는 두 줄이지만
                // VoiceOver 에게는 한 문장이어야 한다.
                //
                // 라벨에는 `※` 가 없다 — 그 표시는 눈으로 훑을 때 「본문이 아님」을
                // 주는 것이지 소리 내어 읽을 것이 아니다(`appVoice.ts` 의 규율).
                //
                // 도장은 **절대 날짜로** 읽힌다: 눈은 「오늘」로 충분하지만 귀에
                // 「오늘」만 남기는 것은 정보를 빼는 것이다(`pinStampLabel`).
                accessibilityLabel={`${name}, ${pinStampLabel(
                  item.pinnedAtMs,
                )}, ${excerpt.ours ? PIN_EMPTY_BODY_TEXT : excerpt.text}, 원본으로 이동`}
                onPress={() => openEntry(item)}
                style={({pressed}) => [styles.card, pressed && styles.pressed]}
                testID="pin-list-item">
                <View style={styles.cardHead}>
                  <Text style={styles.author} numberOfLines={1}>
                    {name}
                  </Text>
                  {/* **고정된 때**이지 쓰인 때가 아니다 (#1146 N1): 이 열이 목록의
                      정렬 근거이고, 다른 값을 그리면 정렬이 깨진 것처럼 보인다.
                      자릿폭 표지는 숫자에만 — 한글 음절이 함께 잡히면
                      「8월  5일」로 벌어진다(`divider.ts` 실측). */}
                  <Text style={styles.day} testID="pin-list-stamp">
                    {pinStampSegments(item.pinnedAtMs, nowMs).map(
                      (segment, index) =>
                        segment.kind === 'figure' ? (
                          <Text key={index} style={styles.figure}>
                            {segment.text}
                          </Text>
                        ) : (
                          segment.text
                        ),
                    )}
                  </Text>
                </View>
                <Text
                  style={[styles.body, excerpt.ours && styles.ourWords]}
                  numberOfLines={2}>
                  {excerpt.text}
                </Text>
              </Pressable>
            );
          }}
        />
      </Screen>
    </EdgeSwipeBack>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.bg,
  },
  listBody: {paddingVertical: space.sm},
  card: {
    // 두 줄짜리 항목이라 높이는 고정이 아니라 바닥이다 — 접근성 글꼴에서 줄이
    // 자라면 카드가 함께 자라야 하고, 고정 높이는 그때 두 번째 줄을 자른다.
    minHeight: TOUCH_TARGET,
    justifyContent: 'center',
    gap: space.xs,
    marginHorizontal: SAFE_GUTTER,
    marginVertical: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: color.border,
    borderRadius: radius.md,
    backgroundColor: color.surface,
  },
  pressed: {backgroundColor: color.surfacePressed},
  cardHead: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: space.sm,
  },
  author: {
    flexShrink: 1,
    color: color.textMuted,
    fontSize: font.label,
    lineHeight: line.label,
  },
  day: {
    marginLeft: 'auto',
    color: color.textFaint,
    fontSize: font.meta,
    lineHeight: line.meta,
  },
  figure: {fontVariant: ['tabular-nums']},
  body: {
    color: color.text,
    fontSize: font.body,
    lineHeight: line.body,
  },
  // 앱이 말하는 줄. 색은 AA 를 지나는 데만 쓰고, 구분은 `※` 가 든다.
  ourWords: {color: color.textMuted},
});
