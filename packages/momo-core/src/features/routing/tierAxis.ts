import { uuidEq } from "../../lib/api";
import { CLOUD_TARGET, WORK_TIER_MODES } from "../settings/model";
import {
  workExecutionLocationKey,
  workExecutionLocationLabel,
  type WorkExecutionLocationKey,
} from "../work/workLocation";

// =============================================================================
// 컴포저 라우팅 스트립의 실행 티어 축 (CRUN-1 / 이슈 1382).
//
// Cursor의 「Run on」을 복제하지 않고 번역한 것이다. 저쪽 칩은 **고른 값만**
// 보여주고 아무것도 고르지 않은 상태에서는 무슨 일이 일어나는지 말하지 않는다.
// 이 줄의 문법은 반대쪽이고, 그것은 MentionRoutingBar 머리말이 이미 세운 결정을
// 그대로 잇는 것이다: 줄의 기본 내용은 오버라이드가 아니라 **상속**이며, 상속된
// 실제 값이 함께 적힌다.
//
// -----------------------------------------------------------------------------
// 이 축이 지금 **표시 전용**인 이유 (전선 실측 2026-08-15)
//
// 메시지 한 건에 실을 수 있는 라우팅 블록은 닫힌 세계다. 서버의 허용 키는 두 개
// 뿐이고(`server-rust/crates/momo-agent/src/routing.rs`의 `ROUTING_KEYS =
// ["model", "effort"]`), openapi의 `RunRoutingInput`도 `additionalProperties:
// false`다. `SendMessageRequest` 어디에도 호스트나 실행 위치를 받는 키는 없다.
// 즉 `routing.tier`를 지어내서 실으면 서버는 그것을 조용히 무시하는 것이 아니라
// **400 `routing contains unknown fields`로 전송 전체를 되돌린다.**
//
// 그래서 이 파일은 없는 계약을 만들지 않는다. 축은 끝까지 그리되 값을 보내지
// 않고, 왜 보낼 수 없는지를 한 문장으로 말한다([`TIER_OVERRIDE_UNSUPPORTED_REASON`]).
// 그 상태에서도 상속 줄은 계속 참이다: 어차피 워크스페이스 정책이 그대로 적용
// 되므로, 이 줄이 말하는 내용은 오히려 그때 더 정확하다.
//
// -----------------------------------------------------------------------------
// 상속의 상대가 무엇인가
//
// 두 개의 실제 서버 행이다. 하나는 등록기(`GET .../work-hosts`, ADR-0125 D1)이고,
// 다른 하나는 이 사람에게 걸려 있는 티어 정책(`GET .../work-tier-policy/me`,
// ADR-0125 D11)이다. 둘 다 이 화면이 지어내지 않은 사실이다.
//
// **정책이 목적지를 못박지 않는 경우가 정상이다.** `ask`와 `t1_only`는 시작 위치를
// 정하지 않고, 시작 호스트는 작업이 생길 때 서버가 D6-A로 고른 뒤 승인 카드가
// 사람에게 묻는다. 그때 이 줄이 티어 하나를 골라 적으면, 화면은 서버가 하지 않은
// 판정을 말하게 된다. 그러므로 못박지 않은 정책은 **정책의 이름을 그대로** 적는다.
//
// -----------------------------------------------------------------------------
// 부적격 티어는 숨기지 않는다
//
// SpawnHostChoice의 선례를 그대로 잇는다(#1132): 회색으로 처리된 「T1 · 데스크톱
// 앱 (등록된 호스트가 없습니다)」이 "왜 내 랩탑을 못 고르지"의 정직한 답이고, 짧은
// 목록은 아니다. 판정 근거는 등록기 한 곳뿐이다 — 이 파일은 서버 상수를 추측하지
// 않는다(T3가 지금 스폰에서 막혀 있다는 사실은 승인 카드가 후보마다 `t3_disabled`로
// 직접 말해 주는 것이고, 여기서 대신 주장할 사실이 아니다).
// =============================================================================

