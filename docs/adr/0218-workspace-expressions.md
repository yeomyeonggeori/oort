# ADR-0218: 팀 표현 보관함 — 한 등록으로 반응·본문·큰 그림, 에이전트 후보와 직접 올리기

> Status: Accepted — owner 2026-10-30 08:20 질문 창 결정 「이대로」와 GIF 사이트 단건 허용 결정(#4301). **D4의 영상 변환 절만 보류**다(owner 2026-10-30 「다음 이슈로 미루자」, #4819).
> Date: 2026-10-30
> Scope: #4301(S2 칸 6, base `track/engine`): 설계 S0 + 플랫폼 독립 코어 C1. 서버·웹·폰 구현은 #4676·#4677·#4678(S3).
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
