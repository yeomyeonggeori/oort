import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RosterMember } from "@momo/core/lib/api";
import type { MailboxEntry } from "@momo/core/features/inbox/mailbox";
import {
  mailboxSource,
  type MailboxPlace,
  type MailboxSource,
} from "@momo/core/features/inbox/source";
import { makeDirectory, type Directory } from "@momo/core/features/workspace/directory";
import { compileTokensCss, ENGINES } from "@/design/appearance/compileTokensTestKit";
import { koreanLocaleForTest } from "@/i18n/koreanLocaleForTest";
import { LocaleContext } from "@/i18n/localeContext";
import { MailboxList } from "./MailboxList";

// =============================================================================
// 받은함 줄의 출처 한 줄 (#5696): 진짜 `MailboxList`를 서버 렌더한 마크업에 `tokens.css`를 Tailwind로 컴파일한 CSS를
// 얹어 설치된 엔진(WebKit·Chromium)에 먹이고, 줄의 기하를 잰다. jsdom은 높이를 모른다 — 줄 높이·말줄임·겹침은 엔진만 안다.
//
//   ① 모든 줄이 같은 높이다: 처리할 일·스레드·1:1 DM·여럿인 DM·채널 멘션·목록에 없는 DM, 안 읽음 수 배지·점·읽음이 섞여도
//      (줄 높이 최댓값 − 최솟값 ≤ 0.5px). 폭 360 · 640(1280 창의 200% 확대) · 352(데스크탑 목록 칸 22rem), 글자 기본·크게.
//   ② 출처 줄은 한 줄이고 긴 출처는 말줄임으로 접히며(대조: 그 줄은 실제로 넘친다) 이름 줄과 겹치지 않는다.
//   ③ 줄 이동 0: 읽음으로 바뀔 때 모든 줄의 위치가 그대로이고(Δ 0), 이름이 늦게 풀려 출처 글이 바뀌어도 그대로이며,
//      새 항목이 맨 위에 올 때 기존 줄은 높이가 그대로이고 정확히 한 줄 높이만큼만 내려간다.
//
// 이름은 모두 가상 인물이다.
// =============================================================================

const NOW = 1_800_000_000_000;
const ME = "00000000-0000-7000-8000-000000000101";
const DOHYUN = "00000000-0000-7000-8000-000000000102";
const SEOYEON = "00000000-0000-7000-8000-000000000103";
const JUNHO = "00000000-0000-7000-8000-000000000104";
const MINJI = "00000000-0000-7000-8000-000000000105";
const BOT = "00000000-0000-7000-8000-000000000301";
const CH = "00000000-0000-7000-8000-000000000201";

function member(id: string, name: string, kind: "human" | "agent" = "human"): RosterMember {
  return {
    id,
    workspaceId: "w",
    kind,
    status: "active",
    displayName: name,
    handle: kind === "agent" ? "dawn-bot" : name,
    channelCount: 0,
    channelIds: [],
    capabilities: [],
    createdAtMs: 0,
    updatedAtMs: 0,
  } as RosterMember;
}

const directory: Directory = makeDirectory([
  member(ME, "구민수"),
  member(DOHYUN, "김도현"),
  member(SEOYEON, "이서연"),
  member(JUNHO, "박준호"),
  member(MINJI, "최민지"),
  member(BOT, "새벽봇", "agent"),
]);

const LONG_CHANNEL = "release-notes-2026-4분기-모바일-데스크탑-통합-점검";
const ch = (name: string | null): MailboxPlace => ({ kind: "channel", name });
const dm = (...names: string[]): MailboxPlace => ({ kind: "dm", names });

function entry(
  key: string,
  kind: MailboxEntry["kind"],
  source: MailboxSource,
  over: Partial<MailboxEntry> = {}
): MailboxEntry {
  return {
    key,
    kind,
    channelId: CH,
    channelLabel: "workbench",
    typeLabel: "",
    source,
    actor: "김도현",
    actorMemberId: DOHYUN,
    actorIsAgent: false,
    preview: "내일 오전 배포 전에 체크리스트 한 번만 같이 봐 줄 수 있을까요? 모바일 쪽 알림 문구도 바뀌었어요.",
    atMs: NOW,
    timeLabel: "3분 전",
    unread: true,
    unreadCount: 0,
    reason: "r",
    ...over,
  };
}

