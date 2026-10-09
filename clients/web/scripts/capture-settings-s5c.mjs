#!/usr/bin/env node
// =============================================================================
// 설정 S5c 캡처 (#3622, 에픽 #3578): 사용량 · AI 허브 링크 행 · 대화상자 해요체 정리.
//
//   npm run build && OUT_DIR=<폴더> node scripts/capture-settings-s5c.mjs
//
// 진짜 앱 셸을 Chromium으로 연다. `/v1/**`는 고정 응답(사용량·잔여량은 계약 픽스처
// `usageFixtures.json`·`quotaFixtures.json`, 시험과 같은 파일), 실시간 소켓은 곧바로 연결되는
// 흉내. 사용량은 멤버라면 누구나 읽는 면이라 403 장면이 없다(서버가 운영자 권한을 요구하지
// 않는다; 보고서에 N/A로 남긴다).
//
// 모든 장면은 **기다리는 값이 기대 상태**다: 다른 상태이면 시간 초과로 실패하고
// `FAIL-<장면>.png`를 남긴다. 장면마다 라이트/다크 × 1440/390.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/settings-s5c");
const PORT = Number(process.env.CAPTURE_PORT || 5199);

const USAGE = JSON.parse(readFileSync(resolve(WEB_ROOT, "src/features/settings/usageFixtures.json"), "utf8"));
const QUOTA = JSON.parse(readFileSync(resolve(WEB_ROOT, "src/features/settings/quotaFixtures.json"), "utf8"));

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "엔진", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://settings-s5c-capture.invalid/connection/websocket",
};
/** 에이전트별 줄의 이름은 명부가 정한다. 같은 표시 이름 둘(사람 @intern-kim, 에이전트 @kim-intern)이 핸들을 붙이는 이유다. */
function roster() {
  const base = (id, kind, displayName, handle, extra = {}) => ({
    id, workspaceId, kind, status: "active", role: "member", displayName, handle, channelCount: 1,
    channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0, ...extra,
  });
  return [
    base(memberId, "human", "곽성재", "seongjae", { role: "owner" }),
    base("019F94E3-7B0F-7A22-9C13-4D5E6F708192", "human", "김인턴", "intern-kim"),
    base("019F94E3-8B21-7AE0-B3C4-5F1A2D6E7C90", "agent", "김인턴", "kim-intern", { ownerHumanId: memberId, agentModel: "claude-opus-5" }),
    base("019F94E3-9C32-7BF1-A4D5-6E2B3C7D8E01", "agent", "hermes", "hermes", { ownerHumanId: memberId, agentModel: "gpt-5.6-sol" }),
  ];
}
/** 쿼터 픽스처는 절대 시각을 담는다. 오늘로 밀어야 「오늘 22:00 리셋」 같은 상대 문구가 날짜가 지나도 같다. */
function anchoredQuota(fixture) {
  const shift = Date.now() - Date.parse(QUOTA._anchor);
  const move = (iso) => (typeof iso === "string" && !Number.isNaN(Date.parse(iso)) ? new Date(Date.parse(iso) + shift).toISOString() : iso);
  return {
    ...fixture,
    observedAt: move(fixture.observedAt),
    snapshots: fixture.snapshots.map((row) => ({ ...row, resetsAt: row.resetsAt === null ? null : move(row.resetsAt), probedAt: move(row.probedAt), ingestedAt: move(row.ingestedAt) })),
  };
}
const WORKSPACE = {
  id: workspaceId, slug: "yeomyeong", name: "여명거리", updatedAtMs: 1_760_000_000_000,
  roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: false,
};

