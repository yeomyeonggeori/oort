import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// =============================================================================
// #1541 · #1542 · #1543 — 같은 다섯 파일, 세 잔여.
//
// #1502 가 `ConfirmButton` 소비처 여섯 자리에서 진행을 잠금에서 갈라낸 뒤에도,
// **같은 줄에 서 있는 다른 컨트롤들**은 여전히 in-flight 를 native `disabled` 로
// 접고 있었다. 한 줄 안에서 옆 버튼이 다른 문법을 쓰는 상태다:
//
//   지우기(ConfirmButton)  aria-disabled + 낱말 + 사유 + 가드, tab order 에 남음
//   전송 멈추기(raw)        native disabled — 낱말 없음, 흐림, tab order 에서 사라짐
//
// 문법 정본은 #1486 회전이 세운 그대로다:
//
//   진행  aria-busy + 바뀐 낱말. 흐리지 않고, 잠그지 않고, 초점을 놓지 않는다.
//   잠금  aria-disabled + 흐림 + 사유 + 가드. tab order 는 떠나지 않는다.
//
// 도는 곳은 DOM 없는 node 라(이 클라이언트에는 jsdom 도 RTL 도 없다) 이 스위트가
// 재는 것은 옆 `confirmBusySplit.test.ts`·`hostedDisconnectScope.test.ts` 와 같은
// 종류 — 호출부 소스의 구조적 불변식이다. 실제 렌더·초점·낭독·이중 발사는
// Playwright 실측이 따로 봤다(PR 본문).
//
// RED PROOF 다섯:
//
//   ① 여섯 자리 어디에도 native `disabled` 가 없다. 그 속성이 붙는 순간 잠긴
//      버튼은 tab order 를 떠나고, 사유 문장이 키보드·AT 로 닿을 수 없는 곳에
//      놓이며, 초점을 쥔 채 잠기면 초점이 <body> 로 떨어진다 (#1541).
//   ② 진행은 자기 잠금 식에 다시 끼어들지 않고, 보이는 낱말과 `aria-busy` 로
//      말해진다. 진행이 없는 자리(추가)는 낱말을 지어내지 않는다.
//   ③ 잠금은 흐림과 **가드**를 함께 진다. `aria-disabled` 는 클릭을 막지 않으므로
//      (그것이 요점이다 — 초점을 잃지 않는다) 가드가 없으면 회색으로 칠한 살아
//      있는 버튼이 된다.
//   ④ 형제 쓰기로 잠긴 줄은 사유를 든다 (#1542). 잠그는 사실이 둘이면 문장도
//      둘이고, 한 번에 하나만 선다.
//   ⑤ 완주 지점에 착지가 있다 (#1543). 확정이 성공해 그 트리거의 패널이 사라질 때
//      초점은 <body> 로 떨어지지 않는다.
// =============================================================================

function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

/**
 * 주석을 걷어낸 소스.
 *
 * 부재를 재는 단정은 **화면에 서는 것**만 봐야 한다. 왜 그것이 없는지를 적는
 * 주석이 자기 스캔에 걸리면 다음 사람은 이유를 적지 않게 되고, 그러면 남는 것은
 * 통과하는 코드와 사라진 판정뿐이다.
 */
function copyOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

const FILES = {
  "EventSubscriptionSection.tsx": source("./EventSubscriptionSection.tsx"),
  "AiLinkSection.tsx": source("./AiLinkSection.tsx"),
  "AiLinkChain.tsx": source("./AiLinkChain.tsx"),
  "WorkspaceSection.tsx": source("./WorkspaceSection.tsx"),
  "HostedConnectionSection.tsx": source(
    "../hostedAgents/HostedConnectionSection.tsx"
  ),
  // #1559 가 데려온 두 파일. 위 다섯이 「같은 다섯 파일」이던 동안 이 둘은 파일군
  // 밖이라 한 번도 재어지지 않았다.
  "InviteSection.tsx": source("./InviteSection.tsx"),
  "WebhookSection.tsx": source("./WebhookSection.tsx"),
} as const;

type FileName = keyof typeof FILES;

/**
 * JSX 여는 태그 하나를 떼어낸다. 중괄호 깊이를 세는 이유는 속성 값 안에 `=>` 와
 * 화살표 함수 본문의 `>` 가 들어가기 때문이다 — `indexOf(">")` 는 `onClick={() =>`
 * 의 화살표에서 먼저 멈춘다.
 */
