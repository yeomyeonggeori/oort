import {NON_SECRET_KEYS, nonSecretStore} from '../../storage/kv';

// =============================================================================
// 아직 보내지 않은 글은 사라지지 않는다 (감사 H-10)
//
// 감사가 폰에 대해 적은 문장: *"첨부 없음, 초안 보존 없음(`Composer.tsx:94`
// 인메모리). 초안 유실이 특히 아픈데, 뒤로가기가 화면을 unmount 한다
// (`shell/AppShell.tsx:186`)."* 즉 이 결함은 폰에서 **더 크다** — 웹에서는 탭을
// 옮겨야 잃는 것을 여기서는 왼쪽 가장자리를 한 번 쓸면 잃는다.
//
// ## 어디에 두는가 — 그리고 왜 MMKV 인가
//
// `storage/kv.ts`(MMKV). 이유는 그 파일이 존재하는 이유와 같다: **동기로
// 읽힌다.** 컴포저의 첫 렌더가 초안을 이미 들고 있어야 하고(한 프레임 뒤에
// 채워 넣는 것은 「글이 잠깐 사라졌다 돌아오는」 화면이다), 비동기 저장소로는
// 그 성질을 살 수 없다. 토큰이 아닌 값만 들어가는 자리라는 것도 kv.ts 가 이미
// 못박아 두었다.
//
// ## 언제 쓰는가 — **키를 누를 때마다**
//
// 「나갈 때 저장」이 싸 보이지만 폰에서 틀린다. 이 앱이 화면을 잃는 길은 뒤로
// 가기 하나가 아니다: 홈으로 나가면 iOS 가 언제든 프로세스를 죽일 수 있고, 그
// 경우 나갈 때 돌 코드는 없다. 키스트로크마다 쓰면 **잃는 경로 자체가 없어진다**
// — 나가는 길을 하나씩 막는 대신.
//
// 컴포저의 규율(`Composer.tsx` 머리말: 값은 SYNCHRONOUS)과 충돌하지 않는다.
// 저장은 「값이 쓰인 **뒤에**, 별개의 레일에서」 일어나고, 이것은 「작성 중」
// 신호가 이미 지키고 있는 그 계약이다. 값에 대해 아무것도 결정하지 않고,
// 기다려지지도 않는다.
//
// **값은 얼마인가 (실측).** 한 글자마다 지도 전체를 파싱하고 다시 쓴다. 상한
// (`DRAFT_LIMIT` 20개 × 400자)까지 채운 지도는 25KB 이고, 그 `JSON.parse` +
// 수정 + `JSON.stringify` 가 **15.2µs** 다(node, 2000회 평균). MMKV 의 `set` 은
// mmap 쓰기라 같은 자릿수다. 같은 키스트로크가 이미 하고 있는 일 — 60명 명부
// 재필터 + 3회 `setState` — 보다 싸고, 그쪽은 실기기에서 조합을 안 깨는 것이
// 측정돼 있다. 캐시를 두지 않는 이유가 그것이다: 캐시는 「누가 또 이 키를
// 쓰는가」라는 질문을 만드는데, 그 질문의 값이 15µs 보다 크다.
//
// ## 수명 — 보낼 때까지. 다만 영원은 아니다
//
// 초안은 **보내면 지워진다.** 그 외에는 남는다 — 「3일 지났으니 지웠습니다」는
// 사람이 부탁한 적 없는 청소다. 그러나 MMKV 에는 만료가 없고 채널 수에는 상한이
// 없으므로, 지도가 무한히 자라는 것도 정직하지 않다. 두 가지로 막는다:
//
//   `DRAFT_TTL_MS`    마지막으로 손댄 지 30일. 한 달 전에 쓰다 만 한 줄을
//                     복원하는 것은 보존이 아니라 놀람이다.
//   `DRAFT_LIMIT`     최근 20개. 넘으면 **가장 오래된 것부터** 버린다.
//
// 두 값 다 「사람이 실제로 돌아올 대화」보다 넉넉하고, 「이 지도가 커져서 문제가
// 되는」 크기보다는 훨씬 작다. 청소는 **쓸 때** 일어난다 — 앱 시작에 훑는 패스를
// 따로 두면 아무도 초안을 쓰지 않는 실행에서도 디스크를 건드린다.
//
// ## 왜 키 하나에 지도인가 (채널마다 키가 아니라)
//
// `NON_SECRET_KEYS` 는 **허용 목록**이다(kv.ts 머리말: 거부 목록은 예상 못 한
// 이름에 지는 모양이다). 채널마다 키를 만들면 그 목록이 접두사 규칙으로 바뀌고,
// 규칙은 목록이 아니다. 그리고 위의 청소 규칙은 「전부를 한 번에 볼 수 있을 것」을
// 요구하는데, 이 앱이 쓰는 저장소 이음매(`NonSecretStore`)에는 키를 열거하는
// 길이 없다 — 지도 하나면 그 질문이 애초에 생기지 않는다.
// =============================================================================

