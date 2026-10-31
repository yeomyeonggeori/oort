import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect, useState} from 'react';
import {
  Image,
  type LayoutChangeEvent,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {OortLoader} from '../../design/brand/OortLoader';
import {GlassSurface} from '../../design/glass';
import {
  CONV_ICONS,
  CONV_ICON_SIZE,
  HOME_ICONS,
  type ConvIconName,
} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import type {StatusDotTone} from '@momo/core/features/presence/statusDot';
import {useMobileLocale} from '../../i18n/LocaleProvider';
import {StatusDot} from '../presence/StatusDot';
import {useOnline} from '../inbox/useOnline';
import {Avatar} from './Avatar';
import {CONV} from './convDesign';
import {headerSlotWidth, pillShowsSecondary, pillStatusWord} from './headerPill';

// =============================================================================
// 대화 머리 — 목록 위에 각각 뜨는 유리 원·이름 알약 (#4789).
// 안전 영역과 줄 높이는 목록의 위 여백으로 전달한다. 유리 뒤로 목록이 흐르며,
// 연결 띠만 머리 밑에 매달린다. 전체 폭의 재료·테두리는 두지 않는다.
// =============================================================================

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
 *
 * 받는 값은 소켓 상태가 아니라 **띠가 말해도 되는 상태**(`useRealtime().bandStatus`)다. 끊긴 지 1초가
 * 안 됐으면 `connected`(= 말없음)로 내려와, 1초 안에 이어지는 재연결은 띠를 세우지 않는다(#4949).
 */
export function connectionBannerText(status: RealtimeStatus): string | null {
  if (status === 'connected') return null;
  return status === 'connecting' ? '연결 중…' : '연결이 끊겼습니다';
}

/**
 * 끊김 띠를 눌렀을 때의 이름(#4895). 사전(`mobile.connection.reconnectNow`, ko·en)이 정본이고, 이 낱말은
 * 사전 없이 올라오는 격리 하네스를 위한 폴백이다 — 같은 낱말을 두 곳에 적는 것은 알지만, 머리의 나머지 문장이
 * 아직 리터럴이라 이관(ADR-0213 P1)이 끝나기 전까지는 이 파일이 폴백을 들고 있는다.
 */
export const RECONNECT_NOW_LABEL = '지금 다시 연결';

export function ConversationHeader({
  title,
  memberCount,
  kind,
  peerId,
  peerStatusTone = null,
  peerStatusLabel,
  directory,
  onBack,
  onOpenMenu,
  onOpenInfo,
  huddle,
  railStatus,
  onReconnect,
  onBannerInset,
  children,
  backLabel = '뒤로',
  titleTestID = 'conversation-title',
}: {
  title: string;
  /** 채널 알약의 보조 글 — 짧은 멤버 수(「6명」). 긴 부제(「6명 · 김인턴 참여 중」)는 정보 페이지의 것이다. 모르면 없다. */
  memberCount?: string;
  kind: 'public' | 'private' | 'dm' | undefined;
  /** DM 상대. 있으면 제목 앞에 그 얼굴(28)이 선다. */
  peerId?: string | null;
  /** DM 상대의 상태 점 톤(#4016). 없으면 점이 없다. 판정은 호출자가 core 로 한다. */
  peerStatusTone?: StatusDotTone | null;
  /**
   * 점의 낱말(「꺼짐」 등). 점은 낭독에서 숨으므로 제목 라벨이 이 낱말을 대신 읽는다(홈 DM 줄과 같은 규칙). 눈에는 알약의 보조 글로도 선다
   * (#4319) — 코어의 긴 판정(「조용함 · 마지막 응답 5분 전」)은 ` · ` 앞 낱말만(`pillStatusWord`).
   */
  peerStatusLabel?: string;
  directory: Directory;
  onBack: () => void;
  /**
   * ⋮ 를 누르면 부른다 — 무엇이 열리는가(공용 행동 시트, `ConversationMenuSheet`)는 호출자의 일이다. 없으면 ⋮ 원을 세우지 않는다:
   * 열 것이 없는 원은 누르면 아무 일도 안 하는 버튼이다(허들 자리와 같은 규칙).
   */
  onOpenMenu?: () => void;
  /**
   * 가운데 알약을 누르면 부른다 — 대화·채널 정보 페이지(`ConversationInfoPage`)를 여는 것은 화면의 일이다. 없으면 알약은 **단추가 아니다**:
   * 이름만 선다(누르면 아무 일도 없는 단추는 없다 — ⋮·허들 자리와 같은 규칙).
   */
  onOpenInfo?: () => void;
  huddle?: HuddleSlot;
  railStatus: RealtimeStatus;
  /**
   * 끊김 띠를 누르면 부른다(「지금 다시 연결」, #4895) — 화면은 이것을 전송의 `resume` 과 같은 길(`useRealtime().reconnect`)로
   * 잇는다. **「연결이 끊겼습니다」일 때만** 단추가 선다: 「연결 중…」은 이미 시도하는 중이라 누를 것이 없다. 없으면 띠는
   * 단추가 아니라 문장만 선다(열 것이 없는 단추는 만들지 않는다 — ⋮·허들 자리와 같은 규칙).
   */
  onReconnect?: () => void;
  /**
   * 뜬 띠가 목록 위 가장자리를 가린 높이(pt, 띠 위 여백 포함). 띠가 서면 그 높이, 걷히면 0. 목록의 떠 있는 필이 그
   * 밑에 쌓이도록 화면이 `Timeline.topPillInset` 에 건넨다(#4292).
   */
  onBannerInset?: (inset: number) => void;
  /** 머리 바로 아래의 기존 요약 줄. 연결 띠는 이 줄 아래에 뜬다. */
  children?: React.ReactNode;
  backLabel?: string;
  titleTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const banner = connectionBannerText(railStatus);
  const reconnectable = railStatus === 'disconnected' && onReconnect !== undefined;
  const reconnectLabel =
    useMobileLocale()?.locale.formatMessage('mobile.connection.reconnectNow') ?? RECONNECT_NOW_LABEL;
  // 기기가 오프라인이면(NetInfo) 레일 재시도가 닿을 수 없다. 웹 배너의 browser-offline 과 같은 규칙으로
  // 같은 마크가 멈춘다(#3961 design-review M-2). 문장은 그대로다.
  const online = useOnline();
  // 띠의 안쪽(로더 + 문장)은 문장이든 단추든 같다. 두 문장(「연결 중…」·「연결이 끊겼습니다」) 모두 레일이 다시 연결을
  // 시도하는 동안이라 같은 로더가 돈다(#3961). 문장은 그대로고 로더는 곁들일 뿐이다. 기기가 오프라인이면 멈춘다.
  const bannerBody = banner ? (
    <>
      <OortLoader size={BANNER_LOADER_SIZE} still={!online} testID="connection-loader" />
      <Text style={styles.bannerText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
        {banner}
      </Text>
    </>
  ) : null;
  const {width: windowWidth, fontScale} = useWindowDimensions();
  const [headerHeight, setHeaderHeight] = useState<number | null>(null);
  const onHeaderLayout = useCallback((event: LayoutChangeEvent) => {
    setHeaderHeight(event.nativeEvent.layout.height);
  }, []);

  const onBannerLayout = useCallback(
    (event: LayoutChangeEvent) => onBannerInset?.(event.nativeEvent.layout.height),
    [onBannerInset],
  );
  // 띠가 걷히면 비운다 — 위쪽 필이 사라진 띠 밑 자리에 남지 않게.
  useEffect(() => {
    if (banner === null) onBannerInset?.(0);
  }, [banner, onBannerInset]);

  // ---- 가운데 알약 -----------------------------------------------------------
  const isDm = kind === 'dm' && Boolean(peerId);
  const isChannel = kind === 'public' || kind === 'private';
  const hasStatus = peerStatusTone !== null && Boolean(peerStatusLabel);
  const slotWidth = headerSlotWidth({huddle: huddle !== undefined, menu: onOpenMenu !== undefined});
  // 보조 글: DM 은 상태 낱말, 채널은 멤버 수. 줄이 모자라면 이름이 이기고 보조 글이 통째로 숨는다(`headerPill.ts`).
  const secondaryText = isDm ? (hasStatus ? pillStatusWord(peerStatusLabel) : null) : isChannel ? (memberCount ?? null) : null;
  const showSecondary =
    secondaryText !== null &&
    pillShowsSecondary({
      name: title,
      secondary: secondaryText,
      leading: isDm ? CONV.titleFace : CONV.titleGlyph,
      windowWidth,
      fontScale,
      slotWidth,
    });
  // 알약은 단추 하나라 낭독도 한 문장이다: 이름 · 상태(또는 멤버 수) · 「… 정보 열기」. 점·보조 글은 안쪽에서 숨고 이 이름이 대신 읽는다.
  const infoName = isDm ? '대화 정보 열기' : '채널 정보 열기';
  const pillLabel = [title, isDm ? (hasStatus ? peerStatusLabel : undefined) : memberCount, infoName]
    .filter(Boolean)
    .join(', ');
  const body = (
    <>
      {isDm ? (
        <View style={styles.face} testID="conversation-title-face">
          <Avatar directory={directory} memberId={peerId as string} size={CONV.titleFace} ground="muted" />
          {peerStatusTone !== null ? (
            <View style={styles.statusAnchor}>
              <StatusDot tone={peerStatusTone} testID="conversation-title-status-dot" />
            </View>
          ) : null}
        </View>
      ) : isChannel ? (
        <Image
          accessibilityElementsHidden
          source={kind === 'private' ? HOME_ICONS.lock : HOME_ICONS.hash}
          style={[styles.titleGlyph, {tintColor: palette.text}]}
          testID={`conversation-title-glyph-${kind}`}
        />
      ) : null}
      <Text
        accessibilityRole="header"
        accessibilityLabel={
          peerStatusTone !== null && peerStatusLabel ? `${title}, ${peerStatusLabel}` : undefined
        }
        style={styles.title}
        numberOfLines={1}
        ellipsizeMode="tail"
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
        testID={titleTestID}>
        {title}
      </Text>
      {showSecondary ? (
        <Text
          style={styles.secondary}
          numberOfLines={1}
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          testID={isDm ? 'conversation-title-status' : 'conversation-member-count'}>
          {secondaryText}
        </Text>
      ) : null}
    </>
  );

  return (
    <View testID="conversation-header" pointerEvents="box-none" onLayout={onHeaderLayout} style={[styles.root, {paddingTop: insets.top}]}>
      {/* 정적인 공간 페이드다. 불투명도 애니메이션은 유리 조상에 걸지 않는다. */}
      <View pointerEvents="none" style={[styles.statusFade, {height: insets.top + CONV.headHeight}]} testID="conversation-status-fade" />
      <View pointerEvents="box-none" style={styles.row} testID="conversation-header-row">
        <View pointerEvents="box-none" style={[styles.slot, {width: slotWidth}]} testID="conversation-header-start">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={backLabel}
            onPress={onBack}
            hitSlop={CIRCLE_SLOP}
            style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
            testID="header-back">
            <GlassSurface radius={CONV.circle / 2} style={StyleSheet.absoluteFill} testID="header-back-glass" />
            <Image
              source={CONV_ICONS.left}
              style={[styles.icon22, {tintColor: palette.text}]}
            />
          </Pressable>
        </View>
        <View pointerEvents="box-none" style={styles.center} testID="conversation-header-center">
          {onOpenInfo ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={pillLabel}
              onPress={onOpenInfo}
              hitSlop={PILL_SLOP}
              style={({pressed}) => [styles.pill, pressed && styles.pillPressed]}
              testID="conversation-info-button">
              <GlassSurface radius={ds2Radius.pill} style={StyleSheet.absoluteFill} testID="conversation-info-glass" />
              {body}
            </Pressable>
          ) : (
            <GlassSurface radius={ds2Radius.pill} style={[styles.pill, styles.titleLine]} testID="conversation-title-line">
              {body}
            </GlassSurface>
          )}
        </View>
        <View pointerEvents="box-none" style={[styles.slot, styles.slotEnd, {width: slotWidth}]} testID="conversation-header-end">
          {huddle ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={huddle.label}
              onPress={huddle.onPress}
              hitSlop={CIRCLE_SLOP}
              style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
              testID="conversation-huddle">
              <GlassSurface radius={CONV.circle / 2} style={StyleSheet.absoluteFill} testID="conversation-huddle-glass" />
              <Image
                source={CONV_ICONS[huddle.icon]}
                style={[styles.icon20, {tintColor: palette.text}]}
              />
            </Pressable>
          ) : null}
          {onOpenMenu ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="대화 메뉴"
              onPress={onOpenMenu}
              hitSlop={CIRCLE_SLOP}
              style={({pressed}) => [styles.circle, pressed && styles.circlePressed]}
              testID="conversation-menu">
              <GlassSurface radius={CONV.circle / 2} style={StyleSheet.absoluteFill} testID="conversation-menu-glass" />
              <Image
                source={CONV_ICONS.kebab}
                style={[styles.icon20, {tintColor: palette.text}]}
              />
            </Pressable>
          ) : null}
        </View>
      </View>
      {children}
      {banner ? (
        // 머리 밑 가장자리에 매달려 목록 위에 뜬다. 문장이 아닌 띠 바깥은 손을 받지 않는다 — 알약 밑의 메시지가
        // 눌려야 한다. 끊김일 때만 알약 **자신**이 단추다(#4895): 층은 `box-none` 이라 손을 받는 것은 알약뿐이다.
        <View
          pointerEvents={reconnectable ? 'box-none' : 'none'}
          onLayout={onBannerLayout}
          style={[styles.bannerLayer, {top: headerHeight ?? insets.top + CONV.headHeight}, headerHeight === null && styles.bannerUnmeasured]}
          testID="connection-banner-layer">
          {reconnectable ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={reconnectLabel}
              // 이름은 행동(「지금 다시 연결」)이고, 지금 상태(「연결이 끊겼습니다」)는 값으로 따라 읽힌다.
              accessibilityValue={{text: banner}}
              accessibilityLiveRegion="polite"
              onPress={onReconnect}
              hitSlop={BANNER_SLOP}
              style={({pressed}) => [
                styles.banner,
                styles.bannerActionable,
                pressed && styles.bannerPressed,
              ]}
              testID="connection-banner">
              {bannerBody}
              {/* 행동의 이름이 눈에도 보인다(#4982). 예전에는 이름이 낭독 라벨에만 있어서 띠가 단추인 줄 알 수 없었다. 이 캡슐은 그림일 뿐
                  누르는 것은 띠 전체다(눌림 높이도 띠가 진다). */}
              <View style={styles.bannerAction} testID="connection-banner-action">
                <Sentence style={styles.bannerActionText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
                  {reconnectLabel}
                </Sentence>
              </View>
            </Pressable>
          ) : (
            <View
              accessibilityRole="text"
              accessibilityLiveRegion="polite"
              style={styles.banner}
              testID="connection-banner">
              {bannerBody}
            </View>
          )}
        </View>
      ) : null}
    </View>
  );
}

/** 42 원을 44 로 만드는 여유 — 한 변에 1. */
const CIRCLE_SLOP = (TOUCH_TARGET - CONV.circle) / 2;
/** 알약(최소 높이 42)을 엄지에 44 로 만드는 여유 — 위아래 한 변에 1. 가로는 이미 넉넉하다. */
const PILL_SLOP = {top: CIRCLE_SLOP, bottom: CIRCLE_SLOP} as const;

/**
 * 끊김 띠(눌리는 알약)의 가로 여유. RN 의 `hitSlop` 은 **부모 경계를 넘지 못해서**(RN 문서) 아래로는 벌 수 없다 — 층이 알약에서 끝난다.
 * 그래서 예전의 눌림 높이는 약 36(알약 29 + 위 여유 7)에서 멈췄고, 44 에 못 미쳤다(#4982). 이제 세로는 슬롭이 아니라 알약의 상자가 지는
 * `minHeight: TOUCH_TARGET`(`bannerActionable`)이다: 층의 높이가 늘면 `onBannerInset`(`onLayout` 이 잰 값)이 그대로 따라간다.
 * 여기 남은 것은 옆 여유뿐이다(층이 화면 폭이라 넉넉하다).
 */
const BANNER_SLOP = {left: space.md, right: space.md} as const;

/**
 * 연결 띠의 로더 한 변(pt). 12pt 문장 한 줄 옆에 서는 자리라 small 마크가 읽히는 20: 글자 대비 1.67배로
 * 웹 배너의 24px 대 15px(1.6배)와 같은 크기감이다(웹에는 같은 숫자의 짝이 없다).
 */
const BANNER_LOADER_SIZE = 20;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    statusFade: {
      ...StyleSheet.absoluteFill,
      experimental_backgroundImage: `linear-gradient(180deg, ${color.canvasTop}, transparent)`,
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
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      boxShadow: color.elevationRest,
    },
    circlePressed: {borderColor: color.textFaint},
    icon22: {width: CONV_ICON_SIZE.left, height: CONV_ICON_SIZE.left},
    icon20: {width: CONV_ICON_SIZE.kebab, height: CONV_ICON_SIZE.kebab},
    // 양쪽 칸은 폭이 같다(`headerSlotWidth`, 인라인) — 가운데 알약이 정말 가운데에 선다. 뒤로의 칸은 왼쪽 정렬, 오른쪽 칸은 원들이 오른쪽 끝에 붙는다.
    slot: {flexDirection: 'row', alignItems: 'center', gap: CONV.headGap},
    slotEnd: {justifyContent: 'flex-end'},
    center: {flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center'},
    // 동작이 없는 이름은 같은 유리 재료지만 단추 역할·누름을 갖지 않는다.
    titleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.headPillGap,
      maxWidth: '100%',
      minHeight: CONV.circle,
    },
    // 가운데 알약 — 원(뒤로·⋮)과 같은 유리 재료다. 최소 높이가 원과 같아 머리 줄(62)이 움직이지 않는다.
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.headPillGap,
      maxWidth: '100%',
      minHeight: CONV.circle,
      paddingHorizontal: CONV.headPillPadX,
      borderRadius: ds2Radius.pill,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      boxShadow: color.elevationRest,
    },
    pillPressed: {borderColor: color.textFaint},
    face: {width: CONV.titleFace, height: CONV.titleFace},
    statusAnchor: {position: 'absolute', right: -2, bottom: -2},
    titleGlyph: {width: CONV.titleGlyph, height: CONV.titleGlyph},
    title: {
      flexShrink: 1,
      fontSize: font.heading,
      fontWeight: '700',
      letterSpacing: CONV.titleTracking,
      color: color.text,
    },
    // 보조 글은 줄어들지 않는다(`flexShrink: 0`) — 줄어드는 것은 이름이다. 모자라면 규칙(`pillShowsSecondary`)이 통째로 숨긴다.
    secondary: {flexShrink: 0, fontSize: font.meta, color: color.textMuted},
    // 머리 뿌리: 뒤 형제(목록)보다 위에 그려져야 매달린 띠가 목록 밑으로 숨지 않는다. 뿌리의 크기는 띠가
    // 서든 말든 같다(띠는 아래 `bannerLayer` 가 흐름 밖에서 진다).
    // **이 `zIndex` 는 호출자가 틀로 봉인해야 한다**: RN 새 아키텍처에서 `zIndex` 는 형제의 그리기·누르기 순서를 트리 순서보다 앞세우므로,
    // 머리가 `Screen` 직속이면 뒤에 서는 전면 덮개(스레드 · 고정 목록 · 작업 목록) **위로** 올라온다. `ConversationScreen` 은 머리 · 목록을
    // `collapsable={false}` 틀 하나에 담아 이 `zIndex` 가 틀 안에서만 겨루게 한다(시험이 잠근다).
    root: {zIndex: 1},
    // RN Yoga 호환 모드의 절대 % 위치는 부모의 안쪽 높이를 기준으로 삼아 안전 영역 패딩을 빠뜨린다.
    // onLayout 이 알린 전체 높이(안전 영역·머리·요약 줄)를 pt 로 써서 부모의 아래 끝에 건다.
    bannerLayer: {
      position: 'absolute',
      left: 0,
      right: 0,
      alignItems: 'center',
      // 긴 문장(다른 언어 · 큰 글자)이 화면 가장자리에 닿지 않게 알약의 폭을 한계 안에 둔다.
      paddingHorizontal: space.md,
    },
    // 첫 배치가 알려 오기 전에는 이름 위에 한 프레임도 그리지 않는다. 흐름 밖이라 측정 높이는 같다.
    bannerUnmeasured: {opacity: 0},
    banner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      marginTop: space.sm,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surfaceMuted,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      // 이제 행 위에 뜬다 — 이 알약은 컨트롤이 아니라 상태라 테두리가 아니라 **고도**로 층임을 말한다. 같은 자리의 `FloatingDayPill`·같은
      // 파일의 머리 원형 버튼과 같은 토큰이다: 다크에서도 보이도록 윗면 하이라이트와 짙은 그림자가 이미 따로 정의돼 있다(옛
      // `shadowOpacity` 레시피의 검정 18% 는 어두운 바닥 위에서 3단계밖에 못 누른다).
      boxShadow: color.elevationRest,
    },
    // 눌리는 띠(끊김)의 눌림 — 머리 알약·원과 같은 자리의 같은 토큰이다(`pillPressed`).
    bannerPressed: {borderColor: color.textFaint},
    // 눌리는 띠는 엄지 높이(44)를 상자 자신이 진다. 문장만 서는 띠(연결 중)는 예전 높이 그대로다.
    bannerActionable: {minHeight: TOUCH_TARGET},
    // 행동의 이름 캡슐 — 문장 옆에 서는 은은한 단추 모양(신호색 연한 면 + 신호 글자).
    bannerAction: {
      flexShrink: 1,
      paddingHorizontal: space.md,
      paddingVertical: space.xs,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.accentSurface,
    },
    bannerActionText: {fontSize: font.meta, color: color.accentText, fontWeight: '600'},
    bannerText: {fontSize: font.meta, color: color.text, fontWeight: '600', flexShrink: 1},
  });
