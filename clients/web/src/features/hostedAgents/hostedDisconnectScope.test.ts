import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  dispositionChoices,
  storedDisposition,
  HOSTED_CLEANUP_KINDS,
  type HostedCleanupChoice,
} from "@momo/core/features/hostedAgents/cleanup";
import {
  hostedConnectionQueryKey,
  hostedListQueryKey,
} from "./hostedCredentialScope";
import {
  hostedConnectionDetailQuery,
  hostedConnectionDetailQueryKey,
  invalidateHostedConnection,
} from "./hostedDisconnectScope";

// =============================================================================
// #1362 HAP-UX2 — 해제 화면이 지켜야 하는 것 넷.
//
// 도는 곳은 DOM 없는 node 라 렌더를 볼 수 없다. 그래서 이 스위트가 재는 것은
// 옆 파일(`hostedCredentialScope.test.ts`)과 같은 종류다: 캐시의 **모양**과,
// 컴포넌트 소스의 **구조적 불변식**. 마지막 하나는 이 표면에만 있다 — 처분 표가
// 데이터베이스 CHECK 와 글자 단위로 같은가. 코어는 레포 배치를 알면 안 되므로
// (purity 게이트가 `import.meta` 와 `process` 를 막는다) 파일을 읽을 수 있는 이쪽이
// 그 대조를 맡는다.
//
// RED PROOF 넷:
//
//   ① 세 캐시가 함께 무효화된다. 하나만 빠지면 다른 탭이 폐기된 연결을 활성으로
//      그린다.
//   ② 이 화면은 되묻지 않는다. 기다릴 상대가 없고, 폼 아래 목록이 5초마다 갈리면
//      사람은 자기가 적던 줄을 잃는다.
//   ③ 컴포넌트가 쿼리 함수를 짓지 않고 아무것도 로그하지 않는다.
//   ④ 처분 표 == migration 072 의 CHECK.
// =============================================================================

