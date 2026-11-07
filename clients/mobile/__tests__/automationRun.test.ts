import fs from 'node:fs';
import path from 'node:path';
import {LogBox, Settings} from 'react-native';

import '../src/boot/polyfills';
import '../src/boot/coreHost';

import {
  AUTOMATION_ARGUMENT,
  automationRun,
  silenceLogBoxForAutomation,
} from '../measure/automation';

// =============================================================================
// #5531 — 시험 실행이 사람의 화면에 「React Native DevTools」 창을 띄우지 않게
//
// 원인: 디버그 빌드 아래쪽의 LogBox 띠(「Open debugger to view warnings.」)를 Maestro 탭이 누르면 Metro 가 독립 실행
// DevTools 앱을 띄운다(RN 0.86). 고침의 한 가닥이 이 파일이 재는 것이다: 시험 도구가 켠 디버그 실행에서는 앱이 시작할 때
// `LogBox.ignoreAllLogs(true)` 를 불러 띠를 처음부터 세우지 않는다. 다른 가닥(레인·측정 스크립트가 자기 Metro 포트의
// DevTools 앱을 닫는다)은 `devtoolsShell.test.ts` 가 잰다.
//
// 이 파일이 재는 것:
//   1. 읽는 쪽 — 어떤 실행 인자가 「시험 실행」이고 어떤 것이 아닌가, 출시 빌드는 어떤 인자에도 평소 앱인가.
//   2. 거는 쪽 — 켠 경우에만 `LogBox.ignoreAllLogs(true)` 가 불리고 실제로 LogBox 가 꺼진다(불린 횟수와 상태 둘 다).
//   3. 이어 붙인 쪽 — `index.js` 를 실제로 평가해 루트를 등록하기 **전**에 한 번 불린다. 함수가 옳아도 아무도 안 부르면
//      아무것도 고쳐지지 않는다.
//   4. Maestro 쪽 — 앱을 새로 켜는 `launchApp` 마다 그 인자가 실려 있다(없는 흐름이 하나라도 있으면 그 흐름이 띠를 세운다).
//
// 못 재는 것: 시뮬레이터에서 띠가 정말 안 서는지, DevTools 프로세스가 정말 0인지(`runtime-unverified`) — 다음 폰 검증 회차가
// 레인 한 번 뒤 `ps` 와 00-login 환영 화면 캡처로 잰다.
// =============================================================================

const APP_ROOT = path.resolve(__dirname, '..');
const MAESTRO_DIR = path.join(APP_ROOT, 'maestro');

/** 이 시험이 건드리는 실행 인자 이름 전부. */
const ARGUMENT_NAMES = [AUTOMATION_ARGUMENT, 'momoMeasure', 'momoSessionGate', 'momoGateControl'];

/** 인자 이름 → 값을 걸고 `body` 를 돌린 뒤 원래대로 돌려 놓는다. */
function withLaunchArguments<T>(values: Record<string, unknown>, body: () => T): T {
  const original = Object.fromEntries(ARGUMENT_NAMES.map(name => [name, Settings.get(name)]));
  Settings.set(Object.fromEntries(ARGUMENT_NAMES.map(name => [name, undefined])));
  Settings.set(values);
  try {
    return body();
  } finally {
    Settings.set(original);
  }
}

/** 출시 빌드를 흉내 낸다: 앱 코드의 `__DEV__` 는 부를 때마다 읽는 전역이다. */
function asReleaseBuild<T>(body: () => T): T {
  const scope = globalThis as unknown as {__DEV__: boolean};
  const original = scope.__DEV__;
  scope.__DEV__ = false;
  try {
    return body();
  } finally {
    scope.__DEV__ = original;
  }
}

/** LogBox 가 정말 꺼졌는지는 호출 기록이 아니라 RN 자신의 상태로 읽는다. */
const logBoxIsDisabled = (): boolean =>
  (jest.requireActual('react-native/Libraries/LogBox/Data/LogBoxData') as {isDisabled: () => boolean}).isDisabled();

