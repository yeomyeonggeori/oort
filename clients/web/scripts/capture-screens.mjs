#!/usr/bin/env node
// =============================================================================
// Dawn palette screenshot capture (MOMO-597 / ADR-0133 P1).
//
// Renders the real components against a mocked REST surface and captures every
// screen in BOTH color schemes, so light/dark can be reviewed side by side and
// regressions are visible. prefers-color-scheme is emulated at the browser
// level, which means the capture exercises the same CSS light-dark() path the
// product uses; nothing is themed specially for the screenshot.
//
//   npm run capture:design                    # -> artifacts/design/*.png
//   OUT_DIR=/tmp/shots npm run capture:design
//
// Go through the npm script, not this file directly: it builds `--mode design`,
// and that mode is what enables the `?agentwork=` capture seam. A release build
// (`npm run build`) answers null to that flag on purpose, so the two agent turn
// screens would shoot an empty sidebar against a production dist.
//
// No credentials and no backend are involved: /v1 is fulfilled from the
// fixtures below (realistic Korean+English team content, never "테스트 1").
// =============================================================================

import { mkdirSync, existsSync, readFileSync, copyFileSync, writeFileSync, appendFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { signInThroughOnboarding } from "../e2e/advanceOnboarding.mjs";
import { assertQrModulePitch } from "./qrModulePitch.mjs";
import { startGuardedPreview } from "../gates/preview-guard.mjs";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = process.env.OUT_DIR
  ? resolve(process.env.OUT_DIR)
  : resolve(WEB_ROOT, "artifacts/design");
const PORT = Number(process.env.CAPTURE_PORT || 5178);
const ORIGIN = `http://127.0.0.1:${PORT}`;
const VIEWPORT = { width: 1280, height: 800 };

/** H6-1: one writer per artefact. A second screenshot to the same path is red. */
const claimedShotPaths = new Set();

function claimShotPath(path) {
  const key = resolve(path);
  if (claimedShotPaths.has(key)) {
    throw new Error(`duplicate shot writer: ${path} already written in this run`);
  }
  claimedShotPaths.add(key);
  return path;
}

function wrapPageShotGuard(page) {
  const orig = page.screenshot.bind(page);
  page.screenshot = async (opts = {}) => {
    if (opts && opts.path) claimShotPath(opts.path);
    return orig(opts);
  };
}

function wrapContextShotGuard(context) {
  const origNewPage = context.newPage.bind(context);
  context.newPage = async (...args) => {
    const page = await origNewPage(...args);
    wrapPageShotGuard(page);
    return page;
  };
}

function wrapBrowserShotGuard(browser) {
  const origNewContext = browser.newContext.bind(browser);
  browser.newContext = async (...args) => {
    const context = await origNewContext(...args);
    wrapContextShotGuard(context);
    return context;
  };
  return browser;
}

/** UX-R4a M-6: whole tools section including 저장 must sit in the viewport. */
async function frameEnabledToolsSection(page, where) {
  const section = page.getByTestId("agent-hub-enabled-tools");
  await section.waitFor({ state: "visible" });
  const previous = page.viewportSize();
  const measure = () =>
    page.evaluate(() => {
      const sec = document.querySelector(
        '[data-testid="agent-hub-enabled-tools"]'
      );
      const btn = document.querySelector(
        '[data-testid="agent-hub-enabled-tools-save"]'
      );
      if (!sec) return null;
      const sr = sec.getBoundingClientRect();
      const br = btn?.getBoundingClientRect();
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      return {
        ok:
          Boolean(br) &&
          br.top >= 0 &&
          br.bottom <= vh &&
          br.left >= 0 &&
          br.right <= vw &&
          sr.top >= -8,
        vh,
        saveTop: br?.top ?? null,
        saveBottom: br?.bottom ?? null,
        sectionTop: sr.top,
        sectionBottom: sr.bottom,
        reason: btn ? undefined : "missing-save",
      };
    });

  // Phone stacks roster above the profile, so scrollIntoView leaves an
  // unscrollable offset (~449px). Grow by saveBottom after that scroll, not
  // by section height alone.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(120);
    const frame = await measure();
    if (!frame) throw new Error(`[${where}] tools section missing`);
    if (frame.ok) return previous;
    if (frame.reason === "missing-save" || frame.saveBottom == null) {
      throw new Error(`[${where}] tools 저장 not in frame ${JSON.stringify(frame)}`);
    }
    const needed = Math.ceil(
      Math.max(frame.saveBottom, frame.sectionBottom) + 64
    );
    if (needed <= page.viewportSize().height) {
      throw new Error(`[${where}] tools 저장 not in frame ${JSON.stringify(frame)}`);
    }
    await page.setViewportSize({ width: previous.width, height: needed });
  }
  const frame = await measure();
  if (!frame?.ok) {
    throw new Error(`[${where}] tools 저장 not in frame ${JSON.stringify(frame)}`);
  }
  return previous;
}
const TOKENS_CSS = readFileSync(
  resolve(WEB_ROOT, "src/design/tokens.css"),
  "utf8"
);
const DRAFT_STORE_SRC = readFileSync(
  resolve(WEB_ROOT, "src/features/chat/draftStore.ts"),
  "utf8"
);
const ACCENT_CATALOG_SRC = readFileSync(
  resolve(WEB_ROOT, "src/design/themes/index.ts"),
  "utf8"
);

function accentCatalogIds() {
  const ids = [...ACCENT_CATALOG_SRC.matchAll(/id: "([a-z]+)"/g)].map(
    (match) => match[1]
  );
  if (ids.length === 0 || ids[0] !== "dawn") {
    throw new Error("accent catalog must list dawn first");
  }
  return ids;
}

function exportedStringConst(source, name) {
  const match = source.match(new RegExp(`export const ${name} = "([^"]+)";`));
  if (match === null) {
    throw new Error(`draftStore.ts의 ${name}을 읽지 못했다`);
  }
  return match[1];
}

const DRAFTS_CHANGED_EVENT = exportedStringConst(
  DRAFT_STORE_SRC,
  "DRAFTS_CHANGED_EVENT"
);

function pixelToken(name) {
  const match = TOKENS_CSS.match(
    new RegExp(`^\\s*--${name}:\\s*([\\d.]+)px;`, "m")
  );
  if (match === null) throw new Error(`tokens.css의 --${name}을 읽지 못했다`);
  return Number(match[1]);
}

const COMPOSER_FRAME_INSET = pixelToken("spacing-3");
const ANCHOR_ALIGNMENT_TOLERANCE = pixelToken("spacing-1");

/**
 * 1200×630 OG thumbnail for the capture unfurl. A rainbow gradient on this
 * canvas became the largest chromatic object in chat-light/dark once rich
 * was the default (#1903 M-3) — the §8-banned hero silhouette. This is a
 * docs-site OG card: solid paper, a mark, Korean+English runbook copy.
 */
let UNFURL_PREVIEW_PNG;

async function prepareUnfurlPreviewPng(browser) {
  if (UNFURL_PREVIEW_PNG) return;
  const page = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await page.setContent(`<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; width: 1200px; height: 630px; }
    body {
      position: relative;
      background: #efece6;
      color: #24211c;
      font: 32px/1.35 "Apple SD Gothic Neo", "Noto Sans KR", "Segoe UI", sans-serif;
      box-sizing: border-box;
      padding: 56px 64px 56px 80px;
      display: flex;
      flex-direction: column;
    }
    .rail {
      position: absolute;
      left: 0; top: 0; bottom: 0;
      width: 16px;
      background: #a54c08;
    }
    .mark {
      width: 48px; height: 48px;
      background: #a54c08;
      border-radius: 6px;
    }
    .kicker {
      margin-top: 28px;
      font-size: 22px;
      color: #6a655f;
    }
    h1 {
      margin: 12px 0 0;
      font-size: 52px;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    .sub {
      margin-top: 16px;
      font-size: 26px;
      color: #6a655f;
    }
    .bar {
      margin-top: auto;
      width: 160px;
      height: 8px;
      background: #a54c08;
    }
  </style>
</head>
<body>
  <div class="rail"></div>
  <div class="mark"></div>
  <div class="kicker">docs.oor7.com · oort runbook</div>
  <h1>게이트웨이 오류 대응 런북</h1>
  <p class="sub">Gateway error runbook · 502 path and worker checks</p>
  <div class="bar"></div>
</body>
</html>`);
  UNFURL_PREVIEW_PNG = await page.screenshot({
    type: "png",
    clip: { x: 0, y: 0, width: 1200, height: 630 },
  });
  await page.close();
}

// 폰 프로파일 (goal B6). 390x844는 iPhone 14/15의 CSS 뷰포트이고, 이 티켓을 연
// 실캡처를 찍은 그 기기다. deviceScaleFactor 3 · hasTouch · isMobile까지 켜는
// 이유는 이 프로파일이 재는 것이 색이 아니라 **기하**이기 때문이다: 터치
// 타깃과 가로 오버플로는 포인터 컨텍스트에서는 측정되지 않는다.
const MOBILE_VIEWPORT = { width: 390, height: 844 };

// 실기기 근사 (goal B9). 렌더 엔진은 여전히 Chromium이지만, UA로 갈리는 코드 경로는
// 이 문자열을 본다. 성재의 캡처가 이 기기·이 브라우저에서 나왔으므로 프로파일도 그것을
// 말한다. 엔진 자체를 바꾸는 것(WebKit 프로파일)은 이 배치의 범위 밖이고, 이 배치가
// 고치는 결함 셋은 전부 기하이지 엔진 차이가 아니다.
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

// goal B8 B2: the shell's connection banner waits out a 15s dwell before it
// claims the rail is down (features/common/connectionAlert.ts SUSTAINED_DOWN_MS).
// Kept a second over it so the capture is not racing the threshold it is meant
// to photograph.
const SUSTAINED_DOWN_WAIT_MS = 16_000;

/**
 * 폰에서 손가락으로 눌러야 하는 컨트롤과 그 최소 크기(px). 44px는 WCAG 2.5.5 /
 * Apple HIG의 값이고, tokens.css의 `tap-target`이 같은 수를 판다.
 *
 * 이 목록이 캡처 안에 있는 이유: 스크린샷은 버튼이 **작다**는 것을 보여주지
 * 않는다. 리뷰어가 픽셀을 재지 않으면 28px 버튼과 44px 버튼은 같은 그림이다.
 */
const MOBILE_TAP_TARGETS = [
  ["open-sidebar-drawer", "채널 목록 열기"],
  ["composer-send", "메시지 보내기"],
  ["composer-input", "컴포저 입력"],
  ["composer-mention-trigger", "멘션 넣기"],
  ["composer-emoji-trigger", "이모지 넣기"],
  ["emoji-search", "이모지 검색", "optional"],
  // B6 H1 — 오터치 비용이 가장 큰 1급 액션도 44px을 회귀로 잰다.
  // optional: 인박스 화면에만 존재 — 있으면 44px을 강제, 없으면 건너뛴다.
  ["inbox-approval-approve", "인박스 승인", "optional"],
  ["inbox-approval-reject", "인박스 거부", "optional"],
  // B11 R2 H3 — 폰의 액션 흐름이 **착지하는** 컨트롤들. 시트 자체는 44px이었지만
  // 시트가 여는 곳은 아무도 재지 않았고, 셋 중 둘이 44px 아래였다. 전부
  // optional인 것은 각자 자기 화면에만 존재하기 때문이고, 그 화면을 찍는 프레임이
  // `assertTapTargets`를 다시 부른다.
  ["message-editor-save", "수정 저장", "optional"],
  // #1718 — 언퍼얼 카드의 제거 X. 카드가 있는 프레임에만 존재한다.
  ["unfurl-remove", "링크 미리보기 제거", "optional"],
  ["message-editor-cancel", "수정 취소", "optional"],
  ["delete-message-commit", "삭제 확인", "optional"],
  ["delete-message-cancel", "삭제 취소", "optional"],
  ["thread-composer-input", "답글 입력", "optional"],
  ["thread-composer-mention-trigger", "답글 멘션 넣기", "optional"],
  ["thread-composer-send", "답글 보내기", "optional"],
  ["long-press-hint-dismiss", "안내 닫기", "optional"],
  // UX-D4 — 하단 프로필 카드 전체. 예전 24×24 아바타 트리거가 옆 톱니 44px와
  // 어긋나던 자리(6b H2)를 행 전체 타깃으로 올렸다. optional인 것은 사이드바
  // (폰에서는 서랍)가 열린 프레임에서만 보이기 때문이고, 그 프레임이
  // `assertTapTargets`를 다시 부른다.
  ["profile-card", "프로필 카드 열기", "optional"],
  // UX-D4 H-1 — 카드가 여는 메뉴 행. 폰 서랍의 1급 진입이라 32px 포인터
  // 치수가 아니라 시트 행(44)이다. optional: 카드가 열린 프레임에서만 존재.
  ["presence-option-auto", "상태 온라인", "optional"],
  ["presence-option-away", "상태 자리 비움", "optional"],
  ["presence-option-dnd", "상태 방해 금지", "optional"],
  ["profile-add-workspace", "워크스페이스 추가", "optional"],
  ["nav-settings", "설정", "optional"],
  ["profile-logout", "로그아웃", "optional"],
  // #1758 M-1 — 도크 닫기/확대는 빠져나오는 손가락 경로인데 28px였다.
  // optional: 도크가 열린 프레임에서만 존재하고, 그 프레임이 자를 다시 부른다.
  ["terminal-dock-close", "터미널 닫기", "optional"],
  ["terminal-dock-expand", "터미널 크게 보기", "optional"],
  // #1885 M-3 — 상·하단 점프 필. hover:none에서 44px. optional: 상단은
  // 구분선이 창 위쪽일 때만, 하단은 바닥이 아닐 때만 존재한다.
  ["jump-unread", "위쪽 새 메시지", "optional"],
  ["jump-latest", "최신 메시지로", "optional"],
  ["draft-row-menu", "초안 메뉴", "optional"],
  // #1888 B-1/H-3 — 리마인더 행의 완료·미루기·⋯. optional: 나중에 탭에만.
  ["reminder-complete", "알림 완료", "optional"],
  ["reminder-snooze", "알림 미루기", "optional"],
  ["reminder-row-menu", "알림 메뉴", "optional"],
  ["reminder-complete-commit", "알림 완료 확인", "optional"],
  ["reminder-delete-commit", "알림 지우기 확인", "optional"],
  // #1889 M-3 — 상태 설정 다이얼로그의 1급 컨트롤. 프리셋 칩과 이모지 칸이
  // size=sm(28)이라 폰에서 tap-target을 각자 단다. optional: 다이얼로그가
  // 열린 프레임에서만 존재하고, 그 프레임이 자를 다시 부른다.
  ["set-status-emoji", "상태 이모지", "optional"],
  ["set-status-preset-meeting", "상태 프리셋 회의 중", "optional"],
  ["set-status-preset-commute", "상태 프리셋 이동 중", "optional"],
  ["set-status-preset-sick", "상태 프리셋 병가", "optional"],
  ["set-status-preset-vacation", "상태 프리셋 휴가", "optional"],
  ["set-status-preset-wfh", "상태 프리셋 재택", "optional"],
  ["set-status-text", "상태 글", "optional"],
  // 같은 결정, 형제 RemindDialog (#1888 랜딩분). optional: 폰 캡처가 시트에서
  // 「나중에 알림」으로 연 프레임에서만 존재하고, 그 프레임이 자를 다시 부른다.
  ["remind-preset-30m", "알림 프리셋 30분", "optional"],
  ["remind-preset-1h", "알림 프리셋 1시간", "optional"],
  ["remind-preset-3h", "알림 프리셋 3시간", "optional"],
  ["remind-preset-tomorrow-9", "알림 프리셋 내일 9시", "optional"],
  ["remind-preset-next-monday-9", "알림 프리셋 다음 주 월요일", "optional"],
  ["remind-note", "알림 메모", "optional"],
  // #1868 N-4 — 설정 > 테마 액센트 스와치. optional: 테마 섹션이 열린 프레임에서만.
  ["accent-swatch-dawn", "액센트 새벽", "optional"],
];

// 연결 화면의 폼 1급 컨트롤 (goal P3 1-4). BZ-6a 이후 한 폼이 아니라
// S0 랜딩 / S1 게이트 / S2 계정 세 화면에 갈라져 있으므로 목록도 화면마다 따로다.
// 한 목록에 섞으면 어느 화면에서 재든 절반이 "없음"이 되어 전부 optional로
// 내려앉고, 그러면 있어야 할 컨트롤이 사라져도 아무도 실패하지 않는다.
//
// `--spacing-control`이 32px이라 폼 컨트롤은 포인터에서 32px이다. WCAG 2.5.8
// AA(24×24)는 통과하지만 Apple HIG의 44pt는 통과하지 못하고, 온보딩은 폰에서
// 가장 먼저 만나는 화면이라 여기서 잘못 눌린 칸이 이 제품의 첫인상이 된다.
const LOGIN_TAP_TARGETS = [
  ["onboarding-back", "뒤로"],
  ["login-email", "이메일 입력"],
  ["login-password", "비밀번호 입력"],
  ["login-submit", "로그인 버튼"],
];

const LANDING_TAP_TARGETS = [
  ["onboarding-choose-server", "우리 팀 서버로 접속"],
  ["onboarding-choose-invite", "초대 링크로 참여"],
];

const GATEWAY_TAP_TARGETS = [
  ["onboarding-back", "뒤로"],
  ["login-server", "서버 주소 입력"],
  ["onboarding-next", "다음"],
  ["connect-recent-server", "최근 접속", "optional"],
];

const PROFILE_TAP_TARGETS = [
  ["onboarding-profile-name", "표시 이름 입력"],
  ["onboarding-profile-submit", "표시 이름 저장"],
  ["onboarding-profile-skip", "지금은 건너뛰기"],
];

// ADR-0134 계약 픽스처. 단위 테스트(routingModel.test.ts)와 라우팅 캡처가 이미
// 쓰는 그 파일이고, 여기서도 같은 것을 읽어 세 표면이 한 표를 본다.
const ROUTING_FIXTURES = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/routing/routingFixtures.json"), "utf8")
);

// 설정 > 사용량 · 구독 잔여량 (#1057). 게이트(gate-shell-layout)와 모델 테스트가
// 계약으로 붙잡는 그 파일들을 그대로 읽는다.
const USAGE_FIXTURE = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/usageFixtures.json"), "utf8")
).normal;
const QUOTA_FIXTURE = JSON.parse(
  readFileSync(resolve(WEB_ROOT, "src/features/settings/quotaFixtures.json"), "utf8")
).healthy;

// 설정 > 멤버와 초대. 한 장짜리 목록은 이 패널의 실제 길이가 아니다 — 만료·사용
// 횟수·역할이 섞인 여러 줄이 이 화면의 기본 상태다.
// 설정 > 앱은 **카탈로그 한 줄과 함께** 찍는다 (이슈 #1125에서 열림).
//
// 여기 있던 「빈 카탈로그로 찍는다」는 회피였다. 2026-08-06 실측은 「카탈로그 행이
// 있으면 다음 섹션에서 `settings-route` 가 30초 안에 돌아오지 않는다」였고, 원인을
// `앱` 패널의 `wide` 마켓플레이스 레이아웃으로 **추정**해 두었다. 그 추정은 틀렸다 —
// `wide` 는 `max-width` 한 줄이다. 실제 원인은 짝 없는 `/v1` 요청이 프리뷰 프록시를
// 타고 진짜 서버로 나간 것이고, 규명과 수리는 `installUnmockedFallback` 머리말에 있다.
/**
 * 설정 > 앱 카탈로그의 한 줄. 출하 시드 매니페스트 그대로다
 * (`gate-shell-layout.mjs` 와 같은 파일, 같은 이유).
 */
const PLUGIN_MANIFEST = JSON.parse(
  readFileSync(
    resolve(WEB_ROOT, "../../server/Fixtures/plugin-manifests/github.json"),
    "utf8"
  )
);
const PLUGIN_CATALOG_ITEM = {
  pluginId: PLUGIN_MANIFEST.plugin.id,
  name: PLUGIN_MANIFEST.plugin.name,
  version: PLUGIN_MANIFEST.plugin.version,
  description: PLUGIN_MANIFEST.plugin.description,
  official: true,
  recommended: true,
  egressDomains: PLUGIN_MANIFEST.momo.egressDomains,
  recommendedFor: PLUGIN_MANIFEST.momo.recommendedFor,
  installed: false,
  enabled: false,
};

const SETTINGS_INVITES = Array.from({ length: 6 }, (_, i) => ({
  id: `capture-invite-${i}`,
  workspaceId: "00000000-0000-7000-8000-000000000001",
  codePreview: `zz${String(i).padStart(4, "0")}`,
  role: i % 2 ? "admin" : "member",
  maxUses: 5,
  usedCount: i % 5,
  expiresAtMs: Date.now() + (i + 1) * 86_400_000,
  createdBy: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
  createdAtMs: Date.now(),
  updatedAtMs: Date.now(),
}));

// 설정 > 웹훅 (#1202). 세 줄이 서로 다른 것을 말한다: oort 서명 활성, Slack 호환
// 활성(목록에서 URL을 되찾을 수 없다는 안내가 붙는 줄), 그리고 폐기된 줄. 리뷰가
// 봐야 하는 것은 이 셋의 대비이고, 특히 폐기된 줄에 액션이 하나도 없다는 사실이다.
const SETTINGS_WEBHOOKS = [
  {
    id: "019f9b10-0000-7000-8000-0000000009a1",
    channelId: "00000000-0000-7000-8000-000000000204",
    authorMemberId: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
    mode: "native",
    label: "배포 알림 (GitHub Actions)",
    status: "active",
    createdAtMs: Date.now() - 3 * 86_400_000,
    updatedAtMs: Date.now() - 3 * 86_400_000,
  },
  {
    id: "019f9b10-0000-7000-8000-0000000009a2",
    channelId: "00000000-0000-7000-8000-000000000202",
    authorMemberId: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
    mode: "slack_compatible",
    label: "Sentry 이슈 알림",
    status: "active",
    createdAtMs: Date.now() - 9 * 86_400_000,
    updatedAtMs: Date.now() - 9 * 86_400_000,
  },
  {
    id: "019f9b10-0000-7000-8000-0000000009a3",
    channelId: "00000000-0000-7000-8000-000000000201",
    authorMemberId: "019f94e3-7a10-79cd-9dee-208f47edd9a8",
    mode: "native",
    label: "구 CI 서버 (2026-07 폐기)",
    status: "revoked",
    createdAtMs: Date.now() - 40 * 86_400_000,
    updatedAtMs: Date.now() - 20 * 86_400_000,
  },
];

// 캡처 전용 값이다. 진짜 비밀값이 커밋된 스크린샷에 들어가는 일이 없도록, 화면에
// 찍혔을 때 그 사실이 값 자체에서 읽히는 문자열을 쓴다.
const WEBHOOK_CAPTURE_SECRET = "whsec_captureonlynotarealsecret00";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000001";
const GENERAL_ID = "00000000-0000-7000-8000-000000000201";
const ME = "019f94e3-7a10-79cd-9dee-208f47edd9a8";
const HERMES = "019f94e3-8b21-7ae0-b3c4-5f1a2d6e7c90";

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
  // Deliberately unreachable: the capture shows the disconnected/connecting
  // rail state rather than pretending the realtime rail is up.
  realtimeWebSocketUrl: `ws://127.0.0.1:${PORT + 900}/connection/websocket`,
};

const CHANNELS = [
  { id: GENERAL_ID, workspaceId: WORKSPACE_ID, kind: "public", name: "general", muted: false },
  { id: "00000000-0000-7000-8000-000000000202", workspaceId: WORKSPACE_ID, kind: "public", name: "엔진", muted: false },
  { id: "00000000-0000-7000-8000-000000000203", workspaceId: WORKSPACE_ID, kind: "private", name: "김인턴작업", muted: false },
  { id: "00000000-0000-7000-8000-000000000204", workspaceId: WORKSPACE_ID, kind: "public", name: "release-notes", muted: false },
  // 자유 텍스트 방 이름 (#1930 M-1). 채널 `name` 은 스키마상 자유 텍스트라 한글도
  // 공백도 담고, 컴포저 후보 행은 폭 192(`w-pane-sm`) 안에서 그것을 담아야 한다.
  // 이 줄이 없으면 그 행을 재는 프레임이 영문 짧은 이름만 보게 된다.
  {
    id: "00000000-0000-7000-8000-000000000205",
    workspaceId: WORKSPACE_ID,
    kind: "public",
    name: "2026-하반기-릴리스-준비-회고-및-후속-작업",
    topic: "회고 기록과 후속 작업",
    muted: false,
  },
];

// The DM the directory opens onto (MOMO-611). It is in the fixture so the
// sidebar renders its 다이렉트 메시지 section, including the 새 다이렉트 메시지
// entry point, in every frame below.
const DM_ID = "019f984d-b4a8-76fd-8fba-3b6e3390072d";
const DM_CHANNEL = {
  id: DM_ID,
  workspaceId: WORKSPACE_ID,
  kind: "dm",
  memberIds: [ME, HERMES],
  muted: false,
};

/** The id POST /channels answers with (MOMO-614): the app routes to it. */
const CREATED_CHANNEL_ID = "019f9b10-0000-7000-8000-000000000301";

const CHANNEL_IDS = CHANNELS.map((c) => c.id);

// #1369 HAP-UX4 — MCP OAuth resource-owner consent preview. One route serves
// every consent frame; it branches on the `request` envelope value (design
// discipline: vary a fixture by query flag, not by swapping routes, so a photo
// can be traced back to its fixture). Fields are server/operator-derived
// (clientId·redirectUri come from the operator allowlist, not provider metadata).
const OAUTH_CONSENT_CONNECTION_ID = "019f9c00-0000-7000-8000-0000000000c1";
const OAUTH_CONSENT_PREVIEW = {
  clientId: "grok-bot",
  redirectUri: "https://grok.com/connectors/oort/callback",
  resource: "https://oort.dawn.example/v1/mcp/agent-port",
  issuer: "https://oort.dawn.example",
  requestedScopes: [
    "agent:port:connect",
    "agent:inbox:read",
    "messages:read",
    "messages:write",
  ],
  candidates: [
    {
      connectionId: OAUTH_CONSENT_CONNECTION_ID,
      agentMemberId: HERMES,
      agentDisplayName: "Grok 리서치",
      createdAtMs: 1_736_900_000_000,
    },
  ],
};

// Roster and read-state are what turn the timeline from raw ids into the actual
// design: the agent row is where --agent (predawn slate-blue) is visible at all,
// and the unread/mention badges are the only place --accent lands in the
// sidebar. Without these the capture would review a surface nobody ships.
//
// #1889 R2-B1: a 4-char 「회의 중」 hid the 80-char menu-width axis. One self
// fixture sits at the text ceiling so wrap-vs-widen cannot hide again.
const SELF_STATUS_TEXT =
  "3분기 게이트웨이 점검 중, 오후 6시 이후 응답이 늦습니다. 급하면 전화 주세요, 이 채널로만 남겨 주세요. urgent only 내일 6시";
if (SELF_STATUS_TEXT.length < 70 || SELF_STATUS_TEXT.length > 80) {
  throw new Error(
    `레인 상태 픽스처가 80자 한도 근처가 아니다: ${SELF_STATUS_TEXT.length}`
  );
}

const ROSTER = [
  {
    id: ME,
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "owner",
    displayName: "곽성재",
    handle: "seongjae",
    channelCount: CHANNEL_IDS.length,
    channelIds: CHANNEL_IDS,
    capabilities: [],
    presenceStatus: "auto",
    statusEmoji: "📅",
    statusText: SELF_STATUS_TEXT,
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
    channelCount: CHANNEL_IDS.length,
    channelIds: CHANNEL_IDS,
    capabilities: ["code"],
    ownerHumanId: ME,
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  // The directory (MOMO-611) is the first surface that renders the whole
  // roster, so the fixture carries a workspace rather than a pair: role
  // labels, the human/agent split, and a second agent attributed to a human.
  {
    id: "019f9a01-0000-7000-8000-000000000401",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "admin",
    displayName: "박지훈",
    handle: "jihoon",
    channelCount: 2,
    channelIds: CHANNEL_IDS.slice(0, 2),
    capabilities: [],
    presenceStatus: "away",
    statusEmoji: "🏠",
    statusText: "재택",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000402",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "intern-kim",
    channelCount: 1,
    channelIds: [GENERAL_ID],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000403",
    workspaceId: WORKSPACE_ID,
    kind: "human",
    status: "invited",
    role: "member",
    displayName: "Nadia Rahman",
    handle: "nadia",
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  },
  {
    id: "019f9a01-0000-7000-8000-000000000404",
    workspaceId: WORKSPACE_ID,
    kind: "agent",
    status: "active",
    role: "member",
    displayName: "김인턴",
    handle: "kim-intern",
    channelCount: 2,
    channelIds: CHANNEL_IDS.slice(0, 2),
    capabilities: ["code"],
    ownerHumanId: "019f9a01-0000-7000-8000-000000000401",
    agentModel: "hermes-agent",
    createdAtMs: 0,
    updatedAtMs: 0,
  },
];

const READ_STATES = [
  { channel_id: GENERAL_ID, last_read_seq: 1410, latest_seq: 1415, unread_count: 5, mention_count: 1 },
  { channel_id: CHANNELS[1].id, last_read_seq: 40, latest_seq: 42, unread_count: 2, mention_count: 0 },
  { channel_id: CHANNELS[2].id, last_read_seq: 12, latest_seq: 12, unread_count: 0, mention_count: 0 },
  { channel_id: CHANNELS[3].id, last_read_seq: 7, latest_seq: 7, unread_count: 0, mention_count: 0 },
  { channel_id: DM_ID, last_read_seq: 3, latest_seq: 3, unread_count: 0, mention_count: 0 },
];

// Four of these rows are typed agent events, not prose, so the capture shows
// the R-1 §4 agent cards (approval / tool run / settled turn cost) and the
// ADR-0135 D1 cascade notice in both schemes. The props are shaped exactly like
// the server's own (AgentGatewayRoutes.approvalRequestProps,
// WorkerService.toolResultProps, AgentGatewayRoutes.timelineProps,
// WorkerService.finalMessageProps), opaque fields included, so the capture also
// proves the redaction: `arguments` and `tool_grant` are present in the fixture
// and must not appear anywhere on screen.
//
// TWO settled turn records on purpose, because there are two executors and they
// mark themselves differently. Hand-writing only the gateway one is exactly how
// the cascade notice shipped structurally unrenderable (2026-07-26 merge review
// D1/F3): the rows a cascade actually lands on are written by the worker, which
// writes no `schema` key, and this capture agreed with the unit fixture instead
// of with the emitter. The cascade now rides the WORKER row here, which is the
// only row it can ride in production.
const BODIES = [
  [ME, "prometheus mem_limit 붙였어요. 야간 소크 돌려두고 아침에 그래프 확인합시다."],
  [ME, "relay outbox lag 지표가 p99에서 1.2s 근처인데, 배치 크기 조정 전에 원인부터 봅시다."],
  [HERMES, "로그를 읽었습니다. outbox drain 워커 1개가 재시작 루프에 있었고, 지금은 안정입니다."],
  [
    HERMES,
    "빌드 캐시를 정리하려 합니다.",
    "approval_request",
    {
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      action_type: "shell",
      tool_name: "shell",
      tier: "workspace_write",
      call_id: "call_9f31",
      title: "빌드 캐시 정리",
      summary: "빌드 산출물 디렉터리를 지웁니다. 진행 중인 빌드는 없습니다.",
      arguments: { command: "rm -rf build/", cwd: "/Users/dawn/projects/momo" },
      tool_grant: { grant_id: "g-31", scopes: ["shell:write"] },
      is_reversible: false,
      estimated_micro_usd: 12400,
      status: "pending",
      source: "hermes_gateway",
    },
  ],
  [ME, "좋아요, 승인할게요. 끝나면 seq 기준으로 복구 마커 남는지 확인 부탁해요."],
  [
    HERMES,
    "3개 디렉터리 삭제",
    "tool_result",
    {
      call_id: "call_9f31",
      tool_name: "shell",
      label: "빌드 캐시",
      approval_id: "0199aa11-2222-7000-8000-0000000000a1",
      run_id: "0199aa11-2222-7000-8000-0000000000b2",
      payload_sha256: "sha256:0199aa112222",
      output: { stdout: "removed 3 directories" },
      is_error: false,
      executor: "agentworker.resume_approval.v0",
    },
  ],
  [ME, "@hermes 다음은 clients/web 쪽 토큰 교체 diff 리뷰 부탁합니다."],
  [
    HERMES,
    "확인했습니다. 여명 팔레트 토큰만 사용하고 있고, 인디고 잔재는 없습니다.",
    "text",
    {
      // Gateway turn record (AgentGatewayRoutes.timelineProps). It is the only
      // shape that carries `usage`, so this is the row that renders the settled
      // turn cost card.
      schema: "momo.agent_gateway.timeline.v0",
      source: "hermes_gateway",
      status: "succeeded",
      run_id: "0199aa11-2222-7000-8000-0000000000c4",
      agent_member_id: HERMES,
      usage: {
        model: "claude-opus-4",
        prompt_tokens: 1240,
        completion_tokens: 380,
        cost_micro_usd: 12000,
        was_estimated: false,
      },
    },
  ],
  [ME, "@hermes 남은 세 파일도 같은 기준으로 봐주세요."],
  [
    HERMES,
    "남은 세 파일도 토큰만 씁니다. 하드코딩된 색은 없습니다.",
    "text",
    {
      // Worker turn record, transcribed from WorkerService.finalMessageProps.
      // No `schema` key: the worker does not write one, and inventing one here
      // would put this capture back to agreeing with the client instead of with
      // the emitter.
      //
      // The cascade fixture in src/features/timeline/cascadeRail.tsx keys its
      // seeded fallback off THIS run id, which is the only way the ADR-0135 D1
      // "2차 프로바이더로 처리됨" row can reach artifacts/design: the capture runs
      // with no socket, so the frame that normally carries it never arrives.
      // Change one and change the other.
      run_id: "0199aa11-2222-7000-8000-0000000000c3",
      source: "agent_worker.final_text.v0",
      trigger_message_id: "0199aa11-2222-7000-8000-0000000000d1",
      trigger_message_seq: 1412,
      author_member_id: ME,
      source_attribution: {
        source_id: "msg_0199aa11-2222-7000-8000-0000000000d1",
        kind: "message",
        title: "Message #1412",
        uri: `momo://workspaces/${WORKSPACE_ID}/channels/${GENERAL_ID}/messages/0199aa11-2222-7000-8000-0000000000d1`,
        workspace_id: WORKSPACE_ID,
        channel_id: GENERAL_ID,
        message_id: "0199aa11-2222-7000-8000-0000000000d1",
        message_seq: 1412,
        author_member_id: ME,
        permission_snapshot: "actor:channel_member agent:channel_member",
        excerpt: "@hermes 남은 세 파일도 같은 기준으로 봐주세요.",
      },
    },
  ],
  // goal B8 H6. Agents answer in markdown whether or not anyone asked, and
  // before this batch the channel printed the asterisks. One row carries every
  // construct the parser reads, so a review can see bold, code, a list and a
  // link at the density they actually ship at.
  [
    HERMES,
    "배포 전 확인할 것은 **롤백 경로**입니다.\n" +
      "- `make deploy` 는 이전 태그를 남깁니다\n" +
      "- 실패하면 *즉시* 이전 태그로 되돌립니다\n" +
      "자세한 절차는 [배포 문서](https://momo.example/docs/deploy)에 있습니다.\n" +
      "```sh\nmake deploy TAG=v0.4.2\n```",
  ],
  // design-review 1R B1. Two things a picture has to show, not just a unit test:
  // a Korean date at the start of a line stays a date (it used to become "1."
  // with the year eaten), and a quotation that starts at step 3 still says 3.
  [
    HERMES,
    "2026. 07. 30. 배포는 롤백으로 끝났습니다. 런북 기준으로 3단계부터 다시 합니다.\n" +
      "3. 이전 태그로 되돌리기\n" +
      "4. 헬스 체크 통과 확인",
  ],
  // design-review 3R Blocker, in a picture: two Korean date lines in a row used
  // to become an ordered list and the browser renumbered the second one, so the
  // reader saw a date nobody typed (12. 31. -> 13. 31.).
  [ME, "12. 25. 크리스마스 휴무\n12. 31. 종무식 후 배포 동결"],
  [ME, "@hermes 어제 실패한 배포 로그도 같이 봐줄래요?"],
  // goal B8 H2. The worker's failure notice: one Korean sentence in the body,
  // a machine code in props, and NOTHING of the provider's own text anywhere.
  // The card's 자세히 carries the repair.
  [
    HERMES,
    "지금은 답변을 만들지 못했습니다. 잠시 뒤에 다시 멘션해 주세요.",
    "text",
    {
      run_id: "0199aa11-2222-7000-8000-0000000000c9",
      source: "agent_worker.provider_failure.v0",
      error_code: "provider_failed",
      trigger_message_id: "0199aa11-2222-7000-8000-0000000000d2",
      author_member_id: ME,
    },
  ],
];

// 긴 무공백 토큰 (goal B9 §0.1이 지목한 모양). 위 열 줄에서 가장 긴 낱말은
// `agentworker.resume_approval.v0`(30자)이고, 390px 폰에서 그 정도는 아무것도 밀어내지
// 못한다. 실제 팀 채널에 흐르는 것은 이런 것들이다: 게이트웨이가 뱉은 URL 한 줄,
// 다이제스트, 그리고 사람이 띄어쓰기 없이 이어 쓴 한 덩어리. 셋을 한 줄에 몰아 넣은
// 것은 억지가 아니라 재현이다 — 502를 붙여 보내는 사람은 요청 URL과 페이로드 해시를
// 같이 붙인다.
//
// **이 줄은 지금 통과한다**(Chromium/WebKit 양쪽 390px에서 접힌다, 실측). 본문에는
// `min-w-0 flex-1` 조상이 있어 상자 폭이 정해지고, 그러면 `break-words`만으로도 낱말이
// 쪼개지기 때문이다. 그래도 남기는 이유는 §0.1이 이 모양을 원인 후보로 지목했기
// 때문이다: 통과하는 픽스처는 주장이 아니라 **울타리**다. 실제로 붉었던 자리와 그것을
// 재는 방법은 아래 `applyLongTokenStress`에 있다.
const LONG_URL =
  "https://gateway.dawn.internal:8443/v1/workspaces/00000000-0000-7000-8000-000000000001/channels/00000000-0000-7000-8000-000000000201/messages?before=1400&limit=200&include=props";
const LONG_DIGEST =
  "sha256:9f2b7c14e0a83d5b6f1c2ea47d90b83c5417ae62d0f39b8c74a15e2306bd9fc1";
// 띄어쓰기 없이 이어 쓴 한글 한 덩어리 (§0.1의 `@oort ...답변이` 모양). 한글은 음절
// 사이에서 끊을 수 있어 이것만으로는 넘치지 않고, 라틴 토큰과 이어 붙어야 한 낱말이
// 된다 — 그래서 붙여 쓴다.
const LONG_HANGUL = "재시작루프가또났는데원인은outbox_drain_worker_restart_loop_2026_08_02";
const ACTION_ROW_BODY = `502가 계속 납니다. GET ${LONG_URL} 이고 페이로드는 ${LONG_DIGEST} 입니다. ${LONG_HANGUL}`;

function makeMessages(count) {
  const base = Date.now() - count * 60_000;
  const rows = Array.from({ length: count }, (_, i) => {
    const [author, body, type, props] = BODIES[i % BODIES.length];
    return {
      id: `capture-${i + 1}`,
      channelId: GENERAL_ID,
      seq: 1400 + i,
      hlcTs: base + i * 60_000,
      hlcCount: 0,
      authorMemberId: author,
      type: type ?? "text",
      body,
      state: "sent",
      ...(props ? { props } : {}),
      createdAtMs: base + i * 60_000,
    };
  });
  // 메시지 액션이 남기는 자국 세 가지 (goal B11). 새 행을 끼워 넣지 않고 **이미
  // 있는 행의 상태만 바꾼다**: seq도 개수도 그대로라 기존 프레임과 게이트가 재던
  // 것이 흔들리지 않는다. 자리는 아래에서 넷째~둘째 — 타임라인이 아래에 붙어
  // 열리므로 캡처가 서는 자리에서 반드시 렌더된다.
  //
  // 삭제된 행이 픽스처에 있다는 것 자체가 요점이다: 지워진 메시지는 목록에서
  // 조용히 사라지지 않고 자리에 「삭제된 메시지」로 남아야 하며, 그래야 seq에
  // 구멍이 뚫린 것처럼 보이지 않는다.
  // 고르는 규칙: **평범한 한 줄짜리 텍스트 행만** 고른다. B8의 실패 카드나 마크다운
  // 행처럼 구조가 있는 행을 건드리면 그 프레임의 픽스처가 조용히 사라진다 — 처음
  // 쓴 판이 `rows[count-2]`를 지웠고, 그것이 하필 턴 실패 카드여서 B8 프레임이
  // `turn-failure`를 못 찾고 죽었다. 실패는 여기서 났는데 증상은 200줄 뒤에서
  // 났다.
  const plainText = (row) =>
    row && row.type === "text" && typeof row.body === "string" && !row.props;
  const pick = (offset) => {
    const row = rows[count - offset];
    return plainText(row) ? row : null;
  };

  const threaded = pick(4);
  if (threaded) {
    threaded.thread = {
      reply_count: 3,
      last_reply_seq: 1400 + count - 1,
      last_reply_at: base + (count - 1) * 60_000,
    };
  }
  const edited = pick(3);
  if (edited) {
    edited.state = "edited";
    edited.editedAtMs = base + count * 60_000;
  }
  const removed = pick(1);
  if (removed) {
    removed.state = "deleted";
    removed.body = undefined;
    removed.deletedAtMs = base + count * 60_000;
  }

  // 언제나 **가장 최근 줄**이다. 타임라인은 아래에 붙어 열리고(alignToBottom) 가상
  // 목록이라, 중간에 끼워 넣은 행은 캡처가 서는 자리에서 렌더되지 않을 수 있다.
  // 게이트가 재지 못하는 픽스처는 픽스처가 아니다.
  rows.push({
    id: `capture-${count + 1}`,
    channelId: GENERAL_ID,
    seq: 1400 + count,
    hlcTs: base + count * 60_000,
    hlcCount: 0,
    authorMemberId: ME,
    type: "text",
    body: ACTION_ROW_BODY,
    state: "sent",
    createdAtMs: base + count * 60_000,
  });
  return rows;
}

/**
 * 한 스레드의 답글 (goal B11). 루트는 `capture-13`(makeMessages가 rollup을 다는
 * 행)이고, 답글은 그 아래 seq를 잇는다.
 *
 * 셋을 사람과 에이전트가 번갈아 쓴다: 스레드는 대화이지 전사(transcript)가
 * 아니라는 것이 이 패널이 답글 컴포저를 갖는 이유이고, 프레임은 그 대화를 보여야
 * 한다. 답글에는 `rootId`가 있으므로 행의 액션에서 「답글 달기」가 빠진다 —
 * momo 스레드는 한 단계이고, 답글에 답글을 걸면 서버가 거절한다.
 */
function makeThreadReplies() {
  const base = Date.now() - 6 * 60_000;
  const rows = [
    [HERMES, "런북 3단계부터 다시 도는 게 맞습니다. 헬스 체크는 제가 확인할게요."],
    [ME, "네, 그 사이 배포는 잠급니다."],
    [HERMES, "헬스 체크 통과했습니다. 다음 배포부터는 태그를 먼저 고정하죠."],
  ];
  return rows.map(([author, body], i) => ({
    id: `capture-reply-${i + 1}`,
    channelId: GENERAL_ID,
    rootId: "capture-13",
    seq: 1500 + i,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));
}

// 코드 실행 호스트 (MOMO-617). The registry is the block a review has to look
// at in both schemes: three status chips (온라인 / 오프라인 / 해지됨) side by
// side is where a status color that only works in one scheme would show.
//
// Shaped like the momowebqa ledger the R2 review measured, because that ledger
// is what exposed the defects. A host that pairs again writes a NEW row, so one
// display name repeats across rows and only the id tail separates them; revoked
// rows are never deleted; and the server returns creation order, so the usable
// hosts do not arrive first. The array is in that server order on purpose,
// which makes the shot prove the panel sorts rather than getting lucky.
const REVOKED_TARGET = "019f99a0-8ac1-77b0-948b-210e791c6238";
const WORK_HOSTS = [
  {
    id: "019f999c-6845-79cd-841d-22f20d098c61",
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 iMac, 집 작업실",
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true },
    revokedAtMs: Date.now() - 3 * 86_400_000,
    createdAtMs: Date.now() - 30 * 86_400_000,
    online: false,
  },
  {
    id: REVOKED_TARGET,
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 iMac, 집 작업실",
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true },
    revokedAtMs: Date.now() - 2 * 86_400_000,
    createdAtMs: Date.now() - 20 * 86_400_000,
    online: false,
  },
  {
    id: "019f994c-4ed0-76a9-9d43-a9bde45b8fcd",
    workspaceId: WORKSPACE_ID,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "성재 MacBook Pro",
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true, git: true },
    lastSeenAtMs: Date.now() - 20_000,
    createdAtMs: Date.now() - 86_400_000,
    online: true,
  },
  {
    id: "019f994c-4ee2-74f5-80f1-44408e9a2b82",
    workspaceId: WORKSPACE_ID,
    scope: "workspace",
    ownerMemberId: ME,
    type: "workd",
    displayName: "dawn-build-01",
    publicKey: "capture-only-not-a-credential",
    capabilities: { terminal: true },
    lastSeenAtMs: Date.now() - 3 * 3_600_000,
    createdAtMs: Date.now() - 7 * 86_400_000,
    online: false,
  },
];

// 설정 > AI 연결 (MOMO-627 / ADR-0135 D1). The singleton head plus four fallback
// hops, because those five rows are what the block has to keep apart on screen:
// a head that is read-only here, a live fallback, a hop the operator switched
// off, a hop whose key the provider rejects, and a hop in a mock mode (the
// self-host default, and the row that must NOT read as a failure). Bearers are
// masked tails, exactly as the API answers (ADR-0004: the key never leaves the
// server).
const PROVIDER_LINK = {
  schema: "momo.provider_link.v0",
  configured: true,
  source: "database",
  mode: "external-hermes",
  baseUrl: "https://api.anthropic.com/v1",
  endpointLabel: "api.anthropic.com",
  bearerConfigured: true,
  bearerLast4: "8f21",
  availability: "live",
  keyConfigured: true,
  updatedAtMs: Date.now() - 6 * 3_600_000,
  diagnostics: [],
};

const PROVIDER_CHAIN = {
  schema: "momo.provider_link.chain.v0",
  entries: [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      baseUrl: PROVIDER_LINK.baseUrl,
      endpointLabel: PROVIDER_LINK.endpointLabel,
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "8f21",
      updatedAtMs: PROVIDER_LINK.updatedAtMs,
    },
    {
      position: 1,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://gateway.dawn.internal:8443/v1",
      endpointLabel: "gateway.dawn.internal:8443",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "c40a",
      updatedAtMs: Date.now() - 2 * 3_600_000,
    },
    {
      position: 2,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://backup.dawn.internal/v1",
      endpointLabel: "backup.dawn.internal",
      enabled: false,
      bearerConfigured: true,
      bearerLast4: "1b77",
    },
    {
      position: 3,
      source: "chain",
      mode: "external-hermes",
      baseUrl: "https://relay.dawn.internal/v1",
      endpointLabel: "relay.dawn.internal",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "9e03",
    },
    {
      position: 4,
      source: "chain",
      mode: "local-mock",
      baseUrl: "http://127.0.0.1:8088/v1",
      endpointLabel: "127.0.0.1:8088",
      enabled: true,
      bearerConfigured: true,
      bearerLast4: "0000",
    },
  ],
  // `entries.count - 1`: fallbacks only. `ProviderCascade.attemptable` filters
  // the WHOLE plan, so the head counts there and the parked hop does not, which
  // is why the summary sentence has to name what it is counting.
  fallbackCount: 4,
  attemptableCount: 4,
};

// The same body with one entry this client cannot read: position 2 lost its
// `baseUrl`. A 200 does not rule that out (a proxy, a dev catch-all or a later
// schema can all produce it), and the panel's answer to it is not cosmetic.
// `PUT /v1/provider/link/chain` replaces the whole fallback list, so a hop that
// never reached the draft is one the next save deletes from the server together
// with the key stored at its position. The block goes read-only, names the
// entry by its place in the answer, and states no count it cannot show.
const PROVIDER_CHAIN_PARTIAL = {
  ...PROVIDER_CHAIN,
  entries: PROVIDER_CHAIN.entries.map((entry, index) => {
    if (index !== 2) return entry;
    const rest = { ...entry };
    delete rest.baseUrl;
    return rest;
  }),
};

// A fresh self-host instance: no operator link, so the head is the boot-time
// HERMES_* env trio pointed at the bundled mock. This is what momowebqa answers
// today, and the state the panel must describe as a MODE rather than a failure.
const MOCK_ONLY_HOP = {
  position: 0,
  source: "environment",
  mode: "local-mock",
  baseUrl: "http://127.0.0.1:8088/v1",
  endpointLabel: "127.0.0.1:8088",
  enabled: true,
  bearerConfigured: true,
  bearerLast4: "0000",
};

// The probe result a review has to look at: the head fell over, the second hop
// answered, the parked hop was skipped, the fourth hop's key was rejected, and
// the fifth is in a mock mode the probe declines to call at all. Every
// disposition the server can emit, in one frame, with the tone each has to be
// drawn in. `cascadeOk: true` because a cascade that fell over to a working
// provider is the cascade doing its job.
const PROVIDER_PROBE = {
  schema: "momo.provider_link.test.v0",
  ok: false,
  reason: "provider_unreachable",
  source: "database",
  mode: "external-hermes",
  endpointLabel: PROVIDER_LINK.endpointLabel,
  checkedAtMs: Date.now(),
  cascadeOk: true,
  entries: [
    {
      position: 0,
      source: "provider_link",
      mode: "external-hermes",
      endpointLabel: "api.anthropic.com",
      enabled: true,
      ok: false,
      reason: "provider_unreachable",
      disposition: "fall_over",
    },
    {
      position: 1,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "gateway.dawn.internal:8443",
      enabled: true,
      ok: true,
      disposition: "ok",
    },
    {
      position: 2,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "backup.dawn.internal",
      enabled: false,
      ok: false,
      reason: "hop_disabled",
      disposition: "skipped",
    },
    {
      position: 3,
      source: "chain",
      mode: "external-hermes",
      endpointLabel: "relay.dawn.internal",
      enabled: true,
      ok: false,
      // 401/403. A caller error does NOT fall over: the next provider would
      // fail the same way, so the cascade stops here (--danger).
      reason: "provider_auth_failed",
      disposition: "propagate",
    },
    {
      position: 4,
      source: "chain",
      mode: "local-mock",
      endpointLabel: "127.0.0.1:8088",
      enabled: true,
      ok: false,
      // `probeHop` returns before calling anything for a non-external mode. It
      // arrives as `propagate`, but nothing failed and nothing was measured, so
      // this row is muted 목 모드 and is excluded from the headline's counts.
      reason: "not_external_provider",
      disposition: "propagate",
    },
  ],
};

// WorkTierPolicyRoutes.loadPolicy answers /me out of the workspace row when the
// member has no row of their own, so an inherited member policy carries the
// DEFAULT's mode, target and updated_at, and differs only in member_id and
// inherited. A review screenshot that shows 상속 중 next to a different mode is
// a screen the server cannot produce, which makes the shot worse than no shot.
const WORKSPACE_TIER_POLICY = {
  workspaceId: WORKSPACE_ID,
  mode: "auto",
  autoTarget: "019f994c-4ee2-74f5-80f1-44408e9a2b82",
  inherited: false,
  updatedAtMs: Date.now() - 3_600_000,
};

// The member has their OWN row here, pointing at a host that was revoked after
// the policy was written. That is the live momowebqa state and it is the one a
// review has to see: the server answers 409 for this target, so the panel is
// describing a policy that cannot run, and the shot is where you check that it
// says so in --danger instead of a muted footnote (SKILL §5 / §8).
const MEMBER_TIER_POLICY = {
  workspaceId: WORKSPACE_ID,
  memberId: ME,
  mode: "auto",
  autoTarget: REVOKED_TARGET,
  inherited: false,
  updatedAtMs: Date.now() - 40 * 60_000,
};

/**
 * The DM the directory opens onto: a short 1:1 with the agent, not a channel.
 *
 * 꼬리 세 쌍은 goal P3 1-2가 고치는 그 모양이다. 1:1 DM에서는 사람이 쓰는 **모든**
 * 메시지가 상대 에이전트를 부르므로, 그 에이전트가 멈춰 있으면 서버는 부를 때마다
 * 시스템 한 줄을 남긴다 — 세 번 말하면 똑같은 문장이 세 줄이다. 픽스처가 세 줄을
 * 그대로 보내고 화면이 한 줄로 접는 것이, 접기가 서버가 아니라 클라이언트에서
 * 일어난다는 증거다.
 *
 * 대소문자도 실물 그대로다: 알림 행의 `authorMemberId`는 Swift의 `uuidString`이라
 * 대문자이고, `props`의 두 키는 서버가 손으로 소문자를 적는 자리다
 * (MessageRoutes.swift:1605-1607). 한 행 안에서 갈리는 값이므로, 접기가 `uuidEq`로
 * 비교하지 않으면 이 프레임에서 바로 드러난다.
 */
function makeDmMessages() {
  const base = Date.now() - 12 * 60_000;
  const spoken = [
    [ME, "어제 올린 relay 패치, DM으로 짧게만 확인할게요. 롤백 절차는 그대로죠?"],
    [HERMES, "그대로입니다. outbox 재처리 스크립트만 먼저 돌리면 됩니다."],
    [ME, "좋아요. 배포 끝나면 여기로 결과만 남겨주세요."],
  ].map(([author, body], i) => ({
    id: `capture-dm-${i + 1}`,
    channelId: DM_ID,
    seq: i + 1,
    hlcTs: base + i * 60_000,
    hlcCount: 0,
    authorMemberId: author,
    type: "text",
    body,
    state: "sent",
    createdAtMs: base + i * 60_000,
  }));

  // 그 뒤로 hermes가 멈췄고, 성재는 그것을 모른 채 세 번 더 말한다.
  const unanswered = [
    "배포 결과 나왔나요?",
    "outbox 쪽 지표만 먼저 알려주세요.",
    "확인되면 알려주세요. 급하진 않습니다.",
  ];
  const tail = [];
  unanswered.forEach((body, i) => {
    const seq = 4 + i * 2;
    const at = base + (3 + i * 2) * 60_000;
    tail.push({
      id: `capture-dm-${seq}`,
      channelId: DM_ID,
      seq,
      hlcTs: at,
      hlcCount: 0,
      authorMemberId: ME,
      type: "text",
      body,
      state: "sent",
      createdAtMs: at,
    });
    tail.push({
      id: `capture-dm-${seq + 1}`,
      channelId: DM_ID,
      seq: seq + 1,
      hlcTs: at + 1_000,
      hlcCount: 0,
      authorMemberId: HERMES.toUpperCase(),
      type: "system",
      body: "hermes은(는) 현재 일시정지되어 있습니다.",
      props: {
        kind: "agent_paused",
        agent_member_id: HERMES,
        source_message_id: `capture-dm-${seq}`,
      },
      createdAtMs: at + 1_000,
    });
  });
  return [...spoken, ...tail];
}

// ---- 에이전트 허브 (goal B5.3b) ---------------------------------------------
// 세 표면이 여기서 처음 화면에 오른다: 프로필 카드(모델·추론 강도·상태), 채널
// 배치, 그리고 만들기 폼. allowed-models가 200이라는 것은 이 서버에 프로필 쓰기와
// 일시정지가 있다는 뜻이고(capability.ts ④), 그래서 편집 컨트롤이 열린 프레임과
// 404로 잠긴 프레임을 둘 다 찍는다.

const AGENT_PROFILE = {
  agentMemberId: HERMES,
  workspaceId: WORKSPACE_ID,
  instructions:
    "배포 전에는 롤백 절차부터 확인하고, 근거가 없는 추정은 추정이라고 먼저 말합니다.",
  modelPref: "hermes-agent",
  enabledTools: ["work.session.spawn", "shell", "git"],
  triggers: { mention: true },
  paused: false,
  version: 3,
  updatedBy: ME,
  updatedAtMs: Date.now() - 6 * 3_600_000,
};

const ALLOWED_AGENT_MODELS = ["hermes-agent", "hermes-agent-mini"];

/** UX-R4a: catalog GET is not on the live server; capture supplies the body. */
const AGENT_TOOL_CATALOG = {
  tools: [
    {
      name: "deploy.rollback.session-end-with-a-very-long-qualified-name",
      description:
        "배포 전 롤백 절차를 확인한 뒤에만 쓰는 작업 세션 종료입니다. 호스트 상태와 정산 원장을 닫으며, 한 번 실행하면 같은 세션으로 되돌리지 못합니다.",
      executable: true,
      requiresApproval: true,
    },
    {
      name: "work.session.spawn",
      description:
        "등록된 호스트에서 코딩 도구를 새 작업 세션으로 시작합니다. 승인하는 사람이 호스트를 고릅니다.",
      executable: true,
      requiresApproval: true,
    },
    {
      name: "work.session.login_handoff",
      description:
        "세션 화면에서 사람이 직접 로그인하게 잠시 멈춥니다. 비밀번호나 코드를 채팅으로 묻지 않습니다.",
      executable: true,
      requiresApproval: true,
    },
    {
      name: "work.session.resume",
      description: "멈춘 작업 세션을 이어서 시작합니다.",
      executable: false,
      requiresApproval: true,
      unavailableReason: "이 서버는 아직 이 도구를 실행하지 않습니다.",
    },
    {
      name: "agent.pause",
      description: "에이전트를 일시정지합니다.",
      executable: false,
      requiresApproval: true,
      unavailableReason: "이 서버는 아직 이 도구를 실행하지 않습니다.",
    },
    {
      name: "message.post",
      description: "채널에 메시지를 올립니다. 에이전트는 이미 자기 답변 경로로 말합니다.",
      executable: false,
      requiresApproval: true,
      unavailableReason: "이 서버는 아직 이 도구를 실행하지 않습니다.",
    },
  ],
};

/** The id POST /agents answers with: the hub selects it right after. */
const CREATED_AGENT_ID = "019f9b10-0000-7000-8000-0000000004a1";

/** 결정 대기 (D-5). snake_case on the wire, the way the ledger projects it. */
/**
 * 스폰 승인의 `execution` — ADR-0125 D6-A의 호스트 선택기(이슈 1114).
 *
 * 후보 넷을 다 싣는다. 자격 있는 둘만 실으면 이 캡처는 라디오가 있다는 것만
 * 보여주고, 이 배치의 논점 — **자격 없는 줄이 사유와 함께 선다** — 은 사진에
 * 나오지 않는다. 서버가 실제로 내는 모양 그대로 snake_case다
 * (`crates/momo-t3/src/work_control.rs` `spawn_execution_object`).
 */
const SPAWN_EXECUTION = {
  kind: "work_session_spawn",
  tool: "codex",
  label: "릴레이 재시작 절차 정리",
  requested_host_id: null,
  default_host_id: "019f9b10-0000-7000-8000-00000000c001",
  host_candidates: [
    {
      host_id: "019f9b10-0000-7000-8000-00000000c001",
      display_name: "성재 맥북",
      host_type: "app",
      tier: "local",
      scope: "member",
      online: true,
      selectable: true,
      unavailable_reason: null,
    },
    {
      host_id: "019f9b10-0000-7000-8000-00000000c002",
      display_name: "팀 VPS (서울)",
      host_type: "workd",
      tier: "remote",
      scope: "workspace",
      online: true,
      selectable: true,
      unavailable_reason: null,
    },
    {
      host_id: "019f9b10-0000-7000-8000-00000000c003",
      display_name: "작업실 아이맥",
      host_type: "app",
      tier: "local",
      scope: "member",
      online: false,
      selectable: false,
      unavailable_reason: "offline",
    },
    {
      host_id: "019f9b10-0000-7000-8000-00000000c004",
      display_name: "momo Cloud",
      host_type: "cloud",
      tier: "cloud",
      scope: "workspace",
      online: true,
      selectable: false,
      unavailable_reason: "t3_disabled",
    },
  ],
};

const APPROVALS = [
  {
    id: "019f9b10-0000-7000-8000-0000000005a1",
    workspace_id: WORKSPACE_ID,
    run_id: "019f9b10-0000-7000-8000-0000000005b1",
    channel_id: GENERAL_ID,
    requested_by: HERMES,
    on_behalf_of: ME,
    action_type: "work.spawn",
    status: "pending",
    is_reversible: false,
    expires_at_ms: Date.now() + 26 * 60_000,
    payload: {
      source: "work_control",
      tool_call: { call_id: "call-spawn", name: "work.spawn" },
      execution: SPAWN_EXECUTION,
    },
  },
  {
    id: "019f9b10-0000-7000-8000-0000000005a2",
    workspace_id: WORKSPACE_ID,
    run_id: "019f9b10-0000-7000-8000-0000000005b2",
    channel_id: "00000000-0000-7000-8000-000000000202",
    requested_by: HERMES,
    action_type: "shell.exec",
    status: "pending",
    is_reversible: true,
    expires_at_ms: Date.now() + 3 * 3_600_000,
  },
];

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

/**
 * 이 하네스가 **답하지 않은** `/v1` 경로들 (이슈 #1125).
 *
 * 아래 `unmockedFallback` 이 채운다. 런이 끝날 때 한 번 인쇄되므로, 새 표면이
 * 붙어 요청이 하나 늘면 다음 사람이 이 목록에서 본다.
 */
const unmockedPaths = new Set();

/**
 * 짝이 없는 `/v1` 요청에 **이 하네스가 직접** 답한다 (이슈 #1125).
 *
 * ## 왜 필요한가 — 프리뷰 서버는 `/v1` 을 **진짜 서버로 넘긴다**
 *
 * `vite.config.ts` 의 `preview.proxy` 는 `/v1` 을 `http://127.0.0.1:28000` 으로
 * 보낸다. 그래서 목이 없는 경로는 응답이 **없는 것이 아니라 그 자리에 떠 있는
 * 아무 서버의 것**이 된다. 실측(2026-08-07): 로컬 스택이 떠 있는 기계에서
 * `GET …/plugins/{id}` 가 **401** 로 돌아왔고, 코어의 `authed()` 는 계약대로
 * 회전을 한 번 시도한 뒤(그것도 401) `markAuthExpired()` 를 불러 **앱이 스스로
 * 로그아웃**했다. 캡처는 그때부터 로그인 화면을 찍는다.
 *
 * 그 답이 기계마다 다르다는 것이 이 결함의 성질이다. 28000 에 아무것도 없는
 * 기계에서는 프록시가 연결 거부로 끝나 화면이 그냥 **매달리고**, 그래서 앞선
 * 진단은 이것을 「`앱` 패널의 `wide` 마켓플레이스 레이아웃 문제」로 적었다
 * (설정 스윕 주석, 2026-08-06). `wide` 는 `max-width` 한 줄이고 아무 잘못이
 * 없었다 — 레이아웃이 아니라 **짝 없는 요청**이 원인이었다.
 *
 * ## 왜 404 이고 왜 죽이지 않는가
 *
 * 이 하네스가 흉내 내는 것은 「우리가 실제로 이야기하는 서버」이고, 그 서버가
 * 모르는 경로에 하는 답이 본문 없는 404 다(`capture-honesty.mjs` 의 `absent` 와
 * 같은 모양·같은 이유). 클라이언트는 그 404 를 **미제공으로 접을 줄 안다**
 * (`serverSaysAbsent`). 죽이지 않는 이유는 이것이 판정 게이트가 아니라 증거
 * 레인이기 때문이고, 대신 **조용하지 않게** 한다: 목록이 런 끝에 인쇄된다.
 *
 * 등록 순서가 계약이다. Playwright 는 **나중에 등록된 라우트를 먼저** 보므로
 * 이 포괄 라우트는 반드시 `installMocks` 의 **맨 앞**에 선다. 뒤에 서면 그것이
 * 모든 목을 이긴다.
 */
async function installUnmockedFallback(context) {
  await context.route("**/v1/**", (route) => {
    unmockedPaths.add(
      `${route.request().method()} ${new URL(route.request().url()).pathname}`
    );
    return route.fulfill({ status: 404, contentType: "text/plain", body: "" });
  });
}

const DEVICE_LINK_CAPTURE_TOKEN = [
  "ABCDEFGHIJKLMNOPQRSTUV",
  "WXYZabcdefghijklmnopq",
].join("");
const DEVICE_LINK_CAPTURE_ID = "019f9b10-0000-7000-8000-000000000d01";
const DEVICE_LINK_CAPTURE_ORIGIN = "https://team.example.com";
const DEVICE_LINK_CAPTURE_DEVICE =
  "성재 iPhone 16 Pro Max, 집 작업실 책상 옆 MagSafe 충전 거치대";

const deviceLinkHarness = {
  sas: "4821",
  issueStatus: 201,
  getBody: () => ({ status: "pending" }),
  deepLink: "",
};

function resetDeviceLinkHarness() {
  deviceLinkHarness.sas = "4821";
  deviceLinkHarness.issueStatus = 201;
  deviceLinkHarness.getBody = () => ({ status: "pending" });
  deviceLinkHarness.deepLink = "";
}

function deviceLinkIssueBody() {
  const body = {
    id: DEVICE_LINK_CAPTURE_ID,
    token: DEVICE_LINK_CAPTURE_TOKEN,
    expiresAt: Date.now() + 120_000,
    deepLink:
      deviceLinkHarness.deepLink ||
      `oort://link?server=${encodeURIComponent(DEVICE_LINK_CAPTURE_ORIGIN)}&token=${DEVICE_LINK_CAPTURE_TOKEN}`,
  };
  if (deviceLinkHarness.sas) body.sas = deviceLinkHarness.sas;
  return body;
}

const QR_MODULE_FLOOR = Number(
  (TOKENS_CSS.match(/--spacing-qr-module:\s*([\d.]+)px;/) || [])[1]
);
if (!Number.isFinite(QR_MODULE_FLOOR) || QR_MODULE_FLOOR <= 0) {
  throw new Error(
    "tokens.css missing a numeric --spacing-qr-module (capture cannot measure QR pitch)"
  );
}

async function measureDeviceLinkQrPitch(page, label) {
  const measured = await page.locator('[data-testid="device-link-qr"]').evaluate((el) => {
    const modules = Number(el.getAttribute("data-qr-modules"));
    const cs = getComputedStyle(el);
    const pad =
      (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    const borderBox = el.getBoundingClientRect().width;
    const content = borderBox - pad;
    return {
      modules,
      content,
      boxSizing: cs.boxSizing,
      pitch: content / modules,
    };
  });
  const pitch = assertQrModulePitch(
    measured.content,
    measured.modules,
    QR_MODULE_FLOOR,
    label
  );
  console.log(
    `  device-link QR pitch ${label}: ${pitch.toFixed(3)} px/module (${measured.modules} modules, content ${measured.content}px, box-sizing ${measured.boxSizing})`
  );
  return measured;
}

async function installMocks(context) {
  let declaredPresence = "auto";
  let customStatus = {
    statusEmoji: "📅",
    statusText: SELF_STATUS_TEXT,
    statusExpiresAtMs: undefined,
  };
  resetDeviceLinkHarness();
  await installUnmockedFallback(context);
  await context.route("**/v1/auth/login", (route) => json(route, SESSION));
  await context.route("**/v1/join", (route) =>
    json(route, { ...SESSION, createdMember: true })
  );
  await context.route("**/v1/auth/device-link**", (route) => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const tail = url.pathname.split("/device-link")[1] ?? "";
    if (method === "POST" && (tail === "" || tail === "/")) {
      if (deviceLinkHarness.issueStatus !== 201) {
        return json(
          route,
          { error: "unavailable" },
          deviceLinkHarness.issueStatus
        );
      }
      return json(route, deviceLinkIssueBody(), 201);
    }
    if (method === "POST" && tail.endsWith("/confirm-sas")) {
      return json(route, { status: "confirmed" });
    }
    if (method === "GET") {
      return json(route, deviceLinkHarness.getBody());
    }
    return route.fallback();
  });
  // ## 로그인 직후의 토큰 회전까지 막아야 로그인이 유지된다 (goal RN-U2, 선행 결함)
  //
  // 이 스텁이 없어서 **하네스 전체가 로그인 화면에서 멈춰 있었다.** 증상은 `signIn`
  // 이 `channel-list` 를 30초 기다리다 죽는 것이고, 원인은 화면이 아니라 여기다:
  //
  //   DESK-1(`2ce728e2`)이 `hasPersistedSession` 을 일회성 읽기에서
  //   `useSyncExternalStore` 로 바꾸면서, 로그인이 세션을 저장하는 순간 `resumable`
  //   이 true 로 뒤집혀 **갓 발급된 토큰을 한 번 회전**시킨다. 그 POST 는 라우트
  //   표에 없으므로 Playwright 를 빠져나가 vite 프록시로 나가고, 무엇이 응답하든
  //   2xx 가 아니면 코어(`api.ts` `refreshSessionOutcome`)가 `markAuthExpired()` 로
  //   세션을 지운다 — 앱은 로그인하고, 셸을 잠깐 그린 뒤, 스스로 로그아웃한다.
  //
  // 이 스텁은 **어느 리비전에도 없었다**(`git log -S "auth/refresh"` 가 비어 있다).
  // DESK-1 전에는 회전 자체가 일어나지 않아 가려져 있었을 뿐이다. 다른 게이트들
  // (`gate-csp`·`gate-wire`·`gate-agent-hub`·`gate-workstream`)은 `**/v1/**` 포괄
  // 스텁을 갖고 있어 이 구멍이 없다 — 이 파일만 예외였다.
  //
  // 응답 **모양**이 load-bearing 이다: `refreshResponseFromWire` 는 두 필드가 모두
  // 문자열이 아니면 throw 하고, 그 throw 는 `"unreachable"` 로 번역되어 결국 같은
  // 로그인 화면으로 되돌아간다. 200 이기만 하면 되는 것이 아니다.
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
  // 채널 만들기 (MOMO-614). The POST answers the way the server does: 409 when
  // an unarchived channel already carries the name, which is the frame that
  // matters because the rejection has to land under the name field, and 201
  // with the created row otherwise.
  // BT-1 (#1929): 사이드바 행 메뉴가 알림을 끄면 서버가 그것을 **기억해야**
  // 낱말이 다음에 열 때 뒤집힌다. 무효화 뒤 재조회가 같은 값을 돌려주면 캡처는
  // 「눌렀지만 아무 일도 없었다」를 초록으로 넘긴다.
  const mutedChannels = new Set();
  await context.route(
    "**/v1/workspaces/*/channels/*/notification-pref",
    (route) => {
      const url = new URL(route.request().url());
      const id = url.pathname.split("/").at(-2);
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.muted) mutedChannels.add(id);
      else mutedChannels.delete(id);
      return json(route, { muted: Boolean(body.muted) });
    }
  );
  await context.route("**/v1/workspaces/*/channels", (route) => {
    if (route.request().method() !== "POST") {
      return json(route, {
        channels: [...CHANNELS, DM_CHANNEL].map((channel) => ({
          ...channel,
          muted: mutedChannels.has(channel.id),
        })),
      });
    }
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (CHANNELS.some((c) => c.name === body.name)) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "channel name already exists" },
        }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        channel: {
          id: CREATED_CHANNEL_ID,
          workspaceId: WORKSPACE_ID,
          kind: body.kind,
          name: body.name,
          topic: body.topic,
          muted: false,
        },
        creatorMembership: {
          id: "019f9b10-0000-7000-8000-0000000003ff",
          workspaceId: WORKSPACE_ID,
          channelId: CREATED_CHANNEL_ID,
          memberId: ME,
          role: "owner",
          joinedAtMs: Date.now(),
        },
      }),
    });
  });
  // 디렉터리 행에서 DM 시작 (MOMO-611): idempotent per pair, so the fixture
  // answers created:false, which is the "이미 있는 대화로 이동" path.
  await context.route("**/v1/workspaces/*/dms", (route) =>
    route.request().method() === "POST"
      ? json(route, { channel: DM_CHANNEL, created: false })
      : json(route, { channels: [DM_CHANNEL] })
  );
  // 추론 강도 표 (ADR-0134 D2). 목이 없으면 이 요청은 프록시로 나가고, 살아
  // 있는 서버가 401을 답하는 순간 캡처 세션이 로그아웃된다. 축이 있는 서버를
  // 찍는 이유는 프로필 카드의 "추론 강도" 줄이 그 판정을 그대로 읽기 때문이다.
  await context.route("**/v1/provider/effort-table", (route) =>
    json(route, ROUTING_FIXTURES.effortTable)
  );
  // 에이전트 허브 (goal B5.3b). 더 긴 경로를 먼저 건다: `**/…/agents`가
  // `/agents/{id}/profile`을 삼키지 않도록 하는 것과 같은 규칙이다.
  await context.route("**/v1/workspaces/*/agent-tool-catalog", (route) =>
    json(route, AGENT_TOOL_CATALOG)
  );
  await context.route("**/v1/workspaces/*/agents/*/allowed-models", (route) =>
    json(route, { allowedAgentModels: ALLOWED_AGENT_MODELS })
  );
  await context.route("**/v1/workspaces/*/agents/*/profile", (route) =>
    json(route, { profile: AGENT_PROFILE })
  );
  await context.route("**/v1/workspaces/*/agents/*/runs*", (route) =>
    json(route, { runs: [] })
  );
  // 만들기는 서버가 답하는 대로: 이미 있는 핸들이면 409(그 거절은 핸들 상자
  // 밑에 서야 한다), 아니면 201 + 만들어진 멤버.
  await context.route("**/v1/workspaces/*/agents", (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = JSON.parse(route.request().postData() ?? "{}");
    if (ROSTER.some((member) => member.handle === body.handle)) {
      return route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { message: "agent handle already exists" },
        }),
      });
    }
    return route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        agent: {
          id: CREATED_AGENT_ID,
          handle: body.handle,
          displayName: body.displayName,
        },
      }),
    });
  });
  // 채널 배치 (B5.3a가 여는 표면). 넣기는 upsert, 빼기는 left_at 표시라 둘 다
  // 멤버십 한 행을 돌려준다.
  await context.route("**/v1/workspaces/*/channels/*/members**", (route) =>
    json(route, {
      membership: {
        id: "019f9b10-0000-7000-8000-0000000006a1",
        workspaceId: WORKSPACE_ID,
        channelId: GENERAL_ID,
        memberId: HERMES,
        role: "member",
        joinedAtMs: Date.now(),
      },
    })
  );
  // 결정 대기 (D-5): pending만 행이 있고, 나머지 상태 페이지는 비어 있다.
  //
  // **지금 이 목은 한 번도 불리지 않는다** (goal P3 후속에서 확인). B12 이후
  // 인박스는 `isSurfaceProvided("approvals")`를 먼저 보고, `serverSurfaces.ts`가
  // 그것을 정적으로 false라 답하므로 `useNeedsAction(false)`가 요청 자체를 만들지
  // 않는다. 정적 판정이 네트워크보다 앞서기 때문에, 이 목을 무엇으로 채우든 승인
  // 행은 생기지 않는다 — `capture:design`을 30초 타임아웃으로 죽여 놓았던 착시가
  // 정확히 이것이었다("목이 있으니 데이터도 있겠지").
  //
  // 그래도 지우지 않는다. `serverSurfaces.ts`가 스스로 "PR 947은 클라이언트 22개
  // 파일만 바꿨고 서버 라우트는 올리지 않았다"고 적어 둔 대로 이것은 "없다"가
  // 아니라 "아직"이고, `provided`가 true로 바뀌는 순간 되살아나야 할 자리다.
  // 그때 이 목과 위의 APPROVALS 픽스처가 그대로 먹고, 뺀 두 프레임(3g)을 복원하면
  // 된다. 지웠다가 다시 쓰는 것보다 죽은 이유를 적어 두는 편이 싸다.
  await context.route("**/v1/workspaces/*/approvals*", (route) => {
    const url = new URL(route.request().url());
    return json(route, {
      approvals:
        url.searchParams.get("status") === "pending" ? APPROVALS : [],
    });
  });
  await context.route("**/v1/workspaces/*/presence", (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}");
      if (
        body.status === "auto" ||
        body.status === "away" ||
        body.status === "dnd"
      ) {
        declaredPresence = body.status;
        if (Object.prototype.hasOwnProperty.call(body, "statusEmoji")) {
          customStatus.statusEmoji =
            body.statusEmoji === null || body.statusEmoji === ""
              ? undefined
              : body.statusEmoji;
        }
        if (Object.prototype.hasOwnProperty.call(body, "statusText")) {
          customStatus.statusText =
            body.statusText === null || body.statusText === ""
              ? undefined
              : body.statusText;
        }
        if (Object.prototype.hasOwnProperty.call(body, "statusExpiresAtMs")) {
          customStatus.statusExpiresAtMs =
            typeof body.statusExpiresAtMs === "number"
              ? body.statusExpiresAtMs
              : undefined;
        }
        const response = { status: declaredPresence };
        if (customStatus.statusEmoji) response.statusEmoji = customStatus.statusEmoji;
        if (customStatus.statusText) response.statusText = customStatus.statusText;
        if (customStatus.statusExpiresAtMs !== undefined) {
          response.statusExpiresAtMs = customStatus.statusExpiresAtMs;
        }
        return json(route, response);
      }
      return route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({ error: "invalid_status" }),
      });
    }
    const own = { status: declaredPresence };
    if (customStatus.statusEmoji) own.statusEmoji = customStatus.statusEmoji;
    if (customStatus.statusText) own.statusText = customStatus.statusText;
    if (customStatus.statusExpiresAtMs !== undefined) {
      own.statusExpiresAtMs = customStatus.statusExpiresAtMs;
    }
    return json(route, own);
  });
  await context.route("**/v1/workspaces/*/roster", (route) =>
    json(route, {
      members: ROSTER.map((member) =>
        member.id === ME
          ? {
              ...member,
              presenceStatus: declaredPresence,
              statusEmoji: customStatus.statusEmoji,
              statusText: customStatus.statusText,
              statusExpiresAtMs: customStatus.statusExpiresAtMs,
            }
          : member
      ),
    })
  );
  await context.route("**/v1/workspaces/*/read-state", (route) =>
    json(route, { read_states: READ_STATES })
  );
  // BF-B1 (#1888). Same 30s poll as read-state; without this pair the catch-all
  // 404s and the 나중에 tab is an error instead of a list.
  await context.route("**/v1/workspaces/*/reminders*", (route) => {
    const now = Date.now();
    return json(route, {
      reminders: [
        {
          id: "00000000-0000-7000-8000-000000000801",
          workspaceId: WORKSPACE_ID,
          memberId: ME,
          channelId: GENERAL_ID,
          messageId: "00000000-0000-7000-8000-000000000501",
          dueAtMs: now + 30 * 60_000,
          createdAtMs: now - 5 * 60_000,
          note: "배포 후 한 줄만 확인",
          messagePreview: "스테이징 배포 체크리스트 공유합니다",
          seq: 42,
        },
        {
          id: "00000000-0000-7000-8000-000000000802",
          workspaceId: WORKSPACE_ID,
          memberId: ME,
          channelId: GENERAL_ID,
          messageId: "00000000-0000-7000-8000-000000000502",
          dueAtMs: now - 10 * 60_000,
          createdAtMs: now - 3 * 60 * 60_000,
          messagePreview: "내일 스탠드업 안건 초안",
          seq: 18,
        },
      ],
    });
  });
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) =>
    json(route, READ_STATES[0])
  );
  await context.route(
    "**/v1/workspaces/*/channels/*/huddles/active",
    (route) => json(route, { huddle: null })
  );
  // 설정 > 코드 실행 호스트 (MOMO-617). The workspace default sits in 자동 재개
  // so the 재개 대상 control is on screen, and the member override inherits it,
  // which is the pair the panel has to keep apart.
  await context.route("**/v1/provider/work-host-engine", (route) =>
    json(route, {
      engine: "opencode",
      source: "database",
      updatedBy: "곽성재",
      updatedAtMs: Date.now() - 2 * 86_400_000,
      schema: "momo.work_host_engine.v0",
    })
  );
  await context.route("**/v1/workspaces/*/work-hosts", (route) =>
    json(route, { workHosts: WORK_HOSTS })
  );
  // 작업 세션 원장 (ADR-0154 D2 / 이슈 1135). **이 라우트가 없으면 캡처가 로그인
  // 화면으로 되돌아간다** — 아래 스레드 답글 라우트의 주석과 똑같은 덫이다: ADE
  // 요약 줄이 셸에 상주하면서 이 경로를 읽는데, 목이 없으면 요청이 프리뷰 서버로
  // 새고, 프리뷰 서버는 모르는 `/v1/*`에 401을 답하며, 클라는 회전에도 401을 받고
  // 세션을 끝낸다. 화면에는 채팅 대신 로그인 폼이 뜬다.
  //
  // 원장을 비워 두는 것은 **선택**이다. 이 캡처가 재는 것은 다른 표면들의 기하이고,
  // 살아 있는 작업이 0이면 요약 줄은 아예 그리지 않는다(그것이 그 줄의 계약이다).
  // ADE 표면 자체의 light/dark 캡처는 `npm run gate:ade`가 매 실행마다 다시 만든다
  // (artifacts/ade/). 여기에 실행 중 세션을 실으면 관계없는 수십 장이 함께 밀린다.
  await context.route("**/v1/workspaces/*/work-sessions*", (route) =>
    json(route, { workSessions: [] })
  );
  // 설정 > AI 연결 (MOMO-627). The chain routes are matched BEFORE the singleton
  // so `**/v1/provider/link` does not swallow `/link/chain` and `/link/test`.
  await context.route("**/v1/provider/link/chain", (route) =>
    json(route, PROVIDER_CHAIN)
  );
  await context.route("**/v1/provider/link/test", (route) =>
    json(route, PROVIDER_PROBE)
  );
  await context.route("**/v1/provider/link", (route) => json(route, PROVIDER_LINK));
  await context.route("**/v1/workspaces/*/work-tier-policy", (route) =>
    json(route, { workTierPolicy: WORKSPACE_TIER_POLICY })
  );
  await context.route("**/v1/workspaces/*/work-tier-policy/me", (route) =>
    json(route, { workTierPolicy: MEMBER_TIER_POLICY })
  );
  // 반응 스냅샷 (goal B11). 서버는 이 맵을 **대문자 id**로 준다(Swift
  // `uuidString`) — 메시지 투영은 소문자다. 픽스처가 그 두 자리를 그대로
  // 재현해야 캡처가 접기(case fold)를 실제로 검증한다. `capture-15`가 아니라
  // `CAPTURE-15`로 쓰는 이유가 그것이다.
  //
  // 세 종류를 담는다: 내가 누른 것(강조 칩), 남만 누른 것, 그리고 여러 개가
  // 한 줄에 놓인 것. 리뷰가 봐야 하는 것은 그 셋의 대비다.
  await context.route("**/v1/workspaces/*/channels/*/reactions", (route) =>
    json(route, {
      // 반드시 **살아 있는** 행에만 단다. 삭제된 메시지의 반응은 서버가 함께
      // 지우고 스냅샷도 tombstone을 빼고 주므로, 지워진 행에 칩이 달린 픽스처는
      // 서버가 낼 수 없는 화면을 그린다 — 픽스처가 거짓말을 하면 리뷰가 못 미더운
      // 것을 승인하게 된다. capture-15는 아래에서 deleted로 표시되는 행이다.
      "CAPTURE-14": { "👍": [ME.toUpperCase(), HERMES.toUpperCase()] },
      "CAPTURE-17": {
        "👍": [HERMES.toUpperCase()],
        "🎉": [HERMES.toUpperCase(), ME.toUpperCase()],
        "👀": [HERMES.toUpperCase()],
      },
    })
  );
  // 스레드 답글 (goal B11). **이 캡처에서 스레드를 연 프레임이 처음이라 이 라우트가
  // 없었다.** 없으면 요청이 프리뷰 서버로 새고, 프리뷰 서버는 모르는 `/v1/*`에
  // 401을 답한다 — 클라는 그 401에 토큰 회전을 시도하고, 회전도 401이면 세션을
  // 끝낸다. 화면에는 스레드 대신 로그인 폼이 뜨고, 원인은 스레드와 아무 상관이
  // 없어 보인다. `messages*`의 `*`는 `/`를 건너지 않으므로 이 경로는 위 라우트에
  // 걸리지 않는다(그래서 별도 라우트다).
  await context.route(
    "**/v1/workspaces/*/channels/*/messages/*/replies*",
    (route) => json(route, { messages: makeThreadReplies() })
  );
  await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
    const url = new URL(route.request().url());
    // Older-history and backfill pages are empty: the head page is the shot.
    if (url.searchParams.has("before") || url.searchParams.has("after")) {
      return json(route, { messages: [] });
    }
    if (url.pathname.includes(DM_ID)) {
      return json(route, { messages: makeDmMessages() });
    }
    return json(route, { messages: makeMessages(16) });
  });

  // ── 설정 나머지 표면의 픽스처 (#1057) ──────────────────────────────────────
  // 이 하네스는 설정 아홉 섹션 중 **둘**(AI 연결·코드 실행 호스트)만 찍고 있었다.
  // 나머지 일곱은 라우트가 없어 프리뷰 서버로 새고, 404 HTML 을 받은 패널은
  // 에러 경계를 그린다 — 즉 "안 찍힌" 것이 아니라 "찍으면 빨간 판"이었다. 그래서
  // 설정 UI 를 바꾼 PR 은 커밋된 캡처 없이 리뷰됐다(#1056 실측).
  //
  // 아래 픽스처는 게이트가 이미 쓰는 것과 같은 출처를 쓴다: 사용량·구독 잔여량은
  // src/features/settings/{usage,quota}Fixtures.json 이고, 그 파일은 각각의 모델
  // 테스트가 계약으로 붙잡고 있다. 손으로 지어낸 페이로드는 서버가 낼 수 없는
  // 화면을 그리므로 리뷰가 못 미더운 것을 승인하게 된다.
  await context.route("**/v1/workspaces/*/usage/summary*", (route) =>
    json(route, USAGE_FIXTURE)
  );
  await context.route("**/v1/provider/quota-snapshots", (route) =>
    json(route, QUOTA_FIXTURE)
  );
  await context.route("**/v1/workspaces/*/invites*", (route) =>
    json(route, { invites: SETTINGS_INVITES })
  );
  // #1369 OAuth consent preview. `preview-unavailable` is the non-enumerable 404
  // (also the shape an OAuth-disabled server answers); the rest vary the body so
  // the empty/expired terminals are shootable from one route. `expiresAtMs` is
  // now-relative so the form frame is never accidentally past its own expiry.
  await context.route(
    "**/v1/workspaces/*/oauth/authorization-requests/preview*",
    (route) => {
      const request = new URL(route.request().url()).searchParams.get("request");
      if (request === "preview-unavailable") {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "not found" } }),
        });
      }
      const now = Date.now();
      if (request === "preview-empty") {
        return json(route, {
          ...OAUTH_CONSENT_PREVIEW,
          expiresAtMs: now + 540_000,
          candidates: [],
        });
      }
      if (request === "preview-expired") {
        return json(route, { ...OAUTH_CONSENT_PREVIEW, expiresAtMs: now - 1000 });
      }
      return json(route, { ...OAUTH_CONSENT_PREVIEW, expiresAtMs: now + 540_000 });
    }
  );
  // 설정 > 웹훅 (#1202). 발급/회전은 **한 번만 돌아오는** 응답이라, 이 목이 없으면
  // 리뷰가 볼 수 없는 화면이 정확히 그 화면이다. 목록은 상태를 바꾸지 않는다:
  // 이 하네스가 재는 것은 발급 카드와 폐기 확인의 기하이지 서버의 상태 전이가
  // 아니고, 그쪽은 코어 스위트가 계약으로 붙잡고 있다.
  await context.route("**/v1/workspaces/*/webhooks", (route) => {
    if (route.request().method() !== "POST") {
      return json(route, { installations: SETTINGS_WEBHOOKS });
    }
    const body = JSON.parse(route.request().postData() || "{}");
    const created = {
      id: "019f9b10-0000-7000-8000-0000000009c1",
      channelId: body.channelId,
      authorMemberId: ME,
      mode: body.mode,
      label: body.label,
      status: "active",
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    };
    return json(route, {
      installation: created,
      keyId: "019f9b10-0000-7000-8000-0000000009d1",
      ...(body.mode === "native"
        ? {
            secret: WEBHOOK_CAPTURE_SECRET,
            url: `/v1/webhooks/${WORKSPACE_ID}/${created.id}`,
            signatureVersion: "v1",
            algorithm: "HMAC-SHA256",
          }
        : { url: `/hooks/${WEBHOOK_CAPTURE_SECRET}` }),
    });
  });
  await context.route("**/v1/workspaces/*/webhooks/*/rotate", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2);
    const row = SETTINGS_WEBHOOKS.find((item) => item.id === id);
    return json(route, {
      installation: row,
      keyId: "019f9b10-0000-7000-8000-0000000009d2",
      secret: WEBHOOK_CAPTURE_SECRET,
      url: `/v1/webhooks/${WORKSPACE_ID}/${id}`,
      signatureVersion: "v1",
      algorithm: "HMAC-SHA256",
      overlapSeconds: 86_400,
    });
  });
  await context.route("**/v1/workspaces/*/webhooks/*", (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1);
    const row = SETTINGS_WEBHOOKS.find((item) => item.id === id);
    return json(route, {
      installation: { ...row, status: "revoked", updatedAtMs: Date.now() },
      revoked: true,
    });
  });
  // 설정 > 앱은 **카탈로그 한 줄과 함께** 찍는다 (이슈 #1125).
  //
  // 1차는 빈 카탈로그였다. 줄을 하나 얹으면 다음 섹션 진입이 무너졌기 때문인데,
  // 그 원인은 위 `installUnmockedFallback` 머리말이 규명한 그것이다 — 카탈로그
  // 행이 여는 `GET …/plugins/{id}` 에 짝이 없어 프리뷰 프록시를 타고 나갔고,
  // 진짜 서버의 401 이 앱을 로그아웃시켰다. 레이아웃과는 무관했다.
  //
  // 목은 `gate-shell-layout` 이 쓰는 것과 같은 출처(출하 시드 매니페스트)를
  // 그대로 든다. 손으로 지어낸 페이로드는 서버가 낼 수 없는 화면을 그리므로
  // 리뷰가 못 미더운 것을 승인하게 된다.
  await context.route("**/v1/workspaces/*/plugins", (route) =>
    json(route, { plugins: [PLUGIN_CATALOG_ITEM], toolPolicy: { plugins: [] } })
  );
  await context.route(`**/v1/workspaces/*/plugins/${PLUGIN_MANIFEST.plugin.id}`, (route) =>
    json(route, { plugin: { ...PLUGIN_CATALOG_ITEM, manifest: PLUGIN_MANIFEST } })
  );
  await context.route(
    `**/v1/workspaces/*/plugins/${PLUGIN_MANIFEST.plugin.id}/grants`,
    (route) => json(route, { grants: [] })
  );
  // #1112 이 더한 부속 읽기. 이 하네스가 찍는 채널 프레임마다 나가고, 짝이 없으면
  // 위 포괄 라우트가 404 로 접어 고정 목록이 「불러오지 못했습니다」로 선다 —
  // 캡처가 보여줄 상태가 아니다.
  await context.route("**/v1/workspaces/*/channels/*/pins", (route) =>
    json(route, { pins: [] })
  );
  // 워크스페이스 라우트 중 가장 덜 구체적이다. `*` 는 `/` 를 건너지 않으므로 위의
  // 하위 경로들은 여전히 자기 라우트로 간다.
  await context.route("**/v1/workspaces/*", (route) =>
    json(route, {
      workspace: {
        id: WORKSPACE_ID,
        slug: "momowebqa",
        name: "momo webqa",
        updatedAtMs: Date.now(),
        roleLabels: {},
      },
    })
  );
  // ADR-0170 client evidence. Only the newest fixture row carries a card, so
  // the normal chat frame shows the real density and the author-only remove
  // control. Every other candidate answers with the server-off shape: empty,
  // with no placeholder invented by the client.
  await context.route("**/v1/workspaces/*/messages/*/unfurls", (route) => {
    if (route.request().method() === "DELETE") {
      return json(route, { removed: true });
    }
    const messageId = new URL(route.request().url()).pathname.split("/").at(-2);
    return json(route, {
      unfurls:
        messageId === "capture-17"
          ? [
              {
                id: "capture-unfurl-1",
                messageId,
                url: "https://docs.oor7.com/runbooks/gateway-errors",
                status: "ok",
                title: "게이트웨이 오류 대응 런북",
                description:
                  "502가 반복될 때 요청 경로와 워커 상태를 확인하는 순서입니다.",
                domain: "docs.oor7.com",
                imageUrl: `/v1/workspaces/${WORKSPACE_ID}/unfurls/capture-unfurl-1/image`,
              },
            ]
          : [],
    });
  });
  await context.route("**/v1/workspaces/*/unfurls/*/image", (route) => {
    if (!UNFURL_PREVIEW_PNG) {
      throw new Error("언퍼얼 OG 픽스처 PNG가 아직 없다");
    }
    return route.fulfill({
      status: 200,
      contentType: "image/png",
      body: UNFURL_PREVIEW_PNG,
    });
  });
  await context.route("**/v1/workspaces/*/unfurl-settings", (route) => {
    const body = JSON.parse(route.request().postData() || "{}");
    return json(route, {
      enabled: route.request().method() === "PUT" ? body.enabled : true,
      updatedAtMs: Date.now() - 3_600_000,
    });
  });
  // ADR-0177 / BT-4 (#1932) — 멤버 소유 사이드바 배치.
  //
  // GET 의 기본값은 **빈 payload** 다. 여기에 커스텀 섹션을 심으면 이 파일의
  // 기존 사이드바 프레임이 전부 한 칸씩 달라지므로, 섹션은 장면이 UI 로 직접
  // 만들고 끝나기 전에 지운다(`captureSidebarSections` 꼬리). PUT 은 서버처럼
  // 통째로 되돌려 준다.
  await context.route(
    "**/v1/workspaces/*/members/me/sidebar-prefs",
    (route) => {
      if (route.request().method() === "PUT") {
        const body = JSON.parse(route.request().postData() || "{}");
        return json(route, {
          prefs: body.prefs ?? { version: 1, sections: [], starredChannelIds: [] },
          updatedAtMs: Date.now(),
        });
      }
      return json(route, {
        prefs: { version: 1, sections: [], starredChannelIds: [] },
      });
    }
  );
  await context.route("**/v1/workspaces/*/notification-rules", (route) => {
    if (route.request().method() === "PUT") {
      const body = JSON.parse(route.request().postData() || "{}");
      return json(route, {
        dnd: Boolean(body.dnd),
        mentionOverridesMute: Boolean(body.mentionOverridesMute),
      });
    }
    return json(route, { dnd: false, mentionOverridesMute: true });
  });
}

async function assertOnboardingCardCentered(page, where, testId) {
  const m = await page.evaluate(`(() => {
    const card = document.querySelector('[data-testid="${testId}"]');
    if (!card) return { missing: true };
    const r = card.getBoundingClientRect();
    return {
      missing: false,
      left: Math.round(r.left),
      width: Math.round(r.width),
      cardMid: r.left + r.width / 2,
      viewMid: window.innerWidth / 2,
    };
  })()`);
  if (m.missing) {
    throw new Error(`카드 중앙 ${where}: ${testId} 없음`);
  }
  const delta = Math.abs(m.cardMid - m.viewMid);
  if (delta > 8) {
    throw new Error(
      `카드 중앙 ${where}: ${testId} mid=${m.cardMid.toFixed(1)} view=${m.viewMid.toFixed(1)} ` +
        `left=${m.left} width=${m.width} (delta ${delta.toFixed(1)}px)`
    );
  }
  console.log(
    `  card center ${where}: ${testId} left=${m.left} width=${m.width} delta=${delta.toFixed(1)}`
  );
}

async function assertCloudMissesTarget(page, where, testId, label) {
  const proof = await page.evaluate(`(() => {
    const target = document.querySelector('[data-testid="${testId}"]');
    if (!target) return { missing: true, hits: [] };
    const b = target.getBoundingClientRect();
    const hits = [];
    for (const el of document.querySelectorAll("[data-onboarding-body]")) {
      const r = el.getBoundingClientRect();
      const overlap = !(
        r.right < b.left ||
        r.left > b.right ||
        r.bottom < b.top ||
        r.top > b.bottom
      );
      if (overlap) {
        hits.push({
          body: el.getAttribute("data-onboarding-body"),
          left: Math.round(r.left),
          top: Math.round(r.top),
          right: Math.round(r.right),
          bottom: Math.round(r.bottom),
        });
      }
    }
    return { missing: false, hits };
  })()`);
  if (proof.missing) {
    throw new Error(`S0 ${label} ${where}: ${testId} 없음`);
  }
  if (proof.hits.length !== 0) {
    throw new Error(
      `S0 ${label} ${where}: hits=${proof.hits.length} ` + JSON.stringify(proof)
    );
  }
  console.log(`  S0 ${label} ${where}: hits 0`);
}

async function assertCloudMissesCta(page, where) {
  await assertCloudMissesTarget(page, where, "onboarding-choose-invite", "CTA invite");
  await assertCloudMissesTarget(page, where, "onboarding-choose-server", "CTA server");
}

async function assertCloudMissesLockup(page, where) {
  await assertCloudMissesTarget(page, where, "onboarding-lockup", "lockup");
}

async function signIn(page) {
  // 위의 refresh 스텁이 세션을 **살려 두게** 되면서 되살아난 전제 하나: 이 컨텍스트의
  // 페이지 14장이 localStorage 를 공유하므로, 두 번째 페이지부터는 이미 로그인된
  // 셸로 자동 복귀해 로그인 카드가 아예 없다. 지금까지는 회전이 실패해 매번
  // 로그아웃되는 덕에 우연히 로그인 화면이 나왔던 것이다 — 그 우연에 기대던 자리를
  // 명시적인 초기화로 바꾼다.
  await page.evaluate(
    "try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}"
  );
  await page.reload({ waitUntil: "networkidle" });
  await signInThroughOnboarding(page, {
    email: "seongjae@dawn.example",
    password: "capture-only-not-a-credential",
  });
  await page.getByTestId("channel-list").waitFor({ state: "visible" });
}

/**
 * S0 → S1 → S2. Capture photographs S0 (new surface) plus the split connect
 * cards. Tap-target lists are mobile-only; desktop still asserts overflow.
 */
async function assertOnboardingIgnoresAccent(page, where) {
  const readLanding = () =>
    page.evaluate(() => {
      const landing = document.querySelector('[data-testid="onboarding-landing"]');
      const cta = document.querySelector('[data-testid="onboarding-choose-server"]');
      if (!landing || !cta) return null;
      const landingStyle = getComputedStyle(landing);
      const ctaStyle = getComputedStyle(cta);
      return {
        space: landingStyle.backgroundColor,
        ink: landingStyle.color,
        onboardingAccent: landingStyle.getPropertyValue("--onboarding-accent").trim(),
        ctaBg: ctaStyle.backgroundColor,
      };
    });
  const before = await readLanding();
  if (!before?.onboardingAccent) {
    throw new Error(`S0 격리 ${where}: 랜딩 토큰을 읽지 못했다`);
  }
  const other = accentCatalogIds().find((id) => id !== "dawn") ?? "seongun";
  await page.evaluate((id) => {
    document.documentElement.setAttribute("data-accent", id);
  }, other);
  const after = await readLanding();
  if (
    !after ||
    after.space !== before.space ||
    after.ink !== before.ink ||
    after.onboardingAccent !== before.onboardingAccent ||
    after.ctaBg !== before.ctaBg
  ) {
    throw new Error(
      `S0 격리 ${where}: data-accent=${other} 가 랜딩을 바꿨다 ` +
        `${JSON.stringify({ before, after })}`
    );
  }
  await page.evaluate(() => {
    document.documentElement.setAttribute("data-accent", "dawn");
  });
}

async function walkOnboardingToAccount(page, where, { tapTargets = false, shoot } = {}) {
  await page.getByTestId("onboarding-landing").waitFor({ state: "visible" });
  await assertOnboardingIgnoresAccent(page, where);
  const scatter = await page.locator("[data-onboarding-body]").count();
  if (scatter !== 30) {
    throw new Error(`S0 산포 ${where}: ${scatter}개체 (기대 30)`);
  }
  await assertCloudMissesCta(page, where);
  await assertCloudMissesLockup(page, where);
  const wordmark = await page.getByTestId("onboarding-wordmark").textContent();
  if (wordmark?.trim() !== "oort") {
    throw new Error(`S0 워드마크 ${where}: ${JSON.stringify(wordmark)}`);
  }
  const tagline = await page.getByTestId("onboarding-tagline").textContent();
  if (tagline?.trim() !== "사람과 에이전트가 같은 자리에서 일하는 메신저.") {
    throw new Error(`S0 카피 ${where}: ${JSON.stringify(tagline)}`);
  }
  const lockupMetrics = await page.evaluate(`(() => {
    const mark = document.querySelector('[data-testid="onboarding-mark"]');
    const word = document.querySelector('[data-testid="onboarding-wordmark"]');
    const copy = document.querySelector('[data-testid="onboarding-tagline"]');
    const markBox = mark.getBoundingClientRect();
    const copyBox = copy.getBoundingClientRect();
    const wordSize = parseFloat(getComputedStyle(word).fontSize);
    const copySize = parseFloat(getComputedStyle(copy).fontSize);
    const copyLh = parseFloat(getComputedStyle(copy).lineHeight);
    return {
      mark: Math.round(markBox.height),
      wordFont: Math.round(wordSize * 10) / 10,
      copyFont: Math.round(copySize * 10) / 10,
      copyHeight: Math.round(copyBox.height),
      copyLh: Math.round(copyLh * 10) / 10,
      copyWidth: Math.round(copyBox.width),
    };
  })()`);
  const wordRatio = lockupMetrics.wordFont / lockupMetrics.mark;
  if (wordRatio < 0.24 || wordRatio > 0.36) {
    throw new Error(
      `S0 워드마크 위계 ${where}: ${lockupMetrics.wordFont}px / mark ${lockupMetrics.mark}px = ${wordRatio.toFixed(3)} (기대 1/4–1/3)`
    );
  }
  if (lockupMetrics.wordFont <= lockupMetrics.copyFont + 4) {
    throw new Error(
      `S0 워드마크가 카피와 같은 단 ${where}: word ${lockupMetrics.wordFont}px copy ${lockupMetrics.copyFont}px`
    );
  }
  if (lockupMetrics.copyHeight > lockupMetrics.copyLh + 1) {
    throw new Error(
      `S0 카피 2줄 ${where}: h=${lockupMetrics.copyHeight} lh=${lockupMetrics.copyLh} w=${lockupMetrics.copyWidth}`
    );
  }
  console.log(
    `  S0 lockup ${where}: mark ${lockupMetrics.mark}px · wordmark ${lockupMetrics.wordFont}px · copy ${lockupMetrics.copyFont}px ${lockupMetrics.copyWidth}×${lockupMetrics.copyHeight}`
  );
  await page.getByTestId("onboarding-choose-server").focus();
  const landingFocus = await page.evaluate(
    `document.activeElement?.getAttribute("data-testid")`
  );
  if (landingFocus !== "onboarding-choose-server") {
    throw new Error(`S0 포커스 ${where}: ${landingFocus}`);
  }
  const fill = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="onboarding-landing"]');
    const r = el.getBoundingClientRect();
    return {
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      viewport: window.innerHeight,
    };
  })()`);
  if (fill.bottom < fill.viewport - 1) {
    throw new Error(
      `S0 높이 ${where}: 랜딩 아랫변 ${fill.bottom}px / 뷰포트 ${fill.viewport}px (top ${fill.top})`
    );
  }
  await assertNoHorizontalOverflow(page, `landing ${where}`);
  if (tapTargets) {
    await assertTapTargets(page, `landing ${where}`, LANDING_TAP_TARGETS);
  }
  if (shoot) await shoot("onboarding-landing");

  await page.getByTestId("onboarding-choose-server").click();
  await page.getByTestId("onboarding-gateway").waitFor({ state: "visible" });
  const chrome = await page.evaluate(`(() => {
    const row = document.querySelector('[data-testid="onboarding-step-chrome"]');
    const back = document.querySelector('[data-testid="onboarding-back"]');
    const progress = document.querySelector('[data-testid="onboarding-progress"]');
    return {
      row: Boolean(row && back && progress && row.contains(back) && row.contains(progress)),
      underline: back ? getComputedStyle(back).textDecorationLine : null,
      backLabel: back?.textContent?.replace(/\\s+/g, " ").trim() ?? null,
    };
  })()`);
  if (!chrome.row) {
    throw new Error(`S1 크롬 ${where}: 뒤로/카운터가 한 줄이 아님 ${JSON.stringify(chrome)}`);
  }
  if (chrome.underline && chrome.underline !== "none") {
    throw new Error(`S1 크롬 ${where}: 뒤로가 밑줄 ${chrome.underline}`);
  }
  if (chrome.backLabel !== "뒤로") {
    throw new Error(`S1 크롬 ${where}: 뒤로 레이블 ${JSON.stringify(chrome.backLabel)}`);
  }
  await assertNoHorizontalOverflow(page, `gateway ${where}`);
  await assertOnboardingCardCentered(page, `gateway ${where}`, "onboarding-gateway");
  if (tapTargets) {
    await assertTapTargets(page, `gateway ${where}`, GATEWAY_TAP_TARGETS);
  }
  if (shoot) await shoot("onboarding-gateway");

  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("onboarding-account").waitFor({ state: "visible" });
  await page.getByTestId("login-submit").waitFor({ state: "visible" });
  await assertOnboardingCardCentered(page, `account ${where}`, "onboarding-account");
}

async function shootOnboardingProfile(page, where, { tapTargets = false, shoot } = {}) {
  await page.getByTestId("onboarding-landing").waitFor({ state: "visible" });
  await page.getByTestId("onboarding-choose-invite").click();
  await page.getByTestId("onboarding-gateway").waitFor({ state: "visible" });
  await page.getByTestId("login-invite-code").fill("momo-alpha-2026");
  await page.getByTestId("onboarding-next").click();
  await page.getByTestId("onboarding-account").waitFor({ state: "visible" });
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("onboarding-profile").waitFor({ state: "visible" });
  const chrome = await page.evaluate(`(() => {
    const row = document.querySelector('[data-testid="onboarding-step-chrome"]');
    const back = document.querySelector('[data-testid="onboarding-back"]');
    const progress = document.querySelector('[data-testid="onboarding-progress"]');
    return {
      hasBack: Boolean(back),
      progress: progress?.textContent ?? null,
      rowHasProgress: Boolean(row && progress && row.contains(progress)),
    };
  })()`);
  if (chrome.hasBack) {
    throw new Error(`S3 크롬 ${where}: 뒤로가 있다`);
  }
  if (chrome.progress !== "4/4" || !chrome.rowHasProgress) {
    throw new Error(`S3 크롬 ${where}: ${JSON.stringify(chrome)}`);
  }
  await assertOnboardingCardCentered(page, `profile ${where}`, "onboarding-profile");
  await assertNoHorizontalOverflow(page, `profile ${where}`);
  if (tapTargets) {
    await assertTapTargets(page, `profile ${where}`, PROFILE_TAP_TARGETS);
  }
  if (shoot) await shoot("onboarding-profile");
  await page.getByTestId("onboarding-profile-name").fill("가".repeat(101));
  await page.getByTestId("onboarding-profile-name-error").waitFor({
    state: "visible",
  });
  if (shoot) await shoot("onboarding-profile-field-error");
  await page.route("**/v1/workspaces/*/members/me", (route) => {
    if (route.request().method() === "PATCH") {
      return json(route, { error: { message: "engine boom" } }, 500);
    }
    return route.fallback();
  });
  await page.getByTestId("onboarding-profile-name").fill("성재");
  await page.getByTestId("onboarding-profile-submit").click();
  await page.getByTestId("onboarding-profile-banner").waitFor({
    state: "visible",
  });
  if (shoot) await shoot("onboarding-profile-banner");
}

function isPresencePut(request) {
  if (request.method() !== "PUT") return false;
  try {
    return new URL(request.url()).pathname.endsWith("/presence");
  } catch {
    return false;
  }
}

/** UX-HT: 포인터 rest 에서 + 는 DOM 0. 캡처가 열려면 헤더를 먼저 hover 한다. */
async function revealNewChannel(page) {
  const button = page.getByTestId("new-channel");
  if ((await button.count()) === 0) {
    await page.getByTestId("sidebar-section-channels-header").hover();
    await button.waitFor({ state: "visible" });
  }
  await button.click();
}

async function sectionActionRestCounts(page) {
  return page.evaluate(`(() => {
    const plus = document.querySelectorAll('[data-testid="new-channel"]').length;
    const dm = document.querySelectorAll('[data-testid="new-dm"]').length;
    const tabStops = Array.from(
      document.querySelectorAll('[data-section-action]')
    ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex >= 0).length;
    return { plus, dm, tabStops };
  })()`);
}

/** overlayHeld 해제(rAF) 와 포인터 주차를 기다린 뒤 rest 0 을 단정한다. */
async function assertSectionActionsAtRest(page, scheme, where) {
  await page.getByTestId("composer-input").hover();
  await page.getByTestId("composer-input").click();
  await page.evaluate(
    `new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))`
  );
  const counts = await sectionActionRestCounts(page);
  if (counts.plus !== 0 || counts.dm !== 0 || counts.tabStops !== 0) {
    throw new Error(
      `섹션 액션 rest ${where} ${scheme}: ${JSON.stringify(counts)} (plus/dm/tabStops 전부 0이어야 함)`
    );
  }
}

function isMutePut(request) {
  if (request.method() !== "PUT") return false;
  try {
    return new URL(request.url()).pathname.endsWith("/notification-pref");
  } catch {
    return false;
  }
}

function isReadStatePut(request) {
  if (request.method() !== "PUT") return false;
  try {
    return new URL(request.url()).pathname.endsWith("/read-state");
  } catch {
    return false;
  }
}

/**
 * BT-1 (#1929): 사이드바 행의 우클릭 메뉴. 두 스킴에서 **열린 프레임**을 찍고,
 * 찍기 전에 그것이 죽은 컨트롤이 아님을 누른다.
 *
 * 여기서 재는 것 넷:
 *   ① 우클릭이 그 행의 메뉴를 열고, 열려 있는 동안 행이 자기가 임자임을 말한다.
 *   ② 키보드에도 같은 문이 있다 (Shift+F10) — 그리고 Esc 뒤 캐럿이 **그 행으로**
 *      돌아온다. BODY 추락은 회귀다.
 *   ③ 알림 토글이 실제로 PUT 하고, 서버가 기억한 값을 따라 낱말이 뒤집힌다.
 *   ④ 「읽음 처리」가 그 채널의 `latest_seq` 를 광고한다.
 */
async function captureSidebarRowMenu(page, scheme, shots) {
  // 안 읽음이 있는 행을 고른다: 다섯 항목이 전부 서는 유일한 상태이고,
  // 「읽음 처리」를 누를 수 있는 유일한 행이다.
  const unreadChannelId = CHANNELS[1].id;
  const row = page.locator(`[data-channel-id="${unreadChannelId}"]`);
  await row.waitFor({ state: "visible" });

  // 행이 두 줄로 흩어지지 않았는가 (실측 회귀): `asChild` 트리거가 NavLink 의
  // 함수 className 을 문자열로 이어 붙이면 행은 flex 도 패딩도 잃는다. 캡처가
  // 그 결함을 한 번 통과시켰으므로, 이제 프레임을 찍기 전에 기하를 잰다.
  const rowBox = await row.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return {
      height: Math.round(rect.height),
      display: style.display,
      paddingLeft: style.paddingLeft,
    };
  });
  if (rowBox.display !== "flex" || rowBox.height > 40) {
    throw new Error(
      `사이드바 행 기하 ${scheme}: ${JSON.stringify(rowBox)} (flex · 한 줄이어야 함)`
    );
  }

  await row.click({ button: "right" });
  const menu = page.getByTestId("channel-row-menu");
  await menu.waitFor({ state: "visible" });
  const owner = await row.evaluate((el) =>
    el.closest("[data-row-menu-trigger]")?.getAttribute("data-state")
  );
  if (owner !== "open") {
    throw new Error(
      `행 메뉴가 열렸는데 행 자리가 임자라고 말하지 않는다 ${scheme}: ${owner}`
    );
  }
  const items = await menu
    .locator("[data-testid^='channel-row-']")
    .evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid"))
    );
  // BT-5(#1933)가 「별표」를 사이드바 정리 무리의 첫 항목으로 들여놨다. 배치
  // (「섹션으로 이동」)는 커스텀 섹션이 하나도 없는 이 시점에는 서지 않는다 —
  // 목적지가 없는 라디오 무리는 선택지가 아니기 때문이다(BT-4).
  const expected = [
    "channel-row-mark-read",
    "channel-row-mute-toggle",
    "channel-row-star",
    "channel-row-copy-link",
    "channel-row-copy-name",
    "channel-row-leave",
  ];
  if (JSON.stringify(items) !== JSON.stringify(expected)) {
    throw new Error(
      `행 메뉴 항목 ${scheme}: ${JSON.stringify(items)} (${JSON.stringify(expected)} 여야 함)`
    );
  }
  const menuShot = `${OUT_DIR}/sidebar-row-menu-${scheme}.png`;
  await waitForAnimations(page);
  await page.screenshot({ path: menuShot });
  shots.push(menuShot);

  // ④ 읽음 처리 — 채널을 열지 않고 그 채널의 latest_seq 를 광고한다.
  const readPut = page.waitForRequest(isReadStatePut);
  await page.getByTestId("channel-row-mark-read").click();
  const readBody = (await readPut).postDataJSON();
  if (readBody?.last_read_seq !== 42) {
    throw new Error(
      `읽음 처리 PUT ${scheme}: ${JSON.stringify(readBody)} (last_read_seq 42 여야 함)`
    );
  }
  await menu.waitFor({ state: "hidden" });

  // ② 키보드에도 같은 문이 있고, **그 방에는 바닥이 있다**
  //    (design-review #1937 B-1). 예전 캡처는 「Shift+F10 → 곧바로 Escape」만
  //    걸어서 그 사이의 화살표를 한 번도 누르지 않았고, 그래서 ↓ 한 번에 메뉴가
  //    사라지고 캐럿이 「활동」으로 튀는 결함을 통과시켰다. 이제 항목에 서서
  //    Enter 로 실행한다 — 헤더 게이트가 이미 쓰는 그 형상.
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await menu.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-testid") ===
      "channel-row-mark-read",
    undefined,
    { timeout: 4_000 }
  ).catch(async () => {
    throw new Error(
      `키보드로 연 메뉴의 첫 정거장 ${scheme}: ${await page.evaluate(
        `document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName`
      )} (channel-row-mark-read 여야 함)`
    );
  });
  await page.keyboard.press("ArrowDown");
  await page.waitForFunction(
    () =>
      document.activeElement?.getAttribute("data-testid") ===
      "channel-row-mute-toggle",
    undefined,
    { timeout: 4_000 }
  ).catch(async () => {
    throw new Error(
      `메뉴 안 ↓ 한 번 뒤 정거장 ${scheme}: ${await page.evaluate(
        `document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName`
      )} · 메뉴 ${await menu.count()} (channel-row-mute-toggle 여야 함)`
    );
  });
  const kbdMutePut = page.waitForRequest(isMutePut);
  await page.keyboard.press("Enter");
  const kbdMuteBody = (await kbdMutePut).postDataJSON();
  if (kbdMuteBody?.muted !== true) {
    throw new Error(
      `키보드로 실행한 알림 PUT ${scheme}: ${JSON.stringify(kbdMuteBody)} ({muted:true} 여야 함)`
    );
  }
  if ("memberId" in kbdMuteBody) {
    throw new Error("알림 몸통이 남을 지목했다 — 자기 것만 끌 수 있다");
  }
  await menu.waitFor({ state: "hidden" });

  // ③ 낱말은 서버가 기억한 값을 따른다. 다시 열어 뒤집혔는지 보고 되돌린다.
  await page.waitForFunction(
    (id) => {
      const target = document.querySelector(`[data-channel-id="${id}"]`);
      const box = target?.closest("[data-row-menu-trigger]");
      if (box?.getAttribute("data-state") !== "open") {
        target?.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, clientX: 40, clientY: 200 })
        );
      }
      const item = document.querySelector(
        '[data-testid="channel-row-mute-toggle"]'
      );
      return item?.getAttribute("data-muted") === "";
    },
    unreadChannelId,
    { timeout: 6_000 }
  ).catch(() => {
    throw new Error(
      `알림 낱말이 저장된 상태를 따라 뒤집히지 않았다 ${scheme}`
    );
  });
  // 되돌린다: 뒤따르는 장면이 음소거된 채널을 물려받지 않게.
  const unmutePut = page.waitForRequest(isMutePut);
  await page.getByTestId("channel-row-mute-toggle").click();
  await unmutePut;
  await menu.waitFor({ state: "hidden" });

  // ④ Esc 는 메뉴만 닫고 캐럿을 그 행으로 돌려준다.
  await row.focus();
  await page.keyboard.press("Shift+F10");
  await menu.waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await page.waitForFunction(
    (id) => document.activeElement?.getAttribute("data-channel-id") === id,
    unreadChannelId,
    { timeout: 4_000 }
  ).catch(() => {
    throw new Error(
      `행 메뉴 Esc 후 포커스가 그 행으로 돌아오지 않았다 ${scheme}`
    );
  });

  // ⑤ 열림 표식은 **활성 행에서도** 보여야 한다 (design-review #1937 N-4).
  //    지금 열려 있는 채널의 행은 불투명한 --accent-soft 를 입고 있어서 배경
  //    표식을 통째로 덮는다. 그때가 하필 키보드로 연 메뉴가 어느 행의 것인지
  //    말하는 유일한 표식이 필요한 순간이다.
  //    캡처는 인덱스(`#/`)에 서 있어서 어느 행도 활성이 아니다 — 그래서 이
  //    장면은 먼저 그 채널로 들어가 행을 실제로 활성으로 만든 뒤 잰다. 재고
  //    나서 인덱스로 돌아온다(뒤따르는 장면의 전제를 바꾸지 않는다).
  await page.evaluate((id) => {
    window.location.hash = `/c/${id}`;
  }, GENERAL_ID);
  const activeRow = page.locator(`[data-channel-id="${GENERAL_ID}"]`);
  await activeRow.waitFor({ state: "visible" });
  await page
    .waitForFunction(
      (id) =>
        document
          .querySelector(`[data-channel-id="${id}"]`)
          ?.getAttribute("aria-current") === "page",
      GENERAL_ID,
      { timeout: 4_000 }
    )
    .catch(() => {
      throw new Error(`활성 행을 만들지 못했다 ${scheme}`);
    });
  await activeRow.focus();
  await page.keyboard.press("Shift+F10");
  await menu.waitFor({ state: "visible" });
  // 전이가 끝난 뒤에 잰다: `transition-colors` 한가운데서 재면 방금 활성이 된
  // 행의 배경이 아직 투명하다.
  await page.waitForTimeout(400);
  const marker = await activeRow.evaluate((el) => {
    const box = el.closest("[data-row-menu-trigger]");
    const boxStyle = box ? getComputedStyle(box) : null;
    // WCAG 2.1 상대 휘도. 브라우저가 이미 `light-dark()` 를 이 스킴으로 풀어
    // 놓았으므로, 여기서 재는 것은 **화면에 실제로 선 두 색**이다.
    const channels = (color) =>
      (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color) => {
      const [r, g, b] = channels(color).map((v) => {
        const c = v / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const rowBackground = getComputedStyle(el).backgroundColor;
    const outlineColor = boxStyle?.outlineColor ?? "";
    const [hi, lo] = [luminance(outlineColor), luminance(rowBackground)].sort(
      (a, b) => b - a
    );
    return {
      state: box?.getAttribute("data-state") ?? null,
      outlineWidth: boxStyle ? parseFloat(boxStyle.outlineWidth) : 0,
      outlineStyle: boxStyle?.outlineStyle ?? "none",
      outlineColor,
      rowBackground,
      ariaCurrent: el.getAttribute("aria-current"),
      contrast: Number(((hi + 0.05) / (lo + 0.05)).toFixed(2)),
    };
  });
  if (
    marker.state !== "open" ||
    marker.outlineStyle === "none" ||
    !(marker.outlineWidth > 0)
  ) {
    throw new Error(
      `활성 행의 열림 표식 ${scheme}: ${JSON.stringify(marker)} (아웃라인이 서야 함)`
    );
  }
  if (/rgba\(0, 0, 0, 0\)|transparent/.test(marker.rowBackground)) {
    throw new Error(
      `활성 행이 활성으로 안 그려졌다 ${scheme}: ${JSON.stringify(marker)} — 이 장면이 재려던 겹침이 없다`
    );
  }
  //    아웃라인이 **있다**는 것만으로는 부족하다. 앞 회전의 표식은 있었고,
  //    다크에서 이 채움 위 2.90:1 이었다(design-review R2 M-1). 그러므로 이
  //    장면은 존재가 아니라 **대비**를 잰다 — 두 스킴 다.
  if (!(marker.contrast >= 3)) {
    throw new Error(
      `활성 행 위 열림 표식 대비 ${scheme}: ${JSON.stringify(marker)} (비텍스트 3:1 이상이어야 함)`
    );
  }
  const activeShot = `${OUT_DIR}/sidebar-row-menu-active-${scheme}.png`;
  await page.screenshot({ path: activeShot });
  shots.push(activeShot);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await page.evaluate(() => {
    window.location.hash = "/";
  });
  await page.waitForFunction(
    (id) =>
      document
        .querySelector(`[data-channel-id="${id}"]`)
        ?.getAttribute("aria-current") === null,
    GENERAL_ID,
    { timeout: 4_000 }
  );

  // ⑥ 오류 상태를 **실제로 일으켜** 그 자리에서 잰다 (design-review #1937
  //    N-3 · N-5). 알림 PUT 을 한 번 503 으로 돌려주면 메뉴 안에 배너가 선다.
  //      · N-3: 배너의 첫 글자가 항목의 첫 글자와 같은 왼쪽 자에 서는가.
  //             (실측 결함: 21px 대 13px — 배너의 `px-4` 와 메뉴 행의 `px-2`)
  //      · N-5: `role="alert"` 이 `role="menu"` 의 직계 자식이 아닌가.
  await page.route(
    "**/v1/workspaces/*/channels/*/notification-pref",
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "unavailable" } }),
      })
  );
  const quietRow = page.locator(`[data-channel-id="${CHANNELS[2].id}"]`);
  await quietRow.waitFor({ state: "visible" });
  await quietRow.click({ button: "right" });
  await menu.waitFor({ state: "visible" });
  await page.getByTestId("channel-row-mute-toggle").click();
  await page
    .getByTestId("channel-row-action-error")
    .waitFor({ state: "visible", timeout: 6_000 });
  const banner = await page.evaluate(`(() => {
    const textLeft = (node) => {
      if (!node) return null;
      const range = document.createRange();
      range.selectNodeContents(node);
      return Math.round(range.getBoundingClientRect().left);
    };
    const box = document.querySelector('[data-testid="channel-row-action-error"]');
    const item = document.querySelector('[data-testid="channel-row-mute-toggle"]');
    return {
      bannerRole: box?.getAttribute("role") ?? null,
      parentRole: box?.parentElement?.getAttribute("role") ?? null,
      grandParentRole: box?.parentElement?.parentElement?.getAttribute("role") ?? null,
      parentNamed: Boolean(box?.parentElement?.getAttribute("aria-label")),
      bannerTextLeft: textLeft(box?.querySelector("span")),
      itemTextLeft: textLeft(item),
      itemBusy: item?.getAttribute("aria-busy") ?? null,
      itemDisabled: item?.getAttribute("data-disabled") ?? null,
      text: (box?.textContent ?? "").trim(),
    };
  })()`);
  if (
    banner.bannerTextLeft === null ||
    banner.itemTextLeft === null ||
    Math.abs(banner.bannerTextLeft - banner.itemTextLeft) > 1
  ) {
    throw new Error(
      `메뉴 안 배너의 왼쪽 자 ${scheme}: ${JSON.stringify(banner)} (항목과 같아야 함)`
    );
  }
  if (
    banner.bannerRole !== "alert" ||
    banner.parentRole !== "group" ||
    banner.grandParentRole !== "menu" ||
    !banner.parentNamed
  ) {
    throw new Error(
      `메뉴 안 배너의 aria 구조 ${scheme}: ${JSON.stringify(banner)} (alert < group < menu, group 에 이름)`
    );
  }
  // 실패한 뒤에도 그 항목은 잠기지도 흐려지지도 않는다 (N-1).
  if (banner.itemDisabled !== null || banner.itemBusy !== null) {
    throw new Error(
      `실패 뒤 항목 상태 ${scheme}: ${JSON.stringify(banner)} (잠금·진행 표시가 남으면 안 된다)`
    );
  }
  const errorShot = `${OUT_DIR}/sidebar-row-menu-error-${scheme}.png`;
  await page.screenshot({ path: errorShot });
  shots.push(errorShot);
  await page.keyboard.press("Escape");
  await menu.waitFor({ state: "detached" });
  await page.unroute("**/v1/workspaces/*/channels/*/notification-pref");

  await page.getByTestId("composer-input").hover();
}

/**
 * UX-D4 (#1756): 새 진입점을 실제로 누른다. 스크린샷만 찍고 클릭하지 않으면
 * 카드·상태 PUT·접기가 죽은 컨트롤이어도 캡처는 초록이다.
 */
async function captureSidebarD4(page, scheme, shots) {
  await assertSectionActionsAtRest(page, scheme, "첫 줄");

  await captureSidebarRowMenu(page, scheme, shots);
  await assertSectionActionsAtRest(page, scheme, "행 메뉴 왕복 후");

  const restHeader = await page
    .getByTestId("sidebar-section-channels-header")
    .evaluate((el) => Math.round(el.getBoundingClientRect().height));

  // B-1 red proof: 순수 키보드 왕복. hover 없이 Tab 으로 + 에 닿고, 연 뒤
  // Esc 하면 포커스가 + 로 돌아와야 한다. BODY 추락은 회귀.
  await page.getByTestId("nav-search").focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Tab");
  const plusStop = await page.evaluate(
    `document.activeElement?.getAttribute("data-testid")`
  );
  if (plusStop !== "new-channel") {
    throw new Error(
      `채널 + 키보드 정거장 ${scheme}: ${plusStop} (new-channel 이어야 함)`
    );
  }
  await page.keyboard.press("Enter");
  await page.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  const plusWhileOpen = await page.getByTestId("new-channel").count();
  if (plusWhileOpen !== 1) {
    throw new Error(
      `다이얼로그가 떠 있는데 + 가 언마운트됐다 ${scheme}: ${plusWhileOpen}`
    );
  }
  const dmWhileHeaderDialog = await page.getByTestId("new-dm").count();
  if (dmWhileHeaderDialog !== 0) {
    throw new Error(
      `채널 만들기(헤더) 중 DM 액션이 고정됐다 ${scheme}: ${dmWhileHeaderDialog}`
    );
  }
  await page.keyboard.press("Escape");
  await page.getByTestId("create-channel-dialog").waitFor({ state: "detached" });
  const plusAfterEsc = await page.evaluate(`(() => ({
    active: document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName,
    plus: document.querySelectorAll('[data-testid="new-channel"]').length,
  }))()`);
  if (plusAfterEsc.active !== "new-channel") {
    throw new Error(
      `채널 만들기 Esc 후 포커스 ${scheme}: ${plusAfterEsc.active} (new-channel, BODY 금지), + DOM ${plusAfterEsc.plus}`
    );
  }
  await assertSectionActionsAtRest(page, scheme, "헤더 경유 왕복 후");

  // R2-1: ⌘K 팔레트는 헤더를 거치지 않는다. 닫힌 뒤 hold 가 헤더 blur 를
  // 기다리면 +·DM 이 세션 내내 rest 에 남는다.
  await page.getByTestId("open-quick-switcher").click();
  await page.getByTestId("quick-switcher").waitFor({ state: "visible" });
  await page.getByTestId("switcher-create-channel").click();
  await page.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  const dmWhileCmdkDialog = await page.getByTestId("new-dm").count();
  if (dmWhileCmdkDialog !== 0) {
    throw new Error(
      `채널 만들기(⌘K) 중 DM 액션이 고정됐다 ${scheme}: ${dmWhileCmdkDialog}`
    );
  }
  await page.keyboard.press("Escape");
  await page.getByTestId("create-channel-dialog").waitFor({ state: "detached" });
  await assertSectionActionsAtRest(page, scheme, "⌘K 왕복 후");

  await page.getByTestId("profile-card").click();
  const menu = page.getByTestId("profile-card-menu");
  await menu.waitFor({ state: "visible" });
  await assertProfileMenuFitsViewport(page, `sidebar profile ${scheme}`);
  const anchor = await page.evaluate(`(() => {
    const trigger = document.querySelector('[data-testid="profile-card"]');
    const panel = document.querySelector('[data-testid="profile-card-menu"]');
    if (!trigger || !panel) return null;
    const t = trigger.getBoundingClientRect();
    const p = panel.getBoundingClientRect();
    return {
      triggerBottom: Math.round(t.bottom),
      panelTop: Math.round(p.top),
      overlapX: Math.max(0, Math.min(t.right, p.right) - Math.max(t.left, p.left)),
    };
  })()`);
  if (!anchor || anchor.overlapX < 8) {
    throw new Error(
      `프로필 카드가 트리거에 앵커되지 않았다 ${scheme}: ${JSON.stringify(anchor)}`
    );
  }
  if (anchor.panelTop < 0) {
    throw new Error(
      `프로필 카드가 뷰포트 위로 새었다 ${scheme}: ${JSON.stringify(anchor)}`
    );
  }
  const profileShot = `${OUT_DIR}/sidebar-profile-card-${scheme}.png`;
  await page.screenshot({ path: profileShot });
  shots.push(profileShot);

  const putAway = page.waitForRequest(isPresencePut);
  await page.getByTestId("presence-option-away").click();
  const awayReq = await putAway;
  const awayBody = awayReq.postDataJSON();
  if (awayBody?.status !== "away") {
    throw new Error(
      `상태 PUT 이 away 가 아니다 ${scheme}: ${JSON.stringify(awayBody)}`
    );
  }
  await menu.waitFor({ state: "hidden" });
  const effective = await page
    .getByTestId("presence-control")
    .getAttribute("data-effective");
  if (effective !== "away") {
    throw new Error(`배지가 away 로 안 바뀌었다 ${scheme}: ${effective}`);
  }

  await page.getByTestId("profile-card").press("Enter");
  await menu.waitFor({ state: "visible" });
  const putAuto = page.waitForRequest(isPresencePut);
  await page.getByTestId("presence-option-auto").click();
  await putAuto;
  await menu.waitFor({ state: "hidden" });

  // H-2: 카드가 연 워크스페이스 추가를 취소하면 트리거(프로필 카드)로 복귀.
  await page.getByTestId("profile-card").click();
  await menu.waitFor({ state: "visible" });
  await page.getByTestId("profile-add-workspace").click();
  await page.getByTestId("add-workspace-dialog").waitFor({ state: "visible" });
  await page.getByTestId("add-workspace-name").waitFor({ state: "visible" });
  // Esc first (review probe). If a leftover layer ate the key, the visible
  // 취소 button is the same close path and still proves restore.
  await page.getByTestId("add-workspace-name").focus();
  await page.keyboard.press("Escape");
  if (await page.getByTestId("add-workspace-dialog").count()) {
    await page.getByTestId("add-workspace-cancel").click();
  }
  await page.getByTestId("add-workspace-dialog").waitFor({ state: "detached" });
  await page.waitForFunction(
    `document.activeElement?.getAttribute("data-testid") === "profile-card"`
  );
  const afterAddWorkspace = await page.evaluate(
    `document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName`
  );
  if (afterAddWorkspace !== "profile-card") {
    throw new Error(
      `워크스페이스 추가 취소 후 포커스 ${scheme}: ${afterAddWorkspace} (profile-card, BODY 금지)`
    );
  }

  const header = page.getByTestId("sidebar-section-channels-header");
  await header.hover();
  await page.getByTestId("new-channel").waitFor({ state: "visible" });
  const hoverHeader = await header.evaluate((el) =>
    Math.round(el.getBoundingClientRect().height)
  );
  if (restHeader !== hoverHeader) {
    throw new Error(
      `섹션 헤더 높이가 rest ${restHeader} → hover ${hoverHeader} 로 자랐다 ${scheme}`
    );
  }
  const hoverShot = `${OUT_DIR}/sidebar-section-hover-${scheme}.png`;
  await page.screenshot({ path: hoverShot });
  shots.push(hoverShot);

  await page.getByTestId("section-collapse-channels").press("Enter");
  await page
    .getByTestId("sidebar-section-channels")
    .locator('[data-testid="channel-item"]')
    .first()
    .waitFor({ state: "detached" });
  const sectionCollapsed = await page
    .getByTestId("sidebar-section-channels")
    .getAttribute("data-collapsed");
  if (sectionCollapsed === null) {
    throw new Error(`채널 섹션이 접히지 않았다 ${scheme}`);
  }
  const collapsedUnread = await page.getByTestId("section-unread-channels");
  await collapsedUnread.waitFor({ state: "visible" });
  const unreadText = (await collapsedUnread.innerText()).trim();
  if (!/^\d+$/.test(unreadText) || Number(unreadText) < 1) {
    throw new Error(
      `접힌 채널 섹션에 언리드 배지가 없다 ${scheme}: ${unreadText}`
    );
  }
  const sectionShot = `${OUT_DIR}/sidebar-section-collapsed-${scheme}.png`;
  await page.screenshot({ path: sectionShot });
  shots.push(sectionShot);
  await page.getByTestId("section-collapse-channels").press("Enter");
  await page.getByTestId("channel-item").first().waitFor({ state: "visible" });

  await captureCustomSection(page, scheme, shots);

  await page.getByTestId("sidebar-toggle").click();
  await page.waitForFunction(
    () =>
      document.querySelector(".app-shell")?.hasAttribute("data-sidebar-collapsed") &&
      document.querySelector('[data-testid="sidebar-channel-pane"]')?.hasAttribute("hidden")
  );
  await assertNoHorizontalOverflow(page, `sidebar collapsed ${scheme}`);
  const collapsedShot = `${OUT_DIR}/sidebar-collapsed-${scheme}.png`;
  await page.screenshot({ path: collapsedShot });
  shots.push(collapsedShot);
  await page.getByTestId("sidebar-toggle").click();
  await page.waitForFunction(
    () =>
      !document.querySelector(".app-shell")?.hasAttribute("data-sidebar-collapsed") &&
      !document.querySelector('[data-testid="sidebar-channel-pane"]')?.hasAttribute("hidden")
  );
  await page.getByTestId("composer-input").hover();
}

/**
 * 섹션 편집 컨트롤 하나의 크기 (design-review #1932 N-3).
 *
 * 리뷰는 이 둘(`new-section` · `section-menu-*`)을 `MOBILE_TAP_TARGETS` 에
 * 올리라고 했다. 그런데 H-1 을 닫으면서 그 둘은 **터치 표면에 존재하지 않게**
 * 됐다 - 배치를 줄 수 없는 표면에는 섹션 편집 문도 내밀지 않는다. 없는 것을 폰
 * 허용목록에 `optional` 로 올리면 언제나 건너뛰는 항목이 되고, 그것은 재는 척하는
 * 목록이다(§5.5② 「허용목록 밖은 재지 않는다」의 반대 실패).
 *
 * 그래서 **사는 자리에서** 잰다: 포인터 표면의 하우스 아이콘 버튼 규격
 * `size-control-sm`(28px), 바로 옆 `new-channel` 이 쓰는 그 수다. 각 컨트롤은
 * 자기 헤더가 호버돼 있을 때만 마운트되므로 한 번에 하나씩 부른다.
 */
async function assertSectionControlSize(page, scheme, testId) {
  const controlSm = pixelToken("spacing-control-sm");
  const box = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="${testId}"]');
    if (!el) return { missing: true };
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), height: Math.round(r.height) };
  })()`);
  if (box.missing || box.height < controlSm || box.width < controlSm) {
    throw new Error(
      `섹션 편집 컨트롤 ${scheme}: ${testId} ${JSON.stringify(box)} (최소 ${controlSm}px)`
    );
  }
  console.log(
    `  섹션 편집 컨트롤 ${scheme}: ${testId} ${box.width}x${box.height}`
  );
}

/**
 * 커스텀 섹션 한 바퀴 (ADR-0177 D4 / BT-4 #1932).
 *
 * 픽스처를 심지 않고 **UI 로 만든다**: 「새 섹션」 → 이름 → 행 우클릭의
 * 「섹션으로 이동」 → 삭제. 그래야 이 프레임들이 사람이 실제로 걷는 길의 사진이
 * 되고, 끝에 지우므로 뒤따르는 장면들의 사이드바가 그대로 남는다.
 *
 * 이름은 긴 한글이다. 80자 상한이 있는 자리이고, 좁은 사이드바에서 잘림이
 * 작동하지 않으면 여기서 가로 넘침으로 드러난다.
 */
async function captureCustomSection(page, scheme, shots) {
  // 80자 — ADR-0177 D3 의 상한 그 자리다. 짧은 이름은 잘림도 메뉴 폭도 재지
  // 못하므로, 픽스처가 규칙을 가리지 않게 상한에 붙여 둔다.
  const LONG_NAME = "출시 준비와 회고 그리고 후속 작업 묶음 ".repeat(4).slice(0, 80);

  await page.getByTestId("sidebar-section-channels-header").hover();
  await page.getByTestId("new-section").waitFor({ state: "visible" });
  await assertSectionControlSize(page, scheme, "new-section");
  await page.getByTestId("new-section").click();
  const dialog = page.getByTestId("sidebar-section-name-dialog");
  await dialog.waitFor({ state: "visible" });
  await page.getByTestId("sidebar-section-name-input").fill(LONG_NAME);
  const createShot = `${OUT_DIR}/sidebar-section-create-${scheme}.png`;
  await waitForAnimations(page);
  await page.screenshot({ path: createShot });
  shots.push(createShot);
  await page.getByTestId("sidebar-section-name-submit").click();
  await dialog.waitFor({ state: "detached" });

  const section = page.getByTestId("sidebar-section-sec-1");
  await section.waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, `custom section ${scheme}`);

  // 방금 만든 섹션은 비어 있고, 비어 있다고 말한다.
  const emptyRows = await section
    .locator('[data-testid="channel-item"]')
    .count();
  if (emptyRows !== 0) {
    throw new Error(`새 섹션이 비어 있지 않다 ${scheme}: ${emptyRows}`);
  }

  // 행 우클릭 → 「섹션으로 이동」. 서브메뉴가 아니라 제목 + 라디오 무리다.
  const row = page
    .getByTestId("sidebar-section-channels")
    .locator('[data-testid="channel-item"]')
    .first();
  await row.click({ button: "right" });
  await page.getByTestId("channel-row-menu").waitFor({ state: "visible" });
  await page
    .getByTestId("channel-row-move-to-section")
    .waitFor({ state: "visible" });
  const radios = await page
    .getByTestId("channel-row-menu")
    .locator('[role="menuitemradio"]')
    .count();
  if (radios !== 2) {
    throw new Error(
      `섹션 라디오 개수 ${scheme}: ${radios} (기본 + 커스텀 = 2 이어야 함)`
    );
  }
  const baseChecked = await page
    .getByTestId("channel-row-section-base")
    .getAttribute("aria-checked");
  if (baseChecked !== "true") {
    throw new Error(
      `배치 전 기본 섹션이 체크가 아니다 ${scheme}: ${baseChecked}`
    );
  }
  // 80자 이름이 메뉴를 창 밖으로 밀지 않는다.
  const menuBox = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="channel-row-menu"]');
    const r = el.getBoundingClientRect();
    return { right: Math.round(r.right), width: Math.round(r.width), view: window.innerWidth };
  })()`);
  if (menuBox.right > menuBox.view) {
    throw new Error(
      `행 메뉴가 창을 넘었다 ${scheme}: right=${menuBox.right} view=${menuBox.view} width=${menuBox.width}`
    );
  }
  const menuShot = `${OUT_DIR}/sidebar-section-move-menu-${scheme}.png`;
  await waitForAnimations(page);
  await page.screenshot({ path: menuShot });
  shots.push(menuShot);

  await page.getByTestId("channel-row-section-sec-1").click();
  await page.getByTestId("channel-row-menu").waitFor({ state: "detached" });
  // 다시 열면 지금 자리가 체크로 서 있다 — 귀(aria-checked)와 눈(체크)이 같은
  // 사실을 말하는지 여기서 함께 본다.
  //
  // **옮긴 그 행**을 다시 열어야 한다. `row` 는 「채널 섹션의 첫 행」이라 옮기고
  // 나면 다른 채널을 가리킨다 — 그 행의 답은 당연히 「기본 섹션」이다.
  await section.locator('[data-testid="channel-item"]').first().click({
    button: "right",
  });
  await page.getByTestId("channel-row-menu").waitFor({ state: "visible" });
  const nowChecked = await page
    .getByTestId("channel-row-section-sec-1")
    .getAttribute("aria-checked");
  const checkGlyphs = await page
    .getByTestId("channel-row-section-sec-1")
    .locator("svg")
    .count();
  if (nowChecked !== "true" || checkGlyphs !== 1) {
    throw new Error(
      `배치 뒤 체크 ${scheme}: aria-checked=${nowChecked} 체크표시=${checkGlyphs}`
    );
  }
  await page.keyboard.press("Escape");
  await page.getByTestId("channel-row-menu").waitFor({ state: "detached" });
  await section
    .locator('[data-testid="channel-item"]')
    .first()
    .waitFor({ state: "visible" });
  await page.getByTestId("sidebar-section-sec-1-header").hover();
  await page.getByTestId("section-menu-sec-1").waitFor({ state: "visible" });

  await assertSectionControlSize(page, scheme, "section-menu-sec-1");
  await assertNoHorizontalOverflow(page, `custom section filled ${scheme}`);
  const filledShot = `${OUT_DIR}/sidebar-custom-section-${scheme}.png`;
  await page.screenshot({ path: filledShot });
  shots.push(filledShot);

  await captureSortDoor(page, scheme, shots);
  await captureSectionDropMarker(page, scheme, shots);
  await captureStarredSection(page, scheme, shots);

  // 지우고 나간다. 확인 문장이 「채널은 사라지지 않는다」를 말하는지도 여기서 본다.
  // 위 두 장면이 포인터를 다른 자리로 옮겼으므로 호버 클러스터를 다시 연다 -
  // ⋮ 는 rest 에서 DOM 에 없다(UX-HT 계약).
  await page.getByTestId("sidebar-section-sec-1-header").hover();
  await page.getByTestId("section-menu-sec-1").waitFor({ state: "visible" });
  await page.getByTestId("section-menu-sec-1").click();
  await page.getByTestId("section-menu-sec-1-delete").click();
  const confirm = page.getByTestId("sidebar-section-delete-confirm");
  await confirm.waitFor({ state: "visible" });
  // design-review #1932 M-1 — 제목은 고정 문장이고 이름은 본문이 진다. 80자
  // 이름이 제목에 들어가면 물음이 셋째 줄 끝에 도착한다.
  const confirmCopy = await page.evaluate(`(() => {
    const box = document.querySelector('[data-testid="sidebar-section-delete-confirm"]');
    const title = box.querySelector("h2, [id$='-title']") ?? box.firstElementChild.firstElementChild;
    return {
      title: (title.textContent ?? "").trim(),
      body: (box.textContent ?? "").trim(),
    };
  })()`);
  if (confirmCopy.title.includes(LONG_NAME.slice(0, 12))) {
    throw new Error(
      `삭제 확인 제목이 섹션 이름을 담았다 ${scheme}: ${confirmCopy.title}`
    );
  }
  if (!confirmCopy.body.includes(LONG_NAME)) {
    throw new Error(`삭제 확인 본문에 섹션 이름이 없다 ${scheme}`);
  }
  const deleteShot = `${OUT_DIR}/sidebar-section-delete-${scheme}.png`;
  await waitForAnimations(page);
  await page.screenshot({ path: deleteShot });
  shots.push(deleteShot);
  await page.getByTestId("sidebar-section-delete-action").click();
  await confirm.waitFor({ state: "detached" });
  await section.waitFor({ state: "detached" });
  // 채널은 돌아왔다 — 섹션을 지우는 것은 채널을 지우는 것이 아니다.
  await page
    .getByTestId("sidebar-section-channels")
    .locator('[data-testid="channel-item"]')
    .first()
    .waitFor({ state: "visible" });
}

/**
 * 정렬의 문 (BT-5 / #1933, design-review R1 M-2).
 *
 * 이 문은 한동안 기본 「채널」 섹션의 ⋮ 안에 있었고, 그때 스크린리더는 그것을
 * 「채널 섹션 메뉴」라 읽었다 — 사이드바 전체에 걸리는 설정인데. 눈으로도 같은 ⋯
 * 글리프가 섹션마다 다른 메뉴를 열었다. 그래서 문을 갈랐고, 이 장면이 그 판정을
 * 레인 안으로 들여 잠근다: **자기 글리프·자기 이름**이고, 섹션 ⋮ 는 그 자리에
 * 없다.
 */
async function captureSortDoor(page, scheme, shots) {
  await page.getByTestId("sidebar-section-channels-header").hover();
  const door = page.getByTestId("sidebar-sort-menu");
  await door.waitFor({ state: "visible" });
  await assertSectionControlSize(page, scheme, "sidebar-sort-menu");
  const name = await door.getAttribute("aria-label");
  if (name !== "채널 정렬") {
    throw new Error(`정렬 문의 이름 ${scheme}: ${name}`);
  }
  // 기본 섹션에는 ⋮ 가 없다 — 그 메뉴는 커스텀 섹션의 것이다(BT-4 그대로).
  const sectionMenu = await page.getByTestId("section-menu-channels").count();
  if (sectionMenu !== 0) {
    throw new Error(`기본 섹션에 ⋮ 가 섰다 ${scheme}: ${sectionMenu}`);
  }

  await door.click();
  const content = page.getByTestId("sidebar-sort-menu-content");
  await content.waitFor({ state: "visible" });
  const label = (await page.getByTestId("sidebar-sort-label").innerText()).trim();
  if (label !== "채널 정렬") {
    throw new Error(`정렬 무리의 제목 ${scheme}: ${label}`);
  }
  const checked = await page
    .getByTestId("sidebar-sort-manual")
    .getAttribute("aria-checked");
  if (checked !== "true") {
    throw new Error(`기본 정렬이 체크가 아니다 ${scheme}: ${checked}`);
  }
  await assertNoHorizontalOverflow(page, `sort door ${scheme}`);
  const shot = `${OUT_DIR}/sidebar-sort-menu-${scheme}.png`;
  await page.screenshot({ path: shot });
  shots.push(shot);
  await page.keyboard.press("Escape");
  await content.waitFor({ state: "detached" });
}

/**
 * 드래그 중의 드롭 표지 (BT-5 / #1933).
 *
 * 네이티브 HTML5 드래그는 Playwright 의 마우스로 발화하지 않는다(브라우저가 OS
 * 드래그 세션을 열어야 한다). 그래서 **드래그 이벤트를 그대로 쏜다** — 출하되는
 * 코드가 듣는 것이 바로 그 이벤트이므로, 사진에 찍히는 것은 실제로 사람이 보게
 * 되는 프레임이다. 좌표를 흉내 내는 것이 아니라 판정의 정본(대상 요소)을 그대로
 * 쓰는 것이고, 그 점이 이 티켓이 라이브러리 없는 손구현을 고른 값이다
 * (`sidebarDnd.ts` 머리말).
 *
 * 표지가 **토큰만** 쓰는지는 여기서 눈으로, `tokens.contrast.test.ts` 의
 * 「드롭 표지」가 수로 잰다.
 */
async function captureSectionDropMarker(page, scheme, shots) {
  await page.evaluate(`(() => {
    const row = document.querySelector(
      '[data-testid="sidebar-section-channels"] [data-testid="channel-item"]'
    );
    if (!row) throw new Error("기본 섹션에 끌 행이 없다");
    row.dispatchEvent(new DragEvent("dragstart", { bubbles: true, cancelable: true }));
  })()`);
  // `dragover` 는 **되풀이해서** 쏜다 — 실제 드래그가 그렇게 생겼기 때문이다
  // (포인터가 움직이는 동안 계속 발화한다). 한 번만 쏘면 `dragstart` 의 상태
  // 갱신이 아직 렌더에 닿기 전이라 그 한 번이 헛나갈 수 있고, 그것은 이 화면의
  // 결함이 아니라 이벤트를 한 틱에 몰아 쏜 자국이다.
  await page.waitForFunction(`(() => {
    const target = document.querySelector('[data-testid="sidebar-section-sec-1"]');
    if (!target) return false;
    target.dispatchEvent(new DragEvent("dragover", { bubbles: true, cancelable: true }));
    return target.hasAttribute("data-drop-target");
  })()`);
  // 표지는 **하나**다: 받는 자리 하나가 「여기에 놓인다」고 말한다.
  const marked = await page.locator("[data-drop-target]").count();
  if (marked !== 1) {
    throw new Error(`드롭 표지 개수 ${scheme}: ${marked} (하나여야 함)`);
  }
  await assertNoHorizontalOverflow(page, `drop marker ${scheme}`);
  const shot = `${OUT_DIR}/sidebar-drop-target-${scheme}.png`;
  await page.screenshot({ path: shot });
  shots.push(shot);

  // Esc 가 드래그의 것이다(BT-5 계약 3항). 표지가 사라지는 것으로 그것을 본다.
  await page.keyboard.press("Escape");
  await page.locator("[data-drop-target]").waitFor({ state: "detached" });
}

/**
 * 별표 섹션 (ADR-0177 D5 / BT-5 #1933).
 *
 * 픽스처를 심지 않고 **UI 로 만든다**: 행 우클릭 → 「별표 붙이기」. 그래야 이
 * 프레임이 사람이 걷는 길의 사진이 되고, 끝에 떼므로 뒤따르는 장면의 사이드바가
 * 그대로 남는다(같은 함수의 섹션 만들기·지우기와 같은 규율).
 */
async function captureStarredSection(page, scheme, shots) {
  const base = page
    .getByTestId("sidebar-section-channels")
    .locator('[data-testid="channel-item"]')
    .first();
  await base.click({ button: "right" });
  await page.getByTestId("channel-row-menu").waitFor({ state: "visible" });
  const starLabel = (await page.getByTestId("channel-row-star").innerText()).trim();
  if (starLabel !== "별표 붙이기") {
    throw new Error(`별표 항목의 낱말 ${scheme}: ${starLabel}`);
  }
  await page.getByTestId("channel-row-star").click();
  await page.getByTestId("channel-row-menu").waitFor({ state: "detached" });

  const starred = page.getByTestId("sidebar-section-starred");
  await starred.waitFor({ state: "visible" });
  // **맨 위**다. 파생 섹션의 순위는 코어가 정하고, 그 사실이 화면에서도 참인지를
  // 여기서 본다.
  const first = await page.evaluate(`(() => {
    const sections = Array.from(
      document.querySelectorAll('[data-testid^="sidebar-section-"]')
    ).filter((el) => !el.dataset.testid.endsWith("-header"));
    return sections[0]?.dataset.testid ?? null;
  })()`);
  if (first !== "sidebar-section-starred") {
    throw new Error(`별표 섹션이 맨 위가 아니다 ${scheme}: ${first}`);
  }
  // 한 채널이 두 번 그려지지 않는다 — 별표가 렌더 순위를 먼저 가져간다.
  const duplicated = await page.evaluate(`(() => {
    const ids = Array.from(
      document.querySelectorAll("[data-channel-id]")
    ).map((el) => el.dataset.channelId);
    return ids.length - new Set(ids).size;
  })()`);
  if (duplicated !== 0) {
    throw new Error(`별표 뒤 중복 행 ${scheme}: ${duplicated}`);
  }
  await assertNoHorizontalOverflow(page, `starred section ${scheme}`);
  const shot = `${OUT_DIR}/sidebar-starred-section-${scheme}.png`;
  await page.screenshot({ path: shot });
  shots.push(shot);

  // 떼고 나간다. 낱말이 상태라는 것도 여기서 함께 본다.
  const starredRow = starred.locator('[data-testid="channel-item"]').first();
  await starredRow.click({ button: "right" });
  await page.getByTestId("channel-row-menu").waitFor({ state: "visible" });
  const unstarLabel = (await page.getByTestId("channel-row-star").innerText()).trim();
  if (unstarLabel !== "별표 떼기") {
    throw new Error(`별표 뒤 항목의 낱말 ${scheme}: ${unstarLabel}`);
  }
  await page.getByTestId("channel-row-star").click();
  await starred.waitFor({ state: "detached" });
}

/**
 * 배치를 **한 번도 못 읽었을 때** (design-review #1932 B-1).
 *
 * 리뷰의 손 프로브가 잡은 그 자리를 캡처 레인 안으로 들여 회귀로 잠근다: GET 이
 * 500 이면 예전 화면은 「섹션이 아직 없다」와 똑같이 생겼고, 그 위의 편집 하나가
 * 서버의 배치를 통째로 지웠다(PUT 은 패치가 아니다).
 *
 * 자기 페이지에서 돈다 - 메인 페이지의 라우트를 갈아 끼우고 되돌리는 대신
 * `context.newPage()` 로 이 표면만 다르게 세운다(3a-3 빈 워크스페이스와 같은 결).
 * PUT 은 세어서 **0** 임을 단정한다: 문이 닫혔다는 것보다 강한 사실은 「아무것도
 * 나가지 않았다」이고, 소실은 나간 PUT 이 만든다.
 */
async function captureSidebarPrefsUnavailable(context, scheme, shots) {
  const page = await context.newPage();
  let puts = 0;
  await page.route("**/v1/workspaces/*/members/me/sidebar-prefs", (route) => {
    if (route.request().method() === "PUT") {
      puts += 1;
      return route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
    }
    return route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "boom" } }),
    });
  });
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);
  await page.getByTestId("channel-list").waitFor({ state: "visible" });

  const banner = page.getByTestId("sidebar-prefs-load-error");
  await banner.waitFor({ state: "visible" });

  // 편집 문은 서지 않는다. 헤더를 호버해도(= 호버 클러스터를 열어도) 없다.
  await page.getByTestId("sidebar-section-channels-header").hover();
  await page.getByTestId("new-channel").waitFor({ state: "visible" });
  const doors = await page.getByTestId("new-section").count();
  if (doors !== 0) {
    throw new Error(
      `배치를 못 읽은 상태에서 「새 섹션」이 서 있다 ${scheme}: ${doors}개`
    );
  }

  const shot = `${OUT_DIR}/sidebar-prefs-unavailable-${scheme}.png`;
  await page.screenshot({ path: shot });
  shots.push(shot);

  // 재시도 문은 있다: 닫힌 이유를 말했으면 되돌아갈 길도 줘야 한다.
  const retry = banner.getByRole("button", { name: "다시 시도" });
  await retry.waitFor({ state: "visible" });
  await retry.click();
  await banner.waitFor({ state: "visible" });

  if (puts !== 0) {
    throw new Error(
      `배치를 못 읽은 상태에서 PUT 이 나갔다 ${scheme}: ${puts}건 (서버 배치가 지워진다)`
    );
  }
  await page.close();
}

/**
 * 가로로 새는 것이 있는가 (goal B6, goal B9에서 확대).
 *
 * B6은 **문서 하나만** 쟀고, 그 단언은 이 셸에서 구조적으로 아무것도 잡을 수 없다:
 * `app-shell`이 `overflow: clip`이라 셸 안의 어떤 것도 문서 폭을 넓히지 못하므로
 * `document.scrollWidth`는 언제나 화면 폭이다. 넘친 것이 있어도 그것은 **셸 안의
 * 스크롤 상자** 안에서 넘친다 — react-virtuoso의 스크롤러는 `overflow-y: auto`이고,
 * 한 축만 지정된 상자는 나머지 축이 `auto`로 계산되므로(CSS Overflow §3) 넘친 한
 * 줄이 타임라인을 좌우로 끌 수 있게 만든다. 실측: 긴 무공백 토큰 아래에서 타임라인
 * 스크롤러가 +781px일 때에도 문서는 0을 답했다. 화면에서 그것은 왼쪽 아바타와 여백이
 * 밀려 나간 모습으로 보이고, 성재 실캡처가 보여준 것이 그 모양이다.
 *
 * 그래서 이제 재는 것은 문서 + **모든 가로 스크롤 상자**다. 대상은 계산된
 * `overflow-x`가 `auto`/`scroll`인 상자 전부이고, 판정은 하나다: 가로로 끌 수 있으면
 * 실패. 세로로만 스크롤할 표면이 가로로도 끌린다는 것은 언제나 새는 것이 있다는 뜻이다.
 *
 * `hidden`/`clip` 상자는 세지 않는다. 그 상자들은 자르는 것이 일이고(닫힌 서랍이
 * `translateX(-100%)`로 밖에 서 있는 것이 그 예다), 잘린 것은 사람이 끌어서 볼 수도
 * 없으므로 이 단언이 말하는 결함과 성질이 다르다.
 *
 * **`data-scroll-x` 상자도 세지 않는다 (goal B11).** 이 단언이 잡으려는 것은
 * "세로로만 스크롤할 표면"이 가로로 끌리는 것이다. 그런데 어떤 상자는 가로로
 * 끌리는 것이 **일**이다 — 코드 블록이 그것이고, 넓은 내용은 자기 `overflow-x:
 * auto` 상자 안에서 스크롤해야 한다는 것이 이 앱의 규칙이다. 코드를 접으면 정렬이
 * 깨지므로 대안도 없다.
 *
 * B11 전까지 이 false positive가 나지 않은 것은 코드 블록이 든 행이 폰 프레임의
 * 렌더 창 밖에 있었기 때문이다 — 규칙이 맞아서가 아니라 운이었고, 반응 칩이
 * 레이아웃을 한 행 밀자 바로 드러났다. 실사용에서는 코드 블록이 화면에 있는 매
 * 순간 걸렸을 것이다.
 *
 * 면제는 게이트가 아니라 **컴포넌트가 선언**한다: 가로 스크롤이 자기 일인 상자만
 * `data-scroll-x`를 달고, 그 속성이 코드 리뷰에서 보인다. 게이트에 이름을 박아
 * 두면 다음 상자는 조용히 새거나 조용히 면제된다.
 */
async function assertNoHorizontalOverflow(page, where) {
  const measure = await page.evaluate(`(() => {
    const doc = document.scrollingElement || document.documentElement;
    const describe = (el) => {
      const id = el.getAttribute("data-testid");
      if (id) return '[data-testid=' + id + ']';
      const cls = (el.getAttribute("class") || "").trim().split(/\\s+/).filter(Boolean);
      return el.tagName.toLowerCase() + (cls.length ? "." + cls.slice(0, 3).join(".") : "");
    };
    const leaks = [];
    for (const el of document.querySelectorAll("*")) {
      const overflowX = getComputedStyle(el).overflowX;
      if (overflowX !== "auto" && overflowX !== "scroll") continue;
      // 가로로 끌리는 것이 이 상자의 일이다 (goal B11) — 위 주석 참조.
      if (el.hasAttribute("data-scroll-x")) continue;
      if (el.closest("[hidden]")) continue;
      const over = el.scrollWidth - el.clientWidth;
      if (over <= 0) continue;
      // 상자 이름만으로는 고칠 자리를 못 찾는다: 타임라인이 끌린다는 것은
      // 타임라인의 결함이 아니라 그 안의 어떤 상자가 접히지 않았다는 뜻이다.
      // 실패 메시지가 그 상자를 지목해야 게이트가 진단이 된다.
      const edge = el.getBoundingClientRect().left + el.clientWidth;
      let worst = null;
      for (const child of el.querySelectorAll("*")) {
        const past = Math.round(child.getBoundingClientRect().right - edge);
        if (past > 0 && (worst === null || past > worst.past)) {
          worst = { past, where: describe(child) };
        }
      }
      leaks.push({
        where: describe(el),
        over,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        worst,
      });
    }
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      leaks,
    };
  })()`);
  if (measure.overflowX > 0) {
    throw new Error(
      `가로 오버플로 ${where}: 문서가 ${measure.scrollWidth}px인데 화면은 ${measure.clientWidth}px다`
    );
  }
  if (measure.leaks.length > 0) {
    const lines = measure.leaks
      .map(
        (l) =>
          `    ${l.where}: ${l.scrollWidth}px 내용 / ${l.clientWidth}px 상자 (+${l.over})` +
          (l.worst ? `\n      밀어낸 것: ${l.worst.where} (+${l.worst.past}px)` : "")
      )
      .join("\n");
    throw new Error(
      `가로 오버플로 ${where}: 세로 스크롤 상자 ${measure.leaks.length}개가 가로로도 끌린다\n${lines}`
    );
  }
  console.log(
    `  overflow-x ${where}: 0 (문서 ${measure.clientWidth}px = ${measure.scrollWidth}px, 스크롤 상자 누수 0)`
  );
}

// 긴 무공백 토큰 스트레스 (goal B9).
//
// 픽스처에 긴 토큰을 심는 것만으로는 부족하다는 것이 이 배치의 실측에서 드러났다:
// 메시지 본문·채널 이름·에이전트 핸들·승인 카드 값에 각각 실제 길이의 무공백 토큰을
// 넣어 재보니 전부 통과했다(본문은 `min-w-0` + `break-words`가 잡고, 이름 계열은
// `truncate`가 잡는다). 그런데도 실기기에서는 가로로 밀렸다. 픽스처가 짧은 것이 아니라
// **어느 자리가 약한지 우리가 모른다**는 것이 문제다.
//
// 그래서 이 단계는 자리를 고르지 않는다: 서버가 쓴 글이 닿는 영역(타임라인 행과 채널
// 목록) 안의 **모든 텍스트 노드**에 한 덩어리를 붙이고, 그 뒤 어떤 세로 스크롤 상자도
// 가로로 끌리지 않아야 한다고 요구한다.
//
// 경계는 **누가 그 문자열을 썼는가**다. 이 클라이언트가 쓴 글은 제외한다: 컨트롤
// 라벨(button/summary/탭), 설명 목록의 **라벨 쪽**(`dt` — 값 쪽인 `dd`는 서버의
// 것이라 남는다, agentCardModel.ts의 라벨은 고정 목록이다), 시계(`time`), 상태 칩
// (`*-chip`). 이 넷은 닫힌 문자열 집합이고 길어질 수 없으며, 셋 다 `shrink-0`으로
// 서 있는 것이 옳다 — 긴 제목 옆에서 상태 칩이 찌그러지면 상태를 읽을 수 없다.
// 여기에 74자를 붙이는 것은 일어날 수 없는 조건을 만들어 놓고 고치라고 하는 것이다.
// 나머지 — 본문, 이름, 핸들, 소유자, 채널 이름, 카드의 값 — 는 전부 사람이나 서버가
// 쓰고, 그래서 전부 스트레스를 받는다.
const LONG_TOKEN_STRESS =
  "outbox_drain_worker_restart_loop_2026_08_02_9f2b7c14e0a83d5b6f1c2ea47d90b83c";

/** 이 클라이언트가 쓴 문자열이 사는 자리. 위 주석이 그 경계를 설명한다. */
const LONG_TOKEN_STRESS_SKIP =
  'button, summary, [role="button"], [role="tab"], dt, time, [data-testid$="-chip"]';

async function applyLongTokenStress(page) {
  const touched = await page.evaluate(`(() => {
    const TOKEN = ${JSON.stringify(LONG_TOKEN_STRESS)};
    const roots = document.querySelectorAll(
      '[data-testid="timeline-message"], [data-testid="channel-list"]'
    );
    const nodes = [];
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.nodeValue || node.nodeValue.trim().length < 2) continue;
        const owner = node.parentElement;
        if (!owner) continue;
        if (owner.closest(${JSON.stringify(LONG_TOKEN_STRESS_SKIP)})) continue;
        nodes.push(node);
      }
    }
    for (const node of nodes) node.nodeValue = node.nodeValue + " " + TOKEN;
    return nodes.length;
  })()`);
  if (touched === 0) throw new Error("긴 토큰 스트레스: 붙일 글이 하나도 없다");
  return touched;
}

// iOS 사파리 하단 바가 가리는 높이 (goal B9). 성재 실캡처(2026-08-02 22:54)에서
// 컴포저가 그 뒤로 들어갔다. 100px는 사파리 하단 툴바(주소 줄 + 탭/공유 줄)의
// 실측치에 맞춘 값이고, 정확한 숫자보다 중요한 것은 **레이아웃 뷰포트와 보이는
// 뷰포트가 어긋난 상태**를 만든다는 것이다.
const BOTTOM_CHROME_PX = 100;

/**
 * 하단 브라우저 크롬을 켠다 (goal B9).
 *
 * Chromium은 이 어긋남을 스스로 만들지 못한다: 창을 줄이면 레이아웃 뷰포트와 시각
 * 뷰포트가 **함께** 줄어들어 `100dvh`로도 답이 맞아버리고, 그래서 이 결함은 뷰포트를
 * 줄이는 방식으로는 절대 재현되지 않는다. iOS 사파리가 하는 일은 다르다: 레이아웃
 * 뷰포트는 그대로 두고(그래서 `height: 100%`도 `100dvh`도 844px을 가리킨다) 시각
 * 뷰포트만 744px로 줄인 뒤, 남은 100px을 자기 툴바로 덮는다.
 *
 * 그 어긋남을 그대로 만든다: `VisualViewport.prototype.height`가 100px 작은 값을
 * 답하게 하고 `resize`를 울린다. 플랫폼 API를 흉내내는 것이지 우리 코드를 흉내내는
 * 것이 아니다 — 단언은 "앱이 visualViewport를 읽었는가"가 아니라 "**그려진** 컴포저의
 * 아랫변이 보이는 높이 안에 있는가"이므로, 읽지 않는 구현은 여기서 반드시 붉어진다.
 */
async function emulateBottomChrome(page) {
  await page.evaluate(`(async () => {
    const vv = window.visualViewport;
    const proto = Object.getPrototypeOf(vv);
    if (!window.__momoBottomChrome) {
      window.__momoBottomChrome = Object.getOwnPropertyDescriptor(proto, "height");
    }
    const original = window.__momoBottomChrome;
    Object.defineProperty(proto, "height", {
      configurable: true,
      get() {
        return original.get.call(this) - ${BOTTOM_CHROME_PX};
      },
    });
    vv.dispatchEvent(new Event("resize"));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

/** 크롬을 걷는다. 다음 프레임들은 다시 온전한 화면에서 찍힌다. */
async function releaseBottomChrome(page) {
  await page.evaluate(`(async () => {
    const vv = window.visualViewport;
    const proto = Object.getPrototypeOf(vv);
    if (window.__momoBottomChrome) {
      Object.defineProperty(proto, "height", window.__momoBottomChrome);
      delete window.__momoBottomChrome;
    }
    vv.dispatchEvent(new Event("resize"));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
}

/**
 * 컴포저가 보이는 뷰포트 안에 있는가 (goal B9). 재는 것은 그려진 기하다: 입력창과
 * 전송 버튼의 아랫변이 둘 다 `visualViewport.height` 안이어야 한다. 한 픽셀의
 * 반올림은 봐주고 그 이상은 봐주지 않는다 — 성재 캡처에서 가려진 것은 100px였다.
 */
async function assertComposerVisible(page, where) {
  const measure = await page.evaluate(`(() => {
    const visible = Math.round(window.visualViewport.height);
    const rect = (id) => {
      const el = document.querySelector('[data-testid="' + id + '"]');
      return el ? Math.round(el.getBoundingClientRect().bottom) : null;
    };
    const shell = document.querySelector(".app-shell");
    return {
      visible,
      layout: window.innerHeight,
      input: rect("composer-input"),
      send: rect("composer-send"),
      shell: shell ? Math.round(shell.getBoundingClientRect().height) : null,
    };
  })()`);
  for (const [label, bottom] of [
    ["입력창", measure.input],
    ["전송 버튼", measure.send],
  ]) {
    if (bottom === null) {
      throw new Error(`컴포저 가시성 ${where}: ${label}이 없다`);
    }
    if (bottom > measure.visible + 1) {
      throw new Error(
        `컴포저 가시성 ${where}: ${label} 아랫변이 ${bottom}px인데 보이는 높이는 ` +
          `${measure.visible}px다 (레이아웃 ${measure.layout}px, 셸 ${measure.shell}px) ` +
          `— 브라우저 하단 바 뒤로 ${bottom - measure.visible}px 들어갔다`
      );
    }
  }
  console.log(
    `  composer ${where}: 입력창 ${measure.input}px · 전송 ${measure.send}px <= 보이는 ${measure.visible}px (레이아웃 ${measure.layout}px, 셸 ${measure.shell}px)`
  );
}

async function pinViewportHeight(page, height) {
  await page.evaluate((nextHeight) => {
    document.documentElement.style.setProperty(
      "--app-viewport-height",
      `${nextHeight}px`
    );
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  }, height);
}

/** N-4: px 문자열로 얼리지 않는다. 변수를 걷어 트래커가 visualViewport 로 다시 쓴다. */
async function unpinViewportHeight(page) {
  await page.evaluate(() => {
    document.documentElement.style.removeProperty("--app-viewport-height");
    window.visualViewport?.dispatchEvent(new Event("resize"));
    window.dispatchEvent(new Event("resize"));
  });
}

/**
 * TC-1 (#1758 B-1): 도크가 컴포저를 덮지 않는 것만으로는 부족하다. 800px 창에서
 * 컴포저가 뷰포트 밖으로 나가도 그 경계 단정은 참이었다. 자는 「컴포저 rect ⊂
 * 뷰포트」와 「타임라인 최소 띠」를 720·800·844 세 높이에서 함께 잰다.
 */
async function assertDockAboveComposer(page, where) {
  const original = page.viewportSize();
  if (!original) {
    throw new Error(`도크 기하 ${where}: 뷰포트 크기를 모른다`);
  }
  try {
    for (const height of [720, 800, 844]) {
      await page.setViewportSize({ width: original.width, height });
      // 폰 셸은 `--app-viewport-height`를 visualViewport에서 받아 쓴다. Playwright
      // 의 setViewportSize 직후에는 그 변수가 직전 높이에 남아 컴포저가 옛 좌표에
      // 서 있는 경합이 있다. 트래커가 쓸 값과 같은 픽셀을 맞춘 뒤 두 프레임을 기다린다.
      await pinViewportHeight(page, height);
      await page.waitForFunction(
        (nextHeight) => {
          const composer = document.querySelector('[data-testid="composer"]');
          if (!composer || window.innerHeight !== nextHeight) return false;
          return composer.getBoundingClientRect().bottom <= nextHeight + 1;
        },
        height,
        { timeout: 5_000 }
      );
      const measure = await page.evaluate(`(() => {
        const dock = document.querySelector('[data-testid="terminal-dock"]');
        const composer = document.querySelector('[data-testid="composer"]');
        const timeline = document.querySelector('[data-testid="chat-timeline"]');
        const input = document.querySelector('[data-testid="composer-input"]');
        const send = document.querySelector('[data-testid="composer-send"]');
        if (!dock || !composer) return { missing: true };
        const d = dock.getBoundingClientRect();
        const c = composer.getBoundingClientRect();
        const t = timeline ? timeline.getBoundingClientRect() : null;
        const strip = timeline
          ? parseFloat(getComputedStyle(timeline).minHeight) || 0
          : 0;
        const vh = window.innerHeight;
        const vw = window.innerWidth;
        const inputBox = input ? input.getBoundingClientRect() : null;
        const sendBox = send ? send.getBoundingClientRect() : null;
        const inside = (box) =>
          box &&
          box.top >= -1 &&
          box.left >= -1 &&
          box.bottom <= vh + 1 &&
          box.right <= vw + 1;
        return {
          missing: false,
          vh,
          vw,
          dockTop: Math.round(d.top),
          dockBottom: Math.round(d.bottom),
          dockH: Math.round(d.height),
          composerTop: Math.round(c.top),
          composerBottom: Math.round(c.bottom),
          composerH: Math.round(c.height),
          overlap: Math.round(d.bottom - c.top),
          timelineH: t ? Math.round(t.height) : 0,
          strip: Math.round(strip),
          composerInView: inside(c),
          inputInView: inside(inputBox),
          sendInView: inside(sendBox),
        };
      })()`);
      if (measure.missing) {
        throw new Error(`도크 기하 ${where} @${height}: 도크 또는 컴포저가 없다`);
      }
      if (measure.overlap > 1) {
        throw new Error(
          `도크가 컴포저를 덮는다 ${where} @${height}: 도크 아랫변 ${measure.dockBottom}px, ` +
            `컴포저 윗변 ${measure.composerTop}px, 교차 ${measure.overlap}px`
        );
      }
      if (!measure.composerInView || !measure.inputInView || !measure.sendInView) {
        throw new Error(
          `컴포저가 뷰포트 밖이다 ${where} @${height}: 컴포저 ${measure.composerTop}–${measure.composerBottom} ` +
            `/ 창 ${measure.vw}×${measure.vh} (입력 ${measure.inputInView} · 전송 ${measure.sendInView})`
        );
      }
      if (measure.timelineH + 1 < measure.strip) {
        throw new Error(
          `타임라인 띠가 사라졌다 ${where} @${height}: ${measure.timelineH}px < 바닥 ${measure.strip}px`
        );
      }
      console.log(
        `  dock ${where} @${height}: 도크 ${measure.dockH}px (${measure.dockTop}–${measure.dockBottom}) · ` +
          `타임라인 ${measure.timelineH}px(바닥 ${measure.strip}) · ` +
          `컴포저 ${measure.composerTop}–${measure.composerBottom} ⊂ ${measure.vw}×${measure.vh}`
      );
    }
  } finally {
    await page.setViewportSize(original);
    await unpinViewportHeight(page);
  }
}

/**
 * R2-H1/H2 · R3-H1: 확대가 720에서 실줄을 벌고, 이득이 0이면 버튼이 disabled
 * 이며, 짧은 창(760×480 · 폰 폭 390×560)에서는 정직 문장만 남고 0px 터미널
 * 상자는 없다. 접힘은 크롬 상수가 아니라 상자 실높이 < floor.
 */
async function assertDockExpandHonesty(page, where) {
  const original = page.viewportSize();
  if (!original) {
    throw new Error(`도크 확대 ${where}: 뷰포트 크기를 모른다`);
  }
  const hasObserver = (await page.getByTestId("work-observer").count()) > 0;
  const cases = [
    { width: 1280, height: 720, expectGrow: true },
    { width: 1280, height: 800, expectGrow: true },
    { width: 1280, height: 844, expectGrow: true },
    { width: 760, height: 480, expectShort: true },
    { width: 390, height: 560, expectShort: true },
  ];
  try {
    for (const next of cases) {
      if (next.expectShort && !hasObserver) continue;
      await page.setViewportSize({ width: next.width, height: next.height });
      await pinViewportHeight(page, next.height);
      await page.waitForFunction(
        (nextHeight) => window.innerHeight === nextHeight,
        next.height,
        { timeout: 5_000 }
      );
      const expand = page.getByTestId("terminal-dock-expand");
      const dock = page.getByTestId("terminal-dock");
      await dock.waitFor({ state: "visible" });
      if (next.expectShort) {
        await page.getByTestId("terminal-dock-short").waitFor({ state: "visible" });
        const terminalBox = page.getByTestId("work-observer-terminal");
        if ((await terminalBox.count()) > 0 && (await terminalBox.isVisible())) {
          throw new Error(
            `${next.width}×${next.height}에서 터미널 상자가 보인다 ${where}`
          );
        }
        const start = page.getByTestId("work-observer-start");
        if ((await start.count()) > 0 && (await start.isVisible())) {
          throw new Error(
            `${next.width}×${next.height}에서 관전 시작이 보인다 ${where}`
          );
        }
        if (!(await expand.isDisabled())) {
          throw new Error(
            `${next.width}×${next.height}에서 확대가 활성이다 ${where}`
          );
        }
        if ((await dock.getAttribute("data-expanded")) !== null) {
          throw new Error(
            `${next.width}×${next.height}에서 data-expanded 가 붙었다 ${where}`
          );
        }
        const dockH = await dock.evaluate((el) => Math.round(el.getBoundingClientRect().height));
        console.log(
          `  dock expand ${where} @${next.width}×${next.height}: 접힘 문장 · 확대 disabled · 도크 ${dockH}px`
        );
        continue;
      }
      const geo = await page.evaluate(() => {
        const dockEl = document.querySelector('[data-testid="terminal-dock"]');
        const timeline = document.querySelector('[data-testid="chat-timeline"]');
        const strip = timeline
          ? parseFloat(getComputedStyle(timeline).minHeight) || 0
          : 0;
        return {
          dockH: dockEl ? dockEl.getBoundingClientRect().height : 0,
          timelineH: timeline ? timeline.getBoundingClientRect().height : 0,
          strip,
        };
      });
      const slack = geo.timelineH - geo.strip;
      const before = geo.dockH;
      if (slack <= 1) {
        if (!(await expand.isDisabled())) {
          throw new Error(
            `띠에 여유 없는데 확대가 활성이다 ${where} @${next.height}: 타임라인 ${Math.round(geo.timelineH)}px`
          );
        }
        if ((await dock.getAttribute("data-expanded")) !== null) {
          throw new Error(`이득 0인데 data-expanded 가 붙었다 ${where} @${next.height}`);
        }
        console.log(
          `  dock expand ${where} @${next.width}×${next.height}: 여유 0 · 확대 disabled · 도크 ${Math.round(before)}px`
        );
        continue;
      }
      if (await expand.isDisabled()) {
        throw new Error(
          `여유 ${Math.round(slack)}px 있는데 확대가 비활성이다 ${where} @${next.height}`
        );
      }
      await expand.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="terminal-dock"]')
            ?.hasAttribute("data-expanded") === true,
        null,
        { timeout: 3_000 }
      );
      const after = await dock.evaluate((el) => el.getBoundingClientRect().height);
      if (next.expectGrow && after <= before + 1) {
        throw new Error(
          `확대가 높이를 바꾸지 않았다 ${where} @${next.height}: ${Math.round(before)} -> ${Math.round(after)}`
        );
      }
      console.log(
        `  dock expand ${where} @${next.width}×${next.height}: ${Math.round(before)} → ${Math.round(after)} (Δ${Math.round(after - before)})`
      );
      await expand.click();
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-testid="terminal-dock"]')
            ?.hasAttribute("data-expanded") !== true,
        null,
        { timeout: 3_000 }
      );
    }
  } finally {
    await page.setViewportSize(original);
    await unpinViewportHeight(page);
    await page.waitForFunction(
      () => {
        const dock = document.querySelector('[data-testid="terminal-dock"]');
        return Boolean(dock) && !dock.hasAttribute("data-short");
      },
      null,
      { timeout: 5_000 }
    );
  }
}

/**
 * 위쪽이 답답한가 (goal B9 §0.3). 성재 실캡처 1번의 지적은 "헤더 아래 콘텐츠가 상단에
 * 붙어 답답"이었고, 그 인상은 두 숫자로 갈린다: 헤더 줄 자체가 손가락 줄만큼 높은가,
 * 그리고 셸이 위쪽 안전 영역을 인정하는가.
 *
 * 안전 영역은 값이 아니라 **선언**을 잰다. 사파리 탭에서 `safe-area-inset-top`은 0이다
 * (브라우저 크롬이 이미 그 자리를 갖고 있다). 그러니 인셋이 0이라는 사실은 결함이
 * 아니고, 인셋이 47px인 곳(홈 화면에 추가한 standalone)에서 셸이 그만큼 물러날
 * 준비가 되어 있는지가 결함이다. 헤드리스 크로미움에는 노치가 없으므로 이 게이트가
 * 관찰할 수 있는 것은 `.app-shell`이 `env(safe-area-inset-top)`을 실제로 걸어 두었다는
 * 사실뿐이고, 그것을 컴퓨티드 스타일이 아니라 **선언된 규칙**에서 읽는다.
 */
async function assertTopBreathing(page, where) {
  const measure = await page.evaluate(`(() => {
    const header = document.querySelector("main header");
    const shell = document.querySelector(".app-shell");
    const declared = [];
    for (const sheet of document.styleSheets) {
      let rules;
      try {
        rules = sheet.cssRules;
      } catch {
        continue;
      }
      const walk = (list) => {
        for (const rule of list) {
          if (rule.cssRules) walk(rule.cssRules);
          if (
            rule.selectorText &&
            rule.selectorText.includes("app-shell") &&
            rule.style &&
            rule.style.getPropertyValue("padding-block-start").includes("safe-area-inset-top")
          ) {
            declared.push(rule.selectorText);
          }
        }
      };
      walk(rules);
    }
    return {
      headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
      shellTop: shell ? Math.round(shell.getBoundingClientRect().top) : null,
      safeAreaTopDeclared: declared.length > 0,
    };
  })()`);
  if (measure.headerHeight === null) {
    throw new Error(`위쪽 여백 ${where}: 헤더가 없다`);
  }
  // 44px는 이 파일이 손가락 타깃에 쓰는 것과 같은 수다(WCAG 2.5.5 / HIG). 헤더는
  // 한 줄이지만 그 줄에 서 있는 것은 전부 눌러야 하는 것들이라(햄버거, 허들, 패널)
  // 줄 자체가 그 높이를 가져야 한다.
  if (measure.headerHeight < 44) {
    throw new Error(
      `위쪽 여백 ${where}: 헤더가 ${measure.headerHeight}px다 (최소 44px)`
    );
  }
  if (!measure.safeAreaTopDeclared) {
    throw new Error(
      `위쪽 여백 ${where}: .app-shell이 env(safe-area-inset-top)을 걸지 않았다 — ` +
        `viewport-fit=cover로 노치 아래까지 그리면서 위로 물러나지 않으면 헤더가 상태바에 들어간다`
    );
  }
  console.log(
    `  top ${where}: 헤더 ${measure.headerHeight}px, 셸 상단 ${measure.shellTop}px, safe-area-top 선언됨`
  );
}

/**
 * 손가락 타깃 실측. 값을 함께 찍어 리뷰가 숫자를 볼 수 있게 한다.
 *
 * `targets`로 목록을 갈아끼울 수 있다: 화면마다 재야 할 컨트롤이 다르고, 그 화면에
 * 없는 것을 필수로 재면 목록 전체가 optional로 물러나기 때문이다 (goal P3 1-4).
 */
async function assertTapTargets(page, where, targets = MOBILE_TAP_TARGETS) {
  const measured = await page.evaluate(
    `(() => ${JSON.stringify(targets)}.map(([testId, label]) => {
      const el = document.querySelector('[data-testid="' + testId + '"]');
      if (!el) return { testId, label, missing: true };
      const r = el.getBoundingClientRect();
      return {
        testId,
        label,
        width: Math.round(r.width),
        height: Math.round(r.height),
      };
    }))()`
  );
  const optional = new Set(
    targets.filter((t) => t[2] === "optional").map((t) => t[0])
  );
  for (const row of measured) {
    if (row.missing) {
      if (optional.has(row.testId)) continue;
      throw new Error(`손가락 타깃 ${where}: ${row.testId} 없음`);
    }
    if (row.height < 44) {
      throw new Error(
        `손가락 타깃 ${where}: ${row.label}(${row.testId})가 ${row.width}x${row.height}px다 (최소 44px)`
      );
    }
  }
  console.log(
    `  tap targets ${where}: ` +
      measured.map((r) => `${r.testId} ${r.width}x${r.height}`).join(", ")
  );
}

/**
 * #1889 R2-B1. The profile menu's width is the menu's (pane-sm), not the
 * user's status sentence. An 80-char head must wrap inside that box: right
 * stays in the viewport and the declared-presence check stays visible.
 */
async function assertProfileMenuFitsViewport(page, where) {
  const paneSm = pixelToken("spacing-pane-sm");
  const fit = await page.evaluate(`(() => {
    const menu = document.querySelector('[data-testid="profile-card-menu"]');
    const check = document.querySelector('[data-testid="presence-option-auto"] svg');
    if (!menu) return { missing: true };
    const r = menu.getBoundingClientRect();
    const c = check ? check.getBoundingClientRect() : null;
    const vw = window.innerWidth;
    return {
      x: Math.round(r.x),
      w: Math.round(r.width),
      right: Math.round(r.right),
      vw,
      checkRight: c ? Math.round(c.right) : null,
      checkVisible: Boolean(
        c && c.width > 0 && c.left >= 0 && c.right <= vw + 0.5
      ),
    };
  })()`);
  if (fit.missing) {
    throw new Error(`프로필 메뉴 ${where}: 메뉴가 없다`);
  }
  if (fit.w > paneSm) {
    throw new Error(
      `프로필 메뉴 ${where}: 폭 ${fit.w}px가 pane-sm(${paneSm})을 넘긴다`
    );
  }
  if (fit.right > fit.vw) {
    throw new Error(
      `프로필 메뉴 ${where}: right ${fit.right} > vw ${fit.vw}`
    );
  }
  if (!fit.checkVisible) {
    throw new Error(
      `프로필 메뉴 ${where}: 선언 ✓가 뷰포트 밖이다 ${JSON.stringify(fit)}`
    );
  }
  console.log(
    `  profile menu ${where}: w=${fit.w} right=${fit.right} vs vw=${fit.vw}, check right=${fit.checkRight}`
  );
}

/**
 * UX-CB의 닫힌 탭 예산. 캡처 레인이 실제 DOM을 걷는다: 정적 소스에서 버튼 이름만
 * 세면 hidden file input이나 disabled 전송 버튼을 놓치고도 초록이 된다.
 */
async function assertComposerTabOrder(page, where) {
  const expected = [
    "composer-input",
    "composer-mention-trigger",
    "composer-attach",
    "composer-emoji-trigger",
    "composer-send",
  ];
  const input = page.getByTestId("composer-input");
  await input.fill("탭 순서 확인");
  const tabbable = await page.getByTestId("composer-frame").evaluate((frame) =>
    Array.from(
      frame.querySelectorAll(
        'textarea:not(:disabled), button:not(:disabled), input:not(:disabled):not([tabindex="-1"])'
      )
    )
      .filter((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      })
      .map((element) => element.getAttribute("data-testid"))
  );
  if (JSON.stringify(tabbable) !== JSON.stringify(expected)) {
    throw new Error(
      `컴포저 탭 순서 ${where}: ${JSON.stringify(tabbable)} (기대 ${JSON.stringify(expected)})`
    );
  }

  // Tab으로 버튼에 간 뒤 Shift+Tab으로 돌아와야 textarea도 키보드 모달리티의
  // :focus-visible을 얻는다. 링은 textarea가 아니라 한 컨트롤인 그릇이 진다.
  await input.focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  const walked = [];
  for (let index = 0; index < expected.length; index++) {
    const focus = await page.evaluate(`(() => {
      const active = document.activeElement;
      const frame = document.querySelector('[data-testid="composer-frame"]');
      const activeStyle = active ? getComputedStyle(active) : null;
      const ringTarget = active?.getAttribute("data-testid") === "composer-input"
        ? frame
        : active;
      const ringStyle = ringTarget ? getComputedStyle(ringTarget) : null;
      return {
        testId: active?.getAttribute("data-testid") ?? null,
        focusVisible: active?.matches(":focus-visible") ?? false,
        activeOutlineWidth: activeStyle?.outlineWidth ?? null,
        activeOutlineStyle: activeStyle?.outlineStyle ?? null,
        outlineWidth: ringStyle?.outlineWidth ?? null,
        outlineStyle: ringStyle?.outlineStyle ?? null,
        modality: document.documentElement.getAttribute("data-focus-modality"),
      };
    })()`);
    walked.push(focus.testId);
    if (
      focus.testId !== expected[index] ||
      !focus.focusVisible ||
      focus.outlineWidth !== "2px" ||
      focus.outlineStyle !== "solid" ||
      (index === 0 && focus.activeOutlineStyle !== "none") ||
      (index === 0 && focus.modality !== "keyboard")
    ) {
      throw new Error(
        `컴포저 키보드 초점 ${where} ${index + 1}/${expected.length}: ${JSON.stringify(focus)}`
      );
    }
    if (index < expected.length - 1) await page.keyboard.press("Tab");
  }
  console.log(
    `  composer tabs ${where}: ${walked.join(" → ")} (총 ${walked.length}, 입력은 그릇 링·버튼은 자체 2px 링)`
  );
  return walked;
}

/** 액션 행의 버튼 아닌 가운데 폭을 실제로 눌러 입력 캐럿이 돌아오는지 잰다. */
async function assertComposerVesselClick(page, where, ids) {
  const input = page.getByTestId(ids.input);
  const frame = page.getByTestId(ids.frame ?? "composer-frame");
  const rest = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor };
  });
  await input.fill("그릇 클릭 확인");
  await input.evaluate((element) => element.setSelectionRange(2, 2));
  await page.getByTestId(ids.actions).click({ position: { x: 160, y: 4 } });
  const proof = await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="${ids.input}"]');
    const frame = document.querySelector('[data-testid="${ids.frame ?? "composer-frame"}"]');
    const frameStyle = frame ? getComputedStyle(frame) : null;
    return {
      active: document.activeElement === input,
      start: input?.selectionStart ?? null,
      end: input?.selectionEnd ?? null,
      borderColor: frameStyle?.borderColor ?? null,
      outlineWidth: frameStyle?.outlineWidth ?? null,
      outlineStyle: frameStyle?.outlineStyle ?? null,
      modality: document.documentElement.getAttribute("data-focus-modality"),
    };
  })()`);
  if (
    !proof.active ||
    proof.start !== 2 ||
    proof.end !== 2 ||
    proof.borderColor !== rest.borderColor ||
    proof.outlineStyle !== "none" ||
    proof.modality !== "pointer"
  ) {
    throw new Error(`컴포저 그릇 클릭 ${where}: ${JSON.stringify(proof)}`);
  }
  console.log(
    `  composer vessel ${where}: 액션 행 빈 폭 → 입력 캐럿 ${proof.start} · 포인터 보더 불변`
  );
}

const OBSERVER_ATTACH_ENDPOINT = "wss://127.0.0.1:28443/v1/observer-terminal";

/** 캡처 레인이 xterm을 연 채로 포인터/Tab 링을 재게, grant + 소켓을 붙잡아 둔다. */
async function mockObserverTerminalAttach(context) {
  await context.route("**/work-sessions/*/terminal-attach", (route) =>
    json(route, {
      attach_endpoint: OBSERVER_ATTACH_ENDPOINT,
      capability_token: `momo_terminal_attach_v1.${"a".repeat(43)}`,
      pty_id: "pty-capture-1",
    })
  );
  await context.routeWebSocket(/\/v1\/observer-terminal$/, () => {});
}

function readObserverTerminalVessel() {
  return `(() => {
      const frame = document.querySelector(
        '[data-testid="work-observer-terminal-frame"]'
      );
      const textarea = document.querySelector(".xterm-helper-textarea");
      const frameStyle = frame ? getComputedStyle(frame) : null;
      return {
        frame: Boolean(frame),
        textarea: Boolean(textarea),
        activeIsTextarea: document.activeElement === textarea,
        activeClass: document.activeElement?.className ?? null,
        focusVisible: textarea?.matches(":focus-visible") ?? false,
        borderColor: frameStyle?.borderColor ?? null,
        outlineWidth: frameStyle?.outlineWidth ?? null,
        outlineStyle: frameStyle?.outlineStyle ?? null,
        modality: document.documentElement.getAttribute("data-focus-modality"),
      };
    })()`;
}

/**
 * 관전 터미널 그릇 (#1866 design-review High). xterm helper textarea는 클릭에도
 * :focus-visible이라 :focus-within이면 드래그 선택 순간 인셋 링이 선다. 컴포저와
 * 같은 focus-visible-within + Tab 스탬프가 그걸 가른다. Tab 이탈은 포커스 트랩
 * 회귀(MOMO-619)를 같이 잰다.
 */
async function assertObserverTerminalModality(page, where, shots, scheme) {
  const start = page.getByTestId("work-observer-start");
  await start.waitFor({ state: "visible" });
  await start.click();
  await page.locator(".xterm-helper-textarea").waitFor({
    state: "attached",
    timeout: 10_000,
  });
  const frame = page.getByTestId("work-observer-terminal-frame");
  await frame.waitFor({ state: "visible" });
  const rest = await frame.evaluate((element) => {
    const style = getComputedStyle(element);
    return { borderColor: style.borderColor };
  });

  const box = await page.getByTestId("work-observer-terminal").boundingBox();
  if (!box) {
    throw new Error(`관전 터미널 상자 없음 ${where}`);
  }
  await page.mouse.move(box.x + 24, box.y + 16);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, box.y + 28);
  const dragging = await page.evaluate(readObserverTerminalVessel());
  await page.mouse.up();
  if (
    !dragging.frame ||
    !dragging.textarea ||
    !dragging.activeIsTextarea ||
    dragging.borderColor !== rest.borderColor ||
    dragging.outlineStyle !== "none" ||
    dragging.modality !== "pointer"
  ) {
    throw new Error(
      `관전 터미널 포인터 선택 ${where}: ${JSON.stringify(dragging)}`
    );
  }
  if (shots && scheme) {
    const pointerShot = `${OUT_DIR}/terminal-pointer-${scheme}.png`;
    await page.screenshot({ path: pointerShot });
    shots.push(pointerShot);
  }

  await page.keyboard.press("Tab");
  const left = await page.evaluate(readObserverTerminalVessel());
  if (left.activeIsTextarea) {
    throw new Error(
      `관전 터미널 Tab 이탈 실패(포커스 트랩) ${where}: ${JSON.stringify(left)}`
    );
  }

  await page.keyboard.press("Shift+Tab");
  const tabbed = await page.evaluate(readObserverTerminalVessel());
  if (
    !tabbed.activeIsTextarea ||
    !tabbed.focusVisible ||
    tabbed.outlineWidth !== "2px" ||
    tabbed.outlineStyle !== "solid" ||
    tabbed.modality !== "keyboard"
  ) {
    throw new Error(
      `관전 터미널 Tab 진입 ${where}: ${JSON.stringify(tabbed)}`
    );
  }
  if (shots && scheme) {
    const focusShot = `${OUT_DIR}/terminal-focus-${scheme}.png`;
    await page.screenshot({ path: focusShot });
    shots.push(focusShot);
  }

  const stop = page.getByTestId("work-observer-stop");
  if ((await stop.count()) > 0 && (await stop.isVisible())) {
    await stop.click();
    await page.getByTestId("work-observer-start").waitFor({ state: "visible" });
  }

  console.log(
    `  observer terminal ${where}: 포인터 선택 무링 · Tab 진입 2px 링 · Tab 이탈`
  );
  return { rest, dragging, left, tabbed };
}

/** [@]를 포인터로 실제 누르고, 기존 listbox가 입력 기준 위치에서 열린 것을 잰다. */
async function assertMentionTrigger(page, where, ids) {
  const input = page.getByTestId(ids.input);
  await input.fill("배포 확인");
  // `배포` 바로 뒤는 비공백 경계다. 공백 뒤를 고르면 B-1의 죽은 버튼도 초록이다.
  await input.evaluate((element) => element.setSelectionRange(2, 2));
  await page.getByTestId(ids.trigger).click();
  await page.getByTestId(ids.list).waitFor({ state: "visible" });
  await page.waitForFunction(
    (testId) =>
      document.activeElement?.getAttribute("data-testid") === testId,
    ids.input
  );
  const proof = await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="${ids.input}"]');
    const list = document.querySelector('[data-testid="${ids.list}"]');
    const frame = input?.closest('[data-testid$="composer-frame"]');
    const inputRect = input?.getBoundingClientRect();
    const listRect = list?.getBoundingClientRect();
    return {
      value: input?.value ?? null,
      active: document.activeElement?.getAttribute("data-testid") ?? null,
      focusVisible: input?.matches(":focus-visible") ?? null,
      inputOutlineWidth: input ? getComputedStyle(input).outlineWidth : null,
      inputOutlineStyle: input ? getComputedStyle(input).outlineStyle : null,
      frameOutlineWidth: frame
        ? getComputedStyle(frame).outlineWidth
        : null,
      frameOutlineStyle: frame
        ? getComputedStyle(frame).outlineStyle
        : null,
      frameBorderColor: frame ? getComputedStyle(frame).borderColor : null,
      modality: document.documentElement.getAttribute("data-focus-modality"),
      options: list?.querySelectorAll('[role="option"]').length ?? 0,
      leftDelta:
        inputRect && listRect ? Math.round(listRect.left - inputRect.left) : null,
      gap:
        inputRect && listRect ? Math.round(inputRect.top - listRect.bottom) : null,
    };
  })()`);
  // 텍스트 입력류는 스펙상 클릭에도 :focus-visible이 매치된다. 그릇 링은 Tab
  // 모달리티에서만 선다(#1866). 포인터 경로의 [@]는 보더 색·아웃라인을 바꾸지 않는다.
  if (
    proof.value !== "배포 @ 확인" ||
    proof.active !== ids.input ||
    proof.focusVisible !== true ||
    proof.inputOutlineStyle !== "none" ||
    proof.frameOutlineStyle !== "none" ||
    proof.modality !== "pointer" ||
    proof.options < 1 ||
    Math.abs(proof.leftDelta) > 1 ||
    proof.gap < 0 ||
    proof.gap > 24
  ) {
    throw new Error(`[@] 발동 ${where}: ${JSON.stringify(proof)}`);
  }
  console.log(
    `  mention trigger ${where}: ${proof.value} · 후보 ${proof.options} · 입력 기준 left ${proof.leftDelta}px / gap ${proof.gap}px · input fv=true, pointer 그릇 무링`
  );
  return proof;
}

/**
 * `#`·`:` 자동완성이 실제로 열린 프레임 (#1930).
 *
 * 두 트리거에는 [@] 같은 버튼이 없다 — 글자를 치는 것이 유일한 경로이므로 캡처도
 * 그 경로로 친다(`fill` 은 한 번에 값을 갈아 끼워 사람이 지나가는 중간 상태를
 * 건너뛴다). 목록이 떴다는 것만 보지 않고 **어느 트리거의 목록인지**(접근 이름)와
 * 입력이 그 목록을 가리키고 있는지(aria-controls/activedescendant)까지 잰다:
 * 셋이 한 기계를 쓰는 이상, 틀린 목록이 뜨는 실패가 가장 그럴듯한 실패다.
 */
async function captureComposerTrigger(page, scheme, shots, ids, trigger) {
  const input = page.getByTestId(ids.input);
  await input.fill("");
  await input.click();
  await page.keyboard.type(trigger.typed, { delay: 15 });
  const list = page.getByTestId(trigger.list);
  await list.waitFor({ state: "visible" });
  const proof = await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="${ids.input}"]');
    const list = document.querySelector('[data-testid="${trigger.list}"]');
    const first = list?.querySelector('[role="option"]');
    return {
      value: input?.value ?? null,
      label: list?.getAttribute("aria-label") ?? null,
      options: list?.querySelectorAll('[role="option"]').length ?? 0,
      expanded: input?.getAttribute("aria-expanded") ?? null,
      controls: input?.getAttribute("aria-controls") ?? null,
      listId: list?.id ?? null,
      active: input?.getAttribute("aria-activedescendant") ?? null,
      firstId: first?.id ?? null,
      firstText: first?.textContent ?? null,
    };
  })()`);
  if (
    proof.value !== trigger.typed ||
    proof.label !== trigger.label ||
    proof.options < 1 ||
    proof.expanded !== "true" ||
    proof.controls === null ||
    proof.controls !== proof.listId ||
    proof.active !== proof.firstId ||
    proof.options < (trigger.minOptions ?? 1) ||
    (trigger.expectFirst !== undefined &&
      !(proof.firstText ?? "").includes(trigger.expectFirst))
  ) {
    throw new Error(
      `${trigger.typed} 자동완성 ${scheme}: ${JSON.stringify(proof)}`
    );
  }
  if (trigger.rows !== undefined) await assertComposerRows(page, scheme, trigger);
  const shot = `${OUT_DIR}/${trigger.shot}-${scheme}.png`;
  await page.screenshot({ path: shot });
  shots.push(shot);
  console.log(
    `  자동완성 ${trigger.typed} ${scheme}: ${proof.label} · 후보 ${proof.options} · 첫 줄 ${proof.firstText}`
  );
  await page.keyboard.press("Escape");
  await list.waitFor({ state: "hidden" });
  await input.fill("");
}

/**
 * 카탈로그가 죽은 판의 사유 상자와 「다시 시도」 (design-review #1930 B-1·H-3).
 *
 * 이 장면이 없어서 두 결함이 초록을 뚫고 나갔다. `:` 만 비동기 소스인데 레인은
 * 성공 경로만 열었고, 단위 시험은 `loadCatalog` 자체를 모킹해 로더의 현실을 보지
 * 않았다. 그래서 여기서는 **실제로 청크를 끊는다**:
 *
 *   1. 카탈로그 요청을 abort → `:thu` 가 사유 상자(오류)를 세운다.
 *   2. 그 상자의 「다시 시도」가 **제출 버튼이 아니다**(B-1). 컴포저의 `<form>`
 *      안이라 `type` 이 없으면 클릭이 폼을 제출해 쓰던 초안이 채널로 나갔다.
 *      클릭 뒤 초안이 그대로 있고 POST /messages 가 0건이어야 한다.
 *   3. 차단을 풀고 누르면 **실제로 다시 실린다**(H-3). 실패한 dynamic import 는
 *      모듈 맵이 기억하므로, 재시도가 자산 URL 을 `fetch` 로 다시 받지 않으면
 *      이 대기는 영원히 안 끝난다.
 *
 * 이 장면은 `:thu` 성공 장면보다 **먼저** 돈다: 카탈로그가 한 번 실리면 그 뒤로는
 * 이 판을 만들 수 없다.
 */
async function captureComposerCatalogFailure(page, context, scheme, shots) {
  const posted = [];
  const watch = (request) => {
    if (request.method() === "POST" && request.url().includes("/messages")) {
      posted.push(request.url());
    }
  };
  page.on("request", watch);
  const block = (route) => route.abort();
  await context.route("**/emojiCatalog-*", block);
  const input = page.getByTestId("composer-input");
  await input.fill("");
  await input.click();
  await page.keyboard.type(":thu", { delay: 15 });
  const box = page.getByTestId("composer-emoji-list-status");
  await box.waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-testid="composer-emoji-list-status"]')
        ?.getAttribute("data-status") === "error"
  );
  const proof = await page.evaluate(`(() => {
    const box = document.querySelector('[data-testid="composer-emoji-list-status"]');
    const button = box?.querySelector("button");
    const input = document.querySelector('[data-testid="composer-input"]');
    return {
      status: box?.getAttribute("data-status") ?? null,
      text: box?.textContent ?? "",
      buttonType: button?.type ?? null,
      buttonTypeAttr: button?.getAttribute("type") ?? null,
      inForm: Boolean(button?.form),
      listWidth: Math.round(box?.getBoundingClientRect().width ?? 0),
      value: input?.value ?? null,
    };
  })()`);
  if (
    proof.status !== "error" ||
    !proof.text.includes("이모지 목록을 불러오지 못했습니다.") ||
    !proof.text.includes("다시 시도") ||
    proof.buttonType !== "button" ||
    !proof.inForm ||
    proof.value !== ":thu"
  ) {
    throw new Error(`이모지 카탈로그 오류 상자 ${scheme}: ${JSON.stringify(proof)}`);
  }
  const shot = `${OUT_DIR}/composer-emoji-catalog-error-${scheme}.png`;
  await page.screenshot({ path: shot });
  shots.push(shot);

  await context.unroute("**/emojiCatalog-*", block);
  await box.locator("button").click();
  await page.getByTestId("composer-emoji-list").waitFor({ state: "visible" });
  const after = await page.evaluate(`(() => {
    const input = document.querySelector('[data-testid="composer-input"]');
    const list = document.querySelector('[data-testid="composer-emoji-list"]');
    return {
      value: input?.value ?? null,
      options: list?.querySelectorAll('[role="option"]').length ?? 0,
      status: document.querySelector('[data-testid="composer-emoji-list-status"]'),
    };
  })()`);
  page.off("request", watch);
  if (after.value !== ":thu" || after.options < 1 || posted.length > 0) {
    throw new Error(
      `다시 시도 ${scheme}: ${JSON.stringify({ ...after, posted })}`
    );
  }
  console.log(
    `  이모지 카탈로그 실패 ${scheme}: 오류 상자 ${proof.listWidth}px · 버튼 격 ${proof.buttonType} · 다시 시도 뒤 후보 ${after.options} · 초안 보존 "${after.value}" · 전송 ${posted.length}건`
  );
  await page.keyboard.press("Escape");
  await page.getByTestId("composer-emoji-list").waitFor({ state: "hidden" });
  await input.fill("");
}

/**
 * 후보 행이 자유 텍스트 방 이름을 **실제로 담는지** 잰다 (design-review #1930).
 *
 * jsdom 은 폭을 재지 않는다. 그래서 앞 판의 「긴 채널 이름도 자르지 않고 넣는다」
 * 시험은 삽입 문자열만 재고 초록이었고, 화면에서는 말줄임이 사람이 친 글자를
 * 먹고(`#2026-하반기-릴리…`) 주제 칸이 폭 0px 로 소멸했다(M-1 실측). 여기서
 * 재는 것은 그 두 가지다: 이름이 두 줄로 감싸고 잘리지 않는가, 주제가 폭을
 * 갖는가. 같은 프레임에서 비공개 방의 격 글리프(M-2)도 함께 본다.
 */
async function assertComposerRows(page, scheme, trigger) {
  const rows = await page.evaluate(`(() => {
    const list = document.querySelector('[data-testid="${trigger.list}"]');
    return [...(list?.querySelectorAll('[role="option"]') ?? [])].map((option) => {
      const spans = [...option.querySelectorAll('span')];
      const lead = spans[0];
      const hint = spans[1] ?? null;
      const leadRect = lead.getBoundingClientRect();
      const line = parseFloat(getComputedStyle(lead).lineHeight) || 1;
      return {
        text: option.textContent,
        lock: Boolean(option.querySelector('svg')),
        leadLines: Math.round(leadRect.height / line),
        leadClipped:
          lead.scrollHeight > lead.clientHeight + 1 ||
          lead.scrollWidth > lead.clientWidth + 1,
        hintW: hint ? Math.round(hint.getBoundingClientRect().width) : null,
      };
    });
  })()`);
  const find = (needle) => rows.find((row) => (row.text ?? "").includes(needle));
  const wrapped = find(trigger.rows.wrapped);
  if (
    !wrapped ||
    wrapped.leadLines < 2 ||
    wrapped.leadClipped ||
    !(wrapped.hintW > 0)
  ) {
    throw new Error(
      `${trigger.typed} 긴 이름 행 ${scheme}: ${JSON.stringify(rows)}`
    );
  }
  const locked = find(trigger.rows.locked);
  if (!locked || !locked.lock || (locked.text ?? "").includes("#")) {
    throw new Error(
      `${trigger.typed} 비공개 행 ${scheme}: ${JSON.stringify(rows)}`
    );
  }
  console.log(
    `  자동완성 행 ${scheme}: 긴 이름 ${wrapped.leadLines}줄 · 주제 ${wrapped.hintW}px · 비공개 자물쇠 ${locked.lock}`
  );
}

/** 이모지 popover의 세로 변이 실제 트리거 버튼에서 시작하는지 잰다. */
async function assertEmojiAnchor(page, where, triggerId, pickerId) {
  // Radix 포지셔닝은 비동기라 open 직후 rect가 미배치(0,0)일 수 있다 — 배치가
  // 두 폴링 연속 같은 자리에 정착한 뒤에만 잰다. 단정은 아래 그대로이므로
  // 진짜 오배치는 정착한 그 자리에서 여전히 걸린다.
  await page.waitForFunction((pid) => {
    const el = document.querySelector(`[data-testid="${pid}"]`);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.left <= 0 && r.top <= 0) return false;
    const prev = el.__momoPrevRect;
    el.__momoPrevRect = { l: r.left, t: r.top };
    return Boolean(prev && prev.l === r.left && prev.t === r.top);
  }, pickerId);
  const proof = await page.evaluate(`(() => {
    const trigger = document.querySelector('[data-testid="${triggerId}"]');
    const picker = document.querySelector('[data-testid="${pickerId}"]');
    const triggerRect = trigger?.getBoundingClientRect();
    const pickerRect = picker?.getBoundingClientRect();
    return {
      trigger: triggerRect
        ? { left: Math.round(triggerRect.left), top: Math.round(triggerRect.top) }
        : null,
      picker: pickerRect
        ? {
            left: Math.round(pickerRect.left),
            right: Math.round(pickerRect.right),
            bottom: Math.round(pickerRect.bottom),
            width: Math.round(pickerRect.width),
          }
        : null,
      triggerRight: triggerRect ? Math.round(triggerRect.right) : null,
      viewportWidth: window.innerWidth,
      horizontalDelta:
        triggerRect && pickerRect
          ? Math.round(pickerRect.left - triggerRect.left)
          : null,
      verticalGap:
        triggerRect && pickerRect
          ? Math.round(triggerRect.top - pickerRect.bottom)
          : null,
    };
  })()`);
  const channelAligned =
    proof.trigger !== null &&
    proof.picker !== null &&
    (!where.startsWith("channel") ||
      Math.abs(proof.horizontalDelta) <= ANCHOR_ALIGNMENT_TOLERANCE);
  // 스레드는 오른쪽 패널 끝에 붙어 있어 Radix가 피커를 왼쪽으로 민다. 시작점 일치
  // 대신 트리거가 피커 가로 범위 안에 남고, 피커가 뷰포트를 넘지 않는지를 단정한다.
  const threadCollisionContained =
    proof.trigger !== null &&
    proof.picker !== null &&
    (!where.startsWith("thread") ||
      (proof.picker.left <= proof.trigger.left + ANCHOR_ALIGNMENT_TOLERANCE &&
        proof.triggerRight <= proof.picker.right + ANCHOR_ALIGNMENT_TOLERANCE &&
        proof.picker.right <= proof.viewportWidth + ANCHOR_ALIGNMENT_TOLERANCE &&
        Math.abs(proof.horizontalDelta) <= proof.picker.width));
  if (
    proof.trigger === null ||
    proof.picker === null ||
    proof.verticalGap < 0 ||
    proof.verticalGap > 16 ||
    !channelAligned ||
    !threadCollisionContained
  ) {
    throw new Error(`이모지 앵커 ${where}: ${JSON.stringify(proof)}`);
  }
  console.log(
    `  emoji anchor ${where}: trigger (${proof.trigger.left},${proof.trigger.top}) · picker (${proof.picker.left},${proof.picker.bottom}) · xΔ ${proof.horizontalDelta}px / gap ${proof.verticalGap}px`
  );
  return proof;
}

/** 단일 그릇의 위/아래 인셋과 컨트롤 경계를 계산 스타일로 고정한다. */
async function assertComposerFrameGeometry(page, where) {
  const proof = await page.evaluate(`(() => {
    const root = document.querySelector('[data-testid="composer"]');
    const form = root?.querySelector("form");
    const frame = document.querySelector('[data-testid="composer-frame"]');
    if (!root || !form || !frame) return null;
    const rootRect = root.getBoundingClientRect();
    const formRect = form.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const style = getComputedStyle(frame);
    const tokenProbe = document.createElement("span");
    tokenProbe.style.color = "var(--line-strong)";
    document.body.append(tokenProbe);
    const expectedBorder = getComputedStyle(tokenProbe).color;
    tokenProbe.remove();
    return {
      topInset: Math.round(frameRect.top - formRect.top),
      bottomInset: Math.round(rootRect.bottom - frameRect.bottom),
      borderWidth: style.borderTopWidth,
      borderStyle: style.borderTopStyle,
      background: style.backgroundColor,
      border: style.borderTopColor,
      expectedBorder,
    };
  })()`);
  if (
    proof === null ||
    proof.topInset !== COMPOSER_FRAME_INSET ||
    proof.bottomInset !== COMPOSER_FRAME_INSET ||
    proof.borderWidth !== "1px" ||
    proof.borderStyle !== "solid" ||
    proof.border !== proof.expectedBorder
  ) {
    throw new Error(`컴포저 그릇 기하 ${where}: ${JSON.stringify(proof)}`);
  }
  console.log(
    `  composer frame ${where}: top ${proof.topInset}px / bottom ${proof.bottomInset}px (--spacing-3) · border ${proof.borderWidth} ${proof.border} (--line-strong) · fill ${proof.background}`
  );
  return proof;
}

/**
 * 인박스가 **자리를 잡을 때까지** 기다린다 (goal P3 후속, B12 회귀 복구).
 *
 * 이 프레임은 `feed-row`가 보이기를 기다리고 있었다. B12가 `isSurfaceProvided`를
 * 인박스에 들이고 `serverSurfaces.ts`가 `approvals`를 정적으로 "라우터에 없음
 * (404)"이라 선언한 뒤로, 인박스는 결정 대기 탭을 지우고 승인 행을 **그리지
 * 않는다**. 그 동작은 옳다 — 없는 원장을 0으로 세어 "결정할 것이 없다"를 지어내지
 * 않는 것이 B12의 요점이다. 틀린 것은 사라진 행을 계속 기다린 이 하네스이고,
 * 그래서 `capture:design`이 30초 타임아웃으로 죽어 있었다. design-review의 증거
 * 파이프라인 전체가 그 한 줄에 걸려 있었다.
 *
 * 그래서 이제 **정착한 결과**를 기다린다: 목록이든 빈 상태든, 스켈레톤이 물러난
 * 자리면 화면은 준비된 것이다. `waitForTimeout`으로 때우지 않는 이유가 정확히 이
 * 사고다 — 고정 대기는 표면이 무엇을 그리든 통과하므로, 다음에 인박스가 또 조용히
 * 바뀌면 이번처럼 **소리 내어 실패하는 대신** 빈 화면을 찍어 보낸다.
 *
 * 오류로 정착하면 실패로 친다. 불러오지 못한 인박스를 찍어 두면 리뷰어는 그것을
 * 제품의 모습으로 읽는다.
 */
async function waitForInboxSettled(page, where) {
  await page.getByTestId("inbox-route").waitFor({ state: "visible" });
  await page.waitForSelector(
    '[data-testid="inbox-list"], [data-testid="inbox-empty"], [data-testid="inbox-error"]',
    { state: "visible" }
  );
  const settled = await page.evaluate(`(() => {
    for (const id of ["inbox-list", "inbox-empty", "inbox-error"]) {
      if (document.querySelector('[data-testid="' + id + '"]')) return id;
    }
    return null;
  })()`);
  if (settled === "inbox-error") {
    throw new Error(`[${where}] 인박스가 오류로 정착했다 — 이 화면은 찍지 않는다`);
  }
  console.log(`  inbox ${where}: ${settled}로 정착`);
  return settled;
}

async function waitForRemindersSettled(page, where) {
  await page.getByTestId("inbox-route").waitFor({ state: "visible" });
  await page.waitForSelector(
    '[data-testid="reminders-list"], [data-testid="reminders-empty"], [data-testid="reminders-error"]',
    { state: "visible" }
  );
  const settled = await page.evaluate(`(() => {
    for (const id of ["reminders-list", "reminders-empty", "reminders-error"]) {
      if (document.querySelector('[data-testid="' + id + '"]')) return id;
    }
    return null;
  })()`);
  if (settled === "reminders-error") {
    throw new Error(
      `[${where}] 리마인더가 오류로 정착했다 — 이 화면은 찍지 않는다`
    );
  }
  if (settled !== "reminders-list") {
    throw new Error(
      `[${where}] 리마인더 목록이 없다 (정착=${settled}) — 목 또는 탭이 빠졌다`
    );
  }
  const overdue = await page
    .locator('[data-testid="reminder-row"][data-due="overdue"]')
    .count();
  if (overdue < 1) {
    throw new Error(`[${where}] 만기 행이 없다 — 픽스처가 빠졌다`);
  }
  console.log(`  reminders ${where}: ${settled}로 정착, overdue ${overdue}`);
  return settled;
}

/**
 * 반복된 「일시정지」 알림이 한 줄로 접혔는가 (goal P3 1-2).
 *
 * 스크린샷은 이것을 증명하지 못한다. 리뷰어가 픽스처를 열어 서버가 **세 줄을
 * 보냈다**는 것을 확인하지 않으면, 한 줄만 있는 화면은 그냥 "원래 한 줄이었나
 * 보다"로 읽힌다. 그래서 여기서 센다: 보낸 것은 셋, 그려진 것은 하나, 그리고 그
 * 하나가 셋이었다고 말하고 있어야 한다.
 *
 * 정보를 없애지 않았다는 쪽도 같이 잰다. 알림 문장 자체는 화면에 그대로 있어야
 * 하고(사람은 여전히 "왜 답이 없는지"를 알 수 있어야 한다), 사람이 쓴 세 줄은
 * 하나도 접히면 안 된다 — 접는 것은 반복이지 대화가 아니다.
 */
async function assertPausedNoticeFolded(page, where) {
  const seen = await page.evaluate(`(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid="timeline-message"]')
    );
    const notices = rows.filter((row) =>
      (row.textContent || "").includes("현재 일시정지되어 있습니다")
    );
    const repeat = document.querySelector(
      '[data-testid="paused-notice-repeat"]'
    );
    return {
      rows: rows.length,
      notices: notices.length,
      repeatText: repeat ? (repeat.textContent || "").trim() : null,
      bodies: rows.map((row) => (row.textContent || "").trim().slice(0, 40)),
    };
  })()`);

  if (seen.notices !== 1) {
    throw new Error(
      `[${where}] 서버는 「일시정지」 알림 3줄을 보냈는데 화면에 ${seen.notices}줄이 그려졌다 (1줄이어야 한다)`
    );
  }
  if (seen.repeatText !== "응답하지 못한 메시지 3개") {
    throw new Error(
      `[${where}] 접힌 개수를 말하지 않는다: ${JSON.stringify(seen.repeatText)}`
    );
  }
  // 사람이 쓴 6줄(초반 3 + 답 없이 보낸 3)은 전부 남아야 한다. 알림 1줄과 합쳐 7.
  if (seen.rows !== 7) {
    throw new Error(
      `[${where}] 접기가 대화를 먹었다: 행 ${seen.rows}개 (기대 7) — ${JSON.stringify(seen.bodies)}`
    );
  }
  console.log(`  paused notice ${where}: 3줄 → 1줄 + "${seen.repeatText}"`);
}

/**
 * 「답글 N개」가 **있어야 할 곳에만** 있는가 (goal P3 1-1 → goal RN-U2).
 *
 * 이 게이트는 두 번 움직였고, 두 번 다 같은 줄에 대한 것이었다.
 *
 * P3 1-1 은 그 줄이 **죽은 버튼**인 것을 잡았다: 패널이 `onOpenThread`를 넘기지
 * 않는데 행은 `rollup`만 있으면 <button>을 그려서, 포커스가 잡히고 hover에
 * 반응하면서 눌러도 아무 일이 없는 컨트롤이 스레드 루트에 앉아 있었다. 그 수정은
 * 버튼을 글로 내렸다.
 *
 * RN-U2 는 그 글마저 여기서는 할 말이 없다고 판정한다 — 성재(iOS 실기기): "답글에서
 * 개수 업데이트는 굳이 왜 해? 목록에 나오면 몇 개의 reply가 있는지는 자연스러운데,
 * 답글에서 '답글 1개' 이런 식으로 보이는 건 자연스럽지 않은 거 같아." 롤업은 목록의
 * 장치이고, 이미 그 스레드 안에 있는 사람에게는 정보가 0이다.
 *
 * 그래서 패널 쪽 판정이 **뒤집힌다**: 있으면 안 된다. 태그를 보던 자리는 텍스트를
 * 보는 자리가 되는데, 그것이 더 강하다 — <span>을 지웠는데 다른 조각이 같은 숫자를
 * 다시 그리는 회귀까지 잡는다.
 *
 * 반대쪽은 그대로다. 채널 타임라인에서는 그 자리가 **여전히 살아 있는 버튼**이어야
 * 한다. 스레드에서 지운다면서 목록의 진입점까지 지우면 스레드로 들어가는 길이
 * 사라지고, 그것이 이 배치가 만들 수 있는 가장 나쁜 회귀다.
 */
async function assertThreadRollupPlacement(page, where) {
  const seen = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="thread-panel"]');
    const inPanel = panel
      ? Array.from(panel.querySelectorAll('[data-testid="thread-anchor"]'))
      : [];
    const outside = Array.from(
      document.querySelectorAll('[data-testid="thread-anchor"]')
    ).filter((el) => !panel || !panel.contains(el));
    const shape = (el) => ({ tag: el.tagName, text: (el.textContent || "").trim() });
    return {
      hasPanel: Boolean(panel),
      inPanel: inPanel.map(shape),
      outside: outside.map(shape),
      // 패널 어디에도 개수 문장이 남아 있지 않은가. 앵커를 지우고 다른 자리에
      // 같은 숫자를 그리는 회귀를 잡는 것은 이쪽이다.
      panelCount: panel
        ? (panel.textContent || "").match(/답글\\s*\\d+\\s*개/)
        : null,
    };
  })()`);

  if (!seen.hasPanel) throw new Error(`[${where}] 스레드 패널이 열리지 않았다`);
  if (seen.inPanel.length > 0) {
    throw new Error(
      `[${where}] 스레드 패널에 아직 「${seen.inPanel[0].text}」가 있다 — 롤업은 목록의 장치이고 스레드 안에서는 정보가 0이다`
    );
  }
  if (seen.panelCount) {
    throw new Error(
      `[${where}] 스레드 패널이 여전히 답글 수를 말한다: 「${seen.panelCount[0]}」`
    );
  }
  if (seen.outside.length === 0) {
    throw new Error(
      `[${where}] 채널 타임라인에 「답글 N개」가 하나도 없다 — 이 게이트가 아무것도 재지 못했다`
    );
  }
  const live = seen.outside.filter((a) => a.tag === "BUTTON");
  if (live.length === 0) {
    throw new Error(
      `[${where}] 채널 타임라인의 「답글 N개」까지 사라졌다 — 스레드로 들어가는 길이 없다`
    );
  }
  console.log(
    `  thread rollup ${where}: 패널 0개 · 타임라인 ${live.length}개 버튼`
  );
}

/**
 * 호버 툴바가 지금 이 프레임에서 몇 개인지 (#1743).
 *
 * 기본/터치 프레임은 0, hover·포커스 프레임은 1. 비호버 행에 툴바가 남아
 * 있으면 opacity 트릭이 돌아온 것이고, 그게 B11 리버트의 원인이다.
 *
 * 피커가 닫히는 순간처럼 「포커스를 든 행 + 포인터 아래 행」이 갈리면 한
 * 프레임 2개가 보일 수 있다(계약은 hover 또는 focus 또는 overlay 이라
 * 모순은 아니다). 개수는 그 과도 상태가 잦아들 때까지 기다린 뒤에 판정한다.
 */
async function assertHoverToolbarCount(page, where, expected) {
  const deadline = Date.now() + 1000;
  let count = -1;
  while (Date.now() < deadline) {
    count = await page.evaluate(
      `document.querySelectorAll('[data-testid="message-hover-toolbar"]').length`
    );
    if (count === expected) break;
    await page.waitForTimeout(16);
  }
  if (count !== expected) {
    throw new Error(
      `[호버 툴바 ${where}] ${count}개가 마운트됐다 (기대 ${expected})`
    );
  }
  console.log(`  호버 툴바 ${where}: ${count}개`);
}

/**
 * 마운트된 툴바가 자기 행의 우측 거터를 지키는가 (#1743 M-3).
 *
 * 상단은 행 경계를 걸치므로(straddle) 행 상자 위로 나가도 된다. 가로는
 * 본문과 같은 16px 거터(`right-4`)를 지킨다. 본문 겹침은 아래
 * `assertHoverToolbarClearsBodyText`가 잰다.
 */
async function assertHoverToolbarPlacement(page, where) {
  const info = await page.evaluate(`(() => {
    const bars = Array.from(
      document.querySelectorAll('[data-testid="message-hover-toolbar"]')
    );
    return bars.map((bar) => {
      const row = bar.closest('[data-testid="timeline-message"]');
      if (!row) return { seq: null, within: false };
      const r = row.getBoundingClientRect();
      const t = bar.getBoundingClientRect();
      const fromRight = Math.round(r.right - t.right);
      return {
        seq: row.getAttribute('data-seq'),
        within:
          t.left >= r.left - 1 &&
          t.right <= r.right + 1,
        fromRight,
        fromTop: Math.round(t.top - r.top),
        gutterOk: Math.abs(fromRight - 16) <= 2,
      };
    });
  })()`);
  if (info.length === 0) {
    throw new Error(`[호버 툴바 ${where}] 잴 툴바가 없다`);
  }
  const stray = info.find((item) => !item.within);
  if (stray) {
    throw new Error(
      `[호버 툴바 ${where}] seq ${stray.seq}: 툴바가 행 상자를 가로로 벗어났다`
    );
  }
  const gutter = info.find((item) => !item.gutterOk);
  if (gutter) {
    throw new Error(
      `[호버 툴바 ${where}] seq ${gutter.seq}: 우측 거터 ${gutter.fromRight}px (기대 16px)`
    );
  }
  console.log(
    `  호버 툴바 위치 ${where}: ${info.length}개, 우측 ${info[0].fromRight}px · 상단 ${info[0].fromTop}px`
  );
}

/**
 * 툴바 상자 ∩ 본문 텍스트 Range = 0 (#1743 B-3, 이웃 행 N-2).
 *
 * 삭제된 `assertActionGutterClearsBody`의 후계. 상자 대 상자가 아니라
 * `data-row-body` 안의 글자 Range를 px로 잰다. 위 straddle은 위 행 아랫단,
 * 아래 뒤집기는 아래 행 윗단에 앉으므로 자기 행만이 아니라 바로 이웃도 본다.
 */
async function assertHoverToolbarClearsBodyText(page, where) {
  const info = await page.evaluate(`(() => {
    function intersects(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }
    function hitChars(barRect, body) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let chars = 0;
      let area = 0;
      let sample = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent || "";
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "\\n" || text[i] === " ") continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (!intersects(barRect, r)) continue;
          chars += 1;
          const w = Math.min(barRect.right, r.right) - Math.max(barRect.left, r.left);
          const h = Math.min(barRect.bottom, r.bottom) - Math.max(barRect.top, r.top);
          area += Math.max(0, w) * Math.max(0, h);
          if (sample.length < 24) sample += text[i];
        }
      }
      return { chars, area: Math.round(area), sample };
    }
    const allRows = Array.from(
      document.querySelectorAll('[data-testid="timeline-message"]')
    );
    const bars = Array.from(
      document.querySelectorAll('[data-testid="message-hover-toolbar"]')
    );
    return bars.map((bar) => {
      const row = bar.closest('[data-testid="timeline-message"]');
      if (!row) return { seq: null, chars: -1, area: -1, neighbor: null };
      const idx = allRows.indexOf(row);
      const neighbors = [allRows[idx - 1], allRows[idx + 1]].filter(Boolean);
      const t = bar.getBoundingClientRect();
      const bodies = [
        { seq: row.getAttribute("data-seq"), neighbor: "self", el: row.querySelector("[data-row-body]") },
        ...neighbors.map((n) => ({
          seq: n.getAttribute("data-seq"),
          neighbor: n === allRows[idx - 1] ? "prev" : "next",
          el: n.querySelector("[data-row-body]"),
        })),
      ].filter((item) => item.el);
      let worst = {
        seq: row.getAttribute("data-seq"),
        neighbor: "self",
        chars: 0,
        area: 0,
        sample: "",
        fromTop: Math.round(t.top - row.getBoundingClientRect().top),
        straddle: bar.getAttribute("data-straddle") || "",
      };
      for (const body of bodies) {
        const hit = hitChars(t, body.el);
        if (hit.chars > worst.chars) {
          worst = { ...worst, ...hit, seq: body.seq, neighbor: body.neighbor };
        }
      }
      return worst;
    });
  })()`);
  if (info.length === 0) {
    throw new Error(`[호버 툴바 본문 ${where}] 잴 툴바가 없다`);
  }
  const hit = info.find((item) => item.chars > 0);
  if (hit) {
    throw new Error(
      `[호버 툴바 본문 ${where}] seq ${hit.seq}(${hit.neighbor}): 본문 ${hit.chars}자(${hit.area}px²)를 덮는다 「${hit.sample}」`
    );
  }
  console.log(
    `  호버 툴바 본문 ${where}: ${info.length}개, 글자 교차 0(자기+이웃) · 상단 ${info[0].fromTop}px · straddle ${info[0].straddle || "top"}`
  );
}

/**
 * 리마인더 행 ⋯ 그릇 ∩ 본문 텍스트 Range = 0 (#1888 B-2).
 * 타임라인 `assertHoverToolbarClearsBodyText` 와 같은 자.
 */
async function assertReminderOverflowClearsBodyText(page, where) {
  const info = await page.evaluate(`(() => {
    function intersects(a, b) {
      return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    }
    function hitChars(barRect, body) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      let chars = 0;
      let area = 0;
      let sample = "";
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent || "";
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "\\n" || text[i] === " ") continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const r = range.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          if (!intersects(barRect, r)) continue;
          chars += 1;
          const w = Math.min(barRect.right, r.right) - Math.max(barRect.left, r.left);
          const h = Math.min(barRect.bottom, r.bottom) - Math.max(barRect.top, r.top);
          area += Math.max(0, w) * Math.max(0, h);
          if (sample.length < 24) sample += text[i];
        }
      }
      return { chars, area: Math.round(area), sample };
    }
    const bowls = Array.from(
      document.querySelectorAll('[data-testid="reminder-overflow-bowl"]')
    ).filter((bowl) => bowl.querySelector('[data-testid="reminder-row-menu"]'));
    return bowls.map((bowl) => {
      const row = bowl.closest('[data-testid="reminder-row"]');
      if (!row) return { chars: -1, area: -1, sample: "" };
      const t = bowl.getBoundingClientRect();
      const body = row.querySelector("[data-reminder-row-body]");
      const due = row.querySelector('[data-testid="reminder-row-due"]');
      let worst = { chars: 0, area: 0, sample: "", width: Math.round(t.width) };
      for (const el of [body, due].filter(Boolean)) {
        const hit = hitChars(t, el);
        if (hit.chars > worst.chars) worst = { ...worst, ...hit };
      }
      return worst;
    });
  })()`);
  if (info.length === 0) {
    throw new Error(`[리마인더 ⋯ 본문 ${where}] 잴 그릇이 없다`);
  }
  const hit = info.find((item) => item.chars > 0);
  if (hit) {
    throw new Error(
      `[리마인더 ⋯ 본문 ${where}] 본문 ${hit.chars}자(${hit.area}px²)를 덮는다 「${hit.sample}」`
    );
  }
  console.log(
    `  리마인더 ⋯ 본문 ${where}: ${info.length}개, 글자 교차 0 · 그릇 ${info[0].width}px`
  );
}

async function assertReminderKeyboardDelete(page, where) {
  const tab = page.getByTestId("inbox-tab-reminders");
  await tab.focus();
  let last = "";
  for (let i = 0; i < 24; i++) {
    await page.keyboard.press("Tab");
    const proof = await page.evaluate(`(() => {
      const el = document.activeElement;
      return {
        testId: el?.getAttribute("data-testid") || "",
        menu: document.querySelectorAll('[data-testid="reminder-row-menu"]').length,
      };
    })()`);
    last = proof.testId;
    if (proof.testId === "reminder-row-link" && proof.menu === 0) {
      await page
        .getByTestId("reminder-row-menu")
        .first()
        .waitFor({ state: "visible", timeout: 1_000 });
    }
    if (proof.testId === "reminder-row-menu") break;
  }
  if (last !== "reminder-row-menu") {
    throw new Error(
      `[리마인더 키보드 ${where}] ⋯에 닿지 못했다 (last=${last})`
    );
  }
  await page.keyboard.press("Enter");
  await page.getByTestId("reminder-row-menu-panel").waitFor({ state: "visible" });
  await page.getByTestId("reminder-row-delete").waitFor({ state: "visible" });
  await page.getByTestId("reminder-row-delete").press("Enter");
  await page.getByTestId("reminder-delete-dialog").waitFor({ state: "visible" });
  console.log(`  리마인더 키보드 지우기 ${where}: ⋯ Tab · 다이얼로그`);
}

/**
 * 행 하나가 키보드에 청구하는 값 (goal B11 R2 H1).
 *
 * B11이 행에 심은 컨트롤(진입점·반응 칩·반응 추가·스레드 앵커)만 센다. 카드
 * 안의 버튼(패치 열기 같은)은 이 배치가 만든 것이 아니고 행 액션도 아니므로
 * 세지 않는다 — 대신 아래 `countTabStopsToComposer`가 그것까지 포함한 실제
 * 비용을 잰다.
 *
 * 기준은 **행당 정확히 1**이다. rest 정거장은 행 자신이므로 OWNED에 행을
 * 편입한다. `opacity-0`으로만 숨긴 버튼은 눈에서만 사라지고 탭 순서에는
 * 그대로 남는다는 것이 1라운드의 결함이었으므로, 여기서는 보이는지가 아니라
 * `tabIndex`를 본다.
 */
async function assertRowTabStops(page, where, limit = 1) {
  const rows = await page.evaluate(`(() => {
    // 행 로빙 구성원(data-row-action) + 행 자신. 아바타, 칩, 툴바, overflow가
    // 여기 들어간다. 카드 안 버튼은 data-row-action이 아니라 세지 않는다.
    const OWNED = '[data-row-action]';
    const isStop = (el) => {
      if (el.hasAttribute('disabled')) return false;
      // display:none 은 폭도 높이도 0이다. opacity-0 은 여전히 탭 스톱이고,
      // 그것이 정확히 이 게이트가 잡아야 하는 상태다.
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      return el.tabIndex >= 0;
    };
    return Array.from(document.querySelectorAll('[data-testid="timeline-message"]'))
      .map((row) => {
        const box = row.getBoundingClientRect();
        const owned = [row, ...row.querySelectorAll(OWNED)];
        const stops = owned.filter(isStop);
        return {
          seq: row.getAttribute('data-seq'),
          stops: stops.length,
          controls: row.querySelectorAll(OWNED).length,
          visible: box.width > 0 && box.height > 0,
        };
      });
  })()`);
  const visible = rows.filter((row) => row.visible);
  if (visible.length === 0) {
    throw new Error(`[탭 스톱 ${where}] 상자 있는 행이 없다`);
  }
  const worst = visible.reduce(
    (a, b) => (b.stops > a.stops ? b : a),
    { seq: null, stops: 0, controls: 0 }
  );
  if (worst.stops > limit) {
    throw new Error(
      `[탭 스톱 ${where}] seq ${worst.seq}: 컨트롤 ${worst.controls}개 중 ${worst.stops}개가 탭 순서에 있다 (행당 ${limit}개 이하)`
    );
  }
  const empty = visible.find((row) => row.stops === 0);
  if (empty) {
    throw new Error(
      `[탭 스톱 ${where}] seq ${empty.seq}: 행 정거장이 0이다 (행당 정확히 1)`
    );
  }
  const controls = visible.reduce((sum, r) => sum + r.controls, 0);
  const stops = visible.reduce((sum, r) => sum + r.stops, 0);
  console.log(
    `  탭 스톱 ${where}: ${visible.length}행에 행 컨트롤 ${controls}개, 탭 스톱 ${stops}개 (행당 정확히 ${worst.stops})`
  );
}

/**
 * 본문 드래그 선택이 핸드오프에 죽지 않는가 (#1743 B-4).
 *
 * actionable 행은 rest 정거장이 행 자신이라 mousedown이 행을 포커스한다.
 * 핸드오프가 `:focus-visible`이 아닌 포커스에도 ⋯로 옮기면 Chrome이 선택을
 * 접는다. 이 레인은 그 축을 실측한다: 선택 문자열 비공허, ⋯ 미탈취,
 * 행 안 `:focus-visible` 링 없음.
 */
async function assertActionableRowDragSelect(page, where) {
  const box = await page.evaluate(`(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid="timeline-message"][data-actionable="true"]')
    );
    for (const row of [...rows].reverse()) {
      const body = row.querySelector("[data-row-body]");
      if (!body) continue;
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (node.parentElement && node.parentElement.closest('[data-testid="unfurl-card"]')) {
          continue;
        }
        const text = node.textContent || "";
        if (text.trim().length < 8) continue;
        const range = document.createRange();
        const from = text.search(/\\S/);
        const start = from < 0 ? 0 : from;
        const end = Math.min(text.length, start + 32);
        if (end - start < 8) continue;
        range.setStart(node, start);
        range.setEnd(node, end);
        const r = range.getBoundingClientRect();
        if (r.width < 24 || r.height < 4) continue;
        return {
          seq: row.getAttribute("data-seq"),
          x: r.left + 2,
          y: r.top + r.height / 2,
          x2: r.right - 2,
          y2: r.top + r.height / 2,
        };
      }
    }
    return null;
  })()`);
  if (!box) {
    throw new Error(`[드래그 선택 ${where}] 본문이 있는 actionable 행이 없다`);
  }
  await page.evaluate(`document.getSelection() && document.getSelection().removeAllRanges()`);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  await page.mouse.move(box.x2, box.y2, { steps: 12 });
  await page.mouse.up();
  const proof = await page.evaluate(`(() => {
    const sel = document.getSelection();
    const text = sel ? sel.toString() : "";
    const active = document.activeElement;
    const row = active && active.closest
      ? active.closest('[data-testid="timeline-message"]')
      : null;
    const scanned = row
      ? [row, ...row.querySelectorAll("*")]
      : [];
    const focusVisible = scanned.some((el) => {
      try { return el.matches(":focus-visible"); } catch { return false; }
    });
    return {
      text,
      collapsed: !sel || sel.isCollapsed,
      activeTestId: active
        ? (active.getAttribute("data-testid") || active.tagName)
        : "",
      focusVisible,
    };
  })()`);
  if (!proof.text || !proof.text.trim()) {
    throw new Error(
      `[드래그 선택 ${where}] seq ${box.seq}: 선택 문자열이 비었다 ` +
        `(active=${proof.activeTestId}, collapsed=${proof.collapsed})`
    );
  }
  if (proof.activeTestId === "message-actions-trigger") {
    throw new Error(
      `[드래그 선택 ${where}] seq ${box.seq}: 선택이 ⋯로 탈취됐다`
    );
  }
  if (proof.focusVisible) {
    throw new Error(
      `[드래그 선택 ${where}] seq ${box.seq}: 포인터 경로에 :focus-visible 링이 있다 ` +
        `(active=${proof.activeTestId})`
    );
  }
  console.log(
    `  드래그 선택 ${where}: seq ${box.seq} 「${proof.text.slice(0, 48)}」 · ` +
      `active=${proof.activeTestId} · fv=false`
  );
}

/**
 * 툴바 상자가 스크롤러 안에 있는가 (#1743 H-4).
 * 최상단 행 레인은 뒤집힌 straddle(`below`)까지 요구한다.
 */
async function assertHoverToolbarInsideScroller(page, where, expectedStraddle) {
  const info = await page.evaluate(`(() => {
    const bar = document.querySelector('[data-testid="message-hover-toolbar"]');
    if (!bar) return null;
    const scroller =
      bar.closest("[data-message-scroll-container]") ||
      bar.closest("[data-virtuoso-scroller]") ||
      bar.closest('[data-testid="timeline-virtuoso"]');
    if (!scroller) return { missing: "scroller" };
    const t = bar.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    const slack = 1;
    const row = bar.closest('[data-testid="timeline-message"]');
    return {
      seq: row ? row.getAttribute("data-seq") : null,
      barTop: Math.round(t.top),
      barBottom: Math.round(t.bottom),
      scrollerTop: Math.round(s.top),
      scrollerBottom: Math.round(s.bottom),
      straddle: bar.getAttribute("data-straddle") || "",
      inside: t.top >= s.top - slack && t.bottom <= s.bottom + slack,
    };
  })()`);
  if (!info || info.missing) {
    throw new Error(`[호버 툴바 스크롤러 ${where}] 툴바 또는 스크롤러가 없다`);
  }
  if (!info.inside) {
    throw new Error(
      `[호버 툴바 스크롤러 ${where}] seq ${info.seq}: 툴바 ${info.barTop}–${info.barBottom}` +
        ` 가 스크롤러 ${info.scrollerTop}–${info.scrollerBottom} 밖 (straddle ${info.straddle})`
    );
  }
  if (expectedStraddle && info.straddle !== expectedStraddle) {
    throw new Error(
      `[호버 툴바 스크롤러 ${where}] seq ${info.seq}: straddle=${info.straddle} ` +
        `(기대 ${expectedStraddle}) · 툴바 상단 ${info.barTop} vs 스크롤러 ${info.scrollerTop}`
    );
  }
  console.log(
    `  호버 툴바 스크롤러 ${where}: seq ${info.seq} inside · straddle ${info.straddle}` +
      ` · 툴바 ${info.barTop} / 스크롤러 ${info.scrollerTop}`
  );
}

/**
 * 스레드 패널의 첫 행은 채널 Virtuoso가 아니라 패널 자체 스크롤러 바로 아래에 선다
 * (#1753). 그 행을 실제로 hover해 툴바가 아래로 뒤집히고, 패널 안에 온전히 남으며,
 * 루트·답글 어느 글자도 덮지 않는지를 한 프레임에서 잰다.
 */
async function assertThreadRootHoverToolbar(page, where) {
  const panel = page.getByTestId("thread-panel");
  const root = panel.getByTestId("timeline-message").first();
  await root.hover();
  await root
    .getByTestId("message-hover-toolbar")
    .waitFor({ state: "visible" });

  const proof = await page.evaluate(`(() => {
    const panel = document.querySelector('[data-testid="thread-panel"]');
    const scroller = panel?.querySelector('[data-message-scroll-container]');
    const root = panel?.querySelector('[data-testid="timeline-message"]');
    const bar = root?.querySelector('[data-testid="message-hover-toolbar"]');
    if (!panel || !scroller || !root || !bar) return null;

    const intersects = (a, b) =>
      a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const barRect = bar.getBoundingClientRect();
    const scrollRect = scroller.getBoundingClientRect();
    let chars = 0;
    let sample = "";
    for (const body of panel.querySelectorAll('[data-row-body]')) {
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const text = node.textContent || "";
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "\\n" || text[i] === " ") continue;
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          const rect = range.getBoundingClientRect();
          if ((rect.width > 0 || rect.height > 0) && intersects(barRect, rect)) {
            chars += 1;
            if (sample.length < 24) sample += text[i];
          }
        }
      }
    }
    const slack = 1;
    return {
      seq: root.getAttribute("data-seq"),
      straddle: bar.getAttribute("data-straddle") || "",
      inside:
        barRect.top >= scrollRect.top - slack &&
        barRect.bottom <= scrollRect.bottom + slack &&
        barRect.left >= scrollRect.left - slack &&
        barRect.right <= scrollRect.right + slack,
      chars,
      sample,
      barTop: Math.round(barRect.top),
      barBottom: Math.round(barRect.bottom),
      scrollTop: Math.round(scrollRect.top),
      scrollBottom: Math.round(scrollRect.bottom),
    };
  })()`);

  if (!proof) {
    throw new Error(`[스레드 루트 호버 ${where}] 패널·루트·툴바·스크롤러 중 하나가 없다`);
  }
  if (!proof.inside || proof.straddle !== "below") {
    throw new Error(
      `[스레드 루트 호버 ${where}] seq ${proof.seq}: 툴바 ${proof.barTop}–${proof.barBottom}` +
        ` / 스크롤러 ${proof.scrollTop}–${proof.scrollBottom} / straddle ${proof.straddle}`
    );
  }
  if (proof.chars > 0) {
    throw new Error(
      `[스레드 루트 호버 ${where}] 본문 ${proof.chars}자를 덮는다 「${proof.sample}」`
    );
  }
  console.log(
    `  스레드 루트 호버 ${where}: 패널 안쪽 · 글자 교차 0 · straddle below`
  );
}

async function pinActionableRowToScrollerTop(page) {
  return page.evaluate(async () => {
    const frame = () =>
      new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (!done) {
            done = true;
            resolve();
          }
        };
        requestAnimationFrame(() => setTimeout(finish, 0));
        setTimeout(finish, 50);
      });
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return null;
    scroller.scrollTop = 0;
    for (let i = 0; i < 12; i++) await frame();
    const rows = Array.from(
      document.querySelectorAll(
        '[data-testid="timeline-message"][data-actionable="true"]'
      )
    );
    const row = rows[0];
    if (!row) return null;
    const delta =
      row.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    scroller.scrollTop += delta;
    for (let i = 0; i < 8; i++) await frame();
    const still = document.querySelector(
      `[data-testid="timeline-message"][data-seq="${row.getAttribute("data-seq")}"]`
    );
    if (!still) return row.getAttribute("data-seq");
    const fix =
      still.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
    if (Math.abs(fix) > 1) scroller.scrollTop += fix;
    await frame();
    return still.getAttribute("data-seq");
  });
}

/**
 * 타임라인 첫 컨트롤에서 컴포저까지, **진짜 Tab을 눌러서** 센다.
 *
 * 리뷰가 쓴 숫자(가상 목록 15~25행이면 60~150 스톱)와 같은 자다. 정적 계산이
 * 아니라 실제 키 입력이므로, 탭 순서에 대한 어떤 가정도 끼어들지 못한다.
 */
async function countTabStopsToComposer(page, where, ceiling) {
  const started = await page.evaluate(`(() => {
    const first = document.querySelector(
      '[data-testid="timeline-message"] [data-row-action][tabindex="0"]'
    );
    if (!first) return false;
    first.focus();
    return document.activeElement === first;
  })()`);
  if (!started) {
    throw new Error(`[탭 경로 ${where}] 타임라인에 시작점이 없다`);
  }
  const max = ceiling * 4;
  for (let presses = 1; presses <= max; presses++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(
      `document.activeElement ? (document.activeElement.getAttribute("data-testid") || "") : ""`
    );
    if (id === "composer-input") {
      if (presses > ceiling) {
        throw new Error(
          `[탭 경로 ${where}] 타임라인에서 컴포저까지 Tab ${presses}번 (상한 ${ceiling}번)`
        );
      }
      console.log(`  탭 경로 ${where}: 타임라인 → 컴포저 Tab ${presses}번`);
      return presses;
    }
  }
  throw new Error(
    `[탭 경로 ${where}] Tab을 ${max}번 눌러도 컴포저에 닿지 못했다`
  );
}

/**
 * 가상 목록 안의 행을 화면에 올린다 — **못 올렸으면 여기서, 이유를 말하고** 죽는다.
 *
 * `locator.scrollIntoViewIfNeeded()`를 쓰지 않는 이유가 있다: react-virtuoso는
 * 스크롤이 부른 재렌더에서 행의 DOM 노드를 **교체**하고, Playwright가 "요소가
 * 안정될 때까지" 기다리는 사이 그 노드가 떨어져 나가면 액션이 그대로 죽는다
 * (`Element is not attached to the DOM`). 노드의 정체성은 이 프레임이 증명하려는
 * 것과 아무 상관이 없고 필요한 것은 "그 행이 보이는가" 하나뿐이므로, 페이지
 * 안에서 스크롤하고 결과를 다시 묻는다.
 *
 * ── goal QA-flake: 이 함수가 `capture:design` 플레이크 1종이었다 ─────────────
 *
 * 실측(base `03fbdb81`, 8회): 3 PASS / 5 FAIL, 그 중 4회가
 * `[스크롤] turn-failure를 6번 시도해도 화면에 올리지 못했다`.
 *
 * 원인은 재시도가 모자라서가 **아니었다. 재시도가 아무 일도 하지 않았기
 * 때문이다.** 이전 판의 루프는 이것이었다:
 *
 *     for (6번) { const el = querySelector(testId);
 *                 if (!el) …아무것도 하지 않는다;
 *                 await waitForTimeout(250); }
 *
 * 행이 렌더 창 밖에 있으면 `querySelector`는 null을 답하고, 그 뒤 이 루프가 한
 * 일은 250ms를 기다린 것뿐이다. **가상 목록은 시간이 지난다고 행을 마운트하지
 * 않는다 — 스크롤러가 움직여야 마운트한다.** 그러니 이 루프는 1.5초를 태우고
 * 같은 null을 여섯 번 본 뒤 죽는, 원리적으로 성공할 수 없는 루프였다. 통과한
 * 회차는 루프가 고친 회차가 아니라 **행이 아직 창 안에 남아 있던** 회차다.
 * (그래서 `tries`를 늘리는 것은 고치는 것이 아니라 같은 null을 더 오래 보는
 * 것이다.)
 *
 * 그러면 행은 왜 사라져 있었나. 이전 판이 `turn-failure`를 묻는 바로 그 순간부터
 * 4초를 50ms 간격으로 80번 표본해 봤다:
 *
 *   실패한 회차: `turn-failure` **없음(80/80)** · 마운트된 항목 index
 *                1000000~1000012 (목록의 **머리**) · scrollTop **0**
 *   통과한 회차: `turn-failure` 있음(80/80) · index 1000004~1000018 (꼬리)
 *                · scrollTop 813
 *
 * 즉 실패한 회차의 타임라인은 **맨 위에 앉아 있었다**. 바로 앞 단계가
 * `message-markdown`을 가운데로 올렸는데 그 스크롤이 남아 있지 않은 것이다
 * (`Timeline`은 `initialItemCount={min(items.length,24)}`로 열려 첫 페인트에는
 * 전 행이 DOM에 있고, 그 뒤 측정 보정과 `startReached`가 스크롤 위치를 다시
 * 잡는다). `turn-failure`는 꼬리 행이므로 머리에 앉은 창의 밖이고, 아무도
 * 스크롤러를 건드리지 않는 한 **영원히** 밖이다 — 80번을 봐도 없었다는 것이 그
 * 뜻이고, 여섯 번 더 본다고 달라질 것이 아니었다.
 *
 * 그런데 바로 앞 단계는 왜 통과했나. 이전 판의 성공 조건이 `isVisible()`이었기
 * 때문이다. Playwright의 `isVisible()`은 "상자가 있고 `visibility:hidden`이
 * 아니다"이지 **"화면 안에 있다"가 아니다** — 창 밖으로 스크롤된 마운트된 노드도
 * 참을 답한다. 그래서 앞 단계는 "행이 마운트돼 있다"를 "행이 내가 둔 자리에
 * 있다"로 잘못 읽고 돌아왔고, 목록이 그 뒤 머리로 돌아가는 것을 보지 못했다.
 *
 * 고치는 자리도 그래서 둘이다: 성공 조건을 **자리(rect)가 멎는 것**으로 바꾸고,
 * 행이 없을 때는 **스크롤러를 실제로 움직인다**.
 *
 * 확인해 둔다: 이 프레임의 **피사체는 이 빌드에 그대로 있다**. `BODIES`의 마지막
 * 줄이 `agent_worker.provider_failure.v0`이고, `makeMessages(16)`에서 그 줄은
 * `rows[14]`이며, B11 픽스처 편집기(`pick(4)/pick(3)/pick(1)` = `rows[12]`
 * `rows[13]` `rows[15]`)는 `plainText` 가드 때문에 그 행을 건드리지 못한다.
 * P3의 인박스 프레임과 달리 여기서 없어진 것은 피사체가 아니라 **기다림**이었고,
 * 그래서 프레임은 그대로 두고 재는 방법만 고쳤다.
 *
 * 그래서 이제:
 *  1. 첫 페인트의 정리가 끝나도록 한 프레임 양보한 뒤 본다 — "지금 있다"가 곧
 *     거짓이 되는 순간에 판단하지 않기 위해서다.
 *  2. 없으면 스크롤러를 **아래에서 위로 반 화면씩 실제로 훑는다**. 마운트되지
 *     않은 행에 닿는 방법은 스크롤 범위를 지나가는 것뿐이고, 걸음 수는
 *     scrollHeight/step으로 유한하다. 아래에서 시작하는 것은 이 하네스가 찾는
 *     행이 전부 최근 꼬리에 있고 타임라인이 바닥에 붙어 열리기 때문이다.
 *  3. 찾으면 가운데로 올린 뒤 **자리가 멎을 때까지** 기다린다. virtuoso는 스크롤
 *     뒤 재측정으로 위치를 보정하므로, 고정 250ms는 보정 중인 화면을 찍는다.
 *  4. 그래도 못 찾으면 **여기서** 죽되, 세 가지를 갈라 말한다:
 *     ① 전 범위를 훑었는데 없었다 → 그 행은 이 빌드에 없다(= 프레임을 제품
 *        사실에 맞출 차례지, 더 기다릴 일이 아니다).
 *     ② 걸음 상한에 걸렸다 → 훑기가 끝나지 않았다.
 *     ③ 찾았는데 자리가 멎지 않았다 → 목록이 계속 움직인다.
 *     어느 쪽이든 그때 화면에 무엇이 있었는지(마운트된 항목 범위·행 수·스크롤러
 *     기하)를 함께 적는다. 이전 메시지는 그 셋을 구분하지 못했고, 그래서 원인
 *     지점과 증상 지점이 200줄 떨어져 있었다.
 */
async function scrollTimelineRowIntoView(page, testId, where = "") {
  const label = where ? `${testId} · ${where}` : testId;
  const seen = await page.evaluate(
    async ({ testId, maxSteps }) => {
      // 한 프레임 양보. rAF는 보이지 않는 탭에서 멈출 수 있으므로 상한을 함께
      // 건다 — 대기로 때우는 값이 아니라 rAF가 오지 않을 때의 안전망이다.
      const frame = () =>
        new Promise((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          requestAnimationFrame(() => setTimeout(finish, 0));
          setTimeout(finish, 50);
        });

      const find = () => document.querySelector(`[data-testid="${testId}"]`);
      const scrollers = () =>
        Array.from(
          new Set([
            ...document.querySelectorAll("[data-virtuoso-scroller]"),
            ...document.querySelectorAll('[data-testid="timeline-virtuoso"]'),
          ])
        ).filter((el) => el.clientHeight > 0);

      const report = (extra) => {
        const mounted = Array.from(
          document.querySelectorAll("[data-item-index]")
        ).map((el) => Number(el.getAttribute("data-item-index")));
        return {
          scrollers: scrollers().map((el) => ({
            top: Math.round(el.scrollTop),
            height: Math.round(el.scrollHeight),
            client: Math.round(el.clientHeight),
          })),
          mountedFrom: mounted.length ? Math.min(...mounted) : null,
          mountedTo: mounted.length ? Math.max(...mounted) : null,
          mountedCount: mounted.length,
          rows: document.querySelectorAll('[data-testid="timeline-message"]')
            .length,
          ...extra,
        };
      };

      await frame();

      let steps = 0;
      let ceiling = false;
      let scanned = false;
      if (!find()) {
        scanned = true;
        for (const scroller of scrollers()) {
          scroller.scrollTop = scroller.scrollHeight;
          await frame();
          for (;;) {
            if (find()) break;
            if (scroller.scrollTop <= 0) break;
            if (steps >= maxSteps) {
              ceiling = true;
              break;
            }
            const step = Math.max(120, Math.round(scroller.clientHeight * 0.6));
            scroller.scrollTop = Math.max(0, scroller.scrollTop - step);
            steps++;
            await frame();
          }
          if (find() || ceiling) break;
        }
      }

      const el = find();
      if (!el) return report({ ok: false, steps, ceiling, scanned });

      // 가운데로 올리고, 같은 자리에 세 프레임 연속으로 앉을 때까지 기다린다.
      el.scrollIntoView({ block: "center" });
      let key = null;
      let stable = 0;
      for (let i = 0; i < 60 && stable < 3; i++) {
        await frame();
        const now = find();
        if (!now) {
          key = null;
          stable = 0;
          continue;
        }
        const rect = now.getBoundingClientRect();
        if (rect.height <= 0) {
          stable = 0;
          continue;
        }
        const next = `${Math.round(rect.top)}:${Math.round(rect.height)}`;
        if (next === key) stable++;
        else {
          key = next;
          stable = 0;
        }
      }
      if (stable < 3) {
        return report({ ok: false, steps, ceiling, scanned, unsettled: true });
      }
      return report({ ok: true, steps, ceiling, scanned });
    },
    { testId, maxSteps: 400 }
  );

  const scene =
    `마운트된 항목 ${seen.mountedCount}개` +
    (seen.mountedFrom === null
      ? ""
      : ` (index ${seen.mountedFrom}~${seen.mountedTo})`) +
    ` · timeline-message ${seen.rows}행 · 스크롤러 ${JSON.stringify(seen.scrollers)}`;

  if (seen.ok) {
    const how = seen.scanned
      ? `창 밖에 있어 스크롤러를 ${seen.steps}걸음 훑어 올림`
      : "이미 창 안";
    console.log(`  스크롤 ${label}: ${how} · ${scene}`);
    return;
  }
  if (seen.unsettled) {
    throw new Error(
      `[스크롤] ${label}: 행을 찾아 가운데로 올렸는데 자리가 멎지 않았다 — ${scene}`
    );
  }
  if (seen.ceiling) {
    throw new Error(
      `[스크롤] ${label}: 스크롤러를 ${seen.steps}걸음 훑고도 끝에 닿지 못했다 — ${scene}`
    );
  }
  throw new Error(
    `[스크롤] ${label}: 스크롤러 전 범위를 ${seen.steps}걸음으로 훑었는데 ` +
      `\`[data-testid="${testId}"]\`가 한 번도 마운트되지 않았다. ` +
      `기다림이 모자란 것이 아니라 **이 빌드에 그 행이 없다** — 픽스처가 그 행을 ` +
      `내보내는지, 제품이 아직 그 행을 그리는지부터 확인해라 (P3 인박스 프레임과 같은 종류). ` +
      `— ${scene}`
  );
}

/**
 * 포커스가 **멎은 뒤에** 읽는다 (goal QA-flake — `capture:design` 플레이크 2종 중 둘째).
 *
 * 실측(base `03fbdb81`, 8회 중 1회):
 *   `[메뉴 dark] 방향키가 항목 사이를 돌지 않는다 (menu-react-👍 → menu-react-👍)`
 * 방향키를 눌렀는데 포커스가 그대로였다는 고발이다. 그런데 **제품은 돌고 있었다.**
 *
 * 원인은 Radix에 있다. `@radix-ui/react-roving-focus`의 항목 keydown 핸들러는
 * 후보를 고른 뒤 마지막 줄이 이것이다:
 *
 *     setTimeout(() => focusFirst(candidateNodes));
 *
 * **포커스 이동은 다음 매크로태스크에서 일어난다.** 그런데
 * `keyboard.press("ArrowDown")`은 키 이벤트를 보낸 시점에 끝나고, 바로 뒤따르는
 * `evaluate`는 그 타이머와 경주한다. 대개 타이머가 이기지만 메인 스레드가 렌더로
 * 붐비면 CDP 평가가 먼저 들어와 **옮기기 전의 포커스**를 읽는다. 그래서 이 단언은
 * 멀쩡한 메뉴를 두고 회차마다 붉었다 — 이것이 두 번째 비결정 실패였다.
 *
 * 고치는 방향은 대기를 늘리는 쪽이 아니라 **표본을 조건으로 바꾸는** 쪽이다.
 * 여기서는 "포커스가 이 메뉴의 항목에 앉았고 `not`이 아니다"가 참이 될 때까지
 * 기다렸다가 그 값을 읽는다. 고정 대기가 없으므로 통과하는 회차는 느려지지
 * 않고, 정말로 돌지 않으면 그때는 진짜 결함이며 — 아래 메시지가 그 순간 무엇이
 * 포커스를 쥐고 있었는지, 메뉴가 열려 있기는 했는지, 항목이 몇 개였는지 말한다.
 */
async function focusedMenuItem(
  page,
  where,
  { not = null, menu = "message-action-menu" } = {}
) {
  try {
    const handle = await page.waitForFunction(
      ({ not, menu }) => {
        const content = document.querySelector(`[data-testid="${menu}"]`);
        const el = document.activeElement;
        if (!content || !el || !content.contains(el)) return null;
        if (el.getAttribute("role") !== "menuitem") return null;
        const testId =
          el.getAttribute("data-testid") || el.tagName.toLowerCase();
        if (not !== null && testId === not) return null;
        return {
          testId,
          items: content.querySelectorAll('[role="menuitem"]').length,
        };
      },
      { not, menu },
      { timeout: 5_000, polling: 50 }
    );
    return await handle.jsonValue();
  } catch {
    const scene = await page.evaluate(
      ({ menu }) => {
        const content = document.querySelector(`[data-testid="${menu}"]`);
        const el = document.activeElement;
        return {
          open: Boolean(content),
          focus: el
            ? el.getAttribute("data-testid") || el.tagName.toLowerCase()
            : "(없음)",
          role: el ? el.getAttribute("role") : null,
          inMenu: Boolean(content) && Boolean(el) && content.contains(el),
          items: content
            ? Array.from(content.querySelectorAll('[role="menuitem"]')).map(
                (item) => item.getAttribute("data-testid")
              )
            : [],
        };
      },
      { menu }
    );
    throw new Error(
      `[${where}] ` +
        (not === null
          ? "메뉴가 열렸는데 5초 동안 포커스가 항목에 앉지 않았다"
          : `방향키를 눌렀는데 5초 동안 포커스가 ${not}에서 움직이지 않았다`) +
        ` — 메뉴 ${scene.open ? "열림" : "닫힘"}, 포커스=${scene.focus}` +
        `(role=${scene.role ?? "없음"}, 메뉴 안=${scene.inMenu}), ` +
        `항목 ${scene.items.length}개 [${scene.items.join(", ")}]`
    );
  }
}

/**
 * 포커스가 그 컨트롤에 **돌아올 때까지** 기다린다.
 *
 * `focusedMenuItem`과 같은 이유다: Radix는 닫힐 때 `onCloseAutoFocus`로 진입점에
 * 포커스를 되돌리는데 그 복원도 즉시가 아니다. 200ms를 재고 한 번 표본을 뜨면
 * 같은 종류의 거짓 실패가 언제든 다시 난다.
 */
async function waitForFocus(page, testId, where, note) {
  try {
    await page.waitForFunction(
      (id) => document.activeElement?.getAttribute("data-testid") === id,
      testId,
      { timeout: 5_000, polling: 50 }
    );
  } catch {
    const returned = await page.evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return "(없음)";
      return el.getAttribute("data-testid") || el.tagName.toLowerCase();
    })()`);
    throw new Error(
      `[${where}] ${note} — 5초를 기다려도 포커스가 ${returned}에 남았다 (기대 ${testId})`
    );
  }
}

async function assertCopiedClipboard(page, where, expected) {
  const text = await page.evaluate(() => navigator.clipboard.readText());
  if (text !== expected) {
    throw new Error(
      `[${where}] 클립보드 ${JSON.stringify(text)} ≠ ${JSON.stringify(expected)}`
    );
  }
  return text;
}

/**
 * 제품이 클립보드에 넣은 공유 링크를 읽는다. URL 모양을 여기서 다시 적지 않는다
 * (사본이 초록인 채 링크만 죽는 자리 — design-review #1764 M-3).
 */
async function readCopiedShareUrl(page, where, { messageId, seq }) {
  const text = await page.evaluate(() => navigator.clipboard.readText());
  if (!text.startsWith(`${ORIGIN}/#/c/${GENERAL_ID}?`)) {
    throw new Error(`[${where}] 공유 링크가 이 서버 origin이 아니다: ${text}`);
  }
  if (!text.includes(`msg=${String(messageId).toLowerCase()}`)) {
    throw new Error(`[${where}] 공유 링크에 msg가 없다: ${text}`);
  }
  if (seq !== undefined && seq !== null && !text.includes(`seq=${seq}`)) {
    throw new Error(`[${where}] 공유 링크에 seq가 없다: ${text}`);
  }
  if (text.includes("tauri://")) {
    throw new Error(`[${where}] 공유 링크가 번들 origin을 싣고 있다: ${text}`);
  }
  return text;
}

async function scrollTimelineToBottom(page) {
  await page.evaluate(async () => {
    const frame = () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => setTimeout(resolve, 0));
      });
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    for (let i = 0; i < 8; i++) await frame();
  });
}

/**
 * 이미 열린 채널의 렌더된 행에서, **뷰포트 위쪽**(채널이 바닥에 붙어 열리면
 * 안 보이는 머리) 행을 고른다. 픽스처 id를 다시 적지 않는다 — 그 숫자를
 * 고치면 자가 조용히 공허해진다 (design-review #1764 R2-H1 · 정본 §5.5①).
 */
async function pickOffscreenShareTarget(page, where) {
  await scrollTimelineToBottom(page);
  const picked = await page.evaluate(() => {
    const vh = window.innerHeight;
    const rows = [
      ...document.querySelectorAll('[data-testid="timeline-message"]'),
    ].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        id: el.getAttribute("data-message-id"),
        seq: el.getAttribute("data-seq"),
        top: r.top,
        bottom: r.bottom,
        height: r.height,
        actionable: el.getAttribute("data-actionable") === "true",
      };
    });
    const above = rows.filter(
      (row) => row.id && row.actionable && row.bottom <= 0
    );
    const seqs = rows
      .map((row) => Number(row.seq))
      .filter((n) => Number.isFinite(n));
    return {
      target: above[0] ?? null,
      oldestSeq: seqs.length ? Math.min(...seqs) : null,
      present: rows.map((row) => row.id).filter(Boolean),
      vh,
      rowCount: rows.length,
      aboveCount: above.length,
    };
  });
  if (!picked.target) {
    throw new Error(
      `[${where}] 뷰포트 위에 있는 행이 없다 ` +
        `(렌더 ${picked.rowCount}행 위쪽 ${picked.aboveCount} vh=${picked.vh}) — ` +
        `바닥 행을 재면 착지를 못 잰다`
    );
  }
  return picked;
}

/** 제품이 낸 공유 링크의 채널/origin을 지키고 msg/seq만 갈아 끼운다. */
function shareUrlForTarget(productShareUrl, { messageId, seq }) {
  const [beforeHash, hash = ""] = productShareUrl.split("#");
  const qIndex = hash.indexOf("?");
  const path = qIndex >= 0 ? hash.slice(0, qIndex) : hash;
  const params = new URLSearchParams(qIndex >= 0 ? hash.slice(qIndex + 1) : "");
  params.set("msg", String(messageId).toLowerCase());
  if (seq !== undefined && seq !== null && seq !== "") {
    params.set("seq", String(seq));
  } else {
    params.delete("seq");
  }
  return `${beforeHash}#${path}?${params}`;
}

async function openColdSharePage(context, url) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "networkidle" });
  return page;
}

/**
 * 복사된 URL을 **콜드 새 페이지**에서 열어 대상 행에 착지하는지 잰다.
 * 대상은 채널이 저절로 보여 주지 않는 행이어야 한다 — 바닥 행은 점프 없이도
 * 보이므로 그 자리의 초록은 공허하다 (R2-B1 / R2-H1).
 * 화면 안 판정은 위·아래 경계를 함께 본다 (R2-N2).
 */
async function assertShareUrlLands(context, productShareUrl, sourcePage, where) {
  const picked = await pickOffscreenShareTarget(sourcePage, where);
  const landingUrl = shareUrlForTarget(productShareUrl, {
    messageId: picked.target.id,
    seq: picked.target.seq,
  });
  const landing = await openColdSharePage(context, landingUrl);
  try {
    await landing
      .getByTestId("timeline-message")
      .first()
      .waitFor({ state: "visible", timeout: 8_000 });
    try {
      await landing.waitForFunction(
        (id) => {
          const el = document.querySelector(
            `[data-testid="timeline-message"][data-message-id="${id}"]`
          );
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const inView =
            r.top >= 0 && r.bottom <= window.innerHeight && r.height > 0;
          // 워처가 착지 행에 얹는 클래스 (`anchor.ts` HIGHLIGHT_CLASS).
          return inView && el.classList.contains("bg-accent-soft");
        },
        picked.target.id,
        { timeout: 8_000 }
      );
    } catch (error) {
      const dump = await landing.evaluate((id) => {
        const el = document.querySelector(
          `[data-testid="timeline-message"][data-message-id="${id}"]`
        );
        const region = document.querySelector(".chat-region");
        const banner = document.querySelector(
          '[data-testid="chat-anchor-missed"]'
        );
        const rows = [
          ...document.querySelectorAll('[data-testid="timeline-message"]'),
        ].map((row) => {
          const r = row.getBoundingClientRect();
          return {
            id: row.getAttribute("data-message-id"),
            seq: row.getAttribute("data-seq"),
            top: Math.round(r.top),
            bottom: Math.round(r.bottom),
            highlight: row.classList.contains("bg-accent-soft"),
          };
        });
        return {
          href: location.href,
          hash: location.hash,
          anchorMsg: region?.getAttribute("data-url-anchor-msg"),
          anchorSeq: region?.getAttribute("data-url-anchor-seq"),
          banner: banner ? banner.textContent?.trim() : null,
          target: el
            ? {
                top: Math.round(el.getBoundingClientRect().top),
                bottom: Math.round(el.getBoundingClientRect().bottom),
                highlight: el.classList.contains("bg-accent-soft"),
                className: el.className,
              }
            : null,
          rows,
        };
      }, picked.target.id);
      throw new Error(
        `[${where}] 콜드 착지 실패 url=${landingUrl} ` +
          `target=${picked.target.id} 열기전 top=${Math.round(picked.target.top)} ` +
          `dump=${JSON.stringify(dump)}` +
          (error instanceof Error ? ` (${error.message})` : "")
      );
    }
    const pos = await landing
      .locator(
        `[data-testid="timeline-message"][data-message-id="${picked.target.id}"]`
      )
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return {
          top: r.top,
          bottom: r.bottom,
          vh: window.innerHeight,
          highlighted: el.classList.contains("bg-accent-soft"),
        };
      });
    console.log(
      `  착지 ${where}: msg=${picked.target.id} top=${Math.round(pos.top)} ` +
        `bottom=${Math.round(pos.bottom)} vh=${pos.vh} highlight=${pos.highlighted ? 1 : 0} ` +
        `(열기 전 top=${Math.round(picked.target.top)})`
    );
  } finally {
    await landing.close();
  }

  await assertColdAnchorMissBanners(context, productShareUrl, picked, where);
}

/**
 * 콜드 오픈에서 없는 msg의 미발견 배너 (P3가 null이던 older/unknown).
 */
async function assertColdAnchorMissBanners(
  context,
  productShareUrl,
  picked,
  where
) {
  let missingId = "capture-missing";
  while (picked.present.includes(missingId)) missingId = `${missingId}-x`;

  const unknownUrl = shareUrlForTarget(productShareUrl, {
    messageId: missingId,
    seq: null,
  });
  const unknownPage = await openColdSharePage(context, unknownUrl);
  try {
    const banner = unknownPage.getByTestId("chat-anchor-missed");
    await banner.waitFor({ state: "visible", timeout: 8_000 });
    const text = (await banner.innerText()).trim();
    if (!text.includes("찾지 못했습니다")) {
      throw new Error(
        `[${where}] 없는 msg(unknown) 배너가 이유를 말하지 않는다: ${text}`
      );
    }
    console.log(`  착지 ${where} 배너 unknown: ${text}`);
  } finally {
    await unknownPage.close();
  }

  // seq 0은 어떤 로드 창보다도 위다. 렌더된 최소 seq-1은 창 *안*일 수 있다
  // (가상 목록이 머리 행을 안 그리는 자리 — 그때는 unknown이 맞다).
  const olderUrl = shareUrlForTarget(productShareUrl, {
    messageId: missingId,
    seq: 0,
  });
  const olderPage = await openColdSharePage(context, olderUrl);
  try {
    const banner = olderPage.getByTestId("chat-anchor-missed");
    await banner.waitFor({ state: "visible", timeout: 8_000 });
    const text = (await banner.innerText()).trim();
    if (!text.includes("위쪽")) {
      throw new Error(
        `[${where}] 없는 msg(older) 배너가 이유를 말하지 않는다: ${text}`
      );
    }
    console.log(`  착지 ${where} 배너 older: ${text}`);
  } finally {
    await olderPage.close();
  }
}

/**
 * 진짜 손가락 제스처 (goal B11 R2 H2).
 *
 * 1라운드의 이 자리는 합성 `pointerdown` 하나였다 — move도 up도 없었으므로,
 * "스크롤은 누르기가 아니다" 규칙은 캡처에서 **한 번도 실행되지 않았다**. 훅
 * 안에서 그 규칙이 죽어 있었던 것도 그래서 아무도 몰랐다.
 *
 * 여기서는 CDP로 실제 터치 시퀀스를 낸다: touchStart → 여러 걸음의 touchMove →
 * 홀드 → touchEnd. 걸음을 나누는 것이 요점이다. 걸음마다 몇 px씩이면 "직전
 * 위치" 기준의 게이트는 절대 걸리지 않고, 시작점 기준의 게이트만 걸린다.
 *
 * 가로로 미는 이유: 타임라인은 세로로만 스크롤하므로 가로 드래그에는 브라우저가
 * 개입하지 않는다(`pointercancel`이 오지 않는다). 남은 방어는 훅의 거리 게이트
 * 하나뿐이고, 정확히 그것을 재려는 것이다.
 *
 * ## 끝은 touchEnd 가 아니라 touchCancel 이다 (#1099)
 *
 * 하네스가 95/118 프레임에서 30초 타임아웃으로 죽던 이유가 여기 있었다. 실측
 * (2026-08-06, origin/track/engine baseline, `CAPTURE_PROFILE=mobile`):
 *
 *   [diag] before touchEnd opened=true
 *   [diag] +0ms visible=false count=0
 *   [diag] events [... "mousedown target=sheet-react-👍" "click target=sheet-react-👍"]
 *
 * 시트는 홀드 동안 정상적으로 열렸다. 그리고 **touchEnd 가 그 시트를 도로 닫았다.**
 * Chrome 은 취소되지 않은 터치 시퀀스의 touchEnd 뒤에 호환용 마우스 이벤트
 * (mousedown/mouseup/click)를 **놓았던 좌표에** 합성한다. 시트는 화면 아래에
 * 붙는 판이라 길게 누른 그 좌표를 덮는다 — 그래서 손을 떼는 동작이 시트의 첫
 * 빠른 반응 버튼(`sheet-react-👍`)을 누르고, 그 onClick 이 `close()` 를 부른다.
 * 두 번째 openSheet() 가 30초를 기다린 것은 그 사이 시트가 닫혔기 때문이다.
 * (첫 열기가 살아남은 것은 우연이다: 그때는 합성 클릭이 시트의 설명 문단이라는
 * 죽은 자리에 떨어졌다.)
 *
 * 이것은 제품 결함이 아니라 **원시 터치 디스패치의 산물**이다. 실제 Chrome 은
 * 700ms 홀드를 GestureLongPress 로 인식해 뒤따르는 탭을 소비하지만,
 * `Input.dispatchTouchEvent` 로 낸 터치는 그 인식기를 거치지 않아 탭이 살아남는다.
 * touchCancel 은 그 "제스처가 소비됐다"를 정확히 모델링하고, 앱 쪽에서는
 * `pointercancel` → `useLongPress.onPointerCancel` 로 눌림 상태도 깨끗이 풀린다.
 */
async function longPressGesture(page, target, { dx = 0, dy = 0, holdMs = 700 } = {}) {
  const box = await target.boundingBox();
  if (!box) throw new Error("길게 누르기 대상의 상자를 잴 수 없다");
  const x0 = box.x + Math.min(24, box.width / 2);
  const y0 = box.y + box.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const at = (fx, fy) => ({
    x: x0 + dx * fx,
    y: y0 + dy * fy,
    radiusX: 12,
    radiusY: 12,
    force: 1,
  });
  try {
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [at(0, 0)],
    });
    const steps = 5;
    for (let i = 1; i <= steps; i++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [at(i / steps, i / steps)],
      });
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(holdMs);
    const opened = await page
      .getByTestId("message-action-sheet")
      .isVisible()
      .catch(() => false);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchCancel",
      touchPoints: [],
    });
    return opened;
  } finally {
    await cdp.detach();
  }
}

/**
 * 이 컨트롤들이 **보이는** 뷰포트 안에 있는가.
 *
 * `assertComposerVisible`과 같은 자인데 대상만 받는다. 스레드 컴포저에 쓰려고
 * 뽑았다: B9가 답한 질문("키보드가 올라오면 컴포저가 가려지는가")은 채널
 * 컴포저에만 답한 것이었고, B11이 새 입력창을 하나 더 놓았다.
 */
async function assertControlsAboveFold(page, where, ids) {
  const measure = await page.evaluate(`(() => {
    const visible = Math.round(window.visualViewport.height);
    return {
      visible,
      layout: window.innerHeight,
      rows: ${JSON.stringify(ids)}.map((id) => {
        const el = document.querySelector('[data-testid="' + id + '"]');
        return { id, bottom: el ? Math.round(el.getBoundingClientRect().bottom) : null };
      }),
    };
  })()`);
  for (const row of measure.rows) {
    if (row.bottom === null) {
      throw new Error(`가시성 ${where}: ${row.id}가 없다`);
    }
    if (row.bottom > measure.visible + 1) {
      throw new Error(
        `가시성 ${where}: ${row.id} 아랫변이 ${row.bottom}px인데 보이는 높이는 ` +
          `${measure.visible}px다 — 하단 크롬 뒤로 ${row.bottom - measure.visible}px 들어갔다`
      );
    }
  }
  console.log(
    `  가시성 ${where}: ` +
      measure.rows.map((r) => `${r.id} ${r.bottom}px`).join(" · ") +
      ` <= 보이는 ${measure.visible}px`
  );
}

/**
 * 폰 (goal B6). 데스크탑 프로파일과 같은 목이고 같은 컴포넌트이며, 다른 것은
 * 뷰포트뿐이다: 이 셸이 폭에 따라 형태를 바꾼다는 주장을 같은 픽스처로 두 번
 * 찍어야 리뷰가 두 형태를 나란히 볼 수 있다.
 *
 * 다섯 화면인 이유는 그 다섯이 폰에서 형태가 **바뀐** 화면 전부이기 때문이다:
 * 연결(셸 밖), 채널(단일 pane + 도크된 컴포저), 서랍이 열린 상태, 에이전트 허브
 * (두 열이 한 열이 되는 표면), 인박스(전역 표면의 헤더에 햄버거가 서는 자리).
 */
async function captureMobile(browser, scheme) {
  const context = await browser.newContext({
    viewport: MOBILE_VIEWPORT,
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent: IPHONE_UA,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await installMocks(context);
  const shots = [];
  const shoot = async (page, name) => {
    const path = `${OUT_DIR}/mobile-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
  };

  // 1. 연결 화면. 셸 밖의 유일한 표면이고, 폰에서 문서가 스크롤해도 되는 자리다.
  //    BZ-6a: 첫 페인트는 S0. S1/S2를 찍은 뒤 기존 login 프레임은 계정 스텝이다.
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await walkOnboardingToAccount(page, `login ${scheme}`, {
    tapTargets: true,
    shoot: (name) => shoot(page, name),
  });
  await assertNoHorizontalOverflow(page, `login ${scheme}`);
  // goal P3 1-4: 폼의 1급 컨트롤은 이 폭에서 44px다. 데스크탑 프레임은 같은
  // 컨트롤을 32px로 찍으므로, 두 프레임이 함께 "토큰이 아니라 폭이 결정한다"를
  // 말한다.
  await assertTapTargets(page, `login ${scheme}`, LOGIN_TAP_TARGETS);
  await shoot(page, "login");

  const profilePage = await context.newPage();
  await profilePage.goto(ORIGIN, { waitUntil: "networkidle" });
  await shootOnboardingProfile(profilePage, `profile ${scheme}`, {
    tapTargets: true,
    shoot: (name) => shoot(profilePage, name),
  });
  await profilePage.close();

  // 2. 채널. 사이드바는 열이 아니라 닫힌 서랍이므로 타임라인이 390px 전부를
  //    받고, 컴포저는 안전 영역 위에 도크된다.
  await page.getByTestId("login-email").fill("seongjae@dawn.example");
  await page.getByTestId("login-password").fill("capture-only-not-a-credential");
  await page.getByTestId("login-submit").click();
  await page.getByTestId("composer-input").waitFor({ state: "visible" });
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `chat ${scheme}`);
  await assertTapTargets(page, `chat ${scheme}`);
  await assertTopBreathing(page, `chat ${scheme}`);
  await assertComposerVisible(page, `chat ${scheme}`);
  await shoot(page, "chat");

  // TC-1 (#1758): 헤더 터미널을 실제로 눌러 도크가 컴포저 위에 앉는지 폰에서도 잰다.
  await page.getByTestId("open-terminal-dock").click();
  await page.getByTestId("terminal-dock").waitFor({ state: "visible" });
  await page.getByTestId("terminal-dock-empty").waitFor({ state: "visible" });
  await assertComposerVisible(page, `terminal dock ${scheme}`);
  await assertDockAboveComposer(page, `terminal dock ${scheme}`);
  await assertDockExpandHonesty(page, `terminal dock ${scheme}`);
  await page.getByTestId("terminal-dock-empty").waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, `terminal dock ${scheme}`);
  await assertTapTargets(page, `terminal dock ${scheme}`);
  await shoot(page, "terminal-dock");
  await page.getByTestId("terminal-dock-close").click();
  await page.getByTestId("terminal-dock").waitFor({ state: "detached" });

  // 2a-0. 이모지 피커 바텀시트 (#1742). 390에서 분류 탭이 화면 밖으로
  //       나가면 안 된다. hover: none 이므로 포인터 popover가 아니라 시트다.
  await page.getByTestId("composer-emoji-trigger").click();
  await page.getByTestId("composer-emoji-picker").waitFor({ state: "visible" });
  await page.getByTestId("emoji-search").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `emoji picker ${scheme}`);
  await assertTapTargets(page, `emoji picker ${scheme}`);
  await shoot(page, "composer-emoji");
  await page.keyboard.press("Escape");

  // 2a-1. 폰에 액션이 있다는 것을 말하는 한 줄 (goal B11 R2 H4). 폰의 진입점은
  //       보이지 않는 제스처 하나뿐이었고, 그래서 이 표면에는 "여기서 무언가 할
  //       수 있다"고 말하는 것이 하나도 없었다. 손가락 기기에서만, 한 번만.
  await page.getByTestId("long-press-hint").waitFor({ state: "visible" });
  // 같은 축의 반대편: hover가 없는 기기에는 호버 툴바가 아예 없어야 한다.
  // display:none 이 아니라 DOM 0 — opacity 트릭의 재발을 여기서 차단한다.
  await assertHoverToolbarCount(page, `폰 ${scheme}`, 0);
  console.log(`  폰 ${scheme}: 호버 툴바 0, 길게 누르기 안내 보임`);

  // 2a-2. 스크롤은 누르기가 아니다 (goal B11 R2 H2). **먼저 열리지 않아야 하는
  //       제스처부터 잰다.** 1라운드의 이 방어는 죽은 코드였다: `origin`을 채운
  //       직후 `clear()`가 그것을 지워서 거리 게이트가 한 번도 돌지 않았고,
  //       그래서 임계 아래에서 천천히 끌다 멈추는 손가락이 시트를 열었다.
  //
  //       40px을 다섯 걸음에 나눠 가로로 민다. 걸음마다 8px이므로 "직전 위치"
  //       기준이라면 다섯 번 다 통과하고, 가로이므로 브라우저가 스크롤로
  //       가져가지도 않는다(`pointercancel`이 오지 않는다). 남은 방어는 훅의
  //       시작점 기준 거리 게이트 하나뿐이다.
  const sheetTarget = page.getByTestId("timeline-message").last();
  const draggedOpen = await longPressGesture(page, sheetTarget, { dx: 40 });
  if (draggedOpen) {
    throw new Error(
      `[길게 누르기 ${scheme}] 40px 끌린 손가락이 시트를 열었다 — 스크롤은 누르기가 아니다`
    );
  }
  console.log(`  길게 누르기 ${scheme}: 40px 끌기는 시트를 열지 않는다`);
  await page.waitForTimeout(200);

  // 2a-3. 그리고 진짜 길게 누르기는 연다. 손가락은 가만히 있지 않으므로 4px의
  //       떨림을 함께 낸다 — 허용 범위 안의 흔들림까지 취소하는 게이트는 열리지
  //       않는 시트와 같다.
  const pressedOpen = await longPressGesture(page, sheetTarget, { dx: 4 });
  if (!pressedOpen) {
    throw new Error(
      `[길게 누르기 ${scheme}] 4px 떨림이 있는 길게 누르기가 시트를 열지 못했다`
    );
  }
  await page.getByTestId("message-action-sheet").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `action sheet ${scheme}`);
  // 시트의 모든 행은 44px 손가락 타깃이어야 한다 — 시트를 여는 이유가 그것이다.
  const sheetTaps = await page.evaluate(`(() => {
    const ids = ["sheet-reply", "sheet-copy-link", "sheet-edit", "sheet-delete"];
    return ids
      .map((id) => {
        const el = document.querySelector('[data-testid="' + id + '"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { id, h: Math.round(r.height), w: Math.round(r.width) };
      })
      .filter(Boolean);
  })()`);
  // 빈 목록은 통과가 아니다 (#1099). 이전 판은 `.filter(Boolean)` 뒤에 for 문만
  // 있어서, 시트가 닫힌 뒤 이 자리에 오면 **행 0개를 무사통과**했다 — 44px 계약이
  // 검사된 적 없는데 초록이 나오는 상태였고, 그 조용한 초록이 시트가 닫히고 있다는
  // 사실을 118프레임 뒤까지 가려 줬다.
  if (sheetTaps.length !== 4) {
    throw new Error(
      `[action sheet ${scheme}] 시트 행 ${sheetTaps.length}/4 — 시트가 닫혔거나 링크 복사가 없다`
    );
  }
  for (const tap of sheetTaps) {
    if (tap.h < 44) {
      throw new Error(
        `[action sheet ${scheme}] ${tap.id} 높이 ${tap.h}px < 44px 손가락 타깃`
      );
    }
  }
  await shoot(page, "b11-action-sheet");
  // UX-D3 (#1755): 시트 클립보드 항목을 실제로 누르고 내용을 읽는다.
  await page.getByTestId("sheet-copy").click();
  await page.getByTestId("sheet-copy").getByText("메시지 복사됨").waitFor();
  await assertCopiedClipboard(page, `시트 메시지 복사 ${scheme}`, ACTION_ROW_BODY);
  await page.getByTestId("sheet-copy-link").click();
  await page.getByTestId("sheet-copy-link").getByText("링크 복사됨").waitFor();
  const sheetMessageId = await sheetTarget.getAttribute("data-message-id");
  const sheetSeq = await sheetTarget.getAttribute("data-seq");
  if (!sheetMessageId) {
    throw new Error(`[시트 ${scheme}] 마지막 행에 data-message-id가 없다`);
  }
  await readCopiedShareUrl(page, `시트 링크 복사 ${scheme}`, {
    messageId: sheetMessageId,
    seq: sheetSeq,
  });
  console.log(`  시트 ${scheme}: 메시지 복사 · 링크 복사 클립보드 일치`);
  await page.keyboard.press("Escape");
  await page.getByTestId("message-action-sheet").waitFor({ state: "hidden" });

  // 2a-4. 시트가 여는 세 목적지 (goal B11 R2 H3). 1라운드는 폰 흐름을 **시트까지**
  //       만 증명했고, 시트가 여는 곳은 아무도 폰에서 보지 않았다. 그 중 둘은
  //       44px 아래 컨트롤에 착지했다(수정 저장·취소 28px, 삭제 확인 32px):
  //       손가락으로 시작한 흐름이 손가락으로 누를 수 없는 곳에서 끝났다.
  const openSheet = async () => {
    const opened = await longPressGesture(page, sheetTarget, { dx: 4 });
    if (!opened) {
      throw new Error(`[폰 ${scheme}] 액션 시트를 다시 열지 못했다`);
    }
    await page.getByTestId("message-action-sheet").waitFor({ state: "visible" });
  };

  // (1) 제자리 편집기.
  await openSheet();
  await page.getByTestId("sheet-edit").click();
  await page.getByTestId("message-editor-input").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `inline editor ${scheme}`);
  await assertTapTargets(page, `inline editor ${scheme}`);
  await shoot(page, "b11-edit");
  await page.getByTestId("message-editor-cancel").click();
  await page
    .getByTestId("message-editor-input")
    .waitFor({ state: "detached" });

  // (2) 삭제 확인.
  await openSheet();
  await page.getByTestId("sheet-delete").click();
  await page.getByTestId("delete-message-dialog").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `delete dialog ${scheme}`);
  await assertTapTargets(page, `delete dialog ${scheme}`);
  await shoot(page, "b11-delete");
  await page.getByTestId("delete-message-cancel").click();
  await page
    .getByTestId("delete-message-dialog")
    .waitFor({ state: "hidden" });

  // (2b) 나중에 알림 (#1889 R2-M1). RemindDialog 44 주장은 장면이 없으면
  //      허용목록만 초록이다. 시트의 「나중에 알림」이 폰의 실진입점.
  await openSheet();
  await page.getByTestId("sheet-remind").click();
  await page.getByTestId("remind-dialog").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `remind dialog ${scheme}`);
  await assertTapTargets(page, `remind dialog ${scheme}`);
  await shoot(page, "remind-dialog");
  await page.keyboard.press("Escape");
  await page.getByTestId("remind-dialog").waitFor({ state: "hidden" });

  // (3) 스레드 패널과 그 컴포저. 폰에서 이 패널은 열이 아니라 채널을 덮는
  //     서랍이고, 그 안에 B11이 입력창을 하나 더 놓았다.
  await page.getByTestId("thread-anchor").first().click();
  await page.getByTestId("thread-panel").waitFor({ state: "visible" });
  await page.getByTestId("thread-composer-input").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `thread ${scheme}`);
  await assertTapTargets(page, `thread ${scheme}`);
  await shoot(page, "b11-thread");

  //     그리고 B9의 질문을 이 입력창에도 던진다: 하단 크롬이 100px을 가져가면
  //     답글 컴포저가 그 뒤로 들어가는가. 코드상으로는 `--app-viewport-height`를
  //     물려받아 안전해 보이지만, 재지 않은 것은 재지 않은 것이다.
  await emulateBottomChrome(page);
  await page.waitForTimeout(300);
  await assertControlsAboveFold(page, `thread + 하단 크롬 ${scheme}`, [
    "thread-composer-input",
    "thread-composer-send",
  ]);
  await shoot(page, "b11-thread-bottom-chrome");
  await releaseBottomChrome(page);
  await page.getByTestId("thread-close").click();
  await page.getByTestId("thread-panel").waitFor({ state: "detached" });

  // 2b. 하단 브라우저 크롬이 100px을 가져간 상태 (goal B9). 성재 실캡처의 조건이고,
  //     이 프레임의 요점은 컴포저가 그 선 **위에** 있다는 것이다. 아래 100px이 비어
  //     보이는 것이 맞다: 실기기에서 거기 있는 것은 사파리의 주소 줄이다.
  await emulateBottomChrome(page);
  await assertComposerVisible(page, `chat + 하단 크롬 ${scheme}`);
  await assertNoHorizontalOverflow(page, `chat + 하단 크롬 ${scheme}`);
  await shoot(page, "chat-bottom-chrome");
  await releaseBottomChrome(page);

  // 3. 서랍이 열린 상태. 뒤 표면이 110px 남는 것이 이 프레임의 요점이다: 덮은
  //    것이 화면 전체가 아니라 서랍이어야 바깥을 눌러 닫을 자리가 보인다.
  await page.getByTestId("open-sidebar-drawer").click();
  await page.getByTestId("sidebar-scrim").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertEnterMotionPressAfterFill(page, `drawer ${scheme}`, {
    requireScrim: true,
  });
  const drawer = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="sidebar"]');
    const r = el.getBoundingClientRect();
    const row = document.querySelector("[data-sidebar-row]");
    const rowRect = row?.getBoundingClientRect();
    return {
      left: Math.round(r.left),
      width: Math.round(r.width),
      peek: Math.round(window.innerWidth - r.right),
      rowHeight: rowRect ? Math.round(rowRect.height) : null,
      mainInert: document
        .querySelector("main")
        ?.hasAttribute("inert"),
      focusInsideDrawer: el.contains(document.activeElement),
    };
  })()`);
  if (drawer.left !== 0 || drawer.peek <= 0) {
    throw new Error(`서랍 기하 ${scheme}: ${JSON.stringify(drawer)}`);
  }
  if (drawer.mainInert !== true) {
    throw new Error(`서랍이 열렸는데 본문이 inert가 아니다 ${scheme}`);
  }
  if (drawer.focusInsideDrawer !== true) {
    throw new Error(`서랍이 열렸는데 캐럿이 밖에 있다 ${scheme}`);
  }
  if (drawer.rowHeight !== null && drawer.rowHeight < 44) {
    throw new Error(`채널 행이 ${drawer.rowHeight}px다 (최소 44px) ${scheme}`);
  }
  console.log(
    `  drawer ${scheme}: ${drawer.width}px 서랍 + ${drawer.peek}px 잔여, 행 ${drawer.rowHeight}px, 본문 inert=${drawer.mainInert}`
  );
  await assertNoHorizontalOverflow(page, `drawer ${scheme}`);

  // ADR-0177 / design-review #1932 H-1 — 배치의 문(행 컨텍스트 메뉴)이 없는
  // 표면에는 섹션을 **만드는** 문도 없다. 만들 수는 있는데 쓸 수 없는 그릇을
  // 내밀지 않는다. 터치에서는 호버 클러스터가 **언제나** 마운트되므로
  // (`shouldShowSectionActions` 의 `!pointerCanHover` 갈래) 아무것도 누르지 않고
  // 세는 것이 맞다 - 헤더를 누르면 섹션이 접혀 이 프레임이 달라진다.
  const touchDoors = await page.evaluate(`(() => ({
    newSection: document.querySelectorAll('[data-testid="new-section"]').length,
    sectionMenus: document.querySelectorAll('[data-testid^="section-menu-"]').length,
  }))()`);
  if (touchDoors.newSection !== 0 || touchDoors.sectionMenus !== 0) {
    throw new Error(
      `터치 서랍에 섹션 편집 문이 서 있다 ${scheme}: ${JSON.stringify(touchDoors)}`
    );
  }
  console.log(
    `  섹션 편집 문 (터치) ${scheme}: 새 섹션 ${touchDoors.newSection} · 섹션 메뉴 ${touchDoors.sectionMenus}`
  );

  await shoot(page, "sidebar-drawer");

  await page.getByTestId("profile-card").click();
  await page.getByTestId("profile-card-menu").waitFor({ state: "visible" });
  await assertProfileMenuFitsViewport(page, `drawer profile ${scheme}`);
  await assertTapTargets(page, `drawer profile ${scheme}`);
  await shoot(page, "sidebar-profile-card");
  await page.getByTestId("profile-set-status").click();
  await page.getByTestId("set-status-dialog").waitFor({ state: "visible" });
  await assertTapTargets(page, `set-status ${scheme}`);
  await shoot(page, "set-status-dialog");
  // #1889 R2-N2: 「시각 고르기」는 390에서 다이얼로그를 키우는 유일한 분기.
  await page.getByTestId("set-status-expiry").selectOption("custom");
  await page.getByTestId("set-status-custom-date").waitFor({ state: "visible" });
  await page.getByTestId("set-status-custom-time").waitFor({ state: "visible" });
  await assertTapTargets(page, `set-status custom ${scheme}`);
  await shoot(page, "set-status-custom");
  await page.keyboard.press("Escape");
  await page.getByTestId("set-status-dialog").waitFor({ state: "hidden" });
  // 첫 Esc 는 상태 다이얼로그, 둘째는 서랍. 메뉴는 상태 항목을 고르며 이미 닫힘.

  // Esc로 닫힌다. 닫히는 길이 셋(닫기 버튼·스크림·Esc)이라는 주장 중 하나를
  // 여기서 실제로 걷는다.
  await page.keyboard.press("Escape");
  await page.getByTestId("sidebar-scrim").waitFor({ state: "detached" });

  // 3b. 에이전트와의 1:1 DM (goal B13 R2 Medium).
  //     이 배치가 좁은 폭에 **새로** 만든 것이 여기 있다: 컴포저 힌트 줄은
  //     원래 통째로 wide-only여서 600px 아래에서는 아예 없었는데, DM일 때는
  //     "멘션 없이 바로 말하면 …가 답합니다"가 남는다. 즉 폰에서 컴포저 아래
  //     텍스트 노드가 하나 생기는 유일한 경우다. 채널 캡처는 그 부재만
  //     증명하므로 존재하는 쪽을 따로 찍는다 — 특히 이름이 긴 에이전트에서
  //     이 줄이 가로로 새지 않는지가 요점이다.
  await page.evaluate('location.hash = "/directory"');
  await page
    .locator('[data-testid="directory-row"][data-member-kind="agent"]')
    .first()
    .click();
  await page.getByTestId("member-profile-dialog").waitFor({ state: "visible" });
  await page.getByTestId("member-profile-dm").click();
  await page.getByTestId("composer-input").waitFor({ state: "visible" });
  await page.getByTestId("composer-dm-hint").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const dmHint = await page.evaluate(`(() => {
    const el = document.querySelector('[data-testid="composer-dm-hint"]');
    const line = document.querySelector('[data-testid="composer-hint"]');
    const keys = document.querySelector('[data-testid="composer-keys-hint"]');
    return {
      // innerText는 렌더된 것만 준다. textContent는 display:none도 포함하므로
      // "접혔는지"를 그것으로 물으면 영원히 안 접힌 것처럼 보인다.
      text: el?.innerText?.trim() ?? null,
      lineText: line?.innerText?.trim() ?? null,
      keysDisplay: keys ? getComputedStyle(keys).display : null,
      overflow: line ? line.scrollWidth - line.clientWidth : null,
    };
  })()`);
  if (!dmHint.text) {
    throw new Error(`DM 컴포저 힌트가 폰에서 사라졌다 ${scheme}`);
  }
  // 폰에는 ⌘도 물리 키보드 안내도 필요 없다: 그 조각만 wide-only로 접히고
  // DM 문장은 남는다.
  if (dmHint.keysDisplay !== "none") {
    throw new Error(
      `폰에서 Enter 안내가 접히지 않았다 (wide-only가 풀렸다) ${scheme}: display=${dmHint.keysDisplay}`
    );
  }
  if (dmHint.lineText.includes("Enter로 보내기")) {
    throw new Error(
      `폰에서 Enter 안내가 여전히 렌더된다 ${scheme}: ${dmHint.lineText}`
    );
  }
  if (dmHint.overflow > 0) {
    throw new Error(
      `DM 힌트가 가로로 샌다 ${scheme}: +${dmHint.overflow}px (${dmHint.lineText})`
    );
  }
  console.log(`  dm hint ${scheme}: "${dmHint.lineText}" (넘침 0)`);
  await assertNoHorizontalOverflow(page, `dm ${scheme}`);
  await shoot(page, "dm");
  await page.evaluate('location.hash = "/"');
  await page.getByTestId("composer-input").waitFor({ state: "visible" });

  // 4. 에이전트 허브. 900px 아래에서 명부와 상세가 한 열로 쌓이는 표면이라,
  //    폰에서 그 형태가 실제로 서는지 보는 자리다.
  await page.evaluate('location.hash = "/agents"');
  await page.getByTestId("agent-hub-profile-card").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await assertNoHorizontalOverflow(page, `agent hub ${scheme}`);
  await shoot(page, "agent-hub");
  const toolsViewport = await frameEnabledToolsSection(
    page,
    `mobile agent-hub-tools ${scheme}`
  );
  await shoot(page, "agent-hub-tools");
  await page.setViewportSize(toolsViewport);

  // 5. 인박스. 전역 표면의 헤더에도 서랍을 여는 길이 있어야 한다는 것이 이
  //    프레임의 요점이다: 없으면 채널 밖으로 나간 사람은 갇힌다. 그 요점은 이
  //    서버가 승인 원장을 갖든 말든 그대로이므로 프레임도 그대로 선다 —
  //    바뀐 것은 무엇을 기다리느냐뿐이다(`waitForInboxSettled` 주석).
  //
  //    `?filter=needs-action`은 일부러 남겨 둔다. 이 서버에 없는 탭을 가리키는
  //    링크이고, `parseFilter`가 그것을 남은 탭으로 접어 주는지가 여기서 함께
  //    걸린다 — 죽은 탭을 가리키는 옛 딥링크는 실제로 돌아다닌다.
  await page.evaluate('location.hash = "/inbox?filter=needs-action"');
  await waitForInboxSettled(page, `mobile ${scheme}`);
  await page.getByTestId("open-sidebar-drawer").waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, `inbox ${scheme}`);
  // 서랍이 폰에서 실제로 **눌리는** 크기인지까지 재고 넘어간다. 전역 표면에서
  // 채널로 돌아가는 유일한 길이라, 여기서 작으면 갇히는 것과 같다.
  await assertTapTargets(page, `inbox ${scheme}`, [
    ["open-sidebar-drawer", "채널 목록 열기"],
  ]);
  await shoot(page, "inbox");

  // 5b. 나중에 알림 (#1888). 390에서 ⋯ 그릇이 본문을 덮지 않는지, 완료·미루기가
  //     44 타깃인지, 만기 행이 칩 그릇을 입는지. hover:none 이라 ⋯는 상시 마운트.
  await page.evaluate('location.hash = "/inbox?filter=reminders"');
  await waitForRemindersSettled(page, `mobile ${scheme}`);
  await assertNoHorizontalOverflow(page, `reminders ${scheme}`);
  await assertReminderOverflowClearsBodyText(page, `mobile ${scheme}`);
  await assertTapTargets(page, `reminders ${scheme}`, [
    ["open-sidebar-drawer", "채널 목록 열기"],
    ["reminder-complete", "알림 완료"],
    ["reminder-snooze", "알림 미루기"],
    ["reminder-row-menu", "알림 메뉴"],
  ]);
  await shoot(page, "reminders");

  // 6. 설정 전면 (#1867). 앱 사이드바가 사라지고 섹션 목록이 본문 위로 접힌다.
  await page.evaluate('location.hash = "/settings?section=profile"');
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await page.getByTestId("settings-back-to-app").waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "프로필", exact: true }).waitFor({
    state: "visible",
  });
  await page.waitForTimeout(250);
  await assertNoHorizontalOverflow(page, `settings ${scheme}`);
  await assertTapTargets(page, `settings ${scheme}`, [
    ["settings-back-to-app", "앱으로 돌아가기"],
    ["profile-display-name", "표시 이름 입력"],
    ["profile-display-name-save", "표시 이름 저장"],
  ]);
  await shoot(page, "settings");

  await page.evaluate('location.hash = "/inbox"');
  await page.waitForTimeout(200);
  await page.evaluate('location.hash = "/settings?section=appearance"');
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  await page.getByRole("heading", { name: "테마", exact: true }).waitFor({
    state: "visible",
  });
  await page.getByTestId("accent-swatch-dawn").waitFor({ state: "visible" });
  await assertNoHorizontalOverflow(page, `settings appearance ${scheme}`);
  await assertTapTargets(page, `settings appearance ${scheme}`, [
    ["settings-back-to-app", "앱으로 돌아가기"],
    ["accent-swatch-dawn", "액센트 새벽"],
  ]);
  await shoot(page, "settings-appearance");

  // 7. 긴 무공백 토큰 스트레스 (goal B9). 마지막에 서는 이유는 이 단계가 DOM을
  //    되돌릴 수 없게 바꾸기 때문이다 — 앞의 여섯 프레임은 손대지 않은 표면에서
  //    찍히고, 이 한 장만 스트레스가 걸린 채로 남는다.
  await page.evaluate('location.hash = "/"');
  await page.getByTestId("composer-input").waitFor({ state: "visible" });
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  const touched = await applyLongTokenStress(page);
  await page.waitForTimeout(200);
  console.log(`  long token ${scheme}: 서버가 쓴 글 ${touched}곳에 74자 무공백 토큰`);
  await assertNoHorizontalOverflow(page, `long token ${scheme}`);
  await shoot(page, "long-token");

  await context.close();
  return shots;
}

async function captureScheme(browser, scheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await installMocks(context);
  const shots = [];

  // 1. login surface: BZ-6a S0 landing, then S1 gateway, then S2 account
  //    (Card / Input / Button / runtime badge tokens).
  const login = await context.newPage();
  await login.goto(ORIGIN, { waitUntil: "networkidle" });
  await walkOnboardingToAccount(login, scheme, {
    shoot: async (name) => {
      const path = `${OUT_DIR}/${name}-${scheme}.png`;
      await login.screenshot({ path });
      shots.push(path);
    },
  });
  const loginShot = `${OUT_DIR}/login-${scheme}.png`;
  await assertWideRowsFillOnly(login, `connect ${scheme}`);
  await login.screenshot({ path: loginShot });
  shots.push(loginShot);

  // 1a-2. 워크스페이스 칸을 펼친 상태 (goal B13 R2 High 1). 접어 둔 것이 "채우는
  //       법을 지운 것"이 아님을 보이는 프레임이다: 열면 라벨이 "워크스페이스 ID"
  //       이고 placeholder가 UUID 모양이라, 무엇을 넣는 칸인지 화면에서 읽힌다.
  await login.getByTestId("login-workspace-toggle").click();
  await login.getByTestId("login-workspace").waitFor({ state: "visible" });
  const workspacePlaceholder = await login
    .getByTestId("login-workspace")
    .getAttribute("placeholder");
  if (!/^[0-9a-f-]{36}$/.test(workspacePlaceholder ?? "")) {
    throw new Error(
      `워크스페이스 칸이 형식을 보여주지 않는다 ${scheme}: ${workspacePlaceholder}`
    );
  }
  const workspaceShot = `${OUT_DIR}/login-workspace-${scheme}.png`;
  await login.screenshot({ path: workspaceShot });
  shots.push(workspaceShot);
  await login.getByTestId("login-workspace-toggle").click();

  // 1b. connect surface, invite path (MOMO-604): the browser fallback for a
  //     oort://join link fills server and code, so only email/password remain.
  //     The LAN discovery card has no web equivalent (no mDNS in a page), so it
  //     is reviewed in the desktop shell, not here.
  const invite = await context.newPage();
  const deepLink = `oort://join?server=${encodeURIComponent(
    ORIGIN
  )}&code=momo-alpha-2026`;
  await invite.goto(`${ORIGIN}/?join=${encodeURIComponent(deepLink)}`, {
    waitUntil: "networkidle",
  });
  await invite.getByTestId("login-invite-code").waitFor({ state: "visible" });
  const inviteShot = `${OUT_DIR}/connect-invite-${scheme}.png`;
  await invite.screenshot({ path: inviteShot });
  shots.push(inviteShot);

  // S3 (UX-R2a). A join that created the member; sign-in on `login` is unchanged.
  const profile = await context.newPage();
  await profile.goto(ORIGIN, { waitUntil: "networkidle" });
  await shootOnboardingProfile(profile, scheme, {
    shoot: async (name) => {
      const path = `${OUT_DIR}/${name}-${scheme}.png`;
      await profile.screenshot({ path });
      shots.push(path);
    },
  });
  await profile.close();

  // 2. chat shell, live path: sidebar + timeline + composer + rail status
  await signIn(login);
  await login.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await login.getByTestId("unfurl-card").waitFor({ state: "visible" });
  const unfurlImage = login.getByTestId("unfurl-image");
  await unfurlImage.waitFor({ state: "visible" });
  await assertWideRowsFillOnly(login, `desktop chat ${scheme}`);
  const unfurlNaturalSize = await unfurlImage.evaluate((element) => ({
    width: element.naturalWidth,
    height: element.naturalHeight,
  }));
  if (unfurlNaturalSize.width !== 1200 || unfurlNaturalSize.height !== 630) {
    throw new Error(
      `언퍼얼 캡처 픽스처가 1200×630이 아니다 ${scheme}: ${JSON.stringify(unfurlNaturalSize)}`
    );
  }
  // 넓은 창도 같은 자로 잰다 (goal B9). 긴 무공백 토큰은 폰에서만 나는 결함이
  // 아니다: 1280px 창에서도 타임라인 스크롤러는 세로 전용이어야 하고, 그 상자가
  // 가로로 끌린다면 새는 것이 있다는 뜻이다. 폭만 다른 같은 주장이다.
  await assertNoHorizontalOverflow(login, `desktop chat ${scheme}`);
  // Park the pointer on the composer so a leftover login-click coordinate
  // cannot keep a row hovered. Rest means the toolbar is not mounted.
  await login.getByTestId("composer-input").hover();
  await login.waitForTimeout(100);
  await assertHoverToolbarCount(login, `desktop chat rest ${scheme}`, 0);
  await waitForAnimations(login);
  const chatShot = `${OUT_DIR}/chat-${scheme}.png`;
  await login.screenshot({ path: chatShot });
  shots.push(chatShot);

  await captureSidebarD4(login, scheme, shots);
  await captureSidebarPrefsUnavailable(context, scheme, shots);

  // UX-CB 4상태 중 rest의 계산 스타일과 닫힌 탭 예산. 새 [@]은 목록에 적어 둔
  // 이름이 아니라 이 페이지에서 실제로 Tab이 멎는 한 정거장이어야 한다.
  await assertComposerFrameGeometry(login, `rest ${scheme}`);
  await assertComposerTabOrder(login, scheme);
  for (let index = 0; index < 4; index++) {
    await login.keyboard.press("Shift+Tab");
  }
  const focusShot = `${OUT_DIR}/composer-focus-${scheme}.png`;
  await login.screenshot({ path: focusShot });
  shots.push(focusShot);
  await assertComposerVesselClick(login, scheme, {
    input: "composer-input",
    actions: "composer-actions",
    frame: "composer-frame",
  });
  const pointerShot = `${OUT_DIR}/composer-pointer-${scheme}.png`;
  await login.screenshot({ path: pointerShot });
  shots.push(pointerShot);

  // 새 진입점은 캡처 레인이 실제로 누른다. 클릭이 @를 넣고 기존 listbox를 열며,
  // 포인터 경로의 프로그램 포커스가 :focus-visible 링을 지어내지 않는 데까지 한 자다.
  const mentionProof = await assertMentionTrigger(login, scheme, {
    input: "composer-input",
    trigger: "composer-mention-trigger",
    list: "composer-mention-list",
  });
  const mentionShot = `${OUT_DIR}/composer-mention-${scheme}.png`;
  await login.screenshot({ path: mentionShot });
  shots.push(mentionShot);
  await login.keyboard.press("Escape");
  await login.getByTestId("composer-mention-list").waitFor({ state: "hidden" });
  await login.getByTestId("composer-input").fill("");

  // 같은 기계의 나머지 두 트리거 (#1930). `#`는 채널 목록, `:`는 피커와 같은
  // 이모지 검색 열을 그린다.
  await captureComposerTrigger(
    login,
    scheme,
    shots,
    { input: "composer-input" },
    {
      typed: "#rel",
      list: "composer-channel-list",
      label: "채널 선택",
      expectFirst: "#release-notes",
      shot: "composer-channel-autocomplete",
    }
  );
  // 같은 목록의 두 결함을 한 프레임이 진다 (#1930 M-1·M-2): 자유 텍스트 방
  // 이름이 행 안에서 감싸고, 비공개 방이 사이드바와 같은 자물쇠로 그려진다.
  await captureComposerTrigger(
    login,
    scheme,
    shots,
    { input: "composer-input" },
    {
      typed: "#",
      list: "composer-channel-list",
      label: "채널 선택",
      minOptions: 4,
      rows: { wrapped: "회고", locked: "김인턴작업" },
      shot: "composer-channel-kinds",
    }
  );
  // 성공 경로보다 먼저: 카탈로그가 한 번 실리면 실패 판을 못 만든다 (#1930 H-3).
  await captureComposerCatalogFailure(login, context, scheme, shots);
  await captureComposerTrigger(
    login,
    scheme,
    shots,
    { input: "composer-input" },
    {
      typed: ":thu",
      list: "composer-emoji-list",
      label: "이모지 선택",
      // 후보와 순위의 정본은 피커의 `filterEmojis` 이고 그 동일성은 단위 시험이
      // 잰다. 여기서 잴 것은 목록이 실제로 여러 줄을 그리고 aria 배선이 그
      // 목록을 가리킨다는 사실 — 그리고 **첫 줄이 Enter 의 기본값이라는 사실**
      // 이다(#1930 H-1). 앞 판의 이 프레임은 `:thu` 첫 줄로 🫰 를 찍었고 마지막
      // 줄이 리투아니아 국기였다. 지금 첫 줄은 친 글자를 숏코드로 맞춘 줄이다.
      minOptions: 2,
      expectFirst: ":thumbsup:",
      shot: "composer-emoji-autocomplete",
    }
  );

  // disabled/offline: 입력·[@]·이모지는 로컬 초안을 계속 만들고, 네트워크를 여는
  // 첨부와 보내기만 막힌다는 기존 의미를 렌더 상태로 확인한다.
  await context.setOffline(true);
  await login.getByTestId("composer-offline").waitFor({ state: "visible" });
  const offlineControls = await login.getByTestId("composer-frame").evaluate((frame) => ({
    input: frame.querySelector('[data-testid="composer-input"]')?.hasAttribute("disabled"),
    mention: frame
      .querySelector('[data-testid="composer-mention-trigger"]')
      ?.hasAttribute("disabled"),
    attach: frame
      .querySelector('[data-testid="composer-attach"]')
      ?.hasAttribute("disabled"),
    emoji: frame
      .querySelector('[data-testid="composer-emoji-trigger"]')
      ?.hasAttribute("disabled"),
    send: frame
      .querySelector('[data-testid="composer-send"]')
      ?.hasAttribute("disabled"),
  }));
  if (
    offlineControls.input !== false ||
    offlineControls.mention !== false ||
    offlineControls.attach !== true ||
    offlineControls.emoji !== false ||
    offlineControls.send !== true
  ) {
    throw new Error(
      `컴포저 오프라인 disabled 의미 ${scheme}: ${JSON.stringify(offlineControls)}`
    );
  }
  const composerOfflineShot = `${OUT_DIR}/composer-offline-${scheme}.png`;
  await login.screenshot({ path: composerOfflineShot });
  shots.push(composerOfflineShot);
  await context.setOffline(false);
  await login.getByTestId("composer-offline").waitFor({ state: "hidden" });

  // 첨부 pending: session 응답을 붙잡아 실제 draftStore가 uploading 칩을 그린
  // 순간을 찍고, 촬영 뒤 같은 3왕복을 끝내 깨끗한 rest로 복귀한다.
  let releaseComposerUpload;
  const composerUploadHeld = new Promise((resolve) => {
    releaseComposerUpload = resolve;
  });
  await login.route("**/attachments/uploads", async (route) => {
    await composerUploadHeld;
    return json(route, {
      id: "capture-composer-attachment",
      status: "pending",
      uploadUrl: `${ORIGIN}/capture-composer-upload`,
    });
  });
  await login.route("**/capture-composer-upload", (route) =>
    route.fulfill({ status: 200, body: "" })
  );
  await login.route("**/attachments/capture-composer-attachment/complete", (route) =>
    json(route, {
      id: "capture-composer-attachment",
      channelId: GENERAL_ID,
      uploaderMemberId: ME,
      name: "deploy-log.txt",
      mime: "text/plain",
      size: 18,
      status: "complete",
      createdAtMs: Date.now(),
    })
  );
  await login
    .getByTestId("composer")
    .locator('input[type="file"]')
    .setInputFiles({
      name: "deploy-log.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("capture attachment"),
    });
  await login.getByTestId("attachment-chip-progress").waitFor({ state: "visible" });
  const composerPendingShot = `${OUT_DIR}/composer-attachment-pending-${scheme}.png`;
  await login.screenshot({ path: composerPendingShot });
  shots.push(composerPendingShot);
  releaseComposerUpload();
  await login.getByTestId("attachment-chip-progress").waitFor({ state: "hidden" });
  await login.getByTestId("attachment-chip-remove").click();
  await login.getByTestId("attachment-chip").waitFor({ state: "hidden" });
  await login.unroute("**/attachments/uploads");
  await login.unroute("**/capture-composer-upload");
  await login.unroute("**/attachments/capture-composer-attachment/complete");
  console.log(
    `  composer states ${scheme}: rest/focus/offline/attachment-pending · mention options ${mentionProof.options}`
  );

  // ADR-0170 destructive boundary: removing a preview is permanent for this
  // message, so the no-regeneration sentence and Esc layer get their own
  // review frame. Esc must restore focus to the exact opener and keeps the card
  // available for the remaining lanes.
  const unfurlRemoveOpener = login.getByTestId("unfurl-remove");
  await unfurlRemoveOpener.click();
  await login.getByTestId("unfurl-remove-dialog").waitFor({ state: "visible" });
  const unfurlRemoveShot = `${OUT_DIR}/unfurl-remove-confirm-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: unfurlRemoveShot });
  shots.push(unfurlRemoveShot);
  await login.keyboard.press("Escape");
  await login.getByTestId("unfurl-remove-dialog").waitFor({ state: "hidden" });
  // Portal removal can become observable one task before Radix runs its
  // close-auto-focus callback. Do not manufacture focus for the proof; wait a
  // bounded interval for the product callback and still fail if it never runs.
  const unfurlFocusProof = await unfurlRemoveOpener.evaluate(async (element) => {
    const deadline = performance.now() + 1_000;
    while (element !== document.activeElement && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
    const active = document.activeElement;
    return {
      restored: element === active,
      activeTag: active?.tagName ?? null,
      activeTestId: active?.getAttribute("data-testid") ?? null,
    };
  });
  if (!unfurlFocusProof.restored) {
    throw new Error(
      `언퍼얼 제거 Esc가 opener 초점을 복원하지 않았다 ${scheme}: ${JSON.stringify(unfurlFocusProof)}`
    );
  }

  // Mocked author DELETE round trip. A separate page keeps the main evidence
  // lane's card intact while proving that success removes only the projection,
  // not the message body, and leaves no regeneration placeholder behind.
  const unfurlRemoval = await context.newPage();
  await unfurlRemoval.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(unfurlRemoval);
  await unfurlRemoval.getByTestId("unfurl-card").waitFor({ state: "visible" });
  await unfurlRemoval.getByTestId("unfurl-remove").click();
  await unfurlRemoval.getByTestId("unfurl-remove-commit").click();
  await unfurlRemoval.getByTestId("unfurl-group").waitFor({ state: "hidden" });
  await unfurlRemoval
    .getByText("502가 계속 납니다.", { exact: false })
    .waitFor({ state: "visible" });
  const unfurlRemovedShot = `${OUT_DIR}/unfurl-removed-${scheme}.png`;
  await unfurlRemoval.screenshot({ path: unfurlRemovedShot });
  shots.push(unfurlRemovedShot);

  // 2c. 메시지 액션 (goal B11 / #1743). 한 프레임이 네 가지를 한꺼번에 증명한다:
  //     내 메시지 위에 뜬 호버 툴바, 위 행들의 반응 칩(내가 누른 것은 강조),
  //     「수정됨」 표식, 그리고 자리에 남은 「삭제된 메시지」.
  //
  //     hover로 띄운다 — 데스크탑의 진입점이 hover이기 때문이다. 폰에는 hover가
  //     없고, 그쪽은 captureMobile의 길게 누르기 프레임이 맡는다.
  const actionRow = login.getByTestId("timeline-message").last();
  await actionRow.hover();
  await login
    .getByTestId("message-hover-toolbar")
    .last()
    .waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  await assertHoverToolbarCount(login, `hover ${scheme}`, 1);
  await assertHoverToolbarPlacement(login, `hover ${scheme}`);
  await assertHoverToolbarClearsBodyText(login, `hover ${scheme}`);
  await assertNoHorizontalOverflow(login, `hover toolbar ${scheme}`);
  await assertRowTabStops(login, `hover ${scheme}`);
  // N-2 / B-1: the React button on the mounted toolbar must open the picker.
  // The ⋯ 메뉴 path is a different consumer and used to stay green while this
  // one crashed.
  await login.getByTestId("toolbar-react-more").last().click();
  await login.getByTestId("reaction-picker").waitFor({ state: "visible" });
  await login.getByTestId("emoji-search").waitFor({ state: "visible" });
  const chipPlus = actionRow.getByTestId("reaction-add");
  if ((await chipPlus.count()) > 0) {
    await login.keyboard.press("Escape");
    await login.getByTestId("reaction-picker").waitFor({ state: "detached" });
    await waitForAnimations(login);
    await actionRow.hover();
    await chipPlus.click();
    await login.getByTestId("reaction-picker").waitFor({ state: "visible" });
    await login.getByTestId("emoji-search").waitFor({ state: "visible" });
  }
  await login.keyboard.press("Escape");
  await login.getByTestId("reaction-picker").waitFor({ state: "detached" });
  await waitForAnimations(login);
  await actionRow.hover();
  await login.getByTestId("message-hover-toolbar").last().waitFor({ state: "visible" });
  await login.setViewportSize({ width: 900, height: 800 });
  await actionRow.hover();
  await login.getByTestId("message-hover-toolbar").last().waitFor({ state: "visible" });
  await assertHoverToolbarClearsBodyText(login, `hover 900 ${scheme}`);
  await assertHoverToolbarPlacement(login, `hover 900 ${scheme}`);
  await login.setViewportSize(VIEWPORT);
  await actionRow.hover();
  await login.getByTestId("message-hover-toolbar").last().waitFor({ state: "visible" });
  const actionsShot = `${OUT_DIR}/b11-message-actions-${scheme}.png`;
  await login.screenshot({ path: actionsShot });
  shots.push(actionsShot);

  // 2c-2. 본문 드래그 선택 (#1743 B-4). 핸드오프가 마우스 포커스에도 ⋯로
  //     옮기면 선택이 빈 문자열이 된다. 포인터를 치운 뒤 본문을 드래그한다.
  await login.getByTestId("composer-input").hover();
  await login.waitForTimeout(100);
  await assertActionableRowDragSelect(login, `hover ${scheme}`);
  await login.evaluate(
    `document.getSelection() && document.getSelection().removeAllRanges()`
  );
  await login.getByTestId("composer-input").hover();
  await login.waitForTimeout(50);

  // 2c-3. 스크롤러 맨 위 행 (#1743 H-4). 위 straddle이 헤더 뒤로 잘리면
  //     행 하단으로 뒤집고, 그 상태에서도 글자 교차 0·상자 전부 스크롤러 안.
  const topSeq = await pinActionableRowToScrollerTop(login);
  if (!topSeq) {
    throw new Error(`[상단 뒤집기 ${scheme}] 스크롤러 상단에 붙일 actionable 행이 없다`);
  }
  const topRow = login.locator(
    `[data-testid="timeline-message"][data-seq="${topSeq}"]`
  );
  await topRow.hover();
  await login.getByTestId("message-hover-toolbar").waitFor({ state: "visible" });
  await login
    .locator('[data-testid="message-hover-toolbar"][data-straddle="below"]')
    .waitFor({ state: "visible", timeout: 1000 });
  await assertHoverToolbarInsideScroller(login, `top ${scheme}`, "below");
  await assertHoverToolbarClearsBodyText(login, `top ${scheme}`);
  await assertHoverToolbarPlacement(login, `top ${scheme}`);
  await login.getByTestId("composer-input").hover();
  await login.evaluate(`(() => {
    const rows = document.querySelectorAll('[data-testid="timeline-message"]');
    const last = rows[rows.length - 1];
    if (last) last.scrollIntoView({ block: "end" });
  })()`);
  await login.waitForTimeout(200);

  // 2d. 키보드 경로 (goal B11 R2 H1 · #1743). **진짜 Tab으로 만든 프레임이다.**
  //
  //     툴바는 비포커스 행에 없으므로, 바로 앞 행의 로빙 정거장에서 Tab을 눌러
  //     마지막 행으로 들어간다. 그 순간 focus-within 이 툴바를 마운트하고,
  //     포커스는 이미 보이는 컨트롤에 있어야 한다 (opacity-0 트리거에 착지하는
  //     옛 경로의 반대). hover 프레임의 포인터가 마지막 행에 남아 있으면
  //     툴바가 미리 떠 있으므로, 키보드 전에 포인터를 치운다.
  await login.getByTestId("composer-input").hover();
  await login.waitForTimeout(100);
  const tabStart = await login.evaluate(`(() => {
    const rows = Array.from(
      document.querySelectorAll('[data-testid="timeline-message"]')
    );
    if (rows.length < 2) return false;
    const prev = rows[rows.length - 2];
    const start =
      prev.querySelector('[data-row-action][tabindex="0"]') ||
      prev.querySelector('[data-row-action]') ||
      prev;
    start.focus();
    return document.activeElement === start;
  })()`);
  if (!tabStart) {
    throw new Error(`[키보드 ${scheme}] 바로 앞 행에 탭 출발점이 없다`);
  }
  let landedRow = false;
  let landedOn = "";
  for (let press = 0; press < 12; press++) {
    await login.keyboard.press("Tab");
    await login.waitForTimeout(30);
    const proof = await login.evaluate(`(() => {
      const el = document.activeElement;
      if (!el) return { inLast: false, testId: "", focusVisible: false, opacity: 0, toolbar: 0 };
      const rows = Array.from(
        document.querySelectorAll('[data-testid="timeline-message"]')
      );
      const last = rows[rows.length - 1];
      return {
        inLast: Boolean(last && last.contains(el)),
        testId: el.getAttribute("data-testid") || "",
        focusVisible: el.matches(":focus-visible"),
        opacity: Number(getComputedStyle(el).opacity),
        toolbar: last
          ? last.querySelectorAll('[data-testid="message-hover-toolbar"]').length
          : 0,
      };
    })()`);
    landedOn = proof.testId;
    if (proof.inLast) {
      if (!proof.focusVisible) {
        throw new Error(
          `[키보드 ${scheme}] 행 착지점이 :focus-visible이 아니다 — 링 없는 프레임은 아무것도 증명하지 않는다`
        );
      }
      if (proof.opacity < 1) {
        throw new Error(
          `[키보드 ${scheme}] 포커스를 받은 컨트롤의 opacity가 ${proof.opacity}다 (보이지 않는 컨트롤에 포커스가 있다)`
        );
      }
      if (proof.toolbar !== 1) {
        throw new Error(
          `[키보드 ${scheme}] focus-within 행에 툴바가 ${proof.toolbar}개다`
        );
      }
      landedRow = true;
      break;
    }
  }
  if (!landedRow) {
    throw new Error(
      `[키보드 ${scheme}] Tab이 마지막 행에 닿지 못했다 (마지막 착지 ${landedOn || "(없음)"})`
    );
  }
  // 본문 링크는 행 로빙 밖의 정당한 탭 스톱이다. 링크에 착지했으면 Tab으로
  // 툴바(tabIndex 0 인 ⋯)에 한 칸 더 들어간다. Arrow 는 로빙 그룹 밖에서
  // 아무 일도 하지 않는다.
  for (let press = 0; press < 8; press++) {
    const reach = await login.evaluate(`(() => {
      const el = document.activeElement;
      const rows = Array.from(
        document.querySelectorAll('[data-testid="timeline-message"]')
      );
      const last = rows[rows.length - 1];
      return {
        onToolbar: Boolean(el && el.hasAttribute("data-toolbar-item")),
        inLast: Boolean(last && el && last.contains(el)),
        testId: el ? el.getAttribute("data-testid") || "" : "",
      };
    })()`);
    if (reach.onToolbar) break;
    if (!reach.inLast) {
      throw new Error(
        `[키보드 ${scheme}] 툴바에 닿기 전에 마지막 행을 떠났다 (${reach.testId || "(없음)"})`
      );
    }
    await login.keyboard.press("Tab");
  }
  const beforeArrow = await login.evaluate(
    `document.activeElement && document.activeElement.hasAttribute("data-toolbar-item")
      ? (document.activeElement.getAttribute("data-testid") || "")
      : ""`
  );
  if (!beforeArrow) {
    throw new Error(`[키보드 ${scheme}] 툴바 항목에 닿지 못했다`);
  }
  await login.keyboard.press("ArrowRight");
  const afterArrow = await login.evaluate(
    `document.activeElement ? (document.activeElement.getAttribute("data-testid") || "") : ""`
  );
  if (!afterArrow || afterArrow === beforeArrow) {
    throw new Error(
      `[키보드 ${scheme}] 툴바 ←/→ 가 ${beforeArrow}에서 움직이지 않았다`
    );
  }
  await login.keyboard.press("ArrowLeft");
  const backArrow = await login.evaluate(
    `document.activeElement ? (document.activeElement.getAttribute("data-testid") || "") : ""`
  );
  if (backArrow !== beforeArrow) {
    throw new Error(
      `[키보드 ${scheme}] ← 가 ${afterArrow}에서 ${beforeArrow}로 돌아오지 못했다 (${backArrow || "(없음)"})`
    );
  }
  console.log(
    `  키보드 ${scheme}: Tab → 행 · 툴바 마운트 · → ${beforeArrow} → ${afterArrow} → ${backArrow}`
  );
  await login.waitForTimeout(300);
  const actionsFocusShot = `${OUT_DIR}/b11-message-actions-focus-${scheme}.png`;
  await login.screenshot({ path: actionsFocusShot });
  shots.push(actionsFocusShot);

  // 2e. 그 진입점이 여는 것 (goal B11 R2 H1). 키보드 사용자는 행당 하나의
  //     진입점으로 같은 액션 **전부**에 닿아야 한다. Enter로 열고, 방향키가
  //     실제로 항목 사이를 도는지 확인하고, Esc가 포커스를 진입점에 돌려주는지
  //     까지 같은 시퀀스에서 잰다.
  for (let press = 0; press < 8; press++) {
    const onOverflow = await login.evaluate(
      `document.activeElement ? document.activeElement.getAttribute("data-testid") : ""`
    );
    if (onOverflow === "message-actions-trigger") break;
    await login.keyboard.press("ArrowRight");
  }
  await login.keyboard.press("Enter");
  await login.getByTestId("message-action-menu").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const menuShot = `${OUT_DIR}/b11-message-action-menu-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: menuShot });
  shots.push(menuShot);
  //     포커스는 **표본이 아니라 조건**으로 읽는다 (goal QA-flake). 사연은
  //     `focusedMenuItem` 주석에 있다: Radix의 roving focus가 포커스를
  //     `setTimeout`으로 옮기므로, 키를 누른 직후의 한 번 읽기는 옮기기 전
  //     상태를 볼 수 있고 그것이 두 번째 플레이크였다.
  const firstItem = await focusedMenuItem(login, `메뉴 ${scheme}`);
  await login.keyboard.press("ArrowDown");
  //     그리고 포커스가 그 항목을 **떠날 때까지**. 끝내 떠나지 않으면 그때가
  //     진짜 결함이고, 그 자리에서 무엇이 포커스를 쥐고 있었는지까지 말한다.
  const secondItem = await focusedMenuItem(login, `메뉴 ${scheme}`, {
    not: firstItem.testId,
  });
  console.log(
    `  메뉴 ${scheme}: 항목 ${firstItem.items}개, ↓로 ${firstItem.testId} → ${secondItem.testId}`
  );
  await login.keyboard.press("Escape");
  await login.getByTestId("message-action-menu").waitFor({ state: "hidden" });
  await waitForFocus(
    login,
    "message-actions-trigger",
    `메뉴 ${scheme}`,
    "Esc 뒤 포커스는 진입점으로 돌아가야 한다"
  );

  // 2e-d3. UX-D3 (#1755): 새 메뉴 항목을 실제로 누르고 클립보드를 읽는다.
  //     세 표면(⋯ · 우클릭 · 시트) 중 포인터 둘. 시트는 captureMobile.
  await actionRow.hover();
  await login.getByTestId("message-actions-trigger").last().click();
  await login.getByTestId("message-action-menu").waitFor({ state: "visible" });
  if ((await login.getByTestId("menu-copy-link").count()) !== 1) {
    throw new Error(`[메뉴 ${scheme}] 링크 복사가 없다`);
  }
  await login.getByTestId("menu-copy").click();
  await login.getByTestId("menu-copy").getByText("메시지 복사됨").waitFor();
  await assertCopiedClipboard(login, `⋯ 메시지 복사 ${scheme}`, ACTION_ROW_BODY);
  await login.getByTestId("menu-copy-link").click();
  await login.getByTestId("menu-copy-link").getByText("링크 복사됨").waitFor();
  const menuMessageId = await actionRow.getAttribute("data-message-id");
  const menuSeq = await actionRow.getAttribute("data-seq");
  if (!menuMessageId) {
    throw new Error(`[메뉴 ${scheme}] 마지막 행에 data-message-id가 없다`);
  }
  const copiedLink = await readCopiedShareUrl(login, `⋯ 링크 복사 ${scheme}`, {
    messageId: menuMessageId,
    seq: menuSeq,
  });
  await login.keyboard.press("Escape");
  await login.getByTestId("message-action-menu").waitFor({ state: "hidden" });

  await actionRow.click({ button: "right", position: { x: 180, y: 24 } });
  await login.getByTestId("message-context-menu").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const contextShot = `${OUT_DIR}/b11-message-context-menu-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: contextShot });
  shots.push(contextShot);
  await login.getByTestId("context-copy").click();
  await login.getByTestId("context-copy").getByText("메시지 복사됨").waitFor();
  await assertCopiedClipboard(login, `우클릭 메시지 복사 ${scheme}`, ACTION_ROW_BODY);
  await login.getByTestId("context-copy-link").click();
  await login.getByTestId("context-copy-link").getByText("링크 복사됨").waitFor();
  await assertCopiedClipboard(login, `우클릭 링크 복사 ${scheme}`, copiedLink);
  await login.keyboard.press("Escape");
  await login.getByTestId("message-context-menu").waitFor({ state: "hidden" });
  console.log(`  메뉴 ${scheme}: ⋯·우클릭 클립보드 항목 누름`);
  await assertShareUrlLands(context, copiedLink, login, `⋯ 링크 ${scheme}`);

  // 2f. 고치기, 제자리에서 (goal B11). 다이얼로그가 아니라 행 안이다: 고치는
  //     대상이 대화의 한 줄이고, 무엇을 쓸지 알려주는 것은 그 주변 메시지다.
  await actionRow.hover();
  await login.getByTestId("message-actions-trigger").last().click();
  await login.getByTestId("menu-edit").click();
  await login.getByTestId("message-editor-input").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  // R2 M3 회귀: 편집 중인 행에는 hover 진입점이 없어야 한다. 1라운드에서는 바가
  // 편집기 테두리에 겹친 채 살아 있었고, 그 상태로 「지우기」가 눌렸다.
  const triggerWhileEditing = await login.evaluate(`(() => {
    const row = document.querySelector('[data-testid="message-editor"]')?.closest(
      '[data-testid="timeline-message"]'
    );
    if (!row) return -1;
    return row.querySelectorAll('[data-testid="message-actions-trigger"]').length;
  })()`);
  if (triggerWhileEditing !== 0) {
    throw new Error(
      `[편집 ${scheme}] 편집 중인 행에 액션 진입점이 ${triggerWhileEditing}개 남아 있다`
    );
  }
  const editShot = `${OUT_DIR}/b11-message-edit-${scheme}.png`;
  await login.screenshot({ path: editShot });
  shots.push(editShot);
  await login.getByTestId("message-editor-cancel").click();

  // 2g. 지우기 확인 (goal B11). 되돌리기가 아니라 확인이다 — 서버의 삭제는 본문을
  //     지우는 tombstone이라 되돌릴 것이 남지 않는다.
  await actionRow.hover();
  await login.getByTestId("message-actions-trigger").last().click();
  await login.getByTestId("menu-delete").click();
  await login.getByTestId("delete-message-dialog").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const deleteShot = `${OUT_DIR}/b11-message-delete-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: deleteShot });
  shots.push(deleteShot);
  await login.getByTestId("delete-message-cancel").click();

  // 2h. 반응 고르기 (#1742). 자작 피커: 검색·카테고리·빈도·스킨톤, 포인터는
  //     트리거 기준 popover. 라이브러리는 여전히 없다 (CSP + 오프라인 셸).
  await actionRow.hover();
  await login.getByTestId("message-actions-trigger").last().click();
  await login.getByTestId("menu-react-more").click();
  await login.getByTestId("reaction-picker").waitFor({ state: "visible" });
  await login.getByTestId("emoji-search").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const pickerShot = `${OUT_DIR}/b11-reaction-picker-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: pickerShot });
  shots.push(pickerShot);
  await login.keyboard.press("Escape");
  await login.getByTestId("reaction-picker").waitFor({ state: "detached" });
  await waitForAnimations(login);
  // 2i. 같은 피커를 메시지 반응과 컴포저 삽입이 공유한다 (#1742).
  //     패널은 caret에 넣는 동안에도 opener를 기억해 Esc/선택 뒤 포커스를
  //     컴포저의 명시적인 진입점으로 돌린다.
  await login.getByTestId("composer-emoji-trigger").click();
  await login.getByTestId("composer-emoji-picker").waitFor({ state: "visible" });
  await login.getByTestId("emoji-search").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  await assertEmojiAnchor(
    login,
    `channel ${scheme}`,
    "composer-emoji-trigger",
    "composer-emoji-picker"
  );
  const composerEmojiShot = `${OUT_DIR}/u4-composer-emoji-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: composerEmojiShot });
  shots.push(composerEmojiShot);
  await login.keyboard.press("Escape");
  await login.getByTestId("composer-emoji-picker").waitFor({ state: "detached" });
  await waitForAnimations(login);
  // 2j. 스레드도 채널과 같은 메시지 입력 능력(멘션·첨부·이모지)을 갖는다
  //     (#1688). 기존 답글 컴포저/첨부 트레이를 유지하고 공용 멘션 층을 붙였다.
  await login.getByTestId("thread-anchor").first().click();
  await login.getByTestId("thread-panel").waitFor({ state: "visible" });
  await assertWideRowsFillOnly(login, `thread ${scheme}`);
  const threadComposer = login.getByTestId("thread-composer-input");
  await threadComposer.waitFor({ state: "visible" });
  const threadFileInputs = await login
    .getByTestId("thread-composer")
    .locator('input[type="file"]')
    .count();
  if (threadFileInputs !== 1) {
    throw new Error(
      `[thread ${scheme}] 첨부 input은 하나여야 하지만 ${threadFileInputs}개다`
    );
  }
  await assertComposerVesselClick(login, `thread ${scheme}`, {
    input: "thread-composer-input",
    actions: "thread-composer-actions",
    frame: "thread-composer-frame",
  });
  await assertMentionTrigger(login, `thread ${scheme}`, {
    input: "thread-composer-input",
    trigger: "thread-composer-mention-trigger",
    list: "thread-mention-list",
  });
  await login.getByTestId("thread-mention-list").waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  await assertNoHorizontalOverflow(login, `thread panel ${scheme}`);
  // goal P3 1-1: 이미 열어 둔 스레드의 「답글 N개」는 읽는 값이지 누르는 것이 아니다.
  await assertThreadRollupPlacement(login, `thread panel ${scheme}`);
  await assertThreadRootHoverToolbar(login, scheme);
  // 호버 프레임은 자기 이름으로 찍고(#1753 N-1), 패리티 사진은 마우스를 치운
  // rest 상태로 되돌린다 — hover 잔상이 다른 목적의 사진에 앉지 않게.
  const threadHoverShot = `${OUT_DIR}/thread-root-hover-${scheme}.png`;
  await login.screenshot({ path: threadHoverShot });
  shots.push(threadHoverShot);
  await login.mouse.move(8, 8);
  await login
    .getByTestId("thread-panel")
    .getByTestId("message-hover-toolbar")
    .waitFor({ state: "detached" });
  const threadShot = `${OUT_DIR}/u4-thread-composer-parity-${scheme}.png`;
  await login.screenshot({ path: threadShot });
  shots.push(threadShot);
  await login.keyboard.press("Escape");
  await threadComposer.fill("");
  await login.getByTestId("thread-composer-emoji-trigger").click();
  await login
    .getByTestId("thread-composer-emoji-picker")
    .waitFor({ state: "visible" });
  await assertEmojiAnchor(
    login,
    `thread ${scheme}`,
    "thread-composer-emoji-trigger",
    "thread-composer-emoji-picker"
  );
  await login.keyboard.press("Escape");
  await login
    .getByTestId("thread-composer-emoji-picker")
    .waitFor({ state: "detached" });
  await waitForAnimations(login);
  const threadStillOpen = await login.getByTestId("thread-panel").count();
  if (threadStillOpen !== 1) {
    throw new Error(
      `[thread ${scheme}] picker Escape left thread-panel count=${threadStillOpen} (want 1)`
    );
  }
  await login.getByTestId("thread-close").click();

  // 2j-2. 답글 0개 분기(#1753 M-2): 점선 빈 상태 상자의 자연 경로는 「아직 답글
  //       없는 행에서 툴바 [답글]로 스레드를 여는 것」이다 — 이미 연 스레드는
  //       클라 스토어가 답글을 기억해 빈 상태로 돌아가지 않는다. 이 루트의
  //       replies 응답만 page 라우트로 비운다(page가 context보다 먼저 매칭).
  await login.route(
    "**/v1/workspaces/*/channels/*/messages/*/replies*",
    (route) => json(route, { messages: [] })
  );
  await login.waitForTimeout(300);
  // 화면 안 마지막 actionable 행을 스크롤 없이 hover한다 — Virtuoso가 스크롤로
  // 행을 리마운트하면 locator와 실제 hover 대상이 어긋난다. 툴바는 전역 1개
  // 불변식(탭 스톱 자)이 있으므로 전역 locator로 잡는다.
  // 앞 레인이 행에 남긴 키보드 포커스를 컴포저로 옮긴다 — 포커스 행+호버 행이
  // 갈리면 툴바가 2개 떠서(hover∨focus 계약) 전역 locator가 흔들린다.
  await login.getByTestId("composer-input").click();
  const freshThreadRow = login
    .locator('[data-testid="timeline-message"][data-actionable="true"]')
    .last();
  await freshThreadRow.hover();
  const freshToolbar = freshThreadRow.getByTestId("message-hover-toolbar");
  await freshToolbar.waitFor({ state: "visible" });
  await freshToolbar.getByTestId("toolbar-reply").click();
  await login.getByTestId("thread-panel").waitFor({ state: "visible" });
  await login.getByTestId("thread-empty").waitFor({ state: "visible" });
  await login.mouse.move(8, 8);
  await assertNoHorizontalOverflow(login, `thread empty ${scheme}`);
  const threadEmptyShot = `${OUT_DIR}/thread-empty-${scheme}.png`;
  await login.screenshot({ path: threadEmptyShot });
  shots.push(threadEmptyShot);
  await login.unroute("**/v1/workspaces/*/channels/*/messages/*/replies*");
  await login.getByTestId("thread-close").click();

  // 2j. 그래서 이 타임라인을 키보드로 지나가는 데 얼마가 드는가 (goal B11 R2 H1).
  //     리뷰가 센 것과 같은 자다. 실측 16번(그려진 11행 + 본문 링크 + 카드 안
  //     컨트롤)이고 상한은 24번이다: 행마다 컨트롤이 하나 더 늘면 11이 더해져
  //     바로 넘는다. 1라운드의 액션 바(행당 6개)는 근처에도 오지 못한다.
  await countTabStopsToComposer(login, `desktop ${scheme}`, 24);

  // 3a. 채널 만들기 다이얼로그 (MOMO-614): the form the sidebar + opens, filled
  //     the way a person fills it. This is the surface that replaced the
  //     /settings dead end, so it is reviewed in both schemes.
  await revealNewChannel(login);
  await login.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  await login.getByTestId("create-channel-name").fill("release-rollback");
  await login
    .getByTestId("create-channel-topic")
    .fill("배포와 롤백 절차, 당번 인계를 한곳에서");
  // The focus ring rides `transition-colors` (150ms), so a frame shot the
  // instant after focus catches the ring mid-interpolation and reviews a color
  // the product never rests on. Let it settle first.
  await login.waitForTimeout(300);
  const createShot = `${OUT_DIR}/channel-create-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: createShot });
  shots.push(createShot);

  // 3a-2. 서버 거절은 필드 옆에 (MOMO-614): 이미 있는 이름을 보내면 409가 이름
  //       상자 밑에 붙고, 입력한 값은 그대로 남는다. 토스트 아님.
  await login.getByTestId("create-channel-name").fill("general");
  await login.getByTestId("create-channel-submit").click();
  await login
    .getByTestId("create-channel-name-error")
    .waitFor({ state: "visible" });
  await login.waitForTimeout(300);
  const createErrorShot = `${OUT_DIR}/channel-create-error-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: createErrorShot });
  shots.push(createErrorShot);

  // 3a-3. 진행 중 (MOMO-614 R1): 제출 버튼 안 스피너 + 라벨. 흐린 라벨 하나가
  //       유일한 진행 신호였던 프레임이라, 두 스킴 모두에서 다시 본다. 응답을
  //       늦추는 라우트는 이 페이지에만 걸고 곧바로 걷는다.
  await login.route("**/v1/workspaces/*/channels", async (route) => {
    if (route.request().method() === "POST") {
      await new Promise((r) => setTimeout(r, 2_000));
    }
    return route.fallback();
  });
  await login.getByTestId("create-channel-name").fill("release-rollback");
  await login.getByTestId("create-channel-submit").click();
  await login
    .locator('[data-testid="create-channel-submit"][aria-busy="true"]')
    .waitFor({ state: "visible" });
  await login.waitForTimeout(200);
  const createPendingShot = `${OUT_DIR}/channel-create-pending-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: createPendingShot });
  shots.push(createPendingShot);
  await login.getByTestId("create-channel-dialog").waitFor({ state: "detached" });
  await login.unroute("**/v1/workspaces/*/channels");

  // 3a-4. 오프라인 (MOMO-614 R1 / R-1 5장): 배너 한 줄 + 만들기 버튼 disabled.
  //       레일의 disconnected는 종단 절단에서만 오므로 브라우저가 아는 오프라인도
  //       함께 읽는다. 여기서는 그 브라우저 신호를 실제로 끊어 확인한다.
  await context.setOffline(true);
  await revealNewChannel(login);
  await login.getByTestId("create-channel-dialog").waitFor({ state: "visible" });
  await login.getByTestId("create-channel-offline").waitFor({ state: "visible" });
  await login.waitForTimeout(200);
  const createOfflineShot = `${OUT_DIR}/channel-create-offline-${scheme}.png`;
  await waitForAnimations(login);
  await login.screenshot({ path: createOfflineShot });
  shots.push(createOfflineShot);
  await context.setOffline(false);
  await login.getByTestId("create-channel-cancel").click();
  await login.getByTestId("create-channel-dialog").waitFor({ state: "detached" });

  // 3a-3. 빈 워크스페이스 (MOMO-614): 채널이 0개일 때 남는 유일한 행동. 이 화면의
  //       [채널 만들기]가 /settings로 보내던 막다른 골목이었고, 이제 위의
  //       다이얼로그를 연다. 이 페이지에서만 채널 목록을 비운다.
  const emptyWorkspace = await context.newPage();
  await emptyWorkspace.route("**/v1/workspaces/*/channels", (route) =>
    route.request().method() === "POST"
      ? route.fallback()
      : json(route, { channels: [] })
  );
  await emptyWorkspace.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(emptyWorkspace);
  await emptyWorkspace.getByTestId("chat-no-channel").waitFor({ state: "visible" });
  const emptyShot = `${OUT_DIR}/workspace-empty-${scheme}.png`;
  await emptyWorkspace.screenshot({ path: emptyShot });
  shots.push(emptyShot);

  // 3a-5. 만들 권한이 없는 멤버가 보는 같은 화면 (MOMO-614): +도 팔레트 항목도
  //       없고, 대신 누가 만들 수 있는지 말한다. requireWorkspaceAdmin이 거절할
  //       버튼을 내주지 않는 것이 이 티켓이 없앤 막다른 골목의 반대편이다.
  const nonAdmin = await context.newPage();
  await nonAdmin.route("**/v1/workspaces/*/channels", (route) =>
    route.request().method() === "POST"
      ? route.fallback()
      : json(route, { channels: [] })
  );
  await nonAdmin.route("**/v1/workspaces/*/roster", (route) =>
    json(route, {
      members: ROSTER.map((m) =>
        m.id === ME ? { ...m, role: "member" } : m
      ),
    })
  );
  await nonAdmin.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(nonAdmin);
  await nonAdmin.getByTestId("chat-no-channel").waitFor({ state: "visible" });
  const nonAdminShot = `${OUT_DIR}/workspace-empty-nonadmin-${scheme}.png`;
  await nonAdmin.screenshot({ path: nonAdminShot });
  shots.push(nonAdminShot);

  // 3a-6. 설정 > 워크스페이스, 멤버가 보는 역할 표시명 (#1770 R2 L-R2-1).
  //       스윕 로그인 픽스처는 owner라 settings-workspace는 편집 폼만 남는다.
  //       위 3a-5와 같은 roster remap으로 KeyValueRows 멤버 뷰를 찍는다.
  //       403 저장 고지는 찍지 않는다: 워크스페이스 픽스처가 PATCH를 성공으로
  //       답하고, 성공 경로를 꺾어 403을 만드는 것은 억지 모킹이다. 그 문장은
  //       WorkspaceSection.test.tsx가 계약으로 붙잡는다.
  const memberSettings = await context.newPage();
  await memberSettings.route("**/v1/workspaces/*/roster", (route) =>
    json(route, {
      members: ROSTER.map((m) =>
        m.id === ME ? { ...m, role: "member" } : m
      ),
    })
  );
  await memberSettings.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(memberSettings);
  await memberSettings.evaluate('location.hash = "/settings?section=workspace"');
  await memberSettings.getByTestId("settings-route").waitFor({ state: "visible" });
  await memberSettings
    .getByRole("heading", { name: "워크스페이스", exact: true })
    .first()
    .waitFor({ state: "visible" });
  await memberSettings
    .getByTestId("workspace-role-labels")
    .waitFor({ state: "visible" });
  const memberForm = await memberSettings.locator("#role-label-owner").count();
  if (memberForm > 0) {
    throw new Error(
      `[설정 워크스페이스 멤버 ${scheme}] owner 폼이 그려졌다 — 롤 픽스처 누락`
    );
  }
  await memberSettings.waitForTimeout(250);
  const memberSettingsShot = `${OUT_DIR}/settings-workspace-member-${scheme}.png`;
  await memberSettings.screenshot({ path: memberSettingsShot });
  shots.push(memberSettingsShot);

  // 3b. 멤버 디렉터리 (MOMO-611): the roster as a list, the role labels, the
  //     human/agent split, and the row that opens the shared profile card.
  const directory = await context.newPage();
  await directory.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(directory);
  await directory.evaluate('location.hash = "/directory"');
  await directory.getByTestId("directory-row").first().waitFor({ state: "visible" });
  const directoryShot = `${OUT_DIR}/directory-${scheme}.png`;
  await directory.screenshot({ path: directoryShot });
  shots.push(directoryShot);

  // 3c. ⌘K with the 사람 section: channels, DMs and people in one palette. The
  //     query is typed, which is how the palette is actually used, and "김"
  //     lands on the pair a directory has to keep apart (a human and an agent
  //     whose display names are both 김인턴).
  await directory.getByTestId("open-quick-switcher").click();
  await directory.getByTestId("quick-switcher-input").fill("김");
  await directory.getByTestId("switcher-person").first().waitFor({ state: "visible" });
  const switcherShot = `${OUT_DIR}/quick-switcher-people-${scheme}.png`;
  await directory.screenshot({ path: switcherShot });
  shots.push(switcherShot);
  await directory.keyboard.press("Escape");

  // 3d. the DM that a directory profile opens: same timeline anatomy as a channel.
  await directory
    .locator('[data-testid="directory-row"][data-member-kind="agent"]')
    .first()
    .click();
  await directory.getByTestId("member-profile-dialog").waitFor({ state: "visible" });
  await directory.getByTestId("member-profile-dm").click();
  await directory.getByTestId("composer-input").waitFor({ state: "visible" });
  await directory.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await assertPausedNoticeFolded(directory, `dm ${scheme}`);
  const dmShot = `${OUT_DIR}/dm-${scheme}.png`;
  await directory.screenshot({ path: dmShot });
  shots.push(dmShot);

  // 3f. 에이전트 허브 (goal B5.3b, D-4): 명부 왼쪽, 프로필 카드와 채널 배치
  //     오른쪽. 이 한 판이 "이 에이전트가 무슨 모델로 어디에서 돌고 있나"에
  //     답해야 하는 화면이라, 카드와 채널 목록이 같은 프레임에 들어와야 한다.
  const agentHub = await context.newPage();
  await agentHub.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(agentHub);
  await agentHub.evaluate('location.hash = "/agents"');
  await agentHub.getByTestId("agent-hub-profile-card").waitFor({ state: "visible" });
  await agentHub.getByTestId("agent-hub-channels").waitFor({ state: "visible" });
  await assertWideRowsFillOnly(agentHub, `agent hub ${scheme}`);
  const agentHubShot = `${OUT_DIR}/agent-hub-${scheme}.png`;
  await agentHub.screenshot({ path: agentHubShot });
  shots.push(agentHubShot);
  const toolsViewport = await frameEnabledToolsSection(
    agentHub,
    `agent-hub-tools ${scheme}`
  );
  const agentHubToolsShot = `${OUT_DIR}/agent-hub-tools-${scheme}.png`;
  await agentHub.screenshot({ path: agentHubToolsShot });
  shots.push(agentHubToolsShot);
  await agentHub.setViewportSize(toolsViewport);

  // 3f-2. 에이전트 만들기, 사람이 채우는 대로 채운 상태. 자격증명 줄이 폼 안에
  //       있는지가 이 프레임의 요점이다 (ADR-0004: 여기에는 키를 넣지 않는다).
  await agentHub.getByTestId("agent-hub-create").click();
  await agentHub.getByTestId("create-agent-dialog").waitFor({ state: "visible" });
  await agentHub.getByTestId("create-agent-display-name").fill("배포당번");
  await agentHub.getByTestId("create-agent-handle").fill("release-duty");
  await agentHub.getByTestId("create-agent-model").fill("hermes-agent");
  await agentHub
    .getByTestId("create-agent-base-url")
    .fill("https://gateway.dawn.internal/v1");
  await agentHub
    .getByTestId("create-agent-instructions")
    .fill("배포 전 롤백 절차를 먼저 확인하고, 확인되지 않은 것은 확인되지 않았다고 적습니다.");
  // 포커스 링은 transition-colors(150ms)를 타므로, 방금 포커스한 프레임을 찍으면
  // 제품이 한 번도 머무르지 않는 중간 색을 리뷰하게 된다.
  await agentHub.waitForTimeout(300);
  const agentCreateShot = `${OUT_DIR}/agent-create-${scheme}.png`;
  await agentHub.screenshot({ path: agentCreateShot });
  shots.push(agentCreateShot);

  // 3f-3. 서버 거절은 필드 옆에: 이미 있는 핸들을 보내면 409가 핸들 상자 밑에
  //       붙고, 입력한 값은 그대로 남는다. 토스트 아님.
  await agentHub.getByTestId("create-agent-handle").fill("hermes");
  await agentHub.getByTestId("create-agent-submit").click();
  await agentHub
    .getByTestId("create-agent-handle-error")
    .waitFor({ state: "visible" });
  await agentHub.waitForTimeout(300);
  const agentCreateErrorShot = `${OUT_DIR}/agent-create-error-${scheme}.png`;
  await agentHub.screenshot({ path: agentCreateErrorShot });
  shots.push(agentCreateErrorShot);
  await agentHub.getByTestId("create-agent-cancel").click();
  await agentHub.getByTestId("create-agent-dialog").waitFor({ state: "detached" });

  // 3f-4. 편집 표면이 없는 서버 (diff matrix D-4의 현재 형상): allowed-models가
  //       404면 프로필 쓰기와 일시정지도 없다. 화면은 읽기는 그대로 두고 저장을
  //       잠근 채 왜 잠겼는지 말해야 한다. 이 프레임이 없으면 "저장하면
  //       만들어집니다"라고 약속하고 404를 돌려주던 상태로 되돌아가기 쉽다.
  const readOnlyHub = await context.newPage();
  await readOnlyHub.route("**/v1/workspaces/*/agents/*/allowed-models", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "not found" } }),
    })
  );
  await readOnlyHub.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(readOnlyHub);
  await readOnlyHub.evaluate('location.hash = "/agents"');
  await readOnlyHub
    .getByTestId("agent-hub-edit-unsupported")
    .waitFor({ state: "visible" });
  const agentHubReadOnlyShot = `${OUT_DIR}/agent-hub-readonly-${scheme}.png`;
  await readOnlyHub.screenshot({ path: agentHubReadOnlyShot });
  shots.push(agentHubReadOnlyShot);

  // 3g. 결정 대기 두 프레임 — **복원됨** (goal W-AP1 2R M7).
  //
  //     이 자리는 goal P3 후속에서 비워져 있었고, 그때의 주석이 되살릴 조건을 미리
  //     적어 뒀다: "`serverSurfaces.ts`의 `approvals.provided`가 true가 되면 아래
  //     목이 그대로 다시 먹으므로 두 프레임을 이 자리에 복원하면 된다." 그 조건이
  //     충족됐다 — goal SRV-T1이 승인 3라우트를 올렸고 W-AP1이 판정을 뒤집었다.
  //     예고한 자리를 예고한 대로 되살린다. 위 APPROVALS 픽스처와 그 아래 목을
  //     한 글자도 바꾸지 않고 그대로 쓴다.
  //
  //     찍는 것은 둘이고, 각각이 증명하는 것이 다르다:
  //       ① 목록  판단에 필요한 사실(누가·무엇을·언제까지·되돌릴 수 있는지)이
  //               행에 이미 있어서, 결정하러 채널로 들어갈 필요가 없다.
  //       ② 확인  한 번의 무방비 클릭으로는 아무것도 결정되지 않는다
  //               (SKILL §6: 승인/거부는 무장이고, 확정이 결정이다). 첫 행은
  //               `is_reversible: false`라 확정 문장이 그 사실을 재진술한다.
  const approvals = await context.newPage();
  await approvals.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(approvals);
  await approvals.evaluate('location.hash = "/inbox?filter=needs-action"');
  await approvals.getByTestId("inbox-list").waitFor({ state: "visible" });
  await approvals
    .getByTestId("inbox-approval-approve")
    .first()
    .waitFor({ state: "visible" });
  await assertWideRowsFillOnly(approvals, `inbox ${scheme}`);
  await approvals.evaluate('location.hash = "/activity"');
  await approvals.getByTestId("activity-route").waitFor({ state: "visible" });
  await approvals
    .locator(
      '[data-testid="feed-row"], [data-testid="activity-list"], [data-testid="activity-empty"], [data-testid="activity-unavailable"], [data-testid="activity-error"]'
    )
    .first()
    .waitFor({ state: "visible" });
  await assertWideRowsFillOnly(approvals, `activity ${scheme}`);
  await approvals.evaluate('location.hash = "/inbox?filter=needs-action"');
  await approvals.getByTestId("inbox-list").waitFor({ state: "visible" });
  const approvalsShot = `${OUT_DIR}/approvals-${scheme}.png`;
  await approvals.screenshot({ path: approvalsShot });
  shots.push(approvalsShot);

  await approvals.getByTestId("inbox-approval-approve").first().click();
  await approvals
    .getByTestId("inbox-approval-confirm")
    .first()
    .waitFor({ state: "visible" });
  const approvalsConfirmShot = `${OUT_DIR}/approvals-confirm-${scheme}.png`;
  await approvals.screenshot({ path: approvalsConfirmShot });
  shots.push(approvalsConfirmShot);

  //     ③ 호스트 선택기 (이슈 1114). 위 두 프레임이 이미 그것을 담고 있지만, 이
  //        한 장은 **확정 문장이 목적지를 말하는 순간**을 다른 호스트에서 잡는다:
  //        사람이 팀 VPS로 바꾼 뒤 무장하면 잠긴 라디오 옆에서 문장이
  //        「팀 VPS」를 말해야 한다. 두 조각(고른 것 / 말한 것)이 어긋나면 사진
  //        한 장에서 바로 보인다.
  await approvals.keyboard.press("Escape");
  await approvals
    .getByTestId(
      "inbox-approval-host-radio-019f9b10-0000-7000-8000-00000000c002"
    )
    .check();
  await approvals.getByTestId("inbox-approval-approve").first().click();
  await approvals
    .getByTestId("inbox-approval-confirm")
    .first()
    .waitFor({ state: "visible" });
  const spawnPickerShot = `${OUT_DIR}/approvals-host-picker-${scheme}.png`;
  await approvals.screenshot({ path: spawnPickerShot });
  shots.push(spawnPickerShot);

  //     ④ **고를 것이 하나도 없을 때** (design-review M2가 미캡처로 남긴 자리).
  //
  //        이 갈래가 이 배치의 fail-closed 문이다: 서버가 409로 답할 것을 결정
  //        전에 말하고, 승인은 실제로 불가용해지며(채움을 버리고 조용한 형태로
  //        강등된다), 거부만 열린 채 남는다. 앞 판의 캡처 세트는 자격 있는 후보가
  //        있는 픽스처 하나뿐이라 그 상태를 한 번도 찍지 못했고, 리뷰는 그것을
  //        「증거 없음」으로 판정했다. 폰은 같은 장면을 이미 갖고 있다
  //        (`measure/captures/ade1-spawn-picker.png`의 두 번째 카드).
  //
  //        라우트를 **갈아끼우지 않고** 쿼리 플래그로 가른다: 같은 목이 두 답을
  //        내면 어느 프레임이 어느 픽스처였는지 사진만 보고는 말할 수 없다.
  const blockedPage = await context.newPage();
  await blockedPage.route("**/v1/workspaces/*/approvals*", (route) => {
    const url = new URL(route.request().url());
    if (url.searchParams.get("status") !== "pending") {
      return json(route, { approvals: [] });
    }
    const [spawn, ...rest] = APPROVALS;
    return json(route, {
      approvals: [
        {
          ...spawn,
          payload: {
            ...spawn.payload,
            execution: {
              ...SPAWN_EXECUTION,
              // 서버가 자격 있는 것을 하나도 못 찾으면 기본값이 없다.
              default_host_id: null,
              host_candidates: SPAWN_EXECUTION.host_candidates.filter(
                (candidate) => !candidate.selectable
              ),
            },
          },
        },
        ...rest,
      ],
    });
  });
  await blockedPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(blockedPage);
  await blockedPage.evaluate('location.hash = "/inbox?filter=needs-action"');
  await blockedPage
    .getByTestId("inbox-approval-host-blocked")
    .first()
    .waitFor({ state: "visible" });
  const spawnBlockedShot = `${OUT_DIR}/approvals-host-blocked-${scheme}.png`;
  await blockedPage.screenshot({ path: spawnBlockedShot });
  shots.push(spawnBlockedShot);
  await blockedPage.close();

  // 3e. agent turn surfaces (MOMO-613): the sidebar pill and the composer
  //     activity list. `?agentwork=live` seeds fixed turns and reports the rail
  //     as connected, so the clock, the 승인 대기 state and the stacked composer
  //     lines are all on screen at once without a socket.
  const turns = await context.newPage();
  await turns.goto(`${ORIGIN}/?agentwork=live`, { waitUntil: "networkidle" });
  await signIn(turns);
  await turns.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await turns.getByTestId("agent-turn-badge").first().waitFor({ state: "visible" });
  await turns.getByTestId("composer-working").waitFor({ state: "visible" });
  // The rich frame is reserved before bytes arrive (#1903 H-1). Wait for
  // the image so the shot shows the OG card, not the muted skeleton.
  await turns.getByTestId("unfurl-image").waitFor({ state: "visible" });
  await assertWideRowsFillOnly(turns, `agent-turns ${scheme}`);
  const turnsShot = `${OUT_DIR}/agent-turns-${scheme}.png`;
  await turns.screenshot({ path: turnsShot });
  shots.push(turnsShot);

  // 3e-2. 그 안내 줄을 화면 안으로 (ADR-0135 D1). 이 줄은 아티팩트에 한 번도 뜬
  //       적이 없다 — 렌더를 확인하지 못한 채 머지 리뷰까지 갔고, 거기서 구조적으로
  //       렌더 불가라는 것이 드러났다(D1/F3). 워커 턴 행에 붙은 모습을 두 스킴
  //       모두에서 남겨 다음 리뷰가 눈으로도 확인할 수 있게 한다.
  //
  // The notice itself is still a GATE: scrollTimelineRowIntoView dies if the
  // worker-turn row is not in this build (the seeded fallback in cascadeRail
  // is keyed to that row's run id).
  await scrollTimelineRowIntoView(
    turns,
    "cascade-notice",
    `agent-turns ${scheme}`
  );
  const cascadeShot = `${OUT_DIR}/cascade-notice-${scheme}.png`;
  await turns.screenshot({ path: cascadeShot });
  shots.push(cascadeShot);

  // 3f. the same turns with the rail down (SKILL §5 offline): the clocks go
  //     away rather than counting on a dead socket, and the banner says why.
  const turnsOffline = await context.newPage();
  await turnsOffline.goto(`${ORIGIN}/?agentwork=offline`, {
    waitUntil: "networkidle",
  });
  await signIn(turnsOffline);
  await turnsOffline
    .getByTestId("timeline-message")
    .first()
    .waitFor({ state: "visible" });
  await turnsOffline
    .getByTestId("agent-turn-badge")
    .first()
    .waitFor({ state: "visible" });
  const turnsOfflineShot = `${OUT_DIR}/agent-turns-offline-${scheme}.png`;
  await turnsOffline.screenshot({ path: turnsOfflineShot });
  shots.push(turnsOfflineShot);

  // BF-A4 (#1887): 설정 > 알림. Chromium 캡처는 셸이 아니므로 권한은 미지원
  // 배너이고, 종류 토글과 서버 DND 그룹이 같은 리듬으로 선다.
  const notificationsPage = await context.newPage();
  await notificationsPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(notificationsPage);
  await notificationsPage.evaluate(
    'location.hash = "/settings?section=notifications"'
  );
  await notificationsPage
    .getByTestId("desktop-notifications-permission")
    .waitFor({ state: "visible" });
  await notificationsPage
    .getByTestId("desktop-notification-kinds")
    .waitFor({ state: "visible" });
  await notificationsPage
    .getByTestId("notification-rules")
    .waitFor({ state: "visible" });
  await assertWideRowsFillOnly(notificationsPage, `settings notifications ${scheme}`);
  const notificationsShot = `${OUT_DIR}/settings-notifications-${scheme}.png`;
  await parkPointerOffViewport(notificationsPage);
  await assertNotificationsDndRest(notificationsPage, scheme);
  await notificationsPage.screenshot({ path: notificationsShot });
  shots.push(notificationsShot);
  await notificationsPage.close();

  // BF-A5 (#1901): 크로스채널 초안 패널. signIn이 localStorage를 비우므로
  // 로그인한 뒤에 심고, 같은 탭 구독이 다시 읽도록 사건을 낸다.
  const draftsPage = await context.newPage();
  await draftsPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(draftsPage);
  await draftsPage.evaluate(`(() => {
    const now = Date.now();
    const prefix = "momo.draft.v1:${WORKSPACE_ID}:";
    localStorage.setItem(prefix + "${GENERAL_ID}", JSON.stringify({
      text: "배포 롤백 근거를 정리하면",
      atMs: now,
    }));
    localStorage.setItem(prefix + "00000000-0000-7000-8000-000000000202", JSON.stringify({
      text: "PR 본문에 게이트 증거를 붙이고\\n두 번째 줄은 미리보기에서 한 줄로 접힌다",
      atMs: now - 60_000,
    }));
    localStorage.setItem(prefix + "${DM_ID}", JSON.stringify({
      text: "hermes 온보딩 문구를 이어서",
      atMs: now - 3_600_000,
    }));
    window.dispatchEvent(new Event("${DRAFTS_CHANGED_EVENT}"));
    window.dispatchEvent(new CustomEvent("momo:composer-seed", {
      detail: {
        workspaceId: "${WORKSPACE_ID}",
        channelId: "${GENERAL_ID}",
        text: "배포 롤백 근거를 정리하면",
      },
    }));
  })()`);
  await draftsPage.getByTestId("nav-drafts").waitFor({ state: "visible" });
  await draftsPage.evaluate('location.hash = "/drafts"');
  try {
    await draftsPage.getByTestId("drafts-list").waitFor({
      state: "visible",
      timeout: 10_000,
    });
  } catch {
    const dump = await draftsPage.evaluate(`(() => ({
      hash: location.hash,
      route: Boolean(document.querySelector('[data-testid="drafts-route"]')),
      list: Boolean(document.querySelector('[data-testid="drafts-list"]')),
      empty: Boolean(document.querySelector('[data-testid="drafts-empty"]')),
      error: Boolean(document.querySelector('[data-testid="drafts-error"]')),
      skeleton: Boolean(document.querySelector('[data-testid="skeleton-row"]')),
      nav: Boolean(document.querySelector('[data-testid="nav-drafts"]')),
      keys: Object.keys(localStorage).filter((key) => key.startsWith("momo.draft")),
      text: (document.getElementById("app-route")?.innerText ?? "").slice(0, 400),
    }))()`);
    throw new Error(`drafts panel capture failed: ${JSON.stringify(dump)}`);
  }
  await assertWideRowsFillOnly(draftsPage, `drafts ${scheme}`);
  const draftsShot = `${OUT_DIR}/drafts-panel-${scheme}.png`;
  await draftsPage.screenshot({ path: draftsShot });
  shots.push(draftsShot);
  await draftsPage.close();

  // BF-B1 (#1888): 인박스 나중에 탭. 두 스킴 + 만기 행. ⋯는 호버로 띄운 뒤
  // 본문 교차 0을 재고, 키보드만으로 지우기 다이얼로그까지 간다.
  const remindersPage = await context.newPage();
  await remindersPage.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(remindersPage);
  await remindersPage.evaluate('location.hash = "/inbox?filter=reminders"');
  await waitForRemindersSettled(remindersPage, `desktop ${scheme}`);
  await assertNoHorizontalOverflow(remindersPage, `reminders ${scheme}`);
  const overdueRow = remindersPage
    .locator('[data-testid="reminder-row"][data-due="overdue"]')
    .first();
  await overdueRow.hover();
  await remindersPage
    .getByTestId("reminder-row-menu")
    .first()
    .waitFor({ state: "visible" });
  await assertReminderOverflowClearsBodyText(remindersPage, `desktop ${scheme}`);
  const remindersShot = `${OUT_DIR}/reminders-${scheme}.png`;
  await remindersPage.screenshot({ path: remindersShot });
  shots.push(remindersShot);
  await remindersPage.getByRole("heading", { name: "인박스" }).hover();
  await assertReminderKeyboardDelete(remindersPage, scheme);
  await remindersPage.close();

  // 3g. 설정 > 코드 실행 호스트 (MOMO-617): the three blocks that decide where an
  //     agent runs. Shot at the top of the panel, where the engine card, the
  //     registry rows and the policy selects all land in one frame.
  const settings = await context.newPage();
  await settings.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(settings);
  await settings.evaluate('location.hash = "/settings?section=code"');
  await settings.getByTestId("work-host-list").waitFor({ state: "visible" });
  await settings.getByTestId("work-tier-policy").waitFor({ state: "visible" });
  const workHostShot = `${OUT_DIR}/settings-work-host-${scheme}.png`;
  await settings.screenshot({ path: workHostShot });
  shots.push(workHostShot);

  // …and the same panel scrolled to its foot, where the three status chips and
  // the two policy scopes sit together. A section this tall is reviewed twice
  // or the half nobody sees is the half that regresses.
  await settings
    .getByTestId("work-tier-policy")
    .scrollIntoViewIfNeeded();
  await settings.waitForTimeout(200);
  const policyShot = `${OUT_DIR}/settings-work-host-policy-${scheme}.png`;
  await settings.screenshot({ path: policyShot });
  shots.push(policyShot);

  // 3h. 설정 > AI 연결 (MOMO-627 / ADR-0135 D1): the singleton card plus the
  //     cascade it heads. Three rows that must stay apart at a glance, the head
  //     being the only one this block cannot edit.
  const aiLink = await context.newPage();
  await aiLink.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiLink);
  await aiLink.evaluate('location.hash = "/settings?section=ai"');
  await aiLink.getByTestId("chain-list").waitFor({ state: "visible" });
  const aiLinkShot = `${OUT_DIR}/settings-ai-chain-${scheme}.png`;
  await aiLink.screenshot({ path: aiLinkShot });
  shots.push(aiLinkShot);

  // …and its foot, where the hop editor's own controls live. A block this tall
  // is reviewed twice or the half nobody sees is the half that regresses.
  await aiLink.getByTestId("chain-add").scrollIntoViewIfNeeded();
  await aiLink.waitForTimeout(200);
  const aiEditShot = `${OUT_DIR}/settings-ai-chain-edit-${scheme}.png`;
  await aiLink.screenshot({ path: aiEditShot });
  shots.push(aiEditShot);

  // …and the probe table, which is the one surface carrying all four
  //     dispositions and therefore all four status tones in one frame.
  await aiLink.getByRole("button", { name: "연결 확인" }).click();
  await aiLink.getByTestId("chain-probe").waitFor({ state: "visible" });
  const aiProbeShot = `${OUT_DIR}/settings-ai-probe-${scheme}.png`;
  await aiLink.screenshot({ path: aiProbeShot });
  shots.push(aiProbeShot);

  // …and a hop that was just added. This frame exists to prove a NEGATIVE: the
  //     empty address field must NOT be red, must not be aria-invalid, and must
  //     keep its format hint. Nothing has happened yet, so there is no error to
  //     report; what the block owes the reader is the next step, once, at the
  //     foot ("6차 provider 주소를 입력하면 저장할 수 있습니다.").
  await aiLink.getByTestId("chain-add").click();
  await aiLink.getByTestId("chain-blocked").waitFor({ state: "visible" });
  await aiLink.getByTestId("chain-blocked").scrollIntoViewIfNeeded();
  await aiLink.waitForTimeout(200);
  const aiNewRowShot = `${OUT_DIR}/settings-ai-chain-new-row-${scheme}.png`;
  await aiLink.screenshot({ path: aiNewRowShot });
  shots.push(aiNewRowShot);

  // …and the probe table with that unsaved hop still on screen. The table is
  //     numbered by the SAVED order, so once the two can disagree it has to say
  //     which of them it is describing: one screen must not carry two meanings
  //     of "3차".
  await aiLink.getByTestId("chain-probe-scope").scrollIntoViewIfNeeded();
  await aiLink.waitForTimeout(200);
  const aiPendingShot = `${OUT_DIR}/settings-ai-probe-pending-${scheme}.png`;
  await aiLink.screenshot({ path: aiPendingShot });
  shots.push(aiPendingShot);

  // 3h-2. a 200 whose entries this client cannot read in full. Read-only, one
  //     banner naming the entry, and no count anywhere that the rows below do
  //     not support.
  const aiPartial = await context.newPage();
  await aiPartial.route("**/v1/provider/link/chain", (route) =>
    json(route, PROVIDER_CHAIN_PARTIAL)
  );
  await aiPartial.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiPartial);
  await aiPartial.evaluate('location.hash = "/settings?section=ai"');
  await aiPartial.getByTestId("chain-partial").waitFor({ state: "visible" });
  await aiPartial.getByTestId("chain-partial").scrollIntoViewIfNeeded();
  await aiPartial.waitForTimeout(200);
  const aiPartialShot = `${OUT_DIR}/settings-ai-chain-partial-${scheme}.png`;
  await aiPartial.screenshot({ path: aiPartialShot });
  shots.push(aiPartialShot);

  // 3i. the same panel against a server built BEFORE the chain landed, which is
  //     the live momowebqa answer today (404, measured 2026-07-26). The block
  //     has to say "this server has no chain yet", never draw an empty chain.
  const aiLegacy = await context.newPage();
  await aiLegacy.route("**/v1/provider/link/chain", (route) =>
    route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ error: { message: "not found" } }),
    })
  );
  await aiLegacy.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiLegacy);
  await aiLegacy.evaluate('location.hash = "/settings?section=ai"');
  await aiLegacy.getByTestId("chain-unavailable").waitFor({ state: "visible" });
  const aiLegacyShot = `${OUT_DIR}/settings-ai-no-chain-${scheme}.png`;
  await aiLegacy.screenshot({ path: aiLegacyShot });
  shots.push(aiLegacyShot);

  // 3j. the self-host DEFAULT: one hop, mock mode, no operator link. This frame
  //     exists because the panel used to call it broken. `probeHop` never calls
  //     a non-external hop, so the check measured nothing, and "지금은 실행이
  //     실패합니다" was a false statement about an instance whose turns succeed
  //     through the bundled mock. It has to read as a mode, not as an outage.
  const aiMock = await context.newPage();
  await aiMock.route("**/v1/provider/link/chain", (route) =>
    json(route, {
      schema: "momo.provider_link.chain.v0",
      entries: [MOCK_ONLY_HOP],
      fallbackCount: 0,
      attemptableCount: 1,
    })
  );
  await aiMock.route("**/v1/provider/link/test", (route) =>
    json(route, {
      schema: "momo.provider_link.test.v0",
      ok: false,
      reason: "not_external_provider",
      source: "environment",
      mode: "local-mock",
      endpointLabel: MOCK_ONLY_HOP.endpointLabel,
      checkedAtMs: Date.now(),
      cascadeOk: false,
      entries: [
        {
          position: 0,
          source: "environment",
          mode: "local-mock",
          endpointLabel: MOCK_ONLY_HOP.endpointLabel,
          enabled: true,
          ok: false,
          reason: "not_external_provider",
          disposition: "propagate",
        },
      ],
    })
  );
  // The singleton above the chain is overridden too, or the shot would show a
  // saved anthropic link heading a mock cascade: a frame the server cannot
  // produce, which makes the screenshot worse than no screenshot. Registered
  // after the two above for the same reason installMocks does it in that order.
  await aiMock.route("**/v1/provider/link", (route) =>
    json(route, {
      schema: "momo.provider_link.v0",
      configured: false,
      source: "environment",
      mode: "local-mock",
      baseUrl: MOCK_ONLY_HOP.baseUrl,
      endpointLabel: MOCK_ONLY_HOP.endpointLabel,
      bearerConfigured: true,
      availability: "mock",
      keyConfigured: true,
      diagnostics: [],
    })
  );
  await aiMock.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(aiMock);
  await aiMock.evaluate('location.hash = "/settings?section=ai"');
  await aiMock.getByTestId("chain-list").waitFor({ state: "visible" });
  await aiMock.getByRole("button", { name: "연결 확인" }).click();
  await aiMock.getByTestId("chain-probe").waitFor({ state: "visible" });
  const aiMockShot = `${OUT_DIR}/settings-ai-mock-mode-${scheme}.png`;
  await aiMock.screenshot({ path: aiMockShot });
  shots.push(aiMockShot);

  // 3k. 설정의 나머지 섹션 (#1057). 위의 3g·3h 는 아홉 섹션 중 둘만 찍었고, 그래서
  //     계정·알림 규칙·워크스페이스·앱·사용량·멤버와 초대를 바꾼 PR 은 커밋된
  //     캡처 없이 리뷰됐다 — design-review 하드 룰의 증거 레인에 뚫린 구멍이었다.
  //
  //     섹션 사이는 **해시 재진입**으로 이동한다. 나란히 클릭으로 넘기는 판이
  //     처음 시도였는데, `앱` 패널이 `wide` 레이아웃이라 그 다음 섹션의 nav 버튼
  //     클릭이 30초 타임아웃으로 죽었다 — 한 섹션의 레이아웃이 다음 섹션의 진입을
  //     좌우하는 순서 의존이다. `SettingsRoute` 는 `?section=` 을 마운트 시 한 번만
  //     읽으므로 `/inbox` 로 튕겨 리마운트시킨다(gate-shell-layout 의 `go()` 와 같은
  //     이유·같은 방식).
  //
  //     각 섹션은 자기 패널의 제목(h2)을 기다린 뒤 찍는다. 기다릴 표지가 없으면
  //     "무엇이 그려졌는지 모르는 스크린샷"이 되고, 그건 에러 경계가 찍힌 판과
  //     구별되지 않는다. 그래서 찍기 전에 에러 경계 부재를 한 번 더 단정한다.
  const settingsSweep = await context.newPage();
  await settingsSweep.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(settingsSweep);
  for (const [section, heading, name] of [
    ["profile", "프로필", "profile"],
    ["account", "계정", "account"],
    ["devices", "기기", "devices"],
    // 설정 > 테마 (U2). 이 스윕은 두 스킴에서 도므로, 선택 화면 **자신이** 라이트와
    // 다크 각각에서 성립하는지가 리뷰 증거로 남는다. 고르는 값은 localStorage이고
    // signIn()이 매번 그것을 비우므로, 찍히는 것은 언제나 기본값(시스템)의 화면이다.
    // 고른 뒤의 화면은 gates/gate-theme.mjs가 실행마다 다시 찍는다.
    ["appearance", "테마", "appearance"],
    ["link-previews", "링크 미리보기", "link-previews"],
    // notifications is owned by the parked-pointer scene above (H6-1).
    // Listing it here overwrote that file with an unguarded hover fill.
    ["workspace", "워크스페이스", "workspace"],
    ["plugins", "앱", "plugins"],
    ["usage", "사용량", "usage"],
    ["webhooks", "웹훅", "webhooks"],
    ["members", "멤버와 초대", "members"],
  ]) {
    await settingsSweep.evaluate('location.hash = "/inbox"');
    await settingsSweep.waitForTimeout(200);
    await settingsSweep.evaluate(
      `location.hash = "/settings?section=${section}"`
    );
    await settingsSweep.getByTestId("settings-route").waitFor({ state: "visible" });
    await settingsSweep
      .getByRole("heading", { name: heading, exact: true })
      .first()
      .waitFor({ state: "visible" });
    if (section === "appearance") {
      await settingsSweep.getByTestId("accent-swatch-dawn").waitFor({
        state: "visible",
      });
      await assertTapTargets(settingsSweep, `appearance ${scheme}`, [
        ["accent-swatch-dawn", "액센트 새벽"],
      ]);
    }
    if (section === "workspace") {
      await settingsSweep
        .getByTestId("workspace-role-labels")
        .waitFor({ state: "visible" });
    }
    await settingsSweep.waitForTimeout(250);
    // 에러 경계가 그려진 판을 "설정 캡처"로 커밋하지 않는다. 이 하네스가 이 섹션들을
    // 찍지 못하던 이유가 정확히 그것(라우트 부재 → 404 → 경계)이었으므로, 픽스처가
    // 다시 새면 캡처가 조용히 빨간 판을 남기는 대신 여기서 죽어야 한다.
    const boundary = await settingsSweep
      .getByText("이 설정을 열지 못했습니다")
      .count();
    if (boundary > 0) {
      throw new Error(`[설정 ${heading} ${scheme}] 에러 경계가 그려졌다 — 픽스처 누락`);
    }
    await assertWideRowsFillOnly(settingsSweep, `settings ${name} ${scheme}`);
    const sectionShot = `${OUT_DIR}/settings-${name}-${scheme}.png`;
    await settingsSweep.screenshot({ path: sectionShot });
    shots.push(sectionShot);
  }

  // ── 설정 > 웹훅 (#1202) ────────────────────────────────────────────────────
  //
  // 스윕이 찍는 것은 목록이 놓인 평상시의 판이다. 아래 두 장은 이 표면에서
  // 한 번뿐이거나 되돌릴 수 없는 두 순간이고, 스크린샷 말고는 리뷰가 볼 방법이
  // 없다: 폐기 확인의 두 번째 단계와, 발급 직후 한 번만 보이는 비밀값 카드.
  const webhooks = await context.newPage();
  await webhooks.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(webhooks);
  await webhooks.evaluate('location.hash = "/settings?section=webhooks"');
  await webhooks.getByTestId("webhook-list").waitFor({ state: "visible" });

  // 확정하지 않는다. 찍는 것은 **묻는 판**이고, 그 판이 존재한다는 사실이 이
  // 표면의 계약이다(한 번의 무방비 클릭으로 살아 있는 수신 주소가 죽지 않는다).
  await webhooks.locator('[data-testid^="webhook-revoke-"]').first().click();
  await webhooks
    .locator('[data-testid^="webhook-revoke-"][data-testid$="-commit"]')
    .first()
    .waitFor({ state: "visible" });
  await webhooks.waitForTimeout(150);
  const revokeShot = `${OUT_DIR}/settings-webhooks-revoke-confirm-${scheme}.png`;
  await webhooks.screenshot({ path: revokeShot });
  shots.push(revokeShot);

  // 회전 확인도 찍는다. 이 프레임은 1차 리뷰에 **없었고**, 그래서 회전과 폐기의
  // 위계(채움은 다르되 경계는 둘 다 컨트롤 경계)를 판단할 근거가 없었다. 확인
  // 프롬프트가 액션 스트립을 대체한다는 것도 여기서만 보인다.
  await webhooks.evaluate('location.hash = "/inbox"');
  await webhooks.waitForTimeout(200);
  await webhooks.evaluate('location.hash = "/settings?section=webhooks"');
  await webhooks.getByTestId("webhook-list").waitFor({ state: "visible" });
  await webhooks.locator('[data-testid^="webhook-rotate-"]').first().click();
  await webhooks
    .locator('[data-testid^="webhook-rotate-"][data-testid$="-commit"]')
    .first()
    .waitFor({ state: "visible" });
  await webhooks.waitForTimeout(150);
  const rotateShot = `${OUT_DIR}/settings-webhooks-rotate-confirm-${scheme}.png`;
  await webhooks.screenshot({ path: rotateShot });
  shots.push(rotateShot);

  // 확인 단계를 걷어내고 발급으로 간다. 라우트를 한 번 튕기는 것이 이 셸에서
  // 패널을 처음 상태로 되돌리는 방법이다(설정 스윕이 쓰는 것과 같은 수법).
  await webhooks.evaluate('location.hash = "/inbox"');
  await webhooks.waitForTimeout(200);
  await webhooks.evaluate('location.hash = "/settings?section=webhooks"');
  await webhooks.getByTestId("webhook-list").waitFor({ state: "visible" });
  await webhooks.getByTestId("webhook-label").fill("배포 알림 (GitHub Actions)");
  await webhooks.getByTestId("webhook-create").click();
  await webhooks.getByTestId("webhook-revealed").waitFor({ state: "visible" });
  await webhooks.waitForTimeout(200);
  const revealShot = `${OUT_DIR}/settings-webhooks-created-${scheme}.png`;
  await webhooks.screenshot({ path: revealShot });
  shots.push(revealShot);

  // ── 설정 > 기기 폰 연결 (#1989, ADR-0180 D7) ──────────────────────────────
  // 프레임 이름에 토큰·딥링크를 넣지 않는다. sas 는 하네스가 장면마다 바꾼다.
  async function openDevicesPage() {
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.evaluate('location.hash = "/inbox"');
    await page.waitForTimeout(200);
    await page.evaluate('location.hash = "/settings?section=devices"');
    await page.getByTestId("settings-route").waitFor({ state: "visible" });
    await page.getByTestId("device-link-card").waitFor({ state: "visible" });
    return page;
  }

  async function shootDevices(page, name) {
    await page.waitForTimeout(250);
    const path = `${OUT_DIR}/settings-devices-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
  }

  resetDeviceLinkHarness();
  const devices = await openDevicesPage();
  await devices.getByTestId("device-link-create").waitFor({ state: "visible" });
  await shootDevices(devices, "idle");

  await devices.getByTestId("device-link-create").click();
  await devices.getByTestId("device-link-qr").waitFor({ state: "visible" });
  await devices.getByTestId("device-link-pending").waitFor({ state: "visible" });
  await shootDevices(devices, "qr");
  await devices.close();

  const railwayDeepLink = `oort://link?server=https%3A%2F%2Foort-production-1a2b.up.railway.app&token=${DEVICE_LINK_CAPTURE_TOKEN}`;
  const selfHostOrigin =
    "https://self-hosted-oort.internal.yeomyeonggeori.example.com:8443";
  const selfHostDeepLink = `oort://link?server=${encodeURIComponent(selfHostOrigin)}&token=${DEVICE_LINK_CAPTURE_TOKEN}`;

  resetDeviceLinkHarness();
  deviceLinkHarness.deepLink = railwayDeepLink;
  const devicesV7 = await openDevicesPage();
  await devicesV7.getByTestId("device-link-create").click();
  await devicesV7.getByTestId("device-link-qr").waitFor({ state: "visible" });
  const v7 = await measureDeviceLinkQrPitch(devicesV7, `v7 ${scheme}`);
  if (v7.modules !== 53) {
    throw new Error(`v7 QR expected 53 modules, got ${v7.modules}`);
  }
  await devicesV7.close();

  resetDeviceLinkHarness();
  deviceLinkHarness.deepLink = selfHostDeepLink;
  const devicesV8 = await openDevicesPage();
  await devicesV8.getByTestId("device-link-create").click();
  await devicesV8.getByTestId("device-link-qr").waitFor({ state: "visible" });
  const v8 = await measureDeviceLinkQrPitch(devicesV8, `v8 ${scheme}`);
  if (v8.modules !== 57) {
    throw new Error(`v8 QR expected 57 modules, got ${v8.modules}`);
  }
  await devicesV8.close();

  resetDeviceLinkHarness();
  deviceLinkHarness.getBody = () => ({
    status: "consumed",
    device: { name: DEVICE_LINK_CAPTURE_DEVICE, platform: "ios" },
  });
  const devicesConfirm = await openDevicesPage();
  await devicesConfirm.getByTestId("device-link-create").click();
  await devicesConfirm.getByTestId("device-link-awaiting-confirm").waitFor({
    state: "visible",
  });
  await shootDevices(devicesConfirm, "awaiting-confirm");
  await devicesConfirm.getByTestId("device-link-confirm-sas").click();
  await devicesConfirm.getByTestId("device-link-connected").waitFor({
    state: "visible",
  });
  await shootDevices(devicesConfirm, "connected");
  await devicesConfirm.close();

  resetDeviceLinkHarness();
  deviceLinkHarness.getBody = () => ({ status: "expired" });
  const devicesExpired = await openDevicesPage();
  await devicesExpired.getByTestId("device-link-create").click();
  await devicesExpired.getByTestId("device-link-expired").waitFor({
    state: "visible",
  });
  await shootDevices(devicesExpired, "expired");
  await devicesExpired.close();

  resetDeviceLinkHarness();
  deviceLinkHarness.issueStatus = 500;
  const devicesError = await openDevicesPage();
  await devicesError.getByTestId("device-link-create").click();
  await devicesError.getByTestId("device-link-banner").waitFor({
    state: "visible",
  });
  await shootDevices(devicesError, "error");
  await devicesError.close();

  resetDeviceLinkHarness();
  const devicesOffline = await openDevicesPage();
  await devicesOffline.evaluate(() => {
    Object.defineProperty(navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    window.dispatchEvent(new Event("offline"));
  });
  await devicesOffline.getByTestId("device-link-offline").waitFor({
    state: "visible",
  });
  await shootDevices(devicesOffline, "offline");
  await devicesOffline.close();

  resetDeviceLinkHarness();
  deviceLinkHarness.sas = "";
  deviceLinkHarness.getBody = () => ({
    status: "consumed",
    device: { name: DEVICE_LINK_CAPTURE_DEVICE, platform: "ios" },
  });
  const devicesLoopback = await openDevicesPage();
  await devicesLoopback.getByTestId("device-link-create").click();
  await devicesLoopback.getByTestId("device-link-connected").waitFor({
    state: "visible",
  });
  await shootDevices(devicesLoopback, "loopback");
  await devicesLoopback.close();

  resetDeviceLinkHarness();
  const firstRun = await context.newPage();
  await firstRun.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(firstRun);
  await firstRun.evaluate(() => {
    sessionStorage.setItem("momo.web.phoneLinkFirstRun.v1", "pending");
  });
  await firstRun.reload({ waitUntil: "networkidle" });
  await firstRun.getByTestId("onboarding-phone-link").waitFor({
    state: "visible",
  });
  await firstRun.waitForTimeout(250);
  const firstRunShot = `${OUT_DIR}/onboarding-phone-link-${scheme}.png`;
  await firstRun.screenshot({ path: firstRunShot });
  shots.push(firstRunShot);
  await firstRun.getByTestId("onboarding-enter-app").click();
  await firstRun.close();

  // 4. dense timeline via the stress path (no realtime rail, 40 rows)
  const stress = await context.newPage();
  await stress.goto(`${ORIGIN}/?stress=40`, { waitUntil: "networkidle" });
  await signIn(stress);
  await stress.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  const stressShot = `${OUT_DIR}/timeline-dense-${scheme}.png`;
  await stress.screenshot({ path: stressShot });
  shots.push(stressShot);

  // ── goal B8 ───────────────────────────────────────────────────────────────

  const b8 = await context.newPage();
  await b8.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(b8);
  await b8.getByTestId("timeline-message").first().waitFor({ state: "visible" });

  // B8 H6: a markdown body rendered as markdown. The fixture row carries bold,
  // inline code, a bullet list, a link and a fenced block, so this one frame is
  // where a reviewer sees whether the timeline stayed dense.
  await scrollTimelineRowIntoView(b8, "message-markdown", `B8 ${scheme}`);
  await b8.getByTestId("message-code-block").first().waitFor({ state: "visible" });
  await b8.waitForTimeout(200);
  const markdownShot = `${OUT_DIR}/b8-message-markdown-${scheme}.png`;
  await b8.screenshot({ path: markdownShot });
  shots.push(markdownShot);

  // B8 H2: the failure notice, with 자세히 open. Two things are on trial here
  // and both are negatives: no English, and no provider text.
  await scrollTimelineRowIntoView(b8, "turn-failure", `B8 ${scheme}`);
  await b8.getByTestId("turn-failure-detail").first().click();
  await b8.waitForTimeout(200);
  await assertWideRowsFillOnly(b8, `b8-failure ${scheme}`);
  const failureShot = `${OUT_DIR}/b8-provider-failure-${scheme}.png`;
  await b8.screenshot({ path: failureShot });
  shots.push(failureShot);

  // B8 H4: the composer with its Enter hint. Focused, because the hint sits
  // under the box a person is typing in and that is where it is read.
  await b8.getByTestId("composer-input").fill("배포 로그 확인 부탁해요");
  await b8.getByTestId("composer-input").focus();
  await b8.getByTestId("composer-hint").waitFor({ state: "visible" });
  await b8.waitForTimeout(300);
  const hintShot = `${OUT_DIR}/b8-composer-hint-${scheme}.png`;
  await b8.screenshot({ path: hintShot });
  shots.push(hintShot);

  // B8 B2: the connection banner. The capture's realtime URL is deliberately
  // unreachable, which is EXACTLY the QA case (a socket that never came up), so
  // this frame needs no mock: it needs the dwell. The wait is longer than the
  // 15s threshold on purpose, because a banner that appears at 14.9s in a test
  // and 15.1s in the product is a banner nobody can review.
  await b8.waitForTimeout(SUSTAINED_DOWN_WAIT_MS);
  await b8.getByTestId("connection-banner").waitFor({ state: "visible" });
  const bannerShot = `${OUT_DIR}/b8-connection-banner-${scheme}.png`;
  await b8.screenshot({ path: bannerShot });
  shots.push(bannerShot);

  // The 900 band the review rubric asks for (web SKILL §11 phase 2), which this
  // capture had no frame of: the sidebar is still a column, so the channel is
  // down to ~360px while every new string here is at full length. The banner
  // sentence plus its button and the composer hint are the two most likely to
  // wrap badly, and both are on screen in this one shot.
  await b8.setViewportSize({ width: 900, height: 800 });
  await b8.waitForTimeout(300);
  const narrowShot = `${OUT_DIR}/b8-narrow-900-${scheme}.png`;
  await b8.screenshot({ path: narrowShot });
  shots.push(narrowShot);
  const overflow900 = await b8.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  if (overflow900 > 0) {
    throw new Error(`900px 가로 오버플로 ${overflow900}px (${scheme})`);
  }

  await context.close();
  return shots;
}

/**
 * 짝 없는 `/v1` 경로를 런 끝에 한 번 인쇄한다 (이슈 #1125).
 *
 * 죽이지 않는 이유는 `installUnmockedFallback` 머리말에 있다. 조용하지 않게 두는
 * 것이 요점이다 — 이 목록이 비어 있지 않은 채로 커밋된 캡처가 다음 사람에게는
 * 「왜 이 화면이 이렇게 나왔는지 모르겠는 판」이 된다.
 */
function reportUnmocked() {
  if (unmockedPaths.size === 0) return;
  console.log(`\n[미대응 /v1 경로 ${unmockedPaths.size}건 — 본문 없는 404로 답했다]`);
  for (const path of [...unmockedPaths].sort()) console.log(`  ${path}`);
}

// TC-1 (#1758). 헤더 터미널을 실제로 눌러 4상태·탭 전환·확대·닫기·컴포저
// 비교차를 잰다. ADE가 같은 work-sessions 키를 셸에서 읽으므로 로딩 장면은
// networkidle을 기다리지 않는다.
async function captureTerminalDockScenes(browser, scheme) {
  const shots = [];
  const liveHostId = "019f994c-4ed0-76a9-9d43-a9bde45b8fcd";
  const dockSessions = [
    {
      id: "019f9ab9-6da4-7be7-9bc9-4a3872d921c3",
      workspaceId: WORKSPACE_ID,
      channelId: GENERAL_ID,
      memberId: ME,
      hostId: liveHostId,
      rootMessageId: "019f9ab9-6da4-7be7-9bc9-4a3872d921c4",
      tool: "claude",
      label: "relay outbox_drain 재시작 루프 조사",
      status: "running",
      observation: "open",
      observerGrantCount: 1,
      remoteAttachAvailable: true,
      remoteDisplayAvailable: false,
      startedAtMs: Date.now() - 12 * 60_000,
    },
    {
      id: "019f9ab9-6da4-7be7-9bc9-4a3872d921c5",
      workspaceId: WORKSPACE_ID,
      channelId: GENERAL_ID,
      memberId: ME,
      hostId: liveHostId,
      rootMessageId: "019f9ab9-6da4-7be7-9bc9-4a3872d921c6",
      tool: "claude",
      label: "배포 로그 수집",
      status: "idle",
      observation: "open",
      observerGrantCount: 0,
      remoteAttachAvailable: true,
      remoteDisplayAvailable: false,
      startedAtMs: Date.now() - 45 * 60_000,
    },
  ];

  async function openDock(page) {
    const toggle = page.getByTestId("open-terminal-dock");
    await toggle.click();
    await page.getByTestId("terminal-dock").waitFor({ state: "visible" });
    if ((await toggle.getAttribute("aria-pressed")) !== "true") {
      throw new Error(`터미널 토글이 열린 동안 pressed가 아니다 ${scheme}`);
    }
    if ((await page.getByTestId("terminal-dock-new").count()) !== 0) {
      throw new Error(`새 세션 버튼이 그렸다 ${scheme}: 웹에 create 경로가 없다`);
    }
  }

  async function shoot(name, prepare, settle, boot = "idle") {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: ORIGIN,
    });
    await installMocks(context);
    if (prepare) await prepare(context);
    const page = await context.newPage();
    // ADE 가 셸에서 work-sessions 를 읽는다. 로딩 장면은 그 요청을 붙잡으므로
    // networkidle 을 기다리면 캡처가 영원히 멈춘다.
    if (boot === "pending") {
      await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
      await signInThroughOnboarding(page, {
        email: "seongjae@dawn.example",
        password: "capture-only-not-a-credential",
      });
      await page.getByTestId("open-terminal-dock").waitFor({ state: "visible" });
      await page.getByTestId("composer-input").waitFor({ state: "visible" });
    } else {
      await page.goto(ORIGIN, { waitUntil: "networkidle" });
      await signIn(page);
      await page.getByTestId("composer-input").waitFor({ state: "visible" });
    }
    await settle(page);
    await assertNoHorizontalOverflow(page, `terminal dock ${name} ${scheme}`);
    await assertComposerVisible(page, `terminal dock ${name} ${scheme}`);
    await assertDockAboveComposer(page, `terminal dock ${name} ${scheme}`);
    await assertDockExpandHonesty(page, `terminal dock ${name} ${scheme}`);
    const path = `${OUT_DIR}/terminal-dock-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  await shoot("empty", null, async (page) => {
    await openDock(page);
    await page.getByTestId("terminal-dock-empty").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
    await page.getByTestId("terminal-dock").waitFor({ state: "detached" });
    await page.waitForFunction(
      `document.activeElement?.getAttribute("data-testid") === "open-terminal-dock"`
    );
    await openDock(page);
    await page.getByTestId("terminal-dock-empty").waitFor({ state: "visible" });
  });

  await shoot(
    "loading",
    async (context) => {
      await context.route("**/v1/workspaces/*/work-sessions*", () => new Promise(() => {}));
    },
    async (page) => {
      await openDock(page);
      await page.getByTestId("terminal-dock-loading").waitFor({ state: "visible" });
    },
    "pending"
  );

  await shoot(
    "error",
    async (context) => {
      await context.route("**/v1/workspaces/*/work-sessions*", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ error: { message: "ledger unavailable" } }),
        })
      );
    },
    async (page) => {
      await openDock(page);
      await page.getByTestId("terminal-dock-error").waitFor({ state: "visible" });
    }
  );

  await shoot("offline", null, async (page) => {
    await openDock(page);
    await page.getByTestId("terminal-dock-empty").waitFor({ state: "visible" });
    await page.context().setOffline(true);
    await page.getByTestId("terminal-dock-offline").waitFor({ state: "visible" });
  });

  await shoot(
    "sessions",
    async (context) => {
      await context.route("**/v1/workspaces/*/work-sessions*", (route) =>
        json(route, { workSessions: dockSessions })
      );
      await mockObserverTerminalAttach(context);
    },
    async (page) => {
      await openDock(page);
      const tabs = page.getByTestId("terminal-dock-tab");
      await tabs.first().waitFor({ state: "visible" });
      if ((await tabs.count()) < 2) {
        throw new Error(`세션 탭이 2개 미만이다 ${scheme}`);
      }
      await tabs.nth(1).click();
      if ((await tabs.nth(1).getAttribute("aria-selected")) !== "true") {
        throw new Error(`두 번째 탭이 선택되지 않는다 ${scheme}`);
      }
      await page.getByTestId("work-observer").waitFor({ state: "visible" });
      await assertObserverTerminalModality(
        page,
        `sessions ${scheme}`,
        shots,
        scheme
      );
      const dock = page.getByTestId("terminal-dock");
      await page.getByTestId("terminal-dock-close").click();
      await dock.waitFor({ state: "detached" });
      await page.waitForFunction(
        `document.activeElement?.getAttribute("data-testid") === "open-terminal-dock"`
      );
      await openDock(page);
      await tabs.nth(1).waitFor({ state: "visible" });
    }
  );

  return shots;
}

/**
 * BT-6 (#1934): timeline with a mark-unread (divider above a known seq).
 * Own context so shared READ_STATES are not rewritten. Overlay only GET/PUT.
 * Dedicated all-read #general. Starts unmarked so the ⋯ click (not a seeded
 * GET mark) is what plants the divider.
 */
const MARK_UNREAD_SEQ = 1408;
const MARK_UNREAD_LATEST = 1416;
const ENGINE_ID = CHANNELS[1].id;

async function waitForScrollerAlignSettled(page, label) {
  await page.evaluate(`(() => {
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    if (!scroller) return;
    scroller.removeAttribute("data-capture-scroll-top");
    scroller.removeAttribute("data-capture-stable-frames");
  })()`);
  try {
    await page.waitForFunction(
      `(() => {
        const scroller =
          document.querySelector("[data-virtuoso-scroller]") ||
          document.querySelector('[data-testid="timeline-virtuoso"]');
        if (!scroller) return false;
        const top = String(scroller.scrollTop);
        const prev = scroller.getAttribute("data-capture-scroll-top");
        const frames = Number(
          scroller.getAttribute("data-capture-stable-frames") || "0"
        );
        if (prev === top) {
          const next = frames + 1;
          scroller.setAttribute("data-capture-stable-frames", String(next));
          return next >= 12;
        }
        scroller.setAttribute("data-capture-scroll-top", top);
        scroller.setAttribute("data-capture-stable-frames", "0");
        return false;
      })()`,
      undefined,
      { polling: "raf", timeout: 15_000 }
    );
  } catch (error) {
    throw new Error(
      `타임라인 정렬이 끝나지 않는다 ${label}: ${error instanceof Error ? error.message : error}`
    );
  }
}

function markUnreadProofExpr() {
  return `(() => {
    const seq = ${MARK_UNREAD_SEQ};
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    const row = document.querySelector(
      '[data-testid="timeline-message"][data-seq="' + seq + '"]'
    );
    const divider = document.querySelector('[data-testid="unread-divider"]');
    if (!scroller || !row || !divider) return null;
    const s = scroller.getBoundingClientRect();
    const d = divider.getBoundingClientRect();
    const r = row.getBoundingClientRect();
    if (d.height <= 0 || r.height <= 0) return null;
    if (d.bottom < s.top || d.top > s.bottom) return null;
    if (r.bottom < s.top || r.top > s.bottom) return null;
    if (d.bottom - r.top > 8 || r.top - d.bottom > 24) return null;
    const active = document.activeElement;
    if (!(active instanceof Element) || !row.contains(active)) return null;
    const pill = document.querySelector('[data-testid="jump-unread"]');
    const pillRect = pill ? pill.getBoundingClientRect() : null;
    const pillVisible = Boolean(
      pillRect &&
        pillRect.height > 0 &&
        pillRect.bottom > s.top &&
        pillRect.top < s.bottom
    );
    return {
      dividerText: (divider.textContent || "").replace(/\\s+/g, " ").trim(),
      pillVisible,
      pillText: pillVisible
        ? (pill.textContent || "").replace(/\\s+/g, " ").trim()
        : "",
      dividerBottom: Math.round(d.bottom),
      rowTop: Math.round(r.top),
      focus: active.getAttribute("data-testid"),
    };
  })()`;
}

function markUnreadReadStates(cleared) {
  return READ_STATES.map((row) =>
    row.channel_id === GENERAL_ID
      ? {
          channel_id: GENERAL_ID,
          last_read_seq: MARK_UNREAD_LATEST,
          latest_seq: MARK_UNREAD_LATEST,
          unread_count: 0,
          mention_count: 0,
          marked_unread_before_seq: cleared ? null : MARK_UNREAD_SEQ,
        }
      : { ...row, marked_unread_before_seq: null }
  );
}

async function captureMarkUnreadScenes(browser, scheme) {
  const shots = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: ORIGIN,
  });
  await installMocks(context);
  let cleared = true;
  await context.route("**/v1/workspaces/*/read-state", (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    return json(route, { read_states: markUnreadReadStates(cleared) });
  });
  await context.route("**/v1/workspaces/*/channels/*/read-state", (route) => {
    const req = route.request();
    if (req.method() !== "PUT") return route.fallback();
    const body = req.postDataJSON() || {};
    if (body.read_intent === "explicit_open") {
      cleared = true;
    } else if (typeof body.mark_unread_before_seq === "number") {
      cleared = false;
    }
    const general = markUnreadReadStates(cleared).find(
      (row) => row.channel_id === GENERAL_ID
    );
    return json(route, {
      ...general,
      last_read_seq: body.last_read_seq ?? MARK_UNREAD_LATEST,
    });
  });
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await waitForScrollerAlignSettled(page, `${scheme} open`);
  await page.evaluate(`location.hash = "/c/${ENGINE_ID}"`);
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await waitForScrollerAlignSettled(page, `${scheme} 엔진`);
  await page.evaluate(`location.hash = "/c/${GENERAL_ID}"`);
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await waitForScrollerAlignSettled(page, `${scheme} general`);
  await page.waitForFunction(`(() => {
    const seq = ${MARK_UNREAD_SEQ};
    const scroller =
      document.querySelector("[data-virtuoso-scroller]") ||
      document.querySelector('[data-testid="timeline-virtuoso"]');
    const row = document.querySelector(
      '[data-testid="timeline-message"][data-seq="' + seq + '"]'
    );
    if (!row) {
      if (scroller) scroller.scrollTop = 0;
      return false;
    }
    const box = row.getBoundingClientRect();
    const root = scroller
      ? scroller.getBoundingClientRect()
      : { top: 0, bottom: window.innerHeight };
    if (box.height <= 0 || box.top < root.top + 8 || box.bottom > root.bottom - 8) {
      row.scrollIntoView({ block: "center" });
      return false;
    }
    return true;
  })()`);
  await waitForScrollerAlignSettled(page, `${scheme} centre 1408`);
  const marked = page.locator(
    `[data-testid="timeline-message"][data-seq="${MARK_UNREAD_SEQ}"]`
  );
  await marked.hover();
  await page.getByTestId("message-actions-trigger").waitFor({ state: "visible" });
  await page.getByTestId("message-actions-trigger").click();
  await page.getByTestId("message-action-menu").waitFor({ state: "visible" });
  const markItem = page.getByTestId("menu-mark-unread");
  if ((await markItem.count()) !== 1) {
    throw new Error(`마크 안 읽음 항목이 없다 ${scheme} (seq ${MARK_UNREAD_SEQ})`);
  }
  await markItem.click();
  await waitForScrollerAlignSettled(page, `${scheme} after mark`);
  const proof = await page.waitForFunction(
    markUnreadProofExpr(),
    undefined,
    { polling: "raf", timeout: 15_000 }
  );
  const path = `${OUT_DIR}/mark-unread-timeline-${scheme}.png`;
  await page.screenshot({ path });
  shots.push(path);
  const state = await proof.jsonValue();
  if (!state || !state.dividerText.includes("새 메시지")) {
    throw new Error(`마크 캡처 ${scheme}: 구분선 문구가 없다 ${JSON.stringify(state)}`);
  }
  if (!state.focus) {
    throw new Error(`마크 캡처 ${scheme}: 포커스가 행을 떠났다 ${JSON.stringify(state)}`);
  }
  const countMatch = state.dividerText.match(/(\d+)/);
  if (!countMatch) {
    throw new Error(`마크 캡처 ${scheme}: 구분선 수가 없다 「${state.dividerText}」`);
  }
  if (state.pillVisible && !state.pillText.includes(countMatch[1])) {
    throw new Error(
      `마크 캡처 ${scheme}: 필 「${state.pillText}」와 구분선 「${state.dividerText}」가 다른 수다`
    );
  }
  await assertComposerVisible(page, `mark-unread ${scheme}`);
  await assertNoHorizontalOverflow(page, `mark-unread ${scheme}`);
  console.log(
    `  mark-unread ${scheme}: divider 「${state.dividerText}」 pill=${state.pillVisible ? state.pillText : "hidden"}`
  );
  await page.close();
  await context.close();
  return shots;
}

// UX-R2b welcome kickoff (#2002). Scenes only — startGuardedPreview is untouched.
// Arrival is driven through the product store path (`oort.capture.message.new`
// → useTimeline applyBatch), not a stage prop.
async function captureWelcomeKickoffScenes(browser, scheme) {
  const shots = [];

  async function openWelcome(reducedMotion, options = {}) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion,
    });
    await installMocks(context);
    await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes("/replies")) return route.fallback();
      if (route.request().method() !== "GET") return route.fallback();
      return url.pathname.toLowerCase().includes(GENERAL_ID.toLowerCase())
        ? json(route, { messages: [] })
        : route.fallback();
    });
    await context.addInitScript(
      ({ workspaceId, memberId }) => {
        sessionStorage.setItem(
          "oort.freshSignup.v1",
          JSON.stringify({ workspaceId, memberId })
        );
      },
      { workspaceId: WORKSPACE_ID, memberId: ME }
    );
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.evaluate(
      ({ workspaceId, memberId }) => {
        sessionStorage.setItem(
          "oort.freshSignup.v1",
          JSON.stringify({ workspaceId, memberId })
        );
      },
      { workspaceId: WORKSPACE_ID, memberId: ME }
    );
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, CHANNELS[1].id);
    await page.getByTestId("chat-timeline").waitFor({ state: "visible" });
    if (options.installClock) await page.clock.install();
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, GENERAL_ID);
    return { context, page };
  }

  async function waitForWelcomeStage(page) {
    const empty = page.getByTestId("timeline-empty");
    try {
      await empty.waitFor({ state: "visible", timeout: 15_000 });
    } catch (err) {
      // Empty intro is optional: a nonempty #general still mounts the stage.
      // Timeout is the only miss we accept; anything else is a real fail.
      const name = err instanceof Error ? err.name : "";
      const message = err instanceof Error ? err.message : String(err);
      if (name !== "TimeoutError" && !message.includes("Timeout")) throw err;
    }
    const stage = page.getByTestId("welcome-kickoff-stage");
    try {
      await stage.waitFor({ state: "attached", timeout: 10_000 });
    } catch (err) {
      const dump = await page.evaluate(() => ({
        hash: location.hash,
        fresh: sessionStorage.getItem("oort.freshSignup.v1"),
        shown: Object.keys(localStorage).filter((k) =>
          k.includes("welcomeKickoff")
        ),
        introEmpty: Boolean(document.querySelector('[data-testid="timeline-empty"]')),
        introStarted: Boolean(
          document.querySelector('[data-testid="message-channel-intro"]')
        ),
        messages: document.querySelectorAll('[data-testid="timeline-message"]').length,
        copy: document.body.innerText.includes("팀이 준비하고 있어요"),
      }));
      throw new Error(`welcome-kickoff-stage missing ${JSON.stringify(dump)}`);
    }
    try {
      await scrollTimelineRowIntoView(page, "welcome-kickoff-stage", "welcome-kickoff");
    } catch (err) {
      if (!String(err).includes("자리가 멎지 않았다")) throw err;
      await page.waitForTimeout(200);
      await scrollTimelineRowIntoView(page, "welcome-kickoff-stage", "welcome-kickoff");
    }
    await stage.waitFor({ state: "visible" });
  }

  {
    const { context, page } = await openWelcome("no-preference");
    await waitForWelcomeStage(page);
    await waitForAnimations(page);
    const path = `${OUT_DIR}/welcome-stage-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  {
    const { context, page } = await openWelcome("reduce");
    await waitForWelcomeStage(page);
    await waitForAnimations(page);
    const path = `${OUT_DIR}/welcome-stage-reduce-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  {
    const { context, page } = await openWelcome("no-preference");
    await waitForWelcomeStage(page);
    await waitForAnimations(page);
    await page.evaluate(
      ({ channelId, agentId }) => {
        window.dispatchEvent(
          new CustomEvent("oort.capture.message.new", {
            detail: {
              id: "0199eeee-0000-7000-8000-000000000501",
              channelId,
              seq: 1,
              hlcTs: 1_704_067_200_000,
              hlcCount: 0,
              authorMemberId: agentId,
              type: "text",
              body: "시작할까요? 이 워크스페이스에서 같이 일해요.",
              state: "sent",
              createdAtMs: 1_704_067_200_000,
            },
          })
        );
      },
      { channelId: GENERAL_ID, agentId: HERMES }
    );
    await page.getByTestId("timeline-message").waitFor({ state: "visible" });
    await page.waitForFunction(
      () =>
        [...document.querySelectorAll('[data-testid="timeline-message"]')].some(
          (node) => node.classList.contains("enter-conversation")
        )
    );
    await waitForAnimations(page);
    const path = `${OUT_DIR}/welcome-arrived-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  {
    const { context, page } = await openWelcome("no-preference", {
      installClock: true,
    });
    await waitForWelcomeStage(page);
    await page.clock.fastForward(120_000);
    await page.getByTestId("welcome-kickoff-backstop").waitFor({ state: "visible" });
    await page.clock.resume();
    await waitForAnimations(page);
    const vp = page.viewportSize() ?? VIEWPORT;
    await page.mouse.move(vp.width + 80, vp.height + 80);
    const path = `${OUT_DIR}/welcome-backstop-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  return shots;
}

async function captureSettingsWelcomeScenes(browser, scheme) {
  const shots = [];
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);
  await page.evaluate('location.hash = "/settings?section=workspace"');
  await page.getByTestId("settings-route").waitFor({ state: "visible" });
  const block = page.getByTestId("workspace-welcome-kickoff");
  await block.waitFor({ state: "visible" });
  // Playwright visible ≠ in-viewport. R2 measured the block at top:884 in an
  // 800 px frame after this wait, so the shutter hit the section above it.
  await block.evaluate((el) => el.scrollIntoView({ block: "start" }));
  await waitForAnimations(page);
  const frame = await block.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    return {
      top: box.top,
      bottom: box.bottom,
      left: box.left,
      right: box.right,
      height: box.height,
      vh,
      vw,
      inViewport:
        box.top >= 0 &&
        box.bottom <= vh &&
        box.left >= 0 &&
        box.right <= vw,
    };
  });
  const path = `${OUT_DIR}/settings-welcome-${scheme}.png`;
  if (frame.height > frame.vh) {
    console.info(
      `settings-welcome ${scheme}: block cannot fit (height ${frame.height} > vh ${frame.vh}); shooting the block element`
    );
    await block.screenshot({ path });
  } else {
    if (!frame.inViewport) {
      throw new Error(
        `settings-welcome ${scheme} inViewport:false top:${frame.top} bottom:${frame.bottom} vh:${frame.vh} vw:${frame.vw}`
      );
    }
    const vp = page.viewportSize() ?? VIEWPORT;
    await page.mouse.move(vp.width + 80, vp.height + 80);
    await page.screenshot({ path });
  }
  shots.push(path);
  await context.close();
  return shots;
}

// 빈 대화의 첫 행동 (#1536, 온보딩 실측 F5). 이 표면은 첫 실행에서 사람이 **반드시**
// 보는 화면인데 리뷰에 프레임이 없었다 — 아래 add-member 레인은 이 화면을 거쳐
// 가면서도 자기 다이얼로그만 찍고 지나간다.
async function captureEmptyConversationScenes(browser, scheme) {
  const shots = [];
  const EMPTY_CHANNEL_ID = CHANNELS[1].id; // 엔진

  async function shoot(name, channelId) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    // 이 대화만 비운다. 나머지는 원래 목으로 되돌아가므로(fallback) 사이드바는
    // 첫 실행이 아니라 **이 방만 빈** 진짜 화면으로 남는다.
    await context.route("**/v1/workspaces/*/channels/*/messages*", (route) =>
      new URL(route.request().url()).pathname.includes(channelId)
        ? json(route, { messages: [] })
        : route.fallback()
    );
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, channelId);
    const empty = page.getByTestId("timeline-empty");
    await empty.waitFor({ state: "visible" });
    // 액션이 실제로 그려진 뒤에 찍는다: 카피만 있고 버튼이 아직 없는 프레임은
    // 이 goal 이 고친 것을 정확히 못 보이게 한다.
    await empty.getByTestId("timeline-empty-primary").waitFor({ state: "visible" });
    await page.waitForTimeout(200);
    const path = `${OUT_DIR}/empty-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  await shoot("channel", EMPTY_CHANNEL_ID);
  await shoot("dm", DM_ID);
  return shots;
}

// 메시지가 있는 채널의 인트로 (#1904 design-review B-1). 빈 상태 레인은
// empty=true만 찍어서, 히스토리 첫 행에 액션이 남는 화면이 증거 없이 지나갔다.
// general은 픽스처 16행이라 열자마자 reachedStart이고, 인트로는 바닥 정렬 때문에
// 창 위에 있으므로 목록을 머리까지 올린 뒤에 찍는다.
async function captureNonemptyChannelIntroScenes(browser, scheme) {
  const shots = [];
  const CHANNEL_ID = CHANNELS[0].id;

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);
  await page.evaluate((id) => {
    window.location.hash = `#/c/${id}`;
  }, CHANNEL_ID);
  await page.getByTestId("chat-timeline").waitFor({ state: "visible" });
  await page.getByTestId("timeline-message").first().waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const scroller = document.querySelector("[data-virtuoso-scroller]");
    return Boolean(scroller && scroller.scrollHeight > scroller.clientHeight + 200);
  });
  await scrollTimelineRowIntoView(
    page,
    "message-channel-intro",
    `nonempty intro ${scheme}`
  );
  const intro = page.getByTestId("message-channel-intro");
  const actionCount = await intro.locator("button").count();
  if (actionCount !== 0) {
    throw new Error(
      `비어 있지 않은 인트로에 액션이 ${actionCount}개다 ${scheme}`
    );
  }
  const text = await intro.innerText();
  if (text.includes("첫 메시지")) {
    throw new Error(`비어 있지 않은 인트로가 「첫 메시지」를 말한다 ${scheme}`);
  }
  await page.waitForTimeout(200);
  const path = `${OUT_DIR}/channel-intro-nonempty-${scheme}.png`;
  await page.screenshot({ path });
  shots.push(path);
  await context.close();
  return shots;
}

// BT-3 (#1931) — 검색 범위 칩. 좁힌 결과 · 넓힌 결과 · 좁힌 빈손(승격 버튼),
// 두 스킴.
//
// 목이 **범위를 실제로 읽는다**: `channel=`이 있으면 그 채널 히트만 돌려준다.
// 목이 파라미터를 무시하면 두 프레임이 같은 그림이 되고, 그때 캡처는 초록인데
// 칩은 죽은 컨트롤이다. 그래서 프레임을 찍기 전에 행 수를 센다 — 스크린샷은
// 「목록이 안 바뀌었다」를 보여주지 못한다(MOBILE_TAP_TARGETS와 같은 이유).
async function captureSearchScopeScenes(browser, scheme) {
  const shots = [];
  const HERE = GENERAL_ID; // general
  const THERE = CHANNELS[1].id; // 엔진
  // 브리프 ①이 명시한 두 갈래를 이 레인이 직접 본다(R1 M-3). 둘 다 이 파일에
  // 이미 있던 픽스처다 — DM 은 hermes, 긴 이름은 #1930 이 「짧은 픽스처」 재발
  // 방지용으로 넣어 둔 40자 그 줄이다. 사진이 없어서 「다이렉트 메시지님과의」
  // (R1 H-2)가 캡처 레인이 아니라 리뷰어 프로브에서 나왔다.
  const LONG = CHANNELS[4].id; // 2026-하반기-릴리스-준비-회고-및-후속-작업
  const NEEDLE = "배포";
  // 이 질의는 어느 채널에도 없다. 좁힌 빈손 프레임이 그 위에 선다.
  const MISSING = "아무데도없는말";

  function hit(channelId, seq, snippet) {
    return {
      channelId,
      messageId: `019f9b00-0000-7000-8000-00000000${String(seq).padStart(4, "0")}`,
      seq,
      authorMemberId: ME,
      createdAtMs: Date.parse("2026-08-31T09:12:00Z") + seq * 60_000,
      snippet,
      matchOffset: snippet.indexOf(NEEDLE) < 0 ? 0 : snippet.indexOf(NEEDLE),
    };
  }

  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  await context.route("**/v1/workspaces/*/search/messages*", (route) => {
    const params = new URL(route.request().url()).searchParams;
    const q = params.get("q") ?? "";
    const channel = params.get("channel");
    if (q === MISSING) return json(route, { hits: [] });
    const all = [
      hit(HERE, 41, "금요일 배포 준비 끝났습니다. 롤백 절차만 한 번 더 볼게요."),
      hit(HERE, 38, "배포 창은 오후 6시로 잡았습니다."),
      hit(THERE, 12, "엔진 쪽 배포는 다음 주로 미룹니다."),
    ];
    const hits =
      channel === null
        ? all
        : all.filter((row) => row.channelId.toLowerCase() === channel.toLowerCase());
    return json(route, { hits });
  });

  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);

  // 같은 라우트 안에서 해시만 바꾸면 라우트가 다시 마운트되지 않아 `?q=`가
  // 첫 렌더의 값 그대로다(useMessageSearch: "초기값은 첫 렌더에서만 읽는다").
  // 그래서 채널을 한 번 거쳐 실제로 떠났다 온다 — 사람이 ⌘K로 오는 경로와 같다.
  async function goSearch(query, channelId) {
    await page.evaluate((id) => {
      window.location.hash = `#/c/${id}`;
    }, GENERAL_ID);
    await page.getByTestId("chat-timeline").waitFor({ state: "visible" });
    await page.evaluate(
      ([q, id]) => {
        const params = new URLSearchParams({ q });
        if (id) params.set("channel", id);
        window.location.hash = `#/search?${params.toString()}`;
      },
      [query, channelId ?? ""]
    );
    await page.getByTestId("search-route").waitFor({ state: "visible" });
  }

  async function rowCount() {
    return page.getByTestId("search-hit").count();
  }

  await goSearch(NEEDLE, HERE);
  await page.getByTestId("search-scope-channel").waitFor({ state: "visible" });
  await page.getByTestId("search-results").waitFor({ state: "visible" });
  const narrowed = await rowCount();
  if (narrowed !== 2) {
    throw new Error(`좁힌 검색 행 수 ${scheme}: ${narrowed} (2여야 함)`);
  }
  await assertWideRowsFillOnly(page, `search ${scheme}`);
  await page.waitForTimeout(200);
  const narrowShot = `${OUT_DIR}/search-scope-channel-${scheme}.png`;
  await page.screenshot({ path: narrowShot });
  shots.push(narrowShot);

  // 칩을 실제로 누른다. 프레임만 찍고 누르지 않으면 죽은 칩도 초록이다.
  await page.getByTestId("search-scope-workspace").click();
  await page.waitForFunction(
    () => document.querySelectorAll('[data-testid="search-hit"]').length === 3
  );
  await page.waitForTimeout(200);
  const wideShot = `${OUT_DIR}/search-scope-workspace-${scheme}.png`;
  await page.screenshot({ path: wideShot });
  shots.push(wideShot);

  // 키보드 계약은 공용 탭 컨트롤의 것이다(정거장 1개, ←/→ 이동). 이 표면이
  // 그것을 실제로 물려받았는지 여기서 잰다.
  await page.getByTestId("search-scope-workspace").focus();
  await page.keyboard.press("ArrowLeft");
  const afterArrow = await page.evaluate(
    `document.activeElement?.getAttribute("data-testid")`
  );
  if (afterArrow !== "search-scope-channel") {
    throw new Error(
      `범위 칩 ←/→ 이동 ${scheme}: ${afterArrow} (search-scope-channel 이어야 함)`
    );
  }

  // 좁힌 빈손 — 그리고 승격 버튼이 실제로 넓히는지.
  await goSearch(MISSING, HERE);
  const empty = page.getByTestId("search-empty");
  await empty.waitFor({ state: "visible" });
  const emptyText = await empty.innerText();
  // 범위만이 아니라 **어느 채널인지**를 말해야 한다(R1 H-1). 이 화면에는 행이
  // 없으므로 행 메타가 이름을 대신 메워 주지 않고, 안내문은 질의가 있어 안 보인다.
  if (!emptyText.includes("general에는")) {
    throw new Error(
      `좁힌 빈손이 어느 채널인지 말하지 않는다 ${scheme}: ${emptyText}`
    );
  }
  await page.waitForTimeout(200);
  const emptyShot = `${OUT_DIR}/search-scope-empty-${scheme}.png`;
  await page.screenshot({ path: emptyShot });
  shots.push(emptyShot);

  await page.getByTestId("search-empty-escalate").click();
  await page.waitForFunction(
    () =>
      (
        document.querySelector('[data-testid="search-empty"]')?.textContent ?? ""
      ).includes("에는 없습니다") === false
  );
  const escalated = await page.getByTestId("search-empty-escalate").count();
  if (escalated !== 0) {
    throw new Error(
      `승격 뒤에도 승격 버튼이 남아 있다 ${scheme}: 넓힐 곳이 없는데 컨트롤이 있다`
    );
  }
  // 승격은 주소에도 적힌다(R1 M-2). 화면만 넓어지고 주소가 `channel=…`에
  // 남아 있으면, 새로고침이 사람의 결정을 조용히 되돌린다.
  const widenedHash = await page.evaluate(() => window.location.hash);
  if (!widenedHash.includes("scope=all") || !widenedHash.includes("channel=")) {
    throw new Error(
      `승격 뒤 주소가 화면과 다른 말을 한다 ${scheme}: ${widenedHash}`
    );
  }

  // DM 분기 — 「이 대화에서」와 존칭 문장. `channelLabel` 이 사람 이름을 주는
  // 정상 경로이고, 이름이 아닌 값을 줄 때 존칭이 붙지 않는 갈래는 vitest 가
  // 잰다(SearchRoute.scope.test.tsx).
  await goSearch(MISSING, DM_ID);
  const dmEmpty = page.getByTestId("search-empty");
  await dmEmpty.waitFor({ state: "visible" });
  const dmText = await dmEmpty.innerText();
  if (!dmText.includes("님과의 대화에는")) {
    throw new Error(`DM 빈손이 사람 이름으로 말하지 않는다 ${scheme}: ${dmText}`);
  }
  const dmChip = await page.getByTestId("search-scope-channel").innerText();
  if (dmChip.trim() !== "이 대화에서") {
    throw new Error(`DM 칩이 「채널」이라 부른다 ${scheme}: ${dmChip}`);
  }
  await page.waitForTimeout(200);
  const dmShot = `${OUT_DIR}/search-scope-dm-${scheme}.png`;
  await page.screenshot({ path: dmShot });
  shots.push(dmShot);

  // 긴 채널 이름 — 빈손 문장이 40자 이름을 지고도 문서를 옆으로 밀지 않는가.
  // 이름을 칩이 아니라 문장이 지기로 한 선택(R1 H-1)의 대가를 여기서 잰다.
  await goSearch(MISSING, LONG);
  const longEmpty = page.getByTestId("search-empty");
  await longEmpty.waitFor({ state: "visible" });
  const longText = await longEmpty.innerText();
  if (!longText.includes("2026-하반기-릴리스-준비-회고-및-후속-작업에는")) {
    throw new Error(
      `긴 이름이 빈손 문장에 실리지 않았다 ${scheme}: ${longText}`
    );
  }
  const overflow = await page.evaluate(
    `(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }))()`
  );
  if (overflow.doc > overflow.win) {
    throw new Error(
      `긴 이름이 문서를 옆으로 밀었다 ${scheme}: ${overflow.doc} > ${overflow.win}`
    );
  }
  // 칩은 이름을 지지 않기로 한 그 결정 그대로다 — 알약이 이름 길이를 따라
  // 출렁이면 R1 H-1 의 수리가 칩 폭 문제를 다시 연 것이 된다.
  const longChip = await page.getByTestId("search-scope-channel").innerText();
  if (longChip.trim() !== "이 채널에서") {
    throw new Error(`긴 이름이 칩으로 새어 들어갔다 ${scheme}: ${longChip}`);
  }
  await page.waitForTimeout(200);
  const longShot = `${OUT_DIR}/search-scope-long-name-${scheme}.png`;
  await page.screenshot({ path: longShot });
  shots.push(longShot);

  await context.close();
  return shots;
}

// #1889 M-4 / R2-N2 — 상태 설정 다이얼로그. 기본 + PUT 500 오류 + 오프라인 +
// 「시각 고르기」(날짜·시간이 열리는 분기), 두 스킴.
async function captureSetStatusScenes(browser, scheme) {
  const shots = [];

  async function shoot(name, { failPut = false, offline = false, customExpiry = false } = {}) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    if (failPut) {
      await context.route("**/v1/workspaces/*/presence", async (route) => {
        if (route.request().method() === "PUT") {
          return route.fulfill({
            status: 500,
            contentType: "application/json",
            body: JSON.stringify({ error: { message: "presence write failed" } }),
          });
        }
        return route.fallback();
      });
    }
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.getByTestId("profile-card").click();
    await page.getByTestId("profile-card-menu").waitFor({ state: "visible" });
    await page.getByTestId("profile-set-status").click();
    await page.getByTestId("set-status-dialog").waitFor({ state: "visible" });
    if (failPut) {
      await page.getByTestId("set-status-save").click();
      await page.getByTestId("set-status-error").waitFor({ state: "visible" });
    } else if (offline) {
      await context.setOffline(true);
      await page.getByTestId("set-status-offline").waitFor({ state: "visible" });
    } else if (customExpiry) {
      await page.getByTestId("set-status-expiry").selectOption("custom");
      await page.getByTestId("set-status-custom-date").waitFor({ state: "visible" });
      await page.getByTestId("set-status-custom-time").waitFor({ state: "visible" });
    } else {
      await page.waitForTimeout(200);
    }
    const path = `${OUT_DIR}/set-status-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  await shoot("dialog");
  await shoot("error", { failPut: true });
  await shoot("offline", { offline: true });
  await shoot("custom", { customExpiry: true });
  return shots;
}

// 채널에 멤버 추가 다이얼로그 (검수 #2 / design-review F-4). This dialog had no
// scene, so its four states went to review unseen. Each state is shot in its
// own context because the roster is a react-query cache: to make the SAME
// dialog show a skeleton, an empty list, an error and a full roster, the roster
// route has to answer differently from app load, and re-answering a cached
// query mid-session does not. The POST that adds a member is the members mock
// installMocks already carries (**/channels/*/members**), so a click in the
// normal shot lands on a real 2xx.
//
// The entry point IS the real one: release-notes is emptied of messages so the
// 빈 채널 "멤버 추가하기" button — the exact control this batch rewired — is on
// screen to click. release-notes is a good target because HERMES is in every
// channel (renders the "멤버" already-in row) while the rest are addable.
//
// #1536 이후 그 버튼은 빈 채널의 **보조** 액션이다(첫 행동은 「첫 메시지 쓰기」).
// 이 레인이 이름으로 집는 것은 그대로이고, 덕분에 이 레인은 강등된 문이 여전히
// 열린다는 것까지 매 캡처마다 실제로 눌러 확인하는 자리가 됐다.
async function captureAddMemberScenes(browser, scheme) {
  const shots = [];
  const RELEASE_NOTES_ID = CHANNELS[3].id;

  async function shoot(name, overrideRoster, settleTestId, entry = "intro") {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    // 대상 채널만 메시지를 비운다 → 빈 채널 상태의 초대 버튼이 뜬다. 다른 채널은
    // 원래 목으로 되돌린다(fallback). Playwright는 나중에 등록한 라우트를 먼저
    // 보므로 이 둘이 installMocks의 것을 이긴다.
    await context.route("**/v1/workspaces/*/channels/*/messages*", (route) => {
      const url = new URL(route.request().url());
      return url.pathname.includes(RELEASE_NOTES_ID)
        ? json(route, { messages: [] })
        : route.fallback();
    });
    if (overrideRoster) {
      await context.route("**/v1/workspaces/*/roster", overrideRoster);
    }

    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    // 사이드바 행을 눌러 SPA 안에서 이동한다(딥링크 goto가 아니라). 라우터가
    // 해시 기반이라 href는 `#/c/{id}` 꼴이다 — 이 앱이 실제로 쓰는 경로를 그대로
    // 고른다.
    await page
      .locator(`[data-testid="channel-list"] a[href="#/c/${RELEASE_NOTES_ID}"]`)
      .click();
    if (entry === "header") {
      // 로딩 장면은 로스터를 붙잡는다. 인트로의 「멤버 추가하기」는 로스터가
      // 오기 전에 아무 말도 하지 않으므로(R2 M5) 여기서 열 수 없다. 헤더 멤버
      // 목록이 같은 다이얼로그의 다른 문이다. 픽스처에 맞춰 제품 규칙을 낮추지
      // 않는다 (#1904 H-1).
      await page.getByTestId("channel-member-count").waitFor({ state: "visible" });
      await page.getByTestId("channel-member-count").click();
      await page
        .getByTestId("channel-member-panel")
        .waitFor({ state: "visible" });
      await page.getByTestId("channel-member-add").click();
    } else {
      const empty = page.getByTestId("timeline-empty");
      await empty.waitFor({ state: "visible" });
      // #1573: 이 버튼(채널에 멤버 추가)의 이름은 자기 다이얼로그의 동사를 따라
      // 「추가」다. 아래 empty 샷의 "멤버 초대하기"는 다른 행위(워크스페이스 초대)의
      // 이름이고, 그 갈라짐이 이 레인이 매 캡처마다 증명하는 것의 일부다.
      await empty.getByRole("button", { name: "멤버 추가하기" }).click();
    }
    await page
      .getByTestId("add-channel-member-dialog")
      .waitFor({ state: "visible" });
    if (settleTestId) {
      // 이 상태는 목의 재시도 백오프를 지나 정착해야 찍힌다: 500은 queryClient의
      // retry:1 + 기본 ~1000ms 백오프 때문에 열자마자는 아직 pending(재시도 중)
      // 이라 스켈레톤이 뜬다. 그 testid가 보일 때까지 기다려 실제 상태를 찍는다.
      await page.getByTestId(settleTestId).waitFor({ state: "visible" });
    } else {
      // 스켈레톤/정상은 목이 곧바로(또는 영영) 응답하므로 200ms면 안정된다.
      // 애니메이션은 reducedMotion으로 이미 꺼져 있다.
      await page.waitForTimeout(200);
    }
    const path = `${OUT_DIR}/add-member-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  // 정상: 기본 로스터. 추가 가능(사람 셋·에이전트 하나) + 이미 멤버(hermes).
  await shoot("normal", null);
  // 빈: 워크스페이스에 나뿐. 카피 + "멤버 초대하기" 액션(F-1)이 보인다.
  await shoot("empty", (route) => json(route, { members: [ROSTER[0]] }));
  // 에러: 로스터 읽기 실패 → 인라인 배너 + 다시 시도. 500은 재시도 백오프를
  // 지나야 error로 정착하므로, 200ms가 아니라 error 배너가 뜰 때까지 기다린다.
  await shoot(
    "error",
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: { message: "roster unavailable" } }),
      }),
    "add-member-roster-error"
  );
  // 로딩: 로스터 요청을 영영 붙잡아 스켈레톤이 화면에 남게 한다. 응답하지
  // 않으므로 fulfill이 없고, 컨텍스트가 닫히면 요청은 그대로 버려진다(닫힌
  // 컨텍스트에 뒤늦게 응답해 터지는 일이 없다). 진입은 헤더 문(위 entry).
  await shoot("loading", () => new Promise(() => {}), null, "header");

  return shots;
}

// =============================================================================
// 호스티드 에이전트 연결 마법사 (goal HAP-UX1 / #1360).
//
// 이 표면은 다섯 단계 중 둘이 **남의 프로세스를 기다리는** 자리라, 사람이 실제로
// 마주치는 화면 대부분이 서버 상태 하나로 갈린다. 그래서 한 장면이 아니라 상태별로
// 찍는다. 네 상태 중 앞의 셋(빈·로딩·오류)도 같은 레인에서 나온다.
//
// 픽스처의 비밀값은 고정 문자열이고 실제 자격증명이 아니다. 그것이 화면에 어떻게
// 서는지(길이가 카드를 넘치게 하지 않는지, 복사 버튼과 「저장했습니다」가 같은 줄에
// 서는지)를 보는 것이 이 레인의 절반이다.
// =============================================================================
const HOSTED_CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c1";
const HOSTED_CREDENTIAL_ID = "019f9a01-0000-7000-8000-0000000005e1";
const HOSTED_PAIRING_VALUE =
  "momo_pair_v1.00000000-0000-7000-8000-000000000001.3xJ7pQ2mVdKcR9tYbN4sLwF6hZa1XeUgO8iPjM0nCvA";

function hostedConnection(overrides = {}) {
  return {
    id: HOSTED_CONNECTION_ID,
    agentMemberId: "019f9a01-0000-7000-8000-000000000404",
    status: "pairing_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [],
    approvedScopes: [],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

async function captureHostedPairingScenes(browser, scheme) {
  const shots = [];

  /**
   * 한 상태를 세우고 프레임을 찍는다.
   *
   * `frames` 는 첫 프레임 **뒤에** 같은 페이지에서 이어 찍는 [이름, 동작] 쌍이다.
   * 이 다이얼로그의 몸통은 자기 스크롤 상자라(`overflow-y-auto`), 한 장에 들어가지
   * 않는 화면은 한 장으로 리뷰될 수 없다: 접힌 아래는 존재하지 않는 것처럼 보이고,
   * 리뷰는 자기가 보지 못한 것을 지적하지 못한다.
   */
  async function shoot(name, install, settle, frames = []) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    await install(context);
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.evaluate('location.hash = "/agents"');
    await page.getByTestId("agent-hub-hosted-pairing").click();
    await page.getByTestId("hosted-agent-wizard").waitFor({ state: "visible" });
    await settle(page, context);

    const frame = async (suffix) => {
      const path = `${OUT_DIR}/hosted-pairing-${suffix}-${scheme}.png`;
      await page.screenshot({ path });
      shots.push(path);
    };
    await frame(name);
    for (const [suffix, act] of frames) {
      await act(page, context);
      await frame(suffix);
    }
    await context.close();
  }

  const emptyList = (context) =>
    context.route("**/v1/workspaces/*/hosted-agent-connections", (route) =>
      route.request().method() === "POST"
        ? json(route, {
            connection: hostedConnection(),
            pairingCredential: HOSTED_PAIRING_VALUE,
            pairingExpiresAtMs: Date.now() + 15 * 60 * 1000,
          })
        : json(route, { connections: [] })
    );

  function listWith(connection) {
    return async (context) => {
      // 더 긴 경로를 먼저 건다: 목록 패턴이 단건을 삼키지 않게. 나중에 등록한
      // 라우트가 먼저 보이므로 순서가 이 두 줄의 전부다.
      await context.route("**/v1/workspaces/*/hosted-agent-connections", (route) =>
        json(route, { connections: [connection] })
      );
      await context.route(
        "**/v1/workspaces/*/hosted-agent-connections/*",
        (route) => json(route, { connection, cleanupArtifacts: [] })
      );
    };
  }

  // 1단계. 진행 중인 연결이 없는 워크스페이스가 마법사를 여는 첫 화면이다.
  await shoot("identity", emptyList, (page) =>
    page.getByTestId("hosted-display-name").waitFor({ state: "visible" })
  );

  // 2단계. 연결 값 일회 노출. 이 레인이 존재하는 가장 큰 이유다.
  await shoot("pairing", emptyList, async (page) => {
    await page.getByTestId("hosted-display-name").fill("Grok 리서치");
    await page.getByTestId("hosted-handle").fill("grok-research");
    await page.getByTestId("hosted-create").click();
    await page.getByTestId("hosted-pairing-card").waitFor({ state: "visible" });
  });

  // 3단계. 다이얼인 대기 = 이 표면의 빈 상태.
  await shoot("detecting", listWith(hostedConnection()), async (page) => {
    await page.getByTestId("hosted-wizard-resume").click();
    await page.getByTestId("hosted-detecting-empty").waitFor({ state: "visible" });
  });

  // 4단계. 사람이 채널과 권한을 고르는 자리 — 이 마법사에서 유일하게 되돌릴 수 없는
  // 결정이고, 그래서 두 프레임을 갖는다 (design-review M2).
  //
  // 첫 프레임은 사실 표와 보안 문장, 채널 목록의 머리에서 끝난다. 사람이 「이 범위로
  // 승인」을 누르기 전에 실제로 읽어야 하는 셋은 전부 그 아래에 있었다: 끌 수 없는
  // 접속 권한 줄, 사유를 달고 선 1:1 대화 줄, 그리고 고른 것 전체가 무슨 뜻인지
  // 말하는 결과 문장. 접힌 아래가 리뷰에 한 번도 오르지 않으면 이 화면의 규율 셋
  // (approval.ts 머리말)은 코드에만 있고 증거에는 없다.
  await shoot(
    "approval",
    listWith(hostedConnection({ status: "detected" })),
    async (page) => {
      await page.getByTestId("hosted-wizard-resume").click();
      await page.getByTestId("hosted-consequence").waitFor({ state: "visible" });
      await page
        .getByTestId("hosted-channels")
        .getByRole("checkbox")
        .first()
        .check();
    },
    [
      // 두 장으로 나누는 것은 취향이 아니라 실측이다. 1280x800 에서 이 몸통의
      // 스크롤 창은 ~506px 이고, 잠긴 접속 줄부터 결과 문장까지가 ~614px 다.
      // 한 장에 담으려면 뷰포트를 리뷰 기준보다 키워야 하는데, 그렇게 찍은 그림은
      // 아무도 쓰지 않는 창에서만 참인 배치를 보여준다. 겹치게 두 장을 찍으면
      // 리뷰 기준 그대로이면서 접힌 아래가 빠짐없이 오른다.
      [
        // 자격 없는 줄이 **사유를 달고 서 있는가** (approval.ts 규율 2). 자격 없는
        // 줄은 뒤로 모이므로(`channelApprovalChoices`) 그 첫 줄을 스크롤 창의 머리에
        // 붙이면 1:1 대화 줄과 잠긴 접속 권한 줄이 한 화면에 함께 선다.
        "approval-scopes",
        async (page) => {
          await page
            .locator('[data-testid="hosted-channels-row"][data-choice-disabled]')
            .first()
            .evaluate((el) => el.scrollIntoView({ block: "start" }));
          await page.getByTestId("hosted-scopes").waitFor({ state: "visible" });
          await page.waitForTimeout(200);
        },
      ],
      [
        // 결과 문장은 몸통의 **마지막** 블록이라, 그것을 시야에 넣는 것이 곧 바닥까지
        // 스크롤하는 것이다. 권한 목록의 꼬리와 「저장한 뒤」 주의가 함께 선다.
        "approval-consequence",
        async (page) => {
          await page.getByTestId("hosted-consequence").scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        },
      ],
    ]
  );

  // 5단계 앞면. 승인은 끝났고 증명이 아직 안 왔다.
  await shoot(
    "awaiting-proof",
    listWith(
      hostedConnection({
        status: "detected",
        activeCredentialId: HOSTED_CREDENTIAL_ID,
        approvedChannelIds: [GENERAL_ID],
        approvedScopes: [
          "agent:port:connect",
          "agent:inbox:read",
          "messages:write",
        ],
      })
    ),
    async (page) => {
      await page.getByTestId("hosted-wizard-resume").click();
      await page.getByTestId("hosted-awaiting-proof").waitFor({ state: "visible" });
    }
  );

  // 5단계 뒷면. 활성 + 테스트 멘션.
  await shoot(
    "active",
    listWith(
      hostedConnection({
        status: "active",
        activeCredentialId: HOSTED_CREDENTIAL_ID,
        approvedChannelIds: [GENERAL_ID],
        approvedScopes: [
          "agent:port:connect",
          "agent:inbox:read",
          "messages:write",
        ],
      })
    ),
    async (page) => {
      await page.getByTestId("hosted-wizard-resume").click();
      await page.getByTestId("hosted-test-mention").waitFor({ state: "visible" });
    }
  );

  // 만료. 이 흐름에서만 나오는 상태이고, 푸는 법이 화면에 있어야 한다.
  await shoot(
    "expired",
    listWith(hostedConnection({ status: "expired" })),
    async (page) => {
      await page.getByTestId("hosted-wizard-resume").click();
      await page.getByTestId("hosted-expired").waitFor({ state: "visible" });
    }
  );

  // 오류. 500은 재시도 백오프를 지나야 error로 정착하므로 배너를 기다린다.
  await shoot(
    "error",
    (context) =>
      context.route("**/v1/workspaces/*/hosted-agent-connections", (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "hosted connections unavailable" },
          }),
        })
      ),
    (page) =>
      page.getByTestId("hosted-wizard-list-error").waitFor({ state: "visible" })
  );

  // 오프라인 (SKILL §5의 넷째 상태, design-review M2). 앞의 셋(빈·로딩·오류)은
  // 이미 이 레인에 있었고 이것만 없었다.
  //
  // 이 표면에서 오프라인은 「아무것도 못 한다」가 아니라 **읽기와 쓰기가 갈리는**
  // 자리라, 그림으로만 확인되는 것이 있다: 마지막으로 받은 상태(사실 표·잠긴 줄·
  // 결과 문장)는 그대로 읽히는데 값 발급과 승인만 물러난다. 그 둘이 한 화면에
  // 함께 서는지는 배너 한 줄로는 알 수 없다.
  //
  // 4단계를 고른 이유가 그것이다: 이 마법사에서 오프라인이 실제로 막는 결정이
  // 사는 유일한 화면이고, 「이 범위로 승인」이 물러난 자리에 그 결정의 근거가
  // 전부 남아 있어야 한다. 레일의 `disconnected`는 종단 절단에서만 오므로
  // (useOffline), 채널 만들기 레인과 같이 브라우저 신호를 실제로 끊는다.
  await shoot(
    "offline",
    listWith(hostedConnection({ status: "detected" })),
    async (page, context) => {
      await page.getByTestId("hosted-wizard-resume").click();
      await page.getByTestId("hosted-consequence").waitFor({ state: "visible" });
      await context.setOffline(true);
      await page.getByTestId("hosted-wizard-offline").waitFor({ state: "visible" });
      await page.waitForTimeout(200);
    },
    [
      // 같은 이유로 여기도 접힌 아래를 본다. 오프라인에서 재야 하는 것이 정확히
      // 이 대비이기 때문이다: 푸터의 「이 범위로 승인」은 물러났는데(푸터는 어느
      // 프레임에서나 보인다) 그 버튼이 무엇을 저장하려던 것인지 말하는 결과
      // 문장과 권한 목록은 흐려지지 않고 그대로 읽힌다.
      [
        "offline-consequence",
        async (page) => {
          await page.getByTestId("hosted-consequence").scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        },
      ],
    ]
  );

  // 로딩. 목록 요청을 영영 붙잡아 스켈레톤이 화면에 남게 한다.
  await shoot(
    "loading",
    (context) =>
      context.route(
        "**/v1/workspaces/*/hosted-agent-connections",
        () => new Promise(() => {})
      ),
    (page) => page.waitForTimeout(200)
  );

  return shots;
}

// =============================================================================
// 호스티드 연결 해제와 정리 확인 (goal HAP-UX2 / #1362).
//
// 마법사 레인과 나란히 서지만 다른 표면이다: 여기는 다이얼로그가 아니라 에이전트
// 상세의 「연결」 탭이고, 사람이 며칠에 걸쳐 오가는 장부다. 그래서 찍는 것도 단계가
// 아니라 **장부의 상태**다.
//
// 픽스처가 일부러 중간값인 이유: 다 비었거나 다 찬 목록은 이 화면의 논지를 보여
// 주지 못한다. #1344 의 교훈이 눈에 보이는 조합은 하나뿐이다 — 커넥터는 닫혔는데
// 로컬 파일은 열려 있고, routine 은 「꺼짐」인 채로 미해결이며, 자격증명 한 줄만
// 서버가 스스로 닫아 둔 상태.
// =============================================================================
const DISCONNECT_AGENT_ID = "019f9a01-0000-7000-8000-000000000404";
const DISCONNECT_CONNECTION_ID = "019f9a01-0000-7000-8000-0000000005c9";
const ACK_AT_MS = 1_700_000_600_000;

function cleanupArtifact(kind, overrides = {}) {
  const expectedAction =
    kind === "bot" ? "decide" : kind === "secret" ? "revoke" : "remove";
  return {
    id: `019f9a01-0000-7000-8000-0000000006${kind.length}${kind.slice(0, 1)}`,
    kind,
    expectedAction,
    currentStatus: "unknown",
    disposition: "pending",
    resolved: false,
    required: true,
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  };
}

/** 절반쯤 온 장부. 여섯 줄이 서로 다른 네 상태를 하나씩 들고 있다. */
const CLEANUP_MIDWAY = [
  cleanupArtifact("connector", {
    currentStatus: "absent",
    disposition: "removed",
    resolved: true,
    source: "manual",
    acknowledgedBy: ME,
    acknowledgedAtMs: ACK_AT_MS,
    evidence: "Grok 설정 > 커넥터에서 제거를 눌렀고 목록에서 사라진 것을 확인",
  }),
  // 이름 붙은 두 줄은 일부러 길고 구분자가 섞여 있다(공백·/·:··(가운뎃점)·-·괄호):
  // cleanupRowTitle 의 boundedLabel(80) 절단과, 900px 좁은 열에서 제목이 음절이
  // 아니라 어절에서 감기는지를 done/manifest 프레임이 증거로 남긴다.
  cleanupArtifact("local_plugin_files", {
    externalRef:
      "~/Library/Application Support/oort/plugins/grok-bridge/private/김인턴-intake-v2 · source: local-only (2026-08 개편본)",
  }),
  cleanupArtifact("plugin", {
    externalRef:
      "사내 비공개 플러그인 레지스트리 / grok-bridge:team-inbox-intake-pipeline · 김인턴 파이프라인 v2 (2026-08 개편)",
  }),
  cleanupArtifact("routine", { currentStatus: "inactive" }),
  cleanupArtifact("bot"),
  cleanupArtifact("secret", {
    currentStatus: "absent",
    disposition: "revoked",
    resolved: true,
    source: "server_verified",
    acknowledgedAtMs: 1_700_000_500_000,
    evidence: "oort revoked 1 hosted credential(s) on this connection",
  }),
];

/** 필수 여섯 줄이 전부 닫힌 장부. 봇은 「남김」이라는 정식 종착으로 닫혔다. */
const CLEANUP_DONE = CLEANUP_MIDWAY.map((artifact) => {
  if (artifact.resolved) return artifact;
  const disposition = artifact.kind === "bot" ? "preserved" : "removed";
  const evidence =
    artifact.kind === "bot"
      ? "팀에 알린 뒤 대화 기록을 지키려고 봇은 남겨 두기로 했습니다"
      : "provider 설정과 로컬 폴더를 열어 항목이 없는 것을 확인";
  return {
    ...artifact,
    currentStatus: artifact.kind === "bot" ? "present" : "absent",
    disposition,
    resolved: true,
    source: "manual",
    acknowledgedBy: ME,
    acknowledgedAtMs: ACK_AT_MS,
    evidence,
  };
});

function disconnectConnection(overrides = {}) {
  return {
    id: DISCONNECT_CONNECTION_ID,
    agentMemberId: DISCONNECT_AGENT_ID,
    status: "cleanup_pending",
    authMode: "static_bearer",
    audience: "/v1/mcp/agent-port",
    approvedChannelIds: [CHANNEL_IDS[0]],
    approvedScopes: ["agent:port:connect", "agent:inbox:read", "messages:write"],
    createdAtMs: 1_700_000_000_000,
    updatedAtMs: 1_700_000_400_000,
    ...overrides,
  };
}

async function captureHostedDisconnectScenes(browser, scheme) {
  const shots = [];

  // band 는 리뷰 루브릭 §11 phase 2 의 두 폭이다: 기본 1280, 그리고 사이드바가
  // 아직 열(column)인 900 — 이 표면의 제목·문장이 전부 full length 인 채로 열이
  // ~600px 로 좁아지는 지점. 좁은 밴드에서는 프레임마다 가로 오버플로를 재서
  // 0 이 아니면 던진다(b8 레인과 같은 자).
  const BANDS = {
    wide: { viewport: VIEWPORT, tag: "" },
    narrow: { viewport: { width: 900, height: 800 }, tag: "-900" },
  };

  async function shoot(
    name,
    install,
    settle = async () => {},
    frames = [],
    band = BANDS.wide
  ) {
    const context = await browser.newContext({
      viewport: band.viewport,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    await install(context);
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.evaluate('location.hash = "/agents"');
    // 해제는 연결을 만들 때가 아니라 **그 에이전트를 보다가** 하는 일이다. 그래서
    // 진입도 로스터에서 그 에이전트를 고르는 것으로 시작한다.
    await page
      .locator(`[data-testid="agent-hub-agent-row"][data-agent-id="${DISCONNECT_AGENT_ID}"]`)
      .click();
    await page.getByTestId("agent-hub-tab-connection").click();
    await page.getByTestId("hosted-connection-section").waitFor({ state: "visible" });
    await settle(page, context);

    const frame = async (suffix) => {
      const path = `${OUT_DIR}/hosted-disconnect-${suffix}${band.tag}-${scheme}.png`;
      await page.screenshot({ path });
      shots.push(path);
      if (band.tag) {
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth
        );
        if (overflow > 0) {
          throw new Error(
            `900px 가로 오버플로 ${overflow}px (${suffix}, ${scheme})`
          );
        }
      }
    };
    await frame(name);
    for (const [suffix, act] of frames) {
      await act(page, context);
      await frame(suffix);
    }
    await context.close();
  }

  // H1 초점 회수 검증 (design-review). 이 클라이언트엔 React 렌더 테스트 하네스가
  // 없어(testing-library 미설치, 웹 유닛 테스트는 전부 순수 로직) 초점 이동은 실제
  // 브라우저에서 잰다: 폼을 열면 초점이 <body> 가 아니라 폼 안 첫 라디오로 들어가고,
  // 닫으면 사라진 트리거가 아니라 줄 제목(h4, tabIndex -1)으로 돌아온다.
  async function assertFocusInForm(page) {
    await page
      .waitForFunction(
        () => {
          const el = document.activeElement;
          return (
            !!el &&
            el.tagName === "INPUT" &&
            el.getAttribute("type") === "radio" &&
            !!el.closest('[data-testid="cleanup-form"]')
          );
        },
        undefined,
        { timeout: 2000 }
      )
      .catch(() => {
        throw new Error("H1: 폼을 열 때 초점이 폼 안 첫 라디오로 들어가지 않았습니다.");
      });
  }
  async function assertFocusOnRowHeading(page, kind) {
    await page
      .waitForFunction(
        (k) => {
          const el = document.activeElement;
          return (
            !!el &&
            el.tagName === "H4" &&
            !!el.closest(
              `[data-testid="cleanup-artifact"][data-artifact-kind="${k}"]`
            )
          );
        },
        kind,
        { timeout: 2000 }
      )
      .catch(() => {
        throw new Error("H1: 폼을 닫을 때 초점이 줄 제목(h4)으로 돌아오지 않았습니다.");
      });
  }

  /**
   * 목록 + 장부를 세운다.
   *
   * 나중에 등록한 라우트가 먼저 보이므로 순서가 이 세 줄의 전부다: 목록,
   * 단건, 그리고 단건 글로브가 삼키지 못하는 하위 경로들.
   */
  function ledger(connection, cleanupArtifacts, extra) {
    return async (context) => {
      await context.route("**/v1/workspaces/*/hosted-agent-connections", (route) =>
        json(route, { connections: [connection] })
      );
      await context.route("**/v1/workspaces/*/hosted-agent-connections/*", (route) =>
        json(route, { connection, cleanupArtifacts })
      );
      if (extra) await extra(context);
    };
  }

  // 이 에이전트가 호스티드 연결로 들어오지 않은 경우. 이 탭의 빈 상태다.
  await shoot("empty", async (context) => {
    await context.route("**/v1/workspaces/*/hosted-agent-connections", (route) =>
      json(route, { connections: [] })
    );
  });

  // 아직 살아 있는 연결. 두 문단이 같은 크기로 서는 것이 이 프레임의 전부다.
  await shoot(
    "start",
    ledger(disconnectConnection({ status: "active" }), []),
    async (page) => {
      await page.getByTestId("hosted-disconnect-start").waitFor({ state: "visible" });
    },
    [
      // 확인 질문. 폐기가 되돌릴 수 없다는 사실이 버튼이 아니라 질문에 있다.
      [
        "start-confirm",
        async (page) => {
          await page.getByTestId("hosted-disconnect-start").click();
          await page.waitForTimeout(200);
        },
      ],
    ]
  );

  // 절반쯤 온 장부. 커넥터는 닫혔고 로컬 파일은 열려 있으며 routine 은 꺼짐이다.
  await shoot(
    "manifest",
    ledger(disconnectConnection(), CLEANUP_MIDWAY),
    async (page) => {
      await page.getByTestId("hosted-cleanup-manifest").waitFor({ state: "visible" });
    },
    [
      // 확정이 막힌 이유. 남은 수와 다음 항목이 버튼 옆에 적혀 있다.
      [
        "terminal-blocked",
        async (page) => {
          await page.getByTestId("hosted-terminal-blocked").scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        },
      ],
    ]
  );

  // 봇의 두 종착. 삭제 줄이 대화 기록을 이름으로 말하는 자리다. 여는 순간 초점이
  // 폼 안으로 들어가고 취소가 초점을 줄 제목으로 되돌리는지도 여기서 잰다 (H1).
  await shoot(
    "bot-choice",
    ledger(disconnectConnection(), CLEANUP_MIDWAY),
    async (page) => {
      const bot = page.locator('[data-testid="cleanup-artifact"][data-artifact-kind="bot"]');
      await bot.getByTestId("cleanup-open-form").click();
      await bot.getByTestId("cleanup-form").waitFor({ state: "visible" });
      await assertFocusInForm(page);
      await bot.getByTestId("cleanup-cancel").click();
      await assertFocusOnRowHeading(page, "bot");
      // 다시 열어 첫 종착(봇을 지웠습니다, 파괴)을 고른 폼을 남긴다.
      await bot.getByTestId("cleanup-open-form").click();
      await bot.getByTestId("cleanup-disposition").waitFor({ state: "visible" });
      await bot.getByTestId("cleanup-disposition").getByRole("radio").first().check();
      await bot.getByTestId("cleanup-evidence").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
    [
      // M1: 「봇을 남깁니다」는 대화 기록을 지키는 답이라 확정이 red 가 아니다.
      // 확정 질문을 열어 non-destructive 확정 버튼(「이대로 기록」)을 증거로 남긴다.
      [
        "bot-preserve-confirm",
        async (page) => {
          const bot = page.locator(
            '[data-testid="cleanup-artifact"][data-artifact-kind="bot"]'
          );
          await bot.getByTestId("cleanup-disposition").getByRole("radio").nth(1).check();
          await bot
            .getByTestId("cleanup-evidence")
            .fill("팀에 대화 기록 위치를 알린 뒤 봇은 남겨 두기로 했습니다");
          await bot.getByTestId("cleanup-save").click();
          await bot.getByTestId("cleanup-save-confirm").waitFor({ state: "visible" });
          await page.waitForTimeout(200);
        },
      ],
    ]
  );

  // 필수 여섯 줄이 전부 닫힌 장부와, 확정 질문.
  await shoot(
    "terminal",
    ledger(disconnectConnection(), CLEANUP_DONE),
    async (page) => {
      await page.getByTestId("hosted-disconnect-complete").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
    [
      [
        "terminal-confirm",
        async (page) => {
          await page.getByTestId("hosted-disconnect-complete").click();
          await page.waitForTimeout(200);
        },
      ],
    ]
  );

  // 확정이 끝난 뒤. 장부는 읽기 전용으로 남고 provenance 도 그대로 남는다 —
  // 해제가 기록을 지우는 일이 아니라는 이 화면의 논지가 마지막 프레임이다.
  await shoot(
    "done",
    ledger(disconnectConnection({ status: "disconnected" }), CLEANUP_DONE),
    async (page) => {
      await page.getByTestId("hosted-disconnect-terminal").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    }
  );

  // 확인 저장이 거절당한 자리. 폼은 그대로 열려 있고 적어 둔 문장도 남는다.
  await shoot(
    "error",
    ledger(disconnectConnection(), CLEANUP_MIDWAY, (context) =>
      context.route("**/cleanup-artifacts/*/acknowledge", (route) =>
        route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { message: "cleanup artifact is already resolved" },
          }),
        })
      )
    ),
    async (page) => {
      const plugin = page.locator(
        '[data-testid="cleanup-artifact"][data-artifact-kind="plugin"]'
      );
      await plugin.getByTestId("cleanup-open-form").click();
      await plugin.getByTestId("cleanup-disposition").getByRole("radio").first().check();
      await plugin
        .getByTestId("cleanup-evidence")
        .fill("플러그인 관리 화면에서 등록을 삭제했습니다");
      await plugin.getByTestId("cleanup-save").click();
      await plugin.getByTestId("cleanup-save-confirm").click();
      await page.getByTestId("hosted-disconnect-failure").waitFor({ state: "visible" });
      await page.waitForTimeout(200);
    }
  );

  // 오프라인. 받아 둔 장부는 계속 읽히고, 저장하는 컨트롤만 잠긴다.
  await shoot(
    "offline",
    ledger(disconnectConnection(), CLEANUP_MIDWAY),
    async (page, context) => {
      await page.getByTestId("hosted-cleanup-manifest").waitFor({ state: "visible" });
      await context.setOffline(true);
      await page.getByTestId("hosted-cleanup-offline").waitFor({ state: "visible" });
      await page.waitForTimeout(200);
    }
  );

  // 900px 밴드 (리뷰 루브릭 §11 phase 2), 이 표면의 유일한 좁은 폭 증거다. 긴
  // 제목(local_plugin_files·plugin 의 긴 externalRef)이 ~600px 열에서 어절 단위로
  // 감기는 것과, done 뷰의 provenance 밀도(M5 이후)를 이 폭에서 남긴다. manifest 는
  // terminal-blocked 서브프레임까지 한 컨텍스트에서 찍고, 프레임마다 가로 오버플로
  // 0 을 확인한다.
  await shoot(
    "manifest",
    ledger(disconnectConnection(), CLEANUP_MIDWAY),
    async (page) => {
      await page.getByTestId("hosted-cleanup-manifest").waitFor({ state: "visible" });
    },
    [
      [
        "terminal-blocked",
        async (page) => {
          await page.getByTestId("hosted-terminal-blocked").scrollIntoViewIfNeeded();
          await page.waitForTimeout(200);
        },
      ],
    ],
    BANDS.narrow
  );
  await shoot(
    "done",
    ledger(disconnectConnection({ status: "disconnected" }), CLEANUP_DONE),
    async (page) => {
      await page.getByTestId("hosted-disconnect-terminal").scrollIntoViewIfNeeded();
      await page.waitForTimeout(200);
    },
    [],
    BANDS.narrow
  );

  return shots;
}

// =============================================================================
// 호스티드 연결 도어벨 등록 (ADR-0171 / WD-2 / #1735).
//
// 연결 탭의 한 상자다. 찍는 것은 네 상태(빈·로딩·등록됨·실패)와, 등록 실패와
// 다른 게이트 닫힘이다. 벨 테스트는 이 파도에 없다.
// =============================================================================
async function captureHostedDoorbellScenes(browser, scheme) {
  const shots = [];
  const connection = disconnectConnection({ status: "active" });

  async function shoot(name, install, settle = async () => {}) {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 2,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    await install(context);
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.evaluate('location.hash = "/agents"');
    await page
      .locator(
        `[data-testid="agent-hub-agent-row"][data-agent-id="${DISCONNECT_AGENT_ID}"]`
      )
      .click();
    await page.getByTestId("agent-hub-tab-connection").click();
    await page.getByTestId("hosted-doorbell-section").waitFor({ state: "visible" });
    await settle(page, context);
    const path = `${OUT_DIR}/hosted-doorbell-${name}-${scheme}.png`;
    await page.screenshot({ path });
    shots.push(path);
    await context.close();
  }

  function surface(row, extra) {
    return async (context) => {
      await context.route("**/v1/workspaces/*/hosted-agent-connections", (route) =>
        json(route, { connections: [row] })
      );
      await context.route(
        "**/v1/workspaces/*/hosted-agent-connections/*",
        (route) => json(route, { connection: row, cleanupArtifacts: [] })
      );
      // 나중에 등록한 라우트가 이긴다. 도어벨 PUT 이 단건 GET 글로브에 먹히면
      // 실패·게이트 닫힘 프레임이 등록 성공으로 찍힌다.
      await context.route(
        "**/v1/workspaces/*/hosted-agent-connections/*/doorbell",
        extra
          ? extra
          : (route) =>
              json(route, {
                connectionId: row.id,
                url: "https://hooks.example.com/doorbell",
                secretMasked: "••••wxyz",
                registeredAtMs: 1_700_000_700_000,
              })
      );
    };
  }

  await shoot("empty", surface(connection), async (page) => {
    await page.getByTestId("hosted-doorbell-empty").waitFor({ state: "visible" });
  });

  await shoot(
    "loading",
    async (context) => {
      await context.route(
        "**/v1/workspaces/*/hosted-agent-connections",
        (route) => json(route, { connections: [connection] })
      );
      await context.route(
        "**/v1/workspaces/*/hosted-agent-connections/*",
        () => new Promise(() => {})
      );
    },
    async (page) => {
      await page.getByTestId("hosted-doorbell-loading").waitFor({ state: "visible" });
    }
  );

  await shoot(
    "registered",
    surface({
      ...connection,
      doorbellUrl: "https://hooks.example.com/doorbell",
      doorbellSecretMasked: "••••wxyz",
      doorbellLastFiredAtMs: Date.now() - 12 * 60_000,
      doorbellLastStatus: "ok_200",
    }),
    async (page) => {
      await page
        .getByTestId("hosted-doorbell-registered")
        .waitFor({ state: "visible" });
    }
  );

  await shoot(
    "error",
    surface(connection, (route) =>
      route.fulfill({
        status: 400,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            message: "webhook URL resolves to a private or reserved address",
          },
        }),
      })
    ),
    async (page) => {
      await page.getByTestId("hosted-doorbell-url").fill(
        "https://hooks.example.com/doorbell"
      );
      await page.getByTestId("hosted-doorbell-secret").fill("crsr_capture_fixture");
      await page.getByTestId("hosted-doorbell-register").click();
      await page.getByTestId("hosted-doorbell-failure").waitFor({ state: "visible" });
    }
  );

  await shoot(
    "gate-off",
    surface(connection, (route) =>
      route.fulfill({ status: 404, body: "" })
    ),
    async (page) => {
      await page.getByTestId("hosted-doorbell-url").fill(
        "https://hooks.example.com/doorbell"
      );
      await page.getByTestId("hosted-doorbell-secret").fill("crsr_capture_fixture");
      await page.getByTestId("hosted-doorbell-register").click();
      await page.getByTestId("hosted-doorbell-gate-off").waitFor({ state: "visible" });
    }
  );

  return shots;
}

/**
 * #1369 HAP-UX4 — the MCP OAuth resource-owner consent surface, in both schemes.
 *
 * This screen lives ABOVE HashRouter (App intercepts `window.location.pathname`),
 * because the provider redirect lands on a real `/oauth/consent?request=` path
 * whose query is not a hash. So each frame is a full navigation to that path, not
 * a `location.hash` set. One preview route (installMocks) varies by the `request`
 * flag, so the terminals are reachable without swapping routes.
 *
 * Its own context, so the logged-out sign-in frame is genuinely logged out (the
 * shared-localStorage pages elsewhere would auto-restore a session).
 *
 * NOT yet shot here (interaction/timing, noted for a follow-up): approve-in-
 * flight, deny redirect, offline banner. The static compositions below (form +
 * four terminals + sign-in) cover the review's structural surface; the atoms
 * (ChoiceList, KeyValueRows, InlineBanner, EmptyInvite, Button) are already shot
 * elsewhere in both schemes.
 */
/**
 * `data-accent` flipping is not the same as paint. Buttons carry
 * `transition-colors` (150ms) even under reduced motion, so wait until a
 * filled control's computed background equals `var(--token)`.
 *
 * `selector` is a CSS selector, not a test id: the selected channel row is
 * one of several `[data-testid="channel-item"]` nodes, and only the
 * `aria-current="page"` one paints `--accent-soft`.
 */
async function waitUntilTokenPaint(page, selector, cssVar) {
  await page.waitForFunction(
    ({ selector: sel, cssVar: token }) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      const probe = document.createElement("span");
      probe.style.backgroundColor = `var(${token})`;
      probe.style.position = "absolute";
      probe.style.left = "-9999px";
      document.body.appendChild(probe);
      const target = getComputedStyle(probe).backgroundColor;
      probe.remove();
      if (target === "rgba(0, 0, 0, 0)" || target === "transparent") return false;
      return getComputedStyle(el).backgroundColor === target;
    },
    { selector, cssVar },
    { timeout: 8_000 }
  );
}

/**
 * Hash navigation and `data-accent` both start 150ms color transitions.
 * Dawn is a no-op accent change, so `--accent` probes would pass on the
 * first tick while the selected row is still mid-transition. Finite
 * running animations (not the infinite caret/spin) must be gone.
 */
async function waitForAnimations(page) {
  await page.waitForFunction(
    () =>
      document.getAnimations().filter((animation) => {
        if (animation.playState !== "running") return false;
        const timing =
          animation.effect && typeof animation.effect.getTiming === "function"
            ? animation.effect.getTiming()
            : null;
        if (timing && timing.iterations === Infinity) return false;
        return true;
      }).length === 0,
    { timeout: 8_000 }
  );
}

/**
 * UX-R1c: two frames per scheme at 1280, plus light 390 (skeleton then
 * settled). Holds the channel list, channel messages, and inbox approvals
 * fetch so the surfaces that actually crossfade (sidebar + inbox) are
 * loading together. Motion stays on; waitForAnimations covers the 240ms
 * fade. This is not ADR-0179 D10 ③ / DS-3.
 *
 * The inbox default panel is 결정 대기 (`GET …/approvals`). Holding only
 * channels leaves that panel ready=true with cards already painted. Gate
 * the skeleton frame on `[data-testid="inbox-route"] [data-ready="false"]`
 * (1 at skeleton, 0 at settled) and the settled frame on the inverse.
 */
async function captureSkeletonReveal(browser, scheme) {
  return captureSkeletonRevealAt(browser, scheme, VIEWPORT, "");
}

/**
 * 1280 keeps the sidebar column in frame. 390 folds it into a drawer, so
 * the wait is `open-sidebar-drawer` (and the inbox skeleton in the pane),
 * never `channel-list`. Light 390 is enough to put the phone-width bars
 * on record; dark 390 is the same layout.
 */
async function captureSkeletonRevealAt(browser, scheme, viewport, nameSuffix) {
  const phone = viewport.width === MOBILE_VIEWPORT.width;
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
  });
  let release = () => {};
  const held = new Promise((resolve) => {
    release = resolve;
  });
  await installMocks(context);
  await context.route("**/v1/workspaces/*/channels", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    return route.fallback();
  });
  await context.route(
    "**/v1/workspaces/*/channels/*/messages*",
    async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.includes("/replies")) return route.fallback();
      if (route.request().method() !== "GET") return route.fallback();
      await held;
      return route.fallback();
    }
  );
  await context.route("**/v1/workspaces/*/approvals*", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    await held;
    return route.fallback();
  });
  const page = await context.newPage();
  const shots = [];
  try {
    await page.goto(ORIGIN, { waitUntil: "domcontentloaded" });
    await page.evaluate(
      "try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}"
    );
    await page.reload({ waitUntil: "domcontentloaded" });
    await signInThroughOnboarding(page, {
      email: "seongjae@dawn.example",
      password: "capture-only-not-a-credential",
    });
    if (phone) {
      await page
        .getByTestId("open-sidebar-drawer")
        .waitFor({ state: "visible" });
    } else {
      await page.getByTestId("channel-list").waitFor({ state: "visible" });
      await page.getByTestId("skeleton-row").first().waitFor({ state: "visible" });
    }
    await page.evaluate('location.hash = "/inbox"');
    await page.getByTestId("inbox-route").waitFor({ state: "visible" });
    await page
      .locator('[data-testid="inbox-route"] [data-ready="false"]')
      .waitFor({ state: "visible", timeout: 8_000 });
    await waitForAnimations(page);
    const skeletonPath = `${OUT_DIR}/skeleton${nameSuffix}-${scheme}.png`;
    await screenshotSettled(page, skeletonPath);
    shots.push(skeletonPath);
    release();
    if (!phone) {
      await page
        .getByTestId("sidebar-section-channels")
        .getByRole("link", { name: "엔진" })
        .waitFor({ state: "visible" });
    }
    await page
      .locator('[data-testid="inbox-route"] [data-ready="true"]')
      .waitFor({ state: "visible" });
    await page
      .locator('[data-testid="inbox-route"] [data-ready="false"]')
      .waitFor({ state: "hidden" });
    await page
      .locator('[data-testid="inbox-route"] [data-testid="skeleton"].is-settled')
      .waitFor({ state: "visible" });
    await waitForAnimations(page);
    const settledPath = `${OUT_DIR}/skeleton-settled${nameSuffix}-${scheme}.png`;
    await screenshotSettled(page, settledPath);
    shots.push(settledPath);
    return shots;
  } finally {
    await page.close();
    await context.close();
  }
}

/** Two consecutive buffers must match so a mid-transition shutter cannot ship. */
async function screenshotSettled(page, path) {
  await waitForAnimations(page);
  let previous = null;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const buffer = await page.screenshot({
      type: "png",
      animations: "disabled",
      caret: "hide",
    });
    if (previous !== null && Buffer.compare(previous, buffer) === 0) {
      claimShotPath(path);
      writeFileSync(path, buffer);
      return;
    }
    previous = buffer;
  }
  claimShotPath(path);
  writeFileSync(path, previous);
}

const ACCENT_CAPTURE_ARGS = [
  "--disable-lcd-text",
  "--disable-font-subpixel-positioning",
  "--font-render-hinting=none",
  "--force-color-profile=srgb",
  "--disable-gpu",
];

async function captureAccentCandidates(_sharedBrowser, scheme) {
  const ids = accentCatalogIds();
  // Own process: lucide/rail-marker AA jittered 1 RGB across shared-browser
  // launches (R3-M1). Software raster + no LCD keeps chrome visible and
  // two capture:design runs byte-identical.
  const browser = wrapBrowserShotGuard(
    await chromium.launch({ args: ACCENT_CAPTURE_ARGS })
  );
  try {
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      colorScheme: scheme,
      reducedMotion: "reduce",
    });
    await installMocks(context);
    const emptyChannelId = CHANNELS[3].id;
    // Last-registered route wins: this channel stays empty so unfurl cards cannot
    // dominate the 시안 frame.
    await context.route(
      `**/channels/${emptyChannelId}/messages*`,
      (route) => json(route, { messages: [] })
    );
    const page = await context.newPage();
    await page.goto(ORIGIN, { waitUntil: "networkidle" });
    await signIn(page);
    await page.getByTestId("channel-list").waitFor({ state: "visible" });
    // Empty public channel: selected sidebar row, enabled primary fill, and the
    // general mention badge share one frame. Timeline unfurl cards (baked amber)
    // do not dominate.
    await page.evaluate(`location.hash = "/c/${emptyChannelId}"`);
    await page.getByTestId("timeline-empty-primary").waitFor({ state: "visible" });
    await page.getByTestId("mention-badge").waitFor({ state: "visible" });
    await page
      .locator('[data-testid="channel-item"][aria-current="page"]')
      .waitFor({ state: "visible" });
    await page.evaluate(() => document.fonts.ready);
    // Product chrome stays visible (R3-M1). Lucide 16px strokes and the 2px
    // rail marker AA at 1 RGB across Chromium launches; snap those glyphs
    // so two capture:design runs stay byte-identical without hiding chrome.
    await page.addStyleTag({
      content: `svg { shape-rendering: crispEdges; }
[data-testid="workspace-current"] .bg-accent,
[data-testid="channel-item"][aria-current="page"] {
  transform: translateZ(0);
}`,
    });
    await waitForAnimations(page);
    const previewDir = resolve(WEB_ROOT, "src/design/themes/previews");
    mkdirSync(previewDir, { recursive: true });
    const shots = [];
    for (const id of ids) {
      await page.evaluate((accentId) => {
        document.documentElement.setAttribute("data-accent", accentId);
      }, id);
      await waitUntilTokenPaint(page, '[data-testid="timeline-empty-primary"]', "--accent");
      await waitUntilTokenPaint(page, '[data-testid="mention-badge"]', "--accent");
      await waitUntilTokenPaint(
        page,
        '[data-testid="channel-item"][aria-current="page"]',
        "--accent-soft"
      );
      await waitForAnimations(page);
      await page.evaluate(
        () =>
          new Promise((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(resolve));
          })
      );
      const path = `${OUT_DIR}/accent-${id}-${scheme}.png`;
      await screenshotSettled(page, path);
      copyFileSync(path, resolve(previewDir, `accent-${id}-${scheme}.png`));
      shots.push(path);
    }
    await page.close();
    await context.close();
    return shots;
  } finally {
    await browser.close();
  }
}

async function captureConsent(browser, scheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  await installMocks(context);
  const shots = [];

  // logged-out → existing sign-in (fresh context, no persisted session).
  const signin = await context.newPage();
  await signin.goto(`${ORIGIN}/oauth/consent?request=preview-ok`, {
    waitUntil: "networkidle",
  });
  await signin.getByTestId("oauth-consent-signin").waitFor({ state: "visible" });
  const signinShot = `${OUT_DIR}/oauth-consent-signin-${scheme}.png`;
  await signin.screenshot({ path: signinShot });
  shots.push(signinShot);
  await signin.close();

  // signed-in: the consent form and the four terminals. sign in once (persists a
  // session), then navigate to each request flag.
  const page = await context.newPage();
  await page.goto(ORIGIN, { waitUntil: "networkidle" });
  await signIn(page);
  for (const [request, testId, name] of [
    ["preview-ok", "oauth-consent-form", "preview"],
    ["preview-empty", "oauth-consent-no-candidate", "no-candidate"],
    ["preview-expired", "oauth-consent-expired", "expired"],
    // 404 == the OAuth-disabled answer too (non-enumerable).
    ["preview-unavailable", "oauth-consent-unavailable", "unavailable"],
  ]) {
    await page.goto(`${ORIGIN}/oauth/consent?request=${request}`, {
      waitUntil: "networkidle",
    });
    await page.getByTestId(testId).waitFor({ state: "visible" });
    await assertNoHorizontalOverflow(page, `oauth-consent ${name} ${scheme}`);
    const shot = `${OUT_DIR}/oauth-consent-${name}-${scheme}.png`;
    await page.screenshot({ path: shot });
    shots.push(shot);
  }
  await page.close();

  await context.close();
  return shots;
}

async function assertGalleryLoadFocus(page, where) {
  const gallery = page.getByTestId("design-gallery");
  const before = await gallery.evaluate((el) => el.scrollTop);
  let info = null;
  for (let i = 0; i < 4; i += 1) {
    await page.keyboard.press("Tab");
    info = await page.evaluate(() => {
      const el = document.activeElement;
      const g = document.querySelector("[data-testid=design-gallery]");
      if (!(el instanceof HTMLElement) || !g) {
        return { ok: false, reason: "no-focus" };
      }
      const er = el.getBoundingClientRect();
      const gr = g.getBoundingClientRect();
      const label = (
        el.getAttribute("aria-label") ||
        el.innerText ||
        el.getAttribute("data-gallery-export") ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 40);
      return {
        ok: true,
        tag: el.tagName,
        label,
        role: el.getAttribute("role") || "",
        scrollTop: g.scrollTop,
        viewportTop: Math.round(er.top),
        galleryY: Math.round(er.top - gr.top + g.scrollTop),
        area: Math.round(er.width * er.height),
        inSpecimen: Boolean(
          el.closest("[data-gallery-stage], [role='menu'], [role='dialog']")
        ),
        isBody: el === document.body,
      };
    });
    if (!info.ok) {
      throw new Error(`${where}: 로드 후 Tab 이 포커스를 옮기지 않았다`);
    }
    if (info.scrollTop > 80) {
      throw new Error(
        `${where}: 로드 후 첫 Tab 이 갤러리를 ${before} → ${info.scrollTop} 로 굴렸다 (${info.tag} ${info.label})`
      );
    }
    if (info.area > 0) break;
  }
  if (!info || !info.ok) {
    throw new Error(`${where}: 로드 후 첫 Tab 이 포커스를 옮기지 않았다`);
  }
  if (info.isBody) {
    throw new Error(`${where}: 로드 후 첫 가시 Tab 이 body 에 남았다`);
  }
  if (info.inSpecimen) {
    throw new Error(
      `${where}: 로드 후 첫 가시 Tab 이 표본 안 (${info.tag} ${info.role} ${info.label})`
    );
  }
  if (info.area <= 0) {
    throw new Error(
      `${where}: 로드 후 Tab 4번에 면적 있는 컨트롤이 없다 (${info.tag} ${info.label})`
    );
  }
  if (info.viewportTop < 0 || info.viewportTop > 700) {
    throw new Error(
      `${where}: 로드 후 첫 가시 Tab 착지가 화면 위가 아니다 (y=${info.viewportTop} galleryY=${info.galleryY} ${info.label})`
    );
  }
  console.log(
    `  load-focus ${where}: Tab → ${info.tag} "${info.label}" y=${info.viewportTop} galleryY=${info.galleryY} scroll=${info.scrollTop} area=${info.area}`
  );
  await releaseGallerySelection(page);
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
}

async function releaseGallerySelection(page) {
  await page.evaluate(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) active.blur();
    window.getSelection()?.removeAllRanges();
  });
}

async function assertGalleryUsable(page, where) {
  const lock = await page.evaluate(() => {
    const body = document.body;
    return {
      pointerEvents: getComputedStyle(body).pointerEvents,
      scrollLocked: body.getAttribute("data-scroll-locked"),
    };
  });
  if (lock.pointerEvents === "none") {
    throw new Error(`${where}: body pointer-events: none`);
  }
  if (lock.scrollLocked && lock.scrollLocked !== "0") {
    throw new Error(`${where}: body data-scroll-locked=${lock.scrollLocked}`);
  }

  const darkToggle = page.getByRole("button", { name: "다크로 보기" });
  const lightToggle = page.getByRole("button", { name: "라이트로 보기" });
  const other = where.includes("dark") ? lightToggle : darkToggle;
  const home = where.includes("dark") ? darkToggle : lightToggle;
  await other.click({ timeout: 3000 });
  const pressed = await other.getAttribute("aria-pressed");
  if (pressed !== "true") {
    throw new Error(`${where}: 스킴 토글 클릭이 먹지 않는다 (aria-pressed=${pressed})`);
  }
  await home.click({ timeout: 3000 });

  const gallery = page.getByTestId("design-gallery");
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
  const viewport = page.viewportSize();
  await page.mouse.move(
    Math.floor(viewport.width / 2),
    Math.floor(viewport.height / 2)
  );
  const before = await gallery.evaluate((el) => el.scrollTop);
  await page.mouse.wheel(0, 2400);
  await page.waitForTimeout(300);
  const after = await gallery.evaluate((el) => ({
    top: el.scrollTop,
    max: el.scrollHeight - el.clientHeight,
  }));
  if (after.max > 200 && after.top - before < 200) {
    throw new Error(
      `${where}: 휠 2400px 요청에 갤러리 스크롤 ${before} → ${after.top} (max ${after.max})`
    );
  }
  console.log(
    `  usable wheel ${where}: ${before} → ${after.top} (요청 2400, max ${after.max})`
  );

  await lightToggle.focus();
  const reached = [];
  for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press("Tab");
    const key = await page.evaluate(() => {
      const el = document.activeElement;
      if (!(el instanceof HTMLElement) || el === document.body) return "";
      const label =
        el.getAttribute("aria-label") ||
        el.innerText ||
        el.getAttribute("data-gallery-export") ||
        "";
      return `${el.tagName}:${label.replace(/\s+/g, " ").trim().slice(0, 24)}`;
    });
    if (key) reached.push(key);
  }
  const distinct = [...new Set(reached)];
  if (distinct.length < 2) {
    throw new Error(
      `${where}: Tab 8번에 서로 다른 컨트롤 ${distinct.length}개 (${distinct.join(" | ")})`
    );
  }
  console.log(`  usable tab ${where}: ${distinct.join(" → ")}`);
  console.log(
    `  usable lock ${where}: pointer-events=${lock.pointerEvents} scroll-locked=${lock.scrollLocked || "0"}`
  );

  await releaseGallerySelection(page);
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
}

async function assertOverlayProductGeometry(page, where) {
  const expected = {
    DialogContent: pixelToken("spacing-pane-md"),
    PopoverContent: pixelToken("spacing-pane-picker"),
    DropdownMenuContent: pixelToken("spacing-pane-sm"),
    ContextMenuContent: pixelToken("spacing-pane-sm"),
  };
  const rows = await page.evaluate((want) => {
    const names = [
      "DialogContent",
      "DialogOverlay",
      "DropdownMenuContent",
      "PopoverContent",
      "ContextMenuContent",
    ];
    return names.map((name) => {
      const el = document.querySelector(`[data-gallery-export="${name}"]`);
      if (!el) return { name, missing: true };
      const r = el.getBoundingClientRect();
      const stage = el.closest("[data-gallery-stage]");
      if (!stage) {
        return { name, missing: false, noStage: true, srOnly: false };
      }
      const s = stage.getBoundingClientRect();
      const overlapW = Math.max(
        0,
        Math.min(r.right, s.right) - Math.max(r.left, s.left)
      );
      const overlapH = Math.max(
        0,
        Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top)
      );
      const area = r.width * r.height;
      const visibleFraction = area > 0 ? (overlapW * overlapH) / area : 0;
      const replica = el.hasAttribute("data-gallery-replica");
      let unoccludedFraction = 1;
      let bgAlpha = 1;
      if (replica) {
        const panel = document.querySelector('[data-gallery-export="DialogContent"]');
        const p = panel ? panel.getBoundingClientRect() : null;
        if (p) {
          const hideW = Math.max(
            0,
            Math.min(r.right, p.right) - Math.max(r.left, p.left)
          );
          const hideH = Math.max(
            0,
            Math.min(r.bottom, p.bottom) - Math.max(r.top, p.top)
          );
          unoccludedFraction = area > 0 ? (area - hideW * hideH) / area : 0;
        } else {
          unoccludedFraction = 0;
        }
        const bg = getComputedStyle(el).backgroundColor;
        const alphaMatch = bg.match(/rgba?\(([^)]+)\)/);
        if (alphaMatch) {
          const parts = alphaMatch[1].split(",").map((n) => Number(n.trim()));
          bgAlpha = parts.length === 4 ? parts[3] : 1;
        }
      }
      return {
        name,
        missing: false,
        noStage: false,
        srOnly: Boolean(el.closest(".sr-only")),
        replica,
        width: Math.round(r.width),
        height: Math.round(r.height),
        stageWidth: Math.round(s.width),
        stageHeight: Math.round(s.height),
        pastRight: Math.round(r.right - s.right),
        pastBottom: Math.round(r.bottom - s.bottom),
        pastLeft: Math.round(s.left - r.left),
        pastTop: Math.round(s.top - r.top),
        visibleFraction,
        unoccludedFraction,
        bgAlpha,
        want: want[name] ?? 0,
      };
    });
  }, expected);
  for (const row of rows) {
    if (row.missing) throw new Error(`${where}: ${row.name} 없음`);
    if (row.noStage) {
      throw new Error(`${where}: ${row.name} 이 [data-gallery-stage] 밖에 있다`);
    }
    if (row.srOnly) throw new Error(`${where}: ${row.name} 이 sr-only`);
    if (row.width * row.height <= 0) {
      throw new Error(`${where}: ${row.name} 면적 0`);
    }
    if (row.visibleFraction < 0.9) {
      throw new Error(
        `${where}: ${row.name} 무대 가시 면적 ${row.visibleFraction.toFixed(3)} < 0.9 (past t${row.pastTop} r${row.pastRight} b${row.pastBottom} l${row.pastLeft})`
      );
    }
    if (row.pastRight > 1 || row.pastBottom > 1 || row.pastLeft > 1 || row.pastTop > 1) {
      throw new Error(
        `${where}: ${row.name} 이 무대를 넘어 잘린다 (pastTop ${row.pastTop} pastRight ${row.pastRight} pastBottom ${row.pastBottom} pastLeft ${row.pastLeft}, 폭 ${row.width}/${row.stageWidth})`
      );
    }
    if (row.replica) {
      if (row.unoccludedFraction < 0.15) {
        throw new Error(
          `${where}: ${row.name} 가림 없는 가시 면적 ${row.unoccludedFraction.toFixed(3)} < 0.15 (판이 스크림을 가림)`
        );
      }
      if (row.bgAlpha <= 0) {
        throw new Error(`${where}: ${row.name} 배경이 투명해서 스크림이 안 보인다`);
      }
    }
    if (row.want && Math.abs(row.width - row.want) > 4 && row.width < row.want - 4) {
      throw new Error(
        `${where}: ${row.name} 폭 ${row.width}px ≠ 제품 ${row.want}px`
      );
    }
    const extra = row.replica
      ? ` unoccluded ${row.unoccludedFraction.toFixed(3)}`
      : "";
    console.log(
      `  overlay ${where} ${row.name}: ${row.width}×${row.height} stage ${row.stageWidth}×${row.stageHeight} vis ${row.visibleFraction.toFixed(3)} want ${row.want || "-"}${extra}`
    );
  }
}

async function wheelGalleryTo(page, gallery, targetTop) {
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
  if (targetTop <= 0) return 0;
  const box = await gallery.boundingBox();
  if (!box) throw new Error("design-gallery bounding box missing");
  await page.mouse.move(
    Math.floor(box.x + box.width / 2),
    Math.floor(box.y + Math.min(360, box.height / 2))
  );
  let current = 0;
  for (let i = 0; i < 48; i += 1) {
    const remaining = targetTop - current;
    if (remaining <= 16) break;
    await page.mouse.wheel(0, Math.min(400, remaining));
    await page.waitForTimeout(40);
    const next = await gallery.evaluate((el) => el.scrollTop);
    if (next <= current) break;
    current = next;
  }
  if (targetTop > 80 && current < targetTop * 0.5) {
    throw new Error(
      `휠로 ${targetTop} 근처까지 못 감 (landed ${current})`
    );
  }
  return current;
}

async function assertOverlayVisibleInStageAtScroll(page, where) {
  const gallery = page.getByTestId("design-gallery");
  const max = await gallery.evaluate((el) => el.scrollHeight - el.clientHeight);
  const offsets = [...new Set([0, 400, 1200, 2000, 2400, 2800, max].filter((v) => v >= 0 && v <= max))].sort(
    (a, b) => a - b
  );
  const names = [
    "DialogContent",
    "DropdownMenuContent",
    "PopoverContent",
    "ContextMenuContent",
  ];
  for (const top of offsets) {
    const landed = await wheelGalleryTo(page, gallery, top);
    const rows = await page.evaluate((exportNames) => {
      return exportNames.map((name) => {
        const el = document.querySelector(`[data-gallery-export="${name}"]`);
        if (!el) return { name, missing: true };
        const r = el.getBoundingClientRect();
        const stage = el.closest("[data-gallery-stage]");
        if (!stage) return { name, missing: false, noStage: true };
        const s = stage.getBoundingClientRect();
        const overlapW = Math.max(
          0,
          Math.min(r.right, s.right) - Math.max(r.left, s.left)
        );
        const overlapH = Math.max(
          0,
          Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top)
        );
        const area = r.width * r.height;
        const visibleFraction = area > 0 ? (overlapW * overlapH) / area : 0;
        return { name, missing: false, noStage: false, visibleFraction };
      });
    }, names);
    for (const row of rows) {
      if (row.missing) throw new Error(`${where} wheel ${landed}: ${row.name} 없음`);
      if (row.noStage) {
        throw new Error(
          `${where} wheel ${landed}: ${row.name} 이 [data-gallery-stage] 밖에 있다`
        );
      }
      if (row.visibleFraction < 0.9) {
        throw new Error(
          `${where} wheel ${landed}: ${row.name} 무대 가시 면적 ${row.visibleFraction.toFixed(3)} < 0.9`
        );
      }
    }
    console.log(
      `  overlay-scroll ${where} wheel ${landed} (want ${top}): ${rows
        .map((row) => `${row.name} vis ${row.visibleFraction.toFixed(3)}`)
        .join(" | ")}`
    );
  }
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
}

async function assertGalleryScrollOwnership(page, where) {
  const m = await page.evaluate(() => {
    const g = document.querySelector("[data-testid=design-gallery]");
    const doc = document.documentElement;
    if (!g) return { missing: true };
    return {
      missing: false,
      overflowY: getComputedStyle(g).overflowY,
      gScroll: g.scrollHeight,
      gClient: g.clientHeight,
      vh: window.innerHeight,
      docScroll: doc.scrollHeight,
      docClient: doc.clientHeight,
    };
  });
  if (m.missing) throw new Error(`${where}: 갤러리 루트 없음`);
  if (m.gScroll > m.vh + 1) {
    if (m.overflowY !== "auto" && m.overflowY !== "scroll") {
      throw new Error(
        `${where}: 갤러리 내용 ${m.gScroll}px > 뷰포트 ${m.vh}px 인데 overflow-y=${m.overflowY}`
      );
    }
    if (m.gClient > m.vh + 1) {
      throw new Error(
        `${where}: 갤러리 루트 clientHeight ${m.gClient} > 뷰포트 ${m.vh} — 스크롤 소유가 아니다`
      );
    }
  }
  if (m.docScroll > m.docClient + 1) {
    throw new Error(
      `${where}: 문서 스크롤러 ${m.docScroll}px > ${m.docClient}px`
    );
  }
  console.log(
    `  scroll-own ${where}: gallery ${m.gClient}/${m.gScroll} overflow-y=${m.overflowY} doc ${m.docClient}/${m.docScroll}`
  );
}

async function pngRgba(page, pngBuffer) {
  const b64 = Buffer.isBuffer(pngBuffer)
    ? pngBuffer.toString("base64")
    : readFileSync(pngBuffer).toString("base64");
  return page.evaluate(async (b64) => {
    const blob = await fetch(`data:image/png;base64,${b64}`).then((r) => r.blob());
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width;
    canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const { data, width, height } = ctx.getImageData(
      0,
      0,
      canvas.width,
      canvas.height
    );
    return { data: Array.from(data), width, height };
  }, b64);
}

function linearizeChannel(c) {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

function oklabOfRgb(r, g, b) {
  const lr = linearizeChannel(r);
  const lg = linearizeChannel(g);
  const lb = linearizeChannel(b);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

function rgbDeltaE(r1, g1, b1, r2, g2, b2) {
  const a = oklabOfRgb(r1, g1, b1);
  const b = oklabOfRgb(r2, g2, b2);
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** Pixels below this OKLab dE count as the same colour (N-2). */
const PIXEL_DE_MIN = 0.01;

function pixelDiffRatio(a, b) {
  if (a.data.length !== b.data.length) return 1;
  let changed = 0;
  const pixels = a.data.length / 4;
  for (let i = 0; i < a.data.length; i += 4) {
    const dE = rgbDeltaE(
      a.data[i],
      a.data[i + 1],
      a.data[i + 2],
      b.data[i],
      b.data[i + 1],
      b.data[i + 2]
    );
    if (dE >= PIXEL_DE_MIN || a.data[i + 3] !== b.data[i + 3]) {
      changed += 1;
    }
  }
  return changed / pixels;
}

async function assertTripletFramesDiffer(page, hoverPath, activePath, label) {
  const hover = await pngRgba(page, hoverPath);
  const active = await pngRgba(page, activePath);
  const ratio = pixelDiffRatio(hover, active);
  const min = 0.01;
  if (ratio < min) {
    throw new Error(
      `${label}: hover vs active differ by ${(ratio * 100).toFixed(2)}% of ${hover.data.length / 4}px (need ≥ 1%)`
    );
  }
  console.log(
    `  ${label}: hover≠active ${(ratio * 100).toFixed(1)}% of ${hover.data.length / 4}px`
  );
}

async function sampleRgb(page, x, y) {
  const buf = await page.screenshot({
    clip: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), width: 1, height: 1 },
    animations: "allow",
    caret: "hide",
  });
  const rgba = await pngRgba(page, buf);
  return [rgba.data[0], rgba.data[1], rgba.data[2]];
}

function rgbEq(a, b) {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function rgbNear(a, b) {
  return rgbEq(a, b) || rgbDeltaE(a[0], a[1], a[2], b[0], b[1], b[2]) < PIXEL_DE_MIN;
}

function cornerInteriorPoints(box) {
  // 2px in along both axes is the leak pixel (R3: sabotaged tl+2 = fill,
  // shipped tl+2 = page bg). [1,1] is the short diagonal. Off-diagonal
  // [2,1]/[1,2] sit on the 1px border and read as AA, not page bg.
  const insets = [
    [2, 2],
    [1, 1],
  ];
  const origins = [
    [box.x, box.y, 1, 1],
    [box.x + box.width - 1, box.y, -1, 1],
    [box.x, box.y + box.height - 1, 1, -1],
    [box.x + box.width - 1, box.y + box.height - 1, -1, -1],
  ];
  const points = [];
  for (const [ox, oy, sx, sy] of origins) {
    for (const [dx, dy] of insets) {
      points.push([Math.round(ox + sx * dx), Math.round(oy + sy * dy)]);
    }
  }
  return points;
}

async function assertSummaryHoverCorners(page, scheme) {
  const figure = page.getByTestId("press-triplet-summary-card");
  await figure.waitFor({ state: "attached" });
  await figure.scrollIntoViewIfNeeded();
  const summary = figure.locator("summary");
  await summary.hover();
  await waitForAnimations(page);
  const details = figure.locator("details");
  const box = await details.boundingBox();
  const fig = await figure.boundingBox();
  if (!box || !fig) {
    throw new Error(`summary-card ${scheme}: bounding box missing`);
  }
  const pad = await sampleRgb(page, fig.x + 2, fig.y + 2);
  const fill = await sampleRgb(
    page,
    box.x + box.width / 2,
    box.y + Math.min(12, box.height / 2)
  );
  if (rgbEq(pad, fill)) {
    throw new Error(
      `summary-card ${scheme}: hover fill ${fill} equals page bg — hover did not paint`
    );
  }
  const points = cornerInteriorPoints(box);
  for (const [x, y] of points) {
    const rgb = await sampleRgb(page, x, y);
    if (rgbNear(rgb, fill) && !rgbNear(rgb, pad)) {
      throw new Error(
        `summary-card ${scheme}: interior corner (${x.toFixed(1)},${y.toFixed(1)}) is hover fill ${fill}, not page bg ${pad}`
      );
    }
    if (!rgbNear(rgb, pad)) {
      throw new Error(
        `summary-card ${scheme}: interior corner (${x.toFixed(1)},${y.toFixed(1)}) ${rgb} ≠ page bg ${pad}`
      );
    }
  }
  console.log(
    `  summary-card ${scheme}: ${points.length} interior-corner samples = page bg, not hover fill`
  );
}

const WIDE_MIN_PX = 480;
const WIDE_MIN_FRAC = 0.5;
const MOTION_ENTER_RE =
  /(?:^|\s)(?:[\w:[\]%=.-]*:)?motion-(?:fast-|modal-)?enter(?:-zoom)?(?:\s|$)|(?:^|\s)(?:[\w:[\]%=.-]*:)?motion-slide-in-end(?:\s|$)/;
const NAMED_PRESS_RE = /(?:^|\s)(?:press|scrim-press|press-instant-fill)(?:\s|$)/;

/**
 * R12: after a `motion-*-enter` animation finishes, named press must still
 * paint. Fill-`both` on the same node pins the `to` keyframe and hides
 * `:active` (B-1: scrim-press opacity stayed 1). Restore `both` → 1 → red.
 */
async function assertEnterMotionPressAfterFill(page, label, opts = {}) {
  const requireScrim = opts.requireScrim === true;
  await waitForAnimations(page);
  const { candidates } = await page.evaluate((enterSource) => {
    const enterRe = new RegExp(enterSource);
    const sel = [
      "a",
      "button",
      "summary",
      '[role="button"]',
      '[role="link"]',
      '[role="option"]',
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="tab"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="radio"]',
      '[role="treeitem"]',
    ].join(",");
    const out = [];
    let i = 0;
    for (const el of document.querySelectorAll(sel)) {
      if (!(el instanceof HTMLElement)) continue;
      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        continue;
      }
      if (el instanceof HTMLSelectElement) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden") continue;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cls = el.className && typeof el.className === "string" ? el.className : "";
      if (!enterRe.test(cls)) continue;
      const mark = `press-enter-${i}`;
      i += 1;
      el.setAttribute("data-press-enter", mark);
      out.push({
        mark,
        tag: el.tagName,
        testId: el.getAttribute("data-testid") || "",
        className: cls,
      });
    }
    return { candidates: out };
  }, MOTION_ENTER_RE.source);

  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument", { depth: 0 });
  const failures = [];
  const reports = [];
  for (const c of candidates) {
    const loc = page.locator(`[data-press-enter="${c.mark}"]`);
    await loc.evaluate(async (el) => {
      await Promise.all(
        el.getAnimations().map((animation) =>
          animation.playState === "finished"
            ? Promise.resolve()
            : animation.finished.catch(() => undefined)
        )
      );
    });
    const rest = await loc.evaluate((el) => {
      const s = getComputedStyle(el);
      return { opacity: s.opacity, transform: s.transform, background: s.backgroundColor };
    });
    const found = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-press-enter="${c.mark}"]`,
    });
    if (!found.nodeId) continue;
    await session.send("CSS.forcePseudoState", {
      nodeId: found.nodeId,
      forcedPseudoClasses: ["active"],
    });
    await page.waitForTimeout(160);
    const active = await loc.evaluate((el) => {
      const s = getComputedStyle(el);
      return {
        opacity: Number.parseFloat(s.opacity),
        opacityRaw: s.opacity,
        transform: s.transform,
        background: s.backgroundColor,
        fillMode: s.animationFillMode,
      };
    });
    await session.send("CSS.forcePseudoState", {
      nodeId: found.nodeId,
      forcedPseudoClasses: [],
    });
    reports.push(
      `<${c.tag}> ${c.testId || c.mark} :active opacity=${active.opacityRaw} fill=${active.fillMode}`
    );
    const namedPress = NAMED_PRESS_RE.test(c.className);
    if (/\bscrim-press\b/.test(c.className)) {
      if (Math.abs(active.opacity - 0.92) > 0.02) {
        failures.push(
          `${c.testId || c.mark} scrim-press :active opacity=${active.opacity} fill=${active.fillMode} (want ≈0.92 after enter finished)`
        );
      }
    } else if (namedPress) {
      const opacityMoved = rest.opacity !== active.opacityRaw;
      const transformMoved = rest.transform !== active.transform;
      const fillMoved = rest.background !== active.background;
      if (!opacityMoved && !transformMoved && !fillMoved) {
        failures.push(
          `${c.testId || c.mark} carries motion-*-enter + named press but :active after enter equals rest (opacity=${active.opacityRaw} transform=${active.transform})`
        );
      }
    }
  }
  await page.evaluate(() => {
    document.querySelectorAll("[data-press-enter]").forEach((el) => {
      el.removeAttribute("data-press-enter");
    });
  });
  const scrimVisible = await page
    .locator('[data-testid="sidebar-scrim"]')
    .isVisible()
    .catch(() => false);
  if (requireScrim || scrimVisible) {
    const measured = candidates.some((c) => c.testId === "sidebar-scrim");
    if (!measured) {
      throw new Error(`enter-press ${label}: sidebar-scrim visible but not measured`);
    }
  }
  console.log(
    `  enter-press ${label}: n=${candidates.length}${reports.length ? ` ${reports.join("; ")}` : ""}`
  );
  if (failures.length > 0) {
    throw new Error(`enter-press ${label}: ${failures.join("; ")}`);
  }
}

/**
 * H5-1 / M6-1: full-width is a measured width. Walk the whole interactive
 * population on the shipped page; for those ≥ 480px or ≥ 50% of `main`,
 * `:active` transform must be none. Prints visited count and the widest
 * offenders (even when green). FeedRow at 1040px goes red with `.press`.
 */
async function assertWideRowsFillOnly(page, label) {
  const { visited, candidates } = await page.evaluate(
    ({ WIDE_MIN_PX: minPx, WIDE_MIN_FRAC: minFrac }) => {
      const main = document.querySelector("main") || document.body;
      const column = main.getBoundingClientRect().width;
      const sel = [
        "a",
        "button",
        "summary",
        '[role="button"]',
        '[role="link"]',
        '[role="option"]',
        '[role="menuitem"]',
        '[role="menuitemcheckbox"]',
        '[role="menuitemradio"]',
        '[role="tab"]',
        '[role="checkbox"]',
        '[role="switch"]',
        '[role="radio"]',
        '[role="treeitem"]',
      ].join(",");
      const out = [];
      let visited = 0;
      let i = 0;
      for (const el of document.querySelectorAll(sel)) {
        if (!(el instanceof HTMLElement)) continue;
        if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
          continue;
        }
        if (el instanceof HTMLSelectElement) continue;
        if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const st = getComputedStyle(el);
        if (st.display === "none" || st.visibility === "hidden" || st.pointerEvents === "none") {
          continue;
        }
        if (st.cursor === "not-allowed" || st.cursor === "wait") continue;
        const r = el.getBoundingClientRect();
        if (r.width < 2 || r.height < 2) continue;
        visited += 1;
        const wide = r.width >= minPx || r.width >= minFrac * column;
        if (!wide) continue;
        const mark = `press-wide-${i}`;
        i += 1;
        el.setAttribute("data-press-wide", mark);
        out.push({
          mark,
          tag: el.tagName,
          testId: el.getAttribute("data-testid") || "",
          width: Math.round(r.width * 100) / 100,
          column: Math.round(column * 100) / 100,
          text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 48),
        });
      }
      return { visited, candidates: out };
    },
    { WIDE_MIN_PX, WIDE_MIN_FRAC }
  );

  const session = await page.context().newCDPSession(page);
  await session.send("DOM.enable");
  await session.send("CSS.enable");
  const { root } = await session.send("DOM.getDocument", { depth: 0 });
  const failures = [];
  for (const c of candidates) {
    const found = await session.send("DOM.querySelector", {
      nodeId: root.nodeId,
      selector: `[data-press-wide="${c.mark}"]`,
    });
    if (!found.nodeId) continue;
    await session.send("CSS.forcePseudoState", {
      nodeId: found.nodeId,
      forcedPseudoClasses: ["active"],
    });
    const transform = await page
      .locator(`[data-press-wide="${c.mark}"]`)
      .evaluate((el) => getComputedStyle(el).transform);
    await session.send("CSS.forcePseudoState", {
      nodeId: found.nodeId,
      forcedPseudoClasses: [],
    });
    const none =
      transform === "none" || transform === "matrix(1, 0, 0, 1, 0, 0)";
    if (!none) {
      failures.push(
        `<${c.tag}> ${c.testId || c.text} width=${c.width} column=${c.column} transform=${transform}`
      );
    }
  }
  await page.evaluate(() => {
    document.querySelectorAll("[data-press-wide]").forEach((el) => {
      el.removeAttribute("data-press-wide");
    });
  });
  const widest = [...candidates]
    .sort((a, b) => b.width - a.width)
    .slice(0, 5)
    .map((c) => `<${c.tag}> ${c.testId || c.text} width=${c.width}`)
    .join("; ");
  console.log(
    `  wide fill-only ${label}: visited=${visited} wide=${candidates.length} ≥ ${WIDE_MIN_PX}px or ≥ ${WIDE_MIN_FRAC}·column; widest: ${widest || "(none)"}`
  );
  if (failures.length > 0) {
    throw new Error(
      `wide press ${label}: expected transform none on :active, got ${failures.join("; ")}`
    );
  }
  await assertEnterMotionPressAfterFill(page, label);
}

async function parkPointerOffViewport(page) {
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.mouse.move(vp.width + 80, vp.height + 80);
  await page.evaluate(() => {
    document.dispatchEvent(new MouseEvent("mouseleave", { bubbles: true }));
  });
  await waitForAnimations(page);
}

function parseCssRgb(css) {
  const m = String(css).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

async function assertNotificationsDndRest(page, scheme) {
  const row = page
    .getByTestId("notification-rules-dnd")
    .locator("xpath=ancestor::label[1]");
  await row.waitFor({ state: "visible" });
  const { bg, hover, surface } = await row.evaluate((el) => {
    const probe = document.createElement("div");
    probe.className = "bg-surface-hover";
    document.body.appendChild(probe);
    const hoverColor = getComputedStyle(probe).backgroundColor;
    probe.className = "bg-surface";
    const surfaceColor = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return {
      bg: getComputedStyle(el).backgroundColor,
      hover: hoverColor,
      surface: surfaceColor,
    };
  });
  if (bg === hover) {
    throw new Error(
      `settings-notifications ${scheme}: DND row still hover fill ${bg}`
    );
  }
  const box = await row.boundingBox();
  if (!box) {
    throw new Error(`settings-notifications ${scheme}: DND row box missing`);
  }
  const px = await sampleRgb(page, box.x + 16, box.y + box.height / 2);
  const surfaceRgb = parseCssRgb(surface);
  if (!surfaceRgb || !rgbNear(px, surfaceRgb)) {
    throw new Error(
      `settings-notifications ${scheme}: DND row rest pixels ${px} ≠ page surface ${surface} (computed ${bg})`
    );
  }
  console.log(
    `  settings-notifications ${scheme}: DND row rest ${bg} ≠ hover ${hover}; pixels ${px} = surface ${surface}`
  );
}

async function assertInstantFillSwatch(page, scheme) {
  const btn = page.getByTestId("press-instant-fill-swatch");
  await btn.waitFor({ state: "visible" });
  await btn.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await waitForAnimations(page);
  const restCss = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  await btn.hover();
  await waitForAnimations(page);
  const hoverCss = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  const box = await btn.boundingBox();
  if (!box) {
    throw new Error(`press-instant-fill swatch ${scheme}: bounding box missing`);
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await waitForAnimations(page);
  const activeCss = await btn.evaluate((el) => getComputedStyle(el).backgroundColor);
  await page.mouse.up();
  const rest = parseCssRgb(restCss);
  const hover = parseCssRgb(hoverCss);
  const active = parseCssRgb(activeCss);
  if (!rest || !hover || !active) {
    throw new Error(
      `press-instant-fill swatch ${scheme}: unparsed rest=${restCss} hover=${hoverCss} active=${activeCss}`
    );
  }
  const dE = (a, b) => rgbDeltaE(a[0], a[1], a[2], b[0], b[1], b[2]);
  const restHover = dE(rest, hover);
  const restActive = dE(rest, active);
  const hoverActive = dE(hover, active);
  if (restHover < PIXEL_DE_MIN || restActive < PIXEL_DE_MIN || hoverActive < PIXEL_DE_MIN) {
    throw new Error(
      `press-instant-fill swatch ${scheme}: rest=${restCss} hover=${hoverCss} active=${activeCss} dE rest-hover=${restHover.toFixed(4)} rest-active=${restActive.toFixed(4)} hover-active=${hoverActive.toFixed(4)} (need ≥ ${PIXEL_DE_MIN})`
    );
  }
  console.log(
    `  press-instant-fill swatch ${scheme}: rest ${restCss} hover ${hoverCss} active ${activeCss} dE ${restHover.toFixed(3)}/${restActive.toFixed(3)}/${hoverActive.toFixed(3)}`
  );
}

async function assertToggleRowTarget(page, scheme) {
  const frame = page.getByTestId("press-triplet-settings-row");
  await frame.scrollIntoViewIfNeeded();
  const checkbox = frame.getByTestId("press-triplet-settings-toggle");
  const host = checkbox.locator("xpath=..");
  const tag = await host.evaluate((el) => el.tagName);
  if (tag !== "LABEL") {
    throw new Error(
      `settings-row ${scheme}: click target is <${tag}>, not LABEL`
    );
  }
  const hostBox = await host.boundingBox();
  const labelBox = await frame.locator("label").boundingBox();
  if (!hostBox || !labelBox) {
    throw new Error(`settings-row ${scheme}: bounding box missing`);
  }
  const deadRight = hostBox.x + hostBox.width - (labelBox.x + labelBox.width);
  if (deadRight > 2) {
    throw new Error(
      `settings-row ${scheme}: fill covers ${deadRight.toFixed(1)}px that are not a click target`
    );
  }
  const hit = await page.evaluate(
    ({ x, y }) => {
      const node = document.elementFromPoint(x, y);
      const label = node?.closest("label");
      return label ? "LABEL" : (node?.tagName ?? "NONE");
    },
    { x: hostBox.x + hostBox.width - 8, y: hostBox.y + hostBox.height / 2 }
  );
  if (hit !== "LABEL") {
    throw new Error(
      `settings-row ${scheme}: right-8 hit <${hit}>, not LABEL`
    );
  }
  console.log(`  settings-row ${scheme}: label fills the row, right-8 is the target`);
}

const PRESS_TRIPLET_GALLERY = [
  "button-default",
  "button-secondary",
  "button-ghost",
  "button-destructive",
  "chip",
  "row",
];

const PRESS_TRIPLET_INSITU = [
  "message-row",
  "pending-row",
  "settings-row",
  "settings-row-checked",
  "drafts-li",
];

const PRESS_TRIPLET_SURFACES = [
  ...PRESS_TRIPLET_GALLERY,
  ...PRESS_TRIPLET_INSITU,
];

function pressTripletTarget(page, surface) {
  const frame = page.getByTestId(`press-triplet-${surface}`);
  if (surface === "row") return frame.locator("[data-sidebar-row]");
  if (surface === "chip") return frame.getByTestId("reaction-chip");
  if (surface === "message-row") return frame.getByTestId("timeline-message");
  if (surface === "pending-row") return frame.getByTestId("timeline-pending");
  if (surface === "settings-row" || surface === "settings-row-checked") {
    const toggleId =
      surface === "settings-row-checked"
        ? "press-triplet-settings-toggle-checked"
        : "press-triplet-settings-toggle";
    return frame.getByTestId(toggleId).locator("..");
  }
  if (surface === "drafts-li") {
    return frame.getByTestId("draft-row").locator("a").first();
  }
  return frame.locator("button").first();
}

/**
 * ADR-0179 D10 ④ / UX-R1e: gallery primitives + in-situ surfaces ×
 * rest/hover/active × two schemes. 390 covers in-situ + sidebar row in
 * both schemes. hover = Playwright hover(); active = mouse.down() held. Motion stays on
 * (reducedMotion no-preference) so waitForAnimations is load-bearing —
 * screenshot animations are allowed, not fast-forwarded.
 */
async function capturePressTriplet(
  browser,
  scheme,
  {
    viewport = VIEWPORT,
    suffix = "",
    surfaces = PRESS_TRIPLET_SURFACES,
  } = {}
) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "no-preference",
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/#/design`, { waitUntil: "networkidle" });
  await page.getByTestId("design-gallery").waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await waitForAnimations(page);

  if (suffix === "") {
    await assertSummaryHoverCorners(page, scheme);
    await assertToggleRowTarget(page, scheme);
  }

  const paths = [];
  for (const surface of surfaces) {
    const frame = page.getByTestId(`press-triplet-${surface}`);
    await frame.scrollIntoViewIfNeeded();
    const target = pressTripletTarget(page, surface);
    await target.waitFor({ state: "visible" });

    await page.mouse.move(0, 0);
    await waitForAnimations(page);
    const restPath = `${OUT_DIR}/press-triplet-${surface}-rest-${scheme}${suffix}.png`;
    await frame.screenshot({
      path: restPath,
      animations: "allow",
      caret: "hide",
    });
    paths.push(restPath);

    await target.hover();
    await waitForAnimations(page);
    const hoverPath = `${OUT_DIR}/press-triplet-${surface}-hover-${scheme}${suffix}.png`;
    await frame.screenshot({
      path: hoverPath,
      animations: "allow",
      caret: "hide",
    });
    paths.push(hoverPath);

    const box = await target.boundingBox();
    if (!box) {
      throw new Error(
        `press-triplet ${surface} ${scheme}: bounding box missing`
      );
    }
    let hoverBg = null;
    if (surface === "message-row" || surface === "pending-row") {
      hoverBg = await target.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      );
    }
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await waitForAnimations(page);
    if (hoverBg !== null) {
      const activeBg = await target.evaluate(
        (el) => getComputedStyle(el).backgroundColor
      );
      if (hoverBg === activeBg) {
        throw new Error(
          `press-triplet ${surface} ${scheme}: hover bg ${hoverBg} equals active (pressed fill vanished)`
        );
      }
    }
    const activePath = `${OUT_DIR}/press-triplet-${surface}-active-${scheme}${suffix}.png`;
    await frame.screenshot({
      path: activePath,
      animations: "allow",
      caret: "hide",
    });
    paths.push(activePath);
    await assertTripletFramesDiffer(
      page,
      hoverPath,
      activePath,
      `press-triplet ${surface} ${scheme}${suffix}`
    );
    await page.mouse.up();
    await page.mouse.move(0, 0);
    await waitForAnimations(page);
  }

  await page.close();
  await context.close();
  commitPressTripletCatalog();
  return paths;
}

async function captureDesignGallery(browser, scheme) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 2,
    colorScheme: scheme,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/#/design`, { waitUntil: "networkidle" });
  const gallery = page.getByTestId("design-gallery");
  await gallery.waitFor({ state: "visible" });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(50);

  await assertGalleryLoadFocus(page, `design-gallery ${scheme}`);
  await assertInstantFillSwatch(page, scheme);
  await page.mouse.move(0, 0);
  await gallery.evaluate((el) => {
    el.scrollTop = 0;
  });
  await assertGalleryScrollOwnership(page, `design-gallery ${scheme}`);
  await assertGalleryUsable(page, `design-gallery ${scheme}`);
  await assertNoHorizontalOverflow(page, `design-gallery ${scheme} 1280`);
  await assertOverlayProductGeometry(page, `design-gallery ${scheme} 1280`);
  await assertOverlayVisibleInStageAtScroll(page, `design-gallery ${scheme} 1280`);

  await page.setViewportSize({ width: 900, height: VIEWPORT.height });
  await assertNoHorizontalOverflow(page, `design-gallery ${scheme} 900`);
  await assertOverlayProductGeometry(page, `design-gallery ${scheme} 900`);
  await page.setViewportSize(VIEWPORT);
  await releaseGallerySelection(page);

  const contentHeight = await page.evaluate(() => {
    const node = document.querySelector("[data-testid=design-gallery]");
    return node ? Math.ceil(node.scrollHeight) : 0;
  });
  await page.setViewportSize({
    width: VIEWPORT.width,
    height: Math.max(VIEWPORT.height, contentHeight),
  });
  const path = `${OUT_DIR}/design-gallery-${scheme}.png`;
  await page.screenshot({
    path,
    fullPage: false,
    animations: "disabled",
    caret: "hide",
  });
  await page.setViewportSize(VIEWPORT);
  await page.close();
  await context.close();
  return [path];
}

function wipePressTripletEvidence() {
  if (!existsSync(OUT_DIR)) return;
  for (const name of readdirSync(OUT_DIR)) {
    if (/^press-triplet/.test(name)) {
      unlinkSync(resolve(OUT_DIR, name));
    }
  }
}

let pressTripletCatalogCommitted = false;

function commitPressTripletCatalog() {
  writePressTripletCatalog();
  pressTripletCatalogCommitted = true;
}

function appendPressTripletAbort(cause) {
  const catalog = resolve(OUT_DIR, "press-triplet-catalog.txt");
  const line = `# abort-after-triplet ${cause.replace(/\s+/g, " ").trim()}\n`;
  if (existsSync(catalog)) appendFileSync(catalog, line);
  else writeFileSync(catalog, line);
}

/** Aborted run must not leave a *partial* triplet set; a finished set stays (#2000 N4-5). */
function recordPressTripletAbort(err) {
  const cause = err instanceof Error ? err.message : String(err);
  if (pressTripletCatalogCommitted) {
    console.error(
      `CAPTURE ABORT: keeping completed press-triplet outputs and catalog. cause: ${cause}`
    );
    if (/intro|scroll|timeout|waiting for locator/i.test(cause)) {
      console.error(
        "CAPTURE ABORT NOTES: pre-existing intro-scroll flake (#2057 N-4)."
      );
    }
    appendPressTripletAbort(cause);
    return;
  }
  console.error(
    `CAPTURE ABORT: wiping press-triplet outputs and catalog. cause: ${cause}`
  );
  if (/intro|scroll|timeout|waiting for locator/i.test(cause)) {
    console.error(
      "CAPTURE ABORT NOTES: pre-existing intro-scroll flake (#2057 N-4)."
    );
  }
  wipePressTripletEvidence();
}

function writePressTripletCatalog() {
  if (!existsSync(OUT_DIR)) return;
  const names = readdirSync(OUT_DIR)
    .filter((name) => /^press-triplet-.*\.png$/.test(name))
    .sort();
  const lines = names.map((name) => {
    const sha = createHash("sha256")
      .update(readFileSync(resolve(OUT_DIR, name)))
      .digest("hex");
    return `${sha}  ${name}`;
  });
  writeFileSync(
    resolve(OUT_DIR, "press-triplet-catalog.txt"),
    `${lines.join("\n")}\n`
  );
}

async function main() {
  if (!existsSync(resolve(WEB_ROOT, "dist/index.html"))) {
    throw new Error("dist/ is missing. Run `npm run capture:design`.");
  }
  mkdirSync(OUT_DIR, { recursive: true });
  wipePressTripletEvidence();

  const preview = await startGuardedPreview({
    webRoot: WEB_ROOT,
    port: PORT,
    portEnvVar: "CAPTURE_PORT",
  });
  let previewDeath = null;
  preview.child.on("exit", (code, signal) => {
    previewDeath = new Error(
      `CAPTURE FAIL: this lane's vite preview died mid-run ` +
        `(exit ${code}, signal ${signal}). Not retrying and not photographing ` +
        `whoever is now on ${PORT}.`
    );
  });
  const assertThisPreview = () => {
    if (previewDeath) throw previewDeath;
  };

  try {
    const browser = wrapBrowserShotGuard(await chromium.launch());
    await prepareUnfurlPreviewPng(browser);
    try {
      const all = [];
      // 한 프로파일만 돌리는 문 (goal B9). 폰 기하를 고치는 동안 1280 프레임 60여
      // 장을 매번 다시 찍는 것은 측정이 아니라 대기다. `accent`는 시안 10장만.
      // 기본값은 여전히 둘 다이므로 게이트가 보는 것은 달라지지 않는다.
      const profile = process.env.CAPTURE_PROFILE || "all";
      if (profile === "accent") {
        for (const scheme of ["light", "dark"]) {
          assertThisPreview();
          all.push(...(await captureAccentCandidates(browser, scheme)));
        }
      } else if (profile === "gallery") {
        for (const scheme of ["light", "dark"]) {
          assertThisPreview();
          all.push(...(await captureDesignGallery(browser, scheme)));
          all.push(...(await capturePressTriplet(browser, scheme)));
          all.push(
            ...(await capturePressTriplet(browser, scheme, {
              viewport: MOBILE_VIEWPORT,
              suffix: "-390",
              surfaces: [...PRESS_TRIPLET_INSITU, "row"],
            }))
          );
        }
      } else if (profile !== "mobile") {
        for (const scheme of ["light", "dark"]) {
          const shot = async (fn) => {
            assertThisPreview();
            return await fn();
          };
          all.push(...(await shot(() => captureDesignGallery(browser, scheme))));
          all.push(...(await shot(() => capturePressTriplet(browser, scheme))));
          all.push(
            ...(await shot(() =>
              capturePressTriplet(browser, scheme, {
                viewport: MOBILE_VIEWPORT,
                suffix: "-390",
                surfaces: [...PRESS_TRIPLET_INSITU, "row"],
              })
            ))
          );
          all.push(...(await shot(() => captureScheme(browser, scheme))));
          all.push(...(await shot(() => captureSkeletonReveal(browser, scheme))));
          if (scheme === "light") {
            all.push(
              ...(await shot(() =>
                captureSkeletonRevealAt(browser, scheme, MOBILE_VIEWPORT, "-390")
              ))
            );
          }
          all.push(...(await shot(() => captureTerminalDockScenes(browser, scheme))));
          all.push(...(await shot(() => captureMarkUnreadScenes(browser, scheme))));
          all.push(...(await shot(() => captureWelcomeKickoffScenes(browser, scheme))));
          all.push(...(await shot(() => captureSettingsWelcomeScenes(browser, scheme))));
          all.push(...(await shot(() => captureEmptyConversationScenes(browser, scheme))));
          all.push(...(await shot(() => captureNonemptyChannelIntroScenes(browser, scheme))));
          all.push(...(await shot(() => captureAddMemberScenes(browser, scheme))));
          all.push(...(await shot(() => captureSetStatusScenes(browser, scheme))));
          all.push(...(await shot(() => captureSearchScopeScenes(browser, scheme))));
          all.push(...(await shot(() => captureHostedPairingScenes(browser, scheme))));
          all.push(...(await shot(() => captureHostedDisconnectScenes(browser, scheme))));
          all.push(...(await shot(() => captureHostedDoorbellScenes(browser, scheme))));
          all.push(...(await shot(() => captureConsent(browser, scheme))));
          all.push(...(await shot(() => captureAccentCandidates(browser, scheme))));
        }
      }
      // 폰 프로파일 (goal B6). 데스크탑 프레임 뒤에 붙는 이유는 회귀를 읽는
      // 순서 때문이다: 1280 프레임이 먼저 전부 나오고, 그 다음이 390이다.
      if (profile !== "desktop" && profile !== "accent" && profile !== "gallery") {
        for (const scheme of ["light", "dark"]) {
          assertThisPreview();
          all.push(...(await captureMobile(browser, scheme)));
        }
      }
      for (const path of all) console.log(path);
      writePressTripletCatalog();
      reportUnmocked();
    } finally {
      await browser.close();
    }
  } finally {
    await preview.stop();
  }
}

main().catch((err) => {
  try {
    recordPressTripletAbort(err);
  } catch (wipeErr) {
    console.error(wipeErr);
  }
  console.error(err);
  process.exit(1);
});
