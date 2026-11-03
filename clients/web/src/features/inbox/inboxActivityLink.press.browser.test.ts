import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";

// =============================================================================
// 인박스 아래 「활동 열기」 줄(`inbox-activity-link`)은 눌러도 크기가 줄지 않는다 (#5094, #5048 D7).
//
// 이 줄은 칼럼 전체 폭(캡처에서 916px)이다. 넓은 줄 규칙(`docs/design-system/README.md` 눌림(D5): 렌더 폭이 480px 이상이거나 콘텐츠
// 열의 50% 이상이면 **채움만**, `.press` 스케일 없음)을 `press`(0.98배)로 어기고 있었고, 정적 원장(`pressLedger.test.ts`)은 이 줄을
// 못 봤다 — `h-control`이 「작은 칩」으로 읽혀 `isFullWidthRow`가 거짓이다. 그래서 잡는 쪽은 캡처의 실행 시간 폭 프로브
// (`assertWideRowsFillOnly`)뿐이었고, 그 프로브는 이 이름 하나를 허용 목록으로 경고만 냈다. 이 시험은 그 프로브가 읽는 값을 **같은
// 엔진에서 같은 방식으로**(마우스를 누른 채 `:active` 계산 값) 이 줄의 실제 클래스(소스에서 읽는다)로 잰다:
//
//   · 눌림 transform = none (WebKit·Chromium, 밝음·어둠)
//   · 눌림 채움 = `--surface-pressed`, 쉼 채움 = `--surface-hover` (눌림은 크기가 아니라 채움이 말한다). 이 줄은 호버 채움도
//     `--surface-pressed`라서 마우스를 올린 채로는 호버와 눌림을 가를 수 없다 — 그래서 호버 낱말만 뺀 사본(손가락처럼 호버가 없는 줄)에서
//     `:active` 채움이 쉼과 달라지는 것을 따로 잰다.
//   · 대조군: 같은 줄에 `press`를 되돌리면 0.98배로 줄어든다 — 이 프로브가 줄어듦을 실제로 본다는 증거(실패할 수 없는 가드 방지).
//
// 사보타주: `InboxRoute.tsx`의 `press-instant-fill`을 `press`로 되돌리면 첫 시험(소스 단어)과 둘째(계산 값)가 함께 붉다.
// =============================================================================

const INBOX_ROUTE = readFileSync(new URL("./InboxRoute.tsx", import.meta.url), "utf8");

/** `inbox-activity-link` 링크가 쓰는 클래스 목록. 사본이 아니라 소스에서 그대로 읽는다. */
function activityLinkClasses(source: string): string {
  const match = source.match(/data-testid="inbox-activity-link"\s+className="([^"]+)"/);
  if (!match) throw new Error("InboxRoute.tsx: inbox-activity-link 의 리터럴 className 이 없다");
  return match[1]!;
}

const WIDE_COLUMN_PX = 916;

