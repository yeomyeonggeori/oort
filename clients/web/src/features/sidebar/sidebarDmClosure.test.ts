import { afterEach, describe, expect, it } from "vitest";
import {
  CLOSED_DMS_PER_WORKSPACE_MAX,
  SIDEBAR_CLOSED_DMS_STORAGE_KEY,
  closeDmOnDevice,
  closedAtSeqOf,
  closedDmsFor,
  dmHiddenByClosure,
  parseClosedDmLedger,
  readProjectionPhase,
  reloadClosedDmsForTest,
  reopenDmOnDevice,
  withClosedDm,
  withoutClosedDm,
} from "./sidebarDmClosure";

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER_WS = "00000000-0000-7000-8000-000000000002";
const dm = (n: number) => `00000000-0000-7000-8000-0000000003${String(n).padStart(3, "0")}`;

class MemoryStorage {
  readonly values = new Map<string, string>();
  writes = 0;
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.writes += 1;
    this.values.set(key, value);
  }
}

afterEach(() => reloadClosedDmsForTest(null));

describe("dmHiddenByClosure: 새 메시지가 오면 다시 나타난다", () => {
  const base = { isOpen: false, phase: "ready" as const };

  it("닫은 적 없는 DM 은 어느 국면에서도 숨지 않는다", () => {
    for (const phase of ["loading", "error", "ready"] as const) {
      expect(
        dmHiddenByClosure({ closedAtSeq: undefined, latestSeq: 9, isOpen: false, phase })
      ).toBe(false);
    }
  });

  it("닫을 때의 seq 와 같거나 작으면 숨고, 넘으면 다시 나타난다", () => {
    expect(dmHiddenByClosure({ ...base, closedAtSeq: 12, latestSeq: 12 })).toBe(true);
    expect(dmHiddenByClosure({ ...base, closedAtSeq: 12, latestSeq: 11 })).toBe(true);
    // 새 메시지 한 건이면 충분하다: 13 > 12.
    expect(dmHiddenByClosure({ ...base, closedAtSeq: 12, latestSeq: 13 })).toBe(false);
  });

  it("메시지가 한 번도 없던 DM: 0 으로 닫았고 첫 메시지가 오면 돌아온다", () => {
    expect(dmHiddenByClosure({ ...base, closedAtSeq: 0, latestSeq: undefined })).toBe(true);
    expect(dmHiddenByClosure({ ...base, closedAtSeq: 0, latestSeq: 0 })).toBe(true);
    expect(dmHiddenByClosure({ ...base, closedAtSeq: 0, latestSeq: 1 })).toBe(false);
  });

  it("지금 열려 있는 DM 은 닫은 것이 아니다", () => {
    expect(
      dmHiddenByClosure({ closedAtSeq: 12, latestSeq: 12, isOpen: true, phase: "ready" })
    ).toBe(false);
  });

  it("투영이 오는 중이면 숨김을 유지한다 — 닫은 대화가 한 프레임 깜빡이지 않는다", () => {
    expect(
      dmHiddenByClosure({ closedAtSeq: 12, latestSeq: undefined, isOpen: false, phase: "loading" })
    ).toBe(true);
  });

  it("투영을 못 읽었으면 보인다 — 새 메시지를 모르는 채 숨기는 쪽이 최악이다", () => {
    expect(
      dmHiddenByClosure({ closedAtSeq: 12, latestSeq: undefined, isOpen: false, phase: "error" })
    ).toBe(false);
  });
});

describe("readProjectionPhase", () => {
  it("한 번도 못 읽은 것만 error 다 — 읽은 뒤의 배경 실패는 손에 든 투영이 있어 ready 다", () => {
    expect(readProjectionPhase({ isPending: true })).toBe("loading");
    expect(readProjectionPhase({ isPending: false, isError: true, data: undefined })).toBe(
      "error"
    );
    expect(readProjectionPhase({ isPending: false, isError: true, data: [] })).toBe("ready");
    expect(readProjectionPhase({ isPending: false, isError: false, data: [] })).toBe("ready");
    // 시험 대역처럼 플래그가 없는 쿼리는 ready 로 읽는다(숨길 이유가 없다).
    expect(readProjectionPhase({ isPending: false })).toBe("ready");
  });
});

