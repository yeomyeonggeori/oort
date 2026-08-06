import { uuidEq, type WorkHost, type WorkSession } from "../../lib/api";

// =============================================================================
// 재개 / 인수 — 어휘 분리와 판정 (ADR-0154 D3, #1137)
//
// 이 파일은 **어느 동사가 성립하는가**만 답한다. 화면은 없고, 요청도 보내지
// 않는다. 답을 여기 한 곳에 둔 이유는 이 티켓의 원인 그 자체다: 같은 act가
// 표면마다 다른 이름으로 서 있었다.
//
//   작업 세션 패널   "새 호스트에서 재개"   `resumeWorkSession`
//   작업 흐름 상세   "새 호스트에서 이어받기" `resumeWorkSession`   <- 같은 호출
//   세션 목록        "이어서 보기"           terminal-attach       <- 다른 호출
//
// 두 이름이 한 act를 가리키고, 그 옆에 **진짜로 다른 act**가 세 번째 이름으로
// 서 있었다. 사람은 "재개"와 "이어받기"가 다른 것이라고 읽을 수밖에 없고, 실제로
// 다른 "이어서 보기"는 그 둘과 같은 종류로 읽힌다. 정확히 거꾸로다.
//
// ## 두 동사 (ADR-0154 D3)
//
//   **재개**  같은 기기의 로컬 히스토리로 돌아간다. 세션은 아직 거기 있고,
//             호스트가 터미널을 붙들고 있다. 잃는 것이 없으므로 사전조건도 없다.
//   **인수**  다른 기기/클라우드에 있던 세션을 **가져온다**. 원래 호스트는 이미
//             사라졌고, 새 호스트에서 다시 선다. 잃는 것이 있으므로 사전조건이
//             있고, 무엇이 복원되고 무엇이 새로 시작하는지 말해야 한다.
//
// ## 판정은 우리가 발명하지 않았다 — 서버가 이미 한다 (실측)
//
// `GET /v1/workspaces/{ws}/work-sessions/{session}/reattach` 가 `verdict` 를
// 돌려준다(`momo-t3::reattach::SessionReattachState::verdict`, 서버 lib.rs:541에
// 라우팅됨). 서버 주석이 이 파일의 존재 이유를 먼저 적어 두었다:
//
//   "ADR-0139 D3 says reattach ... and lineage resume ... are different acts that
//    must not sit behind one button — and today each client re-derives that
//    branch itself from `status` plus host liveness. The web client's
//    `canReattachWorkSession` and the mac console already disagree about one
//    input. A rule that decides what a user is offered belongs on the server."
//
// 그래서 이 파일은 **서버의 규칙을 그대로 복제한다**. 서버 규칙(실측):
//
//   running|idle  AND NOT host_revoked  AND binding.is_some()  -> reattach
//   orphaned                                                    -> resume_lineage
//   그 밖                                                        -> replay_only
//
// 셋 다 웹이 이미 들고 있는 값으로 계산된다. `binding.is_some()` 은 원장 투영의
// `remoteAttachAvailable` 과 **같은 식**이고(서버 REATTACH_COLUMNS:
// `ws.pty_id IS NOT NULL AND ws.attach_endpoint IS NOT NULL`), `host_revoked` 는
// 호스트 명부의 `revokedAtMs` 다. 목록 화면이 세션마다 왕복을 하나씩 더 만들지
// 않고도 서버와 같은 답을 내는 길이 이것이고, 상세 화면이 그 왕복을 실제로 할 때
// 두 답이 어긋나지 않는 이유도 이것이다.
//
// ## 이 파일이 고치는 실제 결함 (서버 주석이 지목한 그 drift)
//
// `workSessionModel.canReattachWorkSession` 은 서버와 **두 입력이 다르다**:
//
//   웹  (running|idle) AND host.online === true
//   서버 (running|idle) AND NOT revoked AND remoteAttachAvailable
//
// 웹은 서버가 일부러 뺀 `online` 을 게이트로 쓰고, 서버가 쓰는 두 입력을 안
// 본다. 그리고 `online` 은 이 레포가 이미 못 믿는다고 적어 둔 칼럼이다
// (`workSessionModel.workHostOnline` 실측: momowebqa 2026-07-26, 등록된 호스트 8개
// 전부 `online: false`, 그중 하나는 그 순간 15개의 `agent.partial` 을 릴레이 중).
// 즉 웹은 **돌아갈 수 있는 세션에 돌아갈 길을 안 보여주고 있었다**. `online` 은
// 게이트가 아니라 조언으로 내려온다 — 서버가 `host_online` 을 verdict와 분리해
// 따로 싣는 이유와 같다.
//
// ## 낱말이 교차한다 — 여기가 그 사실을 적어 두는 자리
//
// 와이어 이름과 우리말이 **엇갈려 있다**. 이것을 모르고 배선하면 정확히 반대로
// 붙는다.
//
//   우리말 **재개**  = 서버 verdict `reattach`        = `…/terminal-attach`
//   우리말 **인수**  = 서버 verdict `resume_lineage`  = `POST …/resume`
//
// 서버의 `resume` 엔드포인트는 **재개가 아니라 인수**다. 이름을 서버에서 바꾸는
// 것은 이 티켓의 몫이 아니므로(공개 계약), 대신 그 교차를 이 파일이 상수로 들고
// 있고 호출자는 우리말만 본다.
// =============================================================================

