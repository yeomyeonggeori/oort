import { describe, expect, it } from "vitest";
import {
  EXPIRY_WARN_MS,
  expiryPhase,
  expirySoonCopy,
  minutesLeft,
  reproposeDraft,
} from "./expiry";

const EXPIRES = 1_000_000_000_000;
const MIN = 60_000;

describe("승인 기한 국면 (#3738)", () => {
  it("경계: 10분 1초 전은 조용하고, 9분 59초 전부터 경고다", () => {
    expect(expiryPhase(EXPIRES, EXPIRES - 10 * MIN - 1_000)).toBe("none");
    expect(expiryPhase(EXPIRES, EXPIRES - 10 * MIN)).toBe("soon");
    expect(expiryPhase(EXPIRES, EXPIRES - (9 * MIN + 59_000))).toBe("soon");
  });

  it("경계: 기한 정각과 그 뒤는 만료다", () => {
    expect(expiryPhase(EXPIRES, EXPIRES - 1)).toBe("soon");
    expect(expiryPhase(EXPIRES, EXPIRES)).toBe("expired");
    expect(expiryPhase(EXPIRES, EXPIRES + 10 * MIN + 1)).toBe("expired");
  });

  it("기한을 모르면 지어내지 않는다", () => {
    expect(expiryPhase(undefined, EXPIRES)).toBe("none");
    expect(expiryPhase(null, EXPIRES)).toBe("none");
  });

  it("경고 창은 10분이다", () => {
    expect(EXPIRY_WARN_MS).toBe(10 * MIN);
  });

  it("남은 분은 올림이고 0분이라고 말하지 않는다", () => {
    expect(minutesLeft(EXPIRES, EXPIRES - 59_000)).toBe(1);
    expect(minutesLeft(EXPIRES, EXPIRES - 61_000)).toBe(2);
    expect(minutesLeft(EXPIRES, EXPIRES - 10 * MIN)).toBe(10);
    expect(expirySoonCopy(EXPIRES, EXPIRES - 61_000)).toBe(
      "2분 안에 만료돼요. 결정하지 않으면 에이전트가 다시 제안해야 해요."
    );
  });

  it("다시 제안 초안은 에이전트 핸들을 멘션한다", () => {
    const draft = reproposeDraft("grokbot");
    expect(draft.startsWith("@grokbot ")).toBe(true);
    expect(draft.endsWith(" ")).toBe(true);
  });
});