describe("parseClosedDmLedger", () => {
  it("없거나 깨졌으면 닫은 DM 이 없는 것과 같다", () => {
    expect(parseClosedDmLedger(null)).toEqual({});
    expect(parseClosedDmLedger("old-value")).toEqual({});
    expect(parseClosedDmLedger("[]")).toEqual({});
    expect(parseClosedDmLedger("7")).toEqual({});
  });

  it("음수·소수·문자열 seq 와 배열 항목은 항목째 버린다", () => {
    const raw = JSON.stringify({
      [WS]: { [dm(1)]: 5, [dm(2)]: -1, [dm(3)]: 1.5, [dm(4)]: "9", [dm(5)]: null },
      [OTHER_WS]: [1, 2, 3],
    });
    expect(parseClosedDmLedger(raw)).toEqual({ [WS]: { [dm(1)]: 5 } });
  });

  it("id 는 소문자로 접힌다", () => {
    const parsed = parseClosedDmLedger(
      JSON.stringify({ [WS.toUpperCase()]: { [dm(1).toUpperCase()]: 3 } })
    );
    expect(parsed).toEqual({ [WS]: { [dm(1)]: 3 } });
  });

  it("프로토타입 이름이 항목으로 읽히지 않는다", () => {
    const parsed = parseClosedDmLedger(
      '{"__proto__":{"x":1},"' + WS + '":{"__proto__":4,"' + dm(1) + '":2}}'
    );
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(parsed).toEqual({ [WS]: { [dm(1)]: 2 } });
    expect(closedAtSeqOf(parsed[WS], "constructor")).toBeUndefined();
    expect(closedAtSeqOf(parsed[WS], "toString")).toBeUndefined();
  });
});

describe("withClosedDm / withoutClosedDm", () => {
  it("닫을 때의 seq 를 적고, 다시 닫으면 갈아 끼운다", () => {
    const first = withClosedDm({}, WS, dm(1), 5);
    expect(first).toEqual({ [WS]: { [dm(1)]: 5 } });
    expect(withClosedDm(first, WS, dm(1), 9)).toEqual({ [WS]: { [dm(1)]: 9 } });
  });

  it("id 대소문자를 접어 같은 DM 으로 센다", () => {
    const ledger = withClosedDm({}, WS.toUpperCase(), dm(1).toUpperCase(), 4);
    expect(closedAtSeqOf(ledger[WS], dm(1))).toBe(4);
    expect(closedAtSeqOf(ledger[WS], dm(1).toUpperCase())).toBe(4);
  });

  it("seq 가 이상한 값이면 0 으로 적는다(첫 메시지가 오면 돌아온다)", () => {
    expect(closedAtSeqOf(withClosedDm({}, WS, dm(1), Number.NaN)[WS], dm(1))).toBe(0);
    expect(closedAtSeqOf(withClosedDm({}, WS, dm(1), -3)[WS], dm(1))).toBe(0);
    expect(closedAtSeqOf(withClosedDm({}, WS, dm(1), 2.5)[WS], dm(1))).toBe(0);
  });

  it("다른 워크스페이스의 칸은 같은 참조로 남는다", () => {
    const other = withClosedDm({}, OTHER_WS, dm(9), 1);
    const next = withClosedDm(other, WS, dm(1), 2);
    expect(next[OTHER_WS]).toBe(other[OTHER_WS]);
  });

  it(`워크스페이스마다 ${CLOSED_DMS_PER_WORKSPACE_MAX}개까지 — 넘으면 가장 먼저 닫은 것부터 잊는다`, () => {
    let ledger = {};
    for (let n = 1; n <= CLOSED_DMS_PER_WORKSPACE_MAX; n += 1) {
      ledger = withClosedDm(ledger, WS, dm(n), n);
    }
    expect(Object.keys((ledger as Record<string, object>)[WS])).toHaveLength(
      CLOSED_DMS_PER_WORKSPACE_MAX
    );
    // 다시 나타났다가 또 닫은 가장 오래된 DM 은 최신으로 옮겨진다.
    ledger = withClosedDm(ledger, WS, dm(1), 777);
    ledger = withClosedDm(ledger, WS, dm(CLOSED_DMS_PER_WORKSPACE_MAX + 1), 1);
    const kept = (ledger as Record<string, Record<string, number>>)[WS];
    expect(Object.keys(kept)).toHaveLength(CLOSED_DMS_PER_WORKSPACE_MAX);
    // 잊힌 것은 dm(2) 다(dm(1) 은 방금 다시 닫아 최신이다).
    expect(kept[dm(2)]).toBeUndefined();
    expect(kept[dm(1)]).toBe(777);
    expect(kept[dm(CLOSED_DMS_PER_WORKSPACE_MAX + 1)]).toBe(1);
  });

  it("지우면 그 DM 만 빠지고, 없는 DM 을 지우면 같은 참조다", () => {
    const ledger = withClosedDm(withClosedDm({}, WS, dm(1), 1), WS, dm(2), 2);
    expect(withoutClosedDm(ledger, WS, dm(1))).toEqual({ [WS]: { [dm(2)]: 2 } });
    expect(withoutClosedDm(ledger, WS, dm(3))).toBe(ledger);
    expect(withoutClosedDm(ledger, OTHER_WS, dm(1))).toBe(ledger);
    expect(withoutClosedDm(ledger, WS, "constructor")).toBe(ledger);
  });

  it("마지막 항목을 지우면 워크스페이스 칸도 사라진다", () => {
    const ledger = withClosedDm({}, WS, dm(1), 1);
    expect(withoutClosedDm(ledger, WS, dm(1))).toEqual({});
  });
});

