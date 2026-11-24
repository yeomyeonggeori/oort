import {requireOptionalNativeModule} from 'expo-modules-core';

import {NSE_KEYCHAIN_ACCESS_GROUP} from '../storage/keychainGroups';
import {PUSH_ACTION_NATIVE_MODULE} from './contract';

// =============================================================================
// The two values only the native build knows (goal RN-N1).
//
// `modules/momo-push-native` reads them from Info.plist; the long-form reasoning
// for why neither can be a JS constant is in MomoPushNativeModule.swift. In
// short: one is per build CONFIGURATION and the other carries the Apple team
// prefix injected at signing time.
//
// `requireOptionalNativeModule` rather than `requireNativeModule`: the latter
// throws at import time when the native side is absent, which would take down
// every Jest suite that transitively imports this file. Returning null lets the
// callers below answer "this build cannot say", which is the honest answer under
// test and the loud one in a misconfigured build.
// =============================================================================

interface MomoPushNativeConstants {
  /** Raw `MomoAPNSEnvironment` — "development" | "production" | "". */
  readonly apnsEnvironment: string;
  /** Raw `MomoKeychainAccessGroup`, team-prefixed. "" when unresolved. */
  readonly keychainAccessGroup: string;
}

const nativeModule =
  requireOptionalNativeModule<MomoPushNativeConstants>('MomoPushNative');

/** What the devices REST call puts in `env`. Mirrors
 *  `APNSRegistrationEnvironment.from` (MomoiOSKit/PushRegistration.swift:21-31). */
export type ApnsEnvironment = 'sandbox' | 'production';

/**
 * The APNs environment this binary is actually entitled to, or null if the build
 * cannot say.
 *
 * Null is NOT translated into a `__DEV__` guess here, and that is the whole
 * point. The frozen kit fell back to `#if DEBUG` and the 2026-08-02 audit
 * (§7.2 #9) flagged it: a Release build signed with a development profile
 * carries aps-environment=development while the DEBUG flag is false, so the
 * guess registers a sandbox token as production and every push is dropped by
 * APNs with no error anywhere. Callers must treat null as "do not register".
 */
export function apnsEnvironment(): ApnsEnvironment | null {
  switch (nativeModule?.apnsEnvironment?.trim().toLowerCase()) {
    case 'development':
      return 'sandbox';
    case 'production':
      return 'production';
    default:
      return null;
  }
}

/**
 * The team-prefixed keychain access group shared with the notification
 * extension (`YWQQFQM38J.app.momo.ios.shared`), or null if unresolved.
 *
 * Read from the same Info.plist key the extension reads
 * (PushNotification.swift:30-32), so writer and reader cannot disagree about
 * where the item lives.
 */
export function keychainAccessGroup(): string | null {
  const value = nativeModule?.keychainAccessGroup?.trim();
  if (!value) return null;

  // Cross-check against the group name this codebase believes in. The native
  // value carries a team prefix JS cannot know, so only the suffix can be
  // compared — but that is the half that changes when someone edits an
  // entitlements file, and a mismatch here means the app would write to a group
  // the extension does not read. Refusing is the only safe answer: writing to
  // the wrong group looks exactly like success.
  if (!value.endsWith(`.${NSE_KEYCHAIN_ACCESS_GROUP}`)) {
    console.error(
      `[push] keychain access group "${value}" does not end with "${NSE_KEYCHAIN_ACCESS_GROUP}" — entitlements and JS disagree`,
    );
    return null;
  }
  return value;
}

/** True when the native push module is linked at all. Used by diagnostics and
 *  by tests that need to skip device-only paths. */
export function pushNativeModuleAvailable(): boolean {
  return nativeModule != null;
}

interface MomoPushActionConstants {
  /** True only once `MomoPushActionInstaller.install()` has attached the
   *  handler (modules/momo-push-action-native). */
  readonly handlesApprovalActions?: boolean;
}

/**
 * 이 폰에서 잠금 화면의 승인·거절을 네이티브 처리기가 **실제로** 맡고 있는가
 * (#3931, ADR-0204 D6).
 *
 * 참일 때만 `handlePushResponse` 가 그 두 버튼에서 물러난다. 이 모듈이 없는 빌드(시험,
 * 옛 바이너리 위의 새 JS)나 `install()` 이 불리지 않은 시작 경로에서 물러나면, 버튼이
 * 아무 일도 하지 않는다 — 소리 없이. 그래서 「iOS 이면」이 아니라 「처리기가 붙어
 * 있으면」이다. 프로덕션 iOS 빌드에서는 늘 참이라 ADR 의 문장과 같다.
 *
 * 부를 때마다 읽는다(상수라 값싸다): 시험이 모듈 적재 뒤에 답을 바꿀 수 있고, 셋업이
 * 늦게 끝나는 빌드에서도 첫 호출의 답이 영원히 굳지 않는다.
 */
