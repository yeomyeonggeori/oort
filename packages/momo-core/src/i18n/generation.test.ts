import { describe, expect, it } from 'vitest';
import { compileCatalogs, generate } from './tooling/generate.mjs';
import { fixture, tamperGenerated } from './tooling/fixtures.mjs';

describe('ICU catalog generation and sabotage fixtures', () => {
  it('reproduces committed AST, keys and argument types without a diff', () => {
    expect(() => generate({ check: true })).not.toThrow();
    const output = generate({ check: true });
    expect(Object.keys(output)).toEqual(['en-US.ts', 'ko-KR.ts', 'messages.ts']);
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
