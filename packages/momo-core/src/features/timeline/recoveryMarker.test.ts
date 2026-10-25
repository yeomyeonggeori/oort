import { describe, expect, it } from "vitest";
import type { Message } from "../../lib/api";
import {
  judgeRecoveryMarker,
  messageIdKey,
  NO_RECOVERY,
  type RecoveredLine,
} from "./recoveryMarker";

// 복구 표지를 세울지의 판정(#4328, 폰 #4292 규칙). 단정은 전부 「이 줄이 표지를 세우는가」다 —
// 내부 자료구조가 아니라 판정의 입출력만 본다. 양성(표지가 선다)과 음성(서지 않는다)을 한 파일에 같이
// 둔다: 음성뿐인 파일은 판정을 통째로 `{show:false}` 로 바꿔도 초록이다.

const ME = "11111111-1111-4111-8111-111111111111";
const OTHER = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const OTHER_2 = "cccccccc-1111-4111-8111-cccccccccccc";

const A = "0199aaaa-0000-7000-8000-00000000000a";
const B = "0199aaaa-0000-7000-8000-00000000000b";
const C = "0199aaaa-0000-7000-8000-00000000000c";

/** 호스트가 줄을 들일 때 하는 등록 그대로 — 접은 열쇠의 집합. */
function known(...ids: string[]): Set<string> {
  return new Set(ids.map(messageIdKey));
}

function line(id: string, authorMemberId: string = OTHER): RecoveredLine {
  return { id, authorMemberId };
}

describe("judgeRecoveryMarker — 표지는 남의 새 줄을 들였을 때만 선다", () => {
  it("남의 새 줄이 하나 들어오면 선다", () => {
    expect(judgeRecoveryMarker([line(A)], known(), ME)).toEqual({
      show: true,
      fresh: 1,
    });
  });

  it("아무것도 들이지 않았으면 서지 않는다 — 빈손 복구", () => {
    expect(judgeRecoveryMarker([], known(A), ME)).toEqual({
      show: false,
      fresh: 0,
    });
  });

  it("들인 것이 내 줄뿐이면 서지 않는다", () => {
    const verdict = judgeRecoveryMarker(
      [line(A, ME), line(B, ME)],
      known(),
      ME
    );
    expect(verdict).toEqual({ show: false, fresh: 0 });
  });

  it("남의 줄이라도 이미 든 줄이면 서지 않는다 — 새것은 id 로 가린다", () => {
    expect(judgeRecoveryMarker([line(A)], known(A), ME)).toEqual({
      show: false,
      fresh: 0,
    });
  });

  it("섞여 오면 남의 새 줄만 센다 — 내 줄·이미 든 줄은 세지 않는다", () => {
    const verdict = judgeRecoveryMarker(
      [line(A, ME), line(B), line(C, OTHER_2)],
      known(B),
      ME
    );
    // A 는 내 줄, B 는 이미 든 줄, C 만 남의 새 줄이다.
    expect(verdict).toEqual({ show: true, fresh: 1 });
  });

  it("에이전트(남)의 새 줄도 센다 — 작성자가 나와 다르면 남이다", () => {
    const agent = "dddddddd-1111-4111-8111-dddddddddddd";
    expect(judgeRecoveryMarker([line(A, agent)], known(), ME).show).toBe(true);
  });

  it("seq 가 아니라 id 로 가린다 — 판정은 seq 를 읽지 않는다", () => {
    // 내 줄(seq 100)이 이미 가장 새 seq 를 쥐고 있어도, 남의 줄(seq 99)은 이 타임라인에 처음이므로
    // 새것이다. `Message` 가 그대로 들어가는지(구조적 타입)도 같이 본다.
    const mine: Message = {
      id: A,
      channelId: "ch",
      seq: 100,
      hlcTs: 100,
      hlcCount: 0,
      authorMemberId: ME,
      type: "text",
      body: "내 줄",
      state: "sent",
      createdAtMs: 100,
    };
    const theirs: Message = { ...mine, id: B, seq: 99, authorMemberId: OTHER };
    expect(
      judgeRecoveryMarker([theirs, mine], known(A), ME)
    ).toEqual({ show: true, fresh: 1 });
  });
});

