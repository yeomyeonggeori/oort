#!/usr/bin/env node
// =============================================================================
// GATE — 브라우저 **배포**의 보안 헤더가 첨부 업로드를 막지 않는다
// (#1207 · A안 · ADR-0151 D1 / #1213 라이브 확장 / #2181·#2297 렌더 기반)
//
// ## #2181: 게이트가 읽던 것은 정책이 아니라 플레이스홀더였다
//
// SH-2(#1926)가 공개 엣지의 사이트 주소와 `connect-src` 를 Caddy env
// 플레이스홀더(`{$OORT_SITE_ADDRESS}` · `{$OORT_CSP_CONNECT_SRC}`)로 템플릿화한
// 뒤, 이 게이트는 파일의 **리터럴** 토큰을 세고 있었다 — `{$OORT_CSP_CONNECT_SRC}`
// 한 덩어리를 「'self' 가 없다 · googleapis 가 없다 · wss 가 없다」로 읽고
// 붉었다(선재 RED, 어디에도 배선되지 않아 아무도 못 봤다). 파일이 정책이 아니라
// 정책의 **틀**이 된 순간, 파일을 읽는 판은 틀을 재는 판이 됐다.
//
// 그래서 이제 Caddy 가 실제로 하는 일을 시킨다: 픽스처 env(`app.example.test`)
// 로 `caddy adapt` 를 돌려 **렌더된 JSON** 을 얻고, 그 안의 응답 헤더 집합을
// 잰다. 플레이스홀더는 Caddy 의 caddyfile 어댑터가 파싱 시점에 치환하므로,
// 렌더 결과에는 정책만 남는다. 픽스처 값은 `scripts/tests/test_public_edge.sh`
// · `test_railway_template.sh` 와 같은 모양(`example.test`, 실호스트 0건)이다.
// 렌더는 로컬 `caddy` 가 PATH 에 있으면 그것으로, 없으면 도커 이미지
// (`MOMO_CADDY_IMAGE`, 기본 `caddy:2-alpine` — 셸 시험들과 같은 변수)로 한다.
//
// 대상은 `TARGETS` 한 상수다(ADR-0184 D5). 플랫폼 엣지 파일이 늘면 거기에 한
// 줄을 더한다 — 이 게이트가 파일을 하나만 지키다 사각이 생긴 것이 #1213 이고,
// 파일이 둘이 된 뒤 셋째(Railway)가 표 밖에 있었던 것이 #2297 이다.
//
// ## #1213: 게이트가 지키던 파일은 라이브 파일이 아니었다
//
// 이 게이트는 `infra/prod/Caddyfile` 하나만 읽었다. 그 파일은 **셀프호스트
// compose**용이고, app.oor7.com 이 실제로 내려보내는 것은
// `infra/rust/Caddyfile`이다(#1217이 서버에서 회수해 레포 정본으로 세웠다).
// 즉 「아무도 재지 않은 정책」을 재겠다고 세운 판이 다시 한 번 라이브가 아닌
// 파일을 재고 있었다 — #1206의 사각이 파일 하나 옆으로 옮겨 간 모양이다.
//
// 그래서 **파일마다** 두 겹이다.
//
//   1. 렌더 결과만 읽고 답하는 정적 검사 — 헤더 5종(CSP · HSTS · nosniff ·
//      Referrer-Policy · 클릭재킹 방어), CSP 필수 소스(googleapis 포함), **HSTS
//      preload 부재**, 픽스처 호스트가 실제로 사이트 매처에 도달했는지(렌더가
//      env 를 읽었다는 증거), 레일 스킴 규칙(아래). preload는 브라우저 소스에
//      박히는 비가역 등재라 「빠뜨리면 안 되는 것」이 아니라 「들어가면 안 되는
//      것」으로 잰다.
//   2. 렌더된 CSP 문자열을 그대로 붙인 preview에 진짜 업로드 경로를 태우는
//      브라우저 검사 — 아래에 적힌 그대로.
//
// ## 레일 스킴 규칙 (#2181 수용기준)
//
// 엣지에는 두 종류가 있고 정책도 둘이다:
//   · `tls`       브라우저가 https 로 여는 엣지(공개 compose · Railway — 후자는
//                 플랫폼이 TLS 를 끊지만 브라우저 오리진은 https 다). HSTS 필수,
//                 레일은 `wss://` 만. `ws://` 토큰은 https 문서에서 혼합 콘텐츠로
//                 잘리는 죽은 토큰이라 있으면 결함이다.
//   · `plaintext` 127.0.0.1 루프백 엣지(`Caddyfile.local`). 레일은 `ws://`
//                 (포트 와일드카드 허용 — 포트는 MOMO_WEB_PORT 로 움직인다).
//                 HSTS 는 **없어야 한다** — 브라우저가 기억하는 헤더라 localhost
//                 를 HTTPS 전용으로 기억시키면 다른 로컬 스택까지 깨진다(그 파일
//                 머리말의 실측). 「일부러 없는 것」은 「빠진 것」과 같은 방식으로
//                 잰다: 들어오면 빨강.
//
// `gates/gate-csp.mjs`는 **Tauri 셸**의 정책(`tauri.conf.json`)을 잰다. 그
// 정책은 `connect-src 'self' http: https: ws: wss:`라 어디로든 나가므로, 이
// 레포에서 가장 좁은 정책 — app.oor7.com 이 실제로 내려보내는 헤더 — 은
// **아무도 재지 않았다.** #1206이 실측한 사고가 정확히 그 사각이다: 계약상
// 첨부 바이트는 브라우저가 Drive로 직접 PUT 하는데(ADR-0151 D1) 그 호스트가
// `connect-src`에 없어 app.oor7.com 에서만 첨부가 불가능했고, 데스크톱 검수
// 표면(Tauri)에서는 영영 재현되지 않았다.
//
// 그래서 이 게이트의 정본은 **배포 Caddyfile 그 자체**다. 파일에서 헤더
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
//   (#1213 · #2297) 정적 검사의 red proof 는 env 스위치가 아니라 **파일을 고치는
//       것**이다: 엣지 파일에서 헤더 한 줄을 지우거나, `connect-src` 의
//       `{$OORT_CSP_CONNECT_SRC}` 를 wss 없는 리터럴로 바꾸고 이 게이트를 돌리면
//       브라우저를 띄우기도 전에 그 파일과 이유를 대며 빨강이 된다. 이름 붙은
//       스위치를 두지 않은 이유는, 그 스위치가 재는 것이 결국 「내가 지운 줄을
//       내가 찾는가」이기 때문이다 — 진짜 회귀는 사람이 파일을 고칠 때 오고, 그
//       경로를 그대로 밟아 보는 것이 증거다(PR 본문에 실행 기록).
//
// LIMIT: Chromium + Vite preview 이지 Caddy 자신이 아니다. 이 게이트가 재는 것은
// 「이 엣지 파일이 픽스처 env 로 렌더한 정책이 이 앱의 첨부 경로를 허용하는가」
// 이고, 「Caddy가 그 헤더를 실제 요청에 내려보내는가」는 scripts/verify_web_serving.sh
// 몫이다. 픽스처 env 는 생성기(`scripts/self_host_env.sh --public-origin`) 가
// 만드는 값의 모양이지 생성기 출력 그 자체는 아니다 — 생성기와 이 픽스처의
// 정합은 `scripts/tests/test_public_edge.sh` 가 잰다.
// =============================================================================

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { startGuardedPreview } from "./preview-guard.mjs";
import { advanceToAccount } from "../e2e/advanceOnboarding.mjs";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webRoot, "../..");

