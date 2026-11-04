import {LONG_PRESS_MS} from '@momo/core/features/timeline/longPressModel';
import {
  isUnfurlPending,
  unfurlCardModel,
  visibleUnfurls,
  type MessageUnfurl,
  type UnfurlCardModel,
  type UnfurlCardSource,
  type UnfurlSize,
} from '@momo/core/features/timeline/unfurl';
import React, {useState} from 'react';
import {Image, Pressable, StyleSheet, Text, View, useWindowDimensions} from 'react-native';

import {STACK_PILL_SCALE} from '../../design/atoms';
import {LINK_CARD_ICONS} from '../../design/icons';
import {useStyles} from '../../design/theme';
import {font, line, radius, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {CONV} from './convDesign';
import {LINK_CARD} from './linkCardDesign';
import {useLinkPreviewPreference} from './linkPreviewPreference';
import {openLink} from './MessageBody';
import {useRowSeen} from './rowViewability';
import {hasFailed, readyUri, useUnfurlImage} from './unfurlImage';

// =============================================================================
// 링크 카드 — 폰 (ADR-0170 D5, #4883, owner 2026-10-31 · 카카오톡 세로 카드).
//
// 무엇을 보여 줄지는 코어 표시 모델이 **한 곳에서** 정한다(`unfurlCardModel`·`visibleUnfurls`, 대체 규칙 표
// 전 행 — 읽을 수 있는 형태는 `docs/design-system/link-cards.md`). 이 파일은 그 결과를 스타일로 그릴 뿐이고
// 규칙을 다시 판단하지 않는다: 그림 크기·문턱·3개 상한을 읽는 코드는 여기 없다(`unfurlCards.test.tsx` 가 소스에서 잰다).
//
//   크게(rich)     그림이 위(가로:세로 1.91:1, 자름), 글이 아래: 제목 두 줄(진하게) · 설명 두 줄(흐리게) · 아이콘 + 도메인.
//   작게(compact)  왼쪽 56pt 그림 칸 + 오른쪽 주소 · 제목 한 줄 · 설명 한 줄. 그림 칸은 셋 중 하나다:
//                  보통 그림(칸에 맞춰 자름) · 작거나 정사각형인 그림(통째로) · 아이콘 타일(사이트 아이콘, 없으면 지구).
//   동영상          그림 위 재생 표시(장식). 눌러도 카드 안에서 재생하지 않고 원래 페이지를 연다.
//   끄기(off)      카드 없음 — 본문의 링크만 남는다.
//
// 카드 전체가 링크 하나다. 누르면 바깥 브라우저(`openLink` — 이 앱에서 밖으로 나가는 문은 그것 하나다). 길게 누르면
// 링크 시트(복사·공유·작성자만 「미리보기 지우기」)를 부른 쪽이 연다. 글은 전부 `Text` 노드다(HTML 해석 없음).
//
// 그림과 사이트 아이콘은 서버 프록시 경로로만 받는다(`unfurlImage.ts`). 그림은 카드가 서면 바로, 아이콘은 줄이
// 화면에 한 번 보인 뒤에(`rowViewability.ts`). 둘 다 실패하면 조용히 타일이다 — 깨진 그림도 오류 문구도 없다.
//
// 큰 글씨(`STACK_PILL_SCALE` 부터)에서는 제목·설명·주소의 줄 수 상한을 걷는다: 글이 잘리지 않고 카드가 자란다.
// 읽는 글자라 `maxFontSizeMultiplier` 상한도 없다(`atoms.tsx` 정책).
// =============================================================================

/** 길게 눌렀을 때 시트가 다룰 링크 하나. 카드의 글에서 온 값이라 화면이 새로 짓는 것이 없다. */
export interface LinkCardTarget {
  id: string;
  url: string;
  title: string;
  domain: string;
}

export function linkCardTarget(model: UnfurlCardModel): LinkCardTarget {
  return {id: model.id, url: model.url, title: model.title, domain: model.domain};
}

/**
 * 한 메시지가 지금 **카드로 그릴** 모델들. 코어가 앞의 서로 다른 링크 3개 중 보여 줄 것이 있는 것만 고르고
 * (`visibleUnfurls`), 각 카드의 글을 정한다(`unfurlCardModel`). 행의 낭독 문장·로터가 같은 글을 쓰도록 이 함수를
 * 카드와 행이 함께 부른다 — 제목·도메인은 그림 실패 여부와 무관하다.
 */
export function cardModelsFor(
  unfurls: readonly MessageUnfurl[],
  size: UnfurlSize,
): UnfurlCardModel[] {
  return visibleUnfurls(unfurls).flatMap(unfurl => {
    const model = unfurlCardModel(unfurl, {size});
    return model === null ? [] : [model];
  });
}

/** 동영상이면 낭독에 「동영상」을 덧붙인다(그림 위 재생 표시가 눈으로만 말하므로). */
export function unfurlSpokenParts(
  model: UnfurlCardModel,
  formatMessage: ReturnType<typeof useFormatMessage>,
): string {
  const label = formatMessage('timeline.unfurl.label', {
    title: model.title,
    domain: model.domain,
  });
  return model.isVideo ? `${label}, ${formatMessage('timeline.unfurl.video')}` : label;
}

function PlayMark({size, glyph, testID}: {size: number; glyph: number; testID: string}) {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={[styles.play, {width: size, height: size, borderRadius: size / 2}]}
      testID={testID}>
      <View
        style={[
          styles.playGlyph,
          {
            borderTopWidth: glyph / 2,
            borderBottomWidth: glyph / 2,
            borderLeftWidth: Math.round(glyph * 0.8),
            marginLeft: Math.round(glyph / 8),
          },
        ]}
      />
    </View>
  );
}

