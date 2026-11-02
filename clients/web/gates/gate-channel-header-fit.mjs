#!/usr/bin/env node
// GATE: 채널 머리의 컨트롤이 긴 이름에도 뷰포트 안에 남는다 (#4230, 검증 줄 3회차 Blocker B1).
//
// 이 게이트가 지키는 것은 「머리가 그려진다」가 아니라 **지원하는 모든 폭에서 컨트롤이 보이고 닿는가**다.
// 판(`app-pane`)과 셸이 `overflow: clip`이라 머리 밖으로 밀린 단추는 스크롤로도 드러나지 않고, 키보드 초점은 보이지 않는
// 단추에 내려앉는다(루브릭 Detail SLA: 늘 Blocker). 문서에 가로 스크롤이 안 생기는지(`gate:channel-header`가 390에서 잰다)로는
// 이것을 못 잡는다: 잘린 단추는 문서 폭을 키우지 않는다.
//
// 장면 하나(폭 × 글자 크기 × 밀도)마다 재는 것:
//   1. 뷰포트        머리의 모든 컨트롤(서랍 단추 포함)의 상자가 뷰포트 안이다.
//   2. 겹침          컨트롤끼리, 컨트롤과 종류 아이콘·제목·토픽이 겹치지 않는다. 판이 좁아 줄이 바뀌어도 그렇다.
//   3. 히트 테스트   각 컨트롤의 가운데와 양 끝 안쪽 점을 `elementFromPoint`로 짚으면 그 컨트롤이 나온다:
//                    조상의 `overflow: clip`에 잘렸거나 다른 상자에 덮였으면 여기서 걸린다.
//   4. 머리 안쪽     머리 자신이 가로로 넘치지 않는다(`scrollWidth ≤ clientWidth`).
//   5. 제목          한 줄이고 남는 폭을 받는다(바닥 이상). 말줄임이어도 글(낭독)과 `title`(툴팁)은 전문 그대로다.
//                    1440에서는 이름이 다 들어갈 자리가 있으므로 잘리지 않는다(단추를 먼저 챙기느라 제목을 필요 이상 깎지 않는다).
//   6. 오른쪽 끝     컨트롤 묶음은 줄이 바뀌어도 머리 안쪽 오른쪽 끝에 붙는다(`channel-head-tools`의 `margin-inline-start: auto`).
//   7. 줄바꿈 정책   컨트롤이 제목 아랫줄로 내려가는 것은 **옆에 제목 몫(바닥 3rem)이 모자랄 때만**이다. 뷰포트 안인지만 보면
//                    「제목 칸이 폭 0으로 시작한다」는 약속이 깨져도(필요 없이 줄이 바뀐다) 초록이다. 반대로 한 줄에 서면 제목
//                    칸이 바닥 이상이다.
//   8. 장면이 진짜다 기대한 단추 집합이 그대로 서 있고, 글자 크기·밀도 속성이 계산된 값에 실제로 닿았다.
//
// 폭은 표(320·390·600·720·900·1440)만이 아니라 **16px 간격 훑기**(320~1440)도 한다. 줄이 바뀌는 문턱과 제목 칸이 바닥에 닿는
// 폭은 표의 여섯 폭 사이에 있고, 레이아웃 결함은 그 문턱에서 나온다(표의 폭만으로는 핸들·바닥 단정이 한 번도 문턱을 못 밟는다).
//
// 장면: 이름 {한글·영문·이모지·짧은 이름} × 토픽 {없음·긴 토픽} + 긴 이름의 DM × 폭 {320, 390, 600, 720, 900, 1440}
//       × 글자 크기 {작게·기본·크게} × 밀도 {촘촘·편하게·여유} × 계획 독 {있음·없음}.
//       독이 있는 장면은 작업 호스트가 온라인이고 12단계 계획의 세션이 도는 대화다(독 배지 두 자리, 터미널 단추도 선다).
//       멤버 12명(멤버 수 두 자리).
//
//   npm run gate:channel-header-fit                       # 이 체크아웃을 빌드해 크로미엄에서 잰다
//   HEADER_FIT_ENGINES=chromium,webkit npm run gate:channel-header-fit   # 데스크탑 셸(WKWebView)과 같은 웨빗까지
//   HEADER_FIT_GATE_DIST=/path/to/dist node gates/gate-channel-header-fit.mjs   # 다른 빌드(고치기 전)를 재서 빨간 불을 확인한다
//   HEADER_FIT_GATE_SHOTS=/tmp/shots [HEADER_FIT_GATE_SCHEME=dark]   # 장면마다 머리 스크린샷(기본 글자 크기·밀도)
//   HEADER_FIT_GATE_LOCALE=en-US                           # 기본은 ko-KR(캡처와 같다): 영어 문구도 같은 기하여야 한다
//
// 백엔드 없음: `/v1`은 아래 모의로 채운다(`gates/gate-channel-header.mjs`와 같은 방식). 번들 크로미엄·웨빗(헤드리스)만 쓴다.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = Number(process.env.HEADER_FIT_GATE_PORT || 5242);
const origin = `http://127.0.0.1:${port}`;
const distOverride = process.env.HEADER_FIT_GATE_DIST
  ? resolve(process.env.HEADER_FIT_GATE_DIST)
  : null;
