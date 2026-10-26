import {
  CUSTOM_STATUS_CLEAR_LABEL,
  CUSTOM_STATUS_DIALOG_TITLE,
  CUSTOM_STATUS_PRESETS,
  CUSTOM_STATUS_SAVE_LABEL,
  CUSTOM_STATUS_SAVING_LABEL,
  CUSTOM_STATUS_TEXT_LABEL,
  CUSTOM_STATUS_TEXT_MAX,
  CUSTOM_STATUS_TEXT_PLACEHOLDER,
  STATUS_EXPIRY_OPTIONS,
  clearCustomStatusWrite,
  customStatusClearFailureMessage,
  customStatusDraftWrite,
  customStatusFailureMessage,
  statusExpiryShortLabel,
  type PhoneStatusExpiryChoice,
} from '@momo/core/features/presence/customStatus';
import type {PresenceStatus, RosterMember} from '@momo/core/lib/api';
import React, {useState} from 'react';
import {StyleSheet, TextInput, View} from 'react-native';

import {PageSheet, usePageSheetClose} from '../../design/PageSheet';
import {SheetHeader} from '../../design/SheetChrome';
import {ChoiceRow, GroupCard, ListRow, RowEmoji, SheetScroll} from '../../design/sheetParts';
import {useKeyboardAppearance, usePalette, useStyles} from '../../design/theme';
import {font, radius, SHEET, space, type Palette} from '../../design/tokens';
import {useSetPresence} from './selfStatus';
import {SettingsNote} from './settingsRows';
import {initialExpiry, statusDraftVerdict, statusSeed} from './statusDraft';

// =============================================================================
// 「상태 설정」 바텀시트 — 이모지 + 한 문장 + 지우는 때 (#4457, ADR-0176; 옛 `StatusPage` 의 자리).
//
// 설정 페이지 **위의** 시트다(`phone-sheets.md` §1 규칙 3: 페이지 안의 한 항목을 고치는 일은 시트가
// 맡는다. 편집 시트는 왼쪽 ✓ 를 갖고 입력 전에는 회색이다). Buzz 「Set a status」 시트의 모양:
//
//   머리   [✓] 상태 설정 [X]       ✓ = 확정(바뀐 것이 있을 때만 눌린다 — `statusDraft.ts`)
//   입력   상태 입력 알약          앞 이모지 + 글 한 줄
//   기간   「지우기」 행 한 줄     값 + 펼침 ⌄ → 누르면 그 자리에서 고른다(시트 위 시트 없음)
//   빠른 상태   이모지 + 이름 목록   누르면 이모지와 글을 채운다(저장은 ✓)
//
// 쓰는 길은 옛 장과 **그대로**다 — 웹 `SetStatusDialog` 와 같은 `PUT /presence`, 같은 코어 낱말·
// 프리셋·상한·저장 규칙(`customStatusDraftWrite`). 서버 계약을 더하지 않는다.
//
// ## 이모지는 키보드로 받는다
//
// 폰에는 이모지 고르개가 없고 새로 들이지 않는다. iOS 키보드의 이모지 판이 그 일을 한다 — 입력 알약
// 앞의 작은 칸 하나가 그 입력을 받는다. 빠른 상태 다섯 줄은 이모지와 글을 한 번에 채운다.
//
// ## 「시각 고르기」가 없다
//
// 날짜·시각 입력은 새 의존(datetimepicker) 없이는 폰에서 쓸 만하게 만들 수 없다. 대신 저장된 만료가
// 있으면 「지금대로」를 첫 선택지로 둔다 — 글만 고친 사람의 만료가 저장 한 번에 사라지지 않게.
//
// ## 높이는 내용 맞춤(`fit`)이다
//
// Buzz 의 이 시트는 내용만큼 서서 뒤의 설정 페이지가 위쪽에 남는다 — 큰 단(위 58 에서 바닥까지)으로 세우면 뒤가
// 거의 가려진다. 1단계는 큰 단을 골랐는데, 그때는 fit·medium 에 키보드 올림이 없어서였다. #4318 이 그것을 넣었다:
// 키보드가 올라오면 시트의 바닥이 키보드 윗면에 앉고 높이가 「키보드 위 ~ 큰 단의 위 끝」 안으로 줄며, 이 시트의
// 입력이 위쪽(머리 바로 아래)에 있어 가려지지 않는다. 내용이 85% 를 넘거나(SE·큰 글씨) 키보드 때문에 줄면 몸이
// 안에서 스크롤하고 머리의 X 와 ✓ 는 고정이다(`phone-sheets.md` §2).
// =============================================================================

