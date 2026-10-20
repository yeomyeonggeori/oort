import { describe, expect, it } from "vitest";
import {
  effectiveLatestSeq,
  isAmbientMessage,
  pageHasHumanMessage,
  REVIVAL_PAGE_LIMIT,
} from "./dmRevival";
import { dmHiddenByClosure } from "./sidebarDmClosure";

describe("isAmbientMessage (#4142)", () => {
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
    ["이어 하기 제안(사람이 눌러야 한다)", { type: "approval_request" as const, props: { kind: "resume_offer" } }],
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
  it("쪽이 가득 찼으면 뒤를 모르므로 있다고 본다", () => {
    const full = Array.from({ length: REVIVAL_PAGE_LIMIT }, () => ({ type: "system" as const }));
    expect(pageHasHumanMessage(full)).toBe(true);
  });
  it("빈 쪽은 없다", () => {
    expect(pageHasHumanMessage([])).toBe(false);
  });
});

describe("effectiveLatestSeq -> dmHiddenByClosure", () => {
  const hidden = (raw: number | undefined, verdict: Parameters<typeof effectiveLatestSeq>[2]) =>
    dmHiddenByClosure({
      closedAtSeq: 9,
      latestSeq: effectiveLatestSeq(raw, 9, verdict),
      isOpen: false,
      phase: "ready",
    });
  it("기계 메시지뿐이거나 읽는 중이면 숨는다", () => {
    expect(hidden(14, "ambient")).toBe(true);
    expect(hidden(14, "pending")).toBe(true);
  });
  it("사람이 읽을 글이 있거나 읽지 못했으면 돌아온다", () => {
    expect(hidden(14, "human")).toBe(false);
    expect(hidden(14, "error")).toBe(false);
  });
  it("투영에 행이 없거나 새 메시지가 없으면 판정과 무관하게 원래대로다", () => {
    expect(effectiveLatestSeq(undefined, 9, "human")).toBeUndefined();
    expect(effectiveLatestSeq(9, 9, "human")).toBe(9);
  });
});
