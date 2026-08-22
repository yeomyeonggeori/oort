import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllFirstMentionRecords,
  firstMentionRecordKey,
  readFirstMentionRecord,
  writeFirstMentionRecord,
  MAX_FIRST_MENTION_RECORDS,
} from "./firstMentionStore";

const WS = "00000000-0000-7000-8000-000000000001";
const CH_A = "00000000-0000-7000-8000-0000000000a1";
const CH_B = "00000000-0000-7000-8000-0000000000b1";
const AGENT = "00000000-0000-7000-8000-0000000000c1";
const NOW = 1_800_000_000_000;

let store: Map<string, string>;

beforeEach(() => {
  store = new Map();
  vi.stubGlobal("localStorage", {
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
});

describe("첫 왕복 완료/닫기는 채널마다 따로 산다", () => {
  it("완료를 되읽는다", () => {
    writeFirstMentionRecord(WS, CH_A, AGENT, "complete", NOW);
    expect(readFirstMentionRecord(WS, CH_A, AGENT)).toBe("complete");
  });

  it("A 채널 기록이 B 채널로 따라가지 않는다", () => {
    writeFirstMentionRecord(WS, CH_A, AGENT, "complete", NOW);
    expect(readFirstMentionRecord(WS, CH_B, AGENT)).toBeNull();
  });

  it("id 의 대소문자를 접는다", () => {
    expect(firstMentionRecordKey(WS, CH_A.toUpperCase(), AGENT)).toBe(
      firstMentionRecordKey(WS, CH_A, AGENT)
    );
  });

  it("완료는 닫기로 낮아지지 않는다", () => {
    writeFirstMentionRecord(WS, CH_A, AGENT, "complete", NOW);
    writeFirstMentionRecord(WS, CH_A, AGENT, "dismissed", NOW + 1);
    expect(readFirstMentionRecord(WS, CH_A, AGENT)).toBe("complete");
  });

  it("로그아웃은 이 기기의 기록을 전부 지운다", () => {
    writeFirstMentionRecord(WS, CH_A, AGENT, "dismissed", NOW);
    store.set("momo.web.session.v1", "{}");
    clearAllFirstMentionRecords();
    expect(readFirstMentionRecord(WS, CH_A, AGENT)).toBeNull();
    expect(store.has("momo.web.session.v1")).toBe(true);
  });

  it("정원을 넘기면 가장 오래된 것부터 버린다", () => {
    for (let i = 0; i < MAX_FIRST_MENTION_RECORDS + 3; i += 1) {
      const channel = `00000000-0000-7000-8000-${i.toString(16).padStart(12, "0")}`;
      writeFirstMentionRecord(WS, channel, AGENT, "dismissed", NOW + i);
    }
    expect(store.size).toBe(MAX_FIRST_MENTION_RECORDS);
  });
});