const shotsDir = process.env.HEADER_FIT_GATE_SHOTS
  ? resolve(process.env.HEADER_FIT_GATE_SHOTS)
  : null;
const scheme = process.env.HEADER_FIT_GATE_SCHEME === "dark" ? "dark" : "light";
const locale = process.env.HEADER_FIT_GATE_LOCALE || "ko-KR";
const engineNames = (process.env.HEADER_FIT_ENGINES || "chromium")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const ENGINES = { chromium, webkit };

// ---- 장면 표 -----------------------------------------------------------------------------

const WIDTHS = [320, 390, 600, 720, 900, 1440];
/** 16px 간격 훑기. 표의 폭은 글자 크기 3 × 밀도 3을 다 곱하고, 훑기 폭은 두 극단(기본·편하게 / 크게·여유롭게)만 곱한다. */
const SWEEP_WIDTHS = Array.from({ length: (1440 - 320) / 16 + 1 }, (_, index) => 320 + index * 16);
const HEIGHT = 800;
/** 제목 칸의 바닥. `tokens.css` `channel-head-body`의 `min-inline-size: 3rem`(루트 16px). */
const TITLE_FLOOR = 48;
/** 글자 크기·밀도의 루트 속성 값. 계산된 값은 `design/appearance/{typography-scale,density}.css`가 정한다. */
const FONT_SIZES = [
  { id: "smaller", scale: 14 / 15 },
  { id: "default", scale: 1 },
  { id: "larger", scale: 16 / 15 },
];
const DENSITIES = [
  { id: "compact", row: 4 },
  { id: "comfortable", row: 6 },
  { id: "spacious", row: 8 },
];

const NAMES = {
  ko: "릴리스-2026-08-온콜-교대-배포-판단-고객-영향-롤백-조건-기록-점검-회의",
  en: "release-2026-08-oncall-handover-deploy-decision-customer-impact-rollback-criteria",
  emoji: "🚀🔥-launch-war-room-🧯-롤백-🎯-고객-영향-점검-회의-👩🏽‍💻👨🏻‍🚀",
  short: "general",
};
const LONG_TOPIC =
  "release-2026-08 운영 토픽: 온콜 교대, 배포 판단, 고객 영향, 롤백 조건을 이 채널에서 함께 기록합니다. " +
  "긴 문장도 헤더의 다른 컨트롤을 밀어내지 않으며, 전체 내용은 키보드로 열어 읽을 수 있어야 합니다.";
const LONG_PEER = "곽성재님의 아주아주 긴 이름을 가진 에이전트 어시스턴트 (운영팀 온콜 담당)";

const SCENES = [
  { id: "ko", kind: "channel", name: NAMES.ko, topic: "" },
  { id: "en", kind: "channel", name: NAMES.en, topic: "" },
  { id: "emoji", kind: "channel", name: NAMES.emoji, topic: "" },
  { id: "ko+topic", kind: "channel", name: NAMES.ko, topic: LONG_TOPIC },
  { id: "short+topic", kind: "channel", name: NAMES.short, topic: LONG_TOPIC },
  { id: "dm", kind: "dm", name: LONG_PEER, topic: "" },
  // 같은 이름의 멤버가 둘이면 DM 제목 옆에 구분용 핸들(`@dohyun`)이 선다.
  { id: "dm+handle", kind: "dm", name: LONG_PEER, topic: "", ambiguous: true },
];

