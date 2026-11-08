import {expressionDiskName} from '@momo/core/features/expressions/diskCache';
import {defaultPhoneDiskBackend, removeOrphansSync} from './fileBackend';
import type {PhoneDiskBackend} from './port';

// =============================================================================
// 시작 청소 (ADR-0218 §14 M2.5 「시작」, M5, #5455 B-2). 앱을 강제로 끝내는 등 로그아웃을 거치지 않은 종료가 남긴 것을 치운다.
//
// 앱 시작 첫 단계(`App.tsx`, **세션을 복원하기 전에** 시작한다):
//   1. 고아: `Paths.cache` 의 `oort-expressions-*`(옛 판의 세션 폴더)와 `oort-expression-transfer-*`(받다 죽은 임시 파일)를 지운다(옛 판이 남긴 것 포함). 동기라 아래 어떤 저장소·
//      provider 보다 먼저 끝난다 — 이번 실행의 세션 폴더는 아직 없다.
//   2. 수명이 지난 항목: 모든 칸의 항목 중 마지막으로 읽거나 쓴 뒤 7일이 지난 것을 지운다.
//   3. 세션 저장소가 자리를 잡은 뒤(`initSessionStore()`: 키체인이 비동기로 답한다): **저장된 자격이 없으면 모든 칸을, 있으면 현재 칸 밖의 칸을** 지운다.
// 복원이 거절되면 `leftSession` 효과가 전부 지운다(`session/useSession.tsx`) — 여기가 아니다. 어떤 실패도 던지지 않는다. 이 파일은 잎이다.
// =============================================================================

/** 현재 로그인한 `(워크스페이스, 멤버)`(없으면 `null`). */
export interface CurrentCompartment {
  workspaceId: string;
  memberId: string;
}

async function trimAll(backend: PhoneDiskBackend): Promise<void> {
  for (const name of await backend.list()) await backend.open(name)?.trim();
}

/** 앱 시작 첫 단계. 첫 화면을 막지 않는다(부르는 쪽이 기다리지 않는다). */
export async function startExpressionDiskBoot(options: {
  /** 세션 저장소가 자리를 잡았다는 약속(`initSessionStore()`). 실패해도 진행한다. */
  ready: Promise<unknown>;
  /** 저장된 자격이 있으면 그 `(워크스페이스, 멤버)`, 없으면 `null`. `ready` 뒤에 읽는다. */
  current: () => CurrentCompartment | null;
  backend?: PhoneDiskBackend;
}): Promise<void> {
  const backend = options.backend ?? defaultPhoneDiskBackend();
  try {
    removeOrphansSync();
  } catch {
    // 고아는 다음 시작이 다시 지운다.
  }
  try {
    await trimAll(backend);
  } catch {
    // 수명 청소는 다음 시작이 다시 한다.
  }
  try {
    await options.ready;
  } catch {
    // 자리를 못 잡았어도 아래가 현재 자격을 본다.
  }
  try {
    const who = options.current();
    const keep = who === null ? null : expressionDiskName(who.workspaceId, who.memberId);
    for (const name of await backend.list()) {
      if (name !== keep) await backend.destroy(name);
    }
  } catch {
    // 못 지운 칸은 다음 시작이 다시 지운다.
  }
}