/** 등록기가 아는 실행 위치 셋. `unknown`은 축이 되지 못한다. */
export type ExecutionTierKey = Exclude<WorkExecutionLocationKey, "unknown">;

export const EXECUTION_TIER_KEYS: readonly ExecutionTierKey[] = ["t1", "t2", "t3"];

/** 축의 보이는 라벨. 스크린리더 전용이 아니다. */
export const EXECUTION_TIER_LABEL = "실행 위치";

/**
 * 메시지 한 건에 실행 위치를 실을 수 없다는 사실.
 *
 * 「이 서버는」이 아니라 「아직」인 것이 중요하다. 모델·강도의 사유들은 서버 세대에
 * 따라 갈리는 사실이지만(capability.ts), 실행 위치는 **어느 세대에도 전선이 없다**.
 * 서버를 새로 올리면 풀린다고 읽히는 문장을 여기 두면 그것은 거짓말이다.
 */
export const TIER_OVERRIDE_UNSUPPORTED_REASON =
  "메시지 한 건에만 적용되는 실행 위치는 아직 보낼 수 없습니다. 이 목록은 지금 무엇이 적용되는지만 보여 줍니다.";

/** 등록기 한 행에서 이 축이 읽는 것 전부. */
export interface TierHostRow {
  /** 서버 대소문자가 흔들리므로 `uuidEq`로만 비교한다. */
  id: string;
  type: string;
  online: boolean;
  /** 해지된 행은 마지막 heartbeat가 무슨 말을 했든 사라진 호스트다. */
  revokedAtMs?: number;
}

/** 지금 이 사람에게 걸려 있는 티어 정책 (ADR-0125 D11). */
export interface TierPolicyRow {
  mode: string;
  /** `auto`에서만 채워진다: "cloud" 또는 소문자 work host id. */
  autoTarget?: string;
}

/**
 * 읽기 하나의 상태.
 *
 * `pending`과 `unreadable`을 한 칸에 넣지 않는 이유는 capability.ts와 같다:
 * 아직 못 물어본 것과 못 읽은 것은 사람에게 서로 다른 다음 행동을 준다.
 */
export type TierReadState = "pending" | "ready" | "unreadable";

export interface ExecutionTierInput {
  hostsState: TierReadState;
  hosts: readonly TierHostRow[];
  policyState: TierReadState;
  policy: TierPolicyRow | null;
}

export interface ExecutionTierOption {
  key: ExecutionTierKey;
  /** "T2 · 셀프호스트" — workLocation.ts 정본 그대로. */
  label: string;
  /** 지금 이 티어에 돌 수 있는 호스트가 있는가. */
  eligible: boolean;
  /** 없으면 왜인지, **한 문장**. 적격이면 null. */
  reason: string | null;
}

export interface InheritedTier {
  /** 정책이 목적지를 못박았을 때만 있다. 아니면 null이고 그것이 정상이다. */
  key: ExecutionTierKey | null;
  /** 상속 옵션에 적히는 문구. "상속 (연결 끊김 시 묻기)" */
  label: string;
  /** 그래서 이번 메시지에 무슨 일이 일어나는가, 한 문장. */
  sentence: string;
}

export interface ExecutionTierAxis {
  inherited: InheritedTier;
  options: readonly ExecutionTierOption[];
  /** 접힌 줄의 요약 조각. "실행 위치 T3 · 클라우드" */
  summary: string;
  /** 지금 이 축을 메시지 한 건에 실을 수 있는가. */
  overrideSupported: boolean;
  /** 실을 수 없는 이유. `overrideSupported`가 참이면 null. */
  overrideReason: string | null;
}

// ---- 부적격 사유 -------------------------------------------------------------
//
// 티어마다 문장을 따로 적는다. 「등록된 {타입 라벨} 호스트가 없습니다」로 만들면
// workd 행이 "등록된 workd 데몬 호스트가 없습니다"가 되어 한 단어가 남는다. 세
// 문장을 그대로 두는 쪽이 번역 가능하고 읽힌다.