// ---- 모의 서버 ----------------------------------------------------------------------------

const workspaceId = "00000000-0000-7000-8000-000000000001";
const ownerId = "00000000-0000-7000-8000-000000000101";
const peerId = "00000000-0000-7000-8000-000000000102";
const channelId = "00000000-0000-7000-8000-000000000201";
const dmChannelId = "00000000-0000-7000-8000-000000000202";
const hostId = "00000000-0000-7000-8000-000000000401";
const sessionId = "00000000-0000-7000-8000-000000000501";
const rootId = "0199cccc-0000-7000-8000-0000000000b1";
const AT = 1_785_238_400_000;
const MEMBER_COUNT = 12;

const json = (route, body, status = 200) =>
  route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });

function rosterMember(over) {
  return {
    workspaceId,
    status: "active",
    role: "member",
    channelCount: 1,
    channelIds: [channelId],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
    ...over,
  };
}

function roster(scene) {
  const members = [
    rosterMember({
      id: ownerId,
      kind: "human",
      role: "owner",
      displayName: "곽성재",
      handle: "seongjae",
      channelIds: [channelId, dmChannelId],
    }),
  ];
  for (let index = 1; index < MEMBER_COUNT; index += 1) {
    const id = `00000000-0000-7000-8000-0000000003${String(index).padStart(2, "0")}`;
    members.push(
      rosterMember({
        id,
        kind: "human",
        displayName: `팀원 ${index}`,
        handle: `member-${index}`,
      })
    );
  }
  members.push(
    rosterMember({
      id: peerId,
      kind: "human",
      displayName: scene.kind === "dm" ? scene.name : "이도현",
      handle: "dohyun",
      channelIds: [dmChannelId],
    })
  );
  if (scene.ambiguous) {
    members.push(
      rosterMember({
        id: "00000000-0000-7000-8000-000000000199",
        kind: "human",
        displayName: scene.name,
        handle: "dohyun-2",
      })
    );
  }
  return members;
}

function channels(scene) {
  if (scene.kind === "dm") {
    return [
      { id: channelId, workspaceId, kind: "public", name: "general", topic: "", muted: false },
      { id: dmChannelId, workspaceId, kind: "dm", muted: false, memberIds: [ownerId, peerId] },
    ];
  }
  return [
    {
      id: channelId,
      workspaceId,
      kind: "public",
      name: scene.name,
      topic: scene.topic,
      muted: false,
    },
  ];
}

function planFrame() {
  // 12단계 중 1단계 완료: 남은 11 → 독 배지가 두 자리다(가장 넓은 독).
  const plan = Array.from({ length: 12 }, (_, index) => ({
    content: `단계 ${index + 1}`,
    status: index < 1 ? "completed" : index === 1 ? "in_progress" : "pending",
  }));
  return {
    channelId,
    hlcCount: 0,
    type: "text",
    state: "sent",
    authorMemberId: ownerId,
    body: "",
    seq: 2,
    id: "0199cccc-0000-7000-8000-0000000000b2",
    hlcTs: AT,
    createdAtMs: AT,
    rootId,
    props: {
      kind: "work_session_event",
      schema: "momo.work_session.acp_event.v1",
      event_type: "agent.status",
      event_id: "header-fit-event-1",
      event_ts: AT,
      event: { work_session_id: sessionId, plan, has_plan: true, phase: "running" },
    },
  };
}

