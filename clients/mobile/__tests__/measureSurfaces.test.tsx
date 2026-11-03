import 'react-native-url-polyfill/auto';
import {cleanup, render} from '@testing-library/react-native';
import {spawnSync} from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import {Settings} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import SurfacesHarness from '../measure/surfaces';
import {measureMode} from '../measure/root';

const known = require('../measure/known-surface.cjs') as {
  launchMode: (raw: unknown) => ReturnType<typeof measureMode>;
  isKnownLaunch: (raw: string, rules: Rules) => boolean;
  loadRules: () => Rules;
  surfaceRules: (source: string, baseDir?: string) => Rules;
};
interface Rules {
  exact: Set<string>;
  prefixes: string[];
}

// =============================================================================
// #5172 — 측정 하네스의 `APPROVED` 표면이 「알 수 없는 표면」 오류 화면이었다.
//
// 검증 줄 3회차 폰 화면 검수는 `-momoMeasure APPROVED` 두 장(밝음·어두움)을 승인된 카드의 증거로 받았는데 둘 다 하네스의 오류 안내
// 화면이었다 — 하네스에 그 이름이 없었고, 모르는 이름도 스크린샷으로는 멀쩡한 사진이라 아무것도 멈추지 않았다. 같은 구멍은 `measure.sh`
// 에도 있었다: #2864 가 지운 `WORK-CONSOLE` 을 그 뒤로도 계속 찍고 있었다(두 장이 오류 화면).
//
// 이 파일은 둘을 **그려 본 값**으로 잰다:
//   1. `approved` 가 실제로 승인된 카드를 그린다(오류 화면이 아니다).
//   2. 「이 이름을 하네스가 아는가」를 소스에서 읽는 도구(`measure/known-surface.cjs`)가 **실제로 그려 본 결과**와 같은 답을 낸다 —
//      도구가 아는 이름은 오류 화면을 그리지 않고, 모르는 이름은 그린다.
//   3. `measure.sh` 가 찍는 모든 표면 이름을 하네스가 알고, 모르는 이름이 나오면 스크립트가 **시뮬레이터를 건드리기 전에** 멈춘다.
//
// 못 재는 것: 시뮬레이터에서의 실제 캡처(`runtime-unverified`) — 이 파일은 jest 안에서 하네스 컴포넌트를 그린 것과 셸 가드의 흐름
// (`xcrun`·`sleep` 은 가짜)만 잰다.
// =============================================================================

const MOBILE = path.resolve(__dirname, '..');
const MEASURE_SH = path.join(MOBILE, 'scripts/measure.sh');
const KNOWN_CLI = path.join(MOBILE, 'measure/known-surface.cjs');
const UNKNOWN_FRAME = '알 수 없는 표면: ';

function collectTexts(node: unknown, out: string[]): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string') {
    out.push(node);
  } else if (Array.isArray(node)) {
    for (const child of node) collectTexts(child, out);
  } else {
    collectTexts((node as {children?: unknown}).children, out);
  }
  return out;
}

/** 하네스를 이 이름·스킴으로 그려 보이는 글을 모은다. 시작 인자(`LIGHT-ROW`)는 `launchMode` 가 이름·스킴으로 가른다. */
function drawn(name: string, scheme: 'light' | 'dark' = 'light'): string[] {
  const view = render(<SurfacesHarness name={name} scheme={scheme} />);
  const texts = collectTexts(view.toJSON(), []);
  view.unmount();
  return texts;
}

const showsUnknownFrame = (texts: string[]) => texts.some(text => text.startsWith(UNKNOWN_FRAME));

afterEach(() => {
  cleanup();
});