/** 마지막으로 손댄 지 이만큼 지난 초안은 복원하지 않는다. */
export const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** 동시에 들고 있는 초안 수의 상한. 넘으면 오래된 것부터 버린다. */
export const DRAFT_LIMIT = 20;

/** 한 자리의 초안. */
export interface Draft {
  body: string;
  /** 마지막으로 글자가 바뀐 시각. 청소는 이 값만 본다. */
  savedAtMs: number;
}

export type DraftMap = Readonly<Record<string, Draft>>;

/**
 * 초안이 붙는 자리의 이름.
 *
 * 채널과 스레드를 **다른 이름 공간**에 둔다: 스레드 루트의 id 는 메시지 id 이고
 * 채널 id 와 같은 값일 수 없지만, 그것은 서버 계약의 성질이지 이 파일이 기댈
 * 사실이 아니다. 접두사를 붙이는 값은 0 이고, 안 붙였을 때의 비용은 채널 초안이
 * 스레드 답글로 되살아나는 것이다.
 */
export function channelDraftKey(channelId: string): string {
  return `channel:${channelId}`;
}

export function threadDraftKey(rootId: string): string {
  return `thread:${rootId}`;
}

/**
 * 지도에서 살아남을 것만 고른다. 순수 함수 — 입력을 바꾸지 않는다.
 *
 * 빈 글은 초안이 아니다: 사람이 쓰던 것을 다 지웠으면 그것은 「빈 초안을
 * 저장해 달라」가 아니라 「이제 없다」이다.
 */
export function pruneDrafts(map: DraftMap, nowMs: number): DraftMap {
  const alive = Object.entries(map).filter(
    ([, draft]) =>
      draft.body !== '' && nowMs - draft.savedAtMs < DRAFT_TTL_MS,
  );
  // 최근 것부터. `DRAFT_LIMIT` 을 넘는 꼬리를 버린다.
  alive.sort((a, b) => b[1].savedAtMs - a[1].savedAtMs);
  return Object.fromEntries(alive.slice(0, DRAFT_LIMIT));
}

/**
 * 저장된 지도. 깨진 JSON 은 **빈 지도로 읽는다** — 초안 하나 때문에 앱이 죽는
 * 것은 초안을 잃는 것보다 나쁘다.
 */
