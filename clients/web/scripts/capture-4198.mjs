#!/usr/bin/env node
// =============================================================================
// 멀티 조직 P0-A 실측 + 캡처 (#4198): 레일 「+」 완료 패널·설정 완료 카드의 막다른 길 수리.
//
//   변경 전 번들: MODE=before DIST=artifacts/dist-before-4198 node scripts/capture-4198.mjs
//   변경 후 번들: npm run build && MODE=after node scripts/capture-4198.mjs
//
// 진짜 앱 셸을 Chromium으로 열고 `/v1/**`는 고정 응답, 실시간 소켓은 곧바로 연결되는 흉내다
// (운영 환경에 닿지 않는다). 장면마다 라이트/다크 × 1440/390.
//
//   dialog-created    레일 「+」 → 이름·슬러그 → 만들기 → 완료 패널. 패널에 ID·복사·옳은 길 안내가 있는가,
//                     폭 안에 들어가는가, 복사가 클립보드에 그 ID를 쓰는가, 완료 직후 초점이 어디인가,
//                     한 번만 보이는 ID를 Esc·바깥 클릭이 지우지 않는가(「닫기」만 닫는다).
//   settings-created  설정 › 워크스페이스 › 새 워크스페이스 만들기 → 완료 카드(같은 사실을 같은 문장으로).
//                     초점·Esc 삼킴·「닫기」·일반 카드 ID 줄의 복사까지.
//   settings-fold     900×700에서 만든 직후 완료 카드가 접힌 아래에 숨지 않고 화면 안에 있는가.
//   login-labels      로그인 화면 「다른 워크스페이스로 로그인」을 열었을 때 그 글자와 칸 이름. 안내 문장이
//                     가리키는 낱말이 실제 화면에 그대로 있는지 같은 번들에서 잰다.
//
//   dialog-short      낮은 창(가로 폰 667x375, 브라우저 200% 상당 720x395, 576x316, 320x480)에서 만든 직후 「닫기」가
//                     화면 안에 있고 누를 수 있는가. Esc·바깥 클릭을 막은 분기의 유일한 출구다(design-review 2차 B1).
//   settings-pending  요청이 날아가는 동안(느린 응답) Esc가 설정을 닫지 않는가(design-review 2차 M-A).
//
// MODE=before / MODE=r2(1차 검수 때의 번들) 는 같은 단정을 **기록만** 한다(변경 전 번들은 빨간 것이 정상이다).
// MODE=after 는 하나라도 빨가면 exit 1.
// =============================================================================
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "../gates/preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const WEB_ROOT = process.env.WEB_ROOT ? resolve(process.env.WEB_ROOT) : resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR ? resolve(process.env.OUT_DIR) : resolve(WEB_ROOT, "artifacts/p0a-4198");
const MODE = process.env.MODE || "after";
const DIST = process.env.DIST || "";
/** `ONLY=short,pending` 처럼 주면 그 장면만 돈다(1차 검수 번들에서 새 단정이 빨개지는지만 볼 때). */
const ONLY = (process.env.ONLY || "").split(",").map((v) => v.trim()).filter(Boolean);
const wants = (name) => ONLY.length === 0 || ONLY.includes(name);
const PORT = Number(process.env.CAPTURE_PORT || 5398);

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const channels = [
  { id: "00000000-0000-7000-8000-000000000201", workspaceId, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId, kind: "public", name: "디자인", muted: false },
];
const auth = {
  accessToken: "capture-only-not-a-credential",
  refreshToken: "capture-only-not-a-credential",
  member: { id: memberId, workspaceId, kind: "human", displayName: "곽성재", handle: "seongjae" },
  realtimeWebSocketUrl: "ws://p0a-4198-capture.invalid/connection/websocket",
};
const roster = [
  {
    id: memberId, workspaceId, kind: "human", status: "active", role: "owner", displayName: "곽성재", handle: "seongjae",
    channelCount: 3, channelIds: channels.map((c) => c.id), capabilities: [], createdAtMs: 0, updatedAtMs: 0,
  },
];
const WORKSPACE = {
  id: workspaceId, slug: "yeomyeong", name: "여명거리", updatedAtMs: 1_760_000_000_000,
  roleLabels: {}, welcomeAgentMemberId: null, welcomePrompt: "", subscriptionAgentsEnabled: false,
};
/**
 * 지금 Rust 서버는 새 워크스페이스 ID를 소문자로 돌려준다(`workspaces.rs` `Uuid::to_string()`). 코어 타입
 * 주석(`CreatedWorkspace.workspaceId`)이 경고하는 대문자는 옛 Swift 서버의 모양이다. 화면은 어느 쪽이든
 * 받은 그대로 보여 주고 그대로 복사해야 하고, 그 「그대로」는 단위 시험이 대문자 값으로 못 박는다.
 */
