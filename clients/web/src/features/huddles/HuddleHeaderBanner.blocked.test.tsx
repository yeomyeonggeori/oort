// @vitest-environment jsdom

import { act, createElement, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectionContext } from "@/features/common/connectionContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { connectionScene, type ConnectionScene } from "@/testing/connectionViews";
import { koreanLocale } from "@/testing/koLocale";
import { HuddleHeaderBanner } from "./HuddleHeaderControl";
import type { HuddleController } from "./useHuddle";

// =============================================================================
// #5260: 허들 띠는 **막은 원인**을 말한다. 진짜 `HuddleHeaderBanner`를 코어 모델이 돌린 모습(`connectionScene`) 위에
// 그리고, 부모(`ChatShell`)가 하는 대로 막았는지는 모델의 게이트(`canSend`)에서 읽는다.
//
//   기기 오프라인       「오프라인이라 …」
//   서버에 닿지 못함    「서버에 닿지 못해 …」 — 오프라인이라고 말하지 않는다(이 칸이 고친 거짓말)
//   알 수 없음          모델이 막지 않는다(모르면 막지 않는다): 띠 없음
//   실시간만 끊김       띠 없음 (#5201 결정 ③)
//
// 문장은 손으로 적는다(사전의 값을 되풀이하면 코드와 시험이 함께 틀려도 초록이다).
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
  act(() => mountedRoot?.unmount());
  host?.remove();
  mountedRoot = null;
  host = null;
});

/** 부모가 하는 일: 모델의 게이트가 막았을 때만 띠에 `offline`을 준다. */
function Parent({ joined }: { joined: boolean }) {
  const offline = !(useContext(ConnectionContext)?.view.canSend ?? true);
  const huddle = { notice: null, joined } as unknown as HuddleController;
  return createElement(HuddleHeaderBanner, { huddle, offline });
}

function mount(scene: ConnectionScene, joined: boolean): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(LocaleProvider, {
        locale: ko,
        children: createElement(ConnectionContext.Provider, {
          value: connectionScene(scene),
          children: createElement(Parent, { joined }),
        }),
      })
    );
  });
  return host;
}

const line = (root: HTMLElement, testId: string) => root.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;

describe("허들 띠: 허들에 들어가기 전", () => {
  it("기기 오프라인: 오프라인이라 쓸 수 없다고 말한다", () => {
    expect(line(mount("deviceOffline", false), "huddle-offline")).toBe("오프라인이라 지금은 허들을 사용할 수 없어요.");
  });

  it("서버에 닿지 못함: 서버에 닿지 못해서라고 말하고 오프라인이라고 하지 않는다", () => {
    const text = line(mount("serverUnreachable", false), "huddle-offline");
    expect(text).toBe("서버에 닿지 못해 지금은 허들을 사용할 수 없어요.");
    expect(text).not.toContain("오프라인");
  });

  it.each(["unknown", "realtimeDown", "ok"] as const)("%s: 모델이 막지 않으므로 띠가 서지 않는다", (scene) => {
    const root = mount(scene, false);
    expect(root.querySelector('[data-testid="huddle-offline"]')).toBeNull();
    expect(root.textContent).toBe("");
  });
});

describe("허들 띠: 허들에 들어간 뒤", () => {
  it("기기 오프라인: 오프라인이라 메시지를 주고받지 못하지만 나가기는 된다고 말한다", () => {
    expect(line(mount("deviceOffline", true), "huddle-joined-offline")).toBe(
      "오프라인이에요. 메시지를 주고받을 수 없지만, 오디오는 계속될 수 있고 허들 나가기는 사용할 수 있어요."
    );
  });

  it("서버에 닿지 못함: 서버에 닿지 못했다고 말한다", () => {
    const text = line(mount("serverUnreachable", true), "huddle-joined-offline");
    expect(text).toBe("서버에 닿지 못했어요. 메시지를 주고받을 수 없지만, 오디오는 계속될 수 있고 허들 나가기는 사용할 수 있어요.");
    expect(text).not.toContain("오프라인");
  });

  it.each(["unknown", "realtimeDown"] as const)("%s: 띠가 서지 않는다", (scene) => {
    expect(mount(scene, true).querySelector('[data-testid="huddle-joined-offline"]')).toBeNull();
  });
});
