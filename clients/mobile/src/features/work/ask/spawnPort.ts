import {NOT_WIRED_SENTENCE} from './model';

// =============================================================================
// 내 맥으로 보내는 한 번의 동작: 서명(Face ID) → `POST /work-spawns` (#3597 T6b).
//
// ## 이 파일이 얇은 문인 이유 — engine 승격 후 연결
//
// 그 동작의 재료는 전부 track/engine에만 있다.
//   - `momo.human.control.v4` 바이트 규격 — core `humanControlV4.ts`(#3592 P1)
//   - `postWorkSpawn` / `WorkSpawnBody` — core `lib/api.ts`(#3570 T5)
//   - 거절 코드 → 문장 — core `personalAgentCall.ts`의 `callFailureLine`
//   - 폰 쪽: v4를 서명하는 `deviceKey/humanControl.ts` 사례와 네이티브 허용 목록
//     (`MomoDeviceKeyStore.checkSigningPayload`는 지금 v2/v3 13줄만 서명한다)
// 이 트리에 없는 코드를 복사하면 승격 때 같은 코드가 두 곳에 생겨 충돌한다. 그래서 시트는
// 이 **포트** 하나만 부르고, 지금의 기본 포트는 「연결 안 됨」을 정직하게 답한다.
// 승격 뒤에는 `registerSpawnPort`로 진짜 포트를 꽂는 한 곳(부팅)만 바뀐다. 시트·모델·시험은
// 그대로다.
//
// 포트가 지키는 약속(시트가 의존한다):
//   - 서명은 Face ID 한 번. 취소하면 `cancelled`, 아무것도 보내지 않는다.
//   - 맥이 꺼졌으면 `mac_off`(서버 409 `work_host_offline`). 대기·재라우팅 없음.
//   - 서버가 서명 요구를 꺼 두었으면 `flag_off`(403 `signed_spawn_disabled`).
//   - 그 밖의 거절은 `refused`와 사람 말 한 문장.
// =============================================================================

export interface SpawnRequest {
  workspaceId: string;
  /** 보내는 사람(서명의 멤버 줄). 시트는 세션의 멤버를 넘긴다. */
  memberId: string;
  /** 서명의 호스트 줄이자 서버의 좁히기 힌트. */
  hostId: string;
  folderId: string;
  /** 하네스 키(`claude`·`codex`·`opencode`). 서명에 들어간다. */
  tool: string;
  /** 집 채널. 서명에 들어간다. */
  channelId: string;
  label: string;
  prompt: string;
}

export type SpawnOutcome =
  | {kind: 'sent'; controlId: string; replayed: boolean}
  | {kind: 'mac_off'}
  | {kind: 'flag_off'}
  | {kind: 'cancelled'; sentence: string}
  | {kind: 'refused'; sentence: string}
  | {kind: 'not_wired'; sentence: string};

export interface SpawnPort {
  /** 이 빌드에서 진짜로 보낼 수 있는가. 아니면 입구(FAB 메뉴)를 세우지 않는다. */
  readonly wired: boolean;
  spawn(request: SpawnRequest): Promise<SpawnOutcome>;
}

export const UNWIRED_SPAWN_PORT: SpawnPort = {
  wired: false,
  spawn: async () => ({kind: 'not_wired', sentence: NOT_WIRED_SENTENCE}),
};

let current: SpawnPort = UNWIRED_SPAWN_PORT;

export function spawnPort(): SpawnPort {
  return current;
}

/** 승격 뒤 부팅에서 한 번. 시험은 자기 포트를 시트에 직접 넘긴다. */
export function registerSpawnPort(port: SpawnPort): void {
  current = port;
}

/** Test seam. */
export function __resetSpawnPort(): void {
  current = UNWIRED_SPAWN_PORT;
}
