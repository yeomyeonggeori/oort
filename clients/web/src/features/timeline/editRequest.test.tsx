// @vitest-environment jsdom

import { act, createElement, useContext, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDIT_REQUEST_TTL_MS,
  EditRequestContext,
  useEditRequestChannel,
  type EditRequestChannel,
} from "./editRequest";

// =============================================================================
// 밖(입력칸의 ↑ 키)에서 행에게 「이 메시지를 고쳐 줘」라고 부르는 요청 채널 (#5191).
//
// 요청 하나가 서고, 받은 행이 비우고, 끝내 받는 행이 없으면(가상 목록이 그 행을 마운트하지 않았다) 스스로 사라진다 — 사라지지
// 않으면 한참 뒤 사용자가 그 줄로 스크롤해 지나갈 때 편집기가 불쑥 열린다.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  if (mountedRoot) act(() => mountedRoot?.unmount());
  mountedRoot = null;
  host?.remove();
  host = null;
  vi.useRealTimers();
});

interface Harness {
  requestEdit: (messageId: string) => number;
  seen: () => EditRequestChannel | null;
  finished: ReturnType<typeof vi.fn>;
}

/** 채널을 만들고, Provider 아래의 한 소비자가 지금 요청을 읽는다. */
function mountChannel(): Harness {
  const finished = vi.fn();
  let requestEdit: Harness["requestEdit"] = () => 0;
  let latest: EditRequestChannel | null = null;

  function Consumer(): ReactElement | null {
    latest = useContext(EditRequestContext);
    return null;
  }
  function Owner(): ReactElement {
    const { channel, requestEdit: request } = useEditRequestChannel(finished);
    requestEdit = request;
    return createElement(EditRequestContext.Provider, { value: channel }, createElement(Consumer));
  }

  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(createElement(Owner));
  });
  return { requestEdit: (id) => requestEdit(id), seen: () => latest, finished };
}

describe("편집 요청 채널", () => {
  it("요청을 내면 소비자가 그 메시지 id 와 새 nonce 를 본다", () => {
    const h = mountChannel();
    expect(h.seen()?.request).toBeNull();
    let nonce = 0;
    act(() => {
      nonce = h.requestEdit("msg-1");
    });
    expect(h.seen()?.request).toEqual({ messageId: "msg-1", nonce });
  });

  it("같은 메시지를 다시 불러도 nonce 가 달라 다시 열린다", () => {
    const h = mountChannel();
    let first = 0;
    let second = 0;
    act(() => {
      first = h.requestEdit("msg-1");
    });
    act(() => {
      h.seen()?.consume(first);
    });
    act(() => {
      second = h.requestEdit("msg-1");
    });
    expect(second).toBeGreaterThan(first);
    expect(h.seen()?.request?.nonce).toBe(second);
  });

  it("받은 행이 consume 하면 요청이 비워진다", () => {
    const h = mountChannel();
    let nonce = 0;
    act(() => {
      nonce = h.requestEdit("msg-1");
    });
    act(() => {
      h.seen()?.consume(nonce);
    });
    expect(h.seen()?.request).toBeNull();
  });

  it("옛 nonce 의 consume 은 새 요청을 지우지 못한다", () => {
    const h = mountChannel();
    let first = 0;
    act(() => {
      first = h.requestEdit("msg-1");
    });
    act(() => {
      h.requestEdit("msg-2");
    });
    act(() => {
      h.seen()?.consume(first);
    });
    expect(h.seen()?.request?.messageId).toBe("msg-2");
  });

  it("끝내 받는 행이 없으면 TTL 뒤 스스로 사라진다(한참 뒤 스크롤에 편집기가 불쑥 열리지 않게)", () => {
    const h = mountChannel();
    act(() => {
      h.requestEdit("msg-far-above");
    });
    act(() => {
      vi.advanceTimersByTime(EDIT_REQUEST_TTL_MS - 1);
    });
    expect(h.seen()?.request?.messageId).toBe("msg-far-above");
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(h.seen()?.request).toBeNull();
  });

  it("새 요청은 앞 요청의 TTL 에 지워지지도, 앞 요청 때문에 자기 TTL 을 잃지도 않는다", () => {
    const h = mountChannel();
    act(() => {
      h.requestEdit("msg-1"); // t=0, 만료 t=TTL
    });
    act(() => {
      vi.advanceTimersByTime(EDIT_REQUEST_TTL_MS - 500);
    });
    act(() => {
      h.requestEdit("msg-2"); // t=TTL-500, 만료 t=2·TTL-500
    });
    // 앞 요청의 만료 시각(t=TTL)을 지난다: 앞 타이머가 살아 있다면 여기서 울리지만 새 요청은 남아야 한다.
    act(() => {
      vi.advanceTimersByTime(600);
    });
    expect(h.seen()?.request?.messageId).toBe("msg-2");
    // 그리고 새 요청은 **자기** 만료 시각에 사라진다(앞 타이머의 울림이 새 타이머를 지웠다면 영영 남는다).
    act(() => {
      vi.advanceTimersByTime(EDIT_REQUEST_TTL_MS);
    });
    expect(h.seen()?.request).toBeNull();
  });

  it("새 요청은 앞 요청의 타이머를 갈아 끼운다: 요청을 거듭해도 살아 있는 타이머가 늘지 않는다(언마운트 뒤 울릴 타이머가 남지 않는다)", () => {
    const h = mountChannel();
    act(() => {
      h.requestEdit("msg-1");
    });
    const afterFirst = vi.getTimerCount();
    act(() => {
      h.requestEdit("msg-2");
    });
    act(() => {
      h.requestEdit("msg-3");
    });
    expect(vi.getTimerCount()).toBe(afterFirst);
  });

  it("낡은 nonce 의 consume 은 살아 있는 요청의 TTL 타이머를 치우지 못한다", () => {
    const h = mountChannel();
    let first = 0;
    act(() => {
      first = h.requestEdit("msg-1");
    });
    act(() => {
      h.requestEdit("msg-2");
    });
    // 갈린 요청을 행이 뒤늦게 비운다: 새 요청은 그대로 서 있고(위 시험), 새 요청의 만료도 그대로여야 한다.
    act(() => {
      h.seen()?.consume(first);
    });
    expect(h.seen()?.request?.messageId).toBe("msg-2");
    act(() => {
      vi.advanceTimersByTime(EDIT_REQUEST_TTL_MS + 1);
    });
    expect(h.seen()?.request).toBeNull();
  });

  it("행이 끝났다고 알리면 요청한 쪽의 콜백이 그 nonce 로 한 번 불린다(초점 복귀)", () => {
    const h = mountChannel();
    let nonce = 0;
    act(() => {
      nonce = h.requestEdit("msg-1");
    });
    act(() => {
      h.seen()?.finished(nonce);
    });
    expect(h.finished).toHaveBeenCalledTimes(1);
    expect(h.finished).toHaveBeenCalledWith(nonce);
  });
});
