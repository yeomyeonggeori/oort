import { describe, expect, it } from "vitest";
import type { Message } from "@momo/core/lib/api";
import { countNewerThan, newestSeqOf } from "./navigation";

// 「아래 새 메시지 N개」가 참인가. 이 산수가 틀려도 화면은 멀쩡해 보이고 사람만
// 잘못 안다 — 그래서 화면이 아니라 숫자를 잰다 (진단 M-9).

const OTHER = "00000000-0000-7000-8000-000000000101";
const ME = "00000000-0000-7000-8000-0000000001ff";

function message(seq: number, authorMemberId: string = OTHER): Message {
  return {
    id: `0199cccc-0000-7000-8000-${String(seq).padStart(12, "0")}`,
    channelId: "0199cccc-0000-7000-8000-000000000201",
    seq,
    authorMemberId,
    body: `메시지 ${seq}`,
    type: "text",
    state: "sent",
    createdAtMs: 1_700_000_000_000 + seq * 1_000,
    hlcTs: 1_700_000_000_000 + seq * 1_000,
    hlcCount: 0,
  };
}

/** 내가 보낸 확정 행 (seq 를 받은 뒤 — 낙관적 메아리가 아니다). */
function mine(seq: number): Message {
  return message(seq, ME);
}

const stream = [41, 42, 43, 44].map((seq) => message(seq));

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
    const older = [37, 38, 39, 40].map((seq) => message(seq));
    expect(countNewerThan([...older, ...stream], 44)).toBe(0);
  });

  it("옛 페이지와 새 메시지가 같은 판에 들어와도 새것만 센다", () => {
    const older = [37, 38].map((seq) => message(seq));
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

// ---------------------------------------------------------------------------
// M-3 (design-review U4-5) — 「새 메시지」는 남의 말이다
//
// 위로 올라가 읽던 중에 한 줄 보내면 화면이 「새 메시지 1개 보기」를 띄웠다. 그것이
// 가리키는 곳은 **내가 방금 쓴 문장**이고, 같은 낱말이 안읽음 구분선에서는 남의
// 말을 뜻한다. 낙관적 메아리는 이 배열에 없으므로 결함은 **확정된 뒤에** 나타났다.
// ---------------------------------------------------------------------------
describe("countNewerThan — 저자", () => {
  it("내 확정 전송은 「새 메시지」가 아니다", () => {
    expect(countNewerThan([...stream, mine(45)], 44, ME)).toBe(0);
  });

  it("내가 끼어들어도 그 아래 남의 말은 계속 센다", () => {
    // `continue`이지 `break`가 아니라는 것. 내가 한 줄 썼다고 그 뒤에 온 남의
    // 말이 안 보이면 처음 결함과 같은 종류의 거짓말이 된다.
    const tail = [message(45), mine(46), message(47)];
    expect(countNewerThan([...stream, ...tail], 44, ME)).toBe(2);
  });

  it("전부 내 것이면 셀 것이 없다 — 그때 라벨은 「최신 메시지로 이동」이다", () => {
    expect(countNewerThan([...stream, mine(45), mine(46)], 44, ME)).toBe(0);
  });

  it("대소문자가 섞여도 같은 사람이다 — 와이어가 섞어 보낸다", () => {
    expect(countNewerThan([...stream, mine(45)], 44, ME.toUpperCase())).toBe(0);
  });

  it("저자를 모르면 빼지 않는다 — 남의 말을 놓치는 쪽이 더 나쁘다", () => {
    // 행 액션이 없는 표면(작업 세션 기록)에는 `myMemberId`가 없다.
    expect(countNewerThan([...stream, mine(45)], 44)).toBe(1);
  });
});