function openingTag(chunk: string): string {
  let depth = 0;
  for (let i = 0; i < chunk.length; i += 1) {
    const ch = chunk[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return chunk.slice(0, i);
  }
  throw new Error("여는 태그가 닫히지 않는다");
}

/**
 * `<Button …>…</Button>` **한 호출**의 여는 태그와 본문. 고르는 열쇠는
 * `data-testid` 다.
 *
 * 파일 단위로 재면 안 되는 이유가 이 goal 의 논지 자체다: 같은 파일의 폼 필드들은
 * 쓰기가 나는 동안 **정말로** native `disabled` 로 잠기는 것이 옳다(잠금이 편집까지
 * 막아야 하는 자리다). 규율이 말하는 것은 **버튼**을 그렇게 잠그지 말라는 것뿐이다.
 */
function control(file: FileName, testId: string): { tag: string; body: string } {
  const marker = `data-testid="${testId}"`;
  for (const chunk of FILES[file].split("<Button").slice(1)) {
    const tag = openingTag(chunk);
    if (!tag.includes(marker)) continue;
    const close = chunk.indexOf("</Button>");
    expect(close, `${testId} 의 </Button> 가 없다`).toBeGreaterThan(-1);
    return { tag, body: chunk.slice(tag.length, close) };
  }
  throw new Error(`${file} 에 testId="${testId}" 인 Button 호출이 없다`);
}

/** `<ConfirmButton …/>` 한 호출의 props. 옆 스위트와 같은 모양. */
function confirmCall(file: FileName, testId: string): string {
  const marker = `testId="${testId}"`;
  for (const chunk of FILES[file].split("<ConfirmButton").slice(1)) {
    const end = chunk.indexOf("/>");
    if (end === -1) continue;
    const call = chunk.slice(0, end);
    if (call.includes(marker)) return call;
  }
  throw new Error(`${file} 에 testId="${testId}" 인 ConfirmButton 호출이 없다`);
}

/** 한 `function NAME(` 의 몸통. 경계는 다음 최상위 `function ` 이다. */
function region(file: FileName, name: string): string {
  const start = FILES[file].indexOf(`function ${name}(`);
  expect(start, `${name} 가 ${file} 에 없다`).toBeGreaterThan(-1);
  const rest = FILES[file].slice(start + 1);
  const end = rest.indexOf("\nfunction ");
  return end === -1 ? rest : rest.slice(0, end);
}

/**
 * `ConfirmButton` 이 아닌 여섯 자리. #1502 가 여섯 `ConfirmButton` 을 고친 뒤
 * 같은 다섯 파일에 남아 있던 것들이고, `lock` 은 그 자리의 잠금을 지는 이름이다.
 *
 * `busy` 가 null 인 한 자리(추가)는 **쓰기를 내지 않는다** — 초안에 줄을 더할 뿐이다.
 * 그 자리에서 `busy` 는 진짜 잠금이고(날고 있는 PUT 밑에서 그 초안을 고치는 일은
 * 막아야 한다), 갈라낼 진행이 없으므로 낱말도 없다. 없는 진행에 낱말을 지어내는
 * 것은 문법을 지키는 것이 아니라 거짓말을 하는 것이다.
 */
const SITES = [
  {
    file: "EventSubscriptionSection.tsx",
    testId: "event-subscription-toggle",
    lock: "toggleLocked",
    lockVia: "const toggleLocked = offline || confirming || (busy && !toggling);",
    busy: "toggling",
    words: ["멈추는 중", "보내는 중"],
    // 이 자리의 낱말은 본문이 아니라 위에서 지어진다: 낭독되는 이름이 그 낱말을
    // 따라 움직여야 해서(RED PROOF ② 마지막) 글자와 이름이 **한 곳**에서 나온다.
    rendersVia: "{toggleText}",
    guard: "if (toggleLocked || toggling) return;",
  },
  {
    file: "AiLinkSection.tsx",
    testId: "ai-link-save",
    lock: "saveLocked",
    lockVia: "const saveLocked = offline || (busy && !saving);",
    busy: "saving",
    words: ["저장 중"],
    rendersVia: null,
    // 이 자리의 가드는 버튼이 아니라 폼이 진다: 주소 칸에서 누른 Enter(암묵적
    // 제출)도 같은 쓰기를 내므로, `onClick` 에 두면 그 길이 열린 채 남는다.
    guard: "if (saveLocked || saving) return;",
  },
  {
    file: "AiLinkSection.tsx",
    testId: "ai-link-check",
    lock: "checkLocked",
    lockVia: "const checkLocked = offline || (busy && !checking);",
    busy: "checking",
    words: ["확인 중"],
    rendersVia: null,
    guard: "if (checkLocked || checking) return;",
  },
  {
    file: "AiLinkChain.tsx",
    testId: "chain-add",
    lock: "addLocked",
    lockVia: "const addLocked = full || busy || readOnly;",
    busy: null,
    words: [],
    rendersVia: null,
    guard: "if (addLocked) return;",
  },
  {
    file: "WorkspaceSection.tsx",
    testId: "workspace-avatar-change",
    lock: "offline",
    lockVia: null,
    busy: "uploading",
    words: ["올리는 중"],
    rendersVia: null,
    guard: "if (offline || uploading) return;",
  },
  {
    file: "WorkspaceSection.tsx",
    testId: "workspace-create",
    lock: "offline",
    lockVia: null,
    busy: "creating",
    words: ["만드는 중"],
    rendersVia: null,
    guard: "if (offline || creating) return;",
  },
] as const satisfies readonly {
  file: FileName;
  testId: string;
  lock: string;
  lockVia: string | null;
  busy: string | null;
  words: readonly string[];
  rendersVia: string | null;
  guard: string;
}[];

describe("RED PROOF ① 여섯 자리 어디에도 native disabled 가 없다", () => {
  for (const site of SITES) {
    it(`${site.file} · ${site.testId}`, () => {
      const { tag } = control(site.file, site.testId);
      // `aria-disabled` 를 부분 문자열로 갖는 이름이라, 앞이 속성 경계인지 본다.
      expect(/(^|\s)disabled=/.test(tag), "native disabled 가 붙어 있다").toBe(
        false
      );
      expect(tag).toContain(`aria-disabled={${site.lock} || undefined}`);
      if (site.lockVia !== null) expect(FILES[site.file]).toContain(site.lockVia);
    });
  }
});

describe("RED PROOF ② 진행은 잠금 식에 끼어들지 않고 낱말로 말해진다", () => {
  for (const site of SITES) {
    it(`${site.file} · ${site.testId}`, () => {
      const { tag, body } = control(site.file, site.testId);
      if (site.busy === null) {
        // 진행이 없는 자리다. `aria-busy` 를 달면 아무 일도 일어나지 않는 동안
        // 「일어나는 중」이라고 말하게 된다.
        expect(tag).not.toContain("aria-busy=");
        return;
      }
      expect(tag).toContain(`aria-busy={${site.busy} || undefined}`);
      // 잠금 식에 진행이 그대로 들어 있지 않다. 부정된 등장(`!saving`)은 통과 —
      // 그것이 갈라내는 문법이다. 막는 것은 `aria-disabled={… || saving}` 로
      // 되돌아가는 길이다.
      const lockExpr = (site.lockVia ?? "").split(`!${site.busy}`).join("");
      expect(new RegExp(`\\b${site.busy}\\b`).test(lockExpr)).toBe(false);
      // 낱말은 실제로 보인다. 흐리지 않는 진행이 눈에 보이는 방법은 이것뿐이다.
      if (site.rendersVia === null) {
        for (const word of site.words) expect(body).toContain(word);
        return;
      }
      expect(body).toContain(site.rendersVia);
      for (const word of site.words) {
        expect(FILES[site.file]).toContain(`"${word}"`);
      }
    });
  }

  it("낱말꼴은 「명사 + 중」이다", () => {
    // 한자어 동작명사가 있으면 「명사 + 중」(저장·확인), 없을 때만 고유어 동사가
    // 「-는 중」(멈추다·보내다·올리다·만들다) — #1490 전수 조사 → #1501 정본.
    for (const [name, file] of Object.entries(FILES)) {
      expect(file.match(/[가-힣]+하는 중/g) ?? [], name).toEqual([]);
    }
  });

  it("보이는 낱말이 바뀌면 낭독되는 이름도 함께 움직인다", () => {
    // 목록이 줄마다 내는 버튼이라 이름이 행을 져야 하는데(3개의 「전송 멈추기」는
    // tab order 의 같은 정류장 셋이다), 그 이름이 `label` 에서 지어지면 글자가
    // 「멈추는 중」이 된 뒤에도 이름은 「전송 멈추기」로 남는다 — label-in-name
    // (WCAG 2.5.3). `ConfirmButton` 이 `triggerText` 로 푼 것과 같은 방법이다.
    const file = FILES["EventSubscriptionSection.tsx"];
    expect(file).toContain("aria-label={`${subject} ${toggleText}`}");
    expect(file).toContain("{toggleText}");
    expect(file).not.toContain("${subject} 전송 멈추기");
  });
});

describe("RED PROOF ③ 잠금은 흐림과 가드를 함께 진다", () => {
  for (const site of SITES) {
    it(`${site.file} · ${site.testId}`, () => {
      const { tag } = control(site.file, site.testId);
      expect(tag).toContain(`className={cn(${site.lock} && "opacity-50")}`);
      // aria-disabled 는 클릭을 막지 않는다. 가드가 없으면 회색으로 칠한 살아
      // 있는 버튼이고, 두 번째 Enter 가 두 번째 쓰기를 낸다.
      expect(FILES[site.file]).toContain(site.guard);
    });
  }
});

describe("RED PROOF ④ 형제 쓰기로 잠긴 줄이 사유를 든다 (#1542)", () => {
  const file = FILES["EventSubscriptionSection.tsx"];

  it("두 번째 사유 문장이 있고, 코드가 아니라 문장이다", () => {
    expect(file).toContain("const BUSY_ROW_REASON =");
    expect(file).toContain("앞서 누른 것이 아직 끝나지 않았습니다.");
    // 뒷문장은 오프라인 문장의 동사를 그대로 받는다 — 같은 목록의 같은 두 행동.
    expect(file).toContain("이어서 멈추거나 지울 수 있습니다.");
  });

  it("한 번에 하나만 선다", () => {
    // 한 잠금에 두 이유를 대면 어느 쪽도 답이 아니게 된다. 오프라인이 이기는
    // 이유는 정리 장부의 `lockReasonId` 와 같다: 오프라인이면 앞선 쓰기도 어차피
    // 도착하지 못한다.
    expect(file).toContain("if (offline) return offlineReasonId;");
    expect(file).toContain("return busy && !mine ? busyReasonId : undefined;");
    // 문장 자체도 동시에 그려지지 않는다.
    expect(file).toContain("{offline && writesLockReason && (");
    expect(file).toContain("{!offline && busy && writesLockReason && (");
    expect(file).toContain("id={busyReasonId}");
  });

  it("줄의 두 컨트롤이 **자기** 진행을 빼고 그 문장을 가리킨다", () => {
    // `mine` 이 참이면 이 컨트롤은 잠긴 것이 아니라 진행 중이고, 진행 중에 「왜
    // 못 하는지」를 읽어 주면 하지 못하는 중이라는 뜻이 된다.
    expect(
      control("EventSubscriptionSection.tsx", "event-subscription-toggle").tag
    ).toContain("aria-describedby={lockReason(toggling)}");
    expect(
      confirmCall("EventSubscriptionSection.tsx", "event-subscription-delete")
    ).toContain("describedBy={lockReason(removing)}");
  });

  it("두 패널이 같은 이름·같은 자리에서 사유를 고른다 — StartPanel 비대칭", () => {
    // 잠금은 `locked` 가 판단하는데 사유는 `blocked` 만 보고 있었다. 한 파일의
    // 같은 자리가 다른 모양이면 다음 사람은 그 차이가 의도인지 알 수 없다.
    const start = region("HostedConnectionSection.tsx", "StartPanel");
    const terminal = region("HostedConnectionSection.tsx", "TerminalPanel");
    expect(start).toContain("const lockReasonId = blocked ? blockedId : undefined;");
    expect(start).toContain("describedBy={lockReasonId}");
    expect(terminal).toContain(
      "const lockReasonId = blocked ? blockedId : locked ? BUSY_NOTE_ID : undefined;"
    );
    // 둘째 문장이 이 패널에 없는 것은 사실이다: 그것을 들고 있는 정리 패널은
    // 이 패널과 함께 마운트되지 않으므로, 가리키면 화면에 없는 id 가 된다.
    expect(start).not.toContain("BUSY_NOTE_ID");
  });
});

describe("RED PROOF ⑤ 완주 지점에 착지가 있다 (#1543)", () => {
  const file = FILES["HostedConnectionSection.tsx"];

  it("두 완주가 각자의 착지를 적는다", () => {
    // 쓰기가 착지하는 자리에서 적는다 — 사라진 패널이 무엇으로 바뀌는지 아는
    // 것은 상태를 쥔 이 컴포넌트뿐이다.
    expect(file).toContain('landing.current = "cleanup";');
    expect(file).toContain('landing.current = "terminal";');
  });

  it("적힌 착지가 서버 상태가 바뀐 뒤에 적용된다", () => {
    // 형제 표면(`EventSubscriptionSection`)과 같은 식: 한 번 쓰고 한 번 쓴다.
    expect(file).toContain("const landing = useRef<string | null>(null);");
    expect(file).toContain("landing.current = null;");
    expect(file).toContain('`[data-landing="${target}"]`');
    expect(file).toContain("?.focus({ preventScroll: true });");
    expect(file).toContain("}, [detail.data]);");
    expect(file).toContain("ref={sectionRef}");
  });

  it("두 착지 노드가 실재하고 Tab 순서에는 들지 않는다", () => {
    for (const target of ["cleanup", "terminal"]) {
      const at = file.indexOf(`data-landing="${target}"`);
      expect(at, `${target} 착지 노드가 없다`).toBeGreaterThan(-1);
      // 프로그램 초점만 받는다. tabIndex 0 이면 없던 정류장이 하나 생긴다.
      expect(file.slice(at, at + 200)).toContain("tabIndex={-1}");
      // 초점 링이 없으면 착지는 보이지 않는 사건이 된다. `outline-none` 만 두면
      // 프리플라이트의 naked_focus 이기도 하다.
      expect(file.slice(at, at + 300)).toContain("focus-visible:focus-ring");
    }
  });

  it("줄 안쪽의 같은 문제는 그 줄이 이미 답했다", () => {
    // 확인 저장이 완주하면 폼이 닫히며 트리거가 사라지는데, 그 착지는
    // `CleanupArtifactRow` 가 자기 제목으로 이미 하고 있다. 이 섹션이 같은 일을
    // 한 번 더 하면 한 전이에 초점이 두 번 움직인다.
    const row = source("../hostedAgents/CleanupArtifactRow.tsx");
    expect(row).toContain("headingRef.current?.focus({ preventScroll: true });");
  });
});

// =============================================================================
// #1559 — 같은 클래스의 **파일군 밖** 잔여.
//
// #1541 이 다섯 파일에서 여섯 자리를 갈라내는 동안, 같은 설정 표면의 다른 파일들과
// 같은 파일의 다른 폼은 그 좌표 밖이었다. 전수 스캔(`disabled={…busy…}` 계열)이
// 찾아낸 설정 표면 잔여는 다섯 자리다:
//
//   event-subscription-create   같은 파일, #1502·#1541 이 잰 목록 **밖**의 만들기
//   invite-create               문법의 어느 쪽도 없었다 — aria-busy 도, 사유도
//   webhook-rotate-{id}         목록 전체가 함께 잠기고 진행 낱말이 없었다
//   webhook-revoke-{id}         동상
//   webhook-{asking}-{id}-commit 확인 그룹의 확정 — 남의 쓰기가 native disabled
//
// 그리고 #1541 이 「PR 에 남긴다」고 적어 둔 배선 잔여 셋(chain-add 의 두 사유,
// ai-link-save/check 의 무사유 회색 — design-review #1557 M)이 여기서 닫힌다.
//
// 문법 정본은 위와 같다. 이 스위트가 재는 것도 같은 종류 — 호출부 소스의 구조적
// 불변식이다.
// =============================================================================

/** testId 가 템플릿 리터럴인 자리를 위해, 마커를 그대로 받는다. */
function controlByMarker(
  file: FileName,
  marker: string
): { tag: string; body: string } {
  for (const chunk of FILES[file].split("<Button").slice(1)) {
    const tag = openingTag(chunk);
    if (!tag.includes(marker)) continue;
    const close = chunk.indexOf("</Button>");
    expect(close, `${marker} 의 </Button> 가 없다`).toBeGreaterThan(-1);
    return { tag, body: chunk.slice(tag.length, close) };
  }
  throw new Error(`${file} 에 ${marker} 인 Button 호출이 없다`);
}

const REMAINDER = [
  {
    name: "event-subscription-create",
    file: "EventSubscriptionSection.tsx",
    marker: 'data-testid="event-subscription-create"',
    lock: "offline",
    busy: "create.isPending",
    words: ["만드는 중"],
    rendersVia: null,
    guard: "if (offline || create.isPending) return;",
  },
  {
    name: "invite-create",
    file: "InviteSection.tsx",
    marker: 'data-testid="invite-create"',
    lock: "offline",
    busy: "create.isPending",
    words: ["만드는 중"],
    rendersVia: null,
    guard: "if (offline || create.isPending) return;",
  },
  {
    // 회전 1 이 데려온 여섯째 자리 (design-review #1595 H1). 초판은 이 자리를
    // 놓쳤다: 접힘이 `disabled={…}` 속성이 아니라 별칭(`submitBlocked`) 뒤에
    // 숨어 `aria-disabled` 와 `opacity-50` 을 몰고 있었고, 아래 스캔은 native
    // 속성만 봤다. 그 사각지대는 이제 「별칭 스캔」이 함께 막는다.
    name: "webhook-create",
    file: "WebhookSection.tsx",
    marker: 'data-testid="webhook-create"',
    lock: "createLocked",
    busy: "creating",
    words: ["만드는 중"],
    rendersVia: null,
    guard: "if (createLocked || creating) return;",
  },
  {
    name: "webhook-rotate",
    file: "WebhookSection.tsx",
    marker: "data-testid={`webhook-rotate-${installation.id}`}",
    lock: "rotateLocked",
    busy: "rotating",
    // 「회전」은 한자어 동작명사 → 「명사 + 중」 (#1501).
    words: ["회전 중"],
    // 낱말이 본문이 아니라 위에서 지어진다: 낭독되는 이름이 그 낱말을 따라
    // 움직여야 하므로(아래 label-in-name 절) 글자와 이름이 한 곳에서 나온다.
    rendersVia: "{rotateText}",
    guard: "if (rotateLocked || rotating) return;",
  },
  {
    name: "webhook-revoke",
    file: "WebhookSection.tsx",
    marker: "data-testid={`webhook-revoke-${installation.id}`}",
    lock: "revokeLocked",
    busy: "revoking",
    words: ["폐기 중"],
    rendersVia: "{revokeText}",
    guard: "if (revokeLocked || revoking) return;",
  },
  {
    name: "webhook-confirm-commit",
    file: "WebhookSection.tsx",
    marker: "data-testid={`webhook-${asking}-${installation.id}-commit`}",
    lock: "confirmLocked",
    // 이 확정은 자기 진행을 가질 수 없다: 쓰기를 내기 전에 `setAsking(null)` 이
    // 이 그룹을 걷어낸다. `aria-busy` 를 달면 아무 일도 없는 동안 「일어나는
    // 중」이라고 말하게 된다.
    busy: null,
    words: [],
    rendersVia: null,
    guard: "if (confirmLocked) return;",
  },
] as const satisfies readonly {
  name: string;
  file: FileName;
  marker: string;
  lock: string;
  busy: string | null;
  words: readonly string[];
  rendersVia: string | null;
  guard: string;
}[];

describe("#1559 RED PROOF ① 다섯 자리 어디에도 native disabled 가 없다", () => {
  for (const site of REMAINDER) {
    it(site.name, () => {
      const { tag } = controlByMarker(site.file, site.marker);
      expect(/(^|\s)disabled=/.test(tag), "native disabled 가 붙어 있다").toBe(
        false
      );
      expect(tag).toContain(`aria-disabled={${site.lock} || undefined}`);
      // `cn(…)` 의 전문이 아니라 흐림 항만 잰다: 같은 `cn` 이 폭 예약
      // (`min-w-action-sm`)도 나르므로(회전 1 Low), 전문 등치는 잠금과 무관한
      // 클래스가 하나 붙을 때마다 깨진다. 잰다고 말한 것은 흐림의 출처다.
      expect(tag).toContain(`${site.lock} && "opacity-50"`);
    });
  }
});

describe("#1559 RED PROOF ② 진행은 낱말과 aria-busy 로만 말해진다", () => {
  for (const site of REMAINDER) {
    it(site.name, () => {
      const { tag, body } = controlByMarker(site.file, site.marker);
      if (site.busy === null) {
        expect(tag).not.toContain("aria-busy=");
        return;
      }
      expect(tag).toContain(`aria-busy={${site.busy} || undefined}`);
      if (site.rendersVia === null) {
        for (const word of site.words) expect(body).toContain(word);
        return;
      }
      expect(body).toContain(site.rendersVia);
      for (const word of site.words) {
        expect(FILES[site.file]).toContain(`"${word}"`);
      }
    });
  }

  it("줄이 지는 진행은 그 줄로 좁혀진다 — 스무 줄이 함께 「회전 중」이 되지 않는다", () => {
    // `busy` 는 섹션 전체의 사실이다. 좁히는 열쇠는 뮤테이션이 들고 있는 인자다.
    const file = FILES["WebhookSection.tsx"];
    expect(file).toContain(
      "const rotatingId = rotate.isPending ? rotate.variables?.id : undefined;"
    );
    expect(file).toContain(
      "const revokingId = revoke.isPending ? revoke.variables?.id : undefined;"
    );
    expect(file).toContain("rotating={rotatingId === installation.id}");
    expect(file).toContain("revoking={revokingId === installation.id}");
    // 자기 쓰기는 잠금이 아니다. 그리고 재는 단위는 줄이 아니라 컨트롤이다:
    // 회전이 날고 있는 동안 같은 줄의 폐기는 진행 중이 아니라 잠긴 것이므로,
    // 줄 단위로 재면 날고 있는 회전 밑에서 같은 웹훅을 폐기하는 길이 열린다.
    expect(file).toContain(
      "const rotateLocked = offline || (busy && !rotating);"
    );
    expect(file).toContain(
      "const revokeLocked = offline || (busy && !revoking);"
    );
    expect(file).toContain("const confirmLocked = offline || busy;");
  });
});

describe("#1559 RED PROOF ③ 잠금은 가드를 함께 진다", () => {
  for (const site of REMAINDER) {
    it(site.name, () => {
      expect(FILES[site.file]).toContain(site.guard);
    });
  }

  it("세 폼의 가드는 onClick 이 아니라 submit 이 진다", () => {
    // 주소·사용 횟수·이름 칸에서 누른 Enter(암묵적 제출)도 같은 쓰기를 내므로,
    // `onClick` 에 두면 그 길이 열린 채 남는다.
    const guards: [FileName, string][] = [
      ["EventSubscriptionSection.tsx", "if (offline || create.isPending) return;"],
      ["InviteSection.tsx", "if (offline || create.isPending) return;"],
      ["WebhookSection.tsx", "if (createLocked || creating) return;"],
    ];
    for (const [file, guard] of guards) {
      expect(region(file, "submit")).toContain(guard);
    }
  });

  it("거절이 setAttempted 보다 먼저 선다", () => {
    // 보낼 수 없는 프레임에서 아직 다 적지도 않은 주소에 대고 규칙을 말하는 것은
    // 최악의 순간에 말하는 규칙이다.
    const submit = region("EventSubscriptionSection.tsx", "submit");
    expect(submit.indexOf("if (offline || create.isPending) return;")).toBeLessThan(
      submit.indexOf("setAttempted(true);")
    );
  });

  it("확인 그룹의 취소는 잠기지 않는다", () => {
    // 되돌릴 수 없는 쪽만 남기고 나가는 길을 막으면 그것은 확인이 아니라 덫이다.
    const cancel = controlByMarker(
      "WebhookSection.tsx",
      "data-testid={`webhook-${asking}-${installation.id}-cancel`}"
    ).tag;
    expect(/(^|\s)disabled=/.test(cancel)).toBe(false);
    expect(cancel).not.toContain("aria-disabled=");
  });
});

describe("#1559 RED PROOF ④ 잠긴 컨트롤이 사유를 든다", () => {
  it("이벤트 구독 만들기 — 오프라인 문장이 id 를 갖고, 버튼이 그것을 가리킨다", () => {
    const file = FILES["EventSubscriptionSection.tsx"];
    expect(
      controlByMarker(
        "EventSubscriptionSection.tsx",
        'data-testid="event-subscription-create"'
      ).tag
    ).toContain("aria-describedby={offline ? offlineReasonId : undefined}");
    expect(file).toContain("id={offlineReasonId}");
  });

  it("초대 링크 만들기 — 없던 문장이 생기고 배선된다", () => {
    const file = FILES["InviteSection.tsx"];
    expect(
      controlByMarker("InviteSection.tsx", 'data-testid="invite-create"').tag
    ).toContain("aria-describedby={offline ? OFFLINE_NOTE_ID : undefined}");
    expect(file).toContain("const OFFLINE_NOTE_ID =");
    expect(file).toContain("id={OFFLINE_NOTE_ID}");
    // 큐에 쌓이지 않는 발급이므로 「그대로 보내집니다」라고 약속하지 않는다.
    // 그 금지는 이제 이 파일만의 것이 아니다 — 아래 「회전 1」의 전 파일 스캔.
    expect(file).toContain(
      "연결이 끊겨 지금은 초대 링크를 만들 수 없습니다. 다시 연결되면 이어서 만들 수 있습니다."
    );
  });

  it("웹훅 목록 — 두 문장이 같은 자리에 서고 한 번에 하나만 그려진다", () => {
    const file = FILES["WebhookSection.tsx"];
    expect(file).toContain("const OFFLINE_ROW_REASON =");
    expect(file).toContain("const BUSY_ROW_REASON =");
    expect(file).toContain("if (offline) return offlineReasonId;");
    expect(file).toContain("return busy && !mine ? busyReasonId : undefined;");
    expect(file).toContain("{rows.length > 0 && offline && (");
    expect(file).toContain("{rows.length > 0 && !offline && busy && (");
    // 줄 **밖**이라는 사실이 이 파일에서는 정확성 문제다: 확인 프롬프트가 열리면
    // 그 줄의 액션 스트립이 통째로 대체되므로, 문장을 스트립 안에 두면 누군가
    // 묻기 시작하는 순간 나머지 줄들의 describedby 가 없는 id 를 가리킨다.
    const list = file.indexOf('data-testid="webhook-list"');
    const closeList = file.indexOf("</ul>", list);
    expect(file.slice(list, closeList)).not.toContain("id={offlineReasonId}");
  });

  it("웹훅 세 컨트롤이 **자기** 진행을 빼고 그 문장을 가리킨다", () => {
    // `mine` 이 참이면 이 컨트롤은 잠긴 것이 아니라 진행 중이고, 진행 중에 「왜
    // 못 하는지」를 읽어 주면 지금 그것을 못 한다는 뜻이 된다.
    const wired: [string, string][] = [
      ["data-testid={`webhook-rotate-${installation.id}`}", "lockReason(rotating)"],
      ["data-testid={`webhook-revoke-${installation.id}`}", "lockReason(revoking)"],
      [
        "data-testid={`webhook-${asking}-${installation.id}-commit`}",
        "lockReason(false)",
      ],
    ];
    for (const [marker, call] of wired) {
      expect(controlByMarker("WebhookSection.tsx", marker).tag).toContain(
        `aria-describedby={${call}}`
      );
    }
  });

  it("chain-add 의 세 사유가 전부 가리킬 문장을 갖는다 (#1541 이 남긴 배선)", () => {
    const file = FILES["AiLinkChain.tsx"];
    expect(control("AiLinkChain.tsx", "chain-add").tag).toContain(
      "aria-describedby={addLockReason()}"
    );
    // 오래 가는 사실부터. 셋을 동시에 대면 어느 쪽도 답이 아니다.
    expect(file).toContain("if (readOnly) return CHAIN_UNREADABLE_NOTE_ID;");
    expect(file).toContain("if (full) return CHAIN_FULL_NOTE_ID;");
    expect(file).toContain("return busy ? CHAIN_BUSY_NOTE_ID : undefined;");
    // 배너의 **문장**이 id 를 진다. 상자에 붙이면 「다시 시도」가 사유에 딸려 온다.
    expect(file).toContain("messageId={CHAIN_UNREADABLE_NOTE_ID}");
    expect(source("../common/States.tsx")).toContain(
      "<Message id={messageId} className=\"break-words\">"
    );
    // 가리키는 곳에 문장이 있다: 서는 조건이 고르는 조건과 같다.
    expect(file).toContain("{busy && !full && !readOnly && (");
    expect(file).toContain("id={CHAIN_BUSY_NOTE_ID}");
  });

  it("ai-link 세 컨트롤의 무사유 회색이 닫힌다 (design-review #1557 M)", () => {
    const file = FILES["AiLinkSection.tsx"];
    expect(file).toContain("if (offline) return LINK_OFFLINE_NOTE_ID;");
    expect(file).toContain("return busy && !mine ? LINK_BUSY_NOTE_ID : undefined;");
    expect(control("AiLinkSection.tsx", "ai-link-save").tag).toContain(
      "aria-describedby={lockReason(saving)}"
    );
    expect(control("AiLinkSection.tsx", "ai-link-check").tag).toContain(
      "aria-describedby={lockReason(checking)}"
    );
    expect(confirmCall("AiLinkSection.tsx", "ai-link-unlink")).toContain(
      "describedBy={lockReason(unlinking)}"
    );
    // 두 문장은 수정 폼 **밖**에 산다: 저장은 폼 안, 확인·해제는 폼이 닫힌
    // 자리에 있어 어느 한쪽에 두면 다른 쪽이 없는 id 를 가리킨다.
    const formEnd = file.indexOf("</form>");
    expect(file.indexOf("id={LINK_OFFLINE_NOTE_ID}")).toBeGreaterThan(formEnd);
    expect(file.indexOf("id={LINK_BUSY_NOTE_ID}")).toBeGreaterThan(formEnd);
  });
});

const IN_FLIGHT =
  /\b(isPending|busy|rotating|revoking|saving|checking|uploading|creating|toggling|removing|clearing|unlinking|sending|loading)\b/;

describe("#1559 스캔 — 설정 표면의 버튼에 in-flight native disabled 가 남지 않았다", () => {
  // 이 스위트가 자리를 하나씩 세는 동안 **빠뜨린 자리**를 잡는 그물이다. 새
  // 컨트롤이 `disabled={…isPending…}` 으로 들어오면 목록에 없어도 여기서 붉다.
  for (const [name, file] of Object.entries(FILES)) {
    it(name, () => {
      const offenders: string[] = [];
      for (const chunk of file.split("<Button").slice(1)) {
        const tag = openingTag(chunk);
        const native = tag.match(/(?:^|\s)disabled=\{([^}]*)\}/);
        if (native && IN_FLIGHT.test(native[1])) offenders.push(native[0].trim());
      }
      expect(offenders).toEqual([]);
    });
  }
});

