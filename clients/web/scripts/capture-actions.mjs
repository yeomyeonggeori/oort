#!/usr/bin/env node
// =============================================================================
// CAPTURE: 워크스페이스 행동 카드 4장면 (AX-4 #2510 / ADR-0186 D4·D5)
//
// 1280 light + 390 dark. 찍는 것은 이 배치가 세운 카드의 생애 전부다:
//
//   pending        제안이 도착했다 — 행·사유·결정 권한이 카드 표면에 있다(부록 A)
//   link-once      승인 확정 직후, 버튼이 있던 자리에 링크가 선다(부록 C · ADR-0182 ①)
//   result         새로고침 뒤 남는 것 — 값 없는 영속 카드(부록 B)
//   role-required  403 — 「관리자가 승인해야 합니다」와 다음 행동(§5)
//
// ## 왜 `capture-screens.mjs` 에 얹지 않았는가
//
// 그 스크립트의 채널 픽스처는 순환 배열이라(`BODIES[i % BODIES.length]`) 행을
// 더하면 꼬리에서 상태를 골라 쓰는 다른 프레임들의 자리가 통째로 밀린다 —
// `capture-handoff.mjs` 가 같은 이유로 자기 파일을 갖는다. 그리고 link-once 장면은
// **시간이 흘러야** 한다: `CONFIRM_GUARD_MS` 는 무장 뒤 400ms 를 기다리고, 저쪽
// 레인은 `Date` 를 얼려 두어 시간 게이트를 여는 장면을 아예 금지한다
// (`capture-clock.mjs`). 여기서는 시계를 얼리지 않으므로 그 문이 정상적으로 열린다.
//
// ## 서버는 아직 없다
//
// AX-3a/3b 가 랜딩하기 전이라 REST 는 **ADR-0186 부록 A·B·C 샘플 JSON** 으로
// 채운다. 부록이 지금의 계약이고, 랜딩 뒤 실샘플로 갈아 끼우는 자리가 여기다.
//
//   npm run build && node scripts/capture-actions.mjs
//   OUT_DIR=/tmp/shots node scripts/capture-actions.mjs
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.ACTIONS_CAPTURE_PORT || 5197);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/actions");
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const CHANNEL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f9a01-0000-7000-8000-000000000401";
const APPROVAL_ID = "0199aa11-2222-7000-8000-0000000000a1";
const INVITE_ID = "0199aa11-2222-7000-8000-0000000000f1";
const BASE_MS = Date.parse("2026-09-22T05:12:00.000Z");

const SESSION = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  realtimeWebSocketUrl: "ws://actions-capture.invalid/connection/websocket",
};

const CHANNELS = [
  {
    id: CHANNEL_ID,
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "온보딩",
    muted: false,
  },
];

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: HERMES,
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "hermes",
    handle: "hermes",
    ownerMemberId: ME,
    channelCount: 1,
    channelIds: [CHANNEL_ID],
    capabilities: ["code"],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

/** ADR-0186 부록 A 그대로. */
const APPROVAL_PROPS = {
  approval_id: APPROVAL_ID,
  run_id: "0199aa11-2222-7000-8000-0000000000b2",
  channel_id: CHANNEL_ID,
  action_type: "workspace_action",
  status: "pending",
  expires_at_ms: BASE_MS + 3_600_000,
  title: "팀원 초대 링크 만들기",
  summary:
    "hermes가 제안했습니다. 승인하면 관리자 권한으로 초대 링크를 만듭니다.",
  action: {
    id: "invite.create",
    rows: [
      { label: "역할", value: "member" },
      { label: "사용 횟수", value: "1회" },
      { label: "만료", value: "7일" },
    ],
    rationale: "새 팀원 온보딩 요청",
    required_role: "admin",
  },
};

/** ADR-0186 부록 B 그대로. `next.href` 는 이 클라이언트에 실물이 있는 섹션이다. */
function actionResultProps(over = {}) {
  return {
    "momo.action_result": {
      v: 1,
      action_id: "invite.create",
      status: "executed",
      approval_id: APPROVAL_ID,
      decided_by: ME,
      ref: { type: "invite", id: INVITE_ID },
      rows: [
        { label: "역할", value: "member" },
        { label: "만료", value: "2026-09-29" },
      ],
      secret_shown_once: true,
      // 부록 B 원문(R1 H1). 이 빌드에 `invites` 섹션은 없으므로 문이 서지
      // 않는 것이 참이고, 아래 장면 ③이 그 fail-closed 를 잰다.
      next: {
        label: "설정 › 초대에서 보기",
        href: "/settings?section=invites",
      },
      ...over,
    },
  };
}

