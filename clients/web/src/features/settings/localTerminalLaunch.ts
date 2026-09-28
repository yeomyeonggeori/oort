import type { LocalHarnessId, LocalHarnessProbe } from "@momo/core/features/hostedAgents/detect";
import {
  credentialName,
  localTerminalLaunch,
  type AiCredentialRef,
  type AiDefaultsAccount,
  type AiDefaultsPrefs,
  type LocalTerminalLaunch,
} from "@momo/core/features/settings/aiDefaults";
import { myAccountRows, type HarnessProfileRef } from "@momo/core/features/settings/harnessProfiles";
import { harnessProfileList, harnessProfileStatus } from "@/lib/tauri";
import { readAiDefaults } from "./aiDefaultsStore";
import { readHiddenDefaults } from "./aiMyAccountsModel";

// =============================================================================
// 로컬 터미널 새 세션이 기본 AI 표의 선택을 읽는다 (#3010, ADR-0191 D1).
//
// 표의 계정 목록(`useMyAccounts`)은 설정 화면이 열려 있을 때만 있다. 새 세션은 그와
// 상관없이 열리므로, 여기서 같은 재료(감지·프로필 목록·뺀 기본 로그인)로 **같은 줄**
// (`myAccountRows`)을 다시 만들고, 판정은 코어 `localTerminalLaunch`가 한다. 그래서
// 도크가 보이는 폴백 문장은 표의 문장과 한 글자까지 같다(교차 시험).
//
// 상태 명령은 저장된 프로필 하나에만 돌린다. 다른 줄의 로그인 상태는 판정에 쓰지 않는다.
// =============================================================================

export interface LocalTerminalLaunchDeps {
  prefs: () => AiDefaultsPrefs;
  profiles: () => Promise<HarnessProfileRef[]>;
  hiddenDefaults: () => LocalHarnessId[];
  profileStatus: (profile: HarnessProfileRef) => Promise<LocalHarnessProbe>;
}

const DESKTOP_DEPS: LocalTerminalLaunchDeps = {
  prefs: readAiDefaults,
  profiles: harnessProfileList,
  hiddenDefaults: readHiddenDefaults,
  profileStatus: harnessProfileStatus,
};

/**
 * 새 세션 메뉴에서 `harness`를 골랐을 때 띄울 것. `probes`는 도크가 이미 감지한
 * 이 맥의 CLI(기본 로그인의 상태)다.
 */
export async function resolveLocalTerminalLaunch(
  harness: LocalHarnessId,
  probes: readonly LocalHarnessProbe[],
  deps: LocalTerminalLaunchDeps = DESKTOP_DEPS
): Promise<LocalTerminalLaunch> {
  const prefs = deps.prefs();
  const saved = prefs.localTerminal;
  if (!saved || saved.kind !== "profile" || saved.harness !== harness) {
    return localTerminalLaunch(harness, prefs, { accounts: [], teamKey: { status: "loading" } });
  }
  const profiles = await deps.profiles();
  const rows = myAccountRows({ probes, profiles, hiddenDefaults: deps.hiddenDefaults() });
  const accounts: AiDefaultsAccount[] = [];
  for (const row of rows) {
    const mine = row.harness === saved.harness && row.profile === saved.label;
    let auth: AiDefaultsAccount["auth"] = "unknown";
    if (mine && row.profile === null) {
      auth = probes.find((probe) => probe.id === row.harness)?.auth ?? "unknown";
    } else if (mine && row.profile !== null) {
      auth = (await deps.profileStatus({ harness: row.harness, label: row.profile })).auth;
    }
    accounts.push({ harness: row.harness, label: row.profile, auth });
  }
  return localTerminalLaunch(harness, prefs, { accounts, teamKey: { status: "loading" } });
}

/** 저장된 계정을 확인하는 동안 도크가 보이는 한 줄. */
export function checkingAccountLine(ref: AiCredentialRef): string {
  return `「${credentialName(ref, { status: "loading" })}」 계정을 확인하고 있어요.`;
}
