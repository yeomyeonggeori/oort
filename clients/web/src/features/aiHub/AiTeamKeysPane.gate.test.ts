import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// 「기본 AI」 표의 「고르지 않으면」 문장은 서버가 실제로 하는 일을 옮긴 것이다(AIH-6, #3400).
// 서버 코드가 바뀌면(예: 채널 요약에 폴백이 생기면) 이 시험이 먼저 실패해서 문장을 다시 쓰게 한다.

const REPO = join(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const summary = readFileSync(join(REPO, "server-rust/bins/momo-agent-worker/src/summary.rs"), "utf8");
const worker = readFileSync(join(REPO, "server-rust/bins/momo-agent-worker/src/lib.rs"), "utf8");

describe("서버의 기본 AI 해석(코드 확인)", () => {
  it("채널 요약: 줄이 없으면 모델을 부르지 않는다(다른 걸로 대신 가지 않는다)", () => {
    expect(summary).toContain("DefaultAiOutcome::NotApplicable => SummaryModel::NotConfigured");
    expect(summary).toContain("REASON_NO_SUMMARY_ROW");
  });

  it("팀 에이전트·첫 인사: 줄이 없으면 턴은 그대로 간다(맨 위 키)", () => {
    expect(worker).toContain("/// The agent has its own model, or no row is stored: the turn is unchanged.");
    expect(worker).toMatch(/is_welcome\(\) \{\s*DefaultAiRole::Summary/);
    expect(worker).toMatch(/let Some\(row\) = rows[\s\S]{0,80}else \{\s*return DefaultAiOutcome::NotApplicable;/);
  });
});
