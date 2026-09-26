import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback} from 'react';
import {
  ActionSheetIOS,
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {GlassSurface} from '../../design/glass';
import {
  CONV_ICONS,
  CONV_ICON_SIZE,
  HOME_ICONS,
  type ConvIconName,
} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {ds2Radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Avatar} from './Avatar';
import {CONV} from './convDesign';

// =============================================================================
// 대화 머리 — 시안 A `.a-hd` + owner 표의 Buzz 대조 (DS2-4 #2716).
//
//   [ ‹ ]  # agent-lab            [🎧] [ ⋮ ]
//          6명 · 김인턴 참여 중
//
// * 뒤로는 42 원(`.a-cbtn`, surface + sh1). 옛 머리의 파란 「‹」 글자는 누르는
//   자리가 보이지 않았다.
// * 제목은 **왼쪽 정렬**이다. 시안은 가운데 제목 + 오른쪽 아바타 더미였지만 owner
//   표가 오른쪽 자리를 「아이콘 액션(허들, ⋮)」으로 정했고, 오른쪽이 아이콘 둘이면
//   가운데 제목은 좌우 폭이 달라 가운데가 아니게 된다(Buzz 도 왼쪽이다).
// * 오른쪽은 아이콘 원. 옛 머리의 빨간 글자 링크 「고정한 메시지」는 ⋮ 메뉴 안으로
//   갔다 — 그 문은 매일 쓰는 것이 아니고, 머리 오른쪽을 글자 하나가 차지했다.
// * 허들 헤드폰은 **자리만** 있다(`huddle` prop). 폰에는 허들이 없고
//   (`realtime/channelRail.ts` 가 허들 레일을 받지 않는다), 없는 기능의 아이콘은
//   누르면 아무 일도 안 하는 버튼이 된다. 생기는 날 호출자가 prop 을 준다.
// * 머리 띠는 유리다(`GlassSurface`, 투명도 줄이기에서는 불투명). 안전 영역까지
//   덮는다 — 상태 막대 밑만 다른 색이면 띠가 떠 보이지 않는다.
// * 연결 상태는 부제가 아니라 머리 **밑의 가벼운 띠**다(owner 표). 부제는 방이
//   무엇인지를 말하는 자리이고, 연결은 방의 정체가 아니다.
// =============================================================================

export interface ConversationHeaderMenuItem {
  label: string;
  run: () => void;
}

/** 머리 오른쪽 허들 자리. 기능이 생기면 호출자가 준다. */
export interface HuddleSlot {
  label: string;
  onPress: () => void;
  /** 허들 아이콘 래스터. 굽는 날 `CONV_ICONS` 에 이름이 는다. */
  icon: ConvIconName;
}

/**
 * 연결 띠의 문장. 연결됐으면 아무 말도 하지 않는다 — 정상은 문장을 쓰지 않는다.
 * 옛 `railSubtitle` 이 하던 판정 그대로다(2R M3: 한 번 연결된 뒤의 connecting 은
 * `RealtimeProvider` 가 이미 disconnected 로 내려보낸다).
 */
export function connectionBannerText(status: RealtimeStatus): string | null {
  if (status === 'connected') return null;
  return status === 'connecting' ? '연결 중…' : '연결이 끊겼습니다';
}

export function ConversationHeader({
  title,
  subtitle,
  kind,
  peerId,
  directory,
  onBack,
  menu,
  huddle,
  railStatus,
  titleTestID = 'conversation-title',
}: {
  title: string;
  subtitle?: string;
  kind: 'public' | 'private' | 'dm' | undefined;
  /** DM 상대. 있으면 제목 앞에 그 얼굴(28)이 선다. */
  peerId?: string | null;
  directory: Directory;
  onBack: () => void;
  /** ⋮ 메뉴 항목. 비면 ⋮ 원을 세우지 않는다. */
  menu: readonly ConversationHeaderMenuItem[];
  huddle?: HuddleSlot;
  railStatus: RealtimeStatus;
  titleTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const banner = connectionBannerText(railStatus);

  const openMenu = useCallback(() => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title,
        options: [...menu.map(item => item.label), '취소'],
        cancelButtonIndex: menu.length,
      },
      index => menu[index]?.run(),
    );
  }, [menu, title]);

  return (
    <View testID="conversation-header">
      <GlassSurface radius={0} style={[styles.band, {paddingTop: insets.top}]}>
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="뒤로"
            onPress={onBack}
            hitSlop={CIRCLE_SLOP}
            style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
            testID="header-back">
            <Image
              source={CONV_ICONS.left}
              style={[styles.icon22, {tintColor: palette.text}]}
            />
          </Pressable>
          <View style={styles.titleBlock}>
            <View style={styles.titleLine}>
              {kind === 'dm' && peerId ? (
                <Avatar directory={directory} memberId={peerId} size={CONV.titleFace} ground="muted" />
              ) : kind === 'public' || kind === 'private' ? (
                <Image
                  accessibilityElementsHidden
                  source={kind === 'private' ? HOME_ICONS.lock : HOME_ICONS.hash}
                  style={[styles.titleGlyph, {tintColor: palette.text}]}
                  testID={`conversation-title-glyph-${kind}`}
                />
              ) : null}
              <Text
                accessibilityRole="header"
                style={styles.title}
                numberOfLines={1}
                ellipsizeMode="tail"
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                testID={titleTestID}>
                {title}
              </Text>
            </View>
            {subtitle ? (
              <Text
                style={styles.subtitle}
                numberOfLines={1}
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                testID="conversation-subtitle">
                {subtitle}
              </Text>
            ) : null}
          </View>
          {huddle ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={huddle.label}
              onPress={huddle.onPress}
              hitSlop={CIRCLE_SLOP}
              style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
              testID="conversation-huddle">
              <Image
                source={CONV_ICONS[huddle.icon]}
                style={[styles.icon20, {tintColor: palette.text}]}
              />
            </Pressable>
          ) : null}
          {menu.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="대화 메뉴"
              accessibilityHint={menu.map(item => item.label).join(', ')}
              onPress={openMenu}
              hitSlop={CIRCLE_SLOP}
              style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
              testID="conversation-menu">
              <Image
                source={CONV_ICONS.kebab}
                style={[styles.icon20, {tintColor: palette.text}]}
              />
            </Pressable>
          ) : null}
        </View>
      </GlassSurface>
      {banner ? (
        <View
          accessibilityRole="text"
          accessibilityLiveRegion="polite"
          style={styles.banner}
          testID="connection-banner">
          <View
            style={[
              styles.bannerDot,
              railStatus === 'connecting' ? styles.bannerDotWait : styles.bannerDotLost,
            ]}
          />
          <Text style={styles.bannerText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
            {banner}
          </Text>
        </View>
      ) : null}
    </View>
  );
}

