// =============================================================================
// Post-claim owner onboarding pending flags (ADR-0185 §8, R3).
//
// Session is already in localStorage at claim success. The key holds three
// independent flags: `workspace-profile` (S1), `invite` (S2) and `team-ai` (the
// skippable team AI stage, #4945). A reload
// during S1 must re-enter S1; after S1 it must re-enter S2 rather than the
// first-run ladder. S2 complete/skip clears ONLY `invite` and opens `team-ai`;
// team AI complete/skip clears `team-ai`. `workspace-profile`
// is cleared by S1 completion (both saves OK) or by both settings doors
// succeeding later. The doc is durable per account+server (durableSlot.ts,
// #3696) so quitting the desktop app mid-S1 still re-offers S1; a JS-heap
// dismiss covers "this load, go to the shell" without dropping S1's re-offer.
// =============================================================================

import {
  isOwnerOnboardingStage,
  type OwnerOnboardingStage,
} from "@/features/auth/onboardingFlow";
import { readDurable, removeDurable, writeDurable } from "./durableSlot";
import { clearS1Draft, clearS1DraftFields } from "./s1Draft";

const listeners = new Set<() => void>();

export const OWNER_ONBOARDING_KEY = "oort.onboarding.v1";

type PendingDoc = {
  "workspace-profile"?: boolean;
  invite?: boolean;
  "team-ai"?: boolean;
  "settings-workspace"?: boolean;
  "settings-profile"?: boolean;
};

let dismissedThisLoad = false;
// 이번 앱 실행에서 claim으로 표지를 찍었는가(#3714). 찍었다면 S1은 첫 질문이고, 아니면
// 이전 실행에서 남았거나 서버 값으로 다시 세운 재질문이다.
let claimedThisLoad = false;

/** 「이대로 쓸게요」를 누른 계정·서버. 영속이고 TTL·로그아웃이 지우지 않는다. */
const DEFAULT_ACCEPTED_SLOT = "oort.onboarding.s1.accepted.v1";

function notify(): void {
  for (const listener of listeners) listener();
}

export function subscribeOwnerOnboarding(onChange: () => void): () => void {
  listeners.add(onChange);
  return () => {
    listeners.delete(onChange);
  };
}

function readDoc(): PendingDoc {
  try {
    const raw = readDurable(OWNER_ONBOARDING_KEY);
    if (!raw) return {};
    if (isOwnerOnboardingStage(raw)) return { [raw]: true };
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return {};
    const record = parsed as Record<string, unknown>;
    const doc: PendingDoc = {};
    if (record["workspace-profile"] === true) doc["workspace-profile"] = true;
    if (record.invite === true) doc.invite = true;
    if (record["team-ai"] === true) doc["team-ai"] = true;
    if (record["settings-workspace"] === true) doc["settings-workspace"] = true;
    if (record["settings-profile"] === true) doc["settings-profile"] = true;
    return doc;
  } catch {
    return {};
  }
}

function writeDoc(doc: PendingDoc): void {
  const next: PendingDoc = {};
  if (doc["workspace-profile"]) next["workspace-profile"] = true;
  if (doc.invite) next.invite = true;
  if (doc["team-ai"]) next["team-ai"] = true;
  if (doc["settings-workspace"]) next["settings-workspace"] = true;
  if (doc["settings-profile"]) next["settings-profile"] = true;
  if (Object.keys(next).length === 0) removeDurable(OWNER_ONBOARDING_KEY);
  else writeDurable(OWNER_ONBOARDING_KEY, JSON.stringify(next));
  notify();
}

export function markOwnerOnboardingPending(): void {
  dismissedThisLoad = false;
  claimedThisLoad = true;
  writeDoc({
    "workspace-profile": true,
    invite: true,
    "team-ai": true,
  });
}

function dropWorkspaceProfile(doc: PendingDoc): void {
  doc["workspace-profile"] = false;
  doc["settings-workspace"] = false;
  doc["settings-profile"] = false;
}

/**
 * `stage` becomes the pending stage; the stages before it are done. S1's flag is
 * dropped on the way (S1 completed) unless the caller says S1 was only skipped:
 * a skipped S1 keeps its flag so a reload offers it again (ADR-0185 §5-1).
 */
export function markOwnerOnboardingStage(
  stage: OwnerOnboardingStage,
  options: { keepWorkspaceProfile?: boolean } = {}
): void {
  const doc = readDoc();
  if (stage === "invite") {
    if (!options.keepWorkspaceProfile) dropWorkspaceProfile(doc);
    doc.invite = true;
  } else if (stage === "team-ai") {
    if (!options.keepWorkspaceProfile) dropWorkspaceProfile(doc);
    doc.invite = false;
    doc["team-ai"] = true;
  } else {
    doc["workspace-profile"] = true;
  }
  writeDoc(doc);
}

