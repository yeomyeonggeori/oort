import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

/**
 * 진행·잠금 문법 린트 규칙(`busyLockGrammar.js`)이 옛 시험이 막던 변조를 실제로 빨갛게 잡는가.
 *
 * 이 파일은 소스 파일을 읽지 않는다. 변조한 소스 한 조각을 **실제 eslint.config.js 로** 린트해서
 * 규칙 메시지의 messageId 를 단정한다 — 설정 연결(파일 범위)과 규칙 본문을 한 번에 건다.
 * `fatal`(구문 오류)을 따로 세는 이유: 깨진 fixture 가 「빨강」으로 읽히면 규칙이 아무것도 못 잡아도
 * 초록이 되기 때문이다.
 *
 * 쓴 곳: 시험 정리 T5(#4711) 첫 묶음. 옛 `rawControlBusySplit`·`confirmBusySplit`·
 * `settingsFieldsBusy` 시험의 그물 일곱을 이 규칙으로 옮겼고, 아래 describe 마다 「옛 시험의 어느
 * 변조인가」를 적었다.
 */

const WEB_ROOT = fileURLToPath(new URL("..", import.meta.url));
const eslint = new ESLint({ cwd: WEB_ROOT });

/** 규칙 `busy-lock-grammar` 범위 안의 파일. 옛 시험 셋이 이름을 달아 재던 열한 파일이다. */
const GRAMMAR_FILE = "src/features/settings/WebhookSection.tsx";
/** 범위 밖의 features 파일 — `<Button disabled>` 가 합법인 곳(`in-flight-lock-props` 만 선다). */
const OUTSIDE_FILE = "src/features/agentHub/AgentChannelsSection.tsx";

async function findings(code: string, file: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath: join(WEB_ROOT, file) });
  const fatal = result.messages.filter((message) => message.fatal);
  expect(fatal.map((message) => message.message), "fixture 가 구문 오류다").toEqual([]);
  return result.messages
    .filter((message) => message.ruleId?.startsWith("momo/"))
    .map((message) => message.messageId ?? message.message);
}

