import { describe, expect, it } from "vitest";
import {
  EXECUTION_TIER_KEYS,
  EXECUTION_TIER_LABEL,
  TIER_OVERRIDE_UNSUPPORTED_REASON,
  resolveExecutionTierAxis,
  tierPolicyModeLabel,
  type ExecutionTierInput,
  type ExecutionTierKey,
  type TierHostRow,
} from "./tierAxis";
import { WORK_TIER_MODES } from "../settings/model";
import { workExecutionLocationLabel } from "../work/workLocation";

const T1_HOST = "019f9a01-0000-7000-8000-0000000000a1";
const T2_HOST = "019F9A01-0000-7000-8000-0000000000A2";

function host(overrides: Partial<TierHostRow> & Pick<TierHostRow, "type">): TierHostRow {
  return {
    id: T1_HOST,
    online: true,
    ...overrides,
  };
}

function input(overrides: Partial<ExecutionTierInput> = {}): ExecutionTierInput {
  return {
    hostsState: "ready",
    hosts: [],
    policyState: "ready",
    policy: { mode: "ask" },
    ...overrides,
  };
}

function optionFor(axis: ReturnType<typeof resolveExecutionTierAxis>, key: ExecutionTierKey) {
  const option = axis.options.find((candidate) => candidate.key === key);
  if (option === undefined) throw new Error(`no option for ${key}`);
  return option;
}

describe("the axis is display only until the wire carries a per-message tier", () => {
  it("never claims the override can be sent, whatever the registry says", () => {
    const axis = resolveExecutionTierAxis(
      input({ hosts: [host({ type: "app" }), host({ id: T2_HOST, type: "workd" })] })
    );
    expect(axis.overrideSupported).toBe(false);
    expect(axis.overrideReason).toBe(TIER_OVERRIDE_UNSUPPORTED_REASON);
  });

  it("says the sentence is about the surface, not about this server's version", () => {
    // `routing`의 허용 키는 두 세대 모두 model·effort 둘뿐이다(ROUTING_KEYS,
    // openapi RunRoutingInput additionalProperties:false). 서버를 새로 올리면
    // 풀린다고 읽히는 문장을 여기 두면 그것은 거짓말이 된다.
    expect(TIER_OVERRIDE_UNSUPPORTED_REASON).not.toContain("이 서버");
  });
});

describe("the three tiers are always on screen, in the shipped vocabulary", () => {
  it("lists t1/t2/t3 with the workLocation labels and nothing invented", () => {
    const axis = resolveExecutionTierAxis(input());
    expect(axis.options.map((option) => option.key)).toEqual([...EXECUTION_TIER_KEYS]);
    expect(axis.options.map((option) => option.label)).toEqual([
      "T1 · 데스크톱 앱",
      "T2 · 셀프호스트",
      "T3 · 클라우드",
    ]);
  });

  it("gives every ineligible tier exactly one sentence", () => {
    const axis = resolveExecutionTierAxis(input());
    for (const option of axis.options) {
      expect(option.eligible).toBe(false);
      expect(option.reason).not.toBeNull();
      expect(option.reason?.endsWith(".")).toBe(true);
      expect(option.reason?.slice(0, -1)).not.toContain(".");
    }
  });
});

