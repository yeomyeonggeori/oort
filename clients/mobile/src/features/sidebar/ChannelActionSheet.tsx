import {
  channelActionClusterTitle,
  channelActionMenuLabel,
  type ChannelActionItem,
  type ChannelActionKey,
} from '@momo/core/features/channels/actionModel';
import {
  CHANNEL_LEAVE_CONFIRM_TITLE,
  CHANNEL_LEAVE_LABEL,
  channelLeaveConfirmBody,
} from '@momo/core/features/channels/model';
import React from 'react';
import {StyleSheet, Text} from 'react-native';
import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {ConfirmStep, GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {font, line, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import type {ChannelRowTarget} from './channelRowActions';

// =============================================================================
// 행을 길게 누르면 열리는 시트 (#4229, Buzz식). 그릇·머리·행은 #4318 의 공용 부품이다.
//
// 항목은 이 파일이 정하지 않는다: 부르는 쪽이 코어 표(`channelRowActionItems`)의 답을 그대로 넘기고,
// 여기는 **그리기만** 한다 — 차례도, 「복사」 제목도, 묶음이 갈리는 자리도 코어가 준
// `cluster`/`separatorBefore` 를 따른다. 그래서 웹 행 메뉴와 같은 문장이 같은 차례로 읽힌다.
// 묶음 하나가 카드 하나이고, 제목이 있는 묶음은 카드 위에 섹션 라벨이 선다.
//
// ## 닫는 길
//
// 머리의 **원형 X**(옛 「닫기」 줄을 이어받아 `channel-sheet-close`), 스크림, 끌어내리기. 내용은 화면의
// 85% 안에서 스크롤하고 X 는 스크롤 밖이라 큰 글씨에서도 닿는다(메시지 시트 M-7 과 같은 이유).
//
// ## 나가기는 이 시트 안에서 확인한다
//
// 되돌릴 길이 없는 일(다시 들어오려면 관리자가 추가해야 한다)이라 한 단계를 더 둔다 — 메시지 시트의
// 지우기 확인과 같은 모양이다. 실패는 확인 단계 **안에서** 말한다(시트를 닫지 않는다).
// =============================================================================

interface Group {
  key: string;
  title: string | undefined;
  items: ChannelActionItem[];
}

/** 코어가 준 차례를 카드 묶음으로 자른다 — 제목이 바뀌거나 `separatorBefore` 면 새 카드다. */
function groupItems(items: ChannelActionItem[]): Group[] {
  const groups: Group[] = [];
  items.forEach((item, index) => {
    const startsCluster = index === 0 || items[index - 1].cluster !== item.cluster;
    if (startsCluster || item.separatorBefore) {
      groups.push({
        key: item.key,
        title: startsCluster ? channelActionClusterTitle(item.cluster) : undefined,
        items: [item],
      });
    } else {
      groups[groups.length - 1].items.push(item);
    }
  });
  return groups;
}

export function ChannelActionSheet({
  target,
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
  target: ChannelRowTarget;
  items: ChannelActionItem[];
  confirmingLeave: boolean;
  isPending: (key: ChannelActionKey) => boolean;
  error: string | null;
  leave: {pending: boolean; error: string | null};
  onRun: (key: ChannelActionKey) => void;
  onConfirmLeave: () => void;
  onCancelLeave: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const isDm = target.channel.kind === 'dm';

  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={channelActionMenuLabel(target.title, target.channel)}
      scrimLabel="대화 액션 닫기"
      scrimTestID="channel-sheet-backdrop"
      testID="channel-action-sheet">
      <SheetHeader
        title={isDm ? target.title : `# ${target.title}`}
        titleTestID="channel-sheet-title"
        closeLabel="대화 액션 닫기"
        closeTestID="channel-sheet-close"
      />
      <SheetScroll testID="channel-sheet-scroll">
        {confirmingLeave ? (
          <ConfirmStep
            testID="channel-leave-confirm"
            headline={CHANNEL_LEAVE_CONFIRM_TITLE}
            detail={channelLeaveConfirmBody(target.title)}
            error={leave.error}
            errorTestID="channel-leave-error"
            confirmLabel={CHANNEL_LEAVE_LABEL}
            pendingLabel="나가는 중…"
            pending={leave.pending}
            onCancel={onCancelLeave}
            onConfirm={onConfirmLeave}
            cancelTestID="channel-leave-cancel"
            confirmTestID="channel-leave-confirm-button"
          />
        ) : (
          <>
            {error !== null ? (
              <Sentence accessibilityRole="alert" style={styles.error} testID="channel-sheet-error">
                {error}
              </Sentence>
            ) : null}
            {groupItems(items).map(group => (
              <GroupCard key={group.key} label={group.title}>
                {group.items.map(item => {
                  const busy = isPending(item.key);
                  return (
                    <ListRow
                      key={item.key}
                      title={busy && item.busyLabel ? item.busyLabel : item.label}
                      leading={item.icon ? <Text accessible={false}>{item.icon}</Text> : undefined}
                      tone={item.tone === 'danger' ? 'danger' : 'default'}
                      busy={busy}
                      // 닫는 길로 보내지 않는다: 이 시트는 왕복 중의 「…하는 중」·「복사됨」·실패를 스스로
                      // 보이는 면이라 행동이 끝날 때까지 떠 있어야 한다(코어 `channelActionKeepsMenuOpen` 이
                      // 같은 이유로 이 항목들을 「열어 둔다」고 정한다).
                      onPress={() => onRun(item.key)}
                      testID={`channel-sheet-${item.testKey}`}
                    />
                  );
                })}
              </GroupCard>
            ))}
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
