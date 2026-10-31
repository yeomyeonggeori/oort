import {expect, expectTypeOf, it, vi} from 'vitest';
import {loadMessageCatalog} from '../i18n';
import type {MessageKey} from '../i18n';
import {createMessageCopy} from './i18n';

it('binds typed dictionary keys/arguments and refuses fallback labels without poisoning later calls', async () => {
  const catalog = await loadMessageCatalog('en-US');
  const onDiagnostic = vi.fn();
  const copy = createMessageCopy({messageLocale: 'en-US', catalog, onDiagnostic});
  expectTypeOf(copy).parameter(0).toEqualTypeOf<MessageKey>();
  expect(copy('common.members.count', {count: 2})).toBe('2 members');
  expect(() => copy('common.members.count', {count: 'bad'} as never)).toThrow(/invalid-arguments/);
  expect(onDiagnostic).toHaveBeenCalledWith({code: 'invalid-arguments', key: 'common.members.count'});
  expect(copy('common.members.count', {count: 1})).toBe('1 member');
  expect(() => copy('toString' as never)).toThrow(/unknown-key/);
  const missing = createMessageCopy({messageLocale: 'ko-KR', catalog: {}});
  expect(() => missing('settings.profile.languageRetry')).toThrow(/missing-message/);
  const broken = createMessageCopy({messageLocale: 'en-US', catalog: {
    ...catalog, 'settings.profile.languageRetry': [{type: 0, value: ' '}],
  }});
  expect(() => broken('settings.profile.languageRetry')).toThrow(/format-failed/);
});