describe("eligibility is read from the registry and nowhere else", () => {
  it("an online host of that type makes the tier eligible with no reason", () => {
    const axis = resolveExecutionTierAxis(input({ hosts: [host({ type: "workd" })] }));
    expect(optionFor(axis, "t2")).toMatchObject({ eligible: true, reason: null });
  });

  it("names the empty tier rather than hiding it", () => {
    const axis = resolveExecutionTierAxis(input({ hosts: [host({ type: "workd" })] }));
    expect(optionFor(axis, "t1")).toMatchObject({
      eligible: false,
      reason: "이 워크스페이스에 등록된 데스크톱 앱 호스트가 없습니다.",
    });
    expect(optionFor(axis, "t3").reason).toBe(
      "이 워크스페이스에 등록된 클라우드 호스트가 없습니다."
    );
  });

  it("bridges the empty T3 row to the managed cloud the policy resumes on", () => {
    // 정책이 관리형 클라우드에서 자동 재개하는데 등록기에는 직접 올린 클라우드
    // 호스트가 없다. 관리형 클라우드는 등록 호스트가 아니므로 이 조합은 정상이고
    // (ADR-0163/0164), 그때 T3 줄이 「호스트 없음」으로 끝나면 상속 줄의 「자동
    // 재개: T3 · 클라우드」와 어긋나 보인다. 대신 그 관리형 경로를 이어 준다(M2).
    const axis = resolveExecutionTierAxis(
      input({ hosts: [host({ type: "app" })], policy: { mode: "auto", autoTarget: "cloud" } })
    );
    expect(axis.inherited.key).toBe("t3");
    const t3 = optionFor(axis, "t3");
    expect(t3.eligible).toBe(false);
    expect(t3.reason).toBe(
      "등록된 클라우드 호스트는 없지만, 정책이 관리형 oort Cloud에서 자동 재개합니다."
    );
    // 정책이 클라우드를 겨냥하지 않으면 같은 빈 등록기라도 평범한 「호스트 없음」이다.
    const plain = resolveExecutionTierAxis(input({ hosts: [host({ type: "app" })] }));
    expect(optionFor(plain, "t3").reason).toBe(
      "이 워크스페이스에 등록된 클라우드 호스트가 없습니다."
    );
  });

  it("separates 'registered but all offline' from 'not registered'", () => {
    const axis = resolveExecutionTierAxis(
      input({ hosts: [host({ type: "app", online: false })] })
    );
    expect(optionFor(axis, "t1")).toMatchObject({
      eligible: false,
      reason: "등록된 데스크톱 앱 호스트가 모두 오프라인입니다.",
    });
  });

  it("a revoked row is gone whatever its last heartbeat said", () => {
    const axis = resolveExecutionTierAxis(
      input({ hosts: [host({ type: "app", online: true, revokedAtMs: 1 })] })
    );
    expect(optionFor(axis, "t1").reason).toBe(
      "이 워크스페이스에 등록된 데스크톱 앱 호스트가 없습니다."
    );
  });

  it("an unknown host type joins no tier rather than the nearest one", () => {
    const axis = resolveExecutionTierAxis(
      input({ hosts: [host({ type: "cloud-preview" })] })
    );
    for (const option of axis.options) expect(option.eligible).toBe(false);
  });

  it("a registry it has not read yet is not an empty registry", () => {
    const pending = resolveExecutionTierAxis(input({ hostsState: "pending" }));
    expect(optionFor(pending, "t1").reason).toBe("등록된 호스트를 확인하는 중입니다.");
    const unreadable = resolveExecutionTierAxis(input({ hostsState: "unreadable" }));
    expect(optionFor(unreadable, "t2").reason).toBe(
      "등록된 호스트 목록을 불러오지 못해 여기서 돌 수 있는지 확인하지 못했습니다."
    );
  });
});

