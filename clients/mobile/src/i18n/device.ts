import type {DeviceLocaleFacts, HourCycle} from '@momo/core/i18n';
import {AppState, I18nManager, Platform, Settings} from 'react-native';

const LOCALE_SETTINGS = [
  'AppleLanguages', 'AppleLocale', 'AppleICUForce12HourTime', 'AppleICUForce24HourTime',
];

/** RN's Settings observes NSUserDefaults changes, including while the app is active. */
export function readMobileDeviceLocale(): DeviceLocaleFacts {
  const ios = Platform.OS === 'ios';
  const appleLanguages: unknown = ios ? Settings.get('AppleLanguages') : undefined;
  const appleLocale: unknown = ios ? Settings.get('AppleLocale') : undefined;
  const regionTag = typeof appleLocale === 'string'
    ? appleLocale.split('@')[0].replace(/_/g, '-') : undefined;
  const nativeTag = I18nManager.getConstants().localeIdentifier;
  const languages = Array.isArray(appleLanguages)
    ? appleLanguages.filter((value): value is string => typeof value === 'string')
    : [];
  if (languages.length === 0) {
    const tag = regionTag ?? nativeTag ?? new Intl.DateTimeFormat().resolvedOptions().locale;
    if (tag) languages.push(tag.replace(/_/g, '-'));
  }
  const regional = new Intl.DateTimeFormat(undefined, {hour: 'numeric'}).resolvedOptions();
  const hourCycle: HourCycle | undefined = ios && Settings.get('AppleICUForce24HourTime') === true
    ? 'h23' : ios && Settings.get('AppleICUForce12HourTime') === true
      ? 'h12' : regional.hourCycle;
  return {
    languages,
    region: regionTag?.split('-').slice(1).find(part => /^[A-Z]{2}$|^\d{3}$/.test(part)),
    timeZone: regional.timeZone,
    hourCycle,
  };
}

/** One installation-wide subscription, unrelated to accounts or workspaces. */
export function subscribeMobileLocaleChanges(onChange: () => void): () => void {
  const appState = AppState.addEventListener('change', next => {
    if (next === 'active') onChange();
  });
  const watch = Platform.OS === 'ios' ? Settings.watchKeys(LOCALE_SETTINGS, onChange) : undefined;
  return () => {
    appState.remove();
    if (watch !== undefined) Settings.clearWatch(watch);
  };
}