export function readDrafts(): DraftMap {
  const raw = nonSecretStore().getString(NON_SECRET_KEYS.composerDrafts);
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object') return {};
    const out: Record<string, Draft> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      // 모양을 확인하고 담는다. 옛 판이나 손으로 고쳐진 값이 `body.length` 에서
      // 터지게 두지 않는다.
      if (value === null || typeof value !== 'object') continue;
      const {body, savedAtMs} = value as {body?: unknown; savedAtMs?: unknown};
      if (typeof body !== 'string' || typeof savedAtMs !== 'number') continue;
      out[key] = {body, savedAtMs};
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 한 자리의 초안 글. 없거나 수명이 지났으면 빈 문자열.
 *
 * 수명 판정을 **읽을 때도** 하는 이유: 청소는 쓸 때 일어나므로, 오래 안 쓴 기기의
 * 지도에는 만료된 항목이 남아 있을 수 있다. 남아 있는 것과 복원되는 것은 다르다.
 */
export function readDraft(key: string, nowMs: number = Date.now()): string {
  const draft = readDrafts()[key];
  if (draft === undefined) return '';
  if (nowMs - draft.savedAtMs >= DRAFT_TTL_MS) return '';
  return draft.body;
}

/** 지도를 통째로 쓴다. 비었으면 키 자체를 지운다. */
function writeDrafts(map: DraftMap): void {
  const store = nonSecretStore();
  if (Object.keys(map).length === 0) {
    store.remove(NON_SECRET_KEYS.composerDrafts);
    return;
  }
  store.set(NON_SECRET_KEYS.composerDrafts, JSON.stringify(map));
}

/**
 * 이 자리의 초안을 적어 둔다. 빈 글이면 지우는 것과 같다.
 *
 * 키스트로크마다 불린다 (머리말). 값에 대해 아무것도 결정하지 않고, 던지지
 * 않는다 — 저장이 실패했다고 사람이 치던 글자가 사라지면 안 된다.
 */
export function saveDraft(
  key: string,
  body: string,
  nowMs: number = Date.now(),
): void {
  try {
    const next = pruneDrafts(
      {...readDrafts(), [key]: {body, savedAtMs: nowMs}},
      nowMs,
    );
    writeDrafts(next);
  } catch {
    // 저장소가 답하지 않는다. 화면에는 여전히 사람이 친 글이 있고, 이 함수가
    // 할 수 있는 최선은 그 글을 방해하지 않는 것이다.
  }
}

/** 보냈다. 이 자리의 초안은 이제 없다. */
export function clearDraft(key: string, nowMs: number = Date.now()): void {
  try {
    const map = {...readDrafts()};
    if (!(key in map)) return;
    delete map[key];
    writeDrafts(pruneDrafts(map, nowMs));
  } catch {
    // 위와 같다.
  }
}

/**
 * 로그아웃했다. 이 기기에 남은 초안은 **전부** 없다 (U4-6 리뷰 H-2).
 *
 * ## 왜 이것이 수명 규칙의 예외가 아닌가
 *
 * 이 파일의 머리말은 「초안은 보낼 때까지 남는다, 청소는 부탁받은 적 없다」고
 * 적는다. 로그아웃은 그 규칙의 예외가 아니라 **부탁받은 청소**다: 로그아웃은
 * 「이 기기에서 내 흔적을 지운다」는 요청이고, 쓰다 만 글은 그 흔적 중에서도
 * 가장 사적인 축이다 — 보낸 메시지는 지워도 원장에 남지만, 안 보낸 글은 어디에도
 * 없고 그래서 **이 기기에만** 있다. 다음 사람이 로그인해서 그 사람의 대화를 열면
 * 앞사람이 쓰다 만 문장이 입력창에 복원된다.
 *
 * 웹이 같은 판단을 먼저 랜딩했다(`clients/web/src/app/session.tsx` — 세션 기록과
 * 같은 저장소에 사는 이상 같은 순간에 사라져야 한다). 폰은 저장소가 더 나쁘다:
 * MMKV 는 앱이 지워질 때까지 살고, 키체인의 세션과 달리 만료도 없다.
 *
 * 지도를 통째로 지운다. 키를 하나씩 도는 것이 아니라 키 자체를 없애는 이유는
 * `writeDrafts` 가 이미 그렇게 하고, 「비었으면 키를 지운다」가 이 저장소에 대한
 * 이 파일의 계약이기 때문이다.
 */
export function clearAllDrafts(): void {
  try {
    nonSecretStore().remove(NON_SECRET_KEYS.composerDrafts);
  } catch {
    // 저장이 실패해도 사람이 치던 글자를 방해하지 않는 것과 같은 규율이다.
    // 다만 여기서 실패하면 초안이 남는다 — 그것을 조용히 넘기는 대신 무엇이
    // 남는지는 위 주석이 말하고, 저장소가 답하지 않는 상황에서 이 함수가 더
    // 할 수 있는 일은 없다(로그아웃 자체는 이미 진행됐다).
  }
}
