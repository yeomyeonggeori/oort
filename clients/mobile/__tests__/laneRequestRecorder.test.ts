import { mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { createServer, request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// =============================================================================
// 폰 레인의 요청 기록 (#5208) — `scripts/lane-request-recorder.cjs`.
//
// 이 중계가 레인의 「구간 읽기(206)가 실제로 오갔다」는 단정의 유일한 눈이다(서버는 요청을 로그로 남기지 않는다). 눈이 헛보면 레인이
// 아무것도 못 잡고 초록이 된다 — 그래서 두 가지를 잰다.
//   ① 중계는 응답을 **그대로** 돌려주고, 기록에는 토큰의 값이 **없다**(베어러가 실려 왔는가만 참·거짓으로 적는다).
//   ② `verifyRecords` 는 통과해야 할 기록에서 통과하고, 어긋난 기록(전부 받기로 시작·베어러 없음·포스터 규칙 위반)에서 각각 실패한다.
// 플레이어·서버·시뮬레이터는 여기 없다 — 그것들은 레인이 잰다.
// =============================================================================

interface RecordLine {
  at?: string;
  method: string;
  route: 'content' | 'poster';
  attachment: string;
  range: string | null;
  auth: boolean;
  status: number;
  contentRange: string | null;
  bytes: number;
  aborted: boolean;
}
interface Recorder {
  startRecorder: (options: {
    listen?: number;
    target: { host: string; port: number };
    out: string;
  }) => Promise<Server>;
  verifyRecords: (
    records: RecordLine[],
    expectation: { played?: string[]; posters?: string[]; noPoster?: string[] },
  ) => string[];
}
const recorder = jest.requireActual('../scripts/lane-request-recorder.cjs') as Recorder;

const ID = '0199aaaa-0000-7000-8000-000000000001';
const OTHER = '0199aaaa-0000-7000-8000-000000000002';
const TOKEN = 'secret-token-xyz';

function line(over: Partial<RecordLine> = {}): RecordLine {
  return {
    method: 'GET',
    route: 'content',
    attachment: ID,
    range: 'bytes=0-1',
    auth: true,
    status: 206,
    contentRange: 'bytes 0-1/100',
    bytes: 2,
    aborted: false,
    ...over,
  };
}
const HEAD_OK = line({ method: 'HEAD', range: null, status: 200, contentRange: null, bytes: 0 });

function fetchVia(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk as Buffer));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

describe('① 중계는 응답을 그대로 돌려주고, 기록에는 토큰의 값이 없다', () => {
  let upstream: Server;
  let proxy: Server;
  let dir: string;

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'lane-recorder-'));
    upstream = createServer((req, res) => {
      if (req.headers.range) {
        res.writeHead(206, { 'content-range': 'bytes 0-9/100', 'content-length': 10 });
        res.end(Buffer.alloc(10, 1));
      } else {
        res.writeHead(200, { 'content-length': 100 });
        res.end(Buffer.alloc(100, 2));
      }
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
  });
  afterEach(async () => {
    for (const server of [proxy, upstream]) {
      server?.closeAllConnections();
      await new Promise(resolve => server?.close(resolve));
    }
    // 이 시험이 만든 파일 하나와 디렉터리 하나만 지운다(재귀 삭제를 쓰지 않는다).
    try {
      unlinkSync(join(dir, 'requests.jsonl'));
    } catch {
      // 기록이 만들어지기 전에 시험이 실패했다.
    }
    rmdirSync(dir);
  });

  it('206 과 Content-Range 와 바이트가 그대로 가고, 첨부 길만 한 줄로 적히며, 토큰은 파일 어디에도 없다', async () => {
    const out = join(dir, 'requests.jsonl');
    const upstreamPort = (upstream.address() as { port: number }).port;
    proxy = await recorder.startRecorder({ target: { host: '127.0.0.1', port: upstreamPort }, out });
    const port = (proxy.address() as { port: number }).port;

    const ranged = await fetchVia(port, `/v1/workspaces/ws/channels/ch/attachments/${ID}/content`, {
      authorization: `Bearer ${TOKEN}`,
      range: 'bytes=0-9',
    });
    expect(ranged.status).toBe(206);
    expect(ranged.headers['content-range']).toBe('bytes 0-9/100');
    expect(ranged.body).toEqual(Buffer.alloc(10, 1));
    // 첨부 길이 아닌 요청은 그대로 가지만 적히지 않는다.
    const login = await fetchVia(port, '/v1/auth/login', { authorization: `Bearer ${TOKEN}` });
    expect(login.status).toBe(200);
    // 베어러 없는 요청은 `auth: false` 로 적힌다.
    await fetchVia(port, `/v1/workspaces/ws/channels/ch/attachments/${OTHER}/poster`, {});

    const text = readFileSync(out, 'utf8');
    const lines = text
      .split('\n')
      .filter(Boolean)
      .map(entry => JSON.parse(entry) as RecordLine);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({
      method: 'GET',
      route: 'content',
      attachment: ID,
      range: 'bytes=0-9',
      auth: true,
      status: 206,
      contentRange: 'bytes 0-9/100',
      bytes: 10,
      aborted: false,
    });
    expect(lines[1]).toMatchObject({ route: 'poster', attachment: OTHER, auth: false, range: null, status: 200 });
    expect(text).not.toContain(TOKEN);
    expect(text.toLowerCase()).not.toContain('bearer');
  });
});

