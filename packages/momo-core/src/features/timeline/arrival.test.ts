import { describe, expect, it } from "vitest";
import {
  MAX_CONSUMED_ARRIVAL_IDS,
  MAX_PENDING_ARRIVAL_GRANTS,
  capArrivalSet,
  takeArrivalPlay,
  type ArrivalDecisionInput,
} from "./arrival";

const SELF = "00000000-0000-7000-8000-0000000001ff";
const OTHER = "00000000-0000-7000-8000-000000000101";
const MSG = "0199cccc-0000-7000-8000-000000000201";

function input(
  overrides: Partial<ArrivalDecisionInput> = {}
): ArrivalDecisionInput {
  return {
    messageId: MSG,
    authorMemberId: OTHER,
    selfMemberId: SELF,
    provenance: "live",
    eventType: "message.new",
    alreadyHeld: false,
    reducedMotion: false,
    ...overrides,
  };
}

describe("takeArrivalPlay — play count is 0 or 1, never a shape", () => {
  it("실시간 도착(타 사용자, message.new)은 1", () => {
    const consumed = new Set<string>();
    expect(takeArrivalPlay(consumed, input())).toBe(1);
  });

  it("REST provenance 단독은 0 (eventType 은 자격 있음)", () => {
    const consumed = new Set<string>();
    expect(
      takeArrivalPlay(consumed, input({ provenance: "rest" }))
    ).toBe(0);
  });

  it("eventType rest 단독은 0 (provenance 는 live)", () => {
    const consumed = new Set<string>();
    expect(
      takeArrivalPlay(consumed, input({ eventType: "rest" }))
    ).toBe(0);
  });

  it("리플레이 게이트는 0", () => {
    const consumed = new Set<string>();
    expect(takeArrivalPlay(consumed, input({ provenance: "replay" }))).toBe(0);
  });

  it("초기 로드(REST head)는 0", () => {
    const consumed = new Set<string>();
    expect(
      takeArrivalPlay(
        consumed,
        input({
          provenance: "rest",
          messageId: "0199cccc-0000-7000-8000-000000000001",
        })
      )
    ).toBe(0);
  });

  it("가상화 언마운트→재마운트는 0 (플래그 소비)", () => {
    const consumed = new Set<string>();
    expect(takeArrivalPlay(consumed, input())).toBe(1);
    expect(takeArrivalPlay(consumed, input())).toBe(0);
  });

  it("자기 메시지 실시간 도착은 0", () => {
    const consumed = new Set<string>();
    expect(
      takeArrivalPlay(consumed, input({ authorMemberId: SELF }))
    ).toBe(0);
  });

  it("message.edited 는 0", () => {
    const consumed = new Set<string>();
    expect(
      takeArrivalPlay(consumed, input({ eventType: "message.edited" }))
    ).toBe(0);
  });

  it("이미 들고 있는 행의 에코는 0", () => {
    const consumed = new Set<string>();
    expect(takeArrivalPlay(consumed, input({ alreadyHeld: true }))).toBe(0);
  });

  it("reduced-motion 은 0", () => {
    const consumed = new Set<string>();
    expect(takeArrivalPlay(consumed, input({ reducedMotion: true }))).toBe(0);
  });

  it("자격이 없는 경로는 장부를 오염시키지 않는다", () => {
    const consumed = new Set<string>();
    expect(
      takeArrivalPlay(consumed, input({ provenance: "rest" }))
    ).toBe(0);
    expect(takeArrivalPlay(consumed, input())).toBe(1);
  });

  it("id 대소문자를 접어 소비한다", () => {
    const consumed = new Set<string>();
    expect(takeArrivalPlay(consumed, input({ messageId: MSG.toUpperCase() }))).toBe(
      1
    );
    expect(takeArrivalPlay(consumed, input({ messageId: MSG.toLowerCase() }))).toBe(
      0
    );
  });
});

describe("arrival grant caps", () => {
  it("pending grant 상한은 1", () => {
    expect(MAX_PENDING_ARRIVAL_GRANTS).toBe(1);
    const grants = new Set(["a", "b", "c"]);
    capArrivalSet(grants, MAX_PENDING_ARRIVAL_GRANTS);
    expect([...grants]).toEqual(["c"]);
  });

  it("consumed ledger 는 상한 안에서 가장 오래된 것부터 버린다", () => {
    const consumed = new Set<string>();
    for (let i = 0; i < MAX_CONSUMED_ARRIVAL_IDS + 3; i += 1) {
      consumed.add(`id-${i}`);
    }
    capArrivalSet(consumed, MAX_CONSUMED_ARRIVAL_IDS);
    expect(consumed.size).toBe(MAX_CONSUMED_ARRIVAL_IDS);
    expect(consumed.has("id-0")).toBe(false);
    expect(consumed.has("id-1")).toBe(false);
    expect(consumed.has("id-2")).toBe(false);
    expect(consumed.has(`id-${MAX_CONSUMED_ARRIVAL_IDS}`)).toBe(true);
  });
});