/** 종류·상태가 섞인 목록. 출처 여섯 모양 + 배지(수)·점·읽음 + 아바타 있음/없음(종류 그림). */
function mixed(): MailboxEntry[] {
  return [
    entry("task", "task", mailboxSource("task", ch(null), false), {
      actor: "@dawn-bot",
      actorMemberId: undefined,
      actorIsAgent: true,
      preview: "프로덕션 배포 승인 요청",
    }),
    entry("thread", "thread", mailboxSource("thread", ch("workbench"), true), {
      actor: "이서연",
      actorMemberId: SEOYEON,
      unreadCount: 3,
    }),
    entry("dm", "dm", mailboxSource("dm", dm("김도현"), false)),
    entry("group", "dm", mailboxSource("dm", dm("박준호", "최민지", "김도현", "이서연"), false), {
      actor: "박준호",
      actorMemberId: JUNHO,
      unread: false,
    }),
    entry("mention", "mention", mailboxSource("mention", ch(LONG_CHANNEL), false), {
      actor: "최민지",
      actorMemberId: MINJI,
      unread: false,
    }),
    entry("gone-dm", "dm", mailboxSource("dm", dm(), false), {
      actor: "나간 멤버",
      actorMemberId: undefined,
    }),
  ];
}

function markup(entries: MailboxEntry[], locale: Awaited<ReturnType<typeof koreanLocaleForTest>>): string {
  return renderToStaticMarkup(
    createElement(
      LocaleContext.Provider,
      { value: locale },
      createElement(MailboxList, {
        entries,
        selectedKey: "dm",
        onSelect: () => undefined,
        directory,
      })
    )
  );
}

type RowBox = { key: string; top: number; height: number };

const WIDTHS = [360, 640, 352] as const;
const FONT_SIZES = [null, "larger"] as const;

