import {createChannel, type Channel} from '@momo/core/lib/api';
import {
  channelNameIssue,
  CHANNEL_NAME_MAX,
  channelNameIssueMessage,
  createChannelFailure,
  normalizeChannelName,
  type CreateChannelFailure,
} from '@momo/core/features/channels/model';
import {upsertChannel} from '@momo/core/features/directory/model';
import {useQueryClient} from '@tanstack/react-query';
import React, {useState} from 'react';
import {
  Pressable,
  ScrollView,
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
  space,
  TOUCH_TARGET,
  type Palette,
} from '../design/tokens';
import {workspaceKeys} from '../features/workspace/queries';
import {useSession} from '../session/useSession';
import {SheetTitleRow} from './NewMessageSheet';

// =============================================================================
// 새 채널 시트 — + 메뉴의 「새 채널」 (DS2-2b #2750).
//
// 폰에는 채널을 만드는 문이 없었다(홈 빈 상태가 「데스크톱에서 할 수 있습니다」라고
// 말했다). + 메뉴가 Buzz 처럼 「새 채널」을 들면서, 이름을 짓는 무거운 일은 이
// 시트로 넘어온다.
//
// 규칙은 모두 core 의 것이다 — 웹 「채널 만들기」 다이얼로그와 한 문장을 쓴다:
//   이름 규칙·문장  `channelNameIssue` / `channelNameIssueMessage`
//   거절의 자리     `createChannelFailure`(409·400 은 이름 칸 밑, 403·429·망은 배너)
//   캐시            `upsertChannel` 로 목록에 바로 넣고 무효화 — 웹 `useCreateChannel`
//
// 누가 볼 수 있는가(오너·관리자)는 메뉴가 정한다(`canCreateChannelNow`). 서버가 마지막
// 말을 하므로 여기서 403 이 와도 배너로 말한다.
// =============================================================================

const KINDS = [
  {
    id: 'public' as const,
    label: '공개',
    detail: '워크스페이스의 누구나 찾아서 들어올 수 있습니다.',
  },
  {
    id: 'private' as const,
    label: '비공개',
    detail: '추가된 멤버에게만 보입니다.',
  },
];

