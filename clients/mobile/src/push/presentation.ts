import type {Channel, RosterMember} from '@momo/core/lib/api';
import {requireOptionalNativeModule} from 'expo-modules-core';
import {useSyncExternalStore} from 'react';

import {NON_SECRET_KEYS, nonSecretStore} from '../storage/kv';
import {absoluteApiBase} from '../storage/serverBase';

// =============================================================================
// 푸시 알림의 「보이는 모양」 (#4316, ADR-0204 증보 5) — 앱이 확장에게 건네는 것들.
//
// 알림 확장은 푸시에서 id 만 받고(ADR-0204) 서버의 두 읽기 경로(메시지·명부)만 부를 수 있다(ADR-0188 §8.7).
// 그래서 iOS 커뮤니케이션 알림(보낸 사람의 둥근 사진 + 작은 앱 아이콘 + 대화 이름)을 그리는 데 필요한
// 나머지는 앱이 **App Group 으로 건넨다**. JS 에는 그 그룹으로 가는 길이 없어서 네이티브 모듈
// `MomoPushNative`(modules/momo-push-native)의 네 함수가 대신 쓴다 — 이 파일이 그 함수들을 부르는 **유일한**
// 자리다.
//
//   설정 둘      「메시지 미리보기」「보낸 사람 표시」. 이 폰의 선택이고 MMKV 에 산다. 바꿀 때와 셸이 뜰 때
//                네이티브로 한 번 더 쓴다(확장은 MMKV 를 읽지 못한다).
//   사진         앱이 이미 받아 둔 얼굴 파일(`memberAvatarImage`). 멤버·미디어 버전(`?v=`) 키로 한 번만.
//   채널 이름    푸시는 채널 id 만 싣는다. 이름·종류(DM 인가)는 앱이 아는 것을 그대로 건넨다.
//   비우기       로그아웃·계정 전환·「보낸 사람 표시」 끄기: 캐시를 지우고 시스템에 기부한 기록을 지우라고 한다.
//
// 어느 호출도 던지지 않고, 기다리게 하지 않는다. 쓰지 못해도 알림은 간다 — 확장이 찾거나 그릴 수 있는
// 것으로 그려진 조금 못한 알림이지, 없는 알림이 아니다. 네이티브 모듈이 없는 빌드(시험·옛 바이너리)에서는
// 모든 호출이 아무 일도 하지 않는다.
// =============================================================================

const MODULE_NAME = 'MomoPushNative';

interface PresentationNative {
  setPresentationSettings?(previewEnabled: boolean, showSender: boolean): Promise<boolean>;
  exportAvatar?(
    baseUrl: string,
    workspaceId: string,
    memberId: string,
    version: string,
    fileUri: string,
  ): Promise<boolean>;
  exportChannels?(
    baseUrl: string,
    workspaceId: string,
    channels: PresentationChannel[],
  ): Promise<boolean>;
  clearPresentation?(): Promise<boolean>;
}

/** 부를 때마다 읽는다: 시험이 모듈 적재 뒤에 답을 바꿀 수 있다(`native.ts` 와 같은 규율). */
function native(): PresentationNative | null {
  return requireOptionalNativeModule<PresentationNative>(MODULE_NAME);
}

// ---- 설정 둘 ---------------------------------------------------------------------------------------

const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 없으면 켬이다: 한 번도 건드리지 않은 폰은 두 줄 다 켜진 채로 온다. 끈 것만 `'0'` 으로 남는다. */
function readSwitch(key: string): boolean {
  return nonSecretStore().getString(key) !== '0';
}

function writeSwitch(key: string, on: boolean): void {
  const store = nonSecretStore();
  if (on) store.remove(key);
  else store.set(key, '0');
}

/** 「메시지 미리보기」: 끄면 메시지 알림의 본문이 「새 메시지」다(이름·사진은 그대로). */
export function isPushPreviewOn(): boolean {
  return readSwitch(NON_SECRET_KEYS.pushPreview);
}

/** 「보낸 사람 표시」: 끄면 사진·이름·미리보기 없이 「oort / 새 메시지」이고, 시스템에 아무것도 기부하지 않는다. */
export function isPushShowSenderOn(): boolean {
  return readSwitch(NON_SECRET_KEYS.pushShowSender);
}

