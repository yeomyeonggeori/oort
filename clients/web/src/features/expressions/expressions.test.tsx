// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FIXTURE_LIST, FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { expressionChoice } from "@momo/core/features/expressions/cards";
import { MANUAL_UPLOAD_CODES, type ExpressionDraft } from "@momo/core/features/expressions/types";
import { expressionMessageModel } from "@momo/core/features/expressions/message";
import { authedResponse } from "@momo/core/lib/api";
import { ExpressionStore } from "./ExpressionStore";
import { createExpressionFixtureTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionDraftCard } from "./ExpressionDraftCard";
import { ExpressionImage } from "./ExpressionImage";
import { ExpressionApprovalCard } from "./ExpressionApprovalCard";
import { expressionApprovalPayload } from "./cards";
import { TeamExpressionsPanel } from "./TeamExpressionsPanel";
import { ExpressionText } from "./ExpressionText";
import { MessageBody } from "@/features/timeline/MessageBody";
import { useComposerAutocomplete } from "@/features/chat/useComposerAutocomplete";
import { resetSettledApprovalsForTest } from "@/features/timeline/settledApprovals";
import { validExpressionFile } from "./media";
import { prepareExpressionMarkdown } from "./markdown";

vi.mock("@momo/core/lib/api", async (actual) => ({ ...await actual<object>(), fetchRoster: vi.fn().mockResolvedValue([]), authedResponse: vi.fn() }));

