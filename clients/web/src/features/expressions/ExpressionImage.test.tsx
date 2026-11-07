// @vitest-environment jsdom
// #5456: 이모티콘·GIF 를 누르면 사라지거나 흔들리던 것. 웹·데스크탑 반쪽(ExpressionImage).
// 이 시험이 재는 것: ① 정지 그림은 누르거나 화면 밖으로 나갔다 돌아와도 같은 노드·같은 그림이다, ② GIF 를 누르면 같은 노드에서 새 장면으로 바뀌고
// 저장소 캐시가 밀려나 있어도 그림 요청이 나가지 않는다, ③ 다시 돌 그림이 디코드되기 전에는 앞 그림이 DOM 에 그대로 남는다, ④ 칸 크기는
// 메타데이터의 가로·세로로 먼저 잡힌다, ⑤ 오프라인·실패는 글자로 남고 다시 불러오기가 된다.
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { FIXTURE_EXPRESSIONS, FIXTURE_MEMBER_ID, FIXTURE_WORKSPACE_ID } from "@momo/core/features/expressions/fixtures";
import { FIXTURE_MEDIA } from "@momo/core/features/expressions/fixtureMedia";
import { loopForeverDataUrl } from "@momo/core/features/expressions/gifLoop";
import type { Expression, ExpressionImage as Picture } from "@momo/core/features/expressions/types";
import { ExpressionStore } from "./ExpressionStore";
import type { ExpressionTransport } from "./transport";
import { ExpressionsContext } from "./context";
import { ExpressionImage } from "./ExpressionImage";

const THUMB = "data:image/png;base64,THUMB";
const STILL = "data:image/png;base64,STILL";
const GIF = "data:image/gif;base64,R0lGODlh";
const STOP_AFTER_MS = 60_000 * 4;
const picture = (mime: Picture["mime"], width: number, height: number, durationMs: number): Picture => ({ mime, sha256: "a".repeat(64), bytes: 100, width, height, frameCount: durationMs ? 8 : 1, durationMs });
// 움직이는 표현(작은 128x96 · 큰 400x300 · 정지 thumb 128x96)과 정지 표현(전부 PNG). 한 번 재생 60초라 4회 뒤 정지 시각을 가짜 시계로 건너뛴다.
const gifItem: Expression = { ...FIXTURE_EXPRESSIONS[0], media: { small: picture("image/gif", 128, 96, 60_000), large: picture("image/gif", 400, 300, 60_000), thumb: picture("image/png", 128, 96, 0) } };
const stillItem: Expression = { ...FIXTURE_EXPRESSIONS[1], id: "00000000-0000-4000-8000-0000000000aa", media: { small: picture("image/png", 96, 96, 0), large: picture("image/png", 256, 256, 0), thumb: picture("image/png", 96, 96, 0) } };

function build() {
  const transport = {
    json: vi.fn(),
    image: vi.fn(async (path: string) => path.includes("size=thumb") ? THUMB : path.includes(stillItem.id) ? STILL : GIF),
  } satisfies ExpressionTransport;
  const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
  return { store, transport, lookups: vi.spyOn(store, "image") };
}
const wrapper = (store: ExpressionStore, content: React.ReactNode) => <ExpressionsContext.Provider value={store}>{content}</ExpressionsContext.Provider>;
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
const flush = () => act(async () => {});
const evictStoreCache = (store: ExpressionStore) => (store as unknown as { images: Map<string, unknown> }).images.clear();

