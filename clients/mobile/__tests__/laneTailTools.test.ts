import {spawn, spawnSync} from 'node:child_process';
import {chmodSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync} from 'node:fs';
import {get} from 'node:http';
import {createServer as createNetServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// =============================================================================
// 폰 레인의 두 도구 (#5310) — `scripts/lane-tail-check.mjs` · `scripts/lane-api-ctl.mjs`.
//
// 둘 다 **눈과 손**이라 헛보거나 아무 데나 손대면 레인이 거짓 초록이 되거나 남의 서버를 내린다. 그래서 둘 다 실패할 수 있다는 것을 잰다.
//   ① 잘린 양 재기: 잘린 계층(마지막 행 아래 끝이 목록 아래 끝을 넘는다)에서 붉고(종료 1), 온전한 계층에서 초록이며(0), 목록·행이 없으면 모른다고 말한다(2).
//      Maestro 의 `assertVisible` 은 잘린 행도 「보인다」고 세므로(경계가 화면에 걸치면 된다) 이 도구가 흐름의 유일한 눈이다.
//   ② api 컨트롤러: **그 프로젝트의 api 컨테이너 하나**만, stop·start·status 셋만 한다 — 가짜 `docker` 가 받은 인자를 그대로 기록해서 읽는다. 프로젝트가 없거나 모양이 틀리면
//      아무것도 안 하고 끝난다(기본값이 있으면 남의 레인을 내릴 수 있다). 끝날 때(SIGTERM)는 api 를 올려 두고 나간다.
// =============================================================================

const TAIL = join(__dirname, '..', 'scripts', 'lane-tail-check.mjs');
const CTL = join(__dirname, '..', 'scripts', 'lane-api-ctl.mjs');

interface Node {
  attributes: {bounds: string; 'resource-id'?: string; accessibilityText?: string};
  children?: Node[];
}

function node(id: string, top: number, bottom: number, name = '', children: Node[] = []): Node {
  return {
    attributes: {bounds: `[0,${top}][390,${bottom}]`, 'resource-id': id, accessibilityText: name},
    children,
  };
}

/** `maestro hierarchy` 모양의 계층: 화면 아래 목록(`timeline-list`)과 그 안의 행들. */
function hierarchy(listBottom: number, rows: Array<[number, number, string]>): string {
  const tree = node('', 0, 874, '', [
    node(
      'timeline-list',
      -300,
      listBottom,
      '',
      rows.map(([top, bottom, name]) => node('message-row', top, bottom, name)),
    ),
  ]);
  // Maestro 는 JSON 앞에 경고 줄을 찍는 일이 있다(`WARNING: …`) — 도구가 그 앞을 건너뛴다.
  return `WARNING: something on stderr-ish\n${JSON.stringify(tree)}`;
}

function runTail(json: string, extra: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'tail-check-'));
  const file = join(dir, 'hier.json');
  writeFileSync(file, json);
  try {
    const result = spawnSync('node', [TAIL, file, ...extra], {encoding: 'utf8'});
    return {rc: result.status, out: result.stdout.trim(), err: result.stderr.trim()};
  } finally {
    unlinkSync(file);
    rmdirSync(dir);
  }
}

describe('잘린 양 재기 (lane-tail-check)', () => {
  it('온전한 계층(마지막 행 아래 끝 = 목록 아래 끝)에서는 0 이고 종료 0', () => {
    const result = runTail(hierarchy(401, [[200, 299, '앞 행'], [309, 401, '마지막 행']]));
    expect(result.rc).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({cutPt: 0, listBottom: 401, lastRowBottom: 401, lastRow: '마지막 행'});
  });

  it('마지막 행이 목록 아래 끝을 20pt 넘으면 20 이고 종료 1 — 5b 의 그림이다', () => {
    const result = runTail(hierarchy(401, [[200, 299, '앞 행'], [329, 421, '마지막 행']]));
    expect(result.rc).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({cutPt: 20, listBottom: 401, lastRowBottom: 421});
  });

  it('마지막 행은 위 끝이 가장 아래인 행이다(목록에 나온 순서가 아니라)', () => {
    const result = runTail(hierarchy(401, [[329, 421, '맨 아래 행'], [200, 299, '앞 행']]));
    expect(JSON.parse(result.out).lastRow).toBe('맨 아래 행');
    expect(result.rc).toBe(1);
  });

  it('`--max` 안이면 통과한다', () => {
    const result = runTail(hierarchy(401, [[329, 421, '마지막 행']]), ['--max', '25']);
    expect(result.rc).toBe(0);
    expect(JSON.parse(result.out).cutPt).toBe(20);
  });

  it('목록이나 행이 없으면 종료 2 — 남의 화면(다른 앱)을 잰 것을 초록으로 세지 않는다', () => {
    const other = JSON.stringify(node('', 0, 874, '', [node('onboarding.next', 728, 776)]));
    const result = runTail(other);
    expect(result.rc).toBe(2);
    expect(result.err).toContain('timeline-list');
  });
});

