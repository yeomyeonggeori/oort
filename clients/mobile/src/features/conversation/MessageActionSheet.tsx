import type {Message} from '@momo/core/lib/api';
import type {MessageActionAvailability} from '@momo/core/features/timeline/model';
import {QUOTE_ACTION_LABEL} from '@momo/core/features/timeline/quote';
import {pinActionLabel} from '@momo/core/features/timeline/pins';
import {
  QUICK_REACTIONS,
  type ReactionChip,
} from '@momo/core/features/timeline/reactions';
import React, {useCallback, useState} from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useStyles} from '../../design/theme';

// =============================================================================
// 메시지 액션 시트 — 폰에서 hover 를 대신하는 것.
//
// 웹은 이 문제를 두 갈래로 풀었다: hover 가 있는 기기에는 행 옆의 액션 열,
// 없는 기기에는 길게 누르기 + 바텀 시트. 그 갈림은 **화면 폭이 아니라 포인터
// 종류**를 축으로 삼는다(B11 R2 M2: 폭으로 갈랐더니 600px 아래의 마우스에는
// 어느 쪽 경로도 없었다). React Native 에서 그 축은 한쪽으로 접혀 있다 — 폰은
// 언제나 터치다. 그래서 여기에는 시트만 있고 액션 열은 **이식하지 않는다**.
//
// ## 웹에서 그대로 가져온 결론
//
// - **행당 탭 스톱 1개 이하**(R2 H1). 웹은 행마다 최대 6개를 깔아 두었다가
//   되돌렸다 — `opacity-0` 은 눈에서만 감추고 탭 순서에는 남기 때문이다. 여기서
//   버튼들은 행이 아니라 이 시트 안에 있고, 시트는 열려 있을 때만 존재한다.
//   행 쪽의 대응은 `MessageRow` 가 접근성 요소 하나로 묶는 것으로 진다.
// - **문구는 웹의 것**. 「고치기」·「지우기」이지 「수정」·「삭제」가 아니고,
//   삭제 확인은 **반응까지 함께 지워진다는 사실**을 누르기 전에 말한다. 되돌리기가
//   아니라 확인인 이유도 같다: 서버에 undo 가 없다.
// - **44px**(R2 H3). 웹은 폰에서 저장/취소 28px, 삭제 확인 32px 이던 것을 재고
//   고쳤다. 이 파일의 모든 누를 것은 `TOUCH_TARGET` 을 깔고 앉는다.
// - **보이는 닫기 경로**. 배경 탭도 받지만 그것이 유일한 경로여서는 안 된다.
//
// ## 반응을 누르면 시트가 닫힌다
//
// 반응은 한 번에 하나를 고르는 행동이고, 고른 뒤에도 시트가 남아 있으면 방금
// 누른 것이 반영됐는지 보려고 또 닫아야 한다. 닫으면 그 자리에서 칩이 늘어나는
// 것이 바로 보인다 — 낙관적 갱신이 **보여야** 하는 이유는 실패했을 때 되돌아가는
// 것도 보여야 하기 때문이다(되돌림은 `MessageRow` 가 그 행에 이유와 함께 그린다.
// 토스트가 아니다).
//
// ## 이 배치에 없는 것: 전체 이모지 고르기
//
// 웹은 빠른 반응 6개 옆에 「다른 반응 고르기」로 32개짜리 격자를 연다. 여기에는
// 없다. 그 목록은 웹 컴포넌트 안에 있어서 가져오려면 **두 번째 정본**을 만들거나
// 코어에 상수를 새로 세워야 하는데, 이 배치의 규율은 코어를 읽기 우선으로 두는
// 것이다. 6개는 커버리지가 아니라 업무 채널이 실제로 하는 말로 골라 둔 목록이라
// (코어 `QUICK_REACTIONS` 의 주석) v0 의 답으로 성립한다. 없는 것을 없다고
// 적어 두는 편이, 목록을 몰래 한 벌 더 만드는 것보다 싸다.
// =============================================================================

