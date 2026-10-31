import React, {useState} from 'react';
import {StyleSheet, Text, View} from 'react-native';

import {Sentence} from '../../design/atoms';
import {PageSheet} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {ConfirmStep, GroupCard, ListRow, SheetScroll} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {font, line, SHEET, space, type Palette} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import type {LinkCardTarget} from './UnfurlCards';

// =============================================================================
// 링크 카드를 길게 누르면 서는 시트 (#4883). 「메시지 액션」 시트(`MessageActionSheet`)와 같은 문법이다 —
// `PageSheet`(내용 맞춤 단) + `SheetHeader`(원형 X) + `GroupCard`·`ListRow`, 파괴 행은 따로 선 카드에 두고
// 확인 단계(`ConfirmStep`)를 한 번 거친다. 다른 점은 **대상이 메시지가 아니라 링크 하나**라는 것뿐이다.
//
//   링크 복사 · 공유        누구나. 행동은 시트가 미끄러져 내린 **뒤에** 한 번 불린다(`closesSheet`).
//   미리보기 지우기          작성자만(서버가 403 으로 같은 규칙을 지킨다). 확인 단계가 먼저 선다: 모두에게서 지워지고
//                            다시 만들어지지 않으며, 메시지와 링크는 남는다는 사실을 누르기 전에 말한다.
//                            실패는 확인 단계 안에서 말하고 시트를 닫지 않는다.
//
// 문구는 전부 사전 키(`mobile.linkCard.*`)다. 이 시트는 복사·공유·지우기의 **결과**를 모른다: 부른 쪽(`MessageRow`)이
// 「복사됨」 영수증과 실패 줄을 그 행 안에서 말한다(토스트가 아니다 — 이 앱이 반응·삭제 실패에서 이미 고른 규율).
// =============================================================================

export interface LinkActionSheetProps {
  target: LinkCardTarget;
  /** 작성자이고 지울 길(`onRemove`)이 있다. 아니면 지우기 행이 서지 않는다. */
  canRemove: boolean;
  /** 확인 단계로 바로 열린다 — 로터의 「미리보기 지우기」와 캡처 이음매(손가락 없이 확인 단계에 닿는 길). */
  startInRemoveConfirm?: boolean;
  onClose: () => void;
  onCopy: () => void;
  onShare: () => void;
  /** 지운다. 실패하면 **던진다** — 시트가 확인 단계 안에서 문장으로 말한다. 성공하면 시트가 닫는다. */
  onRemove?: () => Promise<void>;
}

export function LinkActionSheet(sheet: LinkActionSheetProps): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const title = formatMessage('mobile.linkCard.sheetTitle');
  const closeLabel = formatMessage('mobile.linkCard.sheetClose');
  return (
    <PageSheet
      accessibilityLabel={title}
      height="fit"
      onClose={sheet.onClose}
      scrimLabel={closeLabel}
      scrimTestID="link-sheet-backdrop"
      testID="link-action-sheet">
      <SheetBody {...sheet} title={title} closeLabel={closeLabel} />
    </PageSheet>
  );
}

function SheetBody({
  target,
  canRemove,
  startInRemoveConfirm = false,
  onClose,
  onCopy,
  onShare,
  onRemove,
  title,
  closeLabel,
}: LinkActionSheetProps & {title: string; closeLabel: string}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const formatMessage = useFormatMessage();
  const [confirming, setConfirming] = useState(startInRemoveConfirm && canRemove);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const remove = () => {
    if (pending || onRemove === undefined) return;
    setPending(true);
    setFailed(false);
    onRemove()
      .then(onClose)
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };

  return (
    <>
      <SheetHeader
        closeLabel={closeLabel}
        closeTestID="link-sheet-close"
        title={title}
      />
      <SheetScroll testID="link-sheet-scroll">
        <GroupCard>
          <View style={styles.preview} testID="link-sheet-preview">
            <Text numberOfLines={1} style={styles.previewDomain} testID="link-sheet-domain">
              {target.domain}
            </Text>
            <Sentence numberOfLines={2} style={styles.previewTitle} testID="link-sheet-title">
              {target.title}
            </Sentence>
          </View>
        </GroupCard>
        {confirming ? (
          <ConfirmStep
            cancelLabel={formatMessage('mobile.linkCard.cancel')}
            cancelTestID="link-remove-cancel"
            confirmLabel={formatMessage('mobile.linkCard.removeConfirm')}
            confirmTestID="link-remove-confirm"
            detail={formatMessage('mobile.linkCard.removeDetail')}
            error={failed ? formatMessage('mobile.linkCard.removeFailed') : null}
            errorTestID="link-remove-error"
            headline={formatMessage('mobile.linkCard.removeTitle')}
            onCancel={() => {
              setConfirming(false);
              setFailed(false);
            }}
            onConfirm={remove}
            pending={pending}
            pendingLabel={formatMessage('mobile.linkCard.removePending')}
            testID="link-remove-step"
          />
        ) : (
          <>
            <GroupCard>
              <ListRow
                closesSheet
                onPress={onCopy}
                testID="link-sheet-copy"
                title={formatMessage('mobile.linkCard.copy')}
              />
              <ListRow
                closesSheet
                onPress={onShare}
                testID="link-sheet-share"
                title={formatMessage('mobile.linkCard.share')}
              />
            </GroupCard>
            {canRemove && onRemove !== undefined ? (
              <GroupCard>
                <ListRow
                  onPress={() => setConfirming(true)}
                  testID="link-sheet-remove"
                  title={formatMessage('mobile.linkCard.remove')}
                  tone="danger"
                />
              </GroupCard>
            ) : null}
          </>
        )}
      </SheetScroll>
    </>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    preview: {
      gap: space.xs,
      paddingHorizontal: SHEET.cardInset,
      paddingVertical: space.md,
    },
    // AA: `textFaint` 는 본문 대비 4.5 를 못 지난다 — 도메인은 뜻을 나르는 글자다.
    previewDomain: {
      fontSize: font.meta,
      lineHeight: line.meta,
      color: color.textMuted,
      fontWeight: '600',
    },
    previewTitle: {
      fontSize: font.label,
      lineHeight: line.label,
      color: color.text,
    },
  });