/**
 * 서버 `verdict` 의 세 값. **와이어 어휘 그대로**다(snake_case) — 번역하지 않는
 * 이유는 상세 화면이 실제로 이 문자열을 받아 오기 때문이고, 두 벌이면 언젠가
 * 갈라진다.
 */
export type SessionVerdict = "reattach" | "resume_lineage" | "replay_only";

/** 화면이 세우는 동사. `replay_only` 에는 동사가 없다. */
export type HandoffVerb = "resume" | "takeover";

/** 와이어 문자열 -> 판정. 모르는 값은 `null`(추측 금지). */
export function parseSessionVerdict(raw: unknown): SessionVerdict | null {
  return raw === "reattach" || raw === "resume_lineage" || raw === "replay_only"
    ? raw
    : null;
}

/**
 * 이 세션의 호스트가 해지됐는가. 명부가 없거나 호스트를 못 찾으면 `null` —
 * 「해지 안 됨」이 아니라 「모른다」다.
 */
export function workHostRevoked(
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined
): boolean | null {
  if (!hosts) return null;
  const host = hosts.find((candidate) => uuidEq(candidate.id, session.hostId));
  if (host === undefined) return null;
  return host.revokedAtMs !== undefined;
}

/**
 * 서버 규칙을 그대로 복제한 판정. 명부를 아직 못 읽었으면 `null` 이고, 화면은
 * 그동안 **아무 동사도 세우지 않는다**.
 *
 * `null` 을 `replay_only` 로 접지 않는 이유: 「기록만 볼 수 있습니다」는 돌아갈
 * 길이 없다는 **주장**이고, 명부가 늦게 오는 흔한 판에서 그 주장은 틀린다.
 * 모르는 동안 버튼이 없는 것과, 없다고 말해 버리는 것은 다르다.
 *
 * `host.online` 은 **입력이 아니다**(파일 머리말). 조언은 `handoffAdvisory` 가
 * 따로 나른다.
 */
export function sessionVerdict(
  session: Pick<WorkSession, "hostId" | "status" | "remoteAttachAvailable">,
  hosts: readonly WorkHost[] | undefined
): SessionVerdict | null {
  if (session.status === "orphaned") return "resume_lineage";
  if (session.status === "running" || session.status === "idle") {
    const revoked = workHostRevoked(session, hosts);
    if (revoked === null) return null;
    return !revoked && session.remoteAttachAvailable
      ? "reattach"
      : "replay_only";
  }
  // `ended`, 그리고 이 빌드가 모르는 상태.
  return "replay_only";
}

/** 판정 -> 동사. `replay_only` 는 동사가 없다. */
export function handoffVerb(
  verdict: SessionVerdict | null
): HandoffVerb | null {
  if (verdict === "reattach") return "resume";
  if (verdict === "resume_lineage") return "takeover";
  return null;
}

