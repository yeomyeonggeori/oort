import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { beforeAll, describe, expect, it } from "vitest";
import { BUSY_LOCK_GRAMMAR_FILES, BUSY_LOCK_PRIMITIVES_FILE } from "./busyLockScope.js";

/**
 * 진행·잠금 문법 린트 규칙(`busyLockGrammar.js`)이 옛 시험이 막던 변조를 실제로 빨갛게 잡는가.
 *
 * 이 파일은 소스 파일을 읽지 않는다. 변조한 소스 한 조각을 **실제 eslint.config.js 로** 린트해서
 * 규칙 메시지의 messageId 를 단정한다 — 설정 연결(파일 범위)과 규칙 본문을 한 번에 건다.
 * `fatal`(구문 오류)을 따로 세는 이유: 깨진 fixture 가 「빨강」으로 읽히면 규칙이 아무것도 못 잡아도
 * 초록이 되기 때문이다. 조각은 `offline`·`busy`·`create` 같은 이름을 선언하지 않는다(미선언 식별자는
 * 규칙에게 속을 모르는 값이다) — 조각 안에서 `const busy = …` 별칭을 쓸 때 이름이 겹치지 않게 하려는 것이다.
 *
 * 쓴 곳: 시험 정리 T5(#4711) 첫 묶음. 옛 `rawControlBusySplit`·`confirmBusySplit`·
 * `settingsFieldsBusy` 시험의 그물을 이 규칙으로 옮겼고, 아래 describe 마다 「옛 시험의 어느
 * 변조인가」를 적었다.
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: WEB_ROOT });

// 설정(typescript-eslint 등)을 읽는 첫 린트가 가장 느리다. 시험 하나의 기본 5초가 아니라 훅의 자기
// 예산 안에서 치른다(다른 시험들이 Chromium 을 훅에서 띄우는 것과 같은 이유).
beforeAll(async () => {
  await eslint.lintText("export {};\n", { filePath: join(WEB_ROOT, "src/features/settings/WebhookSection.tsx") });
}, 60_000);

/** 옛 시험 셋이 이름을 달아 재던 열한 파일. 범위 목록(busyLockScope.js)은 이보다 줄 수 없다. */
const ORIGINAL_SCOPE = [
  "src/features/settings/EventSubscriptionSection.tsx",
  "src/features/settings/AiLinkSection.tsx",
  "src/features/settings/AiLinkChain.tsx",
  "src/features/settings/WorkspaceSection.tsx",
  "src/features/settings/InviteSection.tsx",
  "src/features/settings/WebhookSection.tsx",
  "src/features/settings/LeaveWorkspaceRow.tsx",
  "src/features/settings/LinkedDevicesList.tsx",
  "src/features/settings/SettingsFields.tsx",
  "src/features/hostedAgents/HostedConnectionSection.tsx",
  "src/features/hostedAgents/DoorbellSection.tsx",
];
/** 규칙 `busy-lock-grammar` 범위 안의 파일. */
const GRAMMAR_FILE = "src/features/settings/WebhookSection.tsx";
/** 범위 밖의 features 파일 — `<Button disabled>` 가 합법인 곳(`in-flight-lock-props` 만 선다). */
const OUTSIDE_FILE = "src/features/agentHub/AgentChannelsSection.tsx";

async function lint(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(WEB_ROOT, file) });
  const fatal = result.messages.filter((message) => message.fatal);
  expect(fatal.map((message) => message.message), "fixture 가 구문 오류다").toEqual([]);
  return result.messages
    .filter((message) => message.ruleId?.startsWith("momo/"))
    .map((message) => message.messageId ?? message.message);
}

/**
 * 규칙 본문의 결과(종류별로 한 번씩, 정렬). 정의 파일(SettingsFields.tsx) 경로로 린트하는 조각은
 * 컴포넌트를 export 하지 않아 `busy-lock-primitives` 도 붉으므로, 그 규칙의 결과는 아래 마지막
 * describe 에서 따로 잰다.
 */
async function findings(code: string, file: string): Promise<string[]> {
  const ids = (await lint(code, file)).filter((id) => id !== "missingPrimitive");
  return [...new Set(ids)].sort();
}

