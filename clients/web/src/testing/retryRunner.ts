import type { Task } from "vitest";
import { VitestTestRunner } from "vitest/runners";
import { loadRegistry, retriesFor, type RetryRegistry } from "./retryRegistry";

/**
 * vitest 러너: 모든 시험의 재시도 횟수를 등록부(`test-retry.json`)로 정한다(#4708).
 *
 * 등록되고 기한 안인 시험만 1회 다시 돈다. **나머지는 전부 0 으로 덮어쓴다** — 시험 파일의 `{ retry }` 옵션, 설정의 `test.retry`,
 * CLI `--retry` 로도 등록부를 우회하지 못한다. `vite.config.ts` 의 `test.runner` 가 이 파일을 가리킨다.
 *
 * `retry` 는 `onBeforeRunTask` 다음에 읽힌다(@vitest/runner `runTest`) — 그래서 여기가 시험 하나 단위로 정할 수 있는 유일한 자리다.
 */
let registry: RetryRegistry | null = null;

/** vitest 가 실패 줄에 찍는 문장과 같다: `<파일> > <describe> > <시험>`. */
export function testIdOf(task: Task): string {
  const names = [task.name];
  for (let suite = task.suite; suite; suite = suite.suite) {
    if (suite.name) names.unshift(suite.name);
  }
  names.unshift(task.file.name);
  return names.join(" > ");
}

export default class RetryRegistryRunner extends VitestTestRunner {
  override async onBeforeRunTask(task: Task): Promise<void> {
    await super.onBeforeRunTask(task);
    if (task.type !== "test") return;
    registry ??= loadRegistry();
    task.retry = retriesFor(registry, testIdOf(task), Date.now());
  }
}
