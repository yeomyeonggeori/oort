#!/usr/bin/env node
// GATE: #1289 workspace-wide Work Console.
//
// Fixture-only, no backend or credentials. It locks the product contract rather
// than a screenshot: `/work` is a global route, T1/T2/T3 come only from the
// referenced host.type, state and location remain separate text chips, the
// selected session survives in `?session=`, and the narrow layout swaps list
// for the exact existing WorkSessionDetail/ObserverTerminal.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.WORK_CONSOLE_GATE_PORT || 5192);
const origin = `http://127.0.0.1:${port}`;
const captureShots = process.env.WORK_CONSOLE_GATE_SHOTS === "1";
const shotsDir = resolve(webRoot, "artifacts/work-console");
const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const otherMemberId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";

const auth = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://work-console-gate.invalid/connection/websocket",
};

const channel = {
  id: channelId,
  workspaceId,
  kind: "public",
  name: "agent-runtime",
  muted: false,
};

const roster = [
  {
    id: memberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: otherMemberId,
    workspaceId,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "김서연",
    handle: "seoyeon",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const now = Date.now();
const hostIds = {
  app: "00000000-0000-7000-8000-000000000301",
  workd: "00000000-0000-7000-8000-000000000302",
  cloud: "00000000-0000-7000-8000-000000000303",
  unknown: "00000000-0000-7000-8000-000000000304",
};

function host(id, type, displayName, ownerMemberId = memberId) {
  return {
    id,
    workspaceId,
    scope: "member",
    ownerMemberId,
    type,
    displayName,
    capabilities: { terminal: true },
    lastSeenAtMs: now,
    createdAtMs: now - 60_000,
    online: true,
  };
}

const hosts = [
  // 다른 멤버의 app도 workspace 목록에 보인다. viewer-relative한 "이 기기"라
  // 부르면 안 된다는 회귀를 이 픽스처가 잠근다.
  host(hostIds.app, "app", "서연의 MacBook", otherMemberId),
  host(hostIds.workd, "workd", "개발실 워크스테이션"),
  host(hostIds.cloud, "cloud", "oort Cloud 서울"),
  host(hostIds.unknown, "edge-preview", "실험 호스트"),
];

function workSession(
  idSuffix,
  hostId,
  label,
  status = "running",
  remoteDisplayAvailable = false
) {
  return {
    id: `00000000-0000-7000-8000-0000000004${idSuffix}`,
    workspaceId,
    channelId,
    memberId,
    hostId,
    rootMessageId: `00000000-0000-7000-8000-0000000005${idSuffix}`,
    tool: "codex",
    label,
    status,
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    remoteDisplayAvailable,
    startedAtMs: now - Number(idSuffix) * 60_000,
  };
}

const sessions = [
  workSession("01", hostIds.app, "데스크톱 앱에서 UI 검수"),
  workSession("02", hostIds.workd, "셀프호스트에서 테스트"),
  // The one session with BOTH surfaces (LIVE-2 / ADR-0165). The two server
  // facts are independent, so the console must draw both blocks side by side
  // rather than making the reader choose between them.
  workSession("03", hostIds.cloud, "클라우드에서 빌드", "running", true),
  workSession("04", hostIds.unknown, "알 수 없는 위치 확인", "idle"),
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((resolveWait) => setTimeout(resolveWait, ms));
}

async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
    // React Query decides staleness from Date.now(). Advancing this gate clock
    // lets the gate prove a cached refetch failure without sleeping for the
    // production 30s/60s stale windows.
    const actualNow = Date.now.bind(Date);
    let clockOffsetMs = 0;
    Date.now = () => actualNow() + clockOffsetMs;
    window.__workConsoleGateAdvanceTime = (byMs) => {
      clockOffsetMs += byMs;
    };

    class GateWebSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;

      constructor(url) {
        this.url = url;
        this.readyState = GateWebSocket.CONNECTING;
        queueMicrotask(() => {
          this.readyState = GateWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        });
      }

      send(data) {
        const replies = String(data)
          .trim()
          .split("\n")
          .map((line) => {
            const command = JSON.parse(line);
            if (command.connect) {
              return {
                id: command.id,
                connect: { client: "work-console-gate", version: "6" },
              };
            }
            if (command.subscribe) {
              return {
                id: command.id,
                subscribe: {
                  recoverable: true,
                  positioned: true,
                  recovered: false,
                  epoch: "work-console-gate",
                  offset: 0,
                },
              };
            }
            return { id: command.id };
          });
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent("message", {
              data: replies.map((reply) => JSON.stringify(reply)).join("\n"),
            })
          );
        });
      }

      close() {
        this.readyState = GateWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1000 }));
      }
    }
    window.WebSocket = GateWebSocket;
  });
}

