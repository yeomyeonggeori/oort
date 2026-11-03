// @vitest-environment jsdom
import { act } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, type RenderResult } from "@testing-library/react";
import { FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";

// #4986. 삭제·신고 확인이 별도 대화상자였을 때, 그 스크림(층 200)이 고르개(표면 층 300) 아래에 깔려서 앱은 흐려졌는데
// 고르개는 밝게 남았고(디자인 검수 M11), 확인 창을 닫아도 초점이 「관리」로 돌아가지 않았다(M12). 떠 있는 표면은 하나라는
// 규칙(README §3.4)에 맞게, 확인은 고르개 안의 단계가 된다. 이 시험은 그 단계가 어떻게 서고 어디로 초점을 돌려주는지 잰다.
vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]) }));

function makeStore() {
  return new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID));
}
type Claim = { current: (() => void) | null };
async function mountPanel(store = makeStore()) {
  await store.refresh();
  const claim: Claim = { current: null };
  const view = render(<ExpressionsContext.Provider value={store}><TeamExpressionsPanel purpose="reaction" onPick={() => {}} escapeClaim={claim} /></ExpressionsContext.Provider>);
  return { store, claim, view };
}
function manage(view: RenderResult) { return view.getByRole("button", { name: "파티 앵무새 관리" }); }
async function chooseFromMenu(view: RenderResult, name: "신고하기" | "삭제하기") {
  const trigger = manage(view);
  fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse", ctrlKey: false });
  fireEvent.keyDown(trigger, { key: "Enter" });
  fireEvent.click(await view.findByRole("menuitem", { name }));
}
const step = (view: RenderResult) => view.queryByTestId("expression-confirm");

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); resetSettledApprovalsForTest(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("팀 표현 삭제·신고 확인은 고르개 안의 단계다 (#4986)", () => {
  it("확인 단계는 대화상자가 아니라 고르개 안에 서고, 목록은 그 동안 내려가 있다(밝게 남는 두 번째 표면이 없다)", async () => {
    const { view } = await mountPanel();
    await chooseFromMenu(view, "삭제하기");
    expect(step(view)).toBeTruthy();
    // 떠 있는 두 번째 표면(대화상자·알림 대화상자)이 없다.
    expect(document.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    expect(document.querySelector('[data-overlay-layer="scrim"]')).toBeNull();
    // 이름 붙은 그룹이고 제목과 설명이 이어져 있다.
    const group = view.getByRole("group", { name: "팀 그림을 삭제할까요?" });
    expect(group.getAttribute("aria-describedby")).toBeTruthy();
    expect(view.queryByRole("list", { name: "팀 표현 목록" })).toBeNull();
    expect(view.queryByLabelText("우리 팀 표현 검색")).toBeNull();
  });

  it("초점은 「취소」로 들어가고, 취소하면 그 항목의 「관리」로 돌아간다", async () => {
    const { view } = await mountPanel();
    await chooseFromMenu(view, "삭제하기");
    const cancel = view.getByRole("button", { name: "취소" });
    expect(document.activeElement).toBe(cancel);
    fireEvent.click(cancel);
    expect(step(view)).toBeNull();
    expect(document.activeElement).toBe(manage(view));
  });

  it("Esc는 고르개를 닫지 않고 확인 단계만 취소한다: 이 단계가 서 있는 동안에만 임자가 있다", async () => {
    const { view, claim } = await mountPanel();
    expect(claim.current).toBeNull();
    await chooseFromMenu(view, "신고하기");
    expect(claim.current).toBeTypeOf("function");
    act(() => claim.current!());
    expect(step(view)).toBeNull();
    expect(claim.current).toBeNull();
    expect(document.activeElement).toBe(manage(view));
  });

  it("신고 확인을 보내면 항목이 숨겨지고, 초점은 body가 아니라 검색 칸으로 간다", async () => {
    const { view, store } = await mountPanel();
    const mutate = vi.spyOn(store, "mutate");
    await chooseFromMenu(view, "신고하기");
    expect(mutate).not.toHaveBeenCalled(); // 단계가 서는 것만으로는 아무것도 나가지 않는다
    fireEvent.click(view.getByRole("button", { name: "신고하고 숨기기" }));
    await waitFor(() => expect(mutate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(step(view)).toBeNull());
    expect(view.queryByRole("button", { name: "파티 앵무새 관리" })).toBeNull();
    expect(document.activeElement).toBe(view.getByLabelText("우리 팀 표현 검색"));
  });

  it("보내는 동안 초점을 쥔 단추는 disabled가 되지 않고 자기 진행으로 잠기지 않아서 초점이 body로 떨어지지 않는다", async () => {
    const { view, store } = await mountPanel();
    let finish!: () => void;
    vi.spyOn(store, "mutate").mockImplementation(() => new Promise<never>((resolve) => { finish = () => resolve(undefined as never); }));
    await chooseFromMenu(view, "삭제하기");
    const destructive = view.getByRole("button", { name: "삭제하기" });
    destructive.focus();
    fireEvent.click(destructive);
    const busy = await view.findByRole("button", { name: "처리 중" });
    expect(busy).toBe(destructive);
    expect(busy.hasAttribute("disabled")).toBe(false);
    // 진행은 aria-busy + 바뀐 낱말이다. 자기 진행으로 자기를 잠그지도 흐리지도 않는다(낭독이 「처리 중, 사용 안 함」이 되지 않게).
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.getAttribute("aria-disabled")).toBeNull();
    expect(busy.classList.contains("opacity-50")).toBe(false);
    expect(document.activeElement).toBe(busy);
    // 형제인 취소가 그 진행 때문에 잠긴다: aria-disabled + 흐림이고 눌러도 닫지 않는다. 두 번 눌러도 한 번만 나간다.
    const cancel = view.getByRole("button", { name: "취소" });
    expect(cancel.getAttribute("aria-disabled")).toBe("true");
    expect(cancel.classList.contains("opacity-50")).toBe(true);
    expect(cancel.hasAttribute("disabled")).toBe(false);
    fireEvent.click(cancel);
    expect(step(view)).toBeTruthy();
    fireEvent.click(busy);
    expect(vi.mocked(store.mutate)).toHaveBeenCalledTimes(1);
    await act(async () => { finish(); });
  });

  it("연결이 없으면 보내는 단추만 잠긴다: aria-disabled + 흐림이고 눌러도 아무것도 나가지 않으며, 취소는 그대로 쓴다", async () => {
    const { view, store } = await mountPanel();
    const mutate = vi.spyOn(store, "mutate");
    await chooseFromMenu(view, "삭제하기");
    act(() => store.setOffline(true));
    const destructive = view.getByRole("button", { name: "삭제하기" });
    await waitFor(() => expect(destructive.getAttribute("aria-disabled")).toBe("true"));
    expect(destructive.hasAttribute("disabled")).toBe(false);
    expect(destructive.classList.contains("opacity-50")).toBe(true);
    fireEvent.click(destructive);
    expect(mutate).not.toHaveBeenCalled();
    // 취소는 연결과 상관없이 살아 있다.
    const cancel = view.getByRole("button", { name: "취소" });
    expect(cancel.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(cancel);
    expect(step(view)).toBeNull();
  });

  it("신고는 고른 사유를 보내고, 보내는 동안 사유 칸은 잠긴다(초점은 보내는 단추에 있다)", async () => {
    const { view, store } = await mountPanel();
    let finish!: () => void;
    const mutate = vi.spyOn(store, "mutate").mockImplementation(() => new Promise<never>((resolve) => { finish = () => resolve(undefined as never); }));
    await chooseFromMenu(view, "신고하기");
    const reason = view.getByLabelText("신고 사유") as HTMLSelectElement;
    expect(reason.disabled).toBe(false);
    fireEvent.change(reason, { target: { value: "face" } });
    const send = view.getByRole("button", { name: "신고하고 숨기기" });
    send.focus();
    fireEvent.click(send);
    await view.findByRole("button", { name: "처리 중" });
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]![0]).toMatchObject({ method: "POST", body: { reason: "face" } });
    expect((view.getByLabelText("신고 사유") as HTMLSelectElement).disabled).toBe(true);
    expect(document.activeElement).toBe(view.getByRole("button", { name: "처리 중" }));
    await act(async () => { finish(); });
  });

  it("실패는 같은 단계 안에서 말하고 단추를 다시 쓸 수 있다", async () => {
    const { view, store } = await mountPanel();
    vi.spyOn(store, "mutate").mockRejectedValueOnce(new Error("503"));
    await chooseFromMenu(view, "삭제하기");
    fireEvent.click(view.getByRole("button", { name: "삭제하기" }));
    const alert = await view.findByRole("alert");
    expect(alert.textContent).toContain("변경하지 못했어요");
    expect(step(view)).toBeTruthy();
    expect(view.getByRole("button", { name: "삭제하기" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("확인 단계가 서 있는 동안 「추가하기」 메뉴는 없다", async () => {
    const { view } = await mountPanel();
    expect(view.getByTestId("expression-add-menu")).toBeTruthy();
    await chooseFromMenu(view, "삭제하기");
    expect(view.queryByTestId("expression-add-menu")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "취소" }));
    expect(view.getByTestId("expression-add-menu")).toBeTruthy();
  });
});
