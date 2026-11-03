import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// =============================================================================
// #5260: 웹의 제품 소스에는 **원인을 가리지 않는 연결 끊김 문장**이 손으로 적혀 있지 않다.
//
// 막힌 자리의 문장은 사전 틀(`blocked.<틀>.…`)이 원인(기기 오프라인 · 서버에 닿지 못함)에 맞게 말한다(`BlockedReason`).
// 이 시험은 소스의 문자열·템플릿·JSX 글(주석 제외)에서 「연결이 끊」「오프라인」「연결이 없어요」를 찾아, 아래 허용 목록에
// 없는 것이 하나라도 있으면 멈춘다 — 새 자리가 옛 한 가지 문장을 되살리면 여기서 걸린다.
//
// 허용 목록은 **이유가 있는 항목만** 든다: 항목마다 소스에서 그 문장을 찾아야 하고(못 찾으면 낡은 항목이라 멈춘다),
// 이유는 「이 문장은 앱과 서버 사이의 연결을 말하는 것이 아니다」 또는 「원인이 확정이다」 둘 중 하나다.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const PATTERN = /연결이 끊|오프라인|연결이 없어요|끊겨/;
const SKIP = /(?:^|\/)(?:testing|__tests__|generated)(?:\/|$)|\.(?:test|spec|stories)\.[cm]?[jt]sx?$|\.d\.ts$/;

interface Allowed {
  readonly file: string;
  /** 소스에서 이 부분 문자열이 든 문장을 찾아야 한다. */
  readonly includes: string;
  readonly why: string;
}

const NOT_APP_SERVER = "앱과 서버 사이의 연결이 아니라 다른 대상(호스트·화면 스트림·토큰 만료·목록 이름·기기 상태)을 말한다";
const DEVICE_CERTAIN = "세션 앞의 화면이라 게이트가 브라우저 오프라인뿐이다: 원인은 기기 오프라인으로 확정이다";
const ALLOWED: readonly Allowed[] = [
  { file: "design/Gallery.tsx", includes: "연결이 끊겼습니다", why: "디자인 갤러리의 고정 견본이다(제품 화면이 아니다)" },
  { file: "features/agents/RequestThoughtLine.tsx", includes: "연결이 끊겼어요", why: "실시간 소켓(`!live`)이 끊긴 것을 말한다: 막지 않는 원인이고 문장도 그 원인 그대로다" },
  { file: "features/workbench/agent/agentPaneSource.tsx", includes: "새 진행을 받지 못하고", why: "실시간 소켓(`connStatus`)이 끊겨 새 진행을 받지 못하는 것을 말한다: 막지 않는 원인이고 문장도 그 원인 그대로다" },
  { file: "features/auth/ClaimPage.tsx", includes: "오프라인입니다", why: DEVICE_CERTAIN },
  { file: "features/auth/ClaimPage.tsx", includes: "오프라인 상태에서는", why: DEVICE_CERTAIN },
  { file: "features/auth/ConnectPage.tsx", includes: "오프라인입니다", why: DEVICE_CERTAIN },
  { file: "features/auth/ConnectPage.tsx", includes: "오프라인 상태에서는", why: DEVICE_CERTAIN },
  { file: "features/downloads/downloadsCopy.ts", includes: "연결이 끊겨 받지 못했어요", why: "내려받기 한 건의 네트워크 실패 분류다: 연결 상태 모델의 게이트가 아니다" },
  { file: "features/settings/DevAccessCreateForm.tsx", includes: "저절로 끊겨요", why: NOT_APP_SERVER },
  { file: "features/settings/DevAccessList.tsx", includes: "만든 연결이 없어요", why: NOT_APP_SERVER },
  { file: "features/settings/ThisMacHostBlock.tsx", includes: "등록됨, 오프라인", why: NOT_APP_SERVER },
  { file: "features/work/WorkPanel.tsx", includes: "연결이 끊긴 세션", why: NOT_APP_SERVER },
  { file: "features/work/WorkSessionDetail.tsx", includes: "호스트 연결이 끊긴", why: NOT_APP_SERVER },
  { file: "features/work/controlStream.ts", includes: "호스트 연결이 끊겨 이 세션을", why: NOT_APP_SERVER },
  { file: "features/work/controlStream.ts", includes: "호스트 연결이 끊겨 화면을 돌려", why: NOT_APP_SERVER },
  { file: "features/work/displayStream.ts", includes: "화면 연결이 끊겼습니다", why: NOT_APP_SERVER },
  { file: "features/work/displayStream.ts", includes: "호스트 연결이 끊겨 화면을", why: NOT_APP_SERVER },
  { file: "features/work/observerStream.ts", includes: "호스트 연결이 끊겨 관전할", why: NOT_APP_SERVER },
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? sourceFiles(join(dir, entry.name)) : [join(dir, entry.name)]
  );
}

interface Hit {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

/** 주석을 제외한 문자열·템플릿·JSX 글에서 패턴이 든 문장을 모은다. */
function scan(): Hit[] {
  const hits: Hit[] = [];
  for (const path of sourceFiles(SRC).sort()) {
    const file = relative(SRC, path).split("\\").join("/");
    if (!/\.[cm]?[jt]sx?$/.test(file) || SKIP.test(file)) continue;
    const text = readFileSync(path, "utf8");
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, /\.[jt]sx$/.test(file) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (node: ts.Node): void => {
      const literal =
        ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateHead(node) ||
        ts.isTemplateMiddle(node) ||
        ts.isTemplateTail(node) ||
        ts.isJsxText(node);
      if (literal && PATTERN.test(node.text)) {
        hits.push({ file, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.text.trim() });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return hits;
}

describe("웹 제품 소스: 원인을 가리지 않는 연결 끊김 문장이 없다 (#5260)", () => {
  const hits = scan();

  it("허용 목록 밖의 「연결이 끊」「오프라인」 문장이 없다", () => {
    const unexplained = hits.filter(
      (hit) => !ALLOWED.some((allowed) => allowed.file === hit.file && hit.text.includes(allowed.includes))
    );
    expect(unexplained.map((hit) => `${hit.file}:${hit.line} ${hit.text.slice(0, 60)}`)).toEqual([]);
  });

  it("허용 목록의 모든 항목이 소스에서 실제로 문장을 찾는다(낡은 항목이 남지 않는다)", () => {
    const stale = ALLOWED.filter(
      (allowed) => !hits.some((hit) => hit.file === allowed.file && hit.text.includes(allowed.includes))
    );
    expect(stale.map((allowed) => `${allowed.file} ${allowed.includes}`)).toEqual([]);
  });

  it("허용 항목마다 이유가 있다", () => {
    for (const allowed of ALLOWED) expect(allowed.why.length, allowed.file).toBeGreaterThan(10);
  });

  it("스캐너가 실제로 소스를 읽고 있다(0건 통과가 아니다)", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(500);
    expect(hits.length).toBeGreaterThanOrEqual(ALLOWED.length);
  });
});
