import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// =============================================================================
// 「공용 부품 밖」 잔량 (DS-02, #6017)
//
// 화면이 공용 부품(`design/ui`) 대신 손으로 그린 컨트롤이 **늘지 않게** 천장으로 막는다.
// 소스를 읽어 세고(수를 베끼지 않는다), 폴더 단위 천장보다 늘면 빨갛다. 줄면 통과하고
// 안내 줄만 찍는다 — 「0이 된 줄이 표에 남으면 빨강」은 걸지 않는다: 나란히 도는
// 칸이 같은 표를 고치면 착륙 순서가 서로를 빨갛게 만들기 때문이다(폰
// `designSystem.test.ts` 가 웹 쪽 표에 그 방향을 두지 않은 까닭과 같다).
//
// 천장 표는 이 파일 안 상수로 둔다: `chipVessel.test.ts` 의 `RESIDUE` 와 같은 관례이고,
// 옮기는 칸이 시험과 같은 diff 에서 자기 폴더 줄만 낮춘다.
//
// 세는 단위는 다섯이다(주석·문자열 속 글자는 세지 않도록 TypeScript 구문 트리로 읽는다):
//   button   손 <button>
//   input    손 <input>  (체크·라디오 포함)
//   textarea 손 <textarea>
//   dialogPad <DialogContent> 에 p-* 여백을 덮어쓴 자리
//   outline  variant="outline" (공용 단추의 옛 변형 이름)
//
// 범위: src/features, src/app 의 시험이 아닌 .tsx. 새 폴더는 표에 없으면 0 천장이다.
// =============================================================================

const WEB_SRC = fileURLToPath(new URL("..", import.meta.url));

const KINDS = ["button", "input", "textarea", "dialogPad", "outline"] as const;
type Kind = (typeof KINDS)[number];

/** 폴더(`features/<이름>` · `app`) -> 종류별 천장. 표에 없는 종류·폴더는 0. */
const CEILING: Readonly<Record<string, Partial<Record<Kind, number>>>> = {
  "app": { button: 3 },
  "features/ade": { button: 5 },
  "features/agentHub": { button: 4, input: 2, textarea: 2 },
  "features/agents": { button: 10 },
  "features/aiHub": { button: 3, input: 1, dialogPad: 3 },
  "features/attachments": { button: 6, input: 1, outline: 1 },
  "features/auth": { button: 4 },
  "features/channels": { button: 2, input: 1, dialogPad: 1, outline: 13 },
  "features/chat": { button: 12, textarea: 1 },
  "features/common": { button: 1, outline: 3 },
  "features/directory": { button: 4, outline: 4 },
  "features/downloads": { button: 2 },
  "features/drafts": { button: 1 },
  "features/emoji": { button: 5, dialogPad: 1, outline: 1 },
  "features/expressions": { button: 10, input: 5, textarea: 2 },
  "features/github": { input: 3, textarea: 1, dialogPad: 1 },
  "features/hostedAgents": { button: 1, input: 1, textarea: 1 },
  "features/huddles": { button: 3, input: 1, outline: 1 },
  "features/inbox": { button: 2, textarea: 1 },
  "features/memory": { button: 7, textarea: 1, dialogPad: 1 },
  "features/plugins": { button: 1, input: 1 },
  "features/releaseNotes": { dialogPad: 1 },
  "features/reminders": { button: 1, textarea: 1, dialogPad: 3 },
  "features/routing": { button: 1, input: 1 },
  "features/scheduled": { button: 2, textarea: 1, dialogPad: 4 },
  "features/search": { outline: 3 },
  "features/settings": { button: 12, input: 13, textarea: 1, dialogPad: 5 },
  "features/sidebar": { button: 19, input: 1, dialogPad: 5, outline: 7 },
  "features/timeline": { button: 30, input: 1, textarea: 2, dialogPad: 3, outline: 5 },
  "features/welcome": { button: 6, input: 1, dialogPad: 3, outline: 7 },
  "features/work": { button: 13, textarea: 1 },
  "features/workbench": { button: 14, input: 1, textarea: 2, dialogPad: 2 },
  "features/workConsole": { button: 2 },
  "features/workspace": { button: 1, outline: 6 },
  "features/workTab": { button: 5 },
};

