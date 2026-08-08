import { describe, expect, it } from "vitest";
import type { WorkHost, WorkSession } from "../../lib/api";
import {
  HANDOFF_COPY,
  REPLAY_ONLY_COPY,
  TAKEOVER_DISCLOSURE_HEADLINE,
  TAKEOVER_FRESH,
  TAKEOVER_NO_TARGET_COPY,
  TAKEOVER_RESTORED,
  handoffAdvisory,
  handoffVerb,
  parseSessionVerdict,
  sessionHandoffVerb,
  sessionVerdict,
  showsOneWayNote,
  takeoverFailureCopy,
  takeoverGate,
  takeoverOneWayCopy,
  takeoverTargets,
  workHostRevoked,
} from "./sessionHandoff";

const WS = "00000000-0000-7000-8000-000000000001";
const CHANNEL = "00000000-0000-7000-8000-000000000201";
const ME = "00000000-0000-7000-8000-000000000101";
const OTHER = "00000000-0000-7000-8000-000000000102";
const MY_MAC = "0199C0DE-0000-7000-8000-0000000000H1";
const CLOUD = "0199C0DE-0000-7000-8000-0000000000H2";
const OTHERS_MAC = "0199C0DE-0000-7000-8000-0000000000H3";

function host(id: string, overrides: Partial<WorkHost> = {}): WorkHost {
  return {
    id,
    workspaceId: WS,
    scope: "member",
    ownerMemberId: ME,
    type: "app",
    displayName: "내 맥",
    capabilities: {},
    createdAtMs: 0,
    online: true,
    ...overrides,
  };
}

const HOSTS: WorkHost[] = [
  host(MY_MAC),
  host(CLOUD, {
    scope: "workspace",
    type: "cloud",
    displayName: "momo Cloud (서울)",
  }),
  host(OTHERS_MAC, { ownerMemberId: OTHER, displayName: "도현 맥북" }),
];

function session(overrides: Partial<WorkSession> = {}): WorkSession {
  return {
    id: "0199AAAA-0000-7000-8000-0000000000S1",
    workspaceId: WS,
    channelId: CHANNEL,
    memberId: ME,
    hostId: MY_MAC,
    rootMessageId: "0199AAAA-0000-7000-8000-0000000000M1",
    tool: "codex",
    label: "릴리스 노트 초안",
    status: "running",
    observation: "open",
    observerGrantCount: 0,
    remoteAttachAvailable: true,
    startedAtMs: 0,
    ...overrides,
  };
}

// ---- 판정: 서버 규칙과 한 글자도 다르지 않아야 한다 --------------------------
//
// 기대값의 출처는 서버 테스트 `verdict_separates_reattach_from_lineage_resume`
// (`momo-t3/src/reattach.rs:359-397`)의 표 그대로다. 두 표가 갈리는 순간이
// 곧 이 파일이 막으려는 drift다.

