#!/usr/bin/env node
// =============================================================================
// oort 마크 C2-04 Bubble — 기하 정본과 SVG 생성 (#2650).
//
//   npm run icons:mark            -> docs/brand/mark/*.svg, public/favicon.svg,
//                                    public/oort-mark.svg 를 다시 쓴다
//   npm run icons:mark -- --check -> 다시 쓰지 않고, 커밋된 파일이 이 기하와
//                                    같은지만 본다(다르면 exit 1)
//
// 마크는 세 조각이다.
//   링     — o. 사람과 팀. 두께는 바깥 반지름의 40%.
//   꼬리   — 링 왼쪽 아래의 말풍선 꼬리. 메신저라는 뜻. 링 윤곽의 일부다.
//   위성   — 오른쪽 위에서 링에 걸친 원. 에이전트. 링과는 틈으로 떨어져 있다.
//
// 위성과 꼬리는 같은 대각선 위에 있다(위성 -45°, 꼬리 135°, y 아래 방향 좌표).
// 탐색본(claudedocs/brand-2.0/round2/C2-04-bubble-mono-light.png)을 재면 위성은
// -41°, 꼬리 끝은 139°로 이미 한 직선 위에 있었다. 그 축을 45°로 반올림해 정수
// 격자에 올렸다.
//
// 틈은 배경색으로 칠하지 않는다. 위성 둘레(반지름 s+g)의 원으로 링 바깥
// 윤곽을 **잘라낸 홈**이다. 그래야 단색판이 어떤 바탕 위에서도 한 색으로
// 성립하고, 인라인 컴포넌트가 mask id 없이 한 path로 끝난다.
//
// 이 파일은 자동 트레이스가 아니다. 입력은 아래 PARAMS의 정수(와 반 단위)뿐이고,
// 교점·접점은 원과 직선의 식으로 계산한다. 결과 좌표만 소수 둘째 자리로 끊는다.
// 수치의 근거와 크기별 판단은 docs/brand/mark/README.md에 있다.
// =============================================================================

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(WEB_ROOT, "..", "..");
const MARK_DIR = resolve(REPO_ROOT, "docs/brand/mark");
const PUBLIC_DIR = resolve(WEB_ROOT, "public");

// ---- 치수 ------------------------------------------------------------------
//
// regular: 64 격자. 앱 아이콘(1024)과 32px 초과 크기의 정본.
// small:   24 격자. 16~32px 광학 보정판. 앱 안 OortMark(size-4·size-6)와
//          탭 파비콘. regular를 24/64로 줄이면 틈이 16px에서 0.5px이 되어
//          사라지므로, 틈·위성·구멍을 키우고 링을 조금 두껍게 했다.
//
// cx,cy  링 중심            R  바깥 반지름     r  구멍 반지름
// sat    위성 중심의 링 중심 기준 오프셋(대각선이라 x=-y)
// s      위성 반지름         g  틈 폭(위성 가장자리 ~ 링 홈)
// tip    꼬리 끝(모서리를 둥글리기 전 꼭짓점)의 링 중심 기준 오프셋
// spread 꼬리 밑변이 바깥 원과 만나는 각의 반폭(도)
// tipR   꼬리 끝 둥글림 반지름   fillet 꼬리와 링이 만나는 오목 모서리 반지름
export const PARAMS = {
  regular: {
    grid: 64,
    cx: 31,
    cy: 33,
    R: 20,
    r: 12,
    sat: 16,
    s: 6,
    g: 2,
    tip: 20,
    spread: 14,
    tipR: 1.5,
    fillet: 1.5,
  },
  small: {
    grid: 24,
    cx: 11,
    cy: 13,
    R: 8,
    r: 4,
    sat: 7,
    s: 3,
    g: 1.5,
    tip: 9,
    spread: 16,
    tipR: 0.75,
    fillet: 0.5,
  },
};

// ---- 색 --------------------------------------------------------------------
// 전부 src/design/tokens.css에 있는 값이다. 팔레트가 바뀌면 여기도 바뀐다.
export const COLORS = {
  ink: "#17161a", // --surface 다크. 단색 검정, 앱 아이콘 바탕
  paper: "#f7f6f3", // --surface 라이트. 앱 아이콘 링(오프화이트)
  white: "#ffffff", // 단색 흰색
  amber: "#f0a850", // --accent 다크. 단색 호박, 앱 아이콘 위성
};

