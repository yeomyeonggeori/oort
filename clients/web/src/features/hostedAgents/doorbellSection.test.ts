import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { HOSTED_CREDENTIAL_MUTATION_KEY } from "./hostedCredentialScope";
import {
  HOSTED_DOORBELL_MUTATION_KEY,
  purgeHostedDoorbellMutations,
} from "./doorbellScope";

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

const section = source("DoorbellSection.tsx");
const parent = source("HostedConnectionSection.tsx");
const scope = source("doorbellScope.ts");

describe("도어벨 섹션 구조", () => {
  it("부모는 연결 탭에 도어벨 섹션을 붙인다", () => {
    expect(parent).toContain("<DoorbellSection");
    expect(parent).toContain('data-testid="hosted-connection-section"');
  });

  it("쿼리 함수를 컴포넌트 안에서 짓지 않는다", () => {
    expect(section).not.toMatch(/queryFn\s*:/);
    expect(section).toContain("hostedConnectionDetailQueryKey(");
  });

  it("아무것도 로그하지 않고 저장소에 쓰지 않는다", () => {
    expect(section).not.toMatch(/console\.(log|warn|error|debug)/);
    expect(section).not.toMatch(/localStorage\s*\./);
    expect(section).not.toMatch(/sessionStorage\s*\./);
  });

  it("sender key 를 mutation 변수로 넘기지 않는다", () => {
    expect(section).toContain("register.mutate()");
    expect(section).not.toMatch(/mutate\(\s*\{[^}]*secret/);
    expect(section).toContain("secretRef.current");
    expect(section).toContain("HOSTED_DOORBELL_MUTATION_SCOPE");
    expect(section).toContain("purgeHostedDoorbellMutations");
  });

  it("시험 발화 버튼을 그리지 않는다", () => {
    expect(section).not.toMatch(/data-testid="hosted-doorbell-test"/);
    expect(section).toContain("시험 발화 버튼은 없다");
  });

  it("4상태와 게이트 닫힘을 가른다", () => {
    expect(section).toContain("hosted-doorbell-empty");
    expect(section).toContain("hosted-doorbell-loading");
    expect(section).toContain("hosted-doorbell-registered");
    expect(section).toContain("hosted-doorbell-failure");
    expect(section).toContain("hosted-doorbell-gate-off");
    expect(section).toContain("isDoorbellGateClosed(");
    expect(section).toContain("doorbellFailureMessage(");
  });

  it("도어벨 mutation 키는 마법사 자격증명 키와 다르다", () => {
    expect(HOSTED_DOORBELL_MUTATION_KEY).not.toEqual(
      HOSTED_CREDENTIAL_MUTATION_KEY
    );
    expect(scope).toContain('gcTime: 0');
  });

  it("언마운트에서 도어벨 mutation 만 비운다", () => {
    const client = new QueryClient();
    expect(purgeHostedDoorbellMutations(client)).toBe(0);
  });
});