/** 세션 하나에서 곧장 동사로. 두 단계를 각자 부르다 한쪽만 갱신하는 것을 막는다. */
export function sessionHandoffVerb(
  session: Pick<WorkSession, "hostId" | "status" | "remoteAttachAvailable">,
  hosts: readonly WorkHost[] | undefined
): HandoffVerb | null {
  return handoffVerb(sessionVerdict(session, hosts));
}

// ---- 문구 -------------------------------------------------------------------

export interface HandoffVerbCopy {
  /** 동사 그 자체. 제목·라벨이 쓴다. */
  verb: string;
  /** 이 동사를 실행하는 버튼의 보이는 글자. */
  button: string;
  /** 이 동사가 무엇을 하는지 한 줄. 버튼 옆이 아니라 블록 안에 선다. */
  lead: string;
}

/**
 * 두 동사의 정본 문구. **웹의 「재개」가 「이어서 보기」인 것은 오타가 아니다.**
 *
 * 서버의 `reattach` 는 "이어서 보기/쓰기"이고, 둘 중 이 클라이언트가 할 수 있는
 * 것은 **보기뿐**이다: 웹은 언제나 `mode: "observer"` 로만 붙고(`lib/api.ts`
 * `issueObserverTerminalAttach`), controller 권한이 나르는 stdin/resize/kill 을
 * 인코딩할 코드가 이 클라이언트에 없다(`features/work/observerStream.ts`).
 * 「재개하기」라고 적으면 키보드를 돌려준다는 뜻이 되고, 그것은 이 빌드가 지킬
 * 수 없는 약속이다. 동사는 재개가 맞고, 이 기기에서 그 동사가 할 수 있는 데까지가
 * 「보기」다. stdin 을 보낼 수 있는 클라이언트는 같은 동사를 「이어서 쓰기」로
 * 적으면 되고, 그때 바뀌는 것은 이 상수 하나다.
 */
export const HANDOFF_COPY: Readonly<Record<HandoffVerb, HandoffVerbCopy>> = {
  resume: {
    verb: "재개",
    button: "이어서 보기",
    lead: "세션은 원래 호스트에 그대로 있습니다. 진행 내역과 터미널로 돌아갑니다.",
  },
  // `lead` 가 「이어서 **실행**합니다」라고 말하지 않는 것은 신중함이 아니라
  // 실측이다. Rust 서버의 resume 은 원장 행을 만들고 브로드캐스트할 뿐,
  // 새 호스트에 도구를 다시 띄우라는 지시를 보내지 않는다 — Swift 원본의
  // `work_control` 스폰 디스패치가 포트에서 빠져 있다(`work_sessions.rs:45-50`
  // 의 명시적 생략 목록). 그래서 이 문장이 약속하는 것은 **가져온다**까지이고,
  // 그 다음에 무엇이 도는지는 이 클라이언트가 보증할 수 있는 범위 밖이다.
  takeover: {
    verb: "인수",
    button: "인수",
    lead: "원래 호스트가 멈춘 세션을 다른 호스트로 가져옵니다.",
  },
};

