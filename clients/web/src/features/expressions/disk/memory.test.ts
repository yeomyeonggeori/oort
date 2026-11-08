// 메모리 가짜 저장소(ADR-0218 §14 M5): 진짜 구현과 같은 규칙(순수 함수 `planTrim`·`shouldTouchLastRead`)을 부르고, 시험이 앱 재시작을 흉내 내는 데 쓴다.
import { describe, expect, it } from "vitest";
import {
  EXPRESSION_DISK_LAST_READ_GRANULARITY_MS,
  expressionDiskKey,
  expressionDiskName,
} from "@momo/core/features/expressions/diskCache";
import { createMemoryDiskBackend } from "./memory";

const ID = "00000000-0000-4000-8000-000000000011";
const SHA = "ab".repeat(32);
const WS = "00000000-0000-4000-8000-000000000001";
const ME = "00000000-0000-4000-8000-000000000002";

describe("메모리 가짜(진짜 구현과 같은 규칙)", () => {
  const image = (length: number) => ({ bytes: new ArrayBuffer(length), mime: "image/png" });

  it("읽으면 마지막 읽은 시각이 오르고(1분 단위), 상한을 넘으면 오래 읽지 않은 것부터 버려서 최근에 읽은 항목이 남는다", async () => {
    let clock = 1_000_000;
    const backend = createMemoryDiskBackend({ now: () => clock, budgetBytes: 25 });
    const compartment = backend.open(expressionDiskName(WS, ME)!)!;
    for (const name of ["a", "b", "c", "d"]) { await compartment.write(name, image(10)); clock += 1000; }
    clock += EXPRESSION_DISK_LAST_READ_GRANULARITY_MS;
    expect(await compartment.read("a")).not.toBeNull(); // a 를 최근에 읽었다
    await compartment.trim();
    expect(await compartment.keys()).toEqual(["a", "d"]); // b·c(가장 오래 읽지 않은 둘)가 나갔다
  });

  it("id 별 삭제는 그 표현의 모든 크기·sha 를 지우고 다른 표현은 남긴다", async () => {
    const backend = createMemoryDiskBackend();
    const compartment = backend.open(expressionDiskName(WS, ME)!)!;
    const other = "00000000-0000-4000-8000-000000000012";
    await compartment.write(expressionDiskKey(ID, "large", SHA), image(4));
    await compartment.write(expressionDiskKey(ID, "thumb", "cd".repeat(32)), image(4));
    await compartment.write(expressionDiskKey(other, "large", SHA), image(4));
    await compartment.removeIds([ID]);
    expect(await compartment.keys()).toEqual([expressionDiskKey(other, "large", SHA)]);
  });
});
