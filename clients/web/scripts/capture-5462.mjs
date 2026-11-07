#!/usr/bin/env node
// =============================================================================
// 이모티콘 세트 계획 카드·세트 카드 캡처 (#5462, ADR-0218 §12 L2.5·L5~L7). 저장소 캡처 하네스 규약을 따른다:
// 번들 Chromium 헤드리스 + 모의 `/v1`(gates/connection-harness.mjs, 시크릿 없음, 인물·그림은 전부 가상).
// 카드는 실제 대화 줄(`approval_request` 메시지의 `props.action`)로 서고, 그림은 실제 HTTP 전송으로 받는다.
//
//   node_modules/.bin/vite --host 127.0.0.1 --port 5462 --strictPort      # 자기 PID 로 띄우고 끝에 그 PID 만 끈다
//   node scripts/capture-5462.mjs --scheme light --out <스크래치>/cap5462 --port 5462
//   node scripts/capture-5462.mjs --scheme dark  --out <스크래치>/cap5462 --port 5462
//
// 코어의 TS 픽스처(`setFixtures.ts`)는 시작할 때 esbuild 로 JSON 한 장으로 묶어 읽는다(.mjs 가 TS 를 못 읽어서). 그림 속 얼굴은 이 파일의 작은 래스터라이저가 그린다.
// 캡처는 저장소에 올리지 않는다.
// =============================================================================
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { GENERAL_ID, ME, WORKSPACE_ID, installBackend, openGeneral, signIn, sleep } from "../gates/connection-harness.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "../..");

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) return fallback;
  const next = process.argv[at + 1];
  return next === undefined || next.startsWith("--") ? true : next;
}
const SCHEME = String(arg("scheme", "light"));
const PORT = Number(arg("port", 5462));
const WIDTH = Number(arg("width", 1280));
const OUT = resolve(WEB_ROOT, String(arg("out", "captures/5462")));
const ORIGIN = `http://127.0.0.1:${PORT}`;
const AGENT = "019F94E3-8B21-7AE0-B3C4-5F1A2D6E7C90";
const NOW = Date.now();

// ---- 코어 픽스처를 JSON 으로 -----------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const entry = join(OUT, "fixtures-entry.ts");
writeFileSync(entry, `import { FIXTURE_SET_NORMAL, FIXTURE_SET_REFUSED, FIXTURE_SET_PLAN_CARD, FIXTURE_SET_PLAN_CARD_SEEN } from ${JSON.stringify(join(REPO_ROOT, "packages/momo-core/src/features/expressions/setFixtures.ts"))};
process.stdout.write(JSON.stringify({ normal: FIXTURE_SET_NORMAL, refused: FIXTURE_SET_REFUSED, plan: FIXTURE_SET_PLAN_CARD, planSeen: FIXTURE_SET_PLAN_CARD_SEEN }));\n`);
execFileSync(join(WEB_ROOT, "node_modules/.bin/esbuild"), [entry, "--bundle", "--platform=node", "--format=esm", `--outfile=${join(OUT, "fixtures-writer.mjs")}`, "--log-level=warning"]);
const FIXTURES = JSON.parse(execFileSync("node", [join(OUT, "fixtures-writer.mjs")], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));

// ---- 작은 PNG 그리기 ---------------------------------------------------------------------------------------------------
function png(width, height, pixel) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [r, g, b, a] = pixel(x, y);
    const at = y * (width * 4 + 1) + 1 + x * 4;
    raw[at] = r; raw[at + 1] = g; raw[at + 2] = b; raw[at + 3] = a;
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(type, 4, "ascii");
    const tail = Buffer.alloc(4); tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, tail]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const hsl = (h, s, l) => {
  const k = (n) => (n + h / 30) % 12; const a = s * Math.min(l, 1 - l); const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
};
/** 둥근 얼굴 하나: 칸 번호마다 색과 입 모양이 다르다(같은 그림 열 장으로 보이지 않게). */
function face(index, size = 128) {
  const [r, g, b] = hsl((index * 41 + 20) % 360, 0.7, 0.62); const c = size / 2; const R = size * 0.42;
  const eye = (cx, cy) => Math.hypot(0 + cx, cy) < size * 0.06;
  return png(size, size, (x, y) => {
    const dx = x - c; const dy = y - c; const d = Math.hypot(dx, dy);
    if (d > R) return [0, 0, 0, 0];
    if (eye(dx + size * 0.15, dy + size * 0.06) || eye(dx - size * 0.15, dy + size * 0.06)) return [30, 30, 36, 255];
    const mouth = Math.abs(Math.hypot(dx, dy - size * 0.02) - size * (0.14 + (index % 3) * 0.03)) < size * 0.025 && dy > size * 0.06;
    if (mouth) return [30, 30, 36, 255];
    return d > R - 3 ? [r * 0.6, g * 0.6, b * 0.6, 255].map(Math.round) : [r, g, b, 255];
  });
}
/** 참조 그림: 가로 직사각형 안에 얼굴 없는 큰 모양(별) 둘. 사람 얼굴이 아니라는 점이 캡처에서 읽혀야 한다. */
function reference(n) {
  const [r, g, b] = hsl(n === 1 ? 30 : 200, 0.55, 0.78);
  return png(160, 120, (x, y) => {
    const star = (cx, cy, rr) => { const a = Math.atan2(y - cy, x - cx); const d = Math.hypot(x - cx, y - cy); return d < rr * (0.55 + 0.45 * Math.abs(Math.cos(a * 2.5))); };
    if (star(54, 60, 36) || star(112, 58, 26)) return [60, 60, 70, 255];
    return [r, g, b, 255];
  });
}

