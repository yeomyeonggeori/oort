import type {
  ChannelActionItem,
  ChannelActionKey,
} from '@momo/core/features/channels/actionModel';
import {
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  channelLeaveConfirmBody,
} from '@momo/core/features/channels/model';
import type {Channel} from '@momo/core/lib/api';
import React from 'react';
import {StyleSheet} from 'react-native';
import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {ConfirmStep, GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, type Palette} from '../../design/tokens';
import {
  CONVERSATION_DELEGATE_LABEL,
  CONVERSATION_INFO_LABEL,
  conversationMenuAccessibleLabel,
  conversationMenuTitle,
} from './conversationMenu';

// =============================================================================
// 대화 머리 ⋮ 가 여는 시트 (#4319, owner 10-27). 옛 것은 시스템 알림창(제목 + 「취소」 + 「고정한 메시지」)이었다.
// 그릇·머리·행은 #4318 의 공용 부품이고, 모양은 두 행동 시트(메시지 · 대화 행)와 같은 문법이다 — 앞 아이콘 없는 행, 묶음마다 카드 하나.
//
//   카드 1 (이 대화)  대화 정보 · 고정한 메시지 · 작업 맡기기 — 다른 곳으로 가는 문. 행 끝에 ›.
//                     정보는 `onOpenInfo` 가 있을 때만, 작업 맡기기는 일대일 에이전트 DM 에서만 선다. 고정은 늘 선다.
//   카드 2 (알림)     알림 끄기 / 알림 켜기 — 코어 표의 낱말.
//   카드 3 (떠나기)   DM 은 대화 닫기, 채널은 채널 나가기 — 둘은 한 대화에 함께 서지 않는다. 채널 나가기만 위험색이고 확인 단계를 지난다.
//
// ## 닫는 길이 행마다 다르다 (`phone-sheets.md` §2 「행동은 시트가 내려간 뒤에」)
//
// * 첫 카드의 행 셋은 **다른 곳으로 가는 문**이다(정보 화면 · 고정 목록 · 작업 시트) — `closesSheet`: 시트가 먼저 미끄러져 내리고 그 뒤에
//   문이 한 번 열린다. Modal 위에 화면을 쌓지 않는다(§1 규칙 2). 행 끝의 ›(`chevron`)가 그 뜻이다.
// * 알림 · 닫기 · 나가기는 **서버에 닿는 행동**이라 시트가 진행(「알림 끄는 중」)과 실패를 스스로 보여야 한다 — `closesSheet` 가 아니다.
//   성공하면 훅(`useChannelRowActions`)이 시트를 걷고 낭독한다. 실패는 시트가 열린 채 그 자리에서 말한다. DM 닫기·채널 나가기가 성공하면
//   열려 있던 대화도 걷힌다(훅의 `onLeft` → 화면의 뒤로).
//
// ## 항목은 이 파일이 정하지 않는다
//
// 알림 · 닫기 · 나가기는 부르는 쪽이 코어 표의 답(`conversationMenuActionItems`)을 그대로 넘기고 여기는 **그리기만** 한다 — 내밀지 말지(`canLeaveChannel`·
// `dmCloseOffered`)도, 낱말도, 위험색도 코어의 것이다. 「채널 나가기」만 확인 단계를 지난다(되돌릴 길이 없다 — 다시 들어오려면 관리자가 추가해야
// 한다). 「대화 닫기」는 되돌릴 수 있어(닫은 대화 목록·새 메시지) 확인 단계도 위험색도 없다(코어 표가 그렇게 답한다).
// =============================================================================

