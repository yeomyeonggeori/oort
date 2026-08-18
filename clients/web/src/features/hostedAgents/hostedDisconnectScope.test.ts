import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import {
  acknowledgeReady,
  dispositionChoices,
  evidenceIssue,
  storedDisposition,
  HOSTED_CLEANUP_KINDS,
  type HostedCleanupChoice,
} from "@momo/core/features/hostedAgents/cleanup";
import { CLEANUP_EVIDENCE_REQUIRED_NOTE } from "@momo/core/features/hostedAgents/disconnect";
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
// #1362 HAP-UX2 — 해제 화면이 지켜야 하는 것 다섯.
//
// 도는 곳은 DOM 없는 node 라 렌더를 볼 수 없다. 그래서 이 스위트가 재는 것은
// 옆 파일(`hostedCredentialScope.test.ts`)과 같은 종류다: 캐시의 **모양**과,
// 컴포넌트 소스의 **구조적 불변식**. 마지막 하나는 이 표면에만 있다 — 처분 표가
// 데이터베이스 CHECK 와 글자 단위로 같은가. 코어는 레포 배치를 알면 안 되므로
// (purity 게이트가 `import.meta` 와 `process` 를 막는다) 파일을 읽을 수 있는 이쪽이
// 그 대조를 맡는다.
//
// RED PROOF 다섯:
//
//   ① 세 캐시가 함께 무효화된다. 하나만 빠지면 다른 탭이 폐기된 연결을 활성으로
//      그린다.
//   ② 이 화면은 되묻지 않는다. 기다릴 상대가 없고, 폼 아래 목록이 5초마다 갈리면
//      사람은 자기가 적던 줄을 잃는다.
//   ③ 컴포넌트가 쿼리 함수를 짓지 않고 아무것도 로그하지 않는다.
//   ④ 처분 표 == migration 072 의 CHECK.
//   ⑤ 저장이 막힌 사유는 하나뿐이고, 그 자리에 갈래가 없다 (#1488).
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

/**
 * `<ConfirmButton …/>` 한 호출의 props 만 떼어낸다.
 *
 * 진행/잠금 규율은 **쓰기를 낸 그 컨트롤**에 대한 것이라 잣대가 파일 전체이면
 * 안 된다: 같은 폼의 라디오와 증거 칸은 저장이 나는 동안 정말로 잠기므로
 * (`disabled={disabled || saving}`) 파일 단위 검사는 옳은 코드를 위반으로 센다.
 */