describe('#5172 APPROVED 표면 — 승인된 카드를 그린다', () => {
  it('오류 화면이 아니라 승인된 카드 둘(방금 승인한 영수증 · 다시 열었을 때 서버가 알려 준 상태)을 그린다 — 밝음·어두움', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const texts = drawn('approved', scheme);
      const tag = `approved/${scheme}`;
      expect([tag, showsUnknownFrame(texts)]).toEqual([tag, false]);
      // 카드 둘, 둘 다 끝난 상태의 칩 「끝」.
      expect([tag, texts.filter(text => text === 'github.search_issues 실행 허가').length]).toEqual([tag, 2]);
      expect([tag, texts.filter(text => text === '끝').length]).toEqual([tag, 2]);
      // 방금 승인한 카드는 영수증 문장을 말한다.
      expect([tag, texts.includes('승인을 기록했어요.')]).toEqual([tag, true]);
      // 결정이 난 카드다: 대기 칩도, 승인·거부 단추도 서 있지 않다.
      for (const pending of ['승인 필요', '승인', '거부']) {
        expect([tag, pending, texts.includes(pending)]).toEqual([tag, pending, false]);
      }
    }
  });

  it('이 검사는 헛돌지 않는다 — 모르는 이름은 같은 감지기로 오류 화면이 잡힌다', () => {
    const texts = drawn('no-such-surface');
    expect(showsUnknownFrame(texts)).toBe(true);
    expect(texts).toContain(`${UNKNOWN_FRAME}no-such-surface`);
    // 그리고 결정 전 카드(`approval-card`)와 갈린다: 거기에는 대기 칩과 단추가 서 있다.
    const pending = drawn('approval-card');
    expect(showsUnknownFrame(pending)).toBe(false);
    expect(pending).toEqual(expect.arrayContaining(['승인 필요', '거부', '승인']));
  });
});