const NEW_WS_ID = "019fa000-1111-7222-8333-444455556666";
const OLD_SENTENCE = "그 슬러그로 다시 로그인";

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const results = [];
const report = { mode: MODE, dist: DIST || "dist", scenes: [], notes: [] };
function check(tag, name, ok, detail) {
  results.push({ tag, name, ok: Boolean(ok), detail });
  console.log(JSON.stringify({ tag, check: name, ok: Boolean(ok), detail }));
}

async function installRoutes(context, cfg = {}) {
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
      let body = {};
      try { body = JSON.parse(req.postData() || "{}"); } catch { /* 빈 본문 */ }
      if (cfg.createDelayMs) await new Promise((done) => setTimeout(done, cfg.createDelayMs));
      return json(route, { schema: "momo.workspace.created.v1", workspaceId: NEW_WS_ID, slug: body.slug ?? "design-team", name: body.name ?? "디자인팀" }, 201);
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
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
          if (c.connect) return { id: c.id, connect: { client: "p0a-4198-capture", version: "6" } };
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

async function newContext(browser, origin, scheme, vp, cfg = {}) {
  const context = await browser.newContext({
    viewport: { width: vp.w, height: vp.h },
    colorScheme: scheme,
    reducedMotion: "reduce",
    serviceWorkers: "block",
    deviceScaleFactor: 2,
  });
  // 복사 단추가 실제로 클립보드에 쓰는지 읽어서 확인하려면 두 권한이 필요하다.
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => {});
  await installRoutes(context, cfg);
  const page = await context.newPage();
  await installRealtime(page);
  await page.addInitScript((server) => { try { localStorage.setItem("momo.web.server.v1", server); } catch { /* 저장소 없음 */ } }, origin);
  return { context, page };
}

async function signIn(page, origin) {
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await advanceToAccount(page);
  await page.getByTestId("login-email").fill("capture@example.test");
  await page.getByTestId("login-password").fill("not-a-secret");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("workspace-current").waitFor({ state: "attached", timeout: 20_000 });
}

const png = (tag, name) => resolve(OUT_DIR, `${MODE}-${name}-${tag}.png`);
async function shot(page, tag, name, clip) {
  await page.waitForTimeout(300);
  await page.screenshot(clip ? { path: png(tag, name), clip } : { path: png(tag, name) });
  report.scenes.push(`${MODE}-${name}-${tag}.png`);
  console.log("shot", `${MODE}-${name}-${tag}.png`);
}
async function shotBox(page, locator, tag, name, pad = 12) {
  const box = await locator.boundingBox();
  if (!box) throw new Error(`no box for ${name}`);
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  await shot(page, tag, name, {
    x, y,
    width: Math.min(vp.width - x, box.width + pad * 2),
    height: Math.min(vp.height - y, box.height + pad * 2),
  });
}

const describeActive = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    return {
      tag: a?.tagName ?? null,
      testid: a?.getAttribute?.("data-testid") ?? null,
      role: a?.getAttribute?.("role") ?? null,
      inDialog: Boolean(a?.closest?.("[data-testid=add-workspace-dialog]")),
    };
  });