const WS = "00000000-0000-7000-8000-000000000001";
const CONNECTION = "00000000-0000-7000-8000-0000000000c1";

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function source(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./${name}`, import.meta.url)), "utf8");
}

const MIGRATION = readFileSync(
  fileURLToPath(
    new URL(
      "../../../../../server/Migrations/072_hosted_agent_disconnect_manifest.sql",
      import.meta.url
    )
  ),
  "utf8"
);

describe("RED PROOF ① 한 연결의 세 캐시가 함께 낡는다", () => {
  it("장부·마법사 단건·목록이 모두 무효화된다", async () => {
    const queryClient = client();
    const keys = [
      hostedConnectionDetailQueryKey(WS, CONNECTION),
      hostedConnectionQueryKey(WS, CONNECTION),
      hostedListQueryKey(WS),
    ];
    for (const queryKey of keys) {
      await queryClient.prefetchQuery({ queryKey, queryFn: async () => ({ ok: true }) });
    }
    expect(
      queryClient
        .getQueryCache()
        .findAll()
        .every((query) => !query.isStale())
    ).toBe(true);

    invalidateHostedConnection(queryClient, WS, CONNECTION);

    for (const queryKey of keys) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBe(true);
    }
  });

  it("다른 연결과 다른 표면은 건드리지 않는다", async () => {
    const queryClient = client();
    const other = "00000000-0000-7000-8000-0000000000c2";
    const untouched = [
      hostedConnectionDetailQueryKey(WS, other),
      ["settings", "workspace", WS] as const,
    ];
    for (const queryKey of untouched) {
      await queryClient.prefetchQuery({ queryKey, queryFn: async () => ({ ok: true }) });
    }
    invalidateHostedConnection(queryClient, WS, CONNECTION);
    for (const queryKey of untouched) {
      expect(queryClient.getQueryState(queryKey)?.isInvalidated).toBeFalsy();
    }
  });

  it("키는 마법사의 단건과 다르다", () => {
    expect(hostedConnectionDetailQueryKey(WS, CONNECTION)).not.toEqual(
      hostedConnectionQueryKey(WS, CONNECTION)
    );
  });
});

describe("RED PROOF ② 이 화면은 되묻지 않는다", () => {
  it("장부 쿼리에 폴링 간격이 없다", () => {
    const options = hostedConnectionDetailQuery(WS, CONNECTION);
    expect("refetchInterval" in options).toBe(false);
    expect(options.retry).toBe(false);
  });
});

describe("RED PROOF ③ 컴포넌트는 얇고 조용하다", () => {
  const section = source("HostedConnectionSection.tsx");
  const row = source("CleanupArtifactRow.tsx");

  it("컴포넌트 안에 인라인 queryFn 이 없다", () => {
    expect(section).not.toMatch(/queryFn\s*:/);
    expect(section).toContain("hostedListQuery(workspaceId)");
    expect(section).toContain("hostedConnectionDetailQuery(");
  });

  it("아무것도 로그하지 않고 저장소에 아무것도 쓰지 않는다", () => {
    for (const file of [section, row]) {
      expect(file).not.toMatch(/console\.(log|warn|error|debug)/);
      expect(file).not.toMatch(/localStorage\s*\./);
      expect(file).not.toMatch(/sessionStorage\s*\./);
    }
  });

  it("판정과 문구는 코어에서 온다", () => {
    // 게이트 문장을 컴포넌트가 지어내면 같은 거절이 화면마다 다른 말이 된다.
    expect(section).toContain("terminalGate(");
    expect(section).toContain("disconnectStartGate(");
    expect(section).toContain("cleanupProgressSentence(");
    expect(row).toContain("acknowledgeReady(");
    expect(row).toContain("acknowledgeQuestion(");
    expect(row).not.toMatch(/blockedCopy\s*=/);
  });

  it("출처를 요청 본문에 실을 자리가 없다", () => {
    // 서버는 이 경로로 들어온 확인을 전부 `manual` 로 쓴다. 클라이언트가 그 값을
    // 보내려 시도하는 순간 DTO 가 거절하고, 그 시도 자체가 없어야 한다.
    for (const file of [section, row]) {
      expect(file).not.toMatch(/server_verified["']?\s*[,:]/);
      expect(file).not.toMatch(/source\s*:\s*["']/);
    }
    expect(section).toContain("buildAcknowledgement(");
  });

  it("서버가 확인한 줄에는 폼이 서지 않고, 서버의 영어 문장이 그려지지 않는다", () => {
    expect(row).toContain("cleanupRowActionable(artifact)");
    expect(row).toContain("cleanupEvidenceText(artifact)");
    // 원문 `evidence` 를 그대로 그리면 server_verified 줄의 영어 운영자 문장이
    // 사람이 적은 확인들 사이에 선다.
    expect(row).not.toMatch(/\{artifact\.evidence\}/);
  });

  it("처분에는 질문이 서고 관측에는 서지 않는다", () => {
    expect(row).toContain("<ConfirmButton");
    expect(row).toContain("choice === null ? (");
  });

  it("네 상태가 전부 있다", () => {
    expect(section).toContain("SkeletonRows");
    expect(section).toContain("EmptyInvite");
    expect(section).toContain("InlineBanner");
    expect(section).toContain("hosted-disconnect-offline");
    expect(section).toContain("useOffline()");
  });

  // 토스트 금지는 여기서 재지 않는다. `scripts/design_preflight_web.sh` 의
  // `toast` 범주가 clients/web/src 전체를 이미 훑고, 그 범주는 줄 단위 grep 이라
  // 이 파일의 단정 문자열까지 위반으로 센다 — 규칙을 한 번 더 적으려던 줄이 그
  // 규칙을 깨는 자리가 된다.
});

describe("RED PROOF ④ 처분 표는 migration 072 의 CHECK 와 같다", () => {
  it("종류 집합이 CHECK 의 IN 목록과 같다", () => {
    expect(MIGRATION).toContain(
      "'bot','routine','plugin','connector','local_plugin_files','secret'"
    );
    for (const kind of HOSTED_CLEANUP_KINDS) {
      expect(MIGRATION).toContain(`'${kind}'`);
    }
  });

  it("preserve 는 bot 절에만, revoke 는 secret 절에만 있다", () => {
    expect(MIGRATION).toContain("(kind = 'bot' AND disposition IN ('removed','preserved'))");
    expect(MIGRATION).toContain("(kind = 'secret' AND disposition = 'revoked')");
    expect(MIGRATION).toContain(
      "OR (kind IN ('routine','plugin','connector','local_plugin_files')\n        AND disposition = 'removed')"
    );
  });

  it("코어가 내미는 짝과 CHECK 가 받는 짝이 하나도 어긋나지 않는다", () => {
    // 저장 어휘(CHECK)와 요청 어휘(요청 본문)의 대응. 두 어휘가 다른 것이 이
    // 대조를 필요하게 만든다: `delete` 는 `removed` 로, `preserve` 는
    // `preserved` 로, `revoke` 는 `revoked` 로 저장된다.
    const allowed = new Map<string, readonly string[]>([
      ["bot", ["removed", "preserved"]],
      ["secret", ["revoked"]],
      ["routine", ["removed"]],
      ["plugin", ["removed"]],
      ["connector", ["removed"]],
      ["local_plugin_files", ["removed"]],
    ]);
    for (const kind of HOSTED_CLEANUP_KINDS) {
      const offered = dispositionChoices(kind).map((choice) =>
        storedDisposition(kind, choice.id)
      );
      expect(new Set(offered)).toEqual(new Set(allowed.get(kind)));
      for (const choice of ["delete", "preserve", "revoke"] as HostedCleanupChoice[]) {
        const stored = storedDisposition(kind, choice);
        if (stored === null) continue;
        expect(allowed.get(kind)).toContain(stored);
      }
    }
  });

  it("요구 행동 절도 같은 표다", () => {
    expect(MIGRATION).toContain("(kind = 'bot' AND expected_action = 'decide')");
    expect(MIGRATION).toContain("(kind = 'secret' AND expected_action = 'revoke')");
  });

  it("server_verified 는 secret 에만 허용된다는 절이 있다", () => {
    expect(MIGRATION).toContain(
      "source IS DISTINCT FROM 'server_verified' OR kind = 'secret'"
    );
  });
});
