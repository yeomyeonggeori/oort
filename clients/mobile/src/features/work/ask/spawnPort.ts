import {NOT_WIRED_SENTENCE} from './model';

// =============================================================================
// 내 맥으로 보내는 한 번의 동작: 서명(Face ID) → `POST /work-spawns` (#3597 T6b).
//
// ## 이 파일은 계약이고, 진짜 포트는 `phoneSpawnPort.ts`다 (#3638)
//
// 시트는 이 **포트** 하나만 부른다. 기본 포트는 「연결 안 됨」을 정직하게 답하고(시험·캡처·
// 로그인 전), 부팅(`boot/spawnPort.ts`)이 `registerSpawnPort`로 진짜 포트를 꽂는다. 진짜
// 포트는 코어의 v4 바이트 규격·`postWorkSpawn`·`callFailureLine`과 폰 서명자
// (`deviceKey/signer.ts`, Face ID)로 만든다.
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
