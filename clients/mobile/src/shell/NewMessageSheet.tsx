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
  GroupRow,
  GroupSection,
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
// FAB 시트 — 「새 메시지」와 「에이전트 부르기」 (ADR-0189 D1, DS2-2 #2714).
//
// 잉크 FAB은 이 시트를 연다. 시안은 FAB 한 개(`aria-label="새 메시지"`)만 그리고
// 그 뒤를 그리지 않았으므로, 시트의 모양은 셸의 페이지 시트(`PageSheet`, 시안
// `.a-sheet`)를 그대로 쓰고 안의 줄은 이미 있는 묶음 카드 문법(`GroupSection`)을
// 쓴다. 새 모양을 만들지 않는다.
//
// 세 가지를 담는다:
//
//   에이전트 부르기  에이전트 목록 층을 연다 — 사라진 「에이전트」 탭의 문
//                    (수용기준 「기능 손실 0」). 홈이 그 자리를 흡수하면(DS2-3)
//                    이 줄이 남을지는 그 이슈가 정한다.
//   작업 콘솔        서버가 그 표면을 내줄 때만. 사라진 「작업」 탭의 문.
//   받는 사람        워크스페이스의 사람과 에이전트. 누르면 서버가 그 둘의 DM 을
//                    열어 주고(없으면 만든다) 그 대화로 간다. 폰에서 처음으로 **아직
//                    DM 이 없는 사람**에게 말을 걸 수 있는 문이다.
// =============================================================================

export function NewMessageSheet({
  workConsole,
  onOpenAgentList,
  onOpenWorkList,
  onOpenConversation,
  onClose,
}: {
  /** 작업 콘솔 줄을 세울지(서버 표면). */
  workConsole: boolean;
  onOpenAgentList: () => void;
  onOpenWorkList: () => void;
  onOpenConversation: (channelId: string, title: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet onClose={onClose} accessibilityLabel="새 메시지" testID="new-message-sheet">
      <SheetBody
        workConsole={workConsole}
        onOpenAgentList={onOpenAgentList}
        onOpenWorkList={onOpenWorkList}
        onOpenConversation={onOpenConversation}
        onClose={onClose}
      />
    </PageSheet>
  );
}

function SheetBody({
  workConsole,
  onOpenAgentList,
  onOpenWorkList,
  onOpenConversation,
  onClose,
}: {
  workConsole: boolean;
  onOpenAgentList: () => void;
  onOpenWorkList: () => void;
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

  // 층을 여는 줄은 시트를 **즉시** 걷는다(미끄러지지 않는다). 새 층이 셸 위에
  // 서는 순간 시트가 아직 내려가는 중이면 두 움직임이 겹쳐 보인다.
  const header = (
    <View>
      {/* 시안 `.a-sh-top`: 왼쪽 42pt 원형 닫기(`.a-cbtn`, ×). 시안의 오른쪽 「편집」
          자리는 이 시트에 할 일이 없어 비우고, 가운데에 시트의 이름을 둔다. */}
      <View style={styles.titleRow}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="새 메시지 닫기"
          onPress={slideClose}
          hitSlop={slopTo(CLOSE_SIZE)}
          style={({pressed}) => [styles.close, pressed && styles.pressed]}
          testID="new-message-close">
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
          새 메시지
        </Text>
        <View style={styles.closeBalance} />
      </View>

      <GroupSection testID="new-message-doors">
        <GroupRow
          title="에이전트 부르기"
          detail="에이전트 목록에서 골라 대화를 엽니다."
          chevron
          onPress={() => {
            onClose();
            onOpenAgentList();
          }}
          testID="new-message-agents"
        />
        {workConsole ? (
          <GroupRow
            title="작업 콘솔"
            detail="에이전트가 하고 있는 일을 봅니다."
            chevron
            separated
            onPress={() => {
              onClose();
              onOpenWorkList();
            }}
            testID="new-message-work"
          />
        ) : null}
      </GroupSection>

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
        testID="new-message-search"
      />
      {openDm.isError ? (
        <FailureBanner
          message={openDmFailureCopy(openDm.error)}
          onRetry={
            openDm.variables === undefined
              ? undefined
              : () => openDm.mutate(openDm.variables as string)
          }
          testID="new-message-error"
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
        <Text style={styles.empty} testID="new-message-empty">
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
            testID={`new-message-person-${item.handle}`}>
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
      testID="new-message-list"
    />
  );
}

/** 시안 `.a-cbtn{width:42px;height:42px}`. 44 에 모자란 2 는 `hitSlop` 이 진다. */
const CLOSE_SIZE = 42;

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    list: {paddingBottom: space.xl * 2},
    // 시트 몸은 가로 여백을 주지 않는다(`PageSheet`). 묶음 카드(`GroupSection`)는
    // 자기 16 을 들고, 나머지 줄은 여기서 같은 16 을 든다 — 왼쪽 가장자리가 하나다.
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
