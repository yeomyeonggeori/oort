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

/**
 * 마크 한 벌의 기하. 링(꼬리·홈 포함) path, 위성 path, 치수 표.
 * bite=false는 위성 쪽 홈을 파지 않은 링이다. 코메토 얼굴 창의 림(#2732)이 이
 * 판을 쓴다(구멍 r만 16으로 키운다). 림 둘레에는 위성 대신 후드가 있으므로 홈이
 * 있을 이유가 없다. 말풍선 꼬리의 원과 접점은 R·꼬리 파라미터에만 달려 있어,
 * 구멍을 키워도 마크와 좌표가 같다.
 */
export function buildMark(p, { bite: withBite = true } = {}) {
  const C = [p.cx, p.cy];
  const S = [p.cx + p.sat, p.cy - p.sat];
  const T = [p.cx - p.tip, p.cy + p.tip];
  const knock = p.s + p.g;
  const satDist = len(sub(S, C));
  if (withBite && satDist - knock <= p.r) throw new Error("홈이 구멍까지 닿는다");

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
  const tail = [
    arcTo(f1.center, p.fillet, f1.onCircle, f1.onLine),
    `L${pt(t1)}`,
    arcTo(tipCenter, p.tipR, t1, t2),
    `L${pt(f2.onLine)}`,
    arcTo(f2.center, p.fillet, f2.onLine, f2.onCircle),
  ];
  const outline = withBite
    ? [
        `M${pt(qb)}`,
        circleArcForward(C, p.R, qb, f1.onCircle),
        ...tail,
        circleArcForward(C, p.R, f2.onCircle, qa),
        arcTo(S, knock, qa, qb),
        "Z",
      ].join("")
    : [
        // 홈 없는 림: 꼬리 왼쪽 접점에서 시계 방향으로 링을 한 바퀴 돌아 꼬리로.
        `M${pt(f2.onCircle)}`,
        circleArcForward(C, p.R, f2.onCircle, f1.onCircle),
        ...tail,
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
  return { ring, satellite, dims, tail: tail.join(""), tailGeom: { C, T, b1, b2, e1, e2, t1, t2, tipCenter } };
}

// ---- 코메토 K6 플랫 얼굴 (#2732) ---------------------------------------------
//
// 앱 아이콘과 온보딩 S0의 대표 로고. 원본 탐색본은
// claudedocs/brand-2.0/round3/K6-flat-mini.png·K6-flat-light.png·K6-flat-dark.png
// (래스터, 로컬 전용)이고, 여기서도 트레이스하지 않았다. 여섯 조각이다(그리는 순서).
//
//   혜성 꼬리 — 후드 뒤 오른쪽에서 흘러나와 오른쪽 아래로 넓어지는 한 덩어리.
//               후드색 → 호박 → 살구 세 띠(단단한 멈춤점 그라데이션, 평면색).
//   후드  — 연하늘 물방울. 원에서 오른쪽 위로 끝이 솟아 구슬로 끝나고, 왼쪽 아래
//           말풍선 꼬리를 한 겹 둘러싼다(후드 테두리). 그래서 말풍선 꼬리는 어떤
//           바탕에서도 후드 위에 선다.
//   얼굴  — 잉크 원. 림 바깥 지름의 0.8 (탐색본 실측 약 0.8).
//   림    — C2-04 마크와 **같은 문법**: 원 링 + 135° 말풍선 꼬리. buildMark로
//           그리되 치수는 캐릭터 판독이 우선이다(R=20은 마크와 같고, 구멍이
//           r=16으로 커서 림 두께 0.2R. 마크는 0.4R). 말풍선 꼬리의 축·밑변·끝각은
//           마크와 같은 파라미터다.
//   눈    — 무광 흰 점 둘(오프화이트). 빛나지 않는다(index.md: 흑마도사와의 거리).
//   구슬  — 후드 끝의 호박 구슬. 마크의 위성과 같은 −45° 대각선, 같은 호박색.
//
// 자유 곡선(3차 베지에)은 후드 끝과 혜성 꼬리뿐이다. 두 끝은 후드 원의 접선
// 방향으로 들어가므로 원과 이음매가 매끈하다. 제어점은 CHARACTER의 각·거리로 정한다.
export const CHARACTER = {
  // 림: PARAMS.regular 위에 덮어쓰는 값. 나머지(중심, R, 말풍선 꼬리)는 마크와 같다.
  rim: { r: 16 },
  hoodR: 25, // 후드 원 반지름. 림 바깥 R=20에 1.25배
  // 후드 원 중심의 링 중심 기준 오프셋. 구슬 쪽(−45°)으로 밀어 왼쪽 아래는 얇고
  // 오른쪽 위는 두툼한 물방울이 된다.
  hoodShift: [1.5, -1.5],
  sleeve: 2.5, // 말풍선 꼬리를 두르는 후드 테두리 두께
  bead: 27, // 구슬 중심의 링 중심 기준 오프셋(−45° 대각선이라 x=−y). 1.91R
  beadR: 4.5,
  eyeR: 3.5, // 눈 반지름. 얼굴 반지름 16의 0.22 (실측 0.2)
  eyeDx: 7, // 눈 중심의 좌우 거리 (실측 0.54×얼굴 반지름)
  eyeDy: 1.5, // 눈이 얼굴 중심보다 아래로 내려간 거리 (실측 0.1×얼굴 반지름)
  hoodLeft: { angle: -170, reach: 15 },
  tipTop: { at: [-3, -1.6], angle: 0, reach: 11 },
  tipBottom: { at: [-2.4, 2.8], angle: 225, reach: 6 },
  hoodRight: { angle: -30, reach: 10 },
  // 혜성 꼬리(R1 리뷰 H-2). 머리 뒤에서 흘러나와 오른쪽 아래로 넓어지다 뾰족하게
  // 끝나는 한 덩어리. 뿌리 두 점은 후드 원 안(반지름 hoodR−3)의 각, tip은 후드 원
  // 중심 기준 끝점. 바깥 변은 뿌리에서 원의 접선으로 떠나 tipIn 방향으로 끝에
  // 닿고, 안쪽 변은 끝에서 tipOut 방향으로 떠나 뿌리로 접선을 따라 돌아온다.
  comet: {
    rootTop: -20,
    rootBottom: 80,
    tip: [40, 33],
    rootOut: 26,
    tipIn: { angle: 35, reach: 6 },
    tipOut: { angle: 188, reach: 20 },
    rootIn: 16,
  },
  // 띠 경계. 후드 원 중심에서 잰 거리의 비(끝까지 = 1). 동심원 띠라 경계가 머리를
  // 감싸며 흐름을 따라간다(K6 플랫판과 같다). 후드색 → 호박 → 살구.
  cometBands: [0.52, 0.76],
};

export const CHARACTER_COLORS = {
  hood: "#a1cefd", // K6-flat-mini의 후드 색(픽셀 표본). tokens.css --onboarding-kometto-hood
  face: COLORS.ink,
  rim: COLORS.paper,
  eye: COLORS.paper,
  bead: COLORS.amber,
  cometMid: COLORS.amber, // 혜성 꼬리 가운데 띠
  cometEnd: "#f28066", // 혜성 꼬리 끝 띠, 새벽 살구. K6-flat-light 표본 #fe7e63를 한 단 가라앉혔다
};

const circlePath = (c, r) =>
  `M${pt([c[0] + r, c[1]])}A${fmt(r)} ${fmt(r)} 0 1 1 ${pt([c[0] - r, c[1]])}A${fmt(r)} ${fmt(r)} 0 1 1 ${pt([c[0] + r, c[1]])}Z`;

/** 코메토 얼굴 한 벌. 좌표계는 PARAMS.regular(64 격자)와 같다. */
export function buildCharacter(k = CHARACTER, p = PARAMS.regular) {
  const C = [p.cx, p.cy];
  const rimP = { ...p, ...k.rim };
  const mark = buildMark(rimP, { bite: false });
  const B = [p.cx + k.bead, p.cy - k.bead];
  const deg = (a) => rad(a);
  const H = add(C, k.hoodShift);
  const PL = polar(H, k.hoodR, deg(k.hoodLeft.angle));
  const PR = polar(H, k.hoodR, deg(k.hoodRight.angle));
  const T1 = add(B, k.tipTop.at);
  const T2 = add(B, k.tipBottom.at);
  // 원의 시계 방향 접선은 각 + 90°. 왼쪽은 그 방향으로 떠나고, 오른쪽은 그 방향으로 들어온다.
  const cL1 = polar(PL, k.hoodLeft.reach, deg(k.hoodLeft.angle + 90));
  const cL2 = polar(T1, -k.tipTop.reach, deg(k.tipTop.angle));
  const cR1 = polar(T2, k.tipBottom.reach, deg(k.tipBottom.angle));
  const cR2 = polar(PR, k.hoodRight.reach, deg(k.hoodRight.angle - 90));
  // 후드 테두리: 말풍선 꼬리를 sleeve만큼 바깥으로 민 윤곽. 두 변은 평행 이동,
  // 둥근 끝은 같은 중심에서 반지름 tipR + sleeve. 밑변은 링 중심으로 닫는다(후드 원 안).
  const g = mark.tailGeom;
  const outward = (e, other) => {
    const n = [-e[1], e[0]];
    return dot(n, other) < 0 ? n : mul(n, -1);
  };
  const n1 = outward(g.e1, g.e2);
  const n2 = outward(g.e2, g.e1);
  const w = k.sleeve;
  const sleeve = [
    `M${pt(C)}`,
    `L${pt(add(g.b1, mul(n1, w)))}`,
    `L${pt(add(g.t1, mul(n1, w)))}`,
    arcTo(g.tipCenter, rimP.tipR + w, add(g.t1, mul(n1, w)), add(g.t2, mul(n2, w))),
    `L${pt(add(g.b2, mul(n2, w)))}`,
    "Z",
  ].join("");
  const hood =
    [
      `M${pt(PL)}`,
      `C${pt(cL1)} ${pt(cL2)} ${pt(T1)}`,
      `L${pt(T2)}`,
      `C${pt(cR1)} ${pt(cR2)} ${pt(PR)}`,
      `A${fmt(k.hoodR)} ${fmt(k.hoodR)} 0 1 1 ${pt(PL)}`,
      "Z",
    ].join("") + sleeve;
  // 혜성 꼬리
  const cm = k.comet;
  const rootR = k.hoodR - 3;
  const RA = polar(H, rootR, deg(cm.rootTop));
  const RB = polar(H, rootR, deg(cm.rootBottom));
  const F = add(H, cm.tip);
  const comet = [
    `M${pt(RA)}`,
    `C${pt(polar(RA, cm.rootOut, deg(cm.rootTop + 90)))} ${pt(sub(F, mul([Math.cos(deg(cm.tipIn.angle)), Math.sin(deg(cm.tipIn.angle))], cm.tipIn.reach)))} ${pt(F)}`,
    `C${pt(polar(F, cm.tipOut.reach, deg(cm.tipOut.angle)))} ${pt(polar(RB, cm.rootIn, deg(cm.rootBottom - 90)))} ${pt(RB)}`,
    "Z",
  ].join("");
  // 띠: 후드 원 중심에서 끝점까지를 반지름으로 하는 동심원 그라데이션.
  const cometAxis = { center: H, r: len(sub(F, H)) };
  const axisDir = unit(sub(F, H));
  const eyeL = [p.cx - k.eyeDx, p.cy + k.eyeDy];
  const eyeRc = [p.cx + k.eyeDx, p.cy + k.eyeDy];
  const tailTip = mark.dims.bbox;
  const bbox = {
    left: Math.min(H[0] - k.hoodR, tailTip.left - w),
    right: B[0] + k.beadR,
    top: Math.min(B[1] - k.beadR, H[1] - k.hoodR),
    bottom: Math.max(H[1] + k.hoodR, tailTip.bottom + w),
  };
  const withComet = {
    ...bbox,
    right: Math.max(bbox.right, F[0]),
    bottom: Math.max(bbox.bottom, F[1]),
  };
  const upLeft = [Math.cos(rad(-150)), Math.sin(rad(-150))];
  const hoodEdgeAlong = (u) => {
    const v = sub(C, H);
    const b = dot(v, u);
    return -b + Math.sqrt(b * b - (dot(v, v) - k.hoodR * k.hoodR));
  };
  // 후드 원 중심에서 끝점 쪽으로, 반지름 비 t인 자리(띠 표본점).
  const along = (t) => add(H, mul(axisDir, cometAxis.r * t));
  // 크기별 판독 검사가 읽는 표본점(64 격자 좌표).
  const probes = {
    face: [p.cx, p.cy - rimP.r / 2],
    eye: eyeRc,
    betweenEyes: [p.cx, p.cy + k.eyeDy],
    rim: [p.cx + (rimP.R + rimP.r) / 2, p.cy],
    hood: add(C, mul(upLeft, (rimP.R + hoodEdgeAlong(upLeft)) / 2)),
    bead: B,
    // 말풍선 꼬리 가운데(둥근 끝 중심). 둘레는 후드 테두리다.
    tail: g.tipCenter,
    tailRing: add(g.tipCenter, mul(unit(sub(g.tipCenter, C)), rimP.tipR + w / 2)),
    cometMid: along((k.cometBands[0] + k.cometBands[1]) / 2),
    cometEnd: along(k.cometBands[1] + (1 - k.cometBands[1]) * 0.35),
  };
  const mid = [(bbox.left + bbox.right) / 2, (bbox.top + bbox.bottom) / 2];
  // 머리에서 가장 먼 점: 구슬, 후드 원, 후드 테두리를 두른 말풍선 꼬리 끝.
  const reach = Math.max(
    len(sub(B, mid)) + k.beadR,
    len(sub(H, mid)) + k.hoodR,
    len(sub(g.tipCenter, mid)) + rimP.tipR + w
  );
  return {
    hood,
    face: circlePath(C, rimP.r),
    rim: mark.ring,
    tail: mark.tail,
    eyes: circlePath(eyeL, k.eyeR) + circlePath(eyeRc, k.eyeR),
    bead: circlePath(B, k.beadR),
    comet,
    cometAxis,
    dims: {
      bbox,
      bboxWithComet: withComet,
      probes,
      reach,
      beadDistanceRatio: len(sub(B, C)) / p.R,
      faceRatio: rimP.r / rimP.R,
      rimThicknessRatio: (rimP.R - rimP.r) / rimP.R,
    },
  };
}

// ---- 변형 SVG ---------------------------------------------------------------

const CHARACTER_HEADER = (what) =>
  `<!-- oort 코메토 K6 플랫 얼굴 — ${what}. 림은 C2-04 마크의 링이다. 생성물: clients/web/scripts/brand-mark.mjs가 쓴다. 손으로 고치지 않는다(docs/brand/mark/README.md). -->`;

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
 * 앱 아이콘판. 1024 정사각 캔버스에 코메토 얼굴을 놓는다(#2732).
 * frame=full   : iOS·PWA. 바탕이 캔버스 끝까지(런처가 자기 모양으로 자른다).
 * frame=macos  : macOS 아이콘 그리드. 824 둥근 사각형(모서리 185.4)이 100 여백을
 *                두고 앉는다. 모서리 바깥은 투명.
 * 크기: 바탕 한 변에 대한 얼굴 경계 상자의 비(fill). 경계 상자 중심이 아니라
 * 후드 원의 중심을 판 중심에서 offset만큼 옮긴 자리에 둔다. 구슬이 오른쪽 위로
 * 뻗으므로 경계 상자 중심에 두면 무게(후드 원)가 왼쪽 아래로 처진다.
 */
export const APP_ICON = {
  canvas: 1024,
  macos: { inset: 100, side: 824, radius: 185.4 },
  // 머리(혜성 꼬리 제외) 경계 상자가 판 한 변에서 차지하는 비.
  fill: 0.64,
  // 링 중심의 판 중심 기준 위치(판 한 변 비). 혜성 꼬리가 오른쪽 아래로 흐르므로
  // 머리는 왼쪽 위로 조금 올린다.
  offset: [-0.07, -0.03],
};

/**
 * 앱 아이콘 바탕 후보(#2732 R1). 권장안은 APP_BACKGROUND. 나머지는
 * `--candidates <dir>`로만 렌더한다(PR 첨부용, 커밋하지 않는다).
 * badge가 있으면 판 가운데에 원을 하나 더 깐다(K6-flat-light·dark의 배지 원).
 *   cream  오프화이트 판 + 크림 원 (K6-flat-light)
 *   navy   잉크 판 + 새벽 직전 남색 원 (K6-flat-dark)
 *   dawn   밝은 새벽하늘: 위 남색 → 라벤더 → 아래 살구빛 지평선
 */
export const BACKGROUNDS = {
  cream: { stops: [[0, COLORS.paper]], badge: { color: "#ece5d8", r: 0.4 } },
  navy: { stops: [[0, COLORS.ink]], badge: { color: "#252a3a", r: 0.4 } },
  dawn: { stops: [[0, "#34497f"], [0.55, "#7f86bd"], [1, "#f2b596"]] },
};
export const APP_BACKGROUND = "navy";

/** 혜성 꼬리 띠(단단한 멈춤점). */
function cometGradient(ch, id = "comet") {
  const c = CHARACTER_COLORS;
  const [a, b] = CHARACTER.cometBands;
  const { center, r } = ch.cometAxis;
  return `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${fmt(center[0])}" cy="${fmt(center[1])}" r="${fmt(r)}">
      <stop offset="0" stop-color="${c.hood}"/><stop offset="${a}" stop-color="${c.hood}"/>
      <stop offset="${a}" stop-color="${c.cometMid}"/><stop offset="${b}" stop-color="${c.cometMid}"/>
      <stop offset="${b}" stop-color="${c.cometEnd}"/><stop offset="1" stop-color="${c.cometEnd}"/>
    </radialGradient>`;
}

/** 캐릭터 레이어(혜성 꼬리 → 후드 → 얼굴 → 림 → 눈 → 구슬). 색은 CHARACTER_COLORS. */
function characterLayers(ch, indent = "    ") {
  const c = CHARACTER_COLORS;
  return [
    `<path fill="url(#comet)" d="${ch.comet}"/>`,
    `<path fill="${c.hood}" d="${ch.hood}"/>`,
    `<path fill="${c.face}" d="${ch.face}"/>`,
    `<path fill="${c.rim}" fill-rule="evenodd" d="${ch.rim}"/>`,
    `<path fill="${c.eye}" d="${ch.eyes}"/>`,
    `<path fill="${c.bead}" d="${ch.bead}"/>`,
  ]
    .map((line) => indent + line)
    .join("\n");
}

/** W3C maskable 안전 원(지름 80%)의 반지름에 반올림 여유 0.95를 곱한 값. */
export const SAFE_RADIUS = 0.4 * 0.95;

/**
 * 얼굴을 판 위 어디에 얼마나 크게 놓는가. frame=maskable은 머리 경계 상자 중심을
 * 캔버스 중심에 두고, 머리의 가장 먼 점(dims.reach)이 안전 원 안에 들게 줄인다.
 * 혜성 꼬리는 안전 원 밖으로 흘러도 된다(잘려도 머리가 남는다).
 */
export function appIconPlacement(frame) {
  const { canvas, macos, fill, offset } = APP_ICON;
  const ch = buildCharacter();
  const p = PARAMS.regular;
  const bb = ch.dims.bbox;
  const side = Math.max(bb.right - bb.left, bb.bottom - bb.top);
  let scale;
  let tx;
  let ty;
  if (frame === "maskable") {
    scale = Math.min((canvas * fill) / side, (canvas * SAFE_RADIUS) / ch.dims.reach);
    tx = canvas / 2 - scale * ((bb.left + bb.right) / 2);
    ty = canvas / 2 - scale * ((bb.top + bb.bottom) / 2);
  } else {
    const plate = frame === "macos" ? macos.side : canvas;
    const origin = frame === "macos" ? macos.inset : 0;
    scale = (plate * fill) / side;
    tx = origin + plate * (0.5 + offset[0]) - scale * p.cx;
    ty = origin + plate * (0.5 + offset[1]) - scale * p.cy;
  }
  return { ch, scale: Math.round(scale * 1000) / 1000, tx: Math.round(tx * 100) / 100, ty: Math.round(ty * 100) / 100 };
}

export function appIconSvg(frame, background = APP_BACKGROUND) {
  const { canvas, macos } = APP_ICON;
  const { ch, scale, tx, ty } = appIconPlacement(frame);
  const bgDef = BACKGROUNDS[background];
  const stops = bgDef.stops;
  const paint = stops.length === 1 ? stops[0][1] : "url(#sky)";
  const sky =
    stops.length === 1
      ? ""
      : `
    <linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
${stops.map(([o, c]) => `      <stop offset="${o}" stop-color="${c}"/>`).join("\n")}
    </linearGradient>`;
  const plateShape =
    frame === "macos"
      ? `<rect x="${macos.inset}" y="${macos.inset}" width="${macos.side}" height="${macos.side}" rx="${macos.radius}"`
      : `<rect width="${canvas}" height="${canvas}"`;
  const plate = frame === "macos" ? macos.side : canvas;
  const badge = bgDef.badge
    ? `\n  <circle cx="${canvas / 2}" cy="${canvas / 2}" r="${fmt(plate * bgDef.badge.r)}" fill="${bgDef.badge.color}"/>`
    : "";
  const what = {
    macos: "macOS 앱 아이콘(그리드 824/1024)",
    full: "iOS·PWA 앱 아이콘(전면)",
    maskable: "PWA maskable(안전 원 안)",
  }[frame];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${canvas} ${canvas}" width="${canvas}" height="${canvas}">
  ${CHARACTER_HEADER(`${what}, 바탕 ${background}`)}
  <defs>${sky}
    <clipPath id="plate">${plateShape}/></clipPath>
    ${cometGradient(ch)}
  </defs>
  ${plateShape} fill="${paint}"/>${badge}
  <g clip-path="url(#plate)">
  <g transform="translate(${fmt(tx)} ${fmt(ty)}) scale(${scale})">
${characterLayers(ch)}
  </g>
  </g>
</svg>
`;
}

/** 배경 없는 코메토 얼굴(문서·배포 페이지·온보딩 S0 사본의 기준본). */
/**
 * 배경 없는 판의 viewBox. 혜성 꼬리까지 담는 정사각이고, **가로 중심은 링 중심**이다
 * (#2732 리뷰 M-3, R1 리뷰 H-1). 혜성 꼬리가 오른쪽으로 흘러도 얼굴이 S0 워드마크
 * 축 위에 선다. 둘레에 0.5 여백을 둬 구슬·꼬리 끝이 잘리지 않는다.
 */
export function characterViewBox(ch = buildCharacter(), p = PARAMS.regular) {
  const bb = ch.dims.bboxWithComet;
  const half = Math.max(p.cx - bb.left, bb.right - p.cx, (bb.bottom - bb.top) / 2) + 0.5;
  const midY = (bb.top + bb.bottom) / 2;
  return [p.cx - half, midY - half, 2 * half, 2 * half].map(fmt).join(" ");
}

function characterSvg() {
  const ch = buildCharacter();
  const vb = characterViewBox(ch);
  const side = vb.split(" ")[2];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${side}" height="${side}">
  ${CHARACTER_HEADER("배경 없는 판")}
  <defs>
    ${cometGradient(ch)}
  </defs>
  <g>
${characterLayers(ch)}
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
      [resolve(MARK_DIR, "oort-kometto.svg")]: characterSvg(),
      [resolve(MARK_DIR, "oort-app-icon.svg")]: appIconSvg("full"),
      [resolve(MARK_DIR, "oort-app-icon-macos.svg")]: appIconSvg("macos"),
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
