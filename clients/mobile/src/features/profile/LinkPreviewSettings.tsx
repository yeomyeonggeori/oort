import type {UnfurlSize} from '@momo/core/features/timeline/unfurl';
import type {MessageKey} from '@momo/core/i18n/generated/messages';
import React from 'react';
import {ScrollView, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';

import {Screen} from '../../design/atoms';
import {PageHeader} from '../../design/SheetChrome';
import {ChoiceRow, GroupCard, ListRow} from '../../design/sheetParts';
import {useStyles} from '../../design/theme';
import {SAFE_GUTTER, space} from '../../design/tokens';
import {useFormatMessage} from '../../i18n/useFormatMessage';
import {
  LINK_PREVIEW_CHOICES,
  setLinkPreviewPreference,
  useLinkPreviewPreference,
} from '../conversation/linkPreviewPreference';
import {useLayerClose} from '../../nav/EdgeSwipeBack';
import {SettingsNote, SettingsSection} from './settingsRows';

// =============================================================================
// 설정 › 보기 › 링크 미리보기: 작게 · 크게 · 끄기 (#4883, owner 2026-10-31).
//
// 웹 설정(`AppearanceSection`)과 **같은 값 이름·같은 기본값(작게)·같은 낱말**이다 — 낱말은 사전 키
// `settings.appearance.linkPreview*` 를 그대로 쓰고, 폰 모양을 설명하는 두 줄(`mobile.linkPreview.*Hint`)만 폰의 것이다.
// 이 기기에서만 적용되고 서버·다른 멤버 화면과 무관하다. 고르면 열려 있는 대화의 카드가 바로 따라간다
// (`useLinkPreviewPreference` 구독).
//
// 모양은 `LanguageSettings` 와 같다: 설정 페이지 위에 한 겹 더 쌓이는 장이고, 머리의 ‹ 와 왼쪽 가장자리 밀기와
// VoiceOver escape 가 한 겹만 벗긴다. 고른 줄은 강조색 · 굵게 · ✓ 셋이 함께 바뀐다(`ChoiceRow`).
// =============================================================================

// 낱말은 키로만 적는다(직접 문구 장부). `satisfies` 가 코어 크기와 이 표가 갈라지면 컴파일을 멈춘다.
const LABEL_KEY = {
  compact: 'settings.appearance.linkPreviewCompact',
  rich: 'settings.appearance.linkPreviewRich',
  off: 'settings.appearance.linkPreviewOff',
} as const satisfies Record<UnfurlSize, MessageKey>;

const HINT_KEY = {
  compact: 'mobile.linkPreview.compactHint',
  rich: 'mobile.linkPreview.richHint',
  off: 'settings.appearance.linkPreviewOffHint',
} as const satisfies Record<UnfurlSize, MessageKey>;

// 시험 이름은 JSX 밖에서 짓는다 — 직접 문구 장부는 JSX 식 안의 문자열을 문구로 세므로, 이름표가 장부를 올리지 않게 한다.
const BACK_TEST_ID = 'settings-back';
const choiceTestId = (option: UnfurlSize) => `link-preview-${option}`;

/** 「보기」 카드의 한 행 — 지금 고른 낱말이 오른쪽 값이다. */
export function LinkPreviewSettingRow({onPress}: {onPress: () => void}): React.JSX.Element {
  const formatMessage = useFormatMessage();
  const choice = useLinkPreviewPreference();
  const title = formatMessage('mobile.linkPreview.title');
  const value = formatMessage(LABEL_KEY[choice]);
  return (
    <ListRow
      accessibilityLabel={`${title}, ${value}`}
      accessory="chevron"
      onPress={onPress}
      testID="settings-link-preview-row"
      title={title}
      value={value}
    />
  );
}

export function LinkPreviewSettingsPage({onBack}: {onBack: () => void}): React.JSX.Element {
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
  const formatMessage = useFormatMessage();
  const choice = useLinkPreviewPreference();
  const goBack = closeLayer ?? onBack;
  const title = formatMessage('mobile.linkPreview.title');
  return (
    <View onAccessibilityEscape={goBack} style={styles.root} testID="settings-link-preview-page">
      <Screen>
        <PageHeader
          back={{
            label: formatMessage('mobile.locale.backToSettings'),
            onPress: goBack,
            testID: BACK_TEST_ID,
          }}
          testID="settings-sub-header"
          title={title}
          titleTestID="settings-sub-title"
        />
        <ScrollView
          contentContainerStyle={[
            styles.content,
            {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg},
          ]}>
          <SettingsSection>
            <GroupCard>
              <View accessibilityLabel={title} accessibilityRole="radiogroup">
                {LINK_PREVIEW_CHOICES.map(option => (
                  <ChoiceRow
                    detail={formatMessage(HINT_KEY[option])}
                    key={option}
                    onPress={() => setLinkPreviewPreference(option)}
                    selected={choice === option}
                    testID={choiceTestId(option)}
                    title={formatMessage(LABEL_KEY[option])}
                  />
                ))}
              </View>
            </GroupCard>
            <SettingsNote>{formatMessage('mobile.linkPreview.scopeNote')}</SettingsNote>
          </SettingsSection>
        </ScrollView>
      </Screen>
    </View>
  );
}

const buildStyles = () =>
  StyleSheet.create({
    root: {flex: 1},
    content: {paddingTop: space.md, paddingHorizontal: SAFE_GUTTER, gap: space.lg},
  });
