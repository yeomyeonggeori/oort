import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { avatarSurfaceClass } from "@/features/common/avatarTone";
import {
  AVATAR_SHAPE,
  AVATAR_SIZE,
} from "@momo/core/features/workspace/avatar";
import {
  MESSAGE_AVATAR_GUTTER_CLASS,
  MESSAGE_AVATAR_SIZE_CLASS,
} from "./spacing";

// =============================================================================
// 코어의 아바타 숫자가 화면의 클래스와 갈라지지 않는가 (진단 H-11)
//
// `spacing.test.ts` 와 같은 다리 검사다. 코어는 32라는 숫자를 갖고 웹은 `size-8`
// 이라는 클래스를 갖는데, 그 둘을 잇는 것은 사람의 기억뿐이다. U4-4R W-1 이
// 실측한 값이 정확히 그 기억이 틀렸을 때의 비용이었다: 클래스는 있었고 CSS 규칙은
// 없었으며, 화면은 0px 이었다.
//
// 그래서 여기서는 **컴파일된 스케일**을 읽는다. `tokens.css` 의 `--spacing-8` 이
// 코어의 32와 같은지, 그리고 행이 실제로 그 단계를 쓰는지.
// =============================================================================

const tokensCss = readFileSync(
  new URL("../../design/tokens.css", import.meta.url),
  "utf8"
);
const messageRow = readFileSync(
  new URL("./MessageRow.tsx", import.meta.url),
  "utf8"
);
const pendingRow = readFileSync(
  new URL("./PendingRow.tsx", import.meta.url),
  "utf8"
);

function spacingStep(step: string): number {
  const match = tokensCss.match(
    new RegExp(`--spacing-${step}:\\s*(\\d+(?:\\.\\d+)?)px`)
  );
  if (match === null) {
    throw new Error(
      `tokens.css 에 --spacing-${step} 이 없다. 이 레포의 스케일은 고정이라 ` +
        "표에 없는 단계는 클래스 이름만 있고 CSS 규칙이 없다 (U4-4R W-1)"
    );
  }
  return Number(match[1]);
}

describe("아바타 크기 다리", () => {
  it("코어의 AVATAR_SIZE 가 이 레포의 컴파일되는 한 단계다", () => {
    // 리듬 단계 8(32)도 그대로 32다. 다만 타임라인의 아바타는 이제 리듬 단계가 아니라 밀도를 따르는
    // 이름 단계(`--spacing-message-avatar`)를 읽는다(AP-2a #4189): 「편하게」(기본) 값이 AVATAR_SIZE다.
    expect(spacingStep("8")).toBe(AVATAR_SIZE);
    expect(spacingStep("message-avatar")).toBe(AVATAR_SIZE);
  });

  it("행과 대기행이 그 단계를 쓴다: 아바타와 거터가 같은 한 변이다", () => {
    // 두 클래스는 같은 이름 단계를 읽는다. 거터가 아바타보다 좁으면 이니셜이 잘리고, 넓으면 본문이
    // 이유 없이 밀린다.
    expect(MESSAGE_AVATAR_SIZE_CLASS).toBe("size-message-avatar");
    expect(MESSAGE_AVATAR_GUTTER_CLASS).toBe("w-message-avatar");
    expect(MESSAGE_AVATAR_SIZE_CLASS.replace("size-", "")).toBe(
      MESSAGE_AVATAR_GUTTER_CLASS.replace("w-", "")
    );
    // 공용 Avatar의 기본은 그대로 size-8이다(디렉터리·받은편지함 등 대화 밖의 얼굴은 밀도를 따르지 않는다).
    expect(messageRow).toContain("flex size-8 items-center");
    expect(messageRow).toContain('cn("relative shrink-0", MESSAGE_AVATAR_GUTTER_CLASS)');
    expect(pendingRow).toContain('cn("shrink-0", MESSAGE_AVATAR_GUTTER_CLASS)');
    expect(messageRow).toContain("className={MESSAGE_AVATAR_SIZE_CLASS}");
    expect(pendingRow).toContain("className={MESSAGE_AVATAR_SIZE_CLASS}");
    // 손으로 적은 `w-8` 거터로 되돌아오면 밀도를 바꿔도 거터만 32에 남는다.
    expect(messageRow).not.toContain('className="relative w-8 shrink-0"');
    expect(pendingRow).not.toContain('className="w-8 shrink-0"');
  });

  it("대화 밀도의 아바타 크기를 받는 곳은 타임라인 행과 설정 미리보기뿐이다", () => {
    // `Avatar`는 디렉터리·다이얼로그·받은편지함이 함께 쓴다. 거기까지 `size-message-avatar`가 번지면
    // 「대화 밀도」가 목록의 얼굴까지 키우고 줄인다. 이름 단계를 쓰는 파일을 전부 열거한다.
    const srcDir = fileURLToPath(new URL("../..", import.meta.url));
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          if (/size-message-avatar|w-message-avatar|MESSAGE_AVATAR_(SIZE|GUTTER)_CLASS/.test(text)) {
            found.push(relative(srcDir, full));
          }
        }
      }
    };
    walk(srcDir);
    expect(found.sort()).toEqual([
      "features/settings/shell/ConversationPreview.tsx",
      "features/timeline/MessageRow.tsx",
      "features/timeline/PendingRow.tsx",
      "features/timeline/spacing.ts",
    ]);
  });

  it("24px 로 되돌아가지 않는다: 그 크기에서는 아바타로 읽히지 않았다", () => {
    expect(AVATAR_SIZE).toBeGreaterThan(spacingStep("6"));
    expect(messageRow).not.toContain("size-6 items-center justify-center");
  });
});

describe("정체는 색 말고 모양으로도 선다", () => {
  it("사람은 원, 에이전트는 둥근 사각", () => {
    expect(AVATAR_SHAPE.human).toBe("round");
    expect(AVATAR_SHAPE.agent).toBe("rounded-square");
    expect(messageRow).toContain('identity.kind === "agent" ? "rounded-sm" : "rounded-full"');
  });

  it("모르는 작성자는 정체 색을 쓰지 않는다", () => {
    // `--agent` 도 `--accent` 도 아닌 중립 배경. 모양은 빌려도 색은 빌리지 않는다.
    // 채움·테두리는 공용 `avatarSurfaceClass`(#4148)가 정하고, unknown 갈래에는 어느 정체 색도 없다.
    expect(messageRow).toContain("avatarSurfaceClass(identity.kind, member?.id, imageSrc !== null)");
    const unknown = avatarSurfaceClass("unknown", "x");
    expect(unknown).not.toMatch(/agent|accent|signal|avatar-/);
    expect(unknown).toContain("text-ink-muted");
  });
});