/**
 * 비대칭 고지 (ADR-0154 D4 「초기 단방향 허용 — 비대칭 명시」).
 *
 * 인수는 **한 방향으로만** 된다. 서버는 `status == "orphaned"` 인 세션만 받고
 * (`work_sessions.rs:652-657`, 그 밖은 409), `orphaned` 는 사람이 만들 수 있는
 * 상태가 아니다 — 알림 스윕만 그 값을 쓰고(`momo-t3::sweep`), 그 조건은 호스트가
 * 유예 시간 넘게 신호를 끊었거나 데몬이 스스로 손실을 보고한 것이다. 서버 어디에도
 * `host_lost_at` 이나 `status='orphaned'` 를 쓰는 HTTP 경로가 없다.
 *
 * 즉 **살아 있는 기기에서 세션을 빼앗을 수 없다.** 강제 플래그도, 생존성 무시
 * 경로도 없다. 이 사실을 화면이 말하지 않으면 사람은 다른 기기에서 도는 세션을
 * 보며 「인수 버튼이 어디 있지」를 찾다가, 그것이 없는 것을 결함으로 읽는다.
 *
 * ## 상수가 아니라 함수인 이유 (R1 M1)
 *
 * 앞 판은 한 문장이었고, 그 문장이 두 군데서 어긋났다.
 *
 * 1. **주어가 유휴 세션에서 틀렸다.** 이 고지가 서는 조건은 verdict `reattach`
 *    인데 그 판정은 `running` 과 `idle` 을 함께 받는다. 대기 중인 세션 위에서
 *    「실행 중인 세션은」은 화면이 같은 카드에 「완료 · 대기 중」이라고 적어 둔
 *    것과 정면으로 다르다.
 * 2. **없는 길을 약속했다.** 「그 기기에서 멈춘 뒤에야」는 사람이 걸을 수 있는
 *    길처럼 읽히지만, 사람이 세션을 멈추면 그것은 `ended` 이고 `ended` 는 인수
 *    대상이 아니다(서버는 `orphaned` 만 받는다). `orphaned` 를 만드는 것은
 *    스윕뿐이고 그 조건은 **호스트가 신호를 끊는 것**이다. 즉 앞 판의 문장을
 *    그대로 따른 사람은 인수를 영영 못 하게 된다.
 *
 * 그래서 지금 문장은 조건을 말하고 지시하지 않는다. 상태는 카드가 이미 렌더하고
 * 있는 그 값을 받는다 — 고지가 칩과 다른 말을 할 수 없게.
 */
export function takeoverOneWayCopy(status: WorkSession["status"]): string {
  const subject = status === "idle" ? "대기 중인 세션" : "실행 중인 세션";
  return `다른 기기에서 ${subject}입니다. 인수는 그 호스트의 연결이 끊긴 뒤에 열립니다.`;
}

/**
 * 지금 이 카드가 비대칭 고지를 세워야 하는가.
 *
 * 살아 있는 세션 **전부**에 붙이지 않는다. 자기 기계에서 도는 세션에 「인수할 수
 * 없습니다」를 붙이면 아무도 하려 하지 않은 일을 금지당하는 것이고, 경고가
 * 기본값이 되면 그것은 경고가 아니다(`itemDurabilityBadge` 가 턴 카드에 대해
 * 세운 것과 같은 규칙). 붙는 자리는 사람이 실제로 인수를 원할 만한 곳 하나다:
 * **내 것이 아닌 기기**에서 살아 있는 세션.
 */
export function showsOneWayNote(
  verdict: SessionVerdict | null,
  session: Pick<WorkSession, "hostId">,
  hosts: readonly WorkHost[] | undefined,
  viewerMemberId: string
): boolean {
  if (verdict !== "reattach") return false;
  const host = hosts?.find((candidate) => uuidEq(candidate.id, session.hostId));
  if (host === undefined) return false;
  return !uuidEq(host.ownerMemberId, viewerMemberId);
}

/**
 * 동사가 하나도 안 서는 카드의 한 줄. 「할 수 있는 것이 없다」가 아니라 「기록은
 * 남아 있다」로 말한다 — 실제로 스레드는 그대로고, 그것이 이 상태에서 사람이 할
 * 수 있는 일이다.
 */
export const REPLAY_ONLY_COPY = "끝난 세션입니다. 진행 내역은 그대로 볼 수 있습니다.";

// ---- 조언 (게이트가 아니다) --------------------------------------------------

/**
 * 동사 옆에 붙는 경고 한 줄, 또는 `null`.
 *
 * 하트비트가 없다는 사실은 **동사를 막지 않는다**(서버가 verdict에서 뺀 그
 * 이유 그대로). 다만 침묵하지도 않는다: 재개를 눌렀는데 터미널이 안 열리는 흔한
 * 원인이 이것이고, 그 사실을 미리 아는 것과 누른 뒤에 아는 것은 다르다.
 */
export function handoffAdvisory(
  verb: HandoffVerb | null,
  hostOnline: boolean | null
): string | null {
  if (verb !== "resume") return null;
  if (hostOnline !== false) return null;
  return "이 호스트에서 최근 신호를 받지 못했습니다. 터미널이 바로 열리지 않을 수 있습니다.";
}

// ---- 인수 사전조건 -----------------------------------------------------------

