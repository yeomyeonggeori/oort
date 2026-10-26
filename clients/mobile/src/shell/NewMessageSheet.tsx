import {openDirectMessage, uuidEq} from '@momo/core/lib/api';
import {AVATAR_SIZE} from '@momo/core/features/workspace/avatar';
import {channelLabel} from '@momo/core/features/workspace/directory';
import {useMutation} from '@tanstack/react-query';
import React, {useMemo, useState} from 'react';
import {FlatList, Image, Pressable, StyleSheet, Text, View} from 'react-native';

import {
  BAR_CONTROL_MAX_SCALE,
  FailureBanner,
  Sentence,
} from '../design/atoms';
import {PageSheet} from '../design/PageSheet';
import {SheetHeader} from '../design/SheetChrome';
import {GroupCardItem, GroupLabel, InputPill, ListRow} from '../design/sheetParts';
import {usePalette, useStyles} from '../design/theme';
import {font, SAFE_GUTTER, SHEET, slopTo, space, type Palette} from '../design/tokens';
import {SHELL_ICONS, SHELL_ICON_SIZE} from '../design/icons';
import {Avatar} from '../features/conversation/Avatar';
import {useDirectory, useRememberOpenedDm} from '../features/workspace/queries';
import {openDmFailureCopy} from '../screens/SidebarScreen';
import {useSession} from '../session/useSession';

// =============================================================================
// 새 DM 시트 — + 메뉴의 「새 DM」이 여는 사람 고르기 (DS2-2b #2750; 처음은 DS2-2 #2714).
//
// + 메뉴(`PlusMenu`)는 가볍게 문만 든다. 사람을 고르는 일은 목록과 검색이 필요한
// 무거운 일이라 이 시트로 넘어온다. 시트의 그릇은 셸의 페이지 시트(`PageSheet`, 시안
// `.a-sheet`)다.
//
// DS2-2 에서 이 시트 위에 있던 두 문(에이전트 부르기·작업 콘솔)은 + 메뉴의 행으로
// 옮겼다 — 기능은 그대로이고 한 번 덜 누른다.
//
// 받는 사람: 워크스페이스의 사람과 에이전트. 누르면 서버가 그 둘의 DM 을 열어 주고
// (없으면 만든다) 그 대화로 간다. 폰에서 **아직 DM 이 없는 사람**에게 말을 걸 수 있는
// 문이다.
//
// ## 공용 부품으로 (#4318)
//
// 머리는 오른쪽 원형 X 의 `SheetHeader` 이고 목록 밖에 고정이다. 검색은 앞 아이콘이 선 입력
// 알약(`InputPill`), 사람은 묶음 카드의 줄(`GroupCardItem` + `ListRow`)이다. 긴 목록이지만
// 「고르면 곧 닫히는」 선택기라 페이지가 아니라 큰 단의 시트다(`docs/design-system/phone-sheets.md`).
// 아래 `SheetTitleRow`(왼쪽 원형 X 의 옛 머리)는 아직 옮기지 않은 시트들이 쓰므로 남겨 둔다 —
// #4458 이 그 시트들을 옮기는 날 함께 지운다.
// =============================================================================

export function NewMessageSheet({
  onOpenConversation,
  onClose,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel="새 DM"
      scrimLabel="새 DM 닫기"
      testID="new-dm-sheet">
      <SheetBody
        onOpenConversation={onOpenConversation}
        onClose={onClose}
      />
    </PageSheet>
  );
}

