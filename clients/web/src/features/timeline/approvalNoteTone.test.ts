import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  APPROVAL_NOTE_BLOCKED_TWIN,
  APPROVAL_NOTE_TONE_ORDER,
  APPROVAL_NOTE_TONE_SPEC,
  type ApprovalNoteTone,
} from "@momo/core/features/timeline/approvalNote";
import {
  APPROVAL_NOTE_ROLE_TOKEN,
  APPROVAL_NOTE_TONE_CLASS,
  APPROVAL_NOTE_TONE_TOKEN,
} from "./approvalNoteTone";

// =============================================================================
// 승인 노트 세 톤의 옷이 **우연이 아니라 계약**인가 (#1429)
//
// 실측한 상태: 웹은 차단 줄을 `text-warn`으로, 폰은 본문 잉크로 그린다. 두 파일이
// 서로를 모르는 채 각자 옳은 논증을 적어 두었고, 그 둘을 지키는 것은 폰 쪽에만
// 있었다(`approvalCard.test.tsx`). 이 파일이 웹 쪽 절반이다.
//
// 지키는 것은 「앰버다」가 아니라 **역할**이다: 코어가 정한 명세
// (`APPROVAL_NOTE_TONE_SPEC`)를 이 팔레트의 실제 값에 대고 잰다. `tokens.css`를
// 직접 읽는 이유는 D-2와 같다 — U4-4R W-2의 가드는 이 레포가 쓰지 않는 표를 보고
// 있어서 내내 초록이었다.
// =============================================================================

const css = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const agentCard = readFileSync(
  new URL("./AgentCard.tsx", import.meta.url),
  "utf8"
);
const composer = readFileSync(
  new URL("../chat/Composer.tsx", import.meta.url),
  "utf8"
);

/** 토큰 한 줄의 light-dark() 두 값을 [light, dark] 로. */
function tokenValues(name: string): [string, string] {
  const match = css.match(
    new RegExp(
      `${name}:\\s*light-dark\\(\\s*(#[0-9a-f]{6})\\s*,\\s*(#[0-9a-f]{6})\\s*\\)`,
      "i"
    )
  );
  if (match === null) {
    throw new Error(
      `${name}이 tokens.css에 light-dark() 한 쌍으로 없다. 토큰을 옮겼다면 이 ` +
        "다리(approvalNoteTone.ts)도 함께 옮길 것"
    );
  }
  return [match[1].toLowerCase(), match[2].toLowerCase()];
}

const SCHEMES = ["라이트", "다크"] as const;
const TONES = APPROVAL_NOTE_TONE_ORDER as readonly ApprovalNoteTone[];

/** 클래스 표에서 크기 롤 하나. 이 클라의 두 번째 위계 축이다. */
function sizeRole(tone: ApprovalNoteTone): string {
  const role = APPROVAL_NOTE_TONE_CLASS[tone]
    .split(" ")
    .find((cls) => cls === "text-body" || cls === "text-meta");
  if (role === undefined) {
    throw new Error(
      `${tone}의 클래스에 텍스트 롤이 없다. 롤 없이 서면 스톡 스케일이 없는 이 ` +
        "레포에서 그 줄은 크기를 상속받는다"
    );
  }
  return role;
}

describe("코어의 역할표를 이 팔레트가 전부 답한다", () => {
  it("모든 톤에 토큰과 클래스가 있다", () => {
    for (const tone of TONES) {
      expect(APPROVAL_NOTE_TONE_TOKEN[tone], `${tone} 토큰`).toBeTruthy();
      expect(APPROVAL_NOTE_TONE_CLASS[tone], `${tone} 클래스`).toBeTruthy();
    }
  });

  it("명세가 든 이름을 하나도 빠뜨리지 않는다", () => {
    // 답하지 못하는 이름이 명세에 들어오면 그 조건은 **재지 않은 채** 지나간다.
    // D-2가 같은 자리에 같은 단정을 두고 있고, 이유도 같다.
    for (const tone of TONES) {
      for (const name of APPROVAL_NOTE_TONE_SPEC[tone].mustDifferFrom) {
        const answered =
          name in APPROVAL_NOTE_TONE_TOKEN || name in APPROVAL_NOTE_ROLE_TOKEN;
        expect(answered, `명세의 "${name}"을 이 팔레트가 답하지 못한다`).toBe(
          true
        );
      }
    }
  });

  it("클래스가 실제로 그 토큰을 든다", () => {
    // 표 둘이 갈라지면 값 대조는 초록인데 화면은 다른 색이 된다.
    for (const tone of TONES) {
      const utility = `text-${APPROVAL_NOTE_TONE_TOKEN[tone].slice(2)}`;
      expect(
        APPROVAL_NOTE_TONE_CLASS[tone].split(" "),
        `${tone}의 클래스가 자기 토큰을 안 든다`
      ).toContain(utility);
    }
  });
});

