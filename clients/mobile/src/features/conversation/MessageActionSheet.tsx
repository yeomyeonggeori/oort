import {TeamExpressionPicker} from '../expressions/TeamExpressionPicker';
import type {Message} from '@momo/core/lib/api';
import {attachmentPreviewLine} from '@momo/core/features/attachments/model';
import type {MessageActionAvailability} from '@momo/core/features/timeline/model';
import {QUOTE_ACTION_LABEL} from '@momo/core/features/timeline/quote';
import {pinActionLabel} from '@momo/core/features/timeline/pins';
import {COPY_MESSAGE_ACTION_LABEL} from '@momo/core/features/timeline/copyLabels';
import {
  QUICK_REACTIONS,
  type ReactionChip,
} from '@momo/core/features/timeline/reactions';
import React, {useCallback, useState} from 'react';
import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import {REACTION_GLYPH_MAX_SCALE, Sentence} from '../../design/atoms';
import {PageSheet, usePageSheetAction} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {
  ConfirmStep,
  GroupCard,
  ListRow,
  SheetScroll,
} from '../../design/sheetParts';
import {
  font,
  line,
  radius,
  SHEET,
  space,
  TOUCH_TARGET,
  type Palette,
} from '../../design/tokens';
import {useStyles} from '../../design/theme';
import { CONV_ICONS, CONV_ICON_SIZE } from '../../design/icons';
import { EmojiPicker } from '../emoji/EmojiPicker';
import { emojiFrequency } from '../emoji/preferences';
import {useEmojiTriggerFocus} from '../emoji/useEmojiTriggerFocus';