describe('automationRun — 시험 인자가 있을 때만 켜진다', () => {
  it.each(['YES', '1', 'true', 'maestro'])('-momoAutomation %s 는 시험 실행이다', value => {
    expect(withLaunchArguments({[AUTOMATION_ARGUMENT]: value}, automationRun)).toBe(true);
  });

  it.each([undefined, '', 'NO', 'false', '0', 'off'])(
    '-momoAutomation %p 는 평소 앱이다 (인자가 없는 개발 실행 포함)',
    value => {
      expect(withLaunchArguments({[AUTOMATION_ARGUMENT]: value}, automationRun)).toBe(false);
    },
  );

  it('계측 하네스(-momoMeasure)와 세션 게이트(-momoSessionGate + -momoGateControl)도 스크립트가 켠 실행이다', () => {
    expect(withLaunchArguments({momoMeasure: 'YES'}, automationRun)).toBe(true);
    expect(withLaunchArguments({momoMeasure: 'LIGHT-APPROVED'}, automationRun)).toBe(true);
    expect(
      withLaunchArguments({momoSessionGate: 'login', momoGateControl: 'http://127.0.0.1:52344'}, automationRun),
    ).toBe(true);
    // 하네스 읽는 쪽이 「아니다」라고 답하는 모양은 여기서도 아니다.
    expect(withLaunchArguments({momoMeasure: ''}, automationRun)).toBe(false);
    expect(withLaunchArguments({momoSessionGate: 'login'}, automationRun)).toBe(false);
  });

  it('출시 빌드는 누가 어떤 인자를 넘겨도 평소 앱이다', () => {
    const everything = {
      [AUTOMATION_ARGUMENT]: 'YES',
      momoMeasure: 'YES',
      momoSessionGate: 'login',
      momoGateControl: 'http://127.0.0.1:52344',
    };
    expect(withLaunchArguments(everything, automationRun)).toBe(true);
    expect(withLaunchArguments(everything, () => asReleaseBuild(automationRun))).toBe(false);
  });
});

describe('silenceLogBoxForAutomation — 켠 경우에만 LogBox.ignoreAllLogs(true)', () => {
  let ignoreAllLogs: jest.SpyInstance;

  beforeEach(() => {
    // 실제 구현으로 부른다(대신 막지 않는다): 불린 횟수와 LogBox 의 실제 상태를 함께 잰다.
    ignoreAllLogs = jest.spyOn(LogBox, 'ignoreAllLogs');
  });

  afterEach(() => {
    ignoreAllLogs.mockRestore();
    LogBox.ignoreAllLogs(false);
  });

  it('시험 인자가 있으면 한 번 부르고 LogBox 알림이 실제로 꺼진다', () => {
    expect(logBoxIsDisabled()).toBe(false);
    const switched = withLaunchArguments({[AUTOMATION_ARGUMENT]: 'YES'}, silenceLogBoxForAutomation);
    expect(switched).toBe(true);
    expect(ignoreAllLogs.mock.calls).toEqual([[true]]);
    expect(logBoxIsDisabled()).toBe(true);
  });

  it('인자가 없으면 부르지 않고 LogBox 는 그대로다', () => {
    const switched = withLaunchArguments({}, silenceLogBoxForAutomation);
    expect(switched).toBe(false);
    expect(ignoreAllLogs).not.toHaveBeenCalled();
    expect(logBoxIsDisabled()).toBe(false);
  });

  it('출시 빌드는 인자가 있어도 부르지 않는다', () => {
    const switched = withLaunchArguments({[AUTOMATION_ARGUMENT]: 'YES'}, () => asReleaseBuild(silenceLogBoxForAutomation));
    expect(switched).toBe(false);
    expect(ignoreAllLogs).not.toHaveBeenCalled();
    expect(logBoxIsDisabled()).toBe(false);
  });
});