/** ADR-0186 부록 C 그대로. 승인 성공에만 실린다. */
const SECRET_VALUE = "https://oort.example/join?code=Ab3-_xQ7mK";

const DECISION_OK = {
  approval_id: APPROVAL_ID,
  status: "approved",
  decided_by: ME,
  decided_at_ms: BASE_MS + 180_000,
  result: {
    actionId: "invite.create",
    ref: { type: "invite", id: INVITE_ID },
    secretOnce: {
      kind: "invite_link",
      value: SECRET_VALUE,
      expiresAtMs: BASE_MS + 604_800_000,
    },
  },
};

const MESSAGES = [
  {
    author: ME,
    type: "text",
    body: "@hermes 다음 주 합류하는 디자이너 초대 링크 하나 만들어 주세요.",
  },
  {
    author: HERMES,
    type: "approval_request",
    body: "팀원 초대 링크 만들기",
    props: APPROVAL_PROPS,
  },
];

/** 영속 카드는 별도 픽스처다 — 대기 장면과 같은 화면에 두면 둘 다 반쯤 보인다. */
const RESULT_MESSAGES = [
  {
    author: ME,
    type: "text",
    body: "@hermes 다음 주 합류하는 디자이너 초대 링크 하나 만들어 주세요.",
  },
  {
    author: HERMES,
    type: "tool_result",
    body: "초대 링크를 만들었습니다.",
    props: actionResultProps(),
  },
  {
    author: HERMES,
    type: "tool_result",
    body: "웹훅은 만들지 않았습니다.",
    props: actionResultProps({
      action_id: "webhook.create",
      status: "rejected",
      secret_shown_once: false,
      rows: [{ label: "대상", value: "배포 알림" }],
      // 실재하는 섹션 — 같은 프레임에 「문이 서는 카드」와 「서지 않는 카드」가
      // 함께 있어야 fail-closed 가 사진으로 읽힌다.
      next: { label: "설정 › 웹훅에서 보기", href: "/settings?section=webhooks" },
    }),
  },
];

function rows(list) {
  return list.map((row, index) => ({
    id: `actions-capture-${index + 1}`,
    channelId: CHANNEL_ID,
    seq: 2100 + index,
    hlcTs: BASE_MS + index * 60_000,
    hlcCount: 0,
    authorMemberId: row.author,
    type: row.type,
    body: row.body,
    state: "sent",
    ...(row.props ? { props: row.props } : {}),
    createdAtMs: BASE_MS + index * 60_000,
  }));
}

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function installMocks(context, { messages, decisionStatus }) {
  await context.route("**/v1/**", (route) =>
    json(route, { channels: [], members: [], read_states: [], messages: [] })
  );
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/auth/refresh", (route) =>
    json(route, {
      accessToken: SESSION.accessToken,
      refreshToken: SESSION.refreshToken,
    })
  );
  await context.route("**/v1/auth/realtime-token", (route) =>
    json(route, {
      token: "capture-only-not-a-credential",
      tokenType: "jwt",
      expiresAtMs: Date.now() + 60_000,
      ttlSeconds: 60,
      workspaceId: WORKSPACE_ID,
      memberId: ME,
    })
  );
  await context.route("**/v1/workspaces/*/channels", (route) =>
    json(route, { channels: CHANNELS })
  );
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, { members: ROSTER })
  );
  const readStates = [
    {
      channel_id: CHANNEL_ID,
      last_read_seq: 2105,
      latest_seq: 2105,
      unread_count: 0,
      mention_count: 0,
    },
  ];
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: readStates })
  );
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, readStates[0])
  );
  // 허들 404 는 셸에 붉은 줄을 세운다. 사진에서 그 줄이 카드보다 먼저 눈에
  // 들어오면 증거가 자기 일을 못 한다(`capture-handoff.mjs` 와 같은 이유).
  await context.route("**/v1/workspaces/*/channels/*/huddles/active", (route) =>
    json(route, { huddle: null, participants: [] })
  );
  // 결정. 200 이면 부록 C 를 그대로 돌려주고, 403 이면 영수증 스키마에 여전히
  // `pending` 인 승인을 싣는다(§5: 「approval 은 여전히 pending 이다」).
  await context.route("**/v1/workspaces/*/approvals/*/decision", (route) =>
    decisionStatus === 403
      ? json(route, { approval_id: APPROVAL_ID, status: "pending" }, 403)
      : json(route, DECISION_OK)
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) =>
    json(route, { messages: rows(messages) })
  );
}

