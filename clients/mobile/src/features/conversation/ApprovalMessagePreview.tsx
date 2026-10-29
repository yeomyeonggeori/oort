import {
  MESSAGE_PREVIEW_LINK_LABEL,
  type MessagePreview,
} from '@momo/core/features/approvals/messagePreview';
import type {AgentApprovalCard} from '@momo/core/features/timeline/agentCardModel';
import React from 'react';
import {Pressable, StyleSheet, Text} from 'react-native';
import {useStyles} from '../../design/theme';
import {font, line, space, TOUCH_TARGET, type Palette} from '../../design/tokens';

// =============================================================================
// 고정·고정 풀기 승인 카드의 「전문 보기」 (ADR-0186 증보 v5 U-e, #4705)
//
// 카드 행은 서버가 읽은 메시지의 앞 120자와 글자 수를 말한다. 그 앞부분만 보고 누르면 승인하는
// 사람이 자기가 읽지 않은 글을 채널 맨 위에 올리게 되므로, 그 메시지가 있는 자리로 가는 링크
// 하나를 결정 버튼 바로 위에 세운다(웹 `MessagePreviewLink` 와 같은 코어 낱말). 열기는 화면이
// 이미 갖고 있는 앵커 열기(`onOpenMessage`)에 맡긴다. 설명 문장도 글자 수도 더하지 않는다: 글자
// 수는 서버 행이 이미 말한다. 결정이 난 카드에는 서지 않는다(이 문은 결정 전에 읽는 것이다).
//
// 행은 접근성 요소 **하나**라(`MessageRow` 의 `accessible` 뿌리) 이 링크에 VoiceOver 가 닿지
// 못한다. 그래서 같은 조건(`openableMessagePreview`)으로 로터 행동(`MESSAGE_PREVIEW_ACTION_NAME`)이
// 함께 선다 — 승인·거부 로터와 같은 이유다. 열 곳을 모르는 표면(`onOpenMessage` 없음)에는 링크도
// 로터도 서지 않는다: 눌러도 아무 일도 없는 버튼을 두지 않는다.
// =============================================================================

/** 로터 행동의 이름. 라벨은 링크와 같은 낱말(`MESSAGE_PREVIEW_LINK_LABEL`)이다. */
export const MESSAGE_PREVIEW_ACTION_NAME = 'momoOpenMessagePreview';

/**
 * 이 카드가 지금 「전문 보기」를 세워야 하는가. 눈(링크)과 귀(로터)가 같은 답을 읽도록 한 곳에서
 * 정한다. 결정이 나지 않은 카드(`settledStatus === 'pending'`), 서버가 대상 메시지를 실었고
 * (`action.messagePreview`), 열 곳을 아는 표면일 때만 값이다.
 */
export function openableMessagePreview(
  card: AgentApprovalCard,
  settledStatus: string,
  canOpen: boolean,
): MessagePreview | null {
  if (!canOpen || settledStatus !== 'pending') return null;
  return card.action?.messagePreview ?? null;
}

export function ApprovalMessagePreview({
  preview,
  onOpen,
}: {
  preview: MessagePreview;
  onOpen: (channelId: string, messageId: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      onPress={() => onOpen(preview.channelId, preview.messageId)}
      accessibilityRole="link"
      accessibilityLabel={MESSAGE_PREVIEW_LINK_LABEL}
      style={({pressed}) => [styles.link, pressed && styles.pressed]}
      testID="approval-message-preview-link">
      <Text style={styles.linkLabel}>{MESSAGE_PREVIEW_LINK_LABEL}</Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    // 링크 글자는 한 줄이지만 누르는 면은 44 로 선다. 왼쪽 정렬은 사실 행의 글줄과 같다.
    link: {
      minHeight: TOUCH_TARGET,
      alignSelf: 'flex-start',
      justifyContent: 'center',
      marginTop: space.xs,
    },
    linkLabel: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.accentText,
      textDecorationLine: 'underline',
    },
    pressed: {opacity: 0.6},
  });