export function hasOwnerOnboardingFlag(flag: OwnerOnboardingStage): boolean {
  return readDoc()[flag] === true;
}

export function clearOwnerOnboardingFlag(flag: OwnerOnboardingStage): void {
  const doc = readDoc();
  if (flag === "invite") doc.invite = false;
  else if (flag === "team-ai") doc["team-ai"] = false;
  else {
    dropWorkspaceProfile(doc);
    clearS1Draft();
  }
  writeDoc(doc);
}

export function hasOwnerOnboardingSettingsDoor(
  door: "workspace" | "profile"
): boolean {
  const doc = readDoc();
  return door === "workspace"
    ? doc["settings-workspace"] === true
    : doc["settings-profile"] === true;
}

export function readOwnerOnboardingStage(): OwnerOnboardingStage | null {
  const doc = readDoc();
  if (doc["workspace-profile"]) return "workspace-profile";
  if (doc.invite) return "invite";
  if (doc["team-ai"]) return "team-ai";
  return null;
}

/**
 * 세 표지의 한 줄 요약(예: 「011」). 어느 표지가 바뀌어도 값이 달라져서, 이 값을 구독한 화면이 다시 그려진다.
 * 「첫 표지가 무엇인가」(`readOwnerOnboardingStage`)만 구독하면, S1을 건너뛴 채 이어 가는 동안(S1 표지가 계속
 * 첫 표지다) 뒤 단계의 표지가 바뀌어도 값이 그대로라 화면이 움직이지 않는다.
 */
export function readOwnerOnboardingFlagKey(): string {
  const doc = readDoc();
  return [doc["workspace-profile"], doc.invite, doc["team-ai"]]
    .map((flag) => (flag ? 1 : 0))
    .join("");
}

export function ownerOnboardingIsPending(): boolean {
  return readOwnerOnboardingStage() !== null;
}

export function ownerOnboardingShouldMount(): boolean {
  return !dismissedThisLoad && ownerOnboardingIsPending();
}

export function dismissOwnerOnboardingThisLoad(): void {
  dismissedThisLoad = true;
  notify();
}

/**
 * The end of the claim path: clears the stages after S1 (`invite`, `team-ai`) and dismisses
 * this load. A skipped S1 keeps its own flag. The name is from when S2 was the last stage.
 */
export function finishOwnerOnboardingInvite(): void {
  clearOwnerOnboardingFlag("invite");
  clearOwnerOnboardingFlag("team-ai");
  dismissOwnerOnboardingThisLoad();
}

export function recordOwnerOnboardingSettingsSave(
  door: "workspace" | "profile"
): void {
  if (door === "workspace") clearS1DraftFields(["workspaceName"]);
  else clearS1DraftFields(["displayName", "handle"]);
  const doc = readDoc();
  if (!doc["workspace-profile"]) return;
  if (door === "workspace") doc["settings-workspace"] = true;
  else doc["settings-profile"] = true;
  if (doc["settings-workspace"] && doc["settings-profile"]) {
    dropWorkspaceProfile(doc);
    clearS1Draft();
  }
  writeDoc(doc);
}

export function clearOwnerOnboardingPending(): void {
  dismissedThisLoad = false;
  claimedThisLoad = false;
  removeDurable(OWNER_ONBOARDING_KEY);
  clearS1Draft();
  notify();
}

/** S1이 첫 질문이 아니라 재질문인가: 이전 실행에서 남았거나 서버 이름으로 다시 세웠다. */
export function ownerOnboardingS1IsReoffer(): boolean {
  return !claimedThisLoad && hasOwnerOnboardingFlag("workspace-profile");
}

/** 이전 실행에서 남은 표지인가(이번 실행의 claim이 찍은 것이 아니다). */
export function ownerOnboardingFlagIsFromEarlierLoad(): boolean {
  return !claimedThisLoad && ownerOnboardingIsPending();
}

export function hasAcceptedSeedWorkspace(): boolean {
  return readDurable(DEFAULT_ACCEPTED_SLOT) === "1";
}

/** 「이대로 쓸게요」: 이 계정·서버에서 시드 이름을 다시 묻지 않는다. */
export function acceptSeedWorkspace(): void {
  writeDurable(DEFAULT_ACCEPTED_SLOT, "1", Date.now(), { permanent: true });
}

export function resetOwnerOnboardingLoadState(): void {
  dismissedThisLoad = false;
  claimedThisLoad = false;
  notify();
}