// ---- 기하 ------------------------------------------------------------------

const rad = (deg) => (deg * Math.PI) / 180;
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const cross = (a, b) => a[0] * b[1] - a[1] * b[0];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / len(a));
const angleOf = (c, p) => Math.atan2(p[1] - c[1], p[0] - c[0]);
const polar = (c, radius, a) => [c[0] + radius * Math.cos(a), c[1] + radius * Math.sin(a)];

const fmt = (n) => {
  const v = Math.round(n * 100) / 100;
  return Object.is(v, -0) ? "0" : String(v);
};
const pt = (p) => `${fmt(p[0])} ${fmt(p[1])}`;

/** 두 원의 교점. 반환 순서는 c1에서 본 각이 작은 쪽이 먼저. */
function circleIntersections(c1, r1, c2, r2) {
  const d = len(sub(c2, c1));
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d);
  const h = Math.sqrt(r1 * r1 - a * a);
  const u = unit(sub(c2, c1));
  const base = add(c1, mul(u, a));
  const n = [-u[1], u[0]];
  const p1 = add(base, mul(n, h));
  const p2 = sub(base, mul(n, h));
  return angleOf(c1, p1) < angleOf(c1, p2) ? [p1, p2] : [p2, p1];
}

/**
 * 원(c, R)의 바깥에서 원과 직선(p→q)에 동시에 접하는 오목 모서리 원.
 * away: 꼬리 안쪽에서 멀어지는 법선. 반환: 원 위 접점, 직선 위 접점, 중심.
 */
function concaveFillet(c, R, p, q, away, f) {
  const u = unit(sub(q, p));
  const w = sub(add(p, mul(away, f)), c);
  const b = dot(w, u);
  const k = dot(w, w) - (R + f) * (R + f);
  const t = -b + Math.sqrt(b * b - k); // 꼭짓점 쪽 근
  const center = add(add(p, mul(away, f)), mul(u, t));
  const onCircle = add(c, mul(unit(sub(center, c)), R));
  const onLine = sub(center, mul(away, f));
  return { onCircle, onLine, center };
}

/** 작은 호 한 토막. 방향은 외적 부호로 정한다(SVG sweep=1은 각이 커지는 쪽). */
function arcTo(center, radius, from, to) {
  const sweep = cross(sub(from, center), sub(to, center)) > 0 ? 1 : 0;
  return `A${fmt(radius)} ${fmt(radius)} 0 0 ${sweep} ${pt(to)}`;
}

/** 원(c, R) 위에서 각이 커지는 방향으로 from→to. */
function circleArcForward(c, R, from, to) {
  let span = angleOf(c, to) - angleOf(c, from);
  while (span < 0) span += 2 * Math.PI;
  const large = span > Math.PI ? 1 : 0;
  return `A${fmt(R)} ${fmt(R)} 0 ${large} 1 ${pt(to)}`;
}