const NO_HOST_REASON: Readonly<Record<ExecutionTierKey, string>> = {
  t1: "이 워크스페이스에 등록된 데스크톱 앱 호스트가 없습니다.",
  t2: "이 워크스페이스에 등록된 셀프호스트 데몬이 없습니다.",
  t3: "이 워크스페이스에 등록된 클라우드 호스트가 없습니다.",
};

// 정책이 관리형 클라우드(oort Cloud)에서 자동 재개하는데 등록기에 직접 올린
// 클라우드 호스트가 하나도 없을 때 T3 줄이 다는 사유. 관리형 클라우드는 등록
// 호스트가 아니므로(ADR-0163 번들 호스팅 · ADR-0164 관리형 크레딧 과금) 이 조합은
// 정상이다. 그런데 그 줄이 그냥 「호스트 없음」으로 끝나면, 세 줄 위 상속 줄의
// 「자동 재개: T3 · 클라우드」와 정면으로 어긋나 보인다(design-review M2). 그래서
// 빈 등록기를 인정하되 정책이 겨냥한 관리형 클라우드를 그 자리에서 이어 준다.
const RESERVED_CLOUD_T3_REASON =
  "등록된 클라우드 호스트는 없지만, 정책이 관리형 oort Cloud에서 자동 재개합니다.";

const ALL_OFFLINE_REASON: Readonly<Record<ExecutionTierKey, string>> = {
  t1: "등록된 데스크톱 앱 호스트가 모두 오프라인입니다.",
  t2: "등록된 셀프호스트 데몬이 모두 오프라인입니다.",
  t3: "등록된 클라우드 호스트가 모두 오프라인입니다.",
};

const REGISTRY_PENDING_REASON = "등록된 호스트를 확인하는 중입니다.";

const REGISTRY_UNREADABLE_REASON =
  "등록된 호스트 목록을 불러오지 못해 여기서 돌 수 있는지 확인하지 못했습니다.";

// ---- 상속 --------------------------------------------------------------------

const POLICY_PENDING_SENTENCE =
  "이 워크스페이스의 실행 위치 정책을 확인하는 중입니다.";

const POLICY_UNREADABLE_SENTENCE =
  "이 워크스페이스의 실행 위치 정책을 불러오지 못해 어디서 돌지 확인하지 못했습니다.";

const POLICY_UNKNOWN_MODE_SENTENCE =
  "이 빌드가 모르는 실행 위치 정책이 걸려 있습니다. 워크스페이스 설정에서 확인하세요.";

/**
 * 정책 mode의 사람 말. 설정 화면과 **같은 목록**에서 가져온다(WORK_TIER_MODES).
 *
 * 라벨을 여기 다시 적으면 설정에서 고른 문장과 컴포저가 되읽는 문장이 갈라지고,
 * 사람은 같은 정책을 두 이름으로 배우게 된다.
 */
export function tierPolicyModeLabel(mode: string): string | null {
  return WORK_TIER_MODES.find((choice) => choice.id === mode)?.label ?? null;
}

/**
 * 「바꾸지 않으면 무슨 일이 일어나는가」 한 문장.
 *
 * WORK_TIER_MODES의 `detail`을 그대로 쓰지 않는다. 그 문장들은 **설정 화면의 라디오
 * 옆**에 서 있어서 "고르지 않으면 이 값이 쓰입니다" 같은 절을 달고 있고, 그것은
 * 이 화면에서는 참이 아니다(여기서는 아무것도 고를 수 없다). 결과 자체는 같은
 * 사실이므로 같은 뜻을 말하되, 주어를 이번 메시지로 바꿔 이 표면의 문장으로 적는다.
 */
function nonAutoPolicySentence(mode: string): string {
  if (mode === "t1_only") {
    return "이 메시지가 작업을 일으키면 그 작업을 처음 시작한 호스트에서만 돌고, 그 호스트를 잃으면 돌아오기를 기다립니다.";
  }
  if (mode === "ask") {
    return "이 메시지가 작업을 일으키면 호스트를 잃었을 때 어디서 이어갈지 물어봅니다.";
  }
  return POLICY_UNKNOWN_MODE_SENTENCE;
}