/** 배포에서 Drive가 재개 가능 세션을 발급하는 호스트 (server-rust/.../google.rs). */
const ARCHIVE_HOST = "www.googleapis.com";
const ARCHIVE_ORIGIN = `https://${ARCHIVE_HOST}`;

/**
 * 렌더 픽스처. 실호스트가 아니다 — `example.test` 는 RFC 2606 예약 도메인이라
 * 어디에도 닿지 않고, 셸 시험(`test_public_edge.sh` · `test_railway_template.sh`)
 * 과 같은 관례다. CSP 값은 생성기가 `--public-origin https://<host>` 에서
 * 파생하는 모양 그대로: 'self' · https 쌍둥이 · wss 쌍둥이 · 첨부 PUT 목적지.
 */
const FIXTURE_HOST = "app.example.test";
const FIXTURE_ENV = {
  OORT_SITE_ADDRESS: FIXTURE_HOST,
  OORT_CSP_CONNECT_SRC: `'self' https://${FIXTURE_HOST} wss://${FIXTURE_HOST} ${ARCHIVE_ORIGIN}`,
};

/**
 * 이 게이트가 지키는 엣지 파일들 (#1213 · #2297 · ADR-0184 D5).
 *
 * 순서는 취향이 아니다 — 하나가 빨갛다면 먼저 알아야 할 쪽이 지금 사람이 쓰고
 * 있는 배포(공개 compose)이기 때문이다. 새 플랫폼 엣지 파일은 여기에 한 줄:
 *   · `edge`  "tls" | "plaintext" — 레일 스킴·HSTS 규칙(머리말 참조)
 *   · `env`   `caddy adapt` 에 넣을 픽스처 env. 파일이 읽는 플레이스홀더 전부.
 *   · `host`  렌더된 사이트 매처에 있어야 하는 호스트. 포트만 있는 사이트는 null.
 */