async function installRoutes(context, scene, withPlan) {
  /** 계획 독이 서는 대화: 세션이 이 대화에서 돈다(`planSessionsOf`가 채널로 거른다). */
  const sessionChannelId = scene.kind === "dm" ? dmChannelId : channelId;
  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (path === "/v1/auth/login") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
        member: { id: ownerId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
        realtimeWebSocketUrl: "ws://header-fit-gate.invalid/connection/websocket",
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-realtime-token",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId: ownerId,
      });
    }
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: "gate-only-not-a-credential",
        refreshToken: "gate-only-not-a-credential",
      });
    }
    if (path.endsWith("/roster") || (path.endsWith("/members") && method === "GET")) {
      return json(route, { members: roster(scene) });
    }
    if (path.endsWith("/channels")) return json(route, { channels: channels(scene) });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/reactions")) return json(route, {});
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) {
      return json(route, {
        workHosts: withPlan
          ? [
              {
                id: hostId,
                workspaceId,
                scope: "workspace",
                ownerMemberId: ownerId,
                type: "mac",
                displayName: "gate-host",
                capabilities: {},
                createdAtMs: 0,
                online: true,
                lastSeenAtMs: Date.now(),
              },
            ]
          : [],
      });
    }
    if (path.endsWith("/work-sessions")) {
      return json(route, {
        workSessions: withPlan
          ? [
              {
                id: sessionId,
                workspaceId,
                channelId: sessionChannelId,
                memberId: ownerId,
                hostId,
                rootMessageId: rootId,
                tool: "claude",
                label: "계획",
                status: "running",
                observation: "open",
                observerGrantCount: 0,
                remoteAttachAvailable: false,
                remoteDisplayAvailable: false,
                startedAtMs: Date.now() - 60_000,
              },
            ]
          : [],
      });
    }
    if (path.endsWith("/pins")) return json(route, { pins: [] });
    if (path.endsWith(`/messages/${rootId}/replies`)) {
      return json(route, { messages: withPlan ? [planFrame()] : [] });
    }
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.endsWith("/messages")) {
      if (url.searchParams.has("after")) return json(route, { messages: [] });
      return json(route, {
        messages: [
          {
            channelId,
            hlcCount: 0,
            type: "text",
            state: "sent",
            authorMemberId: peerId,
            body: "온콜 교대는 매주 화요일 10시입니다.",
            seq: 42,
            id: "0199cccc-0000-7000-8000-0000000000a1",
            hlcTs: AT + 42_000,
            createdAtMs: AT + 42_000,
          },
        ],
      });
    }
    return json(route, {});
  });
}

/** 셸이 연결을 기다리므로 최소한의 WS 스텁이 필요하다(프레임은 쓰지 않는다). */
async function installRealtimeSocket(page) {
  await page.addInitScript(() => {
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
        const replies = [];
        for (const line of String(data).trim().split("\n")) {
          const command = JSON.parse(line);
          if (command.connect) {
            replies.push({ id: command.id, connect: { client: "header-fit-gate", subs: {} } });
          } else if (command.subscribe) {
            replies.push({
              id: command.id,
              subscribe: { recoverable: true, recovered: true, epoch: "header-fit-gate", offset: 0 },
            });
          } else if (command.unsubscribe) {
            replies.push({ id: command.id, unsubscribe: {} });
          } else {
            replies.push({ id: command.id });
          }
        }
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

async function openScene(browser, scene, withPlan) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: HEIGHT },
    reducedMotion: "reduce",
    colorScheme: scheme,
    locale,
  });
  const page = await context.newPage();
  await installRealtimeSocket(page);
  await installRoutes(context, scene, withPlan);
  await page.goto(origin, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("header-fit@example.test");
  await page.getByTestId("login-password").fill("gate-only");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-item").first().waitFor({ timeout: 20_000 });
  if (scene.kind === "dm") {
    await page
      .locator(`[data-testid="channel-item"][data-channel-id="${dmChannelId}"]`)
      .click();
    await page.getByTestId("dm-profile-trigger").waitFor({ timeout: 15_000 });
  } else {
    await page.getByTestId("channel-item").first().click();
    await page.getByTestId("channel-title-menu").waitFor({ timeout: 15_000 });
    // 멤버 수(두 자리)가 그려진 뒤에 잰다: 명부가 늦게 오면 단추 폭이 바뀐다.
    await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="channel-member-count"]')
          ?.getAttribute("data-roster-status") === "ready",
      undefined,
      { timeout: 15_000 }
    );
  }
  if (withPlan) {
    await page.getByTestId("work-plan-dock").waitFor({ timeout: 15_000 });
  }
  return { context, page };
}

// ---- 한 장면의 측정 -------------------------------------------------------------------------