export function MessageActionSheet({
  message,
  chips,
  availability,
  pinned,
  authorLabel,
  deletePending,
  startInDeleteConfirm = false,
  onClose,
  onToggleReaction,
  onReply,
  onQuote,
  onCopy,
  onPin,
  onEdit,
  onDelete,
}: {
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
   * 인용하기 (ADR-0148). 낱말은 코어의 `QUOTE_ACTION_LABEL` 이다 — 웹과 폰이
   * 같은 말을 해야 하고, 이 시트의 다른 낱말들이 웹에서 온 것과 같은 이유다.
   *
   * 항목이 서는 조건은 `availability.quote`(코어의 `canQuoteMessage`)와 이
   * 핸들러 **둘 다**이고, 그것은 `reply` 가 `onOpenThread` 유무를 함께 보는 것과
   * 같은 모양이다.
   */
  onQuote?: () => void;
  /**
   * 메시지 복사 (BL-2). 복사되는 것은 **저자가 친 원문**이다 — 화면에 그려진
   * 모양이 아니라 마크다운 소스. 사람이 꺼내려는 것은 명령어·해시·경로이고,
   * 그것을 다시 붙여 넣을 곳은 대개 마크다운을 아는 자리가 아니라 터미널이다.
   */
  onCopy?: () => void;
  /**
   * 고정하기 / 고정 해제하기 (이슈 #1112). 낱말은 코어의 `pinActionLabel` 이고,
   * 방향은 한 콜백이 진다 — 행이 이미 어느 쪽인지 알기 때문에 콜백을 둘로
   * 나누면 낱말과 요청이 갈라질 수 있다.
   *
   * 고정은 **채널의 사실**이라 작성자 관문이 없다: 남이 고정한 것도 누구나 풀 수
   * 있고, 서버가 같은 규칙을 강제한다.
   */
  onPin?: () => void;
  onEdit: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  // ===========================================================================
  // 시트는 스크롤한다 (design-review M-7 — 실측으로 확정)
  //
  // 기본 글꼴에서 이 시트는 ≈482pt 이고 SE(667pt)에 185pt 여유가 있다. 그런데
  // 이번 배치가 항목을 둘 늘렸고(인용하기·메시지 복사하기 = **+88pt**, 리뷰의
  // 「약 +86pt」 확정), RN `Text` 는 기본이 `allowFontScaling` 이므로 접근성
  // 글꼴에서 모든 줄이 함께 자란다:
  //
  //     기본 ≈482 · XXL ≈522 · AX2 ≈620 · **AX5 ≈850**  (SE 667 초과)
  //
  // 넘치는 순간 잘리는 것은 목록의 **끝**이고, 이 시트의 끝은 「닫기」다 —
  // 접근성 글꼴을 쓰는 사람이 시트를 닫을 수 없게 된다. 그래서 최대 높이를
  // 화면의 비율로 묶고 그 안에서 스크롤한다. 기본 글꼴에서는 내용이 그 높이보다
  // 짧으므로 **스크롤이 나타나지 않는다** — 지금 화면은 하나도 안 변한다.
  // ===========================================================================
  const {height: windowHeight} = useWindowDimensions();
  const [confirmingDelete, setConfirmingDelete] = useState(startInDeleteConfirm);

  const isMine = useCallback(
    (emoji: string) => chips.some(chip => chip.emoji === emoji && chip.mine),
    [chips],
  );

  const preview = (message.body ?? '').trim();

  return (
    <Modal
      visible
      transparent
      animationType="fade"
      // Android 전용 경로지만 비워 두면 경고가 난다. iOS 에서는 호출되지 않는다.
      onRequestClose={onClose}
      testID="message-action-sheet">
      <View style={styles.root}>
        {/* 배경 탭도 닫는다 — 다만 이것이 **유일한** 닫기 경로여서는 안 된다. */}
        <Pressable
          style={styles.backdrop}
          accessibilityRole="button"
          accessibilityLabel="메시지 액션 닫기"
          onPress={onClose}
          testID="sheet-backdrop"
        />

        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            {
              paddingBottom: Math.max(insets.bottom, space.md),
              // 화면의 85% 를 넘지 않는다. 배경 탭으로 닫는 길이 언제나 보이게
              // 남겨 두는 것이 그 나머지의 몫이다.
              maxHeight: windowHeight * 0.85,
            },
          ]}>
          <View style={styles.grabber} />
          <ScrollView
            // 내용이 짧으면 아무 일도 하지 않는다. 길면 「닫기」까지 닿는다.
            bounces={false}
            showsVerticalScrollIndicator
            testID="sheet-scroll">

          <View style={styles.preview}>
            <Text style={styles.previewTitle}>메시지 액션</Text>
            <Text style={styles.previewAuthor} numberOfLines={1}>
              {authorLabel}
            </Text>
            <Text style={styles.previewBody} numberOfLines={2}>
              {preview === '' ? '내용 없는 메시지' : preview}
            </Text>
          </View>

          {confirmingDelete ? (
            <View style={styles.confirm} testID="delete-confirm">
              <Text style={styles.confirmHeadline}>메시지를 지울까요?</Text>
              <Text style={styles.confirmDetail}>
                지운 메시지는 되돌릴 수 없습니다. 자리에는 「삭제된 메시지」가 남고,
                달려 있던 반응도 함께 지워집니다.
              </Text>
              <View style={styles.confirmRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="취소"
                  onPress={() => setConfirmingDelete(false)}
                  style={({pressed}) => [styles.secondary, pressed && styles.pressed]}
                  testID="delete-cancel">
                  <Text style={styles.secondaryLabel}>취소</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="지우기"
                  accessibilityState={{disabled: deletePending === true}}
                  disabled={deletePending}
                  onPress={onDelete}
                  style={({pressed}) => [
                    styles.destructive,
                    pressed && styles.pressed,
                  ]}
                  testID="delete-confirm-button">
                  <Text style={styles.destructiveLabel}>
                    {deletePending ? '지우는 중…' : '지우기'}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
              {availability.react ? (
                <View style={styles.reactions}>
                  <Text style={styles.sectionLabel}>빠른 반응</Text>
                  <View style={styles.reactionRow} testID="quick-reactions">
                    {QUICK_REACTIONS.map(emoji => {
                      const already = isMine(emoji);
                      return (
                        <Pressable
                          key={emoji}
                          accessibilityRole="button"
                          accessibilityState={{selected: already}}
                          accessibilityLabel={
                            already ? `${emoji} 반응 취소` : `${emoji} 반응 남기기`
                          }
                          onPress={() => onToggleReaction(emoji)}
                          style={({pressed}) => [
                            styles.reaction,
                            already && styles.reactionMine,
                            pressed && styles.pressed,
                          ]}
                          testID={`quick-reaction-${emoji}`}>
                          <Text style={styles.reactionGlyph}>{emoji}</Text>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              {/* 두 항목이 나란히 선다. 같은 「답」이지만 가는 곳이 다르다:
                  「답글 달기」는 대화를 옆으로 치우고(다른 화면이 열린다),
                  「인용하기」는 여기 남아서 저 줄을 가리킨다(ADR-0148). 낱말을
                  이 파일이 고르지 않는 것이 그 구별을 지키는 방법이다 — 폰이
                  자기 말을 지어내면 웹과 갈라지고, 갈라지는 순간 두 화면이
                  같은 장치를 다르게 부른다. */}
              {availability.reply ? (
                <SheetRow label="답글 달기" onPress={onReply} testID="sheet-reply" />
              ) : null}
              {availability.quote && onQuote ? (
                <SheetRow
                  label={QUOTE_ACTION_LABEL}
                  onPress={onQuote}
                  testID="sheet-quote"
                />
              ) : null}
              {/* 복사는 **묘비에도 있다** — 지워진 메시지에는 꺼낼 내용이 없으므로
                  거기서는 애초에 오지 않는다(행이 그것을 판정한다). 여기 두는
                  순서는 「읽어서 가져가는 것」 다음에 「고치는 것」이다: 파괴적인
                  쪽이 아래로 간다. */}
              {onCopy ? (
                <SheetRow
                  // 동사형 (design-review M-2). 이웃이 전부 「답글 달기」·
                  // 「인용해서 답하기」·「고치기」·「지우기」인데 이 항목만
                  // 명사형이었다 — 목록의 결이 한 줄에서 끊긴다.
                  label="메시지 복사하기"
                  onPress={onCopy}
                  testID="sheet-copy"
                />
              ) : null}
              {/* 고정은 복사 다음, 고치기 앞이다 — 여기까지가 「메시지를 그대로 두고
                  하는 일」이고 아래부터가 「메시지를 바꾸는 일」이다. 고정은 채널을
                  바꾸지 메시지를 바꾸지 않는다. */}
              {availability.pin && onPin ? (
                <SheetRow
                  label={pinActionLabel(pinned === true)}
                  onPress={onPin}
                  testID="sheet-pin"
                />
              ) : null}
              {availability.edit ? (
                <SheetRow label="고치기" onPress={onEdit} testID="sheet-edit" />
              ) : null}
              {availability.delete ? (
                <SheetRow
                  label="지우기"
                  tone="danger"
                  onPress={() => setConfirmingDelete(true)}
                  testID="sheet-delete"
                />
              ) : null}

              <SheetRow label="닫기" tone="muted" onPress={onClose} testID="sheet-close" />
            </>
          )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function SheetRow({
  label,
  onPress,
  tone = 'default',
  testID,
}: {
  label: string;
  onPress: () => void;
  tone?: 'default' | 'danger' | 'muted';
  testID?: string;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({pressed}) => [styles.sheetRow, pressed && styles.pressed]}
      testID={testID}>
      <Text
        style={[
          styles.sheetRowLabel,
          tone === 'danger' && styles.sheetRowLabelDanger,
          tone === 'muted' && styles.sheetRowLabelMuted,
        ]}>
        {label}
      </Text>
    </Pressable>
  );
}

const buildStyles = (color: Palette) => StyleSheet.create({
  root: {flex: 1, justifyContent: 'flex-end'},
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: color.scrim,
  },
  sheet: {
    backgroundColor: color.surface,
    borderTopLeftRadius: 16,
    borderTopRightRadius: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: color.border,
    paddingHorizontal: SAFE_GUTTER,
    paddingTop: space.sm,
  },
  grabber: {
    alignSelf: 'center',
    width: 36,
    height: 4,
    borderRadius: radius.pill,
    backgroundColor: color.border,
    marginBottom: space.md,
  },
  preview: {
    gap: 2,
    paddingBottom: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
  },
  previewTitle: {fontSize: font.label, color: color.text, fontWeight: '700'},
  previewAuthor: {fontSize: font.meta, color: color.textFaint, fontWeight: '600'},
  previewBody: {fontSize: font.label, color: color.textMuted, lineHeight: 19},
  reactions: {
    paddingVertical: space.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: color.border,
    gap: space.xs,
  },
  sectionLabel: {fontSize: font.meta, color: color.textFaint, fontWeight: '600'},
  reactionRow: {flexDirection: 'row', justifyContent: 'space-between'},
  reaction: {
    minWidth: TOUCH_TARGET,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: 'transparent',
  },
  reactionMine: {borderColor: color.accent, backgroundColor: color.accentSurface},
  reactionGlyph: {fontSize: 24},
  sheetRow: {minHeight: TOUCH_TARGET, justifyContent: 'center'},
  sheetRowLabel: {fontSize: font.body, color: color.text},
  sheetRowLabelDanger: {color: color.danger},
  sheetRowLabelMuted: {color: color.textMuted},
  confirm: {paddingTop: space.md, gap: space.sm},
  confirmHeadline: {fontSize: font.body, color: color.text, fontWeight: '700'},
  confirmDetail: {fontSize: font.label, color: color.textMuted, lineHeight: 19},
  confirmRow: {flexDirection: 'row', gap: space.sm, paddingTop: space.xs},
  secondary: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.border,
  },
  secondaryLabel: {fontSize: font.label, color: color.text, fontWeight: '600'},
  destructive: {
    flex: 1,
    minHeight: TOUCH_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: color.dangerBorder,
    backgroundColor: color.dangerSurface,
  },
  destructiveLabel: {fontSize: font.label, color: color.danger, fontWeight: '700'},
  pressed: {opacity: 0.6},
});