describe("the inherited value is the workspace policy, stated as it is", () => {
  it("reuses the settings label rather than a second name for the same policy", () => {
    for (const choice of WORK_TIER_MODES) {
      expect(tierPolicyModeLabel(choice.id)).toBe(choice.label);
    }
    expect(tierPolicyModeLabel("teleport")).toBeNull();
  });

  it("names the policy when the policy pins no destination", () => {
    const axis = resolveExecutionTierAxis(input({ policy: { mode: "ask" } }));
    expect(axis.inherited.key).toBeNull();
    expect(axis.inherited.label).toBe("상속 (연결 끊김 시 묻기)");
    expect(axis.inherited.sentence).toBe(
      "이 메시지가 작업을 일으키면 호스트를 잃었을 때 어디서 이어갈지 물어봅니다."
    );
    expect(axis.summary).toBe(`${EXECUTION_TIER_LABEL} 워크스페이스 정책`);
  });

  it("keeps t1_only about the host that started the work, not about a tier", () => {
    const axis = resolveExecutionTierAxis(input({ policy: { mode: "t1_only" } }));
    expect(axis.inherited.key).toBeNull();
    expect(axis.inherited.label).toBe("상속 (처음 시작한 호스트에서만)");
  });

  it("pins T3 when auto targets the reserved cloud selector", () => {
    const axis = resolveExecutionTierAxis(
      input({ policy: { mode: "auto", autoTarget: "cloud" } })
    );
    expect(axis.inherited.key).toBe("t3");
    expect(axis.inherited.label).toBe("상속 (자동 재개: T3 · 클라우드)");
    expect(axis.summary).toBe(
      `${EXECUTION_TIER_LABEL} ${workExecutionLocationLabel("t3")}`
    );
  });

  it("resolves an auto target host id through the registry, casing and all", () => {
    const axis = resolveExecutionTierAxis(
      input({
        hosts: [host({ id: T2_HOST, type: "workd" })],
        policy: { mode: "auto", autoTarget: T2_HOST.toLowerCase() },
      })
    );
    expect(axis.inherited.key).toBe("t2");
    expect(axis.inherited.sentence).toBe(
      "이 메시지가 작업을 일으키면 호스트를 잃었을 때 T2 · 셀프호스트에서 마지막 push 커밋으로 새로 시작합니다."
    );
  });

  it("does not say 'not found' about a registry it has not read", () => {
    const axis = resolveExecutionTierAxis(
      input({ hostsState: "pending", policy: { mode: "auto", autoTarget: T2_HOST } })
    );
    expect(axis.inherited.key).toBeNull();
    expect(axis.inherited.sentence).toContain("확인하는 중");
    expect(axis.summary).toBe(`${EXECUTION_TIER_LABEL} 확인 중`);
  });

  it("says the target is missing when the registry really does not have it", () => {
    const axis = resolveExecutionTierAxis(
      input({ hosts: [host({ type: "app" })], policy: { mode: "auto", autoTarget: T2_HOST } })
    );
    expect(axis.inherited.key).toBeNull();
    expect(axis.inherited.sentence).toBe(
      "정책이 자동 재개 대상으로 정해 둔 호스트를 등록기에서 찾지 못해 어디서 이어갈지 확인하지 못했습니다."
    );
    expect(axis.summary).toBe(`${EXECUTION_TIER_LABEL} 확인 필요`);
  });

  it("refuses to guess the tier of a host type this build does not know", () => {
    const axis = resolveExecutionTierAxis(
      input({
        hosts: [host({ id: T2_HOST, type: "cloud-preview" })],
        policy: { mode: "auto", autoTarget: T2_HOST },
      })
    );
    expect(axis.inherited.key).toBeNull();
    expect(axis.inherited.sentence).toContain("모르는 종류");
  });

  it("does not claim a policy it could not read", () => {
    const pending = resolveExecutionTierAxis(input({ policyState: "pending", policy: null }));
    expect(pending.inherited.label).toBe("상속 (확인 중)");
    expect(pending.summary).toBe(`${EXECUTION_TIER_LABEL} 확인 중`);

    const unreadable = resolveExecutionTierAxis(
      input({ policyState: "unreadable", policy: null })
    );
    expect(unreadable.inherited.label).toBe("상속 (확인하지 못함)");
    // workLocation.ts의 `unknown` 라벨과 글자 그대로 같다. 같은 사실에 두 문장을
    // 만들지 않는다.
    expect(unreadable.summary).toBe(workExecutionLocationLabel("unknown"));
  });

  it("does not invent a name for a policy mode it does not know", () => {
    const axis = resolveExecutionTierAxis(input({ policy: { mode: "teleport" } }));
    expect(axis.inherited.label).toBe("상속 (워크스페이스 정책)");
    expect(axis.inherited.sentence).toContain("이 빌드가 모르는");
    expect(axis.summary).toBe(`${EXECUTION_TIER_LABEL} 확인 필요`);
  });
});