// =============================================================================
// #1559 회전 1 — design-review #1595.
//
// 위 스캔이 `webhook-create` 를 통과시켰다. 그 자리는 #1558 이 정본에서 걷어낸
// 것과 **같은 결함**을 들고 있었는데(`submitBlocked = offline || busy || …`,
// `busy` 가 자기 `create.isPending` 을 포함), 접힘이 native `disabled` 속성이
// 아니라 **별칭 뒤**에 있어 속성만 보는 그물에 걸리지 않았다. #1558 의 red proof
// 주석이 경고한 그것이다: "결함은 `busy` 라는 글자가 아니라 접힘 변수 뒤에 숨어
// 있었다".
//
// 그래서 스캔을 한 겹 더 판다. 재는 규칙은 이렇다 — **진행을 낭독하는 버튼
// (`aria-busy`)의 잠금 식에는 그 진행의 부정이 서 있어야 한다.** 잠금 식을 별칭이
// 다 풀릴 때까지 펴고, 그 안에 in-flight 어휘가 남으면 `!<자기 진행>` 을 요구한다.
// 없는 진행에 대해서는(확인 그룹의 확정처럼 `aria-busy` 가 없는 자리) 아무것도
// 묻지 않는다 — 접을 진행이 없으므로 접힘도 없다.
// =============================================================================