describe("sessionVerdict — 서버 SessionReattachState::verdict 복제", () => {
  it("살아 있고 붙을 PTY가 있으면 reattach", () => {
    expect(sessionVerdict(session({ status: "running" }), HOSTS)).toBe("reattach");
    expect(sessionVerdict(session({ status: "idle" }), HOSTS)).toBe("reattach");
  });

  it("orphaned는 resume_lineage", () => {
    expect(sessionVerdict(session({ status: "orphaned" }), HOSTS)).toBe(
      "resume_lineage"
    );
  });

  it("ended와 모르는 상태는 replay_only", () => {
    expect(sessionVerdict(session({ status: "ended" }), HOSTS)).toBe("replay_only");
    expect(
      sessionVerdict(
        session({ status: "wat" as WorkSession["status"] }),
        HOSTS
      )
    ).toBe("replay_only");
  });

  it("해지된 호스트의 살아 있는 세션은 replay_only (서버 !host_revoked)", () => {
    const hosts = [host(MY_MAC, { revokedAtMs: 1 }), ...HOSTS.slice(1)];
    expect(sessionVerdict(session({ status: "running" }), hosts)).toBe(
      "replay_only"
    );
  });

  it("붙을 PTY가 없으면 replay_only (서버 binding.is_some())", () => {
    expect(
      sessionVerdict(
        session({ status: "running", remoteAttachAvailable: false }),
        HOSTS
      )
    ).toBe("replay_only");
  });

  // 이 단언이 이 파일의 존재 이유다. 서버는 `host_online`을 일부러 안 본다
  // (`verdict_ignores_host_online`), 그리고 이 레포는 그 칼럼이 못 믿을
  // 값이라고 이미 실측해 두었다(workSessionModel.workHostOnline 주석).
  it("하트비트가 끊겨도 판정은 그대로다 — online은 입력이 아니다", () => {
    const offline = [host(MY_MAC, { online: false }), ...HOSTS.slice(1)];
    expect(sessionVerdict(session({ status: "running" }), offline)).toBe(
      "reattach"
    );
  });

  it("명부를 못 읽었으면 null — replay_only로 접지 않는다", () => {
    expect(sessionVerdict(session({ status: "running" }), undefined)).toBeNull();
    expect(sessionVerdict(session({ status: "running" }), [])).toBeNull();
    // 원장만으로 확정되는 두 갈래는 명부 없이도 답한다.
    expect(sessionVerdict(session({ status: "orphaned" }), undefined)).toBe(
      "resume_lineage"
    );
    expect(sessionVerdict(session({ status: "ended" }), undefined)).toBe(
      "replay_only"
    );
  });

  it("workHostRevoked는 모름과 아님을 가른다", () => {
    expect(workHostRevoked(session(), undefined)).toBeNull();
    expect(workHostRevoked(session({ hostId: "0199C0DE-0000-7000-8000-00000000ZZZZ" }), HOSTS)).toBeNull();
    expect(workHostRevoked(session(), HOSTS)).toBe(false);
    expect(workHostRevoked(session(), [host(MY_MAC, { revokedAtMs: 1 })])).toBe(true);
  });

  it("parseSessionVerdict는 와이어 값만 받는다", () => {
    expect(parseSessionVerdict("reattach")).toBe("reattach");
    expect(parseSessionVerdict("resume_lineage")).toBe("resume_lineage");
    expect(parseSessionVerdict("replay_only")).toBe("replay_only");
    expect(parseSessionVerdict("resume")).toBeNull();
    expect(parseSessionVerdict(undefined)).toBeNull();
  });
});

// ---- 동사 배정 --------------------------------------------------------------

describe("동사 배정 — 두 낱말이 섞이지 않는다", () => {
  it("판정마다 동사가 하나씩, replay_only에는 없다", () => {
    expect(handoffVerb("reattach")).toBe("resume");
    expect(handoffVerb("resume_lineage")).toBe("takeover");
    expect(handoffVerb("replay_only")).toBeNull();
    expect(handoffVerb(null)).toBeNull();
  });

  // red proof ①: 동사 오배정. 살아 있는 세션에 인수가, 죽은 세션에 재개가
  // 붙으면 여기서 깨진다.
  it("살아 있는 세션은 재개, 죽은 세션은 인수 — 절대 반대가 아니다", () => {
    expect(sessionHandoffVerb(session({ status: "running" }), HOSTS)).toBe(
      "resume"
    );
    expect(sessionHandoffVerb(session({ status: "idle" }), HOSTS)).toBe("resume");
    expect(sessionHandoffVerb(session({ status: "orphaned" }), HOSTS)).toBe(
      "takeover"
    );
    expect(sessionHandoffVerb(session({ status: "ended" }), HOSTS)).toBeNull();
  });

  it("두 동사는 서로 다른 낱말이고 다른 버튼 글자를 쓴다", () => {
    expect(HANDOFF_COPY.resume.verb).not.toBe(HANDOFF_COPY.takeover.verb);
    expect(HANDOFF_COPY.resume.button).not.toBe(HANDOFF_COPY.takeover.button);
    expect(HANDOFF_COPY.takeover.verb).toBe("인수");
    // 재개 버튼은 「쓰기」를 약속하지 않는다 — 웹은 observer로만 붙는다.
    expect(HANDOFF_COPY.resume.button).toBe("이어서 보기");
    expect(HANDOFF_COPY.resume.button).not.toContain("쓰기");
  });

  it("재개 쪽 문구는 잃는 것을 말하지 않는다 (잃는 것이 없다)", () => {
    expect(HANDOFF_COPY.resume.lead).not.toContain("커밋");
    expect(HANDOFF_COPY.resume.lead).not.toContain("사라");
  });

  it("인수 lead는 실행을 약속하지 않는다 (Rust 포트에 스폰 디스패치가 없다)", () => {
    expect(HANDOFF_COPY.takeover.lead).not.toContain("실행합니다");
    expect(HANDOFF_COPY.takeover.lead).not.toContain("이어서 진행");
  });

  it("동사가 없는 상태에도 할 말이 있다", () => {
    expect(REPLAY_ONLY_COPY).toContain("진행 내역");
  });
});