function makeStore(code?: typeof MANUAL_UPLOAD_CODES[number]) {
  return new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, code));
}
const metadata = { name: "happy_dance", displayName: "신나는 춤", tags: ["축하"], subjectMemberId: null };
const file = () => new File(["pixels"], "dance.gif", { type: "image/gif" });
const wrapper = (store: ExpressionStore, content: React.ReactNode) => <ExpressionsContext.Provider value={store}>{content}</ExpressionsContext.Provider>;
async function prepare(store: ExpressionStore, fromUrl = false) {
  return store.draft({ method: "POST", path: `${store.base}/expressions/${fromUrl ? "import" : "uploads"}`, body: fromUrl ? { ...metadata, url: "https://giphy.com/gifs/dance?tracking=removed" } : metadata, file: fromUrl ? undefined : file() });
}
beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); resetSettledApprovalsForTest(); vi.clearAllMocks();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterAll(() => { delete (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("team expressions web/desktop port", () => {
  it("runs every import failure through source, replacement revision, stale choice refusal and activation", async () => {
    for (const code of MANUAL_UPLOAD_CODES) {
      const store = makeStore(code); await store.refresh();
      const failed = await prepare(store, true);
      expect(failed.state).toBe("manual_upload_required");
      expect(failed.code).toBe(code); expect(failed.origin.sourceUrl).toBe("https://giphy.com/gifs/dance");
      expect(expressionChoice(failed, Date.now())).toBeNull();
      const ready = await store.draft({ method: "PUT", path: `${store.base}/expression-drafts/${failed.draftId}/file`, file: file() });
      const oldPin = expressionChoice(ready, Date.now())!;
      const replaced = await store.draft({ method: "PUT", path: `${store.base}/expression-drafts/${ready.draftId}/file`, file: file() });
      await expect(store.mutate({ method: "POST", path: `${store.base}/expressions`, body: oldPin })).rejects.toThrow();
      expect(replaced.origin).toEqual(failed.origin);
      await store.mutate({ method: "POST", path: `${store.base}/expressions`, body: expressionChoice(replaced, Date.now())! });
      expect(store.getSnapshot().cache.items.some((item) => item.name === metadata.name)).toBe(true);
    }
  });
  it("evicts in-flight authenticated media on offline, disposal and workspace isolation", async () => {
    const store = makeStore(); let finish!: (src: string) => void;
    store.transport.image = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));
    const read = store.image("/old/image"); store.setOffline(true); finish("data:image/png;base64,AA==");
    await expect(read).rejects.toThrow("evicted");
    await expect(store.image("/old/image")).rejects.toThrow("offline");
    store.setOffline(false); const old = store.image("/old/image"); store.dispose(); finish("data:image/png;base64,AA==");
    await expect(old).rejects.toThrow("evicted");
    const other = new ExpressionStore("different-workspace", "other-member", store.transport);
    expect(other.getSnapshot().cache.items).toEqual([]);
  });
  it("falls back in body and reactions immediately after report and preserves removal text", async () => {
    const store = makeStore(); await store.refresh();
    const item = store.getSnapshot().cache.items[0]; const token = `:${item.name}:`;
    const view = render(wrapper(store, <><MessageBody body={token} /><ExpressionText text={token} reaction /></>));
    await waitFor(() => expect(view.container.querySelectorAll("img").length).toBe(2));
    await act(() => store.mutate({ method: "POST", path: `${store.base}/expressions/${item.id}/report`, body: { reason: "copyright" } }));
    expect(view.container.querySelectorAll("img")).toHaveLength(0); expect(view.container.textContent).toBe(token + token);
    await act(() => store.mutate({ method: "DELETE", path: `${store.base}/expressions/${item.id}` }));
    expect(expressionMessageModel(token, store.getSnapshot().cache.items).size).toBe("inline");
  });
  it("preserves escaped/code/link/URL tokens and applies all body sizes", async () => {
    const store = makeStore(); await store.refresh();
    const token = ":party_parrot:";
    const body = `그림 ${token} \\${token} \`${token}\` [${token}](https://example.com/${token}) https://example.com/${token}`;
    const view = render(wrapper(store, <MessageBody body={body} />));
    await waitFor(() => expect(view.container.querySelectorAll("img")).toHaveLength(1));
    expect(view.container.querySelector("code")?.textContent).toBe(token);
    expect(view.container.querySelector("a")?.textContent).toBe(token);
    expect(view.container.textContent).not.toContain("\ue000");
    for (const [body, size] of [[token, "large"], [Array(6).fill(token).join(" "), "medium"], [Array(7).fill(token).join(" "), "inline"], [`${token} 👍`, "inline"]]) {
      expect(prepareExpressionMarkdown(body, store.getSnapshot().cache.items).size).toBe(size);
    }
  });
  it("requires the replacement preview image to load and rights to be checked before registration", async () => {
    const store = makeStore("source_blocked"); const failed = await prepare(store, true); const approve = vi.fn().mockResolvedValue(undefined);
    function Harness() { const [draft, setDraft] = useState<ExpressionDraft>(failed); return <ExpressionDraftCard draft={draft} onReplace={setDraft} onApprove={approve} />; }
    const view = render(wrapper(store, <Harness />));
    expect(view.getByRole("link").getAttribute("href")).toBe("https://giphy.com/gifs/dance");
    expect(view.queryByRole("button", { name: "팀 보관함에 등록" })).toBeNull();
    fireEvent.change(view.getByLabelText("대신 올릴 그림"), { target: { files: { item: () => file(), length: 1 } } });
    const button = await view.findByRole("button", { name: "팀 보관함에 등록" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(view.getByRole("checkbox")); expect(button.disabled).toBe(true);
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    fireEvent.load(view.container.querySelector("img")!);
    await waitFor(() => expect(button.disabled).toBe(false));
    fireEvent.click(button); await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve.mock.calls[0][0]).toMatchObject({ draftId: failed.draftId, revision: "2" });
  });
  // #4912 (S3 묶음 검증 R4). 동작 줄이기에서는 큰 그림 대신 정지 썸네일을 그리므로 「보임」이 바뀌어도 그림 주소가
  // 같다: <img>가 다시 만들어지지 않아 load가 다시 오지 않는다. 옛 코드는 load 시점에 보이는 경우에만 준비
  // 신호를 냈고, 그림이 IntersectionObserver의 첫 보고보다 먼저 로드되면 등록·승인 단추가 영영 잠겼다.
  // 움직임을 허용하면 보임이 주소를 큰 그림으로 바꿔 항상 보인 뒤에 로드되므로 그 경주가 없다.
  // 제어되는 관찰자: 보고는 시험이 낸다.
  function controlledVisibility() {
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    vi.stubGlobal("IntersectionObserver", class {
      constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { callbacks.push(callback); }
      observe() {} disconnect() {}
    });
    return { report: (isIntersecting: boolean) => act(() => { for (const callback of callbacks) callback([{ isIntersecting }]); }) };
  }
  const reduceMotion = (matches: boolean) => vi.mocked(window.matchMedia).mockImplementation(() => ({ matches, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
  it("unlocks registration when the preview finished loading before it was reported visible, under reduced motion", async () => {
    reduceMotion(true); const sight = controlledVisibility();
    const store = makeStore(); const draft = await prepare(store); const approve = vi.fn().mockResolvedValue(undefined);
    const view = render(wrapper(store, <ExpressionDraftCard draft={draft} onReplace={() => {}} onApprove={approve} />));
    fireEvent.click(view.getByRole("checkbox"));
    const button = view.getByRole("button", { name: "팀 보관함에 등록" }) as HTMLButtonElement;
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    fireEvent.load(view.container.querySelector("img")!);
    // 그려졌지만 아직 화면에 있다는 보고가 없다: #4846의 잠금은 그대로다.
    expect(button.disabled).toBe(true);
    expect(view.getByText(/그림을 불러오는 중이에요/)).toBeTruthy();
    sight.report(true);
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(view.queryByText(/그림을 불러오는 중이에요/)).toBeNull();
    fireEvent.click(button); await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
  });
  it("keeps registration locked for a preview that loaded but was never on screen", async () => {
    reduceMotion(true); controlledVisibility();
    const store = makeStore(); const draft = await prepare(store); const approve = vi.fn().mockResolvedValue(undefined);
    const view = render(wrapper(store, <ExpressionDraftCard draft={draft} onReplace={() => {}} onApprove={approve} />));
    fireEvent.click(view.getByRole("checkbox"));
    const button = view.getByRole("button", { name: "팀 보관함에 등록" }) as HTMLButtonElement;
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull());
    fireEvent.load(view.container.querySelector("img")!);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    expect(button.disabled).toBe(true); expect(view.getByText(/그림을 불러오는 중이에요/)).toBeTruthy();
    fireEvent.click(button); expect(approve).not.toHaveBeenCalled();
  });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
  it("tells a reduced-motion preview is ready exactly once, whichever of load and visibility comes first", async () => {
    const store = makeStore(); const draft = await prepare(store);
    for (const loadFirst of [true, false]) {
      cleanup(); store.clearImages(); reduceMotion(true); const sight = controlledVisibility(); const ready = vi.fn();
      const view = render(wrapper(store, <ExpressionImage item={draft} size="large" onReady={ready} />));
      const load = async () => { await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull()); fireEvent.load(view.container.querySelector("img")!); };
      if (loadFirst) { await load(); await settle(); expect(ready).not.toHaveBeenCalled(); sight.report(true); }
      else { sight.report(true); await load(); }
      await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
      // 보임이 흔들리고 같은 그림이 다시 load돼도 신호는 더 오지 않는다.
      sight.report(false); sight.report(true); fireEvent.load(view.container.querySelector("img")!); await settle();
      expect(ready, `loadFirst=${loadFirst}`).toHaveBeenCalledTimes(1);
    }
  });
  it("tells a motion-allowed preview is ready once, only for the large picture after it is visible", async () => {
    reduceMotion(false); const sight = controlledVisibility(); const ready = vi.fn();
    const store = makeStore(); const draft = await prepare(store);
    const view = render(wrapper(store, <ExpressionImage item={draft} size="large" onReady={ready} />));
    // 보이기 전에는 정지 썸네일이다. 이 그림이 로드돼도 신호는 없다.
    await waitFor(() => expect(view.container.querySelector("img")?.src).toContain("data:image/png"));
    fireEvent.load(view.container.querySelector("img")!); await settle();
    expect(ready).not.toHaveBeenCalled();
    sight.report(true);
    await waitFor(() => expect(view.container.querySelector("img")?.src).toContain("data:image/gif"));
    fireEvent.load(view.container.querySelector("img")!);
    await waitFor(() => expect(ready).toHaveBeenCalledTimes(1));
    await settle(); expect(ready).toHaveBeenCalledTimes(1);
  });
  it("stops after four plays and restarts by keyboard activation", async () => {
    const store = makeStore(); await store.refresh();
    const item = store.getSnapshot().cache.items[0];
    const view = render(wrapper(store, <ExpressionImage item={item} size="large" />));
    await waitFor(() => expect(view.container.querySelector("img")?.src).toContain("data:image/gif"));
    vi.useFakeTimers();
    // Remount while the fake clock owns the animation deadline.
    view.rerender(wrapper(store, <ExpressionImage key="clock" item={item} size="large" />));
    await act(async () => {});
    await act(async () => { vi.advanceTimersByTime(item.media!.large.durationMs * 4); });
    expect(view.getByRole("button", { name: `${item.displayName} 다시 재생` })).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: `${item.displayName} 다시 재생` }));
    await act(async () => {});
    expect(view.queryByRole("button", { name: `${item.displayName} 다시 재생` })).toBeNull();
  });
  it("uses static thumbnails for grid, reduced motion and offscreen items", async () => {
    const store = makeStore(); await store.refresh(); const image = vi.spyOn(store.transport, "image");
    vi.mocked(window.matchMedia).mockImplementation(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const view = render(wrapper(store, <ExpressionImage item={FIXTURE_EXPRESSIONS[0]} size="large" />));
    await waitFor(() => expect(view.container.querySelector("img")?.src).toContain("data:image/png"));
    expect(image.mock.calls.every(([path]) => path.includes("size=thumb"))).toBe(true);
    cleanup(); store.clearImages(); image.mockClear();
    vi.mocked(window.matchMedia).mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    vi.stubGlobal("IntersectionObserver", class { observe() {} disconnect() {} });
    render(wrapper(store, <ExpressionImage item={FIXTURE_EXPRESSIONS[0]} size="large" />));
    await waitFor(() => expect(image).toHaveBeenCalled());
    expect(image.mock.calls.every(([path]) => path.includes("size=thumb"))).toBe(true);
  });
  it("shares emoji/sticker/GIF views and confirmation gates destructive mutations", async () => {
    const store = makeStore(); await store.refresh(); const mutation = vi.spyOn(store, "mutate"); const pick = vi.fn();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="reaction" onPick={pick} />));
    fireEvent.click(view.getByLabelText("스티커"));
    fireEvent.change(view.getByLabelText("우리 팀 표현 검색"), { target: { value: "ㅍㅌ" } });
    fireEvent.click(view.getByRole("button", { name: "파티 앵무새 반응으로 고르기" })); expect(pick).toHaveBeenCalledWith(":party_parrot:");
    const trigger = view.getByRole("button", { name: "파티 앵무새 관리" });
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse", ctrlKey: false }); fireEvent.keyDown(trigger, { key: "Enter" });
    const report = await view.findByRole("menuitem", { name: "신고하기" }); fireEvent.click(report);
    const confirm = await view.findByRole("button", { name: "신고하고 숨기기" });
    expect(mutation).not.toHaveBeenCalled(); fireEvent.click(confirm);
    await waitFor(() => expect(mutation).toHaveBeenCalledTimes(1));
  });
  it("completes team colon candidates with keyboard Enter without counting a preview as use", async () => {
    const store = makeStore(); await store.refresh();
    function Harness() {
      const [value, setValue] = useState(""); const ref = useRef<HTMLTextAreaElement>(null);
      const autocomplete = useComposerAutocomplete({ value, members: [], channels: [], inputRef: ref, onValueChange: setValue });
      return <><textarea ref={ref} value={value} onChange={(event) => autocomplete.onTextChange(event.target.value, event.target.selectionStart)} onKeyDown={(event) => { if (event.key === "Enter") autocomplete.handleIntent("mention-accept"); }} /><span data-testid="candidates">{autocomplete.candidates.map((item) => item.lead).join(",")}</span></>;
    }
    const view = render(wrapper(store, <Harness />)); const input = view.getByRole("textbox");
    fireEvent.change(input, { target: { value: ":party", selectionStart: 6 } });
    await waitFor(() => expect(view.getByTestId("candidates").textContent).toContain(":party_parrot:"));
    fireEvent.keyDown(input, { key: "Enter" }); expect((input as HTMLTextAreaElement).value).toBe(":party_parrot: ");
    expect(store.getSnapshot().usage.entries).toEqual([]);
  });
  it("records each successful send receipt once and restores only this workspace/member usage", async () => {
    const store = makeStore(); await store.refresh();
    store.recordSuccess(":party_parrot:", "send-1"); store.recordSuccess(":party_parrot:", "send-1");
    expect(store.getSnapshot().usage.entries[0].count).toBe(1);
    expect(makeStore().getSnapshot().usage.entries[0].count).toBe(1);
    const other = new ExpressionStore(FIXTURE_WORKSPACE_ID, "other-member", store.transport);
    expect(other.getSnapshot().usage.entries).toEqual([]);
  });
  it("keeps empty, loading, error, offline and large text controls actionable", async () => {
    const store = makeStore(); const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    expect(view.queryByTestId("team-expressions")).toBeTruthy();
    store.transport.json = vi.fn().mockRejectedValue(new Error("unreachable"));
    await act(() => store.refresh()); expect(view.getByRole("button", { name: "다시 시도" })).toBeTruthy();
    await act(async () => { store.setOffline(true); }); expect(view.getByText(/연결이 끊겼어요/)).toBeTruthy();
    const fresh = makeStore(); await fresh.refresh();
    for (const item of fresh.getSnapshot().cache.items) await fresh.mutate({ method: "DELETE", path: `${fresh.base}/expressions/${item.id}` });
    await act(async () => { view.rerender(wrapper(fresh, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />)); });
    expect(view.getByRole("button", { name: "첫 그림 올리기" })).toBeTruthy();
  });
  it("requests deltas, recovers a mismatched base with a full read and ignores late versions", async () => {
    const store = makeStore(); await store.refresh();
    const read = vi.fn().mockImplementation(async (request: { path: string }) => request.path.includes("since=") ? { ...FIXTURE_LIST, version: "4", reset: false, baseVersion: "2", items: [] } : { ...FIXTURE_LIST, version: "4", items: FIXTURE_EXPRESSIONS.slice(1) });
    store.transport.json = read;
    await store.refresh(false);
    expect(read.mock.calls.map(([request]) => request.path)).toEqual([`${store.base}/expressions?since=3`, `${store.base}/expressions`]);
    expect(store.getSnapshot().cache.version).toBe("4"); expect(store.getSnapshot().cache.items).toHaveLength(2);
    store.transport.json = vi.fn().mockResolvedValue(FIXTURE_LIST);
    await store.refresh(); expect(store.getSnapshot().cache.version).toBe("4"); expect(store.getSnapshot().status).toBe("ready");
  });
  it("rejects invalid/oversized files and malformed approval blocks", () => {
    expect(validExpressionFile(new File(["svg"], "unsafe.svg", { type: "image/svg+xml" }))).toBe(false);
    expect(validExpressionFile(new File([new Uint8Array(5 * 1024 * 1024 + 1)], "big.gif", { type: "image/gif" }))).toBe(false);
    expect(expressionApprovalPayload({ action: { id: "other", expression: { v: 1, candidates: [] } } })).toBeNull();
    expect(expressionApprovalPayload({ action: { id: "expression.create", expression: { v: 1, candidates: [] } } })).toBeNull();
  });
  it("sends the chosen draft revision/hash through the existing approval decision route", async () => {
    const store = makeStore(); await store.refresh(); const draft = await prepare(store);
    vi.mocked(authedResponse).mockResolvedValue({ status: 200, ok: true, text: "", json: <T,>() => ({ status: "approved", result: { status: "executed", expression: { id: draft.draftId, name: draft.name, token: `:${draft.name}:` } } }) as T, jsonOrNull: () => null });
    const card = { kind: "approval" as const, approvalId: "approval", title: "팀 그림 등록", status: "pending" as const, isResumeOffer: false, execution: null, action: { id: "expression.create", rows: [], omittedRows: 0, rationale: null, requiredRole: null }, detail: { rows: [], withheld: 0 }, channelId: "channel" };
    const view = render(wrapper(store, <ExpressionApprovalCard card={card} payload={{ v: 1, candidates: [draft] }} result={null} />));
    fireEvent.click(view.getByRole("checkbox"));
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull()); fireEvent.load(view.container.querySelector("img")!);
    const approve = view.getByRole("button", { name: "팀 보관함에 등록" }) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false)); fireEvent.click(approve);
    await waitFor(() => expect(authedResponse).toHaveBeenCalledTimes(1));
    const [path, init] = vi.mocked(authedResponse).mock.calls[0];
    expect(path).toBe(`${store.base}/approvals/approval/decision`);
    expect(JSON.parse(init!.body as string)).toMatchObject({ approve: true, expressionChoice: expressionChoice(draft, Date.now()) });
  });
  it("opens one add menu for both ways in and keeps the import form working end to end", async () => {
    const store = makeStore(); await store.refresh();
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    const trigger = view.getByTestId("expression-add-menu");
    fireEvent.keyDown(trigger, { key: "Enter" });
    const items = await view.findAllByRole("menuitem");
    expect(items.map((item) => item.textContent)).toEqual(["가져오기", "AI와 만들기"]);
    fireEvent.keyDown(items[0], { key: "Enter" });
    fireEvent.change(await view.findByLabelText("고정 이름"), { target: { value: "happy_dance" } });
    fireEvent.change(view.getByLabelText("표시 이름"), { target: { value: "신나는 춤" } });
    fireEvent.change(view.getByLabelText("직접 올릴 그림"), { target: { files: { item: () => file(), length: 1 } } });
    fireEvent.click(view.getByRole("button", { name: "미리보기 만들기" }));
    const draft = await view.findByTestId("expression-draft");
    expect(draft.textContent).toContain("신나는 춤");
    fireEvent.click(view.getByRole("checkbox"));
    await waitFor(() => expect(view.container.querySelector("img")).not.toBeNull()); fireEvent.load(view.container.querySelector("img")!);
    const register = view.getByRole("button", { name: "팀 보관함에 등록" }) as HTMLButtonElement;
    await waitFor(() => expect(register.disabled).toBe(false)); fireEvent.click(register);
    await waitFor(() => expect(store.getSnapshot().cache.items.some((item) => item.name === "happy_dance")).toBe(true));
    await waitFor(() => expect(document.activeElement).toBe(view.getByTestId("expression-add-menu")));
    expect(view.queryByTestId("expression-draft")).toBeNull();
  });
  it("opens the import form (not the AI form) from the empty state's first-upload action", async () => {
    const fresh = makeStore(); await fresh.refresh();
    for (const item of fresh.getSnapshot().cache.items) await fresh.mutate({ method: "DELETE", path: `${fresh.base}/expressions/${item.id}` });
    const view = render(wrapper(fresh, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    fireEvent.click(view.getByRole("button", { name: "첫 그림 올리기" }));
    expect(await view.findByLabelText("고정 이름")).toBeTruthy();
    expect(view.queryByTestId("expression-make-form")).toBeNull();
  });
  it("shares the add rule across both menu items: admin-only teams and offline lock the one trigger", async () => {
    const store = makeStore(); await store.refresh();
    store.transport.json = vi.fn().mockResolvedValue({ ...FIXTURE_LIST, addPolicy: "admins" });
    await act(() => store.refresh());
    const view = render(wrapper(store, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    const trigger = () => view.getByTestId("expression-add-menu") as HTMLButtonElement;
    expect(trigger().disabled).toBe(true);
    expect(view.getByText("이 팀은 관리자만 새 그림을 올릴 수 있어요.")).toBeTruthy();
    fireEvent.keyDown(trigger(), { key: "Enter" });
    expect(view.queryByRole("menu")).toBeNull();
    cleanup();
    const open = makeStore(); await open.refresh();
    const other = render(wrapper(open, <TeamExpressionsPanel purpose="insert" onPick={() => {}} />));
    expect((other.getByTestId("expression-add-menu") as HTMLButtonElement).disabled).toBe(false);
    await act(async () => { open.setOffline(true); });
    expect((other.getByTestId("expression-add-menu") as HTMLButtonElement).disabled).toBe(true);
  });
});
