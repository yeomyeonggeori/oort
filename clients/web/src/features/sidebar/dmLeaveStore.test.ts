// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearDmLeaveReceipt,
  endDmLeaveRequest,
  holdDmLeaveReceipts,
  isDmLeaveListHeld,
  requestDmLeave,
  resetDmLeaveStoreForTest,
  showDmLeaveReceipt,
  subscribeDmLeaveStore,
  useDmLeaveStore,
} from "./dmLeaveStore";

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

// 영수증 걷기를 미루는 조건 (검수 r1 M4): 목록에서 연 메뉴가 열려 있거나 확인 창이 서 있는 동안 걷지 않는다.
describe("영수증 걷기 미루기", () => {
  it("메뉴가 열려 있는 동안 붙들리고, 둘이 열리면 둘 다 닫혀야 풀린다. 푸는 함수는 한 번만 센다", () => {
    expect(isDmLeaveListHeld()).toBe(false);
    const releaseA = holdDmLeaveReceipts();
    const releaseB = holdDmLeaveReceipts();
    expect(isDmLeaveListHeld()).toBe(true);
    releaseA();
    releaseA();
    expect(isDmLeaveListHeld()).toBe(true);
    releaseB();
    expect(isDmLeaveListHeld()).toBe(false);
  });

  it("확인 창(요청)이 서 있는 동안도 붙들린다", () => {
    requestDmLeave({ workspaceId: WS, channelId: A, name: "이서연", via: "row", opener: null, observedSeq: null, rootIds: [] });
    expect(isDmLeaveListHeld()).toBe(true);
    endDmLeaveRequest();
    expect(isDmLeaveListHeld()).toBe(false);
  });

  it("풀리는 순간 듣는 쪽에 알린다(영수증이 다시 걷을지 본다)", () => {
    let calls = 0;
    const off = subscribeDmLeaveStore(() => {
      calls += 1;
    });
    const release = holdDmLeaveReceipts();
    expect(calls).toBe(0);
    release();
    expect(calls).toBe(1);
    off();
  });
});