describe("받은함 출처 한 줄의 기하 (#5696)", () => {
  it.skipIf(ENGINES.length === 0)(
    "모든 줄이 같은 높이 · 출처 한 줄 말줄임 · 이름과 겹치지 않음 · 읽음/늦은 이름/새 항목에 줄 이동 0",
    async () => {
      const locale = await koreanLocaleForTest();
      const before = mixed();
      const allRead = before.map((e) => ({ ...e, unread: false, unreadCount: 0 }));
      // 이름이 늦게 풀린다: 명부가 오기 전 「불러오는 중」이던 DM 출처가 이름으로 바뀐다(글만 바뀌고 자리는 그대로여야 한다).
      const pending = before.map((e) =>
        e.key === "dm" ? { ...e, source: mailboxSource("dm", dm("불러오는 중"), false) } : e
      );
      const arrived = [
        entry("new", "mention", mailboxSource("mention", ch("workbench"), true), {
          actor: "새벽봇",
          actorMemberId: BOT,
          actorIsAgent: true,
          preview: "빌드 끝났어요",
        }),
        ...before,
      ];
      const hosts = { before, allRead, pending, arrived };
      const html = Object.fromEntries(
        Object.entries(hosts).map(([id, list]) => [id, markup(list, locale)])
      ) as Record<keyof typeof hosts, string>;
      expect(html.before).toContain("스레드 · #workbench");
      expect(html.before).not.toContain("##");

      const candidates = [...Object.values(html).join("").matchAll(/class="([^"]*)"/g)]
        .flatMap((m) => (m[1] ?? "").split(/\s+/))
        .filter(Boolean);
      const css = await compileTokensCss([...candidates, "bg-pane", "text-ink"]);
      const playwright = await import("playwright");
      const problems: string[] = [];
      const measuredCases: string[] = [];
      let overflowSeen = 0;

      for (const engine of ENGINES) {
        const browser = await playwright[engine].launch();
        try {
          for (const scheme of ["light", "dark"] as const) {
            const ctx = await browser.newContext({ viewport: { width: 1280, height: 2400 }, colorScheme: scheme });
            try {
              const view = await ctx.newPage();
              for (const width of WIDTHS) {
                for (const fontSize of FONT_SIZES) {
                  const label = `${engine}/${scheme}/${width}px/${fontSize ?? "기본"}`;
                  const attr = fontSize === null ? "" : ` data-font-size="${fontSize}"`;
                  await view.setContent(
                    `<!doctype html><html lang="ko"${attr}><head><style>${css}\nhtml,body{margin:0}</style></head><body class="bg-pane text-ink">` +
                      Object.entries(html)
                        .map(([id, body]) => `<div id="${id}" style="width:${width}px">${body}</div>`)
                        .join("") +
                      `</body></html>`
                  );
                  const result = await view.evaluate(() => {
                    const rows = (id: string) => {
                      const host = document.getElementById(id) as HTMLElement;
                      const origin = host.getBoundingClientRect().top;
                      return [...host.querySelectorAll<HTMLElement>("[data-mailbox-row]")].map((row) => {
                        const box = (row.closest("li") as HTMLElement).getBoundingClientRect();
                        return {
                          key: row.getAttribute("data-entry-key") ?? "",
                          top: box.top - origin,
                          height: box.height,
                        };
                      });
                    };
                    const host = document.getElementById("before") as HTMLElement;
                    const sources = [...host.querySelectorAll<HTMLElement>('[data-testid="mailbox-row-source"]')].map(
                      (source) => {
                        const row = source.closest("[data-mailbox-row]") as HTMLElement;
                        const head = source.previousElementSibling as HTMLElement;
                        const s = source.getBoundingClientRect();
                        const h = head.getBoundingClientRect();
                        const style = getComputedStyle(source);
                        return {
                          key: row.getAttribute("data-entry-key") ?? "",
                          text: source.textContent ?? "",
                          aria: row.getAttribute("aria-label") ?? "",
                          height: s.height,
                          lineHeight: parseFloat(style.lineHeight),
                          overflow: source.scrollWidth > source.clientWidth + 0.5,
                          ellipsis: style.textOverflow === "ellipsis" && style.whiteSpace === "nowrap",
                          gap: s.top - h.bottom,
                          right: s.right,
                          rowRight: row.getBoundingClientRect().right,
                        };
                      }
                    );
                    return {
                      before: rows("before"),
                      allRead: rows("allRead"),
                      pending: rows("pending"),
                      arrived: rows("arrived"),
                      sources,
                    };
                  });

                  measuredCases.push(label);
                  // ① 같은 높이(섞인 목록 · 새 항목이 든 목록)
                  for (const [name, list] of [["섞인 목록", result.before], ["새 항목 목록", result.arrived]] as const) {
                    const heights = list.map((r: RowBox) => r.height);
                    const spread = Math.max(...heights) - Math.min(...heights);
                    if (list.length < 6 || spread > 0.5) {
                      problems.push(`${label} ${name}: 줄 높이 ${heights.map((h) => h.toFixed(2)).join(", ")} (차 ${spread.toFixed(2)})`);
                    }
                  }
                  // ② 출처 한 줄 · 말줄임 · 겹침 없음
                  for (const source of result.sources) {
                    if (source.text.trim() === "") problems.push(`${label} ${source.key}: 출처 줄이 비었다`);
                    if (source.height > source.lineHeight * 1.5) {
                      problems.push(`${label} ${source.key}: 출처가 두 줄 이상(${source.height.toFixed(1)}px)`);
                    }
                    if (!source.ellipsis) problems.push(`${label} ${source.key}: 말줄임(nowrap + ellipsis)이 아니다`);
                    if (source.gap < -0.5) problems.push(`${label} ${source.key}: 이름 줄과 ${(-source.gap).toFixed(1)}px 겹친다`);
                    if (source.right > source.rowRight + 0.5) problems.push(`${label} ${source.key}: 출처가 줄 밖으로 나간다`);
                    if (!source.aria.includes(source.text)) problems.push(`${label} ${source.key}: 낭독 이름에 출처 「${source.text}」가 없다`);
                    if (source.overflow) overflowSeen += 1;
                  }
                  // ③ 줄 이동 0
                  const shift = (a: RowBox[], b: RowBox[], name: string) => {
                    a.forEach((row, i) => {
                      const other = b[i];
                      if (!other || other.key !== row.key) {
                        problems.push(`${label} ${name}: 줄 차례가 다르다`);
                        return;
                      }
                      const moved = Math.abs(other.top - row.top) + Math.abs(other.height - row.height);
                      if (moved > 0.01) problems.push(`${label} ${name} ${row.key}: ${moved.toFixed(2)}px 움직였다`);
                    });
                  };
                  shift(result.before, result.allRead, "읽음으로 바뀜");
                  shift(result.before, result.pending, "늦게 풀린 이름");
                  const fresh = result.arrived[0] as RowBox;
                  result.before.forEach((row: RowBox, i: number) => {
                    const after = result.arrived[i + 1] as RowBox;
                    const drift = Math.abs(after.top - row.top - fresh.height) + Math.abs(after.height - row.height);
                    if (drift > 0.01) problems.push(`${label} 새 항목 ${row.key}: 한 줄 높이 밖으로 ${drift.toFixed(2)}px`);
                  });
                }
              }
            } finally {
              await ctx.close();
            }
          }
        } finally {
          await browser.close();
        }
      }
      // 대조군: 긴 채널 출처는 360·352 폭에서 실제로 넘친다 — 말줄임 검사가 빈 검사가 아니다.
      expect(overflowSeen).toBeGreaterThan(0);
      expect(measuredCases.length).toBe(ENGINES.length * 2 * WIDTHS.length * FONT_SIZES.length);
      expect(problems).toEqual([]);
    },
    120_000
  );
});
