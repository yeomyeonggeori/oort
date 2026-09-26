import {openDirectMessage, uuidEq} from '@momo/core/lib/api';
import {channelLabel} from '@momo/core/features/workspace/directory';
import {useMutation} from '@tanstack/react-query';
import React, {useMemo, useState} from 'react';
import {
  FlatList,
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';

import {
  BAR_CONTROL_MAX_SCALE,
  FailureBanner,
} from '../design/atoms';
import {PageSheet, usePageSheetClose} from '../design/PageSheet';
import {usePalette, useStyles} from '../design/theme';
import {
  ds2Radius,
  ds2Type,
  font,
  SAFE_GUTTER,
  slopTo,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {SHELL_ICONS, SHELL_ICON_SIZE} from '../design/icons';
import {Avatar} from '../features/conversation/Avatar';
import {useDirectory} from '../features/workspace/queries';
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
// =============================================================================

export function NewMessageSheet({
  onOpenConversation,
  onClose,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="새 DM" testID="new-dm-sheet">
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
  const palette = usePalette();
  const {member, workspaceId} = useSession();
  const directoryQuery = useDirectory(workspaceId);
  const slideClose = usePageSheetClose() ?? onClose;
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

  const openDm = useMutation({
    mutationFn: (memberId: string) => openDirectMessage(workspaceId, memberId),
    onSuccess: opened => {
      // 머리의 이름은 목록이 쓰는 것과 같은 코어 함수로 푼다 — 같은 방을 두 화면이
      // 다르게 부르지 않게.
      const title = channelLabel(opened.channel, directoryQuery.directory, member.id);
      onClose();
      onOpenConversation(opened.channel.id, title);
    },
  });

  const header = (
    <View>
      <SheetTitleRow
        title="새 DM"
        closeLabel="새 DM 닫기"
        onClose={slideClose}
        testID="new-dm"
      />

      <Text accessibilityRole="header" style={styles.label}>
        받는 사람
      </Text>
      <TextInput
        style={styles.search}
        value={query}
        onChangeText={setQuery}
        placeholder="이름이나 @핸들"
        placeholderTextColor={palette.textFaint}
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
    <FlatList
      data={people}
      keyExtractor={candidate => candidate.id}
      ListHeaderComponent={header}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.list}
      ListEmptyComponent={
        <Text style={styles.empty} testID="new-dm-empty">
          {query.trim() === ''
            ? '말을 걸 수 있는 사람이 아직 없습니다.'
            : `'${query.trim()}'에 맞는 사람이 없습니다.`}
        </Text>
      }
      renderItem={({item}) => {
        const busy = openDm.isPending && openDm.variables === item.id;
        const kind = item.kind === 'agent' ? '에이전트' : '사람';
        return (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${item.displayName}, @${item.handle}, ${kind}`}
            accessibilityHint="대화를 엽니다."
            accessibilityState={{busy}}
            disabled={openDm.isPending}
            onPress={() => openDm.mutate(item.id)}
            style={({pressed}) => [styles.person, pressed && styles.personPressed]}
            testID={`new-dm-person-${item.handle}`}>
            <Avatar directory={directoryQuery.directory} memberId={item.id} />
            <View style={styles.personText}>
              <Text style={styles.personName} numberOfLines={1}>
                {item.displayName}
              </Text>
              <Text style={styles.personHandle} numberOfLines={1}>
                @{item.handle} · {kind}
              </Text>
            </View>
          </Pressable>
        );
      }}
      testID="new-dm-list"
    />
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
    list: {paddingBottom: space.xl * 2},
    // 시트 몸은 가로 여백을 주지 않는다(`PageSheet`). 줄마다 여기서 같은 16 을
    // 든다 — 왼쪽 가장자리가 하나다.
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
      fontSize: ds2Type.headline,
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
    label: {
      marginTop: space.lg,
      marginBottom: space.sm,
      // 시트 여백 16 + 시안 `.a-glabel{margin-left:6px}`. 격자 밖 값이라 잔량 목록에
      // 올라 있다(`designSystem.test.ts`) — 식으로 감춰 스윕을 피하지 않는다.
      marginLeft: 22,
      fontSize: font.label,
      fontWeight: '700',
      color: color.textMuted,
    },
    // 입력 그릇만 선을 든다(ADR-0189 D6: outline 은 텍스트 입력에만).
    search: {
      minHeight: TOUCH_TARGET,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      paddingHorizontal: space.md,
      fontSize: font.body,
      color: color.text,
      marginBottom: space.sm,
      marginHorizontal: SAFE_GUTTER,
    },
    person: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      minHeight: 54,
      paddingVertical: space.xs,
      marginHorizontal: SAFE_GUTTER - space.sm,
      paddingHorizontal: space.sm,
      borderRadius: ds2Radius.row,
    },
    personPressed: {backgroundColor: color.surfacePressed},
    personText: {flex: 1, minWidth: 0},
    personName: {fontSize: font.body, color: color.text, fontWeight: '600'},
    personHandle: {fontSize: font.label, color: color.textMuted},
    empty: {
      paddingVertical: space.lg,
      paddingHorizontal: SAFE_GUTTER,
      fontSize: font.body,
      color: color.textMuted,
    },
  });