describe("외부 저장소: 영속과 새로고침", () => {
  it("닫으면 기록하고, 새로고침(다시 읽기)해도 닫힌 채다", () => {
    const storage = new MemoryStorage();
    reloadClosedDmsForTest(storage);
    expect(closedAtSeqOf(closedDmsFor(WS), dm(1))).toBeUndefined();

    closeDmOnDevice(WS, dm(1), 12, storage);
    expect(closedAtSeqOf(closedDmsFor(WS), dm(1))).toBe(12);
    expect(storage.getItem(SIDEBAR_CLOSED_DMS_STORAGE_KEY)).toBe(
      JSON.stringify({ [WS]: { [dm(1)]: 12 } })
    );

    reloadClosedDmsForTest(storage);
    expect(closedAtSeqOf(closedDmsFor(WS), dm(1))).toBe(12);
  });

  it("다시 열면 지우고 기록한다. 닫은 적 없으면 아무것도 쓰지 않는다", () => {
    const storage = new MemoryStorage();
    reloadClosedDmsForTest(storage);
    closeDmOnDevice(WS, dm(1), 3, storage);
    const writes = storage.writes;
    reopenDmOnDevice(WS, dm(2), storage);
    expect(storage.writes).toBe(writes);
    reopenDmOnDevice(WS, dm(1), storage);
    expect(storage.writes).toBe(writes + 1);
    expect(closedAtSeqOf(closedDmsFor(WS), dm(1))).toBeUndefined();
    reloadClosedDmsForTest(storage);
    expect(closedAtSeqOf(closedDmsFor(WS), dm(1))).toBeUndefined();
  });

  it("저장소가 거부해도 이 탭에서는 닫힌다", () => {
    const denied = {
      getItem: () => null,
      setItem: () => {
        throw new Error("denied");
      },
    };
    reloadClosedDmsForTest(denied);
    expect(() => closeDmOnDevice(WS, dm(1), 4, denied)).not.toThrow();
    expect(closedAtSeqOf(closedDmsFor(WS), dm(1))).toBe(4);
  });

  it("워크스페이스가 다르면 칸이 다르다", () => {
    const storage = new MemoryStorage();
    reloadClosedDmsForTest(storage);
    closeDmOnDevice(WS, dm(1), 4, storage);
    expect(closedAtSeqOf(closedDmsFor(OTHER_WS), dm(1))).toBeUndefined();
  });

  it("바뀌지 않은 칸은 같은 참조를 돌려준다 — 구독자가 헛돌지 않는다", () => {
    const storage = new MemoryStorage();
    reloadClosedDmsForTest(storage);
    closeDmOnDevice(WS, dm(1), 4, storage);
    const before = closedDmsFor(WS);
    closeDmOnDevice(OTHER_WS, dm(2), 1, storage);
    expect(closedDmsFor(WS)).toBe(before);
  });
});