/** 지금 저장된 두 값을 확장이 읽는 자리에 쓴다. 같은 값을 여러 번 써도 같다. */
export function syncPresentationSettings(): void {
  const module = native();
  if (typeof module?.setPresentationSettings !== 'function') return;
  void Promise.resolve(
    module.setPresentationSettings(isPushPreviewOn(), isPushShowSenderOn()),
  ).catch(() => undefined);
}

export function setPushPreview(on: boolean): void {
  if (isPushPreviewOn() === on) return;
  writeSwitch(NON_SECRET_KEYS.pushPreview, on);
  syncPresentationSettings();
  emit();
}

/**
 * 끄는 순간 이미 건넨 것을 거둔다: 캐시(얼굴·채널 이름)를 지우고 시스템에 기부한 기록을 지우라고 한다.
 * 다시 켜면 건넨 것이 없으니, 이 실행에서 건넨 기록을 잊어 다음 사용·다음 목록 읽기에서 다시 건네게 한다.
 */
export function setPushShowSender(on: boolean): void {
  if (isPushShowSenderOn() === on) return;
  writeSwitch(NON_SECRET_KEYS.pushShowSender, on);
  // 설정을 먼저 쓴다: 확장이 이 순간에 도는 중이어도 기부 뒤의 재확인에서 꺼짐을 읽는다.
  syncPresentationSettings();
  if (on) forgetExports();
  else void clearPresentationState();
  emit();
}

/** 설정 › 알림의 두 줄(문구는 한 곳에: 화면과 시험이 같은 글을 읽는다). */
// 기본이 켬인 기존 스위치(「푸시 알림」「작업 끝남」)처럼 **지금 하는 일**을 먼저 말하고, 끈 뒤의 모양을 잇는다 —
// 이미 꺼 둔 사람이 읽어도 어긋나지 않는다.
export const PUSH_PREVIEW_LABEL = '메시지 미리보기';
export const PUSH_PREVIEW_DETAIL =
  '알림에 메시지 내용을 보여요. 끄면 「새 메시지」라고만 보여요. 이름과 사진은 그대로예요.';
export const PUSH_SHOW_SENDER_LABEL = '보낸 사람 표시';
export const PUSH_SHOW_SENDER_DETAIL =
  '알림에 보낸 사람의 이름과 사진을 보여요. 끄면 미리보기도 없이 「새 메시지」로만 알려요.';

export function usePushPreview(): boolean {
  return useSyncExternalStore(subscribe, isPushPreviewOn, () => true);
}

export function usePushShowSender(): boolean {
  return useSyncExternalStore(subscribe, isPushShowSenderOn, () => true);
}

// ---- 건넨 것의 기억 ------------------------------------------------------------------------------------

/** 이 실행에서 이미 건넨 얼굴(서버·경로). 같은 얼굴이 화면마다 그려질 때마다 네이티브를 부르지 않는다. */
const exportedAvatars = new Set<string>();
/** 워크스페이스별로 마지막에 건넨 채널 목록(직렬화). 같으면 다시 쓰지 않는다. */
const exportedChannels = new Map<string, string>();

function forgetExports(): void {
  exportedAvatars.clear();
  exportedChannels.clear();
}

// ---- 사진 ----------------------------------------------------------------------------------------------

