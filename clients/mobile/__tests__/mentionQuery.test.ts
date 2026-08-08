import type {RosterMember} from '@momo/core/lib/api';
import {
  applyMention,
  caretAfterChange,
  matchMembers,
  mentionQueryAt,
} from '../src/features/conversation/mentionQuery';

// =============================================================================
// The compose-time half of mentions, ported from the web composer because the
// core does not carry it (see the module header). These are the tests that make
// the port a port rather than a rewrite: every case here is a rule the web
// implementation already keeps, so a divergence shows up as a red line instead
// of as two clients disagreeing about what `@` means.
// =============================================================================

function member(over: Partial<RosterMember> & {id: string}): RosterMember {
  return {
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이름',
    handle: 'handle',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as RosterMember;
}

const MEMBERS = [
  member({id: '1', displayName: '김인턴', handle: 'kim-intern', kind: 'agent'}),
  member({id: '2', displayName: '헤르메스', handle: 'hermes', kind: 'agent'}),
  member({id: '3', displayName: '곽성재', handle: 'seongjae'}),
  member({id: '4', displayName: '떠난사람', handle: 'gone', status: 'deleted'}),
];

describe('mentionQueryAt', () => {
  it('finds the token being typed at the caret', () => {
    expect(mentionQueryAt('@her', 4)).toEqual({start: 0, text: 'her'});
    expect(mentionQueryAt('안녕 @her', 7)).toEqual({start: 3, text: 'her'});
  });

  it('opens on a bare @', () => {
    expect(mentionQueryAt('@', 1)).toEqual({start: 0, text: ''});
  });

  it('is not a mention mid-word — that is an email, not a call', () => {
    expect(mentionQueryAt('a@b', 3)).toBeNull();
    expect(mentionQueryAt('user@example.com', 16)).toBeNull();
  });

  it('closes once a space follows the token', () => {
    expect(mentionQueryAt('@hermes 안녕', 10)).toBeNull();
  });

  it('reads the token at the caret, not the last one in the text', () => {
    // Caret sits right after the first token; the later text is not its
    // business. Getting this wrong offers candidates for a different word.
    expect(mentionQueryAt('@her 그리고 @kim', 4)).toEqual({start: 0, text: 'her'});
  });

  it('has no token when there is no @', () => {
    expect(mentionQueryAt('안녕하세요', 5)).toBeNull();
  });
});

describe('matchMembers', () => {
  it('matches handle and display name', () => {
    expect(matchMembers(MEMBERS, 'her').map(m => m.handle)).toEqual(['hermes']);
    expect(matchMembers(MEMBERS, '김인').map(m => m.handle)).toEqual(['kim-intern']);
  });

  it('is case-insensitive', () => {
    expect(matchMembers(MEMBERS, 'HER').map(m => m.handle)).toEqual(['hermes']);
  });

  it('offers everyone active on a bare @', () => {
    expect(matchMembers(MEMBERS, '')).toHaveLength(3);
  });

  it('never offers a member who is not active', () => {
    // Mentioning someone who left produces a handle the server routes nowhere.
    expect(matchMembers(MEMBERS, 'gone')).toEqual([]);
  });

  it('caps the list', () => {
    const many = Array.from({length: 40}, (_, i) =>
      member({id: `m${i}`, handle: `mate${i}`}),
    );
    expect(matchMembers(many, 'mate')).toHaveLength(6);
  });
});

describe('applyMention', () => {
  it('replaces the token with the handle and a trailing space', () => {
    const query = mentionQueryAt('@her', 4)!;
    expect(applyMention('@her', query, 4, 'hermes')).toEqual({
      text: '@hermes ',
      caret: 8,
    });
  });

  it('keeps what was after the caret', () => {
    const value = '@her 뒤에 남은 말';
    const query = mentionQueryAt(value, 4)!;
    expect(applyMention(value, query, 4, 'hermes').text).toBe(
      '@hermes  뒤에 남은 말',
    );
  });

  it('leaves text before the token untouched', () => {
    const value = '안녕 @kim';
    const query = mentionQueryAt(value, 7)!;
    expect(applyMention(value, query, 7, 'kim-intern')).toEqual({
      text: '안녕 @kim-intern ',
      caret: 15,
    });
  });
});

describe('caretAfterChange', () => {
  it('lands at the end when typing at the end', () => {
    expect(caretAfterChange('안녕', '안녕하')).toBe(3);
  });

  it('lands after the inserted text in the middle', () => {
    expect(caretAfterChange('ab', 'aXb')).toBe(2);
  });

  it('lands where the deletion happened', () => {
    expect(caretAfterChange('aXb', 'ab')).toBe(1);
  });

  it('handles a repeated character without double counting', () => {
    // `aa` -> `aaa`: the added character is indistinguishable, so the caret
    // must not be pulled back by counting the same `a` as prefix and suffix.
    expect(caretAfterChange('aa', 'aaa')).toBe(3);
  });

  it('lands at the end while an IME rewrites the composing tail', () => {
    // Measured on the device: one keystroke, two syllables (받침 이동).
    expect(caretAfterChange('안녕핫', '안녕하세')).toBe(4);
    // The 10-key tail widening to two characters and folding back.
    expect(caretAfterChange('안녕하ㅅ·', '안녕하서')).toBe(4);
  });

  it('is 0 for a cleared input', () => {
    expect(caretAfterChange('안녕하세요', '')).toBe(0);
  });
});
