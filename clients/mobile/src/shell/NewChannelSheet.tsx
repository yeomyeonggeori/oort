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
import {StyleSheet, Text, View} from 'react-native';

import {FailureBanner} from '../design/atoms';
import {HOME_ICONS} from '../design/icons';
import {PageSheet, usePageSheetClose} from '../design/PageSheet';
import {SheetHeader} from '../design/SheetChrome';
import {ChoiceRow, GroupCard, GroupLabel, InputPill, SheetScroll} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, space, type Palette} from '../design/tokens';
import {workspaceKeys} from '../features/workspace/queries';
import {useSession} from '../session/useSession';

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
// 누가 볼 수 있는가(소유자·관리자)는 메뉴가 정한다(`canCreateChannelNow`). 서버가 마지막
// 말을 하므로 여기서 403 이 와도 배너로 말한다.
//
// ## 공용 시트로 (#4458)
//
// 그릇은 `PageSheet`(중간 단 — 입력이 있는 짧은 시트의 표준 모양, 키보드는 그릇이 피한다). 머리는 `SheetHeader`:
// **왼쪽 ✓ = 채널 만들기**(이름이 규칙을 어기거나 만드는 중이면 회색·눌리지 않음), **오른쪽 원형 X = 닫기**. 옛 오른쪽 글자
// 「만들기」 단추는 없다. 이름은 앞 아이콘(#)이 선 입력 알약(`InputPill`), 공개 범위는 묶음 카드의 라디오 행이다.
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
      height="medium"
      onClose={onClose}
      accessibilityLabel="새 채널"
      scrimLabel="새 채널 닫기"
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
    <>
      <SheetHeader
        title="새 채널"
        closeLabel="새 채널 닫기"
        onClose={slideClose}
        closeTestID="new-channel-close"
        confirm={{
          label: pending ? '채널 만드는 중' : '채널 만들기',
          onPress: () => void submit(),
          disabled,
          busy: pending,
          testID: 'new-channel-create',
        }}
      />
      <SheetScroll keyboardDismissMode="on-drag" testID="new-channel-body">
        {/* 라벨·입력·규칙(또는 오류) 줄은 한 묶음이다 — 작업 맡기기·내 맥에 보내기의 입력 묶음(`styles.field`)과 같은 문법.
            낱개로 두면 시트 몸의 섹션 간격(16)이 라벨과 입력, 입력과 규칙 줄 사이에도 들어가 규칙 줄이 입력과 다음 섹션의
            한가운데 떠서 어느 쪽 문장인지 위치로 안 갈린다(design-review r2 M2). */}
        <View style={styles.field} testID="new-channel-name-field">
          <GroupLabel>채널 이름</GroupLabel>
          <InputPill
            icon={HOME_ICONS.hash}
            value={name}
            onChangeText={next => {
              setName(next);
              if (failure?.field === 'name') setFailure(null);
            }}
            onBlur={() => setTouched(true)}
            onSubmitEditing={() => void submit()}
            placeholder="product-planning"
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
          {nameMessage ? (
            <Text
              accessibilityLiveRegion="polite"
              style={styles.issue}
              lineBreakStrategyIOS="hangul-word"
              testID="new-channel-name-issue">
              {nameMessage}
            </Text>
          ) : (
            // 「대 / 문자는」처럼 어절 가운데서 갈리지 않게 어절 단위로 접는다(design-review r1a M1·r1c M1).
            <Text
              style={styles.rule}
              lineBreakStrategyIOS="hangul-word"
              testID="new-channel-name-rule">
              {nameRule}
            </Text>
          )}
        </View>

        <GroupCard label="공개 범위" testID="new-channel-kind">
          {KINDS.map(choice => (
            <ChoiceRow
              key={choice.id}
              title={choice.label}
              detail={choice.detail}
              selected={kind === choice.id}
              onPress={() => setKind(choice.id)}
              testID={`new-channel-kind-${choice.id}`}
            />
          ))}
        </GroupCard>

        {failure && failure.field === null ? (
          <FailureBanner
            message={failure.message}
            onRetry={() => void submit()}
            testID="new-channel-error"
          />
        ) : null}
      </SheetScroll>
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 라벨 + 입력 + 규칙·오류 줄 한 묶음(안쪽 간격 `space.sm` — 작업 맡기기·내 맥에 보내기의 `field` 와 같은 값).
    field: {gap: space.sm},
    // 입력 알약 아래의 한 줄 — 섹션 라벨과 같은 안쪽 여백에서 시작한다.
    rule: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.textMuted,
    },
    issue: {
      paddingHorizontal: space.xs,
      fontSize: font.label,
      color: color.dangerText,
    },
  });