/** 안내 문장이 길을 바르게 말하는가: 로그인 화면에 실제로 있는 두 낱말을 이름으로 부르고, 옛 거짓 문장은 없다. */
function guideChecks(tag, scope, text) {
  check(tag, `${scope}: 한 번만 보인다는 사실을 말한다(벗어나면 다시 볼 수 없으니 지금 복사)`, text.includes("다시 볼 수 없") && text.includes("복사해 두세요"), null);
  check(tag, `${scope}: 옛 거짓 안내(「${OLD_SENTENCE}」)가 없다`, !text.includes(OLD_SENTENCE), null);
  check(tag, `${scope}: 길을 이름으로 말한다(「다른 워크스페이스로 로그인」 · 워크스페이스 ID 칸)`, text.includes("「다른 워크스페이스로 로그인」") && text.includes("워크스페이스 ID"), null);
  check(tag, `${scope}: 응답의 워크스페이스 ID가 글자로 들어 있다`, text.includes(NEW_WS_ID), { includes: text.includes(NEW_WS_ID) });
}

async function readClipboard(page) {
  return page.evaluate(() => navigator.clipboard.readText()).catch((error) => `ERR ${String(error).slice(0, 80)}`);
}

const SCENES = [
  {
    name: "dialog-created",
    run: async (page, origin, tag, vp) => {
      await signIn(page, origin);
      const opener = page.getByTestId("add-workspace");
      await opener.waitFor({ state: "attached", timeout: 10_000 });
      // 폰 폭에서는 「+」가 화면 밖 레일에 있어 DOM 클릭으로 연다(대화상자가 뜨는지는 이어서 기다린다).
      await opener.evaluate((el) => el.click());
      await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("add-workspace-name").fill("디자인팀");
      await page.getByTestId("add-workspace-slug").fill("design-team");
      await page.getByTestId("add-workspace-submit").click();
      await page.getByTestId("add-workspace-created").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);

      const dialog = page.getByTestId("add-workspace-dialog");
      const text = await dialog.innerText();
      report.notes.push({ tag, scene: "dialog-created", dialogText: text });
      guideChecks(tag, "완료 패널", text);

      const copy = page.getByTestId("add-workspace-created-copy");
      const idNode = page.getByTestId("add-workspace-created-id");
      const hasCopy = (await copy.count()) === 1;
      check(tag, "완료 패널에 「복사」 단추가 있다(접근 이름이 「워크스페이스 ID 복사」)", hasCopy && (await copy.getAttribute("aria-label")) === "워크스페이스 ID 복사", { count: await copy.count() });

      const active = await describeActive(page);
      report.notes.push({ tag, scene: "dialog-created", activeElementAfterCreate: active });
      check(tag, "완료 직후 초점이 대화상자 안에 있다(<body>로 떨어지지 않았다)", active.inDialog, active);
      check(tag, "완료 직후 초점이 이름 붙은 완료 묶음(role=group)에 있다(대화상자 껍데기가 아니다)",
        active.testid === "add-workspace-created" && active.role === "group", active);

      if (hasCopy) {
        const dBox = await dialog.boundingBox();
        const iBox = await idNode.boundingBox();
        const cBox = await copy.boundingBox();
        const overflow = await idNode.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
        check(tag, "ID가 잘리지 않는다(scrollWidth ≤ clientWidth)", overflow.scrollWidth <= overflow.clientWidth, overflow);
        check(tag, "ID와 복사 단추가 대화상자 폭 안에 있다", iBox.x >= dBox.x && iBox.x + iBox.width <= dBox.x + dBox.width + 0.5 && cBox.x >= dBox.x && cBox.x + cBox.width <= dBox.x + dBox.width + 0.5, { dBox, iBox, cBox });
        const sideBySide = cBox.y < iBox.y + iBox.height;
        report.notes.push({ tag, scene: "dialog-created", layout: sideBySide ? "ID 옆(한 줄)" : "ID 아래(줄 바꿈)", copyBox: cBox, idBox: iBox, dialogBox: dBox });
        check(tag, `복사 단추 높이가 폭에 맞다(1440=28 · 390=44)`, Math.round(cBox.height) === (vp.w >= 600 ? 28 : 44), { height: cBox.height });
      }

      await shot(page, tag, "dialog-created");
      await shotBox(page, dialog, tag, "dialog-created-panel");

      if (hasCopy) {
        const dialogBefore = await dialog.boundingBox();
        const copyBefore = await copy.boundingBox();
        await copy.click();
        await page.waitForTimeout(200);
        const clip = await readClipboard(page);
        check(tag, "복사를 누르면 클립보드에 응답의 ID가 그대로 들어간다", clip === NEW_WS_ID, { clip });
        const label = await copy.innerText();
        check(tag, "복사 뒤 단추가 「복사됨」으로 바뀐다", label.trim() === "복사됨", { label });
        const dialogAfter = await dialog.boundingBox();
        const copyAfter = await copy.boundingBox();
        check(tag, "「복사됨」으로 길어져도 단추 자리와 대화상자 높이가 그대로다(누른 손가락 아래에서 달아나지 않는다)",
          Math.abs(dialogAfter.height - dialogBefore.height) < 0.5 && Math.abs(copyAfter.y - copyBefore.y) < 0.5 && Math.abs(copyAfter.x - copyBefore.x) < 0.5,
          { dialogBefore: dialogBefore.height, dialogAfter: dialogAfter.height, copyBefore: { x: copyBefore.x, y: copyBefore.y, w: copyBefore.width }, copyAfter: { x: copyAfter.x, y: copyAfter.y, w: copyAfter.width } });
        await shotBox(page, dialog, tag, "dialog-created-copied");
      }

      // 터치에서 그 순간 반드시 눌러야 하는 하나는 「닫기」다: 폰 폭에서는 복사처럼 44px로 자란다.
      const doneBox = await page.getByTestId("add-workspace-done").boundingBox();
      if (doneBox) check(tag, "「닫기」 높이가 폭에 맞다(1440=28 · 390=44)", Math.round(doneBox.height) === (vp.w >= 600 ? 28 : 44), { height: doneBox.height });

      // 그 ID는 다른 어디에도 없다. 반사적인 Esc·바깥 클릭이 지우지 못하고 나가는 길은 「닫기」 하나다.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const survivedEsc = (await page.getByTestId("add-workspace-created").count()) === 1;
      check(tag, "Esc로는 닫히지 않는다(ID가 다른 어디에도 없다)", survivedEsc, { survivedEsc });
      if (survivedEsc) {
        await page.mouse.click(4, 4);
        await page.waitForTimeout(400);
        const survivedClick = (await page.getByTestId("add-workspace-created").count()) === 1;
        check(tag, "바깥(스크림) 클릭으로는 닫히지 않는다", survivedClick, { survivedClick });
        if (survivedClick) {
          await page.getByTestId("add-workspace-done").click();
          const closed = await dialog.waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
          check(tag, "「닫기」로는 닫힌다", closed, { closed });
        }
      }
    },
  },
  {
    name: "settings-created",
    run: async (page, origin, tag) => {
      await signIn(page, origin);
      await page.evaluate(() => { location.hash = "/settings?section=workspace"; });
      await page.getByTestId("workspace-create-form").waitFor({ timeout: 15_000 });
      await page.locator("#workspace-name").fill("디자인팀");
      await page.locator("#workspace-slug").fill("design-team");
      await page.getByTestId("workspace-create").click();
      await page.getByTestId("workspace-created").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(300);

      const card = page.getByTestId("workspace-created");
      const activeSettings = await describeActive(page);
      report.notes.push({ tag, scene: "settings-created", activeElementAfterCreate: activeSettings });
      check(tag, "설정 완료 직후 초점이 이름 붙은 완료 묶음(role=group)에 있다",
        activeSettings.testid === "workspace-created" && activeSettings.role === "group", activeSettings);
      await card.scrollIntoViewIfNeeded();
      const text = await card.innerText();
      report.notes.push({ tag, scene: "settings-created", createdCardText: text });
      guideChecks(tag, "설정 완료 카드", text);

      const copy = page.getByTestId("workspace-created-copy");
      const hasCopy = (await copy.count()) === 1;
      check(tag, "설정 완료 카드에도 「복사」 단추가 있다", hasCopy, { count: await copy.count() });
      if (hasCopy) {
        const idNode = page.getByTestId("workspace-created-id");
        const overflow = await idNode.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
        check(tag, "설정 카드의 ID가 잘리지 않는다", overflow.scrollWidth <= overflow.clientWidth, overflow);
        const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        check(tag, "가로 스크롤이 생기지 않는다", pageOverflow <= 0, { pageOverflow });
      }
      await shotBox(page, card, tag, "settings-created-card", 16);
      await shot(page, tag, "settings-created");
      if (hasCopy) {
        const cardBefore = await card.boundingBox();
        const copyBefore = await copy.boundingBox();
        await copy.click();
        await page.waitForTimeout(200);
        const clip = await readClipboard(page);
        check(tag, "설정 카드 복사도 같은 ID를 쓴다", clip === NEW_WS_ID, { clip });
        const cardAfter = await card.boundingBox();
        const copyAfter = await copy.boundingBox();
        check(tag, "설정 카드도 「복사됨」으로 길어져 자리가 바뀌지 않는다",
          Math.abs(cardAfter.height - cardBefore.height) < 0.5 && Math.abs(copyAfter.y - copyBefore.y) < 0.5 && Math.abs(copyAfter.x - copyBefore.x) < 0.5,
          { cardBefore: cardBefore.height, cardAfter: cardAfter.height, copyBefore: { x: copyBefore.x, y: copyBefore.y }, copyAfter: { x: copyAfter.x, y: copyAfter.y } });
      }

      // 일반 카드(지금 열려 있는 워크스페이스)의 ID 줄도 같은 복사 단추를 가진다.
      const generalCopy = page.getByTestId("workspace-id-copy");
      check(tag, "일반 카드의 워크스페이스 ID 줄에도 복사 단추가 있다", (await generalCopy.count()) === 1, { count: await generalCopy.count() });
      if ((await generalCopy.count()) === 1) {
        await generalCopy.scrollIntoViewIfNeeded();
        await generalCopy.click();
        await page.waitForTimeout(200);
        check(tag, "일반 카드의 복사는 지금 워크스페이스의 ID를 쓴다", (await readClipboard(page)) === workspaceId, { clip: await readClipboard(page) });
      }

      const settingsDoneBox = await page.getByTestId("workspace-created-done").boundingBox();
      if (settingsDoneBox) check(tag, "설정 카드의 「닫기」 높이가 폭에 맞다(1440=28 · 390=44)", Math.round(settingsDoneBox.height) === (page.viewportSize().width >= 600 ? 28 : 44), { height: settingsDoneBox.height });

      // 카드가 떠 있는 동안 Esc는 설정을 닫지 않고, 「닫기」가 카드를 지우고 초점을 이름 칸으로 돌려준다.
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
      const hashAfterEsc = await page.evaluate(() => location.hash);
      const cardSurvived = (await page.getByTestId("workspace-created").count()) === 1;
      check(tag, "Esc는 설정을 닫지 않고 ID 카드를 지우지 않는다", hashAfterEsc.includes("section=workspace") && cardSurvived, { hashAfterEsc, cardSurvived });
      if (cardSurvived) {
        await page.getByTestId("workspace-created-done").click();
        const gone = await page.getByTestId("workspace-created").waitFor({ state: "detached", timeout: 5000 }).then(() => true, () => false);
        const focusedId = await page.evaluate(() => document.activeElement?.id ?? null);
        check(tag, "「닫기」가 카드를 지우고 초점을 이름 칸으로 돌려준다", gone && focusedId === "workspace-name", { gone, focusedId });
      }
    },
  },
  {
    name: "settings-fold",
    onlyWidths: [900],
    run: async (page, origin, tag, vp) => {
      await signIn(page, origin);
      await page.evaluate(() => { location.hash = "/settings?section=workspace"; });
      await page.getByTestId("workspace-create-form").waitFor({ timeout: 15_000 });
      await page.locator("#workspace-name").fill("디자인팀");
      await page.locator("#workspace-slug").fill("design-team");
      await page.getByTestId("workspace-create").scrollIntoViewIfNeeded();
      await page.getByTestId("workspace-create").click();
      await page.getByTestId("workspace-created").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(500);
      const box = await page.getByTestId("workspace-created").boundingBox();
      const fits = box !== null && box.y >= 0 && box.y + Math.min(box.height, vp.h) <= vp.h + 1;
      check(tag, "만든 직후 완료 카드가 접힌 아래에 숨지 않고 화면 안에 있다(스크롤 없이)", fits, { box, viewport: vp });
      await shot(page, tag, "settings-created-fold");
    },
  },
  {
    name: "login-labels",
    run: async (page, origin, tag) => {
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await advanceToAccount(page);
      const toggle = page.getByTestId("login-workspace-toggle");
      const toggleText = (await toggle.innerText()).trim();
      check(tag, "로그인 화면 접힘 단추 글자가 안내 문장이 부르는 이름과 같다", toggleText === "다른 워크스페이스로 로그인", { toggleText });
      await toggle.click();
      await page.getByTestId("login-workspace").waitFor({ timeout: 10_000 });
      const label = (await page.locator('label[for="connect-workspace"]').innerText()).trim();
      check(tag, "펼친 칸의 이름이 「워크스페이스 ID」다(슬러그가 아니다)", label.includes("워크스페이스 ID") && !label.includes("슬러그"), { label });
      report.notes.push({ tag, scene: "login-labels", toggleText, label });
      await shot(page, tag, "login-labels");
    },
  },
];

