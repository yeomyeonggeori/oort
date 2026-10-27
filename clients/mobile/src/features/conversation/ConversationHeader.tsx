import type {RealtimeStatus} from '@momo/core/lib/realtimeEvents';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useCallback, useEffect} from 'react';
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
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
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
import {StatusDot} from '../presence/StatusDot';
import {useOnline} from '../inbox/useOnline';
import {Avatar} from './Avatar';
import {CONV} from './convDesign';
import {headerSlotWidth, pillShowsSecondary, pillStatusWord} from './headerPill';

// =============================================================================
// 대화 머리 — 시안 A `.a-hd` + owner 표의 Buzz 대조 (DS2-4 #2716).
//
//   [ ‹ ]      ( # agent-lab · 6명 )      [🎧] [ ⋮ ]
//   [ ‹ ]      ( ◉ 김인턴 · 응답함 )          [ ⋮ ]
//
// 가운데 알약은 **단추 하나**다(#4319, owner 10-27 Buzz 대조): 이름과 상태가 한 덩어리로 눌려 대화·채널 정보 페이지를 연다. 알약은 원(뒤로·⋮)과
// 같은 토큰 가족(`surface` + 가는 테두리 + 고도)이라 유리 띠 위에서 같은 층으로 읽힌다.
//
// * 뒤로는 42 원(`.a-cbtn`, surface + sh1). 옛 머리의 파란 「‹」 글자는 누르는
//   자리가 보이지 않았다.
// * 제목은 **가운데**다(#4319 — 이전 판은 왼쪽 정렬이었다). 오른쪽 아이콘 수가 달라 가운데가 아니게 되던 문제는 **양쪽 칸을 같은 폭**으로
//   두어 푼다(`headerSlotWidth`): 뒤로의 칸이 오른쪽(⋮·허들 자리) 칸과 같은 폭을 비워 두고, 오른쪽이 비어도 원 하나 폭을 지킨다.
// * **머리는 여전히 한 줄이다**(#4016, owner 「두 줄로 표시하니까 좀 구리네」): 이름 옆에 보조 글(DM 의 상태 낱말·채널의 멤버 수)이 나란히 선다.
//   줄이 모자라면 **이름이 이기고 보조 글이 통째로 숨는다**(`headerPill.ts` 의 순수 규칙 — 큰 글씨·이름 바닥 미달). 긴 부제(「6명 · 김인턴 참여 중」)와
//   긴 상태 판정은 정보 페이지가 말한다. 머리 높이(`row.minHeight` 62)는 알약 유무·보조 글 유무와 무관하다(#4292·#4613 의 측정이 이 높이에 기댄다).
// * 오른쪽은 아이콘 원. 옛 머리의 빨간 글자 링크 「고정한 메시지」는 ⋮ 메뉴 안으로
//   갔다 — 그 문은 매일 쓰는 것이 아니고, 머리 오른쪽을 글자 하나가 차지했다.
//   ⋮ 가 여는 것은 시스템 액션 시트(제목 + 「취소」)가 아니라 앱의 **공용 행동 시트**다(#4319,
//   `ConversationMenuSheet`) — 이 머리는 누름을 알릴 뿐이고 무엇이 서는지는 화면이 정한다. 알약이 여는 정보 페이지도 마찬가지다(`onOpenInfo`).
// * 허들 헤드폰은 **자리만** 있다(`huddle` prop). 폰에는 허들이 없고
//   (`realtime/channelRail.ts` 가 허들 레일을 받지 않는다), 없는 기능의 아이콘은
//   누르면 아무 일도 안 하는 버튼이 된다. 생기는 날 호출자가 prop 을 준다.
// * 머리 띠는 유리다(`GlassSurface`, 투명도 줄이기에서는 불투명). 안전 영역까지
//   덮는다 — 상태 막대 밑만 다른 색이면 띠가 떠 보이지 않는다.
// * 연결 상태는 부제가 아니라 머리 **밑의 가벼운 띠**다(owner 표). 부제는 방이
//   무엇인지를 말하는 자리이고, 연결은 방의 정체가 아니다.
// * 띠는 **목록 위에 뜬다 — 흐름에 끼지 않는다**(#4292). 흐름 안에 끼면 4초 넘는 끊김마다 머리가 36.7pt
//   자라 목록의 보이는 높이가 매번 그만큼 줄었다 돌아오고, 목록은 그 변화를 한 프레임 늦게 알아채 끝으로
//   따라가므로 그 한 프레임 동안 맨 아래 줄이 밀렸다 돌아오기도 했다(간헐적 — 시뮬레이터 실측
//   `measure/steady.tsx` 에서 높이 변화는 매번 36.7, 줄의 이동은 한 번 36.7·다른 실행에서는 0). 높이가 안
//   바뀌면 그 전제가 사라진다. 표지(#4016)와 달리 이 줄은 「실제로 바뀐 것이 있을 때만 선다」로 줄일 수
//   없다 — 연결이 정말 끊긴 것이 바뀐 것이다. 줄일 수 없으니 자리를 차지하지 않게 한다. 머리 뿌리에
//   `zIndex` 를 주는 이유도 같다: 뒤 형제인 목록이 위에 그려지면 띠가 목록 밑으로 숨는다.
// * 목록 위 가운데는 목록의 떠 있는 필(날짜 · 「안 읽은 곳으로」, `JumpPillDock`)이 이미 쓰는 자리다. 띠가 뜨면
//   그 필들은 띠 밑에 쌓여야 하므로(안 그러면 필이 띠 뒤에 숨은 채 눌리는 컨트롤이 된다) 띠의 **실제** 높이를
//   `onBannerInset` 으로 알린다 — 글자 크기에 따라 띠 높이가 달라서 상수로 둘 수 없다.
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
 */