async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) {
      throw new Error(`preview server never came up: ${url}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function openChannel(context) {
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
  // 주소로 간다. 390 에서 사이드바는 닫힌 서랍이라 목록의 줄을 누를 수 없다.
  await page.evaluate(
    (id) => {
      location.hash = `/c/${id}`;
    },
    CHANNEL_ID
  );
  await page.getByTestId("agent-card").first().waitFor({ state: "visible" });
  return page;
}

/**
 * 무장 → 시간 게이트(400ms) → 확정. 이 레인은 시계를 얼리지 않으므로 열린다.
 *
 * **키보드로 민다** (design-review R2 H-R2-1). 포인터로 확정하면 착지한 요소가
 * `:focus-visible` 에 걸리지 않아 링이 그려지지 않고, 그러면 이 배치가 새로 연
 * 두 키보드 정거장(성공 착지·403 착지)의 링을 사진으로도 실측으로도 잴 수 없다.
 * 가드는 우회하지 않는다: 무장 뒤 600ms 를 기다리고, Enter 는 한 번씩만 누른다
 * (반복 keydown 은 `ApprovalActions` 가 거절한다).
 */
async function decide(page) {
  await page.getByTestId("approval-approve").first().focus();
  await page.keyboard.press("Enter");
  await page.getByTestId("approval-commit").first().waitFor({ state: "visible" });
  await page.waitForTimeout(600);
  await page.keyboard.press("Enter");
}

/** 크로미움 UA 기본 포커스 링. 이 팔레트 밖 색이다(§2.2 한 액센트). */
const UA_FOCUS_BLUE = ["rgb(0, 95, 204)", "rgb(153, 200, 255)"];

/**
 * 키보드가 내려앉은 자리의 링을 잰다 (R2 H-R2-1).
 *
 * 사진만으로는 「링이 있다」와 「링이 house 것이다」가 구별되지 않는다 — R2 가
 * 잡은 결함이 정확히 그 차이였다: 403 착지에 링은 있었고, 그 링이 크로미움의
 * 파란색이었다. 그래서 계산값을 읽는다.
 */
async function measureRing(page, label) {
  const ring = await page.evaluate(() => {
    const el = document.activeElement;
    if (el === null || el === document.body) return null;
    const style = getComputedStyle(el);
    return {
      testId: el.getAttribute("data-testid") ?? el.tagName.toLowerCase(),
      inCard: el.closest('[data-testid="agent-card"]') !== null,
      focusVisible: el.matches(":focus-visible"),
      width: style.outlineWidth,
      style: style.outlineStyle,
      color: style.outlineColor,
      name: el.getAttribute("aria-label") ?? el.getAttribute("aria-labelledby"),
      accent: getComputedStyle(document.documentElement)
        .getPropertyValue("--accent")
        .trim(),
    };
  });
  if (ring === null) {
    throw new Error(`${label}: 초점이 body 로 떨어졌다`);
  }
  if (!ring.inCard) {
    throw new Error(`${label}: 초점이 카드 밖이다 (${ring.testId})`);
  }
  if (!ring.focusVisible) {
    throw new Error(
      `${label}: 키보드로 밀었는데 :focus-visible 이 아니다 (${ring.testId})`
    );
  }
  if (ring.style !== "solid" || ring.width !== "2px") {
    throw new Error(
      `${label}: 링이 house 모양이 아니다 (${ring.width} ${ring.style}) — UA 기본은 auto 1px`
    );
  }
  if (UA_FOCUS_BLUE.includes(ring.color)) {
    throw new Error(`${label}: UA 기본 파란 링이다 (${ring.color})`);
  }
  console.log(
    `  ${label}: 착지 [${ring.testId}] 링 ${ring.width} ${ring.style} ${ring.color} (--accent ${ring.accent})`
  );
  return ring;
}

/** 한 프레임 안의 두 정거장이 같은 링을 드는지. 서로 다르면 카드가 두 색이다. */
function assertSameRing(a, b) {
  if (a.color !== b.color || a.width !== b.width || a.style !== b.style) {
    throw new Error(
      `두 키보드 정거장의 링이 다르다: ${a.testId} ${a.width} ${a.color} vs ` +
        `${b.testId} ${b.width} ${b.color}`
    );
  }
}

async function shoot(browser, { name, scheme, viewport, drive, after, rings, ...mocks }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context, mocks);
  const page = await openChannel(context);
  const label = `${name} ${viewport.width}-${scheme}`;
  await drive(page, { label, rings });
  const path = `${OUT_DIR}/action-${name}-${viewport.width}-${scheme}.png`;
  await page.screenshot({ path });
  // 사진 뒤의 단정. 화면을 바꾸는 검사(새로고침)는 프레임을 더럽히면 안 된다.
  if (after) await after(page, { label });
  await context.close();
  return path;
}

/**
 * 1회 값이 **새로고침을 견디지 않는가** — 제품 수준 단정 (design-review R1 M8).
 *
 * 단위 시험은 bare `AgentCard` 를 재마운트한다. 거기에는 타임라인 스토어도
 * react-query 도 IndexedDB 도 없어서, 그 층 중 하나가 값을 적어 두는 구현을
 * 잡을 수 없다 — 「스토어 초기화」라는 조건을 실제로는 밟지 않는다. 여기서는
 * **secret 이 실제로 실린 화면**에서 진짜 `reload()` 를 걸고 잰다.
 *
 * 재는 자리는 넷이다: 렌더 DOM · localStorage · sessionStorage · IndexedDB.
 * 앞 판의 누출 검사는 secret 이 실린 적 없는 픽스처(장면 ③) 위에서 돌아 아무것도
 * 증명하지 못했다.
 */
async function assertSecretDiesOnReload(page, label) {
  const before = await page.evaluate(
    (secret) => document.body.innerText.includes(secret),
    SECRET_VALUE
  );
  if (!before) {
    throw new Error(`${label}: 새로고침 전에 링크가 화면에 없다 — 잴 것이 없다`);
  }
  await page.reload({ waitUntil: "networkidle" });
  await page.getByTestId("agent-card").first().waitFor({ state: "visible" });
  const after = await page.evaluate(async (secret) => {
    const hay = [
      document.body.innerText,
      document.documentElement.outerHTML,
      location.href,
    ].join("\n");
    const store = (s) => {
      const out = [];
      try {
        for (let i = 0; i < s.length; i += 1) {
          const k = s.key(i);
          out.push(`${k}=${s.getItem(k) ?? ""}`);
        }
      } catch {
        /* blocked storage answers nothing, which is also not a leak */
      }
      return out.join("\n");
    };
    let idb = "";
    try {
      const dbs = (await indexedDB.databases?.()) ?? [];
      idb = JSON.stringify(dbs);
      for (const { name } of dbs) {
        if (!name) continue;
        idb += await new Promise((resolve) => {
          const req = indexedDB.open(name);
          req.onerror = () => resolve("");
          req.onsuccess = () => {
            const db = req.result;
            const names = [...db.objectStoreNames];
            if (names.length === 0) {
              db.close();
              return resolve("");
            }
            const tx = db.transaction(names, "readonly");
            let seen = "";
            let left = names.length;
            for (const store of names) {
              const all = tx.objectStore(store).getAll();
              all.onsuccess = () => {
                seen += JSON.stringify(all.result);
                left -= 1;
                if (left === 0) {
                  db.close();
                  resolve(seen);
                }
              };
              all.onerror = () => {
                left -= 1;
                if (left === 0) {
                  db.close();
                  resolve(seen);
                }
              };
            }
          };
        });
      }
    } catch {
      idb = "";
    }
    const haystacks = {
      dom: hay,
      localStorage: store(localStorage),
      sessionStorage: store(sessionStorage),
      indexedDB: idb,
    };
    const leaks = Object.entries(haystacks)
      .filter(([, text]) => text.includes(secret) || text.includes("code="))
      .map(([where]) => where);
    return {
      leaks,
      linkNodes: document.querySelectorAll('[data-testid="approval-link-once"]')
        .length,
    };
  }, SECRET_VALUE);

  if (after.leaks.length > 0 || after.linkNodes > 0) {
    throw new Error(
      `${label}: 새로고침 뒤 1회 값이 남아 있다 (${after.leaks.join(", ")}` +
        `${after.linkNodes > 0 ? ", link 노드 " + after.linkNodes : ""}) — ADR-0186 D4 위반`
    );
  }
  console.log(`  ${label}: reload 뒤 DOM·localStorage·sessionStorage·IDB 전부 0`);
}

/** 390 에서 1회 값이 말줄임에 먹히지 않는가 (design-review R1 B1). */
async function assertSecretNotClipped(page, label) {
  const box = await page
    .getByTestId("approval-link-once-value")
    .evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      overflow: getComputedStyle(el).textOverflow,
      text: el.textContent ?? "",
    }));
  if (box.scrollWidth > box.clientWidth) {
    throw new Error(
      `${label}: 1회 값이 잘린다 (scrollWidth ${box.scrollWidth} > clientWidth ${box.clientWidth})`
    );
  }
  if (!box.text.endsWith(SECRET_VALUE.slice(-6))) {
    throw new Error(`${label}: 값의 꼬리가 DOM 에 없다 (${box.text})`);
  }
  console.log(
    `  ${label}: 링크 값 ${box.scrollWidth}/${box.clientWidth} (잘림 0), 꼬리 ${SECRET_VALUE.slice(-6)} 가시`
  );
}

/** 카드를 뷰포트 위쪽에 세운다. 최소 이동은 카드를 바닥의 칩 아래로 민다. */
async function raise(page, testId) {
  await page
    .locator(`[data-testid="${testId}"]`)
    .first()
    .evaluate((el) => el.scrollIntoView({ block: "start", behavior: "auto" }));
  await page.waitForTimeout(300);
}

async function captureFrame(browser, frame) {
  const shots = [];
  // 한 프레임(폭×스킴) 안에서 두 키보드 정거장의 링을 모아 서로 비교한다.
  const rings = {};

  // ① 대기 — 행·사유·결정 권한이 카드 표면에 있다(부록 A).
  shots.push(
    await shoot(browser, {
      ...frame,
      rings,
      name: "pending",
      messages: MESSAGES,
      drive: async (page) => {
        await page
          .getByTestId("approval-action-role")
          .waitFor({ state: "visible" });
        const rowCount = await page
          .locator('[data-testid="approval-action-row"]')
          .count();
        if (rowCount !== 3) {
          throw new Error(`행동 행이 ${rowCount}개다 — 부록 A 는 셋이다`);
        }
        await raise(page, "agent-card");
      },
    })
  );

  // ② 승인 직후 — 버튼이 있던 자리에 링크(ADR-0182 ① · 부록 C).
  shots.push(
    await shoot(browser, {
      ...frame,
      rings,
      name: "link-once",
      messages: MESSAGES,
      drive: async (page, { label, rings }) => {
        await decide(page);
        await page.getByTestId("approval-link-once").waitFor({ state: "visible" });
        // 초점이 카드 안에 남고(R1 H2), 그 자리의 링이 house 것인가(R2 H-R2-1).
        rings.settled = await measureRing(page, `${label} 성공 착지`);
        if (rings.settled.testId !== "approval-link-once") {
          throw new Error(
            `${label}: 확정 뒤 착지가 ${rings.settled.testId} 다 — 링크 그룹이어야 한다`
          );
        }
        await assertSecretNotClipped(page, label);
        await raise(page, "agent-card");
      },
      after: async (page, { label }) => {
        // 사진을 찍은 **뒤에** 새로고침을 건다 — 장면은 링크가 선 화면이고,
        // 이 단정은 그 화면이 아무것도 남기지 않았다는 사실이다.
        await assertSecretDiesOnReload(page, label);
      },
    })
  );

  // ③ 영속 — 새로고침 뒤 남는 것. **값이 없다**(D4).
  shots.push(
    await shoot(browser, {
      ...frame,
      rings,
      name: "result",
      messages: RESULT_MESSAGES,
      drive: async (page, { label }) => {
        await page
          .getByTestId("action-result-secret-once")
          .waitFor({ state: "visible" });
        // 문은 **도착할 수 있을 때만** 선다 (R1 H1). 첫 카드의 `next.href` 는
        // 부록 B 원문 `?section=invites` 이고 이 빌드에 그 섹션은 없다;
        // 둘째 카드는 실재하는 `?section=webhooks` 라 문이 선다. 한 프레임에서
        // 두 규칙이 같이 보인다.
        const doors = await page
          .locator('[data-testid="action-result-next"]')
          .evaluateAll((els) => els.map((el) => el.getAttribute("href")));
        if (doors.length !== 1 || doors[0] !== "#/settings?section=webhooks") {
          throw new Error(
            `${label}: 문이 ${JSON.stringify(doors)} 다 — 모르는 섹션에 문이 서거나 아는 섹션에 문이 없다`
          );
        }
        await raise(page, "agent-card");
      },
    })
  );

  // ④ role_required — 사고가 아니라 안내다(§5).
  shots.push(
    await shoot(browser, {
      ...frame,
      rings,
      name: "role-required",
      messages: MESSAGES,
      decisionStatus: 403,
      drive: async (page, { label, rings }) => {
        await decide(page);
        const banner = page.getByTestId("approval-error").first();
        await banner.waitFor({ state: "visible" });
        const tone = await banner.getAttribute("data-tone");
        if (tone !== "unavailable") {
          throw new Error(`${label}: 403 배너의 격이 ${tone} 이다 — 사고가 아니라 안내다`);
        }
        // 성공할 수 없는 채움 버튼이 남지 않는다 (R1 M1), 초점은 **이름과 링을
        // 가진 카드**에 앉는다 (R1 H2 · R2 H-R2-1 · N-R2-2).
        rings.forbidden = await measureRing(page, `${label} 403 착지`);
        if (rings.forbidden.testId !== "agent-card") {
          throw new Error(
            `${label}: 403 착지가 ${rings.forbidden.testId} 다 — 이름 없는 컨테이너다`
          );
        }
        if (!rings.forbidden.name) {
          throw new Error(`${label}: 403 착지에 접근성 이름이 없다`);
        }
        if (rings.settled !== undefined) {
          assertSameRing(rings.settled, rings.forbidden);
          console.log(
            `  ${label}: 두 정거장의 링이 같다 (${rings.forbidden.width} ${rings.forbidden.color})`
          );
        }
        const after = await page.evaluate(() => ({
          commits: document.querySelectorAll('[data-testid="approval-commit"]')
            .length,
          approves: document.querySelectorAll('[data-testid="approval-approve"]')
            .length,
          focusInCard:
            document.activeElement?.closest('[data-testid="agent-card"]') !== null,
        }));
        if (after.commits !== 0) {
          throw new Error(`${label}: 403 뒤에도 「승인 확정」이 ${after.commits}개 남았다`);
        }
        if (after.approves !== 1) {
          throw new Error(`${label}: 403 뒤 승인 버튼이 ${after.approves}개다 — 카드는 여전히 대기다`);
        }
        if (!after.focusInCard) {
          throw new Error(`${label}: 403 뒤 초점이 카드 밖으로 떨어졌다`);
        }
        await raise(page, "agent-card");
      },
    })
  );

  return shots;
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run build` first.");
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const server = spawn(
    resolve(WEB_ROOT, "node_modules/.bin/vite"),
    ["preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: WEB_ROOT, stdio: "ignore" }
  );
  const shutdown = () => server.kill("SIGTERM");
  process.on("exit", shutdown);

  try {
    await waitForServer(ORIGIN);
    const browser = await chromium.launch();
    try {
      const all = [];
      for (const frame of [
        { scheme: "light", viewport: DESKTOP },
        { scheme: "dark", viewport: PHONE },
      ]) {
        all.push(...(await captureFrame(browser, frame)));
      }
      for (const path of all) console.log(path);
    } finally {
      await browser.close();
    }
  } finally {
    shutdown();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
