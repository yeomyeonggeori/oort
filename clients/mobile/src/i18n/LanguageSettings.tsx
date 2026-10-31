import {localeAutonyms} from '@momo/core/i18n/autonyms';
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

const CATALOG_LOCALES = ['ko-KR', 'en-US'] as const;

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

/** Same page stack, back/escape behavior and growing radio rows as the existing theme page. */
export function LanguageSettingsPage({onBack}: {onBack: () => void}): React.JSX.Element | null {
  const current = useMobileLocale();
  const styles = useStyles(buildStyles);
  const palette = usePalette();
  const insets = useSafeAreaInsets();
  const closeLayer = useLayerClose();
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
    try {
      if (!(await controller.setPreference(next))) setFailedChoice(next);
    } catch { setFailedChoice(next); }
    finally { busy.current = false; setPending(false); }
  };
  const goBack = closeLayer ?? onBack;
  const label = locale.formatMessage('settings.profile.languageLabel');
  const beta = locale.formatMessage('settings.profile.languageBeta');
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
          <SettingsSection>
            <GroupCard>
              <View accessibilityRole="radiogroup" accessibilityLabel={label} accessibilityState={{busy: pending}}>
                <ChoiceRow
                  title={locale.formatMessage('settings.profile.languageSystem')}
                  accessibilityLanguage={effectiveLocale}
                  selected={preference === 'system'}
                  disabled={pending}
                  onPress={() => { void choose('system'); }}
                  testID="language-system"
                />
                {CATALOG_LOCALES.map(id => (
                  <ChoiceRow
                    key={id}
                    title={localeAutonyms[id]}
                    // The spoken label carries the on-screen beta tag too, not only the autonym.
                    accessibilityLabel={`${localeAutonyms[id]}, ${beta}`}
                    accessibilityLanguage={id}
                    detail={beta}
                    selected={preference === id}
                    disabled={pending}
                    onPress={() => { void choose(id); }}
                    testID={`language-${id}`}
                  />
                ))}
              </View>
            </GroupCard>
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
            <SettingsNote>{locale.formatMessage('settings.profile.languageCurrent', {languageName: localeAutonyms[effectiveLocale]})}</SettingsNote>
            <SettingsNote>{locale.formatMessage('settings.profile.languageHint')}</SettingsNote>
            <SettingsNote>{locale.formatMessage('settings.profile.languagePartialNotice')}</SettingsNote>
            <SettingsNote>{locale.formatMessage('mobile.locale.permissionNotice')}</SettingsNote>
          </SettingsSection>
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