describe("인박스 「활동 열기」 줄 눌림은 채움만 한다 (#5094, #5048 D7)", () => {
  it("소스: 크기 눌림(`press`)이 없고 이름 있는 채움 눌림(`press-instant-fill`)이 있다", () => {
    const tokens = activityLinkClasses(INBOX_ROUTE).split(/\s+/);
    expect(tokens).not.toContain("press");
    expect(tokens).toContain("press-instant-fill");
    // 호버·쉼 채움은 그대로다(눌림만 바뀐다).
    expect(tokens).toContain("bg-surface-hover");
    expect(tokens).toContain("hover:bg-surface-pressed");
  });

  it.skipIf(ENGINES.length === 0)(
    "엔진: 916px 칼럼의 이 줄은 눌러도 transform 이 none 이고 --surface-pressed 로 칠한다 (대조군 `press`는 0.98배)",
    async () => {
      const real = activityLinkClasses(INBOX_ROUTE);
      // 대조군: 같은 줄에서 눌림 낱말만 옛 `press`로 되돌린다.
      const control = real
        .split(/\s+/)
        .map((token) => (token === "press-instant-fill" ? "press" : token))
        .join(" ");
      // 호버가 없는 줄(손가락): 호버 낱말만 뺀다. 눌림 채움이 호버 채움에 가려지지 않은 채 `:active`만 남는다.
      const noHover = real
        .split(/\s+/)
        .filter((token) => !token.startsWith("hover:"))
        .join(" ");
      const css = await compileTokensCss(
        [`${real} ${control} ${noHover} bg-surface text-ink`].flatMap((list) => list.split(/\s+/))
      );
      const html = `<!doctype html><html lang="ko"><head><style>${css}
html, body { margin: 0; }
#column { width: ${WIDE_COLUMN_PX}px; }
#probe-pressed { background-color: var(--surface-pressed); }
#probe-hover { background-color: var(--surface-hover); }
</style></head><body class="bg-surface text-ink"><main id="column">
<a id="real" href="#real" class="${real}"><span>에이전트가 한 일 전체는 활동에서 봐요</span><span>활동 열기</span></a>
<a id="control" href="#control" class="${control}"><span>에이전트가 한 일 전체는 활동에서 봐요</span><span>활동 열기</span></a>
<a id="nohover" href="#nohover" class="${noHover}"><span>에이전트가 한 일 전체는 활동에서 봐요</span><span>활동 열기</span></a>
<i id="probe-pressed"></i><i id="probe-hover"></i>
</main></body></html>`;

      const playwright = await import("playwright");
      const problems: string[] = [];
      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const colorScheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme });
            try {
              const page = await ctx.newPage();
              await page.setContent(html);
              const at = (what: string) => `${engine} ${colorScheme} ${what}`;

              const press = async (id: string) => {
                const box = await page.locator(`#${id}`).boundingBox();
                if (!box) throw new Error(`${id} has no box`);
                await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
                await page.mouse.down();
                // 눌림은 `--motion-instant` 전이다: 끝난 값을 읽는다.
                await page.evaluate(async (target) => {
                  const el = document.getElementById(target)!;
                  await Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined)));
                }, id);
                const read = await page.evaluate((target) => {
                  const el = document.getElementById(target)!;
                  const style = getComputedStyle(el);
                  return {
                    width: el.getBoundingClientRect().width,
                    active: el.matches(":active"),
                    transform: style.transform,
                    background: style.backgroundColor,
                  };
                }, id);
                // 누른 채 밖으로 옮겨 놓고 뗀다: 링크가 눌린 것으로 세어져 이동하지 않는다.
                await page.mouse.move(2, 2);
                await page.mouse.up();
                return read;
              };
              const colorOf = (id: string) =>
                page.evaluate((target) => getComputedStyle(document.getElementById(target)!).backgroundColor, id);

              const wantPressed = await colorOf("probe-pressed");
              const wantRest = await colorOf("probe-hover");
              const restOf = (id: string) =>
                page.evaluate((target) => getComputedStyle(document.getElementById(target)!).backgroundColor, id);
              const restBackground = await restOf("real");
              const noHoverRest = await restOf("nohover");
              const realPress = await press("real");
              const noHoverPress = await press("nohover");
              const controlPress = await press("control");

              // 이 줄은 넓은 줄이다(캡처의 문턱 480px).
              if (!(realPress.width >= 480)) problems.push(`${at("real")}: 폭 ${realPress.width} < 480 — 넓은 줄이 아니라 이 시험이 의미가 없다`);
              if (realPress.active !== true) problems.push(`${at("real")}: 마우스를 눌러도 :active 가 아니다(프로브가 눌림을 못 만든다)`);
              if (!(realPress.transform === "none" || realPress.transform === "matrix(1, 0, 0, 1, 0, 0)")) {
                problems.push(`${at("real")}: 눌림 transform ${realPress.transform}, 기대 none`);
              }
              if (realPress.background !== wantPressed) problems.push(`${at("real")}: 눌림 채움 ${realPress.background}, 기대 --surface-pressed ${wantPressed}`);
              if (restBackground !== wantRest) problems.push(`${at("real")}: 쉼 채움 ${restBackground}, 기대 --surface-hover ${wantRest}`);

              // 호버 없는 사본: 눌림 채움은 `press-instant-fill`이 `:active`에 칠한 것이고 쉼 채움과 다르다(호버에 가려지지 않는다).
              if (noHoverRest !== wantRest) problems.push(`${at("nohover")}: 쉼 채움 ${noHoverRest}, 기대 --surface-hover ${wantRest}`);
              if (noHoverPress.background !== wantPressed) {
                problems.push(`${at("nohover")}: 눌림 채움 ${noHoverPress.background}, 기대 --surface-pressed ${wantPressed}`);
              }
              if (wantPressed === wantRest) problems.push(`${at("nohover")}: 쉼·눌림 토큰이 같아 이 단정이 아무것도 못 가른다`);
              if (!(noHoverPress.transform === "none" || noHoverPress.transform === "matrix(1, 0, 0, 1, 0, 0)")) {
                problems.push(`${at("nohover")}: 눌림 transform ${noHoverPress.transform}, 기대 none`);
              }

              // 대조군은 줄어든다: 프로브가 줄어듦을 본다는 증거.
              if (controlPress.active !== true) problems.push(`${at("control")}: :active 가 아니다`);
              if (!/^matrix\(0\.98, 0, 0, 0\.98, 0, 0\)$/.test(controlPress.transform)) {
                problems.push(`${at("control")}: \`press\` 눌림 transform ${controlPress.transform}, 기대 matrix(0.98, 0, 0, 0.98, 0, 0)`);
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      expect(problems).toEqual([]);
    },
    120_000
  );
});
