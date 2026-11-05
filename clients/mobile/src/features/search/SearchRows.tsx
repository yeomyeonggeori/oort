import type {MessageSearchHit, RosterMember} from '@momo/core/lib/api';
import {
  leadsWithEllipsis,
  snippetSegments,
  trailsWithEllipsis,
} from '@momo/core/features/search/searchModel';
import type {Directory} from '@momo/core/features/workspace/directory';
import React from 'react';
import {Image, Pressable, ScrollView, StyleSheet, Text, View, type ImageSourcePropType} from 'react-native';
import {HOME_ICON_SIZE, HOME_ICONS, CONV_ICONS, CONV_ICON_SIZE, SHEET_ICONS, SHEET_ICON_SIZE} from '../../design/icons';
import {BAR_CONTROL_MAX_SCALE} from '../../design/atoms';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {
  ds2Radius,
  font,
  line,
  radius,
  SAFE_GUTTER,
  SHEET,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import {Avatar} from '../conversation/Avatar';
import {highlightParts, SEARCH_KINDS, type MatchRanges, type SearchKind} from './localSearch';
import {SEARCH_CLOCK_SIZE, SEARCH_ICONS} from './searchIcons';

// =============================================================================
// 검색 탭의 부품 — 칩·묶음 머리·채널/사람/메시지 줄·최근 목록 (#5365).
//
// 값을 읽는 훅은 문구(`useFormatMessage`)와 스타일뿐이다. 데이터(찾은 것·최근 목록)는 모두 props 로 받는다: 화면의 상태 중
// 서버에서는 안 나오는 것(빈 결과·오류·최근 목록이 찬 첫 화면)을 `measure/surfaces.tsx` 가 이 부품 그대로 찍을 수 있게 하려는
// 이유가 하나이고(옛 `SearchBody` 와 같은 이유), 나머지는 규칙이 코어·순수 모듈에 있어 이 파일에 판정이 없다는 것이다.
//
// 색은 팔레트 역할만 쓴다. 칩은 「종류」가 한 단 위(`primary` 채움), 「범위」가 한 단 아래(`accentSurface` 채움)라서 두 줄이 같은
// 무게로 읽히지 않는다 — 어느 줄이 무엇을 좁히는지 색의 순서가 말한다.
// =============================================================================

/** 칩 높이: 눌림 영역은 `slopTo` 가 44 로 채운다(보이는 높이만 얇게 둔다). */
const CHIP_HEIGHT = TOUCH_TARGET - space.xs;
/** 사람 얼굴·최근 대화 얼굴의 크기. */
const PERSON_FACE = TOUCH_TARGET - space.xs;
const RECENT_FACE = TOUCH_TARGET + space.sm;
const RECENT_ITEM_WIDTH = RECENT_FACE + space.lg;

export function KindChips({
  kind,
  onKind,
  labels,
  groupLabel,
}: {
  kind: SearchKind;
  onKind: (next: SearchKind) => void;
  labels: Readonly<Record<SearchKind, string>>;
  groupLabel: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={groupLabel}
      style={styles.chipRow}
      testID="search-kinds">
      {SEARCH_KINDS.map(candidate => {
        const selected = candidate === kind;
        return (
          <Pressable
            key={candidate}
            accessibilityRole="tab"
            accessibilityLabel={labels[candidate]}
            accessibilityState={{selected}}
            hitSlop={slopTo(CHIP_HEIGHT)}
            onPress={() => onKind(candidate)}
            style={({pressed}) => [
              styles.chip,
              selected && styles.chipSelected,
              pressed && !selected && styles.pressed,
            ]}
            testID={`search-kind-${candidate}`}>
            <Text
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
              style={[styles.chipLabel, selected && styles.chipLabelSelected]}
              numberOfLines={1}>
              {labels[candidate]}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 「메시지」 칩에서만 서는 둘째 줄: 어느 대화에서 찾을지. 서버는 대화 **하나**만 받는다. */
export function ScopeChips({
  scope,
  groupLabel,
  allLabel,
  pickLabel,
  pickAccessibilityLabel,
  chosenAccessibilityLabel,
  onClear,
  onPick,
}: {
  scope: {title: string; isPrivate: boolean | null} | null;
  groupLabel: string;
  allLabel: string;
  pickLabel: string;
  pickAccessibilityLabel: string;
  chosenAccessibilityLabel: string;
  onClear: () => void;
  onPick: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View accessibilityLabel={groupLabel} style={styles.scopeRow} testID="search-scope">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={allLabel}
        accessibilityState={{selected: scope === null}}
        hitSlop={slopTo(CHIP_HEIGHT)}
        onPress={onClear}
        style={({pressed}) => [styles.scopeChip, scope === null && styles.scopeChipOn, pressed && styles.pressed]}
        testID="search-scope-all">
        <Text
          maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
          style={[styles.scopeLabel, scope === null && styles.scopeLabelOn]}
          numberOfLines={1}>
          {allLabel}
        </Text>
      </Pressable>
      {scope === null ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={pickAccessibilityLabel}
          hitSlop={slopTo(CHIP_HEIGHT)}
          onPress={onPick}
          style={({pressed}) => [styles.scopeChip, pressed && styles.pressed]}
          testID="search-scope-pick">
          <Text maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE} style={styles.scopeLabel} numberOfLines={1}>
            {pickLabel}
          </Text>
          <Image source={HOME_ICONS.down} style={styles.chipGlyph} accessibilityElementsHidden />
        </Pressable>
      ) : (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={chosenAccessibilityLabel}
          accessibilityState={{selected: true}}
          hitSlop={slopTo(CHIP_HEIGHT)}
          onPress={onClear}
          style={({pressed}) => [styles.scopeChip, styles.scopeChipOn, styles.scopeChipChosen, pressed && styles.pressed]}
          testID="search-scope-chosen">
          {scope.isPrivate === null ? null : (
            <Image
              source={scope.isPrivate ? HOME_ICONS.lock : HOME_ICONS.hash}
              style={styles.chipLeadGlyph}
              accessibilityElementsHidden
            />
          )}
          <Text
            maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}
            style={[styles.scopeLabel, styles.scopeLabelOn, styles.scopeChosenLabel]}
            numberOfLines={1}>
            {scope.title}
          </Text>
          <Image source={CONV_ICONS.cross} style={styles.chipCross} accessibilityElementsHidden />
        </Pressable>
      )}
    </View>
  );
}

export function GroupHeader({
  title,
  moreLabel,
  moreAccessibilityLabel,
  onMore,
  testID,
}: {
  title: string;
  moreLabel: string;
  moreAccessibilityLabel: string;
  /** 없으면 「더 보기」도 없다(묶음이 첫 몇 건에서 끝났다). */
  onMore?: () => void;
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View style={styles.groupHead} testID={testID}>
      <Text accessibilityRole="header" style={styles.groupTitle}>
        {title}
      </Text>
      {onMore ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={moreAccessibilityLabel}
          hitSlop={slopTo(TOUCH_TARGET - space.md)}
          onPress={onMore}
          style={({pressed}) => [styles.more, pressed && styles.pressed]}
          testID={testID ? `${testID}-more` : undefined}>
          <Text style={styles.moreLabel}>{moreLabel}</Text>
          <Image source={SHEET_ICONS.chevron} style={styles.moreGlyph} accessibilityElementsHidden />
        </Pressable>
      ) : null}
    </View>
  );
}

/** 이름 한 줄. 찾은 글자(`ranges`)만 강조한다 — 범위가 비면 이름 그대로다. */
export function Highlighted({
  text,
  ranges,
  style,
}: {
  text: string;
  ranges: MatchRanges;
  style?: React.ComponentProps<typeof Text>['style'];
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const parts = highlightParts(text, ranges);
  return (
    <Text lineBreakStrategyIOS="hangul-word" numberOfLines={1} style={style}>
      {parts.map((part, index) =>
        part.match ? (
          <Text key={index} style={styles.match} testID="search-match">
            {part.text}
          </Text>
        ) : (
          part.text
        ),
      )}
    </Text>
  );
}

export function ChannelRow({
  id,
  name,
  isPrivate,
  ranges,
  onPress,
}: {
  id: string;
  name: string;
  isPrivate: boolean;
  ranges: MatchRanges;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={formatMessage(
        isPrivate ? 'search.row.privateChannelLabel' : 'search.row.channelLabel',
        {name},
      )}
      accessibilityHint={formatMessage('search.row.openChannelHint')}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID={`search-channel-${id}`}>
      <View style={styles.rowLead}>
        <Image
          source={isPrivate ? HOME_ICONS.lock : HOME_ICONS.hash}
          style={styles.rowGlyph}
          accessibilityElementsHidden
        />
      </View>
      <Highlighted text={name} ranges={ranges} style={styles.rowTitle} />
    </Pressable>
  );
}

export function PersonRow({
  member,
  directory,
  nameRanges,
  handleRanges,
  onPress,
}: {
  member: RosterMember;
  directory: Directory;
  nameRanges: MatchRanges;
  handleRanges: MatchRanges;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const isAgent = member.kind === 'agent';
  // 부제는 `@핸들` 이고 에이전트는 앞에 그 말이 붙는다. 찾은 글자는 핸들 안에서만 강조한다(앞의 `@` 한 글자만큼 민다).
  const subtitle = formatMessage(isAgent ? 'search.row.agentSubtitle' : 'search.row.personSubtitle', {
    handle: member.handle,
  });
  const shift = Array.from(subtitle).length - Array.from(member.handle).length;
  const subtitleRanges: MatchRanges = handleRanges.map(([start, end]) => [start + shift, end + shift] as const);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={formatMessage(isAgent ? 'search.row.agentLabel' : 'search.row.personLabel', {
        name: member.displayName,
        handle: member.handle,
      })}
      accessibilityHint={formatMessage('search.row.openDmHint')}
      onPress={onPress}
      style={({pressed}) => [styles.row, pressed && styles.pressed]}
      testID={`search-person-${member.handle}`}>
      <View style={styles.faceLead}>
        <Avatar directory={directory} memberId={member.id} size={PERSON_FACE} ground="muted" />
      </View>
      <View style={styles.rowText}>
        <Highlighted text={member.displayName} ranges={nameRanges} style={styles.rowTitle} />
        <Highlighted text={subtitle} ranges={subtitleRanges} style={styles.rowDetail} />
      </View>
    </Pressable>
  );
}

/**
 * 메시지 한 건. 서버가 일치 위치(`matchOffset`)를 주고, 코어 `snippetSegments` 가 그것으로 조각을 낸다.
 * (`measure/surfaces.tsx` 가 이 줄 그대로 찍는다.)
 */
export function ResultRow({
  hit,
  query,
  channelTitle,
  authorName,
  onPress,
}: {
  hit: MessageSearchHit;
  query: string;
  channelTitle: string;
  authorName: string;
  onPress: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const segments = snippetSegments(hit.snippet, hit.matchOffset, query);
  // 잘린 쪽에만 말줄임을 붙인다. 잘리지 않은 쪽에 붙이면 없는 말이 있다고 하는
  // 것이고, 그것도 이 표면이 없애려는 거짓말과 같은 종류다.
  const lead = leadsWithEllipsis(hit.matchOffset) ? '…' : '';
  const trail = trailsWithEllipsis(hit.snippet, query) ? '…' : '';
  const when = new Date(hit.createdAtMs);
  const stamp = `${when.getFullYear()}. ${when.getMonth() + 1}. ${when.getDate()}.`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={formatMessage('search.row.messageLabel', {
        channel: channelTitle,
        author: authorName,
        snippet: hit.snippet,
      })}
      onPress={onPress}
      style={({pressed}) => [styles.messageRow, pressed && styles.pressed]}
      testID="search-result">
      <View style={styles.rowHead}>
        <Text style={styles.messageChannel} numberOfLines={1}>
          {channelTitle}
        </Text>
        <Text style={styles.messageMeta} numberOfLines={1}>
          {`${authorName} · ${stamp}`}
        </Text>
      </View>
      <Text lineBreakStrategyIOS="hangul-word" style={styles.snippet} numberOfLines={3}>
        {lead}
        {segments.before}
        <Text style={styles.match}>{segments.match}</Text>
        {segments.after}
        {trail}
      </Text>
    </Pressable>
  );
}

/** 찾는 중. 결과 줄의 높이를 지키는 막대 둘 — 움직이는 효과는 없다. */
export function SkeletonRows({label, count = 2}: {label: string; count?: number}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View accessible accessibilityLabel={label} style={styles.skeleton} testID="search-loading">
      {Array.from({length: count}, (_, index) => (
        <View key={index} style={styles.skeletonRow}>
          <View style={[styles.bar, styles.barShort]} />
          <View style={[styles.bar, styles.barLong]} />
        </View>
      ))}
    </View>
  );
}

/** 채널은 `#`·자물쇠, 상대가 한 사람으로 정해지지 않는 DM(그룹·나간 멤버)은 DM 글리프다. */
export function glyphFor(kind: 'channel' | 'private' | 'dm'): ImageSourcePropType {
  return kind === 'dm' ? HOME_ICONS.dms : kind === 'private' ? HOME_ICONS.lock : HOME_ICONS.hash;
}

export interface RecentTile {
  channelId: string;
  title: string;
  /** DM 이면 상대의 얼굴을, 아니면 채널 글리프를 그린다. */
  kind: 'channel' | 'private' | 'dm';
  peerId: string | null;
}

/** 최근 연 대화: 얼굴과 이름 한 줄이 가로로 줄 선다. */
export function RecentConversations({
  title,
  tiles,
  directory,
  openLabel,
  onOpen,
}: {
  title: string;
  tiles: readonly RecentTile[];
  directory: Directory;
  openLabel: (name: string) => string;
  onOpen: (tile: RecentTile) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View testID="search-recent-conversations">
      <Text accessibilityRole="header" style={styles.sectionTitle}>
        {title}
      </Text>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={styles.tiles}>
        {tiles.map(tile => (
          <Pressable
            key={tile.channelId}
            accessibilityRole="button"
            accessibilityLabel={openLabel(tile.title)}
            onPress={() => onOpen(tile)}
            style={({pressed}) => [styles.tile, pressed && styles.pressed]}
            testID={`search-recent-conversation-${tile.channelId}`}>
            {tile.kind === 'dm' && tile.peerId !== null ? (
              <Avatar directory={directory} memberId={tile.peerId} size={RECENT_FACE} ground="muted" />
            ) : (
              <View style={styles.tileFace}>
                <Image source={glyphFor(tile.kind)} style={styles.rowGlyph} accessibilityElementsHidden />
              </View>
            )}
            <Text style={styles.tileLabel} numberOfLines={1}>
              {tile.title}
            </Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

/** 최근 검색: 눌러서 다시 찾고, 「모두 지우기」로 비운다. */
export function RecentSearches({
  title,
  clearLabel,
  clearAccessibilityLabel,
  items,
  rowLabel,
  onPick,
  onClear,
}: {
  title: string;
  clearLabel: string;
  clearAccessibilityLabel: string;
  items: readonly string[];
  rowLabel: (query: string) => string;
  onPick: (query: string) => void;
  onClear: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <View testID="search-recent-searches">
      <View style={styles.sectionHead}>
        <Text accessibilityRole="header" style={styles.sectionTitleInline}>
          {title}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={clearAccessibilityLabel}
          hitSlop={slopTo(TOUCH_TARGET - space.md)}
          onPress={onClear}
          style={({pressed}) => [styles.more, pressed && styles.pressed]}
          testID="search-recent-clear">
          <Text style={styles.moreLabel}>{clearLabel}</Text>
        </Pressable>
      </View>
      {items.map(item => (
        <Pressable
          key={item}
          accessibilityRole="button"
          accessibilityLabel={rowLabel(item)}
          onPress={() => onPick(item)}
          style={({pressed}) => [styles.row, pressed && styles.pressed]}
          testID="search-recent-search">
          <View style={styles.rowLead}>
            <Image source={SEARCH_ICONS.clock} style={styles.clock} accessibilityElementsHidden />
          </View>
          <Text style={styles.rowTitleFill} numberOfLines={1}>
            {item}
          </Text>
          <Image source={SHEET_ICONS.chevron} style={styles.recentChevron} accessibilityElementsHidden />
        </Pressable>
      ))}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    chipRow: {
      flexDirection: 'row',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingBottom: space.sm,
    },
    chip: {
      flex: 1,
      height: CHIP_HEIGHT,
      alignItems: 'center',
      justifyContent: 'center',
      paddingHorizontal: space.sm,
      borderRadius: radius.pill,
      backgroundColor: color.surface,
    },
    chipSelected: {backgroundColor: color.primary},
    chipLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
    chipLabelSelected: {color: color.onPrimary},
    scopeRow: {
      flexDirection: 'row',
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingBottom: space.sm,
    },
    scopeChip: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: space.xs,
      height: CHIP_HEIGHT,
      paddingHorizontal: space.md,
      borderRadius: radius.pill,
      backgroundColor: color.surface,
    },
    scopeChipOn: {backgroundColor: color.accentSurface},
    scopeChipChosen: {flexShrink: 1},
    scopeLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
    scopeLabelOn: {color: color.accentText},
    scopeChosenLabel: {flexShrink: 1},
    chipGlyph: {
      width: HOME_ICON_SIZE.down,
      height: HOME_ICON_SIZE.down,
      tintColor: color.icon,
    },
    chipLeadGlyph: {
      width: HOME_ICON_SIZE.hash - space.sm,
      height: HOME_ICON_SIZE.hash - space.sm,
      tintColor: color.accentText,
    },
    chipCross: {
      width: CONV_ICON_SIZE.cross,
      height: CONV_ICON_SIZE.cross,
      tintColor: color.accentText,
    },
    groupHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.md,
      paddingBottom: space.xs,
    },
    groupTitle: {fontSize: font.label, fontWeight: '600', color: color.textMuted},
    more: {flexDirection: 'row', alignItems: 'center', gap: space.xs},
    moreLabel: {fontSize: font.label, fontWeight: '600', color: color.accentText},
    moreGlyph: {
      width: SHEET_ICON_SIZE.chevron - space.xs,
      height: SHEET_ICON_SIZE.chevron - space.xs,
      tintColor: color.accentText,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      minHeight: SHEET.rowMinHeight,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.sm,
    },
    rowLead: {
      width: SHEET.iconSlot + space.sm,
      alignItems: 'center',
      justifyContent: 'center',
    },
    faceLead: {width: PERSON_FACE, alignItems: 'center', justifyContent: 'center'},
    rowGlyph: {
      width: HOME_ICON_SIZE.hash,
      height: HOME_ICON_SIZE.hash,
      tintColor: color.icon,
    },
    clock: {
      width: SEARCH_CLOCK_SIZE,
      height: SEARCH_CLOCK_SIZE,
      tintColor: color.icon,
    },
    recentChevron: {
      width: SHEET_ICON_SIZE.chevron,
      height: SHEET_ICON_SIZE.chevron,
      tintColor: color.textFaint,
    },
    rowText: {flex: 1, gap: space.xs},
    rowTitle: {flexShrink: 1, fontSize: font.body, color: color.text},
    rowTitleFill: {flex: 1, fontSize: font.body, color: color.text},
    rowDetail: {fontSize: font.meta, color: color.textMuted},
    match: {color: color.text, fontWeight: '700', backgroundColor: color.accentSurfaceStrong},
    messageRow: {
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
      gap: space.xs,
      minHeight: TOUCH_TARGET,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: color.border,
    },
    rowHead: {flexDirection: 'row', alignItems: 'baseline', gap: space.sm},
    messageChannel: {flexShrink: 1, fontSize: font.label, fontWeight: '700', color: color.text},
    messageMeta: {flex: 1, fontSize: font.meta, color: color.textMuted},
    snippet: {fontSize: font.label, color: color.textMuted, lineHeight: line.label},
    sectionTitle: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.md,
      paddingBottom: space.sm,
      fontSize: font.label,
      fontWeight: '600',
      color: color.textMuted,
    },
    sectionHead: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: space.lg,
      paddingBottom: space.xs,
    },
    sectionTitleInline: {fontSize: font.label, fontWeight: '600', color: color.textMuted},
    // 첫 얼굴이 섹션 제목의 왼쪽 끝에 서도록 칸의 좌우 여유(칸 68 − 얼굴 52)의 절반만큼 여백을 덜어 낸다.
    tiles: {paddingHorizontal: SAFE_GUTTER - (RECENT_ITEM_WIDTH - RECENT_FACE) / 2, gap: space.xs},
    tile: {width: RECENT_ITEM_WIDTH, alignItems: 'center', gap: space.xs},
    tileFace: {
      width: RECENT_FACE,
      height: RECENT_FACE,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: ds2Radius.row,
      backgroundColor: color.surface,
    },
    // 줄 상자를 선언한다: 하이픈(라틴 글자)이 든 이름만 줄이 더 높아져 같은 줄의 라벨이 아래로 밀리는 것을 막는다.
    tileLabel: {
      width: RECENT_ITEM_WIDTH,
      textAlign: 'center',
      fontSize: font.label,
      lineHeight: line.label,
      color: color.textMuted,
    },
    skeleton: {paddingTop: space.sm},
    skeletonRow: {
      gap: space.sm,
      paddingHorizontal: SAFE_GUTTER,
      paddingVertical: space.md,
    },
    bar: {height: space.md, borderRadius: radius.md, backgroundColor: color.surface},
    barShort: {width: '40%'},
    barLong: {width: '90%'},
    pressed: {backgroundColor: color.surfacePressed},
  });
