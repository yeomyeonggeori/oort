import { describe, expect, it } from "vitest";
import { buttonVariants } from "./button";

// 옛 이름 `outline` 은 `secondary` 와 모양이 같아야 한다(DS-13): 치환이 화면을 바꾸지 않는다는 계약.
describe("Button 옛 이름 outline == secondary", () => {
  it.each(["default", "sm", "lg", "icon"] as const)("size=%s 에서 class 가 같다", (size) => {
    expect(buttonVariants({ variant: "outline", size })).toBe(
      buttonVariants({ variant: "secondary", size })
    );
  });
});