describe("세 문장이 같은 옷을 입지 않는다 (M-3)", () => {
  /**
   * 옷은 잉크 하나가 아니라 **이 클라가 위계를 내는 축 전부**다. 영수증과 차단은
   * 잉크가 갈라지고, 차단과 안내는 크기가 같고 잉크가 갈라진다. 한 축만 재면
   * M-3이 실측한 그 상태(셋이 한 벌)로 조용히 되돌아갈 수 있다.
   */
  it("형제 톤끼리 잉크 또는 크기가 갈린다", () => {
    for (const tone of TONES) {
      for (const name of APPROVAL_NOTE_TONE_SPEC[tone].mustDifferFrom) {
        if (!(name in APPROVAL_NOTE_TONE_TOKEN)) continue;
        const other = name as ApprovalNoteTone;
        const mineInk = tokenValues(APPROVAL_NOTE_TONE_TOKEN[tone]);
        const otherInk = tokenValues(APPROVAL_NOTE_TONE_TOKEN[other]);
        for (const [index, scheme] of SCHEMES.entries()) {
          const sameInk = mineInk[index] === otherInk[index];
          const sameSize = sizeRole(tone) === sizeRole(other);
          expect(
            sameInk && sameSize,
            `${scheme}에서 ${tone}과 ${other}가 같은 옷이다`
          ).toBe(false);
        }
      }
    }
  });

  it("격이 실제로 격이다: 영수증만 본문 크기, 안내만 물러난 잉크", () => {
    expect(sizeRole("receipt")).toBe("text-body");
    expect(sizeRole("blocked")).toBe("text-meta");
    expect(sizeRole("guidance")).toBe("text-meta");
    expect(APPROVAL_NOTE_TONE_TOKEN.receipt).toBe("--ink");
    expect(APPROVAL_NOTE_TONE_TOKEN.guidance).toBe("--ink-muted");
  });
});

describe("차단 줄은 부름도 사고도 아니다", () => {
  /**
   * 계약의 심장. 「차단이 무슨 색인가」는 팔레트마다 다르게 답해도 되지만, 이
   * 두 역할과 같아지면 그것은 더 이상 차단이 아니다 — 부름이거나 사고다.
   */
  it("팔레트 역할과 두 스킴 모두에서 값이 다르다", () => {
    for (const tone of TONES) {
      const mine = tokenValues(APPROVAL_NOTE_TONE_TOKEN[tone]);
      for (const name of APPROVAL_NOTE_TONE_SPEC[tone].mustDifferFrom) {
        if (!(name in APPROVAL_NOTE_ROLE_TOKEN)) continue;
        const other = tokenValues(APPROVAL_NOTE_ROLE_TOKEN[name]);
        for (const [index, scheme] of SCHEMES.entries()) {
          expect(
            mine[index],
            `${scheme}에서 ${tone}이 "${name}"과 같은 값이다`
          ).not.toBe(other[index]);
        }
      }
    }
  });

  /**
   * 이 팔레트에서 「사람이 할 일이 남아 있다」를 지는 것은 `--accent`다
   * (`StatusChip.tsx`: *"그 뜻의 색은 이 제품에서 하나여야 한다"*). 차단은 부름이
   * 아니라 **지금은 못 한다**이므로 그 색을 빌려 쓰지 않는다 — 그리고 이 클라에서
   * `--warn`이 그 뜻으로 비어 있다는 것이 폰과 답이 갈리는 이유 전부다
   * (코어 `approvalNote.ts` §색 계약).
   */
  it("부름의 색은 accent이고, 차단은 그것이 아니다", () => {
    expect(APPROVAL_NOTE_ROLE_TOKEN.attention).toBe("--accent");
    expect(APPROVAL_NOTE_TONE_TOKEN.blocked).toBe("--warn");
    expect(APPROVAL_NOTE_TONE_TOKEN.blocked).not.toBe(
      APPROVAL_NOTE_ROLE_TOKEN.attention
    );
  });
});

describe("한 클라 안에서 같은 말이 두 옷을 입지 않는다", () => {
  /**
   * 컴포저의 「지금은 못 보낸다」와 승인 카드의 차단 줄은 같은 종류의 말이다.
   * 폰은 그 둘이 갈라져 있던 것을 U4-6 M-2에서 고쳤고 가드도 남겼다. 웹은 지금
   * 정합인데 그것을 지키는 것이 없었다 — 이 단정이 그 자리다.
   */
  it("컴포저 오프라인 줄이 차단 줄과 같은 옷이다 (U4-6 M-2)", () => {
    // testid 앞쪽에서 **가장 가까운** className을 집는다. 앞에서부터 탐욕적으로
    // 매칭하면 파일 위쪽의 다른 요소가 잡히고, 그 초록은 아무 말도 안 한다.
    const at = composer.indexOf(
      `data-testid="${APPROVAL_NOTE_BLOCKED_TWIN}"`
    );
    expect(
      at,
      `Composer.tsx에서 data-testid="${APPROVAL_NOTE_BLOCKED_TWIN}" 줄을 찾지 못했다`
    ).toBeGreaterThan(-1);
    const before = composer.slice(0, at);
    const worn = [...before.matchAll(/className="([^"]*)"/g)]
      .at(-1)![1]
      .split(/\s+/);
    for (const cls of APPROVAL_NOTE_TONE_CLASS.blocked.split(" ")) {
      expect(worn, `컴포저 오프라인 줄에 ${cls}가 없다`).toContain(cls);
    }
  });

  /**
   * 화면이 표를 우회해 자기 클래스를 적기 시작하면 위 단정 전부가 조용히 무의미해
   * 진다. D-2가 `dividerTone.ts`에 대해 같은 이유로 같은 단정을 둔다.
   */
  it("카드가 표를 우회하지 않는다", () => {
    expect(agentCard).toContain("APPROVAL_NOTE_TONE_CLASS[note.tone]");
    // 노트 줄이 쓰던 옛 삼항 사슬. 남아 있으면 표와 화면이 갈라진 것이다.
    expect(agentCard).not.toContain('note.tone === "blocked" && "text-meta');
  });
});
