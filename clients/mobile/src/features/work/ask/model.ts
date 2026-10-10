import type {Channel, WorkHost, WorkHostFolder} from '@momo/core/lib/api';
import {uuidEq} from '@momo/core/lib/api';

// =============================================================================
// 「내 맥에 보내기」 시트가 묻는 것의 순수 부분 (#3597 T6b, ADR-0198 D4·D7 증보 1·N5·T5 확정).
//
// 판단은 다섯이다. 어느 맥이 켜져 있나, 어느 하네스로, 어느 폴더에서, 어느 채널에 남기나,
// 그리고 보내도 되는 글인가. 다섯 모두 **서버로 나가는 값**이거나 **서명에 들어가는 값**이라
// 화면에서 떼어 둔다.
//
// ## 폴더는 코어 타입이 준다
//
// `WorkHost.folders`·`defaultFolderId`(N5)는 코어 타입이다(#3638: 승격 전 임시 읽기를 걷었다).
// 폰은 폴더 id를 **불투명 값**으로만 다룬다 — 경로가 아니다(ADR-0188 D6).
// =============================================================================

export type HarnessKey = 'claude' | 'codex' | 'opencode';

export const HARNESS_LABEL: Readonly<Record<HarnessKey, string>> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export type AskMode = 'ask' | 'work';

export const MODE_LABEL: Readonly<Record<AskMode, string>> = {
  ask: '물어보기',
  work: '작업 요청',
};

export type MacFolder = WorkHostFolder;

/** 내 맥 한 대: 서버의 `work-hosts` 읽기에서 내 것만, 폰이 쓰는 모양으로. */
export interface OwnMac {
  id: string;
  displayName: string;
  /** 서버의 한 식(`work_host_online_sql`, T4). 폰은 자기 시계로 판정하지 않는다. */
  online: boolean;
  lastSeenAtMs: number;
  folders: MacFolder[];
  /** 「질문용 폴더」 id. 호스트가 알리지 않았으면 없음 — 프로젝트 폴더로 대신하지 않는다. */
  defaultFolderId: string | null;
  capabilities: Record<string, boolean>;
}

/**
 * 내 맥들: 내가 주인인 `scope=member` 호스트, 해지되지 않은 것만. 서버가 서명 spawn의 대상으로
 * 삼는 것과 같은 조건이다(T5 3: 남의 호스트·팀 호스트는 후보에 오르지 않는다).
 */
export function ownMacs(
  hosts: readonly WorkHost[] | undefined,
  selfId: string,
): OwnMac[] {
  if (hosts === undefined) return [];
  return hosts
    .filter(
      host =>
        host.scope === 'member' &&
        uuidEq(host.ownerMemberId, selfId) &&
        host.revokedAtMs === undefined,
    )
    .map(host => ({
      id: host.id,
      displayName: host.displayName,
      online: host.online,
      lastSeenAtMs: host.lastSeenAtMs ?? 0,
      capabilities: host.capabilities ?? {},
      folders: host.folders ?? [],
      defaultFolderId: host.defaultFolderId ?? null,
    }))
    .sort((a, b) => b.lastSeenAtMs - a.lastSeenAtMs);
}

export type MacState =
  /** 등록된 맥이 없다(폰에서는 연결하지 못한다). */
  | {kind: 'none'}
  /** 등록은 됐지만 지금 켜진 맥이 없다. 대기 요청은 없다(v1). */
  | {kind: 'off'; mac: OwnMac}
  | {kind: 'on'; macs: OwnMac[]};

export function macState(macs: readonly OwnMac[]): MacState {
  if (macs.length === 0) return {kind: 'none'};
  const online = macs.filter(mac => mac.online);
  if (online.length === 0) return {kind: 'off', mac: macs[0] as OwnMac};
  return {kind: 'on', macs: online};
}

/**
 * 고를 수 있는 하네스. Claude Code·Codex는 늘 보이고, OpenCode는 맥이 **감지했다고 알릴 때만**
 * 넣는다(ADR-0198 D4·결재 Q4). 오늘 서버의 `capabilities`는 불리언만이고 설치된 도구를 알리는
 * 키는 아직 없다 — 그래서 OpenCode는 이 판에서 실제로는 나타나지 않는다.
 */
export function harnessChoices(mac: OwnMac): HarnessKey[] {
  const out: HarnessKey[] = ['claude', 'codex'];
  if (mac.capabilities.opencode === true) out.push('opencode');
  return out;
}

/** 마지막에 쓴 하네스가 이 맥에서 고를 수 있으면 그것, 아니면 첫째. */
export function defaultHarness(
  choices: readonly HarnessKey[],
  last: HarnessKey | null,
): HarnessKey {
  if (last !== null && choices.includes(last)) return last;
  return choices[0] as HarnessKey;
}