/** 마크 한 벌의 기하. 링(꼬리·홈 포함) path, 위성 path, 치수 표. */
export function buildMark(p) {
  const C = [p.cx, p.cy];
  const S = [p.cx + p.sat, p.cy - p.sat];
  const T = [p.cx - p.tip, p.cy + p.tip];
  const knock = p.s + p.g;
  const satDist = len(sub(S, C));
  if (satDist - knock <= p.r) throw new Error("홈이 구멍까지 닿는다");

  // 홈: 바깥 원과 틈 원의 두 교점. qa는 반시계 쪽, qb는 시계 쪽.
  const [qa, qb] = circleIntersections(C, p.R, S, knock);

  // 꼬리: 135° 축에서 ±spread 벌어진 두 점과 꼭짓점 T.
  const axis = rad(135);
  const b1 = polar(C, p.R, axis - rad(p.spread)); // 아래쪽(각이 작은 쪽)
  const b2 = polar(C, p.R, axis + rad(p.spread)); // 왼쪽
  const inside = unit(sub(T, C)); // 꼬리 안쪽을 가리키는 축 방향
  const normalAway = (a, b) => {
    const u = unit(sub(b, a));
    const n = [-u[1], u[0]];
    // 축 반대편 법선: 꼭짓점에서 축 쪽으로 향하는 성분이 음수가 되게
    const mid = add(C, mul(inside, (p.R + p.tip * Math.SQRT2) / 2));
    return dot(sub(mid, a), n) > 0 ? mul(n, -1) : n;
  };
  const f1 = concaveFillet(C, p.R, b1, T, normalAway(b1, T), p.fillet);
  const f2 = concaveFillet(C, p.R, b2, T, normalAway(b2, T), p.fillet);

  // 꼭짓점 둥글림: 두 변에 접하는 반지름 tipR 원.
  const e1 = unit(sub(b1, T));
  const e2 = unit(sub(b2, T));
  const half = Math.acos(dot(e1, e2)) / 2;
  const back = p.tipR / Math.tan(half);
  const t1 = add(T, mul(e1, back));
  const t2 = add(T, mul(e2, back));
  const tipCenter = add(T, mul(unit(add(e1, e2)), p.tipR / Math.sin(half)));

  // 바깥 윤곽: qb에서 시계 방향으로 돌아 꼬리를 지나 qa, 홈을 파고 qb로.
  const S_ = S;
  const outline = [
    `M${pt(qb)}`,
    circleArcForward(C, p.R, qb, f1.onCircle),
    arcTo(f1.center, p.fillet, f1.onCircle, f1.onLine),
    `L${pt(t1)}`,
    arcTo(tipCenter, p.tipR, t1, t2),
    `L${pt(f2.onLine)}`,
    arcTo(f2.center, p.fillet, f2.onLine, f2.onCircle),
    circleArcForward(C, p.R, f2.onCircle, qa),
    arcTo(S_, knock, qa, qb),
    "Z",
  ].join("");
  // 구멍: 반대 방향으로 돌아 nonzero에서도 비고, evenodd에서도 빈다.
  const hole = [
    `M${pt([p.cx + p.r, p.cy])}`,
    `A${fmt(p.r)} ${fmt(p.r)} 0 1 0 ${pt([p.cx - p.r, p.cy])}`,
    `A${fmt(p.r)} ${fmt(p.r)} 0 1 0 ${pt([p.cx + p.r, p.cy])}`,
    "Z",
  ].join("");
  const ring = outline + hole;
  const satellite = [
    `M${pt([S[0] + p.s, S[1]])}`,
    `A${fmt(p.s)} ${fmt(p.s)} 0 1 1 ${pt([S[0] - p.s, S[1]])}`,
    `A${fmt(p.s)} ${fmt(p.s)} 0 1 1 ${pt([S[0] + p.s, S[1]])}`,
    "Z",
  ].join("");

  // 치수(문서와 테스트가 읽는다). 비율은 바깥 반지름 R 기준.
  const tipExtent = len(sub(tipCenter, C)) + p.tipR;
  const tailAngle = (Math.acos(dot(e1, e2)) * 180) / Math.PI;
  const bite = satDist - knock - p.r;
  const bbox = {
    left: Math.min(p.cx - p.R, tipCenter[0] - p.tipR),
    right: S[0] + p.s,
    top: S[1] - p.s,
    bottom: Math.max(p.cy + p.R, tipCenter[1] + p.tipR),
  };
  // 경계 상자 중심에서 가장 먼 점(위성 바깥 끝, 꼬리 끝). maskable 안전 원 계산용.
  const mid = [(bbox.left + bbox.right) / 2, (bbox.top + bbox.bottom) / 2];
  const reach = Math.max(len(sub(S, mid)) + p.s, len(sub(tipCenter, mid)) + p.tipR);
  const dims = {
    grid: p.grid,
    ringThickness: p.R - p.r,
    ringThicknessRatio: (p.R - p.r) / p.R,
    holeRatio: p.r / p.R,
    satelliteDiameter: 2 * p.s,
    satelliteRatio: p.s / p.R,
    satelliteDistance: satDist,
    satelliteDistanceRatio: satDist / p.R,
    gap: p.g,
    gapRatio: p.g / p.R,
    biteRemainder: bite,
    tailTipAngle: tailAngle,
    tailAxis: 135,
    tailSpread: p.spread,
    tailExtentRatio: tipExtent / p.R,
    bbox,
    reach,
  };
  return { ring, satellite, dims };
}

