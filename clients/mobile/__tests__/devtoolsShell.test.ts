import {spawn, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// =============================================================================
// #5531 — 레인·측정 스크립트가 끝날 때, **자기 실행이 띄운** 독립 실행 DevTools 앱만 PID 로 닫는다
//
// `scripts/devtools-shell.sh` 를 가짜 프로세스 목록으로 잰다. `ps`·`kill`·`sleep` 은 함수로 가려 놓았다: 어떤 프로세스도
// 실제로 목록에 올리지도, 신호를 보내지도 않는다(`kill` 은 불린 줄만 적는다). 재는 것:
//   1. 고르기 — Metro 포트가 맞는 `--frontendUrl` 의 PID 만. 다른 포트·더 긴 포트(`:18081`)·Chrome 의 `--app=`·Electron
//      보조 프로세스·Metro 자신은 고르지 않는다.
//   2. 닫기 — 실행 시작 때 이미 떠 있던 것(기준선)은 건드리지 않고, 새로 뜬 것에만 TERM 을 보낸다. TERM 이 안 먹은 것만 다시
//      맞춰 본 뒤 KILL 한다. 그 사이 PID 가 다른 프로세스로 재사용됐으면 신호를 보내지 않는다. PID 1·자기 자신·부모는 절대 아니다.
//   3. 이어 붙인 쪽 — `measure.sh` 의 종료 처리 함수(`cleanup_run`)가 실제로 이 일을 하고 Metro 를 끝내기 앞에 한다. 레인은
//      소스에서 같은 순서를 센다(레인의 `cleanup` 은 compose·docker 를 부르는 큰 함수라 통째로 돌리지 않는다).
//
// 못 재는 것: 진짜 DevTools 앱(Electron)의 `ps` 줄 모양과 레인 한 번 뒤의 프로세스 수(`runtime-unverified`) — 다음 폰 검증
// 회차가 `ps -axo pid,command | grep -c -- '--frontendUrl='` 로 잰다. 대신 진짜 `ps` 의 출력 모양은 아래 「진짜 ps」 시험이
// 인자에 `--frontendUrl=` 를 단 해롭지 않은 프로세스로 읽어 본다.
// =============================================================================

const MOBILE = path.resolve(__dirname, '..');
const LIB = path.join(MOBILE, 'scripts/devtools-shell.sh');
const LANE_SH = path.join(MOBILE, 'scripts/lane-phone.sh');
const MEASURE_SH = path.join(MOBILE, 'scripts/measure.sh');

/** macOS 의 기본 bash(3.2)와 PATH 의 bash 둘 다: 이 스크립트는 두 곳에서 다 돈다. */
const SHELLS = ['bash', '/bin/bash'].filter(shell => shell === 'bash' || fs.existsSync(shell));

const APP =
  '/Users/dev/Library/Caches/dotslash/3f9a/React Native DevTools.app/Contents/MacOS/React Native DevTools';
const frontendUrl = (host: string, port: number) =>
  `--frontendUrl=http://${host}:${port}/debugger-frontend/rn_fusebox.html?ws=%2Finspector%2Fdebug%3Fdevice%3Dab12%26page%3D1&sources.hide_add_folder=true --windowKey=9c1f`;

/** `ps -A -ww -o pid=,command=` 가 찍는 모양: 오른쪽 맞춤한 PID, 공백, 명령줄. */
const row = (pid: number, command: string) => `${String(pid).padStart(5)} ${command}`;

const ROWS = {
  launchd: row(1, '/sbin/launchd'),
  metro: row(3900, 'node node_modules/react-native/cli.js start --port 8081'),
  mine: row(4101, `${APP} ${frontendUrl('localhost', 8081)}`),
  mineByIp: row(4102, `${APP} ${frontendUrl('127.0.0.1', 8081)}`),
  mineV6: row(4104, `${APP} ${frontendUrl('[::1]', 8081)}`),
  alreadyOpen: row(4103, `${APP} ${frontendUrl('localhost', 8081)}`),
  otherPort: row(4201, `${APP} ${frontendUrl('localhost', 8471)}`),
  longerPort: row(4301, `${APP} ${frontendUrl('localhost', 18081)}`),
  prefixPort: row(4302, `${APP} ${frontendUrl('localhost', 80810)}`),
  chrome: row(
    4401,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome --app=http://localhost:8081/debugger-frontend/rn_fusebox.html?ws=x --window-size=1200,600',
  ),
  helper: row(
    4501,
    `${APP} Helper (GPU).app/Contents/MacOS/React Native DevTools Helper (GPU) --type=gpu-process --user-data-dir=/Users/dev/Library/Application Support/React Native DevTools`,
  ),
};

interface Ran {
  status: number | null;
  stdout: string;
  stderr: string;
  /** `kill` 과 `xcrun` 가짜가 불린 순서대로 적은 줄. */
  calls: string[];
}

/**
 * `body` 를 라이브러리를 읽어 들인 `set -euo pipefail` 셸에서 돌린다. `ps` 는 `table` 을 그대로 내고, `kill` 은 부른 줄을 적는다
 * (`quits`: TERM·KILL 이면 그 줄이 목록에서 사라진다 / `STUBBORN`: 그 PID 만 TERM 을 무시한다 / `REUSED`: TERM 뒤에 그 PID 가
 * 전혀 다른 프로세스가 된다).
 */
function run(shell: string, table: string[], body: string, env: Record<string, string> = {}): Ran {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtools-shell-'));
  const tableFile = path.join(dir, 'table.txt');
  const callLog = path.join(dir, 'calls.log');
  fs.writeFileSync(tableFile, `${table.join('\n')}\n`);
  fs.writeFileSync(callLog, '');
  const code = [
    'set -euo pipefail',
    `. "${LIB}"`,
    'ps() { cat "$TABLE_FILE"; }',
    'sleep() { :; }',
    'drop_row() { grep -v -E "^ *$1 " "$TABLE_FILE" > "$TABLE_FILE.new" || true; mv "$TABLE_FILE.new" "$TABLE_FILE"; }',
    'swap_row() { grep -v -E "^ *$1 " "$TABLE_FILE" > "$TABLE_FILE.new" || true; printf "%5s /usr/bin/vim notes.txt\\n" "$1" >> "$TABLE_FILE.new"; mv "$TABLE_FILE.new" "$TABLE_FILE"; }',
    'kill() {',
    '  echo "kill $*" >> "$CALL_LOG"',
    '  case "$1:${2:-}" in',
    '    -TERM:"${STUBBORN:-none}") ;;',
    '    -TERM:"${REUSED:-none}") swap_row "$2" ;;',
    '    -TERM:* | -KILL:*) drop_row "$2" ;;',
    '  esac',
    '}',
    body,
  ].join('\n');
  const result = spawnSync(shell, ['-c', code], {
    encoding: 'utf8',
    env: {...process.env, TABLE_FILE: tableFile, CALL_LOG: callLog, ...env},
  });
  const calls = fs.readFileSync(callLog, 'utf8').split('\n').filter(Boolean);
  for (const leftover of [tableFile, `${tableFile}.new`, callLog]) {
    if (fs.existsSync(leftover)) fs.unlinkSync(leftover);
  }
  fs.rmdirSync(dir);
  return {status: result.status, stdout: result.stdout, stderr: result.stderr, calls};
}

const lines = (text: string) => text.split('\n').filter(Boolean);

describe.each(SHELLS)('scripts/devtools-shell.sh — %s', shell => {
  const everyone = [
    ROWS.launchd,
    ROWS.metro,
    ROWS.mine,
    ROWS.mineByIp,
    ROWS.alreadyOpen,
    ROWS.mineV6,
    ROWS.otherPort,
    ROWS.longerPort,
    ROWS.prefixPort,
    ROWS.chrome,
    ROWS.helper,
  ];

  describe('고르기 — Metro 포트가 맞는 --frontendUrl 만', () => {
    it('8081: localhost·127.0.0.1·[::1] 로 열린 것만 고른다 (더 긴 포트·다른 포트·Chrome·보조 프로세스·Metro 는 아니다)', () => {
      const ran = run(shell, everyone, 'devtools_pids_for_port 8081');
      expect([ran.status, ran.stderr]).toEqual([0, '']);
      expect(lines(ran.stdout)).toEqual(['4101', '4102', '4103', '4104']);
    });

    it('포트마다 자기 것만 고른다: 8471 은 8471, 18081 은 18081, 80810 은 80810', () => {
      expect(lines(run(shell, everyone, 'devtools_pids_for_port 8471').stdout)).toEqual(['4201']);
      expect(lines(run(shell, everyone, 'devtools_pids_for_port 18081').stdout)).toEqual(['4301']);
      expect(lines(run(shell, everyone, 'devtools_pids_for_port 80810').stdout)).toEqual(['4302']);
    });

    it('맞는 것이 없으면 아무것도 내지 않고 0 으로 끝난다 (pipefail 아래서도)', () => {
      const ran = run(shell, [ROWS.launchd, ROWS.metro], 'devtools_pids_for_port 8081; echo after');
      expect([ran.status, ran.stdout]).toEqual([0, 'after\n']);
    });

    it.each(['', 'abc', '80 81', '8081;echo', '-1'])('숫자가 아닌 포트 %p 는 2 로 거절하고 아무것도 고르지 않는다', port => {
      const ran = run(shell, everyone, `devtools_pids_for_port '${port}' || echo "status=$?"`);
      expect(ran.stdout).toBe('status=2\n');
    });

    it('기준선은 같은 PID 를 한 줄에 공백으로 이어 낸다', () => {
      const ran = run(shell, everyone, 'devtools_baseline_for_port 8081');
      expect(ran.stdout).toBe('4101 4102 4103 4104 ');
    });
  });

  describe('닫기 — 기준선 뒤에 새로 뜬 것만, 정확한 PID 로', () => {
    it('기준선에 있던 창·다른 포트·Chrome·보조 프로세스·Metro 는 건드리지 않고, 새로 뜬 것에만 TERM 을 보낸다', () => {
      const ran = run(shell, everyone, 'devtools_shells_close 8081 "4103 "');
      expect(ran.status).toBe(0);
      // 목록 순서대로 새 것만. 셋 다 TERM 으로 사라졌으니 KILL 은 없다.
      expect(ran.calls).toEqual(['kill -TERM 4101', 'kill -TERM 4102', 'kill -TERM 4104']);
      // 한 줄 기록은 stderr 로 나간다(레인에서는 `say` 가 stdout 의 `[lane]` 줄로 낸다).
      expect(ran.stderr).toMatch(/closed the DevTools window\(s\) this run opened \(Metro :8081\), pid: 4101 4102 4104/);
    });

    it('새로 뜬 것이 없으면 아무 신호도 보내지 않고 그렇게 적는다 (레인 로그가 그 한 줄을 증거로 남긴다)', () => {
      const ran = run(shell, everyone, 'devtools_shells_close 8081 "4101 4102 4103 4104"');
      expect(ran.calls).toEqual([]);
      expect(ran.stderr).toContain('no DevTools window left open by this run (Metro :8081)');
    });

    it('다른 Metro 포트의 창만 있으면 이 포트의 닫기는 아무것도 하지 않는다', () => {
      const ran = run(shell, [ROWS.metro, ROWS.otherPort], 'devtools_shells_close 8081 ""');
      expect(ran.calls).toEqual([]);
    });

    it('TERM 이 안 먹은 것만 KILL 한다 (먹은 것은 다시 신호를 받지 않는다)', () => {
      const ran = run(shell, [ROWS.mine, ROWS.mineByIp, ROWS.otherPort], 'devtools_shells_close 8081 ""', {STUBBORN: '4102'});
      expect(ran.calls).toEqual(['kill -TERM 4101', 'kill -TERM 4102', 'kill -KILL 4102']);
      expect(ran.stderr).toContain('needed SIGKILL: 4102');
    });

    it('TERM 과 확인 사이에 PID 가 다른 프로세스로 재사용됐으면 KILL 을 보내지 않는다', () => {
      const ran = run(shell, [ROWS.mine, ROWS.mineByIp], 'devtools_shells_close 8081 ""', {REUSED: '4101'});
      expect(ran.calls).toEqual(['kill -TERM 4101', 'kill -TERM 4102']);
    });

    it('PID 1·자기 자신·부모는 목록에 있어도 절대 신호를 받지 않는다', () => {
      const url = 'http://localhost:8081/debugger-frontend/x';
      const ran = run(
        shell,
        [ROWS.metro],
        [
          `printf ' %5s /sbin/launchd --frontendUrl=${url}\\n' 1 >> "$TABLE_FILE"`,
          `printf ' %5s /bin/bash --frontendUrl=${url}\\n' "$$" >> "$TABLE_FILE"`,
          `printf ' %5s /bin/zsh --frontendUrl=${url}\\n' "$PPID" >> "$TABLE_FILE"`,
          'devtools_shells_close 8081 ""',
        ].join('\n'),
      );
      expect([ran.status, ran.calls]).toEqual([0, []]);
      expect(ran.stderr).toContain('no DevTools window left open by this run');
    });
  });
});

describe('진짜 ps — 인자에 --frontendUrl= 을 단 해롭지 않은 프로세스를 읽는다', () => {
  it('진짜 ps 의 출력에서 그 PID 를 그 포트로만 고른다', () => {
    const port = 40000 + (process.pid % 10000);
    // 오래 사는 시늉만 하고 스스로 끝난다(이 시험은 어떤 신호도 보내지 않는다). 인자의 `--` 뒤는 node 가 읽지 않는다.
    const dummy = spawn(
      process.execPath,
      ['-e', 'setTimeout(function () {}, 5000)', '--', `--frontendUrl=http://localhost:${port}/debugger-frontend/rn_fusebox.html?x=1`],
      {stdio: 'ignore'},
    );
    dummy.unref();
    const asked = (askedPort: number) =>
      spawnSync('bash', ['-c', `set -euo pipefail; . "${LIB}"; devtools_pids_for_port ${askedPort}`], {encoding: 'utf8'});
    const found = asked(port);
    expect([found.status, lines(found.stdout)]).toEqual([0, [String(dummy.pid)]]);
    // 같은 프로세스가 다른 포트로 묻는 쪽에는 잡히지 않는다. 프로세스는 신호 없이 5초 안에 혼자 사라진다.
    expect(lines(asked(port + 1).stdout)).toEqual([]);
  });
});

describe('이어 붙인 쪽 — 스크립트가 실제로 이 일을 한다', () => {
  const measureSource = fs.readFileSync(MEASURE_SH, 'utf8');
  const cleanupRun = /^cleanup_run\(\) \{\n[\s\S]*?^\}$/m.exec(measureSource)?.[0] ?? '';
  const table = [ROWS.metro, ROWS.mine, ROWS.alreadyOpen, ROWS.otherPort, ROWS.chrome];

  const measureCleanup = (assign: string) =>
    run(
      'bash',
      table,
      `${cleanupRun}\nxcrun() { echo "xcrun $*" >> "$CALL_LOG"; }\n${assign}\ncleanup_run`,
    );

  it('measure.sh 의 cleanup_run 이 있다', () => {
    expect(cleanupRun).toContain('devtools_shells_close');
  });

  it('measure.sh: 기준선을 잡은 뒤에는 Metro 를 끝내기 앞에, 새 창에만 TERM 을 보낸다', () => {
    const ran = measureCleanup(
      'STUB_PID=111; OWN_METRO_PID=222; ORIGINAL_CONTENT_SIZE=large; METRO_PORT=8081; DEVTOOLS_BASELINE_TAKEN=1; DEVTOOLS_BASELINE="4103 "',
    );
    expect(ran.status).toBe(0);
    expect(ran.stderr).toContain('closed the DevTools window(s) this run opened (Metro :8081), pid: 4101');
    expect(ran.calls).toEqual([
      'kill 111',
      'kill -TERM 4101',
      'kill 222',
      'xcrun simctl ui booted content_size large',
    ]);
  });

  it('measure.sh: 기준선을 못 잡은 채 끝나면(Metro 가 안 뜬 경우) 창은 건드리지 않고 나머지는 그대로 한다', () => {
    const ran = measureCleanup(
      'STUB_PID=111; OWN_METRO_PID=222; ORIGINAL_CONTENT_SIZE=large; METRO_PORT=8081; DEVTOOLS_BASELINE_TAKEN=0; DEVTOOLS_BASELINE=""',
    );
    expect([ran.stderr, ran.calls]).toEqual(['', ['kill 111', 'kill 222', 'xcrun simctl ui booted content_size large']]);
  });

  it('measure.sh: 맨 처음(아무 이름도 채워지기 전)에 불려도 set -u 에서 오류 없이 아무것도 하지 않는다', () => {
    const ran = measureCleanup('unset STUB_PID OWN_METRO_PID ORIGINAL_CONTENT_SIZE METRO_PORT DEVTOOLS_BASELINE_TAKEN DEVTOOLS_BASELINE');
    expect([ran.status, ran.stderr, ran.calls]).toEqual([0, '', []]);
  });

  it('measure.sh: 종료 처리는 하나뿐이고(trap 은 cleanup_run 만 건다) 기준선은 앱을 켜기 앞에 잡는다', () => {
    const traps = measureSource.split('\n').filter(line => /^\s*trap\s/.test(line));
    expect(traps).toEqual(['trap cleanup_run EXIT']);
    const baseline = measureSource.indexOf('DEVTOOLS_BASELINE="$(devtools_baseline_for_port "$METRO_PORT")"');
    const firstLaunch = measureSource.indexOf('xcrun simctl launch booted "$BUNDLE_ID"');
    expect(baseline).toBeGreaterThan(0);
    expect(baseline).toBeLessThan(firstLaunch);
  });

  it('lane-phone.sh: 라이브러리를 읽고, 기준선은 Metro 가 선 뒤 첫 흐름 앞에서 잡고, 종료 처리에서 Metro 를 끝내기 앞에 닫는다', () => {
    const lane = fs.readFileSync(LANE_SH, 'utf8');
    const at = (needle: string, from = 0) => {
      const index = lane.indexOf(needle, from);
      expect(index).toBeGreaterThanOrEqual(0);
      return index;
    };
    const cleanupStart = at('\ncleanup() {');
    const sourced = at('. "$APP_ROOT/scripts/devtools-shell.sh"');
    expect(sourced).toBeLessThan(cleanupStart);

    const cleanupBody = lane.slice(cleanupStart, at('\ntrap cleanup EXIT', cleanupStart));
    const sweep = cleanupBody.indexOf('devtools_shells_close "$METRO_PORT" "$DEVTOOLS_BASELINE"');
    expect(sweep).toBeGreaterThan(0);
    // 기준선을 잡은 뒤에만, 그리고 Metro 를 끝내기 앞에.
    expect(cleanupBody.slice(Math.max(0, sweep - 80), sweep)).toContain('DEVTOOLS_BASELINE_TAKEN');
    expect(sweep).toBeLessThan(cleanupBody.indexOf('kill -TERM "-$METRO_PID"'));

    const metroReady = at('say "reusing the Metro already serving this checkout');
    const baseline = at('DEVTOOLS_BASELINE="$(devtools_baseline_for_port "$METRO_PORT")"');
    const flows = at('RESULTS=()');
    expect(baseline).toBeGreaterThan(metroReady);
    expect(baseline).toBeLessThan(flows);
    expect(lane).toContain('DEVTOOLS_BASELINE_TAKEN=1');
  });

  it.each([LIB, LANE_SH, MEASURE_SH])('bash -n %s', file => {
    const syntax = spawnSync('bash', ['-n', file], {encoding: 'utf8'});
    expect([syntax.status, syntax.stderr]).toEqual([0, '']);
  });
});
