import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// #1502 — 진행을 잠금에서 갈라낸다. 여섯 자리, 다섯 파일.
//
// `ConfirmButton` 소비처들이 in-flight 를 `disabled` 에 접어 넣고 있었다
// (`disabled={offline || busy}` 계열). 그 접힘은 **쓰기를 낸 그 버튼 자신**을
// 회색으로 칠한다 — 자기가 켠 busy 로 자기를 잠그는 것이라, 화면에 하나뿐인
// 진행 낱말이 opacity-50 아래에서 죽고 낭독은 「지우는 중, 사용 안 함」이 된다.
// #1403 리뷰 H-1 이 `CleanupArtifactRow` 에서 고친 것과 정확히 같은 클래스이고,
// #1490 이 `ConfirmButton` 에 `busy`/`busyLabel` 을 실어 갈라 넣을 자리를 만들었다.
//
// 문법은 #1486 회전이 세운 그대로다:
//
//   진행  aria-busy + 바뀐 낱말. 흐리지 않고, 잠그지 않고, 초점을 놓지 않는다.
//   잠금  aria-disabled + 흐림 + 사유 + 가드. tab order 는 떠나지 않는다.
//
// 도는 곳은 DOM 없는 node 라(이 클라이언트에는 jsdom 도 RTL 도 없다) 이 스위트가
// 재는 것은 옆 `settingsFieldsBusy.test.ts`·`hostedDisconnectScope.test.ts` 와 같은
// 종류 — 호출부 소스의 구조적 불변식이다. 실제 렌더·초점·이중 발사는 Playwright
// 실측이 따로 봤다(PR 본문).
//
// RED PROOF 넷:
//
//   ① 여섯 자리 전부 진행 낱말을 든다. `busy=` 를 도로 들어내면 먼저 빨개진다.
//   ② 그 진행이 자기 잠금 식에 다시 끼어들지 않는다. `disabled` 로 되돌아오는
//      길을 이름 단위로 막는다 — 접힘이 바로 이 goal 이 고친 것이다.
//   ③ 잠금은 사라지지 않았다. 진행을 빼는 것과 잠금을 지우는 것은 다른 일이고,
//      후자는 날고 있는 쓰기 위에 두 번째 쓰기를 허용한다.
//   ④ 진행은 노드를 갈아 끼우지 않는다. 교체는 native `disabled` 를 피해 얻으려던
//      바로 그것(초점)을 도로 잃는다.
// =============================================================================

function source(relative: string): string {
  return readFileSync(
    fileURLToPath(new URL(relative, import.meta.url)),
    "utf8"
  );
}

const FILES = {
  "AiLinkChain.tsx": source("./AiLinkChain.tsx"),
  "EventSubscriptionSection.tsx": source("./EventSubscriptionSection.tsx"),
  "AiLinkSection.tsx": source("./AiLinkSection.tsx"),
  "WorkspaceSection.tsx": source("./WorkspaceSection.tsx"),
  "HostedConnectionSection.tsx": source(
    "../hostedAgents/HostedConnectionSection.tsx"
  ),
} as const;

type FileName = keyof typeof FILES;

/**
 * `<ConfirmButton …/>` **한 호출**의 props 만 떼어낸다. 고르는 열쇠는 `testId` 다.
 *
 * 파일 단위로 재면 안 되는 이유가 이 goal 의 논지 자체다: 같은 파일의 다른
 * 컨트롤들은 쓰기가 나는 동안 **정말로** 잠기는 것이 옳다. `AiLinkChain` 의 홉
 * 삭제(`chain-remove-*`)가 그렇다 — 저장이 날고 있는 초안을 그 밑에서 고치는
 * 일은 막아야 하고, 그 버튼 자신은 아무것도 진행하고 있지 않다. 규율이 말하는
 * 것은 **쓰기를 낸 그 버튼**을 회색으로 칠하지 말라는 것뿐이다.
 */
function confirmCall(file: FileName, testId: string): string {
  const chunks = FILES[file].split("<ConfirmButton").slice(1);
  const marker = `testId="${testId}"`;
  for (const chunk of chunks) {
    const end = chunk.indexOf("/>");
    if (end === -1) continue;
    const call = chunk.slice(0, end);
    if (call.includes(marker)) return call;
  }
  throw new Error(`${file} 에 testId="${testId}" 인 ConfirmButton 호출이 없다`);
}

