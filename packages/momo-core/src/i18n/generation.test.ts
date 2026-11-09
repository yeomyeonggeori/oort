import { describe, expect, it } from 'vitest';
import { createIntl, createIntlCache } from '@formatjs/intl';
import { COMPLETE_LOCALES, DRAFT_LOCALES, compileCatalogs, generate } from './tooling/generate.mjs';
import { fixture, productFeatures, removeLocale, tamperGenerated, writeFeature } from './tooling/fixtures.mjs';
import { createMessageService } from './service';
import { loadMessageCatalog } from './catalogs';
import { supportedLocales } from './locale';
import type { MessageDiagnostic } from './types';

describe('ICU catalog generation and sabotage fixtures', () => {
  it('reproduces committed AST, keys and argument types without a diff', () => {
    expect(() => generate({ check: true })).not.toThrow();
    const output = generate({ check: true });
    expect(Object.keys(output)).toEqual(['en-US.ts', 'ko-KR.ts', 'ja-JP.ts', 'zh-Hans.ts', 'zh-Hant.ts', 'es-419.ts', 'fr-FR.ts', 'messages.ts']);
    expect(output['en-US.ts']).not.toMatch(/location|parse\(/);
  });

  it('rejects duplicate JSON keys before JSON.parse can overwrite them', () => {
    fixture((root, write) => {
      write('en-US', '{"sample.surface.label":"First","sample.surface.label":"Last"}');
      expect(() => compileCatalogs(root)).toThrow(/duplicate key/);
    });
  });

  it('rejects missing keys, empty catalogs, blank values and invalid key namespaces', () => {
    fixture((root, write) => {
      const cases: Record<string, string>[] = [
        { 'sample.surface.extra': 'Extra' }, {}, { 'sample.surface.label': ' \n ' },
        { 'wrong.surface.label': 'Sample' }, { 'sample.label': 'Sample' },
      ];
      for (const source of cases) {
        write('en-US', source);
        expect(() => compileCatalogs(root)).toThrow();
      }
    });
  });

  it('rejects invalid ICU, plural without other, and unapproved rich text', () => {
    fixture((root, write) => {
      for (const source of ['{count, plural, one {one}}', '{unclosed', '<b>Unsafe</b>', '{bad_name}']) {
        write('en-US', { 'sample.surface.label': source });
        expect(() => compileCatalogs(root)).toThrow();
      }
    });
  });

  it('rejects renamed and incompatible arguments including nested branch arguments', () => {
    fixture((root, write) => {
      for (const [en, ko] of [
        ['Hello {actorName}', '안녕 {name}'],
        ['{count, number}', '{count, date}'],
        ['{count, plural, other {{actorName}}}', '{count, number}'],
        ['{count, number} {count, date}', '{count}'],
      ]) {
        write('en-US', { 'sample.surface.label': en });
        write('ko-KR', { 'sample.surface.label': ko });
        expect(() => compileCatalogs(root)).toThrow(/argument|conflicting/);
      }
    });
  });

  it('infers numeric bare placeholders across languages and traverses select/date/ordinal branches', () => {
    fixture((root, write) => {
      write('en-US', { 'sample.surface.label': '{mode, select, full {{count, selectordinal, one {#st} other {#th}} {at, date}} other {{actorName}}}' });
      write('ko-KR', { 'sample.surface.label': '{mode, select, full {{count} {at, time}} other {{actorName}}}' });
      expect(compileCatalogs(root).args['sample.surface.label']).toEqual({ actorName: 'string', at: 'date', count: 'number', mode: 'string' });
      // Valid semantic names must not inherit Object.prototype and corrupt generated TypeScript.
      for (const locale of ['en-US', 'ko-KR']) {
        write(locale, { 'sample.surface.label': '{constructor} {toString} {hasOwnProperty}' });
      }
      expect(compileCatalogs(root).args['sample.surface.label']).toEqual({ constructor: 'string', hasOwnProperty: 'string', toString: 'string' });
      const generated = generate({ catalogRoot: root, outputRoot: `${root}/generated` });
      expect(generated['messages.ts']).toContain('constructor: string; hasOwnProperty: string; toString: string');
      expect(generated['messages.ts']).not.toContain('[native code]');
    });
  });

  it('detects a stale generated AST in an isolated output directory', () => {
    fixture((root) => {
      const outputRoot = `${root}/generated`;
      generate({ catalogRoot: root, outputRoot });
      tamperGenerated(outputRoot);
      expect(() => generate({ catalogRoot: root, outputRoot, check: true })).toThrow(/Stale generated/);
    });
  });
});

describe('seven-language catalog skeleton (#5589, ADR-0213 §2)', () => {
  it('has catalog files for every ADR-0213 language, mirroring the en-US features', () => {
    expect([...COMPLETE_LOCALES, ...DRAFT_LOCALES].sort()).toEqual([...supportedLocales].sort());
    const features = productFeatures('en-US');
    expect(features?.length).toBeGreaterThan(10);
    for (const locale of supportedLocales) expect(productFeatures(locale)).toEqual(features);
  });

  it('shows English for a key a draft language does not have yet, and reports it', async () => {
    for (const locale of DRAFT_LOCALES) {
      const diagnostics: MessageDiagnostic[] = [];
      const catalog = await loadMessageCatalog(locale);
      const service = createMessageService({ messageLocale: locale, catalog, onDiagnostic: entry => diagnostics.push(entry) });
      expect(service.formatMessage('common.members.count', { count: 2 })).toBe('2 members');
      expect(service.formatMessage('settings.profile.languageLabel')).toBe('Language');
      expect(diagnostics).toContainEqual({ code: 'missing-message', key: 'common.members.count' });
    }
  });

  it('uses a draft translation where it exists and English beside it (fixture, not the product catalogs)', () => {
    fixture((root, write) => {
      write('en-US', { 'sample.surface.label': 'Sample', 'sample.surface.other': 'Other' });
      write('ko-KR', { 'sample.surface.label': '예시', 'sample.surface.other': '다른 것' });
      write('fr-FR', { 'sample.surface.label': 'Exemple', 'sample.surface.other': '' });
      const { catalogs } = compileCatalogs(root);
      expect(Object.keys(catalogs['fr-FR'])).toEqual(['sample.surface.label']);
      expect(catalogs['ja-JP']).toEqual({});
    });
  });

  it('rejects a draft key that en-US lacks, renamed arguments, and missing draft files', () => {
    fixture((root, write) => {
      write('fr-FR', { 'sample.surface.extra': 'En trop' });
      expect(() => compileCatalogs(root)).toThrow(/not an en-US key/);
      write('en-US', { 'sample.surface.label': 'Hello {actorName}' });
      write('ko-KR', { 'sample.surface.label': '안녕 {actorName}' });
      write('fr-FR', { 'sample.surface.label': 'Bonjour {name}' });
      expect(() => compileCatalogs(root)).toThrow(/argument names differ/);
      write('fr-FR', { 'sample.surface.label': '{actorName, date}' });
      expect(() => compileCatalogs(root)).toThrow(/conflicting/);
      write('fr-FR', {});
      expect(() => compileCatalogs(root)).not.toThrow();
      writeFeature(root, 'en-US', 'second.json', { 'second.surface.label': 'Second' });
      writeFeature(root, 'ko-KR', 'second.json', { 'second.surface.label': '둘째' });
      expect(() => compileCatalogs(root)).toThrow(/mirror en-US/);
      for (const locale of DRAFT_LOCALES) writeFeature(root, locale, 'second.json', {});
      expect(() => compileCatalogs(root)).not.toThrow();
      expect(removeLocale(root, 'es-419')).toBe(false);
      expect(() => compileCatalogs(root)).toThrow(/es-419: catalog directory is missing/);
    });
  });

  it('compiles ICU plural (one/many/other), number and date for the drafts with CLDR rules per language', () => {
    fixture((root, write) => {
      const source = (one: string, other: string) => `{count, plural, one {# ${one}} other {# ${other}}} · {total, number} · {at, date, medium}`;
      write('en-US', { 'sample.surface.label': source('message', 'messages') });
      write('ko-KR', { 'sample.surface.label': '메시지 {count}개 · {total, number} · {at, date, medium}' });
      write('fr-FR', { 'sample.surface.label': '{count, plural, one {# message} many {# de messages} other {# messages}} · {total, number} · {at, date, medium}' });
      write('es-419', { 'sample.surface.label': '{count, plural, one {# mensaje} many {# de mensajes} other {# mensajes}} · {total, number} · {at, date, medium}' });
      write('ja-JP', { 'sample.surface.label': 'メッセージ{count}件 · {total, number} · {at, date, medium}' });
      const { catalogs, args } = compileCatalogs(root);
      expect(args['sample.surface.label']).toEqual({ at: 'date', count: 'number', total: 'number' });
      const at = Date.UTC(2026, 10, 9, 3);
      const format = (locale: string, count: number) => createIntl({
        locale, messages: catalogs[locale], timeZone: 'UTC', onError: (error) => { throw error; },
      }, createIntlCache()).formatMessage({ id: 'sample.surface.label' }, { count, total: 12345.5, at });
      expect(format('fr-FR', 1)).toMatch(/^1 message · 12\s345,5 · 9 nov\. 2026$/);
      expect(format('fr-FR', 0)).toMatch(/^0 message /);
      expect(format('fr-FR', 1_000_000)).toMatch(/^1\s000\s000 de messages /);
      expect(format('es-419', 1_000_000)).toMatch(/de mensajes/);
      expect(format('es-419', 2)).toMatch(/^2 mensajes /);
      expect(format('ja-JP', 1)).toBe('メッセージ1件 · 12,345.5 · 2026年11月9日');
    });
  });
});