export function connectionBannerText(status: RealtimeStatus): string | null {
  if (status === 'connected') return null;
  return status === 'connecting' ? '연결 중…' : '연결이 끊겼습니다';
}

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
  onBannerInset,
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
   * 뜬 띠가 목록 위 가장자리를 가린 높이(pt, 띠 위 여백 포함). 띠가 서면 그 높이, 걷히면 0. 목록의 떠 있는 필이 그
   * 밑에 쌓이도록 화면이 `Timeline.topPillInset` 에 건넨다(#4292).
   */
  onBannerInset?: (inset: number) => void;
  titleTestID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const banner = connectionBannerText(railStatus);
  // 기기가 오프라인이면(NetInfo) 레일 재시도가 닿을 수 없다. 웹 배너의 browser-offline 과 같은 규칙으로
  // 같은 마크가 멈춘다(#3961 design-review M-2). 문장은 그대로다.
  const online = useOnline();
  const {width: windowWidth, fontScale} = useWindowDimensions();

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
    <View testID="conversation-header" style={styles.root}>
      <GlassSurface radius={0} style={[styles.band, {paddingTop: insets.top}]}>
        <View style={styles.row} testID="conversation-header-row">
          <View style={[styles.slot, {width: slotWidth}]} testID="conversation-header-start">
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
          </View>
          <View style={styles.center} testID="conversation-header-center">
            {onOpenInfo ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={pillLabel}
                onPress={onOpenInfo}
                hitSlop={PILL_SLOP}
                style={({pressed}) => [styles.pill, pressed && styles.pillPressed]}
                testID="conversation-info-button">
                {body}
              </Pressable>
            ) : (
              <View style={styles.titleLine} testID="conversation-title-line">
                {body}
              </View>
            )}
          </View>
          <View style={[styles.slot, styles.slotEnd, {width: slotWidth}]} testID="conversation-header-end">
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
            {onOpenMenu ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="대화 메뉴"
                onPress={onOpenMenu}
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
        </View>
      </GlassSurface>
      {banner ? (
        // 머리 밑 가장자리에 매달려 목록 위에 뜬다. 문장이 아닌 띠 바깥은 손을 받지 않는다 — 알약 밑의 메시지가
        // 눌려야 하고, 이 줄은 누르는 것이 아니다.
        <View
          pointerEvents="none"
          onLayout={onBannerLayout}
          style={styles.bannerLayer}
          testID="connection-banner-layer">
          <View
            accessibilityRole="text"
            accessibilityLiveRegion="polite"
            style={styles.banner}
            testID="connection-banner">
            {/* 두 문장(「연결 중…」·「연결이 끊겼습니다」) 모두 레일이 다시 연결을 시도하는 동안이라
                같은 로더가 돈다(#3961). 문장은 그대로고 로더는 곁들일 뿐이다. 기기가 오프라인이면 멈춘다. */}
            <OortLoader size={BANNER_LOADER_SIZE} still={!online} testID="connection-loader" />
            <Text style={styles.bannerText} maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              {banner}
            </Text>
          </View>
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
 * 연결 띠의 로더 한 변(pt). 12pt 문장 한 줄 옆에 서는 자리라 small 마크가 읽히는 20: 글자 대비 1.67배로
 * 웹 배너의 24px 대 15px(1.6배)와 같은 크기감이다(웹에는 같은 숫자의 짝이 없다).
 */
const BANNER_LOADER_SIZE = 20;

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
    // 양쪽 칸은 폭이 같다(`headerSlotWidth`, 인라인) — 가운데 알약이 정말 가운데에 선다. 뒤로의 칸은 왼쪽 정렬, 오른쪽 칸은 원들이 오른쪽 끝에 붙는다.
    slot: {flexDirection: 'row', alignItems: 'center', gap: CONV.headGap},
    slotEnd: {justifyContent: 'flex-end'},
    center: {flex: 1, minWidth: 0, alignItems: 'center', justifyContent: 'center'},
    // 눌리지 않는 이름(`onOpenInfo` 없음): 캡슐 모양 없이 이름만 선다 — 단추처럼 보이는 것이 단추가 아닌 일은 없다.
    titleLine: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.headPillGap,
      maxWidth: '100%',
      minHeight: CONV.circle,
    },
    // 가운데 알약 — 원(뒤로·⋮)과 같은 토큰 가족이라 유리 띠 위에서 같은 층이다. 최소 높이가 원과 같아 머리 줄(62)이 움직이지 않는다.
    pill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: CONV.headPillGap,
      maxWidth: '100%',
      minHeight: CONV.circle,
      paddingHorizontal: CONV.headPillPadX,
      borderRadius: CONV.circle / 2,
      backgroundColor: color.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      boxShadow: color.elevationRest,
    },
    pillPressed: {backgroundColor: color.surfacePressed},
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
    // 흐름 밖. `top: '100%'` 는 머리 뿌리의 높이 — 곧 머리 유리 띠의 밑 가장자리다.
    bannerLayer: {
      position: 'absolute',
      top: '100%',
      left: 0,
      right: 0,
      alignItems: 'center',
      // 긴 문장(다른 언어 · 큰 글자)이 화면 가장자리에 닿지 않게 알약의 폭을 한계 안에 둔다.
      paddingHorizontal: space.md,
    },
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
    bannerText: {fontSize: font.meta, color: color.text, fontWeight: '600', flexShrink: 1},
  });
