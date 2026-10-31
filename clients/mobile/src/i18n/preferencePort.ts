import type {LocalePreferencePort} from '@momo/core/i18n';
import {createMMKV, type MMKV} from 'react-native-mmkv';
import {readMobileDeviceLocale} from './device';

export const MOBILE_LOCALE_KEY = 'oort.mobile.locale.v1';
let preferences: MMKV | undefined;

/** Dedicated non-secret installation store: no account key, logout or cache-clear path. */
export function createMobileLocalePort(): LocalePreferencePort {
  const store = () => (preferences ??= createMMKV({id: 'oort.mobile.preferences'}));
  return {
    readPreference: () => store().getString(MOBILE_LOCALE_KEY),
    writePreference: preference => store().set(MOBILE_LOCALE_KEY, preference),
    readDevice: readMobileDeviceLocale,
  };
}
