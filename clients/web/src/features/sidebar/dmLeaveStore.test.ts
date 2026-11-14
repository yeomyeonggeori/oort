// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearDmLeaveReceipt, resetDmLeaveStoreForTest, showDmLeaveReceipt, useDmLeaveStore } from "./dmLeaveStore";

// 끝난 뒤 영수증 (ADR-0177 증보 2026-11-14 D21, #5825): 영수증마다 제 시계로 걷힌다. 첫 영수증이 붙들린 동안(포인터가 목록 위) 두 번째로
// 나가도 첫 자리가 빠지지 않아야 아래 줄이 포인터 밑에서 움직이지 않는다.

const WS = "00000000-0000-7000-8000-000000000001";
const A = "00000000-0000-7000-8000-000000000301";
const B = "00000000-0000-7000-8000-000000000302";

beforeEach(() => resetDmLeaveStoreForTest());

describe("영수증 목록", () => {
  it("두 번째 영수증이 첫 것을 밀어내지 않고, 걷기는 영수증마다 따로다", () => {
    const { result, rerender } = renderHook(() => useDmLeaveStore());
    showDmLeaveReceipt(WS, A);
    rerender();
    const first = result.current.receipts[0];
    showDmLeaveReceipt(WS, B.toUpperCase());
    rerender();
    expect(result.current.receipts.map((r) => r.channelId)).toEqual([A, B]);
    clearDmLeaveReceipt(result.current.receipts[1].id);
    rerender();
    expect(result.current.receipts).toEqual([first]);
    // 같은 대화를 다시 나가면(되살아난 뒤) 앞 영수증을 새 것이 대신한다.
    showDmLeaveReceipt(WS, A);
    rerender();
    expect(result.current.receipts).toHaveLength(1);
    expect(result.current.receipts[0].id).not.toBe(first.id);
  });
});