/**
 * `const NAME = <한 줄 식>;` 의 우변. 중괄호가 든 우변(`useMutation({…})`)은
 * 값이 아니라 호출이므로 펴지 않는다.
 */
function aliasBody(file: string, name: string): string | null {
  const match = file.match(
    new RegExp(`\\bconst\\s+${name}\\s*=\\s*([^;\\n{}]+);`)
  );
  return match ? match[1] : null;
}

/** 별칭이 다 풀릴 때까지 편다. `submitBlocked` -> `offline || busy || …` -> …. */
function expandAliases(file: string, expr: string, depth = 4): string {
  if (depth === 0) return expr;
  let out = expr;
  for (const id of new Set(expr.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])) {
    const body = aliasBody(file, id);
    if (body === null) continue;
    out = out.replace(
      new RegExp(`\\b${id}\\b`, "g"),
      `(${expandAliases(file, body, depth - 1)})`
    );
  }
  return out;
}

/** 공백과 괄호를 걷어낸 꼴. `!(create.isPending)` 과 `!create.isPending` 은 같다. */
function flat(expr: string): string {
  return expr.replace(/[\s()]/g, "");
}

/** `attr={…}` 한 속성의 안쪽. `|| undefined` 꼬리는 잠금 사실이 아니다. */
function attrExpr(tag: string, attr: string): string | null {
  const at = tag.indexOf(`${attr}={`);
  if (at === -1) return null;
  const from = at + attr.length + 2;
  let depth = 0;
  for (let i = from; i < tag.length; i += 1) {
    if (tag[i] === "{") depth += 1;
    else if (tag[i] === "}") {
      if (depth === 0) return tag.slice(from, i).replace("|| undefined", "");
      depth -= 1;
    }
  }
  return null;
}

