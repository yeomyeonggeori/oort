// =============================================================================
// 호버 툴바 상자 ∩ 이웃 글자 Range = 0 의 자 (#1743 B-3 · N-2, #5173).
//
// README §6 「행 액션 표면」 5번: 툴바는 행 상단 경계를 걸치는 플로팅 그릇이고(위쪽이 스크롤러 상단에 막히면 행 하단으로
// 뒤집힌다), **자기 행과 바로 이웃의 글자**와 교차 면적 0이어야 한다. 이 모듈이 그 자의 **한 벌**이다 — 캡처 레인
// (`capture-screens.mjs`)과 이슈 전용 레인(`capture-5173.mjs`)이 같은 함수를 부른다. 자가 두 벌이면 한쪽만 이웃을 넓혀서
// 한쪽은 붉고 한쪽은 초록인 채로 남는다(#5173 이 그 모양이었다).
//
// 이웃 = 타임라인의 **행(`timeline-message`)과 시스템 줄(`system-line`)**을 문서 순서로 센 앞·뒤 한 칸이다.
// 옛 자는 이웃을 `timeline-message` 에서만 찾았다. #5129 가 중단 줄을 말풍선 행에서 가운데 작은 줄로 바꾸면서 줄이
// `data-testid="system-line"` 이 되었고(행 동작이 없는 줄이 `timeline-message` 를 쓰면 정거장·툴바 판정이 줄을 행으로 센다),
// 자는 그 줄을 이웃으로 세지 않아 390px 열에서 툴바가 줄을 덮어도 초록이었다.
//
// 글자를 재는 상자: 행은 `[data-row-body]`, 시스템 줄은 줄 자신이다. 생각 줄(`request-thought-line`)은 행의 `[data-row-body]` 안에
// 서고 글자가 진짜 글 노드라서 행 안의 글자로 이미 잰다(`SystemLine.straddle.browser.test.ts` 의 마지막 시험이 그 구조를 못 박는다).
// 즉 생각 줄은 자가 못 보던 줄이 아니라 **그 장면(에이전트 DM·390px)이 레인에 없던 줄**이다. 시스템 줄에는 `data-row-body` 를
// 달지 않는다: 그 속성은 다른 레인(`capture-4619.mjs` `geometry()`)이 「행」을 세는 이름이다.
// =============================================================================

/** 이웃으로 세는 칸. 같은 선택자 목록이 문서 순서를 준다(`querySelectorAll` 은 문서 순서). */
export const HOVER_TOOLBAR_NEIGHBOR_SELECTOR =
  '[data-testid="timeline-message"], [data-testid="system-line"]';

/**
 * 마운트된 호버 툴바마다 자기 행·앞 칸·뒤 칸의 글자와 교차하는 글자 수를 잰다. 던지지 않는다(판정은 부르는 쪽).
 *
 * @param {import("playwright").Page} page
 * @returns {Promise<Array<{
 *   seq: string | null, neighbor: "self" | "prev" | "next" | null, kind: "row" | "system-line" | null,
 *   chars: number, area: number, sample: string, fromTop: number, straddle: string,
 *   looked: Array<{ where: "self" | "prev" | "next", kind: "row" | "system-line", seq: string | null }>,
 * }>>}
 */
export async function measureHoverToolbarOverlap(page) {
  return page.evaluate((neighborSelector) => {
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
          if (text[i] === "\n" || text[i] === " ") continue;
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
    const kindOf = (el) => (el.getAttribute("data-testid") === "system-line" ? "system-line" : "row");
    const textBoxOf = (el) => (kindOf(el) === "system-line" ? el : el.querySelector("[data-row-body]"));
    const items = Array.from(document.querySelectorAll(neighborSelector));
    const bars = Array.from(document.querySelectorAll('[data-testid="message-hover-toolbar"]'));
    return bars.map((bar) => {
      const row = bar.closest('[data-testid="timeline-message"]');
      if (!row) return { seq: null, neighbor: null, kind: null, chars: -1, area: -1, sample: "", fromTop: 0, straddle: "", looked: [] };
      const idx = items.indexOf(row);
      const t = bar.getBoundingClientRect();
      const boxes = [
        { where: "self", el: row },
        { where: "prev", el: items[idx - 1] },
        { where: "next", el: items[idx + 1] },
      ]
        .filter((item) => item.el)
        .map((item) => ({ ...item, kind: kindOf(item.el), seq: item.el.getAttribute("data-seq"), box: textBoxOf(item.el) }))
        .filter((item) => item.box);
      let worst = {
        seq: row.getAttribute("data-seq"),
        neighbor: "self",
        kind: "row",
        chars: 0,
        area: 0,
        sample: "",
        fromTop: Math.round(t.top - row.getBoundingClientRect().top),
        straddle: bar.getAttribute("data-straddle") || "",
      };
      for (const item of boxes) {
        const hit = hitChars(t, item.box);
        if (hit.chars > worst.chars) {
          worst = { ...worst, ...hit, seq: item.seq, neighbor: item.where, kind: item.kind };
        }
      }
      return { ...worst, looked: boxes.map(({ where, kind, seq }) => ({ where, kind, seq })) };
    });
  }, HOVER_TOOLBAR_NEIGHBOR_SELECTOR);
}

/**
 * 툴바 상자 ∩ 본문 텍스트 Range = 0 (#1743 B-3, 이웃 행 N-2, 이웃 시스템 줄 #5173).
 *
 * 삭제된 `assertActionGutterClearsBody`의 후계. 상자 대 상자가 아니라 글자 Range를 px로 잰다. 위 straddle은 위 칸 아랫단,
 * 아래 뒤집기는 아래 칸 윗단에 앉으므로 자기 행만이 아니라 바로 이웃(행·시스템 줄)도 본다.
 *
 * @param {import("playwright").Page} page
 * @param {string} where
 */
export async function assertHoverToolbarClearsBodyText(page, where) {
  const info = await measureHoverToolbarOverlap(page);
  if (info.length === 0) {
    throw new Error(`[호버 툴바 본문 ${where}] 잴 툴바가 없다`);
  }
  const hit = info.find((item) => item.chars > 0);
  if (hit) {
    throw new Error(
      `[호버 툴바 본문 ${where}] seq ${hit.seq}(${hit.neighbor}, ${hit.kind}): 본문 ${hit.chars}자(${hit.area}px²)를 덮는다 「${hit.sample}」`
    );
  }
  console.log(
    `  호버 툴바 본문 ${where}: ${info.length}개, 글자 교차 0(자기+이웃 행·시스템 줄) · 상단 ${info[0].fromTop}px · straddle ${info[0].straddle || "top"}`
  );
}