/** `auto`가 목적지를 못박았을 때의 문장. 자동 재개의 결과를 그대로 옮긴다. */
function autoPinnedSentence(pinned: ExecutionTierKey): string {
  return `이 메시지가 작업을 일으키면 호스트를 잃었을 때 ${workExecutionLocationLabel(
    pinned
  )}에서 마지막 push 커밋으로 새로 시작합니다.`;
}

const AUTO_TARGET_PENDING_SENTENCE =
  "이 메시지가 작업을 일으키면 호스트를 잃었을 때 정책이 정한 호스트에서 새로 시작합니다. 그 호스트가 어느 실행 위치인지는 아직 확인하는 중입니다.";

const AUTO_TARGET_MISSING_SENTENCE =
  "정책이 자동 재개 대상으로 정해 둔 호스트를 등록기에서 찾지 못해 어디서 이어갈지 확인하지 못했습니다.";

const AUTO_TARGET_UNKNOWN_TYPE_SENTENCE =
  "정책이 자동 재개 대상으로 정해 둔 호스트가 이 빌드가 모르는 종류라 실행 위치를 말할 수 없습니다.";

// 요약 줄에 들어갈 짧은 값.
//
// 정책이 목적지를 못박았으면 티어 라벨이 그대로 들어가고, 아니면 **정책 이름이
// 아니라** 「워크스페이스 정책」이 들어간다. 접힌 한 줄에서 "실행 위치 연결 끊김
// 시 묻기"는 위치를 묻는 자리에 위치가 아닌 답을 앉히는 것이고, 그 정책이 정확히
// 무엇인지는 펼친 상자의 상속 줄이 이미 말한다.
//
// 못 읽은 경우의 값은 `실행 위치 확인 필요`가 되어 workLocation.ts의 `unknown`
// 라벨과 글자 그대로 같아진다. 같은 사실에 두 문장을 만들지 않는다.
const SUMMARY_UNKNOWN = "확인 필요";
const SUMMARY_PENDING = "확인 중";
const SUMMARY_POLICY = "워크스페이스 정책";

interface ResolvedInheritance {
  inherited: InheritedTier;
  /** 요약 줄의 값 조각. */
  summaryValue: string;
}

function resolveInheritance(input: ExecutionTierInput): ResolvedInheritance {
  if (input.policyState === "pending") {
    return {
      inherited: {
        key: null,
        label: `상속 (${SUMMARY_PENDING})`,
        sentence: POLICY_PENDING_SENTENCE,
      },
      summaryValue: SUMMARY_PENDING,
    };
  }
  if (input.policyState === "unreadable" || input.policy === null) {
    return {
      inherited: {
        key: null,
        label: "상속 (확인하지 못함)",
        sentence: POLICY_UNREADABLE_SENTENCE,
      },
      summaryValue: SUMMARY_UNKNOWN,
    };
  }

  const { mode, autoTarget } = input.policy;
  const modeLabel = tierPolicyModeLabel(mode);
  if (modeLabel === null) {
    return {
      inherited: {
        key: null,
        label: "상속 (워크스페이스 정책)",
        sentence: POLICY_UNKNOWN_MODE_SENTENCE,
      },
      summaryValue: SUMMARY_UNKNOWN,
    };
  }

  if (mode !== "auto") {
    return {
      inherited: {
        key: null,
        label: `상속 (${modeLabel})`,
        sentence: nonAutoPolicySentence(mode),
      },
      summaryValue: SUMMARY_POLICY,
    };
  }

  const pinned = (key: ExecutionTierKey): ResolvedInheritance => ({
    inherited: {
      key,
      label: `상속 (${modeLabel}: ${workExecutionLocationLabel(key)})`,
      sentence: autoPinnedSentence(key),
    },
    summaryValue: workExecutionLocationLabel(key),
  });
  const unpinned = (sentence: string, summaryValue: string): ResolvedInheritance => ({
    inherited: { key: null, label: `상속 (${modeLabel})`, sentence },
    summaryValue,
  });

  // `auto`만 목적지를 못박는다. "cloud"는 예약된 선택자라 등록기를 보지 않아도
  // 답이 나오고, host id는 등록기를 읽어야 어느 티어인지 알 수 있다.
  if (autoTarget === CLOUD_TARGET) return pinned("t3");
  if (autoTarget === undefined || autoTarget.trim() === "") {
    return unpinned(AUTO_TARGET_MISSING_SENTENCE, SUMMARY_UNKNOWN);
  }
  // 등록기를 아직 못 읽었으면 "찾지 못했다"고 말하지 않는다. 그것은 등록기에 대한
  // 사실이 아니라 우리가 방금 못 물어봤다는 상태다.
  if (input.hostsState !== "ready") {
    return unpinned(AUTO_TARGET_PENDING_SENTENCE, SUMMARY_PENDING);
  }
  const target = input.hosts.find((host) => uuidEq(host.id, autoTarget));
  if (target === undefined) {
    return unpinned(AUTO_TARGET_MISSING_SENTENCE, SUMMARY_UNKNOWN);
  }
  const key = workExecutionLocationKey(target.type);
  if (key === "unknown") {
    return unpinned(AUTO_TARGET_UNKNOWN_TYPE_SENTENCE, SUMMARY_UNKNOWN);
  }
  return pinned(key);
}