export function ConversationMenuSheet({
  title,
  kind,
  pinLabel,
  onOpenPins,
  onOpenInfo,
  onDelegateWork,
  items,
  confirmingLeave,
  isPending,
  error,
  leave,
  onRun,
  onConfirmLeave,
  onCancelLeave,
  onClose,
}: {
  /** 대화의 이름 — DM 은 상대 이름, 채널은 `#` 없는 이름(머리의 `# ` 는 여기서 붙인다). */
  title: string;
  /** 종류. 채널 목록이 오기 전에는 `undefined` — 머리는 이름만 말하고 정보 행은 서지 않는다. */
  kind: Channel['kind'] | undefined;
  /** 「고정한 메시지」 행의 낱말 — 코어 `pinListHeaderLabel(개수, 상태)` 의 답. */
  pinLabel: string;
  onOpenPins: () => void;
  /**
   * 「대화 정보 / 채널 정보」 문. **정보 화면을 가진 호출자만 준다** — 주지 않으면 행이 서지 않는다(눌러도 아무 일도 없는 행은 없다).
   * 종류를 모르는 동안에도 서지 않는다(무엇이라 부를지 모른다).
   */
  onOpenInfo?: () => void;
  /** 「작업 맡기기」 문. 일대일 에이전트 DM 에서만 준다. */
  onDelegateWork?: () => void;
  /** 코어 표의 알림 · 닫기 · 나가기(`conversationMenuActionItems`). 채널을 아직 모르면 비어 있다. */
  items: readonly ChannelActionItem[];
  confirmingLeave: boolean;
  isPending: (key: ChannelActionKey) => boolean;
  /** 알림·닫기가 서버에서 거절됐을 때 그 자리에서 하는 말(토스트가 아니다). */
  error: string | null;
  leave: {pending: boolean; error: string | null};
  onRun: (key: ChannelActionKey) => void;
  onConfirmLeave: () => void;
  onCancelLeave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const infoLabel = kind === 'dm' ? CONVERSATION_INFO_LABEL.dm : CONVERSATION_INFO_LABEL.channel;
  const mute = items.find(item => item.key === 'mute');
  // DM 은 「대화 닫기」, 채널은 「채널 나가기」 — 코어 표가 한 대화에 둘을 함께 내지 않는다(`isDm`).
  const leaving = items.find(item => item.key === 'close-dm' || item.key === 'leave');

  const actionRow = (item: ChannelActionItem): React.JSX.Element => {
    const busy = isPending(item.key);
    return (
      <ListRow
        title={busy && item.busyLabel ? item.busyLabel : item.label}
        tone={item.tone === 'danger' ? 'danger' : 'default'}
        busy={busy}
        // 닫는 길로 보내지 않는다: 이 시트는 왕복 중의 「…하는 중」과 실패를 스스로 보이는 면이라 행동이 끝날 때까지 떠 있어야 한다.
        onPress={() => onRun(item.key)}
        testID={`conversation-menu-${item.testKey}`}
      />
    );
  };

  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={conversationMenuAccessibleLabel(title, kind)}
      scrimLabel="대화 메뉴 닫기"
      scrimTestID="conversation-menu-backdrop"
      testID="conversation-menu-sheet">
      <SheetHeader
        title={conversationMenuTitle(title, kind)}
        titleTestID="conversation-menu-title"
        closeLabel="대화 메뉴 닫기"
        closeTestID="conversation-menu-close"
      />
      <SheetScroll testID="conversation-menu-scroll">
        {confirmingLeave ? (
          <ConfirmStep
            testID="conversation-menu-leave-confirm"
            headline={CHANNEL_LEAVE_CONFIRM_TITLE}
            detail={channelLeaveConfirmBody(title)}
            error={leave.error}
            errorTestID="conversation-menu-leave-error"
            confirmLabel={CHANNEL_LEAVE_LABEL}
            pendingLabel="나가는 중…"
            pending={leave.pending}
            onCancel={onCancelLeave}
            onConfirm={onConfirmLeave}
            cancelTestID="conversation-menu-leave-cancel"
            confirmTestID="conversation-menu-leave-confirm-button"
          />
        ) : (
          <>
            {error !== null ? (
              <Sentence
                accessibilityRole="alert"
                style={styles.error}
                testID="conversation-menu-error">
                {error}
              </Sentence>
            ) : null}
            <GroupCard testID="conversation-menu-doors">
              {onOpenInfo !== undefined && kind !== undefined ? (
                <ListRow
                  title={infoLabel}
                  accessory="chevron"
                  accessibilityHint={`${infoLabel}를 엽니다.`}
                  onPress={onOpenInfo}
                  closesSheet
                  testID="conversation-menu-info"
                />
              ) : null}
              <ListRow
                title={pinLabel}
                accessory="chevron"
                accessibilityHint="고정한 메시지 목록을 엽니다."
                onPress={onOpenPins}
                closesSheet
                testID="conversation-menu-pins"
              />
              {onDelegateWork !== undefined ? (
                <ListRow
                  title={CONVERSATION_DELEGATE_LABEL}
                  accessory="chevron"
                  accessibilityHint="작업을 맡기는 시트를 엽니다."
                  onPress={onDelegateWork}
                  closesSheet
                  testID="conversation-menu-delegate"
                />
              ) : null}
            </GroupCard>
            {mute !== undefined ? <GroupCard>{actionRow(mute)}</GroupCard> : null}
            {leaving !== undefined ? <GroupCard>{actionRow(leaving)}</GroupCard> : null}
          </>
        )}
      </SheetScroll>
    </PageSheet>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    error: {fontSize: font.label, color: color.danger, lineHeight: line.label},
  });
