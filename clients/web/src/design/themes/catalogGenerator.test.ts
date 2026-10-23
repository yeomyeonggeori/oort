import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { THEME_CATALOG, THEME_CATALOG_UPSTREAM } from "@momo/core/design/themeCatalog.generated";
import { THEME_CATALOG_INDEX } from "@momo/core/design/themeCatalogIndex.generated";
import {
  CATALOG_DEFS,
  CATALOG_FORBIDDEN,
  buildCatalog,
  parseNotice,
  parseShikiModule,
  readTgz,
  renderCatalogTs,
  renderIndexTs,
  sha256Hex,
  type CatalogInputs,
  type EntryDef,
} from "../../../scripts/lib/catalogBuild";

// =============================================================================
// 카탈로그 생성기 (ADR-0189 증보 3 D1, AP-1b #4188, AC 1·10). 규칙 전체를 **가짜 입력**(작은 tarball·NOTICE·테마
// 모듈)으로 잰다: 허용 목록·금지 이름·모드 일치·출력 모양·결정성, 그리고 fail-closed(GPL 픽스처를 주입하면 실패).
// 진짜 입력(shiki 4.1.0 · tm-themes 1.12.12 tarball)이 있는 기계에서는 `THEME_CATALOG_FROM=<dir>`로 커밋본과 **바이트
// 동일** 재생성도 잰다. 그 입력은 레포에 없다: tm-themes tarball이 GPL-3.0 테마 파일(aurora-x)을 안에 들고 있어서
// 커밋하지 않는다. 그 대신 항상 도는 두 가지가 있다: 커밋된 생성물이 생성기의 표(`CATALOG_DEFS`)와 어긋나지 않는지,
// 커밋된 생성물이 생성기가 자기 데이터로 다시 쓴 것과 글자까지 같은지(수정·정렬 훼손 탐지).
// =============================================================================

const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../../../../");

// ---- 가짜 입력 도구 ---------------------------------------------------------------