function AddressLine({
  domain,
  iconUri,
  expand,
  onIconBroken,
}: {
  domain: string;
  /** 받아 둔 사이트 아이콘(`data:`), 없으면 지구. */
  iconUri: string | null;
  expand: boolean;
  onIconBroken: () => void;
}) {
  const styles = useStyles(buildStyles);
  const iconTestID = iconUri === null ? 'unfurl-globe' : 'unfurl-icon';
  return (
    <View style={styles.address} testID="unfurl-address">
      <Image
        accessibilityElementsHidden
        importantForAccessibility="no"
        onError={iconUri === null ? undefined : onIconBroken}
        resizeMode="contain"
        source={iconUri === null ? LINK_CARD_ICONS.globe : {uri: iconUri}}
        style={iconUri === null ? styles.addressGlobe : styles.addressIcon}
        testID={iconTestID}
      />
      <Text
        numberOfLines={expand ? undefined : 1}
        style={styles.domain}
        testID="unfurl-domain">
        {domain}
      </Text>
    </View>
  );
}

/**
 * 카드 한 장. 입력칸 위 미리보기(#5016)도 이 컴포넌트를 그대로 쓴다 — 미리보기에는 아직 메시지가 없어 `messageId` 가
 * 없을 뿐이고(`UnfurlCardSource`), 표시 모델은 `messageId` 를 읽지 않으므로 같은 규칙으로 같은 카드가 그려진다.
 */