// ---- 변형 SVG ---------------------------------------------------------------

const HEADER = (what) =>
  `<!-- oort 마크 C2-04 Bubble — ${what}. 생성물: clients/web/scripts/brand-mark.mjs가 쓴다. 손으로 고치지 않는다(docs/brand/mark/README.md). -->`;

function monoSvg(geo, grid, color, what) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${grid} ${grid}" width="${grid}" height="${grid}">
  ${HEADER(what)}
  <g fill="${color}" fill-rule="evenodd">
    <path d="${geo.ring}"/>
    <path d="${geo.satellite}"/>
  </g>
</svg>
`;
}

/**
 * 앱 아이콘판. 1024 정사각 캔버스에 마크를 놓는다.
 * frame=full   : iOS·PWA. 바탕이 캔버스 끝까지(런처가 자기 모양으로 자른다).
 * frame=macos  : macOS 아이콘 그리드. 824 둥근 사각형(모서리 185.4)이 100 여백을
 *                두고 앉는다. 모서리 바깥은 투명.
 * 마크 크기: 바탕 한 변에 대한 마크 경계 상자의 비. iOS 템플릿의 중심 원(지름
 * 약 0.6)에 링과 위성이 함께 들어가게 잡았다.
 */
export const APP_ICON = {
  canvas: 1024,
  macos: { inset: 100, side: 824, radius: 185.4 },
  markFill: 0.6,
};

function appIconSvg(geo, p, frame) {
  const { canvas, macos, markFill } = APP_ICON;
  const plate = frame === "macos" ? macos.side : canvas;
  const origin = frame === "macos" ? macos.inset : 0;
  const bb = geo.dims.bbox;
  const w = bb.right - bb.left;
  const h = bb.bottom - bb.top;
  const scale = (plate * markFill) / Math.max(w, h);
  // 경계 상자의 중심을 판의 중심에 둔다.
  const tx = origin + plate / 2 - scale * (bb.left + w / 2);
  const ty = origin + plate / 2 - scale * (bb.top + h / 2);
  const bg =
    frame === "macos"
      ? `<rect x="${macos.inset}" y="${macos.inset}" width="${macos.side}" height="${macos.side}" rx="${macos.radius}" fill="${COLORS.ink}"/>`
      : `<rect width="${canvas}" height="${canvas}" fill="${COLORS.ink}"/>`;
  const what = frame === "macos" ? "macOS 앱 아이콘(그리드 824/1024)" : "iOS·PWA 앱 아이콘(전면)";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}" width="${canvas}" height="${canvas}">
  ${HEADER(what)}
  ${bg}
  <g transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${fmt(scale * 1000) / 1000})" fill-rule="evenodd">
    <path fill="${COLORS.paper}" d="${geo.ring}"/>
    <path fill="${COLORS.amber}" d="${geo.satellite}"/>
  </g>
</svg>
`;
}

/** 탭 파비콘: 어두운 둥근 타일 + small 기하. 24 격자를 1.25배(30)로 키워 타일에 1 여백으로 앉힌다.
 *  마크 경계 상자가 타일의 약 70%를 차지한다. 16px 탭에서 틈이 1px에 가깝게 남도록 여백을 줄였다(#2650 리뷰 M3). */
