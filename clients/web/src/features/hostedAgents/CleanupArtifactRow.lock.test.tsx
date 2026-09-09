// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupExpectedAction, type HostedCleanupArtifact } from "@momo/core/features/hostedAgents/cleanup";
import { CleanupArtifactRow } from "./CleanupArtifactRow";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

let mountedRoot: Root | null = null;
let mountedHost: HTMLElement | null = null;

const artifact: HostedCleanupArtifact = {
  id: "019f9a01-0000-7000-8000-0000000000a1",
  kind: "routine",
  expectedAction: cleanupExpectedAction("routine"),
  currentStatus: "unknown",
  disposition: "pending",
  resolved: false,
  required: true,
  updatedAtMs: 1_700_000_000_000,
};

function mount(): HTMLElement {
  const host = document.createElement("div");
  document.body.append(host);
  mountedHost = host;
  mountedRoot = createRoot(host);
  act(() => {
    mountedRoot?.render(
      createElement("ul", null,
        createElement(CleanupArtifactRow, {
          artifact,
          open: true,
          onOpenChange: () => undefined,
          actorName: "곽성재",
          failure: null,
          onDismissFailure: () => undefined,
          disabled: true,
          saving: false,
          onAcknowledge: () => undefined,
        })
      )
    );
  });
  return host;
}

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

describe("CleanupArtifactRow ChoiceList 잠금", () => {
  it("잠긴 정리 목록은 native fieldset disabled 다", () => {
    const host = mount();
    const fieldset = host.querySelector('[data-testid="cleanup-status"]');
    expect(fieldset).toBeInstanceOf(HTMLFieldSetElement);
    expect((fieldset as HTMLFieldSetElement).disabled).toBe(true);
    expect(fieldset?.hasAttribute("aria-disabled")).toBe(false);
  });
});