/** 도착지는 입력 전에 이름으로 보인다(ADR-0198 D4). 과금·구독 이야기는 여기에 없다(#3566 미측정). */
export function destinationLine(mac: OwnMac, harness: HarnessKey): string {
  return `내 맥 · ${mac.displayName} · ${HARNESS_LABEL[harness]}`;
}

// ---- 폴더 -------------------------------------------------------------------

export function questionFolder(mac: OwnMac): MacFolder | null {
  if (mac.defaultFolderId === null) return null;
  return mac.folders.find(folder => folder.id === mac.defaultFolderId) ?? null;
}

export function projectFolders(mac: OwnMac): MacFolder[] {
  return mac.folders.filter(folder => folder.kind === 'project');
}

/**
 * 모드별 폴더.
 * - 물어보기: 서버의 `defaultFolderId`(질문용 폴더). 없으면 **프로젝트 폴더로 조용히 대신하지
 *   않고** 사람이 고르게 한다(N5 규칙 2).
 * - 작업 요청: 서버 기본값이 없다. 이 기기에서 마지막에 쓴 폴더가 이 맥에 있으면 그것.
 */
export function defaultFolderId(
  mode: AskMode,
  mac: OwnMac,
  lastProjectFolderId: string | null,
): string | null {
  if (mode === 'ask') return questionFolder(mac)?.id ?? null;
  if (lastProjectFolderId === null) return null;
  return projectFolders(mac).some(folder => folder.id === lastProjectFolderId)
    ? lastProjectFolderId
    : null;
}

/** 물어보기에서 질문용 폴더가 없을 때 고를 수 있는 폴더(전부). */
export function foldersToPick(mode: AskMode, mac: OwnMac): MacFolder[] {
  if (mode === 'work') return projectFolders(mac);
  return questionFolder(mac) === null ? mac.folders : [];
}

// ---- 집 채널 ----------------------------------------------------------------

/**
 * 후보 채널: 내가 들어 있는 채널 중 DM이 아니고 보관되지 않은 것(N5 「집 채널 규칙」).
 * 나와의 DM은 없고, 다른 사람과의 DM을 임시 집으로 권하지 않는다 — 읽는 쪽이 생기기 때문이다.
 */
export function homeChannels(channels: readonly Channel[]): Channel[] {
  return channels.filter(
    channel => channel.kind !== 'dm' && channel.archivedAtMs === undefined,
  );
}

/** 고르기 전에 보이는 공개 범위 문장. 요청과 답이 그 채널 멤버에게 읽힌다(D7·결재 3). */
export function channelReach(channel: Channel): string {
  return channel.kind === 'private'
    ? '비공개 채널 · 이 채널 멤버가 읽어요'
    : '이 채널 멤버가 모두 읽어요';
}

// ---- 보낼 글 -----------------------------------------------------------------

export const PROMPT_MAX_CHARS = 32_768;
export const LABEL_MAX_CHARS = 120;

// eslint-disable-next-line no-control-regex -- 찾는 것이 바로 그 문자다.
const CONTROL_EXCEPT_LF_TAB = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_ANY = /[\u0000-\u001f\u007f-\u009f]/g;

export const EMPTY_PROMPT_SENTENCE = '무엇을 시킬지 적어 주세요.';
export const SLASH_PROMPT_SENTENCE =
  '「/」로 시작하는 글은 보낼 수 없어요. 하고 싶은 일을 문장으로 적어 주세요.';
export const LONG_PROMPT_SENTENCE = '글이 너무 길어요. 줄여서 다시 보내 주세요.';
export const CONTROL_PROMPT_SENTENCE =
  '보이지 않는 제어 문자가 있어 보낼 수 없어요. 글을 지우고 다시 적어 주세요.';

/** 보내기 전에 막는 글. 서버가 어차피 400으로 막는 것과 같은 규칙이다(T5 L-2). */
export function promptIssue(prompt: string): string | null {
  const text = prompt.normalize('NFC').trim();
  if (text === '') return EMPTY_PROMPT_SENTENCE;
  if (text.startsWith('/')) return SLASH_PROMPT_SENTENCE;
  if (Array.from(text).length > PROMPT_MAX_CHARS) return LONG_PROMPT_SENTENCE;
  if (CONTROL_EXCEPT_LF_TAB.test(text)) return CONTROL_PROMPT_SENTENCE;
  return null;
}

/** 카드 제목: 첫 줄, 공백 정리, 120자 안. 서명이 묶는 한 줄이라 줄바꿈·제어 문자를 남기지 않는다. */
export function labelFromPrompt(prompt: string): string {
  const first =
    prompt
      .normalize('NFC')
      .split('\n')
      .map(line => line.replace(CONTROL_ANY, ' ').replace(/\s+/g, ' ').trim())
      .find(line => line !== '') ?? '';
  const chars = Array.from(first);
  return chars.length <= LABEL_MAX_CHARS
    ? first
    : `${chars.slice(0, LABEL_MAX_CHARS - 1).join('').trimEnd()}…`;
}

