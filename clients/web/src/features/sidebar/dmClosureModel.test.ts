import { afterEach, describe, expect, it } from "vitest";
import type { ReadState } from "@momo/core/lib/api";
import {
  DM_CLOSURE_CACHE_KEY,
  DM_CLOSURE_MIGRATED_KEY,
  dmClosureCacheOf,
  dmClosureMode,
  dmLedgerMigrated,
  dmVerdict,
  foldDmClosureAbsent,
  migrateDmLedger,
  parseDmClosureCache,
  resetDmClosureFoldForTest,
  type DmFactsInput,
} from "./dmClosureModel";

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER_WS = "00000000-0000-7000-8000-000000000002";
const dm = (n: number) => `00000000-0000-7000-8000-0000000003${String(n).padStart(2, "0")}`;

function row(channelId: string, patch: Partial<ReadState> = {}): ReadState {
  return {
    channelId,
    lastReadSeq: 10,
    latestSeq: 10,
    unreadCount: 0,
    mentionCount: 0,
    markedUnreadBeforeSeq: null,
    ...patch,
  };
}

class MemoryStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

afterEach(() => resetDmClosureFoldForTest());

describe("dmClosureMode: 읽음 투영이 곧 탐지다", () => {
  it("새 서버는 모든 행에 두 필드를 싣는다 -> server", () => {
    expect(
      dmClosureMode({
        workspaceId: WS,
        rows: [row(dm(1), { latestReadableSeq: 10, closedAtSeq: null })],
      })
    ).toBe("server");
  });

  it("행 하나라도 말하면 server 다(닫힘 `null` 도 말한 것이다)", () => {
    expect(dmClosureMode({ workspaceId: WS, rows: [row(dm(1)), row(dm(2), { closedAtSeq: null })] })).toBe("server");
    expect(dmClosureMode({ workspaceId: WS, rows: [row(dm(1)), row(dm(2), { latestReadableSeq: 3 })] })).toBe("server");
  });

  it("아무 행도 말하지 않으면 legacy 다", () => {
    expect(dmClosureMode({ workspaceId: WS, rows: [row(dm(1)), row(dm(2))] })).toBe("legacy");
  });

  it("투영이 없거나 행이 0 개면 증거가 없다 -> unknown", () => {
    expect(dmClosureMode({ workspaceId: WS, rows: undefined })).toBe("unknown");
    expect(dmClosureMode({ workspaceId: WS, rows: [] })).toBe("unknown");
  });

  it("닫기 경로가 없다고 답해 접은 워크스페이스는 투영이 뭐라 하든 legacy 다 - 다른 워크스페이스는 그대로", () => {
    const rows = [row(dm(1), { latestReadableSeq: 10, closedAtSeq: null })];
    foldDmClosureAbsent(WS);
    expect(dmClosureMode({ workspaceId: WS, rows })).toBe("legacy");
    expect(dmClosureMode({ workspaceId: OTHER_WS, rows })).toBe("server");
  });
});

