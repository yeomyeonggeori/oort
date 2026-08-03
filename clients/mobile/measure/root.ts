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
export type MeasureMode =
  | {kind: 'measure'}
  | {kind: 'states'}
  /** One of goal RN-C5's action/search surfaces — see `measure/surfaces.tsx`. */
  | {kind: 'surface'; name: string}
  | null;

/**
 * Anything that is neither `YES` nor `STATES` names a SURFACE. Adding a
 * screenshot therefore costs a case in `surfaces.tsx` and nothing here, which is
 * deliberate: the list of screens worth reviewing grows faster than this
 * function should.
 */
export function measureMode(): MeasureMode {
  if (!__DEV__) return null;
  const value = Settings.get('momoMeasure');
  if (value === 'YES' || value === true || value === 1 || value === '1') {
    return {kind: 'measure'};
  }
  if (typeof value !== 'string' || value === '') return null;
  const normalized = value.toLowerCase();
  if (normalized === 'states') return {kind: 'states'};
  return {kind: 'surface', name: normalized};
}
