import { describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { countNewerThan, newestSeqOf } from "./navigation";

// 「아래 새 메시지 N개」가 참인가. 이 산수가 틀려도 화면은 멀쩡해 보이고 사람만
// 잘못 안다 — 그래서 화면이 아니라 숫자를 잰다 (진단 M-9).

function message(seq: number): Message {
  return {
    id: `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "0199cccc-0000-7000-8000-000000000201",
    seq,
    authorMemberId: "00000000-0000-7000-8000-000000000101",
    body: `메시지 ${seq}`,
    type: "text",
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1_000,
    hlcTs: 1_700_000_000_000 + seq * 1_000,
    hlcCount: 0,
  };
}

const stream = [41, 42, 43, 44].map(message);

describe("newestSeqOf", () => {
  it("빈 채널에는 기준선이 없다", () => {
    expect(newestSeqOf([])).toBeNull();
  });

  it("꼬리의 seq가 기준선이다", () => {
    expect(newestSeqOf(stream)).toBe(44);
  });
});

describe("countNewerThan", () => {
  it("바닥을 떠난 뒤 아무것도 오지 않았으면 0이다", () => {
    expect(countNewerThan(stream, 44)).toBe(0);
  });

  it("꼬리에 붙은 것만 센다", () => {
    expect(countNewerThan([...stream, message(45), message(46)], 44)).toBe(2);
  });

  it("위로 더 불러온 옛 페이지는 새 메시지가 아니다", () => {
    // `?before` prepend. 이것을 세면 위로 스크롤할 때마다 「아래 새 메시지」가
    // 늘어난다 — 이 goal이 피해야 할 정확한 거짓말이다.
    const older = [37, 38, 39, 40].map(message);
    expect(countNewerThan([...older, ...stream], 44)).toBe(0);
  });

  it("옛 페이지와 새 메시지가 같은 판에 들어와도 새것만 센다", () => {
    const older = [37, 38].map(message);
    const withNew = [...older, ...stream, message(45)];
    expect(countNewerThan(withNew, 44)).toBe(1);
  });

  it("기준선 자체는 새것이 아니다", () => {
    expect(countNewerThan(stream, 43)).toBe(1);
  });

  it("빈 목록은 0이다", () => {
    expect(countNewerThan([], 44)).toBe(0);
  });
});
