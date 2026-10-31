import {describe, expect, expectTypeOf, it, vi} from 'vitest';
import {SCHEDULED_COPY} from '../features/scheduled/copy';
import {blankCopy, copyStringCount, createCopy, createFlush, createMount, loginBody, member, missingKeys, selfMember} from './index';

describe('shared testkit', () => {
  it('keeps member defaults and gives every fixture its own arrays', () => {
    const first = member({id: 'a'});
    const second = member({id: 'a', kind: 'agent'});
    first.channelIds.push('ch');
    first.capabilities.push('test');
    expect(second.channelIds).toEqual([]);
    expect(second.capabilities).toEqual([]);
    expect(first).toMatchObject({workspaceId: 'ws', kind: 'human', status: 'active'});
    expect(second.kind).toBe('agent');
  });

  it('builds independent login fixtures with caller overrides', () => {
    const first = loginBody(selfMember({id: 'me', workspaceId: 'other'}));
    const second = loginBody(selfMember());
    first.member.displayName = 'changed';
    expect(first.member).toMatchObject({id: 'me', workspaceId: 'other'});
    expect(second.member.displayName).toBe('이름');
    expect(second.accessToken).toBe('access-token-1');
  });

  it('tracks all mounts, cleans in reverse order, and permits another cycle', () => {
    const disposed: string[] = [];
    const kit = createMount((name: string) => ({name}), value => disposed.push(value.name));
    expect(kit.mount('a')).toEqual({name: 'a'});
    kit.mount('b');
    kit.cleanup();
    kit.cleanup();
    kit.mount('c');
    kit.cleanup();
    expect(disposed).toEqual(['b', 'a', 'c']);
  });

  it('does not register a render that failed', () => {
    const unmount = vi.fn();
    const kit = createMount(() => { throw new Error('render failed'); }, unmount);
    expect(() => kit.mount()).toThrow('render failed');
    kit.cleanup();
    expect(unmount).not.toHaveBeenCalled();
  });

  it('flush awaits queued promises and timers inside the injected act', async () => {
    const turns: string[] = [];
    const flush = createFlush(async work => {
      turns.push('act');
      await work();
      turns.push('done');
    });
    void Promise.resolve().then(() => turns.push('promise'));
    setTimeout(() => turns.push('timer'), 0);
    await flush(2);
    expect(turns).toEqual(['act', 'promise', 'timer', 'done', 'act', 'done']);
  });
});

describe('copy module lookup and catalog', () => {
  it('reads typed dotted keys from the live module, without a sentence mirror', () => {
    const source = {title: 'Save', nested: {label: 'Cancel'}, fn: () => 'x', list: ['x']};
    const copy = createCopy(source);
    expectTypeOf(copy).parameter(0).toEqualTypeOf<'title' | 'nested.label'>();
    expect(copy('nested.label')).toBe('Cancel');
    source.title = 'Updated';
    expect(copy('title')).toBe('Updated');
  });

  it('rejects missing, inherited, blank, and non-string entries', () => {
    const copy = createCopy({empty: '', spaces: '  ', nested: {title: 'Save'}, fn: () => 'x'});
    for (const key of ['gone', 'toString', 'nested.toString', 'empty', 'spaces', 'nested', 'fn']) {
      expect(() => copy(key as never)).toThrow(/copy/i);
    }
  });

  it('reports missing own keys and undefined values in required order', () => {
    expect(missingKeys({present: 'x', absent: undefined}, ['present', 'absent', 'gone', 'toString']))
      .toEqual(['absent', 'gone', 'toString']);
  });

  it('finds blank nested entries and counts strings without executing functions', () => {
    const fn = vi.fn(() => '');
    const source = {title: 'x', nested: {blank: ' ', rows: ['y', '']}, fn};
    expect(blankCopy(source)).toEqual(['nested.blank', 'nested.rows[1]']);
    expect(copyStringCount(source)).toBe(4);
    expect(fn).not.toHaveBeenCalled();
  });

  it('checks the real shared copy catalog for required keys and blank sentences', () => {
    expect(missingKeys(SCHEDULED_COPY, ['trigger', 'menu', 'dialog', 'errors'])).toEqual([]);
    expect(copyStringCount(SCHEDULED_COPY)).toBeGreaterThan(0);
    expect(blankCopy(SCHEDULED_COPY)).toEqual([]);
    expect(createCopy(SCHEDULED_COPY)('trigger.label')).toBe(SCHEDULED_COPY.trigger.label);
  });
});