function confirmButtonProps(file: string): string {
  const open = file.indexOf("<ConfirmButton");
  expect(open, "ConfirmButton 호출이 없다").toBeGreaterThan(-1);
  const close = file.indexOf("/>", open);
  expect(close).toBeGreaterThan(open);
  return file.slice(open, close);
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

/**
 * `disabled` 가 곧장 DOM `<button>` 의 native 속성이 되는 태그들. 여기에 붙는
 * native `disabled` 가 이 검사가 잡는 것이다 (#1403).
 *
 * `ConfirmButton`·`SaveButton` 은 일부러 빠져 있다: 그 둘은 `disabled` 를 **받아서
 * 자기 안에서 `aria-disabled` 로 옮기는** 컴포넌트라(SettingsFields), 호출부의
 * `disabled={...}` 는 이미 이 규율을 지킨 모양이다. 그것까지 금지하면 규율을
 * 지키는 유일한 방법을 금지하게 된다.
 */
const BUTTON_TAGS = new Set(["Button", "button"]);

/**
 * `disabled={...}` 를 든 JSX 여는 태그의 이름들.
 *
 * 정규식 하나로 여는 태그 전체를 잡을 수 없어서(속성 값에 `=>` 와 중첩 중괄호가
 * 들어간다) 줄에서 거슬러 올라간다: 이 레포의 JSX 는 여는 태그를 자기 줄에 두므로
 * `disabled={` 줄에서 위로 가장 가까운 `<Tag` 가 그 속성의 주인이다.
 *
 * 잰 것이 **수가 아니라 주인**이라 새 필드나 새 파일이 생겨도 깨지지 않고,
 * 버튼에 native `disabled` 가 붙는 순간에만 깨진다.
 */
function nativeDisabledOwners(file: string): readonly string[] {
  const lines = file.split("\n");
  const owners: string[] = [];
  lines.forEach((line, index) => {
    if (!/^\s*disabled=\{/.test(line)) return;
    for (let back = index; back >= 0; back -= 1) {
      const open = /<([A-Za-z][\w.]*)/.exec(lines[back] ?? "");
      if (open?.[1] !== undefined) {
        owners.push(open[1]);
        return;
      }
    }
    owners.push("(주인을 못 찾음)");
  });
  return owners;
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

  it("거절은 그것을 부른 컨트롤 옆에 선다", () => {
    // 이 장부는 한 화면에 들어가지 않는다. 맨 위 배너 하나로 답하면 여섯 번째
    // 줄에서 저장을 누른 사람에게 그 답이 화면 밖에서 뜬다.
    expect(section).toContain('scope: "start"');
    expect(section).toContain('scope: "complete"');
    expect(section).toContain("scope: variables.artifact.id");
    expect(section).toContain('failure?.scope === artifact.id');
    expect(row).toContain("<InlineBanner");
  });

  it("네 상태가 전부 있다", () => {
    expect(section).toContain("SkeletonRows");
    expect(section).toContain("EmptyInvite");
    expect(row).toContain("InlineBanner");
    // 오프라인은 배너를 하나 더 세우지 않는다. 라우트가 이미 자기 배너를 들고
    // 있으므로 이 화면이 더하는 것은 **잠긴 줄들이 가리키는 사유 문장** 하나다.
    expect(section).toContain("hosted-cleanup-offline");
    expect(section).toContain("OFFLINE_NOTE_ID");
    expect(section).not.toMatch(/useOffline\(\)/);
    expect(row).toContain("aria-describedby={disabled ? disabledReasonId");
  });

  it("이 파일군의 어떤 버튼도 native disabled 로 잠기지 않는다", () => {
    // #1403. 사유를 한 번만 적고 잠긴 줄들이 그것을 가리키는 바로 위 설계는,
    // 버튼이 native `disabled` 인 순간 무너진다: 그 버튼은 tab order 에서 빠져
    // aria-describedby 가 가리키는 문장이 키보드·AT 로 **닿을 수 없는 곳**에
    // 놓이고, 초점을 쥔 채 잠기면 초점은 <body> 로 떨어진다. SettingsFields 의
    // SaveButton·ConfirmButton 이 같은 이유로 이미 aria-disabled 를 쓴다.
    //
    // 재는 방법이 「`disabled=` 가 N 개」가 아닌 이유(리뷰 M-2): 정확 일치 카운트는
    // 필드를 하나 더하거나 가드를 함수로 빼는 **옳은 수리를 벌하고**, 두 파일만
    // 세므로 이 폴더에 새로 생기는 파일의 native `disabled` 는 영원히 못 본다.
    // 그래서 수가 아니라 **누가 그 속성을 들고 있는가**를 잰다: 폴더의 모든 .tsx
    // 를 훑어 `disabled={...}` 를 든 여는 태그의 이름을 모으고, 그 안에 버튼이
    // 있으면 실패다. 잠금이 편집까지 막아야 하는 폼 필드(input·textarea·
    // ChoiceList)와, DOM 이 아니라 자기 안에서 aria-disabled 로 옮기는 컴포넌트
    // prop 은 그대로 통과한다.
    const offenders = new Map<string, readonly string[]>();
    for (const file of readdirSync(HERE).filter((name) => name.endsWith(".tsx"))) {
      const owners = nativeDisabledOwners(source(file)).filter((owner) =>
        BUTTON_TAGS.has(owner)
      );
      if (owners.length > 0) offenders.set(file, owners);
    }
    expect(Object.fromEntries(offenders)).toEqual({});
  });

  it("잠긴 컨트롤은 사유를 들고, 잠금은 그림만이 아니다", () => {
    // aria-disabled 는 클릭을 막지 않는다(그것이 요점이다 — 초점을 잃지 않는다).
    // 그러므로 잠금은 항상 **가드와 짝**이어야 하고, 그러지 않으면 회색으로 칠한
    // 살아 있는 버튼이 된다. 그리고 tab order 에 남은 잠긴 버튼은 왜 못 하는지
    // 말할 수 있어야 한다 — 그것이 이 수리의 논지 전체다.
    for (const control of [
      { file: row, lock: "aria-disabled={disabled || undefined}", guard: "if (disabled) return;" },
      { file: row, lock: "aria-disabled={saving || undefined}", guard: "if (saving) return;" },
      { file: row, lock: "aria-disabled={locked || undefined}", guard: "if (locked || saving) return;" },
      { file: section, lock: "aria-disabled={repairLocked || undefined}", guard: "if (repairLocked || repairing) return;" },
    ]) {
      expect(control.file).toContain(control.lock);
      expect(control.file).toContain(control.guard);
    }
    // 사유가 닿는다: 줄의 네 컨트롤이 전부 목록 머리의 문장을 가리키고,
    // 섹션이 그 id 를 두 사실(오프라인·앞선 쓰기) 중 하나로 고른다.
    expect(row).toContain("aria-describedby={disabled ? disabledReasonId");
    expect(row).toContain("aria-describedby={saving ? disabledReasonId");
    expect(row).toContain("aria-describedby={locked ? disabledReasonId");
    expect(row).toContain("locked ? disabledReasonId : undefined");
    expect(section).toContain("aria-describedby={repairLocked ? lockReasonId");
    expect(section).toContain("disabledReasonId={lockReasonId}");
  });

  it("진행 중은 잠금으로 그려지지 않는다", () => {
    // States.tsx `actionBusy` 의 규율: 진행 중은 aria-busy 와 바뀐 낱말로 말하고,
    // 잠기지도 흐려지지도 않는다. 회색이 된 컨트롤은 「지금 일어나는 중」이 아니라
    // 「당신은 이걸 못 한다」로 읽히고, 그 둘을 겹치면 유일한 진행 낱말이
    // opacity-50 아래에서 죽는다 (#1403 리뷰 H-1).
    //
    // 그래서 이 두 파일에서 `aria-busy` 를 든 줄 근처에 `aria-disabled` 가 함께
    // 서면 안 된다. 진행을 지는 이름(saving·repairing·starting·completing)이
    // 잠금 식(`aria-disabled=`)에 등장하지 않는 것으로 잰다.
    for (const file of [row, section]) {
      for (const busyName of ["saving", "repairing", "starting", "completing"]) {
        const locks = file.match(/aria-disabled=\{[^}]*\}/g) ?? [];
        const overlap = locks.filter((lock) =>
          new RegExp(`\\b${busyName}\\b`).test(lock)
        );
        // 취소는 예외다: 그 버튼은 **진행 중인 것이 아니라** 진행 때문에 지금 할 수
        // 없는 것이라(날고 있는 쓰기는 취소되지 않는다) 잠금이 맞는 문법이다.
        expect(overlap.filter((lock) => lock !== "aria-disabled={saving || undefined}")).toEqual([]);
      }
    }
    // 진행은 실제로 말해진다 — **두 갈래 모두 보이는 낱말로**. 폼의 aria-busy 는
    // 여전히 서 있지만, 그것 하나만으로 진행을 지던 갈래는 이제 없다 (#1501).
    expect(row).toContain('{saving ? "저장 중" : CLEANUP_SAVE_LABEL}');
    expect(row).toContain("aria-busy={saving || undefined}");
    expect(section).toContain("aria-busy={repairing || undefined}");
  });

  it("처분 갈래도 보이는 진행 낱말을 든다 — ConfirmButton 의 busy 로", () => {
    // #1490 이 `ConfirmButton` 에 busy/busyLabel 을 실었고 소비처를 비워 두었다.
    // 그 한 줄이 없으면 처분을 고른 사람은 자기 클릭이 갔는지 알 방법이 화면에
    // 없다 — 낭독 전용 aria-busy 뿐이고, 그것은 눈에는 아무것도 아니다.
    const confirm = confirmButtonProps(row);
    expect(confirm).toContain("busy={saving}");
    // 잠금에 접히지 않는다. 이 goal 이 고친 것이 정확히 그 겹침이므로, 같은
    // 이름이 이 버튼의 `disabled` 로 되돌아오는 길을 막는다.
    //
    // 폼의 다른 컨트롤들(라디오·증거 칸)이 `disabled={disabled || saving}` 인
    // 것은 옳다 — 저장이 나는 동안 **정말로** 못 고치는 값들이다. 규율이 말하는
    // 것은 쓰기를 낸 그 버튼 자신을 회색으로 칠하지 말라는 것이라, 잣대는
    // 파일 전체가 아니라 이 호출 하나여야 한다.
    expect(confirm).toContain("disabled={locked || !ready}");
    expect(confirm).not.toMatch(/\bdisabled=\{[^}]*\bsaving\b/);
  });

  it("한 폼의 두 갈래가 같은 저장을 한 낱말로 말한다", () => {
    // 관측 갈래는 낱말을 직접 쓰고, 처분 갈래는 `ConfirmButton` 의 기본
    // `busyLabel` 을 받는다. 둘이 갈리면 같은 폼 같은 저장이 두 낱말이 되므로,
    // 이 줄은 **호출자가 busyLabel 을 넘기지 않는다**는 사실과 그 기본값이
    // 관측 갈래의 낱말과 같다는 사실을 함께 잰다.
    const settings = source("../settings/SettingsFields.tsx");
    const fallback = settings.match(/busyLabel = "([^"]+)"/)?.[1];
    expect(fallback).toBe("저장 중");
    expect(row).toContain(`{saving ? "${fallback}" : CLEANUP_SAVE_LABEL}`);
    expect(confirmButtonProps(row)).not.toContain("busyLabel=");
  });

  it("진행 낱말은 「명사 + 중」이다", () => {
    // 한자어 동작명사가 있으면 「명사 + 중」, 없을 때만 고유어 동사가 「-는 중」을
    // 쓴다 (#1490 전수 조사 → #1501 정본화). 「저장하는 중」은 같은 뜻을 두 글자
    // 더 길게 말하는 것이고, 진행 낱말은 원래 라벨을 **제자리에서** 대체하므로
    // 그 두 글자가 그대로 줄이 흔들리는 폭이 된다.
    //
    // `-하는 중` 을 통째로 금지하지는 않는다: 「받는 중」처럼 한자어 명사가 없는
    // 자리는 그 꼴이 맞다. 이 두 파일에 실제로 서 있던 넷만 못 박는다.
    for (const [file, name] of [
      [row, "CleanupArtifactRow.tsx"],
      [section, "HostedConnectionSection.tsx"],
    ] as const) {
      const hits = file.match(/[가-힣]+하는 중/g) ?? [];
      expect(hits, `${name} 에 「-하는 중」이 남았다`).toEqual([]);
    }
    expect(section).toContain("해제 중");
    expect(section).toContain("확정 중");
    expect(section).toContain('{repairing ? "복원 중" : MANIFEST_REPAIR_LABEL}');
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

// =============================================================================
// RED PROOF ⑤ 저장이 막힌 사유는 하나뿐이다 (#1488)
//
// #1403 워커가 실측한 죽은 카피의 뿌리는 카피가 아니라 **판정**이다:
// `acknowledgeReady` 는 처분을 고르지 않은 폼을 언제나 통과시키므로(관측만 적는
// 저장에는 막힐 것이 없다) `!ready` 인 순간 `choice` 는 절대 null 이 아니다.
// 그러므로 `!ready` 아래에 `choice === null` 갈래를 두면 그 문장은 영원히 안
// 보이고, 보였다면 「막힌 이유」 자리에서 「막히지 않았습니다」라고 말했을 것이다.
//
// 이 스위트가 판정과 소스를 한자리에서 재는 이유가 그것이다: 문장만 지우면
// 다음 사람이 같은 갈래를 다시 적고, 판정만 재면 화면이 그 판정을 어겨도 모른다.
// =============================================================================

/** 컴포넌트 소스에서 `<p id={blockedId} …>` 의 본문만 떼어낸다. */
function blockedCopySlot(row: string): string {
  const open = row.indexOf("<p id={blockedId}");
  expect(open).toBeGreaterThan(-1);
  const close = row.indexOf("</p>", open);
  expect(close).toBeGreaterThan(open);
  return row.slice(open, close);
}

describe("RED PROOF ⑤ 저장이 막힌 사유는 하나뿐이고 갈래가 없다", () => {
  const row = source("CleanupArtifactRow.tsx");

  it("처분을 고르지 않은 폼은 어떤 종류에서도 저장을 막지 않는다", () => {
    // 이것이 카피를 죽게 만든 사실이다. 여섯 종류 × 증거 네 모양 전부에서
    // 참이어야 `!ready ⟹ choice !== null` 이 성립한다.
    const evidences = ["", "  ", "목록에서 사라짐", "가".repeat(700)];
    for (const kind of HOSTED_CLEANUP_KINDS) {
      for (const evidence of evidences) {
        expect(acknowledgeReady(kind, null, evidence)).toBe(true);
      }
    }
  });

  it("`!ready` 는 곧 「처분을 골랐는데 증거가 규칙을 어겼다」와 같은 말이다", () => {
    // 화면이 내미는 처분은 전부 그 종류가 받는 것이므로(RED PROOF ④), 저장을
    // 막는 사정은 증거 하나뿐이다. 사유 문장이 하나여도 되는 근거가 여기 있다.
    const evidences = ["", "  ", "목록에서 사라짐", "가".repeat(700)];
    for (const kind of HOSTED_CLEANUP_KINDS) {
      for (const choice of dispositionChoices(kind)) {
        for (const evidence of evidences) {
          expect(acknowledgeReady(kind, choice.id, evidence)).toBe(
            evidenceIssue(evidence) === null
          );
        }
      }
    }
  });

  it("사유 자리에 처분 갈래가 없다", () => {
    // 처분으로 갈라지려면 이 슬롯이 `choice` 를 불러야 한다. 부르지 않는다면
    // 갈래는 생길 수 없다. 삼항 자체도 함께 막는다 — 다른 이름으로 같은 갈래를
    // 다시 세우는 길이기 때문이다.
    const slot = blockedCopySlot(row);
    expect(slot).not.toMatch(/\bchoice\b/);
    expect(slot).not.toMatch(/\n\s*\?\s/);
  });

  it("사유 문장은 코어가 들고 있고 컴포넌트가 지어내지 않는다", () => {
    expect(blockedCopySlot(row)).toContain("CLEANUP_EVIDENCE_REQUIRED_NOTE");
    expect(CLEANUP_EVIDENCE_REQUIRED_NOTE).toBe(
      "확인한 내용을 적어야 이 답을 기록할 수 있습니다."
    );
    // 지운 문장이 어디에도 되살아나지 않았다.
    expect(row).not.toContain("처분을 고르지 않았습니다");
  });
});
