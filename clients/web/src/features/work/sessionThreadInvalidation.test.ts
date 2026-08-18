import { readFileSync } from "node:fs";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { invalidateSessionThreads } from "./useWorkSessions";

// =============================================================================
// 살아 있는 꼬리를 버렸으면 스레드를 다시 읽는다 (리뷰어 C G-H1).
//
// 앞 판의 결함은 **주석과 코드의 어긋남**이었다: `work.session.ended` 분기는
// "its whole stream is in the thread the invalidation below is about to re-read"
// 라고 적어 두고, 실제로는 세션 **목록**만 무효화했다. 스레드 무효화는 resync
// 콜백에만 있었고, 그래서 미리보기·상세를 연 채 세션이 끝나면 경과는 성과 서술로
// 바뀌는데 검증 칩은 계속 부재였다 — 화면이 「보고 없음」을 그리는 동안 실패
// 리포트가 원장에 있는 상태.
//
// 그래서 이 파일은 두 층으로 잰다: ①무효화 함수가 **실제 QueryClient 에서** 스레드
// 쿼리를 stale 로 만드는가(행동) ②꼬리를 버리는 두 분기가 그 함수를 부르는가
// (배선). 문자열 대조만 있으면 함수가 아무 일도 안 하게 되어도 초록이고, 행동만
// 재면 배선이 빠져도 초록이다.
// =============================================================================

const WORKSPACE = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const ROOT = "00000000-0000-7000-8000-0000000006a2";

const source = readFileSync(
  new URL("./useWorkSessions.ts", import.meta.url),
  "utf8"
);

function seeded() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const key = ["work-session-events", WORKSPACE, CHANNEL, ROOT];
  client.setQueryData(key, { events: [], truncated: false, reports: [] });
  return { client, key };
}

describe("스레드 무효화가 실제로 일어난다", () => {
  it("열려 있는 세션 스레드 읽기를 stale 로 만든다", async () => {
    const { client, key } = seeded();
    expect(client.getQueryState(key)?.isInvalidated).toBe(false);
    await invalidateSessionThreads(client);
    expect(client.getQueryState(key)?.isInvalidated).toBe(true);
  });

  it("접두 하나로 **모든** 세션의 스레드에 걸린다", async () => {
    // 프레임은 `session_id` 를 나르고 쿼리 키는 `rootMessageId` 로 걸린다. 그
    // 사이의 지도는 매 refetch 마다 새로 만들어지는 배열이라 콜백이 붙잡으면
    // 낡는다 — 그래서 접두 무효화가 답이고, 그것이 두 스레드 모두에 걸려야 한다.
    const { client } = seeded();
    const other = [
      "work-session-events",
      WORKSPACE,
      CHANNEL,
      "00000000-0000-7000-8000-0000000006a3",
    ];
    client.setQueryData(other, { events: [], truncated: false, reports: [] });
    await invalidateSessionThreads(client);
    expect(client.getQueryState(other)?.isInvalidated).toBe(true);
  });

  it("세션 목록 읽기는 건드리지 않는다 — 그쪽은 자기 전이 경로가 따로 있다", async () => {
    const { client } = seeded();
    const list = ["work-sessions", WORKSPACE];
    client.setQueryData(list, []);
    await invalidateSessionThreads(client);
    expect(client.getQueryState(list)?.isInvalidated).toBe(false);
  });
});

describe("꼬리를 버리는 자리마다 그 무효화가 배선돼 있다", () => {
  it("`work.session.ended` 와 `work.session.idle` 두 분기가 부른다", () => {
    for (const frameType of ["work.session.ended", "work.session.idle"]) {
      const branch = source.slice(source.indexOf(`frame.type === "${frameType}"`));
      const body = branch.slice(0, branch.indexOf("refetchSessionsAfterTransition"));
      expect(
        body.includes("invalidateSessionThreads(queryClient)"),
        `${frameType} 이 꼬리를 버리고도 스레드를 다시 읽지 않는다`
      ).toBe(true);
    }
  });

  it("재동기화 경로도 같은 한 함수를 지난다 — 무효화 표현이 둘로 갈라지지 않게", () => {
    // 앞 판에는 `invalidateQueries({ queryKey: ["work-session-events"] })` 라는
    // 문자열이 resync 안에만 있었고, 그 사본 하나가 다른 자리에는 없다는 사실이
    // 결함 그 자체였다. 표현을 하나로 모아 두면 다음 호출자가 같은 실수를 할
    // 자리가 없다.
    expect(source).not.toContain('queryKey: ["work-session-events"]');
    expect(
      source.split("invalidateSessionThreads(queryClient)").length - 1
    ).toBeGreaterThanOrEqual(3);
  });
});
