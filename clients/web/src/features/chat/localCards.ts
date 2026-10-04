import type { LocalCardArgs, LocalCardId } from "@momo/core/features/commands/registry";

// =============================================================================
// 로컬 카드의 자리 (#2943 GC-2 · 카드 본체는 GC-3 #2944).
//
// 슬래시·⌘K가 연 카드는 메시지가 아니다. 이 기기·이 채널 화면에만 붙는
// 「나에게만 보여요」 카드이고(brief §3.2), 새로고침·채널 이동에 사라진다. 그래서
// 원장은 서버가 아니라 **지금 떠 있는 채널 화면**이다.
//
// 코어의 `CommandContext.openLocalCard`는 「이 카드를 열어 달라」만 말한다.
// 그 부탁을 받을 자리가 여기다: 채널 화면이 마운트될 때 자기 채널 id로 자리를
// 등록하고(`registerLocalCardHost`), 명령을 부른 쪽(팔레트·컴포저)은 채널 id로
// 부탁한다(`openLocalCardIn`). 자리가 없으면 false이고, 명령이 스스로 폴백한다
// (`ai.connect`는 AI로 간다).
//
// **GC-3 전에는 자리를 등록하는 화면이 없다.** 그래서 지금 제품에서 이 부탁은
// 언제나 false이고 ⌘K·`/연결`은 설정으로 간다. 그것이 계약된 폴백이다.
// =============================================================================

/** 카드 자리. 카드를 붙였으면 true를 돌려준다. */
export type LocalCardHost = (card: LocalCardId, args: LocalCardArgs) => boolean;

const hosts = new Map<string, LocalCardHost>();

const key = (channelId: string) => channelId.toLowerCase();

/**
 * 이 채널의 카드 자리를 등록한다. 돌려준 함수로 해제한다(언마운트).
 *
 * 채널당 자리는 하나다. 같은 채널로 다시 등록하면 앞의 것을 대신하고, 해제는
 * **자기가 등록한 자리일 때만** 지운다 — 채널을 옮겨 다니며 마운트·언마운트가
 * 엇갈려도 새 화면의 자리를 옛 화면의 정리가 지우지 않게.
 */
export function registerLocalCardHost(
  channelId: string,
  host: LocalCardHost
): () => void {
  const id = key(channelId);
  hosts.set(id, host);
  return () => {
    if (hosts.get(id) === host) hosts.delete(id);
  };
}

/** 이 채널에 카드 자리가 있는가. 팔레트 줄의 작은 글씨가 이 답을 따른다. */
export function hasLocalCardHost(channelId: string | null): boolean {
  return channelId !== null && hosts.has(key(channelId));
}

/** 이 채널에 카드를 열어 달라고 부탁한다. 자리가 없거나 채널 밖이면 false. */
export function openLocalCardIn(
  channelId: string | null,
  card: LocalCardId,
  args: LocalCardArgs
): boolean {
  if (channelId === null) return false;
  const host = hosts.get(key(channelId));
  return host === undefined ? false : host(card, args);
}
