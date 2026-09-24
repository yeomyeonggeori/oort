import type {UpdateReadStateOptions} from '@momo/core/lib/api';

// =============================================================================
// 읽음 광고의 이유, 폰판 (ADR-0178 D6 · #1964).
//
// 서버는 `PUT read-state` 두 가지를 본문만으로는 구별하지 못한다: 사람이 채널을
// **열어서** 보내는 광고와, 연 채로 메시지가 도착해서 **몰아 보내는** 광고. 둘 다
// 같은 엔드포인트, 같은 본문, 같은 값이다. 그래서 D6 이 판별자 `read_intent` 를
// 두었고, `explicit_open` 이 실린 요청만 같은 tx 에서 「여기부터 안 읽음」 마크를
// 지운다. 없으면 background 이고, 그것이 안전한 쪽이다 — 마크를 못 지우는 것은
// 사람이 되돌릴 수 있지만, 소리 없이 사라진 마크는 이 ADR 이 막으려던 결함이다.
//
// 이 파일이 생기기 전 폰은 판별자를 한 번도 싣지 않았다. 안전하긴 했다(마크를
// 지우지 않는다). 대신 폰에서 채널을 열어 다 읽어도 데스크탑이 건 마크가 남아,
// 그 채널은 어느 기기에서나 계속 안 읽음이었다.
//
// ## 호출 자리는 이유를 말하고, 와이어 모양은 여기서만 정한다
//
// 웹 `clients/web/src/features/chat/advertiseReadState.ts` 와 같은 분류다. 폰에
// 있는 갈래는 셋이다:
//
//   channel_open   대화 화면이 연 방문의 **첫** 광고 → `explicit_open`.
//                  D4/D6 의 「명시 열람」이다.
//   arrival_flush  같은 방문에서 그 뒤에 몰아 보내는 광고 → 생략(background).
//                  이 갈래가 (1)과 구별되지 않던 것이 D6 의 발단이다.
//   inbox_mention  인박스에서 멘션 하나를 읽음으로 → 생략. 멘션 하나를 치운 것은
//                  채널을 연 것이 아니다(웹의 같은 갈래와 같은 판정).
//
// 「background」를 문자열로 보내는 갈래는 없다. 생략이 그 와이어 모양이다
// (`updateReadState` 가 `explicit_open` 이외의 값을 싣지 않는 것도 같은 규율).
//
// 폰에는 아직 「읽음 처리」 메뉴와 「여기부터 안 읽음」이 없다. 생기면 웹의
// `mark_read_menu`(explicit_open)와 `mark_unread`(생략 + 마크) 갈래가 여기에
// 같은 모양으로 더해진다 — 특히 뒤의 것에 explicit_open 을 실으면 마크를 건 바로
// 그 tx 가 마크를 지운다.
// =============================================================================

export type ReadAdvertisementReason =
  | 'channel_open'
  | 'arrival_flush'
  | 'inbox_mention';

/** D6 판별자의 와이어 모양. `channel_open` 만 싣는다. */
export function readIntentWire(
  reason: ReadAdvertisementReason,
): UpdateReadStateOptions['readIntent'] {
  return reason === 'channel_open' ? 'explicit_open' : undefined;
}

/**
 * 대화 화면이 커서를 보낼 때 드는 이유.
 *
 * 방문(채널을 연 한 번)마다 **처음 성공한 광고 하나**가 명시 열람이다. 실패하면
 * 다음 광고가 다시 명시 열람을 들고 간다 — 웹의 `nextAdvertisedChannelId` 와 같은
 * 규율이다. 방문 단위로 세는 이유는 A→B→A 로 돌아온 두 번째 A 도 새로 연 것이기
 * 때문이다(채널 id 하나만 기억하면 그 사이 B 가 광고하지 않았을 때 두 번째 A 를
 * 놓친다).
 *
 * `freshBoundary` 는 **이 방문 동안 받은 읽음 상태 응답으로 경계를 그렸는가**다.
 * 명시 열람은 서버에서 마크를 지우므로, 그 전에 화면이 서버의 지금 마크를
 * 그렸어야 한다(「먼저 그리고 그다음 지운다」).
 *
 * 문턱이 「응답을 한 번이라도 받았다」가 아니라 **「이 방문 동안 받았다」**인 이유는
 * 캐시다. 폰은 30초 신선도(`staleTime`)로 읽음 상태를 캐시하고 포커스로 재조회하지
 * 않는다. 그래서 앱을 되살리거나 켜진 앱에서 푸시로 방을 열면, 손에 든 캐시가
 * 데스크탑이 방금 건 마크보다 오래됐다. 첫 판은 그 캐시를 「봤다」로 쳤고, 마크를
 * 한 번도 그리지 않은 채 지웠다(design-review 2593 R1 H-1).
 *
 * 아직 이 방문의 응답이 없으면(오는 중·실패·콜드 스타트) 이 광고는 background 로
 * 나간다. 커서는 전진하고 마크는 산다. 응답이 와서 경계가 그려진 뒤의 광고가 명시
 * 열람이 된다.
 */
export function visitFlushReason(input: {
  explicitOpenSent: boolean;
  freshBoundary: boolean;
}): Extract<ReadAdvertisementReason, 'channel_open' | 'arrival_flush'> {
  return !input.explicitOpenSent && input.freshBoundary
    ? 'channel_open'
    : 'arrival_flush';
}