/** `/v1/workspaces/{ws}/members/{member}/avatar/content?v={media}` — 확장이 읽는 모양과 같다. */
const AVATAR_PATH = /^\/v1\/workspaces\/([^/?#]+)\/members\/([^/?#]+)\/avatar\/content\?v=([A-Za-z0-9_-]{1,64})$/;

/**
 * 앱이 받아 둔 얼굴을 확장 몫으로 한 번 건넨다. 「보낸 사람 표시」가 꺼져 있으면 건네지 않는다.
 * 멤버 아바타 content 경로가 아니거나 버전(`?v=`)이 없으면 건네지 않는다(버전이 없으면 바뀐 사진과
 * 구별할 수 없다). 베어러가 필요한 경로가 아니라 **이미 디스크에 있는 파일**(`file://`)만 넘긴다.
 */
export function exportAvatarForPush(path: string, fileUri: string): void {
  if (!isPushShowSenderOn()) return;
  const found = AVATAR_PATH.exec(path);
  if (found === null || !fileUri.startsWith('file://')) return;
  const module = native();
  if (typeof module?.exportAvatar !== 'function') return;
  const baseUrl = absoluteApiBase();
  const memberKey = `${baseUrl}|${found[1].toLowerCase()}|${found[2].toLowerCase()}|${found[3].toLowerCase()}`;
  if (exportedAvatars.has(memberKey)) return;
  exportedAvatars.add(memberKey);
  void Promise.resolve(module.exportAvatar(baseUrl, found[1], found[2], found[3], fileUri)).catch(
    () => undefined,
  );
}

// ---- 채널 이름 ------------------------------------------------------------------------------------------

export interface PresentationChannel {
  id: string;
  kind: 'public' | 'private' | 'dm';
  /** DM 에는 없다. */
  name?: string;
  /** 활성 멤버 수(보낸 사람과 받는 사람 포함). 모르면 없다. */
  memberCount?: number;
}

/** 확장이 받는 한도(네이티브 `channelMaxEntries`)와 같다. */
const MAX_CHANNELS = 512;

/**
 * 채널 목록 + 명부 → 확장이 받는 모양. 보관된 채널은 뺀다(목록에서 사라진 것이라 알림도 오지 않는다).
 * 멤버 수는 명부의 `channelIds` 에서 센다(활성 멤버만, 에이전트 포함) — 푸시 확장의 자격은 채널 목록도 멤버
 * 목록도 읽지 못하므로, 앱이 이미 가진 명부가 유일한 출처다. DM 은 둘이다.
 */
export function presentationChannels(
  channels: readonly Channel[],
  members: readonly RosterMember[],
): PresentationChannel[] {
  const counts = new Map<string, number>();
  for (const member of members) {
    if (member.status !== 'active') continue;
    for (const channelId of member.channelIds ?? []) {
      const key = channelId.toLowerCase();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  const out: PresentationChannel[] = [];
  for (const channel of channels) {
    if (channel.archivedAtMs !== undefined) continue;
    if (out.length >= MAX_CHANNELS) break;
    const id = channel.id.toLowerCase();
    const memberCount = channel.kind === 'dm' ? (channel.memberIds?.length ?? counts.get(id) ?? 2) : counts.get(id);
    out.push({
      id,
      kind: channel.kind,
      ...(channel.kind !== 'dm' && channel.name ? {name: channel.name} : null),
      ...(memberCount !== undefined && memberCount > 0 ? {memberCount} : null),
    });
  }
  return out;
}

/** 채널 목록 전체를 확장 몫으로 건넨다. 지난번과 같으면 다시 쓰지 않는다. */
export function exportChannelsForPush(workspaceId: string, channels: PresentationChannel[]): void {
  if (!isPushShowSenderOn()) return;
  const module = native();
  if (typeof module?.exportChannels !== 'function') return;
  const serialized = JSON.stringify(channels);
  const key = `${absoluteApiBase()}|${workspaceId.toLowerCase()}`;
  if (exportedChannels.get(key) === serialized) return;
  exportedChannels.set(key, serialized);
  void Promise.resolve(module.exportChannels(absoluteApiBase(), workspaceId, channels)).catch(
    () => undefined,
  );
}

// ---- 비우기 --------------------------------------------------------------------------------------------

/**
 * 로그아웃·계정 전환·「보낸 사람 표시」 끄기: 이 폰에 건넨 얼굴과 채널 이름을 지우고, 시스템에 기부한
 * 커뮤니케이션 기록을 지우라고 한다(끝나지 못하면 네이티브가 다음 실행에 다시 시도한다). 설정 둘은
 * 이 폰의 선택이라 남는다. 참이면 시스템이 지웠다고 답한 것이다.
 */
export async function clearPresentationState(): Promise<boolean> {
  forgetExports();
  const module = native();
  if (typeof module?.clearPresentation !== 'function') return false;
  try {
    return (await module.clearPresentation()) === true;
  } catch {
    return false;
  }
}