const TARGETS = [
  {
    label: "infra/rust/Caddyfile (공개 엣지 템플릿 · compose T1)",
    path: resolve(repoRoot, "infra/rust/Caddyfile"),
    edge: "tls",
    env: FIXTURE_ENV,
    host: FIXTURE_HOST,
  },
  {
    label: "infra/rust/Caddyfile.local (셀프호스트 로컬 엣지 · 평문 루프백)",
    path: resolve(repoRoot, "infra/rust/Caddyfile.local"),
    edge: "plaintext",
    env: {},
    host: null,
  },
  {
    label: "infra/railway/Caddyfile.railway (Railway T2 · 플랫폼이 TLS 종단)",
    path: resolve(repoRoot, "infra/railway/Caddyfile.railway"),
    edge: "tls",
    env: { ...FIXTURE_ENV, PORT: "8080" },
    host: FIXTURE_HOST,
  },
];

const modelPath = resolve(
  repoRoot,
  "packages/momo-core/src/features/attachments/model.ts"
);

const port = Number(process.env.CSP_DEPLOY_GATE_PORT || 5183);
const origin = `http://127.0.0.1:${port}`;

const proveRedUpload = process.env.CSP_DEPLOY_GATE_PROVE_RED_UPLOAD === "1";
const proveRedHeader = process.env.CSP_DEPLOY_GATE_PROVE_RED_HEADER === "1";

/** 셸 시험들과 같은 변수 이름. 로컬 `caddy` 가 PATH 에 있으면 이미지는 안 쓴다. */
const CADDY_IMAGE = process.env.MOMO_CADDY_IMAGE || "caddy:2-alpine";

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
 * 렌더 도구. 로컬 `caddy` 가 있으면 그것, 없으면 도커 이미지. 둘 다 없으면 이
 * 게이트는 **닫혀서** 실패한다 — 도구가 없는 날 초록이 되는 판은 그날이 바로
 * 필요한 날에 아무것도 재지 않는다(#1236 과 같은 규율).
 */
function caddyRunner() {
  const local = spawnSync("caddy", ["version"], { encoding: "utf8" });
  if (local.status === 0) {
    return { label: `caddy ${local.stdout.trim()} (PATH)`, mode: "local" };
  }
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (docker.status === 0) {
    return { label: `docker ${docker.stdout.trim()} · ${CADDY_IMAGE}`, mode: "docker" };
  }
  throw new Error(
    "caddy adapt 를 돌릴 수단이 없다 — PATH 에 caddy 가 없고 docker 데몬도 응답하지 않는다. " +
      "둘 중 하나를 준비하고 다시 돌려라(이 게이트는 도구 없이 초록이 되지 않는다)."
  );
}

/**
 * `caddy adapt` — 엣지 파일을 픽스처 env 로 렌더한 JSON.
 *
 * 호스트 env 는 넘기지 않는다. 이 셸에 진짜 `OORT_SITE_ADDRESS` 가 실려 있어도
 * 렌더는 픽스처만 본다 — 그래야 「이 파일이 이 env 를 읽는다」가 재지고, 실호스트
 * 이름이 게이트 출력에 섞이지 않는다.
 */
function renderCaddy(target, runner) {
  let result;
  if (runner.mode === "local") {
    result = spawnSync(
      "caddy",
      ["adapt", "--config", target.path, "--adapter", "caddyfile"],
      {
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: process.env.HOME, ...target.env },
      }
    );
  } else {
    const args = ["run", "--rm"];
    for (const [key, value] of Object.entries(target.env)) args.push("-e", `${key}=${value}`);
    args.push(
      "-v",
      `${target.path}:/etc/caddy/Caddyfile:ro`,
      CADDY_IMAGE,
      "caddy",
      "adapt",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile"
    );
    result = spawnSync("docker", args, { encoding: "utf8" });
  }
  if (result.status !== 0) {
    throw new Error(
      `${target.label}: caddy adapt 실패 (exit ${result.status})\n` +
        `    ${String(result.stderr ?? "").trim().split("\n").join("\n    ")}`
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`${target.label}: caddy adapt 출력이 JSON 이 아니다: ${error.message}`);
  }
}

