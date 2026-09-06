// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SessionProvider, type SessionContextValue } from "@/app/session";
import {
  ApprovalActions,
  type Armed,
} from "@/features/timeline/ApprovalActions";

const CLOCK_SRC = readFileSync(
  join(process.cwd(), "scripts/capture-clock.mjs"),
  "utf8"
);
const APPROVAL_SRC = readFileSync(
  join(process.cwd(), "src/features/timeline/ApprovalActions.tsx"),
  "utf8"
);

type ClockMod = {
  beginCaptureScene: (name: string) => "fixed" | "flowing";
  setActiveCaptureScene: (name: string) => void;
  wrapPageTimeGateClicks: (page: Record<string, unknown>) => Promise<unknown>;
  sceneDispatchMouseEvent: (
    page: unknown,
    locator: unknown,
    type: string,
    init?: unknown
  ) => Promise<unknown>;
};

function loadClock(): ClockMod {
  const rewritten = CLOCK_SRC.replace(/import [^\n]+\n/g, "")
    .replace(/const APPROVAL_PATH = [\s\S]*?;\n\n/, "")
    .replace(
      /export const TIME_GATED_CONTROLS = parseTimeGatedControls\(\s*readFileSync\(APPROVAL_PATH, "utf8"\)\s*\);/,
      `const TIME_GATED_CONTROLS = parseTimeGatedControls(${JSON.stringify(APPROVAL_SRC)});`
    )
    .replaceAll("export const", "const")
    .replaceAll("export async function", "async function")
    .replaceAll("export function", "function");
  return new Function(
    `${rewritten}
return {
  beginCaptureScene,
  setActiveCaptureScene,
  wrapPageTimeGateClicks,
  sceneDispatchMouseEvent,
};`
  )() as ClockMod;
}

const {
  beginCaptureScene,
  setActiveCaptureScene,
  wrapPageTimeGateClicks,
  sceneDispatchMouseEvent,
} = loadClock();

const COMMIT_ABORT =
  /CAPTURE ABORT: scene "approvals-confirm" is clock:fixed; time-gated control \[inbox-approval-commit\] cannot open CONFIRM_GUARD_MS/;

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
let mountedRoot: Root | null = null;
let mountHost: HTMLElement | null = null;

beforeAll(() => {
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  if (mountedRoot) {
    act(() => mountedRoot?.unmount());
    mountedRoot = null;
  }
  mountHost?.remove();
  mountHost = null;
  setActiveCaptureScene("default");
});

function sessionValue(): SessionContextValue {
  return {
    session: {
      accessToken: "access",
      refreshToken: "refresh",
      member: {
        id: "00000000-0000-7000-8000-0000000001ff",
        workspaceId: "00000000-0000-7000-8000-000000000001",
        kind: "human",
        displayName: "곽성재",
        handle: "seongjae",
      },
      realtimeWebSocketUrl: "wss://example.test/connection/websocket",
    },
    workspaceId: "00000000-0000-7000-8000-000000000001",
    realtime: null,
    connStatus: "connected",
    logout: () => undefined,
    replaceSessionMember: () => undefined,
  };
}

function ApprovalHarness(): ReactElement {
  const [armed, setArmed] = useState<Armed>(null);
  return createElement(
    SessionProvider,
    { value: sessionValue() },
    createElement(ApprovalActions, {
      approvalId: "approval-1",
      armed,
      setArmed,
      onSettled: () => undefined,
      testIdPrefix: "inbox-approval",
    })
  );
}

function mountApproval(): HTMLElement {
  mountHost = document.createElement("div");
  document.body.append(mountHost);
  mountedRoot = createRoot(mountHost);
  act(() => {
    mountedRoot?.render(createElement(ApprovalHarness));
  });
  return mountHost;
}

describe("capture clock resolver against rendered ApprovalActions", () => {
  it("raw keyboard Enter on a focused armed commit aborts in a fixed scene", async () => {
    beginCaptureScene("approvals-confirm");
    const host = mountApproval();
    const approve = host.querySelector(
      '[data-testid="inbox-approval-approve"]'
    ) as HTMLButtonElement | null;
    expect(approve).not.toBeNull();
    act(() => {
      approve?.click();
    });
    const commit = host.querySelector(
      '[data-testid="inbox-approval-commit"]'
    ) as HTMLButtonElement | null;
    expect(commit).not.toBeNull();
    expect(document.activeElement).toBe(commit);

    const presses: string[] = [];
    const page = {
      evaluate: async (fn: () => string) => fn(),
      keyboard: {
        press: async (key: string) => {
          presses.push(key);
        },
      },
      getByTestId: () => ({ click: async () => undefined }),
      locator: () => ({ click: async () => undefined }),
      getByRole: () => ({ click: async () => undefined }),
      getByText: () => ({ click: async () => undefined }),
      getByLabel: () => ({ click: async () => undefined }),
    };
    await wrapPageTimeGateClicks(page);
    await expect(
      (page.keyboard.press as (key: string) => Promise<unknown>)("Enter")
    ).rejects.toThrow(COMMIT_ABORT);
    expect(presses).toEqual([]);
  });

  it("sceneDispatchMouseEvent reads the target's test id from the element", async () => {
    beginCaptureScene("approvals-confirm");
    const target = document.createElement("button");
    target.setAttribute("data-testid", "inbox-approval-commit");
    const locator = {
      evaluate: async (
        fn: (el: Element, arg?: unknown) => unknown,
        arg?: unknown
      ) => fn(target, arg),
    };
    const page = {
      evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) =>
        fn(arg),
    };
    await expect(
      sceneDispatchMouseEvent(page, locator, "click", { bubbles: true })
    ).rejects.toThrow(COMMIT_ABORT);
  });
});