/**
 * 인수를 실제로 누를 수 있는가. `spawnHostChoice.spawnHostGate` 와 **같은 형상**
 * 이다(`canApprove` / `blockedCopy`): 같은 종류의 답을 두 가지 모양으로 두면
 * 호출자가 두 가지로 다루게 된다.
 */
export interface TakeoverGate {
  canTakeover: boolean;
  /** 못 하는 이유 — **무엇을 하면 되는지**로 적는다. 가능하면 없다. */
  blockedCopy?: string;
}

/**
 * 자격 있는 대상 호스트가 하나도 없다.
 *
 * 상수인 이유: 이 사실은 두 표면에서 **같은 사실**이다(작업 세션 패널의 인수
 * 블록, 작업 흐름 상세의 인수 블록). 작업 흐름 쪽은 「온라인인 다른 호스트가
 * 없습니다」라는 자기 문장을 들고 있었는데, 그 문장은 상태만 말하고 사람을 세워
 * 두는 데다 `online` 을 자격 조건으로 부른다 — 이 파일 머리말이 못 믿는다고 적어
 * 둔 바로 그 칼럼이고, 실제 자격 규칙(`takeoverTargets`)은 그것을 보지 않는다.
 */
export const TAKEOVER_NO_TARGET_COPY =
  "인수할 수 있는 다른 호스트가 없습니다. 호스트 앱이 켜져 있는지 확인한 뒤 다시 시도하세요.";

/**
 * 인수 사전조건 **선검사**. 요청을 보내기 전에 확실히 아는 것만 본다.
 *
 * ## 여기서 검사하지 **않는** 것과 그 이유 (실측, ADR-0154 D3 이탈)
 *
 * ADR-0154 D3 은 사전조건으로 「클린 트리·브랜치 push·동일 repo」를 적었다.
 * **서버에 그 셋이 없다.** `routes/work_sessions.rs::resume_in_tx` 가 실제로
 * 거는 관문은 전부 다음이고(측정 2026-08-07), git 상태를 읽는 코드는 이 경로
 * 어디에도 없다:
 *
 *   require_human                    사람 토큰만 (에이전트는 인수할 수 없다)
 *   work_tool_is_enabled_in_tx       400 work tool is not registered or enabled
 *   source.status == "orphaned"      409 only an orphaned work session can resume
 *   is_active_channel_member_in_tx   403 active channel membership required
 *   acquire_slot_in_tx               409 pool_exhausted | member_limit
 *
 * 워킹 트리는 호스트 위에 있고 원장에 투영되지 않는다 — 서버도 클라이언트도
 * 그것을 볼 창이 없다. 그래서 「커밋 안 된 변경이 있습니다」를 여기서 말하면
 * 그것은 검사가 아니라 **지어낸 문장**이다. 대신 그 사실은 검사에서 빠지고
 * 복원 고지(`TAKEOVER_FRESH`)에 남는다: 확인해 줄 수는 없지만 잃는다는 것은
 * 확실하므로, 「막는다」가 아니라 「말한다」가 정직한 자리다.
 *
 * 남은 셋(도구·멤버십·슬롯)은 클라이언트가 **미리 알 수 없다** — 어느 것도 원장
 * 투영에 없다. 그것들은 거절이 돌아온 뒤 `takeoverFailureCopy` 가 행동으로
 * 번역한다. 선검사가 답할 수 있는 것은 둘뿐이고, 이 함수는 그 둘만 답한다.
 *
 * ## 대상 자격 검사가 여기서 **유일한** 방어다 (실측)
 *
 * Swift 서버는 대상 호스트를 서버에서 걸렀다(`WorkSessionRoutes.requireResumeTarget`
 * :2518-2555 — 해지된 호스트 409, 남의 개인 호스트 409, tier 정책 409). **Rust
 * 포트에는 그 넷이 없다**(`work_sessions.rs:45-47` 의 명시적 생략 목록). 대상이
 * 죽은 원본 호스트와 같아도 막지 않는다 — `resume_in_tx` 에 `target_host_id`
 * 와 `source.host_id` 를 비교하는 줄이 없고, DB 제약도 `resumed_from_session_id
 * <> id` 뿐이다(`025_work_tier_fallback.sql:54-55`).
 *
 * 즉 `takeoverTargets` 의 필터는 편의가 아니라 **지금 이 계약에서 유일하게
 * 성립하는 대상 검사**다. 화면이 고를 수 없게 만드는 것이 곧 방어라는 뜻이고,
 * 목록에 없는 호스트 id 를 손으로 실어 보내지 않는 것이 호출자의 의무다.
 */