describe("judgeRecoveryMarker — id·작성자 비교는 대소문자를 접는다", () => {
  it("줄 id 의 대소문자가 달라도 이미 든 줄이다", () => {
    // 집합에는 접은 열쇠가 들어 있고, 되쏘기에는 같은 줄이 대문자로 실려 온다.
    expect(
      judgeRecoveryMarker([line(A.toUpperCase())], known(A), ME)
    ).toEqual({ show: false, fresh: 0 });
  });

  it("등록은 `messageIdKey` 로 접으므로, 대문자로 든 줄이 소문자로 되쏘여 와도 같은 줄이다", () => {
    expect(
      judgeRecoveryMarker([line(A)], known(A.toUpperCase()), ME)
    ).toEqual({ show: false, fresh: 0 });
  });

  it("작성자 id 의 대소문자가 달라도 내 줄이다", () => {
    const me = "AbCdEf12-1111-4111-8111-AAAAAAAAAAAA";
    expect(
      judgeRecoveryMarker([line(A, me.toLowerCase())], known(), me)
    ).toEqual({ show: false, fresh: 0 });
    expect(
      judgeRecoveryMarker([line(A, me.toUpperCase())], known(), me.toLowerCase())
    ).toEqual({ show: false, fresh: 0 });
  });

  it("messageIdKey 는 소문자로 접는다", () => {
    expect(messageIdKey("AbC-1")).toBe("abc-1");
    expect(messageIdKey(A)).toBe(A);
  });
});

describe("judgeRecoveryMarker — 묶음을 이어 누계를 만든다", () => {
  it("한 묶음 안에서 같은 새 id 가 두 번 실려 와도 한 줄로 센다", () => {
    expect(
      judgeRecoveryMarker([line(A), line(A.toUpperCase())], known(), ME)
    ).toEqual({ show: true, fresh: 1 });
  });

  it("앞선 판정을 before 로 이으면 누계가 된다 — 꼬리 읽기는 여러 페이지로 온다", () => {
    const first = judgeRecoveryMarker([line(A)], known(), ME);
    const second = judgeRecoveryMarker([line(B), line(C)], known(A), ME, first);
    expect(first).toEqual({ show: true, fresh: 1 });
    expect(second).toEqual({ show: true, fresh: 3 });
  });

  it("더할 것이 없는 묶음은 앞선 판정을 그대로 돌려준다 — 먼저 센 것이 지워지지 않는다", () => {
    const first = judgeRecoveryMarker([line(A)], known(), ME);
    const quiet = judgeRecoveryMarker([line(B, ME)], known(A), ME, first);
    expect(quiet).toBe(first);
    expect(quiet.show).toBe(true);
  });

  it("처음부터 더할 것이 없으면 NO_RECOVERY 를 그대로 돌려준다", () => {
    expect(judgeRecoveryMarker([], known(), ME)).toBe(NO_RECOVERY);
    expect(judgeRecoveryMarker([line(A, ME)], known(), ME)).toBe(NO_RECOVERY);
  });

  it("NO_RECOVERY 는 바뀌지 않는다 — 한 복구의 누계가 다음 복구로 새지 않는다", () => {
    judgeRecoveryMarker([line(A)], known(), ME);
    expect(NO_RECOVERY).toEqual({ show: false, fresh: 0 });
    expect(Object.isFrozen(NO_RECOVERY)).toBe(true);
  });

  it("판정은 이미 든 id 의 집합을 바꾸지 않는다 — 등록은 호스트가 병합 뒤에 한다", () => {
    const ids = known(A);
    const before = [...ids];
    judgeRecoveryMarker([line(B), line(C, ME)], ids, ME);
    expect([...ids]).toEqual(before);
  });

  it("병합 뒤에 부르면 새것이 사라진다 — 부르는 쪽은 병합 전에 물어야 한다", () => {
    // 약속 2 의 반대편을 못 박는다: 같은 줄을 등록한 뒤 다시 물으면 이미 든 줄이다.
    const ids = known();
    const batch = [line(A)];
    expect(judgeRecoveryMarker(batch, ids, ME).show).toBe(true);
    for (const l of batch) ids.add(messageIdKey(l.id));
    expect(judgeRecoveryMarker(batch, ids, ME).show).toBe(false);
  });

  it("내 멤버 id 가 비어 있으면 아무도 나가 아니다 — 모든 줄이 남의 줄이다", () => {
    expect(judgeRecoveryMarker([line(A, ME)], known(), "")).toEqual({
      show: true,
      fresh: 1,
    });
  });
});