/**
 * 렌더된 JSON 에서 이 게이트가 재는 것만 걷어 온다.
 *
 *   headers   `handler: "headers"` 의 `response.set` 전부 — 사이트 전역 블록과
 *             SPA handle 안의 CSP 가 서로 다른 핸들러로 나오므로 합쳐서 본다.
 *   hosts     사이트 매처의 host 목록 — 픽스처 호스트가 여기 있으면 env 가 파일을
 *             지나 렌더까지 왔다는 뜻이다.
 *   listen    서버가 듣는 주소 — 포트만 있는 로컬 엣지의 형태 증거.
 */
function collectRendered(json) {
  const headers = new Map();
  const hosts = [];
  const listen = [];
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node === null || typeof node !== "object") return;
    if (node.handler === "headers" && node.response?.set) {
      for (const [name, values] of Object.entries(node.response.set)) {
        const key = name.toLowerCase();
        const list = headers.get(key) ?? [];
        list.push(...(Array.isArray(values) ? values : [values]));
        headers.set(key, list);
      }
    }
    if (Array.isArray(node.match)) {
      for (const matcher of node.match) {
        if (Array.isArray(matcher?.host)) hosts.push(...matcher.host);
      }
    }
    if (Array.isArray(node.listen)) listen.push(...node.listen);
    for (const value of Object.values(node)) walk(value);
  };
  walk(json);
  return { headers, hosts, listen };
}

/** 정책 문자열을 `{ 지시어: [소스…] }` 로. 값 비교는 전부 이 위에서 한다. */
function cspDirectives(policy) {
  const table = new Map();
  for (const part of policy.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    table.set(tokens[0], tokens.slice(1));
  }
  return table;
}

/**
 * 이 엣지가 레일에 쓰는 주소. 렌더된 정책에서 **읽는다** — 게이트가 도메인을
 * 알고 있으면 파일이 바뀌는 날 그 앎이 곧 거짓이 된다.
 *
 * tls 엣지는 `wss://<host>` 토큰이 곧 주소다. 평문 엣지의 `ws://127.0.0.1:*` 는
 * 포트 와일드카드라 그대로 주소가 못 되므로 preview 포트를 넣는다 — 그 주소가
 * 와일드카드 토큰에 매칭되는지는 정책 문법이 답하고, 소켓 자체는 스텁이라 이
 * 주소로 나가는 트래픽은 없다. 재는 것은 「이 주소가 정책을 통과하는가」다.
 */
function realtimeUrlFromPolicy(policy, target) {
  const connect = cspDirectives(policy).get("connect-src") ?? [];
  if (target.edge === "tls") {
    const wss = connect.find((source) => source.startsWith("wss://"));
    if (wss === undefined) {
      throw new Error(`${target.label}: connect-src에 wss:// 레일 주소가 없다`);
    }
    return `${wss}/connection/websocket`;
  }
  const loopback = connect.find((source) => /^ws:\/\/127\.0\.0\.1(:\*|:\d+)?$/.test(source));
  if (loopback === undefined) {
    throw new Error(`${target.label}: connect-src에 ws://127.0.0.1 레일 토큰이 없다`);
  }
  return `ws://127.0.0.1:${port}/connection/websocket`;
}

