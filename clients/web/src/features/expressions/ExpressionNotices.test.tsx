// @vitest-environment jsdom
// #5491 (ADR-0218 증보 9, §15): 변경 알림 처리 — 웹·데스크탑 저장소가 알림 둘(상세 → 옛 알림)을 어떻게 받아 어떤 그림을 건드리는가.
// 값으로 잰다: 그림 요청 수, 같은 <img> 노드가 그대로인가(빈 프레임이 없다), epoch(전체 폐기 횟수), 읽기 요청 수, 캐시 칸 수.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import type { ExpressionChanged, ExpressionChangedDetail } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import { ExpressionsContext } from "./context";
import { ExpressionImage } from "./ExpressionImage";
import { createExpressionFixtureTransport } from "./transport";
import { expressionNoticeHandlers } from "./notices";

const [parrot, other] = FIXTURE_EXPRESSIONS;
const detail = (action: ExpressionChangedDetail["action"], expressionIds: string[], version = "4"): ExpressionChangedDetail => ({
  type: "expression.changed.detail", workspaceId: FIXTURE_WORKSPACE_ID, version, action, expressionIds,
});
const plain = (version = "4"): ExpressionChanged => ({ type: "expression.changed", workspaceId: FIXTURE_WORKSPACE_ID, version });

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

/** 저장소 + 두 그림(`parrot`·`other`)을 그린 화면. 그림 요청과 목록 읽기를 세고, 숨기기는 가짜 서버에 직접 한다. */
async function mounted() {
  const transport = createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID);
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  await store.refresh();
  const image = vi.spyOn(store.transport, "image");
  const json = vi.spyOn(store.transport, "json");
  const view = render(
    <ExpressionsContext.Provider value={store}>
      <ExpressionImage item={parrot} size="inline" />
      <ExpressionImage item={other} size="inline" />
    </ExpressionsContext.Provider>,
  );
  const imgs = () => [...view.container.querySelectorAll("img")] as HTMLImageElement[];
  const canvases = () => view.container.querySelectorAll("canvas").length;
  await waitFor(() => expect(imgs()).toHaveLength(2));
  const nodes = imgs();
  const reads = () => json.mock.calls.filter(([request]) => request.method === "GET" && /\/expressions(\?|$)/.test(request.path)).length;
  const hide = (id: string) => store.transport.json({ method: "POST", path: `${store.base}/expressions/${id}/report`, body: { reason: "other" } });
  const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 15)); });
  const askedOther = image.mock.calls.filter(([path]) => path.includes(`/expressions/${other.id}/image`)).length;
  return { store, view, image, json, imgs, canvases, nodes, reads, hide, settle, handlers: expressionNoticeHandlers(store), base: { images: image.mock.calls.length, askedOther } };
}