/** 42 원을 44 로 만드는 여유 — 한 변에 1. */
const CIRCLE_SLOP = (TOUCH_TARGET - CONV.circle) / 2;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    band: {
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.glassLine,
    },
    row: {
      minHeight: CONV.headHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.headGap,
      paddingHorizontal: CONV.headPadX,
    },
    circle: {
      width: CONV.circle,
      height: CONV.circle,
      borderRadius: CONV.circle / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surface,
      // 다크에서 surface 원이 유리 띠에 녹아 「원형 버튼」이라는 모양이 약했다(검수 L-7).
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      boxShadow: color.elevationRest,
    },
    circlePressed: {backgroundColor: color.surfacePressed},
    icon22: {width: CONV_ICON_SIZE.left, height: CONV_ICON_SIZE.left},
    icon20: {width: CONV_ICON_SIZE.kebab, height: CONV_ICON_SIZE.kebab},
    titleBlock: {flex: 1, minWidth: 0},
    titleLine: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    titleGlyph: {width: CONV.titleGlyph, height: CONV.titleGlyph},
    title: {
      flexShrink: 1,
      fontSize: CONV.titleSize,
      fontWeight: '700',
      letterSpacing: CONV.titleTracking,
      color: color.text,
    },
    subtitle: {fontSize: CONV.subtitleSize, color: color.textMuted},
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'center',
      gap: space.sm,
      marginTop: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
    },
    bannerDot: {width: space.sm, height: space.sm, borderRadius: space.xs},
    bannerDotWait: {backgroundColor: color.textMuted},
    bannerDotLost: {backgroundColor: color.warn},
    bannerText: {fontSize: CONV.subtitleSize, color: color.text, fontWeight: '600'},
  });