/** 한 조각을 컴포넌트 안에 넣는다. 별칭(const)은 body 에 적는다. */
function component(body: string, jsx: string): string {
  return `export function Row() {
  ${body}
  return (
    <div>
      ${jsx}
    </div>
  );
}
`;
}

/** 진행을 말하는 `<Button>` 한 개. 잠금·흐림·진행 식과 추가 className 인자를 바꿔 끼운다. */
function button(options: { lock?: string; busy?: string; cn?: string; extra?: string }): string {
  const attrs = [
    options.lock === undefined ? "" : `aria-disabled={${options.lock} || undefined}`,
    options.busy === undefined ? "" : `aria-busy={${options.busy} || undefined}`,
    options.cn === undefined ? "" : `className={cn(${options.cn})}`,
    options.extra ?? "",
  ].filter(Boolean);
  return `<Button ${attrs.join(" ")}>저장</Button>`;
}

describe("rawControlBusySplit ① + 그물 — 버튼은 native disabled 로 잠그지 않는다", () => {
  it("<Button disabled={…}> 는 진행 어휘가 있든 별칭 뒤에 있든 붉다", async () => {
    const direct = component(
      "const creating = create.isPending;",
      "<Button disabled={creating} onClick={go}>만들기</Button>"
    );
    const aliased = component(
      "const submitBlocked = offline || busy;",
      "<Button disabled={submitBlocked}>만들기</Button>"
    );
    const bare = component("", "<Button disabled onClick={go}>만들기</Button>");
    expect(await findings(direct, GRAMMAR_FILE)).toEqual(["nativeDisabled"]);
    expect(await findings(aliased, GRAMMAR_FILE)).toEqual(["nativeDisabled"]);
    expect(await findings(bare, GRAMMAR_FILE)).toEqual(["nativeDisabled"]);
  });

  it("폼 필드·ConfirmButton 의 disabled 와 aria-disabled 버튼은 붉지 않다", async () => {
    const ok = component(
      "",
      `<input disabled={offline} />
      <ConfirmButton disabled={offline} label="지우기" />
      ${button({ lock: "offline", cn: 'offline && "opacity-50"' })}`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });

  it("범위 밖 파일의 <Button disabled> 와 흐림은 이 규칙의 대상이 아니다", async () => {
    const outside = component(
      "",
      `<Button disabled={busy}>추가</Button>
      ${button({ busy: "busy", cn: 'busy && "opacity-60"' })}`
    );
    expect(await findings(outside, OUTSIDE_FILE)).toEqual([]);
  });

  it.each(BUSY_LOCK_GRAMMAR_FILES)("범위의 파일에 규칙이 선다 — %s", async (file) => {
    const bad = component("", "<Button disabled>저장</Button>");
    expect(await findings(bad, file)).toEqual(["nativeDisabled"]);
  });

  it("범위 목록은 옛 열한 파일보다 줄지 않고, 목록의 파일은 모두 디스크에 있다(옮기면 규칙이 조용히 빠지지 않고 붉다)", () => {
    expect(BUSY_LOCK_GRAMMAR_FILES).toEqual(expect.arrayContaining(ORIGINAL_SCOPE));
    const missing = [...BUSY_LOCK_GRAMMAR_FILES, BUSY_LOCK_PRIMITIVES_FILE].filter(
      (file) => !existsSync(join(WEB_ROOT, file))
    );
    expect(missing).toEqual([]);
  });
});

describe("rawControlBusySplit 별칭 스캔 · confirmBusySplit ② · settingsFieldsBusy ② — 진행은 자기 잠금 식에 끼지 않는다", () => {
  it("aria-disabled 에 자기 진행이 직접 든다", async () => {
    const code = component(
      "",
      button({ lock: "offline || creating", busy: "creating", cn: '(offline || creating) && "opacity-50"' })
    );
    expect(await findings(code, GRAMMAR_FILE)).toEqual(["selfLock"]);
  });

  it("초판 webhook-create — 잠금이 별칭(submitBlocked) 뒤에서 busy 를 통째로 든다 (#1595 H1)", async () => {
    // 이 한 조각이 옛 시험의 「그물이 실제로 그 결함을 잡는다」 자기 시험이 재현하던 소스다.
    const original = component(
      "const submitBlocked = offline || busy || channelChoices.length === 0;",
      button({ lock: "submitBlocked", busy: "creating", cn: 'submitBlocked && "opacity-50"' })
    );
    expect(await findings(original, GRAMMAR_FILE)).toEqual(["selfLock"]);
  });

  it("흐림 조건에만 숨은 접힘도 잡는다(aria-disabled 는 깨끗하다)", async () => {
    const dimOnly = component(
      "",
      button({ lock: "offline", busy: "creating", cn: '(offline || creating) && "opacity-50"' })
    );
    expect(await findings(dimOnly, GRAMMAR_FILE)).toContain("selfLock");
  });

  it("ConfirmButton 의 disabled 가 자기 busy 를 든다 — 직접, 그리고 진행 어휘가 아닌 이름의 별칭 뒤", async () => {
    const direct = component(
      "",
      `<ConfirmButton label="지우기" disabled={offline || removing} busy={removing} />`
    );
    // `starting` 은 진행 어휘 목록에 없다. 어휘 검사로는 못 잡고, 「자기 진행 하나만으로 잠금이 켜지는가」로 잡힌다.
    const hiddenName = component(
      "const locked = blocked || starting;",
      `<ConfirmButton label="해제" disabled={locked} busy={starting} />`
    );
    expect(await findings(direct, GRAMMAR_FILE)).toEqual(["selfLock"]);
    expect(await findings(hiddenName, GRAMMAR_FILE)).toEqual(["selfLock"]);
  });

  it.each([
    ["Boolean(…)", "const createLocked = Boolean(offline || busy);"],
    ["x as boolean", "const createLocked = (offline || busy) as boolean;"],
    ["useMemo(() => x)", "const createLocked = useMemo(() => offline || busy, [offline, busy]);"],
    ["useMemo 블록 몸통", "const createLocked = useMemo(() => {\n    return offline || busy;\n  }, [offline, busy]);"],
  ])("꺼풀로 감싼 별칭 %s 도 벗겨서 본다", async (_name, alias) => {
    const code = component(
      alias,
      button({ lock: "createLocked", busy: "creating", cn: "createLocked && \"opacity-50\"" })
    );
    expect(await findings(code, GRAMMAR_FILE)).toEqual(["selfLock"]);
  });

  it("꺼풀로 감싸도 올바른 문법은 붉지 않다", async () => {
    const code = component(
      "const createLocked = Boolean(offline || (busy && !creating));",
      button({ lock: "createLocked", busy: "creating", cn: "createLocked && \"opacity-50\"" })
    );
    expect(await findings(code, GRAMMAR_FILE)).toEqual([]);
  });

  it("삼항 안에 숨은 접힘도 진리표가 본다 — 진행 어휘가 아닌 이름", async () => {
    const hidden = component(
      "const locked = offline || (starting ? true : blocked);",
      `<ConfirmButton label="시작" disabled={locked} busy={starting} />`
    );
    const clean = component(
      "const locked = offline || (blocked ? true : false);",
      `<ConfirmButton label="시작" disabled={locked} busy={starting} />`
    );
    expect(await findings(hidden, GRAMMAR_FILE)).toEqual(["selfLock"]);
    expect(await findings(clean, GRAMMAR_FILE)).toEqual([]);
  });

  it("자기 진행이 둘로 펴져도(복합) 한쪽만으로 잠기면 붉고, 둘 다 가르면 붉지 않다", async () => {
    const aliases = `const creating = create.isPending;
  const rotating = rotate.isPending;
  const writing = creating || rotating;
  const busy = create.isPending || rotate.isPending || revoke.isPending;`;
    const folded = component(
      `${aliases}\n  const locked = offline || (busy && !creating);`,
      button({ lock: "locked", busy: "writing", cn: 'locked && "opacity-50"' })
    );
    const split = component(
      `${aliases}\n  const locked = offline || (busy && !creating && !rotating);`,
      button({ lock: "locked", busy: "writing", cn: 'locked && "opacity-50"' })
    );
    expect(await findings(folded, GRAMMAR_FILE)).toEqual(["selfLock"]);
    expect(await findings(split, GRAMMAR_FILE)).toEqual([]);
  });

  it("복합 진행의 둘째 항만 접혀도 붉다 — 진행 어휘가 아닌 이름이라 의미 검사만 볼 수 있다", async () => {
    const second = component(
      "const writing = starting || stopping;\n  const locked = offline || blocked || stopping;",
      `<ConfirmButton label="멈추기" disabled={locked} busy={writing} />`
    );
    const clean = component(
      "const writing = starting || stopping;\n  const locked = offline || blocked;",
      `<ConfirmButton label="멈추기" disabled={locked} busy={writing} />`
    );
    expect(await findings(second, GRAMMAR_FILE)).toEqual(["selfLock"]);
    expect(await findings(clean, GRAMMAR_FILE)).toEqual([]);
  });

  it("진리표 상한을 넘는 잠금 식은 건너뛰지 않고 붉다(조용한 통과 금지)", async () => {
    const atoms = Array.from({ length: 16 }, (_, index) => `flag${index}`);
    const huge = component(
      "",
      `<ConfirmButton label="지우기" disabled={${atoms.join(" || ")}} busy={removing} />`
    );
    const small = component(
      "",
      `<ConfirmButton label="지우기" disabled={${atoms.slice(0, 6).join(" || ")}} busy={removing} />`
    );
    expect(await findings(huge, GRAMMAR_FILE)).toEqual(["lockTooComplex"]);
    expect(await findings(small, GRAMMAR_FILE)).toEqual([]);
  });

  it("SaveButton 정본의 #1558 원형 — blocked = !canSave || busy 가 aria-disabled·흐림에 걸린다", async () => {
    const original = component(
      "const blocked = !canSave || busy;",
      button({ lock: "blocked", busy: "busy", cn: 'blocked && "opacity-50"' })
    );
    const messages = await findings(original, "src/features/settings/SettingsFields.tsx");
    expect(messages).toEqual(["selfLock"]);
  });

  it("형제 쓰기로 잠기는 올바른 문법은 붉지 않다 — 별칭 busy 가 자기 진행을 품어도", async () => {
    const ok = component(
      `const creating = create.isPending;
  const busy = create.isPending || rotate.isPending || revoke.isPending;
  const createLocked = offline || noChannels || (busy && !creating);`,
      `${button({ lock: "createLocked", busy: "creating", cn: 'createLocked && "opacity-50"' })}
      <ConfirmButton label="지우기" disabled={offline || (busy && !removing)} busy={removing} />
      <ConfirmButton label="나가기" disabled={offline} busy={leave.isPending} />`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });

  it("자기 진행이 `a || b` 로 펴진 올바른 꼴은 붉지 않다 — 식 전체의 부정으로 가르든 직접 쓰든", async () => {
    const aliases = `const creating = create.isPending;
  const rotating = rotate.isPending;
  const writing = creating || rotating;
  const busy = create.isPending || rotate.isPending || revoke.isPending;`;
    const viaAlias = component(
      `${aliases}\n  const locked = offline || (busy && !writing);`,
      button({ lock: "locked", busy: "writing", cn: 'locked && "opacity-50"' })
    );
    const inline = component(
      "const busy = create.isPending || rotate.isPending || revoke.isPending;",
      `<ConfirmButton label="지우기" disabled={offline || (busy && !(create.isPending || rotate.isPending))} busy={create.isPending || rotate.isPending} />`
    );
    expect(await findings(viaAlias, GRAMMAR_FILE)).toEqual([]);
    expect(await findings(inline, GRAMMAR_FILE)).toEqual([]);
  });

  it("자기 진행이 `a && b` 로 펴진 올바른 꼴도 붉지 않고, 자기 진행을 맨몸으로 든 꼴은 붉다", async () => {
    // 실제 모양: GithubOperatorBlock(attach.isPending && attach.variables === id) ·
    // DmApprovalSection(write.isPending && write.variables?.row.channelId === row.channelId).
    const attaching = "const attaching = attach.isPending && attach.variables === installation.installationId;";
    const ok = component(
      attaching,
      `<ConfirmButton label="연결" disabled={offline || (attach.isPending && !attaching)} busy={attaching} />`
    );
    const okButton = component(
      `const rotating = rotate.isPending && rotate.variables?.id === installation.id;
  const busy = rotate.isPending || revoke.isPending;
  const rotateLocked = offline || (busy && !rotating);`,
      button({ lock: "rotateLocked", busy: "rotating", cn: 'rotateLocked && "opacity-50"' })
    );
    const dmApproval = component(
      `const busy = write.isPending && write.variables?.row.channelId === row.channelId;
  const locked = offline || write.isPending;`,
      `<ConfirmButton label="닫기" disabled={locked && !busy} busy={busy} />`
    );
    const folded = component(
      attaching,
      `<ConfirmButton label="연결" disabled={offline || attaching} busy={attaching} />`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
    expect(await findings(okButton, GRAMMAR_FILE)).toEqual([]);
    expect(await findings(dmApproval, GRAMMAR_FILE)).toEqual([]);
    expect(await findings(folded, GRAMMAR_FILE)).toEqual(["selfLock"]);
  });

  it("다른 컨트롤의 진행 어휘가 잠금 식에 자기 진행의 부정 없이 남으면 붉다 — 옛 별칭 스캔의 어휘 검사", async () => {
    // 옛 스캔은 잠금 식을 편 뒤 진행 어휘가 남아 있으면 `!자기진행` 을 요구했다. 자기 진행(saving)은 잠금에
    // 나오지 않으므로 진리표(나)는 못 보고, 어휘 검사(가)만 이 자리를 본다.
    const bare = component(
      "",
      button({ lock: "offline || creating", busy: "saving", cn: '(offline || creating) && "opacity-50"' })
    );
    const split = component(
      "",
      button({
        lock: "offline || (creating && !saving)",
        busy: "saving",
        cn: '(offline || (creating && !saving)) && "opacity-50"',
      })
    );
    expect(await findings(bare, GRAMMAR_FILE)).toEqual(["selfLock"]);
    expect(await findings(split, GRAMMAR_FILE)).toEqual([]);
  });

  it("식 안의 설명 주석이 어휘 검사를 붉히지 않는다 — 주석은 노드가 아니다", async () => {
    const lockComment = component(
      "",
      `<ConfirmButton label="지우기" disabled={offline || // saving 중에는 아래 항이 잠근다
        confirming} busy={removing} />`
    );
    const buttonComment = component(
      "",
      `<Button aria-disabled={offline || // 일부러 creating 을 뺐다
        confirming || undefined} aria-busy={creating || undefined} className={cn((offline || confirming) && "opacity-50")}>저장</Button>`
    );
    expect(await findings(lockComment, GRAMMAR_FILE)).toEqual([]);
    expect(await findings(buttonComment, GRAMMAR_FILE)).toEqual([]);
  });
});

describe("rawControlBusySplit ③ · settingsFieldsBusy ② — 흐림은 aria-disabled 와 같은 식 하나가 켠다", () => {
  it("흐림 조건이 잠금 식과 다르거나 흐림이 아예 없다", async () => {
    const mismatch = component("", button({ lock: "offline", cn: 'busy && "opacity-50"' }));
    const missing = component("", button({ lock: "offline", extra: 'className="p-2"' }));
    expect(await findings(mismatch, GRAMMAR_FILE)).toEqual(["opacityFollowsLock"]);
    expect(await findings(missing, GRAMMAR_FILE)).toEqual(["opacityFollowsLock"]);
  });

  it("고정 클래스의 흐림 계열(변형 접두 포함)은 늘 흐린 버튼을 만든다", async () => {
    const fixed = component("", button({ lock: "offline", cn: '"opacity-50 p-2", offline && "opacity-50"' }));
    const variant = component("", button({ lock: "offline", cn: '"hover:opacity-70", offline && "opacity-50"' }));
    expect(await findings(fixed, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
    expect(await findings(variant, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
  });

  it("고정 클래스가 앞에 붙은 올바른 짝은 붉지 않다", async () => {
    const ok = component("", button({ lock: "offline", cn: '"min-w-action-sm tap-target", offline && "opacity-50"' }));
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });

  // 아래 넷은 옛 정규식·등치가 모르는 꼴이면 빨갰던 자리다(전문 등치). 규칙은 흐림 토큰이 잠금 인자 밖에 보이면
  // 모양과 상관없이 붉어야 한다. 모두 실제 컴포넌트 한 줄을 이렇게 바꾼 변조다.
  it("진행(busy)이 흐림을 더 켠다 — SaveButton 정본 모양 `cn(!canSave && …, busy && opacity-70)`", async () => {
    const code = component(
      "",
      button({ lock: "!canSave", busy: "busy", cn: '!canSave && "opacity-50", busy && "opacity-70"' })
    );
    expect(await findings(code, "src/features/settings/SettingsFields.tsx")).toEqual(["opacityOutsideLock", "selfLock"]);
  });

  it("ConfirmButton 트리거 모양 — `cn(triggerClassName, disabled && …, busy && opacity-60)`", async () => {
    const code = component(
      "",
      button({ lock: "disabled", busy: "busy", cn: 'triggerClassName, disabled && "opacity-50", busy && "opacity-60"' })
    );
    expect(await findings(code, "src/features/settings/SettingsFields.tsx")).toEqual(["opacityOutsideLock", "selfLock"]);
  });

  it("삼항 가지의 흐림 — `cn(locked && …, toggling ? opacity-60 : '')`", async () => {
    const code = component(
      "",
      button({ lock: "toggleLocked", busy: "toggling", cn: 'toggleLocked && "opacity-50", toggling ? "opacity-60" : ""' })
    );
    expect(await findings(code, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
  });

  it.each([
    ["const 별칭(삼항)", 'const dimClass = toggling ? "opacity-60" : "";', 'toggleLocked && "opacity-50", dimClass'],
    ["조건부 별칭", 'const dimClass = "opacity-60";', 'toggleLocked && "opacity-50", other && dimClass'],
    ["겹친 별칭", 'const base = "opacity-60";\n  const dimClass = base;', 'toggleLocked && "opacity-50", dimClass'],
    ["배열 별칭 스프레드", 'const extra = ["opacity-70"];', 'toggleLocked && "opacity-50", ...extra'],
    ["별칭 안의 cn 호출", 'const dim = cn("p-2", "opacity-60");', 'toggleLocked && "opacity-50", dim'],
  ])("변수에 담긴 클래스 문자열도 따라간다 — %s", async (_name, decl, args) => {
    const code = component(decl, button({ lock: "toggleLocked", busy: "toggling", cn: args }));
    expect(await findings(code, GRAMMAR_FILE)).toContain("opacityOutsideLock");
  });

  it("진행만 있는 버튼의 className 이 별칭이어도 따라가고, 풀리지 않는 값(prop)은 건드리지 않는다", async () => {
    const aliasClass = component(
      'const dimClass = "opacity-50";',
      '<Button aria-busy={creating || undefined} className={dimClass}>저장</Button>'
    );
    const unresolved = component("", button({ lock: "disabled", cn: 'triggerClassName, disabled && "opacity-50"' }));
    expect(await findings(aliasClass, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
    expect(await findings(unresolved, GRAMMAR_FILE)).toEqual([]);
  });

  it("잠금 인자의 오른쪽이 별칭이어도 값이 opacity-50 이면 붉지 않고, 다른 값이면 붉다", async () => {
    const same = component('const LOCK_DIM = "opacity-50";', button({ lock: "locked", cn: "locked && LOCK_DIM" }));
    const other = component('const LOCK_DIM = "opacity-70";', button({ lock: "locked", cn: "locked && LOCK_DIM" }));
    expect(await findings(same, GRAMMAR_FILE)).toEqual([]);
    expect(await findings(other, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
  });

  it("템플릿 조각의 흐림도 붉고, 흐림이 아닌 조건부 클래스는 붉지 않다", async () => {
    const quasi = component("", button({ lock: "locked", cn: 'locked && "opacity-50", `opacity-70 p-2`' }));
    const cursor = component(
      "",
      button({ lock: "locked", busy: "creating", cn: 'locked && "opacity-50", creating && "cursor-wait"' })
    );
    expect(await findings(quasi, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
    expect(await findings(cursor, GRAMMAR_FILE)).toEqual([]);
  });

  it("잠금 인자라도 값이 opacity-50 이 아니면 붉고, 진행만 있는 버튼의 흐림은 전부 붉다", async () => {
    const otherValue = component("", button({ lock: "locked", cn: 'locked && "opacity-70"' }));
    const busyOnly = component("", button({ busy: "creating", cn: 'creating && "opacity-50"' }));
    const busyOnlyFixed = component("", button({ busy: "creating", extra: 'className="opacity-50"' }));
    expect(await findings(otherValue, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
    expect(await findings(busyOnly, GRAMMAR_FILE)).toEqual(["opacityOutsideLock", "selfLock"]);
    expect(await findings(busyOnlyFixed, GRAMMAR_FILE)).toEqual(["opacityOutsideLock"]);
  });
});

describe("rawControlBusySplit 사유 한글 규칙 (#1595 M6)", () => {
  it("id 에 reason·note 가 든 <p>·<span> 은 break-keep 이 없으면 붉다", async () => {
    const bad = component(
      "",
      `<p id={offlineReasonId} className="text-ink-muted">연결이 끊겼어요.</p>
      <span id={LINK_BUSY_NOTE_ID}>앞서 누른 것이 끝나지 않았어요.</span>`
    );
    expect(await findings(bad, GRAMMAR_FILE)).toEqual(["reasonBreakKeep"]);
    // 둘 다 따로 센다(같은 종류라 위에서 하나로 접혔을 뿐이다).
    expect((await lint(bad, GRAMMAR_FILE)).filter((id) => id === "reasonBreakKeep")).toHaveLength(2);
  });

  it("break-keep 을 들었거나 사유 노드가 아니면 붉지 않다", async () => {
    const ok = component(
      "",
      `<p id={offlineReasonId} className="break-keep text-ink-muted">연결이 끊겼어요.</p>
      <p id="plain" className="text-ink-muted">설명</p>`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });
});

describe("rawControlBusySplit 거짓 약속 (#1595 H4) — 오프라인 큐가 없다", () => {
  it("「그대로 보내져요」 문장과 networkMode·onlineManager 는 붉다", async () => {
    const promise = component(
      "",
      `<p className="break-keep">연결이 끊겨도 쓴 글은 그대로 보내져요.</p>`
    );
    const manager = component("const online = onlineManager.isOnline();", "<p>대기</p>");
    const mode = component(`const options = { networkMode: "offlineFirst" };`, "<p>대기</p>");
    expect(await findings(promise, GRAMMAR_FILE)).toEqual(["offlineQueuePromise"]);
    expect(await findings(manager, GRAMMAR_FILE)).toEqual(["offlineQueuePromise"]);
    expect(await findings(mode, GRAMMAR_FILE)).toEqual(["offlineQueuePromise"]);
  });

  it("주석에 반례로 인용한 것은 붉지 않다 — 주석은 노드가 아니다", async () => {
    const quoted = `// 「그대로 보내져요」 같은 약속은 networkMode·onlineManager 가 생기기 전에는 거짓이다.
${component("", "<p>대기</p>")}`;
    expect(await findings(quoted, GRAMMAR_FILE)).toEqual([]);
  });
});

describe("settingsFieldsBusy 소비처 그물 (#1558) — <SaveButton canSave> 에 진행이 접히지 않는다", () => {
  const SAVE_FILE = "src/features/chat/Fixture.tsx";

  it.each([
    ["save.isPending", "dirty && !save.isPending"],
    ["busy", "dirty && !busy"],
    ["isLoading", "!isLoading"],
    ["isFetching", "dirty && !isFetching"],
    ["대소문자 무시(Saving)", "dirty && !Saving"],
    ["문자열 상태 낱말", 'dirty && status !== "saving"'],
    ["계산 키 문자열", 'dirty && !save["isPending"]'],
  ])("canSave 에 진행 어휘(%s)가 있다", async (_name, expr) => {
    const code = component("", `<SaveButton canSave={${expr}} onSave={go} />`);
    expect(await findings(code, SAVE_FILE)).toEqual(["saveButtonCanSave"]);
  });

  it("canSave={식} 이 없으면 붉다 — 생략도 축약(`canSave`, 늘 참)도", async () => {
    const missing = component("", "<SaveButton onSave={go} />");
    const shorthand = component("", "<SaveButton canSave onSave={go} />");
    expect(await findings(missing, SAVE_FILE)).toEqual(["saveButtonCanSaveMissing"]);
    expect(await findings(shorthand, SAVE_FILE)).toEqual(["saveButtonCanSaveMissing"]);
  });

  it("진행이 없는 canSave 는 붉지 않다 — 이름이 비슷한 것·설명 주석·진행과 무관한 문자열도", async () => {
    const ok = component(
      "",
      `<SaveButton canSave={dirty && !offline} onSave={go} />
      <SaveButton canSave={dirty && !draft.busyLabel} onSave={go} />
      <SaveButton canSave={dirty && /* busy 가 아니다 */ !offline} onSave={go} />
      <SaveButton canSave={dirty && status !== "idle"} onSave={go} />`
    );
    expect(await findings(ok, SAVE_FILE)).toEqual([]);
  });

  it("시험 파일(.test.tsx)은 이 규칙 밖이다", async () => {
    const bad = component("", "<SaveButton canSave={dirty && !busy} onSave={go} />");
    expect(await findings(bad, "src/features/chat/Fixture.test.tsx")).toEqual([]);
  });
});

describe("rawControlBusySplit fieldset (#1595 H3) — <ChoiceRadios disabled> 에 진행이 없다", () => {
  const RADIO_FILE = "src/features/chat/Fixture.tsx";

  it("disabled 에 진행 어휘가 있으면 붉고, 오프라인만이면 붉지 않다", async () => {
    const bad = component("", '<ChoiceRadios name="mode" disabled={offline || save.isPending} />');
    const ok = component("", '<ChoiceRadios name="mode" disabled={offline} busy={save.isPending} />');
    expect(await findings(bad, RADIO_FILE)).toEqual(["choiceRadiosDisabled"]);
    expect(await findings(ok, RADIO_FILE)).toEqual([]);
  });

  it("문자열 상태 낱말도 붉다", async () => {
    const bad = component("", '<ChoiceRadios name="mode" disabled={offline || list.status === "loading"} />');
    expect(await findings(bad, RADIO_FILE)).toEqual(["choiceRadiosDisabled"]);
  });
});

describe("규칙이 겨누는 컴포넌트의 정의 파일 — 이름이 바뀌어 규칙이 눈먼 초록이 되지 않는다 (옛 소비처 그물의 seen >= N 자리)", () => {
  const defining = (names: string[]) =>
    names.map((name) => `export function ${name}() {\n  return null;\n}\n`).join("\n");

  it("세 컴포넌트가 export 되면 붉지 않다(함수 선언도 const 화살표도)", async () => {
    const arrows = [
      "export const SaveButton = () => null;",
      "export const ConfirmButton = () => null;",
      "export const ChoiceRadios = () => null;",
      "",
    ].join("\n");
    expect(await lint(defining(["SaveButton", "ConfirmButton", "ChoiceRadios"]), BUSY_LOCK_PRIMITIVES_FILE)).toEqual([]);
    expect(await lint(arrows, BUSY_LOCK_PRIMITIVES_FILE)).toEqual([]);
  });

  it.each(["SaveButton", "ConfirmButton", "ChoiceRadios"])("%s 의 이름이 바뀌면 붉다", async (name) => {
    const all = ["SaveButton", "ConfirmButton", "ChoiceRadios"];
    const renamed = defining(all.map((each) => (each === name ? `${each}Renamed` : each)));
    expect(await lint(renamed, BUSY_LOCK_PRIMITIVES_FILE)).toEqual(["missingPrimitive"]);
  });

  it("export 가 빠져도(같은 이름의 비공개 함수) 붉다", async () => {
    const notExported = `${defining(["ConfirmButton", "ChoiceRadios"])}\nfunction SaveButton() {\n  return null;\n}\n`;
    expect(await lint(notExported, BUSY_LOCK_PRIMITIVES_FILE)).toEqual(["missingPrimitive"]);
  });

  it("정의 파일이 아닌 곳에는 서지 않는다", async () => {
    expect(await lint(defining(["Other"]), OUTSIDE_FILE)).toEqual([]);
  });
});
