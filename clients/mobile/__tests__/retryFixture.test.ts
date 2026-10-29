import fs from 'fs';

/**
 * `retryRegistry.test.ts` 가 **진짜 러너 설정으로** 따로 띄우는 재료다(#4708). 환경 변수가 없으면(= 보통의 시험 실행) 전부 건너뛴다.
 * 첫 시도에서 반드시 실패하고 두 번째에 통과하는 시험과, 계속 실패하는 시험을 만들어 몇 번 돌았는지를 파일로 남긴다.
 * 같은 describe 안의 등록 밖 시험과, 시험 파일이 직접 건 `jest.retryTimes` 로도 등록부를 우회할 수 없다는 것까지 본다.
 */
const OUT = process.env.MOMO_RETRY_FIXTURE_OUT;
const attempts: Record<string, number> = {};

function attempt(name: string): number {
  attempts[name] = (attempts[name] ?? 0) + 1;
  return attempts[name];
}

const suite = OUT ? describe : describe.skip;

if (OUT) {
  // 등록부를 우회하려는 시도: 파일이 직접 모든 시험에 재시도 3회를 건다.
  jest.retryTimes(3);
}

// 파일 맨 위의 afterAll 은 모든 블록이 끝난 뒤에 돈다.
afterAll(() => {
  if (OUT) {
    fs.writeFileSync(OUT, JSON.stringify(attempts));
  }
});

suite('retry fixture', () => {
  it('listed: fails once then passes', () => {
    if (attempt('listed-flaky') === 1) {
      throw new Error('first attempt fails');
    }
  });
  it('listed: always fails', () => {
    attempt('listed-broken');
    throw new Error('always fails');
  });
  // 등록된 시험과 같은 describe 블록이다 — 블록 단위 재시도에 딸려 가면 안 된다.
  it('unlisted sibling: fails once then passes', () => {
    if (attempt('sibling-flaky') === 1) {
      throw new Error('first attempt fails');
    }
  });
  it('expired: fails once then passes', () => {
    if (attempt('expired-flaky') === 1) {
      throw new Error('first attempt fails');
    }
  });
});

suite('retry fixture unlisted block', () => {
  it('unlisted: fails once then passes', () => {
    if (attempt('unlisted-flaky') === 1) {
      throw new Error('first attempt fails');
    }
  });
});