function SheetBody({
  onOpenConversation,
  onClose,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const {member, workspaceId} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const [query, setQuery] = useState('');

  const people = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return directoryQuery.directory.members
      .filter(
        candidate =>
          candidate.status === 'active' && !uuidEq(candidate.id, member.id),
      )
      .filter(
        candidate =>
          needle === '' ||
          candidate.displayName.toLowerCase().includes(needle) ||
          candidate.handle.toLowerCase().includes(needle),
      )
      .sort((a, b) => a.displayName.localeCompare(b.displayName, 'ko'));
  }, [directoryQuery.directory, member.id, query]);

  const rememberOpenedDm = useRememberOpenedDm(workspaceId);
  const openDm = useMutation({
    mutationFn: (memberId: string) => openDirectMessage(workspaceId, memberId),
    onSuccess: opened => {
      rememberOpenedDm(opened.channel);
      // 머리의 이름은 목록이 쓰는 것과 같은 코어 함수로 푼다 — 같은 방을 두 화면이
      // 다르게 부르지 않게.
      const title = channelLabel(opened.channel, directoryQuery.directory, member.id);
      onClose();
      onOpenConversation(opened.channel.id, title);
    },
  });

  // 머리(원형 X·제목)는 목록 밖에 고정이다 — 목록이 스크롤돼도 닫기가 사라지지 않는다.
  // 검색 칸과 오류는 목록의 머리라 목록과 함께 스크롤한다.
  const listHeader = (
    <View style={styles.listHeader}>
      <GroupLabel>받는 사람</GroupLabel>
      <InputPill
        icon={SHELL_ICONS.search}
        value={query}
        onChangeText={setQuery}
        placeholder="이름이나 @핸들"
        autoCapitalize="none"
        autoCorrect={false}
        clearButtonMode="while-editing"
        accessibilityLabel="받는 사람 찾기"
        testID="new-dm-search"
      />
      {openDm.isError ? (
        <FailureBanner
          message={openDmFailureCopy(openDm.error)}
          onRetry={
            openDm.variables === undefined
              ? undefined
              : () => openDm.mutate(openDm.variables as string)
          }
          testID="new-dm-error"
        />
      ) : null}
    </View>
  );

  return (
    <View style={styles.body}>
      <SheetHeader title="새 DM" closeLabel="새 DM 닫기" closeTestID="new-dm-close" />
      <FlatList
        data={people}
        keyExtractor={candidate => candidate.id}
        ListHeaderComponent={listHeader}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <Sentence style={styles.empty} testID="new-dm-empty">
            {query.trim() === ''
              ? '말을 걸 수 있는 사람이 아직 없습니다.'
              : `'${query.trim()}'에 맞는 사람이 없습니다.`}
          </Sentence>
        }
        renderItem={({item, index}) => {
          const busy = openDm.isPending && openDm.variables === item.id;
          const kind = item.kind === 'agent' ? '에이전트' : '사람';
          return (
            <GroupCardItem index={index} count={people.length} inset={AVATAR_SIZE}>
              <ListRow
                // 카드(`surface`) 위의 아바타 — 기본 `ground='surface'` 는 카드에 녹아 이니셜만 떠 보인다
                // (`Avatar.ground` 주석이 말한 그 실패). `muted` 로 원이 선다.
                leading={
                  <Avatar
                    directory={directoryQuery.directory}
                    memberId={item.id}
                    ground="muted"
                  />
                }
                leadingWidth={AVATAR_SIZE}
                title={item.displayName}
                detail={`@${item.handle} · ${kind}`}
                accessibilityLabel={`${item.displayName}, @${item.handle}, ${kind}`}
                accessibilityHint="대화를 엽니다."
                busy={busy}
                disabled={openDm.isPending}
                onPress={() => openDm.mutate(item.id)}
                testID={`new-dm-person-${item.handle}`}
              />
            </GroupCardItem>
          );
        }}
        testID="new-dm-list"
      />
    </View>
  );
}

/** 시안 `.a-cbtn{width:42px;height:42px}`. 44 에 모자란 2 는 `hitSlop` 이 진다. */
const CLOSE_SIZE = 42;

/**
 * 시안 `.a-sh-top`: 왼쪽 42pt 원형 닫기(`.a-cbtn`, ×), 가운데 시트 이름, 오른쪽
 * 행위 자리(`trailing`, 시안의 「편집」 자리). 행위가 없으면 닫기와 같은 폭의 빈 칸이
 * 이름을 가운데에 둔다. 새 DM·새 채널 두 시트가 같은 머리를 쓴다.
 */
export function SheetTitleRow({
  title,
  closeLabel,
  onClose,
  trailing,
  testID,
}: {
  title: string;
  closeLabel: string;
  onClose: () => void;
  trailing?: React.ReactNode;
  testID: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  return (
    <View style={styles.titleRow}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={closeLabel}
        onPress={onClose}
        hitSlop={slopTo(CLOSE_SIZE)}
        style={({pressed}) => [styles.close, pressed && styles.pressed]}
        testID={`${testID}-close`}>
        <Image
          source={SHELL_ICONS.x}
          style={{
            width: SHELL_ICON_SIZE.x,
            height: SHELL_ICON_SIZE.x,
            tintColor: palette.text,
          }}
        />
      </Pressable>
      <Text
        accessibilityRole="header"
        style={styles.title}
        numberOfLines={1}
        maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
        {title}
      </Text>
      {trailing ?? <View style={styles.closeBalance} />}
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    body: {flex: 1},
    // 카드·입력은 가로 여백을 목록이 준다 — 시트 몸은 여백이 없다(`PageSheet`).
    list: {
      paddingHorizontal: SAFE_GUTTER,
      // 머리 줄 아래 숨 쉴 틈(`SheetScroll` 과 같은 값).
      paddingTop: SHEET.bodyTop,
      paddingBottom: space.xl * 2,
    },
    listHeader: {gap: space.sm, paddingBottom: space.lg},
    empty: {
      paddingVertical: space.lg,
      fontSize: font.body,
      color: color.textMuted,
    },
    // ---- `SheetTitleRow` — 옛 머리(왼쪽 원형 X). #4458 이 나머지 시트를 새 `SheetHeader` 로 옮기면 지운다.
    titleRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: SAFE_GUTTER,
      marginBottom: space.md,
    },
    title: {
      flex: 1,
      textAlign: 'center',
      fontSize: font.heading,
      fontWeight: '700',
      color: color.text,
    },
    close: {
      width: CLOSE_SIZE,
      height: CLOSE_SIZE,
      borderRadius: CLOSE_SIZE / 2,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: color.surface,
      boxShadow: color.elevationRest,
    },
    closeBalance: {width: CLOSE_SIZE},
    pressed: {opacity: 0.6},
  });