// ---- 조언은 게이트가 아니다 --------------------------------------------------

describe("handoffAdvisory", () => {
  it("하트비트 침묵은 재개 옆에 경고로만 선다", () => {
    expect(handoffAdvisory("resume", false)).not.toBeNull();
    expect(handoffAdvisory("resume", true)).toBeNull();
    expect(handoffAdvisory("resume", null)).toBeNull();
  });

  it("인수와 무동사에는 붙지 않는다 — 죽은 호스트에 「응답 없음」은 동어반복", () => {
    expect(handoffAdvisory("takeover", false)).toBeNull();
    expect(handoffAdvisory(null, false)).toBeNull();
  });
});

// ---- 인수 사전조건 -----------------------------------------------------------

describe("takeoverGate — 사전조건 선검사", () => {
  const orphan = session({ status: "orphaned" });
  const targets = takeoverTargets(orphan, HOSTS, ME);

  it("자격 대상이 있으면 통과하고 사유가 없다", () => {
    const gate = takeoverGate(orphan, HOSTS, targets);
    expect(gate.canTakeover).toBe(true);
    expect(gate.blockedCopy).toBeUndefined();
  });

  // red proof ②: 사전조건 무시 인수. 판정이 인수가 아닌데 게이트가 열리면
  // 여기서 깨진다.
  it("살아 있는 세션은 막고, 대신 할 일을 지목한다", () => {
    const gate = takeoverGate(session({ status: "running" }), HOSTS, targets);
    expect(gate.canTakeover).toBe(false);
    expect(gate.blockedCopy).toContain("이어서 보기");
  });

  it("끝난 세션은 막고, 대신 할 일을 지목한다", () => {
    const gate = takeoverGate(session({ status: "ended" }), HOSTS, targets);
    expect(gate.canTakeover).toBe(false);
    expect(gate.blockedCopy).toContain("새 세션");
  });

  it("명부를 못 읽었으면 막되 원인을 「모른다」로 말한다", () => {
    const gate = takeoverGate(session({ status: "running" }), undefined, targets);
    expect(gate.canTakeover).toBe(false);
    expect(gate.blockedCopy).toContain("잠시 뒤");
  });

  it("대상이 없으면 막고, 고칠 방법을 말한다", () => {
    const gate = takeoverGate(orphan, HOSTS, []);
    expect(gate.canTakeover).toBe(false);
    expect(gate.blockedCopy).toContain("호스트 앱");
    // 형제 표면(작업 흐름 상세)이 같은 사실에 쓰는 문장과 **같은 상수**다.
    // 두 벌이던 시절 이쪽만 `online` 을 자격으로 불렀다 (R1 H1).
    expect(gate.blockedCopy).toBe(TAKEOVER_NO_TARGET_COPY);
  });

  // 모든 차단 문장은 행동 지시형이다 — 「무엇을 하면 되는지」(ADR-0154 D3).
  it("차단 문장은 전부 사람이 할 행동으로 끝난다", () => {
    const blocked = [
      takeoverGate(session({ status: "running" }), HOSTS, targets),
      takeoverGate(session({ status: "ended" }), HOSTS, targets),
      takeoverGate(session({ status: "running" }), undefined, targets),
      takeoverGate(orphan, HOSTS, []),
    ];
    for (const gate of blocked) {
      expect(gate.canTakeover).toBe(false);
      // 「무엇을 하면 되는지」의 기계적 형태: 마지막 문장이 명령형으로 끝난다.
      // 「…할 수 없습니다.」로 끝나는 문장은 상태만 말하고 사람을 세워 둔다.
      expect(gate.blockedCopy).toMatch(/세요\.$/);
    }
  });

  it("대상 목록은 죽은 원본 호스트와 남의 개인 기기를 뺀다", () => {
    const ids = targets.map((target) => target.id);
    // 원본 호스트(MY_MAC)는 죽어서 인수의 출발점이다 — 대상이 될 수 없다.
    expect(ids).not.toContain(MY_MAC);
    // 남의 개인(member scope) 호스트도 아니다.
    expect(ids).not.toContain(OTHERS_MAC);
    expect(ids).toContain(CLOUD);
  });
});

