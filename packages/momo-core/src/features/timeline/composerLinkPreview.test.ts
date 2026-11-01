import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../lib/api";
import type { UnfurlPreview } from "./unfurl";
import {
  UNFURL_PREVIEW_DEBOUNCE_MS,
  UNFURL_PREVIEW_FAILED_MEMORY_MS,
  UNFURL_PREVIEW_OK_MEMORY_MS,
  UNFURL_PREVIEW_RETRY_CEILING_SECONDS,
} from "./unfurlDraft";
import {
  createComposerLinkPreviewController,
  type ComposerLinkPreviewInput,
} from "./composerLinkPreview";

// =============================================================================
// #5037: 보내기 전 입력칸 미리보기의 상태기계(코어 컨트롤러). 웹·폰 입력칸 시험은 이 규칙을 화면을 통해 재고
// (`composerLinkPreview.test.tsx` 둘), 여기서는 화면이 닿기 어려운 **전이**를 직접 잰다: 기다림이 글마다 처음부터인 것과
// 요청을 끊는 열쇠가 따로인 것, 늦은 답, 기억의 길이, 429, 묻지 않는 때, ✕의 범위, 판의 안정성, 정리.
// 서버 호출(`fetchPreview`)만 손으로 여닫고 시계는 가짜다.
// =============================================================================

const WS = "ws-1";
const CH = "ch-1";
const A = "https://a.example/one";
const B = "https://b.example/two";
const C = "https://c.example/three";

interface Asked {
  workspaceId: string;
  channelId: string;
  url: string;
  signal: AbortSignal;
  resolve: (preview: UnfurlPreview) => void;
  reject: (error: unknown) => void;
}

let serial = 0;
function ok(url: string): UnfurlPreview {
  serial += 1;
  const domain = new URL(url).hostname;
  return { id: `p-${serial}`, url, status: "ok", title: `Title of ${domain}`, domain } as UnfurlPreview;
}