const PHONE_EXPIRY: readonly Exclude<PhoneStatusExpiryChoice, 'keep'>[] = [
  'none',
  '30m',
  '1h',
  'today',
];

function expiryLabel(id: Exclude<PhoneStatusExpiryChoice, 'keep'>): string {
  return STATUS_EXPIRY_OPTIONS.find(option => option.id === id)?.label ?? id;
}

export function StatusSheet({
  workspaceId,
  selfId,
  self,
  onClose,
}: {
  workspaceId: string;
  selfId: string;
  self: RosterMember | undefined;
  onClose: () => void;
}): React.JSX.Element {
  return (
    <PageSheet
      height="fit"
      onClose={onClose}
      accessibilityLabel={CUSTOM_STATUS_DIALOG_TITLE}
      testID="status-sheet"
      scrimTestID="status-sheet-scrim"
      scrimLabel={`${CUSTOM_STATUS_DIALOG_TITLE} 닫기`}>
      <StatusSheetBody
        workspaceId={workspaceId}
        selfId={selfId}
        self={self}
        onClose={onClose}
      />
    </PageSheet>
  );
}

function StatusSheetBody({
  workspaceId,
  selfId,
  self,
  onClose,
}: {
  workspaceId: string;
  selfId: string;
  self: RosterMember | undefined;
  onClose: () => void;
}): React.JSX.Element {
  // 저장이 끝나면 스크림·끌기와 같이 미끄러져 나간다.
  const slideClose = usePageSheetClose() ?? onClose;
  const write = useSetPresence(workspaceId, selfId);
  const declared: PresenceStatus = self?.presenceStatus ?? 'auto';
  // 씨앗은 여는 순간 한 번 — 명부가 다시 읽혀도 쓰던 글을 덮지 않는다.
  const [openedAtMs] = useState(() => Date.now());
  const [seed] = useState(() => statusSeed(self, openedAtMs));
  const [emoji, setEmoji] = useState(seed.emoji);
  const [text, setText] = useState(seed.text);
  const [expiry, setExpiry] = useState<PhoneStatusExpiryChoice>(() =>
    initialExpiry(seed),
  );
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const verdict = statusDraftVerdict(seed, {emoji, text, expiry});

  const commit = (next: Parameters<typeof write.mutate>[0], fail: string) => {
    if (write.isPending) return;
    setFailure(null);
    write.mutate(next, {
      onSuccess: slideClose,
      onError: () => setFailure(fail),
    });
  };
  const save = () => {
    if (!verdict.canSave) return;
    commit(
      customStatusDraftWrite({emoji, text, expiry}, declared, Date.now()),
      customStatusFailureMessage(),
    );
  };
  const clear = () =>
    commit(clearCustomStatusWrite(declared), customStatusClearFailureMessage());

  const choices: PhoneStatusExpiryChoice[] =
    seed.storedExpiry !== undefined ? ['keep', ...PHONE_EXPIRY] : [...PHONE_EXPIRY];
  const choiceLabel = (id: PhoneStatusExpiryChoice): string =>
    id === 'keep' && seed.storedExpiry !== undefined
      ? `지금대로 · ${statusExpiryShortLabel(seed.storedExpiry, openedAtMs)}`
      : expiryLabel(id as Exclude<PhoneStatusExpiryChoice, 'keep'>);
  const expiryValue = choiceLabel(expiry);

  return (
    <>
      <SheetHeader
        title={CUSTOM_STATUS_DIALOG_TITLE}
        closeLabel={`${CUSTOM_STATUS_DIALOG_TITLE} 닫기`}
        closeTestID="status-sheet-close"
        titleTestID="status-sheet-title"
        confirm={{
          label: write.isPending
            ? CUSTOM_STATUS_SAVING_LABEL
            : CUSTOM_STATUS_SAVE_LABEL,
          onPress: save,
          disabled: !verdict.canSave || write.isPending,
          testID: 'status-save',
        }}
      />
      <SheetScroll testID="status-sheet-scroll">
        <StatusInputPill
          emoji={emoji}
          text={text}
          onEmojiChange={setEmoji}
          onTextChange={setText}
        />

        <GroupCard label="기간" testID="status-expiry-card">
          <ListRow
            title="지우기"
            value={expiryValue}
            accessory="expand"
            onPress={() => setExpiryOpen(open => !open)}
            accessibilityLabel={`지우기, ${expiryValue}`}
            accessibilityHint="지울 시간을 고릅니다."
            testID="status-expiry-row"
          />
          {expiryOpen
            ? choices.map(id => (
                <ChoiceRow
                  key={id}
                  title={choiceLabel(id)}
                  selected={id === expiry}
                  onPress={() => {
                    setExpiry(id);
                    setExpiryOpen(false);
                  }}
                  testID={`status-expiry-${id}`}
                />
              ))
            : null}
        </GroupCard>

        <GroupCard label="빠른 상태" inset="icon" testID="status-presets-card">
          {CUSTOM_STATUS_PRESETS.map(preset => (
            <ListRow
              key={preset.id}
              title={preset.label}
              leading={<RowEmoji emoji={preset.emoji} />}
              onPress={() => {
                setEmoji(preset.emoji);
                setText(preset.label);
              }}
              accessibilityLabel={preset.label}
              accessibilityHint="상태 글을 이것으로 채웁니다."
              testID={`status-preset-${preset.id}`}
            />
          ))}
        </GroupCard>

        {seed.hasVisible ? (
          <GroupCard testID="status-clear-card">
            <ListRow
              title={CUSTOM_STATUS_CLEAR_LABEL}
              tone="danger"
              disabled={write.isPending}
              onPress={clear}
              testID="status-clear"
            />
          </GroupCard>
        ) : null}

        {failure ? (
          <SettingsNote tone="danger" testID="status-failure">
            {failure}
          </SettingsNote>
        ) : null}
      </SheetScroll>
    </>
  );
}

