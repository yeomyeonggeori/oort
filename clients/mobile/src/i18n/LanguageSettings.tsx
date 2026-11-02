import {localeAutonyms} from '@momo/core/i18n/autonyms';
import {languageChoices} from '@momo/core/i18n/choices';
import type {LocalePreference} from '@momo/core/i18n/locale';
import React, {useRef, useState} from 'react';
import {ActivityIndicator, ScrollView, StyleSheet, View} from 'react-native';
import {useSafeAreaInsets} from 'react-native-safe-area-context';
import {Screen} from '../design/atoms';
import {PageHeader} from '../design/SheetChrome';
import {ChoiceRow, GroupCard, ListRow} from '../design/sheetParts';
import {usePalette, useStyles} from '../design/theme';
import {SAFE_GUTTER, space} from '../design/tokens';
import {ActionRow, SettingsNote, SettingsSection} from '../features/profile/settingsRows';
import {useLayerClose} from '../nav/EdgeSwipeBack';
import {useMobileLocale} from './LocaleProvider';

/** 사전이 있는 언어. 설정 페이지와 첫 화면의 언어 칩(`LanguageChip`)이 같은 목록을 쓴다. */
export const CATALOG_LOCALES = ['ko-KR', 'en-US'] as const;

export function LanguageSettingRow({onPress}: {onPress: () => void}): React.JSX.Element | null {
  const current = useMobileLocale();
  if (!current) return null;
  const {locale, preference, effectiveLocale} = current;
  return (
    <ListRow
      title={locale.formatMessage('settings.profile.languageLabel')}
      value={preference === 'system' ? locale.formatMessage('settings.profile.languageSystem') : localeAutonyms[effectiveLocale]}
      accessibilityHint={locale.formatMessage('settings.profile.languageHint')}
      accessory="chevron"
      onPress={onPress}
      testID="settings-language-row"
    />
  );
}

/**
 * 고르는 목록(기기 언어 + 사전이 있는 언어)과 그 상태(저장 중·실패와 다시 시도·영어 UI의 한 줄). 설정 페이지와 첫 화면의
 * 언어 시트(#4670)가 **이 한 부품**을 같이 쓴다: 같은 컨트롤러의 같은 `setPreference`, 같은 저장소, 같은 목록
 * (코어 `languageChoices`)이라 첫 화면에서 고른 언어가 설정에서 그대로 보인다. `onChosen`은 저장이 **성공했을 때만** 불린다.
 */
export function LanguageChoices({onChosen}: {onChosen?: () => void}): React.JSX.Element | null {
  const current = useMobileLocale();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const [failedChoice, setFailedChoice] = useState<LocalePreference | null>(null);
  if (!current) return null;
  const {locale, preference, effectiveLocale, controller} = current;
  const choose = async (next: LocalePreference) => {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailedChoice(null);
    let saved = false;
    try {
      saved = await controller.setPreference(next);
      if (!saved) setFailedChoice(next);
    } catch { setFailedChoice(next); }
    finally { busy.current = false; setPending(false); }
    if (saved) onChosen?.();
  };
  const label = locale.formatMessage('settings.profile.languageLabel');
  // The one note left (owner 10-31, #4936) belongs to the English UI, whatever got it there: an explicit choice, system on an
  // English device, or system on a language the app has no catalog for (it falls back to English).
  const englishUi = effectiveLocale === 'en-US';
  return (
    <SettingsSection>
      {/* The radiogroup role belongs OUTSIDE the card (#5101, same shape as ExpressionPhotoForm's branch picker): GroupCard draws a
          divider between its children, so a role wrapper inside it leaves the card one child and no divider between the rows. */}
      <View accessibilityRole="radiogroup" accessibilityLabel={label} accessibilityState={{busy: pending}} testID="language-radiogroup">
        <GroupCard>
          {languageChoices(CATALOG_LOCALES).map(choice => (
            // No beta tag, on screen or spoken (owner 10-31, #4936): the row is just the autonym.
            <ChoiceRow
              key={choice.preference}
              title={choice.system ? locale.formatMessage('settings.profile.languageSystem') : (choice.autonym ?? '')}
              accessibilityLanguage={choice.system ? effectiveLocale : choice.preference}
              selected={preference === choice.preference}
              disabled={pending}
              onPress={() => { void choose(choice.preference); }}
              testID={`language-${choice.preference}`}
            />
          ))}
        </GroupCard>
      </View>
      {pending ? (
        <View style={styles.pending} accessibilityLiveRegion="polite">
          <ActivityIndicator color={palette.textMuted} />
          <SettingsNote>{locale.formatMessage('mobile.locale.saving')}</SettingsNote>
        </View>
      ) : null}
      {failedChoice !== null ? (
        <>
          <SettingsNote tone="danger">{locale.formatMessage('settings.profile.languageLoadError')}</SettingsNote>
          <GroupCard>
            <ActionRow title={locale.formatMessage('settings.profile.languageRetry')} onPress={() => { void choose(failedChoice); }} />
          </GroupCard>
        </>
      ) : null}
      {/* The only note left: while the UI is English, some screens are still Korean. The Korean UI has none. */}
      {englishUi ? (
        <SettingsNote testID="language-partial-notice">{locale.formatMessage('settings.profile.languagePartialNotice')}</SettingsNote>
      ) : null}
    </SettingsSection>
  );
}

/** Same page stack, back/escape behavior and growing radio rows as the existing theme page. */
export function LanguageSettingsPage({onBack}: {onBack: () => void}): React.JSX.Element | null {
  const current = useMobileLocale();
  const styles = useStyles(buildStyles);
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
  if (!current) return null;
  const {locale} = current;
  const goBack = closeLayer ?? onBack;
  const label = locale.formatMessage('settings.profile.languageLabel');
  return (
    <View style={styles.root} onAccessibilityEscape={goBack} testID="settings-language-page">
      <Screen>
        <PageHeader
          title={label}
          back={{label: locale.formatMessage('mobile.locale.backToSettings'), onPress: goBack, testID: 'settings-back'}}
          titleTestID="settings-sub-title"
          testID="settings-sub-header"
        />
        <ScrollView contentContainerStyle={[styles.content, {paddingBottom: Math.max(insets.bottom, space.lg) + space.lg}]}>
          <LanguageChoices />
        </ScrollView>
      </Screen>
    </View>
  );
}

const buildStyles = () => StyleSheet.create({
  root: {flex: 1},
  content: {paddingTop: space.md, paddingHorizontal: SAFE_GUTTER, gap: space.lg},
  pending: {alignItems: 'flex-start', gap: space.sm},
});