// `index.js` 를 실제로 평가한다(`foregroundPresentation.test.tsx` 의 「시작 경로」와 같은 방법): 격리된 모듈 레지스트리에서
// `react-native` 의 `Settings`·`LogBox`·`AppRegistry` 가 `index.js` 와 이 시험에 같은 것이다.
describe('index.js — 루트를 등록하기 전에, 시험 실행에서만 한 번 부른다', () => {
  interface Evaluation {
    ignoreCalls: unknown[][];
    ignoreOrder: number;
    registerCalls: number;
    registerOrder: number;
  }

  function evaluateIndex(launchArguments: Record<string, unknown>): Evaluation {
    const result: Evaluation = {ignoreCalls: [], ignoreOrder: 0, registerCalls: -1, registerOrder: Number.POSITIVE_INFINITY};
    jest.isolateModules(() => {
      const {AppRegistry, LogBox: isolatedLogBox, Settings: isolatedSettings} = require('react-native');
      isolatedSettings.set(launchArguments);
      const register = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'MomoMobile');
      const ignore = jest.spyOn(isolatedLogBox, 'ignoreAllLogs').mockImplementation(() => {});
      require('../index');
      result.ignoreCalls = ignore.mock.calls;
      result.ignoreOrder = ignore.mock.invocationCallOrder[0] ?? 0;
      result.registerCalls = register.mock.calls.length;
      result.registerOrder = register.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;
    });
    return result;
  }

  it('시험 인자로 켠 실행: index.js 를 평가하면 ignoreAllLogs(true) 가 한 번, 루트 등록보다 앞에서 불린다', () => {
    const run = evaluateIndex({[AUTOMATION_ARGUMENT]: 'YES'});
    expect(run.ignoreCalls).toEqual([[true]]);
    expect(run.registerCalls).toBe(1);
    expect(run.ignoreOrder).toBeGreaterThan(0);
    expect(run.ignoreOrder).toBeLessThan(run.registerOrder);
  });

  it('인자 없는 개발 실행: index.js 를 평가해도 LogBox 는 건드리지 않고 루트는 그대로 등록된다', () => {
    const run = evaluateIndex({});
    expect(run.ignoreCalls).toEqual([]);
    expect(run.registerCalls).toBe(1);
  });

  const codeOnly = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  it('index.js 소스에서도 호출이 두 boot import 뒤, registerComponent 앞에 있고 호출하는 파일은 index.js 하나다', () => {
    const source = codeOnly(fs.readFileSync(path.join(APP_ROOT, 'index.js'), 'utf8'));
    const at = (needle: string) => {
      const index = source.indexOf(needle);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const call = at('silenceLogBoxForAutomation();');
    expect(call).toBeGreaterThan(at("'./src/boot/polyfills'"));
    expect(call).toBeGreaterThan(at("'./src/boot/coreHost'"));
    expect(call).toBeLessThan(at('AppRegistry.registerComponent('));

    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, {withFileTypes: true})) {
        if (['node_modules', 'Pods', 'build', '__tests__', 'ios', 'android'].includes(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !/^jest\./.test(entry.name)) {
          if (/(?<!function\s)\bsilenceLogBoxForAutomation\s*\(/.test(codeOnly(fs.readFileSync(full, 'utf8')))) {
            callers.push(path.relative(APP_ROOT, full));
          }
        }
      }
    };
    walk(APP_ROOT);
    // 정의(`export function silenceLogBoxForAutomation(`)는 세지 않는다. 호출은 index.js 하나다.
    expect(callers).toEqual(['index.js']);
  });
});

// =============================================================================
// Maestro 흐름 — 앱을 새로 켜는 `launchApp` 마다 시험 인자가 실려 있다
//
// 인자가 빠진 흐름은 조용히 띠를 세운다(앱은 평소처럼 켜지고, 그 흐름의 탭이 띠를 누르면 DevTools 창이 뜬다). 눈으로는 안
// 보이는 회귀라서 흐름 파일을 읽어 센다. 값은 **따옴표 친 문자열**이어야 한다: Maestro 2.8 은 YAML 불리언 값에는 `-` 를 붙이지
// 않고 넘겨(`momoAutomation true`) iOS 가 실행 인자로 읽지 않는다 — 그러면 아무 일도 안 일어나는데 흐름은 초록이다.
// 예외는 `stopApp: false`(이미 떠 있는 앱을 앞으로 가져올 뿐이라 새 프로세스가 아니다).
// =============================================================================

