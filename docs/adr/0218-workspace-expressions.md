# ADR-0218: 팀 표현 보관함 — 한 등록으로 반응·본문·큰 그림, 에이전트 후보와 직접 올리기

> Status: Accepted — owner 2026-10-30 08:20 질문 창 결정 「이대로」와 GIF 사이트 단건 허용 결정(#4301). **D4의 영상 변환 절만 보류**다(owner 2026-10-30 「다음 이슈로 미루자」, #4819).
> Date: 2026-10-30
> Scope: #4301(S2 칸 6, base `track/engine`): 설계 S0 + 플랫폼 독립 코어 C1. 서버·웹·폰 구현은 #4676·#4677·#4678(S3).
> 증보: §7 (2026-10-30, #4820, **Accepted**) — AI와 만드는 움직이는 표현: 생성 출처의 원본 첨부 참조·서버 조립 계약·실패 사유·비용. 부록 B의 고정 JSON 블록은 바꾸지 않고, 스키마 변경은 §7의 델타를 구현 단계가 한 번에 합친다.
> Consumes: [ADR-0100](0100-decision-governance.md), [ADR-0137](0137-mobile-react-native-migration.md), [ADR-0151](0151-attachments-v0-drive-contract-port.md), [ADR-0170](0170-link-unfurl-server-surface.md), [ADR-0186 증보 v8](0186-agent-workspace-actions.md#증보-2026-10-30--팀-표현-행동-expressioncreate-v8-4301).

## 1. 결정의 근거와 범위

10-30 제안서의 S0·C1을 다음 owner 결정으로 고친 계약이다. 이전 10-27 안의 500개·종류 구분·외부 GIF 공급자 거절과 10-30 제안서의 스티커 전송 필드·스티커 반응 제외는 이 ADR로 대체한다.

1. 중심 흐름은 **에이전트 웹 검색/생성 → 후보 1~4개 → 사람이 실제 저장될 그림을 보고 하나 선택 → 팀 보관함 등록**이다. 그림 생성 비용은 각 에이전트 쪽이다. 호스팅 에이전트의 웹/이미지 도구를 켤 권한은 이 결정에 포함되지 않는다(ADR-0203).
2. GIPHY·Tenor 등 사이트에서 찾은 그림도 사람이 고른 한 장씩 허용한다. 대량 수집·공급자 API 검색·공급자 키·외부 미디어 직접 렌더는 없다. #4679와 제안서 §2-6·E4/W4/P4/Q4는 제거한다. 사이트 약관에 관한 법적 허용을 보증하는 결정은 아니다.
3. 못 받은 후보는 **출처 링크 + 「직접 올리기」**로 남는다. 다른 파일을 올리면 새 미리보기를 다시 보고 승인한다. 출처·신고 기록을 보존한다.
4. **한 등록이 반응(작게), 글 사이, 단독 전송(크게)**에 모두 쓰인다. 별도 `kind=sticker`가 없다. 패널의 이모지·스티커·우리 팀 GIF 탭은 같은 보관함의 표시/필터다.
5. 합쳐서 워크스페이스당 **1,000개**, 사람 멤버 누구나 추가(관리자가 관리자만으로 제한 가능), 만든 사람·관리자 삭제, 누구나 신고하면 즉시 숨김, 사람 얼굴은 당사자만 승인이다.

공개 문서와 기능 모양을 참고해 새로 설계했다. [Mattermost 라이선스](https://raw.githubusercontent.com/mattermost/mattermost/master/LICENSE.txt)는 서버 일반 부분을 AGPL/상용, `webapp/`·`server/public/` 등을 Apache-2.0 예외로 구분한다(10-30 확인). 이 변경은 어느 쪽 코드도 차용하지 않는다. [공식 이모지 문서](https://docs.mattermost.com/end-user-guide/collaborate/react-with-emojis-gifs.html)는 이름 토큰·커스텀 반응의 참고다.

## 2. 결정

### D1. 메시지 모델 (a)를 선택한다

| 모델 | 반응·큰 전송을 함께 쓰는 방법 | 비용과 선택 |
|---|---|---|
| **(a) 하나의 표현 + small/large 그림 + 본문 토큰** | 본문·반응 모두 `:name:`. 전체 본문이 표현 하나면 large를 쓴다 | **선택.** 전송 입력·서버 소유 props·seq/outbox 척추를 바꾸지 않는다. 기록의 정체성을 지키기 위해 canonical name을 영구 예약해야 한다 |
| (b) 같은 표현 + `sticker:{id}` 입력 + `momo.sticker` | 반응은 같은 id의 이름 토큰, 단독 전송은 id props와 `[스티커] 이름` 본문 | 기각. 이름 변경은 쉽지만 서버 전송/수정/푸시/검색/옛 클라이언트의 두 표현 길과 props 위조 차단을 모두 유지해야 한다. 같은 등록인데 전송할 때마다 다른 와이어를 고르는 비용이 크다 |

- **고정 이름** `name=[a-z0-9_-]{2,30}`: 콜론 둘까지 32자로 현행 반응 상한에 맞는다. 표준 이모지 정본의 모든 짧은 이름/별칭과 충돌하면 거절한다. S3는 #4322와 같은 정본으로 검사한다. 워크스페이스 안에서 삭제된 이름까지 유일하다. 이름 변경·재사용 API는 없다. 사람이 바꾸는 것은 `displayName`(≤40자)·태그뿐이다. 같은 id의 그림 교체도 없다. 다른 그림은 다른 이름의 새 등록이다.
- **본문·대체 본문**: 전송은 기존 메시지 요청의 `body: ":party_parrot:"`다. 새 `sticker` 필드·`momo.sticker`·표현 전용 props는 **0개**다. 저장 본문, 푸시, 검색 결과, 인용, 에이전트 읽기의 대체 본문은 모두 **원래 토큰 문자열 그대로**다. `[스티커] 표시 이름`으로 덮어쓰지 않는다. 옛 클라이언트도 뜻을 잃지 않는 읽을 수 있는 이름을 추천한다. 표시 이름 변경은 옛 본문/푸시/검색 인덱스를 바꾸지 않는다. 검색의 v1 계약은 원래 토큰/본문 검색이며 변경된 표시 이름으로 옛 메시지가 검색된다고 보장하지 않는다.
- **삭제·숨김·모르는 이름**: 등록/추가 반응 선택은 active만 가능하다. 옛 본문의 해당 토큰과 반응은 `:name:` 글자로 돌아간다. 지운 이름은 다른 그림에 연결되지 않는다. 서버는 일반 텍스트 전송의 모르는 토큰을 거절하지 않는다. 이미 달린 반응 제거는 숨김 뒤에도 가능하다. 새 커스텀 반응 추가는 같은 워크스페이스 active 이름만 받는다. 표준 유니코드 반응은 현행대로다.
- **편집**: 일반 텍스트 메시지의 기존 편집 규칙 그대로다. 토큰을 하나 지우거나 글을 더하면 렌더를 다시 계산한다. 서버가 소유한 스티커 블록이 없어서 별도 편집 금지가 필요 없다.
- **토큰화**: 대소문자 치환 없이 정확한 이름만 해석한다. 코드 span·fence·들여쓴 코드, 백슬래시로 이스케이프한 토큰, URL·autolink·링크 목적지는 해석하지 않는다. host의 Markdown 파서는 코드/링크 노드 안에서 다시 치환하지 않는다. 반응은 문자열 **전체**가 한 토큰일 때만 해석하고 공백을 trim하지 않는다.

| 본문(공백은 무시, 모르는 토큰은 글) | 크기 | 그림 |
|---|---|---|
| active 표현 하나뿐 | large: 폰 최대 160pt / 웹·데스크탑 200px, 말풍선 배경 없음 | large |
| 표현만 2~6개 | medium: 폰 48pt / 웹 64px | small |
| 7개 이상, 글/구두점/표준 이모지 등과 섞임, 표현 없음 | inline: 글자 높이 | small |
| 반응 | 20pt/px, 본문 크기 규칙과 독립 | small |

가로세로 비율은 보존한다. 격자·동작 줄이기·오프스크린은 thumb만 쓴다. 움직임은 총 4회 뒤 정지하고 탭으로 다시 시작한다. 서버 GIF도 총 4회 재생으로 인코딩한다(반복 횟수 메타 의미는 S3 디코더 시험으로 확인). 읽기 도우미는 `displayName` + 첫 태그를 읽는다. 큰 전송은 미리보기 → 한 번 더 탭/Enter로 보내며, 결과 카드 「보내기」는 현재 active id/name을 다시 확인한다.

### D2. 저장·RLS·원자성

다음은 **S3 migration 계약**이며 이 PR에 SQL/migration은 없다. 번호는 planner가 S3에 배정한다. 모든 신규 표는 `workspace_id NOT NULL`, `ENABLE/FORCE ROW LEVEL SECURITY`, `ws_isolation`, tx 시작의 `SET LOCAL app.workspace_id` 대상이다. 참조는 `(workspace_id,id)` 복합 FK다. 쓰기 역할에 BYPASSRLS를 주지 않는다.

| 표 | 정본 필드·제약 |
|---|---|
| `expression_catalog` | workspace PK, `version bigint >= 0`, `add_policy members|admins`. 변경 때 이 행을 `FOR UPDATE`하여 quota·이름·version을 직렬화 |
| `expression` | id·영구 유일 name·display_name·tags jsonb(≤8, 각 ≤16 Unicode scalar, 중복 없음)·subject_member_id?·origin_kind·source_url?·created_by(승인한 사람)·proposed_by?·approval_id?·created_at·status(active/hidden/deleted)·version·hidden_at?·deleted_at?. id/name/origin/승인 주체/바이트 포인터는 INSERT 뒤 불변 |
| `expression_image` | expression_id·variant(small/large/thumb)·mime·bytes bytea·sha256·width·height·frame_count·duration_ms. 바이트/해시/치수는 DB 트리거로 불변, blob을 metadata/list/outbox에 싣지 않음 |
| `expression_draft` | draft_id·동일 metadata·creator·approval_id?·candidate_index?·state(ready/manual_upload_required, 활성화 뒤 내부 상태 activated)·code?·revision·검사 후 그림 3벌과 해시·expires_at. 직접 활성화의 submitted_by/draft_id/revision/sha와 원래 Mutation receipt를 같은 행에 보존한다. activated는 wire Draft로 내보내지 않고 GET은 404, POST 재시도는 현재 인가 확인 뒤 저장 receipt를 반환한다. ready 그림은 불변. 교체는 새 그림 행/핀 + revision 증가, 이전 그림 제거를 한 tx에서 수행 |
| `expression_report` | id·expression_id·reporter_id·reason·detail?·created_at. 테넌트 RLS에 더해 현재 admin만 SELECT할 수 있는 정책/최소 권한 역할을 적용하며 일반 멤버는 신고 INSERT만 수행한다. 신고자·상세를 공개 목록에 싣지 않음 |

`active + hidden` 합계 ≤1,000(종류별 quota 없음). deleted는 개수에서 빠져도 최소 이름 tombstone은 영구 남는다. draft는 quota 밖이되 사람당 살아 있는 직접 업로드 draft ≤4, 에이전트는 기존 pending 제안 ≤3 × 후보 ≤4, 같은 decoder 동시 2 제한을 공유한다. 세 그림의 최악 합계는 등록당 1.5 MiB, 1,000개면 약 1.46 GiB(인덱스/MVCC/draft/백업 별도)이므로 S3 배포 전 팀 PG의 용량·복원 시간을 확인한다. 직접 draft TTL 1시간, 행동 draft는 기존 approval TTL을 따른다. 거절·만료·취소·승인 때 미선택 draft 바이트를 같은 tx에서 회수하며 TTL sweep도 회수한다. 직접 활성화의 compact receipt/이름 tombstone은 TTL sweep이 지우지 않는다. 활성화 후 draft의 원본/세 그림 바이트는 제거하고 expression_image만 유지한다. 카드의 출처·사유·결정 기록은 바이트와 별개로 남는다.

활성화/편집/삭제/신고 숨김/정책 변경 tx는 catalog version 증가 + 행 version + 감사 + outbox `expression.changed`를 함께 쓴다. 활성화는 이름 예약·quota·인증·정책·당사자·핀 재확인 후 수행한다. 영상/그림 디코드는 tx/행 락 밖에서 끝낸다. 메시지 전송은 현행 **REST → channel_seq + message + outbox 단일 tx → relay → Centrifugo** 그대로다. 이모지 직접 publish는 없다.

### D3. 이미지 규격·서빙

| 단계 | 제한 |
|---|---|
| 입력 | 업로드·첨부·링크 모두 ≤5 MiB, 생성 base64 디코드 후 ≤1 MiB(문자열 ≤1,398,104). MIME/확장자를 믿지 않고 매직/완전 디코드로 판정 |
| 정지 입력 | PNG·JPEG·정지 WebP·단일 프레임 GIF. 한 변 ≤4096, 총 ≤16,000,000 px, 0/파싱 실패 거절. APNG·움직이는 WebP·SVG·HEIC/HEIF·AVIF 거절 |
| GIF 입력 | GIF, canvas ≤512×512, ≤100프레임, 전체 디코드 픽셀 ≤32,000,000, 총 재생 길이 ≤10초, 프레임 지연 ≥20ms(더 작은 지연은 20ms로 정규화 후 총 길이 검사). 첫 프레임만 검사하고 통과시키지 않음 |
| small | 정지 PNG 또는 GIF, 긴 변 ≤128, ≤256 KiB, 확대 안 함 |
| large | 정지 PNG 또는 GIF, 긴 변 ≤512, ≤1 MiB, 확대 안 함 |
| thumb | 정지 PNG 첫 합성 장면, 긴 변 ≤128, ≤256 KiB |
| 디코더 | 전 출처 공통 semaphore 2, 작업당 할당 상한 192 MiB, 벽시계 10초, 프레임은 순차 합성·축소·인코딩, 무제한 `collect_frames` 금지. 타임아웃 뒤 계속 도는 blocking 작업이 semaphore를 놓지 않도록 종료/동시성 시험 |

정지·움직임 모두 **픽셀에서 새로 인코딩**한다. GIF disposal/transparency를 합성한 뒤 두 크기를 만들고 첫 합성 장면을 thumb로 만든다. 원본/EXIF/ICC/주석/꼬리 바이트·원래 링크를 그림 주소로 제공하지 않는다. 결과 초과는 조용히 프레임을 자르거나 다른 그림으로 바꾸지 않고 실패 카드로 남긴다. `image` 크레이트의 GIF feature 및 전이 의존은 permissive 라이선스 검증·NOTICE 귀속을 S3에서 한다. 현행 서버는 png/jpeg/webp만 켜져 있다.

그림 경로는 항상 워크스페이스 멤버 bearer + active 검사 + variant별 정확한 sha 검사다. 숨김/삭제/타 테넌트/틀린 sha/비멤버는 동일 404. `Content-Type`은 저장 MIME, `nosniff`, `CSP: default-src 'none'; sandbox`, **`Cache-Control: private, no-store`**. 인증된 앱 메모리 캐시만 허용하고 logout/계정·워크스페이스 전환/숨김·삭제 이벤트/재연결 전체 갱신 때 디코드 중인 것도 폐기한다. offline에서는 문자열/정지 자리표시만 쓴다. 네트워크가 끊긴 화면까지 즉시 회수할 수 있다고 주장하지 않는다. 웹·Tauri는 bearer로 받아 data URL, 폰은 세션 범위의 임시 파일을 쓰며 공개 미인증 URL·CSP 확장은 없다.

### D4. 짧은 영상 처리 — **보류 (owner 2026-10-30, #4819)**

owner가 2026-10-30에 영상→GIF 변환을 다음 이슈로 미뤘다(「지금은 조금 과할거같아서」). 그때까지 영상 입력은 `video_processing_unavailable` 카드로 끝나고 출처 링크와 GIF 직접 올리기를 안내한다. 움직이는 그림은 GIF로 직접 올리거나 에이전트가 GIF로 만들어 제안한다(#4820). 아래 비교와 고정 처리 계약은 #4819를 다시 열 때의 출발점이다.

| 경로 | 장점 | 비용·판정 |
|---|---|---|
| **(a) 서버에서 GIF로 변환** | 링크로 찾은 영상·폰 업로드도 같은 3벌을 만들고 반응/격자/큰 전송 모두 기존 Image 경로로 표시 | **다시 열 때의 첫 후보(보류, #4819).** 새 서버 영상 디코더 공격면과 FFmpeg 배포 라이선스 승인이 필요 |
| (b) 무음 반복 영상 보존 | 압축 효율이 높음, 웹 video로 재생 가능 | 폰에 영상 재생 의존성이 없음(`expo-video` 등 추가 시 라이선스·Pod/네이티브 빌드 영향), 반응마다 video 플레이어, 서버 thumb 추출에는 결국 디코더 필요. 기각 |
| (c) 올리는 기기에서 변환 | 웹·데스크탑 canvas + [gifenc(MIT)](https://raw.githubusercontent.com/mattdesl/gifenc/master/LICENSE.md) 같은 permissive 인코더 가능 | 폰은 별도 네이티브 프레임 추출, 브라우저 코덱 차이·CORS·기기 자원 한도. 에이전트 URL 영상은 서버가 못 처리하므로 사람이 받아 다시 변환해야 한다. 중심 흐름이 기기마다 달라져 기각 |

[FFmpeg 공식 라이선스](https://ffmpeg.org/legal.html)(10-30 확인)는 기본 LGPL-2.1-or-later, 선택한 구성에 따라 GPL 적용이라고 설명한다. **별도 실행 파일로 호출해도 이미지에 실어 배포하는 의무는 없어지지 않는다.** 현행 `deny.toml` 허용 목록에 LGPL/GPL이 없으며 `NOTICE`의 OS-layer copyleft 인벤토리는 새 앱 기능 의존의 승인이 아니다. 이 PR은 FFmpeg 설치·정책 파일·NOTICE를 바꾸지 않는다. owner가 배포 구성/의무와 정책 예외를 승인하기 전 **영상 디코더를 실행하지 않는다**. S3는 `video_processing_unavailable` 카드와 GIF 직접 올리기를 먼저 구현할 수 있다. 이 절의 보류를 전체 기능 Accepted로 덮어 승인했다고 해석하지 않는다.

승인 뒤의 고정 처리 계약: 입력 MP4/MOV(H.264), WebM(VP8/VP9) ≤5 MiB·≤5초·가로세로 ≤1280·총 ≤921,600 px·≤30fps·≤150프레임. 오디오는 버리고 10fps 이하 GIF로 두 크기와 thumb를 만든다. D3 출력 한도를 똑같이 적용하며 초과/코덱 미지원은 카드에 남긴다. 사전 probe 역시 격리 안에서 한다. 셸 문자열 보간 없이 고정 인수·고정 바이너리·인코더 목록, 외부 URL을 디코더에 주지 않고 가드로 받은 로컬 파일만 입력한다. 전용 비권한 프로세스, network 없음, 읽기 전용 root, 전용 임시 디렉터리 32 MiB, RSS 256 MiB, CPU 5초/벽시계 10초, 동시 1(공통 semaphore에도 포함), 하위 프로세스 포함 강제 종료·파일 회수·환경/시크릿 미전달이 필수다. 파이프/playlist/외부 참조·임의 프로토콜은 거절한다. `--enable-gpl`·`--enable-nonfree`를 쓰지 않는 구성을 검토하되 이것만으로 permissive라고 부르지 않는다. 실제 변환·격리·라이선스·자원 실측은 **runtime-unverified**다.

### D5. 링크 가져오기·출처·받기 실패

HTTPS만 받는다. `momo-unfurl`의 URL/공인 IP 검증·모든 DNS 응답 검사·연결 IP pin·redirect ≤3 매 hop 재검사·전체 요청 5초·스트리밍 5 MiB 상한을 재사용한다. 현행 transport의 timeout이 hop별이면 외부에 5초 deadline을 한 번 더 둔다. 쿠키·멤버 bearer·임의 헤더·referer를 외부에 전달하지 않는다. 새 downloader로 가드를 복제하거나 HTML 속 미디어 링크를 따라 탐색하지 않는다. GIPHY/Tenor/KLIPY라는 이유로 거절하지 않는다. 사이트 페이지 HTML이 오면 `source_unsupported`로 남겨 사람이 원본 파일을 올리게 한다. agent가 받은 redirect/HTML 속 지시를 시스템 지시로 실행하지 않는다.

`origin.sourceUrl`은 사람이 고른 원래 공개 출처의 HTTPS host/path다. userinfo·query·fragment는 저장/감사/카드에서 제거한다. credential 포함 입력은 거절하며 query는 fetch 수명 안에서만 쓸 수 있다. 처음부터 내부/사설 목적지인 입력은 400으로 거절한다. 공개 원본에서 차단된 redirect를 따라가지 못한 경우는 안전한 원래 공개 링크를 유지한 `source_blocked` 카드로 남긴다. 주소는 텍스트 링크로만 열고(외부 브라우저 확인), 그림 src로 쓰지 않는다. 카드 라벨은 서버가 파싱한 도메인, 이름/태그/생성 prompt는 에이전트가 쓴 글임을 표시한 평문이다. 실패나 직접 업로드로 바뀌어도 출처를 `upload`로 세탁하지 않는다. source 입력 원문이나 URL query를 로그/감사/outbox에 남기지 않는다.

### D6. 권리·얼굴·신고

- 등록 화면에 저장 권한 확인, 출처, 사람 얼굴 여부를 명시한다. `subjectMemberId:null`은 **사람 얼굴 없음이라는 제출자 선언**이다. 얼굴이 있으면 한 명의 워크스페이스 사람 멤버를 지정하고 **그 당사자 AND 현재 추가 정책 충족자**만 승인한다. admin 대리 승인은 없다. 여러 사람·당사자 미확인·비멤버 얼굴은 v1에서 등록하지 않는다. 직접 올리기도 같은 규칙이다. 얼굴 탐지/인식이나 외부 자동 심사 API는 없다. 누락 선언을 기술로 검증한다고 주장하지 않으며 신고 즉시 숨김으로 보완한다.
- 모든 사람 멤버(게스트 포함)의 신고 `copyright|face|other`를 받는 tx에서 즉시 hidden으로 바꾸고 그림 GET·고르개·캐시에서 제거한다. 신고 내용/신고자 공개 금지, 관리자 검토 전 자동 복구 없음. 멤버 밖의 권리자는 공지된 수령인에게 연락할 수 있어야 한다. 수령·권리자/등록자 통지·재개 요구·분쟁 처리 기록은 운영자가 관리하며, 재개가 필요하면 권리 확인 절차 뒤 별도 후속 계약으로 다룬다.
- [저작권법 제103조](https://www.law.go.kr/법령/저작권법/제103조)의 중단/통지/재개와 수령인 지정·공지를 따른다. [시행령 제44조](https://www.law.go.kr/법령/저작권법시행령/제44조)의 수령인 성명·부서·전화·팩스·이메일·우편 주소는 서비스에서 쉽게 찾을 수 있게 공지한다. 공개 서비스 활성화 전 운영자가 실제 수령인을 설정하고 등록/관리/신고 화면에서 그 공지로 이동할 수 있어야 한다. 신고 숨김 구현만으로 면책 요건 충족을 주장하지 않는다. 조문은 korean-law-mcp에서 10-30 현행 저작권법 MST 285693·시행령 291497로 확인했다.
- [개인정보 보호법 시행령 제18조](https://www.law.go.kr/법령/개인정보보호법시행령/제18조)(MST 289537)에서 식별 목적의 기술적 신체 특징 정보를 민감정보로 다룬다. 이 설계는 그런 식별 정보를 만들지 않는다. 얼굴 동의·출처·신고는 권리 판단의 증거이며 이용허락 자체를 대신하지 않는다.
- 감사는 staged/created/updated/deleted/reported/hidden·결정 주체·출처 kind/domain·approval id·해시 prefix·사유 코드만 담고 바이트·base64·prompt·원본 URL/신고 상세를 싣지 않는다. 상세 열람은 현재 admin만 허용한다.

## 3. 부록 A — 고정 REST / OpenAPI 조각

아래 표·스키마·JSON은 엔진/웹/폰 동시 구현의 정본이다. 경로의 `{ws}`는 UUID다. 그림·목록은 현재 워크스페이스 멤버 bearer, 쓰기는 사람 bearer(게스트 추가 불가), 정책/할당/당사자 판정은 매 결정 tx에서 다시 한다. 에이전트는 이 REST로 직접 등록하지 않고 ADR-0186 행동으로만 제안한다. 기존 엔드포인트/메시지 DTO의 다른 필드는 그대로다.

**운반 예산**: 생성 후보당 디코드 ≤1 MiB/base64 ≤1,398,104자, 후보 합계 디코드 ≤4 MiB, `expression.create` 제안의 **전체 UTF-8 JSON/RPC 요청 ≤6 MiB**다(단순 args만이 아닌 envelope 포함). 직접 multipart도 file 5 MiB + metadata를 포함해 요청 ≤6 MiB다. 현행 `momo-mcp`는 전체 64 KiB·dataBase64 58,700자(아바타 예외)를 검사하므로 레지스트리 추가만으로 새 후보를 운반할 수 없다. S3 엔진은 MCP/CLI bridge/Agent Port/propose HTTP body limit·문자열 검사·중계·원장 저장을 **expression.create에만** 이 예산으로 연결한다. 대상에는 `momo-mcp/src/lib.rs`의 parse 전 검사, `oort-cli/src/mcp.rs`의 64 KiB 줄 상한, `oort-cli/tests/wire_constants.rs`의 동등성 계약, `routes/agent_port.rs`의 `to_bytes` cap도 포함된다. 기존 행동의 64 KiB/기존 문자열 예산은 유지하고 다른 행동이나 알 수 없는 필드에 base64를 숨겨 한도를 넓힐 수 없게 한다. 인증·scope 검사를 대형 바이트 수집 전에 수행하고 스트리밍/파서 단계 전체 6 MiB cap은 항상 적용한다. 1 MiB 후보 4개의 실제 왕복, 5번째·base64/전체 cap 초과·다른 행동으로 위장한 요청을 거절하는 회귀/사보타주가 S3 수용기준이다.


| method / `/v1/workspaces/{ws}` 뒤 경로 | 요청 → 응답 | 상태·권한 |
|---|---|---|
| `GET /expressions?since=<version>` | `List` | 200. since 없음/너무 옛 version은 full reset; 현재 since는 빈 delta 가능 |
| `POST /expressions/uploads` | multipart `metadata: Metadata` JSON + `file` → `Draft` | 201 ready, 영상 미지원/변환 실패는 200 manual. 추가 가능자 |
| `POST /expressions/import` | `ImportRequest` → `Draft` | 201 ready / **200 manual_upload_required**. 추가 가능자 |
| `POST /expressions/from-attachment` | `AttachmentRequest` → `Draft` | 201/200. `channelId`의 현재 멤버이며 그 채널에 본인이 올린 완료·미삭제 첨부만(다른 사람/대화/없는 id는 동일 404). 행동은 요청 필드 대신 서버 run_channel을 사용 |
| `GET /expression-drafts/{draftId}` | → `Draft` | 200, 제출자 또는 그 승인을 결정할 수 있는 사람. 만료 410 |
| `PUT /expression-drafts/{draftId}/file` | multipart `file` → `Draft` | 200 새 revision. 미리보기 교체; 출처/이름/당사자/TTL 불변. 에이전트는 호출 불가 |
| `GET /expression-drafts/{draftId}/image?size=small|large|thumb&v=<sha>` | → 저장 MIME bytes | 200. 직접 draft 제출자, 행동 draft는 결정 가능자/제안자만; 같은 404. 해시 불일치 404 |
| `POST /expressions` | `Choice` → `Mutation` | 201. 직접 draft만 활성화, 행동 draft는 기존 승인 decision 경로만. 핀/정책 재검증 |
| `GET /expressions/{id}/image?size=small|large|thumb&v=<sha>` | → 저장 MIME bytes | 200 또는 동일 404, no-store |
| `PATCH /expressions/{id}` | `Patch` → `Mutation` | 200. 만든 사람·관리자, 이름/바이트 교체 불가 |
| `DELETE /expressions/{id}` | 없음 → `Mutation` | 200 tombstone, 만든 사람·관리자, 멱등 |
| `POST /expressions/{id}/report` | `ReportRequest` → `Mutation` | 200 hidden, 사람 멤버·게스트, 이미 hidden/deleted면 상태 악화/복원 없이 멱등 |

`version`/`revision`은 **10진 bigint 문자열**이다. timestamp는 UTC epoch milliseconds, 모든 길이는 Unicode scalar 수다. full 목록은 active만 최대 1,000개; delta는 요청 since보다 큰 **최신 행**(hidden/deleted 포함)을 최대 1,000개 싣고 초과하면 full reset한다. delta의 baseVersion은 요청 since와 정확히 같다. catalog 조회는 같은 snapshot에서 version과 items를 읽는다. 정책 변경도 version을 올리고 List.addPolicy로 전파한다. 이 v1은 정책 편집 UI/API를 만들지 않고 운영자 설정으로 바꾸되 catalog tx를 거친다. 보관함 모음·서버 즐겨찾기·팀 인기 집계는 후속이며 이 부록에 섞지 않는다.

현행 일반 워크스페이스 이벤트 rail은 없으므로 **새 `expressions:ws<UPPERCASE_WORKSPACE_UUID>` namespace**로 `Changed` 객체를 `BroadcastPayload.data`에 싣는다. `subscribe_proxy_enabled=true`, client publish/history/presence/join-leave는 전부 false다. 연결 credential의 liveness/테넌트를 재검증하고 현재 active 워크스페이스 멤버(사람·에이전트·게스트)의 읽기만 허용한다. 강제 퇴장/logout 때 기존 구독도 끊는다. `online:` presence 목적을 바꾸지 않고 `channel_seq`도 올리지 않는다. 서버만 outbox→relay로 publish하며 idempotency key는 `expression:<ws>:<version>`이다. S3 엔진은 parser/subscribe proxy와 Centrifugo 설정 추가를 함께 인계하고 실제 두 테넌트 구독 거절을 시험한다. 클라이언트는 최신 version을 보더라도 local version을 먼저 올리지 않고 since 요청으로 따라간다. 응답 base가 어긋나면 full 재조회, 늦게 온 낮은 version은 버린다. 숨김/삭제 delta를 적용할 때 이미지 캐시를 폐기한다. 재연결은 full부터 시작하고 계정/워크스페이스가 바뀌면 metadata·사용 기록·이미지 캐시를 분리한다.

에러는 기존 error 봉투에 이 경로용 `code`를 더한 `{ "error": {"code":"expression_preview_stale","message":"…"} }`다. 인증 401, 추가 역할/당사자 불충족 403 `expression_role_required`, 비존재/테넌트/인가 감춤 404 `not_found`, malformed 입력 400 `expression_invalid`, 이름 예약/quota/stale pin 409 `expression_name_reserved|expression_quota|expression_preview_stale`, TTL 410 `expression_draft_expired`, 직접 올린 비영상의 크기/형식 실패 413/415 `expression_media_invalid`다. **외부 fetch의 크기·형식·시간·HTTP 차단은 이 에러로 끝내지 않고 Draft manual로 반환**한다. 인가/문법적으로 잘못된 URL은 fetch 전에 400이며 공개 원본의 redirect 가드 거절은 안전한 원래 공개 출처만 가진 manual 카드다. 처음부터 사설 목적지인 URL은 400이다.

```yaml
openapi: 3.1.0
info: {title: oort expressions contract fragment, version: '1'}
components:
  parameters:
    ws: {in: path, name: ws, required: true, schema: {type: string, format: uuid}}
    id: {in: path, name: id, required: true, schema: {type: string, format: uuid}}
    draftId: {in: path, name: draftId, required: true, schema: {type: string, format: uuid}}
    size: {in: query, name: size, required: true, schema: {type: string, enum: [small, large, thumb]}}
    v: {in: query, name: v, required: true, schema: {type: string, pattern: '^[a-f0-9]{64}$'}}
  securitySchemes:
    bearerAuth: {type: http, scheme: bearer}
  schemas:
    Expression: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/Expression'}
    List: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/List'}
    Metadata: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/Metadata'}
    Draft: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/Draft'}
    ImportRequest: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/ImportRequest'}
    AttachmentRequest: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/AttachmentRequest'}
    Choice: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/Choice'}
    Mutation: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/Mutation'}
    Patch: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/Patch'}
    ReportRequest: {$ref: '../../packages/momo-core/src/features/expressions/contracts.schema.json#/$defs/ReportRequest'}
security: [{bearerAuth: []}]
paths:
  /v1/workspaces/{ws}/expressions:
    parameters: [{$ref: '#/components/parameters/ws'}]
    get:
      parameters: [{in: query, name: since, schema: {type: string, pattern: '^(0|[1-9][0-9]*)$'}}]
      responses: {'200': {description: Full or delta, content: {application/json: {schema: {$ref: '#/components/schemas/List'}}}}}
    post:
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/Choice'}}}}
      responses: {'201': {description: Registered, content: {application/json: {schema: {$ref: '#/components/schemas/Mutation'}}}}}
  /v1/workspaces/{ws}/expressions/uploads:
    parameters: [{$ref: '#/components/parameters/ws'}]
    post:
      requestBody:
        required: true
        content:
          multipart/form-data:
            schema: {type: object, additionalProperties: false, required: [metadata, file], properties: {metadata: {$ref: '#/components/schemas/Metadata'}, file: {type: string, format: binary}}}
            encoding: {metadata: {contentType: application/json}}
      responses: {'201': {description: Ready draft, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}, '200': {description: Manual upload required, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}}
  /v1/workspaces/{ws}/expressions/import:
    parameters: [{$ref: '#/components/parameters/ws'}]
    post:
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/ImportRequest'}}}}
      responses: {'201': {description: Ready draft, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}, '200': {description: Keep source link and upload control, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}}
  /v1/workspaces/{ws}/expressions/from-attachment:
    parameters: [{$ref: '#/components/parameters/ws'}]
    post:
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/AttachmentRequest'}}}}
      responses: {'201': {description: Ready draft, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}, '200': {description: Video unavailable, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}}
  /v1/workspaces/{ws}/expression-drafts/{draftId}:
    parameters: [{$ref: '#/components/parameters/ws'}, {$ref: '#/components/parameters/draftId'}]
    get:
      responses: {'200': {description: Current draft, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}}
  /v1/workspaces/{ws}/expression-drafts/{draftId}/file:
    parameters: [{$ref: '#/components/parameters/ws'}, {$ref: '#/components/parameters/draftId'}]
    put:
      requestBody: {required: true, content: {multipart/form-data: {schema: {type: object, additionalProperties: false, required: [file], properties: {file: {type: string, format: binary}}}}}}
      responses: {'200': {description: New revision, content: {application/json: {schema: {$ref: '#/components/schemas/Draft'}}}}}
  /v1/workspaces/{ws}/expression-drafts/{draftId}/image:
    parameters: [{$ref: '#/components/parameters/ws'}, {$ref: '#/components/parameters/draftId'}, {$ref: '#/components/parameters/size'}, {$ref: '#/components/parameters/v'}]
    get:
      responses: {'200': {description: Pinned authenticated draft bytes, content: {image/png: {schema: {type: string, format: binary}}, image/gif: {schema: {type: string, format: binary}}}}}
  /v1/workspaces/{ws}/expressions/{id}/image:
    parameters: [{$ref: '#/components/parameters/ws'}, {$ref: '#/components/parameters/id'}, {$ref: '#/components/parameters/size'}, {$ref: '#/components/parameters/v'}]
    get:
      responses: {'200': {description: Active authenticated bytes, content: {image/png: {schema: {type: string, format: binary}}, image/gif: {schema: {type: string, format: binary}}}}}
  /v1/workspaces/{ws}/expressions/{id}:
    parameters: [{$ref: '#/components/parameters/ws'}, {$ref: '#/components/parameters/id'}]
    patch:
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/Patch'}}}}
      responses: {'200': {description: Metadata updated, content: {application/json: {schema: {$ref: '#/components/schemas/Mutation'}}}}}
    delete:
      responses: {'200': {description: Deleted tombstone, content: {application/json: {schema: {$ref: '#/components/schemas/Mutation'}}}}}
  /v1/workspaces/{ws}/expressions/{id}/report:
    parameters: [{$ref: '#/components/parameters/ws'}, {$ref: '#/components/parameters/id'}]
    post:
      requestBody: {required: true, content: {application/json: {schema: {$ref: '#/components/schemas/ReportRequest'}}}}
      responses: {'200': {description: Immediately hidden, content: {application/json: {schema: {$ref: '#/components/schemas/Mutation'}}}}}
```

## 4. 부록 B — 고정 JSON Schema / props / 행동

아래 `expression-contracts-v1` JSON은 [코어 스키마](../../packages/momo-core/src/features/expressions/contracts.schema.json)와 JSON 값이 정확히 같다. `verify-contract.mjs`가 ADR 자체를 읽어 동등성을 검사하고 `contracts.test.ts`가 fixture의 양/음성 스키마 단정을 검사한다. JSON Schema 구조 외에 D1~D6의 RLS·핀·동일 주체·정책·시간·상태 전이 제약은 서버가 강제한다.

<!-- expression-contracts-v1:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:oort:expressions:v1",
  "$defs": {
    "Metadata": {"type":"object","additionalProperties":false,"required":["name","displayName","tags","subjectMemberId"],"properties":{"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]}}},
    "Origin": {"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt"],"properties":{"kind":{"const":"url"},"sourceUrl":{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},"prompt":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt"],"properties":{"kind":{"enum":["upload","attachment"]},"sourceUrl":{"oneOf":[{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},{"type":"null"}]},"prompt":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt"],"properties":{"kind":{"const":"generated"},"sourceUrl":{"oneOf":[{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},{"type":"null"}]},"prompt":{"type":"string","minLength":1,"maxLength":2000}}}]},
    "SmallImage": {"oneOf":[{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/png"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":262144},"width":{"type":"integer","minimum":1,"maximum":128},"height":{"type":"integer","minimum":1,"maximum":128},"frameCount":{"const":1},"durationMs":{"const":0}}},{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/gif"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":262144},"width":{"type":"integer","minimum":1,"maximum":128},"height":{"type":"integer","minimum":1,"maximum":128},"frameCount":{"type":"integer","minimum":2,"maximum":100},"durationMs":{"type":"integer","minimum":20,"maximum":10000}}}]},
    "LargeImage": {"oneOf":[{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/png"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":1048576},"width":{"type":"integer","minimum":1,"maximum":512},"height":{"type":"integer","minimum":1,"maximum":512},"frameCount":{"const":1},"durationMs":{"const":0}}},{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/gif"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":1048576},"width":{"type":"integer","minimum":1,"maximum":512},"height":{"type":"integer","minimum":1,"maximum":512},"frameCount":{"type":"integer","minimum":2,"maximum":100},"durationMs":{"type":"integer","minimum":20,"maximum":10000}}}]},
    "ThumbImage": {"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/png"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":262144},"width":{"type":"integer","minimum":1,"maximum":128},"height":{"type":"integer","minimum":1,"maximum":128},"frameCount":{"const":1},"durationMs":{"const":0}}},
    "Media": {"type":"object","additionalProperties":false,"required":["small","large","thumb"],"properties":{"small":{"$ref":"#/$defs/SmallImage"},"large":{"$ref":"#/$defs/LargeImage"},"thumb":{"$ref":"#/$defs/ThumbImage"}}},
    "Expression": {"oneOf":[{"type":"object","additionalProperties":false,"required":["id","workspaceId","name","displayName","tags","subjectMemberId","version","origin","createdBy","createdAtMs","status","media"],"properties":{"id":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"origin":{"$ref":"#/$defs/Origin"},"createdBy":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"createdAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"status":{"const":"active"},"media":{"$ref":"#/$defs/Media"}}},{"type":"object","additionalProperties":false,"required":["id","workspaceId","name","displayName","tags","subjectMemberId","version","origin","createdBy","createdAtMs","status","media"],"properties":{"id":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"origin":{"$ref":"#/$defs/Origin"},"createdBy":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"createdAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"status":{"enum":["hidden","deleted"]},"media":{"type":"null"}}}]},
    "List": {"oneOf":[{"type":"object","additionalProperties":false,"required":["workspaceId","version","addPolicy","items","reset","baseVersion"],"properties":{"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"addPolicy":{"enum":["members","admins"]},"items":{"type":"array","minItems":0,"maxItems":1000,"items":{"$ref":"#/$defs/Expression"}},"reset":{"const":true},"baseVersion":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["workspaceId","version","addPolicy","items","reset","baseVersion"],"properties":{"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"addPolicy":{"enum":["members","admins"]},"items":{"type":"array","minItems":0,"maxItems":1000,"items":{"$ref":"#/$defs/Expression"}},"reset":{"const":false},"baseVersion":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"}}}]},
    "Draft": {"oneOf":[{"type":"object","additionalProperties":false,"required":["draftId","workspaceId","revision","name","displayName","tags","subjectMemberId","origin","expiresAtMs","state","code","media"],"properties":{"draftId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"revision":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"origin":{"$ref":"#/$defs/Origin"},"expiresAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"state":{"const":"ready"},"code":{"type":"null"},"media":{"$ref":"#/$defs/Media"}}},{"type":"object","additionalProperties":false,"required":["draftId","workspaceId","revision","name","displayName","tags","subjectMemberId","origin","expiresAtMs","state","code","media"],"properties":{"draftId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"revision":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"origin":{"$ref":"#/$defs/Origin"},"expiresAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"state":{"const":"manual_upload_required"},"code":{"enum":["source_blocked","source_unavailable","source_too_large","source_unsupported","source_timeout","source_invalid_media","video_processing_unavailable","video_conversion_failed"]},"media":{"type":"null"}}}]},
    "ImportRequest": {"type":"object","additionalProperties":false,"required":["name","displayName","tags","subjectMemberId","url"],"properties":{"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"url":{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://[^\\s/@#]+(?:/[^\\s#]*)?$"}}},
    "AttachmentRequest": {"type":"object","additionalProperties":false,"required":["name","displayName","tags","subjectMemberId","attachmentId","channelId"],"properties":{"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"attachmentId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"channelId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}},
    "Choice": {"type":"object","additionalProperties":false,"required":["draftId","revision","sha256"],"properties":{"draftId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"revision":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"}}},
    "Mutation": {"type":"object","additionalProperties":false,"required":["workspaceId","version","expression"],"properties":{"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"expression":{"$ref":"#/$defs/Expression"}}},
    "Patch": {"type":"object","additionalProperties":false,"required":[],"properties":{"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true}},"minProperties":1},
    "ReportRequest": {"type":"object","additionalProperties":false,"required":["reason"],"properties":{"reason":{"enum":["copyright","face","other"]},"detail":{"type":"string","minLength":0,"maxLength":500}}},
    "AgentImage": {"oneOf":[{"type":"object","additionalProperties":false,"required":["source","attachmentId"],"properties":{"source":{"const":"attachment"},"attachmentId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}},{"type":"object","additionalProperties":false,"required":["source","url"],"properties":{"source":{"const":"url"},"url":{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://[^\\s/@#]+(?:/[^\\s#]*)?$"}}},{"type":"object","additionalProperties":false,"required":["source","mime","dataBase64","prompt"],"properties":{"source":{"const":"generated"},"mime":{"enum":["image/png","image/jpeg","image/gif","image/webp"]},"dataBase64":{"type":"string","minLength":4,"maxLength":1398104,"pattern":"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"},"prompt":{"type":"string","minLength":1,"maxLength":2000}}}]},
    "AgentCandidate": {"type":"object","additionalProperties":false,"required":["name","displayName","tags","subjectMemberId","image"],"properties":{"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"image":{"$ref":"#/$defs/AgentImage"}}},
    "AgentAction": {"type":"object","additionalProperties":false,"required":["action","args"],"properties":{"action":{"const":"expression.create"},"args":{"type":"object","additionalProperties":false,"required":["candidates"],"properties":{"candidates":{"type":"array","minItems":1,"maxItems":4,"items":{"$ref":"#/$defs/AgentCandidate"}}}}}},
    "Approval": {"type":"object","additionalProperties":false,"required":["v","candidates"],"properties":{"v":{"const":1},"candidates":{"type":"array","minItems":1,"maxItems":4,"items":{"$ref":"#/$defs/Draft"}}}},
    "Decision": {"type":"object","additionalProperties":false,"required":["expressionChoice"],"properties":{"expressionChoice":{"$ref":"#/$defs/Choice"}}},
    "Result": {"type":"object","additionalProperties":false,"required":["id","name","token"],"properties":{"id":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"token":{"type":"string","minLength":4,"maxLength":32,"pattern":"^:[a-z0-9_-]{2,30}:$"}}},
    "MessageInput": {"type":"object","additionalProperties":false,"required":["body"],"properties":{"body":{"type":"string","minLength":4,"maxLength":32,"pattern":"^:[a-z0-9_-]{2,30}:$"}}},
    "Changed": {"type":"object","additionalProperties":false,"required":["type","workspaceId","version"],"properties":{"type":{"const":"expression.changed"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"}}}
  }
}
```
<!-- expression-contracts-v1:end -->

`MessageInput`은 기존 SendMessageRequest 중 이 기능이 쓰는 body만 보인 투영이다. 전송 요청의 다른 기존 필드를 금지하는 스키마가 아니다. **메시지 props 스키마: 표현 추가 키 없음**. `Approval`은 기존 `approval_request.props.action.expression`, `Result`는 기존 `props.result.expression`에만 들어간다. 승인 외 일반 메시지에 클라가 이 블록을 주어 신뢰 카드를 만들 수 없다. `AgentAction`은 `expression.create` 한 종류, 기존 `oort_action_propose`/workspace-action transport가 action/args를 감싼다. 위험 등급·원장·멱등성·run park는 ADR-0186 그대로다.

## 5. 부록 C — 승인·결과 카드와 받기 실패 상태

| 상태/코드 | 서버 카드·화면 | 결정/교체 |
|---|---|---|
| `ready`, code=null | 서버 그림(large) + 이름/태그 + 출처 도메인/링크 + 생성 prompt(있을 때, 에이전트 글 표시) | 1~4개 중 **하나** 선택. 선택한 draftId/revision/large sha를 함께 보냄 |
| `manual_upload_required` / `source_blocked` | 접근/리다이렉트/SSRF 가드 거절, 그림 없음 | 출처 링크 + **직접 올리기**, 승인 불가 |
| 같은 state / `source_unavailable` | DNS/접속/404/429/5xx 등 받기 실패 | 같음. 자동 재수집/무한 retry 없음 |
| 같은 state / `source_too_large` | Content-Length 또는 스트림 5 MiB 초과 | 같음 |
| 같은 state / `source_unsupported` | HTML/허용하지 않는 형식·코덱 | 같음 |
| 같은 state / `source_timeout` | 전체 fetch 5초 초과 | 같음 |
| 같은 state / `source_invalid_media` | 디코드 실패·치수/프레임/재인코딩 출력 한도 실패 | 같음 |
| 같은 state / `video_processing_unavailable` | D4 미승인/영상 변환기가 꺼짐 | 출처 링크(있으면) + 직접 올리기, GIF 안내, 승인 불가 |
| 같은 state / `video_conversion_failed` | 승인된 변환기의 시간/자원/디코드 실패 | 같음 |
| 직접 올리기 성공 → `ready` | 같은 draftId·출처, revision 증가·새 그림/sha | **새 그림을 본 뒤 새 핀으로** 승인. 옛 choice는 409, 승인 소모 없음 |
| approval rejected/expired/cancelled | 기존 승인 카드 끝 상태·이유, 미리보기 바이트 회수 | 업로드/승인 없음. source 링크·사유 코드는 기록으로 남음 |
| 승인 성공 | 기존 카드 `result.status=executed`, `ref.type=expression`, `result.expression: Result`, line=「팀 보관함에 저장했어요」 | 「보내기」는 현재 active를 조회해 `:name:` 본문만 채우고 미리보기 후 전송 |

받기 실패는 **approval.status=pending 유지**이며 실행 실패·거절·완료 카드로 처리하지 않는다. 이미 준비된 다른 후보는 그대로 선택할 수 있다. 모든 후보의 subjectMemberId는 같아야 한다. 실패 후보를 다른 사람이 올린 파일로 교체해도 당사자/정책 판정은 바뀌지 않는다. 직접 draft의 두 번 활성화와 행동 승인 경주는 행 락으로 한 번만 등록한다. 직접 draft는 성공한 `(제출자,draftId,revision,sha256)`의 Mutation/201 receipt를 보존해 같은 Choice 재시도에 원래 응답을 돌려준다(등록 tx 안에 receipt 저장). 다른 choice는 409다. 행동은 기존 결정 receipt를 돌려준다.

최소 요청/응답 예시(전체 실행 가능한 응답과 실제 작은 GIF/PNG 바이트는 [fixtures](../../packages/momo-core/src/features/expressions/fixtures.ts)·[fixtureServer](../../packages/momo-core/src/features/expressions/fixtureServer.ts)):

```json
{"name":"happy_dance","displayName":"신나는 춤","tags":["축하","춤"],"subjectMemberId":null,"url":"https://giphy.com/gifs/example"}
```

```json
{"draftId":"00000000-0000-4000-8000-000000000021","workspaceId":"00000000-0000-4000-8000-000000000001","revision":"1","name":"happy_dance","displayName":"신나는 춤","tags":["축하","춤"],"subjectMemberId":null,"origin":{"kind":"url","sourceUrl":"https://giphy.com/gifs/example","prompt":null},"expiresAtMs":1793318400000,"state":"manual_upload_required","code":"source_blocked","media":null}
```

```json
{"action":"expression.create","args":{"candidates":[{"name":"happy_dance","displayName":"신나는 춤","tags":["축하"],"subjectMemberId":null,"image":{"source":"url","url":"https://giphy.com/gifs/example"}}]}}
```

## 6. 부록 D — 코어·클라이언트 접합과 검증 인계

- 코어 진입점은 [features/expressions/index.ts](../../packages/momo-core/src/features/expressions/index.ts). 목록/변경 응답·strict 스키마·검색(이름/태그/한글 초성)·본문/반응 토큰·크기/대체 본문·카드 상태·기기 기록과 순수 가짜 서버를 제공한다. 플랫폼 API·UI·transport·런타임 의존을 추가하지 않는다.
- 최근/자주 기록은 `{v:1,workspaceId,memberId,entries:[{id,count,lastUsedAtMs}]}`. **성공한 전송/반응만** 센다(미리보기·실패·낙관 중복은 제외, 호출자는 성공 receipt당 1회). 최근은 시각 내림차순/id, 자주는 횟수 내림차순/시각/id. 검색은 정확 이름 > 이름 앞부분 > 정확 태그 > 부분/초성 > 사용 횟수 > 고정 이름/id. 장치 저장 adapter는 호스트가 제공하고 현재 account/workspace와 다르면 버린다. 숨김 항목은 추천하지 않는다.
- S3는 `createExpressionFixtureServer().request({method,path,body})`를 transport port에 연결한다. multipart는 fixture에서 metadata만 body로 보낸다. `importFailure`에 각 사유 코드를 주면 사이트 차단→직접 올리기→새 preview→등록을 엔진 없이 재현한다. image 응답 `bodyBase64`를 host가 디코드한다. 이 fixture는 실제 auth/RLS/SSRF/변환 검증을 대신하지 않는다.
- S2 증거: 코어 typecheck·변경 파일 lint·행동/스키마 시험·의도적 변조 RED→복원 GREEN·마지막 코어 단위 전체. docs 전체 게이트/독립 보안 검수·실 PG는 planner/S3에 인계한다. SQL·서버 코드가 없으므로 S2에서 실 PG를 구동하지 않는다.
- **S3 엔진 필수 증거**: 실제 비우회 PG 역할로 두 테넌트 RLS/FORCE·복합 FK·quota/이름 경주·해시/당사자/권한 재증명·draft 교체 경주·TTL/미선택 회수·신고 즉시 숨김+outbox·스냅샷/delta·bearer/sha404·가드 hop/IP pin·폭탄/프레임/격리·서빙 메타데이터 제거·위조 카드 차단. 모델 (a)에서는 송신 tx에 새 표현 props를 만들지 않는 회귀를 확인한다.
- **스택 검증 메모**: S2 화면 변경 없음. S3 웹/데스크탑 Playwright·폰 Maestro에서 한 GIF를 등록해 반응/본문/1개·2~6개·7개/글 혼합 전송, 삭제/숨김 후 문자열 폴백·캐시 회수, 링크 차단/크기/형식/시간 실패→출처 링크+직접 올리기→다시 확인, 4후보/당사자 제한, reduced motion/4회 반복/접근성·오프라인·재연결·계정/워크스페이스 전환을 잰다. 폰 GIF·데스크탑 CSP·화면/실기기/PG/변환은 **runtime-unverified**다.

## 7. 증보 2026-10-30 — AI와 만드는 움직이는 표현, 원본 출처와 서버 조립 (#4820)

> Status: **Accepted (2026-10-30, owner 요청)**. 근거: [#4820](https://github.com/yeomyeonggeori/oort/issues/4820) 본문의 owner 요청 「카카오톡 이모티콘 처럼 동적인 이모티콘도 AI와 함께 만들어서 사용할 수도 있게 해볼 수 있니 ? 원본 이미지 기반으로 image 생성 기능 및 스킬이 가능하면 에이전트가 만들어서 쓸 수 있게 해주는거지.」
> 범위: 계약을 문서로 고정한다. 서버 조립·`expression.create` 연결(#4820 C)·화면(#4820 B)·격리 디코더(#4676)·`expression.create`(#4829)가 이 증보를 입력으로 구현한다. 이 증보는 코드·migration·부록 B의 고정 JSON 블록을 바꾸지 않는다(G7).
> 같이 읽는 것: 공동 호스팅 Hermes의 그림 도구 허용은 [ADR-0203 증보(#4820)](0203-cohosted-agent-detection.md#증보-2026-10-30--codex-구독-그림-생성만-허용-4820), 행동 계약은 [ADR-0186 v8](0186-agent-workspace-actions.md#증보-2026-10-30--팀-표현-행동-expressioncreate-v8-4301)이다.

### G0. 바뀌는 것과 바뀌지 않는 것

- 바뀌는 것: (1) `Origin`의 `generated`에 원본 첨부 포인터가 더해진다(G1). (2) `AgentImage`에 서버가 보관한 조립 결과를 가리키는 `assembled` 갈래가 더해진다(G3.6). (3) 부록 C의 닫힌 코드에 생성·조립 실패 코드가 더해진다(G3.8). (4) D3의 「생성 base64 디코드 후 ≤1 MiB」는 **저장될 후보**의 상한으로 읽는다. 조립에 들어가는 원본 그림은 G3의 입력 한도를 따른다.
- 바뀌지 않는 것: D1~D6, 서버는 그림을 **생성하지 않는다**(X8-1 「서버/팀 AI 생성 호출은 없다」). 서버가 하는 일은 에이전트가 만든 그림에 움직임을 입히는 **조립**이다. 코드를 실행할 수 있는 에이전트가 GIF를 직접 만들어 `generated`로 보내는 길(X8-1)도 그대로다. 이 증보는 그것이 불가능한 에이전트(잠긴 공동 Hermes)를 위한 길을 더한다. 영상 변환(D4, #4819)·세트(팩)·외부 GIF API는 열지 않는다.

### G1. 출처 `generated`에 원본 첨부 참조

- `Origin`의 `generated` 갈래에 `sourceAttachmentId`(UUID 또는 null)를 더한다. null은 원본 없이 prompt만으로 만든 경우다. 값이 있으면 「이 그림은 이 첨부를 바탕으로 만들었다」는 **기록 포인터**이며 첨부를 여는 열쇠가 아니다. 첨부는 자기 대화의 인가 경로로만 열린다([ADR-0151](0151-attachments-v0-drive-contract-port.md)).
- **에이전트는 자기가 읽을 수 있는 첨부만 원본으로 쓴다.** 서버가 `image.source=attachment`와 같은 판정으로 검증한다. 곧 런 요청자가 **같은 대화**에 올린 완료·미삭제 첨부만이다(X8-1). 남의 사진·다른 대화·없는 id·미완료·삭제된 첨부는 구분 없는 같은 invalid arguments이며 승인 카드가 생기지 않는다. 서버가 검증한 값만 저장하고 에이전트가 쓴 값을 그대로 믿지 않는다.
- 저장: `expression.origin_source_attachment_id uuid NULL`(INSERT 뒤 불변, 외래키 없음: 첨부가 지워져도 표현의 기록이 바뀌지 않는다), 같은 열을 `expression_draft`에도 둔다. 원본 **바이트**는 표현에 저장하지 않는다. 가리키는 첨부가 지워졌으면 화면은 「원본 사진 없음」이라고만 말한다. 감사에는 싣지 않는다(D6의 닫힌 목록 그대로). 상세 열람은 현재 admin만이다.
- `origin.kind`는 `generated`이고 `prompt`(1~2,000자, 에이전트가 쓴 평문임을 표시)는 필수다. 웹에서 가져온 그림을 `generated`로 표시하지 않는다(출처 세탁 금지, D5).

### G2. 얼굴·당사자 — D6 그대로, 원본에도 적용

- 원본 첨부나 만들어진 그림에 사람 얼굴이 있으면 D6·X8-3을 그대로 따른다. `subjectMemberId`로 워크스페이스 사람 멤버 한 명을 지정하고 **그 당사자 AND 현재 추가 정책 충족자만** 승인한다. admin·에이전트 소유자의 대리 승인은 없고, 여러 사람·비멤버·당사자 미확인은 등록하지 않는다. 스티커풍으로 바꾼 그림도 얼굴을 닮았으면 같은 규칙이다. 그림체 변환은 면제 사유가 아니다.
- 얼굴 탐지·인식은 없다(D6). 그래서 에이전트 지시가 이렇게 가르친다. 원본에 사람 얼굴이 있거나 불확실하면 만들기 전에 요청자에게 누구인지 묻고 `subjectMemberId`를 지정한다. 당사자를 확인하지 못하면 만들지 않는다. `subjectMemberId:null`은 제출자의 「사람 얼굴 없음」 선언이지 기술 판정이 아니다. 한 요청의 모든 후보는 같은 `subjectMemberId`를 가진다(부록 B).
- `sourceAttachmentId`가 있는 승인 카드는 그 대화의 첨부를 가리키는 「원본 사진」 줄과 얼굴 선언을 함께 보인다(그림 자체는 대화 첨부 경로로만 열린다). 신고 즉시 숨김·관리자 검토는 D6 그대로다.
- 시험(C의 수용기준): 얼굴이 선언된 후보를 당사자가 아닌 사람이 결정하면 거절되고 승인이 소모되지 않는다. 같은 요청 안의 후보 사이 subject 불일치는 거절된다. 남의 대화 첨부를 `sourceAttachmentId`로 쓰면 카드가 생기지 않는다.

### G3. 서버 조립 계약

**G3.1 왜 서버가 하는가.** (a) 공동 호스팅 Hermes는 코드를 실행할 수 없어 GIF를 만들 수 없다(ADR-0203 I2). (b) gpt-image-2는 최소 1024×1024 PNG를 돌려주고 보통 1 MiB를 넘는다. D3의 ≤512×512·≤1 MiB는 서버 디코더가 맞춰야 한다. (c) MiB 단위 바이트를 모델 문맥으로 나르는 길은 현실적이지 않다. 에이전트는 **그림**을, 서버는 **움직임**을 맡는다.

**G3.2 입력.** 한 요청은 원본 그림 한 장과 움직임 지정 하나다.

- 원본 그림: D3 「정지 입력」 규격(PNG·JPEG·정지 WebP·단일 프레임 GIF, 한 변 ≤4096, ≤16,000,000 px). 바이트 상한은 요청에 실려 오면 디코드 후 ≤4 MiB(base64 ≤5,592,408자, 전체 요청 ≤6 MiB 예산 안), 서버 안에서 옮겨 온 것이면 ≤5 MiB(D3 입력)다.
- `motion`은 둘 중 하나다.
  - `preset`: `presets` 1~4개(중복 없음). 값은 `bounce`(통통)·`wobble`(흔들기)·`pulse`(두근)·`sparkle`(반짝). 프리셋마다 후보 하나.
  - `sprite`: 한 장에 자세 2~4개를 격자로 그린 시트. `frames` ∈ {2,3,4}이고 격자는 고정이다. 2 → 가로 2×세로 1, 3 → 3×1, 4 → 2×2이며 칸 번호는 왼쪽→오른쪽, 위→아래로 0부터 센다. 이미지를 열×행으로 균등 분할하고 나누어떨어지지 않으면 남는 오른쪽·아래 픽셀은 버린다. `sequence`는 칸 번호 배열(길이 2~24, 같은 칸 반복 가능, `frames` 밖 번호 거절), `frameMs`는 40~500의 정수 하나다. `sequence` 길이 × `frameMs` ≤ 10,000이다. 후보는 하나다.
- `size`: 정사각 캔버스 한 변 ∈ {240, 360, 480}, 기본 360. 원본(또는 칸)은 비율을 지켜 캔버스 한 변의 **80%** 정사각 안에 맞춰 가운데에 둔다(움직임이 가장자리에서 잘리지 않게 사방 10% 여백을 남긴다). 80%보다 작으면 확대하지 않는다. 여백과 빈 자리는 원본 가장자리 픽셀의 중앙값 색으로 채우고, 원본이 투명이면 투명으로 둔다(누끼·배경 제거 없음).
- `prompt`(1~2,000자, 에이전트가 쓴 평문)와 `sourceAttachmentId`(G1)를 함께 받는다.

**G3.3 움직임 프리셋.** 아래 표가 정본이고 시험이 이 값을 잰다. 값을 바꾸는 것은 이 ADR의 증보로만 한다. 위상 t = i/프레임수(i = 0…프레임수−1)다.

| id | 이름 | 프레임 | 프레임 지연 | 한 번 재생 | 움직임 |
|---|---|---|---|---|---|
| `bounce` | 통통 | 16 | 40 ms | 640 ms | 세로 이동 −0.08·size·\|sin(π·t)\|. 바닥(t=0)에서 가로 +6%·세로 −6% 눌림 |
| `wobble` | 흔들기 | 16 | 40 ms | 640 ms | 중심 기준 회전 8°·sin(2π·t) |
| `pulse` | 두근 | 12 | 50 ms | 600 ms | 크기 배율 1 + 0.12·sin²(2π·t), 한 번 재생에 두 번 뛴다 |
| `sparkle` | 반짝 | 20 | 50 ms | 1,000 ms | 그림은 고정. 서버가 코드로 그리는 단순 별 4개를 사방 10% 여백의 고정 위치에 두고, 별 k(k=0…3)는 프레임 5k…5k+4에서만 켠다(외부 에셋 없음) |

모든 프리셋이 D3의 GIF 한도(캔버스 ≤512, ≤100프레임, 지연 ≥20 ms, ≤10초)를 만족하고, 가장 큰 움직임(통통 8%·흔들기 8°·두근 ×1.12)도 80% 정사각 안의 그림이 10% 여백 안에서 움직이도록 정했다.

**G3.4 출력.** 후보 1~4개(프리셋 수, 또는 sprite 하나). 각 후보는 GIF89a이고 `size`×`size`이며 프레임·지연은 G3.3 표 또는 요청 값이다. **≤1 MiB**(D3 후보 상한). 반복은 총 4회 재생이다(의미는 D3처럼 디코더 시험으로 확인). 주석·응용 확장은 반복 하나뿐이다. 같은 입력과 같은 값이면 같은 바이트가 나온다(sha 핀이 안정적이다). 출력은 D3의 일반 경로를 다시 지난다. 곧 GIF 입력 검사 → 픽셀 재인코딩 → small/large/thumb이다. 조립 결과를 검사 없이 저장하지 않는다.

**G3.5 실행 환경.** #4676의 격리 디코더·재인코딩 경로 **안에서만** 돈다(전 출처 공통 semaphore 2, 작업당 할당 192 MiB, 벽시계 10초, 프레임 순차 합성, 무제한 `collect_frames` 금지). 네트워크·셸·외부 프로세스는 없다. **ffmpeg를 쓰지 않고** permissive 라이선스 라이브러리만 쓴다(GPL 계열 양자화 라이브러리 등은 제외하며 선택·검증·NOTICE 귀속은 C가 `deny.toml`로 한다). 서버는 이미지를 생성하지 않고 외부를 호출하지 않는다.

**G3.6 보관과 후보 연결.** 조립 결과는 서버가 `assemblyId`(UUID)로 임시 보관한다. 워크스페이스·요청 에이전트에 묶이고 TTL은 1시간이며 `expression_draft`와 같은 회수 규칙·할당·디코더 동시성을 공유한다(에이전트당 동시에 보관하는 후보 ≤12 = 기존 pending 제안 ≤3 × 후보 ≤4). 후보는 `expression.create`의 `image`에 `{source:"assembled", assemblyId, index}`로 들어간다. **에이전트가 GIF 바이트를 다시 나르지 않는다.** 승인 카드가 보이는 그림은 서버가 조립한 바이트 그대로이고(X8-2), prompt와 `sourceAttachmentId`는 조립 요청 때 서버가 받은 값이 후보의 `origin`이 된다. 다른 에이전트·다른 요청자·다른 워크스페이스의 `assemblyId`는 구분 없는 같은 invalid arguments다. 후보는 한 조립 결과의 일부만 제안해도 되고, 5개 이상이나 서로 다른 조립 결과의 섞임은 `AgentAction`의 상한(후보 ≤4)과 같은 규칙으로 거절한다.

**G3.7 입구.** 입구는 둘이고 같은 조립 함수를 부른다. (a) Agent Port의 MCP 도구 `oort_expression_assemble`(인자 `AssembleRequest`, 결과 `AssembleResult`, 필요한 범위는 `oort_action_propose`와 같고 새 범위는 없다)와 (b) 호스팅 실행(공동 Hermes)의 서버 쪽 문이다. 둘의 입력 한도·실패 사유·보관은 같다. (b)의 입력 경로는 G4가 확인한 사실로 좁혀진다. Hermes API 서버는 클라이언트가 선언한 함수 도구(`tools`·`tool_choice`)를 읽지 않으므로(Hermes `api_server_openai_routes.py:653-656,723,793`, `/v1/responses`는 `:1054-1060`) 워커의 카탈로그 도구 문은 Hermes에서 열리지 않는다. 남는 후보는 모델의 최종 답에서 `AssembleRequest`와 같은 닫힌 스키마로 검증되는 구조만 읽는 문이다(자유 문장·마크다운을 행동으로 해석하지 않는다). Hermes의 `mcp_servers`에 oort MCP를 다는 길은 커넥터 모드라 ADR-0203 I3과 충돌하므로 새 결정 없이는 쓰지 않는다. 구체 표기와 워커 적합성은 C가 닫는다.

**G3.8 실패 사유와 카드.** 닫힌 코드다. 한도 초과와 생성 실패를 **조용히 자르거나 프레임을 버려 통과시키지 않는다**(D3).

| 코드 | 언제 | 남는 곳 | 한국어 한 줄(코어 사전) |
|---|---|---|---|
| `assembly_params_invalid` | 모르거나 중복된 프리셋·`presets` 5개 이상·잘못된 격자/순서·`size` 범위 밖 | 호출 오류(어느 인자가 틀렸는지 이름만). 만들어진 것이 없어 카드 없음 | (사람에게 보이지 않음, 에이전트가 고쳐서 다시 요청) |
| `generation_failed` | 그림 도구가 오류·빈 응답·구독 한도로 그림을 주지 못함, 또는 호스팅 실행에서 받을 그림이 없음 | 실패 카드 | 그림을 만들지 못했어요 |
| `assembly_source_invalid` | 형식 불허(APNG·움직이는 WebP·SVG·HEIC/AVIF)·디코드 실패·치수/픽셀 한도 초과 | 실패 카드 | 이 그림에는 움직임을 입힐 수 없어요 |
| `assembly_source_too_large` | 원본 바이트 상한 초과 | 실패 카드 | 그림이 너무 커서 움직임을 입힐 수 없어요 |
| `assembly_output_too_large` | 결과 GIF가 1 MiB 초과(측정한 바이트 수는 `props`에 숫자로) | 실패 카드. 서버는 크기를 **줄여 다시 만들지 않는다**. 에이전트가 더 작은 `size`로 새 요청을 할 수 있다 | 움직이는 그림이 너무 커요 |
| `assembly_timeout` | 벽시계 10초·할당 상한 초과 | 실패 카드 | 움직임을 입히다가 시간이 다 됐어요 |
| `assembly_busy` | 디코더 동시성 한도 때문에 시작하지 못함 | 실패 카드 | 지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요 |

「실패 카드」는 요청 고리의 카드가 닫힌 코드(`props.code`)와 한국어 한 줄로 끝나는 것이다. 한국어 문장은 클라이언트가 코어 사전에서 읽고 서버는 같은 골든 데이터의 중립문을 `body`에 쓴다. 영어 원문은 쓰지 않으며 에이전트의 문장이 카드 제목이 되지 않는다([ADR-0186 v6 R-d](0186-agent-workspace-actions.md#r-d-영어-원문을-쓰지-않는다--상태-코드--한국어-accepted-전부-권장으로)). 후보 일부만 실패하면 승인 카드의 그 자리가 부록 C의 `manual_upload_required` + 위 코드(그림 없음, 직접 올리기 안내)로 남고 준비된 후보는 계속 고를 수 있다. 에이전트에 그림 도구가 없는 경우는 후보가 만들어진 적이 없으므로 카드가 아니라 에이전트의 답 「이 에이전트는 그림을 만들 수 없어요」(ADR-0203 I4)다. 새 코드는 C가 부록 C의 표와 부록 B의 `Draft.code`에 함께 더한다(`assembly_params_invalid`는 호출 오류라 카드 코드가 아니다).

### G4. 전달 경로와 확인한 한계 [소스, runtime-unverified]

공동 호스팅 Hermes의 잠금 아래에서 그림이 오가는 길은 다음 사실로만 정한다(ADR-0203 I1의 5·4, 고정 commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`).

- **나가는 길(그림 → oort).** `image_generate`는 PNG를 Hermes 볼륨에 저장하고 **경로만** 돌려준다. `file` 묶음이 꺼져 있어 에이전트는 바이트를 읽어 `generated`의 base64로 만들 수 없다. 응답 쪽 유일한 출구는 최종 답의 `MEDIA:<경로>`이며, API 서버가 5 MiB 이하 이미지에 한해 `data:image/…;base64,…` 주소를 담은 마크다운 이미지로 바꾼다. 이 변환은 **비스트리밍 최종 응답**과 Responses에만 적용되고 스트리밍 조각에는 적용되지 않는다. 따라서 호스팅 실행이 그림을 받으려면 비스트리밍 응답(또는 같은 효과를 내는 경로)을 써야 하고, 받은 그림은 G3.2의 입력 한도(≤5 MiB)와 D3 정지 입력 검사를 지난다. 그림이 없으면 `generation_failed`다. gpt-image-2의 PNG가 5 MiB 안에 들어오는지와 지연(이미지 생성은 수십 초 걸릴 수 있다)이 현행 워커의 시간 제한과 맞는지는 확인하지 않았다.
- **들어가는 길(원본 → 도구).** Hermes API 서버는 비전 입력(`data:image/` 또는 http(s), `api_server.py:470-540`)을 받아 모델이 그림을 **볼 수** 있게 한다. 그러나 도구의 `image_url`·`reference_image_urls`는 모델이 쓰는 문자열이다(모델은 본 그림의 바이트를 `data:` URL로 다시 쓸 수 없다). `momo-provider`·`momo-agent-worker`에서 Hermes 안의 파일 경로나 Hermes가 내려받을 주소를 요청에 싣는 코드를 찾지 못했다. 그래서 **첫 구현은 모델이 본 원본을 설명하는 prompt로 만드는 text-to-image다.** 원본 픽셀을 `images/edits`로 보내는 경로는 이 증보가 열지 않는다. 열려면 oort가 Hermes에 원본 주소를 건네야 하는데 Hermes가 직접 내려받는 요청이 되므로 별도의 보안 결정이 필요하다(ADR-0203 I2). oort는 Hermes 요청에 http(s) 원본 주소를 넣지 않는다.
- 코드를 실행해 파일을 읽을 수 있는 외부 런타임(Agent Port)은 자기 그림을 `source.from="base64"`(≤4 MiB)로 보내거나 대화 첨부를 `source.from="attachment"`로 쓸 수 있다. 모델이 직접 쓰는 MiB 단위 base64는 현실적이지 않으므로 파일을 읽어 보내는 런타임에 한한다.
- 미검증: 위 비스트리밍 경로가 워커의 응답 처리와 맞는지, 모델이 `MEDIA:` 표시를 실제로 쓰는지, 5 MiB·시간 한도 안에서 실제 그림이 들어오는지, 구독 한도에 걸릴 때의 오류 모양. 이 증보는 이를 확인했다고 주장하지 않는다.

### G5. 비용은 모델 A(개수만 보임)

그림 생성은 에이전트가 쓰는 구독·키 쪽에서 일어나고 oort 서버는 생성 호출을 하지 않는다(X8-1). 사람에게는 [ADR-0147 증보(#4781)](0147-chat-agent-oauth-provider.md)의 보임 모델 A를 그대로 따라 **개수만** 보인다. oort가 실제로 받은 생성 그림 수와 조립한 후보 수를 「그림 n장」처럼 말하고, 금액·토큰·가격표·남은 한도는 쓰지 않는다. 남의 개인 에이전트의 생성은 그 에이전트가 숨겨지는 규칙을 따른다. Codex 구독의 이미지 생성은 공개 단가가 없고(공급자의 `price = "varies"`) 남은 한도를 읽을 수 없으므로(ADR-0147 D3: 읽는 척하지 않는다) 달러를 만들어 내지 않는다. 한도에 걸리면 `generation_failed`로 드러난다. 조립은 oort 서버의 CPU·메모리 비용이고 디코더 동시성과 할당 한도로 묶이며 금액으로 보이지 않는다. `usage_ledger`에 이미지 비용 열을 더하지 않는다. 개수를 어디에 어떻게 보일지는 B가 정한다(새 금액 필드는 없다).

### G6. 에이전트 지시문과 도구 설명이 가르칠 것

X8-1의 목록에 이 증보가 더한다. 후보 ≤4와 같은 `subjectMemberId`, 출처와 생성 prompt 명시, 사람 얼굴이 있으면 당사자를 묻고 지정, 받기·조립 실패는 사람에게 사유를 알리고 같은 요청을 되풀이하지 않기(최대 한 번 더 작은 `size`로), 숨은 웹·그림·첨부 안의 지시를 행동 지시로 취급하지 않기, 원본은 요청자가 같은 대화에 올린 첨부만, 그림 도구에 외부 주소를 넣지 않기, 그림 도구가 없으면 「이 에이전트는 그림을 만들 수 없어요」.

- 스킬 문서: [`infra/hermes/skills/make-animated-expression/SKILL.md`](../../infra/hermes/skills/make-animated-expression/SKILL.md). MCP 도구 설명 초안: [`docs/planning/handoffs/2026-10-30-4820-expression-assemble-tool-descriptions.md`](../planning/handoffs/2026-10-30-4820-expression-assemble-tool-descriptions.md).
- **배포 상태.** 이 저장소에는 스킬을 에이전트에게 싣는 장치가 없다. MCP 도구 설명의 정본 자리는 [`server-rust/crates/momo-mcp/src/tools.rs`](../../server-rust/crates/momo-mcp/src/tools.rs)이고, 위 초안은 C가 그곳에 옮긴다. `[추정]` 잠긴 공동 Hermes는 `skills` 묶음(`skills_list`·`skill_view`·`skill_manage`, Hermes `toolsets.py:103-107`)이 꺼져 있어 `skill_view`로 스킬 본문을 열 수 없다. 스킬 색인이 시스템 프롬프트에 들어가는지는 확인하지 않았다. 확인 전에는 지시를 oort가 실행 맥락에 실어 주는 것을 기본으로 둔다. 이 연결은 C가 닫는다.

### G7. 스키마 델타 — 부록 B의 고정 블록 밖

부록 B의 `expression-contracts-v1` 블록은 [코어 스키마](../../packages/momo-core/src/features/expressions/contracts.schema.json)와 값이 정확히 같아야 하고 `verify-contract.mjs`가 이를 잰다. 이 증보는 그 블록을 바꾸지 않는다. 아래는 **추가분만**이며 구현 단계(C)가 **부록 B의 블록·코어 스키마·fixture·OpenAPI·migration 열을 한 번에 함께** 바꿀 때 합친다. 합칠 때 `Origin`의 `generated` 갈래를 `OriginGeneratedWithSource`로 바꾸고(필수 키가 늘어 옛 payload에는 하위 호환이 아니므로 fixture·코어 파서·클라이언트를 함께 고친다), `AgentImage`에 `AgentImageAssembled`를 더하며, `Draft.code`의 닫힌 목록에 G3.8의 카드 코드 여섯 개를 더한다. JSON Schema로 나타낼 수 없는 규칙(`sequence`의 값이 `frames` 안, 길이 × `frameMs` ≤ 10,000, 첨부·`assemblyId` 소유, 같은 `subjectMemberId`)은 서버가 강제한다.

<!-- expression-augment-4820:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:oort:expressions:v1:augment-4820",
  "$defs": {
    "OriginGeneratedWithSource": {"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt","sourceAttachmentId"],"properties":{"kind":{"const":"generated"},"sourceUrl":{"oneOf":[{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},{"type":"null"}]},"prompt":{"type":"string","minLength":1,"maxLength":2000},"sourceAttachmentId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]}}},
    "AgentImageAssembled": {"type":"object","additionalProperties":false,"required":["source","assemblyId","index"],"properties":{"source":{"const":"assembled"},"assemblyId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"index":{"type":"integer","minimum":0,"maximum":3}}},
    "AssembleSource": {"oneOf":[{"type":"object","additionalProperties":false,"required":["from","attachmentId"],"properties":{"from":{"const":"attachment"},"attachmentId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}},{"type":"object","additionalProperties":false,"required":["from","mime","dataBase64"],"properties":{"from":{"const":"base64"},"mime":{"enum":["image/png","image/jpeg","image/gif","image/webp"]},"dataBase64":{"type":"string","minLength":4,"maxLength":5592408,"pattern":"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"}}}]},
    "AssembleMotion": {"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","presets"],"properties":{"kind":{"const":"preset"},"presets":{"type":"array","minItems":1,"maxItems":4,"uniqueItems":true,"items":{"enum":["bounce","wobble","pulse","sparkle"]}}}},{"type":"object","additionalProperties":false,"required":["kind","frames","sequence","frameMs"],"properties":{"kind":{"const":"sprite"},"frames":{"enum":[2,3,4]},"sequence":{"type":"array","minItems":2,"maxItems":24,"items":{"type":"integer","minimum":0,"maximum":3}},"frameMs":{"type":"integer","minimum":40,"maximum":500}}}]},
    "AssembleRequest": {"type":"object","additionalProperties":false,"required":["source","motion","prompt","sourceAttachmentId"],"properties":{"source":{"$ref":"#/$defs/AssembleSource"},"motion":{"$ref":"#/$defs/AssembleMotion"},"size":{"enum":[240,360,480]},"prompt":{"type":"string","minLength":1,"maxLength":2000},"sourceAttachmentId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]}}},
    "AssembleResult": {"type":"object","additionalProperties":false,"required":["assemblyId","expiresAtMs","candidates"],"properties":{"assemblyId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"expiresAtMs":{"type":"integer","minimum":0},"candidates":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["index","motion","frames","durationMs","bytes","sha256"],"properties":{"index":{"type":"integer","minimum":0,"maximum":3},"motion":{"enum":["bounce","wobble","pulse","sparkle","sprite"]},"frames":{"type":"integer","minimum":2,"maximum":24},"durationMs":{"type":"integer","minimum":40,"maximum":10000},"bytes":{"type":"integer","minimum":1,"maximum":1048576},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"}}}}}}
  }
}
```
<!-- expression-augment-4820:end -->

### G8. 열지 않는 것과 구현·검수 인계

- 열지 않는 것: 영상→GIF(#4819), 여러 개를 묶는 세트(팩), 외부 GIF API, 서버의 이미지 생성 호출, ffmpeg, 원본 픽셀을 `images/edits`로 보내는 경로(G4), 공개·서명 주소로 원본을 내주는 경로, 자동 얼굴 탐지.
- C(서버): G7의 델타를 부록 B·코어 스키마·fixture·OpenAPI·migration 열과 한 번에 합치고 `verify-contract.mjs`를 같이 고친다. 조립 함수(G3)를 #4676의 격리 경로 안에 두고 MCP 도구와 호스팅 문을 연결하며 G4의 전달 경로를 확인한다. 증거는 실제 비우회 PG 역할로 두 테넌트에서 `sourceAttachmentId`와 `assemblyId`의 소유 판정, 프리셋 네 개와 sprite 세 격자의 프레임 수·지연·≤1 MiB·4회 재생, 한도 초과·형식 불허·시간 초과의 실패 코드(조용한 절단 없음), 얼굴 선언 후보의 당사자 승인, 에이전트당 후보 ≤12 보관과 TTL 회수, 허용하지 않는 라이선스 의존이 없는 것이다. 사보타주는 지키는 줄마다 한다.
- B(화면): 「AI와 만들기」(원본 그림 → 움직임 → 만들 에이전트), 후보 카드(움직이는 미리보기·4회 재생·동작 줄이기면 정지), 실패 카드의 코드별 한국어 줄, 「원본 사진」 줄, 개수만 보이는 비용 표시.
- 독립 검수는 보안 경계(ADR-0203 증보)와 이 증보를 함께 본다. 실제 Codex 이미지 응답·`MEDIA` 변환·GIF 인코딩 실측·실기기는 **runtime-unverified**다.
