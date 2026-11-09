import {describe, expect, it} from 'vitest';
import {
  anchorSeal, ceilings, checkSurface, compareSurface, compareWithBase, dirtyScannedFiles, extractDirectCopy,
  isProductSource, landLedger, raiseLedger, readLedger, serializeLedger, shrinkLedger, surfaceOf, validateLedger,
  type Ledger,
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
    expect(extract('setError("Something failed"); const ctaLabel = "Save";').en).toBe(2);
    // English counts by role, not by shape: a variable that is not named as copy is not copy.
    expect(extract('const mode = "Save";').en).toBe(0);
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

  it('counts Korean anywhere, but English only where it is copy — the same rule on every surface (#5589 r1)', () => {
    const source = 'const kind = "open"; const label = "Open"; const state = "needs review"; const note = "두 단어";';
    for (const file of ['packages/momo-core/src/features/inbox/model.ts', 'clients/web/src/features/inbox/model.ts',
      'clients/mobile/src/features/inbox/model.ts']) {
      expect(extract(source, file)).toEqual({ko: 1, en: 1, cat: 0});
    }
  });

  it('judges a literal by the JSX attribute that receives it, through ternaries, calls and templates (H1)', () => {
    // The review's cases: technical values computed inside an attribute are not copy.
    expect(extract('<div className={open ? "visible" : "hidden"} />')).toEqual({ko: 0, en: 0, cat: 0});
    expect(extract('<div className={cn("flex gap-2", open && "hidden")} data-testid={`row-${id}`} />'))
      .toEqual({ko: 0, en: 0, cat: 0});
    expect(extract('<Row data-state={blocked ? "blocked" : on ? "on" : "off"} tone={ok ? "ok" : "danger"}'
      + ' style={{display: "none", textAlign: "center"}} />')).toEqual({ko: 0, en: 0, cat: 0});
    // Compared values, switch cases, call arguments, state setters and index keys are not shown either.
    expect(extract('{kind === "dm" ? null : <Info />}; if (s !== "ready") go(); switch (k) { case "idle": break; }'))
      .toEqual({ko: 0, en: 0, cat: 0});
    expect(extract('<Text>{n.toLocaleString("ko-KR")}</Text>; setStatus("loading"); failureMessage("list", error);'
      + ' <Note label={COPY["save"]} />')).toEqual({ko: 0, en: 0, cat: 0});
    // A style object inside a copy-named property is still a style: the nearest name decides.
    expect(extract('const styles = {heroText: {alignItems: "center", textAlign: "center"}};').en).toBe(0);
  });

  it('still counts real English copy wherever it is computed (no false negatives from H1)', () => {
    expect(extract('<button aria-label={open ? "Close panel" : "Open panel"} />').en).toBe(2);
    expect(extract('<Input placeholder={`Search ${name}`} title={`${n} items`} />').en).toBe(2);
    expect(extract('<p>{live && "Live"}</p>; <Text>{label ?? "Untitled"}</Text>').en).toBe(2);
    expect(extract('<Banner action={{label: "Retry", run}} options={{title: "Settings"}} />').en).toBe(2);
    expect(extract('const label = on ? "On" : "Off"; setError("Failed"); <Row getLabel={() => "Settings"} />').en).toBe(4);
    expect(extract('<Button onPress={() => alert("Saved")}>Apply</Button>').en).toBe(2);
    // Korean in a computed non-technical attribute counts; in a technical one it does not.
    expect(extract('<Banner action={{label: "지금 새로고침"}} title={busy ? "저장 중" : "저장"} />').ko).toBe(3);
    expect(extract('<div className={cn("x", label === "커밋" && "font-mono")} />').ko).toBe(0);
  });

  it('counts Korean in Error messages, message argument values and name= (M4); English there is not copy', () => {
    expect(extract('throw new SaveError("저장하지 못했어요"); throw new Error("Internal failure");'))
      .toEqual({ko: 1, en: 0, cat: 0});
    expect(extract('new EnrollError(`Face ID를 취소해 ${n}번 다시`);').ko).toBe(2); // each template part is a literal
    expect(extract('formatMessage("k.a.b", {label: "관리자만 보여요", kind: "agent"});')).toEqual({ko: 1, en: 0, cat: 0});
    expect(extract('useBlockedReason("changeIt", {why: "연결이 끊겼어요"});').ko).toBe(1);
    expect(extract('<SettingsToggleRow name="이 채널은 요약에서 빼기" /><input name="email" />')).toEqual({ko: 1, en: 0, cat: 0});
    // Diagnostics stay out: console/logger calls, and English errors.
    expect(extract('console.warn("진단 로그"); logger.error(new Error("한국어 진단"));').ko).toBe(0);
  });

  it('scans the core i18n folder except the dictionary, generated code, tooling and self-names (M4)', () => {
    expect(surfaceOf('packages/momo-core/src/i18n/choices.ts')).toBe('core');
    expect(surfaceOf('packages/momo-core/src/i18n/pseudo.ts')).toBe('core');
    for (const file of ['packages/momo-core/src/i18n/autonyms.ts', 'packages/momo-core/src/i18n/tooling/direct-copy.mjs',
      'packages/momo-core/src/i18n/catalogs/x.ts', 'packages/momo-core/src/i18n/generated/ko-KR.ts']) {
      expect(surfaceOf(file)).toBeUndefined();
    }
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

  it('M2: the issue is a 4–5 digit number, and a ledger sync or a non-sentence is not a reason', () => {
    const raise = (entry: object) => validateLedger({...ledger, raises: [entry]} as Ledger, {seal}).join('\n');
    for (const issue of [1, 999, 100000, 999999]) expect(raise({file: A, issue, ko: 1, reason: REASON})).toMatch(/4–5 digit/);
    for (const issue of [1000, 5600, 99999]) expect(raise({file: A, issue, ko: 1, reason: REASON})).toBe('');
    // The review's bypasses (#5598 r1, M2).
    for (const reason of ['update ledger after merge', 'sync counts with track/uxui', 'ledger bump for landing',
      '장부 업데이트 — 착륙 후 수 맞춤', '카운트 갱신 (트랙 합친 뒤)', 'aaaaaaaaaaaaaaaaaaaa']) {
      expect(raise({file: A, issue: 5600, ko: 1, reason})).toMatch(/regeneration or ledger sync|in words/);
    }
    expect(raise({file: A, issue: 5600, ko: 1, reason: 'moved from clients/web/src/Old.tsx with the rename'})).toBe('');
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

  it('M2: land stops on more than 10 new raises unless --allow-many-raises', () => {
    const files = Array.from({length: 11}, (_, index) => `clients/web/src/N${index}.tsx`);
    const many = {...ledger, raises: files.map(file => ({file, issue: 5600, ko: 1, reason: REASON}))};
    const countsFor = (names: string[]): Record<string, {ko: number; en?: number}> =>
      ({[A]: {ko: 3, en: 1}, [B]: {ko: 1}, ...Object.fromEntries(names.map(file => [file, {ko: 1}]))});
    const stopped = landLedger(ledger, many, countsFor(files));
    expect(stopped.carried).toBe(11);
    expect(stopped.refused.join('\n')).toMatch(/11 new raises in one landing/);
    expect(landLedger(ledger, many, countsFor(files), {allowManyRaises: true}).refused).toEqual([]);
    const ten = {...many, raises: many.raises.slice(0, 10)};
    expect(landLedger(ledger, ten, countsFor(files.slice(0, 10))).refused).toEqual([]);
  });

  it('M1: against the base, the anchor and seal hold and no (lowered ?? anchor) goes up', () => {
    const base = shrinkLedger(ledger, {[A]: {ko: 1, en: 1}, [B]: {ko: 1}}).ledger; // the track lowered A to 1
    const ok = compareWithBase(base, base, {baseSeal: seal, headSeal: seal});
    expect(ok.problems).toEqual([]);
    // S7a: the branch drops the track's lowered entry to bring copy back without a raise.
    const restored = compareWithBase(base, {...base, lowered: {}}, {baseSeal: seal, headSeal: seal});
    expect(restored.problems.join('\n')).toMatch(/A\.tsx: \(lowered \?\? anchor\) went up against the base, ko 1 → 3/);
    // S6b: a re-anchor with a matching seal passes `check`, but not the base comparison without the label.
    const reAnchored = {...base, anchor: {...base.anchor, [A]: {ko: 4, en: 1}}, lowered: {}};
    const reSeal = anchorSeal(reAnchored);
    expect(validateLedger(reAnchored, {seal: reSeal})).toEqual([]);
    expect(compareWithBase(base, reAnchored, {baseSeal: seal, headSeal: reSeal}).problems.join('\n')).toMatch(/policy-change-approved/);
    expect(compareWithBase(base, reAnchored, {baseSeal: seal, headSeal: reSeal, reanchorApproved: true}).problems).toEqual([]);
    // Lowering and raising are the normal paths: listed, not refused.
    const raised = raiseLedger(shrinkLedger(base, {[A]: {ko: 0, en: 1}, [B]: {ko: 1}}).ledger, NEW, {ko: 1}, {issue: 5600, reason: REASON});
    const normal = compareWithBase(base, raised, {baseSeal: seal, headSeal: seal});
    expect(normal.problems).toEqual([]);
    expect(normal.fresh).toEqual([{file: NEW, issue: 5600, ko: 1, reason: REASON}]);
    // A v1 base (this PR's own base) has nothing to compare.
    expect(compareWithBase({version: 1, files: {}}, base, {headSeal: seal}).notes.join('\n')).toMatch(/nothing to compare/);
  });

  it('L2: land refuses unstaged or untracked scanned files, not a staged merge or unscanned output', () => {
    const status = ['M  clients/web/src/Staged.tsx', ' M clients/web/src/Edited.tsx', '?? clients/mobile/src/New.tsx',
      ' M packages/momo-core/src/i18n/generated/ko-KR.ts', '?? clients/web/src/New.test.tsx', 'UU packages/momo-core/src/x.ts',
      'R  clients/web/src/Moved.tsx', 'clients/web/src/Old.tsx', ''].join('\0');
    expect(dirtyScannedFiles(status)).toEqual([' M clients/web/src/Edited.tsx', '?? clients/mobile/src/New.tsx',
      'UU packages/momo-core/src/x.ts']);
    expect(dirtyScannedFiles('')).toEqual([]);
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
