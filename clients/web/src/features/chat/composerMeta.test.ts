import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { composerMetaMode, keepPhoneDmHint } from "./composerMeta";

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const composer = source("./Composer.tsx");
const typingLine = source("./TypingLine.tsx");
const tokens = readFileSync(
  fileURLToPath(new URL("../../design/tokens.css", import.meta.url)),
  "utf8"
);

describe("컴포저 공유 액션 슬롯 (U-8 · #1749)", () => {
  it("넓은 화면에서는 힌트, 폰은 키 힌트 없이 빈 슬롯이다", () => {
    const idle = { hasDmHint: false, keysHintNeeded: true, isMobile: false };
    expect(composerMetaMode(idle)).toBe("hint");
    expect(composerMetaMode({ ...idle, isMobile: true })).toBe("empty");
  });

  it("폰 DM 안내는 공유 슬롯 밖에서 상시 유지한다", () => {
    const phoneDm = { hasDmHint: true, keysHintNeeded: true, isMobile: true };
    expect(keepPhoneDmHint(phoneDm)).toBe(true);
    expect(composerMetaMode(phoneDm)).toBe("empty");
  });

  it("링크 자리표시가 남아 있으면 폰에서도 힌트 슬롯을 연다", () => {
    expect(
      composerMetaMode({
        hasDmHint: false,
        keysHintNeeded: false,
        isMobile: true,
        hasPendingLink: true,
      })
    ).toBe("hint");
  });

  it("힌트·빈 판은 액션 행의 가로 슬롯만 쓰고 예약 세로 행을 만들지 않는다", () => {
    expect(composer).toContain(
      '"min-w-0 flex-1 truncate text-right text-meta text-ink-muted"'
    );
    expect(composer).toContain(
      'data-composer-meta-slot={sharedRow ? "" : undefined}'
    );
    expect(composer).toMatch(/data-testid="composer-meta-empty"\s+data-composer-meta-slot=""/);
    // 액션 행은 한 부품(`ComposerCard`)이 그리고(#5324) 가운데 슬롯(`meta`)에 힌트 줄을 채널 입력창이 넘긴다.
    expect(composer).toMatch(/meta=\{[\s\S]*?<ComposerHint[\s\S]*?composer-meta-empty/);
    expect(readFileSync(fileURLToPath(new URL("./ComposerCard.tsx", import.meta.url)), "utf8")).toMatch(
      /\$\{testIdPrefix\}-actions[\s\S]*?\{tools\}[\s\S]*?\{meta\}[\s\S]*?\{send\}/
    );
    expect(composer).toContain("COMPOSER_FORMAT_LINK_HINT");
    expect(composer).toContain("composerFormatHasPendingLink");
    expect(composer).toContain('data-testid="composer-link-hint"');
  });
});

describe("「입력 중」은 카드 아래 늘 잡아 둔 한 줄이다 (#5567)", () => {
  it("남의 입력은 공유 슬롯을 바꾸지 않는다: 슬롯 판정에 입력 중인 사람 수가 들어가지 않는다", () => {
    expect(composer).not.toMatch(/composerMetaMode\(\{[^}]*typist/);
    // 줄은 액션 행(`meta`) 안이 아니라 카드 **뒤**, 같은 폼 안이다.
    expect(composer).toMatch(/<\/ComposerCard>\s*\{\/\*[\s\S]*?\*\/\}\s*<TypingLine memberIds=\{typists\} directory=\{directory\} \/>\s*<\/form>/);
    expect(composer).not.toMatch(/meta=\{[\s\S]*?<TypingLine[\s\S]*?send=\{/);
  });

  it("줄은 아무도 치지 않을 때도 서 있고(높이 = text-meta 행간), 넓은 창에서는 카드 아래 여백 18을 그 줄이 맡는다", () => {
    // 줄 상자는 조건 없이 그려지고, 안의 문장만 서고 진다.
    expect(typingLine).toMatch(/return \(\s*<div\s+className="typing-line"/);
    expect(typingLine).toMatch(/\{parts !== null && \(/);
    const utility = /@utility typing-line \{([\s\S]*?)\n\}/.exec(tokens)?.[1] ?? "";
    expect(utility).toMatch(/block-size: var\(--text-meta--line-height\);/);
    expect(utility).toMatch(/overflow: hidden;/);
    expect(tokens).toMatch(/--text-meta--line-height: calc\(var\(--type-rem\) \* 1\.125\);/);
    // 폼의 아래 여백은 0이다. 폰 폭은 `pb-0`, 넓은 창은 독 규칙이 정한다.
    expect(composer).toContain('className="relative p-3 pb-0 data-rail:pt-0"');
    expect(tokens).toMatch(/& > form \{\s*padding: var\(--spacing-2\) var\(--spacing-6\) 0;\s*\}/);
  });

  it("live 영역이 아니고, 보이는 조각은 aria-hidden 이며 온전한 문장은 sr-only 하나다", () => {
    expect(typingLine).not.toContain("aria-live");
    expect(typingLine).not.toContain('role="status"');
    expect(typingLine.match(/aria-hidden="true"/g)).toHaveLength(2);
    expect(typingLine).toContain('className="sr-only" data-testid="composer-typing-label"');
  });
});
