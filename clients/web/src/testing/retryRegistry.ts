import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 플레이키 재시도 등록부 (#4708, owner 결정 2026-10-28).
 *
 * 규칙은 이 파일 하나가 정한다 — 재시도는 **이슈가 달린 시험만, 1회, 2주 기한**이다. 전면 재시도는 진짜 경쟁 상태를 가린다.
 * 본업은 원인 결정화이고, 등록은 그 사이 CI 를 막지 않기 위한 임시 방편이다:
 *
 *   - `id`      시험 하나. `<파일 경로(clients/web 기준)> > <describe> > <시험 이름>` — vitest 가 실패 줄에 찍는 그 문장이다.
 *   - `issue`   그 시험의 플레이키를 추적하는 이슈 번호. 이슈 없이는 등록하지 않는다.
 *   - `since`   등록한 날(YYYY-MM-DD). `expires` 와의 간격이 14일을 넘지 못한다.
 *   - `expires` 마지막으로 재시도가 도는 날(YYYY-MM-DD, 한국 시간 하루의 끝까지). 지나면 러너가 **등록 밖으로 본다**(재시도 0)
 *               — 흔들림이 다시 빨강으로 보이게 하려는 것이다. 동시에 `retryRegistry.test.ts` 가 빨개져서 등록부를 정리하게 한다.
 *
 * 등록 밖 시험은 재시도 0 이다. 러너(`retryRunner.ts`)가 **모든** 시험의 `retry` 를 이 표로 덮어쓰므로 시험 파일의 `{ retry }` 옵션이나
 * CLI `--retry` 도 통하지 않는다. 한 번에 2회 이상은 없다(`RETRY_ATTEMPTS`).
 *
 * 등록하려면(최근 CI 빨강과 이슈가 있을 때만; 본업은 원인 결정화다) `clients/web/test-retry.json` 에 한 줄을 더한다:
 *
 *   { "id": "src/features/x/Y.test.tsx > describe 이름 > 시험 이름", "issue": 1234, "since": "2026-10-28", "expires": "2026-11-11" }
 *
 * 다시 돌아서 끝난 시험은 로그에 `[test-retry] #1234 …` 한 줄이 남는다. 폰(jest)은 `clients/mobile/test-retry.json` 과
 * `jest.retryRegistry.js` 가 같은 규칙이다.
 */
export const RETRY_ATTEMPTS = 1;
export const MAX_LIFETIME_DAYS = 14;

export interface RetryEntry {
  id: string;
  issue: number;
  since: string;
  expires: string;
}

export interface RetryRegistry {
  entries: RetryEntry[];
}

const HERE = dirname(fileURLToPath(import.meta.url));
/** 시험이 임시 등록부로 러너를 돌려 볼 수 있게 하는 이음매(`retryRegistry.test.ts`). 운영에서는 쓰지 않는다. */
export const REGISTRY_PATH_ENV = "MOMO_TEST_RETRY_REGISTRY";
export const DEFAULT_REGISTRY_PATH = join(HERE, "../../test-retry.json");

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_KEYS = ["id", "issue", "since", "expires"].sort();

/** `YYYY-MM-DD` 의 한국 시간 하루가 끝나는 순간(그날 23:59:59.999 KST). 잘못된 날짜면 NaN. */
export function endOfDayKst(date: string): number {
  if (!DATE_RE.test(date)) return Number.NaN;
  const instant = Date.parse(`${date}T23:59:59.999+09:00`);
  if (Number.isNaN(instant)) return Number.NaN;
  // 2026-02-30 같은 날은 Date.parse 가 NaN 이거나 다른 달로 굴린다 — 되읽어서 같은 날인지 본다.
  const back = new Date(instant + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  return back === date ? instant : Number.NaN;
}

export function isExpired(entry: RetryEntry, now: number): boolean {
  return !(now <= endOfDayKst(entry.expires));
}

/** 이 시험이 지금 몇 번 다시 돌 수 있는가: 등록돼 있고 기한 안이면 `RETRY_ATTEMPTS`, 아니면 0. */
export function retriesFor(registry: RetryRegistry, id: string, now: number): number {
  const entry = registry.entries.find((candidate) => candidate.id === id);
  if (!entry || isExpired(entry, now)) return 0;
  return RETRY_ATTEMPTS;
}

/** 등록부 모양이 틀렸으면 이유를 모아 돌려준다(던지지 않는다 — 시험이 이유를 그대로 보여 준다). */
export function shapeProblems(raw: unknown): string[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return ["등록부의 맨 위는 { entries: [...] } 하나여야 해요."];
  }
  const keys = Object.keys(raw);
  const out: string[] = [];
  if (keys.length !== 1 || keys[0] !== "entries") {
    out.push(`등록부의 맨 위에는 entries 만 있어야 해요(받은 키: ${keys.join(", ") || "없음"}). 재시도 횟수는 코드의 RETRY_ATTEMPTS 가 정해요.`);
  }
  const entries = (raw as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    out.push("entries 는 배열이어야 해요.");
    return out;
  }
  entries.forEach((entry, index) => {
    const label = `entries[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      out.push(`${label}: 객체여야 해요.`);
      return;
    }
    const shape = Object.keys(entry).sort();
    if (shape.join() !== ENTRY_KEYS.join()) {
      out.push(`${label}: 키는 정확히 ${ENTRY_KEYS.join(", ")} 이어야 해요(받은 키: ${shape.join(", ")}).`);
      return;
    }
    const e = entry as Record<string, unknown>;
    if (typeof e.id !== "string" || e.id.trim() === "" || !e.id.includes(" > ")) {
      out.push(`${label}.id: "<파일> > <describe> > <시험>" 모양의 문자열이어야 해요.`);
    }
    if (!Number.isInteger(e.issue) || (e.issue as number) <= 0) {
      out.push(`${label}.issue: 플레이키를 추적하는 이슈 번호(양의 정수)가 필요해요.`);
    }
    for (const field of ["since", "expires"] as const) {
      if (typeof e[field] !== "string" || Number.isNaN(endOfDayKst(e[field] as string))) {
        out.push(`${label}.${field}: 실제 날짜 YYYY-MM-DD 여야 해요.`);
      }
    }
  });
  return out;
}

export function parseRegistry(raw: unknown): RetryRegistry {
  const problems = shapeProblems(raw);
  if (problems.length > 0) throw new Error(`test-retry.json 이 올바르지 않아요:\n- ${problems.join("\n- ")}`);
  return raw as RetryRegistry;
}

export function loadRegistry(path = process.env[REGISTRY_PATH_ENV] ?? DEFAULT_REGISTRY_PATH): RetryRegistry {
  return parseRegistry(JSON.parse(readFileSync(path, "utf8")));
}

/** 모양이 맞는 등록부가 지켜야 할 나머지 규칙: 중복 없음 · 기한 14일 이내 · 만료 없음. 만료는 「정리하라」는 빨강이다. */
export function ruleProblems(registry: RetryRegistry, now: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of registry.entries) {
    if (seen.has(entry.id)) out.push(`중복 등록: ${entry.id}`);
    seen.add(entry.id);
    const span = (endOfDayKst(entry.expires) - endOfDayKst(entry.since)) / DAY_MS;
    if (!(span >= 0)) out.push(`기한이 등록일보다 앞서요: ${entry.id}`);
    else if (span > MAX_LIFETIME_DAYS) {
      out.push(`기한이 ${MAX_LIFETIME_DAYS}일을 넘어요(#${entry.issue}): ${entry.id} — 이슈에 사유를 남기고 원인을 고치세요.`);
    }
    if (isExpired(entry, now)) {
      out.push(
        `재시도 기한이 지났어요(#${entry.issue}, ${entry.expires}): ${entry.id} — 원인을 고쳐 항목을 지우거나, 이슈에 사유를 남기고 새 기한으로 다시 등록하세요. 러너는 이미 이 시험을 재시도하지 않아요.`
      );
    }
  }
  return out;
}