describe("첫 페인트 사본 (D8, 원장이 아니다)", () => {
  const rows = [
    row(dm(1), { closedAtSeq: 10, latestReadableSeq: 10 }),
    row(dm(2), { closedAtSeq: null, latestReadableSeq: 4, lastReadSeq: 2, mentionCount: 1 }),
    row(dm(3)), // 닫힘을 말하지 않았다 -> 적지 않는다
  ];
  const ids = new Set([dm(1), dm(2), dm(3)]);

  it("닫힘을 말한 행만, 판정에 쓰는 네 칸으로 적는다", () => {
    expect(dmClosureCacheOf(rows, ids)).toEqual({
      [dm(1)]: [10, 10, 10, 0],
      [dm(2)]: [null, 4, 2, 1],
    });
  });

  it("DM 이 아닌 채널의 행은 적지 않는다", () => {
    expect(Object.keys(dmClosureCacheOf(rows, new Set([dm(2)])))).toEqual([dm(2)]);
  });

  it("저장했다가 읽으면 같다. 워크스페이스마다 칸이 다르다", () => {
    const raw = JSON.stringify({ [WS]: dmClosureCacheOf(rows, ids) });
    expect(parseDmClosureCache(raw, WS)).toEqual(dmClosureCacheOf(rows, ids));
    expect(parseDmClosureCache(raw, OTHER_WS)).toBeNull();
  });

  it("못 읽는 값은 캐시가 없는 것과 같다(던지지 않는다) - 남의 값은 항목째 버린다", () => {
    expect(parseDmClosureCache(null, WS)).toBeNull();
    expect(parseDmClosureCache("not json", WS)).toBeNull();
    expect(parseDmClosureCache("[]", WS)).toBeNull();
    const raw = JSON.stringify({
      [WS]: { [dm(1)]: [-1, 3, 3, 0], [dm(2)]: [null, 1.5, 0, 0], [dm(3)]: [null, 4, 2, 2], [dm(4)]: [5, 5, 5, 0] },
    });
    expect(parseDmClosureCache(raw, WS)).toEqual({ [dm(4)]: [5, 5, 5, 0] });
  });

  it("키 이름이 원장과 다르다(원장을 사본으로 읽지 않는다)", () => {
    expect(DM_CLOSURE_CACHE_KEY).not.toBe("momo.web.sidebar-closed-dms.v1");
  });
});

// ---- 판정 입력 ---------------------------------------------------------------------

const BASE: DmFactsInput = {
  mode: "server",
  phase: "ready",
  counterpart: "present",
  starredOrSectioned: false,
  read: row(dm(1), { closedAtSeq: null, latestReadableSeq: 10 }),
  cache: null,
  channelId: dm(1),
  ledgerClosedAtSeq: undefined,
  revivalLatestSeq: undefined,
  goneVerdict: undefined,
};

describe("dmVerdict · server 갈래", () => {
  it("서버가 닫았다고 말하면 숨고(7), 닫은 뒤 읽을 메시지가 오면 돌아온다(8)", () => {
    const closed = row(dm(1), { closedAtSeq: 10, latestReadableSeq: 10, latestSeq: 10 });
    expect(dmVerdict({ ...BASE, read: closed })).toEqual({ state: "hidden", rule: 7 });
    expect(
      dmVerdict({ ...BASE, read: { ...closed, latestReadableSeq: 11, latestSeq: 11 } })
    ).toEqual({ state: "shown", rule: 8 });
  });

  it("기계 메시지만 왔으면(latestSeq 만 오르고 읽을 seq 는 그대로) 숨은 채다 - 메시지를 다시 읽지 않는다", () => {
    const closed = row(dm(1), { closedAtSeq: 10, latestReadableSeq: 10, latestSeq: 25 });
    expect(dmVerdict({ ...BASE, read: closed })).toEqual({ state: "hidden", rule: 7 });
  });

  it("나간 상대 + 다 읽음 -> 숨김(6), 읽을 메시지가 있으면 보임", () => {
    const gone = row(dm(1), { closedAtSeq: null, latestReadableSeq: 10, lastReadSeq: 10 });
    expect(dmVerdict({ ...BASE, counterpart: "gone", read: gone })).toEqual({ state: "hidden", rule: 6 });
    expect(
      dmVerdict({ ...BASE, counterpart: "gone", read: { ...gone, latestReadableSeq: 12 } }).state
    ).toBe("shown");
  });

  it("명부를 못 믿으면(unknown) 나간 상대 규칙을 건너뛴다", () => {
    const gone = row(dm(1), { closedAtSeq: null, latestReadableSeq: 10, lastReadSeq: 10 });
    expect(dmVerdict({ ...BASE, counterpart: "unknown", read: gone }).state).toBe("shown");
  });

  it("투영 행이 없는 DM(메시지가 한 번도 없음)은 보인다", () => {
    expect(dmVerdict({ ...BASE, read: undefined })).toEqual({ state: "shown", rule: 9 });
  });

  it("행이 읽을 seq 를 말하지 않았으면(옛 행) 전체 seq 로 대신한다 - 더 많이 보이는 쪽이다", () => {
    const old = row(dm(1), { closedAtSeq: 10, latestSeq: 12 });
    expect(dmVerdict({ ...BASE, read: old })).toEqual({ state: "shown", rule: 8 });
  });

  it("닫힘을 말하지 않은 행(undefined)은 안 닫음이 아니다: 사본이 닫았다고 하면 숨은 채, 사본이 없으면 보인다", () => {
    const unsaid = row(dm(1), { latestReadableSeq: 10 }); // closedAtSeq 키 없음
    expect(
      dmVerdict({ ...BASE, read: unsaid, cache: { [dm(1)]: [10, 10, 10, 0] } })
    ).toEqual({ state: "hidden", rule: 7 });
    expect(dmVerdict({ ...BASE, read: unsaid, cache: {} }).state).toBe("shown");
  });

  it("투영 오류면 보인다(2)", () => {
    expect(
      dmVerdict({ ...BASE, phase: "error", read: row(dm(1), { closedAtSeq: 10, latestReadableSeq: 10 }) })
    ).toEqual({ state: "shown", rule: 2 });
  });
});

