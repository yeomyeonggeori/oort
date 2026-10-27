import type {RosterMember} from '@momo/core/lib/api';

import {
  initialExpiry,
  statusDraftVerdict,
  statusSeed,
  type StatusDraft,
  type StatusSeed,
} from '../src/features/profile/statusDraft';

// =============================================================================
// #4457 — 「상태 설정」 시트의 ✓ 가 언제 눌리는가 (`statusDraft.ts`, 순수 판정).
//
// 규칙(`phone-sheets.md` §3): 입력 전·바뀐 것이 없으면 회색. 배선(`StatusSheet`)이 아니라 판정이라
// 비교가 한 칸만 바뀌어도(`!==` → `===`, 공백 비교, 만료 비교 누락) 아래 단정이 빨개진다.
// =============================================================================

const NOW = Date.UTC(2026, 9, 25, 3, 0, 0);
const HOUR = 60 * 60_000;

function row(over: Partial<RosterMember> = {}): RosterMember {
  return {
    id: 'me',
    workspaceId: 'ws',
    kind: 'human',
    status: 'active',
    displayName: '이도현',
    handle: 'dohyun',
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  } as unknown as RosterMember;
}

const EMPTY: StatusSeed = {emoji: '', text: '', storedExpiry: undefined, hasVisible: false};
const VISIBLE: StatusSeed = {emoji: '🏠', text: '재택', storedExpiry: undefined, hasVisible: true};
const WITH_EXPIRY: StatusSeed = {...VISIBLE, storedExpiry: NOW + 3 * HOUR};

const draft = (over: Partial<StatusDraft> = {}, from: StatusSeed = EMPTY): StatusDraft => ({
  emoji: from.emoji,
  text: from.text,
  expiry: initialExpiry(from),
  ...over,
});

describe('statusSeed — 여는 순간의 보이는 상태', () => {
  it('보이는 상태가 있으면 그 이모지·글·만료가 씨앗이다', () => {
    const seed = statusSeed(
      row({statusEmoji: '🏠', statusText: '재택', statusExpiresAtMs: NOW + HOUR}),
      NOW,
    );
    expect(seed).toEqual({
      emoji: '🏠',
      text: '재택',
      storedExpiry: NOW + HOUR,
      hasVisible: true,
    });
  });

  it('만료가 지난 글은 없는 것이다 — 씨앗이 비고 만료도 가져오지 않는다', () => {
    const seed = statusSeed(
      row({statusEmoji: '🏠', statusText: '재택', statusExpiresAtMs: NOW - 1}),
      NOW,
    );
    expect(seed).toEqual(EMPTY);
  });

  it('명부에 아직 내가 없으면 빈 씨앗이다', () => {
    expect(statusSeed(undefined, NOW)).toEqual(EMPTY);
  });

  it('만료 없는 상태는 storedExpiry 가 없다', () => {
    expect(statusSeed(row({statusText: '집중'}), NOW)).toMatchObject({
      text: '집중',
      storedExpiry: undefined,
      hasVisible: true,
    });
  });
});

describe('initialExpiry', () => {
  it('저장된 만료가 있으면 「지금대로」, 없으면 「지우지 않음」', () => {
    expect(initialExpiry(WITH_EXPIRY)).toBe('keep');
    expect(initialExpiry(VISIBLE)).toBe('none');
    expect(initialExpiry(EMPTY)).toBe('none');
  });
});

describe('statusDraftVerdict — ✓ 가 눌리는가', () => {
  it('아무것도 바뀌지 않았으면 눌리지 않는다(빈 씨앗이든 있는 씨앗이든)', () => {
    expect(statusDraftVerdict(EMPTY, draft())).toEqual({dirty: false, canSave: false});
    expect(statusDraftVerdict(VISIBLE, draft({}, VISIBLE))).toEqual({dirty: false, canSave: false});
    expect(statusDraftVerdict(WITH_EXPIRY, draft({}, WITH_EXPIRY))).toEqual({
      dirty: false,
      canSave: false,
    });
  });

  it('글·이모지가 바뀌면 눌린다', () => {
    expect(statusDraftVerdict(EMPTY, draft({text: '회의 중'}))).toEqual({dirty: true, canSave: true});
    expect(statusDraftVerdict(EMPTY, draft({emoji: '📅'}))).toEqual({dirty: true, canSave: true});
    expect(statusDraftVerdict(VISIBLE, draft({text: '재택 근무'}, VISIBLE)).canSave).toBe(true);
    expect(statusDraftVerdict(VISIBLE, draft({emoji: '🌴'}, VISIBLE)).canSave).toBe(true);
  });

  it('공백만 다른 것은 같은 글이다 — 앞뒤 공백과 한 칸 더는 바뀐 것이 아니다', () => {
    expect(statusDraftVerdict(VISIBLE, draft({text: '재택  '}, VISIBLE)).dirty).toBe(false);
    expect(statusDraftVerdict(VISIBLE, draft({text: '  재택'}, VISIBLE)).dirty).toBe(false);
    expect(statusDraftVerdict(EMPTY, draft({text: '   '})).dirty).toBe(false);
  });

  it('고쳤다가 처음 값으로 되돌리면 다시 회색이다', () => {
    expect(statusDraftVerdict(VISIBLE, draft({text: '재택 근무'}, VISIBLE)).canSave).toBe(true);
    expect(statusDraftVerdict(VISIBLE, draft({text: '재택'}, VISIBLE)).canSave).toBe(false);
  });

  it('기간만 바꿔도 바뀐 것이다 — 지금대로 → 지우지 않음, 지우지 않음 → 30분', () => {
    expect(statusDraftVerdict(WITH_EXPIRY, draft({expiry: 'none'}, WITH_EXPIRY))).toEqual({
      dirty: true,
      canSave: true,
    });
    expect(statusDraftVerdict(VISIBLE, draft({expiry: '30m'}, VISIBLE))).toEqual({
      dirty: true,
      canSave: true,
    });
  });

  it('비운 초안은 지울 상태가 있을 때만 저장이다', () => {
    // 지울 것이 없는데 기간만 바꾼 빈 초안: 바뀌었지만 저장할 것이 없다.
    expect(statusDraftVerdict(EMPTY, draft({expiry: '1h'}))).toEqual({dirty: true, canSave: false});
    // 보이는 상태를 다 지운 초안: 「상태 지우기」와 같은 쓰기라 눌린다.
    expect(statusDraftVerdict(VISIBLE, draft({emoji: '', text: ''}, VISIBLE))).toEqual({
      dirty: true,
      canSave: true,
    });
    // 공백뿐인 글도 빈 것이다 — 지울 상태가 없으면 저장이 아니다.
    expect(statusDraftVerdict(EMPTY, draft({text: '   ', expiry: 'today'})).canSave).toBe(false);
  });
});