describe("웹 알림 처리: 상세 알림 (ADR-0218 §15)", () => {
  it("등록 상세: 그리던 그림이 그대로이고(같은 <img>, 빈 칸 0) 그림 요청도 전체 폐기도 없이 목록만 새로 읽는다", async () => {
    const m = await mounted();
    const epoch = m.store.getSnapshot().epoch; const stats = m.store.imageCacheStats(); const reads = m.reads();
    act(() => m.handlers.detail(detail("created", ["00000000-0000-4000-8000-0000000000e1"])));
    await m.settle();
    expect(m.reads()).toBe(reads + 1); // 목록은 새로 읽는다
    expect(m.store.getSnapshot().epoch).toBe(epoch); // 전체 폐기 없음
    expect(m.image.mock.calls.length).toBe(m.base.images); // 그림 요청 0
    expect(m.imgs()).toHaveLength(2); expect(m.canvases()).toBe(0); // 빈 칸 0
    expect(m.imgs()[0]).toBe(m.nodes[0]); expect(m.imgs()[1]).toBe(m.nodes[1]); // 노드가 새로 만들어지지 않았다
    expect(m.store.imageCacheStats()).toEqual(stats);
  });

  it("고치기 상세도 같다", async () => {
    const m = await mounted(); const epoch = m.store.getSnapshot().epoch;
    act(() => m.handlers.detail(detail("edited", [parrot.id])));
    await m.settle();
    expect(m.store.getSnapshot().epoch).toBe(epoch);
    expect(m.image.mock.calls.length).toBe(m.base.images);
    expect(m.imgs()[0]).toBe(m.nodes[0]);
  });

  it("숨김 상세: 그 표현만 그 자리에서 글자가 되고 그 id 의 캐시 칸만 사라지며, 나머지는 같은 <img>·같은 캐시·요청 0이다", async () => {
    const m = await mounted();
    const before = m.store.imageCacheStats().entries;
    expect(before).toBeGreaterThanOrEqual(2);
    await m.hide(parrot.id);
    act(() => m.handlers.detail(detail("hidden", [parrot.id])));
    // 목록이 오기 전에도(아직 읽는 중) 숨겨진 표현은 이미 내려갔다.
    expect(m.store.getSnapshot().cache.items.some((item) => item.id === parrot.id)).toBe(false);
    expect(m.store.imageCacheStats().entries).toBe(before - 1);
    await m.settle();
    expect(m.view.container.querySelectorAll("img")).toHaveLength(1);
    expect(m.imgs()[0]).toBe(m.nodes[1]); // 남은 것은 같은 노드다
    expect(m.view.getByText(`:${parrot.name}:`)).toBeTruthy();
    // 남은 표현의 그림은 다시 받지 않았다(숨겨진 표현의 칸이 이 시험에서는 아직 붙어 있어 제 그림을 한 번 더 물을 뿐이다 — 서버가 404 로 답한다).
    const askedFor = (item: typeof parrot) => m.image.mock.calls.filter(([path]) => path.includes(`/expressions/${item.id}/image`)).length;
    expect(askedFor(other)).toBe(m.base.askedOther);
  });

  it("같은 version 의 옛 알림은 건너뛴다: 상세가 먼저 왔으면 전체 폐기가 없다. 상세 없이 오면 지금처럼 전부 폐기한다", async () => {
    const m = await mounted(); const epoch = m.store.getSnapshot().epoch;
    act(() => m.handlers.detail(detail("created", ["00000000-0000-4000-8000-0000000000e1"], "9")));
    act(() => m.handlers.changed(plain("9")));
    await m.settle();
    expect(m.store.getSnapshot().epoch).toBe(epoch);
    expect(m.imgs()[0]).toBe(m.nodes[0]);
    // 다른 version 의 옛 알림은 상세가 없으니 전부 폐기한다(v0.1.44 와 같다).
    act(() => m.handlers.changed(plain("10")));
    expect(m.store.getSnapshot().epoch).toBe(epoch + 1);
    await m.settle();
    expect(m.image.mock.calls.length).toBeGreaterThan(m.base.images); // 칸들이 그림을 다시 받는다
  });

  it("옛 알림이 먼저 오면(순서가 뒤집혀도) 전부 폐기하고, 뒤늦게 온 같은 version 의 등록 상세는 할 일이 없다", async () => {
    const m = await mounted(); const epoch = m.store.getSnapshot().epoch;
    act(() => m.handlers.changed(plain("11")));
    expect(m.store.getSnapshot().epoch).toBe(epoch + 1);
    const reads = m.reads();
    act(() => m.handlers.detail(detail("created", ["00000000-0000-4000-8000-0000000000e1"], "11")));
    expect(m.store.getSnapshot().epoch).toBe(epoch + 1);
    await m.settle();
    expect(m.reads()).toBe(reads); // 두 번째 읽기도 없다
  });

  it("옛 알림이 먼저 오고 숨김 상세가 늦게 와도 건너뛰지 않는다: 그 id 를 목록을 기다리지 않고 내리고 목록을 새로 읽는다 (#5491 H-5491-1)", async () => {
    const m = await mounted(); const epoch = m.store.getSnapshot().epoch;
    act(() => m.handlers.changed(plain("11")));
    expect(m.store.getSnapshot().epoch).toBe(epoch + 1);
    const reads = m.reads();
    expect(m.store.getSnapshot().cache.items.some((item) => item.id === parrot.id)).toBe(true);
    act(() => m.handlers.detail(detail("hidden", [parrot.id], "11")));
    // 목록이 오기 전에: 그 id 가 목록에서 빠지고 그 id 의 받는 중 읽기·캐시 칸은 새 세대가 된다(전체 폐기는 아니다).
    expect(m.store.getSnapshot().cache.items.some((item) => item.id === parrot.id)).toBe(false);
    expect(m.store.getSnapshot().revoked.get(parrot.id)).toBe(1);
    expect(m.store.getSnapshot().epoch).toBe(epoch + 1);
    await m.settle();
    expect(m.reads()).toBe(reads + 1); // 앞서 시작한 읽기는 버려지고 새로 읽는다
  });

  it("재구독(resync)은 기억을 비우고 전부 폐기한다", async () => {
    const m = await mounted(); const epoch = m.store.getSnapshot().epoch;
    act(() => m.handlers.detail(detail("created", ["00000000-0000-4000-8000-0000000000e1"], "12")));
    act(() => m.handlers.resync());
    expect(m.store.getSnapshot().epoch).toBe(epoch + 1);
    act(() => m.handlers.changed(plain("12")));
    expect(m.store.getSnapshot().epoch).toBe(epoch + 2); // 앞서 본 version 이어도 건너뛰지 않는다
  });

  it("evictImages 는 앞서 시작한 읽기의 낡은 답을 버린다 — 숨기기 전 목록이 늦게 와도 숨긴 등록이 되살아나지 않는다", async () => {
    // 알림 처리기는 걷은 뒤 읽기를 새로 시작하고 그것이 앞선 읽기를 낡게 만든다. 여기서는 저장소 하나만 재려고 `evictImages` 를 직접 부른다.
    const m = await mounted();
    let stale!: (value: unknown) => void;
    const preHide = await m.store.transport.json({ method: "GET", path: `${m.store.base}/expressions` });
    m.json.mockImplementationOnce(() => new Promise((resolve) => { stale = resolve; }));
    let reading!: Promise<void>;
    act(() => { reading = m.store.refresh(); }); // 알림보다 앞서 시작한 읽기(붙들려 있다)
    await m.hide(parrot.id);
    act(() => m.store.evictImages([parrot.id]));
    expect(m.store.getSnapshot().cache.items.some((item) => item.id === parrot.id)).toBe(false);
    await act(async () => { stale(preHide); await reading; }); // 숨기기 전 목록이 늦게 답한다
    expect(m.store.getSnapshot().cache.items.some((item) => item.id === parrot.id)).toBe(false);
  });

  it("알림 처리기: 숨김 상세 뒤의 새 읽기가 숨긴 등록을 목록에서 확인한다", async () => {
    const m = await mounted();
    await m.hide(parrot.id);
    act(() => m.handlers.detail(detail("hidden", [parrot.id])));
    await m.settle();
    expect(m.store.getSnapshot().cache.items.some((item) => item.id === parrot.id)).toBe(false);
    expect(m.store.getSnapshot().cache.version).toBe("4"); // 읽은 목록이 숨김 version 까지 왔다
    expect(m.store.getSnapshot().status).toBe("ready");
  });

  it("숨김 상세는 그 id 의 받는 중 그림만 버린다: 다른 그림의 받기는 이어진다", async () => {
    const transport = createExpressionFixtureTransport(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID);
    const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
    await store.refresh();
    const replies = new Map<string, (src: string) => void>();
    vi.spyOn(store.transport, "image").mockImplementation((path) => new Promise<string>((resolve) => { replies.set(path, resolve); }));
    const path = (item: typeof parrot) => `${store.base}/expressions/${item.id}/image?size=small&v=${item.media!.small.sha256}`;
    const lateParrot = store.image(path(parrot)); const lateOther = store.image(path(other));
    expect(replies.size).toBe(2);
    store.evictImages([parrot.id]);
    for (const reply of replies.values()) reply("data:image/png;base64,AAAA");
    await expect(lateParrot).rejects.toThrow("evicted expression");
    await expect(lateOther).resolves.toBe("data:image/png;base64,AAAA");
    expect(store.imageCacheStats().entries).toBe(1);
  });
});