export function CardView({
  unfurl,
  preference,
  rowKey,
  onLongPress,
  eagerIcon = false,
  endInset = 0,
}: {
  unfurl: UnfurlCardSource;
  preference: Exclude<UnfurlSize, 'off'>;
  rowKey: string;
  onLongPress?: ((target: LinkCardTarget) => void) | undefined;
  /**
   * 목록 줄이 아닌 자리(입력칸 미리보기)의 카드는 「줄이 한 번 보였는가」를 물을 목록이 없다. 켜면 사이트 아이콘을
   * 카드가 서는 때 바로 받는다 — 카드가 이미 화면 위에 있다. 목록이 없을 때 `useRowSeen` 이 `true` 를 주는 것에
   * 기대지 않고 이름으로 적는다(그 위에 목록 제공자가 생기는 날 아이콘이 영영 막히지 않게).
   */
  eagerIcon?: boolean;
  /**
   * 카드 오른쪽 위에 겹쳐 서는 것(입력칸 미리보기의 ✕)이 가리지 않게, 작은 카드의 글이 비워 둘 오른쪽 여백.
   * 큰 카드는 겹치는 자리가 그림 위라 비우지 않는다.
   */
  endInset?: number;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {fontScale} = useWindowDimensions();
  const expand = fontScale >= STACK_PILL_SCALE;
  // 사이트 아이콘은 줄이 한 번 보인 뒤에만 부른다 — 프록시가 그때 사이트로 나간다(ADR-0170 증보 D9).
  // 그림은 카드가 서면 바로 받는다(틀을 미리 잡아 두어 줄이 뛰지 않는다).
  const rowSeen = useRowSeen(rowKey);
  const seen = eagerIcon || rowSeen;
  const image = useUnfurlImage(unfurl.imageUrl);
  const icon = useUnfurlImage(unfurl.iconUrl, {enabled: seen});
  const [brokenSrc, setBrokenSrc] = useState<string | null>(null);
  const [brokenIcon, setBrokenIcon] = useState<string | null>(null);
  const imageUri = readyUri(image);
  // 받기 실패와 그리기 실패는 같은 길로 타일이 된다 — 모양을 정하는 것은 코어 모델이다.
  const imageFailed = hasFailed(image) || (imageUri !== null && imageUri === brokenSrc);
  const model = unfurlCardModel(unfurl, {size: preference, imageFailed});
  if (model === null) return null;

  const iconDataUrl = readyUri(icon);
  const iconUri = iconDataUrl !== null && iconDataUrl !== brokenIcon ? iconDataUrl : null;
  const onIconBroken = () => setBrokenIcon(iconDataUrl);
  const picture = model.picture;
  const rich = model.layout === 'rich';
  const label = unfurlSpokenParts(model, formatMessage);
  const lines = expand ? undefined : rich ? 2 : 1;
  const tileTestID = iconUri === null ? 'unfurl-tile-globe' : 'unfurl-tile-icon';

  const address = (
    <AddressLine
      domain={model.domain}
      expand={expand}
      iconUri={iconUri}
      onIconBroken={onIconBroken}
    />
  );
  const text = (
    <View style={rich ? styles.richText : styles.compactText}>
      {rich ? address : null}
      <Text
        numberOfLines={lines}
        lineBreakStrategyIOS="hangul-word"
        style={rich ? styles.richTitle : styles.compactTitle}
        testID="unfurl-title">
        {model.title}
      </Text>
      {model.description ? (
        <Text
          numberOfLines={lines}
          lineBreakStrategyIOS="hangul-word"
          style={rich ? styles.richDescription : styles.compactDescription}
          testID="unfurl-description">
          {model.description}
        </Text>
      ) : null}
      {rich ? null : address}
    </View>
  );

  return (
    <Pressable
      accessibilityLabel={label}
      accessibilityRole="link"
      delayLongPress={LONG_PRESS_MS}
      onLongPress={onLongPress ? () => onLongPress(linkCardTarget(model)) : undefined}
      onPress={() => openLink(model.url)}
      style={({pressed}) => [styles.card, pressed && styles.cardPressed]}
      testID="unfurl-card">
      {rich ? (
        <>
          {/* 그림 틀은 받는 중에도 같은 크기라 줄이 뛰지 않는다. 그림이 있어야 크게가 되므로(코어 모델) 틀은 늘 그림용이다. */}
          <View style={styles.hero} testID="unfurl-hero">
            {picture.kind === 'image' && imageUri !== null ? (
              <Image
                accessibilityElementsHidden
                importantForAccessibility="no"
                onError={() => setBrokenSrc(imageUri)}
                resizeMode="cover"
                source={{uri: imageUri}}
                style={styles.heroImage}
                testID="unfurl-image"
              />
            ) : null}
            {model.isVideo ? (
              <PlayMark
                glyph={LINK_CARD.playGlyphHero}
                size={LINK_CARD.playHero}
                testID="unfurl-play"
              />
            ) : null}
          </View>
          {text}
        </>
      ) : (
        <View
          style={[
            styles.compactRow,
            endInset > 0 ? {paddingRight: space.sm + endInset} : null,
          ]}>
          {picture.kind === 'tile' ? (
            <View style={styles.thumb} testID="unfurl-tile">
              {model.isVideo ? (
                <PlayMark
                  glyph={LINK_CARD.playGlyphThumb}
                  size={LINK_CARD.playThumb}
                  testID="unfurl-play"
                />
              ) : (
                <Image
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  onError={iconUri === null ? undefined : onIconBroken}
                  resizeMode="contain"
                  source={iconUri === null ? LINK_CARD_ICONS.globe : {uri: iconUri}}
                  style={iconUri === null ? styles.tileGlobe : styles.tileIcon}
                  testID={tileTestID}
                />
              )}
            </View>
          ) : (
            <View style={styles.thumb} testID="unfurl-thumb">
              {imageUri !== null ? (
                <Image
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                  onError={() => setBrokenSrc(imageUri)}
                  // 작거나 정사각형인 그림은 통째로, 보통 그림은 칸에 맞춰 자른다(코어가 가른 `shape`).
                  resizeMode={picture.shape === 'small' ? 'contain' : 'cover'}
                  source={{uri: imageUri}}
                  style={styles.thumbImage}
                  testID="unfurl-image"
                />
              ) : null}
              {model.isVideo ? (
                <PlayMark
                  glyph={LINK_CARD.playGlyphThumb}
                  size={LINK_CARD.playThumb}
                  testID="unfurl-play"
                />
              ) : null}
            </View>
          )}
          {text}
        </View>
      )}
    </Pressable>
  );
}

/** 카드를 기다리는 자리 — 작은 카드 한 줄만큼이라, 카드가 도착해도 줄이 크게 뛰지 않는다. */
function PendingCard(): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  return (
    <View
      accessibilityLabel={formatMessage('mobile.linkCard.loading')}
      accessibilityRole="progressbar"
      accessibilityState={{busy: true}}
      style={styles.card}
      testID="unfurl-pending">
      <View style={styles.compactRow}>
        <View style={styles.thumb} />
      </View>
    </View>
  );
}