export function takeoverGate(
  session: Pick<WorkSession, "hostId" | "status" | "remoteAttachAvailable">,
  hosts: readonly WorkHost[] | undefined,
  targets: readonly WorkHost[]
): TakeoverGate {
  const verdict = sessionVerdict(session, hosts);
  if (verdict !== "resume_lineage") {
    // 동사가 잘못 배정된 자리. 무엇을 **대신** 하면 되는지까지 말한다 — 이
    // 갈래가 이 티켓의 red proof 하나다.
    return {
      canTakeover: false,
      blockedCopy:
        verdict === "reattach"
          ? "이 세션은 아직 원래 호스트에 있습니다. 인수 대신 이어서 보기로 돌아가세요."
          : verdict === null
            ? "호스트 명부를 아직 읽지 못했습니다. 잠시 뒤 다시 확인하세요."
            : "끝난 세션은 인수할 수 없습니다. 같은 작업을 이어가려면 새 세션을 시작하세요.",
    };
  }
  if (targets.length === 0) {
    // 이 상태의 원인은 거의 항상 「내 기계가 꺼져 있다」이고, 30초 안에 사람이
    // 고칠 수 있다. `spawnHostChoice.NO_ELIGIBLE_HOST_COPY` 가 같은 이유로 같은
    // 모양의 문장을 쓴다.
    return { canTakeover: false, blockedCopy: TAKEOVER_NO_TARGET_COPY };
  }
  return { canTakeover: true };
}

/**
 * 서버가 인수를 거절했다 -> **무엇을 하면 되는지**.
 *
 * 앞 판의 문장은 모든 실패에 하나였다: "새 호스트에서 재개하지 못했습니다.
 * 호스트 상태를 확인한 뒤 다시 시도하세요." 슬롯이 가득 찬 경우에 그 문장은
 * 틀린 곳을 고치라고 시킨다 — 호스트는 멀쩡하다.
 *
 * 매칭은 상태 코드와 서버 메시지 둘 다 본다. 서버 메시지는 닫힌 어휘라
 * (`pool_exhausted`, `member_limit`) 문자열 비교가 안전하고, 그렇지 않은 것은
 * 상태 코드로 갈린다. **모르는 실패는 모른다고 말한다** — 지어낸 원인을 대면
 * 사람은 멀쩡한 곳을 고치러 간다.
 */
export function takeoverFailureCopy(
  status: number | undefined,
  message: string | undefined
): string {
  const raw = message ?? "";
  if (raw.includes("pool_exhausted")) {
    return "지금 실행 슬롯이 모두 찼습니다. 진행 중인 작업이 끝난 뒤 다시 시도하세요.";
  }
  if (raw.includes("member_limit")) {
    return "동시에 실행할 수 있는 내 작업 수를 넘었습니다. 내 세션 하나를 끝낸 뒤 다시 시도하세요.";
  }
  if (raw.includes("only an orphaned work session can resume")) {
    // 판정이 그 사이에 바뀌었다. 화면을 다시 읽으라고 말한다.
    return "이 세션은 더 이상 인수 대상이 아닙니다. 목록을 새로 고친 뒤 다시 확인하세요.";
  }
  if (raw.includes("work tool is not registered or enabled")) {
    return "이 세션의 도구가 워크스페이스에서 꺼져 있습니다. 관리자에게 도구를 켜 달라고 요청하세요.";
  }
  if (status === 403) {
    return "이 세션이 있는 채널의 멤버만 인수할 수 있습니다. 채널에 참여한 뒤 다시 시도하세요.";
  }
  if (status === 404) {
    return "세션을 찾을 수 없습니다. 목록을 새로 고쳐 확인하세요.";
  }
  if (status === 409) {
    return "다른 곳에서 이 세션의 상태가 바뀌었습니다. 목록을 새로 고친 뒤 다시 시도하세요.";
  }
  return "인수하지 못했습니다. 잠시 뒤 다시 시도하세요.";
}