describe('known-surface — 하네스가 아는 이름을 소스에서 읽는 도구', () => {
  const rules = known.loadRules();

  it('소스에서 읽은 규칙이 비어 있지 않다 — 이름 150개 이상, 접두 20개 이상, 대표 이름이 들어 있다', () => {
    expect(rules.exact.size).toBeGreaterThanOrEqual(150);
    expect(rules.prefixes.length).toBeGreaterThanOrEqual(20);
    for (const name of ['approval-card', 'approved', 'pull-probe', 'theme-live', 'shell-home-approval']) {
      expect([name, rules.exact.has(name)]).toEqual([name, true]);
    }
    // `if (isUncollectedSurface(name))` 은 import 한 술어(`measure/uncollected.tsx`)를 풀어 읽는다.
    expect(rules.prefixes).toContain('uncollected-');
    expect(rules.exact.has('uncollected')).toBe(true);
    // `name.startsWith('apps-') && !name.startsWith('apps-tail')` 의 부정 항은 읽지 않고, 긍정 항만 접두가 된다.
    expect(rules.prefixes).toContain('apps-');
  });

  it('도구의 답이 실제로 그려 본 결과와 같다 — 아는 이름은 오류 화면을 안 그리고 모르는 이름은 그린다', () => {
    const SAMPLE = [
      // 맨 위 `switch (name)` 의 case
      'approval-card',
      'approved',
      'group',
      'row',
      // 맨 위 `name === …` / `name.startsWith(…)` 갈래(가족 안의 이름은 가족이 풀므로 대표 하나만)
      'pin-approval-approved',
      // 모르는 이름들: 빠진 낱말·옛 이름·접두만 같은 이름
      'no-such-surface',
      'work-console',
      'approve',
      'approvedx',
    ];
    const wrong: string[] = [];
    let knownCount = 0;
    let unknownCount = 0;
    for (const raw of SAMPLE) {
      const mode = known.launchMode(raw);
      if (mode === null || mode.kind !== 'surface') throw new Error(`${raw}: 표면 이름이 아니다`);
      const byTool = known.isKnownLaunch(raw, rules);
      const byRender = !showsUnknownFrame(drawn(mode.name, mode.scheme));
      if (byTool !== byRender) wrong.push(`${raw}: 도구 ${byTool ? '안다' : '모른다'} ≠ 그려 보니 ${byRender ? '안다' : '모른다'}`);
      if (byRender) knownCount += 1;
      else unknownCount += 1;
    }
    expect(wrong).toEqual([]);
    // 표본이 한쪽으로 쏠리지 않았다.
    expect(knownCount).toBeGreaterThanOrEqual(5);
    expect(unknownCount).toBeGreaterThanOrEqual(4);
  });

  it('이름 정규화가 앱의 `measureMode()` 와 같다 — YES·1·states·앞의 light-·대소문자', () => {
    const original = Settings.get('momoMeasure');
    try {
      for (const raw of ['YES', '1', 'states', 'STATES', 'LIGHT-ROW', 'light-row', 'Row', 'row', 'LIGHT-', 'light-LIGHT-ROW', 'yes']) {
        Settings.set({momoMeasure: raw});
        expect([raw, known.launchMode(raw)]).toEqual([raw, measureMode()]);
      }
      // 빈 값은 앱 자신이다(하네스가 아니다) — 도구는 이를 「모르는 이름」으로 막는다.
      Settings.set({momoMeasure: ''});
      expect(measureMode()).toBeNull();
      expect(known.launchMode('')).toBeNull();
      expect(known.isKnownLaunch('', rules)).toBe(false);
    } finally {
      Settings.set({momoMeasure: original});
    }
  });

  it('소스에서 이름이 빠지면 도구도 모른다 — 읽는 것이 헛돌지 않는다', () => {
    const source = fs.readFileSync(path.join(MOBILE, 'measure/surfaces.tsx'), 'utf8');
    expect(source).toContain("case 'approved':");
    const broken = known.surfaceRules(source.replace("case 'approved':", "case 'approved-gone':"), path.join(MOBILE, 'measure'));
    expect(rules.exact.has('approved')).toBe(true);
    expect(broken.exact.has('approved')).toBe(false);
    expect(broken.exact.has('approved-gone')).toBe(true);
    // 접두 갈래도 같다.
    const noPin = known.surfaceRules(source.replace("name.startsWith('pin-approval')", "name.startsWith('pin-approval-gone')"), path.join(MOBILE, 'measure'));
    expect(known.isKnownLaunch('pin-approval-approved', noPin)).toBe(false);
    expect(known.isKnownLaunch('pin-approval-approved', rules)).toBe(true);
  });

  it('디스패치 모양이 바뀌면 조용히 틀리지 않고 던진다', () => {
    expect(() => known.surfaceRules('export function Other({name}: {name: string}) { return null; }')).toThrow(/함수 Surface/);
    expect(() =>
      known.surfaceRules("export function Surface({name}: {name: string}) { if (name === 'a') return null; return null; }"),
    ).toThrow(/읽은 것이 이상하다/);
    expect(() =>
      known.surfaceRules(
        "export function Surface({name}: {name: string}) { if (isMissing(name)) return null; switch (name) { case 'a': return null; } return null; }",
      ),
    ).toThrow(/술어 isMissing/);
  });

  it('명령으로 부르면 아는 이름은 0, 모르는 이름은 2 와 이유, 인자가 없으면 64', () => {
    const run = (...args: string[]) => spawnSync(process.execPath, [KNOWN_CLI, ...args], {cwd: MOBILE, encoding: 'utf8'});
    const ok = run('approved', 'LIGHT-APPROVAL-CARD', 'YES');
    expect([ok.status, ok.stderr]).toEqual([0, '']);
    const bad = run('APPROVED', 'WORK-CONSOLE');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('알 수 없는 표면: WORK-CONSOLE');
    expect(bad.stderr).toContain('work-detail'); // 비슷한 이름
    expect(bad.stderr).not.toContain('알 수 없는 표면: APPROVED');
    expect(run().status).toBe(64);
  });
});

