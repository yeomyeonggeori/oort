import {createChannel, type Channel, type RosterMember} from '@momo/core/lib/api';
import {
  channelNameIssue,
  CHANNEL_CREATE_FAILURE_KEYS,
  CHANNEL_NAME_MAX,
  CHANNEL_NAME_ISSUE_KEYS,
  CHANNEL_NAME_SERVER_REJECTED_KEY,
  createChannelFailure,
  normalizeChannelName,
  type ChannelNameIssue,
  type CreateChannelFailure,
} from '@momo/core/features/channels/model';
import {withChannelMemberAdded} from '@momo/core/features/channels/memberAdd';
import {upsertChannel} from '@momo/core/features/directory/model';
import {useQueryClient} from '@tanstack/react-query';
import React, {useRef, useState} from 'react';
import {
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
  type NativeSyntheticEvent,
  type StyleProp,
  type TextLayoutEventData,
  type TextStyle,
} from 'react-native';

import {FailureBanner} from '../design/atoms';
import {HOME_ICONS} from '../design/icons';
import {
  PageSheet,
  usePageSheetClose,
  usePageSheetGone,
  usePageSheetHandoff,
} from '../design/PageSheet';
import {SheetHeader} from '../design/SheetChrome';
import {ChoiceRow, GroupCard, GroupLabel, InputPill, SheetScroll} from '../design/sheetParts';
import {useStyles} from '../design/theme';
import {font, space, type Palette} from '../design/tokens';
import {
  newChannelDraftKey,
  useHoldDraftOnEntry,
  useRestoredEntryDraft,
} from '../lib/entryDrafts';
import {workspaceKeys} from '../features/workspace/queries';
import {useFormatMessage} from '../i18n/useFormatMessage';
import {useSession} from '../session/useSession';
import type {ChannelMemberAddTarget} from './ChannelMemberAddSheet';

// =============================================================================
// 새 채널 시트 — + 메뉴의 「새 채널」 (DS2-2b #2750).
//
// 폰에는 채널을 만드는 문이 없었다(홈 빈 상태가 「데스크톱에서 할 수 있습니다」라고
// 말했다). + 메뉴가 Buzz 처럼 「새 채널」을 들면서, 이름을 짓는 무거운 일은 이
// 시트로 넘어온다.
//
// 규칙은 모두 core 의 것이다 — 웹 「채널 만들기」 다이얼로그와 한 문장을 쓴다:
//   이름 규칙       `channelNameIssue` · `normalizeChannelName` (모든 언어의 글자·숫자, ADR-0225)
//   문장            사전 키 — 안내·자리표시자·미리보기 `channels.nameRule.*`, 거절 `channelNameIssueKey`, 실패 `messageKey`(웹과 같은 키·같은 말, #5834)
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

interface NewChannelDraft {
  name: string;
  kind: 'public' | 'private';
}

// 설명은 웹 「채널 만들기」와 같은 사전 키다(#5784). 공개 채널을 「찾아서 들어오는」 길은 아직 없어서, 지금 동작(소유자·관리자가
// 추가, 앞으로 워크스페이스에 들어오는 사람은 자동)을 그대로 말한다.
const KINDS = [
  {
    id: 'public' as const,
    label: '공개',
    detailKey: 'timeline.createChannel.publicDetail' as const,
  },
  {
    id: 'private' as const,
    label: '비공개',
    detailKey: 'timeline.createChannel.privateDetail' as const,
  },
];

export function NewChannelSheet({
  onOpenConversation,
  onCreated,
  onClose,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
  /**
   * 채널을 만들었다 — 셸이 「멤버 추가」 시트를 잇는다(#5784). 공개·비공개 모두다: 지금은 공개도 만든 사람 한 명으로 시작하고,
   * 폰에는 이 시트 말고 채널에 사람을 넣는 문이 없다.
   */
  onCreated?: (target: ChannelMemberAddTarget) => void;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet
      height="medium"
      onClose={onClose}
      accessibilityLabel="새 채널"
      scrimLabel="새 채널 닫기"
      testID="new-channel-sheet">
      <SheetBody
        onOpenConversation={onOpenConversation}
        onCreated={onCreated}
        onClose={onClose}
      />
    </PageSheet>
  );
}

