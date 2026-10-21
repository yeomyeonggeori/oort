import React, {memo, useCallback} from 'react';
import {
  ActivityIndicator,
  FlatList,
  Image,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';

import {BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {usePalette, useStyles} from '../../design/theme';
import {ds2Radius, font, line, space, type Palette} from '../../design/tokens';
import {PHOTO_COPY} from './photoCardCopy';
import {PHOTO_CARD, photoCellSize, type PhotoCardSize} from './photoCardDesign';
import {
  photoDateLabel,
  selectionOrder,
  type PhotoAsset,
  type PhotoLibraryPorts,
} from './photoLibrary';
import type {PickedAttachmentFile} from './picker';
import {noticeText, usePhotoLibrary} from './usePhotoLibrary';

// =============================================================================
// 사진 카드 — 첨부 메뉴가 변신해 도착하는 최근 사진 그리드 (#4181, Buzz IMG_4321).
//
// 카드는 **내용만** 안다. 크기·위치·모서리는 호스트(변신 틀 `PhotoMorphFrame`)가 정하고,
// 이 컴포넌트는 받은 크기를 채운다. `active` 가 거짓이면 포트를 한 번도 부르지 않는다
// (`usePhotoLibrary`) — 첨부 메뉴를 여는 것만으로는 사진 권한 API 가 불리지 않는다.
//
// 권한 4상태가 카드 안에서 사람 말로 갈린다 (이슈 Goal 7):
//   미결정  설명 + 「허용」(시스템 프롬프트가 뜬다) + 「전체 사진에서 고르기」
//   거부    설명 + 「설정 열기」 + 「전체 사진에서 고르기」   ← iOS 는 다시 묻지 않는다
//   일부    허용된 사진 그리드 + 「사진 더 고르기」(시스템 창)  ← 정상 경로
//   전체    그리드
// =============================================================================

export interface PhotoGridCardProps {
  ports: PhotoLibraryPorts;
  /** 카드가 열려 있는가. 거짓이면 포트를 부르지 않는다. */
  active: boolean;
  size: PhotoCardSize;
  /** 더 붙일 수 있는 수(`photoRoom(트레이 개수)`). */
  room: number;
  onBack: () => void;
  /** 고른 사진을 파일로 바꿨다 — 한 번의 호출로 넘긴다. */
  onAttach: (files: PickedAttachmentFile[]) => void;
  /** 고른 것을 전부 넘겼다. 호스트가 카드를 닫는다. */
  onDone: () => void;
  /** 「전체 사진」 — 기존 시스템 picker(`pickPhoto`). 호스트가 메뉴를 닫은 뒤 부른다. */
  onOpenSystemPicker: () => void;
  /** 처음 선택된 사진 id(캡처 하네스용). */
  initialSelected?: readonly string[];
  testID?: string;
}

export function PhotoGridCard({
  ports,
  active,
  size,
  room,
  onBack,
  onAttach,
  onDone,
  onOpenSystemPicker,
  initialSelected,
  testID = 'photo-card',
}: PhotoGridCardProps): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const library = usePhotoLibrary({
    ports,
    active,
    room,
    onAttach,
    onDone,
    initialSelected,
  });
  const {permission} = library;
  const reading = permission === 'granted' || permission === 'limited';
  const cell = photoCellSize(size.width);
  const bottomClear = PHOTO_CARD.control + 2 * PHOTO_CARD.controlInset;

  const renderItem = useCallback(
    ({item}: ListRenderItemInfo<PhotoAsset>) => (
      <PhotoCell
        asset={item}
        size={cell}
        order={selectionOrder(library.selected, item.id)}
        onPress={library.toggle}
      />
    ),
    [cell, library.selected, library.toggle],
  );

  const attachingNow = library.attaching !== null;
  const count = library.selected.length;
  const statusText =
    library.attaching?.downloading === true
      ? PHOTO_COPY.downloading
      : library.attaching !== null
        ? PHOTO_COPY.preparing(library.attaching.done, library.attaching.total)
        : library.notice !== null
          ? noticeText(library.notice)
          : null;

  return (
    <View
      accessibilityLabel={PHOTO_COPY.card}
      style={[styles.card, {width: size.width, height: size.height}]}
      testID={testID}>
      {permission === 'checking' ? (
        <CenterNote text={PHOTO_COPY.checking} busy testID="photo-checking" />
      ) : null}

      {permission === 'undetermined' ? (
        <PermissionPane
          title={PHOTO_COPY.askTitle}
          detail={PHOTO_COPY.askDetail}
          primaryLabel={PHOTO_COPY.allow}
          primaryHint={PHOTO_COPY.allowHint}
          primaryBusy={library.requesting}
          onPrimary={library.request}
          secondaryLabel={PHOTO_COPY.pickFromAll}
          onSecondary={onOpenSystemPicker}
          bottomClear={bottomClear}
          testID="photo-pane-undetermined"
          primaryTestID="photo-allow"
        />
      ) : null}

      {permission === 'denied' ? (
        <PermissionPane
          title={PHOTO_COPY.deniedTitle}
          detail={PHOTO_COPY.deniedDetail}
          primaryLabel={PHOTO_COPY.openSettings}
          onPrimary={library.openSettings}
          secondaryLabel={PHOTO_COPY.pickFromAll}
          onSecondary={onOpenSystemPicker}
          bottomClear={bottomClear}
          testID="photo-pane-denied"
          primaryTestID="photo-open-settings"
        />
      ) : null}

      {reading ? (
        <View style={styles.gridArea}>
          {permission === 'limited' ? (
            <View style={styles.limited} testID="photo-limited">
              <Sentence style={styles.limitedNote}>{PHOTO_COPY.limitedNote}</Sentence>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={PHOTO_COPY.limitedMore}
                accessibilityHint={PHOTO_COPY.limitedMoreHint}
                onPress={library.presentLimited}
                style={({pressed}) => [styles.limitedMore, pressed && styles.pressed]}
                testID="photo-limited-more">
                <Text style={styles.limitedMoreLabel}>{PHOTO_COPY.limitedMore}</Text>
              </Pressable>
            </View>
          ) : null}

          {library.loadFailed ? (
            <CenterNote
              text={PHOTO_COPY.loadFailed}
              actionLabel={PHOTO_COPY.retry}
              onAction={library.retry}
              testID="photo-load-failed"
            />
          ) : library.loading && library.assets.length === 0 ? (
            <CenterNote text={PHOTO_COPY.loading} busy testID="photo-loading" />
          ) : library.assets.length === 0 ? (
            <CenterNote
              text={PHOTO_COPY.emptyTitle}
              detail={
                permission === 'limited'
                  ? PHOTO_COPY.emptyLimitedDetail
                  : PHOTO_COPY.emptyDetail
              }
              testID="photo-empty"
            />
          ) : (
            <FlatList
              data={library.assets}
              extraData={library.selected}
              renderItem={renderItem}
              keyExtractor={keyOf}
              numColumns={PHOTO_CARD.columns}
              columnWrapperStyle={styles.row}
              ItemSeparatorComponent={RowGap}
              onEndReached={library.hasMore ? library.loadMore : undefined}
              onEndReachedThreshold={1.5}
              initialNumToRender={PHOTO_CARD.columns * 4}
              maxToRenderPerBatch={PHOTO_CARD.columns * 3}
              windowSize={7}
              removeClippedSubviews
              contentContainerStyle={{paddingBottom: bottomClear}}
              ListFooterComponent={
                library.loadingMore ? (
                  <ActivityIndicator color={palette.textMuted} style={styles.footer} />
                ) : null
              }
              showsVerticalScrollIndicator={false}
              testID="photo-grid"
            />
          )}
        </View>
      ) : null}

      {statusText !== null ? (
        <View
          accessibilityLiveRegion="polite"
          pointerEvents="none"
          style={[styles.status, {bottom: bottomClear}]}
          testID="photo-notice">
          <Sentence style={styles.statusText}>{statusText}</Sentence>
        </View>
      ) : null}

      <View pointerEvents="box-none" style={styles.controls}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={PHOTO_COPY.back}
          accessibilityHint={PHOTO_COPY.backHint}
          onPress={onBack}
          style={({pressed}) => [styles.back, pressed && styles.pillPressed]}
          testID="photo-back">
          <Image
            source={CONV_ICONS.left}
            style={[styles.backGlyph, {tintColor: palette.text}]}
          />
        </Pressable>

        {reading ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={
              count > 0 ? PHOTO_COPY.attach(count) : PHOTO_COPY.allPhotos
            }
            accessibilityHint={count > 0 ? undefined : PHOTO_COPY.allPhotosHint}
            accessibilityState={{busy: attachingNow, disabled: attachingNow}}
            disabled={attachingNow}
            onPress={count > 0 ? library.attach : onOpenSystemPicker}
            style={({pressed}) => [styles.pill, pressed && styles.pillPressed]}
            testID="photo-pill">
            {attachingNow ? (
              <ActivityIndicator color={palette.onPrimary} />
            ) : (
              <Text
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                numberOfLines={1}
                style={styles.pillLabel}>
                {count > 0 ? PHOTO_COPY.attach(count) : PHOTO_COPY.allPhotos}
              </Text>
            )}
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const keyOf = (asset: PhotoAsset): string => asset.id;

function RowGap(): React.JSX.Element {
  return <View style={rowGapStyle} />;
}

const rowGapStyle = {height: PHOTO_CARD.cellGap} as const;

// ---- 사진 한 칸 -----------------------------------------------------------------

const PhotoCell = memo(function PhotoCellView({
  asset,
  size,
  order,
  onPress,
}: {
  asset: PhotoAsset;
  size: number;
  /** 고른 순번(1부터). 고르지 않았으면 0. */
  order: number;
  onPress: (id: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const selected = order > 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={PHOTO_COPY.photo(photoDateLabel(asset.creationTimeMs))}
      accessibilityValue={{
        text: selected ? PHOTO_COPY.selected(order) : PHOTO_COPY.notSelected,
      }}
      accessibilityState={{selected}}
      onPress={() => onPress(asset.id)}
      style={{width: size, height: size}}
      testID={`photo-cell-${asset.id}`}>
      <Image
        source={{uri: asset.uri}}
        resizeMode="cover"
        style={styles.thumb}
        testID={`photo-thumb-${asset.id}`}
      />
      {selected ? (
        <>
          <View pointerEvents="none" style={styles.ring} testID={`photo-ring-${asset.id}`} />
          <View pointerEvents="none" style={styles.badge}>
            <Text style={styles.badgeLabel} testID={`photo-order-${asset.id}`}>
              {order}
            </Text>
          </View>
        </>
      ) : null}
    </Pressable>
  );
});

// ---- 권한 설명과 빈 상태 ----------------------------------------------------------

function PermissionPane({
  title,
  detail,
  primaryLabel,
  primaryHint,
  primaryBusy = false,
  onPrimary,
  secondaryLabel,
  onSecondary,
  bottomClear,
  testID,
  primaryTestID,
}: {
  title: string;
  detail: string;
  primaryLabel: string;
  primaryHint?: string;
  primaryBusy?: boolean;
  onPrimary: () => void;
  secondaryLabel: string;
  onSecondary: () => void;
  bottomClear: number;
  testID: string;
  primaryTestID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 글자를 키우면 설명이 카드(고정 높이)보다 길어질 수 있다 — 잘리지 않고 스크롤된다.
  return (
    <ScrollView
      contentContainerStyle={[styles.pane, {paddingBottom: bottomClear}]}
      showsVerticalScrollIndicator={false}
      testID={testID}>
      <Sentence style={styles.paneTitle}>{title}</Sentence>
      <Sentence style={styles.paneDetail}>{detail}</Sentence>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={primaryLabel}
        accessibilityHint={primaryHint}
        accessibilityState={{busy: primaryBusy, disabled: primaryBusy}}
        disabled={primaryBusy}
        onPress={onPrimary}
        style={({pressed}) => [styles.primary, pressed && styles.pillPressed]}
        testID={primaryTestID}>
        {primaryBusy ? (
          <ActivityIndicator color={palette.onPrimary} />
        ) : (
          <Text style={styles.pillLabel}>{primaryLabel}</Text>
        )}
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={secondaryLabel}
        onPress={onSecondary}
        style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
        testID="photo-pick-from-all">
        <Text style={styles.secondaryLabel}>{secondaryLabel}</Text>
      </Pressable>
    </ScrollView>
  );
}

function CenterNote({
  text,
  detail,
  busy = false,
  actionLabel,
  onAction,
  testID,
}: {
  text: string;
  detail?: string;
  busy?: boolean;
  actionLabel?: string;
  onAction?: () => void;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <View style={styles.center} testID={testID}>
      {busy ? <ActivityIndicator color={palette.textMuted} /> : null}
      <Sentence style={styles.paneTitle}>{text}</Sentence>
      {detail !== undefined ? <Sentence style={styles.paneDetail}>{detail}</Sentence> : null}
      {actionLabel !== undefined && onAction !== undefined ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={actionLabel}
          onPress={onAction}
          style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
          testID="photo-retry">
          <Text style={styles.secondaryLabel}>{actionLabel}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 카드는 떠 있는 **올린 면**이다(`surface`: 바닥보다 한 단 위). `sheet` 는 페이지 시트의 바탕이라
    // 다크에서 대화 바닥과 거의 같은 색이어서 카드의 가장자리가 사라졌다(시뮬레이터 캡처). 그림자는
    // `elevationFloat`(떠 있는 층) — `boxShadow` 는 자기 `overflow: hidden` 에 잘리지 않는다.
    card: {
      backgroundColor: color.surface,
      borderRadius: PHOTO_CARD.radius,
      borderCurve: 'continuous',
      overflow: 'hidden',
      boxShadow: color.elevationFloat,
    },
    gridArea: {flex: 1},
    row: {gap: PHOTO_CARD.cellGap},
    thumb: {width: '100%', height: '100%', backgroundColor: color.surfaceMuted},
    footer: {paddingVertical: space.lg},
    ring: {
      ...StyleSheet.absoluteFill,
      borderWidth: PHOTO_CARD.ringWidth,
      borderColor: color.accent,
    },
    badge: {
      position: 'absolute',
      top: PHOTO_CARD.badgeInset,
      right: PHOTO_CARD.badgeInset,
      width: PHOTO_CARD.badge,
      height: PHOTO_CARD.badge,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.accent,
      alignItems: 'center',
      justifyContent: 'center',
    },
    badgeLabel: {
      fontSize: font.meta,
      lineHeight: line.meta,
      fontWeight: '700',
      color: color.onAccent,
    },
    pane: {
      flexGrow: 1,
      paddingHorizontal: space.xl,
      paddingTop: space.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.md,
    },
    center: {
      flex: 1,
      paddingHorizontal: space.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.sm,
    },
    paneTitle: {
      fontSize: font.heading,
      lineHeight: line.body,
      fontWeight: '700',
      color: color.text,
      textAlign: 'center',
    },
    paneDetail: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
      textAlign: 'center',
    },
    primary: {
      minHeight: PHOTO_CARD.control,
      minWidth: PHOTO_CARD.control * 2,
      paddingHorizontal: PHOTO_CARD.pillPadX,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.primary,
      alignItems: 'center',
      justifyContent: 'center',
      marginTop: space.sm,
    },
    secondary: {
      minHeight: PHOTO_CARD.control,
      paddingHorizontal: space.lg,
      alignItems: 'center',
      justifyContent: 'center',
    },
    secondaryLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.accentText,
    },
    limited: {
      minHeight: PHOTO_CARD.control,
      paddingLeft: space.lg,
      paddingRight: space.xs,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    limitedNote: {
      flexShrink: 1,
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    limitedMore: {
      minHeight: PHOTO_CARD.control,
      paddingHorizontal: space.md,
      alignItems: 'center',
      justifyContent: 'center',
    },
    limitedMoreLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      color: color.accentText,
    },
    status: {
      position: 'absolute',
      left: PHOTO_CARD.controlInset,
      right: PHOTO_CARD.controlInset,
      alignItems: 'center',
    },
    // 안내는 눌리는 것이 아니다 — 잉크 알약이 아니라 조용한 면 위의 글자다(design-review M4).
    statusText: {
      overflow: 'hidden',
      paddingHorizontal: space.md,
      paddingVertical: space.sm,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
      color: color.text,
      fontSize: font.label,
      lineHeight: line.label,
      fontWeight: '600',
      textAlign: 'center',
    },
    controls: {
      position: 'absolute',
      left: PHOTO_CARD.controlInset,
      right: PHOTO_CARD.controlInset,
      bottom: PHOTO_CARD.controlInset,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
    },
    // 뒤로 원은 **보조** 조작이라 주 조작(잉크 알약)과 채움이 달라야 한다(위계 §3.1) — 헤더의 뒤로 원과
    // 같은 불투명 `surface` 채움이다. 유리 + 글리프는 어두운 사진 위에서 사라졌고(캡처 selected-light),
    // 잉크 채움은 보조가 주와 같은 무게가 됐다(design-review M3). 불투명 면은 사진과 상관없이 선다.
    back: {
      width: PHOTO_CARD.control,
      height: PHOTO_CARD.control,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
      alignItems: 'center',
      justifyContent: 'center',
    },
    backGlyph: {
      width: CONV_ICON_SIZE.left,
      height: CONV_ICON_SIZE.left,
    },
    pill: {
      minWidth: PHOTO_CARD.control * 2,
      height: PHOTO_CARD.control,
      paddingHorizontal: PHOTO_CARD.pillPadX,
      borderRadius: ds2Radius.pill,
      backgroundColor: color.primary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    pillPressed: {opacity: 0.85},
    pillLabel: {
      fontSize: font.body,
      lineHeight: line.body,
      fontWeight: '600',
      color: color.onPrimary,
    },
    pressed: {backgroundColor: color.surfacePressed},
  });