// ---- 보낸 뒤: 세션이 생기기를 기다린다 ----------------------------------------------

export interface SessionLike {
  id: string;
  memberId: string;
  hostId: string;
  channelId: string;
  label: string;
}

/**
 * 방금 보낸 요청이 만든 세션. 서버는 컨트롤 id로 세션을 가리키지 않는다(세션은 맥이 요청을 받은
 * 뒤에야 생긴다). 그래서 **보내기 전에 있던 세션을 뺀** 나머지 중에서, 내 것이고 같은 맥·같은
 * 채널·같은 제목인 것을 찾는다. 하나로 정해지지 않으면 찾지 못한 것으로 둔다(엉뚱한 세션을
 * 열어 주느니 작업 목록으로 간다).
 */
export function findSpawnedSession(
  sessions: readonly SessionLike[],
  before: ReadonlySet<string>,
  want: {selfId: string; hostId: string; channelId: string; label: string},
): string | null {
  const hits = sessions.filter(
    session =>
      !before.has(session.id) &&
      uuidEq(session.memberId, want.selfId) &&
      uuidEq(session.hostId, want.hostId) &&
      uuidEq(session.channelId, want.channelId) &&
      session.label === want.label,
  );
  return hits.length === 1 ? (hits[0] as SessionLike).id : null;
}

// ---- 문장 --------------------------------------------------------------------

export const MAC_OFF_HEADLINE = '내 맥이 꺼져 있어요';
export const MAC_OFF_DETAIL =
  '맥이 꺼져 있으면 기다렸다가 보내지 않아요. 맥을 켠 뒤에 다시 보내 주세요.';
export const MAC_NONE_DETAIL =
  '연결된 맥이 아직 없어요. 데스크탑 앱에서 내 맥을 연결하면 여기서 쓸 수 있어요.';
export const AGENT_SUGGEST_SENTENCE =
  '지금 꼭 필요하면 에이전트에게 맡길 수 있어요. 내 맥이 아닌 곳에서 일하니, 맡길지는 직접 골라 주세요.';
export const AGENT_SUGGEST_LABEL = '에이전트에게 맡기기';

export const FLAG_OFF_HEADLINE = '이 서버에서는 아직 쓸 수 없어요';
export const FLAG_OFF_DETAIL =
  '이 서버는 아직 내 맥으로 보내는 요청을 받지 않아요. 서버 관리자가 서명 확인을 켜면 보낼 수 있어요.';
export const KEY_NOT_READY_HEADLINE = '이 폰의 서명 키가 필요해요';
export const KEY_NOT_READY_DETAIL =
  '내 맥으로 보내려면 Face ID 서명 키가 준비돼 있어야 해요. 프로필 › 지시 기기에서 등록해 주세요.';
export const NEED_FOLDER_HINT = '폴더를 골라야 보낼 수 있어요.';
export const NEED_CHANNEL_HINT = '어느 채널에 남길지 골라야 보낼 수 있어요.';
export const UNKNOWN_FAILURE_SENTENCE =
  '보내지 못했어요. 아무것도 보내지 않았으니 잠시 뒤에 다시 보내 주세요.';
export const WAITING_NOTE = '받으면 작업 목록에서도 볼 수 있어요.';
export const NOT_WIRED_SENTENCE =
  '이 앱 버전에서는 아직 내 맥으로 보낼 수 없어요. 앱을 업데이트한 뒤에 다시 시도해 주세요.';
export const FACE_ID_NOTE = '보낼 때 Face ID로 한 번 확인해요.';
export const MAC_WENT_OFF_SENTENCE =
  '보내는 사이에 내 맥이 꺼졌어요. 아무것도 보내지 않았어요.';

// ---- 서명 전에 알 수 있는 막힘 ----------------------------------------------------

export type SigningBlock = 'flag_off' | 'key' | null;

/**
 * Face ID를 띄우기 **전에** 알 수 있는 이유로 막는다. 서버가 서명 요구를 꺼 두면 새 작업 경로는
 * 403 `signed_spawn_disabled`로 닫혀 있다(T5 3) — 사람에게 Face ID를 시키고 그 403을 보여 주는 것은
 * 정직한 안내가 아니다. 서버를 못 읽었으면(`null`) 모른다: 막지 않고 보내 본다.
 *
 * `keyKind`는 `useDeviceKey().view.kind`. 승인된 키만 서명할 수 있고, 읽는 중에는 막지 않는다.
 */
export function signingBlock(
  flagRequired: boolean | null,
  keyKind: string,
): SigningBlock {
  if (flagRequired === false) return 'flag_off';
  if (keyKind === 'approved' || keyKind === 'loading') return null;
  return 'key';
}
