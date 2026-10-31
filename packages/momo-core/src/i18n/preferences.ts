import { isLocalePreference, resolveLocaleContext } from './locale';
import type { DeviceLocaleFacts, LocaleContext, LocalePreference } from './locale';

export interface LocalePreferenceDiagnostic {
  code: 'preference-read-failed' | 'preference-write-failed' | 'invalid-preference' | 'device-read-failed';
}

/** P0-3/4 implement once per installation; never key or clear this store by session/account. */
export interface LocalePreferencePort {
  readPreference(): unknown | Promise<unknown>;
  writePreference(preference: LocalePreference): void | Promise<void>;
  readDevice(): DeviceLocaleFacts;
}

export interface LocalePreferenceSnapshot {
  readonly preference: LocalePreference;
  readonly context: LocaleContext;
}

export interface LocalePreferences {
  getSnapshot(): LocalePreferenceSnapshot;
  /** Persist first; false leaves the last successfully stored choice active. */
  setPreference(preference: LocalePreference): Promise<boolean>;
  /** P0-3/4 call on app resume/OS changes; explicit language still refreshes regional facts. */
  refresh(): Promise<void>;
  /** P0-3/4 load catalogs before committing the new context to the rendered locale service. */
  subscribe(listener: (snapshot: LocalePreferenceSnapshot) => void): () => void;
}

/** P0-3/4 await this before first render/html lang; retain it across every account switch. */
export async function createLocalePreferences(
  port: LocalePreferencePort,
  options: { explicitTimeZone?: string; onDiagnostic?: (diagnostic: LocalePreferenceDiagnostic) => void } = {},
): Promise<LocalePreferences> {
  const diagnostic = (code: LocalePreferenceDiagnostic['code']) => {
    try { options.onDiagnostic?.({ code }); } catch { /* Observers cannot break preferences. */ }
  };
  let preference: LocalePreference = 'system';
  try {
    const stored = await port.readPreference();
    if (isLocalePreference(stored)) preference = stored;
    else if (stored !== null && stored !== undefined) diagnostic('invalid-preference');
  } catch { diagnostic('preference-read-failed'); }
  const resolve = () => {
    let device: DeviceLocaleFacts;
    try { device = port.readDevice(); }
    catch { diagnostic('device-read-failed'); device = { languages: [] }; }
    return Object.freeze({ preference, context: resolveLocaleContext(preference, device, options.explicitTimeZone) });
  };
  let snapshot = resolve();
  const listeners = new Set<(snapshot: LocalePreferenceSnapshot) => void>();
  const publish = () => {
    snapshot = resolve();
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* A host observer is isolated from all others. */ }
    }
  };
  // Async stores (and rapid taps) cannot persist an older choice after a newer one.
  let pending: Promise<unknown> = Promise.resolve();
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    const result = pending.then(work);
    pending = result.catch(() => {});
    return result;
  };
  return {
    getSnapshot: () => snapshot,
    setPreference: next => enqueue(async () => {
      if (!isLocalePreference(next)) { diagnostic('invalid-preference'); return false; }
      try { await port.writePreference(next); }
      catch { diagnostic('preference-write-failed'); return false; }
      preference = next;
      publish();
      return true;
    }),
    refresh: () => enqueue(async () => { publish(); }),
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
