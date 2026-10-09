import {NON_SECRET_KEYS, nonSecretStore} from '../../../storage/kv';

import type {HarnessKey} from './model';

// =============================================================================
// 「내 맥에 보내기」가 이 기기에 기억하는 것 (#3597, ADR-0198 N5·ADR-0174).
//
// 마지막에 쓴 하네스, 마지막에 쓴 프로젝트 폴더, 폴더마다 마지막에 쓴 집 채널 — 전부 id뿐이다.
// 서버는 이 대응을 저장하지 않는다. 글(프롬프트)은 어디에도 쓰지 않는다: 보내기 전에는
// 서버도 본 적 없는 사람의 말이다.
// =============================================================================

export interface AskLast {
  harness: HarnessKey | null;
  projectFolderId: string | null;
  /** 폴더 id → 채널 id */
  channelByFolder: Record<string, string>;
}

const EMPTY: AskLast = {harness: null, projectFolderId: null, channelByFolder: {}};

function readAll(): Record<string, unknown> {
  try {
    const raw = nonSecretStore().getString(NON_SECRET_KEYS.askMacLast);
    if (raw === undefined) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function readAskLast(workspaceId: string): AskLast {
  const mine = readAll()[workspaceId];
  if (typeof mine !== 'object' || mine === null) return EMPTY;
  const {harness, projectFolderId, channelByFolder} = mine as Record<
    string,
    unknown
  >;
  const channels: Record<string, string> = {};
  if (typeof channelByFolder === 'object' && channelByFolder !== null) {
    for (const [folder, channel] of Object.entries(channelByFolder)) {
      if (typeof channel === 'string') channels[folder] = channel;
    }
  }
  return {
    harness:
      harness === 'claude' || harness === 'codex' || harness === 'opencode'
        ? harness
        : null,
    projectFolderId: typeof projectFolderId === 'string' ? projectFolderId : null,
    channelByFolder: channels,
  };
}

export function writeAskLast(
  workspaceId: string,
  patch: {
    harness?: HarnessKey;
    projectFolderId?: string;
    channel?: {folderId: string; channelId: string};
  },
): void {
  try {
    const current = readAskLast(workspaceId);
    const next: AskLast = {
      harness: patch.harness ?? current.harness,
      projectFolderId: patch.projectFolderId ?? current.projectFolderId,
      channelByFolder:
        patch.channel === undefined
          ? current.channelByFolder
          : {...current.channelByFolder, [patch.channel.folderId]: patch.channel.channelId},
    };
    nonSecretStore().set(
      NON_SECRET_KEYS.askMacLast,
      JSON.stringify({...readAll(), [workspaceId]: next}),
    );
  } catch {
    /* 편의일 뿐이다 — 못 쓰면 다음에 다시 고른다 */
  }
}