/**
 * 상태 입력 알약: 앞 이모지 칸 + 글 한 줄. `design/sheetParts.tsx` 의 `InputPill` 은 앞 자리가 아이콘
 * 하나뿐이라(입력을 둘 수 없다) 같은 윤곽을 이 시트에서 얇게 다시 짠다 — 외곽선은 `textFaint`(3:1,
 * ADR-0189 D6 이 값을 받는 그릇에만 남긴 선), 높이는 `SHEET.pillMinHeight`. #4318 이 `InputPill` 에
 * 앞 자리(`leading`)를 내면 이 함수는 지워진다.
 */
function StatusInputPill({
  emoji,
  text,
  onEmojiChange,
  onTextChange,
}: {
  emoji: string;
  text: string;
  onEmojiChange: (next: string) => void;
  onTextChange: (next: string) => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  // 키보드 모양은 앱의 스킴이 정한다(#4526) — 시스템이 라이트인데 앱이 다크이면 어두운 시트에 밝은 키보드가 선다.
  const keyboardAppearance = useKeyboardAppearance();
  return (
    <View style={styles.pill} testID="status-input-pill">
      <TextInput
        value={emoji}
        onChangeText={onEmojiChange}
        // 이모지를 자리표시자로 두면 제 색으로 그려져 「골라 둔 값」처럼 보인다(옛 리뷰 M-2).
        placeholder="＋"
        placeholderTextColor={palette.textMuted}
        accessibilityLabel="상태 이모지"
        accessibilityHint="키보드의 이모지 판에서 고릅니다."
        keyboardAppearance={keyboardAppearance}
        style={styles.emojiInput}
        testID="status-emoji-input"
      />
      <TextInput
        value={text}
        onChangeText={onTextChange}
        placeholder={CUSTOM_STATUS_TEXT_PLACEHOLDER}
        placeholderTextColor={palette.textMuted}
        accessibilityLabel={CUSTOM_STATUS_TEXT_LABEL}
        maxLength={CUSTOM_STATUS_TEXT_MAX}
        returnKeyType="done"
        keyboardAppearance={keyboardAppearance}
        style={styles.textInput}
        testID="status-text-input"
      />
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    pill: {
      minHeight: SHEET.pillMinHeight,
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.md,
      paddingHorizontal: space.lg,
      borderRadius: radius.pill,
      borderWidth: 1,
      borderColor: color.textFaint,
    },
    emojiInput: {
      minWidth: SHEET.iconSlot + space.sm,
      textAlign: 'center',
      fontSize: font.heading,
      color: color.text,
      padding: 0,
    },
    textInput: {
      flex: 1,
      paddingVertical: space.sm,
      fontSize: font.body,
      color: color.text,
    },
  });