/** `attr={…}` 한 자리. 중첩 중괄호가 없는 식들이라 이 정도로 충분하다. */
function prop(call: string, attr: string): string {
  const found = new RegExp(`${attr}=\\{([^}]*)\\}`).exec(call);
  expect(found?.[1], `${attr}= 가 없다`).toBeDefined();
  return found?.[1] ?? "";
}

/** `busyLabel="…"` 의 값. 넘기지 않았으면 null(= 기본값 「저장 중」을 쓴다). */
function busyLabel(call: string): string | null {
  return /busyLabel="([^"]+)"/.exec(call)?.[1] ?? null;
}

/**
 * 이 goal 이 고친 여섯 자리. 「진행을 지는 이름」과 「그 자리에 설 낱말」의 짝이다.
 *
 * `lockVia` 는 잠금이 그 호출에서 어떻게 불리는가 — 두 호스티드 자리는 잠금 식이
 * 길어 이름 하나로 뽑아 두었고(`locked`), 그 이름의 정의를 아래 ③ 이 따로 잰다.
 */
const SITES = [
  {
    file: "AiLinkChain.tsx",
    testId: "chain-clear",
    busy: "clearing",
    label: "지우는 중",
    lock: "offline || (busy && !clearing)",
    lockVia: null,
  },
  {
    file: "EventSubscriptionSection.tsx",
    testId: "event-subscription-delete",
    busy: "removing",
    label: "지우는 중",
    lock: "offline || (busy && !removing)",
    lockVia: null,
  },
  {
    file: "AiLinkSection.tsx",
    testId: "ai-link-unlink",
    busy: "unlinking",
    label: "해제 중",
    lock: "offline || (busy && !unlinking)",
    lockVia: null,
  },
  {
    file: "HostedConnectionSection.tsx",
    testId: "hosted-disconnect-start",
    busy: "starting",
    label: "해제 중",
    lock: "locked",
    lockVia: "const locked = blocked || (busy && !starting);",
  },
  {
    file: "HostedConnectionSection.tsx",
    testId: "hosted-disconnect-complete",
    busy: "completing",
    label: "확정 중",
    lock: "locked",
    lockVia: "const locked = blocked || (busy && !completing);",
  },
  {
    file: "WorkspaceSection.tsx",
    testId: "workspace-leave",
    busy: "leave.isPending",
    label: "나가는 중",
    lock: "offline",
    lockVia: null,
  },
] as const satisfies readonly {
  file: FileName;
  testId: string;
  busy: string;
  label: string;
  lock: string;
  lockVia: string | null;
}[];

describe("RED PROOF ① 여섯 자리 전부 보이는 진행 낱말을 든다", () => {
  for (const site of SITES) {
    it(`${site.file} · ${site.testId} → 「${site.label}」`, () => {
      const call = confirmCall(site.file, site.testId);
      expect(prop(call, "busy")).toBe(site.busy);
      // 낱말을 넘기지 않으면 기본값 「저장 중」이 선다. 이 여섯 중 저장인 것은
      // 하나도 없으므로, 기본값에 기대는 것은 곧 틀린 낱말을 세우는 것이다.
      expect(busyLabel(call)).toBe(site.label);
    });
  }
});

describe("RED PROOF ② 진행이 자기 잠금 식에 다시 끼어들지 않는다", () => {
  for (const site of SITES) {
    it(`${site.file} · ${site.testId} 의 disabled 에 ${site.busy} 가 그대로 없다`, () => {
      const call = confirmCall(site.file, site.testId);
      // 부정된 등장(`!clearing`)은 통과시킨다 — 그것이 바로 갈라내는 문법이다.
      // 여기서 막는 것은 `disabled={offline || clearing}` 로 되돌아가는 길이다.
      const lock = prop(call, "disabled").split(`!${site.busy}`).join("");
      const bare = new RegExp(
        `(^|[^.\\w])${site.busy.replace(".", "\\.")}([^\\w]|$)`
      );
      expect(bare.test(lock), `disabled 가 ${site.busy} 를 그대로 든다`).toBe(
        false
      );
    });
  }

  it("흐림과 낭독은 잠금에만 붙는다 — 공용 컴포넌트가 지는 몫", () => {
    // 호출부가 아무리 옳아도 `ConfirmButton` 이 busy 를 잠금처럼 그리면 소용이
    // 없다. 그 불변식은 `settingsFieldsBusy.test.ts` 가 재고 있고, 이 줄은 그
    // 스위트가 사라지지 않았다는 사실만 확인한다.
    const spec = source("./settingsFieldsBusy.test.ts");
    expect(spec).toContain("busy 가 aria-disabled 식에 없다");
    expect(spec).toContain("busy 가 흐림(opacity-50) 식에 없다");
  });
});