describe('② verifyRecords — 통과할 기록은 통과하고, 어긋난 기록은 각각 실패한다', () => {
  it('열기 전 HEAD 와 구간 읽기 206 로 시작한 재생, 포스터를 받은 영상과 안 부른 영상은 통과한다', () => {
    const records = [
      HEAD_OK,
      line(),
      line({ range: 'bytes=2-', contentRange: 'bytes 2-99/100', bytes: 98 }),
      line({ method: 'GET', route: 'poster', range: null, status: 200, contentRange: null, bytes: 1500 }),
    ];
    expect(recorder.verifyRecords(records, { played: [ID], posters: [ID], noPoster: [OTHER] })).toEqual([]);
  });

  it('전부 받기(200, Range 없음)로 시작했거나 HEAD 가 없거나 베어러가 없으면 각각 이유를 대고 실패한다', () => {
    const wholeFile = line({ range: null, status: 200, contentRange: null, bytes: 100 });
    expect(recorder.verifyRecords([HEAD_OK, wholeFile], { played: [ID] })).toEqual([
      expect.stringContaining('not a ranged 206'),
    ]);
    expect(recorder.verifyRecords([line()], { played: [ID] })).toEqual([
      expect.stringContaining('no authorised HEAD'),
    ]);
    expect(recorder.verifyRecords([HEAD_OK, line({ auth: false })], { played: [ID] })).toEqual([
      expect.stringContaining('carried no bearer'),
    ]);
    // 206 이지만 Content-Range 가 없으면 구간 읽기의 증거가 아니다.
    expect(recorder.verifyRecords([HEAD_OK, line({ contentRange: null })], { played: [ID] })).toEqual([
      expect.stringContaining('not a ranged 206'),
    ]);
    // 재생한 영상이 하나도 안 이름 붙으면 검사가 헛돈다.
    expect(recorder.verifyRecords([HEAD_OK, line()], {})).toEqual([
      expect.stringContaining('would prove nothing'),
    ]);
  });

  it('플레이어가 content 를 한 번도 안 읽었거나 포스터 규칙을 어기면 실패한다', () => {
    expect(recorder.verifyRecords([HEAD_OK], { played: [ID] })).toEqual([
      expect.stringContaining('never read the content route'),
    ]);
    const poster = line({ route: 'poster', range: null, status: 200, contentRange: null });
    expect(recorder.verifyRecords([HEAD_OK, line()], { played: [ID], posters: [ID] })).toEqual([
      expect.stringContaining('poster was never read'),
    ]);
    expect(
      recorder.verifyRecords([HEAD_OK, line(), { ...poster, attachment: OTHER }], {
        played: [ID],
        noPoster: [OTHER],
      }),
    ).toEqual([expect.stringContaining('still asked for one')]);
  });
});