/**
 * 브라우저를 띄우기 전에, 렌더 결과만 읽고 답할 수 있는 것들 (#1213 · #2297).
 *
 * 헤더 5종 · CSP 필수 소스 · HSTS preload 부재 · 픽스처 호스트 도달 · 레일 스킴.
 * 실패는 모아서 한 번에 말한다 — 한 줄씩 고치고 다시 돌리게 만드는 판은 사람이
 * 게이트를 미워하게 만든다.
 */
function assertDeployHeaders(target, runner) {
  const rendered = collectRendered(renderCaddy(target, runner));
  const { headers } = rendered;
  const problems = [];
  const tls = target.edge === "tls";

  // 픽스처 호스트가 사이트 매처에 도달했는가 — 이것이 「렌더가 env 를 읽었다」의
  // 증거다. 리터럴 호스트로 되돌아간 파일은 픽스처 대신 그 이름을 내놓는다.
  if (target.host !== null) {
    const unique = [...new Set(rendered.hosts)];
    if (unique.length !== 1 || unique[0] !== target.host) {
      problems.push(
        `렌더된 사이트 호스트가 픽스처와 다르다: expected [${target.host}], got ${JSON.stringify(unique)}`
      );
    }
  } else if (rendered.hosts.length !== 0) {
    problems.push(
      `포트만 있어야 하는 로컬 엣지에 호스트 매처가 있다: ${JSON.stringify(rendered.hosts)} — 호스트가 붙으면 자동 HTTPS 가 켜지고 부팅 시각에 ACME 주문이 나간다(#1239)`
    );
  }

  const hsts = headers.get("strict-transport-security") ?? [];
  if (tls) {
    if (hsts.length === 0) problems.push("Strict-Transport-Security 가 없다");
    for (const value of hsts) {
      if (!/max-age=\d+/.test(value)) {
        problems.push(`HSTS에 max-age가 없다: ${JSON.stringify(value)}`);
      }
      // 비가역이라서 「없어야 하는 것」으로 잰다. 프리로드 목록은 브라우저 소스에
      // 박히고, 빼는 데 수개월이 걸린다 — 실수로 한 줄 늘어나는 것을 배포 뒤에
      // 알게 되는 종류의 헤더가 아니다.
      if (/preload/i.test(value)) {
        problems.push(`HSTS에 preload가 있다(비가역 등재 금지): ${JSON.stringify(value)}`);
      }
    }
  } else if (hsts.length !== 0) {
    problems.push(
      `평문 루프백 엣지에 HSTS 가 있다: ${JSON.stringify(hsts)} — 브라우저가 localhost 를 HTTPS 전용으로 기억해 다른 로컬 스택까지 깬다(Caddyfile.local 머리말)`
    );
  }

  if (!(headers.get("x-content-type-options") ?? []).some((v) => /^nosniff$/i.test(v))) {
    problems.push('X-Content-Type-Options "nosniff" 가 없다');
  }
  if (!(headers.get("referrer-policy") ?? []).some((v) => v.length > 0)) {
    problems.push("Referrer-Policy 가 없다");
  }

  // 웹을 서빙하는 handle 안의 한 줄이 정본이다. 여러 개가 렌더되면(사이트가
  // 늘었다는 뜻) 멈춘다 — 어느 것을 재는지 모르는 판은 안 재는 판보다 나쁘다.
  const csps = headers.get("content-security-policy") ?? [];
  let policy = null;
  if (csps.length !== 1) {
    problems.push(`Content-Security-Policy 헤더가 ${csps.length}개 렌더됐다 (1개여야 한다)`);
  } else {
    policy = csps[0];
  }

  if (policy !== null) {
    const table = cspDirectives(policy);
    /** 각 소스의 근거는 엣지 파일 주석에 있다. 여기 있는 것은 「빠지면 안 된다」뿐. */
    const required = [
      ["default-src", ["'self'"]],
      ["connect-src", ["'self'", ARCHIVE_ORIGIN]],
      ["img-src", ["'self'", "data:"]],
      ["style-src", ["'self'", "'unsafe-inline'"]],
    ];
    for (const [directive, sources] of required) {
      const present = table.get(directive);
      if (present === undefined) {
        problems.push(`CSP에 ${directive} 가 없다`);
        continue;
      }
      for (const source of sources) {
        if (!present.includes(source)) {
          problems.push(`CSP ${directive} 에 ${source} 가 없다`);
        }
      }
    }
    const connect = table.get("connect-src") ?? [];
    if (connect.some((s) => s === "*" || s.includes("://*"))) {
      problems.push(`CSP connect-src 에 와일드카드가 있다(생성기가 거절하는 형태 #1792): ${connect.join(" ")}`);
    }
    if (tls) {
      if (!connect.some((s) => s.startsWith("wss://"))) {
        problems.push("CSP connect-src 에 wss:// 레일 주소가 없다");
      }
      for (const dead of connect.filter((s) => s.startsWith("ws://"))) {
        problems.push(`https 엣지의 connect-src 에 평문 ws:// 토큰이 있다(혼합 콘텐츠로 잘리는 죽은 토큰): ${dead}`);
      }
    } else if (!connect.some((s) => s.startsWith("ws://"))) {
      problems.push("평문 루프백 엣지의 CSP connect-src 에 ws:// 레일 주소가 없다");
    }
    // 클릭재킹: CSP의 frame-ancestors 나 X-Frame-Options 중 **하나**면 된다.
    // 둘 다 요구하면 중복을 강제하게 되고, 하나도 요구하지 않으면 이 축이 없다.
    const frameAncestors = table.get("frame-ancestors") ?? [];
    const hasXfo = (headers.get("x-frame-options") ?? []).some((v) =>
      /^(DENY|SAMEORIGIN)$/i.test(v)
    );
    if (!frameAncestors.includes("'none'") && !hasXfo) {
      problems.push(
        "클릭재킹 방어가 없다 (CSP frame-ancestors 'none' 또는 X-Frame-Options 중 하나)"
      );
    }
  }

  if (problems.length > 0) {
    fail(
      `${target.label} — 렌더된 헤더 정책이 깨졌다 (${runner.label}, env ${JSON.stringify(target.env)}):\n` +
        problems.map((line) => `  · ${line}`).join("\n")
    );
  }
  return policy;
}

