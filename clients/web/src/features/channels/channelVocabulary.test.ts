import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

// =============================================================================
// 채널 범위의 낱말 경계 (#1584, #1573 예약의 뒤처리).
//
// #1573 이 「초대」를 **워크스페이스에 새 사람을 부르는 행위**의 낱말로 예약하고
// 빈 채널의 손잡이를 「멤버 추가하기」로 개명했다. 그때 코어 상수에는 가드가
// 붙었지만(`features/timeline/model.test.ts` 의 `not.toContain("초대")`),
// **그 예약 이전부터 있던 문장들**은 그대로 남아 채널 범위 멤버십을 계속 초대로
// 서술했다 — design-review 가 셋을 셌고 이 스위트가 그 자리를 기계로 닫는다.
//
// 왜 값이 아니라 소스를 읽나: 이 문장들은 컴포넌트 안의 리터럴이라 내보내진
// 상수가 아니다. 상수로 끌어내는 것이 더 나은 자리도 있겠지만(코어의
// `EMPTY_ADD_MEMBER_ACTION_LABEL` 이 그 예다), 그 판단은 이 위생 티켓의 몫이
// 아니고, 소스를 읽는 가드는 그 사이에도 **전수**로 돈다.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_SRC = join(HERE, "..", "..");

/**
 * 렌더되는 글만 남긴다. 이 저장소의 주석은 한국어 산문이고 그 안의 「초대」는
 * 대개 **왜 여기 초대가 아닌가**를 설명하는 글이다 — 그것까지 위반으로 세면
 * 가드가 자기 근거를 벌한다.
 */
function withoutProse(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(?<!:)\/\/.*$/gm, "");
}

function sourcesIn(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourcesIn(full));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("채널 범위의 행위는 「추가」다 (#1573 예약 · #1584)", () => {
  it("채널 만들기의 두 갈래가 같은 동사 가족으로 말한다", () => {
    // 공개는 스스로 **들어오고**, 비공개는 누군가 **추가해야** 들어온다.
    // 앞 문장은 「초대받은 멤버에게만 보입니다」였는데, 그 초대를 하는 문이
    // 제품에 없다 — 채널에 사람을 넣는 문은 「멤버 추가」 다이얼로그뿐이다.
    const source = readFileSync(join(HERE, "CreateChannelDialog.tsx"), "utf8");
    const details = [...withoutProse(source).matchAll(/detail: "([^"]*)"/g)].map(
      (m) => m[1]
    );
    expect(details, "채널 종류는 공개·비공개 둘이고 각각 한 줄을 갖는다").toHaveLength(2);
    for (const detail of details) expect(detail).not.toContain("초대");
    expect(details[0]).toBe("워크스페이스의 누구나 찾아서 들어올 수 있습니다.");
    expect(details[1]).toBe("추가된 멤버에게만 보입니다.");
  });

  it("`features/channels/` 의 사용자 문장 속 「초대」는 워크스페이스로 나가는 문뿐이다", () => {
    // 허용목록이 아니라 **잔량**이다(오르트 구름 §5.5 ②): 재는 것은 이 폴더
    // 전수이고, 남는 둘은 「이 워크스페이스에 다른 멤버가 없습니다」 상태가
    // /settings 의 초대 링크 생성기로 내보내는 탈출구다 — #1573 이 의도적으로
    // 남긴 자리이고, 그것은 채널이 아니라 워크스페이스에 대한 문장이다.
    const hits: string[] = [];
    for (const file of sourcesIn(HERE)) {
      for (const text of withoutProse(readFileSync(file, "utf8")).split("\n")) {
        if (text.includes("초대")) {
          hits.push(`${relative(WEB_SRC, file)}: ${text.trim()}`);
        }
      }
    }
    const ESCAPE_HATCH = "features/channels/AddChannelMemberDialog.tsx";
    expect(hits.filter((h) => !h.startsWith(`${ESCAPE_HATCH}: `))).toEqual([]);
    // 그 파일 안에서도 늘어나면 빨갛다. 오늘 세어 낸 수가 둘(빈-워크스페이스
    // 상태의 안내 한 줄과 그 버튼)이고, 상한이지 목표가 아니다.
    expect(hits.length).toBeLessThanOrEqual(2);
  });

  it("셸의 주석과 코어가 인용한 그 주석이 한 문장이다", () => {
    // 코어 머리말이 셸 주석을 **따옴표로** 인용한다. 인용은 사본이고, 사본은
    // 한쪽만 고쳐지는 날이 온다 — #1584 의 셋째 자리가 정확히 그 모양이었다
    // (셸이 「초대 진입점」이라 부르는 동안 코어가 그 문장을 그대로 베껴 두
    // 파일이 함께 낡았다). 여기서 바이트로 잰다.
    const normalise = (s: string) =>
      s.replace(/^[ \t]*(\/\/|\*|\{?\/\*)[ \t]?/gm, "").replace(/\s+/g, " ");
    const core = readFileSync(
      join(WEB_SRC, "..", "..", "..", "packages/momo-core/src/features/timeline/model.ts"),
      "utf8"
    );
    const quoted = normalise(core).match(/AppShell\.tsx`:\s*"([^"]+)"/);
    expect(quoted, "코어 머리말이 AppShell 주석을 인용하고 있어야 한다").not.toBeNull();
    const sentence = quoted?.[1] ?? "";
    expect(sentence).not.toContain("초대");
    const shell = normalise(readFileSync(join(WEB_SRC, "app/AppShell.tsx"), "utf8"));
    expect(
      shell.includes(sentence),
      `코어가 인용한 문장이 AppShell.tsx 에 없다: "${sentence}"`
    ).toBe(true);
  });
});