// ---- 부분 복원 정직 표기 -----------------------------------------------------

/**
 * 인수하면 **무엇이 따라오는가**. 실측이고, 추측이 아니다.
 *
 * `momo-t3::lifecycle::create_resumed_work_session_in_tx` 의 INSERT 열 목록이
 * 정본이다(측정 2026-08-07). 새 행이 원본에서 **복사**하는 것:
 *
 *   channel_id · root_message_id · tool · label · observation
 *
 * `root_message_id` 가 그대로인 것이 이 고지의 핵심이다. 세션 카드와 그 스레드는
 * **같은 것 하나**이고, ACP 이벤트는 전부 그 스레드의 답글이다. 즉 인수된 세션은
 * 새 스레드를 파지 않고 원래 스레드에 이어 쌓인다 — ADR-0154 D3 이 「대화는
 * 복원」이라고 부른 것이 이 한 칸이고, 그것은 실제로 참이다.
 *
 * INSERT 에 **없는** 것이 새로 시작하는 것이다: `host_id` 는 새로 고른 호스트고,
 * `pty_id`/`attach_endpoint` 는 실리지 않아 `remoteAttachAvailable` 이 거짓으로
 * 시작한다(터미널이 넘어오지 않는다는 뜻). 워킹 트리는 애초에 원장에 없다.
 *
 * 두 목록을 **한 문장으로 합치지 않는다**. "대화는 복원되지만 환경은 새로
 * 시작합니다"는 읽는 사람이 자기 미커밋 변경이 어느 쪽인지 스스로 판정하게
 * 만든다. 목록은 그 판정을 대신 해 준다.
 */
export const TAKEOVER_RESTORED: readonly string[] = [
  "지금까지의 진행 내역: 같은 스레드에 이어서 쌓입니다",
  "세션 이름과 도구, 관전 설정",
];

/**
 * 실행자가 바뀌는 것이 이 목록에 있는 이유: 서버가 새 행의 `member_id` 에
 * **호출자**를 싣는다(`create_resumed_work_session_in_tx` 바인딩 실측 — 원본의
 * `member_id` 가 아니다). 남이 시작한 세션을 인수하면 그 실행은 내 이름으로
 * 이어지고, 원장에는 두 실행이 나란히 남는다(ADR-0143 D2: "the source
 * `member_id` stays an execution record and is never transferred"). 세션을 끝낼
 * 수 있는 사람도 그때부터 나다.
 */
export const TAKEOVER_FRESH: readonly string[] = [
  "실행 환경: 새 호스트에서 처음부터 시작합니다",
  "이전 호스트의 터미널, 그리고 커밋하지 않은 변경",
  "실행자: 이 작업은 내 이름으로 이어집니다",
];

/** 두 목록 위에 서는 제목. 「부분」이라는 사실이 제목에 있어야 한다. */
export const TAKEOVER_DISCLOSURE_HEADLINE = "인수하면 일부만 넘어옵니다.";
export const TAKEOVER_RESTORED_LABEL = "그대로 이어지는 것";
export const TAKEOVER_FRESH_LABEL = "새로 시작하는 것";

// ---- 인수 대상 --------------------------------------------------------------

/**
 * 인수 대상 호스트. `workSessionModel.workSessionResumeTargets` 를 **그대로**
 * 부른다 — 여기에 두 번째 자격 규칙을 두지 않는다는 뜻이고, 그 파일이 자기
 * 주석에 이미 적어 둔 이유("eligibility has to be asked in ONE place")를 이
 * 파일이 지키는 방식이다.
 *
 * 이 재수출이 있는 이유는 호출자의 시선이다: 인수 동선을 배선하는 사람이 읽는
 * 파일이 여기이고, 대상 목록만 다른 파일에서 찾아 오게 하면 그 사람은 자격
 * 규칙이 이 동선의 일부라는 것을 모른 채 지나간다.
 */
export { workSessionResumeTargets as takeoverTargets } from "./workSessionModel";