/** 페이지 안에서 도는 측정. 상자·히트 테스트·계산된 값만 돌려주고, 판정은 노드 쪽에서 한다. */
function measureInPage() {
  const rect = (element) => {
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return { left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
  };
  const visible = (element) =>
    element.getClientRects().length > 0 && getComputedStyle(element).visibility !== "hidden";
  const header = document.querySelector('[data-testid="channel-header"]');
  const group = document.querySelector('[data-testid="channel-header-controls"]');
  const drawer = document.querySelector('[data-testid="open-sidebar-drawer"]');
  const controls = [];
  const consider = (element, id) => {
    if (!element || !visible(element)) return;
    const box = element.getBoundingClientRect();
    const cy = box.top + box.height / 2;
    const points = [
      [box.left + box.width / 2, cy],
      [box.left + 3, cy],
      [box.right - 3, cy],
    ];
    const hits = points.map(([x, y]) => {
      const hit = document.elementFromPoint(x, y);
      return hit !== null && element.contains(hit);
    });
    controls.push({ id, rect: rect(element), hits });
  };
  consider(drawer, "open-sidebar-drawer");
  if (group) {
    group.querySelectorAll("button").forEach((button, index) => {
      consider(button, button.getAttribute("data-testid") ?? `button#${index}`);
    });
  }
  const icon = header.querySelector("[data-head-icon]");
  const h1 = header.querySelector("h1");
  const topic = header.querySelector('[data-testid="channel-header-topic"]');
  const handle = header.querySelector('[data-testid="channel-handle"]');
  const main = header.querySelector(".channel-head-main");
  const body = header.querySelector(".channel-head-body");
  const tools = header.querySelector(".channel-head-tools");
  const h1Style = h1 ? getComputedStyle(h1) : null;
  const headerStyle = getComputedStyle(header);
  const root = document.documentElement;
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    docOverflow: root.scrollWidth > window.innerWidth,
    header: rect(header),
    headerInnerLeft: header.getBoundingClientRect().left + Number.parseFloat(headerStyle.paddingLeft),
    headerInnerRight: header.getBoundingClientRect().right - Number.parseFloat(headerStyle.paddingRight),
    columnGap: Number.parseFloat(headerStyle.columnGap),
    main: rect(main),
    body: rect(body),
    tools: rect(tools),
    headerOverflow: header.scrollWidth - header.clientWidth,
    controls,
    icon: icon && visible(icon) ? rect(icon) : null,
    topic: topic && visible(topic) ? rect(topic) : null,
    handle: handle && visible(handle) ? rect(handle) : null,
    h1: h1
      ? {
          rect: rect(h1),
          text: h1.textContent,
          title: h1.getAttribute("title"),
          scrollWidth: h1.scrollWidth,
          clientWidth: h1.clientWidth,
          lineHeight: Number.parseFloat(h1Style.lineHeight),
          whiteSpace: h1Style.whiteSpace,
        }
      : null,
    typeScale: Number.parseFloat(getComputedStyle(root).getPropertyValue("--type-scale")),
    rowSpacing: Number.parseFloat(getComputedStyle(root).getPropertyValue("--spacing-row")),
  };
}

const overlaps = (a, b) =>
  Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0.5 &&
  Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0.5;

const fmt = (box) =>
  `[${box.left.toFixed(1)}→${box.right.toFixed(1)}, ${box.top.toFixed(1)}→${box.bottom.toFixed(1)}]`;

/** 단추 집합의 기대. DM은 서는 단추가 종류마다 달라 개수 하한만 본다. */
function expectedControls(scene, withPlan, width) {
  const drawer = width < 600 ? ["open-sidebar-drawer"] : [];
  if (scene.kind === "dm") return { min: drawer.length + 2 + (withPlan ? 2 : 0) };
  const base = ["open-pin-list", "channel-member-count", "huddle-start", "channel-title-menu"];
  const dock = withPlan ? ["work-plan-dock", "open-terminal-dock"] : [];
  return { ids: [...drawer, ...dock, ...base] };
}