/** `- launchApp` 항목마다 그 항목의 들여쓴 본문(없으면 빈 문자열). */
function launchAppBlocks(source: string): string[] {
  const lines = source.split('\n');
  const blocks: string[] = [];
  lines.forEach((line, at) => {
    const head = /^(\s*)- launchApp:?\s*$/.exec(line);
    if (head === null) return;
    const indent = head[1].length;
    const body: string[] = [];
    for (const next of lines.slice(at + 1)) {
      if (next.trim() === '' || next.length - next.trimStart().length <= indent) break;
      body.push(next);
    }
    blocks.push(body.join('\n'));
  });
  return blocks;
}

/** 이 `launchApp` 본문이 시험 인자를 싣는가(재시작 없는 이어받기는 해당 없음). */
function carriesAutomationArgument(block: string): boolean {
  if (/^\s*stopApp:\s*false\s*$/m.test(block)) return true;
  return (
    /^\s*arguments:\s*$/m.test(block) &&
    new RegExp(`^\\s+${AUTOMATION_ARGUMENT}:\\s*"[^"\\n]+"\\s*$`, 'm').test(block)
  );
}

function flowFiles(dir: string): string[] {
  return fs.readdirSync(dir, {withFileTypes: true}).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return flowFiles(full);
    return entry.name.endsWith('.yaml') ? [full] : [];
  });
}

describe('Maestro 흐름 — launchApp 마다 -momoAutomation 이 실려 있다', () => {
  it('앱을 새로 켜는 launchApp 은 하나도 빠짐없이 따옴표 친 값으로 인자를 싣는다', () => {
    const offenders: string[] = [];
    let counted = 0;
    for (const file of flowFiles(MAESTRO_DIR)) {
      const blocks = launchAppBlocks(fs.readFileSync(file, 'utf8'));
      counted += blocks.length;
      blocks.forEach((block, index) => {
        if (!carriesAutomationArgument(block)) offenders.push(`${path.relative(MAESTRO_DIR, file)} #${index + 1}`);
      });
    }
    // 이 시험이 아무것도 안 세고 통과하지 못하게: 지금 흐름은 launchApp 이 스무 개 넘게 있다.
    expect(counted).toBeGreaterThanOrEqual(20);
    expect(offenders).toEqual([]);
  });

  it('센서가 헛돌지 않는다 — 빠진 것·따옴표 없는 값·다른 이름은 걸리고, 갖춘 것은 통과한다', () => {
    const verdict = (yaml: string) => launchAppBlocks(yaml).map(carriesAutomationArgument);
    const good = `- launchApp:\n    appId: app.momo.ios\n    arguments:\n      ${AUTOMATION_ARGUMENT}: "YES"\n- runFlow: x.yaml\n`;
    const noArguments = '- launchApp:\n    appId: app.momo.ios\n- runFlow: x.yaml\n';
    const bare = '- launchApp\n- runFlow: x.yaml\n';
    const boolean = `- launchApp:\n    appId: app.momo.ios\n    arguments:\n      ${AUTOMATION_ARGUMENT}: true\n`;
    const otherName = '- launchApp:\n    appId: app.momo.ios\n    arguments:\n      momoMeasure: "YES"\n';
    const resume = '- launchApp:\n    stopApp: false\n';
    expect(verdict(good)).toEqual([true]);
    expect(verdict(noArguments)).toEqual([false]);
    expect(verdict(bare)).toEqual([false]);
    expect(verdict(boolean)).toEqual([false]);
    expect(verdict(otherName)).toEqual([false]);
    expect(verdict(resume)).toEqual([true]);
    expect(verdict(`${good}${noArguments}`)).toEqual([true, false]);
  });
});
