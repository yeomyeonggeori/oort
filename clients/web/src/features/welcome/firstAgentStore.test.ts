import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearAllFirstAgentMarkers,
  firstAgentIsPending,
  firstAgentMarkerKey,
  markFirstAgentPending,
  readFirstAgentMarker,
  setFirstAgentResumeHash,
  takeFirstAgentResumeHash,
  writeFirstAgentMarker,
} from "./firstAgentStore";

const WS = "00000000-0000-7000-8000-000000000001";
const OTHER = "00000000-0000-7000-8000-000000000002";
const NOW = 1_800_000_000_000;

let local: Map<string, string>;
let session: Map<string, string>;

beforeEach(() => {
  local = new Map();
  session = new Map();
  const make = (store: Map<string, string>) => ({
    get length() {
      return store.size;
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
    removeItem: (key: string) => void store.delete(key),
  });
  vi.stubGlobal("localStorage", make(local));
  vi.stubGlobal("sessionStorage", make(session));
});

describe("건너뛰기·완료 마커 멱등", () => {
  it("완료는 건너뛰기로 낮아지지 않는다", () => {
    writeFirstAgentMarker(WS, "done", NOW);
    writeFirstAgentMarker(WS, "skipped", NOW + 1);
    expect(readFirstAgentMarker(WS)).toBe("done");
  });

  it("같은 건너뛰기를 두 번 써도 한 기록이다", () => {
    writeFirstAgentMarker(WS, "skipped", NOW);
    writeFirstAgentMarker(WS, "skipped", NOW + 1);
    expect(readFirstAgentMarker(WS)).toBe("skipped");
    expect(JSON.parse(local.get(firstAgentMarkerKey(WS)) ?? "{}").atMs).toBe(
      NOW + 1
    );
  });

  it("이미 마커가 있으면 pending 을 세우지 않는다", () => {
    writeFirstAgentMarker(WS, "skipped", NOW);
    markFirstAgentPending(WS);
    expect(firstAgentIsPending(WS)).toBe(false);
  });

  it("워크스페이스 키가 다르면 따라가지 않는다", () => {
    writeFirstAgentMarker(WS, "done", NOW);
    expect(readFirstAgentMarker(OTHER)).toBeNull();
    markFirstAgentPending(OTHER);
    expect(firstAgentIsPending(OTHER)).toBe(true);
    expect(firstAgentIsPending(WS)).toBe(false);
  });
});

describe("세션 pending 과 재개 해시", () => {
  it("pending 은 마커가 생기면 지워진다", () => {
    markFirstAgentPending(WS);
    expect(firstAgentIsPending(WS)).toBe(true);
    writeFirstAgentMarker(WS, "skipped", NOW);
    expect(firstAgentIsPending(WS)).toBe(false);
  });

  it("재개 해시는 한 번만 꺼낸다", () => {
    setFirstAgentResumeHash("#/settings?section=ai");
    expect(takeFirstAgentResumeHash()).toBe("#/settings?section=ai");
    expect(takeFirstAgentResumeHash()).toBeNull();
  });
});

describe("로그아웃은 이 마커를 지우지 않는다", () => {
  it("세션 로그아웃은 first mention 만 비운다", () => {
    const sessionSrc = readFileSync(
      fileURLToPath(new URL("../../app/session.tsx", import.meta.url)),
      "utf8"
    );
    expect(sessionSrc).toContain("clearAllFirstMentionRecords");
    expect(sessionSrc).not.toContain("clearAllFirstAgentMarkers");
    writeFirstAgentMarker(WS, "done", NOW);
    clearAllFirstAgentMarkers();
    expect(readFirstAgentMarker(WS)).toBeNull();
  });
});
