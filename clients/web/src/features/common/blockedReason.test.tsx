// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { ConnectionContext } from "@/features/common/connectionContext";
import { LocaleProvider } from "@/i18n/LocaleProvider";
import type { AppLocale } from "@/i18n/localeStore";
import { connectionScene, type ConnectionScene } from "@/testing/connectionViews";
import { koreanLocale } from "@/testing/koLocale";
import { BlockedReason, useBlockedReason, type BlockedFrame } from "./BlockedReason";

// =============================================================================
// #5260: 막힌 자리의 한 문장(`BlockedReason`·`useBlockedReason`)이 연결 상태 모델의 **원인**에 맞는 문장을 고른다.
// 원인은 손으로 짓지 않고 코어 모델에 사건을 넣어 만든 모습(`connectionScene`)이다.
//
//   기기 오프라인       막음 → 「오프라인이라 …」
//   서버에 닿지 못함    막음 → 「서버에 닿지 못해 …」 (오프라인이라고 말하지 않는다)
//   로그인 만료         막음 → 원인을 지어내지 않고 만료 문장
//   알 수 없음          막지 않음(모르면 막지 않는다)
//   실시간만 끊김       막지 않음 (#5201 결정 ③: 전송은 REST고 소켓은 수신용이다)
//   정상                막지 않음
//
// 막지 않는 원인에서는 호출부(`offline`이 거짓)가 이 문장을 그리지 않는다. 그 연결(모델이 막지 않는다 = `canSend`)을 함께
// 잰다. 문장은 손으로 적는다(사전의 값을 되풀이하면 코드와 시험이 함께 틀려도 초록이다).
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

function Text({ frame }: { frame: BlockedFrame }) {
  return createElement("p", { "data-testid": "hook" }, useBlockedReason(frame));
}
function Component({ frame }: { frame: BlockedFrame }) {
  return createElement("p", { "data-testid": "component" }, createElement(BlockedReason, { frame }));
}

/** `scene`이 `null`이면 연결 모델 공급자가 없는 자리(셸 밖·단위 시험). `locale`이 `null`이면 번들된 영어. */
function mount(scene: ConnectionScene | null, locale: AppLocale | null, frame: BlockedFrame): HTMLElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  mountedRoot = createRoot(host);
  const inner = createElement("div", null, createElement(Text, { frame }), createElement(Component, { frame }));
  const withScene =
    scene === null ? inner : createElement(ConnectionContext.Provider, { value: connectionScene(scene) }, inner);
  act(() => {
    mountedRoot?.render(locale === null ? withScene : createElement(LocaleProvider, { locale, children: withScene }));
  });
  return host;
}

function both(root: HTMLElement): [string, string] {
  return [
    root.querySelector('[data-testid="hook"]')?.textContent ?? "",
    root.querySelector('[data-testid="component"]')?.textContent ?? "",
  ];
}

const BLOCKS: Record<ConnectionScene, boolean> = {
  ok: false,
  deviceOffline: true,
  serverUnreachable: true,
  expired: true,
  unknown: false,
  realtimeDown: false,
};

describe("모델의 게이트: 어떤 원인이 막나(문장이 서는 원인)", () => {
  it.each(Object.entries(BLOCKS) as Array<[ConnectionScene, boolean]>)("%s → 막음=%s", (scene, blocks) => {
    expect(!connectionScene(scene).view.canSend).toBe(blocks);
  });
});

describe("원인에 맞는 문장 (ko)", () => {
  it("기기 오프라인 → 오프라인이라 …, 글(컴포넌트)과 문자열(훅)이 같다", () => {
    const [hook, component] = both(mount("deviceOffline", ko, "changeIt"));
    expect(hook).toBe("오프라인이라 지금은 바꿀 수 없어요.");
    expect(component).toBe(hook);
  });

  it("서버에 닿지 못함 → 서버에 닿지 못해 …, 「오프라인」이라 하지 않는다", () => {
    const [hook, component] = both(mount("serverUnreachable", ko, "changeIt"));
    expect(hook).toBe("서버에 닿지 못해 지금은 바꿀 수 없어요.");
    expect(component).toBe(hook);
    expect(hook).not.toContain("오프라인");
  });

  it("로그인 만료 → 원인을 지어내지 않고 만료 문장", () => {
    const [hook, component] = both(mount("expired", ko, "changeIt"));
    expect(hook).toBe("로그인이 만료됐어요. 다시 로그인해 주세요.");
    expect(component).toBe(hook);
  });

  it("틀마다 자기 문장이다: 같은 원인에서 다른 틀은 다른 말을 한다", () => {
    expect(both(mount("serverUnreachable", ko, "createInviteLink"))[0]).toBe(
      "서버에 닿지 못해 지금은 초대 링크를 만들 수 없어요. 다시 연결되면 이어서 만들 수 있어요."
    );
    act(() => mountedRoot?.unmount());
    host?.remove();
    expect(both(mount("deviceOffline", ko, "keepViewChangeLater"))[0]).toBe(
      "오프라인이에요. 마지막으로 받은 내용은 계속 볼 수 있고, 변경은 다시 연결된 뒤에 할 수 있어요."
    );
  });

  it("공급자가 없는 자리(셸 밖·단위 시험)에서 막혔다고 한 호출은 기기 오프라인 문장이다", () => {
    expect(both(mount(null, ko, "changeIt"))[0]).toBe("오프라인이라 지금은 바꿀 수 없어요.");
  });
});

describe("원인에 맞는 문장 (en, 번들된 영어)", () => {
  it("기기 오프라인과 서버에 닿지 못함이 서로 다른 말을 한다", () => {
    expect(both(mount("deviceOffline", null, "changeIt"))[0]).toBe("You're offline, so you can't change this right now.");
    act(() => mountedRoot?.unmount());
    host?.remove();
    const server = both(mount("serverUnreachable", null, "changeIt"))[0];
    expect(server).toBe("We can't reach the server, so you can't change this right now.");
    expect(server).not.toMatch(/offline/i);
  });
});