describe("dmVerdict · 콜드 스타트 (AC 10)", () => {
  const loading = { ...BASE, phase: "loading" as const, read: undefined };

  it("사본이 있으면 닫은 DM 이 깜빡이지 않는다: 투영이 오기 전에도 숨어 있다", () => {
    expect(dmVerdict({ ...loading, cache: { [dm(1)]: [10, 10, 10, 0] } })).toEqual({
      state: "hidden",
      rule: 7,
    });
  });

  it("사본에 없는 DM(지난 세션 뒤에 생긴 DM)은 보인다", () => {
    expect(dmVerdict({ ...loading, cache: { [dm(2)]: [10, 10, 10, 0] } }).state).toBe("shown");
  });

  it("저장소를 지운 뒤(재설치 모사)에는 판정을 미룬다 - 그리고 투영이 오면 닫혀 있다", () => {
    expect(dmVerdict({ ...loading, cache: null })).toEqual({ state: "pending", rule: 3 });
    const arrived = row(dm(1), { closedAtSeq: 10, latestReadableSeq: 10 });
    expect(dmVerdict({ ...BASE, cache: null, read: arrived })).toEqual({ state: "hidden", rule: 7 });
  });

  it("증거가 아무것도 없으면(모드 모름 + 사본 없음 + 원장 없음) 투영이 올 때까지 미룬다 - 원장이 있으면 그 DM 만 숨는다", () => {
    const unknown = { ...loading, mode: "unknown" as const, cache: null };
    expect(dmVerdict(unknown)).toEqual({ state: "pending", rule: 3 });
    expect(dmVerdict({ ...unknown, counterpart: "gone" }).state).toBe("pending");
    expect(dmVerdict({ ...unknown, ledgerClosedAtSeq: 3 })).toEqual({ state: "hidden", rule: 3 });
  });

  it("사본이 가리는 동안에도 별표 DM 은 보인다(4)", () => {
    expect(
      dmVerdict({ ...loading, starredOrSectioned: true, cache: { [dm(1)]: [10, 10, 10, 0] } }).state
    ).toBe("shown");
  });
});