export function nativeApprovalHandlerAttached(): boolean {
  return (
    requireOptionalNativeModule<MomoPushActionConstants>(PUSH_ACTION_NATIVE_MODULE)
      ?.handlesApprovalActions === true
  );
}

interface MomoPushActionReplies {
  /** 처리기가 붙어 있고 이 빌드가 앱 전용 키체인 그룹을 말할 때만 참 (#6036). */
  readonly handlesReplyActions?: boolean;
  /** 이 응답을 처리기가 어떻게 했는가 (#6092): 'kept' · 'notKept' · 이 프로세스에서 받은 적 없으면 null. */
  replyOutcome?(requestIdentifier: string): string | null;
  queuedReplies?(): string[] | null;
  removeQueuedReply?(clientMsgId: string): void;
  markQueuedReplyRefused?(clientMsgId: string): boolean;
  clearQueuedReplies?(): void;
}

/** 잠금 화면 답장의 보관 목록 (#6036, `queuedReplies.ts`). */
export interface QueuedReplyStore {
  /** 남은 항목(JSON 문자열). 키체인이 답하지 않으면 null — 「없음」이 아니라 「모름」이다. */
  list(): string[] | null;
  remove(clientMsgId: string): void;
  /** 서버가 분명히 거절했다 — 다시 보내지 않는다고 적는다(ADR-0204 증보 7 A7-13). 적지 못하면 거짓. */
  markRefused(clientMsgId: string): boolean;
  clear(): void;
}

/** 처리기가 이 답장 응답을 어떻게 했는가 (#6092). */
export type NativeReplyOutcome = 'kept' | 'notKept';

/**
 * 네이티브 처리기가 **이 응답을** 어떻게 했는가 (#6092). `'kept'` 일 때만 `handlePushResponse` 가 답장 갈래에서
 * 물러난다 — 보내기는 보관 목록 한 길이 한다. `'notKept'`(세션 항목이 없었다 · 저장이 실패했다)이면 JS 가 예전처럼
 * 보내고, 처리기가 띄운 「보내지 못했어요」 줄을 걷는다. 처리기가 없는 빌드(시험, 옛 바이너리)는 null 이다.
 *
 * 「지금 남기는가」(키체인을 새로 읽는 물음)도 「목록에 아직 있는가」도 아니다. 앞의 것은 토큰을 새로 놓는 틈(지우고 →
 * 쓰기)에 처리기가 한 일과 다르게 답했고, 뒤의 것은 비우기가 먼저 보내고 지운 뒤에 물으면 「없다」고 답한다. 둘 다 한
 * 답장이 두 번 가는 길이었다(#6036 보안 검수 r1 M1). 처리기는 `didReceive` 가 돌아가기 전에 이 응답의 결과를 메모리에
 * 적고, 여기서는 그것을 식별자로 읽는다.
 */
export function nativeReplyOutcome(requestIdentifier: string): NativeReplyOutcome | null {
  const module = requireOptionalNativeModule<MomoPushActionReplies>(PUSH_ACTION_NATIVE_MODULE);
  if (module?.handlesReplyActions !== true || typeof module.replyOutcome !== 'function') {
    return null;
  }
  try {
    const answer = module.replyOutcome.call(module, requestIdentifier);
    return answer === 'kept' || answer === 'notKept' ? answer : null;
  } catch {
    return null;
  }
}

/** 보관 목록. 이 모듈이 없는 빌드(시험, 옛 바이너리)에서는 null. */
export function nativeQueuedReplyStore(): QueuedReplyStore | null {
  const module = requireOptionalNativeModule<MomoPushActionReplies>(PUSH_ACTION_NATIVE_MODULE);
  if (
    !module ||
    typeof module.queuedReplies !== 'function' ||
    typeof module.removeQueuedReply !== 'function' ||
    typeof module.markQueuedReplyRefused !== 'function' ||
    typeof module.clearQueuedReplies !== 'function'
  ) {
    return null;
  }
  const {queuedReplies, removeQueuedReply, markQueuedReplyRefused, clearQueuedReplies} = module;
  return {
    list: () => queuedReplies.call(module) ?? null,
    remove: id => removeQueuedReply.call(module, id),
    markRefused: id => markQueuedReplyRefused.call(module, id) === true,
    clear: () => clearQueuedReplies.call(module),
  };
}
