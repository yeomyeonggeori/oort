import React, {useCallback, useState} from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {sendMessage} from '@momo/core/lib/api';
import {
  canDelegate,
  delegateButtonLabel,
  delegateMessageBody,
  delegateSentLine,
  type TeamAiDelegate,
  type TeamAiDelegateCandidate,
} from '@momo/core/features/timeline/teamAi';
import {font, line, radius, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {Sentence} from '../../design/atoms';
import {usePalette, useStyles} from '../../design/theme';

// =============================================================================
// 도우미가 넘기는 줄 아래의 「○○에게 맡기기」 — 폰 (ADR-0201 D5, #3836).
//
// 판정은 웹과 같은 코어(`teamAi.ts`)가 한다: 이유 한 줄, 요청자 본인에게만 버튼, 서버가
// 정한 멱등 키, 도우미 멘션을 지운 `@대상 원래 요청` 본문. 렌더만 폰 고유다.
// 워크스페이스를 모르는 표면(측정 하네스)에서는 버튼을 세우지 않는다.
//
// **보내기 상태는 행이 든다** (#3844 design-review H-1). 메시지 행은 접근성 원소
// 하나라서(`MessageRow` 의 `accessible` 뿌리) 이 띠의 버튼에 VoiceOver 가 닿지 못한다.
// 행 안의 다른 컨트롤처럼 로터에 「○○에게 맡기기」를 등재해야 하고, 그러려면 손가락과
// 로터가 **같은** 보내기 함수와 상태를 써야 한다. 그래서 상태는 `useTeamAiDelegateSend`
// 가 행에서 갖고, 이 띠는 그것을 그리기만 한다. 결과는 소리로도 한 번 말한다: 행이 한
// 원소라 바뀐 한 줄로 초점이 가지 않는다.
// =============================================================================

export type TeamAiDelegateSendState =
  | {kind: 'idle'}
  | {kind: 'sending'; memberId: string}
  | {kind: 'sent'; name: string}
  | {kind: 'error'};

const SEND_ERROR_LINE = '보내지 못했어요. 연결을 확인하고 다시 눌러 주세요.';
const OFFLINE_LINE = '연결이 끊겨 지금은 맡길 수 없어요.';

export interface TeamAiDelegateSend {
  /** 이 사람에게 버튼(과 로터 행동)을 세우는가. */
  showButtons: boolean;
  state: TeamAiDelegateSendState;
  /** 지금 누를 수 있는 후보. 보냈거나 보내는 중이거나 오프라인이면 비어 있다. */
  pressable: readonly TeamAiDelegateCandidate[];
  press: (candidate: TeamAiDelegateCandidate) => void;
}

export function useTeamAiDelegateSend({
  delegate,
  workspaceId,
  channelId,
  viewerMemberId,
  sourceBody,
  teamAiHandle,
  offline,
}: {
  delegate: TeamAiDelegate | null;
  workspaceId: string | undefined;
  channelId: string;
  viewerMemberId: string | undefined;
  sourceBody: string | null;
  teamAiHandle: string | null;
  offline: boolean;
}): TeamAiDelegateSend {
  const [state, setState] = useState<TeamAiDelegateSendState>({kind: 'idle'});
  const showButtons =
    delegate !== null &&
    workspaceId !== undefined &&
    canDelegate(delegate, viewerMemberId);

  const press = useCallback(
    (candidate: TeamAiDelegateCandidate) => {
      if (
        delegate === null ||
        workspaceId === undefined ||
        offline ||
        state.kind === 'sending' ||
        state.kind === 'sent'
      ) {
        return;
      }
      setState({kind: 'sending', memberId: candidate.memberId});
      const body = delegateMessageBody({
        targetHandle: candidate.handle,
        sourceBody,
        teamAiHandles: teamAiHandle !== null ? [teamAiHandle] : [],
      });
      sendMessage(
        workspaceId,
        channelId,
        candidate.clientMsgId,
        body,
        delegate.sourceMessageId !== null
          ? {replyToId: delegate.sourceMessageId}
          : undefined,
      )
        .then(() => {
          setState({kind: 'sent', name: candidate.displayName});
          AccessibilityInfo.announceForAccessibility(
            delegateSentLine(candidate.displayName),
          );
        })
        .catch(() => {
          setState({kind: 'error'});
          AccessibilityInfo.announceForAccessibility(SEND_ERROR_LINE);
        });
    },
    [delegate, workspaceId, channelId, offline, state.kind, sourceBody, teamAiHandle],
  );

  const pressable =
    showButtons && delegate !== null && !offline &&
    state.kind !== 'sending' && state.kind !== 'sent'
      ? delegate.candidates
      : [];
  return {showButtons, state, pressable, press};
}

/** 로터 행동의 이름. 후보의 순서로 짓는다(멤버 id 를 행동 이름에 싣지 않는다). */
export const TEAM_AI_DELEGATE_ACTION_PREFIX = 'momoDelegate:';

export function TeamAiDelegateStrip({
  delegate,
  send,
  offline,
}: {
  delegate: TeamAiDelegate;
  send: TeamAiDelegateSend;
  offline: boolean;
}): React.JSX.Element | null {
  const styles = useStyles(build);
  const palette = usePalette();
  const {showButtons, state, press} = send;
  if (delegate.reasonLine === null && !showButtons) return null;

  return (
    <View style={styles.wrap} testID="team-ai-delegate">
      {delegate.reasonLine !== null ? (
        <Sentence style={styles.meta} testID="team-ai-delegate-reason">
          {delegate.reasonLine}
        </Sentence>
      ) : null}
      {showButtons && state.kind === 'sent' ? (
        <Sentence style={styles.meta} testID="team-ai-delegate-sent">
          {delegateSentLine(state.name)}
        </Sentence>
      ) : null}
      {showButtons && state.kind !== 'sent' ? (
        <View style={styles.buttons}>
          {delegate.candidates.map(candidate => {
            const sending =
              state.kind === 'sending' && state.memberId === candidate.memberId;
            const blocked = offline || state.kind === 'sending';
            return (
              <Pressable
                key={candidate.memberId}
                accessibilityRole="button"
                accessibilityState={{disabled: blocked, busy: sending}}
                onPress={() => press(candidate)}
                testID="team-ai-delegate-button"
                style={({pressed}) => [
                  styles.pill,
                  offline && styles.dim,
                  pressed && !blocked && styles.pressed,
                ]}>
                {sending ? (
                  <ActivityIndicator size="small" color={palette.textMuted} />
                ) : null}
                <Text style={styles.pillLabel}>
                  {delegateButtonLabel(candidate)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {showButtons && offline && state.kind !== 'sent' ? (
        <Sentence style={styles.meta}>{OFFLINE_LINE}</Sentence>
      ) : null}
      {showButtons && state.kind === 'error' ? (
        <Sentence style={styles.error} testID="team-ai-delegate-error">
          {SEND_ERROR_LINE}
        </Sentence>
      ) : null}
    </View>
  );
}

/**
 * 행의 낭독 라벨 뒤에 붙일 이 띠의 문장들. 행이 원소 하나라 띠의 글이 따로 읽히지
 * 않는다. 보인 것과 같은 글자를 같은 순서로 말한다.
 */
export function teamAiDelegateSpoken(
  delegate: TeamAiDelegate | null,
  send: TeamAiDelegateSend,
  offline: boolean,
): string[] {
  if (delegate === null) return [];
  const parts: string[] = [];
  if (delegate.reasonLine !== null) parts.push(delegate.reasonLine);
  if (send.showButtons) {
    if (send.state.kind === 'sent') parts.push(delegateSentLine(send.state.name));
    else if (offline) parts.push(OFFLINE_LINE);
    if (send.state.kind === 'error') parts.push(SEND_ERROR_LINE);
  }
  return parts;
}

function build(color: Palette) {
  return StyleSheet.create({
    wrap: {marginTop: space.xs, gap: space.sm},
    meta: {fontSize: font.meta, lineHeight: line.meta, color: color.textMuted},
    error: {fontSize: font.meta, lineHeight: line.meta, color: color.danger},
    buttons: {flexDirection: 'row', flexWrap: 'wrap', gap: space.sm},
    /** 웹 `Button variant="secondary"` 의 폰 번역: 채움 알약, 테두리 없음(ADR-0189 D6). */
    pill: {
      minHeight: TOUCH_TARGET,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.xs,
      paddingHorizontal: space.md,
      borderRadius: radius.pill,
      backgroundColor: color.surfaceMuted,
    },
    pillLabel: {fontSize: font.label, fontWeight: '600', color: color.text},
    dim: {opacity: 0.5},
    pressed: {opacity: 0.6},
  });
}
