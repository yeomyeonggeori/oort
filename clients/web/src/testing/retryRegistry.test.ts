import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_REGISTRY_PATH,
  MAX_LIFETIME_DAYS,
  RETRY_ATTEMPTS,
  REGISTRY_PATH_ENV,
  endOfDayKst,
  parseRegistry,
  retriesFor,
  ruleProblems,
  shapeProblems,
  type RetryEntry,
} from "./retryRegistry";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "../..");

const entry = (over: Partial<RetryEntry> = {}): RetryEntry => ({
  id: "src/a.test.ts > suite > case",
  issue: 4708,
  since: "2026-10-28",
  expires: "2026-11-11",
  ...over,
});
const NOW = Date.parse("2026-11-01T12:00:00+09:00");

describe("재시도 등록부 (#4708) — 이슈가 달린 시험만 · 1회 · 2주", () => {
  it("올바른 모양이고 기한이 지난 항목이 없다 — 지나면 이 시험이 빨개져 등록부를 정리하게 한다", () => {
    const raw: unknown = JSON.parse(readFileSync(DEFAULT_REGISTRY_PATH, "utf8"));
    expect(shapeProblems(raw)).toEqual([]);
    expect(ruleProblems(parseRegistry(raw), Date.now())).toEqual([]);
  });

  it("재시도는 1회다", () => {
    expect(RETRY_ATTEMPTS).toBe(1);
    expect(MAX_LIFETIME_DAYS).toBe(14);
  });

  describe("규칙 함수는 나쁜 등록부를 실제로 잡는다", () => {
    it("등록된 시험만, 기한 날의 끝(한국 시간)까지 1회", () => {
      const registry = { entries: [entry()] };
      expect(retriesFor(registry, entry().id, NOW)).toBe(1);
      expect(retriesFor(registry, "src/a.test.ts > suite > other", NOW)).toBe(0);
      expect(retriesFor(registry, entry().id, Date.parse("2026-11-11T23:59:59+09:00"))).toBe(1);
      expect(retriesFor(registry, entry().id, Date.parse("2026-11-12T00:00:00+09:00"))).toBe(0);
    });

    it("만료된 항목은 재시도 0 이고 등록부 점검이 이름을 대며 빨개진다", () => {
      const registry = { entries: [entry({ expires: "2026-10-31", since: "2026-10-28" })] };
      expect(retriesFor(registry, entry().id, NOW)).toBe(0);
      expect(ruleProblems(registry, NOW).join("\n")).toContain("재시도 기한이 지났어요");
      expect(ruleProblems(registry, NOW).join("\n")).toContain(entry().id);
    });

    it("기한이 14일을 넘는 등록·중복·거꾸로 된 기한을 막는다", () => {
      expect(ruleProblems({ entries: [entry({ expires: "2026-11-12" })] }, NOW).join("\n")).toContain("14일을 넘어요");
      expect(ruleProblems({ entries: [entry(), entry()] }, NOW).join("\n")).toContain("중복 등록");
      expect(ruleProblems({ entries: [entry({ since: "2026-11-05", expires: "2026-11-01" })] }, NOW).join("\n")).toContain("앞서요");
    });

    it("이슈 없는 항목·횟수 키·존재하지 않는 날짜·엉뚱한 모양을 막는다", () => {
      expect(shapeProblems({ entries: [{ ...entry(), issue: 0 }] }).join("\n")).toContain("issue");
      expect(shapeProblems({ entries: [{ ...entry(), issue: "4708" }] }).join("\n")).toContain("issue");
      expect(shapeProblems({ entries: [{ ...entry(), retries: 3 }] }).join("\n")).toContain("키는 정확히");
      expect(shapeProblems({ entries: [], retries: 3 }).join("\n")).toContain("entries만");
      expect(shapeProblems({ entries: [{ ...entry(), expires: "2026-02-30" }] }).join("\n")).toContain("expires");
      expect(shapeProblems({ entries: [{ ...entry(), id: "no-separator" }] }).join("\n")).toContain("id");
      expect(shapeProblems([]).join("\n")).toContain("맨 위");
      expect(Number.isNaN(endOfDayKst("2026-13-01"))).toBe(true);
    });
  });

  it("실제 러너: 등록된 시험만 1회 다시 돈다 · 등록 밖·만료·시험 자신의 retry 옵션은 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "momo-retry-"));
    try {
      const file = "src/testing/retryFixture.test.ts";
      const id = (name: string) => `${file} > retry fixture > ${name}`;
      const registryPath = join(dir, "registry.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          entries: [
            { id: id("listed: fails once then passes"), issue: 4708, since: "2026-10-28", expires: "2999-01-01" },
            { id: id("listed: always fails"), issue: 4708, since: "2026-10-28", expires: "2999-01-01" },
            { id: id("expired: fails once then passes"), issue: 4708, since: "2026-10-01", expires: "2026-10-02" },
          ],
        })
      );
      const resultPath = join(dir, "result.json");
      const attemptsPath = join(dir, "attempts.json");
      const vitestBin = join(dirname(createRequire(import.meta.url).resolve("vitest/package.json")), "vitest.mjs");
      const env: NodeJS.ProcessEnv = { ...process.env };
      for (const key of Object.keys(env)) if (/^(VITEST|JEST)/.test(key)) delete env[key];
      const run = spawnSync(
        process.execPath,
        [vitestBin, "run", file, "--reporter=json", `--outputFile=${resultPath}`],
        {
          cwd: WEB_ROOT,
          encoding: "utf8",
          env: { ...env, [REGISTRY_PATH_ENV]: registryPath, MOMO_RETRY_FIXTURE_OUT: attemptsPath },
        }
      );
      const report = JSON.parse(readFileSync(resultPath, "utf8")) as {
        testResults: { assertionResults: { title: string; status: string }[] }[];
      };
      const status = Object.fromEntries(
        report.testResults.flatMap((fileResult) => fileResult.assertionResults).map((row) => [row.title, row.status])
      );
      const attempts = JSON.parse(readFileSync(attemptsPath, "utf8")) as Record<string, number>;
      expect(status).toEqual({
        "listed: fails once then passes": "passed",
        "listed: always fails": "failed",
        "unlisted: fails once then passes": "failed",
        "expired: fails once then passes": "failed",
        "unlisted with its own retry option: fails once then passes": "failed",
      });
      // 횟수: 등록된 시험은 첫 시도 + 재시도 1회 = 2. 나머지는 첫 시도 하나로 끝난다.
      expect(attempts).toEqual({
        "listed-flaky": 2,
        "listed-broken": 2,
        "unlisted-flaky": 1,
        "expired-flaky": 1,
        "option-flaky": 1,
      });
      expect(run.status).toBe(1); // 실패한 시험이 있으니 러너는 빨강으로 끝난다
      // 다시 돌아서 끝난 시험은 로그에 이슈 번호와 함께 남는다 — 재시도가 흔들림을 가리지 않는다.
      const log = `${run.stdout}\n${run.stderr}`;
      expect(log).toContain(`[test-retry] #4708 ${id("listed: fails once then passes")}`);
      expect(log).not.toContain(`[test-retry] #? `);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
