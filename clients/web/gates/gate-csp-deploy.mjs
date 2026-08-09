#!/usr/bin/env node
// =============================================================================
// GATE — 브라우저 **배포** CSP(infra/prod/Caddyfile)가 첨부 업로드를 막지 않는다
// (#1207 · A안 · ADR-0151 D1)
//
// `gates/gate-csp.mjs`는 **Tauri 셸**의 정책(`tauri.conf.json`)을 잰다. 그
// 정책은 `connect-src 'self' http: https: ws: wss:`라 어디로든 나가므로, 이
// 레포에서 가장 좁은 정책 — app.oor7.com 이 실제로 내려보내는 헤더 — 은
// **아무도 재지 않았다.** #1206이 실측한 사고가 정확히 그 사각이다: 계약상
// 첨부 바이트는 브라우저가 Drive로 직접 PUT 하는데(ADR-0151 D1) 그 호스트가
// `connect-src`에 없어 app.oor7.com 에서만 첨부가 불가능했고, 데스크톱 검수
// 표면(Tauri)에서는 영영 재현되지 않았다.
//
// 그래서 이 게이트의 정본은 **`infra/prod/Caddyfile`** 이다. 파일에서 헤더
// 문자열을 그대로 읽어 Vite preview에 붙이고, 제품의 진짜 업로드 경로
// (`features/attachments/uploadTransport.ts`)를 태운다. 값을 여기에 베껴 적지
// 않는 이유는 gate-csp.mjs 와 같다: 베낀 값은 배포와 조용히 갈라진다.
//
// ## 무엇이 증거인가
//
// `putAttachmentBytes`는 실패를 두 갈래로 **구별해서** 부른다 — 문서의
// `securitypolicyviolation`이 그 호스트에 대해 오면 `blocked`, 아니면
// `network`. 그 구별이 #1206이 만든 것이고, 화면에서는
// 「이 배포의 보안 정책이 보관소 주소를 막았습니다」한 줄로 나온다.
//
// 따라서 통과의 증거는 「업로드가 성공한다」가 아니라 **그 문구가 더는 안 뜬다**
// 이다. 게이트가 Google에 진짜로 바이트를 보내지 않아도(라우트가 가로채 abort
// 한다) 이 구별은 온전하다:
//
//   정책에 호스트가 있으면 → 위반 이벤트 없음 → `network`(또는 `status`)
//   정책에 호스트가 없으면 → 위반 이벤트 발생 → `blocked` + 그 한 줄
//
// 그리고 CSP는 네트워크 스택 **앞**에서 자르므로, 라우트 핸들러가 한 번이라도
// 불렸다는 사실 자체가 「정책이 이 요청을 허용했다」는 독립적인 두 번째 증거다.
//
// 실행 (npm run build 뒤):
//   npm run gate:csp-deploy
//
// 이름 붙은 red proof (expected FAIL):
//   CSP_DEPLOY_GATE_PROVE_RED_UPLOAD=1 npm run gate:csp-deploy
//     — 읽어 온 정책에서 `https://www.googleapis.com` **한 토큰만** 뺀다.
//       #1206의 그 문구가 다시 서고 라우트는 한 번도 안 불려야 하며, 그러지
//       않으면 이 게이트가 자기 자신을 실패시킨다(눈먼 판을 초록으로 두지 않는다).
//   CSP_DEPLOY_GATE_PROVE_RED_HEADER=1 npm run gate:csp-deploy
//     — preview에 정책을 아예 안 붙인다. 헤더가 실제로 페이지에 도달한다는
//       사실 자체를 증명한다(gate-csp.mjs 가 같은 이유로 세운 축).
//
// LIMIT: Chromium + Vite preview 이지 Caddy 자신이 아니다. 이 게이트가 재는 것은
// 「Caddyfile에 적힌 정책 문자열이 이 앱의 첨부 경로를 허용하는가」이고,
// 「Caddy가 그 헤더를 실제로 내려보내는가」는 scripts/verify_web_serving.sh 몫이다.
// =============================================================================

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");
const caddyfilePath = resolve(repoRoot, "infra/prod/Caddyfile");
const modelPath = resolve(
  repoRoot,
  "packages/momo-core/src/features/attachments/model.ts"
);

