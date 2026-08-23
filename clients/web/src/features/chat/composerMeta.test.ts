import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composerMetaMode, keepPhoneDmHint } from "./composerMeta";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const composer = source("./Composer.tsx");
const typingLine = source("./TypingLine.tsx");
const tokens = source("../../design/tokens.css");

function tokenPx(name: string): number {
  const match = tokens.match(
    new RegExp(`^\\s*--${name}:\\s*([\\d.]+)(px|rem);`, "m")
  );
  if (!match) throw new Error(`tokens.css에 --${name}가 없다`);
  const value = Number(match[1]);
  return match[2] === "rem" ? value * 16 : value;
}

describe("컴포저 공유 메타 행 (U-8)", () => {
  it("넓은 화면에서 힌트와 작성 중 문장을 같은 행으로 스왑한다", () => {
    const idle = {
      typistCount: 0,
      hasDmHint: false,
      keysHintNeeded: true,
      isMobile: false,
    };

    expect(composerMetaMode(idle)).toBe("hint");
    expect(composerMetaMode({ ...idle, typistCount: 1 })).toBe("typing");
    expect(composerMetaMode(idle)).toBe("hint");
  });

  it("폰은 키 힌트 없이 같은 행을 예약하고 타이핑 배치를 유지한다", () => {
    const phoneIdle = {
      typistCount: 0,
      hasDmHint: false,
      keysHintNeeded: true,
      isMobile: true,
    };

    expect(composerMetaMode(phoneIdle)).toBe("reserved");
    expect(composerMetaMode({ ...phoneIdle, typistCount: 1 })).toBe("typing");
    expect(composerMetaMode(phoneIdle)).toBe("reserved");
  });

  it("폰 DM 안내는 타이핑 행 위에서 시작·종료 내내 상시 유지한다", () => {
    const phoneDm = {
      typistCount: 0,
      hasDmHint: true,
      keysHintNeeded: true,
      isMobile: true,
    };

    expect(keepPhoneDmHint(phoneDm)).toBe(true);
    expect(composerMetaMode(phoneDm)).toBe("reserved");
    expect(composerMetaMode({ ...phoneDm, typistCount: 1 })).toBe("typing");
    expect(keepPhoneDmHint(phoneDm)).toBe(true);
    expect(composerMetaMode(phoneDm)).toBe("reserved");
  });

  it("힌트·작성 중·예약 판은 모두 한 줄 26px 계약을 쓴다", () => {
    const lineHeight = tokenPx("text-meta--line-height");
    const paddingBottom = tokenPx("spacing-2");

    expect(lineHeight).toBe(18);
    expect(paddingBottom).toBe(8);
    expect(lineHeight + paddingBottom).toBe(26);
    expect(composer).toContain(
      '"px-6 pb-2 text-meta text-ink-muted"'
    );
    expect(typingLine).toContain(
      '"flex items-baseline overflow-hidden px-6 pb-2 text-meta"'
    );
    expect(composer).toContain(
      'data-composer-meta-row={sharedRow ? "" : undefined}'
    );
    expect(typingLine.match(/data-composer-meta-row=""/g)).toHaveLength(2);
  });
});
