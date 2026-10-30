import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
  createMessageService, loadMessageCatalog, messageKeys, SAFE_MESSAGE,
  type MessageDiagnostic, type MessageService, type MessageCatalog, type MessageArgs,
} from './index';

describe('ADR-0213 compiled message service', () => {
  it('loads both nonempty catalogs and renders real ko/en copy and plural boundaries', async () => {
    const ko = createMessageService({ messageLocale: 'ko-KR', catalog: await loadMessageCatalog('ko-KR') });
    const en = createMessageService({ messageLocale: 'en-US' });
    expect(messageKeys.length).toBeGreaterThan(0);
    expect(new Set(messageKeys).size).toBe(messageKeys.length);
    expect(messageKeys).toContain('desktop.menu.edit');
    for (const locale of ['en-US', 'ko-KR'] as const) {
      expect(Object.keys(await loadMessageCatalog(locale)).sort()).toEqual([...messageKeys].sort());
    }
    expect(ko.formatMessage('settings.profile.languageLabel')).toBe('언어');
    expect(en.formatMessage('settings.profile.languageLabel')).toBe('Language');
    expect(ko.formatMessage('settings.profile.languageCurrent', { languageName: 'English' })).toBe('현재 언어: English');
    for (const count of [0, 1, 2, 1.5, 1_000_000]) {
      const number = new Intl.NumberFormat('en-US').format(count);
      expect(en.formatMessage('common.members.count', { count })).toBe(`${number} ${count === 1 ? 'member' : 'members'}`);
      expect(ko.formatMessage('common.members.count', { count })).toBe(`${number}명`);
    }
  });

  it('keeps user values literal without interpreting HTML, ICU or Korean particles', async () => {
    const actorName = '<b>{count, plural, other {secret}}</b>';
    for (const locale of ['en-US', 'ko-KR'] as const) {
      const service = createMessageService({ messageLocale: locale, catalog: await loadMessageCatalog(locale) });
      expect(service.formatMessage('common.invitation.received', { actorName })).toBe(
        locale === 'en-US' ? `${actorName} invited you.` : `${actorName} 님이 초대했어요.`,
      );
    }
  });

  it('falls through missing, blank and broken selected ASTs to English', () => {
    const key = 'settings.profile.languageLabel';
    const cases: MessageCatalog[] = [
      {}, { [key]: [] }, { [key]: [{ type: 0, value: '  ' }] },
      { [key]: [{ type: 1, value: 'missingValue' }] },
    ];
    for (const catalog of cases) {
      const diagnostics: MessageDiagnostic[] = [];
      const service = createMessageService({ messageLocale: 'ko-KR', catalog, onDiagnostic: d => diagnostics.push(d) });
      expect(service.formatMessage(key)).toBe('Language');
      expect(diagnostics.length).toBeGreaterThan(0);
    }
    expect(createMessageService({ messageLocale: 'ja-JP' }).formatMessage(key)).toBe('Language');
  });

  it('uses a catalog-independent safe message and redacts diagnostics for invalid runtime calls', () => {
    const diagnostics: MessageDiagnostic[] = [];
    const service = createMessageService({ messageLocale: 'ko-KR', catalog: {}, fallbackCatalog: {}, onDiagnostic: d => diagnostics.push(d) });
    expect(service.formatMessage('settings.profile.languageLabel')).toBe(SAFE_MESSAGE);
    // These calls represent stale/untyped adapters; they must also be safe in production.
    // @ts-expect-error Unknown IDs are compile errors, including prototype names.
    expect(service.formatMessage('private.secret')).toBe(SAFE_MESSAGE);
    // @ts-expect-error Prototype names are not registered keys.
    expect(service.formatMessage('toString')).toBe(SAFE_MESSAGE);
    // @ts-expect-error Missing semantic argument.
    expect(service.formatMessage('common.members.count')).toBe(SAFE_MESSAGE);
    // @ts-expect-error Wrong numeric type; the private value must not reach diagnostics.
    expect(service.formatMessage('common.members.count', { count: 'private-value' })).toBe(SAFE_MESSAGE);
    expect(service.formatMessage('common.members.count', { count: NaN })).toBe(SAFE_MESSAGE);
    expect(service.formatMessage('common.members.count', { count: Infinity })).toBe(SAFE_MESSAGE);
    // @ts-expect-error Extra arguments cannot be reused as another template.
    expect(service.formatMessage('settings.profile.languageLabel', { secret: 'private-value' })).toBe(SAFE_MESSAGE);
    expect(JSON.stringify(diagnostics)).not.toMatch(/private|value|Error|stack/);
    expect(diagnostics).toContainEqual({ code: 'unknown-key' });
    expect(diagnostics).toContainEqual({ code: 'invalid-arguments', key: 'common.members.count' });
  });

  it('survives a throwing diagnostic observer and discards old service formatter caches', async () => {
    const broken = createMessageService({ messageLocale: 'ko-KR', fallbackCatalog: {}, onDiagnostic: () => { throw new Error('private observer error'); } });
    expect(broken.formatMessage('settings.profile.languageLabel')).toBe(SAFE_MESSAGE);
    const first = createMessageService({ messageLocale: 'ko-KR', catalog: await loadMessageCatalog('ko-KR') });
    const next = createMessageService({ messageLocale: 'en-US' });
    expect(next.formatMessage('settings.profile.languageLabel')).toBe('Language');
    expect(first.formatMessage('settings.profile.languageLabel')).toBe('언어');
  });

  it('fails safely when the host has not initialized Intl.PluralRules (not Hermes execution evidence)', () => {
    const missing = vi.spyOn(Intl, 'PluralRules').mockImplementation(() => { throw new Error('host Intl missing'); });
    try {
      const service = createMessageService({ messageLocale: 'en-US' });
      expect(service.formatMessage('common.members.count', { count: 2 })).toBe(SAFE_MESSAGE);
      expect(service.formatMessage('settings.profile.languageLabel')).toBe('Language');
    } finally { missing.mockRestore(); }
  });

  it('exposes typed public keys and required semantic arguments', () => {
    expectTypeOf<MessageArgs['common.members.count']>().toEqualTypeOf<{ count: number }>();
    expectTypeOf<MessageArgs['common.invitation.received']>().toEqualTypeOf<{ actorName: string }>();
    const checkTypes = (service: MessageService) => {
      service.formatMessage('common.members.count', { count: 1 });
      // @ts-expect-error Wrong argument name.
      service.formatMessage('common.invitation.received', { name: 'Alex' });
      // @ts-expect-error Parameter-free message rejects arbitrary values.
      service.formatMessage('settings.profile.languageLabel', { count: 1 });
    };
    expectTypeOf(checkTypes).toBeFunction();
  });
});
