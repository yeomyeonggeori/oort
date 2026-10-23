import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { THEME_CATALOG } from "@momo/core/design/themeCatalog.generated";

// =============================================================================
// 카탈로그의 귀속과 라이선스 (ADR-0189 증보 3 D1·D9, AP-1b #4188, AC 10). 생성물(`themeCatalog.generated.ts`)의
// 출처와 `legal/` 파일들이 서로 어긋나지 않는지, Buzz 코드 차용이 Apache-2.0 §4(b)대로 표시됐는지를 잰다.
// 허용 목록·금지 이름 규칙 자체는 `catalogGenerator.test.ts`가 가짜 입력으로 잰다.
// =============================================================================

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

const THIRD_PARTY = read("legal/THIRD_PARTY_NOTICES.md");
const NOTICES = read("legal/generated/THEME_PALETTE_NOTICES.txt");

/** 항목들의 출처를 상류 저장소별로 묶는다: repo → { spdx, themes }. */
function upstreams() {
  const byRepo = new Map<string, { spdx: Set<string>; themes: Set<string> }>();
  for (const entry of THEME_CATALOG) {
    for (const ref of Object.values(entry.source)) {
      const found = byRepo.get(ref.repo) ?? { spdx: new Set<string>(), themes: new Set<string>() };
      found.spdx.add(ref.spdx);
      found.themes.add(ref.theme);
      byRepo.set(ref.repo, found);
    }
  }
  return byRepo;
}

/** `legal/THIRD_PARTY_NOTICES.md`의 「Theme palette seeds」 표를 행으로 읽는다. */
function indexRows() {
  const start = THIRD_PARTY.indexOf("### Theme palette seeds (theme catalog)");
  expect(start).toBeGreaterThan(0);
  const end = THIRD_PARTY.indexOf("\n### ", start + 10);
  const section = THIRD_PARTY.slice(start, end);
  return section
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Upstream") && !line.startsWith("|---"))
    .map((line) => line.split("|").slice(1, -1).map((cell) => cell.trim()));
}

const fold = (text: string) =>
  text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/©/g, "(c)")
    .replace(/[<>]/g, "")
    .toLowerCase();

describe("상류 고지: 생성된 전문 파일(THEME_PALETTE_NOTICES.txt)", () => {
  it("쓰인 상류 25곳을 한 곳씩 싣고, 모든 source.repo가 거기 있다", () => {
    const repos = [...upstreams().keys()];
    expect(repos).toHaveLength(25);
    expect(NOTICES).toContain("Upstream projects: 25");
    expect(NOTICES.match(/^Upstream: /gm)).toHaveLength(25);
    for (const repo of repos) expect(NOTICES, repo).toContain(`Upstream: ${repo}\n`);
  });

  it("각 절은 SPDX·License URL·쓰인 테마·본문 라이선스를 든다", () => {
    for (const [repo, { spdx, themes }] of upstreams()) {
      const at = NOTICES.indexOf(`Upstream: ${repo}\n`);
      const section = NOTICES.slice(at, NOTICES.indexOf("\nUpstream: ", at + 10) === -1 ? undefined : NOTICES.indexOf("\nUpstream: ", at + 10));
      expect(section, repo).toContain(`SPDX: ${[...spdx][0]}`);
      expect(section, repo).toContain(`License: https://raw.githubusercontent.com/${repo}/`);
      for (const theme of themes) expect(section, `${repo} ${theme}`).toContain(theme);
      expect(section.length, repo).toBeGreaterThan(900); // 본문(MIT는 약 1KB, Apache-2.0은 약 11KB)이 실제로 있다.
    }
  });

  it("GPL 본문과 허용 밖 라이선스는 한 글자도 없다 (aurora-x 부재)", () => {
    expect(NOTICES).not.toMatch(/GNU GENERAL PUBLIC LICENSE/i);
    expect(NOTICES).not.toMatch(/GPL/);
    expect(NOTICES.toLowerCase()).not.toContain("aurora");
    expect(NOTICES).not.toMatch(/SPDX: (?!MIT|Apache-2\.0|ISC|BSD-2-Clause|BSD-3-Clause)/);
  });

  it("MIT 52 · Apache-2.0 5 테마가 절마다 맞게 적혔다", () => {
    const counts: Record<string, number> = {};
    for (const { spdx, themes } of upstreams().values()) counts[[...spdx][0]] = (counts[[...spdx][0]] ?? 0) + themes.size;
    expect(counts).toEqual({ MIT: 52, "Apache-2.0": 5 });
  });
});