describe("RED PROOF ③ 잠금은 사라지지 않았다", () => {
  for (const site of SITES) {
    it(`${site.file} · ${site.testId} 는 여전히 잠긴다`, () => {
      const call = confirmCall(site.file, site.testId);
      expect(prop(call, "disabled")).toBe(site.lock);
      if (site.lockVia !== null) {
        expect(FILES[site.file]).toContain(site.lockVia);
      }
    });
  }

  it("잠긴 확정 버튼은 사유를 든다", () => {
    // 회색인데 아무 말도 없는 컨트롤은 「당신은 이걸 못 한다」로 읽힌다. 확정은
    // 잠기는 사실이 둘이라(게이트·오프라인 / 앞서 누른 것) 사유도 둘이고, 한
    // 번에 하나만 선다 — 둘째 문장은 바로 위 정리 패널이 이미 적어 둔 것이다.
    const section = FILES["HostedConnectionSection.tsx"];
    expect(section).toContain(
      "const lockReasonId = blocked ? blockedId : locked ? BUSY_NOTE_ID : undefined;"
    );
    expect(confirmCall("HostedConnectionSection.tsx", "hosted-disconnect-complete"))
      .toContain("describedBy={lockReasonId}");
    // 그 id 가 실제로 그려지는 자리. 두 패널은 언제나 함께 마운트된다.
    expect(section).toContain("id={BUSY_NOTE_ID}");
  });
});

describe("RED PROOF ④ 진행은 노드를 갈아 끼우지 않는다", () => {
  it("호스티드 두 자리가 트리거를 교체하지 않는다", () => {
    // 교체본은 그림으로는 규율을 지켰지만(aria-busy + 낱말) 초점을 지키지
    // 못했다: 확정을 누른 순간 `ConfirmButton` 이 통째로 언마운트되므로 방금
    // Enter 를 누른 손에서 초점이 <body> 로 떨어진다 — native `disabled` 를
    // 피해 얻으려던 바로 그것이다. 낱말은 이제 같은 노드가 바꿔 단다.
    const section = FILES["HostedConnectionSection.tsx"];
    for (const name of ["starting", "completing"]) {
      expect(section, `${name} 이 아직 노드를 가른다`).not.toContain(
        `{${name} ? (`
      );
    }
    // 낱말은 사라지지 않았다 — 자리를 옮겼을 뿐이다.
    expect(section).toContain('busyLabel="해제 중"');
    expect(section).toContain('busyLabel="확정 중"');
  });

  it("나가기의 형제 상태 줄이 트리거로 합쳐졌다", () => {
    // 회색 버튼 옆에 진행을 대신 말해 주던 줄이 있었다. 낱말이 트리거로 온
    // 지금 그 줄을 남기면 100px 안에 같은 말이 둘 선다.
    const file = FILES["WorkspaceSection.tsx"];
    expect(file).not.toContain("workspace-leave-pending");
    expect(file.split("나가는 중").length - 1).toBe(1);
  });

  it("낱말꼴은 「명사 + 중」이다", () => {
    // 한자어 동작명사가 있으면 「명사 + 중」, 없을 때만 고유어 동사가 「-는 중」
    // (#1490 전수 조사 → #1501 정본화). 이 goal 이 새로 세운 낱말 여섯이 그
    // 규칙 아래 있다: 해제·확정은 명사꼴, 지우다·나가다는 고유어라 「-는 중」.
    for (const [name, file] of Object.entries(FILES)) {
      expect(file.match(/[가-힣]+하는 중/g) ?? [], `${name}`).toEqual([]);
    }
  });
});
