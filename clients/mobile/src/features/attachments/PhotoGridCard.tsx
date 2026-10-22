import React, {memo, useCallback, useEffect, useRef} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  FlatList,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from 'react-native';

import {AVATAR_INITIAL_MAX_SCALE, BAR_CONTROL_MAX_SCALE, Sentence} from '../../design/atoms';
import {CONV_ICONS, CONV_ICON_SIZE} from '../../design/icons';
import {usePalette, useStyles, useTheme} from '../../design/theme';
import {ds2Radius, font, line, space, type Palette} from '../../design/tokens';
import {useMorphEdgeShift} from './morphEdge';
import {PHOTO_COPY} from './photoCardCopy';
import {
  PHOTO_CARD,
  photoCellSize,
  scrollNeedsHint,
  type PhotoCardSize,
} from './photoCardDesign';
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
//   일부    허용된 사진 그리드 + 「보여 줄 사진 바꾸기」(시스템 창)  ← 정상 경로
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
  // 변신 중 오른쪽 닻 컨트롤(알약·일부 허용 링크)이 틀의 오른쪽 가장자리를 따라간다(`morphEdge.ts`).
  const edgeShift = useMorphEdgeShift();
  const {permission} = library;
  const reading = permission === 'granted' || permission === 'limited';
  const cell = photoCellSize(size.width);
  const bottomClear = PHOTO_CARD.control + 2 * PHOTO_CARD.controlInset;
  // 자리표시자 줄 수 — 카드 높이를 채울 만큼(높이를 보존하는 스켈레톤, 디자인 시스템 §4 로딩).
  const skeletonRows = Math.ceil(size.height / (cell + PHOTO_CARD.cellGap));

  // 메뉴가 카드로 바뀌면 낭독 초점이 사라진 메뉴 행에서 떨어진다. 새 면의 이름을 한 번 알린다.
  // (카드 루트 View 의 라벨은 `accessible` 이 아니라서 iOS 가 읽지 않는다.)
  useEffect(() => {
    if (active && Platform.OS === 'ios') {
      AccessibilityInfo.announceForAccessibility(PHOTO_COPY.card);
    }
  }, [active]);

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
      onAccessibilityEscape={onBack}
      style={[styles.card, {width: size.width, height: size.height}]}
      testID={testID}>
      {permission === 'checking' ? (
        // 권한을 읽는 동안은 **비어 있다**. 한두 프레임이면 끝나는 일에 문구·스피너를 세우면 변신 도중
        // 번쩍인다(design-review M5). 낭독만 「확인하는 중」을 안다.
        <View
          accessible
          accessibilityLabel={PHOTO_COPY.checking}
          accessibilityState={{busy: true}}
          style={styles.center}
          testID="photo-checking"
        />
      ) : null}

      {permission === 'undetermined' ? (
        <Face
          title={PHOTO_COPY.askTitle}
          detail={PHOTO_COPY.askDetail}
          actions={[
            {
              kind: 'primary',
              label: PHOTO_COPY.allow,
              hint: PHOTO_COPY.allowHint,
              busy: library.requesting,
              onPress: library.request,
              testID: 'photo-allow',
            },
            {
              kind: 'link',
              label: PHOTO_COPY.pickFromAll,
              onPress: onOpenSystemPicker,
              testID: 'photo-pick-from-all',
            },
          ]}
          bottomClear={bottomClear}
          testID="photo-pane-undetermined"
        />
      ) : null}

      {permission === 'denied' ? (
        <Face
          title={PHOTO_COPY.deniedTitle}
          detail={PHOTO_COPY.deniedDetail}
          actions={[
            {
              kind: 'primary',
              label: PHOTO_COPY.openSettings,
              onPress: library.openSettings,
              testID: 'photo-open-settings',
            },
            {
              kind: 'link',
              label: PHOTO_COPY.pickFromAll,
              onPress: onOpenSystemPicker,
              testID: 'photo-pick-from-all',
            },
          ]}
          bottomClear={bottomClear}
          testID="photo-pane-denied"
        />
      ) : null}

      {reading ? (
        <View style={styles.gridArea}>
          {permission === 'limited' ? (
            <View style={styles.limited} testID="photo-limited">
              <Sentence
                maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                style={styles.limitedNote}>
                {PHOTO_COPY.limitedNote}
              </Sentence>
              <Animated.View style={{transform: [{translateX: edgeShift}]}}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={PHOTO_COPY.limitedMore}
                  accessibilityHint={PHOTO_COPY.limitedMoreHint}
                  onPress={library.presentLimited}
                  style={({pressed}) => [styles.limitedMore, pressed && styles.pressed]}
                  testID="photo-limited-more">
                  <Text
                    maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                    style={styles.limitedMoreLabel}>
                    {PHOTO_COPY.limitedMore}
                  </Text>
                </Pressable>
              </Animated.View>
            </View>
          ) : null}

          {library.loadFailed ? (
            <Face
              title={PHOTO_COPY.loadFailed}
              actions={[
                {
                  kind: 'link',
                  label: PHOTO_COPY.retry,
                  onPress: library.retry,
                  testID: 'photo-retry',
                },
              ]}
              bottomClear={bottomClear}
              testID="photo-load-failed"
            />
          ) : library.loading && library.assets.length === 0 ? (
            <PhotoSkeleton
              cell={cell}
              label={PHOTO_COPY.loading}
              rows={skeletonRows}
              testID="photo-loading"
            />
          ) : library.assets.length === 0 ? (
            <Face
              title={PHOTO_COPY.emptyTitle}
              detail={
                permission === 'limited'
                  ? PHOTO_COPY.emptyLimitedDetail
                  : PHOTO_COPY.emptyDetail
              }
              actions={[]}
              bottomClear={bottomClear}
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
                  <View style={styles.footer}>
                    <PhotoSkeleton cell={cell} rows={1} testID="photo-loading-more" />
                  </View>
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
          <Sentence
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            style={styles.statusText}>
            {statusText}
          </Sentence>
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
          // 알약은 오른쪽 가장자리에 닻이 있다 — 변신 중에는 틀의 오른쪽 가장자리를 따라간다(`morphEdge.ts`).
          <Animated.View style={{transform: [{translateX: edgeShift}]}}>
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
          </Animated.View>
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
      accessibilityValue={selected ? {text: PHOTO_COPY.order(order)} : undefined}
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
            {/* 순번 원은 글자와 함께 자라지 않는 고정 지름이다 — 고정 상자 안의 한두 글자 표식이라 아바타
                이니셜과 같은 상한을 쓴다(atoms.tsx 가 `maxFontSizeMultiplier` 의 유일한 출처). */}
            <Text
              maxFontSizeMultiplier={AVATAR_INITIAL_MAX_SCALE}
              style={styles.badgeLabel}
              testID={`photo-order-${asset.id}`}>
              {order}
            </Text>
          </View>
        </>
      ) : null}
    </Pressable>
  );
});