/** 측정값 → 어긴 항목 문장들. */
function judge(m, ctx) {
  const problems = [];
  const add = (check, text) => problems.push({ check, text });
  const { scene, withPlan, width, fontSize, density } = ctx;

  // 장면이 진짜인가: 속성이 계산된 값에 닿았고, 기대한 단추가 서 있다.
  if (Math.abs(m.typeScale - fontSize.scale) > 0.001) {
    add("scene", `글자 크기 ${fontSize.id}가 --type-scale ${fontSize.scale.toFixed(4)}에 닿지 않았다(읽은 값 ${m.typeScale})`);
  }
  if (Math.abs(m.rowSpacing - density.row) > 0.001) {
    add("scene", `밀도 ${density.id}가 --spacing-row ${density.row}px에 닿지 않았다(읽은 값 ${m.rowSpacing})`);
  }
  if (m.vw !== width) add("scene", `뷰포트 폭이 ${width}이어야 하는데 ${m.vw}`);
  const want = expectedControls(scene, withPlan, width);
  const got = m.controls.map((control) => control.id);
  if (want.ids) {
    const missing = want.ids.filter((id) => !got.includes(id));
    const extra = got.filter((id) => !want.ids.includes(id));
    if (missing.length > 0 || extra.length > 0) {
      add("scene", `단추 집합이 기대와 다르다: 빠짐 ${JSON.stringify(missing)} 더 있음 ${JSON.stringify(extra)}`);
    }
  } else if (got.length < want.min) {
    add("scene", `단추가 ${want.min}개 이상이어야 하는데 ${got.length}개(${got.join(", ")})`);
  }
  if (withPlan && !got.includes("work-plan-dock")) {
    add("scene", "계획 독이 선 장면인데 독이 없다");
  }
  if (scene.ambiguous && !m.handle) add("scene", "핸들 장면인데 구분용 핸들이 서지 않았다");

  // 1. 뷰포트
  for (const control of m.controls) {
    const r = control.rect;
    if (r.left < -0.5 || r.top < -0.5 || r.right > m.vw + 0.5 || r.bottom > m.vh + 0.5) {
      add("viewport", `${control.id} ${fmt(r)}가 뷰포트(${m.vw}×${m.vh}) 밖이다`);
    }
  }

  if (m.handle && (m.handle.right > m.vw + 0.5 || m.handle.left < -0.5)) {
    add("viewport", `handle ${fmt(m.handle)}가 뷰포트 밖이다`);
  }

  // 2. 겹침: 컨트롤끼리, 그리고 컨트롤과 아이콘·제목·토픽·핸들.
  const boxes = [
    ...m.controls.map((control) => ({ id: control.id, rect: control.rect })),
    ...(m.icon ? [{ id: "head-icon", rect: m.icon }] : []),
    ...(m.h1 ? [{ id: "title", rect: m.h1.rect }] : []),
    ...(m.topic ? [{ id: "topic", rect: m.topic }] : []),
    ...(m.handle ? [{ id: "handle", rect: m.handle }] : []),
  ];
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      if (overlaps(boxes[i].rect, boxes[j].rect)) {
        add("overlap", `${boxes[i].id} ${fmt(boxes[i].rect)}와 ${boxes[j].id} ${fmt(boxes[j].rect)}가 겹친다`);
      }
    }
  }

  // 3. 히트 테스트: 눈에 보이는 단추는 실제로 그 자리에서 눌린다.
  for (const control of m.controls) {
    if (control.hits.some((ok) => !ok)) {
      add("hit", `${control.id}의 ${control.hits.map((ok) => (ok ? "o" : "x")).join("")}(가운데·왼쪽·오른쪽) 점이 단추를 짚지 못한다(잘렸거나 덮였다)`);
    }
  }

  // 4. 머리 안쪽 가로 넘침, 문서 가로 넘침.
  if (m.headerOverflow > 1) add("header-overflow", `머리가 가로로 ${m.headerOverflow}px 넘친다(자식이 머리 밖으로 나갔다)`);
  if (m.docOverflow) add("doc-overflow", "문서가 가로로 넘친다");

  // 6. 오른쪽 끝: 가장 오른쪽 컨트롤이 머리 안쪽 오른쪽 끝에 붙는다(줄이 바뀌어도).
  if (m.controls.length > 0) {
    const farRight = Math.max(...m.controls.map((control) => control.rect.right));
    if (Math.abs(farRight - m.headerInnerRight) > 1) {
      add("align", `컨트롤 묶음이 오른쪽 끝에 붙지 않았다: 가장 오른쪽 단추 ${farRight.toFixed(1)}, 머리 안쪽 끝 ${m.headerInnerRight.toFixed(1)}`);
    }
  }

  // 7. 줄바꿈 정책: 컨트롤이 아랫줄로 내려가는 것은 옆에 제목 몫(바닥)이 모자랄 때만이다.
  if (!m.main || !m.body || !m.tools) {
    add("scene", "머리 칸(channel-head-main·body·tools)이 없다");
  } else {
    const separate = m.tools.top >= m.main.bottom - 0.5;
    const room =
      m.headerInnerRight - m.headerInnerLeft - m.tools.width - m.columnGap - (m.body.left - m.headerInnerLeft);
    if (separate && room >= TITLE_FLOOR + 0.5) {
      add("wrap", `컨트롤이 제목 아랫줄로 내려갔는데 옆에 제목 몫 ${room.toFixed(1)}px(바닥 ${TITLE_FLOOR} 이상)이 있었다: 필요 없이 줄을 바꿨다`);
    }
    if (!separate && m.body.width < TITLE_FLOOR - 0.5) {
      add("wrap", `컨트롤이 제목 옆에 섰는데 제목 칸이 바닥 밑이다: ${m.body.width.toFixed(1)}px < ${TITLE_FLOOR}`);
    }
  }

  // 5. 제목.
  if (!m.h1) {
    add("title", "머리에 제목(h1)이 없다");
  } else {
    const h1 = m.h1;
    if (h1.text !== scene.name && scene.kind !== "dm") {
      add("title", `제목의 글이 이름 전문이 아니다: ${JSON.stringify(h1.text)}`);
    }
    if (h1.title !== h1.text && scene.kind !== "dm") {
      add("title", `전문 툴팁(title)이 없거나 다르다: ${JSON.stringify(h1.title)}`);
    }
    if (scene.kind === "dm" && !(h1.title && h1.title.length > 0)) {
      add("title", "DM 제목에 전문 툴팁(title)이 없다");
    }
    if (h1.rect.height > h1.lineHeight * 1.5) {
      add("title", `제목이 한 줄이 아니다(높이 ${h1.rect.height.toFixed(1)} > 줄 ${h1.lineHeight})`);
    }
    if (h1.rect.width < 32) {
      add("title", `제목이 바닥(32px) 밑으로 줄었다: ${h1.rect.width.toFixed(1)}px`);
    }
    if (width === 1440 && h1.scrollWidth > h1.clientWidth + 1) {
      add("title", `1440에서 이름이 들어갈 자리가 있는데 제목이 잘렸다(${h1.scrollWidth} > ${h1.clientWidth})`);
    }
  }
  return problems;
}

