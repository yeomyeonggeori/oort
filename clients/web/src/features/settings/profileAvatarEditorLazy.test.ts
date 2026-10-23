import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 아바타 편집기는 **지연 청크**다 (#4261): 설정 화면에서만 쓰이는 코드(캔버스 포트, 팔레트, 코메토 타일, 이모지 패널 배선,
// 미리보기)가 메인 청크를 키우지 않는다는 이슈 조건이다. 번들러는 정적 import 가 하나라도 있으면 그 모듈을 메인에 넣는다.
// 그래서 이 파일은 히어로 쪽 두 파일(`ProfileAvatarField.tsx`, `shell/ProfileHero.tsx`)의 가져오기 줄을 읽어
//   · 편집기 디렉터리(`./avatarEditor/…`)와 편집기 코어 모듈(판정·팔레트·그리기 모델)을 **값으로** 가져오는 줄이 없고,
//   · 편집기를 실제로 `import()` 로 부른다는 것
// 을 지킨다. 주석은 걷는다(왜 못 가져오는지를 적는 문장이 자기 스캔에 걸리지 않게).

function read(rel: string): string {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[ \t]*\/\/.*$/gm, "");
}

/** 정적 import 선언 전부. `import type …` 은 번들에 남지 않으므로 값 가져오기만 돌려준다. */
function valueImports(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/^import\s+([^;]*?)\s+from\s+["']([^"']+)["'];?/gms)) {
    const clause = match[1];
    if (/^type\s/.test(clause.trim())) continue;
    out.push(match[2]);
  }
  for (const match of source.matchAll(/^import\s+["']([^"']+)["'];?/gm)) out.push(match[1]);
  return out;
}

const HEAVY = [
  /avatarEditor\//, // 편집기 디렉터리 (대화상자, 포트, 훅)
  /workspace\/avatarEditor$/, // 코어: 그리기 모델과 편집기 문구 본체
  /workspace\/avatarContrast$/,
  /workspace\/avatarPalette$/,
  /workspace\/avatarPng$/,
  /memberAvatarCopy$/, // 올리기 오류 문구는 편집기와 같이 들어온다
  /uploadMyAvatar$/,
];

describe("아바타 편집기는 지연 청크다 (메인 청크를 키우지 않는다)", () => {
  for (const file of ["./ProfileAvatarField.tsx", "./shell/ProfileHero.tsx"]) {
    it(`${file.replace("./", "")} 는 편집기 쪽 모듈을 값으로 가져오지 않는다`, () => {
      const imports = valueImports(read(file));
      expect(imports.length).toBeGreaterThan(0); // 스캐너가 아무것도 못 읽고 통과하지 않게
      for (const specifier of imports) {
        for (const heavy of HEAVY) {
          expect(heavy.test(specifier), `${file} 가 ${specifier} 를 정적으로 가져온다`).toBe(false);
        }
      }
    });
  }

  it("히어로 필드는 편집기를 import() 로만 부르고, 그 디렉터리에서는 타입만 가져온다", () => {
    const source = read("./ProfileAvatarField.tsx");
    expect(source).toMatch(/import\(\s*["']\.\/avatarEditor\/AvatarEditorDialog["']\s*\)/);
    expect(source).toMatch(/import type \{[^}]*\} from "\.\/avatarEditor\/AvatarEditorDialog"/);
  });

  it("스캐너가 실제로 위반을 잡는다: 값 가져오기는 보이고 type 가져오기는 안 보인다", () => {
    const sample = [
      'import { a } from "./avatarEditor/AvatarEditorDialog";',
      'import type { B } from "./avatarEditor/AvatarEditorDialog";',
      'import { c } from "@momo/core/features/workspace/avatarEditor";',
      'import "./avatarEditor/avatarEditor.css";',
    ].join("\n");
    expect(valueImports(sample)).toEqual([
      "./avatarEditor/AvatarEditorDialog",
      "@momo/core/features/workspace/avatarEditor",
      "./avatarEditor/avatarEditor.css",
    ]);
  });

  it("여는 자리의 문구 모듈(avatarEditorCopy)은 무거운 모듈을 가져오지 않는다", () => {
    const copy = readFileSync(
      fileURLToPath(new URL("../../../../../packages/momo-core/src/features/workspace/avatarEditorCopy.ts", import.meta.url)),
      "utf8"
    );
    expect(valueImports(copy.replace(/\/\/.*$/gm, ""))).toEqual([]);
  });
});