describe("색인: legal/THIRD_PARTY_NOTICES.md (이미지에 복사되는 색인 파일)", () => {
  it("표가 카탈로그의 상류와 한 곳씩 같다: 저장소·SPDX·쓰인 테마", () => {
    const rows = indexRows();
    const expected = upstreams();
    expect(rows).toHaveLength(25);
    expect(new Set(rows.map((row) => row[0]))).toEqual(new Set(expected.keys()));
    for (const [repo, spdx, , themes] of rows) {
      const found = expected.get(repo)!;
      expect([repo, spdx]).toEqual([repo, [...found.spdx][0]]);
      expect([repo, themes.split(", ").sort()]).toEqual([repo, [...found.themes].sort()]);
    }
  });

  it("표의 저작권 표기는 상류 전문 파일의 표기와 같다 (표기를 지어내지 않았다)", () => {
    for (const [repo, , copyright] of indexRows()) {
      const at = NOTICES.indexOf(`Upstream: ${repo}\n`);
      const next = NOTICES.indexOf("\nUpstream: ", at + 10);
      const section = fold(NOTICES.slice(at, next === -1 ? undefined : next));
      for (const part of copyright.split(" / ")) {
        expect(section, `${repo}: ${part}`).toContain(fold(part));
      }
    }
  });

  it("aurora-x(GPL-3.0)는 표에도 설명에도 없다", () => {
    const start = THIRD_PARTY.indexOf("### Theme palette seeds (theme catalog)");
    const end = THIRD_PARTY.indexOf("\n### ", start + 10);
    expect(THIRD_PARTY.slice(start, end).toLowerCase()).not.toContain("aurora");
  });

  it("전문 파일로 가는 링크와 재생성 명령이 적혀 있다", () => {
    expect(THIRD_PARTY).toContain("generated/THEME_PALETTE_NOTICES.txt");
    expect(THIRD_PARTY).toContain("npm --prefix clients/web run gen:theme-catalog -- --from <dir>");
  });
});

describe("Buzz 코드 차용 표시 (Apache-2.0 §4(b), ADR-0189 증보 3 D9)", () => {
  const buzzRow = THIRD_PARTY.split("\n").find((line) => line.startsWith("| Buzz desktop")) ?? "";

  it("Buzz 행이 「설계만」에서 「코드 차용」으로 고쳐졌다: 파일·커밋·저작권·변경점을 든다", () => {
    expect(buzzRow).not.toBe("");
    expect(buzzRow).not.toContain("Design only; no source file or CSS is copied");
    expect(buzzRow).toContain("Code adapted");
    expect(buzzRow).toContain("af5bb0a");
    expect(buzzRow).toContain("Copyright 2026 Block, Inc.");
    expect(buzzRow).toContain("desktop/src/shared/theme/adaptive-theme.ts");
    expect(buzzRow).toContain("desktop/src/shared/theme/theme-loader.ts");
    expect(buzzRow).toContain("section 4(b)");
    // 우리 쪽 파일 이름을 든다.
    for (const file of ["derive.ts", "themeSeed.ts", "catalogBuild.ts"]) expect(buzzRow).toContain(file);
  });

  it.each([
    "packages/momo-core/src/design/derive.ts",
    "packages/momo-core/src/design/themeSeed.ts",
    "clients/web/scripts/lib/catalogBuild.ts",
  ])("%s 머리에 출처 파일·커밋·라이선스·저작권·변경 요약이 있다", (file) => {
    const head = read(file).split("\n").slice(0, 40).join("\n");
    expect(head).toContain("Adapted from block/buzz");
    expect(head).toContain("af5bb0a");
    expect(head).toContain("Apache-2.0");
    expect(head).toContain("Copyright 2026 Block, Inc.");
    expect(head).toMatch(/Changed by oort.*§4\(b\)/s);
  });

  it("생성물 머리도 출처(목록·쌍)를 적는다", () => {
    const head = read("packages/momo-core/src/design/themeCatalog.generated.ts").split("\n").slice(0, 12).join("\n");
    expect(head).toContain("block/buzz desktop/src/shared/theme/theme-loader.ts @ af5bb0a");
    expect(head).toContain("Apache-2.0, Copyright 2026 Block, Inc.");
  });

  it("루트 NOTICE가 Buzz 차용과 테마 고지의 위치를 가리킨다", () => {
    const notice = read("NOTICE");
    expect(notice).toContain("Buzz (https://github.com/block/buzz, commit af5bb0a, Apache-2.0, Copyright 2026 Block, Inc.)");
    expect(notice).toContain("legal/generated/THEME_PALETTE_NOTICES.txt");
    expect(notice).toContain("legal/THIRD_PARTY_NOTICES.md");
  });
});

describe("이미지에 복사되는 파일의 해시 (CI `alignment` 잡의 --stale-only가 같은 것을 잰다)", () => {
  it("GHCR_NOTICE_BUNDLE.sha256이 지금의 NOTICE·THIRD_PARTY_NOTICES.md와 맞는다", () => {
    const sums = Object.fromEntries(
      read("legal/generated/GHCR_NOTICE_BUNDLE.sha256")
        .trim()
        .split("\n")
        .map((line) => {
          const [hash, name] = line.split(/\s+/);
          return [name, hash];
        })
    );
    const sha = (rel: string) => createHash("sha256").update(readFileSync(join(ROOT, rel))).digest("hex");
    expect(sums["NOTICE"]).toBe(sha("NOTICE"));
    expect(sums["THIRD_PARTY_NOTICES.md"]).toBe(sha("legal/THIRD_PARTY_NOTICES.md"));
  });
});
