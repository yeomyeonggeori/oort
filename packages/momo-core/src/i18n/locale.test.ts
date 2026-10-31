import { describe, expect, it, vi } from 'vitest';
import {
  createLocalePreferences, isLocalePreference, matchDeviceLocale, resolveLocaleContext,
  supportedLocales, validTimeZone, weekStartForRegion,
  type DeviceLocaleFacts, type LocalePreference, type LocalePreferenceDiagnostic,
} from './index';

describe('ADR-0213 device-local language preferences', () => {
  it('matches all seven IDs in OS order after independent BCP 47 normalization', () => {
    const inputs = ['KO-kr', 'en-GB', 'ja', 'zh-SG', 'zh-HK', 'es-ES', 'fr-CA'];
    expect(inputs.map(tag => matchDeviceLocale([tag]))).toEqual(supportedLocales);
    expect(matchDeviceLocale(['bad_tag', 'de-DE', 'fr-ca', 'ko'])).toBe('fr-FR');
    expect(matchDeviceLocale(['de', 'pt-BR', 'ar'])).toBe('en-US');
    expect(matchDeviceLocale([])).toBe('en-US');
    expect(isLocalePreference('en-GB')).toBe(false);
    expect(isLocalePreference('system')).toBe(true);
  });

  it('gives Chinese script priority over region and defaults bare zh to Hans', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-SG', 'zh-Hans-TW']) expect(matchDeviceLocale([tag])).toBe('zh-Hans');
    for (const tag of ['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-CN']) expect(matchDeviceLocale([tag])).toBe('zh-Hant');
    expect(resolveLocaleContext('system', { languages: ['zh-HK'] }).formatLocale).toBe('zh-Hant-HK');
    expect(resolveLocaleContext('zh-Hans', { languages: [] }).formatLocale).toBe('zh-Hans-CN');
    expect(resolveLocaleContext('zh-Hant', { languages: [] }).formatLocale).toBe('zh-Hant-TW');
  });

  it('preserves device region while explicit language, week and timezone remain independent', () => {
    const facts = { languages: ['en-GB'], timeZone: 'Asia/Seoul' };
    expect(resolveLocaleContext('fr-FR', facts)).toMatchObject({
      messageLocale: 'fr-FR', formatLocale: 'fr-GB', timeZone: 'Asia/Seoul', weekStartsOn: 1,
    });
    expect(resolveLocaleContext('system', { languages: [] }).weekStartsOn).toBe(7);
    expect(resolveLocaleContext('es-419', { languages: [] }).formatLocale).toBe('es-419');
    expect(resolveLocaleContext('system', { ...facts, region: 'US', weekStartsOn: 6, hourCycle: 'h12' }))
      .toMatchObject({ formatLocale: 'en-US', weekStartsOn: 6, hourCycle: 'h12' });
    expect(resolveLocaleContext('system', { ...facts, weekStartsOn: 0 }).weekStartsOn).toBe(1);
    expect(['US', 'KR', 'JP', 'FR', 'CN', 'TW', 'AE', 'AF', 'MV'].map(weekStartForRegion)).toEqual([7, 7, 7, 1, 1, 7, 1, 6, 5]);
    expect(resolveLocaleContext('system', facts, 'America/New_York').timeZone).toBe('America/New_York');
    expect(resolveLocaleContext('system', facts, 'Invalid/Zone').timeZone).toBe('Asia/Seoul');
    expect(resolveLocaleContext('system', { languages: [], timeZone: '+09:00' }).timeZone).toBe('UTC');
    expect(validTimeZone('UTC')).toBe(true);
  });

  it('persists one installation choice across account removal, restart and system resume', async () => {
    let stored: unknown = null;
    let device: DeviceLocaleFacts = { languages: ['ko'], timeZone: 'Asia/Seoul' };
    const port = {
      readPreference: () => stored,
      writePreference: (next: LocalePreference) => { stored = next; },
      readDevice: () => device,
    };
    const preferences = await createLocalePreferences(port);
    const observer = vi.fn();
    const unsubscribe = preferences.subscribe(observer);
    expect(preferences.getSnapshot().context.messageLocale).toBe('ko-KR');
    await preferences.setPreference('ja-JP');
    // Session/account stores are unrelated and have no input into this installation port.
    const accounts = new Map([['first', 'workspace-a'], ['second', 'workspace-b']]);
    accounts.clear();
    const restarted = await createLocalePreferences(port);
    expect(restarted.getSnapshot().preference).toBe('ja-JP');
    device = { languages: ['fr-CA'], timeZone: 'America/Toronto' };
    await preferences.refresh();
    expect(preferences.getSnapshot().context).toMatchObject({ messageLocale: 'ja-JP', timeZone: 'America/Toronto' });
    await preferences.setPreference('system');
    expect(preferences.getSnapshot().context.messageLocale).toBe('fr-FR');
    unsubscribe();
    observer.mockClear();
    await preferences.refresh();
    expect(observer).not.toHaveBeenCalled();
  });

  it('isolates corrupt storage, throwing hosts/observers and redacts diagnostic payloads', async () => {
    const diagnostics: LocalePreferenceDiagnostic[] = [];
    const report = (d: LocalePreferenceDiagnostic) => { diagnostics.push(d); throw new Error('private observer'); };
    const preferences = await createLocalePreferences({
      readPreference: () => 'private unrecognized preference',
      writePreference: () => { throw new Error('private credential'); },
      readDevice: () => { throw new Error('private device'); },
    }, { onDiagnostic: report });
    expect(preferences.getSnapshot()).toMatchObject({ preference: 'system', context: { messageLocale: 'en-US', timeZone: 'UTC' } });
    expect(await preferences.setPreference('ko-KR')).toBe(false);
    expect(await preferences.setPreference('garbage' as LocalePreference)).toBe(false);
    expect(preferences.getSnapshot().preference).toBe('system');
    expect(diagnostics).toEqual([
      { code: 'invalid-preference' }, { code: 'device-read-failed' },
      { code: 'preference-write-failed' }, { code: 'invalid-preference' },
    ]);
    const fallback = await createLocalePreferences({
      readPreference: () => { throw new Error('private'); }, writePreference: () => {}, readDevice: () => ({ languages: [] }),
    }, { onDiagnostic: report });
    expect(fallback.getSnapshot().preference).toBe('system');
    expect(diagnostics.at(-1)).toEqual({ code: 'preference-read-failed' });
  });

  it('serializes asynchronous writes and does not publish until persistence succeeds', async () => {
    let release: () => void = () => {};
    const writes: LocalePreference[] = [];
    const preferences = await createLocalePreferences({
      readPreference: async () => 'system', readDevice: () => ({ languages: ['en'] }),
      writePreference: async next => {
        if (next === 'ko-KR') await new Promise<void>(resolve => { release = resolve; });
        writes.push(next);
      },
    });
    const observer = vi.fn();
    preferences.subscribe(() => { throw new Error('observer'); });
    preferences.subscribe(observer);
    const first = preferences.setPreference('ko-KR');
    const second = preferences.setPreference('fr-FR');
    await Promise.resolve();
    expect(preferences.getSnapshot().preference).toBe('system');
    expect(writes).toEqual([]);
    release();
    await Promise.all([first, second]);
    expect(writes).toEqual(['ko-KR', 'fr-FR']);
    expect(preferences.getSnapshot().preference).toBe('fr-FR');
    expect(observer).toHaveBeenCalledTimes(2);
  });
});
