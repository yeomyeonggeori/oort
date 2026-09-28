import { useSyncExternalStore } from "react";
import {
  AI_DEFAULTS_LOCAL_SLOT,
  parseAiDefaults,
  serializeAiDefaults,
  type AiDefaultsAccount,
  type AiDefaultsPrefs,
} from "@momo/core/features/settings/aiDefaults";
import { readDesignParam } from "./aiMyAccountsModel";

// =============================================================================
// 기본 AI 표의 두 값 (#2881).
//
// - 개인 행 선택: **이 기기에만** 저장한다(localStorage, 코어 `serializeAiDefaults`의
//   닫힌 형식). 서버에 올리지 않는다(brief §4.5-4). 저장할 수 없는 창이면 이번
//   화면에서만 유지된다.
// - 이 맥의 계정 목록: 「내 계정」 절(`AiMyAccountsSection`)이 이미 감지·조회한 줄을
//   여기에 알린다. 표가 같은 CLI 감지를 한 번 더 돌리지 않게 하는 한 곳이다.
//
// 해제 창(#2878)도 같은 선택을 읽어 「이 계정을 쓰던 칸」을 이름으로 보인다.
// =============================================================================

type Listener = () => void;
const listeners = new Set<Listener>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** design 캡처: `?aiDefaults=demo`면 저장 대신 이 선택으로 그린다(쓰지 않는다). */
function designPrefs(): AiDefaultsPrefs | null {
  const pose = readDesignParam("aiDefaults");
  if (pose === "demo") {
    return {
      appCommand: { kind: "teamKey" },
      localTerminal: { kind: "profile", harness: "claude", label: "개인" },
      remoteWork: { kind: "profile", harness: "claude", label: "회사" },
    };
  }
  return null;
}

function readStored(): string | null {
  try {
    return window.localStorage.getItem(AI_DEFAULTS_LOCAL_SLOT);
  } catch {
    return null;
  }
}

let memory: AiDefaultsPrefs | null = null;
let cachedRaw: string | null | undefined;
let cachedPrefs: AiDefaultsPrefs = {};

function snapshotPrefs(): AiDefaultsPrefs {
  if (memory) return memory;
  const design = designPrefs();
  if (design) {
    memory = design;
    return memory;
  }
  const raw = readStored();
  if (raw !== cachedRaw) {
    cachedRaw = raw;
    cachedPrefs = parseAiDefaults(raw);
  }
  return cachedPrefs;
}

export function readAiDefaults(): AiDefaultsPrefs {
  return snapshotPrefs();
}

export function writeAiDefaults(prefs: AiDefaultsPrefs): void {
  try {
    window.localStorage.setItem(AI_DEFAULTS_LOCAL_SLOT, serializeAiDefaults(prefs));
    memory = null;
  } catch {
    // 저장할 수 없는 창(사생활 보호 모드 등): 이번 화면에서만 유지한다.
    memory = prefs;
  }
  emit();
}

export function useAiDefaults(): AiDefaultsPrefs {
  return useSyncExternalStore(subscribe, snapshotPrefs, snapshotPrefs);
}

// ---- 이 맥의 계정(내 계정 절이 알린다) ------------------------------------------------

let accounts: readonly AiDefaultsAccount[] | null = null;
let accountsKey = "";

/** 내 계정 절이 줄을 그릴 때마다 부른다. 같은 목록이면 알리지 않는다. */
export function publishMyAccounts(next: readonly AiDefaultsAccount[] | null): void {
  const key = next === null ? "" : next.map((a) => `${a.harness}/${a.label ?? ""}=${a.auth}`).join("|");
  if (key === accountsKey && (next === null) === (accounts === null)) return;
  accountsKey = key;
  accounts = next;
  emit();
}

function snapshotAccounts(): readonly AiDefaultsAccount[] | null {
  return accounts;
}

/** `null` = 아직 모름(감지 전, 또는 내 계정 절이 줄을 그리지 않는 상태). */
export function useMyAccounts(): readonly AiDefaultsAccount[] | null {
  return useSyncExternalStore(subscribe, snapshotAccounts, snapshotAccounts);
}