/** hh:mm, 24-hour, local. The row's own clock is never used for ordering. */
export function timeLabel(atMs: number): string {
  const d = new Date(atMs);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

// =============================================================================
// 메시지 액션 시트 — 폰에서 hover 를 대신하는 것.
//
// 웹은 이 문제를 두 갈래로 풀었다: hover 가 있는 기기에는 행 옆의 액션 열, 없는 기기에는 길게
// 누르기 + 바텀 시트. 그 갈림은 **화면 폭이 아니라 포인터 종류**를 축으로 삼는다(B11 R2 M2).
// React Native 에서 그 축은 한쪽으로 접혀 있다 — 폰은 언제나 터치다. 그래서 여기에는 시트만
// 있고 액션 열은 **이식하지 않는다**.
//
// ## 웹에서 그대로 가져온 결론
//
// - **행당 탭 스톱 1개 이하**(R2 H1). 행 쪽의 대응은 `MessageRow` 가 접근성 요소 하나로 묶는 것.
// - **문구는 웹의 것**. 「고치기」·「지우기」이지 「수정」·「삭제」가 아니고, 삭제 확인은 **반응까지
//   함께 지워진다는 사실**을 누르기 전에 말한다. 서버에 undo 가 없어 되돌리기가 아니라 확인이다.
// - **44px**(R2 H3). 이 파일의 모든 누를 것은 `TOUCH_TARGET` 을 깔고 앉는다.
//
// ## 그릇과 머리 (#4318)
//
// 그릇은 `PageSheet`(내용 맞춤 단)이고 닫는 길이 셋이다: 머리의 **원형 X**, 스크림, 끌어내리기.
// 옛 「닫기」 줄은 없다 — X 가 머리에 고정돼 있어 큰 글씨로 내용이 길어져도(AX5 ≈850pt, SE 667pt)
// 스크롤에 밀려나지 않는다(design-review M-7 이 걱정한 「닫을 수 없는 시트」가 구조로 닫힌다).
// 내용은 화면의 85% 안에서 스크롤한다.
//
// ## 반응을 누르면 시트가 닫힌다
//
// 반응은 한 번에 하나를 고르는 행동이고, 고른 뒤에도 시트가 남아 있으면 방금 누른 것이 반영됐는지
// 보려고 또 닫아야 한다. 닫으면 그 자리에서 칩이 늘어나는 것이 바로 보인다(되돌림은 `MessageRow`
// 가 그 행에 이유와 함께 그린다. 토스트가 아니다).
//
// ## 행동은 시트가 **미끄러져 내린 뒤에** 불린다 (#4318)
//
// 답글·인용·복사·고정·고치기·반응은 부모(`MessageRow`)가 행동 안에서 곧바로 `setSheetOpen(false)`
// 하는 「고르면 곧 닫히는」 행동이다. 그대로 두면 시트가 언마운트되며 스냅으로 사라진다(옛 fade Modal 은
// 언마운트에도 부드럽게 나갔다). `MessageRow` 는 이 PR 의 손이 아니므로 시트 안에서 푼다: 누름을
// X·스크림·끌기와 같은 닫는 길(`usePageSheetAction`)로 보내 슬라이드가 끝난 뒤 행동을 **한 번** 부른다
// (동작 줄이기면 바로). 반응이 칩으로 보이는 데 슬라이드 한 번(260ms)이 더 걸린다 - 고른 것이 시트와
// 함께 사라지고 그 자리에서 칩이 늘어난다.
//
// 닫는 길로 보내지 **않는** 둘: 「지우기」 행은 시트 안에서 확인 단계로 넘어갈 뿐이고, 확인의 「지우기」
// 는 왕복이 도는 동안 시트가 「지우는 중…」을 말해야 한다(성공 뒤에야 부모가 닫는다). 이 닫힘은 부모의
// `.then(() => setSheetOpen(false))` 라 지금도 스냅이다 - PR 「발견」 참조.
//
// 「+」 는 같은 PageSheet 를 큰 단의 전체 이모지 피커로 바꾼다(#4322).
// 시트를 겹치지 않고, X 는 빠른 행동 목록으로 돌아온다. 고르면 기존 닫는 길 뒤에 반응을 쓴다.
// =============================================================================

export interface MessageActionSheetProps {
  message: Message;
  chips: ReactionChip[];
  availability: MessageActionAvailability;
  /** 이슈 #1112 — 지금 고정돼 있는가. 항목의 낱말이 이 값으로 뒤집힌다. */
  pinned?: boolean;
  /** 이미 해석된 작성자 이름. 행이 쓰던 것과 같은 답을 쓴다. */
  authorLabel: string;
  deletePending?: boolean;
  /**
   * Capture seam (`measure/surfaces.tsx`), inert in the app.
   *
   * The delete confirmation is reached by a press, and the simulator cannot be
   * pressed by a script (spike #837: RN's elements are absent from the
   * accessibility tree and coordinate clicks land nowhere). Without this the one
   * destructive confirmation in the app would be the one screen nobody reviews.
   * Same reasoning as `Timeline`'s `anchorSeq`/`anchorRef`.
   */
  startInDeleteConfirm?: boolean;
  onClose: () => void;
  onToggleReaction: (emoji: string) => void;
  onReply: () => void;
  /**
   * 인용하기 (ADR-0148). 낱말은 코어의 `QUOTE_ACTION_LABEL` 이다 — 웹과 폰이 같은 말을 해야 한다.
   * 항목이 서는 조건은 `availability.quote`(코어의 `canQuoteMessage`)와 이 핸들러 **둘 다**다.
   */
  onQuote?: () => void;
  /**
   * 메시지 복사 (BL-2). 복사되는 것은 **저자가 친 원문**이다 — 화면에 그려진 모양이 아니라
   * 마크다운 소스. 사람이 꺼내려는 것은 명령어·해시·경로이고, 붙여 넣을 곳은 대개 터미널이다.
   */
  onCopy?: () => void;
  /**
   * 고정하기 / 고정 해제하기 (이슈 #1112). 낱말은 코어의 `pinActionLabel` 이고, 방향은 한 콜백이
   * 진다. 고정은 **채널의 사실**이라 작성자 관문이 없다.
   */
  onPin?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

export function MessageActionSheet(
  sheet: MessageActionSheetProps,
): React.JSX.Element {
  const [pickerOpen, setPickerOpen] = useState(false);
  return (
    <PageSheet
      height={pickerOpen ? 'large' : 'fit'}
      onClose={sheet.onClose}
      onNavigateBack={pickerOpen ? () => setPickerOpen(false) : undefined}
      accessibilityLabel={pickerOpen ? '이모지 고르기' : '메시지 액션'}
      scrimLabel="메시지 액션 닫기"
      scrimTestID="sheet-backdrop"
      testID="message-action-sheet"
    >
      <SheetBody
        {...sheet}
        pickerOpen={pickerOpen}
        setPickerOpen={setPickerOpen}
      />
    </PageSheet>
  );
}

function SheetBody({
  message,
  chips,
  availability,
  pinned,
  authorLabel,
  deletePending,
  startInDeleteConfirm = false,
  pickerOpen,
  setPickerOpen,
  onToggleReaction,
  onReply,
  onQuote,
  onCopy,
  onPin,
  onEdit,
  onDelete,
}: MessageActionSheetProps & {
  pickerOpen: boolean;
  setPickerOpen: (open: boolean) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const afterClose = usePageSheetAction();
  const emojiTrigger = useEmojiTriggerFocus(pickerOpen);
  const [confirmingDelete, setConfirmingDelete] =
    useState(startInDeleteConfirm);

  const isMine = useCallback(
    (emoji: string) => chips.some(chip => chip.emoji === emoji && chip.mine),
    [chips],
  );

  // 글 없이 사진·파일만 보낸 메시지는 「내용 없는 메시지」가 아니라 개수로 말한다 (#4294).
  const preview =
    (message.body ?? '').trim() ||
    (attachmentPreviewLine(message.attachments) ?? '');

  // 두 항목이 나란히 선다. 같은 「답」이지만 가는 곳이 다르다: 「답글 달기」는 대화를 옆으로 치우고
  // (다른 화면이 열린다), 「인용하기」는 여기 남아서 저 줄을 가리킨다(ADR-0148). 낱말을 이 파일이
  // 고르지 않는 것이 그 구별을 지키는 방법이다. 순서는 「읽어서 가져가는 것」 다음에 「고치는 것」이고
  // 파괴적인 쪽이 아래(따로 선 카드)로 간다. 고정은 복사 다음, 고치기 앞이다 — 채널을 바꾸지 메시지를
  // 바꾸지 않는다. 복사는 **묘비에도 있다**(지워진 메시지는 애초에 이 시트로 오지 않는다).
  const rows: React.ReactNode[] = [
    availability.reply ? (
      <ListRow
        key="reply"
        title="답글 달기"
        onPress={onReply}
        closesSheet
        testID="sheet-reply"
      />
    ) : null,
    availability.quote && onQuote ? (
      <ListRow
        key="quote"
        title={QUOTE_ACTION_LABEL}
        onPress={onQuote}
        closesSheet
        testID="sheet-quote"
      />
    ) : null,
    onCopy ? (
      // 동사형. 낱말은 코어의 `COPY_MESSAGE_ACTION_LABEL` — 웹 메뉴와 이 시트가 같은 말을 쓴다.
      <ListRow
        key="copy"
        title={COPY_MESSAGE_ACTION_LABEL}
        onPress={onCopy}
        closesSheet
        testID="sheet-copy"
      />
    ) : null,
    availability.pin && onPin ? (
      <ListRow
        key="pin"
        title={pinActionLabel(pinned === true)}
        onPress={onPin}
        closesSheet
        testID="sheet-pin"
      />
    ) : null,
    availability.edit ? (
      <ListRow
        key="edit"
        title="고치기"
        onPress={onEdit}
        closesSheet
        testID="sheet-edit"
      />
    ) : null,
  ].filter(Boolean);

  if (pickerOpen)
    return (
      <EmojiPicker
        onClose={() => setPickerOpen(false)}
        team={{render: ({query}) => <TeamExpressionPicker query={query} onSelect={token => afterClose(() => onToggleReaction(token))} />}}
        onSelect={glyph => afterClose(() => onToggleReaction(glyph))}
      />
    );

  return (
    <>
      <SheetHeader
        title="메시지 액션"
        closeLabel="메시지 액션 닫기"
        closeTestID="sheet-close"
      />
      <SheetScroll testID="sheet-scroll">
        <GroupCard>
          <View style={styles.preview}>
            {/* 이 메시지의 시각 (#3386). 연속 행은 왼쪽 시각 칸을 접었다 — 5분 묶음 안 개별 발화의
                시각은 길게 눌러 여는 이 머리에서 본다. */}
            <View style={styles.previewWho}>
              <Text style={styles.previewAuthor} numberOfLines={1}>
                {authorLabel}
              </Text>
              <Text style={styles.previewTime} testID="sheet-time">
                {timeLabel(message.createdAtMs)}
              </Text>
            </View>
            <Sentence
              style={styles.previewBody}
              numberOfLines={2}
              testID="sheet-preview-body"
            >
              {preview === '' ? '내용 없는 메시지' : preview}
            </Sentence>
          </View>
        </GroupCard>

        {confirmingDelete ? (
          <ConfirmStep
            testID="delete-confirm"
            headline="메시지를 지울까요?"
            // 「…」 바로 뒤에 조사를 붙이지 않는다(「…」가 → 「…」 표시가): `hangul-word` 줄바꿈은 닫는 괄호 뒤의 조사를
            // 못 붙잡아 SE 폭에서 줄 머리에 「가」가 떨어졌다(design-review #4318 r4 H1). 웹 `MessageActions.tsx` 의
            // 같은 문장은 브라우저가 어절을 지켜 그대로다.
            detail="지운 메시지는 되돌릴 수 없습니다. 자리에는 「삭제된 메시지」 표시가 남고, 달려 있던 반응도 함께 지워집니다."
            confirmLabel="지우기"
            pendingLabel="지우는 중…"
            pending={deletePending === true}
            onCancel={() => setConfirmingDelete(false)}
            // 닫는 길로 보내지 않는다: 왕복 중 시트가 「지우는 중…」을 말하고, 성공 뒤에야 부모가 닫는다.
            onConfirm={onDelete}
            cancelTestID="delete-cancel"
            confirmTestID="delete-confirm-button"
          />
        ) : (
          <>
            {availability.react ? (
              <GroupCard label="빠른 반응">
                <View style={styles.reactionRow} testID="quick-reactions">
                  {QUICK_REACTIONS.map(emoji => {
                    const already = isMine(emoji);
                    return (
                      <Pressable
                        key={emoji}
                        accessibilityRole="button"
                        accessibilityState={{selected: already}}
                        accessibilityLabel={
                          already
                            ? `${emoji} 반응 취소`
                            : `${emoji} 반응 남기기`
                        }
                        onPress={() => {
                          if (!already) emojiFrequency.record(emoji);
                          afterClose(() => onToggleReaction(emoji));
                        }}
                        style={({pressed}) => [
                          styles.reaction,
                          already && styles.reactionMine,
                          pressed && styles.pressed,
                        ]}
                        testID={`quick-reaction-${emoji}`}
                      >
                        <Text
                          style={styles.reactionGlyph}
                          maxFontSizeMultiplier={REACTION_GLYPH_MAX_SCALE}
                        >
                          {emoji}
                        </Text>
                      </Pressable>
                    );
                  })}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="전체 이모지 고르기"
                    ref={emojiTrigger}
                    onPress={() => setPickerOpen(true)}
                    testID="all-reactions"
                    style={({ pressed }) => [
                      styles.reaction,
                      pressed && styles.pressed,
                    ]}
                  >
                    <Image
                      source={CONV_ICONS.plus}
                      style={{
                        width: CONV_ICON_SIZE.plus,
                        height: CONV_ICON_SIZE.plus,
                      }}
                    />
                  </Pressable>
                </View>
              </GroupCard>
            ) : null}
            {rows.length > 0 ? <GroupCard>{rows}</GroupCard> : null}
            {availability.delete ? (
              <GroupCard>
                <ListRow
                  title="지우기"
                  tone="danger"
                  onPress={() => setConfirmingDelete(true)}
                  testID="sheet-delete"
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
    previewWho: {
      flexDirection: 'row',
      alignItems: 'baseline',
      columnGap: space.sm,
    },
    // AA: `textFaint` 는 본문 대비 4.5 를 못 지난다 — 작성자·시각은 뜻을 나르는 글자다.
    previewAuthor: {
      flexShrink: 1,
      fontSize: font.meta,
      color: color.textMuted,
      fontWeight: '600',
    },
    previewTime: {fontSize: font.meta, color: color.textMuted},
    previewBody: {
      fontSize: font.label,
      color: color.text,
      lineHeight: line.label,
    },
    reactionRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      justifyContent: 'space-between',
      paddingHorizontal: space.sm,
      paddingVertical: space.sm,
    },
    reaction: {
      minWidth: TOUCH_TARGET,
      minHeight: TOUCH_TARGET,
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: radius.md,
      borderWidth: 1,
      borderColor: 'transparent',
    },
    reactionMine: {
      borderColor: color.accent,
      backgroundColor: color.accentSurface,
    },
    // 이모지 한 글자의 도형 크기 — 역할 표의 「화면·시트 제목」(22)과 같다.
    reactionGlyph: {fontSize: font.title},
    pressed: {opacity: 0.6},
  });