// ---- 서버 거절 -> 행동 --------------------------------------------------------

describe("takeoverFailureCopy — 거절을 행동으로", () => {
  it("슬롯 고갈은 호스트를 고치라고 시키지 않는다", () => {
    const copy = takeoverFailureCopy(409, "pool_exhausted");
    expect(copy).toContain("슬롯");
    expect(copy).not.toContain("호스트 상태");
  });

  it("멤버 한도는 내 세션을 끝내라고 말한다", () => {
    expect(takeoverFailureCopy(409, "member_limit")).toContain("끝낸 뒤");
  });

  it("상태가 바뀐 경우는 새로 고치라고 말한다", () => {
    expect(
      takeoverFailureCopy(409, "only an orphaned work session can resume")
    ).toContain("새로 고친");
  });

  it("꺼진 도구는 관리자에게 보낸다", () => {
    expect(
      takeoverFailureCopy(400, "work tool is not registered or enabled")
    ).toContain("관리자");
  });

  it("403은 채널 멤버십을 말한다", () => {
    expect(takeoverFailureCopy(403, "active channel membership required")).toContain(
      "채널"
    );
  });

  it("모르는 실패는 원인을 지어내지 않는다", () => {
    const copy = takeoverFailureCopy(500, "boom");
    expect(copy).not.toContain("호스트");
    expect(copy).not.toContain("슬롯");
    expect(copy).toContain("다시 시도");
  });

  it("어떤 실패든 문장이 하나는 나온다", () => {
    for (const status of [undefined, 400, 403, 404, 409, 500, 503]) {
      expect(takeoverFailureCopy(status, undefined).length).toBeGreaterThan(0);
    }
  });
});

// ---- 부분 복원 정직 표기 -----------------------------------------------------