async function installRoutes(context, state) {
  await context.route("**/v1/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        // The cached-refetch test advances the browser clock by more than one
        // host stale window. Keep the fixture token out of that test's way.
        expiresAtMs: Date.now() + 600_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path.endsWith("/channels")) {
      await wait(state.channelDelayMs ?? 0);
      return state.failChannels
        ? json(route, { error: { message: "fixture channel failure" } }, 500)
        : json(route, { channels: [channel] });
    }
    if (path.endsWith("/roster")) {
      await wait(state.rosterDelayMs ?? 0);
      return state.failRoster
        ? json(route, { error: { message: "fixture roster failure" } }, 500)
        : json(route, { members: roster });
    }
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) {
      await wait(state.sessionDelayMs ?? 0);
      if (state.mode === "error" || state.failSessions) {
        return json(route, { error: { message: "fixture failure" } }, 500);
      }
      return json(route, {
        workSessions: state.mode === "empty" ? [] : sessions,
      });
    }
    if (path.endsWith("/work-hosts")) {
      await wait(state.hostDelayMs ?? 0);
      return state.failHosts
        ? json(route, { error: { message: "fixture host failure" } }, 500)
        : json(route, { workHosts: hosts });
    }
    if (path.includes("/messages/") && path.endsWith("/replies")) {
      return json(route, { messages: [] });
    }
    return json(route, {});
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // Preview is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
  }
  throw new Error("preview server never came up");
}