// ---- 카드에 서는 데이터 ---------------------------------------------------------------------------------------------
/** 세트의 그림을 실제 Hermes 크기(정지 512, 작은 것·썸네일 128)로 적어, 종류 추천(J4)이 현실처럼 큰 이모티콘으로 나오게 한다. 해시는 그대로 둔다. */
function realistic(set) {
  const copy = JSON.parse(JSON.stringify(set));
  copy.workspaceId = WORKSPACE_ID;
  copy.expiresAtMs = NOW + 3_600_000;
  for (const slot of copy.slots) if (slot.state === "ready") {
    slot.media.large.width = slot.media.large.height = 512;
    slot.media.small.width = slot.media.small.height = 128;
    slot.media.thumb.width = slot.media.thumb.height = 128;
  }
  return copy;
}
const REFERENCE_IDS = FIXTURES.normal.references.map((reference) => reference.attachmentId);
const PLAN = { ...FIXTURES.plan, workspaceId: WORKSPACE_ID, expiresAtMs: NOW + 3_600_000 };
const SET_NORMAL = { ...realistic(FIXTURES.normal), setId: "00000000-0000-4000-8000-000000000401" };
const SET_REFUSED = { ...realistic(FIXTURES.refused), setId: "00000000-0000-4000-8000-000000000402" };
// 칸마다 다른 그림 id 를 가져야 한 카드의 칸이 다른 카드의 그림과 겹치지 않는다.
const draftId = (card, index) => `00000000-0000-4000-8000-000000${card}${index.toString(16).padStart(5, "0")}`;
for (const [card, set] of [[5, SET_NORMAL], [6, SET_REFUSED]]) for (const slot of set.slots) if (slot.state === "ready") slot.draftId = draftId(card, slot.index);
const ID = { plan: "0199aa11-3333-7000-8000-000000000011", normal: "0199aa11-3333-7000-8000-000000000012", refused: "0199aa11-3333-7000-8000-000000000013" };

function message(seq, author, body, extra = {}) {
  return {
    id: `0199aa11-2222-7000-8000-${String(seq).padStart(12, "0")}`, channelId: GENERAL_ID, seq, hlcTs: NOW - (20 - seq) * 60_000, hlcCount: 0,
    authorMemberId: author, type: "text", body, state: "sent", createdAtMs: NOW - (20 - seq) * 60_000, ...extra,
  };
}
function card(seq, approvalId, title, action) {
  return message(seq, AGENT, title, {
    type: "approval_request",
    props: { approval_id: approvalId, run_id: "0199aa11-2222-7000-8000-0000000000b2", channel_id: GENERAL_ID, action_type: "workspace_action", status: "pending", title, expires_at_ms: NOW + 3_600_000, action },
  });
}
const MESSAGES = [
  message(10, ME, "@코메토 고양이 스티커 세트 만들어 줘. 참고 그림 두 장 붙였어요"),
  card(11, ID.plan, "고양이 세트 계획", { id: "expression.set.plan", required_role: "requesting_member", rows: [], expressionSetPlan: PLAN }),
  card(12, ID.normal, "고양이 세트", { id: "expression.set.create", required_role: "expression_adder", rows: [], expressionSet: SET_NORMAL }),
  card(13, ID.refused, "고양이 세트", { id: "expression.set.create", required_role: "expression_adder", rows: [], expressionSet: SET_REFUSED }),
];
const draftIndex = new Map();
for (const set of [SET_NORMAL, SET_REFUSED]) for (const slot of set.slots) if (slot.state === "ready") draftIndex.set(slot.draftId, slot.index);

