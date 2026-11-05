import React from 'react';
import {Image, Pressable, StyleSheet, Text, View, type ViewStyle} from 'react-native';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {GlassSurface} from '../../design/glass';
import {CONV_ICONS, CONV_ICON_SIZE, HOME_ICONS, HOME_ICON_SIZE} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {font, line, slopTo, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {CONV} from './convDesign';
import type {SearchPosition} from './conversationSearchModel';

// =============================================================================
// 결과로 이동한 뒤 컴포저 **자리**에 서는 이동 막대 (#5364, 시안 A4) — 「목록」 · 「3 / 20+」 · ↑ ↓.
//
// 검색 중에는 글을 못 쓰므로 막대가 컴포저를 대신하고(X 로 검색을 끝내면 컴포저가 돌아온다), 그래서 컴포저 알약과 **같은 치수**를 쓴다: 같은
// 유리 · 같은 반경(`composerRadius`) · 같은 바깥 여백(`composerDockInset`) · 원 36 이 알약 가장자리에서 사방 9 다. 막대가 서고 걷힐 때 도크의
// 높이가 거의 움직이지 않는다.
//
// ## 번호와 방향
//
// 번호는 최근 결과가 1번이다(`conversationSearchModel.ts` 머리말). ↑ 는 **더 오래된** 결과(대화 화면의 위쪽이 오래된 글이다), ↓ 는 더 최근 결과다.
// 총 건수는 서버가 주지 않으므로 다 불러오기 전에는 「3 / 20+」, 다 불러오면 정확한 수다 — 낭독도 같은 사실을 말한다(「20개 이상 중 3번째」).
// 단추의 비활성은 색(글리프가 `textFaint`)과 접근성 상태(`disabled`)로 말한다. ↑ 가 불러온 끝에서 다음 쪽을 불러오는 동안은 `busy` 다.
// =============================================================================

/**
 * 대화 안 검색이 열린 동안 컴포저 묶음에 입히는 스타일(#5364). 걷지 않고 **숨긴다** — 마운트가 유지돼서 쓰던 글·첨부·답글 머리말이 그대로고, 검색을 끝내면 그 자리에서
 * 돌아온다. 이 막대와 같은 파일에 두는 이유는 짝이라서다(막대가 서는 동안 컴포저가 숨는다).
 */
export const COMPOSER_HIDDEN: ViewStyle = {display: 'none'};

/** 알약 안쪽 여백 — 알약의 선(헤어라인)을 던 값이라 원이 바깥 가장자리에서 사방 `composerGap` 이다(`Composer` 의 `BAR_PAD_X` 와 같은 식). */
const BAR_PAD = CONV.composerGap - StyleSheet.hairlineWidth;
const CIRCLE_SLOP = slopTo(CONV.composerCircle);

export function ConversationSearchBar({
  position,
  query,
  canOlder,
  canNewer,
  loadingMore,
  onList,
  onOlder,
  onNewer,
}: {
  position: SearchPosition;
  /** 지금 보는 결과가 어떤 말에 대한 것인지. 막대 한가운데 번호 옆에 작게 선다. */
  query: string;
  canOlder: boolean;
  canNewer: boolean;
  /** ↑ 가 다음 쪽을 불러오는 중. */
  loadingMore: boolean;
  onList: () => void;
  onOlder: () => void;
  onNewer: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const formatMessage = useFormatMessage();
  // 사전의 평범한 `{…}` 인자는 글이다(숫자 서식이 아니다) — 번호는 자릿수 구분이 없는 그대로의 수다.
  const args = {index: String(position.index), total: String(position.total)};
  const label = formatMessage(position.more ? 'mobile.convSearch.positionMore' : 'mobile.convSearch.position', args);
  const spoken = formatMessage(
    position.more ? 'mobile.convSearch.positionSpokenMore' : 'mobile.convSearch.positionSpoken',
    args,
  );
  return (
    <View style={styles.dock} testID="conversation-search-bar">
      <GlassSurface radius={CONV.composerRadius} style={styles.pill} testID="conversation-search-bar-pill">
        <View style={styles.bar}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={formatMessage('mobile.convSearch.barList')}
            onPress={onList}
            hitSlop={CIRCLE_SLOP}
            style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
            testID="conversation-search-list">
            <Image source={CONV_ICONS.list} style={[styles.icon, {tintColor: palette.text}]} />
          </Pressable>
          <View
            accessible
            accessibilityRole="text"
            accessibilityLabel={spoken}
            accessibilityLiveRegion="polite"
            style={styles.center}
            testID="conversation-search-position">
            <Text style={styles.position} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE} testID="conversation-search-position-text">
              {label}
            </Text>
            <Text style={styles.query} numberOfLines={1} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              {`‘${query}’`}
            </Text>
          </View>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={formatMessage('mobile.convSearch.barOlder')}
            accessibilityState={{disabled: !canOlder, busy: loadingMore}}
            disabled={!canOlder || loadingMore}
            onPress={onOlder}
            hitSlop={CIRCLE_SLOP}
            style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
            testID="conversation-search-older">
            <Image
              source={CONV_ICONS.chevronUp}
              style={[styles.icon, {tintColor: canOlder ? palette.text : palette.textFaint}]}
            />
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={formatMessage('mobile.convSearch.barNewer')}
            accessibilityState={{disabled: !canNewer}}
            disabled={!canNewer}
            onPress={onNewer}
            hitSlop={CIRCLE_SLOP}
            style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
            testID="conversation-search-newer">
            <Image
              source={HOME_ICONS.down}
              style={[styles.iconDown, {tintColor: canNewer ? palette.text : palette.textFaint}]}
            />
          </Pressable>
        </View>
      </GlassSurface>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 컴포저 도크와 같은 바깥 여백(`Composer` 의 `floatInset`).
    dock: {paddingHorizontal: CONV.composerDockInset, paddingTop: CONV.composerTopAir},
    pill: {
      borderRadius: CONV.composerRadius,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.glassLine,
      boxShadow: color.elevationRest,
    },
    bar: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      padding: BAR_PAD,
    },
    circle: {
      width: CONV.composerCircle,
      height: CONV.composerCircle,
      borderRadius: CONV.composerCircle / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surfaceMuted,
    },
    circlePressed: {backgroundColor: color.surfacePressed},
    icon: {width: CONV_ICON_SIZE.list, height: CONV_ICON_SIZE.list},
    iconDown: {width: HOME_ICON_SIZE.down, height: HOME_ICON_SIZE.down},
    center: {flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'center', gap: space.sm},
    position: {fontSize: font.heading, lineHeight: line.heading, color: color.text, fontWeight: '700'},
    query: {flexShrink: 1, fontSize: font.label, lineHeight: line.label, color: color.textMuted},
  });