export function UnfurlCards({
  unfurls,
  rowKey,
  preference: preferenceOverride,
  onLongPressCard,
}: {
  unfurls: readonly MessageUnfurl[];
  /** 이 카드들이 선 목록 줄의 키 — 「줄이 한 번 보였는가」(`rowViewability.ts`)를 묻는 열쇠. */
  rowKey: string;
  /** 시험·하네스가 고정하는 값. 실제 화면은 이 기기의 선택(`useLinkPreviewPreference`)을 읽어 바로 따라간다. */
  preference?: UnfurlSize;
  /** 카드를 길게 눌렀다. 링크 시트를 여는 것은 부른 쪽이다. */
  onLongPressCard?: (target: LinkCardTarget) => void;
}): React.JSX.Element | null {
  const styles = useStyles(buildStyles);
  const stored = useLinkPreviewPreference();
  const preference = preferenceOverride ?? stored;
  if (preference === 'off') return null;
  // 앞의 서로 다른 링크 3개까지, 불러오는 중이거나 보여 줄 것이 있는 것만(코어가 정한다).
  const visible = visibleUnfurls(unfurls);
  if (visible.length === 0) return null;
  return (
    <View style={styles.group} testID="unfurl-group">
      {visible.map(unfurl =>
        isUnfurlPending(unfurl) ? (
          <PendingCard key={unfurl.id} />
        ) : (
          <CardView
            key={unfurl.id}
            onLongPress={onLongPressCard}
            preference={preference}
            rowKey={rowKey}
            unfurl={unfurl}
          />
        ),
      )}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    group: {
      marginTop: space.sm,
      gap: space.sm,
      width: '100%',
      maxWidth: LINK_CARD.maxWidth,
    },
    // 면은 `surface` 하나 + 머리카락 테두리 — 첨부 파일 카드(`AttachmentList`)와 같은 줄 안 카드의 문법이다.
    // 라이트 팔레트에서 `surfaceMuted` 는 바닥과 거의 같은 값이라 테두리 없는 카드가 사라진다(캡처로 확인할 것).
    card: {
      borderRadius: CONV.fileRadius,
      borderWidth: 1,
      borderColor: color.border,
      backgroundColor: color.surface,
      overflow: 'hidden',
    },
    cardPressed: {backgroundColor: color.surfacePressed},

    // ---- 크게: 그림 위, 글 아래 ----
    hero: {
      width: '100%',
      aspectRatio: LINK_CARD.heroRatio,
      backgroundColor: color.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    heroImage: {...StyleSheet.absoluteFill},
    richText: {
      paddingHorizontal: space.md,
      paddingVertical: space.md,
      gap: space.xs,
    },
    richTitle: {
      fontSize: font.body,
      lineHeight: line.body,
      fontWeight: '600',
      color: color.text,
    },
    richDescription: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },

    // ---- 작게: 왼쪽 그림 칸, 오른쪽 글 ----
    compactRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: space.md,
      padding: space.sm,
    },
    thumb: {
      width: LINK_CARD.thumb,
      height: LINK_CARD.thumb,
      borderRadius: radius.md,
      overflow: 'hidden',
      backgroundColor: color.surfaceMuted,
      alignItems: 'center',
      justifyContent: 'center',
    },
    thumbImage: {...StyleSheet.absoluteFill},
    tileIcon: {width: LINK_CARD.tileIcon, height: LINK_CARD.tileIcon, borderRadius: radius.sm},
    tileGlobe: {width: LINK_CARD.tileIcon, height: LINK_CARD.tileIcon, tintColor: color.icon},
    compactText: {flex: 1, flexShrink: 1, justifyContent: 'center'},
    compactTitle: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.text,
    },
    compactDescription: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },

    // ---- 주소 줄: 사이트 아이콘(없으면 지구) + 실제 도메인 ----
    address: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    addressIcon: {
      width: LINK_CARD.addressIcon,
      height: LINK_CARD.addressIcon,
      borderRadius: radius.sm,
    },
    addressGlobe: {
      width: LINK_CARD.addressIcon,
      height: LINK_CARD.addressIcon,
      tintColor: color.icon,
    },
    domain: {
      flexShrink: 1,
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
    },

    // ---- 그림 위 재생 표시: 불투명 토큰 면(그림이 어떤 색이어도 읽힌다) ----
    play: {
      position: 'absolute',
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
    },
    playGlyph: {
      width: 0,
      height: 0,
      borderTopColor: 'transparent',
      borderBottomColor: 'transparent',
      borderLeftColor: color.text,
    },
  });
