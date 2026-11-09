import {describe, expect, it} from 'vitest';
import {
  anchorSeal, ceilings, checkSurface, compareSurface, extractDirectCopy, isProductSource, landLedger,
  raiseLedger, readLedger, serializeLedger, shrinkLedger, validateLedger, type Ledger,
} from './tooling/direct-copy.mjs';

const extract = (source: string, file = 'clients/web/src/NewScreen.tsx') => {
  const {ko, en, cat} = extractDirectCopy(file, source);
  return {ko, en, cat};
};

describe('direct UI copy extraction', () => {
  it('detects Korean, English, JSX, accessibility text, object copy and interpolated templates', () => {
    const source = '<><button aria-label="Save profile">저장</button><Text>{"Continue"}</Text></>;\n'
      + 'const options = {title: "Settings"}; const hint = `Hello ${name}`;';
    expect(extract(source)).toEqual({ko: 1, en: 4, cat: 0});
    expect(extract('<Text>English only</Text>').en).toBe(1);
    expect(extract('setError("Something failed"); const cta = "Save";').en).toBe(2);
  });

  it('distinguishes comments, diagnostics, technical attributes, user values and fixture files', () => {
    const source = '// 한국어 주석\nconsole.warn("진단 로그"); logger.info("Debug message");\n'
      + 'throw new Error("Internal failure"); const key = "common.action.save";\n'
      + '<Text testID="저장-test" className="flex items-center">{user.body}</Text>;';
    expect(extract(source)).toEqual({ko: 0, en: 0, cat: 0});
    expect(extract('<button>Apply</button>', 'clients/web/src/design/ThemeControl.tsx').en).toBe(1);
    expect(extract('<Text>새 문구</Text>', 'clients/mobile/App.tsx').ko).toBe(1);
    for (const path of ['src/a.test.tsx', 'src/__tests__/a.tsx', 'src/fixtures/a.ts', 'src/testkit/a.ts', 'src/generated/a.ts']) {
      expect(isProductSource(path)).toBe(false);
      expect(extract('<Text>새 문구</Text>', path)).toEqual({ko: 0, en: 0, cat: 0});
    }
  });

  it('counts copy in any JSX attribute (#5589): headline, detail, *Label props — but not technical attributes', () => {
    const source = '<Empty headline="채널이 없어요" detail="자세히 봐요" actionLabel="Create channel" busyLabel="만드는 중"'
      + ' variant="primary" testID="저장-test" className="gap-2" data-state="열림" />';
    expect(extract(source)).toEqual({ko: 3, en: 1, cat: 0});
    // Before #5589 these attributes were skipped entirely: the same file counted nothing.
    expect(extract('<Notice headline="새 글" />')).toEqual({ko: 1, en: 0, cat: 0});
  });

  it('counts Korean anywhere in the shared core, but English only where it is copy', () => {
    const source = 'const kind = "open"; const label = "Open"; const state = "needs review"; const note = "두 단어";';
    expect(extract(source, 'packages/momo-core/src/features/inbox/model.ts')).toEqual({ko: 1, en: 1, cat: 0});
    // The client rule stays the conservative #4834 one.
    expect(extract(source, 'clients/web/src/features/inbox/model.ts')).toEqual({ko: 1, en: 3, cat: 0});
  });

  it('counts sentences assembled from dictionary output, and nothing for one whole message', () => {
    const cat = (source: string) => extract(source).cat;
    expect(cat('const a = `${title}. ${formatMessage("k.a.b")}`;')).toBe(1);
    expect(cat('const a = `${formatMessage("k.a.b")}!`;')).toBe(1);
    expect(cat('const a = messages.formatMessage("k.a.b") + " " + name;')).toBe(1);
    expect(cat('const a = [formatMessage("k.a.b"), formatMessage("k.a.c")].join(" ");')).toBe(1);
    expect(cat('const a = `${formatMessage("k.a.b")}`; const b = formatMessage("k.a.b", {name});')).toBe(0);
    expect(cat('console.log(`${formatMessage("k.a.b")} debug`);')).toBe(0);
  });

  it('does not count blocked-reason frame names as copy, but still counts the sentence beside them', () => {
    expect(extract('const reason = useBlockedReason("changeIt");', 'src/Screen.tsx').en).toBe(0);
    expect(extract('const line = useBlockedStale("lastSyncedList", when);', 'src/Screen.tsx').en).toBe(0);
    expect(extract('const reason = describe("연결이 끊겨 지금은 바꿀 수 없어요.");', 'src/Screen.tsx').ko).toBe(1);
  });

  it('rejects unknown literal message references and permits registered references', () => {
    const result = extractDirectCopy('src/Screen.tsx',
      'messages.formatMessage("common.action.save"); messages.formatMessage("missing.surface.key");', ['common.action.save']);
    expect(result).toEqual({ko: 0, en: 0, cat: 0, unknownKeys: ['missing.surface.key']});
  });
});