describe("dmVerdict · legacy 갈래 (옛 서버: 원장 + 되살림 판정)", () => {
  const legacy = { ...BASE, mode: "legacy" as const, read: row(dm(1)) };

  it("원장이 닫은 DM 은 새 메시지가 없으면 숨고, 새 메시지가 오면 돌아온다", () => {
    expect(dmVerdict({ ...legacy, ledgerClosedAtSeq: 10 })).toEqual({ state: "hidden", rule: 7 });
    expect(
      dmVerdict({ ...legacy, read: row(dm(1), { latestSeq: 11, lastReadSeq: 11 }), ledgerClosedAtSeq: 10 })
    ).toEqual({ state: "shown", rule: 8 });
  });

  it("되살림 판정이 기계 메시지뿐이라고 하면 닫을 때의 seq 로 눌러 숨은 채다", () => {
    expect(
      dmVerdict({
        ...legacy,
        read: row(dm(1), { latestSeq: 30, lastReadSeq: 10 }),
        ledgerClosedAtSeq: 10,
        revivalLatestSeq: 10,
      })
    ).toEqual({ state: "hidden", rule: 7 });
  });

  it("나간 상대의 안 읽음이 기계 메시지뿐이면(ambient) 숨고, 사람이 읽을 것이면(human) 보인다", () => {
    const unread = row(dm(1), { latestSeq: 14, lastReadSeq: 10, unreadCount: 4 });
    expect(dmVerdict({ ...legacy, counterpart: "gone", read: unread, goneVerdict: "ambient" })).toEqual({
      state: "hidden",
      rule: 6,
    });
    expect(dmVerdict({ ...legacy, counterpart: "gone", read: unread, goneVerdict: "pending" }).state).toBe("hidden");
    expect(dmVerdict({ ...legacy, counterpart: "gone", read: unread, goneVerdict: "human" }).state).toBe("shown");
    expect(dmVerdict({ ...legacy, counterpart: "gone", read: unread, goneVerdict: "error" }).state).toBe("shown");
  });

  it("투영이 오는 중이면 원장이 닫은 DM·나간 상대의 DM 은 숨은 채, 나머지는 보인다(깜빡임 방지)", () => {
    const loading = { ...legacy, phase: "loading" as const, read: undefined };
    expect(dmVerdict({ ...loading, ledgerClosedAtSeq: 3 }).state).toBe("hidden");
    expect(dmVerdict({ ...loading, counterpart: "gone" }).state).toBe("hidden");
    expect(dmVerdict(loading).state).toBe("shown");
  });

  it("투영을 못 읽었으면 보인다(2)", () => {
    expect(dmVerdict({ ...legacy, phase: "error", ledgerClosedAtSeq: 10 })).toEqual({ state: "shown", rule: 2 });
  });
});

// ---- 로컬 원장 이전 (D12, 수용기준 11) -------------------------------------------------