/** 한 조각을 컴포넌트 안에 넣는다. 별칭(const)은 body 에 적는다. */
function component(body: string, jsx: string): string {
  return `export function Row({ offline, busy }: { offline: boolean; busy: boolean }) {
  ${body}
  return (
    <div>
      ${jsx}
    </div>
  );
}
`;
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
      <Button aria-disabled={offline || undefined} className={cn(offline && "opacity-50")}>저장</Button>`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });

  it("범위 밖 파일의 <Button disabled> 는 이 규칙의 대상이 아니다", async () => {
    const outside = component("", "<Button disabled={busy}>추가</Button>");
    expect(await findings(outside, OUTSIDE_FILE)).toEqual([]);
  });

  it.each([
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
  ])("범위가 줄지 않는다 — %s", async (file) => {
    const bad = component("", "<Button disabled>저장</Button>");
    expect(await findings(bad, file)).toEqual(["nativeDisabled"]);
  });
});

describe("rawControlBusySplit 별칭 스캔 · confirmBusySplit ② · settingsFieldsBusy ② — 진행은 자기 잠금 식에 끼지 않는다", () => {
  const bad = (messages: string[]) => expect(messages).toEqual(["selfLock"]);

  it("aria-disabled 에 자기 진행이 직접 든다", async () => {
    bad(
      await findings(
        component(
          "",
          `<Button aria-disabled={offline || creating || undefined} aria-busy={creating || undefined} className={cn((offline || creating) && "opacity-50")}>만들기</Button>`
        ),
        GRAMMAR_FILE
      ).then((messages) => [...new Set(messages)])
    );
  });

  it("초판 webhook-create — 잠금이 별칭(submitBlocked) 뒤에서 busy 를 통째로 든다 (#1595 H1)", async () => {
    // 이 한 조각이 옛 시험의 「그물이 실제로 그 결함을 잡는다」 자기 시험이 재현하던 소스다.
    const original = component(
      "const submitBlocked = offline || busy || channelChoices.length === 0;",
      `<Button aria-disabled={submitBlocked || undefined} aria-busy={creating || undefined} className={cn(submitBlocked && "opacity-50")}>만들기</Button>`
    );
    bad(await findings(original, GRAMMAR_FILE).then((messages) => [...new Set(messages)]));
  });

  it("흐림 조건에만 숨은 접힘도 잡는다(aria-disabled 는 깨끗하다)", async () => {
    const dimOnly = component(
      "",
      `<Button aria-disabled={offline || undefined} aria-busy={creating || undefined} className={cn((offline || creating) && "opacity-50")}>만들기</Button>`
    );
    const messages = await findings(dimOnly, GRAMMAR_FILE);
    expect(messages).toContain("selfLock");
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
    bad(await findings(direct, GRAMMAR_FILE));
    bad(await findings(hiddenName, GRAMMAR_FILE));
  });

  it("SaveButton 정본의 #1558 원형 — blocked = !canSave || busy 가 aria-disabled·흐림에 걸린다", async () => {
    const original = component(
      "const blocked = !canSave || busy;",
      `<Button aria-disabled={blocked || undefined} aria-busy={busy || undefined} className={cn(blocked && "opacity-50")}>저장</Button>`
    );
    const messages = await findings(original, "src/features/settings/SettingsFields.tsx");
    expect([...new Set(messages)]).toEqual(["selfLock"]);
  });

  it("형제 쓰기로 잠기는 올바른 문법은 붉지 않다 — 별칭 busy 가 자기 진행을 품어도", async () => {
    const ok = component(
      `const creating = create.isPending;
  const busy = create.isPending || rotate.isPending || revoke.isPending;
  const createLocked = offline || noChannels || (busy && !creating);`,
      `<Button aria-disabled={createLocked || undefined} aria-busy={creating || undefined} className={cn(createLocked && "opacity-50")}>만들기</Button>
      <ConfirmButton label="지우기" disabled={offline || (busy && !removing)} busy={removing} />
      <ConfirmButton label="나가기" disabled={offline} busy={leave.isPending} />`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });
});

describe("rawControlBusySplit ③ · settingsFieldsBusy ② — 흐림은 aria-disabled 와 같은 식이 켠다", () => {
  it("흐림 조건이 잠금 식과 다르거나 흐림이 아예 없다", async () => {
    const mismatch = component(
      "",
      `<Button aria-disabled={offline || undefined} className={cn(busy && "opacity-50")}>저장</Button>`
    );
    const missing = component(
      "",
      `<Button aria-disabled={offline || undefined} className="p-2">저장</Button>`
    );
    expect(await findings(mismatch, GRAMMAR_FILE)).toEqual(["opacityFollowsLock"]);
    expect(await findings(missing, GRAMMAR_FILE)).toEqual(["opacityFollowsLock"]);
  });

  it("고정 클래스의 흐림 계열(변형 접두 포함)은 늘 흐린 버튼을 만든다", async () => {
    const fixed = component(
      "",
      `<Button aria-disabled={offline || undefined} className={cn("opacity-50 p-2", offline && "opacity-50")}>저장</Button>`
    );
    const variant = component(
      "",
      `<Button aria-disabled={offline || undefined} className={cn("hover:opacity-70", offline && "opacity-50")}>저장</Button>`
    );
    expect(await findings(fixed, GRAMMAR_FILE)).toEqual(["opacityFixed"]);
    expect(await findings(variant, GRAMMAR_FILE)).toEqual(["opacityFixed"]);
  });

  it("고정 클래스가 앞에 붙은 올바른 짝은 붉지 않다", async () => {
    const ok = component(
      "",
      `<Button aria-disabled={offline || undefined} className={cn("min-w-action-sm tap-target", offline && "opacity-50")}>저장</Button>`
    );
    expect(await findings(ok, GRAMMAR_FILE)).toEqual([]);
  });
});

describe("rawControlBusySplit 사유 한글 규칙 (#1595 M6)", () => {
  it("id 에 reason·note 가 든 <p>·<span> 은 break-keep 이 없으면 붉다", async () => {
    const bad = component(
      "",
      `<p id={offlineReasonId} className="text-ink-muted">연결이 끊겼어요.</p>
      <span id={LINK_BUSY_NOTE_ID}>앞서 누른 것이 끝나지 않았어요.</span>`
    );
    expect(await findings(bad, GRAMMAR_FILE)).toEqual(["reasonBreakKeep", "reasonBreakKeep"]);
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
  ])("canSave 에 진행 어휘(%s)가 있다", async (_name, expr) => {
    const code = component("", `<SaveButton canSave={${expr}} onSave={go} />`);
    expect(await findings(code, SAVE_FILE)).toEqual(["saveButtonCanSave"]);
  });

  it("진행이 없는 canSave 는 붉지 않고, features 밖이 아니라 시험 파일도 뺀다", async () => {
    const ok = component("", "<SaveButton canSave={dirty && !offline} onSave={go} />");
    const bad = component("", "<SaveButton canSave={dirty && !busy} onSave={go} />");
    expect(await findings(ok, SAVE_FILE)).toEqual([]);
    expect(await findings(bad, "src/features/chat/Fixture.test.tsx")).toEqual([]);
  });
});

describe("rawControlBusySplit fieldset (#1595 H3) — <ChoiceRadios disabled> 에 진행이 없다", () => {
  const RADIO_FILE = "src/features/chat/Fixture.tsx";

  it("disabled 에 진행 어휘가 있으면 붉고, 오프라인만이면 붉지 않다", async () => {
    const bad = component("", "<ChoiceRadios name=\"mode\" disabled={offline || save.isPending} />");
    const ok = component("", "<ChoiceRadios name=\"mode\" disabled={offline} busy={save.isPending} />");
    expect(await findings(bad, RADIO_FILE)).toEqual(["choiceRadiosDisabled"]);
    expect(await findings(ok, RADIO_FILE)).toEqual([]);
  });
});