const A = 'clients/web/src/A.tsx';
const B = 'clients/web/src/B.tsx';
const NEW = 'clients/web/src/New.tsx';
function sealed(anchor: Ledger['anchor'], rest: Partial<Ledger> = {}) {
  const ledger: Ledger = {version: 2, anchorHead: 'a'.repeat(40), anchor, lowered: {}, raises: [], ...rest};
  return {ledger, seal: anchorSeal(ledger)};
}
const REASON = 'Error banner text waits for the P1 web settings extraction (#5600).';

describe('direct-copy ratchet (#5589)', () => {
  const {ledger, seal} = sealed({[A]: {ko: 3, en: 1}, [B]: {ko: 1, en: 0}});

  it('passes only when every file matches its allowance exactly', () => {
    expect(validateLedger(ledger, {seal})).toEqual([]);
    expect(compareSurface(ledger, 'web', {[A]: {ko: 3, en: 1}, [B]: {ko: 1}})).toEqual({increases: [], decreases: []});
  });

  it('RED: one more hardcoded line, or a new file with copy; GREEN once it is gone', () => {
    const up = compareSurface(ledger, 'web', {[A]: {ko: 4, en: 1}, [B]: {ko: 1}, [NEW]: {ko: 1}});
    expect(up.increases).toHaveLength(2);
    expect(up.increases[0]).toContain('dictionary key');
    expect(compareSurface(ledger, 'web', {[A]: {ko: 3, en: 1}, [B]: {ko: 1}}).increases).toEqual([]);
  });

  it('RED on a stale allowance: a drop must lower the ledger, so later copy cannot spend it', () => {
    const down = compareSurface(ledger, 'web', {[A]: {ko: 2, en: 1}});
    expect(down.decreases).toHaveLength(2);
    expect(down.decreases.join('\n')).toContain('shrink');
  });

  it('RED: the old whole-ledger regeneration shape, a rewritten anchor, or a lowered entry above the anchor', () => {
    const regenerated = {version: 1, baselineHead: 'b'.repeat(40), files: {[A]: 4, [B]: 1}};
    expect(validateLedger(regenerated, {seal}).join('\n')).toMatch(/regeneration/);
    const reAnchored = {...ledger, anchor: {...ledger.anchor, [A]: {ko: 4, en: 1}}};
    expect(validateLedger(reAnchored, {seal}).join('\n')).toMatch(/seal mismatch/);
    expect(validateLedger({...ledger, lowered: {[A]: {ko: 4, en: 1}}}, {seal}).join('\n')).toMatch(/higher than the anchor/);
    expect(validateLedger({...ledger, files: {}}, {seal}).join('\n')).toMatch(/unknown field files/);
  });

  it('a raise needs an issue and a real reason, never a regeneration note', () => {
    const raise = (entry: object) => validateLedger({...ledger, raises: [entry]} as Ledger, {seal}).join('\n');
    expect(raise({file: A, issue: 5600, ko: 1, reason: REASON})).toBe('');
    expect(raise({file: A, ko: 1, reason: REASON})).toMatch(/issue/);
    expect(raise({file: A, issue: 5600, ko: 1, reason: 'track/engine 합친 뒤 장부 다시 만들기'})).toMatch(/regeneration/);
    expect(raise({file: A, issue: 5600, ko: 1, reason: 'regenerate ledger after merge'})).toMatch(/regeneration/);
    expect(raise({file: A, issue: 5600, reason: REASON})).toMatch(/positive/);
    // Ordinary UI verbs are not regeneration notes.
    expect(raise({file: A, issue: 5600, ko: 1, reason: '탭을 다시 세우는 안내 문구, P1 settings 키로 옮길 때까지 남겨요.'})).toBe('');
    expect(raise({file: A, issue: 5600, ko: 1, reason: '병합 뒤 문구 수를 다시 세어 맞춤 (자동)'})).toMatch(/regeneration/);
  });

  it('raise adds one explicit entry sized to the excess; shrink only lowers and trims unused raises', () => {
    const raised = raiseLedger(ledger, A, {ko: 5, en: 1}, {issue: 5600, reason: REASON});
    expect(raised.raises).toEqual([{file: A, issue: 5600, ko: 2, reason: REASON}]);
    expect(ceilings(raised)[A]).toEqual({ko: 5, en: 1, cat: 0});
    expect(() => raiseLedger(ledger, A, {ko: 3, en: 1}, {issue: 5600, reason: REASON})).toThrow(/nothing to raise/);

    const refused = shrinkLedger(ledger, {[A]: {ko: 4, en: 1}, [B]: {ko: 1}});
    expect(refused.refused).toHaveLength(1);
    const lowered = shrinkLedger(raised, {[A]: {ko: 4, en: 1}, [B]: {ko: 0}});
    expect(lowered.refused).toEqual([]);
    expect(lowered.ledger.raises).toEqual([{file: A, issue: 5600, ko: 1, reason: REASON}]);
    expect(lowered.ledger.lowered).toEqual({[B]: {ko: 0, en: 0}});
    expect(ceilings(lowered.ledger)[A]).toEqual({ko: 4, en: 1, cat: 0});
    expect(validateLedger(lowered.ledger, {seal})).toEqual([]);
  });

  it('land carries only the branch\'s new raises; a lowered entry raised by hand is refused', () => {
    const base = shrinkLedger(ledger, {[A]: {ko: 1, en: 1}, [B]: {ko: 1}}).ledger;
    const branchRaise = raiseLedger(ledger, NEW, {ko: 1}, {issue: 5600, reason: REASON});
    const landed = landLedger(base, branchRaise, {[A]: {ko: 1, en: 1}, [B]: {ko: 1}, [NEW]: {ko: 1}});
    expect(landed.refused).toEqual([]);
    expect(landed.carried).toBe(1);
    expect(landed.ledger.lowered).toEqual({[A]: {ko: 1, en: 1}});
    // The branch put copy back into A and edited `lowered` instead of adding a raise.
    const sneaky = {...base, lowered: {[A]: {ko: 3, en: 1}}};
    expect(landLedger(base, sneaky, {[A]: {ko: 3, en: 1}, [B]: {ko: 1}}).refused).toEqual(['clients/web/src/A.tsx: ko 1 → 3']);
  });

  it('serializes one file per line and round-trips', () => {
    const text = serializeLedger(ledger);
    expect(text).toContain(`    "${A}": {"ko": 3, "en": 1}`);
    expect(JSON.parse(text)).toMatchObject({version: 2, anchor: ledger.anchor, lowered: {}, raises: []});
  });
});

describe('committed ledger', () => {
  it('is a sealed v2 ledger', () => {
    expect(validateLedger(readLedger())).toEqual([]);
  });

  it('keeps shared-core direct copy within its allowance', () => {
    expect(() => checkSurface('core')).not.toThrow();
  });
});
