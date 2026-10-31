import {describe, expect, it} from 'vitest';
import type {MessageFormatElement} from '@formatjs/icu-messageformat-parser';
import {parse, TYPE, pseudoCatalog} from './tooling/pseudo.mjs';
import {compileCatalogs} from './tooling/generate.mjs';
import {createMessageService} from './service';

function structure(ast: MessageFormatElement[]): unknown {
  return ast.filter(node => node.type !== TYPE.literal).map(node => {
    if (node.type === TYPE.tag) return {...node, children: structure(node.children)};
    if (node.type === TYPE.plural || node.type === TYPE.select) return {...node, options: Object.fromEntries(
      Object.entries(node.options).map(([selector, option]) => [selector, {...option, value: structure(option.value)}]),
    )};
    return node;
  });
}
function literalLength(ast: MessageFormatElement[]): number {
  return ast.reduce((sum, node) => sum + (node.type === TYPE.literal ? [...node.value].length
    : node.type === TYPE.tag ? literalLength(node.children)
      : node.type === TYPE.plural || node.type === TYPE.select
        ? Object.values(node.options).reduce((total, option) => total + literalLength(option.value), 0) : 0), 0);
}

describe('development pseudo locale', () => {
  it('accents literals, marks boundaries and grows literal text by 30–40% including markers', () => {
    for (const source of ['Language', 'Save your profile settings', 'An accessible error message that wraps across multiple lines']) {
      const ast = parse(source);
      const pseudo = pseudoCatalog({sample: ast}).sample;
      const ratio = literalLength(pseudo) / literalLength(ast);
      expect(ratio).toBeGreaterThanOrEqual(1.30);
      expect(ratio).toBeLessThanOrEqual(1.40);
      expect(pseudo[0]).toEqual({type: TYPE.literal, value: '['});
      expect(pseudo.at(-1)).toEqual({type: TYPE.literal, value: ']'});
      expect(JSON.stringify(pseudo)).toMatch(/á|é|í|ó|ú/);
    }
  });

  it('preserves keys, tags, arguments, plural selectors, offsets, pound and number/date skeletons', () => {
    const ast = parse('<link>Hello {actorName}</link> {mode, select, full {{count, plural, offset:1 =0 {No messages} one {# message} other {# messages}}} other {{rank, selectordinal, one {# first} other {# later}}}} {amount, number, ::currency/USD} {at, date, ::yyyyMMdd} {at, time, short}');
    const input = {'sample.surface.label': ast};
    const before = JSON.stringify(input);
    const pseudo = pseudoCatalog(input);
    expect(Object.keys(pseudo)).toEqual(Object.keys(input));
    expect(structure(pseudo['sample.surface.label'])).toEqual(structure(ast));
    expect(JSON.stringify(input)).toBe(before);
    expect(literalLength(pseudo['sample.surface.label'])).toBe(Math.round(literalLength(ast) * 1.35));
  });

  it('renders real compiled catalogs with user values kept literal and plural branches still selected', () => {
    const {catalogs} = compileCatalogs();
    const service = createMessageService({messageLocale: 'en-XA', catalog: pseudoCatalog(catalogs['en-US'])});
    const actorName = '<b>{count} 김 User</b>';
    const output = service.formatMessage('common.invitation.received', {actorName});
    expect(output).toContain(actorName);
    expect(output.startsWith('[') && output.endsWith(']')).toBe(true);
    for (const count of [0, 1, 2]) expect(service.formatMessage('common.members.count', {count})).toContain(String(count));
    expect(service.formatMessage('common.members.count', {count: 1})).not.toContain('ɱéɱƀéŕš');
    expect(service.formatMessage('common.members.count', {count: 2})).toContain('ɱéɱƀéŕš');
  });

  it('handles escaped ICU syntax, Korean, multiline and argument-only messages without changing syntax nodes', () => {
    for (const source of ["Literal '{name}' and ''quotes''", '첫 줄\n다음 줄 {actorName}', '{actorName}']) {
      const ast = parse(source);
      expect(structure(pseudoCatalog({sample: ast}).sample)).toEqual(structure(ast));
    }
  });
});