const port = Number(process.env.CSP_DEPLOY_GATE_PORT || 5183);
const origin = `http://127.0.0.1:${port}`;

const proveRedUpload = process.env.CSP_DEPLOY_GATE_PROVE_RED_UPLOAD === "1";
const proveRedHeader = process.env.CSP_DEPLOY_GATE_PROVE_RED_HEADER === "1";

/** 배포에서 Drive가 재개 가능 세션을 발급하는 호스트 (server-rust/.../google.rs). */
const ARCHIVE_HOST = "www.googleapis.com";
const ARCHIVE_ORIGIN = `https://${ARCHIVE_HOST}`;
/** 게이트가 REALTIME_DOMAIN 자리에 넣는 이름. 어디에도 연결되지 않는다. */
const REALTIME_DOMAIN = "realtime.csp-deploy-gate.invalid";

const workspaceId = "00000000-0000-7000-8000-000000000001";
const memberId = "00000000-0000-7000-8000-000000000101";
const channelId = "00000000-0000-7000-8000-000000000201";

/**
 * 「막혔다」의 문구를 **코어에서** 읽는다. 게이트가 문자열을 베껴 적으면 카피가
 * 바뀌는 날 이 판은 조용히 아무것도 안 재게 된다.
 */
function blockedCopy() {
  const source = readFileSync(modelPath, "utf8");
  const match = source.match(/case "blocked":\s*\n\s*return "([^"]+)";/);
  if (!match) throw new Error(`${modelPath}: uploadIssueCopy("blocked") 문구를 못 읽었다`);
  return match[1];
}

/**
 * 배포 정책을 Caddyfile에서 그대로 읽는다.
 *
 * APP_DOMAIN 사이트의 `handle {}` 블록 안에 있는 한 줄이 정본이다. 여러 줄이
 * 잡히면(사이트가 늘어났다는 뜻) 멈춘다 — 어느 것을 재는지 모르는 판은
 * 안 재는 판보다 나쁘다.
 */
function deployCsp() {
  const source = readFileSync(caddyfilePath, "utf8");
  const found = [...source.matchAll(/header Content-Security-Policy "([^"]+)"/g)];
  if (found.length !== 1) {
    throw new Error(
      `${caddyfilePath}: Content-Security-Policy 헤더가 ${found.length}개다 (1개여야 한다)`
    );
  }
  return found[0][1].replaceAll("{$REALTIME_DOMAIN}", REALTIME_DOMAIN);
}

function cspForRun(policy) {
  if (!proveRedUpload) return policy;
  const narrowed = policy.replace(` ${ARCHIVE_ORIGIN}`, "");
  if (narrowed === policy) {
    throw new Error(`red proof expected "${ARCHIVE_ORIGIN}" in the Caddyfile connect-src`);
  }
  return narrowed;
}

const session = {
  accessToken: "gate-only-not-a-credential",
  refreshToken: "gate-only-not-a-credential",
  member: {
    id: memberId,
    workspaceId,
    kind: "human",
    displayName: "곽성재",
    handle: "seongjae",
  },
  // 로그인 응답이 주는 주소(ADR-0110). 정책의 `wss://{$REALTIME_DOMAIN}` 자리와
  // 같은 이름이라, 이 소켓이 CSP에 걸리지 않는 것도 함께 재진다.
  realtimeWebSocketUrl: `wss://${REALTIME_DOMAIN}/connection/websocket`,
};