describe('measure.sh — 모르는 표면 이름이면 시뮬레이터를 건드리기 전에 멈춘다', () => {
  const script = fs.readFileSync(MEASURE_SH, 'utf8');
  const rules = known.loadRules();
  const captured = [...script.matchAll(/^capture_surface +([A-Za-z0-9+_-]+) +\S+\.png/gm)].map(match => match[1]);

  it('스크립트가 찍는 표면 이름을 실제로 읽었고, 전부 하네스가 안다', () => {
    // 헛돌지 않는다: 이름을 못 읽었으면 아래 「전부 안다」는 아무것도 못 잡는다.
    expect(captured.length).toBeGreaterThanOrEqual(8);
    expect(captured.some(name => name.startsWith('LIGHT-'))).toBe(true);
    const unknown = captured.filter(name => !known.isKnownLaunch(name, rules));
    expect(unknown).toEqual([]);
  });

  it('그 이름들을 실제로 그려도 오류 화면이 아니다', () => {
    const wrong: string[] = [];
    for (const raw of [...new Set(captured)]) {
      const mode = known.launchMode(raw);
      if (mode === null || mode.kind !== 'surface') continue;
      if (showsUnknownFrame(drawn(mode.name, mode.scheme))) wrong.push(raw);
    }
    expect(wrong).toEqual([]);
  });

  /** 스크립트의 한 구획(`# >>> 이름` … `# <<< 이름`). */
  function block(name: string): string | null {
    const match = new RegExp(`^# >>> ${name}\\n([\\s\\S]*?)^# <<< ${name}$`, 'm').exec(script);
    return match === null ? null : match[1];
  }

  /** 스크립트 맨 위 함수 하나(`name() {` … 첫 줄 `}`). */
  function shellFunction(name: string): string | null {
    const match = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(script);
    return match === null ? null : match[0];
  }

  const bash = (code: string, argv0: string, env: Record<string, string> = {}) =>
    spawnSync('bash', ['-c', code, argv0], {cwd: MOBILE, encoding: 'utf8', env: {...process.env, ...env}});

  it('시작 점검: 스크립트가 찍는 이름을 하네스가 전부 알면 통과하고, 모르는 이름이 하나 섞이면 멈춘다', () => {
    const preflight = block('surface-preflight');
    expect(preflight).not.toBeNull();
    const code = `set -euo pipefail\n${preflight}\necho PREFLIGHT-DONE`;
    const pass = bash(code, MEASURE_SH);
    expect([pass.status, pass.stdout.includes('PREFLIGHT-DONE')]).toEqual([0, true]);

    // 같은 구획을 **모르는 이름이 한 줄 더 있는 사본**에 돌린다: 점검이 스크립트 자신의 `capture_surface` 줄을 읽는다는 증거다.
    // 사본은 진짜와 같은 모양의 작은 트리(`scripts/measure.sh` + `measure/` 심볼릭 링크)에 둔다 — 점검은 스크립트 곁의 `../measure/` 를 부른다.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-sh-'));
    const copy = path.join(dir, 'scripts', 'measure.sh');
    const link = path.join(dir, 'measure');
    fs.mkdirSync(path.join(dir, 'scripts'));
    fs.symlinkSync(path.join(MOBILE, 'measure'), link);
    try {
      fs.writeFileSync(copy, `${script}\ncapture_surface NO-SUCH-SURFACE nowhere.png\n`);
      const fail = bash(code, copy);
      expect(fail.status).not.toBe(0);
      expect(fail.stdout.includes('PREFLIGHT-DONE')).toBe(false);
      expect(fail.stderr).toContain('알 수 없는 표면: NO-SUCH-SURFACE');
      // 사본에 그 줄이 없으면(= 위 실패의 원인이 사본의 한 줄뿐이면) 같은 사본이 통과한다.
      fs.writeFileSync(copy, script);
      const again = bash(code, copy);
      expect([again.status, again.stdout.includes('PREFLIGHT-DONE')]).toEqual([0, true]);
    } finally {
      fs.unlinkSync(copy);
      fs.unlinkSync(link);
      fs.rmdirSync(path.join(dir, 'scripts'));
      fs.rmdirSync(dir);
    }
  });

  it('시작 점검은 어느 폴더에서 어떤 경로로 불러도 돈다 — 상대 경로로 불린 스크립트도 자기 줄을 읽는다', () => {
    const preflight = block('surface-preflight');
    expect(preflight).not.toBeNull();
    const code = `set -euo pipefail\n${preflight}\necho PREFLIGHT-DONE`;
    const repoRoot = path.resolve(MOBILE, '../..');
    const callers: ReadonlyArray<readonly [string, string]> = [
      [repoRoot, 'clients/mobile/scripts/measure.sh'],
      [path.join(MOBILE, 'scripts'), './measure.sh'],
      [MOBILE, 'scripts/measure.sh'],
    ];
    for (const [cwd, argv0] of callers) {
      const run = spawnSync('bash', ['-c', code, argv0], {cwd, encoding: 'utf8'});
      expect([cwd, argv0, run.status, run.stdout.includes('PREFLIGHT-DONE')]).toEqual([cwd, argv0, 0, true]);
    }
  });

  it('시작 점검이 시뮬레이터·Metro 를 건드리는 첫 명령과 스크립트의 `cd` 보다 앞에 선다', () => {
    const at = script.indexOf('# >>> surface-preflight');
    expect(at).toBeGreaterThan(0);
    // `cd` 앞인 까닭: 상대 경로로 불린 `$0` 은 `cd` 뒤에는 다른 곳을 가리켜 점검이 자기 줄을 못 읽는다.
    const touching = [
      'cd "$(dirname "$0")/.."',
      'xcrun ',
      'node measure/origin-stub.mjs',
      'defaults write',
      'osascript',
      'react-native/cli.js',
      'mkdir -p',
    ];
    for (const command of touching) {
      const first = script.indexOf(command);
      expect([command, first > at]).toEqual([command, true]); // 못 찾은 명령(-1)도 붉다: 이 목록이 스크립트를 따라간다.
    }
  });

  it('capture_surface 는 모르는 이름이면 앱을 띄우지 않고 실패하고, 아는 이름이면 그 이름으로 띄운다', () => {
    const fn = shellFunction('capture_surface');
    expect(fn).not.toBeNull();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'measure-guard-'));
    const log = path.join(dir, 'xcrun.log');
    // `xcrun`·`sleep` 은 가짜다: 어떤 명령이 불렸는지만 적는다.
    const harness = (name: string) =>
      [
        'set -euo pipefail',
        'xcrun() { echo "xcrun $*" >> "$XCRUN_LOG"; }',
        'sleep() { :; }',
        'BUNDLE_ID=app.momo.ios; OUT_DIR=.; METRO_PORT=8081',
        fn,
        `capture_surface ${name} out.png`,
        'echo CAPTURE-DONE',
      ].join('\n');
    try {
      const bad = bash(harness('NO-SUCH-SURFACE'), 'measure.sh', {XCRUN_LOG: log});
      const launchedForBad = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      expect(bad.status).not.toBe(0);
      expect(bad.stdout.includes('CAPTURE-DONE')).toBe(false);
      expect(bad.stderr).toContain('알 수 없는 표면: NO-SUCH-SURFACE');
      expect(launchedForBad).toBe(''); // 시뮬레이터에 아무것도 시키지 않았다.

      const good = bash(harness('LIGHT-APPROVED'), 'measure.sh', {XCRUN_LOG: log});
      expect([good.status, good.stdout.includes('CAPTURE-DONE')]).toEqual([0, true]);
      const launched = fs.readFileSync(log, 'utf8');
      expect(launched).toMatch(/xcrun simctl launch booted app\.momo\.ios --args -momoMeasure LIGHT-APPROVED /);
      expect(launched).toMatch(/xcrun simctl io booted screenshot \.\/out\.png/);
    } finally {
      if (fs.existsSync(log)) fs.unlinkSync(log);
      fs.rmdirSync(dir);
    }
  });
});