describe("migrateDmLedger (D12)", () => {
  const hiddenRow = (n: number, closedAt = 10) =>
    row(dm(n), { latestSeq: closedAt, latestReadableSeq: closedAt, closedAtSeq: null });

  function harness(options: {
    ledger: Record<string, number>;
    rows: ReadState[];
    outcome?: (channelId: string) => "ok" | number | "network";
    storage?: MemoryStorage;
  }) {
    const ledger = { ...options.ledger };
    const puts: Array<[string, number]> = [];
    const storage = options.storage ?? new MemoryStorage();
    const run = () =>
      migrateDmLedger({
        workspaceId: WS,
        ledger,
        rows: options.rows,
        put: async (channelId, seenSeq) => {
          puts.push([channelId, seenSeq]);
          const outcome = options.outcome?.(channelId) ?? "ok";
          if (outcome === "ok") return;
          if (outcome === "network") throw new Error("offline");
          throw Object.assign(new Error("http"), { status: outcome });
        },
        forget: (channelId) => {
          delete ledger[channelId];
        },
        storage,
      });
    return { ledger, puts, storage, run };
  }

  it("숨은 항목만 올리고(워터마크가 seenSeq), 올린 항목만 원장에서 지운다", async () => {
    const h = harness({
      ledger: { [dm(1)]: 10, [dm(2)]: 7 },
      rows: [hiddenRow(1, 10), row(dm(2), { latestSeq: 9, latestReadableSeq: 9, closedAtSeq: null })],
    });
    const result = await h.run();
    // dm(2) 는 닫은 뒤(7) 읽을 메시지(9)가 와서 되살아났다: 올리지 않고 건드리지 않는다.
    expect(h.puts).toEqual([[dm(1), 10]]);
    expect(h.ledger).toEqual({ [dm(2)]: 7 });
    expect(result).toMatchObject({ settled: [dm(1)], kept: [], absent: false, done: true });
  });

  it("(기기, 워크스페이스)마다 한 번만 일어난다: 두 번째 호출은 아무것도 보내지 않는다", async () => {
    const h = harness({ ledger: { [dm(1)]: 10 }, rows: [hiddenRow(1)] });
    await h.run();
    expect(dmLedgerMigrated(WS, h.storage)).toBe(true);
    h.ledger[dm(1)] = 10; // 같은 항목이 다시 생겨도(다른 탭 등) 이 워크스페이스는 이미 이전했다
    const again = await h.run();
    expect(h.puts).toHaveLength(1);
    expect(again.done).toBe(true);
    // 다른 워크스페이스는 자기 마커가 따로다.
    expect(dmLedgerMigrated(OTHER_WS, h.storage)).toBe(false);
  });

  it("부분 실패한 항목은 남고, 마커가 없어 다음 실행이 그 항목만 다시 한다", async () => {
    let failing = true;
    const h = harness({
      ledger: { [dm(1)]: 10, [dm(2)]: 10, [dm(3)]: 10 },
      rows: [hiddenRow(1), hiddenRow(2), hiddenRow(3)],
      outcome: (channelId) => (channelId === dm(2) && failing ? 500 : "ok"),
    });
    const first = await h.run();
    expect(first).toMatchObject({ settled: [dm(1), dm(3)], kept: [dm(2)], done: false });
    expect(h.ledger).toEqual({ [dm(2)]: 10 });
    expect(dmLedgerMigrated(WS, h.storage)).toBe(false);

    failing = false;
    h.puts.length = 0;
    const second = await h.run();
    expect(h.puts).toEqual([[dm(2), 10]]);
    expect(second).toMatchObject({ settled: [dm(2)], kept: [], done: true });
    expect(h.ledger).toEqual({});
  });

  it("네트워크 실패도 남긴다(항목을 잃지 않는다)", async () => {
    const h = harness({ ledger: { [dm(1)]: 10 }, rows: [hiddenRow(1)], outcome: () => "network" });
    const result = await h.run();
    expect(h.ledger).toEqual({ [dm(1)]: 10 });
    expect(result.done).toBe(false);
  });

  it("404 는 그 DM 이 서버에 없다는 뜻이다: 그 항목을 지운다", async () => {
    const h = harness({ ledger: { [dm(1)]: 10 }, rows: [hiddenRow(1)], outcome: () => 404 });
    const result = await h.run();
    expect(h.ledger).toEqual({});
    expect(result).toMatchObject({ settled: [dm(1)], done: true });
  });

  it("405/501 은 경로가 없다: 멈추고, 아무것도 지우지 않고, 마커도 적지 않는다", async () => {
    const h = harness({
      ledger: { [dm(1)]: 10, [dm(2)]: 10 },
      rows: [hiddenRow(1), hiddenRow(2)],
      outcome: () => 405,
    });
    const result = await h.run();
    expect(h.puts).toHaveLength(1); // 첫 항목에서 멈췄다
    expect(h.ledger).toEqual({ [dm(1)]: 10, [dm(2)]: 10 });
    expect(result).toMatchObject({ absent: true, done: false });
    expect(dmLedgerMigrated(WS, h.storage)).toBe(false);
  });

  it("투영에 행이 없는 항목은 건드리지 않는다(숨었는지 모른다)", async () => {
    const h = harness({ ledger: { [dm(1)]: 10 }, rows: [] });
    await h.run();
    expect(h.puts).toHaveLength(0);
    expect(h.ledger).toEqual({ [dm(1)]: 10 });
  });

  it("마커는 워크스페이스 단위로 적힌다", async () => {
    const h = harness({ ledger: {}, rows: [] });
    await h.run();
    expect(JSON.parse(h.storage.getItem(DM_CLOSURE_MIGRATED_KEY) ?? "[]")).toEqual([WS]);
  });
});