// 제어되는 관찰자: 보임(IntersectionObserver)은 시험이 낸다.
function controlledVisibility() {
  const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
  vi.stubGlobal("IntersectionObserver", class {
    constructor(callback: (entries: Array<{ isIntersecting: boolean }>) => void) { callbacks.push(callback); }
    observe() {} disconnect() {}
  });
  return { report: (isIntersecting: boolean) => act(() => { for (const callback of callbacks) callback([{ isIntersecting }]); }) };
}
// 디코드는 jsdom 에 없다. 쥐고 있다가(hold) 시험이 풀어 주는 가짜: 풀리기 전의 화면을 잰다.
function controlledDecode() {
  const state = { hold: false, release: () => {} };
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true, writable: true,
    value: vi.fn(() => state.hold ? new Promise<void>((resolve) => { state.release = resolve; }) : Promise.resolve()),
  });
  return state;
}
// 그림이 사라지거나(img 제거) 글자 자리표시가 선 적이 한 번이라도 있는지 센다.
function watchGaps(root: HTMLElement, name: string) {
  const seen = { imagesRemoved: 0, placeholders: 0 };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach((node) => { if (node instanceof Element && (node.tagName === "IMG" || node.querySelector("img"))) seen.imagesRemoved += 1; });
      record.addedNodes.forEach((node) => { if ((node.textContent ?? "") === `:${name}:`) seen.placeholders += 1; });
    }
  });
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  return { seen, stop: () => observer.disconnect() };
}
const image = (root: HTMLElement) => root.querySelector("img");
// 4회 재생이 끝나 멈춘 상태까지: 가짜 시계가 4회 뒤 시각을 소유하도록 한 번 새로 마운트한다(기존 시험과 같은 방법).
async function reachStopped(store: ExpressionStore, view: ReturnType<typeof render>) {
  await waitFor(() => expect(image(view.container)?.src).toBe(GIF));
  vi.useFakeTimers();
  view.rerender(wrapper(store, <ExpressionImage key="clock" item={gifItem} size="large" />));
  await flush();
  expect(image(view.container)?.src).toBe(GIF);
  await act(async () => { vi.advanceTimersByTime(STOP_AFTER_MS); });
  await flush();
  expect(image(view.container)?.src).toBe(THUMB);
  return view.getByRole("button", { name: `${gifItem.displayName} 다시 재생` });
}

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  vi.stubGlobal("matchMedia", vi.fn().mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});
afterEach(() => {
  cleanup(); vi.useRealTimers(); vi.unstubAllGlobals();
  delete (HTMLImageElement.prototype as { decode?: unknown }).decode;
});