/** 두 대표 폭(1440·390) 사이와 더 좁은 폰에서도 ID가 잘리지 않고 복사 자리가 안 바뀐다. 변경 후 번들 전용(전엔 단추가 없다). */
const SWEEP_WIDTHS = [320, 360, 375, 390, 412, 430, 480, 600, 768, 1024];
async function sweep(browser, origin) {
  for (const w of SWEEP_WIDTHS) {
    const tag = `sweep-${w}-light`;
    const { context, page } = await newContext(browser, origin, "light", { w, h: 900 });
    try {
      await signIn(page, origin);
      const opener = page.getByTestId("add-workspace");
      await opener.waitFor({ state: "attached", timeout: 10_000 });
      await opener.evaluate((el) => el.click());
      await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("add-workspace-name").fill("디자인팀");
      await page.getByTestId("add-workspace-slug").fill("design-team");
      await page.getByTestId("add-workspace-submit").click();
      await page.getByTestId("add-workspace-created").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(250);
      const dialog = page.getByTestId("add-workspace-dialog");
      const copy = page.getByTestId("add-workspace-created-copy");
      const idNode = page.getByTestId("add-workspace-created-id");
      const dBox = await dialog.boundingBox();
      const iBox = await idNode.boundingBox();
      const cBox = await copy.boundingBox();
      const overflow = await idNode.evaluate((el) => ({ scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }));
      const idLines = Math.round(iBox.height / 18);
      const pageOverflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      const layout = cBox.y >= iBox.y + iBox.height - 1 ? "아래" : "옆";
      // 360 미만(320)은 칸이 252px라 36자 ID(260px)가 두 줄로 접힌다. 잘리지는 않는다(scrollWidth ≤ clientWidth).
      check(tag, `폭 ${w}: ID가 ${w < 360 ? "잘리지 않고" : "한 줄이고 잘리지 않으며"} 대화상자 안에 있다(복사 ${layout}, ID ${idLines}줄)`,
        overflow.scrollWidth <= overflow.clientWidth && (idLines === 1 || w < 360) && iBox.x >= dBox.x && iBox.x + iBox.width <= dBox.x + dBox.width + 0.5 && cBox.x + cBox.width <= dBox.x + dBox.width + 0.5 && pageOverflow <= 0,
        { w, layout, idLines, overflow, pageOverflow, dBox: { x: dBox.x, w: dBox.width, h: dBox.height }, iBox: { x: iBox.x, w: iBox.width }, cBox: { x: cBox.x, y: cBox.y, w: cBox.width } });
      await copy.click();
      await page.waitForTimeout(200);
      const d2 = await dialog.boundingBox();
      const c2 = await copy.boundingBox();
      check(tag, `폭 ${w}: 「복사됨」이 되어도 단추 자리와 대화상자 높이가 그대로다`,
        Math.abs(d2.height - dBox.height) < 0.5 && Math.abs(c2.y - cBox.y) < 0.5 && Math.abs(c2.x - cBox.x) < 0.5,
        { before: { h: dBox.height, x: cBox.x, y: cBox.y, w: cBox.width }, after: { h: d2.height, x: c2.x, y: c2.y, w: c2.width } });
      if (w === 320 || w === 430) await shotBox(page, dialog, tag, "dialog-created-copied");
    } catch (error) {
      await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${MODE}-${tag}.png`) }).catch(() => {});
      check(tag, `폭 ${w} 장면이 끝까지 간다`, false, String(error).slice(0, 300));
    } finally {
      await context.close();
    }
  }
}

/**
 * 낮은 창에서 만든 직후 「닫기」가 화면 안에 있고 실제로 눌리는가(가운데 점의 `elementFromPoint`가 그 단추).
 * Esc·바깥 클릭을 막은 분기라 이 단추가 유일한 출구다. 이 축은 기계가 아무것도 재지 않는다
 * (디자인 시스템 §5.3): 높이 700 아래는 이 장면만 잰다.
 */
const SHORT_VIEWPORTS = [
  { w: 667, h: 375 }, // 가로 폰
  { w: 844, h: 390 }, // 가로 폰(큰 것)
  { w: 720, h: 395 }, // 1440x790 창에서 브라우저 200%와 같은 CSS 뷰포트
  { w: 576, h: 316 }, // 250% 상당
  { w: 320, h: 480 }, // 작은 폰
];
async function shortViewports(browser, origin) {
  for (const vp of SHORT_VIEWPORTS) {
    const tag = `short-${vp.w}x${vp.h}-light`;
    const { context, page } = await newContext(browser, origin, "light", vp);
    try {
      await signIn(page, origin);
      const opener = page.getByTestId("add-workspace");
      await opener.waitFor({ state: "attached", timeout: 10_000 });
      await opener.evaluate((el) => el.click());
      await page.getByTestId("add-workspace-dialog").waitFor({ timeout: 10_000 });
      await page.getByTestId("add-workspace-name").fill("디자인팀");
      await page.getByTestId("add-workspace-slug").fill("design-team");
      await page.getByTestId("add-workspace-submit").click();
      await page.getByTestId("add-workspace-created").waitFor({ timeout: 10_000 });
      await page.waitForTimeout(350);
      const done = page.getByTestId("add-workspace-done");
      const box = await done.boundingBox();
      const size = page.viewportSize();
      const inside = box !== null && box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width + 0.5 && box.y + box.height <= size.height + 0.5;
      const hit = await done.evaluate((button) => {
        const r = button.getBoundingClientRect();
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return top === button || button.contains(top);
      });
      const scroller = await page.evaluate(() => {
        const group = document.querySelector("[data-testid=add-workspace-created]");
        const box = group?.closest(".overflow-y-auto");
        return box ? { scrollHeight: box.scrollHeight, clientHeight: box.clientHeight } : null;
      });
      report.notes.push({ tag, scene: "dialog-short", doneBox: box, viewport: size, scroller });
      check(tag, `낮은 창 ${vp.w}x${vp.h}: 「닫기」가 화면 안에 있고 실제로 눌린다`, inside && hit, { inside, hit, box, viewport: size, scroller });
      await shot(page, tag, "dialog-short");
    } catch (error) {
      await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${MODE}-${tag}.png`) }).catch(() => {});
      check(tag, `낮은 창 ${vp.w}x${vp.h} 장면이 끝까지 간다`, false, String(error).slice(0, 300));
    } finally {
      await context.close();
    }
  }
}