// ---- 축 ----------------------------------------------------------------------

function tierOption(
  key: ExecutionTierKey,
  input: ExecutionTierInput,
  resumesReservedCloud: boolean
): ExecutionTierOption {
  const label = workExecutionLocationLabel(key);
  if (input.hostsState === "pending") {
    return { key, label, eligible: false, reason: REGISTRY_PENDING_REASON };
  }
  if (input.hostsState === "unreadable") {
    return { key, label, eligible: false, reason: REGISTRY_UNREADABLE_REASON };
  }
  const rows = input.hosts.filter(
    (host) =>
      host.revokedAtMs === undefined && workExecutionLocationKey(host.type) === key
  );
  if (rows.length === 0) {
    // 클라우드 티어만 특별하다: 등록기가 비어도 관리형 oort Cloud가 정책의 자동
    // 재개 목적지면 상속 줄과 어긋나지 않게 그 사실을 인정한다(M2). 다른 티어와
    // 다른 클라우드의 빈 상태는 그대로 「호스트 없음」이다.
    if (key === "t3" && resumesReservedCloud) {
      return { key, label, eligible: false, reason: RESERVED_CLOUD_T3_REASON };
    }
    return { key, label, eligible: false, reason: NO_HOST_REASON[key] };
  }
  if (!rows.some((host) => host.online)) {
    return { key, label, eligible: false, reason: ALL_OFFLINE_REASON[key] };
  }
  return { key, label, eligible: true, reason: null };
}

/**
 * 등록기 + 정책 두 사실을 축 하나로.
 *
 * 순수 함수라 단위 테스트가 문구와 판정을 함께 고정한다. React 쪽은 두 쿼리의
 * 상태를 [`TierReadState`]로 옮겨 넘기는 일만 한다.
 */
export function resolveExecutionTierAxis(
  input: ExecutionTierInput
): ExecutionTierAxis {
  const { inherited, summaryValue } = resolveInheritance(input);
  // 정책이 예약된 관리형 클라우드에서 자동 재개하는가. 그렇다면 빈 클라우드 등록기는
  // 모순이 아니라 정상이고, T3 줄이 그 사실을 직접 말해야 한다(M2).
  const resumesReservedCloud =
    input.policy?.mode === "auto" && input.policy?.autoTarget === CLOUD_TARGET;
  return {
    inherited,
    options: EXECUTION_TIER_KEYS.map((key) =>
      tierOption(key, input, resumesReservedCloud)
    ),
    summary: `${EXECUTION_TIER_LABEL} ${summaryValue}`,
    overrideSupported: false,
    overrideReason: TIER_OVERRIDE_UNSUPPORTED_REASON,
  };
}
