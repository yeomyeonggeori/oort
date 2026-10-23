import { describe, expect, it } from "vitest";
import {
  GONE_UNREAD_PAGE_LIMIT,
  HUMAN_MESSAGE_PAGE_LIMIT,
  isAmbientMessage,
  pageHasHumanMessage,
} from "./ambientMessage";

// #4142 에서 웹에 있던 구별을 #4252 가 코어로 옮겼다(웹·폰이 같이 읽는다). 웹 `dmRevival.test.ts` 가 다시 내보낸 이름으로 같은
// 표를 한 번 더 잰다. 여기서는 코어가 자기 이름으로 그 계약을 잡는다.

describe("isAmbientMessage", () => {
  it.each([
    ["system", { type: "system" as const }],
    ["tool_call", { type: "tool_call" as const }],
    ["tool_result", { type: "tool_result" as const }],
    ["work_session 카드", { type: "text" as const, props: { kind: "work_session" } }],
    ["지워진 글", { type: "text" as const, state: "deleted" as const }],
  ])("%s 는 사람이 읽을 것이 아니다", (_name, message) => {
    expect(isAmbientMessage(message)).toBe(true);
  });

  it.each([
    ["글", { type: "text" as const }],
    ["승인 요청", { type: "approval_request" as const }],
    ["산출물", { type: "artifact" as const }],
  ])("%s 는 사람이 읽을 것이다", (_name, message) => {
    expect(isAmbientMessage(message)).toBe(false);
  });
});

describe("pageHasHumanMessage", () => {
  it("기계 메시지뿐이면 없다, 하나라도 섞이면 있다", () => {
    expect(pageHasHumanMessage([{ type: "system" }, { type: "tool_call" }])).toBe(false);
    expect(pageHasHumanMessage([{ type: "system" }, { type: "text" }])).toBe(true);
  });

  it("쪽이 가득 찼으면 뒤를 모르므로 있다고 본다 (모르면 보이는 쪽)", () => {
    expect(HUMAN_MESSAGE_PAGE_LIMIT).toBe(50);
    const full = Array.from({ length: HUMAN_MESSAGE_PAGE_LIMIT }, () => ({ type: "system" as const }));
    expect(pageHasHumanMessage(full)).toBe(true);
    expect(pageHasHumanMessage(full.slice(1))).toBe(false);
  });

  it("빈 쪽은 없다", () => {
    expect(pageHasHumanMessage([])).toBe(false);
  });

  it("쪽을 요청한 크기(limit)를 알려 주면 그 크기에서 가득 찬 것으로 본다: 나간 멤버 DM 의 안 읽음은 서버 최대 200 건까지 읽는다 (design-review M-A)", () => {
    expect(GONE_UNREAD_PAGE_LIMIT).toBe(200);
    const ambient = (n: number) => Array.from({ length: n }, () => ({ type: "system" as const }));
    // 50 건(되살림의 크기)은 이 크기에서는 가득 찬 쪽이 아니다: 기계 메시지뿐이다.
    expect(pageHasHumanMessage(ambient(50), GONE_UNREAD_PAGE_LIMIT)).toBe(false);
    expect(pageHasHumanMessage(ambient(120), GONE_UNREAD_PAGE_LIMIT)).toBe(false);
    expect(pageHasHumanMessage(ambient(199), GONE_UNREAD_PAGE_LIMIT)).toBe(false);
    // 200 건이 다 기계 메시지여도 뒤를 모르므로 보이는 쪽이다.
    expect(pageHasHumanMessage(ambient(200), GONE_UNREAD_PAGE_LIMIT)).toBe(true);
    // 크기를 안 알려 주면 예전 그대로(50)다.
    expect(pageHasHumanMessage(ambient(50))).toBe(true);
  });
});