const failures = [];
const report = { scenes: [], checks: [], notApplicable: ["사용량 403: 멤버라면 누구나 읽는 면이라 서버가 운영자 권한을 요구하지 않는다(OperatorNotice 없음)"] };
function check(name, ok, detail) {
  report.checks.push({ name, ok, detail });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? `  ${JSON.stringify(detail)}` : ""}`);
  if (!ok) failures.push(name);
}
const json = (route, body, status = 200) =>
  route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const denied = (route) => json(route, { error: { code: "forbidden", message: "operator required" } }, 403);
const down = (route) => json(route, { error: { code: "unavailable", message: "잠시 후 다시 시도해 주세요." } }, 503);
const hang = () => new Promise(() => {});

async function installRoutes(context, cfg) {
  let usageServed = 0;
  await context.route("**/v1/**", async (route) => {
    const req = route.request();
    const path = new URL(req.url()).pathname;
    const method = req.method();
    if (path === "/v1/auth/login") return json(route, auth);
    if (path === "/v1/auth/refresh") return json(route, { accessToken: auth.accessToken, refreshToken: auth.refreshToken });
    if (path === "/v1/auth/realtime-token") {
      return json(route, { token: "capture", tokenType: "Bearer", expiresAtMs: Date.now() + 600_000, ttlSeconds: 60, workspaceId, memberId });
    }
    if (path === "/v1/workspaces" && method === "POST") {
      if (cfg.create === "403") return denied(route);
      return json(route, { workspaceId: "00000000-0000-7000-8000-000000000999", slug: "new-team", name: "새 팀" }, 201);
    }
    if (path.endsWith("/usage/summary")) {
      usageServed += 1;
      if (cfg.usage === "hang") return hang();
      if (cfg.usage === "404") return json(route, {}, 404);
      if (cfg.usage === "503") return down(route);
      // 처음 한 번만 답하고 그 뒤로는 실패: 「마지막 확인값」 장면이 이 순서에서 나온다.
      if (cfg.usage === "once-then-503") return usageServed === 1 ? json(route, USAGE.normal) : down(route);
      if (cfg.usage === "empty") return json(route, USAGE.emptyPeriod);
      if (cfg.usage === "hard") return json(route, USAGE.budgetHardLimit);
      return json(route, USAGE.normal);
    }
    if (path.endsWith("/provider/quota-snapshots")) {
      if (cfg.quota === "hang") return hang();
      if (cfg.quota === "404") return json(route, {}, 404);
      if (cfg.quota === "near") return json(route, anchoredQuota(QUOTA.nearLimit));
      if (cfg.quota === "stale") return json(route, anchoredQuota(QUOTA.staleSnapshot));
      if (cfg.quota === "absent") return json(route, anchoredQuota(QUOTA.absent));
      return json(route, anchoredQuota(QUOTA.healthy));
    }
    if (path.endsWith("/provider/link")) {
      return json(route, { schema: "momo.provider_link.v0", configured: false, source: "environment", mode: "local-mock", baseUrl: "http://mock", endpointLabel: "mock", bearerConfigured: false, availability: "mock", keyConfigured: false, diagnostics: [] });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster() });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-hosts")) return json(route, { workHosts: [] });
    if (path.endsWith(`/workspaces/${workspaceId}`)) return json(route, { workspace: WORKSPACE });
    if (path.includes("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function installRealtime(page) {
  await page.addInitScript(() => {
    class CaptureSocket {
      static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
      constructor(url) {
        this.url = String(url);
        this.readyState = 0;
        queueMicrotask(() => { this.readyState = 1; this.onopen?.(new Event("open")); });
      }
      send(data) {
        const replies = String(data).trim().split("\n").map((line) => {
          const c = JSON.parse(line);
          if (c.connect) return { id: c.id, connect: { client: "settings-s5c-capture", version: "6" } };
          if (c.subscribe) return { id: c.id, subscribe: { recoverable: true, positioned: true, recovered: false, epoch: "cap", offset: 0 } };
          return { id: c.id };
        });
        queueMicrotask(() => this.onmessage?.(new MessageEvent("message", { data: replies.map((r) => JSON.stringify(r)).join("\n") })));
      }
      close() { this.readyState = 3; this.onclose?.(new CloseEvent("close", { code: 1000 })); }
    }
    window.WebSocket = CaptureSocket;
  });
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  try {
    await page.getByTestId("nav-team").waitFor({ timeout: 20_000 });
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, "FAIL-sign-in.png") }).catch(() => {});
    throw error;
  }
}

const VIEWPORTS = [
  { w: 1440, h: 1500 },
  { w: 390, h: 3200 },
];
const DIALOG_VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 390, h: 844 },
];

const text = (page) => page.locator("body").innerText();
const KEUM = /(습니다|됩니다|십시오|입니까)/;
const noKeum = async (page, tag, scope = "body") =>
  check(`${tag} 합쇼체가 없다`, !KEUM.test(await page.locator(scope).first().innerText()));
const h2s = (page) => page.locator("[data-testid=settings-route] h2").allInnerTexts();
/** 카드 안에 또 하나의 테두리 상자: 상태 알약(inline-flex)은 상자가 아니다. */
const innerBoxes = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-testid=settings-route] *")].filter(
      (el) => el.classList.contains("border") && !el.classList.contains("inline-flex") && (el.classList.contains("rounded-md") || el.classList.contains("rounded-sm"))
    ).length
  );
const waitText = (page, id, t) => page.getByTestId(id).filter({ hasText: t }).first().waitFor({ timeout: 10_000 });
/** 폰 폭에서는 열기 단추가 화면 밖(레일·호버 묶음)이라 DOM 클릭으로 연다. 대화상자가 **뜨는지**는 이어서 기다린다. */
const opener = async (page, id) => {
  // 섹션 머리의 단추 묶음은 포인터가 머리에 들어올 때만 선다(`onMouseEnter`). 폰 폭에서는 머리가
  // 화면 밖이라 마우스를 옮길 수 없으므로 같은 이벤트를 DOM에서 보낸다.
  if (id === "new-channel" || id === "new-section") {
    await page.getByTestId("sidebar-section-channels-header").evaluate((el) => el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true, relatedTarget: document.body })));
  }
  await page.getByTestId(id).waitFor({ state: "attached", timeout: 10_000 });
  await page.getByTestId(id).evaluate((el) => el.click());
};
const goOffline = async (page, context) => {
  await context.setOffline(true);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
};

const CARDS_FULL = ["구독 잔여량", "비용 집계", "합계", "예산", "모델별", "에이전트별"];
const usageCommon = async (page, tag) => {
  await noKeum(page, tag, "[data-testid=settings-route]");
  check(`${tag} 카드 안에 상자를 한 겹 더 두르지 않는다`, (await innerBoxes(page)) === 0, { boxes: await innerBoxes(page) });
  check(`${tag} 옛 카드 껍질이 없다`, (await page.getByTestId("settings-legacy-card").count()) === 0);
};

const SCENES = [
  {
    name: "usage-normal", section: "usage",
    ready: async (page) => { await page.getByTestId("usage-total-cost").waitFor({ timeout: 10_000 }); await page.getByTestId("usage-quota-provider").first().waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      const titles = await h2s(page);
      check(`${tag} 카드 순서`, JSON.stringify(titles.slice(0, 6)) === JSON.stringify(CARDS_FULL), titles);
      check(`${tag} 합계가 화면에 있다`, (await page.getByTestId("usage-total-cost").innerText()).includes("$18.43"));
      check(`${tag} 에이전트별에서 같은 이름 둘을 핸들로 가른다`, (await page.getByTestId("usage-agent-row").allInnerTexts()).join("|").includes("@kim-intern"));
      check(`${tag} 기간은 라디오 묶음이고 30일이 켜져 있다`, (await page.getByTestId("usage-period-30d").isChecked()) && !(await page.getByTestId("usage-period-7d").isChecked()));
    },
  },
  {
    name: "usage-breakdown", section: "usage",
    ready: async (page) => { await page.getByTestId("usage-model-row").first().waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("usage-buckets").locator("summary").click();
      await page.getByTestId("usage-bucket-row").first().waitFor({ timeout: 10_000 });
      await page.getByTestId("usage-bucket-row").first().scrollIntoViewIfNeeded();
    },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 구간 목록이 펼쳐졌다`, (await page.getByTestId("usage-bucket-row").count()) > 3);
    },
  },
  {
    name: "usage-period-7d", section: "usage",
    ready: async (page) => { await page.getByTestId("usage-total-cost").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("usage-period-7d").locator("..").click();
      await page.waitForFunction(() => document.querySelector('[data-testid="usage-period-7d"]')?.checked === true, null, { timeout: 5_000 });
    },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 30일이 꺼졌다`, !(await page.getByTestId("usage-period-30d").isChecked()));
    },
  },
  {
    name: "usage-quota-near", section: "usage", cfg: { quota: "near", usage: "hard" },
    ready: async (page) => { await page.locator('[data-testid="usage-quota-gauge"][data-tone="danger"]').first().waitFor({ timeout: 10_000 }); await page.locator('[data-testid="usage-budget"][data-budget-state="hard_limit"]').waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 한도 임박 칩이 글로 말한다`, (await page.getByTestId("usage-quota").innerText()).includes("임박"));
    },
  },
  {
    name: "usage-quota-stale", section: "usage", cfg: { quota: "stale" },
    ready: async (page) => { await page.getByTestId("usage-quota-reset-passed").first().waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => usageCommon(page, tag),
  },
  {
    name: "usage-quota-empty", section: "usage", cfg: { quota: "absent" },
    ready: async (page) => { await page.getByTestId("usage-quota-empty").waitFor({ timeout: 10_000 }); await page.getByTestId("usage-total-cost").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => usageCommon(page, tag),
  },
  {
    name: "usage-empty", section: "usage", cfg: { usage: "empty" },
    ready: async (page) => { await page.getByTestId("usage-empty").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 합계 카드 안에 빈 상태 한 줄, 총합 숫자는 없다`, (await page.getByTestId("usage-total-cost").count()) === 0 && (await page.locator("[data-testid=usage-empty] button").count()) === 1);
      check(`${tag} 예산 카드는 빈 기간에도 선다`, (await h2s(page)).includes("예산"));
    },
  },
  {
    name: "usage-error", section: "usage", cfg: { usage: "404", quota: "404" },
    ready: async (page) => { await page.getByTestId("usage-error").waitFor({ timeout: 10_000 }); await page.getByTestId("usage-quota-error").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 비용 쪽 다시 시도 단추 하나`, (await page.locator("[data-testid=usage-error] button").count()) === 1);
      check(`${tag} 이 면에는 운영자 안내가 없다`, (await page.getByTestId("operator-notice").count()) === 0);
      check(`${tag} 서버가 모르는 쪽을 문장으로 말한다`, (await text(page)).includes("아직 사용량 집계를 제공하지 않아요"));
    },
  },
  {
    name: "usage-last-known", section: "usage", cfg: { usage: "once-then-503" },
    ready: async (page) => { await page.getByTestId("usage-total-cost").waitFor({ timeout: 10_000 }); },
    after: async (page) => {
      await page.getByTestId("usage-refresh").click();
      await page.getByTestId("usage-last-known").waitFor({ timeout: 10_000 });
    },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 확인했던 합계가 그대로 보인다`, (await page.getByTestId("usage-total-cost").innerText()).includes("$18.43"));
      check(`${tag} 배너가 마지막 확인을 말한다`, (await page.getByTestId("usage-last-known-banner").innerText()).length > 0);
    },
  },
  {
    name: "usage-loading", section: "usage", cfg: { usage: "hang", quota: "hang" },
    ready: async (page) => { await page.getByTestId("usage-skeleton").waitFor({ state: "attached", timeout: 10_000 }); await page.getByTestId("usage-quota-skeleton").waitFor({ state: "attached", timeout: 10_000 }); },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 합계 숫자는 아직 없다`, (await page.getByTestId("usage-total-cost").count()) === 0);
      check(`${tag} 읽는 중이라고 aria-busy 가 말한다`, (await page.getByTestId("usage-panel").getAttribute("aria-busy")) === "true");
    },
  },
  {
    name: "usage-offline", section: "usage",
    // 오프라인을 **쿼리가 생기기 전에** 만든다: 요청이 나가지 않고(paused) 캐시도 없는 유일한 경우다.
    preNav: goOffline,
    ready: async (page) => { await page.getByTestId("usage-error").waitFor({ timeout: 10_000 }); await page.getByTestId("settings-offline-banner").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      await usageCommon(page, tag);
      check(`${tag} 합계 숫자 대신 이유를 말한다`, (await page.getByTestId("usage-total-cost").count()) === 0 && (await page.getByTestId("usage-error").innerText()).length > 0);
    },
  },
  // ---- AI 허브 링크 행 -----------------------------------------------------------
  {
    name: "ai-link-row", section: "ai", wide: true,
    ready: async (page) => { await page.getByTestId("ai-hub-moved-link").waitFor({ timeout: 10_000 }); await page.getByTestId("ai-team").waitFor({ timeout: 10_000 }); },
    verify: async (page, tag) => {
      const link = page.getByTestId("ai-hub-moved-link");
      check(`${tag} 링크 행이 카드 안에 있다`, (await link.locator("a").count()) === 1 && (await link.evaluate((el) => !!el.querySelector(".settings-row"))));
      check(`${tag} 링크는 AI 허브로 간다`, ((await link.locator("a").getAttribute("href")) ?? "").endsWith("/ai/accounts"));
      check(`${tag} 행 문구`, (await link.innerText()).includes("AI 화면으로 옮겼어요"));
      check(`${tag} 이 페이지에도 옛 카드 껍질이 없다`, (await page.getByTestId("settings-legacy-card").count()) === 0);
    },
  },
];

