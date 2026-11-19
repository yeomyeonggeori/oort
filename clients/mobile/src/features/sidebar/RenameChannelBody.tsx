import {
  CHANNEL_CREATE_FAILURE_KEYS,
  CHANNEL_NAME_ISSUE_KEYS,
  CHANNEL_NAME_MAX,
  CHANNEL_NAME_SERVER_REJECTED_KEY,
  channelNameIssue,
  normalizeChannelName,
  type ChannelNameIssue,
} from '@momo/core/features/channels/model';
import type {ChannelRenameFailure} from '@momo/core/features/channels/rename';
import {NetworkError} from '@momo/core/lib/http';
import React, {useState} from 'react';
import {StyleSheet, View} from 'react-native';
import {HOME_ICONS} from '../../design/icons';
import {SheetHeader} from '../../design/SheetChrome';
import {GroupLabel, InputPill, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {space} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {ChannelNameStatus} from './ChannelNameStatus';

// =============================================================================
// 「이름 바꾸기」 단계 (ADR-0225 D10 · D13, #5835). 채널 행 시트와 대화 ⋮ 시트가 같은 이 몸을 쓴다 — 시트 안에서 메뉴 대신 서는 단계이고
// (나가기 확인 단계와 같은 관례), 머리는 이 단계의 것이다: **✓ = 바꾸기**(이름이 그대로거나 거절이면 흐림), **원형 X = 닫기**(보내는 중에는
// 흐려지고 잠김으로 읽힌다 — #5903). 이름 칸은 새 채널 시트와 같은 사전 키 · 같은 줄 약속(`ChannelNameStatus`)이다: 칸은 친 그대로,
// 친 것과 저장될 이름이 다를 때만 「#… 이름으로 바뀌어요」, 거절은 같은 자리, 높이는 예약.
// =============================================================================

export function RenameChannelBody({
  current,
  pending,
  failure,
  onSubmit,
  onEdit,
  testIDPrefix,
}: {
  /** 지금 이름(칸의 처음 값). */
  current: string;
  pending: boolean;
  /** 서버가 한 말. 이름을 고치면 `onEdit` 이 지운다. */
  failure: ChannelRenameFailure | null;
  /** 접은 이름으로 보낸다. */
  onSubmit: (name: string) => void;
  onEdit: () => void;
  testIDPrefix: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const [name, setName] = useState(current);

  const issue = channelNameIssue(name);
  const issueText = (which: ChannelNameIssue): string =>
    which === 'tooLong'
      ? formatMessage(CHANNEL_NAME_ISSUE_KEYS.tooLong, {max: CHANNEL_NAME_MAX})
      : formatMessage(CHANNEL_NAME_ISSUE_KEYS[which]);
  const failureText = failure === null ? null : formatMessage(failure.key, failure.values as never);
  // 빈칸뿐인 칸에는 아직 말하지 않는다(웹과 같은 기준). 서버의 말은 이름을 고칠 때까지 선다.
  const issueMessage = issue !== null && name.trim() !== '' ? issueText(issue) : null;
  const nameMessage = failureText ?? issueMessage;
  const hint = formatMessage('channels.nameRule.hint', {max: CHANNEL_NAME_MAX});
  const saved = issue === null ? normalizeChannelName(name) : null;
  const preview =
    nameMessage === null && saved !== null && saved !== name
      ? formatMessage('channels.rename.preview', {name: `#${saved}`})
      : null;
  const reserve = [
    hint,
    ...(Object.keys(CHANNEL_NAME_ISSUE_KEYS) as ChannelNameIssue[]).map(issueText),
    formatMessage(CHANNEL_NAME_SERVER_REJECTED_KEY),
    formatMessage(CHANNEL_CREATE_FAILURE_KEYS.duplicate),
    formatMessage(CHANNEL_CREATE_FAILURE_KEYS.rateLimited),
    formatMessage('channels.rename.generalLocked'),
    formatMessage('channels.rename.notFound'),
    formatMessage('channels.rename.forbidden'),
    formatMessage('channels.rename.generic'),
    formatMessage('channels.rename.network', {reason: new NetworkError('timeout', 15_000).message}),
    ...(failureText === null ? [] : [failureText]),
  ].filter((text, at, all) => all.indexOf(text) === at);

  const unchanged = saved !== null && saved === current;
  const blocked = pending || issue !== null || unchanged;
  const submit = () => {
    if (blocked || saved === null) return;
    onSubmit(saved);
  };

  return (
    <>
      <SheetHeader
        title={formatMessage('channels.rename.title')}
        closeLabel={formatMessage('channels.browse.close')}
        closeDisabled={pending}
        closeTestID={`${testIDPrefix}-close`}
        confirm={{
          label: pending ? formatMessage('channels.rename.busy') : formatMessage('channels.rename.submit'),
          onPress: submit,
          disabled: blocked,
          busy: pending,
          testID: `${testIDPrefix}-submit`,
        }}
      />
      <SheetScroll keyboardDismissMode="on-drag" testID={`${testIDPrefix}-body`}>
        <View style={styles.field} testID={`${testIDPrefix}-field`}>
          <GroupLabel>{formatMessage('channels.rename.fieldLabel')}</GroupLabel>
          <InputPill
            icon={HOME_ICONS.hash}
            value={name}
            onChangeText={next => {
              setName(next);
              onEdit();
            }}
            onSubmitEditing={submit}
            placeholder={formatMessage('channels.nameRule.placeholder')}
            autoCapitalize="none"
            autoCorrect={false}
            autoFocus
            selectTextOnFocus
            returnKeyType="done"
            editable={!pending}
            accessibilityLabel={formatMessage('channels.rename.aria', {name: current})}
            // VoiceOver 도 같은 줄을 듣는다: 어기면 그 이유 > 저장될 이름 > 평소엔 안내.
            accessibilityHint={nameMessage ?? preview ?? hint}
            testID={`${testIDPrefix}-name`}
          />
          <ChannelNameStatus
            error={nameMessage}
            preview={preview}
            hint={hint}
            reserve={reserve}
            testIDPrefix={`${testIDPrefix}-name`}
          />
        </View>
      </SheetScroll>
    </>
  );
}

// 라벨 + 입력 + 규칙·오류 줄 한 묶음(안쪽 간격 `space.sm` — 새 채널 시트의 `field` 와 같은 값).
const buildStyles = () => StyleSheet.create({field: {gap: space.sm}});
