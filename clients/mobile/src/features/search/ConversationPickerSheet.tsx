import {AVATAR_SIZE} from '@momo/core/features/workspace/avatar';
import type {Directory} from '@momo/core/features/workspace/directory';
import React, {useMemo, useState} from 'react';
import {FlatList, Image, StyleSheet, View} from 'react-native';

import {Sentence} from '../../design/atoms';
import {HOME_ICON_SIZE, SHELL_ICONS} from '../../design/icons';
import {PageSheet, usePageSheetAction, usePageSheetScrollProps} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {ChoiceRow, GroupCardItem, InputPill} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, SAFE_GUTTER, SHEET, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {Avatar} from '../conversation/Avatar';
import {matchName} from './localSearch';
import {glyphFor} from './SearchRows';

// =============================================================================
// 「대화 고르기」 시트 — 메시지 검색의 범위를 대화 **하나**로 좁힌다 (#5365, owner 11-05).
//
// 서버는 `channel=` 에 대화 하나만 받는다(#1931). 그래서 여러 대화를 칩으로 줄세우지 않고, 이 시트에서 하나를 골라
// 검색 화면의 둘째 줄에 「# 이름 ×」 칩 하나로 보인다(칩 줄이 짧게 남는다). 첫 줄은 「모든 대화」(좁히지 않음)다.
//
// 모양은 `NewMessageSheet` 와 같은 가족이다: 페이지 시트 + 머리(제목·원형 X) + 입력 알약 + 묶음 카드의 줄. 줄은 하나만 고르는
// 값이라 라디오 행(`ChoiceRow`, 고른 줄에 ✓)이고, 누르면 시트가 미끄러져 내려간 **뒤에** 고른 값이 올라간다(`usePageSheetAction`).
// 목록은 `FlatList` 라 스스로 시트에 스크롤을 알린다.
// =============================================================================

export interface PickerItem {
  id: string;
  title: string;
  subtitle: string;
  /** 채널(공개·비공개)이면 글리프, DM 이면 상대의 얼굴. */
  kind: 'channel' | 'private' | 'dm';
  peerId: string | null;
}

export function ConversationPickerSheet({
  items,
  directory,
  selectedId,
  onPick,
  onClose,
}: {
  items: readonly PickerItem[];
  directory: Directory;
  /** 지금 좁혀 둔 대화. 없으면 「모든 대화」가 골라져 있다. */
  selectedId: string | null;
  /** `null` 은 「모든 대화」. */
  onPick: (channelId: string | null) => void;
  onClose: () => void;
}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel={formatMessage('search.picker.title')}
      scrimLabel={formatMessage('search.picker.close')}
      testID="search-picker-sheet">
      <PickerBody items={items} directory={directory} selectedId={selectedId} onPick={onPick} />
    </PageSheet>
  );
}

function PickerBody({
  items,
  directory,
  selectedId,
  onPick,
}: {
  items: readonly PickerItem[];
  directory: Directory;
  selectedId: string | null;
  onPick: (channelId: string | null) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  // 목록은 날 `FlatList` 라 스스로 시트에 알려야 한다: 맨 위에서 아래로 끌면 시트가 따라오고, 중간이면 목록이 스크롤한다.
  const sheetScroll = usePageSheetScrollProps();
  const afterClose = usePageSheetAction();
  const [filter, setFilter] = useState('');

  const shown = useMemo(() => {
    const needle = filter.trim();
    return needle === '' ? items : items.filter(item => matchName(needle, item.title, true) !== null);
  }, [items, filter]);
  // 「모든 대화」는 걸러지지 않는 첫 줄이다 — 이름으로 찾는 중에는 숨긴다(찾는 대상이 대화 이름이다).
  const withAll = filter.trim() === '';
  const count = shown.length + (withAll ? 1 : 0);

  return (
    <View style={styles.body}>
      <SheetHeader
        title={formatMessage('search.picker.title')}
        closeLabel={formatMessage('search.picker.close')}
        closeTestID="search-picker-close"
      />
      <FlatList
        {...sheetScroll}
        data={shown}
        keyExtractor={item => item.id}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <View style={styles.listHeader}>
            <InputPill
              icon={SHELL_ICONS.search}
              value={filter}
              onChangeText={setFilter}
              placeholder={formatMessage('search.picker.filterPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              clearButtonMode="while-editing"
              accessibilityLabel={formatMessage('search.picker.filterLabel')}
              testID="search-picker-filter"
            />
            {withAll ? (
              <GroupCardItem index={0} count={count} inset={AVATAR_SIZE}>
                <ChoiceRow
                  leading={
                    <View style={styles.glyphSlot}>
                      <Image source={SHELL_ICONS.search} style={styles.glyph} accessibilityElementsHidden />
                    </View>
                  }
                  leadingWidth={AVATAR_SIZE}
                  leadingAlign="center"
                  title={formatMessage('search.picker.all')}
                  selected={selectedId === null}
                  onPress={() => afterClose(() => onPick(null))}
                  testID="search-picker-all"
                  checkTestID="search-picker-check"
                />
              </GroupCardItem>
            ) : null}
          </View>
        }
        ListEmptyComponent={
          <Sentence style={styles.empty} testID="search-picker-empty">
            {formatMessage('search.picker.empty')}
          </Sentence>
        }
        renderItem={({item, index}) => (
          <GroupCardItem index={index + (withAll ? 1 : 0)} count={count} inset={AVATAR_SIZE}>
            <ChoiceRow
              leading={
                item.kind === 'dm' && item.peerId !== null ? (
                  <Avatar directory={directory} memberId={item.peerId} ground="muted" />
                ) : (
                  <View style={styles.glyphSlot}>
                    <Image source={glyphFor(item.kind)} style={styles.glyph} accessibilityElementsHidden />
                  </View>
                )
              }
              leadingWidth={AVATAR_SIZE}
              leadingAlign="center"
              title={item.title}
              detail={item.subtitle}
              selected={selectedId !== null && item.id === selectedId}
              onPress={() => afterClose(() => onPick(item.id))}
              testID={`search-picker-item-${item.id}`}
              checkTestID="search-picker-check"
            />
          </GroupCardItem>
        )}
        testID="search-picker-list"
      />
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {flex: 1},
    // 카드·입력은 가로 여백을 목록이 준다 — 시트 몸은 여백이 없다(`PageSheet`).
    list: {
      paddingHorizontal: SAFE_GUTTER,
      paddingTop: SHEET.bodyTop,
      paddingBottom: space.xl * 2,
    },
    listHeader: {gap: space.md},
    glyphSlot: {width: AVATAR_SIZE, alignItems: 'center', justifyContent: 'center'},
    glyph: {width: HOME_ICON_SIZE.hash, height: HOME_ICON_SIZE.hash, tintColor: color.icon},
    empty: {paddingVertical: space.lg, fontSize: font.body, color: color.textMuted},
  });
