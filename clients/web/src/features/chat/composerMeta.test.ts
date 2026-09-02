import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composerMetaMode, keepPhoneDmHint } from "./composerMeta";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const composer = source("./Composer.tsx");
const typingLine = source("./TypingLine.tsx");

describe("컴포저 공유 액션 슬롯 (U-8 · #1749)", () => {
  it("넓은 화면에서 힌트와 작성 중 문장을 같은 액션 슬롯으로 스왑한다", () => {
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

    expect(composerMetaMode(phoneIdle)).toBe("empty");
    expect(composerMetaMode({ ...phoneIdle, typistCount: 1 })).toBe("typing");
    expect(composerMetaMode(phoneIdle)).toBe("empty");
  });

  it("폰 DM 안내는 타이핑 행 위에서 시작·종료 내내 상시 유지한다", () => {
    const phoneDm = {
      typistCount: 0,
      hasDmHint: true,
      keysHintNeeded: true,
      isMobile: true,
    };

    expect(keepPhoneDmHint(phoneDm)).toBe(true);
    expect(composerMetaMode(phoneDm)).toBe("empty");
    expect(composerMetaMode({ ...phoneDm, typistCount: 1 })).toBe("typing");
    expect(keepPhoneDmHint(phoneDm)).toBe(true);
    expect(composerMetaMode(phoneDm)).toBe("empty");
  });

  it("링크 자리표시가 남아 있으면 작성 중이 아닐 때 힌트 슬롯을 연다", () => {
    expect(
      composerMetaMode({
        typistCount: 0,
        hasDmHint: false,
        keysHintNeeded: false,
        isMobile: true,
        hasPendingLink: true,
      })
    ).toBe("hint");
    expect(
      composerMetaMode({
        typistCount: 1,
        hasDmHint: false,
        keysHintNeeded: false,
        isMobile: false,
        hasPendingLink: true,
      })
    ).toBe("typing");
  });

  it("힌트·작성 중·빈 판은 액션 행의 가로 슬롯만 쓰고 예약 세로 행을 만들지 않는다", () => {
    expect(composer).toContain(
      '"min-w-0 flex-1 truncate text-right text-meta text-ink-muted"'
    );
    expect(typingLine).toContain(
      '"flex min-w-0 flex-1 items-baseline justify-end overflow-hidden text-meta"'
    );
    expect(composer).toContain(
      'data-composer-meta-slot={sharedRow ? "" : undefined}'
    );
    expect(typingLine.match(/data-composer-meta-slot=""/g)).toHaveLength(2);
    expect(typingLine).not.toContain("composer-typing-reserved");
    expect(typingLine).not.toContain('{"\\u200b"}');
    expect(typingLine).toContain('aria-hidden="true"');
    expect(composer).toMatch(
      /data-testid="composer-actions"[\s\S]*?<ComposerHint[\s\S]*?<TypingLine/
    );
    expect(composer).toContain("COMPOSER_FORMAT_LINK_HINT");
    expect(composer).toContain("composerFormatHasPendingLink");
    expect(composer).toContain('data-testid="composer-link-hint"');
  });
});