describe("#1559 회전 1 · 별칭 스캔 — 접힘은 이름 뒤에도 숨지 못한다", () => {
  for (const [name, file] of Object.entries(FILES)) {
    it(name, () => {
      const offenders: string[] = [];
      for (const chunk of file.split("<Button").slice(1)) {
        const tag = openingTag(chunk);
        const busy = attrExpr(tag, "aria-busy");
        // 진행을 낭독하지 않는 버튼은 접을 진행이 없다.
        if (busy === null) continue;
        const locks = [
          attrExpr(tag, "aria-disabled"),
          // 흐림도 잠금이다. `cn(x && "opacity-50")` 의 x 가 그 식이다.
          tag.match(/className=\{cn\(([\s\S]*?)"opacity-50"\)\}/)?.[1] ?? null,
        ].filter((lock): lock is string => lock !== null);

        for (const lock of locks) {
          const opened = expandAliases(file, lock);
          if (!IN_FLIGHT.test(opened)) continue;
          // in-flight 가 잠금에 남아 있다면, 그것을 가르는 부정이 함께 있어야
          // 한다. `busy && !rotating` 은 통과하고 `offline || busy` 는 붉다.
          const negated = `!${flat(expandAliases(file, busy))}`;
          if (!flat(opened).includes(negated)) {
            offenders.push(`${tag.slice(0, 60).trim()}… lock=${lock.trim()}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("그물이 실제로 그 결함을 잡는다 — 초판 webhook-create 로 재현", () => {
    // 그물이 아무것도 안 잡는 그물일 수 있으므로, 회전 1 이 고친 그 식을 그대로
    // 되돌린 소스에 대고 한 번 돌린다.
    const broken = FILES["WebhookSection.tsx"]
      .replace(
        "const createLocked = offline || noChannels || (busy && !creating);",
        "const submitBlocked = offline || busy || channelChoices.length === 0;"
      )
      .replace("aria-disabled={createLocked || undefined}", "aria-disabled={submitBlocked || undefined}")
      .replace('className={cn(createLocked && "opacity-50")}', 'className={cn(submitBlocked && "opacity-50")}');
    const tag = openingTag(
      broken.split("<Button").find((c) => c.includes('data-testid="webhook-create"')) ?? ""
    );
    const lock = attrExpr(tag, "aria-disabled") ?? "";
    const busy = attrExpr(tag, "aria-busy") ?? "";
    expect(IN_FLIGHT.test(expandAliases(broken, lock))).toBe(true);
    expect(
      flat(expandAliases(broken, lock)).includes(
        `!${flat(expandAliases(broken, busy))}`
      )
    ).toBe(false);
  });
});

describe("#1559 회전 1 · 웹훅 만들기가 사유를 든다 (#1595 H2)", () => {
  const file = FILES["WebhookSection.tsx"];

  it("잠그는 사실 셋이 각자의 문장을 갖는다", () => {
    expect(file).toContain("const OFFLINE_CREATE_REASON =");
    expect(file).toContain("const NO_CHANNEL_CREATE_REASON =");
    expect(file).toContain("const BUSY_CREATE_REASON =");
    expect(
      controlByMarker("WebhookSection.tsx", 'data-testid="webhook-create"').tag
    ).toContain("aria-describedby={createLockReason()}");
    expect(file).toContain("if (offline) return createOfflineReasonId;");
    expect(file).toContain("if (noChannels) return createNoChannelReasonId;");
    expect(file).toContain(
      "return busy && !creating ? createBusyReasonId : undefined;"
    );
  });

  it("가리키는 곳에 문장이 있다 — 서는 조건이 고르는 조건과 같다", () => {
    expect(file).toContain("{offline && (");
    expect(file).toContain("{!offline && noChannels && (");
    expect(file).toContain("{!offline && !noChannels && busy && !creating && (");
  });

  it("빈 상태에서도 사유가 선다 — rows.length 게이트 밖이다", () => {
    // 목록의 두 문장은 `rows.length > 0` 에서만 서므로 웹훅이 하나도 없는
    // 프레임에서는 화면에 없다. 그 프레임이 정확히 빈 상태이고, 빈 상태의 주
    // CTA 가 이 버튼이다 — 거기서 무사유 회색이던 것이 이 절의 결함이다.
    const bare = copyOnly(file);
    const from = bare.indexOf('data-testid="webhook-create-form"');
    expect(from).toBeGreaterThan(-1);
    const form = bare.slice(from, bare.indexOf("</form>", from));
    for (const testId of [
      "webhook-create-offline",
      "webhook-create-no-channel",
      "webhook-create-busy",
    ]) {
      expect(form, `${testId} 가 폼 안에 없다`).toContain(testId);
    }
    expect(form).not.toContain("rows.length");
  });
});

describe("#1559 회전 1 · 거짓 약속 (#1595 H4)", () => {
  it("어느 표면도 오프라인 큐를 약속하지 않는다", () => {
    // 이 클라이언트에 오프라인 큐는 없다. 아래 단정이 그 사실 자체를 잰다.
    for (const [name, file] of Object.entries(FILES)) {
      expect(copyOnly(file), name).not.toContain("그대로 보내집니다");
    }
  });

  it("없는 것이 정말 없다 — networkMode·onlineManager 부재", () => {
    // 문장이 거짓인 근거는 이것이다. 큐가 생기는 날 이 단정이 먼저 붉어지고,
    // 그때 문장을 되돌리는 것이 옳은 순서다.
    for (const [name, file] of Object.entries(FILES)) {
      expect(copyOnly(file), name).not.toMatch(
        /\bnetworkMode\b|\bonlineManager\b/
      );
    }
  });

  it("두 표면이 같은 잠금에 같은 사실을 말한다", () => {
    expect(FILES["EventSubscriptionSection.tsx"]).toContain(
      "서버와 연결이 끊겨 지금은 만들 수 없습니다. 다시 연결되면 이어서 만들 수 있습니다."
    );
    expect(FILES["InviteSection.tsx"]).toContain("다시 연결되면 이어서 만들 수 있습니다.");
    expect(FILES["WebhookSection.tsx"]).toContain("다시 연결되면 이어서 만들 수 있습니다.");
  });
});

describe("#1559 회전 1 · in-flight 는 fieldset 을 끄지 않는다 (#1595 H3)", () => {
  // `<fieldset disabled>` 는 초점을 쥔 라디오를 끄고 초점을 <body> 로 떨어뜨린다.
  // `ChoiceRadios.busy` 가 정확히 그 용도로 있고 독스트링이 그 실패를 적어 두었다.
  // 자리 목록이 아니라 features/ 전수인 이유는 #1558 의 canSave 스캔과 같다: 새
  // 소비처도 자동으로 이 규율 아래 선다.
  const FEATURES_DIR = fileURLToPath(new URL("..", import.meta.url));

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(path);
      return entry.name.endsWith(".tsx") ? [path] : [];
    });
  }

  it("모든 ChoiceRadios 소비처의 disabled 식에 진행 어휘가 없다", () => {
    let seen = 0;
    for (const path of tsxFiles(FEATURES_DIR)) {
      const text = readFileSync(path, "utf8");
      for (const chunk of text.split("<ChoiceRadios").slice(1)) {
        const end = chunk.indexOf("/>");
        const call = chunk.slice(0, end === -1 ? undefined : end);
        seen += 1;
        const disabled = call.match(/\sdisabled=\{([^}]*)\}/)?.[1];
        if (disabled === undefined) continue;
        expect(
          IN_FLIGHT.test(disabled),
          `${path}: disabled={${disabled}} 가 in-flight 로 fieldset 을 끈다`
        ).toBe(false);
      }
    }
    // 하나도 안 잡히면 이 단정은 공허하게 초록이다. 오늘의 실측은 여섯이다.
    expect(seen).toBeGreaterThanOrEqual(6);
  });
});

describe("#1559 회전 1 · 되돌리기가 사유 없이 침묵하지 않는다 (#1595 M5)", () => {
  const file = source("./WorkHostSection.tsx");

  it("두 자리 다 잠금을 그리고 낭독한다", () => {
    for (const testId of ["work-host-revert", "work-tier-revert-${scope}"]) {
      const marker = testId.includes("$")
        ? `data-testid={\`${testId}\`}`
        : `data-testid="${testId}"`;
      const chunk = file
        .split("<Button")
        .find((part) => part.includes(marker));
      expect(chunk, `${testId} 가 없다`).toBeTruthy();
      const tag = openingTag(chunk ?? "");
      expect(tag).toContain("aria-disabled={save.isPending || undefined}");
      expect(tag).toContain('className={cn(save.isPending && "opacity-50")}');
      expect(tag).toContain("aria-describedby={");
      expect(tag).toContain("choiceRadiosHintId(");
    }
  });

  it("사유는 새로 쓰이지 않고 그룹이 이미 세운 문장을 가리킨다", () => {
    // 잠금 하나에 문장 하나. 여기 한 번 더 쓰면 같은 사실이 한 화면에 두 번 선다.
    // 규약의 주인은 하나다. 컴포넌트 파일 밖에 사는 이유는 그 모듈 머리말에.
    expect(source("./fieldIds.ts")).toContain(
      "export function choiceRadiosHintId("
    );
    expect(source("./SettingsFields.tsx")).toContain(
      "const hintId = hint ? choiceRadiosHintId(name) : undefined;"
    );
    expect(file).toContain('const engineRadiosName = "work-host-engine";');
    expect(file).toContain("const modeRadiosName = `work-tier-mode-${scope}`;");
    expect(file).toContain("엔진을 저장하는 중입니다.");
    expect(file).toContain("정책을 저장하는 중입니다.");
  });
});

describe("#1559 회전 1 · 줄의 이름과 폭 (#1595 Low 둘)", () => {
  const file = FILES["WebhookSection.tsx"];

  it("이름이 줄을 지고 낱말을 따라 움직인다 — label-in-name", () => {
    // 2.5.3 은 보이는 글자를 **포함**할 것만 요구한다. 스무 줄이 같은 이름의 탭
    // 스톱 스무 개가 되는 문제는 같은 줄의 `CopyButton` 이 `subject` 로 이미 푼다.
    expect(file).toContain('const rotateText = rotating ? "회전 중" : "비밀값 회전";');
    expect(file).toContain('const revokeText = revoking ? "폐기 중" : "폐기";');
    for (const [marker, text] of [
      ["data-testid={`webhook-rotate-${installation.id}`}", "rotateText"],
      ["data-testid={`webhook-revoke-${installation.id}`}", "revokeText"],
    ] as const) {
      const tag = controlByMarker("WebhookSection.tsx", marker).tag;
      expect(tag).toContain(`aria-label={\`\${installation.label} \${${text}}\`}`);
    }
  });

  it("낱말이 바뀌어도 폭은 움직이지 않는다 — 파괴적 형제가 밀리지 않는다", () => {
    // tokens.css §4 의 `--spacing-action-sm` 이 있는 이유가 이 실패다(MOMO-676
    // M-3). 「비밀값 회전」 -> 「회전 중」은 그 오른쪽의 [폐기]를 포인터 아래에서
    // 움직인다.
    for (const marker of [
      "data-testid={`webhook-rotate-${installation.id}`}",
      "data-testid={`webhook-revoke-${installation.id}`}",
    ]) {
      expect(controlByMarker("WebhookSection.tsx", marker).tag).toContain(
        'className={cn("min-w-action-sm"'
      );
    }
  });
});

describe("#1559 회전 1 · 사유 문장은 한글 규칙으로 접힌다 (#1595 M6)", () => {
  // 사유는 두세 어절 문장이라 좁은 칸에서 어절 중간이 끊긴다. 이 diff 가 세운
  // 사유 노드 전부가 `break-keep` 을 갖는다 — 하나만 빠지면 그 하나만 다르게
  // 접힌다.
  for (const [name, file] of Object.entries(FILES)) {
    it(name, () => {
      const offenders: string[] = [];
      for (const tagMatch of file.matchAll(/<(?:p|span)\s[\s\S]*?>/g)) {
        const tag = tagMatch[0];
        const id = tag.match(/\bid=\{([^}]*)\}/)?.[1] ?? "";
        if (!/reason|note/i.test(id)) continue;
        if (!tag.includes("break-keep")) offenders.push(id);
      }
      expect(offenders).toEqual([]);
    });
  }
});