// ---- 대화상자 3종 (해요체 정리) ---------------------------------------------------
const DIALOGS = [
  {
    name: "dialog-add-workspace",
    open: async (page) => { await opener(page, "add-workspace"); await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 }); },
    scope: "[data-testid=add-workspace-dialog]",
    verify: async (page, tag) => {
      const t = await page.getByTestId("add-workspace-dialog").innerText();
      check(`${tag} 안내가 해요체`, t.includes("초대 링크로 참여해요") && t.includes("사람이 읽는 이름이에요") && t.includes("하나뿐이어야 해요"), t);
    },
  },
  {
    name: "dialog-add-workspace-offline",
    open: async (page, context) => { await opener(page, "add-workspace"); await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 }); await goOffline(page, context); await page.getByTestId("add-workspace-offline").waitFor({ timeout: 10_000 }); },
    scope: "[data-testid=add-workspace-dialog]",
    verify: async (page, tag) => check(`${tag} 오프라인 문장`, (await page.getByTestId("add-workspace-offline").innerText()).includes("연결이 끊겼어요. 워크스페이스 만들기는 다시 연결된 뒤에 할 수 있어요.")),
  },
  {
    name: "dialog-add-workspace-403", cfg: { create: "403" },
    open: async (page) => {
      await opener(page, "add-workspace");
      await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("add-workspace-name").fill("새 팀");
      await page.getByTestId("add-workspace-slug").fill("new-team");
      await page.getByTestId("add-workspace-submit").click();
      await waitText(page, "add-workspace-dialog", "운영자만 만들 수 있어요");
    },
    scope: "[data-testid=add-workspace-dialog]",
    verify: async (page, tag) => check(`${tag} 운영자 안내 두 문장`, (await page.getByTestId("operator-notice").innerText()).includes("받은 초대 링크로 참여할 수 있어요")),
  },
  {
    name: "dialog-add-workspace-created",
    open: async (page) => {
      await opener(page, "add-workspace");
      await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("add-workspace-name").fill("새 팀");
      await page.getByTestId("add-workspace-slug").fill("new-team");
      await page.getByTestId("add-workspace-submit").click();
      await page.getByTestId("add-workspace-created").waitFor({ timeout: 10_000 });
    },
    scope: "[data-testid=add-workspace-dialog]",
    verify: async (page, tag) => check(`${tag} 완료 문장`, (await page.getByTestId("add-workspace-created").innerText()).includes("워크스페이스를 만들었어요.")),
  },
  {
    name: "dialog-create-channel",
    open: async (page) => { await opener(page, "new-channel"); await page.getByTestId("create-channel-dialog").waitFor({ timeout: 10_000 }); },
    scope: "[data-testid=create-channel-dialog]",
    verify: async (page, tag) => {
      const t = await page.getByTestId("create-channel-dialog").innerText();
      check(`${tag} 안내가 해요체`, t.includes("찾아서 들어올 수 있어요") && t.includes("추가된 멤버에게만 보여요") && t.includes("저장돼요") && t.includes("280자까지 쓸 수 있어요"), t);
    },
  },
  {
    name: "dialog-create-channel-offline",
    open: async (page, context) => { await opener(page, "new-channel"); await page.getByTestId("create-channel-dialog").waitFor({ timeout: 10_000 }); await goOffline(page, context); await page.getByTestId("create-channel-offline").waitFor({ timeout: 10_000 }); },
    scope: "[data-testid=create-channel-dialog]",
    verify: async (page, tag) => check(`${tag} 오프라인 문장`, (await page.getByTestId("create-channel-offline").innerText()).includes("연결이 끊겼어요. 채널 만들기는 다시 연결된 뒤에 할 수 있어요.")),
  },
  {
    name: "dialog-section-name",
    open: async (page) => { await opener(page, "new-section"); await page.getByTestId("sidebar-section-name-dialog").waitFor({ timeout: 10_000 }); },
    scope: "[data-testid=sidebar-section-name-dialog]",
    verify: async (page, tag) => {
      const t = await page.getByTestId("sidebar-section-name-dialog").innerText();
      check(`${tag} 안내가 해요체`, t.includes("채널을 묶어요") && t.includes("쓸 수 있어요"), t);
    },
  },
];

