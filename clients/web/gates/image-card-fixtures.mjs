// #5189 이미지 카드 게이트의 그림 공장.
//
// 그라디언트 한 장으로는 「글자가 읽히는가」를 눈으로도 기계로도 못 본다. 그래서
// 그림은 브라우저의 캔버스로 **실제 글자를 그려서** 만든다(가로로 긴 터미널 캡처,
// 대시보드 판, 긴 화면, 작은 카드, 큰 사진, 정사각). 바이트는 진짜 PNG다 — 서버
// 프록시가 돌려주는 것과 같은 모양이다.
//
// 글은 현실적인 한국어+영어 팀 대화체다(스킬 §7). 어떤 실사용자 캡처도 옮겨 담지
// 않는다.

/**
 * @typedef {object} Fixture
 * @property {string} key       이름(로그·캡처 파일명)
 * @property {number} w         원본 픽셀 폭
 * @property {number} h         원본 픽셀 높이
 * @property {"wide"|"tall"|"small"|"large"|"square"} kind
 * @property {string} body      메시지 본문 한 줄
 */

/** @type {Fixture[]} */
export const FIXTURES = [
  {
    key: "strip",
    w: 2072,
    h: 110,
    kind: "wide",
    body: "배포 점검 로그 캡처입니다. 가로로 긴 화면이에요.",
  },
  {
    key: "ultra",
    w: 1200,
    h: 60,
    kind: "wide",
    body: "더 낮고 더 긴 한 줄 캡처도 올립니다.",
  },
  {
    key: "wide-mid",
    w: 1500,
    h: 600,
    kind: "wide",
    body: "대시보드 판 캡처입니다. 2.5 대 1 정도예요.",
  },
  {
    key: "tall",
    w: 600,
    h: 2400,
    kind: "tall",
    body: "긴 화면을 통째로 캡처했어요.",
  },
  {
    key: "small",
    w: 240,
    h: 160,
    kind: "small",
    body: "작은 카드 조각입니다.",
  },
  {
    key: "large",
    w: 3200,
    h: 2400,
    kind: "large",
    body: "큰 사진 원본입니다.",
  },
  {
    key: "square",
    w: 1000,
    h: 1000,
    kind: "square",
    body: "정사각형 이미지입니다.",
  },
];

/**
 * 브라우저 안에서 그림 하나를 그려 PNG 바이트(base64)로 돌려준다. 이 함수는
 * `page.evaluate` 안에서 돈다 — 바깥 변수를 쓰지 않는다.
 */
function paintInPage({ key, w, h }) {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext("2d");
  const mono = 'ui-monospace, Menlo, "Courier New", monospace';
  const sans = 'ui-sans-serif, system-ui, "Apple SD Gothic Neo", sans-serif';

  if (key === "strip" || key === "ultra") {
    // 터미널 줄. 레티나(2x) 캡처의 11pt 글자 = 22px 이므로 strip 은 22px 로 그린다.
    // 바탕은 라이트·다크 두 바탕과 모두 색 차이가 큰 짙은 청록이다(모서리를 픽셀로 잰다).
    g.fillStyle = "#164e63";
    g.fillRect(0, 0, w, h);
    const size = key === "strip" ? 22 : 18;
    g.font = `600 ${size}px ${mono}`;
    g.fillStyle = "#e6f4f8";
    g.textBaseline = "top";
    const lines =
      key === "strip"
        ? [
            "배포 점검 (11-03 09:00): 예약 글 14건 확인, 해요체 검사는 통과했습니다. 취소 API는 없어서",
            "캘린더에서 직접 고쳐야 합니다. staging-api 응답 p95 212ms, error budget 99.94% 남음.",
          ]
        : ["deploy ok · 14 jobs · p95 212ms · 취소 API 없음, 캘린더에서 직접 수정"];
    lines.forEach((line, index) => g.fillText(line, 28, 18 + index * (size + 16)));
  } else if (key === "wide-mid") {
    g.fillStyle = "#f4f1ea";
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1f2937";
    g.font = `700 44px ${sans}`;
    g.textBaseline = "top";
    g.fillText("주간 지표 · Weekly metrics", 48, 40);
    const cols = ["#d9772f", "#3b6ea5", "#4f9a6a", "#8a6bb0"];
    cols.forEach((color, index) => {
      const x = 48 + index * 350;
      g.fillStyle = color;
      g.fillRect(x, 140, 320, 300);
      g.fillStyle = "#ffffff";
      g.font = `700 64px ${sans}`;
      g.fillText(String(12 + index * 7), x + 28, 170);
      g.font = `500 28px ${sans}`;
      g.fillText(["신규 가입", "활성 팀", "에이전트 실행", "응답 지연"][index], x + 28, 260);
    });
  } else if (key === "tall") {
    const gradient = g.createLinearGradient(0, 0, 0, h);
    gradient.addColorStop(0, "#fff6e8");
    gradient.addColorStop(1, "#dbe9f6");
    g.fillStyle = gradient;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1f2937";
    g.font = `700 52px ${sans}`;
    g.textBaseline = "top";
    for (let i = 0; i < 12; i += 1) {
      g.fillText(`${i + 1}. 체크리스트 항목`, 48, 80 + i * 180);
      g.fillStyle = "#9aa7b8";
      g.fillRect(48, 150 + i * 180, w - 96, 6);
      g.fillStyle = "#1f2937";
    }
  } else {
    const gradient = g.createLinearGradient(0, 0, w, h);
    gradient.addColorStop(0, "#f3d9b8");
    gradient.addColorStop(1, "#9db9d8");
    g.fillStyle = gradient;
    g.fillRect(0, 0, w, h);
    g.fillStyle = "#1f2937";
    g.font = `700 ${Math.round(Math.min(w, h) / 9)}px ${sans}`;
    g.textBaseline = "middle";
    g.textAlign = "center";
    g.fillText(`${w}×${h}`, w / 2, h / 2);
    // 가장자리가 보이는 면: 네 모서리 표식. 모서리가 깎이면 표식이 잘린다.
    g.fillStyle = "#c2410c";
    const mark = Math.max(6, Math.round(Math.min(w, h) / 40));
    for (const [x, y] of [
      [0, 0],
      [w - mark, 0],
      [0, h - mark],
      [w - mark, h - mark],
    ]) {
      g.fillRect(x, y, mark, mark);
    }
  }
  const dataUrl = canvas.toDataURL("image/png");
  return dataUrl.slice(dataUrl.indexOf(",") + 1);
}

/**
 * @param {import("playwright").Browser} browser
 * @returns {Promise<Map<string, Buffer>>} key → PNG 바이트
 */
export async function renderFixtures(browser) {
  const context = await browser.newContext({ deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.setContent("<!doctype html><meta charset=utf-8><title>fixtures</title>");
  const out = new Map();
  for (const fixture of FIXTURES) {
    const base64 = await page.evaluate(paintInPage, fixture);
    out.set(fixture.key, Buffer.from(base64, "base64"));
  }
  await context.close();
  return out;
}

/** 컴포저 트레이 썸네일(128px)과 구별하는 데 쓴다: `draftThumbnail.ts` 의 캔버스 변. */
export const DRAFT_THUMBNAIL_PX = 128;
