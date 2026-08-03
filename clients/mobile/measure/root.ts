import {Settings} from 'react-native';

/**
 * Is this process a measurement run?
 *
 * Answered from the LAUNCH ARGUMENT `-momoMeasure YES`, which iOS places in
 * NSUserDefaults' argument domain and React Native's `Settings` module reads
 * back. Nothing persists: the next launch without the argument is the app.
 *
 * `__DEV__` gates it as well, so a release build cannot be talked into the
 * harness by anyone who can pass it arguments.
 */
export type MeasureMode = 'measure' | 'states' | null;

export function measureMode(): MeasureMode {
  if (!__DEV__) return null;
  const value = Settings.get('momoMeasure');
  if (value === 'STATES' || value === 'states') return 'states';
  if (value === 'YES' || value === true || value === 1 || value === '1') {
    return 'measure';
  }
  return null;
}