/** 호스트가 하는 일을 흉내 낸다: 입력이 바뀌면 효과(`sync`)를 부르고, 렌더(`view`)로 그릴 것을 읽는다. */
function harness() {
  const asked: Asked[] = [];
  const controller = createComposerLinkPreviewController({
    fetchPreview: (workspaceId, channelId, url, signal) =>
      new Promise<UnfurlPreview>((resolve, reject) => {
        asked.push({ workspaceId, channelId, url, signal, resolve, reject });
      }),
  });
  let input: ComposerLinkPreviewInput = {
    workspaceId: WS,
    channelId: CH,
    text: "",
    paused: false,
    enabled: true,
  };
  return {
    controller,
    asked,
    urls: () => asked.map((request) => request.url),
    cardUrls: () => controller.view(input).cards.map((card) => card.url),
    view: () => controller.view(input),
    set(change: Partial<ComposerLinkPreviewInput>) {
      input = { ...input, ...change };
      controller.sync(input);
      return controller.view(input);
    },
    advance: (ms: number) => vi.advanceTimersByTimeAsync(ms),
    async answer(index: number, preview: UnfurlPreview) {
      asked[index]!.resolve(preview);
      await vi.advanceTimersByTimeAsync(0);
    },
    async refuse(index: number, error: unknown) {
      asked[index]!.reject(error);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T10:00:00+09:00"));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("composer link preview controller (#5037)", () => {
  it("asks only after the typing stops, one address at a time and in the order of the text; rendering starts nothing", async () => {
    const h = harness();
    // 렌더만(효과 없이) 해서는 아무것도 묻지 않는다.
    h.controller.view({ workspaceId: WS, channelId: CH, text: A, paused: false, enabled: true });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 3);
    expect(h.urls()).toEqual([]);

    h.set({ text: `${A} ${B}` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS - 1);
    expect(h.urls()).toEqual([]);
    h.set({ text: `${A} ${B} ` }); // 글이 또 바뀌었다: 기다림이 처음부터다.
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS - 1);
    expect(h.urls()).toEqual([]);
    await h.advance(1);
    expect(h.urls()).toEqual([A]); // 한 번에 하나.
    expect(h.asked[0]).toMatchObject({ workspaceId: WS, channelId: CH });
    await h.answer(0, ok(A));
    expect(h.urls()).toEqual([A, B]);
    await h.answer(1, ok(B));
    expect(h.urls()).toEqual([A, B]);
    expect(h.cardUrls()).toEqual([A, B]); // 글에 나온 순서.
  });

  it("cuts the request when the links change and ignores its late answer; a words-only edit cuts nothing", async () => {
    const h = harness();
    h.set({ text: `${A} ${B}` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    const first = h.asked[0]!;
    expect(first.signal.aborted).toBe(false);

    // 링크는 그대로이고 글만 고쳤다: 요청은 끊지 않는다. 기다림이 끝나도 나가 있는 요청이 있는 동안은 새 판을 열지 않고,
    // 답이 오면 그 판이 이어서 다음 주소를 묻는다.
    h.set({ text: `look ${A} ${B}` });
    expect(first.signal.aborted).toBe(false);
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A]);
    await h.answer(0, ok(A));
    expect(h.urls()).toEqual([A, B]);
    await h.answer(1, ok(B));

    // 링크 구성이 바뀌었다: 나가 있던 요청을 끊는다.
    h.set({ text: `${B} ${C}` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    const cut = h.asked[2]!;
    expect(cut.url).toBe(C); // B는 받아 둔 답이 있어 건너뛴다.
    h.set({ text: A + " 그리고 다른 글 " + `${C}x` });
    expect(cut.signal.aborted).toBe(true);
    // 끊은 요청의 늦은 답: 기록하지 않고, 옛 링크의 나머지도 묻지 않는다.
    await h.answer(2, ok(C));
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls().slice(3)).toEqual(["https://c.example/threex"]);
    // 늦은 답이 기록되지 않았다: 그 링크를 되살리면 다시 묻는다.
    h.set({ text: C });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls().filter((url) => url === C)).toHaveLength(2);
  });

  it("counts a request it cut itself as nothing: its AbortError keeps no failure and no other old link is asked", async () => {
    const h = harness();
    h.set({ text: `${A} ${B}` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A]);
    h.set({ text: C }); // A를 끊는다.
    expect(h.asked[0]!.signal.aborted).toBe(true);
    // 진짜 `fetch`는 끊기면 그 자리에서 AbortError로 거절한다.
    await h.refuse(0, new DOMException("aborted", "AbortError"));
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toEqual([A, C]); // 옛 링크 B는 묻지 않는다.
    // 끊은 요청은 실패로도 기록되지 않는다: A를 되살리면 다시 묻는다.
    await h.answer(1, ok(C));
    h.set({ text: A });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, C, A]);
  });

  it("keeps what it learned per workspace: the same address in another workspace is asked again", async () => {
    const h = harness();
    h.set({ text: A });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.answer(0, ok(A));
    h.set({ workspaceId: "ws-2" });
    expect(h.cardUrls()).toEqual([]); // 다른 워크스페이스의 답으로는 그리지 않는다.
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A]);
    expect(h.asked[1]).toMatchObject({ workspaceId: "ws-2", channelId: CH });
    await h.answer(1, ok(A));
    // 돌아오면 처음 답이 그대로 있다(방을 옮겨도 컨트롤러는 그대로 산다).
    h.set({ workspaceId: WS, text: `${A} x` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A]);
    expect(h.cardUrls()).toEqual([A]);
  });

  it("draws from the text of this very render: a removed link's card goes at once and the answer stays remembered", async () => {
    const h = harness();
    h.set({ text: A });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.answer(0, ok(A));
    expect(h.cardUrls()).toEqual([A]);
    // 효과(`sync`) 없이 다른 글로 렌더해도 지운 링크의 카드는 없다.
    expect(
      h.controller.view({ workspaceId: WS, channelId: CH, text: "no link", paused: false, enabled: true }).cards
    ).toEqual([]);
    // 링크를 되살리면 받아 둔 답이 그대로 있어 다시 묻지 않는다.
    h.set({ text: `${A} again` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A]);
    expect(h.cardUrls()).toEqual([A]);
  });

  it("keeps an ok answer for 25 minutes and a 4xx for 2, and remembers no 5xx or dropped connection", async () => {
    const h = harness();
    h.set({ text: A });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.answer(0, ok(A));
    h.set({ text: `${A} x` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A]); // 받아 둔 답이 있어 다시 묻지 않는다.
    await h.advance(UNFURL_PREVIEW_OK_MEMORY_MS);
    h.set({ text: `${A} xy` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A]); // 기억이 끝났다: 다음 글 변경이 다시 묻는다.
    await h.answer(1, ok(A));

    // 4xx(사이트·권한): 2분 동안 기억한다. 그림 없이 카드도 없다.
    h.set({ text: B });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.refuse(2, new ApiError(404, "gone"));
    expect(h.cardUrls()).toEqual([]);
    h.set({ text: `${B} x` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A, B]);
    await h.advance(UNFURL_PREVIEW_FAILED_MEMORY_MS);
    h.set({ text: `${B} xy` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A, B, B]);
    await h.answer(3, ok(B));

    // 5xx와 끊긴 연결: 기억하지 않아서 다음 글 변경이 바로 다시 묻는다.
    h.set({ text: C });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.refuse(4, new ApiError(503, "down"));
    h.set({ text: `${C} x` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls().filter((url) => url === C)).toHaveLength(2);
    await h.refuse(5, new TypeError("network"));
    h.set({ text: `${C} xy` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls().filter((url) => url === C)).toHaveLength(3);
  });

  it("on a 429 waits Retry-After and asks once more, then gives up until the next edit; a missing or huge Retry-After invents no long wait", async () => {
    const h = harness();
    h.set({ text: A });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.refuse(0, new ApiError(429, "slow", undefined, 5));
    expect(h.cardUrls()).toEqual([]);
    await h.advance(4_999);
    expect(h.urls()).toEqual([A]);
    await h.advance(1);
    expect(h.urls()).toEqual([A, A]); // 한 번 다시.
    await h.refuse(1, new ApiError(429, "slow", undefined, 5));
    await h.advance(UNFURL_PREVIEW_RETRY_CEILING_SECONDS * 1000);
    expect(h.urls()).toEqual([A, A]); // 두 번째 429 뒤에는 글이 바뀔 때까지 그만둔다.
    h.set({ text: `${A} words` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A, A]);
    await h.answer(2, ok(A));

    // `Retry-After`가 너무 길면 서버 예산 창(60초)에서 자른다.
    h.set({ text: B });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.refuse(3, new ApiError(429, "slow", undefined, 600));
    await h.advance(UNFURL_PREVIEW_RETRY_CEILING_SECONDS * 1000 - 1);
    expect(h.urls()).toEqual([A, A, A, B]);
    await h.advance(1);
    expect(h.urls()).toEqual([A, A, A, B, B]);
    await h.answer(4, ok(B));

    // 초를 말하지 않은 429는 기다림을 지어내지 않는다: 예약도 없고, 다음 글 변경이 다시 묻는다.
    h.set({ text: C });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.refuse(5, new ApiError(429, "slow"));
    await h.advance(UNFURL_PREVIEW_RETRY_CEILING_SECONDS * 1000);
    expect(h.urls().filter((url) => url === C)).toHaveLength(1);
    h.set({ text: `${C} x` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls().filter((url) => url === C)).toHaveLength(2);

    // 429는 그 주소에서 판을 멈춘다. 글을 고치면 뒤의 주소를 묻되, 기다리는 주소는 건너뛴다.
    const g = harness();
    g.set({ text: `${A} ${B} ${C}` });
    await g.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await g.answer(0, ok(A));
    await g.refuse(1, new ApiError(429, "slow", undefined, 30));
    expect(g.urls()).toEqual([A, B]);
    g.set({ text: `${A} ${B} ${C} x` });
    await g.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(g.urls()).toEqual([A, B, C]);
  });

  it("forgets the oldest answers past 48 and keeps the newest", async () => {
    const h = harness();
    const link = (n: number) => `https://m${n}.example/page`;
    // 서로 다른 주소 51개(한 글에 3개씩 17번): 한도(48)를 3개 넘긴다.
    for (let set = 0; set < 17; set += 1) {
      h.set({ text: [0, 1, 2].map((i) => link(set * 3 + i)).join(" ") });
      await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
      for (let i = 0; i < 3; i += 1) {
        const last = h.asked.length - 1;
        await h.answer(last, ok(h.asked[last]!.url));
      }
    }
    expect(h.asked).toHaveLength(51);
    h.set({ text: link(50) }); // 가장 새것과 한도 안쪽 끝(네 번째로 오래된 것)은 남아 있다.
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    h.set({ text: link(3) });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.asked).toHaveLength(51);
    h.set({ text: link(0) }); // 가장 오래된 셋은 잊었다.
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.asked).toHaveLength(52);
    expect(h.asked[51]!.url).toBe(link(0));
  });

  it("asks nothing while paused, for a draft with an API key, or without a room — it cuts what is out and goes on when allowed", async () => {
    // 키 모양 글자는 실행할 때 조립한다(고정 문자열은 비밀 검사가 진짜 키로 읽는다).
    const key = ["s", "k-", "proj-", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4"].join("");
    const h = harness();
    h.set({ text: A, paused: true });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toEqual([]);
    h.set({ paused: false }); // 풀리면 이어서 묻는다.
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A]);

    // 이미 나간 요청도 묻지 않는 때가 되면 끊는다. 받아 둔 카드는 그대로다.
    const out = h.asked[0]!;
    h.set({ paused: true });
    expect(out.signal.aborted).toBe(true);
    h.set({ paused: false, text: `${A} ${B}` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A]); // A는 늦은 답이 기록되지 않아 다시 묻는다.
    await h.answer(1, ok(A));
    await h.answer(2, ok(B));

    // 키 모양이 든 글: 어떤 링크도 서버로 가지 않는다. 키를 지우면 평소처럼 묻는다.
    h.set({ text: `${C} ${key}` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toEqual([A, A, B]);
    h.set({ text: C });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A, A, B, C]);
    await h.answer(3, ok(C));

    // 보낼 방을 모른다: 물을 곳이 없다.
    h.set({ workspaceId: undefined, text: `${C} again` });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toHaveLength(4);
    h.set({ workspaceId: WS, channelId: undefined });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toHaveLength(4);
  });

  it("turns ✕ off for this link set only: words keep it; links, room or thread bring the card back for good", async () => {
    const h = harness();
    h.set({ text: A, threadRootId: "root-1" });
    // 카드가 없으면 ✕는 아무 일도 하지 않는다.
    h.view().dismiss();
    expect(h.view().suppressed).toBe(false);
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.answer(0, ok(A));

    h.view().dismiss();
    expect(h.view()).toMatchObject({ suppressed: true, cards: [] });
    h.set({ text: `${A} some words` });
    expect(h.view().suppressed).toBe(true); // 글만 고치면 그대로다.

    h.set({ text: `${A} ${B}` }); // 링크가 늘었다: 다시 뜬다.
    expect(h.view().suppressed).toBe(false);
    expect(h.cardUrls()).toEqual([A]);
    // 푼 ✕는 잊었다: 예전 구성으로 돌아와도 되살아나지 않는다.
    h.set({ text: `${A} some words` });
    expect(h.view().suppressed).toBe(false);

    h.view().dismiss();
    expect(h.view().suppressed).toBe(true);
    h.set({ threadRootId: "root-2" }); // 같은 방의 다른 스레드로는 따라가지 않는다.
    expect(h.view().suppressed).toBe(false);
    h.view().dismiss();
    h.set({ channelId: "ch-2" });
    expect(h.view().suppressed).toBe(false);

    // 이 기기가 「끄기」이면 링크도 카드도 ✕도 없다.
    h.set({ enabled: false });
    expect(h.view()).toMatchObject({ suppressed: false, cards: [] });
    h.view().dismiss();
    expect(h.view().suppressed).toBe(false);
    const before = h.urls().length;
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toHaveLength(before);
  });

  it("tells the host only when an answer or ✕ changes: the snapshot stays the same otherwise", async () => {
    const h = harness();
    const listener = vi.fn();
    const unsubscribe = h.controller.subscribe(listener);
    const first = h.controller.getSnapshot();

    h.set({ text: A });
    h.set({ text: A }); // 같은 입력을 또 줘도 같다.
    expect(h.controller.getSnapshot()).toBe(first);
    expect(listener).not.toHaveBeenCalled();

    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.answer(0, ok(A));
    expect(listener).toHaveBeenCalledTimes(1);
    const answered = h.controller.getSnapshot();
    expect(answered).not.toBe(first);

    h.view().dismiss();
    expect(listener).toHaveBeenCalledTimes(2);
    h.view().dismiss(); // 이미 꺼진 같은 구성: 바뀐 것이 없다.
    expect(listener).toHaveBeenCalledTimes(2);
    expect(h.controller.getSnapshot()).not.toBe(answered);

    unsubscribe();
    h.set({ text: B });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    await h.answer(1, ok(B));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("dispose cuts the request and the wait; the next sync picks the work up again (mount, cleanup, mount)", async () => {
    const h = harness();
    h.set({ text: A });
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS - 100);
    h.controller.dispose();
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS * 2);
    expect(h.urls()).toEqual([]); // 기다리던 것이 사라졌다.

    // 같은 입력으로 다시 맞추면 이어서 한다.
    h.set({});
    await h.advance(UNFURL_PREVIEW_DEBOUNCE_MS);
    expect(h.urls()).toEqual([A]);
    const out = h.asked[0]!;
    h.controller.dispose();
    expect(out.signal.aborted).toBe(true);
    await h.answer(0, ok(A)); // 끊은 요청의 늦은 답은 기록되지 않는다.
    expect(h.cardUrls()).toEqual([]);
  });
});
