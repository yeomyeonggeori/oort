import {
  CUSTOM_STATUS_CLEAR_LABEL,
  CUSTOM_STATUS_PRESETS,
  CUSTOM_STATUS_SAVE_LABEL,
  CUSTOM_STATUS_TEXT_LABEL,
  CUSTOM_STATUS_TEXT_MAX,
  CUSTOM_STATUS_TEXT_PLACEHOLDER,
  STATUS_EXPIRY_OPTIONS,
  clearCustomStatusWrite,
  customStatusClearFailureMessage,
  customStatusDraftWrite,
  customStatusFailureMessage,
  statusExpiryShortLabel,
  visibleCustomStatus,
  type PhoneStatusExpiryChoice,
} from '@momo/core/features/presence/customStatus';
import type {PresenceStatus, RosterMember} from '@momo/core/lib/api';
import React, {useState} from 'react';
import {StyleSheet, Text, TextInput, View} from 'react-native';

import {
  GroupRow,
  GroupSection,
  OutlineButton,
  PrimaryButton,
  Sentence,
} from '../../design/atoms';
import {useStyles, usePalette} from '../../design/theme';
import {font, radius, SAFE_GUTTER, space, TOUCH_TARGET, type Palette} from '../../design/tokens';
import {useSetPresence} from './selfStatus';

// =============================================================================
// 상태 글 — 이모지 + 한 문장 + 지우기 시간 (#2848, ADR-0176).
//
// 프로필 시트 **안의 한 장**이다(테마와 같은 문법 — 시트 위에 시트를 겹치지
// 않는다). 웹 `SetStatusDialog` 와 같은 PUT, 같은 코어 낱말·프리셋·상한을 쓴다.
//
// ## 이모지는 키보드로 받는다
//
// 폰에는 이모지 고르개가 없고, 새로 들이지 않는다. iOS 키보드의 이모지 판이
// 이미 그 일을 한다 — 작은 칸 하나가 그 입력을 받는다. 프리셋 다섯 줄은
// 이모지와 글을 한 번에 채운다.
//
// ## 「시각 고르기」가 없다
//
// 날짜·시각 입력은 새 의존(datetimepicker) 없이는 폰에서 쓸 만하게 만들 수
// 없다. 그 대신 저장된 만료가 있으면 「지금대로」를 첫 선택지로 둔다 — 글만 고친
// 사람의 만료가 저장 한 번에 사라지지 않게.
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