// ---- 불러오는 동안: 높이를 보존하는 중성 스켈레톤 ---------------------------------------

/**
 * 사진 칸과 같은 크기의 중성 면(`surfaceMuted`) — **시머 없음**(디자인 시스템 §4 로딩: 높이를 보존하는
 * 중성 스켈레톤 바, 시머 금지). 실제 칸의 썸네일 바탕과 같은 색이라, 사진이 들어와도 면이 바뀌지 않고
 * 그 위에 사진이 얹힌다. 문구·스피너는 없다 — 열 때마다 번쩍이지 않게(design-review M5).
 * `label` 이 없으면 장식이라 낭독하지 않는다(다음 쪽을 부르는 바닥 줄).
 */
function PhotoSkeleton({
  cell,
  rows,
  label,
  testID,
}: {
  cell: number;
  rows: number;
  label?: string;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const cells = Array.from({length: PHOTO_CARD.columns}, (_, column) => column);
  return (
    <View
      accessibilityElementsHidden={label === undefined}
      accessibilityLabel={label}
      accessibilityState={label === undefined ? undefined : {busy: true}}
      accessible={label !== undefined}
      importantForAccessibility={label === undefined ? 'no-hide-descendants' : 'yes'}
      style={styles.skeleton}
      testID={testID}>
      {Array.from({length: rows}, (_, row) => (
        <View key={row} style={styles.row}>
          {cells.map(column => (
            <View key={column} style={[styles.skeletonCell, {width: cell, height: cell}]} />
          ))}
        </View>
      ))}
    </View>
  );
}

// ---- 권한 설명과 빈 상태 ----------------------------------------------------------

/**
 * 카드가 말하는 면(권한 설명·거부·비어 있음·불러오기 실패)의 한 모양.
 *
 * **글은 스크롤하고 행동은 바닥에 붙는다.** 글자를 키우면(AX5) 제목·설명이 카드(고정 높이)보다 길어진다.
 * 행동(「허용」·「설정 열기」·「다시 불러오기」)까지 같은 스크롤 안에 두면 첫 화면에 행동이 없고(권한 면),
 * 떠 있는 알약 밑에 겹쳤다(오류 면) — design-review. 그래서 글 영역만 스크롤하고 행동은 그 아래 **고정 띠**에
 * 둔다(떠 있는 뒤로 원·알약 줄 `bottomClear` 위). 기본 글꼴에서는 글이 짧아 스크롤이 나타나지 않고, 글은 위
 * 영역의 가운데에 선다. 넘치면 스크롤 표시를 한 번 보인다(`scrollNeedsHint`).
 */
interface FaceAction {
  /** `primary` = 채운 알약(주), `link` = 글자만(보조). */
  kind: 'primary' | 'link';
  label: string;
  hint?: string;
  busy?: boolean;
  onPress: () => void;
  testID: string;
}

function Face({
  title,
  detail,
  actions,
  bottomClear,
  testID,
}: {
  title: string;
  detail?: string;
  actions: FaceAction[];
  bottomClear: number;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const {scheme} = useTheme();
  const scroll = useRef<ScrollView>(null);
  const layoutHeight = useRef(0);
  const contentHeight = useRef(0);
  // 넘치는지는 두 크기를 모두 알아야 답할 수 있고, 두 이벤트가 오는 순서는 약속이 아니다 —
  // 어느 쪽이 나중에 와도 같은 답을 낸다(한 쪽만 믿으면 순서가 바뀐 기기에서 표시가 영영 안 선다).
  const hintIfOverflowing = () => {
    if (scrollNeedsHint(contentHeight.current, layoutHeight.current)) {
      scroll.current?.flashScrollIndicators?.();
    }
  };
  return (
    <View style={styles.face} testID={testID}>
      <ScrollView
        contentContainerStyle={styles.faceText}
        // 스크롤 표시의 색은 UIKit 이 **시스템** 모양으로 정한다. 사람이 앱에서 다크를 고르고 시스템이 라이트면
        // 어두운 카드에 어두운 표시가 서서 「더 있다」 단서가 안 보인다(시뮬레이터 영상으로 확인) — 앱의 모양을 따른다.
        indicatorStyle={scheme === 'light' ? 'black' : 'white'}
        onContentSizeChange={(_width, height) => {
          contentHeight.current = height;
          hintIfOverflowing();
        }}
        onLayout={event => {
          layoutHeight.current = event.nativeEvent.layout.height;
          hintIfOverflowing();
        }}
        ref={scroll}
        style={styles.faceScroll}
        testID={`${testID}-text`}>
        <Sentence accessibilityRole="header" style={styles.paneTitle}>
          {title}
        </Sentence>
        {detail !== undefined ? <Sentence style={styles.paneDetail}>{detail}</Sentence> : null}
      </ScrollView>
      <View style={[styles.faceActions, {paddingBottom: bottomClear}]}>
        {actions.map(action =>
          action.kind === 'primary' ? (
            <Pressable
              accessibilityHint={action.hint}
              accessibilityLabel={action.label}
              accessibilityRole="button"
              accessibilityState={{busy: action.busy === true, disabled: action.busy === true}}
              disabled={action.busy === true}
              key={action.testID}
              onPress={action.onPress}
              style={({pressed}) => [styles.primary, pressed && styles.pillPressed]}
              testID={action.testID}>
              {action.busy === true ? (
                <ActivityIndicator color={palette.onPrimary} />
              ) : (
                <Text
                  maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
                  numberOfLines={1}
                  style={styles.pillLabel}>
                  {action.label}
                </Text>
              )}
            </Pressable>
          ) : (
            <Pressable
              accessibilityLabel={action.label}
              accessibilityRole="button"
              key={action.testID}
              onPress={action.onPress}
              style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
              testID={action.testID}>
              <Text maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE} style={styles.secondaryLabel}>
                {action.label}
              </Text>
            </Pressable>
          ),
        )}
      </View>
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
    row: {flexDirection: 'row', gap: PHOTO_CARD.cellGap},
    skeleton: {gap: PHOTO_CARD.cellGap},
    skeletonCell: {backgroundColor: color.surfaceMuted},
    thumb: {width: '100%', height: '100%', backgroundColor: color.surfaceMuted},
    footer: {paddingTop: PHOTO_CARD.cellGap},
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
    face: {flex: 1},
    faceScroll: {flex: 1},
    faceText: {
      flexGrow: 1,
      paddingHorizontal: space.xl,
      paddingTop: space.xl,
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.md,
    },
    faceActions: {
      paddingHorizontal: space.xl,
      alignItems: 'center',
      gap: space.sm,
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
    // 글자가 크면 링크가 안내 아래 줄로 내려간다(`flexWrap`). 한 줄에 억지로 두면 링크가 폭을 다 먹어 안내가
    // 사라졌고 링크 라벨이 낱말 중간에서 끊겼다(AX5 캡처 ax5-limited).
    limited: {
      minHeight: PHOTO_CARD.control,
      paddingLeft: space.lg,
      paddingRight: space.xs,
      flexDirection: 'row',
      flexWrap: 'wrap',
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
      // 권한·로딩 면처럼 카드 몸통도 `surface` 인 곳에서는 채움만으로는 원이 사라지고 글리프만 남는다 —
      // 헤더의 뒤로 원과 같은 가는 테두리로 「눌리는 것」의 경계를 건다(design-review L4).
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
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
