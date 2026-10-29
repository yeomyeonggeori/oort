import { writeFileSync } from "node:fs";
import { afterAll, describe, it } from "vitest";

/**
 * `retryRegistry.test.ts` 가 **진짜 러너 설정으로** 따로 띄우는 재료다(#4708). 환경 변수가 없으면(= 보통의 시험 실행) 전부 건너뛴다.
 * 첫 시도에서 반드시 실패하고 두 번째에 통과하는 시험과, 계속 실패하는 시험을 만들어 몇 번 돌았는지를 파일로 남긴다.
 */
const OUT = process.env.MOMO_RETRY_FIXTURE_OUT;
const attempts: Record<string, number> = {};

function attempt(name: string): number {
  attempts[name] = (attempts[name] ?? 0) + 1;
  return attempts[name];
}

describe.skipIf(!OUT)("retry fixture", () => {
  afterAll(() => {
    if (OUT) writeFileSync(OUT, JSON.stringify(attempts));
  });

  it("listed: fails once then passes", () => {
    if (attempt("listed-flaky") === 1) throw new Error("first attempt fails");
  });
  it("listed: always fails", () => {
    attempt("listed-broken");
    throw new Error("always fails");
  });
  it("unlisted: fails once then passes", () => {
    if (attempt("unlisted-flaky") === 1) throw new Error("first attempt fails");
  });
  it("expired: fails once then passes", () => {
    if (attempt("expired-flaky") === 1) throw new Error("first attempt fails");
  });
  it("unlisted with its own retry option: fails once then passes", { retry: 3 }, () => {
    if (attempt("option-flaky") === 1) throw new Error("first attempt fails");
  });
});
