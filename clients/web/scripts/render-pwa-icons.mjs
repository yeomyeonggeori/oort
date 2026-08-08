#!/usr/bin/env node
// =============================================================================
// 홈 화면 아이콘 래스터라이즈 (goal B10).
//
//   npm run icons:pwa      -> public/icon-192.png, icon-512.png,
//                             icon-maskable-512.png
//
// 새 그림을 그리지 않는다. 입력은 언제나 `public/favicon.svg` 한 장이고, 이
// 스크립트가 하는 일은 그 타일을 두 크기로 떠내는 것과, 마스크 규격에 맞게
// 여백을 다시 잡는 것뿐이다. B4.4가 정한 마크는 그대로 남는다.
//
// 왜 PNG인가: 매니페스트 아이콘은 SVG도 받지만, 안드로이드 런처와 iOS 홈 화면이
// 실제로 그리는 것은 래스터다. 512는 스플래시와 스토어 규격, 192는 런처 규격이고,
// 둘 다 없으면 크롬은 설치 자체를 제안하지 않는다.
//
// 왜 maskable을 따로 두는가: 런처는 아이콘을 자기 모양(원, 스퀘어클, 물방울)으로
// **잘라낸다**. 둥근 타일을 그대로 넘기면 모서리가 두 번 깎여 배경이 잘린 사각형
// 처럼 남는다. maskable 판은 배경을 화면 끝까지 채우고(둥근 모서리 없음) 마크는
// 안전 영역(가운데 지름 80% 원) 안으로 들어간다. 그 안전 영역은 눈으로 맞추지
// 않고 렌더된 마크의 실제 경계 상자를 재서 계산한다.
//
// 결과 PNG는 커밋된다. 빌드마다 크로미움을 띄워 아이콘을 다시 뜨는 것은
// `npm run build`가 브라우저를 요구하게 만드는 일이고, 마크는 빌드마다 바뀌는
// 물건이 아니다. 마크를 고치면 이 스크립트를 다시 돌린다.
// =============================================================================

import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PUBLIC_DIR = resolve(WEB_ROOT, "public");
const SOURCE = resolve(PUBLIC_DIR, "favicon.svg");

// 안전 영역은 지름 80%인 원이다(W3C maskable icon). 마크의 경계 상자 대각선이 그
// 원의 지름보다 짧아야 어떤 마스크에서도, 대각선 방향으로도 잘리지 않는다. 0.95는
// 그 원 안에 남기는 여유다: 더 줄이면 런처 아이콘 한가운데에 마크가 작게 떠 있는
// 그림이 되고, 1.0으로 두면 반올림 한 픽셀이 원 밖으로 나간다.
const SAFE_CIRCLE = 0.8;
const SAFE_FILL = 0.95;

const svgSource = readFileSync(SOURCE, "utf8");

/** 한 장을 뜬다. `maskable`이면 모서리를 펴고 마크를 안전 영역 안으로 줄인다. */
async function renderIcon(page, { size, maskable, out }) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(
    `<!doctype html><html><head><style>
       html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden}
       svg{display:block;width:100%;height:100%}
     </style></head><body>${svgSource}</body></html>`,
    { waitUntil: "load" }
  );

  if (maskable) {
    await page.evaluate(
      ({ safeCircle, safeFill }) => {
        const svg = document.querySelector("svg");
        const tile = svg.querySelector("rect");
        const mark = svg.querySelector("g");
        // 배경은 끝까지. 런처가 자기 모양으로 자르므로 이 판에 모서리는 없다.
        tile.setAttribute("rx", "0");

        // 실제로 그려진 마크의 경계를 화면 좌표에서 재고 뷰박스 단위로 되돌린다.
        // 경로 좌표를 손으로 계산하지 않는 이유는, 마크가 바뀌어도 이 스크립트가
        // 따라오게 하기 위해서다.
        //
        // 획 두께는 더해 준다: 크로미움의 getBoundingClientRect는 SVG 그룹에
        // 대해 **채움 기준** 상자를 돌려주므로, 획(2 유저 단위, 둥근 끝)이 상자
        // 밖으로 절반씩 삐져나온다. 처음 판에서 이걸 빼먹었더니 대각선이 안전
        // 지름보다 작다고 계산되어 축소가 통째로 건너뛰어졌다(scale = 1).
        const svgBox = svg.getBoundingClientRect();
        const markBox = mark.getBoundingClientRect();
        const unit = svgBox.width / svg.viewBox.baseVal.width;
        const stroke =
          parseFloat(getComputedStyle(mark.querySelector("path")).strokeWidth) || 0;
        const width = markBox.width / unit + stroke;
        const height = markBox.height / unit + stroke;
        const centerX = (markBox.left - svgBox.left + markBox.width / 2) / unit;
        const centerY = (markBox.top - svgBox.top + markBox.height / 2) / unit;

        const side = svg.viewBox.baseVal.width;
        const target = side * safeCircle * safeFill;
        const diagonal = Math.hypot(width, height);
        const scale = Math.min(1, target / diagonal);

        const middle = side / 2;
        const tx = middle - centerX * scale;
        const ty = middle - centerY * scale;
        const original = mark.getAttribute("transform") ?? "";
        mark.setAttribute(
          "transform",
          `translate(${tx.toFixed(4)} ${ty.toFixed(4)}) scale(${scale.toFixed(4)}) ${original}`
        );
      },
      { safeCircle: SAFE_CIRCLE, safeFill: SAFE_FILL }
    );
  }

  await page.screenshot({ path: out, type: "png" });
  console.log(`wrote ${out} (${size}x${size}${maskable ? ", maskable" : ""})`);
}

async function main() {
  mkdirSync(PUBLIC_DIR, { recursive: true });
  const browser = await chromium.launch();
  try {
    // 아이콘은 물리 픽셀 그대로여야 한다: deviceScaleFactor를 올리면 192 요청에
    // 384 픽셀 파일이 나온다.
    const page = await browser.newPage({ deviceScaleFactor: 1 });
    await renderIcon(page, {
      size: 192,
      maskable: false,
      out: resolve(PUBLIC_DIR, "icon-192.png"),
    });
    await renderIcon(page, {
      size: 512,
      maskable: false,
      out: resolve(PUBLIC_DIR, "icon-512.png"),
    });
    await renderIcon(page, {
      size: 512,
      maskable: true,
      out: resolve(PUBLIC_DIR, "icon-maskable-512.png"),
    });
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