export function NewChannelSheet({
  onOpenConversation,
  onClose,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet
      onClose={onClose}
      accessibilityLabel="새 채널"
      testID="new-channel-sheet">
      <SheetBody onOpenConversation={onOpenConversation} onClose={onClose} />
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
  const {workspaceId} = useSession();
  const client = useQueryClient();
  const slideClose = usePageSheetClose() ?? onClose;
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'public' | 'private'>('public');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreateChannelFailure | null>(null);

  const issue = channelNameIssue(name);
  // 빈 칸은 아직 말하지 않는다 — 열자마자 「입력하세요」가 서면 꾸중부터 듣는다.
  const issueMessage =
    issue && (touched || name !== '') ? channelNameIssueMessage(issue) : null;
  const nameMessage =
    failure?.field === 'name' ? failure.message : issueMessage;
  // 규칙은 처음부터 칸 밑에 선다 — 웹 다이얼로그와 같은 자리, 같은 문장 가족이다
  // (design-review M4). 어기면 같은 자리가 그 이유로 바뀐다.
  const nameRule = `영문, 숫자, 하이픈, 밑줄로 ${CHANNEL_NAME_MAX}자 이내, 처음과 끝은 영문이나 숫자. 대문자는 소문자로 저장됩니다.`;

  const submit = async () => {
    setTouched(true);
    if (issue || pending) return;
    setPending(true);
    setFailure(null);
    try {
      const created = await createChannel(workspaceId, {
        kind,
        name: normalizeChannelName(name),
      });
      client.setQueryData<Channel[]>(
        workspaceKeys.channels(workspaceId),
        current =>
          current ? upsertChannel(current, created.channel) : [created.channel],
      );
      void client.invalidateQueries({
        queryKey: workspaceKeys.channels(workspaceId),
      });
      onClose();
      onOpenConversation(
        created.channel.id,
        created.channel.name ?? normalizeChannelName(name),
      );
    } catch (error) {
      setFailure(createChannelFailure(error));
    } finally {
      setPending(false);
    }
  };

  const disabled = pending || issue !== null;

  return (
    <ScrollView
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentContainerStyle={styles.list}
      testID="new-channel-body">
      <SheetTitleRow
        title="새 채널"
        closeLabel="새 채널 닫기"
        onClose={slideClose}
        testID="new-channel"
        trailing={
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={pending ? '채널 만드는 중' : '채널 만들기'}
            accessibilityState={{disabled, busy: pending}}
            disabled={disabled}
            onPress={() => void submit()}
            style={({pressed}) => [styles.create, pressed && styles.pressed]}
            testID="new-channel-create">
            <Text
              style={[styles.createLabel, disabled && styles.createLabelOff]}
              maxFontSizeMultiplier={BAR_CONTROL_MAX_SCALE}>
              만들기
            </Text>
          </Pressable>
        }
      />

      <Text accessibilityRole="header" style={styles.label}>
        채널 이름
      </Text>
      <View style={styles.field}>
        <Text
          style={styles.hash}
          importantForAccessibility="no"
          accessibilityElementsHidden>
          #
        </Text>
        <TextInput
          style={styles.input}
          value={name}
          onChangeText={next => {
            setName(next);
            if (failure?.field === 'name') setFailure(null);
          }}
          onBlur={() => setTouched(true)}
          onSubmitEditing={() => void submit()}
          placeholder="product-planning"
          placeholderTextColor={palette.textFaint}
          autoCapitalize="none"
          autoCorrect={false}
          // 이름은 영문 소문자·숫자·하이픈·밑줄뿐이다 — 한글 자판으로 열면 첫 글자부터
          // 규칙 위반 문장을 본다.
          keyboardType="ascii-capable"
          autoFocus
          returnKeyType="done"
          editable={!pending}
          accessibilityLabel="채널 이름"
          // VoiceOver 도 같은 줄을 듣는다: 평소엔 규칙, 어기면 그 이유.
          accessibilityHint={nameMessage ?? nameRule}
          testID="new-channel-name"
        />
      </View>
      {nameMessage ? (
        <Text
          accessibilityLiveRegion="polite"
          style={styles.issue}
          testID="new-channel-name-issue">
          {nameMessage}
        </Text>
      ) : (
        <Text style={styles.rule} testID="new-channel-name-rule">
          {nameRule}
        </Text>
      )}

      <View style={styles.kind}>
        <GroupSection label="공개 범위" testID="new-channel-kind">
          {KINDS.map((choice, index) => (
            <GroupRow
              key={choice.id}
              title={choice.label}
              detail={choice.detail}
              separated={index > 0}
              accessibilityRole="radio"
              accessibilityState={{selected: kind === choice.id}}
              onPress={() => setKind(choice.id)}
              trailing={
                kind === choice.id ? (
                  <Text style={styles.check} importantForAccessibility="no">
                    ✓
                  </Text>
                ) : null
              }
              testID={`new-channel-kind-${choice.id}`}
            />
          ))}
        </GroupSection>
      </View>

      {failure && failure.field === null ? (
        <FailureBanner
          message={failure.message}
          onRetry={() => void submit()}
          testID="new-channel-error"
        />
      ) : null}
    </ScrollView>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    list: {paddingBottom: space.xl * 2},
    kind: {marginTop: space.xl},
    label: {
      marginTop: space.lg,
      marginBottom: space.sm,
      marginLeft: SAFE_GUTTER,
      fontSize: font.label,
      fontWeight: '700',
      color: color.textMuted,
    },
    // 입력 그릇만 선을 든다(ADR-0189 D6: outline 은 텍스트 입력에만).
    field: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      borderRadius: ds2Radius.row,
      borderWidth: 1,
      borderColor: color.textFaint,
      backgroundColor: color.surface,
      paddingHorizontal: space.md,
      marginHorizontal: SAFE_GUTTER,
    },
    hash: {fontSize: font.body, color: color.textMuted, fontWeight: '600'},
    input: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      fontSize: font.body,
      color: color.text,
    },
    rule: {
      marginTop: space.sm,
      marginHorizontal: SAFE_GUTTER,
      fontSize: font.label,
      color: color.textMuted,
    },
    issue: {
      marginTop: space.sm,
      marginHorizontal: SAFE_GUTTER,
      fontSize: font.label,
      color: color.dangerText,
    },
    create: {
      minWidth: TOUCH_TARGET,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
    },
    createLabel: {
      fontSize: ds2Type.callout,
      fontWeight: '700',
      color: color.text,
    },
    createLabelOff: {color: color.textFaint},
    pressed: {opacity: 0.6},
    check: {fontSize: font.body, fontWeight: '700', color: color.text},
  });
