// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { coreSession } from "@momo/core/runtime/host";
import { readSessionGeneration } from "@/features/expressions/disk/generation";
import { expressionDiskKey, expressionDiskName } from "@momo/core/features/expressions/diskCache";
import type { MemoryDiskBackend } from "@/features/expressions/disk/memory";

// =============================================================================
// 세션 경계의 한 자리 (ADR-0218 §14 M2.5·MA8, #5455 B-1).
//
// 로그아웃(`logout`)·죽은 토큰으로 복원 실패(`restoreSession`)·다른 탭의 로그아웃(`adoptExternal` → 만료 효과)·만료(`expired` 효과)는 모두 `clearSession()` 을
// 지난다. 그래서 이모티콘 그림의 기기 캐시 지우기는 그 한 줄에 걸려 있고, 이 시험이 그 줄을 잰다: `clearSession()` 이 모든 보관 칸을 지우고 세션 세대를 올린다.
// 진짜 IndexedDB 에서 지워지는지는 실제 엔진 시험(`disk/idb.browser.test.ts`)이 잰다.
// =============================================================================

const world = vi.hoisted(() => ({ backend: null as unknown as MemoryDiskBackend }));
vi.mock("../features/expressions/disk/idb", async () => {
  const memory = await import("../features/expressions/disk/memory");
  world.backend = memory.createMemoryDiskBackend();
  return { defaultExpressionDiskBackend: () => world.backend };
});

import { clearSession } from "./session";
import "./coreHost";

const WS = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";
const OTHER = "00000000-0000-4000-8000-0000000000aa";
const entry = { bytes: new ArrayBuffer(8), mime: "image/png" };
const sha = "c".repeat(64);

beforeEach(() => { localStorage.clear(); });

describe("clearSession 이 이모티콘 그림의 기기 캐시를 지운다", () => {
  it("모든 보관 칸(현재 멤버·다른 멤버)을 지우고 세션 세대를 올린다", async () => {
    const lineage = expressionDiskKey("00000000-0000-4000-8000-000000000011", "large", sha);
    world.backend.plant(expressionDiskName(WS, ME)!, lineage, entry);
    world.backend.plant(expressionDiskName(WS, OTHER)!, lineage, entry);
    localStorage.setItem("oort.expressions.disk.generation.v1", "before-sign-out");
    expect(world.backend.names()).toHaveLength(2);
    clearSession();
    // 세대는 **동기로 먼저** 올라간다(다른 탭의 늦은 쓰기가 지운 뒤에 되살리지 못하게).
    expect(readSessionGeneration()).not.toBe("before-sign-out");
    expect(readSessionGeneration()).not.toBeNull();
    await vi.waitFor(() => expect(world.backend.names()).toEqual([]));
  });

  it("복원 거절·로그아웃·만료가 부르는 코어의 clearSession 이 곧 이 함수다(그래서 위 한 줄이 네 길을 모두 덮는다)", () => {
    expect(coreSession().clearSession).toBe(clearSession);
  });
});
