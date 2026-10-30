import {describe, expect, it} from 'vitest';
import {compareCounts, extractDirectCopy, isProductSource} from './tooling/direct-copy.mjs';

const extract = (source: string) => extractDirectCopy('clients/web/src/NewScreen.tsx', source);

describe('new direct UI copy guard sabotage', () => {
  it('detects Korean, English, JSX, accessibility text, object copy and interpolated templates', () => {
    const source = '<><button aria-label="Save profile">저장</button><Text>{"Continue"}</Text></>;\n'
      + 'const options = {title: "Settings"}; const hint = `Hello ${name}`;';
    expect(extract(source).count).toBe(5);
    expect(extract('<Text>English only</Text>').count).toBe(1);
    expect(extract('setError("Something failed"); const cta = "Save";').count).toBe(2);
  });

  it('distinguishes comments, diagnostics, technical attributes, user values and fixture files', () => {
    const source = '// 한국어 주석\nconsole.warn("진단 로그"); logger.info("Debug message");\n'
      + 'throw new Error("Internal failure"); const key = "common.action.save";\n'
      + '<Text testID="저장-test" className="flex items-center">{user.body}</Text>;';
    expect(extract(source).count).toBe(0);
    expect(extractDirectCopy('clients/web/src/design/ThemeControl.tsx', '<button>Apply</button>').count).toBe(1);
    expect(extractDirectCopy('clients/mobile/App.tsx', '<Text>새 문구</Text>').count).toBe(1);
    for (const path of ['src/a.test.tsx', 'src/__tests__/a.tsx', 'src/fixtures/a.ts', 'src/testkit/a.ts', 'src/generated/a.ts']) {
      expect(isProductSource(path)).toBe(false);
      expect(extractDirectCopy(path, '<Text>새 문구</Text>').count).toBe(0);
    }
  });

  it('ignores line movement but rejects a new file and increases in either language', () => {
    const source = '<Text>저장</Text>; <Text>Continue</Text>;';
    expect(extract(source).count).toBe(extract('\n\n' + source).count);
    expect(compareCounts({'old.tsx': 2}, {'old.tsx': 3, 'new.tsx': 1}).increases).toHaveLength(2);
    expect(compareCounts({'old.tsx': 2}, {'old.tsx': 2}).increases).toEqual([]);
  });

  it('requires extraction ledger reductions including deleted files to prevent stale allowances', () => {
    const result = compareCounts({'a.tsx': 3, 'deleted.tsx': 1}, {'a.tsx': 2});
    expect(result.increases).toEqual([]);
    expect(result.decreases).toHaveLength(2);
    expect(result.decreases.join('\n')).toContain('reduce the committed extraction ledger');
  });

  it('rejects unknown literal message references and permits registered references', () => {
    const result = extractDirectCopy('src/Screen.tsx',
      'messages.formatMessage("common.action.save"); messages.formatMessage("missing.surface.key");', ['common.action.save']);
    expect(result).toEqual({count: 0, unknownKeys: ['missing.surface.key']});
  });
});