/** 요청이 날아가는 동안(느린 응답) Esc가 설정 라우트를 닫지 않는다: 닫히면 POST는 갔는데 카드는 안 그려진다. */
async function settingsPending(browser, origin) {
  const tag = "pending-1440-light";
  const { context, page } = await newContext(browser, origin, "light", { w: 1440, h: 900 }, { createDelayMs: 1800 });
  try {
    await signIn(page, origin);
    await page.evaluate(() => { location.hash = "/settings?section=workspace"; });
    await page.getByTestId("workspace-create-form").waitFor({ timeout: 15_000 });
    await page.locator("#workspace-name").fill("디자인팀");
    await page.locator("#workspace-slug").fill("design-team");
    await page.getByTestId("workspace-create").scrollIntoViewIfNeeded();
    await page.getByTestId("workspace-create").click();
    await page.waitForTimeout(250);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    const hash = await page.evaluate(() => location.hash);
    const stayed = hash.includes("section=workspace");
    check(tag, "요청이 날아가는 동안 Esc는 설정을 닫지 않는다", stayed, { hash });
    if (stayed) {
      const arrived = await page.getByTestId("workspace-created").waitFor({ timeout: 8000 }).then(() => true, () => false);
      check(tag, "응답이 오면 ID 카드가 그려진다(요청 중에 닫히지 않았으므로)", arrived, { arrived });
    }
  } catch (error) {
    await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${MODE}-${tag}.png`) }).catch(() => {});
    check(tag, "요청 중 Esc 장면이 끝까지 간다", false, String(error).slice(0, 300));
  } finally {
    await context.close();
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
    extraArgs: DIST ? ["--outDir", DIST] : [],
  });
  const browser = await chromium.launch();
  try {
    for (const scheme of wants("main") ? ["light", "dark"] : []) {
      for (const vp of [{ w: 1440, h: 900 }, { w: 390, h: 844 }, { w: 900, h: 700 }]) {
        for (const def of SCENES) {
          // 접힌 아래 장면은 900×700 한 가지 크기에서만 잰다(라이트).
          if (def.onlyWidths ? !def.onlyWidths.includes(vp.w) : vp.w === 900) continue;
          if (def.onlyWidths && scheme === "dark") continue;
          // 로그인 화면은 라이트·다크가 아니라 글자를 재는 장면이라 폭마다 라이트에서만 찍는다.
          if (def.name === "login-labels" && scheme === "dark" && vp.w === 390) continue;
          const tag = `${vp.w}-${scheme}`;
          const { context, page } = await newContext(browser, preview.origin, scheme, vp);
          try {
            await def.run(page, preview.origin, tag, vp);
          } catch (error) {
            await page.screenshot({ path: resolve(OUT_DIR, `FAIL-${MODE}-${def.name}-${tag}.png`) }).catch(() => {});
            console.error("FAIL", def.name, tag, String(error).slice(0, 400));
            check(tag, `${def.name} 장면이 끝까지 간다`, false, String(error).slice(0, 300));
          } finally {
            await context.close();
          }
        }
      }
    }
    if (MODE === "after" && wants("sweep")) await sweep(browser, preview.origin);
    if (wants("short")) await shortViewports(browser, preview.origin);
    if (wants("pending")) await settingsPending(browser, preview.origin);
  } finally {
    await browser.close();
    await preview.stop?.();
  }
  const bad = results.filter((r) => !r.ok);
  writeFileSync(resolve(OUT_DIR, `${MODE}-results.json`), JSON.stringify({ report, results }, null, 1));
  console.log(
    bad.length === 0
      ? `P0A-4198 ${MODE} PASS (${results.length})`
      : `P0A-4198 ${MODE} ${MODE === "after" ? "FAIL" : "RED(예상)"} (${bad.length}/${results.length}): ${bad.map((r) => `${r.tag}/${r.name}`).join(" | ")}`
  );
  process.exit(MODE !== "after" ? 0 : bad.length === 0 ? 0 : 1);
}
main().catch((error) => { console.error(error); process.exit(1); });
