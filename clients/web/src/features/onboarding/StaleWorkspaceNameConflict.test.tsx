// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { directionParticle } from "@momo/core/lib/koreanParticle";
import {
  StaleWorkspaceNameConflict,
  WORD_JOINER,
} from "./StaleWorkspaceNameConflict";

const LONG_NAME =
  "여명거리 스튜디오 Dawn Street Studio 서울 본사 디자인 엔지니어링 팀 2026 상반기";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountedHost?.remove();
  mountedHost = null;
});

function visibleText(node: ParentNode | null): string {
  return (node?.textContent ?? "").replaceAll(WORD_JOINER, "");
}

function mountPhrase(otherName: string) {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement(
        "div",
        { className: "w-full max-w-sm", "data-testid": "stale-card" },
        createElement(StaleWorkspaceNameConflict, {
          otherName,
          onKeepTheirs: vi.fn(),
          onKeepMine: vi.fn(),
          messageId: "stale-message",
          testIdPrefix: "onboarding-s1",
        })
      )
    );
  });
  return host;
}

describe("StaleWorkspaceNamePhrase wrap and particle (B-R3-1, M-R3-5)", () => {
  it("nowrap glue is only 」+particle, not the name", () => {
    const host = mountPhrase("다른 기기에서 바꾼 이름");
    const glue = host.querySelector('[data-testid="stale-name-particle"]');
    expect(glue?.className).toContain("whitespace-nowrap");
    expect(glue?.textContent).toBe("」으로");
    expect(glue?.textContent).not.toContain("다른 기기에서 바꾼 이름");
    expect(visibleText(host)).toContain(
      "워크스페이스 이름이 「다른 기기에서 바꾼 이름」으로 바뀌었습니다."
    );
    const bannerNowraps = [
      ...(host.querySelector('[data-testid="onboarding-s1-stale"]')?.querySelectorAll(
        ".whitespace-nowrap"
      ) ?? []),
    ];
    expect(bannerNowraps.length).toBeGreaterThan(0);
    for (const el of bannerNowraps) {
      expect(el.textContent).not.toContain("다른 기기에서 바꾼 이름");
      expect(el.textContent).toMatch(/^」/);
    }
  });

  it("a 55-char name is not trapped in nowrap and the particle stays 로", () => {
    expect([...LONG_NAME].length).toBe(55);
    const host = mountPhrase(LONG_NAME);
    const glue = host.querySelector('[data-testid="stale-name-particle"]');
    expect(glue?.textContent).toBe(`」${directionParticle(LONG_NAME)}`);
    expect(glue?.textContent).toBe("」로");
    expect(glue?.textContent).not.toContain(LONG_NAME);
    expect(visibleText(host.querySelector('[data-testid="onboarding-s1-stale"]'))).toContain(
      LONG_NAME
    );
    const bannerNowraps = [
      ...(host.querySelector('[data-testid="onboarding-s1-stale"]')?.querySelectorAll(
        ".whitespace-nowrap"
      ) ?? []),
    ];
    expect(bannerNowraps.length).toBeGreaterThan(0);
    for (const el of bannerNowraps) {
      expect(el.textContent).not.toContain("여명거리 스튜디오");
      expect(el.textContent).toMatch(/^」/);
    }
  });

  it("rendered particle follows directionParticle for a vowel-final name", () => {
    const host = mountPhrase("여명거리 스튜디오");
    expect(host.querySelector('[data-testid="stale-name-particle"]')?.textContent).toBe("」로");
    expect(visibleText(host)).toContain("「여명거리 스튜디오」로 바뀌었습니다.");
    expect(visibleText(host)).not.toContain("」으로");
  });
});