function faviconSvg(geo) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <!--
    oort 탭 아이콘 (#2650, C2-04 Bubble). 생성물: clients/web/scripts/brand-mark.mjs가
    쓴다. 손으로 고치지 않는다. 기하는 small(24 격자, 16~32px 광학 보정판)이고
    src/design/brand/OortMark.tsx와 같은 path다.
    icon-system-exception(ADR-0172): 브라우저가 직접 읽는 oort 브랜드 파비콘이라
    Lucide 기능 아이콘으로 바꾸지 않고 로컬 SVG로 남긴다.

    색은 토큰이 아니라 리터럴이다(CSS 캐스케이드 밖에서 탭이 직접 읽는다).
    값은 앱 아이콘판과 같다: 바탕 ${COLORS.ink}(surface 토큰 다크), 링 ${COLORS.paper}
    (surface 토큰 라이트), 위성 ${COLORS.amber}(accent 토큰 다크). XML 주석 안에는
    하이픈 두 개를 쓸 수 없어 토큰 이름을 풀어 적었다. 폰 홈 화면·Dock·탭이
    같은 마크, 같은 세 색을 보인다. 스킴을 따라가지 않는다.
  -->
  <rect width="32" height="32" rx="7" fill="${COLORS.ink}"/>
  <g transform="translate(1 1) scale(1.25)" fill-rule="evenodd">
    <path fill="${COLORS.paper}" d="${geo.ring}"/>
    <path fill="${COLORS.amber}" d="${geo.satellite}"/>
  </g>
</svg>
`;
}

/** 배경 없는 판(앱 밖 문서·배포 페이지용). 한 색, 스킴을 따라간다. */
function publicMarkSvg(geo) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
  <!--
    oort 마크, 배경 없는 판 (#2650, C2-04 Bubble). 생성물: clients/web/scripts/
    brand-mark.mjs가 쓴다. 앱 밖에서 쓰는 사본이다: 문서, 배포 페이지, 링크
    미리보기처럼 이 클라이언트의 CSS가 닿지 않는 자리.
    icon-system-exception(ADR-0172): Lucide에 없는 oort 브랜드 마크의 정적 자산이라
    로컬 SVG로 남긴다. 제품 UI의 기능 아이콘으로 쓰지 않는다.

    앱 **안에서는 이 파일을 쓰지 않는다.** 셸과 로그인은
    src/design/brand/OortMark.tsx를 쓰고, 거기서는 색이 currentColor다.
    배경이 없으니 채움 색만 스킴을 따라간다. 값은 tokens.css의 accent 토큰 두
    스킴이다(라이트 #a54c08, 다크 ${COLORS.amber}).
  -->
  <style>
    .mark { fill: #a54c08; }
    @media (prefers-color-scheme: dark) { .mark { fill: ${COLORS.amber}; } }
  </style>
  <g class="mark" fill-rule="evenodd">
    <path d="${geo.ring}"/>
    <path d="${geo.satellite}"/>
  </g>
</svg>
`;
}

export function outputs() {
  const regular = buildMark(PARAMS.regular);
  const small = buildMark(PARAMS.small);
  const g = PARAMS.regular.grid;
  const gs = PARAMS.small.grid;
  return {
    regular,
    small,
    files: {
      [resolve(MARK_DIR, "oort-mark-black.svg")]: monoSvg(regular, g, COLORS.ink, "단색 검정"),
      [resolve(MARK_DIR, "oort-mark-white.svg")]: monoSvg(regular, g, COLORS.white, "단색 흰색"),
      [resolve(MARK_DIR, "oort-mark-amber.svg")]: monoSvg(regular, g, COLORS.amber, "단색 호박"),
      [resolve(MARK_DIR, "oort-mark-small-black.svg")]: monoSvg(small, gs, COLORS.ink, "16~32px 광학 보정판, 단색 검정"),
      [resolve(MARK_DIR, "oort-app-icon.svg")]: appIconSvg(regular, PARAMS.regular, "full"),
      [resolve(MARK_DIR, "oort-app-icon-macos.svg")]: appIconSvg(regular, PARAMS.regular, "macos"),
      [resolve(PUBLIC_DIR, "favicon.svg")]: faviconSvg(small),
      [resolve(PUBLIC_DIR, "oort-mark.svg")]: publicMarkSvg(small),
    },
  };
}

function main() {
  const check = process.argv.includes("--check");
  const { regular, small, files } = outputs();
  let stale = 0;
  for (const [path, content] of Object.entries(files)) {
    const rel = relative(REPO_ROOT, path);
    if (check) {
      let current = "";
      try {
        current = readFileSync(path, "utf8");
      } catch {
        /* 없으면 낡은 것 */
      }
      if (current !== content) {
        console.error(`stale: ${rel}`);
        stale += 1;
      }
    } else {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
      console.log(`wrote ${rel}`);
    }
  }
  if (!check) {
    console.log("\nOortMark.tsx (small) ring:\n" + small.ring);
    console.log("OortMark.tsx (small) satellite:\n" + small.satellite);
    console.log("\nregular dims:", JSON.stringify(regular.dims, null, 1));
    console.log("small dims:", JSON.stringify(small.dims, null, 1));
  }
  if (stale) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
