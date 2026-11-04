// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "@momo/core/lib/api";
import { NetworkError } from "@momo/core/lib/http";
import { CONNECTION_KEYS } from "@momo/core/features/connection/copyKeys";
import type { ConnectionCause } from "@momo/core/features/connection/model";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { koreanLocale } from "@/testing/koLocale";
import { LoadFailureNote } from "./LoadFailureBox";
import { loadCauseOf } from "./loadFailure";

// =============================================================================
// #5242: 남은 「불러오지 못했습니다」 자리들이 함께 쓰는 부품.
//   - `loadCauseOf`: 이 자리의 오류 객체 하나 + 지금 기기가 아는 온라인 여부 → 연결 원인(S-C `causeOfFailure`와 같은 규칙).
//   - `LoadFailureNote`: 상자가 맞지 않는 좁은 자리의 한 줄. 제목 + 이유 한 벌, 다시 시도는 있을 때만.
// 자리마다의 배선(어느 오류 객체를 넘기는가)은 자리 시험이 잰다. 여기는 부품만.
// =============================================================================

const reactActEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
let mountedRoot: Root | null = null;
let host: HTMLElement | null = null;
let ko: AppLocale;

beforeAll(async () => {
  ko = await koreanLocale();
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});
afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

function deviceOnline(value: boolean): void {
  vi.spyOn(globalThis.navigator, "onLine", "get").mockReturnValue(value);
}

function mount(node: ReturnType<typeof createElement>, korean: boolean): HTMLElement {
  host = document.createElement("div");
  document.body.append(host);
  mountedRoot = createRoot(host);
  act(() => mountedRoot?.render(korean ? createElement(LocaleProvider, { locale: ko, children: node }) : node));
  return host;
}

describe("loadCauseOf", () => {
  it("응답이 없으면 기기가 꺼져 있을 때 오프라인, 켜져 있으면 서버에 닿지 못함", () => {
    const failure = new NetworkError("unreachable", 15_000);
    deviceOnline(false);
    expect(loadCauseOf(failure)).toBe("deviceOffline");
    deviceOnline(true);
    expect(loadCauseOf(failure)).toBe("serverUnreachable");
  });

  it("길 위의 장비가 낸 응답(502·504, 코드 없는 503)은 서버에 닿지 못함, 서버가 직접 답한 것은 원인 없음", () => {
    deviceOnline(true);
    expect(loadCauseOf(new ApiError(502, "bad gateway"))).toBe("serverUnreachable");
    expect(loadCauseOf(new ApiError(504, "timeout"))).toBe("serverUnreachable");
    expect(loadCauseOf(new ApiError(503, "unavailable"))).toBe("serverUnreachable");
    expect(loadCauseOf(new ApiError(503, "unavailable", "host_down"))).toBeNull();
    expect(loadCauseOf(new ApiError(500, "boom", "internal"))).toBeNull();
    expect(loadCauseOf(new ApiError(404, "gone"))).toBeNull();
  });

  it("연결 쪽이 아닌 오류 객체는 기기가 꺼져 있어도 원인이 없다(이유는 「문제가 생겼어요」)", () => {
    deviceOnline(false);
    expect(loadCauseOf(new Error("x"))).toBeNull();
    expect(loadCauseOf(new ApiError(500, "boom", "internal"))).toBeNull();
  });

  it("오류 객체를 모르는 자리는 기기가 아는 사실 하나만 안다: 꺼져 있으면 오프라인, 아니면 원인 없음", () => {
    deviceOnline(false);
    expect(loadCauseOf(null)).toBe("deviceOffline");
    expect(loadCauseOf(undefined)).toBe("deviceOffline");
    deviceOnline(true);
    expect(loadCauseOf(null)).toBeNull();
    expect(loadCauseOf(undefined)).toBeNull();
  });
});

describe("LoadFailureNote", () => {
  const reasons: [ConnectionCause | null, string][] = [
    ["deviceOffline", "오프라인이에요. 연결되면 다시 불러올 수 있어요."],
    ["serverUnreachable", "서버에 닿지 못했어요. 잠시 뒤 다시 시도해 주세요."],
    [null, "문제가 생겼어요. 다시 시도해 주세요."],
  ];

  it("제목 + 이유 한 벌을 한 줄로 말하고, 원인마다 이유가 다르다. 상태 코드는 없다", () => {
    for (const [cause, reason] of reasons) {
      const root = mount(
        createElement(LoadFailureNote, {
          titleKey: CONNECTION_KEYS.loadInboxTitle,
          cause,
          onRetry: () => undefined,
          testId: "note",
        }),
        true
      );
      const note = root.querySelector<HTMLElement>('[data-testid="note"]');
      expect(note?.getAttribute("role")).toBe("alert");
      expect(note?.textContent).toContain(`인박스를 불러오지 못했어요. ${reason}`);
      expect(note?.textContent).not.toMatch(/\d{3}/);
      act(() => mountedRoot?.unmount());
      host?.remove();
      mountedRoot = null;
      host = null;
    }
  });

  it("다시 시도는 onRetry가 있을 때만 서고, 누르면 부른다", () => {
    const onRetry = vi.fn();
    const withRetry = mount(
      createElement(LoadFailureNote, {
        titleKey: CONNECTION_KEYS.loadActivityTitle,
        cause: null,
        onRetry,
        testId: "note",
      }),
      true
    );
    const button = withRetry.querySelector("button");
    expect(button?.textContent).toBe("다시 시도");
    act(() => button?.click());
    expect(onRetry).toHaveBeenCalledTimes(1);
    act(() => mountedRoot?.unmount());
    host?.remove();

    const without = mount(
      createElement(LoadFailureNote, {
        titleKey: CONNECTION_KEYS.loadActivityTitle,
        cause: null,
        testId: "note",
      }),
      true
    );
    expect(without.querySelector("button")).toBeNull();
    expect(without.querySelector('[data-testid="note"]')?.textContent).toContain("활동을 불러오지 못했어요");
  });

  it("카드 안의 자리는 여백·구분선을 부른 쪽이 정한다", () => {
    const root = mount(
      createElement(LoadFailureNote, {
        titleKey: CONNECTION_KEYS.loadHermesStatusTitle,
        cause: "serverUnreachable",
        separator: false,
        className: "px-0",
        testId: "note",
      }),
      true
    );
    const note = root.querySelector<HTMLElement>('[data-testid="note"]');
    expect(note?.className).toContain("px-0");
    expect(note?.className).not.toContain("border-b");
  });

  it("공급자 밖에서는 번들된 영어로 물러나고, 한글이 한 글자도 없다", () => {
    const root = mount(
      createElement(LoadFailureNote, {
        titleKey: CONNECTION_KEYS.loadMemberProfileTitle,
        cause: "deviceOffline",
        onRetry: () => undefined,
        testId: "note",
      }),
      false
    );
    const text = root.querySelector('[data-testid="note"]')?.textContent ?? "";
    expect(text).toContain("Couldn't load the member profile. You're offline. You can try again once you're connected.");
    expect(text).not.toMatch(/[가-힣]/);
  });
});