describe("ExpressionImage: 누르면 사라지거나 흔들리던 것 (#5456)", () => {
  it("정지 이모티콘은 누르거나 화면 밖으로 나갔다 돌아와도 같은 노드와 같은 그림이다", async () => {
    const sight = controlledVisibility(); const { store, transport } = build();
    const view = render(wrapper(store, <ExpressionImage item={stillItem} size="large" />));
    await settle(); await waitFor(() => expect(image(view.container)?.src).toBe(THUMB));
    await sight.report(true); await waitFor(() => expect(image(view.container)?.src).toBe(STILL));
    const node = image(view.container)!; const gaps = watchGaps(view.container, stillItem.name);
    const requests = transport.image.mock.calls.length;
    fireEvent.click(node); fireEvent.pointerDown(node); fireEvent.pointerUp(node); await settle();
    expect(image(view.container)).toBe(node); expect(node.src).toBe(STILL);
    // 화면 밖으로 나가면 정지 thumb, 돌아오면 큰 그림: 노드는 그대로이고 src 만 바뀐다. 요청은 더 나가지 않는다.
    await sight.report(false); await settle(); expect(image(view.container)).toBe(node); expect(node.src).toBe(THUMB);
    await sight.report(true); await settle(); expect(image(view.container)).toBe(node); expect(node.src).toBe(STILL);
    expect(view.container.querySelectorAll("img")).toHaveLength(1); expect(view.queryByRole("button")).toBeNull();
    expect(gaps.seen).toEqual({ imagesRemoved: 0, placeholders: 0 }); gaps.stop();
    expect(transport.image.mock.calls.length).toBe(requests);
  });

  it("GIF 를 누르면 같은 노드에서 새 장면으로 바뀌고, 저장소 캐시가 밀려나 있어도 그림 요청이 나가지 않는다", async () => {
    const { store, transport, lookups } = build();
    const view = render(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    const button = await reachStopped(store, view);
    const node = image(view.container)!;
    // 96칸 캐시에서 이 GIF 가 밀려난 상태(저장소의 선입선출): 옛 판은 여기서 그림을 다시 내려받으며 글자 자리표시를 세웠다.
    evictStoreCache(store);
    const before = { lookups: lookups.mock.calls.length, transport: transport.image.mock.calls.length };
    const gaps = watchGaps(view.container, gifItem.name);
    fireEvent.click(button); await flush();
    expect(lookups.mock.calls.length).toBe(before.lookups); expect(transport.image.mock.calls.length).toBe(before.transport);
    expect(image(view.container)).toBe(node); expect(node.src).toBe(`data:image/gif;replay=1;base64,${GIF.slice("data:image/gif;base64,".length)}`);
    expect(gaps.seen).toEqual({ imagesRemoved: 0, placeholders: 0 });
    // 다시 멈추고 또 누르면 또 다른 주소(replay=2): 같은 주소는 엔진이 한 그림으로 묶어 중간 장면에서 시작한다.
    await act(async () => { vi.advanceTimersByTime(STOP_AFTER_MS); }); await flush();
    expect(node.src).toBe(THUMB);
    fireEvent.click(view.getByRole("button", { name: `${gifItem.displayName} 다시 재생` })); await flush();
    expect(image(view.container)).toBe(node); expect(node.src).toContain("data:image/gif;replay=2;base64,");
    expect(gaps.seen).toEqual({ imagesRemoved: 0, placeholders: 0 }); gaps.stop();
    expect(lookups.mock.calls.length).toBe(before.lookups); expect(transport.image.mock.calls.length).toBe(before.transport);
  });

  it("다시 돌 그림이 디코드되기 전에는 앞 그림이 같은 노드로 DOM 에 남아 있다", async () => {
    const decode = controlledDecode(); const { store } = build();
    const view = render(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    const button = await reachStopped(store, view);
    const node = image(view.container)!;
    decode.hold = true;
    fireEvent.click(button); await flush();
    // 디코드 중: 앞 그림(정지 thumb)이 그대로 걸려 있고 빈 칸도 글자도 없다. 단추만 걷혔다.
    expect(image(view.container)).toBe(node); expect(node.src).toBe(THUMB);
    expect(view.container.textContent).toBe(""); expect(view.container.querySelector("canvas")).toBeNull();
    expect(view.queryByRole("button", { name: `${gifItem.displayName} 다시 재생` })).toBeNull();
    decode.hold = false; await act(async () => { decode.release(); });
    expect(image(view.container)).toBe(node); expect(node.src).toContain("data:image/gif;replay=1;base64,");
  });

  it("칸 크기는 받기 전에 메타데이터의 가로·세로로 먼저 잡히고, 그림이 와도 그대로다", async () => {
    const decode = controlledDecode(); decode.hold = true; const { store } = build();
    const view = render(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    // 아직 아무것도 못 받았다: 글자가 아니라 큰 그림이 앉을 칸(400x300 을 200 안에 맞춘 200x150)이 서 있다.
    const slot = view.container.querySelector("canvas")!;
    expect(slot.getAttribute("width")).toBe("200"); expect(slot.getAttribute("height")).toBe("150");
    expect(view.container.textContent).toBe("");
    decode.hold = false; await act(async () => { decode.release(); }); await settle();
    const node = await waitFor(() => { const found = image(view.container); expect(found?.src).toBe(GIF); return found!; });
    expect(node.getAttribute("width")).toBe("200"); expect(node.getAttribute("height")).toBe("150");
    // 가운데 크기는 64 안에, 글 사이·반응은 CSS 가 높이를 정하므로 속성을 달지 않는다.
    cleanup(); decode.hold = false;
    const medium = render(wrapper(store, <ExpressionImage item={gifItem} size="medium" />));
    await waitFor(() => expect(image(medium.container)?.src).toBe(GIF));
    expect(image(medium.container)!.getAttribute("width")).toBe("64"); expect(image(medium.container)!.getAttribute("height")).toBe("48");
    cleanup();
    const inline = render(wrapper(store, <ExpressionImage item={gifItem} size="inline" />));
    await waitFor(() => expect(image(inline.container)?.src).toBe(GIF));
    expect(image(inline.container)!.hasAttribute("width")).toBe(false);
    // 동작 줄이기: thumb 만 그리므로 바꿔 끼울 일이 없어 칸을 잡지 않는다.
    cleanup(); vi.mocked(window.matchMedia).mockImplementation(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const reduced = render(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    await waitFor(() => expect(image(reduced.container)?.src).toBe(THUMB));
    expect(image(reduced.container)!.hasAttribute("width")).toBe(false);
    // 같은 자리에 다른 표현이 오면(본문 편집) 앞 표현의 그림을 대신 걸어 두지 않는다: 받는 동안은 새 표현의 빈 칸이다.
    cleanup(); vi.mocked(window.matchMedia).mockImplementation(() => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const swap = render(wrapper(store, <ExpressionImage item={stillItem} size="large" />));
    await waitFor(() => expect(image(swap.container)?.src).toBe(STILL));
    decode.hold = true;
    swap.rerender(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    expect(image(swap.container)).toBeNull(); expect(swap.container.querySelector("canvas")).not.toBeNull();
  });

  it("오프라인과 실패는 글자로 남고, 그림 다시 불러오기로 받아 온다", async () => {
    const { store, transport } = build();
    transport.image.mockImplementation(async () => { throw new Error("network"); });
    const view = render(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    await settle();
    expect(image(view.container)).toBeNull(); expect(view.container.textContent).toContain(`:${gifItem.name}:`);
    // 받을 수 있게 되면 단추로 다시 받아 온다(저장소는 실패한 읽기를 캐시에 남기지 않는다).
    transport.image.mockImplementation(async (path: string) => path.includes("size=thumb") ? THUMB : GIF);
    fireEvent.click(view.getByRole("button", { name: "그림 다시 불러오기" }));
    await waitFor(() => expect(image(view.container)?.src).toBe(GIF));
    expect(view.queryByRole("button", { name: "그림 다시 불러오기" })).toBeNull();
    // 오프라인: 받아 둔 그림도 걷고 글자만 남긴다.
    await act(async () => { store.setOffline(true); });
    expect(image(view.container)).toBeNull(); expect(view.container.textContent).toContain(`:${gifItem.name}:`);
  });
});

// #5504: 반응 칩의 GIF 는 4번 돌고 멈추지 않는다(owner 2026-11-07). 서버 GIF 는 반복 횟수가 4번(NETSCAPE 3)이라 타이머만 빼서는 엔진이 마지막 장면에서 멈추므로,
// 반응 칩은 같은 그림의 반복 횟수만 무한으로 바꾼 주소를 그린다. 엔진이 정말 계속 도는지는 `ReactionChips.motion.browser.test.ts` 가 실제 엔진으로 잰다.
describe("ExpressionImage: 반응 칩의 GIF 는 계속 움직인다 (#5504)", () => {
  // 바이트가 진짜 GIF 여야 반복 횟수를 바꾼 주소가 원본과 달라진다(위의 짧은 글자 GIF 는 GIF 머리 6글자뿐이라 바뀌지 않는다).
  const SERVER_GIF = `data:image/gif;base64,${FIXTURE_MEDIA.gif.bodyBase64}`;
  const LOOPING_GIF = loopForeverDataUrl(SERVER_GIF);
  function buildReal() {
    const transport = {
      json: vi.fn(),
      image: vi.fn(async (path: string) => path.includes("size=thumb") ? THUMB : SERVER_GIF),
    } satisfies ExpressionTransport;
    const store = new ExpressionStore(FIXTURE_WORKSPACE_ID, FIXTURE_MEMBER_ID, transport);
    return { store, transport };
  }
  const smallCalls = (transport: { image: { mock: { calls: unknown[][] } } }) => transport.image.mock.calls.filter(([path]) => String(path).includes("size=small")).length;
  // 가짜 시계 아래에서 새로 마운트해 4회 뒤 시각을 건너뛴다(기존 시험과 같은 방법).
  async function afterFourPlays(store: ExpressionStore, size: "reaction" | "large", view: ReturnType<typeof render>) {
    await waitFor(() => expect(image(view.container)?.src).not.toBe(THUMB));
    vi.useFakeTimers();
    view.rerender(wrapper(store, <ExpressionImage key="clock" item={gifItem} size={size} />));
    await flush();
    await act(async () => { vi.advanceTimersByTime(STOP_AFTER_MS + 1_000); });
    await flush();
  }

  it("반응 칩은 4번 돌 시간이 지나도 멈춘 그림(thumb)으로 바뀌지 않고, 같은 시간이 지난 큰 그림은 멈춘다", async () => {
    const { store } = buildReal();
    const chip = render(wrapper(store, <ExpressionImage item={gifItem} size="reaction" />));
    await afterFourPlays(store, "reaction", chip);
    expect(image(chip.container)?.src).toBe(LOOPING_GIF);
    expect(chip.queryByRole("button")).toBeNull();
    cleanup(); vi.useRealTimers();
    // 대조: 같은 시계에서 큰 그림은 정지 thumb 으로 바뀐다(메시지 속 GIF 의 4번 규칙은 그대로다).
    const large = render(wrapper(store, <ExpressionImage item={gifItem} size="large" />));
    await afterFourPlays(store, "large", large);
    expect(image(large.container)?.src).toBe(THUMB);
  });

  it("반응 칩은 원본이 아니라 반복 횟수가 바뀐 주소를 그린다: 원본 GIF 와 주소가 다르고 그림 요청은 같다", async () => {
    const { store, transport } = buildReal();
    expect(LOOPING_GIF).not.toBe(SERVER_GIF);
    const chip = render(wrapper(store, <ExpressionImage item={gifItem} size="reaction" />));
    await waitFor(() => expect(image(chip.container)?.src).toBe(LOOPING_GIF));
    cleanup();
    const inline = render(wrapper(store, <ExpressionImage item={gifItem} size="inline" />));
    await waitFor(() => expect(image(inline.container)?.src).toBe(SERVER_GIF));
    // 반응 칩도 글 사이 그림도 서버 그림 한 번(small)만 받는다: 반복 횟수만 바꾼 주소는 받은 그림에서 만든다.
    expect(smallCalls(transport)).toBe(1);
  });

  it("같은 그림의 반응 칩 여럿은 한 번 받고 한 주소를 나눠 쓴다(디코드를 한 번만)", async () => {
    const { store, transport } = buildReal();
    const row = render(wrapper(store, <>{[0, 1, 2, 3, 4, 5].map((index) => <ExpressionImage key={index} item={gifItem} size="reaction" />)}</>));
    await waitFor(() => expect(row.container.querySelectorAll("img")).toHaveLength(6));
    await waitFor(() => expect([...row.container.querySelectorAll("img")].every((node) => node.src === LOOPING_GIF)).toBe(true));
    expect(smallCalls(transport)).toBe(1);
  });

  it("동작 줄이기는 멈춘 첫 장면(thumb)이고 반복 횟수를 바꾼 그림을 만들지도 않는다", async () => {
    vi.mocked(window.matchMedia).mockImplementation(() => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as unknown as MediaQueryList);
    const { store, transport } = buildReal();
    const chip = render(wrapper(store, <ExpressionImage item={gifItem} size="reaction" />));
    await waitFor(() => expect(image(chip.container)?.src).toBe(THUMB));
    await settle();
    expect(image(chip.container)?.src).toBe(THUMB);
    expect(smallCalls(transport)).toBe(0);
  });

  it("화면 밖의 반응 칩은 멈춘 그림이고 돌아오면 계속 도는 그림이다", async () => {
    const sight = controlledVisibility(); const { store } = buildReal();
    const chip = render(wrapper(store, <ExpressionImage item={gifItem} size="reaction" />));
    await sight.report(true); await waitFor(() => expect(image(chip.container)?.src).toBe(LOOPING_GIF));
    const node = image(chip.container)!;
    await sight.report(false); await settle(); expect(image(chip.container)).toBe(node); expect(node.src).toBe(THUMB);
    await sight.report(true); await settle(); expect(image(chip.container)).toBe(node); expect(node.src).toBe(LOOPING_GIF);
  });
});