export function StatusPage({
  workspaceId,
  selfId,
  self,
  nowMs,
  onDone,
}: {
  workspaceId: string;
  selfId: string;
  self: RosterMember | undefined;
  nowMs: number;
  onDone: () => void;
}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const write = useSetPresence(workspaceId, selfId);
  const declared: PresenceStatus = self?.presenceStatus ?? 'auto';
  // 씨앗은 여는 순간 한 번 — 명부가 다시 읽혀도 쓰던 글을 덮지 않는다.
  const [seed] = useState(() => {
    const visible = self ? visibleCustomStatus(self, nowMs) : null;
    const stored = visible ? self?.statusExpiresAtMs : undefined;
    return {
      emoji: visible?.emoji ?? '',
      text: visible?.text ?? '',
      storedExpiry: stored,
      hasVisible: visible !== null,
    };
  });
  const [emoji, setEmoji] = useState(seed.emoji);
  const [text, setText] = useState(seed.text);
  const [expiry, setExpiry] = useState<PhoneStatusExpiryChoice>(
    seed.storedExpiry !== undefined ? 'keep' : 'none',
  );
  const [failure, setFailure] = useState<string | null>(null);

  const commit = (next: Parameters<typeof write.mutate>[0], fail: string) => {
    if (write.isPending) return;
    setFailure(null);
    write.mutate(next, {
      onSuccess: onDone,
      onError: () => setFailure(fail),
    });
  };

  const save = () =>
    commit(
      customStatusDraftWrite({emoji, text, expiry}, declared, Date.now()),
      customStatusFailureMessage(),
    );
  const clear = () =>
    commit(clearCustomStatusWrite(declared), customStatusClearFailureMessage());

  const choices: PhoneStatusExpiryChoice[] =
    seed.storedExpiry !== undefined ? ['keep', ...PHONE_EXPIRY] : [...PHONE_EXPIRY];

  return (
    <View style={styles.page} testID="status-page">
      <View style={styles.group}>
        <View style={styles.fieldCard}>
          <TextInput
            value={emoji}
            onChangeText={setEmoji}
            // 이모지를 자리표시자로 두면 제 색으로 그려져 「골라 둔 값」처럼 보인다(리뷰 M-2).
            placeholder="＋"
            placeholderTextColor={palette.textMuted}
            accessibilityLabel="상태 이모지"
            accessibilityHint="키보드의 이모지 판에서 고릅니다."
            style={styles.emojiInput}
            testID="status-emoji-input"
          />
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder={CUSTOM_STATUS_TEXT_PLACEHOLDER}
            placeholderTextColor={palette.textMuted}
            accessibilityLabel={CUSTOM_STATUS_TEXT_LABEL}
            maxLength={CUSTOM_STATUS_TEXT_MAX}
            returnKeyType="done"
            style={styles.textInput}
            testID="status-text-input"
          />
        </View>
      </View>

      <GroupSection label="빠른 선택">
        {CUSTOM_STATUS_PRESETS.map((preset, index) => (
          <GroupRow
            key={preset.id}
            title={`${preset.emoji}  ${preset.label}`}
            separated={index > 0}
            onPress={() => {
              setEmoji(preset.emoji);
              setText(preset.label);
            }}
            accessibilityLabel={preset.label}
            accessibilityHint="상태 글을 이것으로 채웁니다."
            testID={`status-preset-${preset.id}`}
          />
        ))}
      </GroupSection>

      <View accessibilityRole="radiogroup" accessibilityLabel="지우기">
        <GroupSection label="지우기">
          {choices.map((id, index) => {
            const selected = id === expiry;
            const label =
              id === 'keep' && seed.storedExpiry !== undefined
                ? `지금대로 · ${statusExpiryShortLabel(seed.storedExpiry, nowMs)}`
                : expiryLabel(id as Exclude<PhoneStatusExpiryChoice, 'keep'>);
            return (
              <GroupRow
                key={id}
                title={label}
                tone={selected ? 'accent' : 'default'}
                separated={index > 0}
                onPress={() => setExpiry(id)}
                accessibilityRole="radio"
                accessibilityState={{selected}}
                accessibilityLabel={label}
                trailing={
                  <Text
                    style={[styles.check, !selected && styles.checkHidden]}
                    importantForAccessibility="no">
                    ✓
                  </Text>
                }
                testID={`status-expiry-${id}`}
              />
            );
          })}
        </GroupSection>
      </View>

      <View style={styles.actions}>
        {failure ? (
          <Sentence
            style={styles.failure}
            accessibilityLiveRegion="polite"
            testID="status-failure">
            {failure}
          </Sentence>
        ) : null}
        <PrimaryButton
          label={CUSTOM_STATUS_SAVE_LABEL}
          busyLabel="저장 중"
          busy={write.isPending}
          onPress={save}
          testID="status-save"
        />
        {seed.hasVisible ? (
          <OutlineButton
            label={CUSTOM_STATUS_CLEAR_LABEL}
            onPress={clear}
            testID="status-clear"
          />
        ) : null}
      </View>
    </View>
  );
}

const buildStyles = (color: Palette) =>
  StyleSheet.create({
    page: {gap: space.xl},
    group: {paddingHorizontal: SAFE_GUTTER},
    fieldCard: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: space.sm,
      padding: space.sm,
      borderRadius: radius.md,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: color.border,
      backgroundColor: color.surface,
    },
    // 이모지 칸은 누르는 자리이자 입력 그릇이다 — 44 정사각, 3:1 테두리.
    emojiInput: {
      width: TOUCH_TARGET,
      height: TOUCH_TARGET,
      borderRadius: TOUCH_TARGET / 2,
      borderWidth: 1,
      borderColor: color.textFaint,
      textAlign: 'center',
      fontSize: font.heading,
      color: color.text,
      padding: 0,
    },
    textInput: {
      flex: 1,
      minHeight: TOUCH_TARGET,
      fontSize: font.body,
      color: color.text,
      paddingHorizontal: space.sm,
    },
    check: {
      fontSize: font.body,
      fontWeight: '700',
      color: color.accentText,
      minWidth: space.lg,
      textAlign: 'center',
    },
    checkHidden: {opacity: 0},
    actions: {paddingHorizontal: SAFE_GUTTER, gap: space.sm},
    failure: {fontSize: font.label, color: color.dangerText, lineHeight: 18},
  });