describe("부분 복원 고지", () => {
  // red proof ③: 부분 복원 허위 표기. 「전부 복원」으로 읽히거나, 잃는 쪽이
  // 비면 여기서 깨진다.
  it("제목이 「일부」라고 말한다 — 전부라고 말하지 않는다", () => {
    expect(TAKEOVER_DISCLOSURE_HEADLINE).toContain("일부");
    expect(TAKEOVER_DISCLOSURE_HEADLINE).not.toContain("그대로 복원");
  });

  it("두 목록 다 비어 있지 않다 — 한쪽만 있으면 그것은 고지가 아니다", () => {
    expect(TAKEOVER_RESTORED.length).toBeGreaterThan(0);
    expect(TAKEOVER_FRESH.length).toBeGreaterThan(0);
  });

  it("복원되는 쪽은 스레드를 말한다 (서버가 root_message_id를 그대로 쓴다)", () => {
    expect(TAKEOVER_RESTORED.join(" ")).toContain("스레드");
  });

  it("잃는 쪽은 미커밋 변경과 터미널을 이름으로 말한다", () => {
    const fresh = TAKEOVER_FRESH.join(" ");
    expect(fresh).toContain("커밋하지 않은 변경");
    expect(fresh).toContain("터미널");
  });

  it("실행자가 바뀐다는 사실이 빠지지 않는다 (서버가 member_id에 호출자를 싣는다)", () => {
    expect(TAKEOVER_FRESH.join(" ")).toContain("실행자");
  });

  it("같은 항목이 양쪽에 동시에 서지 않는다", () => {
    for (const item of TAKEOVER_RESTORED) {
      expect(TAKEOVER_FRESH).not.toContain(item);
    }
  });

  // R1 B2: 이 목록의 항목은 사람이 읽는 문구다. em-dash 는 SKILL §7의 binary
  // fail 인데, 이 패키지를 훑는 프리플라이트가 없어서(그 스크립트는 clients/web
  // 만 본다) 세 건이 그대로 실렸다. 게이트가 못 보는 자리는 테스트가 본다.
  it("사람이 읽는 문구에 em-dash 가 없다", () => {
    for (const line of [
      ...TAKEOVER_RESTORED,
      ...TAKEOVER_FRESH,
      TAKEOVER_DISCLOSURE_HEADLINE,
      TAKEOVER_NO_TARGET_COPY,
      REPLAY_ONLY_COPY,
      HANDOFF_COPY.resume.lead,
      HANDOFF_COPY.takeover.lead,
    ]) {
      expect(line).not.toMatch(/[—–]/);
    }
  });
});

// ---- 비대칭 (ADR-0154 D4 단방향) ---------------------------------------------

describe("단방향 비대칭 고지", () => {
  it("남의 기기에서 살아 있는 세션에만 선다", () => {
    const onOthers = session({ status: "running", hostId: OTHERS_MAC });
    expect(showsOneWayNote("reattach", onOthers, HOSTS, ME)).toBe(true);
  });

  it("내 기기의 세션에는 서지 않는다 — 아무도 하려 하지 않은 일을 금지하지 않는다", () => {
    expect(showsOneWayNote("reattach", session(), HOSTS, ME)).toBe(false);
  });

  it("이미 인수할 수 있는 세션에는 서지 않는다", () => {
    const orphan = session({ status: "orphaned", hostId: OTHERS_MAC });
    expect(showsOneWayNote("resume_lineage", orphan, HOSTS, ME)).toBe(false);
    expect(showsOneWayNote(null, orphan, HOSTS, ME)).toBe(false);
  });

  // R1 M1: 앞 판은 상수 하나였고, 그 한 문장이 두 군데서 어긋났다.
  it("주어가 카드의 상태를 따른다 — 대기 중인 세션을 「실행 중」이라 부르지 않는다", () => {
    expect(takeoverOneWayCopy("idle")).toContain("대기 중인 세션");
    expect(takeoverOneWayCopy("idle")).not.toContain("실행 중인 세션");
    expect(takeoverOneWayCopy("running")).toContain("실행 중인 세션");
  });

  it("사람이 걸을 수 없는 길을 가리키지 않는다", () => {
    // 사람이 세션을 멈추면 그것은 `ended` 이고, `ended` 는 인수 대상이 아니다.
    // 인수를 여는 것은 **호스트의 신호 끊김**(스윕)뿐이다. 앞 판의 「그 기기에서
    // 멈춘 뒤에야」를 그대로 따른 사람은 영영 인수하지 못한다.
    for (const status of ["running", "idle"] as const) {
      const copy = takeoverOneWayCopy(status);
      expect(copy).not.toContain("멈춘 뒤");
      expect(copy).toContain("연결이 끊긴 뒤");
      expect(copy).not.toMatch(/[—–]/);
    }
  });
});