/** 종류마다 대신 쓸 공용 부품. 실패 문장이 이것을 이름으로 가리킨다. */
const SHARED: Readonly<Record<Kind, string>> = {
  button: "Button(design/ui/button)",
  input: "Input(design/ui/input) · 켜고 끄기는 Switch",
  textarea: "Input 과 같은 입력 그릇(공용 여러 줄 부품은 아직 없다)",
  dialogPad: "DialogContent 의 기본 여백(className 의 p-* 를 빼기)",
  outline: 'Button variant="secondary"',
};

const fix = (kind: Kind): string =>
  `공용 부품을 쓰거나(${SHARED[kind]}), 고유 표면이면 표를 올리고 이유를 적는다`;

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.tsx$/.test(p) && !/\.test\.tsx$/.test(p)) out.push(p);
  }
  return out;
}

function folderOf(rel: string): string {
  const parts = rel.split("/");
  return parts[0] === "features" ? `features/${parts[1]}` : parts[0];
}

// `p-4` `px-2` `md:pt-1` `!p-0` 등 여백 유틸. `placeholder-` `pointer-` 는 `p` 뒤가 달라 걸리지 않는다.
const PAD = /(^|[\s:!"'`])-?p[xytblrse]?-[\w[]/;

function countFile(src: string): Record<Kind, number> {
  const c: Record<Kind, number> = {
    button: 0,
    input: 0,
    textarea: 0,
    dialogPad: 0,
    outline: 0,
  };
  const sf = ts.createSourceFile("f.tsx", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const visit = (n: ts.Node): void => {
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText(sf);
      if (tag === "button" || tag === "input" || tag === "textarea") c[tag]++;
      if (tag === "DialogContent") {
        const cls = n.attributes.properties.find(
          (a): a is ts.JsxAttribute =>
            ts.isJsxAttribute(a) && a.name.getText(sf) === "className"
        );
        if (cls?.initializer && PAD.test(cls.initializer.getText(sf))) c.dialogPad++;
      }
    }
    if (
      ts.isJsxAttribute(n) &&
      n.name.getText(sf) === "variant" &&
      n.initializer &&
      ts.isStringLiteral(n.initializer) &&
      n.initializer.text === "outline"
    )
      c.outline++;
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return c;
}

function sweep(): { files: number; byFolder: Map<string, Record<Kind, number>> } {
  const byFolder = new Map<string, Record<Kind, number>>();
  let files = 0;
  for (const root of ["features", "app"]) {
    for (const f of walk(join(WEB_SRC, root))) {
      files++;
      const folder = folderOf(relative(WEB_SRC, f));
      const cur =
        byFolder.get(folder) ??
        ({ button: 0, input: 0, textarea: 0, dialogPad: 0, outline: 0 } as Record<Kind, number>);
      const got = countFile(readFileSync(f, "utf8"));
      for (const k of KINDS) cur[k] += got[k];
      byFolder.set(folder, cur);
    }
  }
  return { files, byFolder };
}

describe("공용 부품 밖 잔량 천장 (#6017)", () => {
  const { files, byFolder } = sweep();

  it("소스를 실제로 읽었다 — 읽은 파일이 0이면 실패", () => {
    expect(files).toBeGreaterThan(0);
    expect(byFolder.size).toBeGreaterThan(0);
    // 훑기가 눈멀지 않았다는 증거: 천장 표의 합이 0이 아니면 실제 수도 0일 수 없다.
    const total = KINDS.reduce(
      (s, k) => s + [...byFolder.values()].reduce((a, r) => a + r[k], 0),
      0
    );
    expect(total).toBeGreaterThan(0);
  });

  for (const kind of KINDS) {
    it(`${kind}: 폴더마다 천장을 넘지 않는다`, () => {
      const over: string[] = [];
      const room: string[] = [];
      for (const [folder, row] of [...byFolder].sort(([a], [b]) => a.localeCompare(b))) {
        const cap = CEILING[folder]?.[kind] ?? 0;
        if (row[kind] > cap) over.push(`${folder}: ${row[kind]} > 천장 ${cap}`);
        else if (row[kind] < cap) room.push(`${folder}: ${row[kind]} < 천장 ${cap}`);
      }
      if (room.length > 0)
        console.info(`[${kind}] 천장보다 낮아진 폴더 — 옮기는 칸이 낮춘다: ${room.join(" · ")}`);
      expect(over, `[${kind}] 손으로 그린 것이 늘었다 — ${fix(kind)}`).toEqual([]);
    });
  }
});