async function openConsole(context) {
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  const submit = page.getByTestId("login-submit");
  await submit.waitFor({ timeout: 30_000 });
  await page.getByTestId("login-email").fill("gate@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await submit.click();
  await page.getByTestId("nav-work-console").waitFor();
  await page.getByTestId("nav-work-console").click();
  await page.getByTestId("work-console-route").waitFor();
  return page;
}

async function assertFocus(page, selector) {
  await page.waitForFunction(
    (expectedSelector) => {
      const active = document.activeElement;
      return active instanceof HTMLElement && active.matches(expectedSelector);
    },
    selector
  );
}

async function remountSelectedConsole(page, sessionId, advanceMs) {
  await page.getByTestId("nav-activity").click();
  await page.getByTestId("nav-work-console").waitFor();
  await page.evaluate(
    ({ selectedId, byMs }) => {
      window.__workConsoleGateAdvanceTime(byMs);
      window.location.hash = `#/work?session=${selectedId}`;
    },
    { selectedId: sessionId, byMs: advanceMs }
  );
  await page.getByTestId("work-console-route").waitFor();
}

async function assertCachedRefetchFailure(page, state, kind) {
  const isHost = kind === "host";
  if (isHost) state.failHosts = true;
  else state.failSessions = true;
  await remountSelectedConsole(
    page,
    sessions[2].id,
    isHost ? 61_000 : 31_000
  );
  const warning = page.getByTestId("work-console-stale-error");
  await warning.waitFor({ timeout: 10_000 });
  const expectedCopy = isHost
    ? "실행 위치를 새로 확인하지 못했습니다. 마지막 호스트 정보를 표시합니다."
    : "작업 세션을 새로 확인하지 못했습니다. 마지막 목록을 표시합니다.";
  if ((await warning.textContent())?.includes(expectedCopy) !== true) {
    throw new Error(`${kind} cached refetch warning did not name the stale projection`);
  }
  if ((await page.getByTestId("work-console-row").count()) !== 4) {
    throw new Error(`${kind} cached refetch failure erased the master rows`);
  }
  await page.getByTestId("work-detail").waitFor();
  if (!page.url().includes(`session=${sessions[2].id}`)) {
    throw new Error(`${kind} cached refetch failure lost the selected detail`);
  }

  if (isHost) state.failHosts = false;
  else state.failSessions = false;
  await warning.getByText("다시 시도", { exact: true }).click();
  await warning.waitFor({ state: "detached", timeout: 10_000 });
}

async function assertConsole(context, state) {
  const page = await openConsole(context);
  const skeletons = page.getByTestId("skeleton-row");
  await skeletons.first().waitFor();
  if ((await page.getByTestId("work-console-count").count()) !== 0) {
    throw new Error("initial loading rendered a settled session count");
  }
  const rows = page.getByTestId("work-console-row");
  await rows.first().waitFor();
  // The rest of the gate is about transitions, not artificial latency.
  state.sessionDelayMs = 0;
  state.hostDelayMs = 0;
  if ((await rows.count()) !== 4) {
    throw new Error(`workspace master list rendered ${await rows.count()} rows`);
  }

  const labels = await page
    .getByTestId("work-console-location")
    .allTextContents();
  const expected = [
    "T1 · 데스크톱 앱",
    "T2 · 셀프호스트",
    "T3 · 클라우드",
    "실행 위치 확인 필요",
  ];
  for (const label of expected) {
    if (!labels.some((value) => value.trim() === label)) {
      throw new Error(`location label missing: ${label} in ${JSON.stringify(labels)}`);
    }
  }
  for (const [sessionLabel, expectedHost] of [
    ["데스크톱 앱에서 UI 검수", "서연의 MacBook"],
    ["셀프호스트에서 테스트", "개발실 워크스테이션"],
    ["클라우드에서 빌드", "oort Cloud 서울"],
    ["알 수 없는 위치 확인", "실험 호스트"],
  ]) {
    const hostLabel = rows
      .filter({ hasText: sessionLabel })
      .getByTestId("work-console-host");
    if ((await hostLabel.textContent())?.trim() !== expectedHost) {
      throw new Error(`host identity drifted for ${sessionLabel}`);
    }
    const clipped = await hostLabel.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    if (clipped) {
      throw new Error(`host identity is clipped at the default width: ${expectedHost}`);
    }
  }
  const cloudBadge = page.locator(
    '[data-testid="work-console-location"][data-location="t3"]'
  );
  if (
    (await cloudBadge.count()) !== 1 ||
    (await cloudBadge.locator("svg.lucide-cloud").count()) !== 1
  ) {
    throw new Error("T3 cloud tag lost its data marker or cloud SVG icon");
  }
  const sameElement = await rows.first().evaluate((row) => {
    const status = row.querySelector('[data-testid="work-console-status"]');
    const location = row.querySelector('[data-testid="work-console-location"]');
    return status === location;
  });
  if (sameElement) throw new Error("session state and execution location collapsed into one chip");
  const firstMeta = (await rows.first().getByTestId("work-console-meta").textContent())?.trim();
  if (firstMeta !== "#agent-runtime · 곽성재 · codex") {
    throw new Error(`session who/what meta drifted: ${firstMeta}`);
  }
  for (const meta of await page.getByTestId("work-console-meta").all()) {
    const clipped = await meta.evaluate(
      (element) => element.scrollWidth > element.clientWidth + 1
    );
    if (clipped) {
      throw new Error("channel, owner, or tool metadata is clipped at the default width");
    }
  }
  const firstTime = (
    await rows.first().getByTestId("work-console-time").textContent()
  )?.trim();
  if (!/^시작 \d{2}:\d{2}$/.test(firstTime ?? "")) {
    throw new Error(`session time is not an explicit known timestamp: ${firstTime}`);
  }
  const idleTime = (
    await rows
      .filter({ hasText: "알 수 없는 위치 확인" })
      .getByTestId("work-console-time")
      .textContent()
  )?.trim();
  if (!/^시작 \d{2}:\d{2}$/.test(idleTime ?? "")) {
    throw new Error(`idle session time is not a stable start timestamp: ${idleTime}`);
  }

  await rows.filter({ hasText: "클라우드에서 빌드" }).click();
  await page.getByTestId("work-detail").waitFor();
  const headingOutline = await page
    .getByTestId("work-console-route")
    .locator("h1, h2, h3, h4, h5, h6")
    .evaluateAll((headings) =>
      headings.map((heading) => ({
        level: Number(heading.tagName.slice(1)),
        text: heading.textContent?.trim() ?? "",
      }))
    );
  const expectedHeadingOutline = [
    { level: 1, text: "작업 콘솔" },
    { level: 2, text: "클라우드에서 빌드" },
    { level: 3, text: "터미널 관전" },
    { level: 3, text: "라이브 화면" },
  ];
  if (JSON.stringify(headingOutline) !== JSON.stringify(expectedHeadingOutline)) {
    throw new Error(
      `route detail heading outline is not h1 -> h2 -> h3: ${JSON.stringify(
        headingOutline
      )}`
    );
  }
  const observer = page.getByTestId("work-observer");
  await observer.waitFor();
  const readOnly = observer.getByTestId("work-observer-readonly");
  if ((await readOnly.textContent())?.trim() !== "읽기 전용") {
    throw new Error("observer detail does not state that the terminal is read-only");
  }
  const readOnlyTitle = (await readOnly.getAttribute("title")) ?? "";
  for (const denied of ["입력", "크기 조절", "종료"]) {
    if (!readOnlyTitle.includes(denied)) {
      throw new Error(`read-only title does not deny ${denied}`);
    }
  }
  const controllerInputs = observer.locator(
    'input, textarea, [contenteditable="true"], [data-testid*="controller"], [data-testid*="stdin"], [data-testid*="resize"], [data-testid*="kill"]'
  );
  if ((await controllerInputs.count()) !== 0) {
    throw new Error("observer-only terminal exposed a controller/input control");
  }

  // 라이브 화면 (LIVE-2 / ADR-0165), on the same session as the terminal and
  // beside it. What the gate checks here is what a person would check: that the
  // surface says it cannot be typed into, and that there is nothing on it that
  // could type.
  const display = page.getByTestId("work-display");
  await display.waitFor();
  const displayReadOnly = display.getByTestId("work-display-readonly");
  if ((await displayReadOnly.textContent())?.trim() !== "보기 전용") {
    throw new Error("display detail does not state that the screen is view-only");
  }
  const displayReadOnlyTitle = (await displayReadOnly.getAttribute("title")) ?? "";
  for (const denied of ["키보드", "마우스", "저장"]) {
    if (!displayReadOnlyTitle.includes(denied)) {
      throw new Error(`view-only title does not deny ${denied}`);
    }
  }
  // ADR-0004 증보 3 D1: control is not 인수, and the word must not appear.
  if (((await display.textContent()) ?? "").includes("인수")) {
    throw new Error("the display surface used the word 인수");
  }
  if (!(await display.getByTestId("work-display-start").isVisible())) {
    throw new Error("a session with a published screen offered no way to open it");
  }
  const displayInputs = display.locator(
    'input, textarea, [contenteditable="true"], video[controls], [data-testid*="controller"], [data-testid*="input"], [data-testid*="keyboard"]'
  );
  if ((await displayInputs.count()) !== 0) {
    throw new Error("view-only display exposed a control that could send input");
  }

  if (!page.url().includes(`session=${sessions[2].id}`)) {
    throw new Error(`selected session did not enter the URL: ${page.url()}`);
  }
  // This is a destination, not component memory: reloading the copied address
  // must recover the same detail from the server projection.
  await page.reload();
  await page.getByTestId("work-detail").waitFor();
  const reloadedLocation = (
    await page
      .getByTestId("work-console-detail-location")
      .getByTestId("work-console-location")
      .textContent()
  )?.trim();
  if (reloadedLocation !== "T3 · 클라우드") {
    throw new Error(`direct session link recovered ${reloadedLocation}`);
  }
  if (!(await page.getByTestId("work-console-list").isVisible())) {
    throw new Error("desktop detail replaced the master list instead of standing beside it");
  }

  const consoleLayout = page.locator(".work-console-layout");
  const detailPane = page.locator("[data-work-console-detail]");
  const defaultDetailWidth = await detailPane.evaluate(
    (element) => element.getBoundingClientRect().width
  );
  const wideToggle = page.getByTestId("work-console-detail-wide");
  if (
    (await wideToggle.getAttribute("aria-label")) !== "세션 상세 넓게 보기" ||
    (await wideToggle.getAttribute("title")) !== "상세 넓게 보기" ||
    (await wideToggle.getAttribute("aria-controls")) !==
      "work-console-session-list"
  ) {
    throw new Error("work console detail focus action is not named truthfully");
  }
  await observer.evaluate((element) => {
    window.__workConsoleObserverNode = element;
    element.dataset.gateMountMarker = "before-wide";
  });
  await wideToggle.click();
  await page.waitForFunction(() => {
    const layout = document.querySelector(".work-console-layout");
    return layout instanceof HTMLElement && layout.hasAttribute("data-detail-wide");
  });
  if (await page.getByTestId("work-console-list").isVisible()) {
    throw new Error("detail focus mode left the session master visible");
  }
  const focusedDetailWidth = await detailPane.evaluate(
    (element) => element.getBoundingClientRect().width
  );
  if (focusedDetailWidth < defaultDetailWidth + 250) {
    throw new Error(
      `detail focus recovered too little width: ${defaultDetailWidth} -> ${focusedDetailWidth}`
    );
  }
  if (
    (await consoleLayout.getAttribute("data-detail-wide")) === null ||
    (await wideToggle.getAttribute("aria-pressed")) !== "true" ||
    (await wideToggle.getAttribute("aria-label")) !== "세션 상세 넓게 보기" ||
    (await wideToggle.getAttribute("title")) !== "세션 목록 보이기"
  ) {
    throw new Error("detail focus state is not exposed to assistive technology");
  }
  if (!page.url().includes(`session=${sessions[2].id}`)) {
    throw new Error("detail focus mode discarded the selected session URL");
  }
  if (!(await readOnly.isVisible())) {
    throw new Error("detail focus mode replaced the observer terminal");
  }
  const observerRemounted = await observer.evaluate(
    (element) =>
      window.__workConsoleObserverNode !== element ||
      element.dataset.gateMountMarker !== "before-wide"
  );
  if (observerRemounted) {
    throw new Error("detail focus remounted the observer terminal subtree");
  }
  if (captureShots) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(shotsDir, "console-detail-focus-light.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: resolve(shotsDir, "console-detail-focus-dark.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(220);
  }
  await page.goBack();
  await page.waitForFunction(() => !window.location.hash.includes("session="));
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  await assertFocus(page, `a[data-session-id="${sessions[2].id}"]`);
  await rows.filter({ hasText: "클라우드에서 빌드" }).click();
  await page.getByTestId("work-detail").waitFor();
  const restoredWideToggle = page.getByTestId("work-console-detail-wide");
  if ((await restoredWideToggle.getAttribute("aria-pressed")) !== "false") {
    throw new Error("history back leaked detail focus into a fresh selection");
  }
  await restoredWideToggle.click();
  await restoredWideToggle.click();
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  if ((await restoredWideToggle.getAttribute("aria-pressed")) !== "false") {
    throw new Error("restoring the session list did not release detail focus");
  }

  await assertCachedRefetchFailure(page, state, "host");
  await assertCachedRefetchFailure(page, state, "session");
  if (captureShots) {
    mkdirSync(shotsDir, { recursive: true });
    await page.screenshot({
      path: resolve(shotsDir, "console-wide-light.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: resolve(shotsDir, "console-wide-dark.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(220);
  }

  for (const [width, expectSplit] of [
    [900, true],
    [899, false],
  ]) {
    await page.setViewportSize({ width, height: 700 });
    await page.goto(`${origin}/#/work?session=${sessions[1].id}`);
    await page.getByTestId("work-detail").waitFor();
    const listVisible = await page.getByTestId("work-console-list").isVisible();
    const toggleVisible = await page
      .getByTestId("work-console-detail-wide")
      .isVisible();
    if (listVisible !== expectSplit || toggleVisible !== expectSplit) {
      throw new Error(
        `${width}px breakpoint drifted: list=${listVisible} toggle=${toggleVisible}`
      );
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
    );
    if (overflow) throw new Error(`${width}px work console created document overflow`);
  }

  await page.setViewportSize({ width: 760, height: 700 });
  await page.goto(`${origin}/#/work`);
  await page.getByTestId("work-console-list").waitFor();
  if (!(await page.getByTestId("work-console-list").isVisible())) {
    throw new Error("narrow console did not start on the session list");
  }
  if (captureShots) {
    await page.screenshot({
      path: resolve(shotsDir, "console-narrow-light.png"),
      fullPage: false,
    });
  }
  await page
    .getByTestId("work-console-row")
    .filter({ hasText: "셀프호스트에서 테스트" })
    .click();
  await page.getByTestId("work-detail").waitFor();
  if (await page.getByTestId("work-console-list").isVisible()) {
    throw new Error("narrow console kept the list beside the terminal detail");
  }
  if (await page.getByTestId("work-console-detail-wide").isVisible()) {
    throw new Error("narrow console exposed a focus action that cannot widen it further");
  }

  // This session has a terminal and no screen, which is a DIFFERENT sentence
  // from an error (LIVE-2 AC-4). It is checked here rather than beside the
  // cloud session's display block because switching rows up there would push
  // two history entries under the goBack the focus assertions depend on.
  const noScreen = (
    await page.getByTestId("work-display-blocked").textContent()
  )?.trim();
  if (!noScreen?.includes("호스트 화면을 열어 두지 않았습니다")) {
    throw new Error(`a session with no screen did not say so: ${noScreen}`);
  }
  if (await page.getByTestId("work-display-error").count()) {
    throw new Error("a session with no screen drew an error instead of a state");
  }
  if (await page.getByTestId("work-display-start").count()) {
    throw new Error("a session with no screen still offered to open one");
  }
  if (captureShots) {
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForTimeout(220);
    await page.screenshot({
      path: resolve(shotsDir, "console-narrow-dark.png"),
      fullPage: false,
    });
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(220);
  }
  await page.getByTestId("work-detail-back").click();
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  await assertFocus(page, `a[data-session-id="${sessions[1].id}"]`);

  await page.goto(`${origin}/#/work?session=not-a-session`);
  await page.getByTestId("work-console-not-found").waitFor();
  await page.getByTestId("work-console-not-found").getByText("목록으로").click();
  await page.getByTestId("work-console-list").waitFor({ state: "visible" });
  await assertFocus(page, `a[data-session-id="${sessions[0].id}"]`);

  await page.goto(`${origin}/#/work?session=${sessions[0].id}`);
  const offlineDetail = page.getByTestId("work-detail");
  await offlineDetail.waitFor();
  if ((await offlineDetail.getAttribute("data-live")) === null) {
    throw new Error("fixture detail never entered its live state");
  }
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  const cachedOffline = page.getByTestId("work-console-offline");
  await cachedOffline.waitFor();
  if (
    (await cachedOffline.textContent())?.includes(
      "아래는 마지막으로 확인된 작업 상태입니다."
    ) !== true
  ) {
    throw new Error("cached offline state did not name its last-known projection");
  }
  await page.waitForFunction(() => {
    const detail = document.querySelector('[data-testid="work-detail"]');
    return detail instanceof HTMLElement && !detail.hasAttribute("data-live");
  });
  await page.close();
}

async function assertTerminalState(browser, state, testId, expectedCopy = null) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, state);
    const page = await openConsole(context);
    const target = page.getByTestId(testId);
    await target.waitFor({ timeout: 10_000 });
    if (
      expectedCopy !== null &&
      (await target.textContent())?.includes(expectedCopy) !== true
    ) {
      throw new Error(`${testId} did not render expected copy: ${expectedCopy}`);
    }
  } finally {
    await context.close();
  }
}

async function assertMetadataFallback(
  browser,
  state,
  expectedMeta,
  expectedWarning
) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, state);
    const page = await openConsole(context);
    const firstMeta = page
      .getByTestId("work-console-row")
      .first()
      .getByTestId("work-console-meta");
    await firstMeta.waitFor({ timeout: 10_000 });
    const warning = page.getByTestId("work-console-metadata-error");
    await warning.waitFor({ timeout: 10_000 });
    if ((await warning.textContent())?.includes(expectedWarning) !== true) {
      throw new Error(
        `metadata failure warning did not name the failed projection: ${await warning.textContent()}`
      );
    }
    if ((await firstMeta.textContent())?.trim() !== expectedMeta) {
      throw new Error(
        `initial projection failure did not fail closed: ${await firstMeta.textContent()}`
      );
    }
  } finally {
    await context.close();
  }
}

