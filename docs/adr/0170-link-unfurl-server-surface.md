# ADR-0170: 링크 언퍼얼 — 서버 메타데이터 표면과 2층 온오프

- Status: **Accepted** (2026-08-23 성재 승인 — "수동 QA 제외 전부 승인" 위임 집행. 기안 같은 날, #1698)
- 관련: P9(에이전트 본문 미판독 불변식 — 경계 §D2), ADR-0004(자격증명 비유입), OutboundHTTPPolicy(기존 egress 통제 재사용), 단일 쓰기경로 불변식
- 실측 근거: 2026-08-23 기본 기능 검수 — 웹·코어·서버 언퍼얼 코드 0건(링크는 자동 링크화만). UXUI 파도 계획 §2가 서버 원장행으로 기이관.

## Context

성재 직접 수요(2026-08-23): "링크를 보내면 메타데이터 표시 + 온오프." 언퍼얼은 ①서버가 사용자 발신 URL을 따라가는 행위의 **프라이버시 정책** ②SSRF 등 **egress 보안** ③워크스페이스/개인 **통제권**이 한 몸인 서버 신설 표면이라 ADR이 선행한다.

## Decisions (요청)

### D1. 수행 주체·시점 = 서버 비동기, outbox 경유
메시지 랜딩 후 서버 워커가 URL을 fetch(OG/Twitter 카드 파싱)→`message_unfurl` 파생 레코드→outbox 이벤트로 광고. 단일 쓰기경로·`message.seq` 불변(언퍼얼은 파생 첨부, 본문 불변). 캐시=URL 정규화 키, TTL 기본 24h.

### D2. P9 경계 성문화
언퍼얼은 **서버가 링크 대상만 읽는 것**이며 메시지 본문 판독이 아니다 — P9 불변식과 양립함을 문서에 명시. 단, 에이전트/봇 발신 메시지도 동일 취급(발신자 구분 없음).

### D3. egress 가드
OutboundHTTPPolicy 재사용: 사설망·링크로컬·루프백 차단, redirect ≤3(매 홉 재검사), 응답 상한(HTML 512KB·이미지 5MB), 타임아웃, UA 명시. 셀프호스트에서 `MOMO_UNFURL_ENABLED` env로 인스턴스 전체 차단 가능.

### D4. 온오프 2층 + 메시지 단위 제거
- 워크스페이스 설정(관리자): 기본 on/off — off면 fetch 자체를 안 한다(렌더만 끄는 게 아님).
- 개인 설정: 내 화면 렌더 접기.
- 메시지 단위: 발신자가 자기 메시지의 언퍼얼 제거(x) — 제거는 파생 레코드 삭제(재생성 안 함).

### D5. 클라 렌더
카드(제목·설명·도메인·이미지) 4상태(로딩/실패/차단/빈 — 실패·차단은 침묵이 기본, 카드 미표시). 이미지는 서버 프록시 경유(클라가 임의 호스트에 직접 붙지 않음 — CSP 유지).

## 대안 기각

- 클라 직접 fetch: CSP·프라이버시(수신자 IP 노출)·CORS 전면 위배.
- 전용 마이크로서비스: 현 규모 과설계 — webhook-sender 선례처럼 별도 바이너리는 필요해질 때.

## Consequences

- 서버 신규 테이블 1(파생 레코드— schema_v0 불변, 신규 마이그레이션), 워커 루프 1, 설정 표면 2.
- 발사 순번은 성재 지정 대기(서버 원장 후보들과 조율).

## 증보 2026-10-31 — 링크 카드 추출 보강: 사이트 이름·아이콘·그림 크기·동영상·문자 인코딩·카드 3개 (#4881)

- Status: **Accepted** (2026-11-01, planner 위임 결정 — owner 10-31 「링크 미리보기를 Buzz·카카오톡 등을 참고해 다시 설계하고, 이미지나 제목 등이 하나씩 빠졌을 때의 기본값부터 정해 달라」 요청 범위, 독립 보안 검수 2회차 Blocker 0·High 0 뒤. 기안: #4881 엔진 워커). 이 증보는 응답 필드(공개 API), 서버가 가져오는 주소의 폭(보안 경계), 열 추가(DB 계약)를 바꾸므로 ADR-0100에 따라 Accepted가 구현 머지 조건이다.
- 근거: owner 2026-10-31 요청(이슈 #4881에 요약). 링크 미리보기를 Buzz·카카오톡 같은 메신저를 참고해 다시 설계하고, 제목·그림 같은 항목이 하나씩 빠졌을 때의 기본값을 정한다. 화면의 기본값은 #4882·#4883 몫이고, 이 증보는 **서버가 그 화면에 필요한 정보를 더 뽑아 내보내는 부분**만 정한다.
- 관계: D1~D5는 바뀌지 않는다. D3(egress 가드)는 그대로이고 새 가져오기 종류 하나(아이콘)가 같은 가드 위에 **더 좁은 규칙**으로 더해진다. D5의 「실패·차단은 침묵」은 아래 D11이 「정보 없음」까지 넓힌다. 같이 읽는 것: [ADR-0218 D5](0218-workspace-expressions.md)(443 전용 가져오기 선례), ADR-0214(보안 주장은 시험이 있어야 한다).
- 표기: [V] 이 세션에서 직접 확인(track/engine `a0ee63bd7`) · `runtime-unverified` 실행하지 않음.

### 확인한 사실 [V]

- 해석기(`momo-unfurl/src/parse.rs`)는 제목(og → twitter → `<title>`)·설명·그림(og:image·secure_url·twitter:image)만 뽑았고, 상한은 제목 200자·설명 300자였다. 사이트 이름·아이콘·그림 크기·동영상 여부는 뽑지 않았다.
- 워커는 페이지 본문을 늘 UTF-8로 읽었다(`String::from_utf8_lossy`). EUC-KR 같은 다른 인코딩의 페이지는 글자가 깨졌다.
- 메시지당 링크 3개는 `extract_urls`가 이미 지킨다(`MAX_URLS_PER_MESSAGE = 3`, 코드 블록·이메일 제외, 정규화 뒤 중복 제거).
- 가드(`fetch_guarded`)의 443 전용 규칙은 ADR-0218 D5의 `FetchKind::Source`에만 있다. 미리보기 종류(`Html`·`Image`)는 https(운영)·공개 IP·hop마다 재검사이고 포트 제한은 없다.
- 그림 상대 주소는 풀어 쓰되(`resolve_image`) 풀어 낸 주소에는 모양 검사(`normalize_url`)뿐이었다. 사설·루프백 리터럴 검사는 없었고, 거절은 프록시가 가져올 때의 가드에서만 일어났다.
- 정보가 하나도 없는 페이지(제목도 그림도 없음)도 `ok` 행(도메인만 채운)으로 남았고 웹 화면은 도메인을 제목으로 쓴 카드를 그렸다.

### D6. 새 응답 필드 — 모두 선택값

REST는 camelCase, 실시간 `message.unfurl`은 snake_case다(기존 `imageUrl`/`image_url`과 같다). `v`는 1 그대로이고, 옛 클라이언트는 모르는 키를 무시한다. 값이 없으면 키를 보내지 않는다(`null`을 보내지 않는다).

| REST | 실시간 | 값 |
|---|---|---|
| `siteName` | `site_name` | og:site_name, 정리 뒤 100자 이하 |
| `iconUrl` | `icon_url` | 아이콘 프록시 경로 `/v1/workspaces/{ws}/unfurls/{id}/icon`. 원격 주소가 아니다 |
| `imageWidth`·`imageHeight` | `image_width`·`image_height` | 1 이상 16384 이하 정수. **둘이 함께** 있거나 둘 다 없다 |
| `isVideo` | `is_video` | `true`일 때만 실린다 |

새 상태값은 만들지 않는다. 옛 클라이언트는 모르는 `status`가 든 행을 통째로 버리기 때문이다.

### D7. 추출 순서·상한·정리

- 제목: og:title → twitter:title → `<title>`, 180자. 설명: og:description → twitter:description → `name=description`, 280자. 사이트 이름: og:site_name, 100자(대체 규칙 없음, 화면이 도메인으로 메운다).
- 정리: 엔티티를 한 번만 해석한다(`&amp; &lt; &gt; &quot; &apos; &nbsp;`와 숫자 `&#N;`·`&#xH;`. 옛 코드는 `&amp;lt;`를 `<`로 두 번 풀었다). 제어 문자와 공백 연속은 공백 하나로 줄이고(글자 방향 제어 문자 U+202A–U+202E·U+2066–U+2069는 지운다, D13) 양끝 공백을 걷은 **뒤에** 글자 수(문자 단위, 줄임표 없음)로 자른다. 정리 뒤 비어 있으면 없는 값이다. 그래서 `og:title=""`는 다음 순위로 넘어간다.
- 설명이 제목과 같으면 설명을 비운다(정리 뒤, 자르기 전에 비교).
- 같은 키가 여럿이면 글자 값은 마지막 것, 주소 값은 처음 것(현행 유지).

### D8. 문자 인코딩

- 읽는 순서: BOM → Content-Type의 `charset` → `<meta charset>` → `<meta http-equiv="Content-Type" content="…; charset=…">` → 모르면 UTF-8. 메타는 본문 앞 4096바이트에서만 찾는다(HTML 표준의 1024바이트 prescan을 넓힌 값이다. 시험이 경계를 잰다).
- 라벨은 `encoding_rs`(WHATWG 라벨표)로 읽고, 모르는 라벨은 건너뛰어 다음 순위로 간다. 메타가 UTF-16을 말하면 UTF-8로 읽는다(ASCII로 읽히는 문서이므로, WHATWG와 같다). 잘못된 바이트는 U+FFFD로 바뀌고 읽기는 실패하지 않는다.
- 라이브러리는 `encoding_rs` 0.8(`(Apache-2.0 OR MIT) AND BSD-3-Clause`, 모두 permissive)이다. 이미 `Cargo.lock`에 있어서(`multer` 경유) 새 패키지는 없다. 링크 미리보기 워커(`momo-unfurl`, webhook-sender 바이너리에도 링크된다)의 직접 의존으로 더해지므로 `legal/THIRD_PARTY_NOTICES.md`의 「Server direct additions」에 행을 더하고 `NOTICE`의 같은 문단을 고치고, 번들을 다시 만들어 `generate_ghcr_notice_bundle.py check`를 통과시킨다.

### D9. 상대 주소와 안전 규칙 — 새 우회 길을 만들지 않는다

- 그림·아이콘의 상대 주소는 **리디렉션을 따른 최종 페이지 주소**를 기준으로 푼다. `<base href>`는 쓰지 않는다.
- 풀어 낸 주소는 저장하기 전에 `validated_url`(문자 수준)을 지난다: http(s)만, 자격증명·조각 없음, 사설·루프백·링크 로컬 리터럴 거절, 운영에서는 https만(`MOMO_UNFURL_ALLOW_HTTP`는 로컬 개발만). 통과하지 못한 후보는 버리고 다음 후보로 간다. 이 단계는 DNS를 하지 않는다. 저장 시점의 검사는 **UX와 이중 방어**이고 정본 가드는 그대로 가져오는 시점이다(`outbound.rs`가 저장 경로와 전송 경로에 같은 정책을 두 번 두는 방식과 같다).
- 가져오는 시점의 가드는 바뀌지 않는다: 첫 hop부터 매 hop 공개 IP만, 핀 연결, 리디렉션 ≤3 재검사, 응답 상한, 타임아웃.
- **아이콘은 새 가져오기 종류 `FetchKind::Icon`이고 그림보다 좁다.** 같은 가드 위에서 ① **443 포트만, 매 hop**(ADR-0218 D5와 같은 규칙. 첫 검사는 DNS보다 앞이다) ② 본문 상한 512 KiB(그림은 5 MiB) ③ 허용 형식은 PNG·JPEG·GIF·WebP·AVIF·ICO(`image/x-icon`·`image/vnd.microsoft.icon`)이고 **SVG는 받지 않는다**(스크립트를 품을 수 있는 형식). 이슈가 적은 「443」을 새 경로에 처음부터 적용한 것이다. **og:image의 규칙(포트 제한 없음, 5 MiB, 위 형식 중 ICO 제외)은 이 증보가 바꾸지 않는다.**
- 아이콘 후보 순서: `<link rel>`의 `apple-touch-icon`(`-precomposed` 포함) → `icon`(`shortcut icon` 포함) → 최종 페이지 주소의 `/favicon.ico`. 위 문자 수준 검사를 처음 통과한 것을 쓴다. SVG로 보이는 후보(`type`에 `svg`가 있거나 경로가 `.svg`로 끝남)와 http(s)가 아닌 것(`data:` 등)은 건너뛴다. 크기(`sizes`)는 고르지 않는다(문서 순서의 첫 것).
- **아이콘 원본 주소는 클라이언트에 나가지 않는다.** DB에는 `icon_source_url`(원격 주소)과 `icon_proxy_key`(그 주소의 sha256)가 있고, REST와 실시간 모두 `iconUrl`은 프록시 경로뿐이다(`image_url`과 같은 규칙이고 열 COMMENT에 적는다). 프록시는 `GET /v1/workspaces/{ws}/unfurls/{id}/icon`이고 인증·채널 멤버 확인·헤더(`nosniff`, `private` 캐시)가 `…/image`와 같다. 프록시의 메모리 캐시는 그림과 아이콘의 키가 겹치지 않게 갈라 둔다(허용 형식이 다르기 때문).
- 아이콘은 카드를 만들 때가 아니라 **클라이언트가 `…/icon`을 처음 부를 때** 가져온다. 그래서 링크 하나당 워커가 새로 내보내는 요청은 HTML 한 번 그대로다.

### D10. 메시지당 카드 3개

앞에서부터 **서로 다른**(정규화 뒤) 링크 3개까지만 카드를 만든다. 4번째 이후는 가져오지도 않는다. 이미 있는 상한(`MAX_URLS_PER_MESSAGE = 3`)을 정본으로 적고 시험으로 못 박는다. 카드 순서는 링크가 나온 순서다(`ORDER BY created_at, id`. 한 트랜잭션의 행은 `created_at`이 같아 `id`(uuidv7)가 순서를 가른다).

### D11. 정보 없음은 조용히 끝난다

받기는 성공했지만 **제목도 그림도 없으면** 카드를 만들지 않는다. 구현은 상태 `failed`로 기록해(캐시에도 24시간) 모든 클라이언트가 이미 아는 침묵 경로를 탄다. 사이트 이름·아이콘·설명만 있는 페이지도 같다(화면이 채울 수 없는 카드는 만들지 않는다는 이 증보의 선택). **행동 변화**: 이전에는 이런 링크가 도메인만 채운 `ok` 카드가 되어 웹 화면에 도메인 제목의 카드로 보였다. 이 증보부터는 보이지 않는다.

### D12. 그림 크기

- `imageWidth`·`imageHeight`는 og:image:width·height다. 첫 og:image에 딸린 묶음만 쓰고(두 번째 og:image 이후의 값은 버린다), 둘 다 1~16384의 정수일 때만 쓴다. 그림이 twitter:image에서 왔으면 og 크기를 쓰지 않는다.
- 선언이 없으면 프록시가 그림을 받을 때 **헤더에서 잰다**(PNG·GIF·JPEG·WebP. AVIF 등은 재지 않는다). 잰 값은 그 카드 행과 캐시 행에 한 번 기록한다(`WHERE image_width IS NULL`). 기록이 실패해도 그림 응답은 그대로다. 외부 이미지 디코더는 쓰지 않고 헤더의 정수만 읽는다(범위를 벗어난 입력은 못 잰 것으로 본다).
- 선언한 값은 페이지가 정직하다는 보장이 없다. 화면은 값을 비율로만 쓰고 자기 상한을 둔다(#4882).

### D13. 독립 보안 검수 1회차 수리 (2026-10-31)

검수가 이 증보의 구현에서 High 1건·Medium 2건·Low 3건을 냈다. 아래는 고친 것과 그 결정이다(검수 기록은 비공개이고 재현 절차는 여기에 쓰지 않는다). 새 송신 경로나 새 열은 없다. 2회차 검수가 Blocker 0·High 0으로 통과해 Status를 Accepted로 올렸다(남은 Low는 후속 이슈).

- **해석은 페이지 크기에 선형이다 (H-1).** 해석기는 `</title`이 없는 `<title>`을 만나면 「뒤에도 없다」를 한 번만 알아내고(`Scan::title_unclosed`) 이후 `<title>`에서 다시 찾지 않는다. 닫혔지만 정리하면 비는 제목은 이 표시를 켜지 않는다(뒤의 `<title>`이 제목이 될 수 있다). 모듈 머리 주석의 선형 시간 설명을 사실에 맞게 고쳤다. 안전망으로 워커는 카드 만들기를 `spawn_blocking`으로 돌려 같은 태스크에서 도는 웹훅 송신·도어벨과 떼어 놓는다(구조적 방어라 단독 시험·사보타주는 없다). 시험 문턱은 512 KiB 상한 페이지 1초다(선형 해석은 밀리초 단위로 끝난다).
- **아이콘의 DNS 단계를 시험이 잰다 (M-1).** 아이콘 주소가 이름이고 그 이름이 사설·루프백·링크 로컬·클라우드 메타데이터·IPv6에 담긴 IPv4(매핑·NAT64·6to4·호환)로 풀리면 `Blocked`이고 소켓은 0이다(첫 hop, 공개+사설 혼합 답, 리디렉션 hop의 이름). 해석기가 실제로 불렸는지까지 단정해 더 앞의 거절 때문에 통과하는 일이 없게 했다. 이 시험이 후속 주장(「아이콘은 443 전용이고 사설·루프백·링크 로컬은 거절」)의 증명 시험이다(`claims.yaml`은 정책 파일이라 이 증보가 고치지 않는다).
- **프록시는 바깥 사이트를 아낀다 (M-2).** 아이콘은 거의 모든 카드에 생기고(`/favicon.ico` 대체) 각 요청은 최대 4번의 바깥 GET이므로, #4882·#4883 화면이 `…/icon`을 부르기 전에 넣는다.
  - **실패 기억**: 404·가드 거절·시간 초과·형식 불일치를 10분 기억하고 그동안 바깥에 묻지 않는다. 그림 캐시와 따로 한도(1024개)를 둬서 나쁜 주소가 좋은 그림을 밀어내지 못한다.
  - **멤버 예산**: `MemberWrite::UnfurlProxy`, 창(60초)당 기본 240, `RATE_LIMIT_UNFURL_PROXY_PER_MEMBER`(0이면 끔). 두 라우트가 한 예산을 쓰고 **서버가 실제로 바깥에서 받아 와야 하는 요청만** 센다(`proxy_goes_outbound`): 메모리에 있는 그림과 기억 중인 실패는 세지 않는다. 라우트 층이 아니라 핸들러에서 인가 뒤·받기 앞에 쓴다(층은 둘을 가르지 못한다). 넘으면 openapi가 이미 선언한 429 + `Retry-After`이고, 감사 행은 멤버 쓰기 예산의 기존 계약이다(`rate_limit.exceeded`, `surface = unfurl_proxy`, 멤버·표면당 창마다 최대 1행). 240은 한 화면 20장(그림·아이콘 40번)을 처음 열 때보다 넉넉하고 초당 4번이다.
  - **동시 상한**: 바깥으로 나가는 받기는 프로세스 전체로 16개, 한 멤버는 그중 4개까지다(#4956, 검수 2회차 Low 후속). 넘으면 429 + `Retry-After: 1`이고 카드 탓이 아니므로 실패로 기억하지 않으며, 그 요청이 쓴 멤버 예산은 돌려준다. 이름 조회 자리가 없어 시작하지 못한 받기(`FetchError::Capacity`)도 같다. 화면(#4882·#4883)은 429를 404처럼 조용히 대체 아이콘으로 그리고 `Retry-After` 뒤에 다시 부른다.
  - **해석 마감**: `SafeUnfurlTransport`의 이름 조회에 3초 마감과 32개 상한을 둔다. `tokio::net::lookup_host`는 blocking 풀에서 `getaddrinfo`를 부르고, 마감에 future를 버려도 그 스레드는 `getaddrinfo`가 끝날 때까지 잡혀 있다. 그래서 조회를 자기 태스크에서 돌려 **끝날 때까지 자리를 쥐게** 했다(포기한 조회도 상한에 센다). 자리가 없으면 줄 세우지 않고 바로 이름 해석 실패(`Failed("dns")`)다. 한계: 이 상한은 이 전송기 하나의 것이고 `momo-webhook`의 공용 `SystemHostResolver`(웹훅 전달·도어벨)는 그대로다. 같은 마감을 거기에 주는 것은 후속 후보다.
  - **LRU**: 가득 차면 전부 비우던 것을 가장 오래 안 쓴 것부터 내보내고 항목 256개·합 32 MiB로 묶는다(전에는 64개에 항목당 최대 5 MiB라 이론상 320 MiB).
- **마이그레이션 163의 CHECK 여섯 개는 `NOT VALID`다 (Low-1).** 열이 방금 생겨 기존 행이 어길 수 없고 새로 쓰는 행(INSERT·UPDATE)은 검사된다. 그래서 큰 표에서도 잠금이 메타데이터 변경 길이로 끝난다(162와 같은 이유). 이미 163을 적용한 DB는 옛 모양을 그대로 가진다(적용된 마이그레이션은 다시 돌지 않는다).
- **글자 방향 제어 문자를 지운다 (Low-3).** 제목·설명·사이트 이름에서 U+202A–U+202E·U+2066–U+2069를 서버가 지운다(공백으로 바꾸지 않는다). 오른쪽에서 왼쪽으로 쓰는 글자와 U+200E·U+200F는 그대로다.
- 하지 않은 것(후속 후보): 첫 hop 호스트를 정규화한 뒤 IP를 고정하기(검수 Low-2, 이번 변경 밖의 기존 코드이고 운영 glibc에서는 닿지 않는다), 같은 주소를 동시에 부르는 요청 합치기.

### DB (migration 163)

`unfurl_url_cache`와 `message_unfurl`에 같은 열 여섯: `site_name`·`icon_proxy_key`·`icon_source_url`·`image_width`·`image_height`·`is_video`(NOT NULL DEFAULT false). 크기 쌍·범위·주소 길이는 CHECK로 DB도 쥔다. `icon_source_url`은 `image_url`처럼 클라이언트에 나가지 않는다고 열 COMMENT에 적는다. 새 표가 없으므로 RLS 정책·FORCE·권한은 그대로다. 163 이전의 `unfurl_url_cache` 행은 새 필드 없이 24시간 안에 만료된다(다시 가져오지 않는다).

### 무엇을 열지 않나

- 화면(#4882·#4883), 보내기 전 입력칸 미리보기(#4884), 팀 서버 켜기(#4880).
- 새 송신 경로: 가져오기는 여전히 `UnfurlHttp` 한 곳이고, 클라이언트는 원격 호스트에 붙지 않는다.
- SVG 아이콘, `<base href>`, 아이콘 `sizes` 고르기, 카드를 만들 때의 아이콘 선가져오기, 새 상태값, og:image의 포트 제한은 하지 않는다.

### 확인 [V]와 한계

시험 이름이 정본이다(PR 본문이 실행 결과를 적는다). 아래 이름을 바꾸면 이 목록도 같이 바꾼다.

- 추출·정리(D7·D12): `parse.rs`의 `every_missing_item_combination_yields_exactly_what_is_there`(빠진 항목 조합) · `the_caps_are_180_280_and_100_characters_and_whitespace_collapses` · `a_description_that_repeats_the_title_is_dropped` · `entities_are_decoded_once` · `a_greater_than_inside_a_quoted_value_does_not_cut_the_tag` · `comments_scripts_and_styles_do_not_feed_the_card` · `video_is_og_type_video_dot_something_or_a_twitter_player` · `icons_come_apple_touch_first_then_icon_and_never_svg` · `the_size_is_the_first_og_images_valid_pair`, `dimensions.rs`의 `each_supported_format_reports_its_size` · `what_cannot_be_measured_is_none_and_never_a_panic`.
- 인코딩(D8): `charset.rs`의 `the_content_type_charset_decodes_euc_kr` · `meta_charset_and_http_equiv_fill_in_when_the_header_is_silent` · `the_order_is_header_then_meta_charset_then_http_equiv_then_utf8` · `a_label_we_do_not_know_is_skipped_not_fatal` · `a_byte_order_mark_beats_the_header` · `the_meta_is_only_looked_for_in_the_first_4096_bytes`, `card.rs`의 `an_euc_kr_page_reads_in_korean`.
- 주소·안전(D9): `card.rs`의 `relative_pictures_and_icons_resolve_against_the_final_page_address` · `a_resolved_address_that_lands_on_a_private_host_is_dropped` · `plain_http_is_only_a_development_allowance` · `an_icon_is_on_port_443_a_picture_may_not_be`, `fetch.rs`의 `an_icon_fetch_is_refused_for_private_loopback_and_link_local_before_any_connect` · `an_icon_dials_443_only_on_every_hop_and_a_picture_does_not` · `an_icon_redirect_into_a_private_destination_stops_after_the_public_hop` · `an_icon_body_is_cut_off_at_the_icon_cap`, `proxy.rs`의 `the_icon_proxy_refuses_private_loopback_and_link_local_addresses` · `an_icon_redirect_into_a_private_address_is_refused_after_the_public_hop` · `an_icon_may_be_an_ico_a_picture_may_not_and_nothing_may_be_svg_or_html` · `a_picture_and_an_icon_at_one_address_never_share_a_cache_entry` · `each_slot_fetches_its_own_address_as_its_own_kind`.
- 카드 3개·정보 없음·새 열(D10·D11·DB, 실 PG, `momo_app`은 superuser·BYPASSRLS 아님을 시험이 단정한다, 두 테넌트): `momo-unfurl/tests/unfurl_conformance_pg.rs`의 `four_links_make_three_cards_in_order_and_every_new_column_is_stored` · `a_page_with_no_title_and_no_picture_ends_quietly` · `the_cache_carries_the_new_fields_to_the_next_message` · `two_tenants_each_read_only_their_own_site_meta_as_the_runtime_role` · `a_measured_size_is_recorded_once_and_a_declared_size_is_never_overwritten` · `the_database_holds_the_size_pair_the_icon_pair_and_the_name_length`, 기존 `extract.rs`의 `keeps_three_and_drops_the_fourth`.
- 응답에 아이콘·그림의 원격 주소가 없음(REST와 실시간 모두, 본문 문자열에서 부재를 단정한다)·아이콘 경로의 인가(비로그인 401, 채널 밖 멤버·다른 테넌트 403, 없는 카드·아이콘 없는 카드 404)·잰 크기의 기록: `momo-server/tests/unfurl_conformance_pg.rs`의 `site_meta_over_rest_the_icon_proxy_and_the_measured_size`와 위 첫 PG 시험의 방송 단정.
- 코어 타입·디코더: `packages/momo-core`의 `unfurl.test.ts`(`unfurl site metadata`) · `unfurlFrames.test.ts` · `unfurlApi.test.ts`.
- 검수 1회차 수리(D13): `parse.rs`의 `a_page_of_unclosed_titles_is_read_in_linear_time` · `no_page_shape_at_the_fetch_cap_makes_the_reader_slow` · `an_empty_closed_title_does_not_stop_a_later_title_but_an_unclosed_one_does` · `direction_controls_are_dropped_from_every_text_field`. 아이콘 DNS 단계(M-1): `fetch.rs`의 `an_icon_name_that_resolves_to_an_inward_address_is_blocked_before_any_connect` · `an_icon_name_with_one_inward_answer_among_public_ones_is_blocked` · `an_icon_redirect_to_a_name_that_resolves_inward_stops_after_the_public_hop`, `proxy.rs`의 `an_icon_name_that_resolves_inward_is_refused_by_the_proxy_and_never_dialled`. 프록시 절약(M-2): `proxy.rs`의 `a_failed_fetch_is_remembered_and_the_address_is_not_asked_again` · `a_remembered_failure_runs_out_and_the_address_is_asked_again` · `the_least_recently_used_picture_goes_first_and_the_cache_is_never_emptied_at_once` · `the_byte_budget_bounds_the_cache_and_a_body_over_it_is_served_but_not_kept` · `failures_have_a_bound_of_their_own_and_never_push_pictures_out` · `at_most_the_limit_of_fetches_run_at_once_and_the_next_is_busy_until_one_ends` · `a_failed_fetch_gives_its_place_back` · `only_a_request_that_would_leave_the_building_goes_outbound`, `fetch.rs`의 `a_name_server_that_never_answers_ends_the_fetch_at_the_deadline` · `lookups_that_outlive_their_deadline_still_count_against_the_ceiling`, 서버 PG(`momo-server/tests/unfurl_conformance_pg.rs`)의 `the_proxy_budget_is_spent_only_by_a_request_that_fetches_and_is_the_members_own` · `a_full_house_of_fetches_in_flight_is_a_429_and_only_for_a_request_that_must_fetch` · `an_icon_that_404ed_is_remembered_so_asking_again_costs_neither_the_site_nor_the_budget`, 설정 `config.rs`의 `the_member_write_defaults_admit_ordinary_use_with_headroom` · `the_member_write_env_names_move_exactly_their_own_field`. migration 163의 `NOT VALID`(두 표의 새 행·UPDATE 거절과 `convalidated` 거짓): crate PG `the_database_holds_the_size_pair_the_icon_pair_and_the_name_length`.
- 사보타주(아이콘 가드 우회, 풀이 뒤 검사 제거, 3개 상한 제거, charset 무시, 설명=제목 비우기 제거, 응답에 아이콘 원본 주소 노출, 그리고 1회차 수리의 제목 플래그·방향 문자·아이콘 DNS 단계 생략·실패 기억·LRU·바이트 상한·동시 상한·멤버 예산·해석 마감과 상한·`NOT VALID`)는 각각 RED를 확인하고 되돌렸다. 결과표는 PR 본문에 있다.
- 실제 외부 사이트를 대상으로 한 확인은 하지 않았다(`runtime-unverified`). 가짜 서버는 127.0.0.1이고 안전 규칙은 주입한 해석기와 가짜 소켓으로 시험한다. 화면은 이 증보의 범위가 아니다.
- `docs/security/claims.yaml`의 새 주장(아이콘 443 전용 등)은 정책 파일이라 이 증보가 고치지 않는다. 기존 NET-2의 증명 시험 이름·위치는 바꾸지 않았다. 후속 이슈의 몫이다.

## 증보 2026-11-01 — 보내기 전 입력칸 링크 미리보기와 「미리보기 없이 보내기」 (#4884)

- Status: **Accepted** (2026-11-01 planner — 독립 보안 검수 1회차 Blocker 0·High 0. Medium·Low는 후속 이슈. #4884 엔진 워커 기안, owner 2026-10-31 요청(이슈 #4884에 요약)의 범위). 이 증보는 공개 API(새 경로 3개, 보내기 필드 1개)와 서버가 가져오는 주소가 정해지는 길(보안 경계)을 바꾸므로 Accepted가 구현 머지 조건이다(ADR-0100).
- 근거: 이슈 #4884. 화면(웹·폰 입력칸 카드와 ✕)은 #4882 뒤의 별도 칸이고, 이 증보는 **서버가 저장 전에 카드 정보를 내보내는 길과, 이 메시지는 카드를 만들지 말라는 표시**만 정한다.
- 관계: D1~D13은 바뀌지 않는다. D2(P9)는 그대로다 — 미리보기 요청은 **초안 본문이 아니라 주소 하나**만 받는다. D3(egress 가드)는 그대로 쓰고, 그 위에 이 길만의 **더 좁은 규칙 하나**(443 전용)를 더한다(D9의 아이콘과 같은 방식). 같이 읽는 것: ADR-0218 D5(회원이 직접 적은 주소를 서버가 받는 선례, 443 전용), #4956(멤버별 동시 상한·예산·바쁨 환불의 틀).
- 표기: [V] 이 세션에서 직접 확인(track/engine `2ed568572`) · `runtime-unverified` 실행하지 않음.

### 확인한 사실 [V]

- 카드 행(`message_unfurl.message_id`)은 메시지를 가리키는 `NOT NULL` 외래키이므로 **보내기 전에는 카드 행이 있을 수 없다**. 그림·아이콘 프록시(`…/unfurls/{id}/image|icon`)는 그 행의 id가 열쇠라서 미리보기에는 그대로 쓸 수 없다.
- 카드는 메시지 INSERT 트리거가 `unfurl_job`을 남기면 워커가 만든다. 워커는 **맨 먼저** `message_unfurl_tombstone`을 본다(`prepare`의 `tombstone_exists`, 커밋 직전에 한 번 더). 묘비는 D4의 「메시지 단위 제거」가 이미 쓰는 표이고 RLS·권한이 있다.
- `unfurl_url_cache`를 지우는 코드는 어디에도 없다(만료는 같은 주소를 다시 받을 때 덮어쓰기뿐). 이 표에 미리보기를 쓰면 회원의 입력이 만드는 행이 예산만큼 영원히 쌓인다.
- 미리보기 종류에 해당하는 `FetchKind::Html`에는 포트 제한이 없다(D9 확인 사실). 회원이 주소를 직접 적고 **응답이 바로 돌아오는** 길에 이것을 그대로 쓰면 공개 호스트의 열린 포트를 상태 코드로 훑는 길이 된다(ADR-0218 D5가 막은 것과 같은 문제).
- 보내기 요청은 closed-world(`deny_unknown_fields`)이고 새 선택 필드는 「켠 때만 키가 간다」로 더해 왔다(`alsoInChannel`, `apps`). 개발자 토큰의 보내기 본문은 허용 목록 5개 키뿐이라 새 키는 자동으로 막히고, 개발자 토큰이 닿는 경로는 닫힌 표(`dev_route_scope`)라 새 경로도 자동으로 막힌다.

### D14. 미리보기 요청 — 채널에 매인 POST 하나

`POST /v1/workspaces/{ws}/channels/{ch}/unfurl-previews`, 본문 `{ "url": "<http(s) 주소>" }`(closed-world, 2048바이트 이하). 응답은 항상 200이고 본문은 D15다. 400은 주소가 http(s) 모양이 아닐 때(자격증명 포함·너무 김)뿐이고 **네트워크는 아직 건드리지 않은 상태**다. 본문이 이 모양을 벗어나면(모르는 키·`url` 없음) 서버 공통 JSON 추출기의 4xx다. 401·403(D16)·429(D20)가 그 밖이다.

- **POST + 본문**인 이유: 링크의 쿼리는 흔히 토큰이라 주소를 경로·쿼리에 싣지 않는다(액세스 로그·프록시·브라우저 기록).
- **채널에 매인** 이유: 미리보기의 권한을 「그 채널에서 보낼 수 있는가」와 같게 하려는 것이다. 게스트·DM·비공개 채널 규칙을 새로 만들지 않고 보내기의 규칙이 그대로 따라온다.
- 서버는 입력칸 본문을 받지 않는다. 어느 주소를 물을지는 클라이언트가 정하고(D22), 서버는 그 주소 하나만 읽는다(D2).

### D15. 응답 — 기존 카드 필드와 같은 모양, 상태는 둘뿐

| 키 | 값 |
|---|---|
| `url` | 정규화한 주소(`normalize_url`, 저장된 카드의 `url`과 같은 모양) |
| `status` | `ok` 또는 `failed` |
| `id` | `ok`일 때만. 미리보기 열쇠(D19) |
| `title`·`description`·`domain`·`siteName`·`imageWidth`·`imageHeight`·`isVideo` | `ok`일 때, 카드와 같은 규칙으로 정리·상한(D7). 값이 없으면 키가 없다 |
| `imageUrl`·`iconUrl` | `ok`이고 있을 때만, **미리보기 프록시 경로**(D19). 원격 그림·아이콘 주소는 어디에도 실리지 않는다 |

`messageId`는 없다(메시지가 아직 없다). `failed`는 `url`·`status`만 싣는다. **`blocked`·`pending`은 내보내지 않는다.** 가드가 거절한 것·받지 못한 것·정보가 없는 페이지(D11)는 모두 같은 `failed`다 — 「이 이름은 서버 안쪽으로 풀린다」를 알려 주는 길이 되지 않게 한다. 저장된 카드의 `blocked`/`failed` 구별(D5)은 그대로다.

### D16. 권한

- **사람 자격만**(`require_human`). 에이전트·작업 호스트 자격은 403이다. 개발자 토큰은 닫힌 표에 없어 `dev_route_not_allowed`다.
- **활성 워크스페이스 멤버이면서 그 채널의 현재 멤버**. 둘 중 하나라도 아니면, 채널이 없는 경우까지 포함해 같은 403이다(채널이 있는지 알려 주지 않는다).
- **게스트**: 보내기와 같은 규칙 — 자기가 속한 채널에서만 된다. 따로 막거나 따로 열지 않는다. 게스트가 속한 채널에 링크를 보내면 지금도 서버가 그 주소를 받으므로(D1), 새 능력을 열어 주는 것이 아니다.
- **스위치 둘이 받기 자체를 막는다**: 인스턴스 `MOMO_UNFURL_ENABLED`가 켜져 있고 워크스페이스 설정(D4)이 켜져 있어야 한다. 하나라도 꺼져 있으면 **받지 않고** `failed`로 답한다(예산도 안 쓴다). 렌더만 끄는 것이 아니다.

### D17. 바깥으로 나가는 받기 — 새 전송기도 새 가드도 없다

미리보기의 페이지 받기는 `state.unfurl_http` 하나(`UnfurlHttp`, 운영에서는 `SafeUnfurlTransport`)를 지난다. 새 HTTP 클라이언트·새 이름 해석기를 만들지 않는다. D3의 상한은 그대로다: HTML 512 KiB, 리디렉션 ≤3(매 hop 재검사), 공개 IP만·핀 연결, https(운영), 시간 마감, 이름 조회 마감·상한.

더해진 것은 **새 받기 종류 `FetchKind::Preview`와 그 규칙 하나**다. 본문 상한·`Accept`·내용 형식 기본값은 `Html`과 같고, 같은 가드 위에서 **443 포트만, 매 hop**(ADR-0218 D5, D9의 아이콘과 같은 규칙. 첫 검사는 DNS보다 앞이다). 이슈가 적은 「지금 SSRF 규칙 그대로」를 새 경로에 처음부터 더 좁게 적용한 것이고, 가드 코드(`fetch_guarded`)는 한 벌이다. **워커의 `Html`(포트 제한 없음)은 이 증보가 바꾸지 않는다.**

받기 결과는 워커와 같은 함수(`build_card`, 막힌 풀에서 실행: D13 H-1)로 카드 필드가 된다. 그림·아이콘의 원격 주소는 D9의 문자 수준 검사를 거친 뒤에만 쥔다. 어떤 실패도 로그에 주소·쿼리·본문을 싣지 않는다.

### D18. 캐시 — 프로세스 안에, 멤버별로, DB에는 아무것도 쓰지 않는다

- 키는 **(워크스페이스, 멤버, 정규화한 주소)**. 같은 주소를 같은 멤버가 다시 물으면 바깥에 가지 않고 예산도 쓰지 않는다. `ok`는 30분, `failed`는 2분 기억한다. 항목은 512개, 한 멤버는 그중 64개까지다. 가득 차면 가장 오래 안 쓴 것부터, 한 멤버가 자기 몫을 넘으면 **그 멤버 자신의** 가장 오래 안 쓴 것부터 나가므로 한 멤버가 캐시를 채워 남의 미리보기를 밀어낼 수 없다(그림 캐시와 따로, 자리의 멤버 몫(D20)과 같은 이유).
- **테넌트가 다르면 절대 공유하지 않는다**(키의 워크스페이스 성분이 막고, 시험이 잰다). 멤버 성분은 이슈의 「테넌트별」보다 **한 겹 더 좁다**: 같은 워크스페이스의 다른 멤버가 방금 쓰다 만 초안의 링크가 캐시 적중의 속도·예산으로 새지 않게 한다.
- **DB 표(`unfurl_url_cache`)를 쓰지 않는 이유**: ① 보내지 않을 수도 있는 초안의 주소가 24시간 이상 남지 않게, ② 위 [V]처럼 지우는 코드가 없어 회원 입력이 만드는 행이 끝없이 쌓이지 않게, ③ 마이그레이션이 필요 없게. 대가는 아래 「남는 위험」의 1·2다.
- `failed`는 정확히 한 가지를 빼고 기억한다: 자리가 없어서 시작하지 못한 것(D20)은 주소의 잘못이 아니므로 기억하지 않는다.

### D19. 그림·아이콘 — 미리보기 열쇠와 같은 프록시

`ok` 미리보기마다 서버가 무작위 `id`(UUID v4)를 만들어 캐시 항목에 붙인다. 클라이언트는 두 경로로만 그림·아이콘을 받는다.

- `GET /v1/workspaces/{ws}/unfurl-previews/{id}/image`
- `GET /v1/workspaces/{ws}/unfurl-previews/{id}/icon`

**프록시 기능은 기존 것이다.** 항목을 카드 행과 같은 모양으로 풀어 `fetch_record_image`/`fetch_record_icon`(같은 가드, `FetchKind::Image`/`Icon`, 같은 형식 허용 목록·SVG 금지, 같은 `ImageCache`·실패 기억·자리)에 넘긴다. 응답 헤더도 `…/unfurls/{id}/image`와 같다(`nosniff`, 사설 캐시). 그림 크기를 재서 기록하는 일(D12)만 하지 않는다(쓸 행이 없다).

권한은 **자기 미리보기뿐**이다: 활성 워크스페이스 멤버이고 `id`가 **그 멤버가 만든** 살아 있는 항목일 때만 된다. 남의 `id`·만료된 `id`·다른 워크스페이스의 `id`·받을 것이 없는 항목은 모두 404이고(`{ws}`가 자격의 워크스페이스와 다르면 기존 규칙대로 403), `id`는 추측할 수 없는 무작위 값이다. 서버가 그림을 받을 때 쓰는 예산은 기존 `UnfurlProxy`다(D20).

### D20. 예산과 자리 — #4956과 같은 틀

- **예산**: `MemberWrite::UnfurlPreview`, 창(60초)당 기본 60, `RATE_LIMIT_UNFURL_PREVIEW_PER_MEMBER`(0이면 끔). **캐시에 없어서 서버가 실제로 바깥에서 받아야 하는 요청만** 센다. 넘으면 429 + `Retry-After`이고 감사 행은 멤버 쓰기 예산의 기존 계약이다(`rate_limit.exceeded`, `surface = unfurl_preview`, 멤버·표면당 창마다 최대 1행). 입력을 멈추고 350ms 뒤에 묻는 보통의 사용은 이 한도의 한참 아래이고, 주소를 천천히 치다 멈춘 중간 상태가 몇 번 더해져도 여유가 있도록 60으로 잡았다.
- **자리**: 바깥으로 나가는 받기의 **같은 자리**(프로세스 16, 한 멤버 4: `ImageCache`)를 쓴다. 그래서 한 멤버가 동시에 바깥으로 내보내는 받기는 미리보기·그림·아이콘을 다 합쳐 4개다. 자리가 없거나 이름 조회 자리가 없으면(`FetchError::Capacity`) 429 + `Retry-After: 1`이고, 그 요청이 쓴 예산은 돌려주며, 실패로 기억하지 않는다.
- 두 번째 예산(`UnfurlProxy`)은 미리보기 그림·아이콘 프록시가 그대로 쓴다(D13).

### D21. 「미리보기 없이 보내기」 — 보내기 필드 하나, 묘비 하나

`POST …/messages` 요청에 선택 필드 `suppressUnfurl`(boolean)을 더한다. **`true`일 때만 키가 간다**(옛 서버의 closed-world 요청이 모르는 키를 400으로 거절하므로 클라이언트는 미리보기 표면이 있는 서버에만 보낸다). 없거나 `false`는 같은 요청이다.

- **같은 보내기 트랜잭션 안에서**, 메시지가 **새로 들어갈 때만**, 보낸 사람 이름으로 `message_unfurl_tombstone` 행 하나를 심는다(D4의 묘비, `ON CONFLICT DO NOTHING`). 그러면 워커가 `prepare`에서 `Skip("tombstone")`으로 끝내므로 **카드가 하나도 만들어지지 않는다**. 보내기의 채널 순번·메시지 행·outbox는 한 줄도 바뀌지 않고, 새 표·새 열·새 상태가 없다(마이그레이션 0).
- 멱등 재시도(`deduped`)는 저장된 메시지를 돌려줄 뿐 이 필드를 다시 판단하지 않는다(`alsoInChannel`과 같다). 첫 보내기에 켜졌으면 묘비가 남아 있고, 안 켰으면 재시도가 뒤늦게 켜지 못한다.
- props 키가 아니다: props는 클라이언트가 쓰는 평평한 문자열 표라 서버가 보증할 값을 담을 수 없다(`apps`·`stream`과 같은 이유). 서버 소유 키 목록은 바뀌지 않는다.
- 효과 범위는 **자기 메시지뿐**이다(다른 사람의 카드·캐시에 영향이 없다). 개발자 토큰의 보내기는 허용 목록이 닫혀 있어 이 키를 보내면 기존대로 `dev_field_not_allowed`다. 예약 전송은 이 선택을 아직 싣지 않는다.
- 보낸 뒤의 제거(`DELETE …/unfurls`, D4)는 그대로다. 이 필드는 「보내기 전의 ✕」일 뿐이다.

### D22. 클라이언트 권고 (서버가 강제하지 않는다)

- 입력을 멈추고 **350ms 뒤**에 묻는다. 주소가 끝났다고 볼 수 있을 때(뒤에 공백·줄바꿈, 붙여넣기 직후) 묻고, 한 입력칸에서 같은 주소는 한 번만 묻는다. 한 메시지에서 카드가 되는 링크는 앞의 서로 다른 3개다(D10).
- 어느 주소가 카드가 되는지는 서버의 추출 규칙(코드 블록·이메일 제외, 정규화 뒤 중복 제거)을 따른다. 규칙이 다르면 미리보기에는 보이는데 보낸 뒤에는 카드가 안 생기는 어긋남이 난다.
- 429는 `Retry-After`(초) 뒤에 한 번 다시 묻고, 그동안 카드 자리를 비운다. 404(그림·아이콘)는 대체 아이콘으로 조용히 그린다.
- ✕는 **이번 메시지의 미리보기 전체**를 끄는 한 번의 선택이고, 보낼 때 `suppressUnfurl: true`로 간다.

## 대안 기각 (이 증보)

- **미리보기를 `unfurl_url_cache`에 쓰고 보낼 때 워커가 그대로 쓰게 하기**: 보낸 직후 카드가 바로 뜨고 바깥 받기도 한 번 줄지만, 위 [V]처럼 지우는 코드가 없어 입력이 곧 영구 행이 되고, 보내지 않은 초안의 주소가 남으며, 그림 프록시가 행을 찾으려면 주소를 경로·쿼리에 싣거나 색인 없는 열을 훑어야 한다. 기각. 보낼 때 **실제로 보낸 주소만** 미리보기에서 캐시로 옮기는 안은 보내기 트랜잭션을 건드려야 해서 이번에 하지 않는다(후속 후보).
- **새 표(`unfurl_preview`)와 마이그레이션**: 같은 쌓임 문제에 지우는 작업까지 새로 만들어야 한다. 기각.
- **입력칸 본문 전체를 보내고 서버가 주소를 뽑기**: 추출 규칙은 서버 한 벌이 되지만 초안 본문이 서버로 나간다(D2). 기각 — 주소 하나만 받는다.
- **클라이언트가 직접 받기**: 기존 기각 사유(CSP·수신자 IP 노출·CORS)와 같다.
- **억제를 props 키로**: D21에 적은 이유로 기각. **억제를 DB 열·트리거 변경으로**: 묘비가 이미 같은 일을 하므로 마이그레이션이 필요 없다. 기각.
- **워크스페이스 단위 미리보기 경로**: 게스트·비공개 채널 규칙을 새로 정해야 한다. 기각.
- **미리보기 `Html`을 포트 제한 없이 그대로 쓰기**: 공개 호스트 포트 훑기가 된다(위 [V]). 기각.

## 남는 위험 (이 증보)

1. **프로세스 안 상태**: 재시작하거나 복제본이 여러 개이면 미리보기 `id`가 사라져 그림·아이콘이 404가 되고(입력칸이 그림 없이 그린다), 예산도 복제본마다다(기존 한도와 같은 계약).
2. **보낼 때 한 번 더 받는다**: 워커는 미리보기 항목을 모르므로 같은 주소를 다시 받는다. 그 사이 페이지가 바뀌면 카드가 미리보기와 다를 수 있다.
3. **443이 아닌 포트의 링크**: 미리보기는 `failed`(카드 없음)인데 보낸 뒤 워커의 `Html`은 카드를 만든다. 어긋남이지 보안 문제가 아니다.
4. **남은 신호**: 「공개 호스트 하나가 443에서 HTML을 주는가」(`ok`/`failed`)는 여전히 보인다. 브라우저가 알 수 있는 것과 같은 정보이고 예산·자리가 속도를 묶는다. 사설 이름이 있는지는 알려 주지 않는다(D15).
5. **같은 주소 동시 요청은 합치지 않는다**(D13에 적은 후속 후보와 같다). 멤버 자리 4개가 상한이다.
6. **서버는 초안 링크를 본다**: 이 기능의 본질이다. 저장도 로그도 하지 않지만 요청을 받는 순간 서버는 안다.
7. **멤버끼리 캐시를 나누지 않아** 같은 링크를 두 멤버가 물으면 두 번 받는다(D18의 선택).
8. **예산 1단위 = 바깥 GET 최대 4번**(검수 2026-11-01): 리디렉션 hop마다 하나라 예산이 바깥 요청 수를 그대로 세지는 않는다. 상한은 hop 수와 멤버 자리 4개가 묶는다.
9. **og:image는 포트를 묶지 않는다**(검수 2026-11-01): 미리보기 HTML은 443만 받지만, 카드의 그림 주소(`Image` 종류)는 기존 그림 프록시처럼 포트 제한이 없다. 가드(사설·루프백·메타데이터·DNS 고정)는 그대로 걸린다.
10. **자리 굶기기**: 프로세스 자리 16·이름 조회 32는 계정 몇 개로 바닥낼 수 있다(새 위험은 아니지만, 미리보기는 사람이 주소를 직접 적는 더 곧은 길이다). 멤버별 자리 4와 예산이 한 계정의 몫을 묶는다.
11. **응답 시간**(검수 2026-11-01): 4의 「사설 이름이 있는지 알려 주지 않는다」는 응답 본문 기준이다. 가드가 바로 거절하는 이름, 없는 이름, 느린 공개 사이트는 응답 시간이 다를 수 있다. 저장된 카드의 `blocked`/`failed` 구별보다 새는 정보는 적다.
12. **캐시 전체 상한**(검수 2026-11-01): 캐시는 프로세스 전체 512개, 멤버 몫 64개라 계정 여럿(8개 이상)이 채우면 다른 멤버의 항목이 밀린다. 밀린 쪽은 한 번 다시 받고 예산 1을 쓴다.

## 무엇을 열지 않나 (이 증보)

- 화면(입력칸 카드·✕·모바일), 미리보기 → 워커 이어받기, 예약 전송의 억제, `unfurl_url_cache` 청소 작업, 워커 `Html`의 포트 제한, 같은 주소 동시 요청 합치기, 웹훅 공용 이름 해석기의 마감.
- 새 송신 경로: 가져오기는 여전히 `UnfurlHttp` 한 곳이고, 클라이언트는 원격 호스트에 붙지 않는다. 새 표·새 열·마이그레이션 없음.

## 확인 [V]와 한계 (이 증보)

시험 이름이 정본이다(PR 본문이 실행 결과를 적는다). 아래 이름을 바꾸면 이 목록도 같이 바꾼다.

- 가드를 지난다(D17, 크레이트 시험, 실제 `fetch_guarded` 위의 가짜 소켓·이름 풀이): `preview.rs`의 `the_preview_fetch_is_refused_for_private_loopback_link_local_and_metadata_before_any_connect` · `a_name_that_resolves_inward_is_a_failed_preview_and_never_dialled` · `a_preview_is_https_on_443_only_on_every_hop` · `a_preview_redirect_into_a_private_destination_stops_after_the_public_hop` · `every_way_to_fail_is_the_same_failed_preview` · `a_page_with_nothing_to_show_is_a_failed_preview`.
- 캐시·열쇠·자리(D18~D20): `preview.rs`의 `the_cache_key_names_workspace_member_and_address` · `an_ok_preview_is_kept_for_its_ttl_and_a_failed_one_for_a_shorter_while` · `the_least_recently_used_preview_goes_first_and_its_id_goes_with_it` · `one_member_cannot_fill_the_cache_and_push_out_another_members_previews` · `a_preview_belongs_to_the_member_who_asked` · `a_place_shortage_is_busy_and_is_never_remembered` · `one_member_cannot_hold_more_places_than_its_share_while_another_is_served`.
- REST·실 PG(비우회 역할 `momo_app`을 시험이 단정한다, 두 테넌트): `momo-server/tests/unfurl_conformance_pg.rs`의 `a_preview_shows_the_card_to_the_member_who_asked_and_never_a_remote_address` · `only_an_active_member_of_the_channel_may_preview_and_a_guest_only_where_it_may_send` · `two_tenants_and_two_members_never_share_a_preview` · `a_preview_is_cached_and_spends_budget_only_when_it_fetches` · `a_preview_with_no_place_is_a_429_and_gives_the_unit_back` · `a_destination_the_guard_refuses_is_a_plain_failed_preview_through_the_production_transport` · `a_preview_makes_no_request_while_the_workspace_or_the_instance_has_unfurls_off` · `a_malformed_preview_request_is_a_400_before_any_fetch`.
- 억제(D21): 같은 파일의 `a_message_sent_with_suppress_unfurl_gets_no_cards_and_one_without_still_does`. 개발자 토큰(D16·D21): `messages.rs`의 `every_key_outside_the_allow_list_is_refused_as_dev_field_not_allowed`(새 키 `suppressUnfurl`)와 `dev_access.rs`의 `templates_off_the_table_are_refused`(새 경로 셋).
- 예산 설정(D20): `config.rs`의 `the_member_write_defaults_admit_ordinary_use_with_headroom`(기본값 60) · `the_member_write_env_names_move_exactly_their_own_field`(`RATE_LIMIT_UNFURL_PREVIEW_PER_MEMBER`), `rate_limit.rs`의 `the_limit_follows_the_surface_and_only_the_send_surface_tells_humans_from_agents` · `every_surface_has_its_own_label_and_its_own_key_space`(`unfurl_preview`).
- 코어 타입·디코더: `packages/momo-core`의 `unfurlPreview.test.ts`.
- 사보타주(가드 우회, 캐시 키의 테넌트·멤버 성분, 멤버 상한, 억제 분기, 환불, 스위치 확인, 443 규칙)는 각각 RED를 확인하고 되돌린다. 결과표는 PR 본문에 있다.
- 실제 외부 사이트를 대상으로 한 확인은 하지 않았다(`runtime-unverified`). 가짜 서버는 127.0.0.1이고 안전 규칙은 주입한 해석기와 가짜 소켓으로 시험한다. 화면은 이 증보의 범위가 아니다.

## 증보 2026-11-01 정오 — 미리보기 권한·응답 코드·예산 문장 바로잡기 (#5004)

- Status: **Accepted** (2026-11-01 planner — #4884 독립 보안 검수 1회차의 Medium·Low 후속 #5004. D14~D22의 문장 정정이라 결정 변경은 없다). **동작·공개 API·DB는 바뀌지 않는다.** 앞 증보(D14~D22, Accepted)의 문장 가운데 코드와 어긋난 곳을 코드 기준으로 바로잡고, 시험이 재지 못하던 줄을 재는 시험의 이름을 아래 「확인 [V]」에 더한다. D14~D22의 결정은 그대로다.
- 표기: [V] 이 세션에서 직접 확인(track/engine `de0790d67` 위) · `runtime-unverified` 실행하지 않음.

### 정오 1 (D16) — 사람이 아닌 자격은 자격마다 다른 코드를 받는다

D16의 「에이전트·작업 호스트 자격은 403이다」는 아래 표로 읽는다. 셋 다 **인증 미들웨어(문)에서** 끝나고 핸들러에 닿지 않는다.

| 자격 | 응답 | 이유 [V] |
|---|---|---|
| 에이전트 베어러 | 403 `agent bearer is not allowed for this route` | 에이전트 허용 표(`required_agent_scope`)에 이 경로가 없다 |
| 개발자 토큰 | 403 `dev_route_not_allowed` | 닫힌 표(`dev_route_scope`)에 없다(`dev_access.rs`의 `templates_off_the_table_are_refused`) |
| 작업 호스트 서명(`MomoHost`) | **401** `invalid work host request signature` | 서명으로 인증되는 경로는 `is_allowed_signed_path`에 적힌 작업 호스트 경로뿐이고, 나머지는 서명이 틀린 요청과 같은 401이다 |

핸들러의 `require_human`(403)은 이 셋을 지나온 비사람 주체를 위한 두 번째 겹이며 지금은 닿지 않는다. OpenAPI `createUnfurlPreview`의 「Who may ask」와 `403` 설명도 같이 고쳤다.

### 정오 2 (D16·D19) — 「활성 워크스페이스 멤버」가 성립하는 조건과 자리

- **조건**: `workspace_membership` 행이 있고, `member.status = 'active'`이며, `member.deleted_at`이 비어 있다(`momo_auth::active_workspace_role`). 역할은 따지지 않는다(게스트도 활성 멤버다). `status`가 `active`가 아닌 멤버(일시 중지·삭제·초대 중)와 삭제 표시가 있는 멤버는 `workspace_membership` 행이 남아 있어도 활성이 아니다.
- **POST 미리보기**는 이 조건을 **요청마다 DB로** 확인한다(첫 트랜잭션에서 채널 현재 멤버 확인과 함께, 하나라도 아니면 같은 403).
- **그림·아이콘 GET**(D19)은 DB로 확인하지 않는다. 정지·제거·탈퇴는 각각 그 멤버의 모든 토큰을 폐기하므로(`revoke_member_tokens_in_tx` — `momo_settings::membership_lifecycle`, 탈퇴는 `routes/workspaces.rs`) 그렇게 활성을 잃은 멤버는 문에서 401이고, 이 길 스스로 확인하는 것은 항목(워크스페이스·주인·수명)뿐이다. D19의 「활성 워크스페이스 멤버이고」는 이 뜻으로 읽는다. 토큰을 폐기하지 않고 `member` 행만 바꾼 상태(DB를 직접 고친 경우)에서는 그 멤버가 자기 미리보기의 그림·아이콘을 항목 수명(30분) 안에서 계속 받을 수 있다 — 남의 것은 받을 수 없고, 새 주소를 받아 오는 길도 아니다. 이 틈을 닫을지는 동작을 바꾸는 별도 결정이라 이 증보의 범위 밖이다. **planner 판단(2026-11-01)**: 닫지 않는다 — 정상 경로(정지·제거·탈퇴)는 토큰 폐기로 이미 닫히고, 남는 경우는 DB를 직접 고친 운영 실수뿐이며 자기 항목·30분으로 묶인다.

### 정오 3 (D18·D20) — 「DB에는 아무것도 쓰지 않는다」와 실패한 받기

- 미리보기의 **내용**(주소·카드·id)은 DB에 쓰지 않는다. 이 길이 만드는 행은 예산을 처음 넘긴 요청의 감사 행(`rate_limit.exceeded`, D20)뿐이다.
- **실패한 받기도 예산을 쓴다**: 서버가 바깥에 물었으므로 `failed`가 돼도 단위를 돌려주지 않는다. 돌려주는 것은 자리가 없던 요청뿐이다(D20). 실패는 2분 기억하므로(D18) 같은 주소를 그 사이에 다시 물으면 세지 않는다.

### 정오 4 (주석) — 「The one writer」

`message_unfurl_tombstone`에 행을 넣는 곳은 둘이다: `momo_unfurl::plant_tombstone_in_tx`(카드 제거와 보내기 억제 D21)와 `momo_workspace_actions::team_ai::withhold_link_previews_in_tx`(팀 AI 답, #3899 — 그 크레이트는 이 크레이트에 의존하지 않아 INSERT가 따로 있다). `remove.rs`의 「The one writer」 주석을 이 사실로 고쳤다. 열이 바뀌면 두 곳을 같이 고쳐야 하고, 하나로 합치는 것은 후속 후보다.

### 확인 [V] 더하기

시험 이름이 정본이다(PR 본문이 실행 결과를 적는다).

- 실패한 미리보기도 예산을 쓴다(D20, 환불을 넣으면 RED): `momo-server/tests/unfurl_conformance_pg.rs`의 `a_failed_preview_spends_the_budget_like_a_good_one`.
- 리디렉션 hop에서 이름이 사설 주소로 풀리면 그 hop은 연결하지 않는다(D17, 아이콘의 짝): `momo-unfurl/src/fetch.rs`의 `a_preview_redirect_to_a_name_that_resolves_inward_stops_after_the_public_hop`.
- 억제는 스레드 답글·인용에도 듣고, 답하거나 인용한 상대 메시지(남의 것일 수 있다)의 카드는 건드리지 않는다(D21): `unfurl_conformance_pg.rs`의 `suppress_unfurl_covers_a_thread_reply_and_a_quote_and_never_reaches_the_message_it_answers`.
- 활성이 아닌 멤버(정지·삭제·워크스페이스 멤버십 행 없음)는 채널에 남아 있어도 403이다(D16): `unfurl_conformance_pg.rs`의 `a_member_the_workspace_does_not_count_as_active_may_not_preview_from_a_channel_it_is_still_in`.
- 작업 호스트 서명은 미리보기 세 경로의 서명 허용 목록에 없어 401이다(D16): `momo-server/src/work_host_auth.rs`의 `the_link_preview_routes_are_not_signable_so_a_work_host_is_told_401_there`.
- 사보타주(실패에 환불 넣기, 리디렉션 hop의 답 검사 생략, 묘비를 한 모양에만 심기, 활성 확인 빼기, 서명 허용 목록에 미리보기 넣기)는 각각 RED를 확인하고 되돌렸다. 결과표는 PR 본문에 있다.
- 실제 외부 사이트를 대상으로 한 확인은 하지 않았다(`runtime-unverified`). 새 시험의 가짜 서버·가짜 이름 풀이는 시험이 주입한다.
