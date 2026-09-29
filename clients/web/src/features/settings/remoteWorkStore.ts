import { useSyncExternalStore } from "react";
import type { LocalHarnessId } from "@momo/core/features/hostedAgents/detect";
import { withChoice, type AiCredentialRef, type AiDefaultsPrefs } from "@momo/core/features/settings/aiDefaults";
import {
  chooseRemoteWork,
  REMOTE_WORK_APPLYING,
  remoteWorkOutcomeText,
  syncRemoteWork,
  type RemoteWorkChoice,
  type RemoteWorkDeps,
  type RemoteWorkOutcome,
} from "@momo/core/features/settings/remoteWorkProfile";
import { desktopRemoteProfile, harnessProfileRemoteStatus } from "@/lib/tauri";
import { readAiDefaults, writeAiDefaults } from "./aiDefaultsStore";
import { readDesignParam } from "./aiMyAccountsModel";

// =============================================================================
// 기본 AI 표 「원격 작업 기본 계정」 행 → 이 맥의 workd (#3157).
//
// 행을 고르면 셸이 코드서명 소켓으로 workd에게 넘긴다(`set_remote_profile`). 이 기기의
// 저장(localStorage)은 **workd가 받은 뒤에만** 바꾼다: 거부되거나 로그인을 마치지 않으면
// 표는 이전 선택 그대로이고, 이유가 문장으로 보인다(조용한 기본 계정 폴백 없음).
// 판정 순서는 코어 `chooseRemoteWork`다. 이 파일은 셸·저장·로그인 창을 잇는다.
// =============================================================================

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: Listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export interface RemoteWorkView {
  /** 이 맥에 넘기고 있다(고른 칸을 잠근다). */
  readonly applying: boolean;
  /** 마지막 결말이 남긴 한 줄. */
  readonly note: { tone: "muted" | "warn"; text: string } | null;
  /** 원격 작업용 로그인 창이 열려 있는 계정. */
  readonly login: RemoteWorkChoice | null;
}

let view: RemoteWorkView = { applying: false, note: null, login: null };
let loginResolver: ((connected: boolean) => void) | null = null;
/** 이 맥이 마지막으로 받은 선택("harness/label" 또는 "none"). 같은 값을 다시 넘기지 않는다. */
let syncedKey: string | null = null;

function set(patch: Partial<RemoteWorkView>) {
  view = { ...view, ...patch };
  emit();
}

export function useRemoteWork(): RemoteWorkView {
  return useSyncExternalStore(subscribe, () => view, () => view);
}

/** 테스트: 저장 상태를 처음으로. */
export function resetRemoteWorkForTest() {
  view = { applying: false, note: null, login: null };
  loginResolver = null;
  syncedKey = null;
}

const keyOf = (choice: RemoteWorkChoice | null) => (choice ? `${choice.harness}/${choice.label}` : "none");

const realDeps: RemoteWorkDeps = {
  set: (harness: LocalHarnessId, label: string | null) => desktopRemoteProfile.set(harness, label),
  prepare: (harness, label) => desktopRemoteProfile.prepare(harness, label),
  status: (harness, label) => harnessProfileRemoteStatus({ harness, label }),
  signIn: (harness, label) =>
    new Promise<boolean>((resolve) => {
      loginResolver = resolve;
      set({ login: { harness, label } });
    }),
};

/**
 * design 캡처: `?aiRemote=refuse:<라벨>`(이 맥이 그 라벨로 거부) · `reset`(선택 파일 초기화)
 * · `login`(원격 작업 폴더가 로그인 전). 셸 없이 각 결말의 화면을 찍는다. 제품 빌드는 무시한다.
 */
function fixtureDeps(mode: string): RemoteWorkDeps {
  const refuse = mode.startsWith("refuse:") ? mode.slice("refuse:".length) : null;
  return {
    set: async () => (refuse ? { ok: false, code: refuse } : { ok: true, reset: mode === "reset" }),
    prepare: async () => ({ ok: true }),
    status: async (harness) => ({ id: harness, installed: true, auth: mode === "login" ? "needs_login" : "logged_in" }),
    signIn: realDeps.signIn,
  };
}

function currentDeps(): RemoteWorkDeps {
  const mode = readDesignParam("aiRemote");
  return mode ? fixtureDeps(mode) : realDeps;
}

/** 로그인 창이 연결을 알렸다. */
export function remoteLoginConnected() {
  loginResolver?.(true);
  loginResolver = null;
}

/** 로그인 창이 닫혔다. 연결 전이면 마치지 않은 것이다. */
export function remoteLoginClosed() {
  loginResolver?.(false);
  loginResolver = null;
  if (view.login !== null) set({ login: null });
}

function profileChoice(ref: AiCredentialRef | null): RemoteWorkChoice | null {
  return ref && ref.kind === "profile" && ref.label !== null ? { harness: ref.harness, label: ref.label } : null;
}

/**
 * 표의 선택. 이 맥이 받은 뒤에만 이 기기 저장을 바꾼다. `deps`는 시험이 갈아 끼운다.
 */
export async function chooseRemoteWorkAccount(
  ref: AiCredentialRef | null,
  deps: RemoteWorkDeps = currentDeps()
): Promise<RemoteWorkOutcome | null> {
  if (view.applying) return null;
  const choice = profileChoice(ref);
  set({ applying: true, note: null });
  let outcome: RemoteWorkOutcome;
  try {
    outcome = await chooseRemoteWork(choice, deps);
  } finally {
    set({ applying: false, login: null });
  }
  if (outcome.kind === "applied" || outcome.kind === "cleared") {
    syncedKey = keyOf(choice);
    const prefs: AiDefaultsPrefs = readAiDefaults();
    writeAiDefaults(withChoice(prefs, "remoteWork", choice ? { kind: "profile", ...choice } : null));
  }
  set({ note: remoteWorkOutcomeText(outcome) });
  return outcome;
}

/** 소켓 문제(호스트 꺼짐 등)는 표를 열 때마다 알리지 않는다: 선택은 workd 파일에 남아 있다. */
const QUIET_SYNC_CODES = new Set(["not_running", "unsupported_platform", "unknown", "socket_unavailable"]);

/**
 * 저장된 선택이 이 맥에 있는지 맞춘다(표가 열릴 때·선택이 바뀔 때). 로그인 창은 열지
 * 않는다: 폴더가 없거나 안전하지 않으면 그 거부가 행 밑에 문장으로 남는다.
 */
export async function syncRemoteWorkAccount(
  prefs: AiDefaultsPrefs,
  deps: Pick<RemoteWorkDeps, "set"> = currentDeps()
): Promise<void> {
  if (view.applying) return;
  const saved = prefs.remoteWork;
  const choice = saved ? profileChoice(saved) : null;
  const key = keyOf(choice);
  if (key === syncedKey) return;
  const outcome = await syncRemoteWork(choice, deps);
  if (outcome.kind === "refused" && QUIET_SYNC_CODES.has(outcome.code)) return;
  syncedKey = outcome.kind === "refused" ? null : key;
  set({ note: remoteWorkOutcomeText(outcome) });
}

export { REMOTE_WORK_APPLYING };