async function assertColdOffline(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: "reduce",
  });
  try {
    await installRoutes(context, {
      mode: "normal",
      sessionDelayMs: 2_000,
      hostDelayMs: 2_000,
    });
    const page = await openConsole(context);
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    const banner = page.getByTestId("work-console-offline");
    await banner.waitFor();
    if (
      (await banner.textContent())?.includes(
        "아직 표시할 저장된 작업 상태가 없습니다."
      ) !== true
    ) {
      throw new Error("cold offline state claimed that a cached projection exists");
    }
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }
  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, stdio: "ignore" }
  );
  try {
    await waitForServer();
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        reducedMotion: "reduce",
      });
      const state = {
        mode: "normal",
        sessionDelayMs: 650,
        hostDelayMs: 850,
        channelDelayMs: 0,
        rosterDelayMs: 0,
        failSessions: false,
        failHosts: false,
        failChannels: false,
        failRoster: false,
      };
      await installRoutes(context, state);
      await assertConsole(context, state);
      await context.close();
      await assertTerminalState(
        browser,
        { mode: "empty" },
        "work-console-empty"
      );
      await assertTerminalState(
        browser,
        { mode: "error" },
        "work-console-error",
        "작업 세션을 불러오지 못했습니다."
      );
      await assertTerminalState(
        browser,
        { mode: "normal", failHosts: true },
        "work-console-error",
        "실행 위치를 불러오지 못했습니다."
      );
      await assertMetadataFallback(
        browser,
        { mode: "normal", failChannels: true },
        "채널 조회 실패 · 곽성재 · codex",
        "채널 정보를 새로 확인하지 못했습니다."
      );
      await assertMetadataFallback(
        browser,
        { mode: "normal", failRoster: true },
        "#agent-runtime · 담당자 조회 실패 · codex",
        "담당자 정보를 새로 확인하지 못했습니다."
      );
      await assertColdOffline(browser);
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }
  console.log(
    "PASS work console: delayed load, projection errors and cached stale fallback, unclipped T1/T2/T3/unknown hosts, cloud icon, observer-only terminal, h1/h2/h3 route outline, linkable selection, responsive keyboard focus, cached/cold offline, empty/error"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