function SheetBody({
  onOpenConversation,
  onCreated,
  onClose,
}: {
  onOpenConversation: (channelId: string, title: string) => void;
  onCreated?: (target: ChannelMemberAddTarget) => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const {member, workspaceId} = useSession();
  const client = useQueryClient();
  const slideClose = usePageSheetClose() ?? onClose;
  const sheetGone = usePageSheetGone();
  // 「멤버 추가」는 **다른 Modal** 이다 — 이 시트의 Modal 이 iOS 에서 다 내려간 뒤에 세운다(#5417, `PageSheet` 머리말). 한 화면 갱신에 이 시트의
  // 언마운트와 멤버 추가 시트의 마운트가 겹치면 iOS 가 뒤의 제시를 거절해 시트가 영영 안 뜬다(검수 r1 B1, 시뮬레이터 4/4).
  const afterDismissed = usePageSheetHandoff();
  // 알림이 걷어 간 시트였다면 쓰던 이름과 공개 범위로 선다(#4667). 사람이 X 로 닫은 시트는 평소처럼 빈 채로 선다. 자리는 워크스페이스로
  // 묶인다(`lib/entryDrafts.ts`) — 다른 사람이 같은 기기로 로그인해도 앞 사람의 이름이 나타나지 않는다.
  const draftKey = newChannelDraftKey(workspaceId);
  const restored = useRestoredEntryDraft<NewChannelDraft>(draftKey);
  const [name, setName] = useState(restored?.name ?? '');
  const [kind, setKind] = useState<'public' | 'private'>(restored?.kind ?? 'public');
  const [touched, setTouched] = useState(false);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<CreateChannelFailure | null>(null);

  const issue = channelNameIssue(name);
  const issueText = (which: ChannelNameIssue): string =>
    which === 'tooLong'
      ? formatMessage(CHANNEL_NAME_ISSUE_KEYS.tooLong, {max: CHANNEL_NAME_MAX})
      : formatMessage(CHANNEL_NAME_ISSUE_KEYS[which]);
  // 거절 문장은 사전 키로 화면 언어를 따른다(400·409·403·429). 키가 없는 실패(망·알 수 없음)만 코어가 준 문장 그대로다(#5906 몫).
  const failureText = (f: CreateChannelFailure): string =>
    f.messageKey !== undefined ? formatMessage(f.messageKey) : f.message;
  // 빈 칸은 아직 말하지 않는다 — 열자마자 「입력하세요」가 서면 꾸중부터 듣는다. 빈칸뿐인 칸도 같다(웹과 같은 기준).
  const issueMessage = issue && (touched || name.trim() !== '') ? issueText(issue) : null;
  const nameMessage = failure?.field === 'name' ? failureText(failure) : issueMessage;
  // 안내는 처음부터 칸 밑에 선다 — 웹 다이얼로그와 같은 자리, 같은 말이다(design-review M4). 규칙을 어기거나 서버가 거절하면 같은 자리가 그 이유로
  // 바뀌고, 친 것과 저장될 이름이 다르면 「#디자인-리뷰 이름으로 만들어져요」가 선다(ADR-0225 D13). 칸의 값은 어느 때도 바꾸지 않는다.
  const nameRule = formatMessage('channels.nameRule.hint', {max: CHANNEL_NAME_MAX});
  const savedName = issue === null ? normalizeChannelName(name) : null;
  const namePreview =
    nameMessage === null && savedName !== null && savedName !== name
      ? formatMessage('channels.nameRule.preview', {name: `#${savedName}`})
      : null;
  // 이 자리에 설 수 있는 모든 문장 — 안 서 있는 문장도 보이지 않게 같은 폭으로 깔려 가장 큰 높이가 자리의 높이를 정한다(미리보기는 안내와 같은 줄 수 안에서 접는다).
  const nameReserve = [
    nameRule,
    ...(Object.keys(CHANNEL_NAME_ISSUE_KEYS) as ChannelNameIssue[]).map(issueText),
    formatMessage(CHANNEL_NAME_SERVER_REJECTED_KEY),
    formatMessage(CHANNEL_CREATE_FAILURE_KEYS.duplicate),
  ].filter((text, at, all) => all.indexOf(text) === at);

  const submit = async () => {
    setTouched(true);
    if (issue || pending) return;
    setPending(true);
    setFailure(null);
    // 「멤버 추가」로 넘겼는가. 넘긴 뒤 시트는 내려가는 동안 「만드는 중」 그대로 둔다 — ✓ 가 다시 눌리지 않고, 그 사이 알림이
    // 착지해도 이미 만든 채널 이름을 초안으로 맡기지 않는다(`useHoldDraftOnEntry` 는 `pending` 이면 맡기지 않는다).
    let handedOff = false;
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
      // 만든 사람은 서버에서 이미 멤버다 — 명부의 내 `channelIds` 에도 먼저 넣고 다시 읽는다(웹 `useCreateChannel` 과 같은 이유,
      // #5784). 이어 뜨는 「멤버 추가」 시트와 채널 멤버 수가 다음 명부 읽기를 기다리지 않는다.
      client.setQueryData<RosterMember[]>(workspaceKeys.roster(workspaceId), current =>
        current ? withChannelMemberAdded(current, created.channel.id, member.id) : current,
      );
      void client.invalidateQueries({queryKey: workspaceKeys.roster(workspaceId)});
      // 만드는 동안 시트가 걷혔으면(알림이 착지했거나 사람이 X 로 닫았다) 채널은 만들어졌고 목록에는 들어갔다 — 여기까지다.
      // 요청이 끝났다고 사람을 새 채널로 끌고 가면 알림이 세운 목적지를 덮고, 늦은 `onClose()` 는 그 사이 사람이 새로 연
      // 시트를 닫는다(#5058). 닫히는 슬라이드가 도는 동안도 걷힌 것으로 센다. 「멤버 추가」도 잇지 않는다.
      if (sheetGone()) return;
      const title = created.channel.name ?? normalizeChannelName(name);
      if (onCreated) {
        // 채널은 만든 사람 한 명으로 시작한다(공개도 지금은 누군가 추가해야 들어온다) — 새 채널 안에서 「멤버 추가」 시트를 잇는다
        // (X 가 건너뛰기). `onClose` 는 넘겨주기가 부른다: 다 내려간 뒤 `onClose` -> 새 채널로 -> 멤버 추가 시트.
        handedOff = true;
        const target: ChannelMemberAddTarget = {
          id: created.channel.id,
          name: title,
          kind: created.channel.kind === 'private' ? 'private' : 'public',
        };
        afterDismissed(() => {
          onOpenConversation(target.id, title);
          onCreated(target);
        });
        return;
      }
      onClose();
      onOpenConversation(created.channel.id, title);
    } catch (error) {
      setFailure(createChannelFailure(error));
    } finally {
      if (!handedOff) setPending(false);
    }
  };

  const disabled = pending || issue !== null;
  // 이름을 쓰던 중에 알림이 이 시트를 걷어도 그 이름은 남는다(#4667). 만드는 중(`pending`)은 곧 끝나는 일이라 맡기지 않는다.
  useHoldDraftOnEntry<NewChannelDraft>(draftKey, () =>
    !pending && name !== '' ? {name, kind} : undefined,
  );

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
            placeholder={formatMessage('channels.nameRule.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            returnKeyType="done"
            editable={!pending}
            accessibilityLabel="채널 이름"
            // VoiceOver 도 같은 줄을 듣는다: 어기면 그 이유 > 저장될 이름 > 평소엔 안내.
            accessibilityHint={nameMessage ?? namePreview ?? nameRule}
            testID="new-channel-name"
          />
          <NameStatus
            error={nameMessage}
            preview={namePreview}
            hint={nameRule}
            reserve={nameReserve}
            ruleStyle={styles.rule}
            issueStyle={styles.issue}
          />
        </View>

        <GroupCard label="공개 범위" testID="new-channel-kind">
          {KINDS.map(choice => (
            <ChoiceRow
              key={choice.id}
              title={choice.label}
              detail={formatMessage(choice.detailKey)}
              // 설명은 화면에만 있지 않다 — VoiceOver 도 「공개」 뒤에 같은 문장을 듣는다(검수 r1 M7).
              accessibilityHint={formatMessage(choice.detailKey)}
              selected={kind === choice.id}
              onPress={() => setKind(choice.id)}
              testID={`new-channel-kind-${choice.id}`}
            />
          ))}
        </GroupCard>

        {failure && failure.field === null ? (
          <FailureBanner
            message={failureText(failure)}
            retryLabel={formatMessage('connection.action.retry')}
            onRetry={() => void submit()}
            testID="new-channel-error"
          />
        ) : null}
      </SheetScroll>
    </>
  );
}

/**
 * 칸 아래 한 줄: 거절 문장 · 저장될 이름 · 안내 가운데 **하나만** 선다(위에서부터). 서는 자리는 하나이고, 서지 않은 문장들이 같은 폭으로 보이지 않게
 * 깔려 가장 큰 높이를 자리의 최소 높이로 삼는다 — 줄이 서고 걷혀도 아래 공개 범위 카드와 머리 단추가 움직이지 않는다(웹 `NameStatus` 와 같은 약속, #5833).
 * 실제로 화면이 꺾은 높이를 `onLayout` 으로 읽는다(줄 수를 어림하지 않는다). 미리보기는 예약된 줄 수 안에서 접는다 — 80자 이름이 시트를 밀지 않는다.
 * 「대 / 문자는」처럼 어절 가운데서 갈리지 않게 어절 단위로 접는다(design-review r1a M1·r1c M1).
 */
function NameStatus({
  error,
  preview,
  hint,
  reserve,
  ruleStyle,
  issueStyle,
}: {
  error: string | null;
  preview: string | null;
  hint: string;
  reserve: readonly string[];
  ruleStyle: StyleProp<TextStyle>;
  issueStyle: StyleProp<TextStyle>;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const heights = useRef<Record<number, number>>({});
  const lineCounts = useRef<Record<number, number>>({});
  const [reserved, setReserved] = useState(0);
  const [lines, setLines] = useState<number | undefined>(undefined);
  const onReserveLayout = (index: number) => (event: LayoutChangeEvent) => {
    heights.current[index] = event.nativeEvent.layout.height;
    const tallest = Math.max(0, ...Object.values(heights.current));
    setReserved(prev => (prev === tallest ? prev : tallest));
  };
  // 줄 수는 높이를 줄 높이로 나눠 어림하지 않고 화면이 꺾은 줄 수를 그대로 쓴다 — 가장 큰 접근성 글자에서는 줄 높이가 토큰(18)보다 커서 어림이 틀린다.
  const onReserveText = (index: number) => (event: NativeSyntheticEvent<TextLayoutEventData>) => {
    lineCounts.current[index] = event.nativeEvent.lines.length;
    const most = Math.max(1, ...Object.values(lineCounts.current));
    setLines(prev => (prev === most ? prev : most));
  };
  const shown = error ?? preview ?? hint;
  const kind = error !== null ? 'issue' : preview !== null ? 'preview' : 'rule';
  return (
    <View>
      <Text
        accessibilityLiveRegion={kind === 'issue' ? 'polite' : 'none'}
        style={[kind === 'issue' ? issueStyle : ruleStyle, reserved > 0 && {minHeight: reserved}]}
        lineBreakStrategyIOS="hangul-word"
        numberOfLines={kind === 'preview' ? lines : undefined}
        testID={`new-channel-name-${kind}`}>
        {shown}
      </Text>
      {reserve.map((candidate, index) => (
        <Text
          key={index}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          pointerEvents="none"
          onLayout={onReserveLayout(index)}
          onTextLayout={onReserveText(index)}
          style={[ruleStyle, styles.reserveCopy]}
          lineBreakStrategyIOS="hangul-word"
          testID={`new-channel-name-reserve-${index}`}>
          {candidate}
        </Text>
      ))}
    </View>
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
    // 높이만 재는 숨은 사본 — 같은 폭의 겹친 층이라 레이아웃 높이를 더하지 않는다.
    reserveCopy: {position: 'absolute', top: 0, left: 0, right: 0, opacity: 0},
  });