/** ustar 한 항목. 체크섬은 체크섬 칸을 공백으로 두고 바이트를 더한 값이다. */
function tarEntry(path: string, body: string): Uint8Array {
  const data = new TextEncoder().encode(body);
  const header = new Uint8Array(512);
  const put = (offset: number, text: string) => header.set(new TextEncoder().encode(text), offset);
  put(0, path);
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${data.length.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(148, "        ");
  header[156] = "0".charCodeAt(0);
  put(257, "ustar\0");
  put(263, "00");
  const sum = header.reduce((total, byte) => total + byte, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
  padded.set(data);
  const out = new Uint8Array(512 + padded.length);
  out.set(header);
  out.set(padded, 512);
  return out;
}

function tgzOf(files: Record<string, string>): Uint8Array {
  const parts = Object.entries(files).map(([path, body]) => tarEntry(`package/${path}`, body));
  const end = new Uint8Array(1024);
  const tar = new Uint8Array(parts.reduce((n, p) => n + p.length, 0) + end.length);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  tar.set(end, offset);
  return gzipSync(tar);
}

const hexOf = (six: string) => `#${six}`;

function moduleText(name: string, theme: unknown): string {
  return `/* Theme: ${name} */\nexport default Object.freeze(JSON.parse(${JSON.stringify(JSON.stringify(theme))}))`;
}

function themeJson(bg: string, fg: string, extra: Record<string, unknown> = {}) {
  return { colors: { "editor.background": hexOf(bg), "editor.foreground": hexOf(fg) }, ...extra };
}

const RULE = "=".repeat(105);
const THIN = "-".repeat(105);

function noticeBlock(files: string[], spdx: string, repo: string, body = "Permission is hereby granted."): string {
  return [
    RULE,
    `Files:   ${files.map((name) => `${name}.json`).join(", ")}`,
    `License: https://raw.githubusercontent.com/${repo}/main/LICENSE`,
    `SPDX:    ${spdx}`,
    THIN,
    body,
    "",
  ].join("\n");
}

const NOTICE_HEAD = "THIRD-PARTY SOFTWARE NOTICES AND INFORMATION\n\nThe following files/folders contain third party software:\n\n";

function inputsOf(
  themes: Record<string, unknown>,
  blocks: string[],
  over: Partial<CatalogInputs> = {}
): CatalogInputs {
  return {
    themeModules: new Map(Object.entries(themes).map(([name, theme]) => [name, moduleText(name, theme)])),
    noticeText: NOTICE_HEAD + blocks.join("\n"),
    upstream: {
      shiki: { version: "9.9.9", sha256: "a".repeat(64) },
      tm: { version: "8.8.8", sha256: "b".repeat(64) },
    },
    ...over,
  };
}

const PAIR: EntryDef = { id: "pair-a", label: "Pair A", light: "pair-a-light", dark: "pair-a-dark" };
const DARK: EntryDef = { id: "dark-b", label: "Dark B", dark: "dark-b" };
const LIGHT: EntryDef = { id: "light-c", label: "Light C", light: "light-c" };

const GOOD_THEMES = {
  "pair-a-light": themeJson("fafafa", "222222", { tokenColors: [{ scope: "comment", settings: { foreground: hexOf("8899aa") } }] }),
  "pair-a-dark": themeJson("101820", "e6e6e6"),
  "dark-b": themeJson("1a1a2e", "dddddd"),
  "light-c": themeJson("ffffff", "333333"),
};
const GOOD_BLOCKS = [
  noticeBlock(["pair-a-light", "pair-a-dark"], "MIT", "owner-a/repo-a"),
  noticeBlock(["dark-b"], "Apache-2.0", "owner-b/repo-b"),
  noticeBlock(["light-c"], "ISC", "owner-c/repo-c"),
];

describe("tarball 읽기", () => {
  it("npm tarball을 메모리에서 풀고 첫 경로 조각(package/)을 뗀다", () => {
    const gz = tgzOf({ "package.json": '{"name":"x"}', "dist/a.mjs": "export default 1", NOTICE: "n".repeat(700) });
    const files = readTgz(gz);
    expect([...files.keys()].sort()).toEqual(["NOTICE", "dist/a.mjs", "package.json"]);
    expect(new TextDecoder().decode(files.get("dist/a.mjs"))).toBe("export default 1");
    expect(new TextDecoder().decode(files.get("NOTICE"))).toBe("n".repeat(700));
  });

  it("sha256은 입력 바이트의 것이다", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
  });
});

describe("shiki 테마 모듈", () => {
  it("모듈 텍스트에서 테마 객체를 꺼낸다 (코드를 실행하지 않는다)", () => {
    const parsed = parseShikiModule(moduleText("t", themeJson("101820", "e6e6e6")));
    expect(parsed.name).toBe("t");
    expect(parsed.theme).toEqual(themeJson("101820", "e6e6e6"));
  });

  it("모양이 다르면 던진다 — 임의 코드가 든 모듈을 읽지 않는다", () => {
    expect(() => parseShikiModule("process.exit(1)")).toThrow(/모양/);
    expect(() =>
      parseShikiModule('/* Theme: x */\nexport default Object.freeze(JSON.parse("{}")); process.exit(1);')
    ).toThrow(/모양/);
  });
});

describe("NOTICE 읽기", () => {
  it("블록마다 파일 목록·SPDX·저장소·본문을 읽는다", () => {
    const blocks = parseNotice(NOTICE_HEAD + GOOD_BLOCKS.join("\n"));
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toMatchObject({
      files: ["pair-a-light.json", "pair-a-dark.json"],
      spdx: "MIT",
      repo: "owner-a/repo-a",
      text: "Permission is hereby granted.",
    });
  });

  it("머리가 틀린 블록과 저장소를 읽을 수 없는 License URL은 던진다 (fail-closed)", () => {
    expect(() => parseNotice(`${NOTICE_HEAD}${RULE}\nFiles: a.json\n${THIN}\nbody\n`)).toThrow(/머리/);
    const bad = noticeBlock(["a"], "MIT", "x/y").replace("raw.githubusercontent.com", "example.com");
    expect(() => parseNotice(NOTICE_HEAD + bad)).toThrow(/저장소/);
  });
});

describe("buildCatalog: 가짜 입력으로 규칙 전체", () => {
  const defs = [DARK, LIGHT, PAIR];

  it("쌍은 한 항목, 단일 모드는 없는 모드를 복제하지 않는다", () => {
    const out = buildCatalog(inputsOf(GOOD_THEMES, GOOD_BLOCKS), defs);
    expect(out.entries.map((e) => e.id)).toEqual(["dark-b", "light-c", "pair-a"]);
    const [dark, light, pair] = out.entries;
    expect(dark.light).toBeUndefined();
    expect(dark.dark).toMatchObject({ bg: hexOf("1a1a2e"), fg: hexOf("dddddd") });
    expect(light.dark).toBeUndefined();
    expect(pair.light).toBeDefined();
    expect(pair.dark).toBeDefined();
    expect(Object.keys(dark.source)).toEqual(["dark"]);
    expect(Object.keys(pair.source).sort()).toEqual(["dark", "light"]);
  });

  it("출처에 원본 이름·저장소·SPDX를 싣는다", () => {
    const out = buildCatalog(inputsOf(GOOD_THEMES, GOOD_BLOCKS), defs);
    expect(out.entries[0].source.dark).toEqual({ theme: "dark-b", repo: "owner-b/repo-b", spdx: "Apache-2.0" });
    expect(out.entries[1].source.light).toEqual({ theme: "light-c", repo: "owner-c/repo-c", spdx: "ISC" });
  });

  it("tokenColors만 있는 테마에서 comment를 읽는다 (Buzz 결함 비이식, AC 7)", () => {
    const out = buildCatalog(inputsOf(GOOD_THEMES, GOOD_BLOCKS), defs);
    expect(out.entries[2].light?.comment).toBe(hexOf("8899aa"));
  });

  it("출력은 결정적이다: 같은 입력은 같은 세 문자열이다", () => {
    const a = buildCatalog(inputsOf(GOOD_THEMES, GOOD_BLOCKS), defs);
    const b = buildCatalog(inputsOf(GOOD_THEMES, GOOD_BLOCKS), defs);
    expect([a.catalogTs, a.indexTs, a.noticesTxt]).toEqual([b.catalogTs, b.indexTs, b.noticesTxt]);
  });

  it("출력 모양: 헤더(생성 표시·재생성 명령·상류 버전과 sha256)·항목·색인 한 줄·상류 고지", () => {
    const out = buildCatalog(inputsOf(GOOD_THEMES, GOOD_BLOCKS), defs);
    expect(out.catalogTs).toContain("GENERATED by clients/web/scripts/gen-theme-catalog.ts");
    expect(out.catalogTs).toContain("npm --prefix clients/web run gen:theme-catalog -- --from <dir>");
    expect(out.catalogTs).toContain("@shikijs/themes@9.9.9 sha256:" + "a".repeat(64));
    expect(out.catalogTs).toContain("tm-themes@8.8.8 sha256:" + "b".repeat(64));
    expect(out.catalogTs).toContain("block/buzz desktop/src/shared/theme/theme-loader.ts @ af5bb0a");
    expect(out.indexTs).toContain('export const THEME_CATALOG_INDEX = "dark-b:d light-c:l pair-a:b";');
    expect(out.noticesTxt).toContain("Upstream projects: 3");
    expect(out.noticesTxt).toContain("Upstream: owner-a/repo-a");
    expect(out.noticesTxt).toContain("Themes used: pair-a-dark, pair-a-light");
    expect(out.noticesTxt).toContain("Permission is hereby granted.");
  });

  it("상류 고지는 쓰인 상류만 싣는다 (쓰이지 않는 블록은 들어오지 않는다)", () => {
    const unused = noticeBlock(["never-used"], "MIT", "owner-z/repo-z");
    const out = buildCatalog(inputsOf(GOOD_THEMES, [...GOOD_BLOCKS, unused]), defs);
    expect(out.noticesTxt).not.toContain("owner-z/repo-z");
    expect(out.noticesTxt).toContain("Upstream projects: 3");
  });

  it("허용 라이선스는 MIT · Apache-2.0 · BSD · ISC다 (BSD-3-Clause도 선다)", () => {
    const blocks = [
      noticeBlock(["pair-a-light", "pair-a-dark"], "BSD-3-Clause", "owner-a/repo-a"),
      noticeBlock(["dark-b"], "BSD-2-Clause", "owner-b/repo-b"),
      noticeBlock(["light-c"], "ISC", "owner-c/repo-c"),
    ];
    expect(() => buildCatalog(inputsOf(GOOD_THEMES, blocks), defs)).not.toThrow();
  });
});

describe("fail-closed: 조용히 건너뛰는 길이 없다 (red proof)", () => {
  const defs = [DARK, LIGHT, PAIR];
  const run = (themes: Record<string, unknown>, blocks: string[], list = defs) =>
    buildCatalog(inputsOf(themes, blocks), list);

  it("GPL 픽스처 하나를 주입하면 생성기가 실패한다 (AC 1)", () => {
    const gpl = [
      noticeBlock(["pair-a-light", "pair-a-dark"], "MIT", "owner-a/repo-a"),
      noticeBlock(["dark-b"], "GPL-3.0", "marqu3ss/Aurora-X", "GNU GENERAL PUBLIC LICENSE"),
      noticeBlock(["light-c"], "ISC", "owner-c/repo-c"),
    ];
    expect(() => run(GOOD_THEMES, gpl)).toThrow(/dark-b.*GPL-3\.0.*허용 목록/);
  });

  it.each(["GPL-3.0", "AGPL-3.0", "LGPL-2.1", "MIT OR GPL-3.0", "Unlicense", "UNKNOWN", "mit"])(
    "허용 목록 밖 SPDX %s는 실패한다",
    (spdx) => {
      const blocks = [GOOD_BLOCKS[0], noticeBlock(["dark-b"], spdx, "owner-b/repo-b"), GOOD_BLOCKS[2]];
      expect(() => run(GOOD_THEMES, blocks)).toThrow(/허용 목록/);
    }
  );

  it.each(Object.keys(CATALOG_FORBIDDEN))("금지 이름 %s가 표에 있으면 NOTICE가 MIT라고 해도 실패한다 (이름으로도 막는다)", (name) => {
    const themes = { ...GOOD_THEMES, [name]: themeJson("101820", "e6e6e6") };
    const blocks = [...GOOD_BLOCKS, noticeBlock([name], "MIT", "owner-x/repo-x")];
    const forbidden: EntryDef = { id: "forbidden-x", label: "Forbidden", dark: name };
    expect(() => run(themes, blocks, [...defs, forbidden])).toThrow(/들어올 수 없다/);
  });

  it("표의 테마가 NOTICE에 없으면 실패한다", () => {
    expect(() => run(GOOD_THEMES, GOOD_BLOCKS.slice(0, 2))).toThrow(/NOTICE에 .*light-c.*블록이 없다/);
  });

  it("표의 테마 모듈이 입력에 없으면 실패한다", () => {
    const { "dark-b": _gone, ...rest } = GOOD_THEMES;
    expect(() => run(rest, GOOD_BLOCKS)).toThrow(/dark-b.*모듈이 입력에 없다/);
  });

  it("라이트 칸에 어두운 바탕이(또는 반대로) 들어 있으면 실패한다 — type 필드가 아니라 휘도로 가른다", () => {
    const swapped = { ...GOOD_THEMES, "pair-a-light": themeJson("101820", "e6e6e6", { type: "light" }) };
    expect(() => run(swapped, GOOD_BLOCKS)).toThrow(/pair-a-light.*light 칸.*dark/);
    const swapped2 = { ...GOOD_THEMES, "dark-b": themeJson("ffffff", "000000", { type: "dark" }) };
    expect(() => run(swapped2, GOOD_BLOCKS)).toThrow(/dark-b.*dark 칸.*light/);
  });

  it("colors가 없는 테마는 실패하고, 배경·글자 한쪽만 없는 테마는 Buzz처럼 기본색으로 선다", () => {
    expect(() => run({ ...GOOD_THEMES, "dark-b": {} }, GOOD_BLOCKS)).toThrow(/dark-b.*읽을 수 없다/);
    const noFg = { ...GOOD_THEMES, "dark-b": { colors: { "editor.background": hexOf("262335") } } };
    const out = run(noFg, GOOD_BLOCKS);
    expect(out.entries[0].dark).toMatchObject({ bg: hexOf("262335"), fg: hexOf("d4d4d4") });
  });

  it("id가 겹치거나 문법이 틀리거나 모드가 없거나 같은 원본이 두 번 쓰이면 실패한다", () => {
    expect(() => run(GOOD_THEMES, GOOD_BLOCKS, [DARK, DARK])).toThrow(/id가 겹친다/);
    expect(() => run(GOOD_THEMES, GOOD_BLOCKS, [{ ...DARK, id: "Dark_B" }])).toThrow(/id 문법/);
    expect(() => run(GOOD_THEMES, GOOD_BLOCKS, [{ id: "none", label: "None" }])).toThrow(/모드가 하나도 없다/);
    expect(() => run(GOOD_THEMES, GOOD_BLOCKS, [DARK, { id: "dark-copy", label: "Copy", dark: "dark-b" }])).toThrow(
      /두 번 쓰였다/
    );
  });
});

describe("생성기의 표(CATALOG_DEFS)와 커밋된 생성물", () => {
  it("41항목 · 57 테마-모드 · 쌍 16 · 라이트 단독 1 · 다크 단독 24이고 id 순이며 금지 이름이 없다", () => {
    expect(CATALOG_DEFS).toHaveLength(41);
    const slots = CATALOG_DEFS.flatMap((d) => [d.light, d.dark].filter((n): n is string => n !== undefined));
    expect(slots).toHaveLength(57);
    expect(new Set(slots).size).toBe(57);
    expect(CATALOG_DEFS.filter((d) => d.light && d.dark)).toHaveLength(16);
    expect(CATALOG_DEFS.filter((d) => d.light && !d.dark)).toHaveLength(1);
    expect(CATALOG_DEFS.filter((d) => !d.light && d.dark)).toHaveLength(24);
    const ids = CATALOG_DEFS.map((d) => d.id);
    expect(ids).toEqual([...ids].sort());
    for (const name of Object.keys(CATALOG_FORBIDDEN)) expect(slots).not.toContain(name);
    expect(Object.keys(CATALOG_FORBIDDEN).sort()).toEqual(["aurora-x", "buzz", "buzz-dark", "slack-dark", "slack-ochin"]);
  });

  it("커밋된 카탈로그의 id·라벨·원본 이름이 표와 한 칸씩 같다", () => {
    expect(THEME_CATALOG.map((e) => e.id)).toEqual(CATALOG_DEFS.map((d) => d.id));
    CATALOG_DEFS.forEach((def, i) => {
      const entry = THEME_CATALOG[i];
      expect([entry.id, entry.label]).toEqual([def.id, def.label]);
      expect([entry.id, entry.source.light?.theme]).toEqual([def.id, def.light]);
      expect([entry.id, entry.source.dark?.theme]).toEqual([def.id, def.dark]);
    });
  });

  it("커밋된 생성물은 생성기가 자기 데이터로 다시 쓴 것과 글자까지 같다 (손으로 고친 흔적·정렬 훼손 탐지)", () => {
    const inputs = inputsOf({}, [], {
      upstream: {
        shiki: { version: THEME_CATALOG_UPSTREAM.shikiThemes.version, sha256: THEME_CATALOG_UPSTREAM.shikiThemes.tgzSha256 },
        tm: { version: THEME_CATALOG_UPSTREAM.tmThemes.version, sha256: THEME_CATALOG_UPSTREAM.tmThemes.tgzSha256 },
      },
    });
    const root = REPO_ROOT;
    const catalogFile = readFileSync(join(root, "packages/momo-core/src/design/themeCatalog.generated.ts"), "utf8");
    const indexFile = readFileSync(join(root, "packages/momo-core/src/design/themeCatalogIndex.generated.ts"), "utf8");
    expect(renderCatalogTs(THEME_CATALOG, inputs)).toBe(catalogFile);
    expect(renderIndexTs(THEME_CATALOG)).toBe(indexFile);
    expect(THEME_CATALOG_INDEX).toBe(indexFile.match(/THEME_CATALOG_INDEX = "([^"]+)"/)![1]);
  });

  // 진짜 입력이 있을 때만 도는 시험이다(환경 변수가 없으면 건너뛴다). PR 본문에 이 시험의 실행 원문을 적는다.
  it.skipIf(!process.env.THEME_CATALOG_FROM)(
    "진짜 tarball(THEME_CATALOG_FROM)에서 다시 만들면 커밋본과 바이트 동일하다 (AC 1)",
    () => {
      const dir = resolve(process.env.THEME_CATALOG_FROM!);
      const find = (prefix: string) => {
        const hits = readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".tgz"));
        expect(hits, `${dir}의 ${prefix}*.tgz`).toHaveLength(1);
        return readFileSync(join(dir, hits[0]));
      };
      const shiki = find("shikijs-themes-");
      const tm = find("tm-themes-");
      const shikiFiles = readTgz(shiki);
      const tmFiles = readTgz(tm);
      const decode = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
      const version = (files: Map<string, Uint8Array>) => JSON.parse(decode(files.get("package.json"))).version as string;
      const themeModules = new Map<string, string>();
      for (const [path, bytes] of shikiFiles) {
        const found = /^dist\/([\w-]+)\.mjs$/.exec(path);
        if (found && found[1] !== "index") themeModules.set(found[1], decode(bytes));
      }
      const built = buildCatalog({
        themeModules,
        noticeText: decode(tmFiles.get("NOTICE")),
        upstream: {
          shiki: { version: version(shikiFiles), sha256: sha256Hex(shiki) },
          tm: { version: version(tmFiles), sha256: sha256Hex(tm) },
        },
      });
      const root = REPO_ROOT;
      const read = (rel: string) => readFileSync(join(root, rel), "utf8");
      expect(existsSync(join(root, "legal/generated/THEME_PALETTE_NOTICES.txt"))).toBe(true);
      expect(built.catalogTs).toBe(read("packages/momo-core/src/design/themeCatalog.generated.ts"));
      expect(built.indexTs).toBe(read("packages/momo-core/src/design/themeCatalogIndex.generated.ts"));
      expect(built.noticesTxt).toBe(read("legal/generated/THEME_PALETTE_NOTICES.txt"));
    }
  );
});