const channels = [
  { id: channelId, workspaceId, kind: "public", name: "release-2026-08", muted: false },
];

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
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function wait(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

function fail(message) {
  console.error(`GATE FAIL: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function expect(condition, message) {
  if (!condition) fail(message);
}

/**
 * Centrifuge가 진짜 소켓을 열지 않게 한다. 실제 배포에서 CSP가 이 주소를
 * 허용하는지는 정책 문자열이 답하는 것이고, 게이트가 DNS를 기다릴 이유는 없다.
 */
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
            replies.push({ id: command.id, connect: { client: "csp-gate", version: "6" } });
          } else if (command.subscribe) {
            replies.push({
              id: command.id,
              subscribe: {
                recoverable: true,
                positioned: true,
                recovered: true,
                epoch: "csp-gate",
                offset: 0,
              },
            });
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

async function installRoutes(context, seen) {
  // 실제 배포가 발급하는 그 호스트로 라우트를 건다. **CSP가 먼저 자르므로**,
  // 이 핸들러가 불렸다는 사실 = 정책이 이 요청을 허용했다는 뜻이다. 바이트를
  // 진짜로 내보내지 않기 위해 abort 한다 — 제품에게는 네트워크 실패로 보이고,
  // 그것은 `blocked`가 **아닌** 갈래다(그 구별이 이 게이트의 무게중심이다).
  await context.route(`${ARCHIVE_ORIGIN}/**`, async (route) => {
    seen.uploadAttempts += 1;
    if (route.request().headers().authorization !== undefined) {
      seen.bearerLeaked = true;
    }
    await route.abort("connectionrefused");
  });

  await context.route("**/v1/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;

    if (path === "/v1/auth/login") return json(route, session);
    if (path === "/v1/auth/refresh") {
      return json(route, {
        accessToken: session.accessToken,
        refreshToken: session.refreshToken,
      });
    }
    if (path === "/v1/auth/realtime-token") {
      return json(route, {
        token: "gate-only-not-a-credential",
        tokenType: "Bearer",
        expiresAtMs: Date.now() + 60_000,
        ttlSeconds: 60,
        workspaceId,
        memberId,
      });
    }
    if (path.endsWith("/channels")) return json(route, { channels });
    if (path.endsWith("/roster")) return json(route, { members: roster });
    if (path.endsWith("/read-state")) return json(route, { read_states: [] });
    if (path.endsWith("/huddles/active")) return json(route, { huddle: null });
    if (path.endsWith("/work-sessions")) return json(route, { sessions: [] });
    if (path.endsWith("/replies")) return json(route, { messages: [] });
    if (path.includes("/approvals")) return json(route, { approvals: [] });
    if (path.includes("/pins")) return json(route, { pins: [] });

    // ADR-0151 D1: 서버는 Drive의 재개 가능 세션 주소를 그대로 넘긴다. 배포에서
    // 이 값의 호스트가 www.googleapis.com 이고, 그것이 이 티켓의 전부다.
    if (path.endsWith("/attachments/uploads")) {
      const body = JSON.parse(request.postData() ?? "{}");
      return json(
        route,
        {
          id: "0199eeee-0000-7000-8000-0000000000aa",
          status: "pending",
          uploadUrl:
            `${ARCHIVE_ORIGIN}/upload/drive/v3/files` +
            `?uploadType=resumable&upload_id=gate-${encodeURIComponent(body.name ?? "f")}`,
        },
        201
      );
    }
    if (path.endsWith("/messages")) return json(route, { messages: [] });
    return json(route, {});
  });
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }

  const policy = deployCsp();
  const served = cspForRun(policy);
  const copy = blockedCopy();

  // 헤더 red proof: 정책을 아예 안 붙인다. 아래의 "헤더가 도달했다" 단정이
  // 실제로 무언가를 재고 있다는 증거.
  const env = { ...process.env };
  if (proveRedHeader) delete env.MOMO_CSP_GATE_HEADER;
  else env.MOMO_CSP_GATE_HEADER = served;

  const server = spawn(
    resolve(webRoot, "node_modules/.bin/vite"),
    ["preview", "--port", String(port), "--strictPort", "--host", "127.0.0.1"],
    { cwd: webRoot, env, stdio: "ignore" }
  );

  const seen = { uploadAttempts: 0, bearerLeaked: false };

  try {
    const deadline = Date.now() + 30_000;
    let probe = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(origin);
        if (response.ok) {
          probe = response;
          break;
        }
      } catch {
        /* preview 서버가 아직 뜨는 중 */
      }
      await wait(200);
    }
    if (probe === null) throw new Error("preview server never came up");

    const header = probe.headers.get("content-security-policy");
    expect(
      header === served,
      `배포 정책이 preview에 도달하지 않았다: expected ${JSON.stringify(served)}, got ${JSON.stringify(header)}`
    );
    expect(
      header.includes(`connect-src`) && header.includes(ARCHIVE_ORIGIN) !== proveRedUpload,
      `connect-src의 ${ARCHIVE_ORIGIN} 상태가 이 실행의 의도와 다르다: ${header}`
    );

    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
      });
      await context.addInitScript(() => {
        window.__cspViolations = [];
        document.addEventListener("securitypolicyviolation", (event) => {
          window.__cspViolations.push({
            blockedURI: event.blockedURI,
            effectiveDirective: event.effectiveDirective || event.violatedDirective,
          });
        });
      });

      const page = await context.newPage();
      await installRealtimeSocket(page);
      await installRoutes(context, seen);

      await page.goto(origin, { waitUntil: "networkidle" });
      await page.getByTestId("login-email").fill("csp@example.test");
      await page.getByTestId("login-password").fill("gate-only");
      await page.getByTestId("login-submit").click();
      await page.getByTestId("channel-item").first().waitFor({ timeout: 15_000 });

      await page.evaluate((id) => {
        window.location.hash = `#/c/${id}`;
      }, channelId);
      await page.getByTestId("composer-input").waitFor({ timeout: 15_000 });
      await wait(400);

      const dir = resolve(webRoot, "artifacts/csp-deploy-fixtures");
      mkdirSync(dir, { recursive: true });
      const logFile = resolve(dir, "drain-2026-08-09.log");
      writeFileSync(logFile, "2026-08-09T09:10:00Z drain batch=1 lag=12ms\n".repeat(40));

      await page.locator('input[type="file"]').first().setInputFiles(logFile);

      const chip = page.getByTestId("attachment-chip").first();
      await chip.waitFor({ timeout: 10_000 });
      // 성공이든 실패든 칩이 멈추는 자리까지 기다린다.
      await page.waitForFunction(
        () =>
          ["failed", "uploaded", "verifying"].includes(
            document.querySelector('[data-testid="attachment-chip"]')?.dataset
              .attachmentStatus ?? ""
          ),
        undefined,
        { timeout: 20_000 }
      );
      await wait(300);

      const violations = await page.evaluate(() => window.__cspViolations ?? []);
      const archiveViolations = violations.filter(
        (violation) =>
          violation.effectiveDirective.startsWith("connect-src") &&
          violation.blockedURI.includes(ARCHIVE_HOST)
      );
      const statusLine = await chip.getByTestId("attachment-chip-status").innerText();

      expect(!seen.bearerLeaked, "capability URL 에 베어러가 실렸다");

      if (proveRedUpload) {
        // 이 판이 눈멀지 않았다는 증거: 토큰 하나를 빼면 #1206의 그 문장이 선다.
        expect(
          archiveViolations.length > 0,
          `red proof: ${ARCHIVE_HOST} 에 대한 connect-src 위반이 없다 (${JSON.stringify(violations)})`
        );
        expect(
          statusLine.includes(copy),
          `red proof: 「${copy}」가 서지 않았다 (실제: ${JSON.stringify(statusLine)})`
        );
        expect(
          seen.uploadAttempts === 0,
          `red proof: 정책이 막았는데 요청이 ${seen.uploadAttempts}번 나갔다`
        );
        fail(
          `배포 CSP에서 ${ARCHIVE_ORIGIN} 을 빼면 첨부 업로드가 「${copy}」로 막힌다 ` +
            "— #1207 이 닫은 그 실패를 그대로 재현했다"
        );
      }

      expect(
        archiveViolations.length === 0,
        `배포 CSP가 ${ARCHIVE_HOST} 로의 업로드를 막았다: ${JSON.stringify(archiveViolations)}`
      );
      expect(
        violations.length === 0,
        `배포 CSP가 첨부 경로의 무언가를 막았다: ${JSON.stringify(violations)}`
      );
      expect(
        seen.uploadAttempts > 0,
        "업로드 요청이 네트워크 층까지 오지 않았다 — 정책이 앞에서 잘랐거나 경로가 안 탔다"
      );
      expect(
        !statusLine.includes(copy),
        `#1206의 「${copy}」가 아직 뜬다 (실제: ${JSON.stringify(statusLine)})`
      );

      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    server.kill("SIGTERM");
  }

  console.log(
    `GATE PASS: infra/prod/Caddyfile 의 정책이 preview에 그대로 도달했고, ` +
      `그 정책 아래에서 첨부 PUT 이 ${ARCHIVE_HOST} 까지 나갔으며 ` +
      `(요청 ${seen.uploadAttempts}건, connect-src 위반 0건), ` +
      `#1206 의 「${blockedCopy()}」는 서지 않았다.`
  );
}

await main();