async function newPage(browser, origin, cfg, scheme, vp) {
  const context = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, colorScheme: scheme, reducedMotion: "reduce", serviceWorkers: "block" });
  await installRoutes(context, cfg);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없는 캡처 */ } }, origin);
  await signIn(page, origin);
  return { context, page };
}

async function scene(browser, origin, def, scheme, vp) {
  const tag = `${def.name}-${vp.w}-${scheme}`;
  const { context, page } = await newPage(browser, origin, def.cfg ?? {}, scheme, vp);
  try {
    if (def.preNav) await def.preNav(page, context);
    await page.evaluate((hash) => { location.hash = hash; }, `/settings?section=${def.section}`);
    await def.ready(page, tag);
    if (def.after) await def.after(page, context);
    await page.waitForTimeout(250);
    const overflow = await page.evaluate(() => {
      const v = document.querySelector("[data-settings-scroll-viewport]") ?? document.documentElement;
      return Math.max(document.documentElement.scrollWidth - document.documentElement.clientWidth, v.scrollWidth - v.clientWidth);
    });
    check(`${tag} 가로 넘침 0`, overflow <= 0, { overflow });
    if (def.verify) await def.verify(page, tag);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    report.scenes.push(tag);
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function dialogScene(browser, origin, def, scheme, vp) {
  const tag = `${def.name}-${vp.w}-${scheme}`;
  const { context, page } = await newPage(browser, origin, def.cfg ?? {}, scheme, vp);
  try {
    await def.open(page, context);
    await page.waitForTimeout(250);
    await noKeum(page, tag, def.scope);
    // 대화상자가 화면 안에 온전히 들어온다.
    const box = await page.locator(def.scope).first().boundingBox();
    check(`${tag} 화면 안에 들어온다`, !!box && box.x >= -0.5 && box.x + box.width <= vp.w + 0.5, box);
    if (def.verify) await def.verify(page, tag);
    await page.screenshot({ path: resolve(OUT_DIR, `${tag}.png`) });
    report.scenes.push(tag);
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${tag}.png`) }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) throw new Error("dist/ is missing. Run npm run build first.");
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({ webRoot: WEB_ROOT, port: PORT, portEnvVar: "CAPTURE_PORT" });
  const browser = await chromium.launch();
  try {
    for (const scheme of ["light", "dark"]) {
      for (const vp of VIEWPORTS) {
        for (const def of SCENES) await scene(browser, preview.origin, def, scheme, vp);
      }
      for (const vp of DIALOG_VIEWPORTS) {
        for (const def of DIALOGS) await dialogScene(browser, preview.origin, def, scheme, vp);
      }
    }
  } finally {
    await browser.close();
    await preview.stop();
    writeFileSync(resolve(OUT_DIR, "report.json"), JSON.stringify(report, null, 2));
  }
  if (failures.length) {
    console.error(`\n${failures.length} check(s) failed`);
    process.exit(1);
  }
}

await main();