describe('api 컨트롤러 (lane-api-ctl)', () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs) {
      for (const name of ['docker', 'docker.log']) {
        try {
          unlinkSync(join(dir, name));
        } catch {
          /* 없으면 그만 */
        }
      }
      rmdirSync(dir);
    }
  });

  /** 가짜 docker: 받은 인자를 한 줄씩 기록하고 `ps` 에는 줄 하나를 답한다. */
  function fakeDocker() {
    const dir = mkdtempSync(join(tmpdir(), 'lane-ctl-'));
    dirs.push(dir);
    const log = join(dir, 'docker.log');
    writeFileSync(
      join(dir, 'docker'),
      `#!/bin/sh\necho "$@" >> "${log}"\ncase "$1" in ps) echo "momo_x-api-1 Up 1 second";; esac\nexit 0\n`,
    );
    chmodSync(join(dir, 'docker'), 0o755);
    return {dir, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(line => line !== '')};
  }

  async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
      const probe = createNetServer();
      probe.on('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const {port} = probe.address() as {port: number};
        probe.close(() => resolve(port));
      });
    });
  }

  function call(port: number, path: string): Promise<{status: number; body: string}> {
    return new Promise((resolve, reject) => {
      get({host: '127.0.0.1', port, path}, response => {
        let body = '';
        response.on('data', chunk => (body += chunk));
        response.on('end', () => resolve({status: response.statusCode ?? 0, body}));
      }).on('error', reject);
    });
  }

  it('프로젝트가 없거나 모양이 틀리면 아무것도 안 하고 종료 2 — 기본값이 없다', () => {
    const fake = fakeDocker();
    const env = {...process.env, PATH: `${fake.dir}:${process.env.PATH ?? ''}`};
    for (const args of [[], ['--port', '24999'], ['--project', 'x;y', '--port', '24999'], ['--project', 'ok', '--port', '80']]) {
      // 시간 제한: 검사가 빠진 컨트롤러는 듣기 시작해 끝나지 않는다 — 그 판이 시험을 영원히 붙들지 않고 붉어지게 한다.
      const result = spawnSync('node', [CTL, ...args], {encoding: 'utf8', env, timeout: 8000, killSignal: 'SIGKILL'});
      expect(result.status).toBe(2);
    }
    expect(() => readFileSync(join(fake.dir, 'docker.log'))).toThrow(); // docker 는 한 번도 안 불렸다
  });

  it('stop·start·status 셋만 그 프로젝트의 api 컨테이너 하나에 한다 — 그 밖의 길은 404 이고 docker 를 안 부른다', async () => {
    const fake = fakeDocker();
    const port = await freePort();
    const child = spawn('node', [CTL, '--project', 'momo_lane-1', '--port', String(port)], {
      env: {...process.env, PATH: `${fake.dir}:${process.env.PATH ?? ''}`},
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    try {
      await new Promise<void>((resolve, reject) => {
        child.stdout.on('data', chunk => String(chunk).includes('listening') && resolve());
        child.on('error', reject);
        child.on('exit', code => reject(new Error(`controller exited early: ${code}`)));
      });

      expect((await call(port, '/api-stop')).status).toBe(200);
      expect((await call(port, '/api-start')).status).toBe(200);
      const status = await call(port, '/status');
      expect(JSON.parse(status.body).status).toEqual(['momo_x-api-1 Up 1 second']);
      // 허용 밖: 다른 서비스·다른 컨테이너·임의 인자는 404 로 끝나고 docker 로 가지 않는다.
      for (const path of ['/postgres-stop', '/stop?container=other', '/api-stop/../x', '/']) {
        expect((await call(port, path)).status).toBe(404);
      }

      expect(fake.calls()).toEqual([
        'stop -t 1 momo_lane-1-api-1',
        'start momo_lane-1-api-1',
        'ps -a --filter name=momo_lane-1- --format {{.Names}} {{.Status}}',
      ]);
    } finally {
      child.kill('SIGTERM');
      await new Promise(resolve => child.on('exit', resolve));
    }
    // 끝날 때는 api 를 올려 두고 나간다 — 내린 채 끝나 다음 흐름이 죽은 서버를 만나지 않게.
    expect(fake.calls().slice(-1)).toEqual(['start momo_lane-1-api-1']);
  }, 30000);
});
