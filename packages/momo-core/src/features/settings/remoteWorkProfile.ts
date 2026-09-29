import { LOCAL_HARNESS_IDS, type LocalHarnessId, type LocalHarnessProbe } from "../hostedAgents/detect";
import { myAccountRowTitle } from "./harnessProfiles";

// =============================================================================
// 원격 작업 계정 선택 (#3157, 서버 #3156 · ADR-0191 D1 A 레인).
//
// 폰에서 시작한 작업이 이 맥에서 어느 계정으로 뜨는지는 **이 맥의 선택**이다: 데스크탑
// 셸이 코드서명 제어 소켓으로 `set_remote_profile`을 넘기면 workd가 저장하고 spawn마다
// 읽는다. 이 파일은 그 순서와 문장을 판정한다(그리기·소켓은 웹/셸의 몫).
//
// 순서: prepare(폴더 만들기) → 상태 명령 → 로그인 필요하면 로그인 창 → set. 로그인을
// 마치지 않으면 아무것도 저장하지 않는다. 어느 단계가 거부되든 **다른 계정으로 조용히
// 넘어가지 않는다**: 저장된 선택은 그대로이고, 거부 라벨이 문장으로 보인다.
// =============================================================================

/** 셸이 돌려주는 한 번의 결과. 실패는 workd의 거부 라벨이나 소켓 코드다. */
export type RemoteOpResult<T extends object = object> = ({ ok: true } & T) | { ok: false; code: string };

export interface RemoteWorkChoice {
  readonly harness: LocalHarnessId;
  readonly label: string;
}

export interface RemoteWorkDeps {
  /** `set_remote_profile`. `label: null`은 그 하네스의 선택을 지운다. */
  set(harness: LocalHarnessId, label: string | null): Promise<RemoteOpResult<{ reset: boolean }>>;
  /** `prepare_remote_profile`: 폴더를 만든다(있으면 그대로). 경로는 웹에 오지 않는다. */
  prepare(harness: LocalHarnessId, label: string): Promise<RemoteOpResult>;
  /** 그 원격 작업 폴더로 돌린 상태 명령. */
  status(harness: LocalHarnessId, label: string): Promise<LocalHarnessProbe>;
  /** 원격 작업 폴더로 공식 CLI 로그인. 연결되면 true, 마치지 않고 닫으면 false. */
  signIn(harness: LocalHarnessId, label: string): Promise<boolean>;
}

export type RemoteWorkOutcome =
  /** 이 맥이 선택을 받았다. `reset`: 선택 파일이 읽히지 않아 모두 초기화됐다. */
  | { kind: "applied"; reset: boolean }
  | { kind: "cleared"; reset: boolean }
  /** 로그인을 마치지 않고 닫았다. 아무것도 바꾸지 않았다. */
  | { kind: "login_abandoned" }
  | { kind: "refused"; code: string };

/** 「고르지 않음」이면 두 하네스의 선택을 모두 지운다. 하나라도 거부되면 거부다. */
async function clearAll(deps: Pick<RemoteWorkDeps, "set">): Promise<RemoteWorkOutcome> {
  let reset = false;
  for (const harness of LOCAL_HARNESS_IDS) {
    const result = await deps.set(harness, null);
    if (!result.ok) return { kind: "refused", code: result.code };
    reset ||= result.reset;
  }
  return { kind: "cleared", reset };
}

export async function chooseRemoteWork(
  choice: RemoteWorkChoice | null,
  deps: RemoteWorkDeps
): Promise<RemoteWorkOutcome> {
  if (choice === null) return clearAll(deps);
  const { harness, label } = choice;
  const prepared = await deps.prepare(harness, label);
  if (!prepared.ok) return { kind: "refused", code: prepared.code };
  const probe = await deps.status(harness, label);
  if (!(probe.installed && probe.auth === "logged_in")) {
    const connected = await deps.signIn(harness, label);
    if (!connected) return { kind: "login_abandoned" };
  }
  const saved = await deps.set(harness, label);
  if (!saved.ok) return { kind: "refused", code: saved.code };
  // 표는 한 칸이다: 다른 하네스에 남은 선택은 지운다(둘이 동시에 「기본」이 되지 않게).
  let reset = saved.reset;
  for (const other of LOCAL_HARNESS_IDS) {
    if (other === harness) continue;
    const cleared = await deps.set(other, null);
    if (!cleared.ok) return { kind: "refused", code: cleared.code };
    reset ||= cleared.reset;
  }
  return { kind: "applied", reset };
}

/**
 * 저장된 선택을 이 맥에 다시 넘긴다(표를 열 때). 로그인 창은 열지 않는다: 폴더가 없거나
 * 안전하지 않으면 그 사실을 거부 라벨로 돌려준다.
 */