const json = (route, body, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

async function installCards(context, log) {
  await context.route(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/expressions(\\?.*)?$`), (route) => json(route, { workspaceId: WORKSPACE_ID, version: "3", baseVersion: null, reset: true, addPolicy: "members", items: [] }));
  await context.route(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/expression-drafts/([^/]+)/image`), (route) => {
    const id = new URL(route.request().url()).pathname.split("/").slice(-2)[0];
    log.push(`draft-image:${id.slice(-6)}`);
    return route.fulfill({ status: 200, contentType: "image/png", headers: { "Cache-Control": "private, no-store" }, body: face(draftIndex.get(id) ?? 0) });
  });
  await context.route(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/channels/${GENERAL_ID}/attachments/([^/]+)/content`), (route) => {
    const id = new URL(route.request().url()).pathname.split("/").slice(-2)[0];
    log.push(`attachment:${id.slice(-3)}`);
    return route.fulfill({ status: 200, contentType: "image/png", body: reference(REFERENCE_IDS.indexOf(id) === 0 ? 1 : 2) });
  });
  await context.route(new RegExp(`/v1/workspaces/[^/]+/channels/${GENERAL_ID}/messages(\\?.*)?$`), (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return json(route, { messages: MESSAGES });
  });
  // 결정: 고른 것을 그대로 등록한 영수증(실서버가 줄 모양: status approved + result.expressionSet).
  await context.route(new RegExp(`/v1/workspaces/${WORKSPACE_ID}/approvals/([^/]+)/decision$`), (route) => {
    const body = JSON.parse(route.request().postData() ?? "{}");
    log.push(`decision:${JSON.stringify({ approve: body.approve, choices: body.expressionChoices?.length ?? null, kinds: [...new Set((body.expressionChoices ?? []).map((choice) => choice.kind))] })}`);
    const set = body.approval_id === ID.normal ? SET_NORMAL : SET_REFUSED;
    const chosen = new Set((body.expressionChoices ?? []).map((choice) => choice.draftId));
    const registered = set.slots.filter((slot) => slot.state === "ready" && chosen.has(slot.draftId)).map((slot) => ({ id: slot.draftId, name: slot.name, token: `:${slot.name}:` }));
    return json(route, { status: body.approve ? "approved" : "rejected", approvalId: body.approval_id, result: body.approve ? { actionId: "expression.set.create", ref: { type: "expression_set", id: set.setId }, expressionSet: { setId: set.setId, registered, skipped: [] } } : null });
  });
}

async function shot(page, seq, name) {
  const row = page.locator(`[data-testid="timeline-message"][data-seq="${seq}"]`);
  await row.scrollIntoViewIfNeeded();
  // 포인터가 줄 위에 서 있으면 줄의 반응 막대가 카드 모서리를 덮는다: 옆으로 치운다.
  await page.mouse.move(4, 4);
  await sleep(500);
  const path = join(OUT, `web-${SCHEME}${WIDTH === 1280 ? "" : `-${WIDTH}`}-${name}.png`);
  await row.screenshot({ path, animations: "disabled", caret: "hide" });
  console.log(`  captured ${path}`);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: WIDTH, height: 2200 }, deviceScaleFactor: 1, colorScheme: SCHEME, timezoneId: "Asia/Seoul", locale: "ko-KR" });
    const log = [];
    await installBackend(context, PORT);
    await installCards(context, log);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log(`  [pageerror] ${String(error).slice(0, 300)}`));
    page.on("console", (message) => { if (message.type() === "error") console.log(`  [console.error] ${message.text().slice(0, 240)}`); });
    await signIn(page, ORIGIN);
    await openGeneral(page);
    await page.locator('[data-testid="expression-plan"]').waitFor({ state: "visible", timeout: 20_000 });
    await page.locator('[data-testid="expression-set"]').first().waitFor({ state: "visible", timeout: 20_000 });
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="expression-set-reference"][data-phase="0"]').length >= 2, null, { timeout: 15_000 });
    await sleep(1500);

    // 1. 계획 카드(처음 한 번의 고지가 있는 첫 계획)
    await shot(page, 11, "1-plan-first");
    // 2. 계획 고치기 (참조 빼기·칸 빼기·글 고치기)
    await page.locator('[data-testid="expression-plan-revise"]').click();
    await sleep(400);
    await shot(page, 11, "2-plan-edit");
    await page.locator('[data-testid="expression-plan-edit-back"]').click();
    // 3. 세트 카드(전부 준비됨, 전부 선택)
    const normal = page.locator('[data-testid="timeline-message"][data-seq="12"]');
    await shot(page, 12, "3-set-normal");
    // 4. 회색 칸이 있는 세트
    await shot(page, 13, "4-set-refused");
    // 5. 키보드: 방향키로 옮긴 포커스 고리와 두 칸을 뺀 모양(세트 카드)
    const tiles = normal.locator('[data-testid="expression-set-tile"]');
    await tiles.nth(0).focus();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Space");
    await page.keyboard.press("ArrowDown");
    await sleep(300);
    await shot(page, 12, "5-set-keyboard");
    // 6. 등록 뒤 결과 줄(숫자만)
    await normal.locator('[data-testid="expression-set-register"]').click();
    await normal.locator('[data-testid="expression-set-settled"]').waitFor({ state: "visible", timeout: 10_000 });
    await shot(page, 12, "6-set-result");
    console.log(`  requests: ${log.length} (${[...new Set(log.map((line) => line.split(":")[0]))].join(", ")})`);
    for (const line of log.filter((entry) => entry.startsWith("decision"))) console.log(`  ${line}`);
    await context.close();
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