function cspForRun(policy) {
  if (!proveRedUpload) return policy;
  const narrowed = policy.replace(` ${ARCHIVE_ORIGIN}`, "");
  if (narrowed === policy) {
    throw new Error(`red proof expected "${ARCHIVE_ORIGIN}" in the Caddyfile connect-src`);
  }
  return narrowed;
}

/**
 * 로그인 응답. 주소는 배포 정책에서 읽어 온 것을 그대로 쓴다(ADR-0110) — 정책의
 * `wss://…` 자리와 같은 이름이라, 이 소켓이 CSP에 걸리지 않는 것도 함께 재진다.
 */
function sessionFor(realtimeWebSocketUrl) {
  return {
    accessToken: "gate-only-not-a-credential",
    refreshToken: "gate-only-not-a-credential",
    member: {
      id: memberId,
      workspaceId,
      kind: "human",
      displayName: "곽성재",
      handle: "seongjae",
    },
    realtimeWebSocketUrl,
  };
}

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

async function installRoutes(context, seen, session) {
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

/**
 * 배포 파일 한 장을 브라우저에 태운다. 이 함수가 끝나면 그 파일의 정책 아래에서
 * 첨부 PUT 이 실제로 나갔다는 사실 하나가 증명돼 있다.
 */
async function runTarget(target, policy) {
  const served = cspForRun(policy);
  const copy = blockedCopy();
  const session = sessionFor(realtimeUrlFromPolicy(policy, target));

  // 헤더 red proof: 정책을 아예 안 붙인다. 아래의 "헤더가 도달했다" 단정이
  // 실제로 무언가를 재고 있다는 증거.
  const env = { ...process.env };
  if (proveRedHeader) delete env.MOMO_CSP_GATE_HEADER;
  else env.MOMO_CSP_GATE_HEADER = served;

  const server = await startGuardedPreview({
    webRoot,
    port,
    portEnvVar: "CSP_DEPLOY_GATE_PORT",
    env,
  });

  const seen = { uploadAttempts: 0, bearerLeaked: false };

  try {
    const probe = server.probe;

    const header = probe.headers.get("content-security-policy");
    expect(
      header === served,
      `${target.label}: 배포 정책이 preview에 도달하지 않았다: expected ${JSON.stringify(served)}, got ${JSON.stringify(header)}`
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
      await installRoutes(context, seen, session);

      await page.goto(origin, { waitUntil: "networkidle" });
      await advanceToAccount(page);
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
          `${target.label}: 배포 CSP에서 ${ARCHIVE_ORIGIN} 을 빼면 첨부 업로드가 ` +
            `「${copy}」로 막힌다 — #1207 이 닫은 그 실패를 그대로 재현했다`
        );
      }

      expect(
        archiveViolations.length === 0,
        `${target.label}: 배포 CSP가 ${ARCHIVE_HOST} 로의 업로드를 막았다: ${JSON.stringify(archiveViolations)}`
      );
      expect(
        violations.length === 0,
        `${target.label}: 배포 CSP가 첨부 경로의 무언가를 막았다: ${JSON.stringify(violations)}`
      );
      expect(
        seen.uploadAttempts > 0,
        `${target.label}: 업로드 요청이 네트워크 층까지 오지 않았다 — 정책이 앞에서 잘랐거나 경로가 안 탔다`
      );
      expect(
        !statusLine.includes(copy),
        `${target.label}: #1206의 「${copy}」가 아직 뜬다 (실제: ${JSON.stringify(statusLine)})`
      );

      await context.close();
    } finally {
      await browser.close();
    }
  } finally {
    // 다음 대상이 같은 포트를 `--strictPort`로 잡는다. stop() 은 자식이
    // **실제로 죽을 때까지** 기다린다 — 리스너는 프로세스와 함께 닫힌다.
    await server.stop();
  }

  console.log(
    `  ✓ ${target.label} — 정책이 preview에 그대로 도달했고, 그 정책 아래에서 ` +
      `첨부 PUT 이 ${ARCHIVE_HOST} 까지 나갔다 ` +
      `(요청 ${seen.uploadAttempts}건, connect-src 위반 0건).`
  );
}