async function settle(page) {
  await page.evaluate(
    () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => done())))
  );
}

/** 한 장면(이름 종류 × 독 유무)이 훑을 상태 목록: 표의 폭은 글자 크기 3 × 밀도 3 전부, 훑기 폭은 두 극단만. */
function statesToMeasure() {
  const list = [];
  const widths = [...new Set([...WIDTHS, ...SWEEP_WIDTHS])].sort((a, b) => a - b);
  for (const width of widths) {
    const inTable = WIDTHS.includes(width);
    for (const fontSize of FONT_SIZES) {
      for (const density of DENSITIES) {
        const extreme =
          (fontSize.id === "default" && density.id === "comfortable") ||
          (fontSize.id === "larger" && density.id === "spacious");
        if (inTable || extreme) list.push({ width, fontSize, density, inTable });
      }
    }
  }
  return list;
}

async function sweepScene(page, scene, withPlan, engineName, report) {
  const label = `${engineName} · ${scene.id} · 독 ${withPlan ? "있음" : "없음"}`;
  let measuredCount = 0;
  let failedStates = 0;
  /** 항목별로 그 항목을 어긴 장면 수(한 장면은 항목마다 한 번만 센다). */
  const failedByCheck = new Map();
  for (const { width, fontSize, density, inTable } of statesToMeasure()) {
    await page.setViewportSize({ width, height: HEIGHT });
    await page.evaluate(
      ({ fontSizeId, densityId }) => {
        const root = document.documentElement;
        root.setAttribute("data-font-size", fontSizeId);
        root.setAttribute("data-density", densityId);
      },
      { fontSizeId: fontSize.id, densityId: density.id }
    );
    await settle(page);
    const measured = await page.evaluate(measureInPage);
    const problems = judge(measured, { scene, withPlan, width, fontSize, density });
    measuredCount += 1;
    if (problems.length > 0) {
      failedStates += 1;
      for (const check of new Set(problems.map((problem) => problem.check))) {
        failedByCheck.set(check, (failedByCheck.get(check) ?? 0) + 1);
      }
      for (const problem of problems) {
        report.failures.push({
          label,
          state: `${width}px · 글자 ${fontSize.id} · 밀도 ${density.id}`,
          ...problem,
        });
      }
    }
    if (shotsDir && inTable && fontSize.id === "default" && density.id === "comfortable") {
      const dir = resolve(shotsDir, engineName);
      mkdirSync(dir, { recursive: true });
      await page.screenshot({
        path: resolve(dir, `${scene.id.replace(/\+/g, "-")}-${withPlan ? "dock" : "nodock"}-${width}-${scheme}.png`),
        clip: { x: 0, y: 0, width, height: Math.min(HEIGHT, Math.ceil(measured.header.bottom + 24)) },
      });
    }
  }
  report.states += measuredCount;
  report.failedStates += failedStates;
  const detail = [...failedByCheck.entries()]
    .map(([check, count]) => `${check} ${count}`)
    .join(", ");
  report.perScene.push(
    `${label}: ${measuredCount - failedStates}/${measuredCount} 통과${detail ? ` (어긴 장면 수: ${detail})` : ""}`
  );
}

