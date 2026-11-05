import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// 폰은 「지금 쓰는 중」 신호를 보내지 않는다 (ADR-0206 D4, 수용 기준 20, #4508).
//
// 앞에 있는 폰 앱은 OS가 배너를 내지 않는다(#2592·#4310). 폰이 이 신호를 보내면 서버가 폰 사용자를
// 「데스크탑을 쓰는 중」으로 읽고 **자기 폰 알림을 스스로 늦춘다**. 그래서 신호의 길(`activityBeat`
// 모듈, 그 안의 `holdActivityBeat`·`touchPresenceActivity`, 그리고 서버 경로 `presence/activity`)이
// 폰 트리에 한 글자라도 나타나면 이 시험이 실패한다. 폰이 읽는 「보고 있음」 신호(`readState/viewingBeat`)와는
// 별개 파일이라 그쪽은 해당 없다.
// =============================================================================

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "../../../../..");
const PHONE = join(REPO, "clients/mobile");

/** 신호의 길을 이루는 낱말. 하나라도 폰 소스에 있으면 폰이 보내는 길이 열린 것이다. */
const ACTIVITY_PATH = /presence\/activity|presence\/activityBeat|\bholdActivityBeat\b|\btouchPresenceActivity\b|\bActivityPort\b/;

function walk(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === "Pods" || entry === "build") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, acc);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry)) acc.push(path);
  }
  return acc;
}

function offenders(files: readonly string[], read: (path: string) => string): string[] {
  return files.filter((path) => ACTIVITY_PATH.test(read(path))).map((path) => relative(REPO, path));
}

describe("폰은 활동 신호를 보내지 않는다 (#4508, 수용 기준 20)", () => {
  // 시험은 폰의 소스와 폰 시험 둘 다 본다: 폰 시험이 신호를 부르는 것도 폰이 그 길을 쓴다는 뜻이다.
  const files = [...walk(join(PHONE, "src")), ...walk(join(PHONE, "__tests__"))];

  it("폰 트리에 신호의 길이 없다", () => {
    // 트리를 못 찾아 빈 목록을 훑은 「초록」이 아님을 먼저 증명한다.
    expect(files.length).toBeGreaterThan(100);
    expect(offenders(files, (path) => readFileSync(path, "utf8"))).toEqual([]);
  });

  it("길이 생기면 잡는다(가드가 실패할 수 있다)", () => {
    const fake = join(PHONE, "src/features/presence/Fake.ts");
    const bodies = [
      "import { holdActivityBeat } from '@momo/core/features/presence/activityBeat';",
      "const url = `/v1/workspaces/${ws}/presence/activity`;",
      "await touchPresenceActivity(workspaceId);",
      "const port: ActivityPort = makePort();",
    ];
    for (const body of bodies) {
      expect(offenders([fake], () => body)).toHaveLength(1);
    }
    // 폰이 쓰는 「보고 있음」 신호의 낱말은 잡지 않는다.
    expect(
      offenders([fake], () => "import { holdChannelViewing } from '@momo/core/features/readState/viewingBeat';")
    ).toEqual([]);
  });
});