async function main() {
  if (!existsSync(resolve(webRoot, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run npm run build first.");
  }

  // 렌더 + 정적 검사가 **먼저** 전부 돈다. 브라우저를 20초 띄운 뒤에 「그런데
  // HSTS가 없네요」라고 말하는 판은, 헤더 한 줄을 지운 사람에게 그 사실을 20초
  // 늦게 알려 주는 것 말고 하는 일이 없다.
  const runner = caddyRunner();
  console.log(`GATE: caddy adapt 렌더 = ${runner.label} · 픽스처 호스트 ${FIXTURE_HOST}`);
  const policies = TARGETS.map((target) => {
    const policy = assertDeployHeaders(target, runner);
    console.log(`  · ${target.label}\n    rendered CSP: ${policy}`);
    return [target, policy];
  });
  console.log(
    `GATE: 엣지 파일 ${TARGETS.length}장의 렌더 기반 헤더 5종 정적 검사 통과 ` +
      `(${TARGETS.map((t) => t.label).join(" · ")})`
  );

  for (const [target, policy] of policies) {
    await runTarget(target, policy);
  }

  console.log(
    `GATE PASS: 엣지 파일 ${TARGETS.length}장 모두 픽스처 env 로 렌더한 정책이 헤더 5종을 ` +
      `갖췄고(HSTS preload 없음 · 레일 스킴 규칙 준수), 각 정책이 preview에 그대로 ` +
      `도달했으며, 그 아래에서 첨부 PUT 이 ${ARCHIVE_HOST} 까지 나갔다 — ` +
      `#1206 의 「${blockedCopy()}」는 어느 판에서도 서지 않았다.`
  );
}

await main();
