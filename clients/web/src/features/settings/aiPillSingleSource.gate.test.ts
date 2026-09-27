import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// 같은 판정은 한 곳에서 (#2941 GC-0, brief §3.5).
//
// 설정 › AI 연결, 채팅 연결 카드(#2944), 폰 카드(GC-4)가 서로 다른 상태를 말할
// 길을 구조로 막는다. 알약의 판정 낱말(「확인 실패」「연결 안 됨」「자격증명
// 없음」)과 판정 함수 정의는 코어 `aiLinkPill.ts`에만 있다. 클라이언트 트리에
// 지역 사본이 생기면 이 시험이 실패한다.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../../..");
const ROOTS = [join(REPO, "clients/web/src"), join(REPO, "clients/mobile/src")];

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "dist") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) acc.push(path);
  }
  return acc;
}

/** 판정 함수의 지역 정의. 이름을 바꿔 숨겨도 판정 낱말 묶음이 잡는다. */
const LOCAL_JUDGE = /\bfunction\s+(linkPill|harnessPillView)\b|\b(const|let)\s+(linkPill|harnessPillView)\s*=/;
/** 팀 연결 판정에만 쓰이는 낱말. 한 파일에 둘 이상이면 판정표 사본이다. */
const VERDICT_WORDS = ["\"확인 실패\"", "\"자격증명 없음\"", "\"모의 응답\"", "\"확인할 수 없음\""];

function offenders(files: readonly string[], read: (path: string) => string): string[] {
  const out: string[] = [];
  for (const path of files) {
    const source = read(path);
    if (LOCAL_JUDGE.test(source)) {
      out.push(`${relative(REPO, path)}: 판정 함수 지역 정의`);
      continue;
    }
    const hits = VERDICT_WORDS.filter((word) => source.includes(word));
    if (hits.length >= 2) out.push(`${relative(REPO, path)}: 판정 낱말 ${hits.join(", ")}`);
  }
  return out;
}

describe("AI 연결 알약 판정은 코어 한 곳 (#2941)", () => {
  const files = ROOTS.flatMap((root) => walk(root));

  it("웹·폰 트리에 판정 사본이 없다", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(offenders(files, (path) => readFileSync(path, "utf8"))).toEqual([]);
  });

  it("사본을 넣으면 잡는다(가드가 실패할 수 있다)", () => {
    const fake = join(REPO, "clients/web/src/features/chat/Fake.tsx");
    const copies: Record<string, string> = {
      a: "function linkPill(link) { return null }",
      b: 'const t = ok ? "확인됨" : "확인 실패"; const u = "자격증명 없음";',
      c: "const harnessPillView = (p) => p;",
    };
    for (const body of Object.values(copies)) {
      expect(offenders([fake], () => body)).toHaveLength(1);
    }
  });

  it("설정의 두 절이 코어 판정을 import한다", () => {
    const link = readFileSync(join(HERE, "AiLinkSection.tsx"), "utf8");
    const mine = readFileSync(join(HERE, "AiMyAccountsSection.tsx"), "utf8");
    expect(link).toMatch(/from "@momo\/core\/features\/settings\/aiLinkPill"/);
    expect(mine).toMatch(/from "@momo\/core\/features\/settings\/aiLinkPill"/);
  });
});
