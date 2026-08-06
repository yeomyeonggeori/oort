import {
  PIN_EMPTY_BODY_TEXT,
  PIN_LIST_EMPTY_DETAIL,
  PIN_LIST_EMPTY_HEADLINE,
  pinList,
  pinListLabel,
  type PinMap,
  type PinnedMessage,
} from '@momo/core/features/timeline/pins';
import {memberNameParts} from '@momo/core/features/workspace/directory';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useMemo} from 'react';
import {FlatList, Pressable, StyleSheet, Text, View} from 'react-native';
import {EmptyState, Screen, ScreenHeader} from '../../design/atoms';
import {
  color,
  font,
  line,
  radius,
  SAFE_GUTTER,
  space,
  TOUCH_TARGET,
} from '../../design/tokens';
import {EdgeSwipeBack} from '../../nav/EdgeSwipeBack';
import {appNote} from './appVoice';

// =============================================================================
// 채널의 고정 목록 (이슈 #1112) — 폰 몫.
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
// 같은 함수(`pinList`·`pinListLabel`)에서 오므로 두 화면이 다른 말을 하지 않는다.
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
 * 본문이 있으면 저자의 말이고, 없으면 앱의 서술이다 — 그리고 앱의 서술은 `※` 를
 * 달고 흐린 색으로 선다(`appVoice.ts`). 카드 안에서 그 둘이 같은 결로 서면 사람은
 * 앱의 해명을 남의 말로 읽는다. 텍스트 첨부만 있는 메시지가 정확히 이 경우다.
 */
function excerpt(body: string | null): {text: string; ours: boolean} {
  const text = body?.trim();
  if (!text) return {text: appNote(PIN_EMPTY_BODY_TEXT), ours: true};
  const flattened = text.replace(/\s+/g, ' ');
  return {
    text:
      flattened.length > EXCERPT_MAX_CHARS
        ? `${flattened.slice(0, EXCERPT_MAX_CHARS)}…`
        : flattened,
    ours: false,
  };
}

function dayLabel(atMs: number): string {
  const at = new Date(atMs);
  return `${at.getMonth() + 1}월 ${at.getDate()}일`;
}

export function PinListPanel({
  pins,
  directory,
  onJump,
  onClose,
}: {
  pins: PinMap;
  directory: Directory;
  /** 원본으로 간다. 대화 화면의 기존 점프 기계를 그대로 탄다. */
  onJump: (messageId: string, seq: number) => void;
  onClose: () => void;
}): React.JSX.Element {
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
          title={pinListLabel(entries.length)}
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
          ListEmptyComponent={
            <EmptyState
              // 두 조각을 코어에서 든다. 제목을 손으로 적으면 설명과 갈라지고,
              // 한 문자열을 둘 다에 넘기면 같은 문장이 두 번 인쇄된다(실측).
              headline={PIN_LIST_EMPTY_HEADLINE}
              detail={PIN_LIST_EMPTY_DETAIL}
              testID="pin-list-empty"
            />
          }
          renderItem={({item}) => {
            const name = memberNameParts(
              directory,
              item.authorMemberId,
              '알 수 없는 멤버',
            ).name;
            const excerptLine = excerpt(item.body);
            return (
              <Pressable
                accessibilityRole="button"
                // 이름 하나로 무엇이 열릴지 다 말한다: 화면에는 두 줄이지만
                // VoiceOver 에게는 한 문장이어야 한다.
                //
                // 라벨에는 `※` 가 없다 — 그 표시는 눈으로 훑을 때 「본문이 아님」을
                // 주는 것이지 소리 내어 읽을 것이 아니다(`appVoice.ts` 의 규율).
                accessibilityLabel={`${name}, ${
                  excerptLine.ours ? PIN_EMPTY_BODY_TEXT : excerptLine.text
                }, 원본으로 이동`}
                onPress={() => openEntry(item)}
                style={({pressed}) => [styles.card, pressed && styles.pressed]}
                testID="pin-list-item">
                <View style={styles.cardHead}>
                  <Text style={styles.author} numberOfLines={1}>
                    {name}
                  </Text>
                  <Text style={styles.day}>{dayLabel(item.createdAtMs)}</Text>
                </View>
                <Text
                  style={[styles.body, excerptLine.ours && styles.ourWords]}
                  numberOfLines={2}>
                  {excerptLine.text}
                </Text>
              </Pressable>
            );
          }}
        />
      </Screen>
    </EdgeSwipeBack>
  );
}

const styles = StyleSheet.create({
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
  body: {
    color: color.text,
    fontSize: font.body,
    lineHeight: line.body,
  },
  // 앱이 말하는 줄. 색은 AA 를 지나는 데만 쓰고, 구분은 `※` 가 든다.
  ourWords: {color: color.textMuted},
});