async function main() {
  const dist = distOverride ?? resolve(webRoot, "dist");
  if (!existsSync(resolve(dist, "index.html"))) {
    throw new Error(
      `${dist}/index.html is missing. Run npm run build first (or point HEADER_FIT_GATE_DIST at a build).`
    );
  }
  for (const name of engineNames) {
    if (!(name in ENGINES)) throw new Error(`unknown engine ${JSON.stringify(name)} (chromium | webkit)`);
  }
  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "HEADER_FIT_GATE_PORT",
    extraArgs: distOverride ? ["--outDir", distOverride] : [],
  });
  const report = { states: 0, failedStates: 0, failures: [], perScene: [] };
  try {
    for (const engineName of engineNames) {
      const browser = await ENGINES[engineName].launch();
      try {
        for (const scene of SCENES) {
          for (const withPlan of [false, true]) {
            const { context, page } = await openScene(browser, scene, withPlan);
            try {
              await sweepScene(page, scene, withPlan, engineName, report);
            } finally {
              await context.close();
            }
          }
        }
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.stop();
  }

  // 장면 수 자체를 못 박는다: 센 것이 적으면 아래 판정이 비어 늘 초록이다.
  const sceneRuns = SCENES.length * 2;
  const expectedStates = engineNames.length * sceneRuns * statesToMeasure().length;
  if (report.states !== expectedStates) {
    throw new Error(`쟀어야 할 장면은 ${expectedStates}개인데 ${report.states}개를 쟀다`);
  }

  if (report.failures.length > 0) {
    const byCheck = new Map();
    for (const failure of report.failures) {
      byCheck.set(failure.check, (byCheck.get(failure.check) ?? 0) + 1);
    }
    console.error(
      `GATE FAIL: 장면 ${report.states}개 중 ${report.failedStates}개가 어겼다 ` +
        `(항목별 ${[...byCheck.entries()].map(([check, count]) => `${check} ${count}`).join(", ")})`
    );
    for (const line of report.perScene) console.error(`  ${line}`);
    const shown = new Map();
    for (const failure of report.failures) {
      const seen = shown.get(failure.check) ?? 0;
      if (seen >= 4) continue;
      shown.set(failure.check, seen + 1);
      console.error(`  - [${failure.check}] ${failure.label} · ${failure.state}: ${failure.text}`);
    }
    process.exit(1);
  }
  for (const line of report.perScene) console.log(`  ${line}`);
  console.log(
    `GATE PASS: 장면 ${report.states}개(엔진 ${engineNames.join("·")})에서 머리의 모든 컨트롤이 뷰포트 안이고, ` +
      "서로·아이콘·제목·토픽과 겹치지 않으며, 그 자리에서 눌린다. 제목은 한 줄 말줄임이고 전문은 글과 툴팁에 남는다."
  );
}

main().catch((error) => {
  const message = String(error.message ?? error);
  console.error(message.startsWith("GATE FAIL:") ? message : `GATE FAIL: ${message}`);
  process.exit(1);
});