export async function syncRemoteWork(
  choice: RemoteWorkChoice | null,
  deps: Pick<RemoteWorkDeps, "set">
): Promise<RemoteWorkOutcome> {
  if (choice === null) return clearAll(deps);
  const saved = await deps.set(choice.harness, choice.label);
  if (!saved.ok) return { kind: "refused", code: saved.code };
  let reset = saved.reset;
  for (const other of LOCAL_HARNESS_IDS) {
    if (other === choice.harness) continue;
    const cleared = await deps.set(other, null);
    if (!cleared.ok) return { kind: "refused", code: cleared.code };
    reset ||= cleared.reset;
  }
  return { kind: "applied", reset };
}

// ---- 문장(해요체, 사실만) ------------------------------------------------------------

export const REMOTE_WORK_RESET_NOTICE = "원격 작업 계정 선택이 초기화됐어요. 계정을 다시 골라 주세요.";
export const REMOTE_WORK_APPLYING = "이 맥에 적용하고 있어요";
export const REMOTE_WORK_LOGIN_ABANDONED = "로그인을 마치지 않아 원격 작업 계정을 바꾸지 않았어요.";
export const REMOTE_WORK_NOTE = "폰에서 시작한 작업은 원격 작업용으로 따로 로그인한 이 계정으로 떠요";
export const REMOTE_WORK_DEFAULT_LOGIN_SENTENCE =
  "이 맥 기본 로그인은 원격 작업에 쓰지 않아요. 계정을 골라 주세요.";

/** 로그인 창이 어느 폴더에 로그인하는지: 이 맥 로컬 계정이 아니라 원격 작업용 폴더다. */
export function remoteProfileLoginLine(harness: LocalHarnessId, label: string): string {
  return `${myAccountRowTitle({ harness, profile: label })} 계정을 원격 작업용으로 로그인해요. 폰에서 시작한 작업이 이 로그인으로 실행돼요. 브라우저에서 이 계정으로 로그인해 주세요.`;
}

const NO_SUBSTITUTE = "다른 계정으로 대신 시작하지 않아요.";

/**
 * 셸/workd가 돌려준 코드 한 개의 사용자 문장. 새 코드는 「알 수 없는 답」 문장으로 가고,
 * 코드 원문을 화면에 그대로 내지 않는다.
 */
export function remoteProfileRefusalSentence(code: string): string {
  switch (code) {
    case "profile_not_found":
      return `이 맥에 원격 작업용 계정 폴더가 없어요. 계정을 다시 골라 로그인해 주세요. ${NO_SUBSTITUTE}`;
    case "profile_refused":
      return `원격 작업용 계정 폴더가 바뀌었거나 안전하지 않아 쓰지 않았어요. 계정을 다시 골라 로그인해 주세요. ${NO_SUBSTITUTE}`;
    case "profile_login_required":
      return `원격 작업용 계정이 로그인돼 있지 않아요. 계정을 다시 골라 로그인해 주세요. ${NO_SUBSTITUTE}`;
    case "invalid_label":
    case "unknown_harness":
    case "invalid_request":
      return "이 계정은 원격 작업에 쓸 수 없는 이름이에요. 다른 계정을 골라 주세요.";
    case "profiles_unavailable":
      return "이 맥에서 원격 작업용 계정 폴더를 열 수 없어요. 폴더 권한을 확인해 주세요.";
    case "not_running":
      return "이 맥이 작업 호스트로 켜져 있지 않아 계정을 고를 수 없어요. 켠 뒤에 다시 골라 주세요.";
    case "unknown_op":
      return "이 맥의 작업 호스트가 오래돼 계정을 고를 수 없어요. 앱을 업데이트한 뒤 다시 골라 주세요.";
    case "unsupported_platform":
      return "이 기기에서는 원격 작업 계정을 고를 수 없어요.";
    default:
      return "이 맥의 작업 호스트와 통신하지 못해 계정을 바꾸지 못했어요. 앱을 다시 연 뒤 골라 주세요.";
  }
}

/** 셸이 reject한 값(문자열 코드)을 닫힌 코드로. 형식이 다르면 `unknown`. */
export function remoteProfileCodeOf(error: unknown): string {
  const raw = typeof error === "string" ? error : "";
  return /^[a-z_]{1,64}$/.test(raw) ? raw : "unknown";
}

export function remoteWorkOutcomeText(outcome: RemoteWorkOutcome): { tone: "muted" | "warn"; text: string } | null {
  switch (outcome.kind) {
    case "applied":
    case "cleared":
      return outcome.reset ? { tone: "warn", text: REMOTE_WORK_RESET_NOTICE } : null;
    case "login_abandoned":
      return { tone: "muted", text: REMOTE_WORK_LOGIN_ABANDONED };
    case "refused":
      return { tone: "warn", text: remoteProfileRefusalSentence(outcome.code) };
  }
}
