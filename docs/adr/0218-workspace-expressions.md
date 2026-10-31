# ADR-0218: 팀 표현 보관함 — 한 등록으로 반응·본문·큰 그림, 에이전트 후보와 직접 올리기

> Status: Accepted — owner 2026-10-30 08:20 질문 창 결정 「이대로」와 GIF 사이트 단건 허용 결정(#4301). **D4의 영상 변환 절만 보류**다(owner 2026-10-30 「다음 이슈로 미루자」, #4819).
> Date: 2026-10-30
> Scope: #4301(S2 칸 6, base `track/engine`): 설계 S0 + 플랫폼 독립 코어 C1. 서버·웹·폰 구현은 #4676·#4677·#4678(S3).
> 증보: §7 (2026-10-30, #4820, **Accepted**) — AI와 만드는 움직이는 표현: 생성 출처의 원본 첨부 참조·서버 조립 계약·실패 사유·비용. 부록 B의 고정 JSON 블록은 바꾸지 않고, 스키마 변경은 §7의 델타를 구현 단계가 한 번에 합친다.
> 증보 2: §8 (2026-10-31, #4931, **Proposed — owner 선택 대기**) — 사진 이모티콘의 「배경 정리」 방식 비교와 권장안, 팀 서버에서 호스팅 문을 여는 순서, 실제 Hermes 리허설. Accepted가 아니며 아무 계약도 바꾸지 않는다.
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

**운반 예산**: 생성 후보당 디코드 ≤1 MiB/base64 ≤1,398,104자, 후보 합계 디코드 ≤4 MiB, `expression.create` 제안의 **전체 UTF-8 JSON/RPC 요청 ≤6 MiB**다(단순 args만이 아닌 envelope 포함). 직접 multipart도 file 5 MiB + metadata를 포함해 요청 ≤6 MiB다. 현행 `momo-mcp`는 전체 64 KiB·dataBase64 58,700자(아바타 예외)를 검사하므로 레지스트리 추가만으로 새 후보를 운반할 수 없다. S3 엔진은 MCP/CLI bridge/Agent Port/propose HTTP body limit·문자열 검사·중계·원장 저장을 **expression.create에만** 이 예산으로 연결한다. 대상에는 `momo-mcp/src/lib.rs`의 parse 전 검사, `oort-cli/src/mcp.rs`의 64 KiB 줄 상한, `oort-cli/tests/wire_constants.rs`의 동등성 계약, `routes/agent_port.rs`의 `to_bytes` cap도 포함된다. 기존 행동의 64 KiB/기존 문자열 예산은 유지하고 다른 행동이나 알 수 없는 필드에 base64를 숨겨 한도를 넓힐 수 없게 한다. 인증·scope 검사를 대형 바이트 수집 전에 수행하고 스트리밍/파서 단계 전체 6 MiB cap은 항상 적용한다. 6 MiB까지 읽는 길은 인증을 통과하고 `workspace:propose` scope를 가진 에이전트에게만 열리고(그 밖의 인증은 64 KiB 그대로), 그 본문은 **15초 안에** 도착해야 한다(넘으면 본문 없는 `408`; 닫힌 거절 어휘와 호출 추적 규칙은 늘리지 않는다). 1 MiB 후보 4개의 실제 왕복, 5번째·base64/전체 cap 초과·다른 행동으로 위장한 요청을 거절하는 회귀/사보타주가 S3 수용기준이다.


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
    "Origin": {"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt"],"properties":{"kind":{"const":"url"},"sourceUrl":{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},"prompt":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt"],"properties":{"kind":{"enum":["upload","attachment"]},"sourceUrl":{"oneOf":[{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},{"type":"null"}]},"prompt":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["kind","sourceUrl","prompt","sourceAttachmentId"],"properties":{"kind":{"const":"generated"},"sourceUrl":{"oneOf":[{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://(?:[a-z0-9.-]+|\\[[0-9a-f:]+\\])(?::[0-9]{1,5})?(?:/[^\\s?#]*)?$"},{"type":"null"}]},"prompt":{"type":"string","minLength":1,"maxLength":2000},"sourceAttachmentId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]}}}]},
    "SmallImage": {"oneOf":[{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/png"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":262144},"width":{"type":"integer","minimum":1,"maximum":128},"height":{"type":"integer","minimum":1,"maximum":128},"frameCount":{"const":1},"durationMs":{"const":0}}},{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/gif"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":262144},"width":{"type":"integer","minimum":1,"maximum":128},"height":{"type":"integer","minimum":1,"maximum":128},"frameCount":{"type":"integer","minimum":2,"maximum":100},"durationMs":{"type":"integer","minimum":20,"maximum":10000}}}]},
    "LargeImage": {"oneOf":[{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/png"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":1048576},"width":{"type":"integer","minimum":1,"maximum":512},"height":{"type":"integer","minimum":1,"maximum":512},"frameCount":{"const":1},"durationMs":{"const":0}}},{"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/gif"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":1048576},"width":{"type":"integer","minimum":1,"maximum":512},"height":{"type":"integer","minimum":1,"maximum":512},"frameCount":{"type":"integer","minimum":2,"maximum":100},"durationMs":{"type":"integer","minimum":20,"maximum":10000}}}]},
    "ThumbImage": {"type":"object","additionalProperties":false,"required":["mime","sha256","bytes","width","height","frameCount","durationMs"],"properties":{"mime":{"const":"image/png"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"},"bytes":{"type":"integer","minimum":1,"maximum":262144},"width":{"type":"integer","minimum":1,"maximum":128},"height":{"type":"integer","minimum":1,"maximum":128},"frameCount":{"const":1},"durationMs":{"const":0}}},
    "Media": {"type":"object","additionalProperties":false,"required":["small","large","thumb"],"properties":{"small":{"$ref":"#/$defs/SmallImage"},"large":{"$ref":"#/$defs/LargeImage"},"thumb":{"$ref":"#/$defs/ThumbImage"}}},
    "Expression": {"oneOf":[{"type":"object","additionalProperties":false,"required":["id","workspaceId","name","displayName","tags","subjectMemberId","version","origin","createdBy","createdAtMs","status","media"],"properties":{"id":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"origin":{"$ref":"#/$defs/Origin"},"createdBy":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"createdAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"status":{"const":"active"},"media":{"$ref":"#/$defs/Media"}}},{"type":"object","additionalProperties":false,"required":["id","workspaceId","name","displayName","tags","subjectMemberId","version","origin","createdBy","createdAtMs","status","media"],"properties":{"id":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"origin":{"$ref":"#/$defs/Origin"},"createdBy":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"createdAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"status":{"enum":["hidden","deleted"]},"media":{"type":"null"}}}]},
    "List": {"oneOf":[{"type":"object","additionalProperties":false,"required":["workspaceId","version","addPolicy","items","reset","baseVersion"],"properties":{"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"addPolicy":{"enum":["members","admins"]},"items":{"type":"array","minItems":0,"maxItems":1000,"items":{"$ref":"#/$defs/Expression"}},"reset":{"const":true},"baseVersion":{"type":"null"}}},{"type":"object","additionalProperties":false,"required":["workspaceId","version","addPolicy","items","reset","baseVersion"],"properties":{"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"addPolicy":{"enum":["members","admins"]},"items":{"type":"array","minItems":0,"maxItems":1000,"items":{"$ref":"#/$defs/Expression"}},"reset":{"const":false},"baseVersion":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"}}}]},
    "Draft": {"oneOf":[{"type":"object","additionalProperties":false,"required":["draftId","workspaceId","revision","name","displayName","tags","subjectMemberId","origin","expiresAtMs","state","code","media"],"properties":{"draftId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"revision":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"origin":{"$ref":"#/$defs/Origin"},"expiresAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"state":{"const":"ready"},"code":{"type":"null"},"media":{"$ref":"#/$defs/Media"}}},{"type":"object","additionalProperties":false,"required":["draftId","workspaceId","revision","name","displayName","tags","subjectMemberId","origin","expiresAtMs","state","code","media"],"properties":{"draftId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"revision":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"origin":{"$ref":"#/$defs/Origin"},"expiresAtMs":{"type":"integer","minimum":0,"maximum":9007199254740991},"state":{"const":"manual_upload_required"},"code":{"enum":["source_blocked","source_unavailable","source_too_large","source_unsupported","source_timeout","source_invalid_media","video_processing_unavailable","video_conversion_failed","generation_failed","assembly_source_invalid","assembly_source_too_large","assembly_output_too_large","assembly_timeout","assembly_busy"]},"media":{"type":"null"}}}]},
    "ImportRequest": {"type":"object","additionalProperties":false,"required":["name","displayName","tags","subjectMemberId","url"],"properties":{"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"url":{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://[^\\s/@#]+(?:/[^\\s#]*)?$"}}},
    "AttachmentRequest": {"type":"object","additionalProperties":false,"required":["name","displayName","tags","subjectMemberId","attachmentId","channelId"],"properties":{"name":{"type":"string","minLength":2,"maxLength":30,"pattern":"^[a-z0-9_-]{2,30}$"},"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true},"subjectMemberId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]},"attachmentId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"channelId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}},
    "Choice": {"type":"object","additionalProperties":false,"required":["draftId","revision","sha256"],"properties":{"draftId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"revision":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"}}},
    "Mutation": {"type":"object","additionalProperties":false,"required":["workspaceId","version","expression"],"properties":{"workspaceId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"version":{"type":"string","minLength":1,"maxLength":19,"pattern":"^(0|[1-9][0-9]*)$"},"expression":{"$ref":"#/$defs/Expression"}}},
    "Patch": {"type":"object","additionalProperties":false,"required":[],"properties":{"displayName":{"type":"string","minLength":1,"maxLength":40,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"tags":{"type":"array","minItems":0,"maxItems":8,"items":{"type":"string","minLength":1,"maxLength":16,"pattern":"^[^\\u0000-\\u001f\\u007f@<>\\[\\]`\\\\]+$"},"uniqueItems":true}},"minProperties":1},
    "ReportRequest": {"type":"object","additionalProperties":false,"required":["reason"],"properties":{"reason":{"enum":["copyright","face","other"]},"detail":{"type":"string","minLength":0,"maxLength":500}}},
    "AgentImage": {"oneOf":[{"type":"object","additionalProperties":false,"required":["source","attachmentId"],"properties":{"source":{"const":"attachment"},"attachmentId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}},{"type":"object","additionalProperties":false,"required":["source","url"],"properties":{"source":{"const":"url"},"url":{"type":"string","minLength":8,"maxLength":2048,"pattern":"^https://[^\\s/@#]+(?:/[^\\s#]*)?$"}}},{"type":"object","additionalProperties":false,"required":["source","mime","dataBase64","prompt"],"properties":{"source":{"const":"generated"},"mime":{"enum":["image/png","image/jpeg","image/gif","image/webp"]},"dataBase64":{"type":"string","minLength":4,"maxLength":1398104,"pattern":"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"},"prompt":{"type":"string","minLength":1,"maxLength":2000}}},{"type":"object","additionalProperties":false,"required":["source","assemblyId","index"],"properties":{"source":{"const":"assembled"},"assemblyId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"index":{"type":"integer","minimum":0,"maximum":3}}}]},
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
> 범위: 계약을 문서로 고정한다. 서버 조립·`expression.create` 연결(#4820 C)·화면(#4820 B)·격리 디코더(#4676)·`expression.create`(#4829)가 이 증보를 입력으로 구현한다. 이 증보 자체는 코드·migration을 바꾸지 않았다. 부록 B의 블록·코어 스키마·OpenAPI·migration 열은 G7대로 #4820 C2b(2026-10-31)가 합쳤다. 호스팅 문(G3.7 (b))과 G6 지시문은 #4820 C2b 2부(2026-10-31)가, STRICT의 Hermes 쪽 강제와 배포 짝은 3부(2026-10-31)가 닫았다(아래 G3.7·G4·G6).
> **owner 10-30 23:34 결정 ①(생성 방식 ①, #4820 C2a)**: 움직이는 이모티콘은 요청자가 올린 **원본 사진을 바탕으로 편집**한다. 그래서 G4의 「첫 구현은 text-to-image」를 이 결정으로 바꾸고(원본 전달 길 하나를 연다), G8의 「공개·서명 주소로 원본을 내주는 경로」 금지를 그 한 길만 뺀 것으로 좁힌다. 이 결정은 owner의 말이고, 열린 길의 모양·한계·남는 위험은 아래 G4·G8과 [ADR-0203 I2·I4](0203-cohosted-agent-detection.md#증보-2026-10-30--codex-구독-그림-생성만-허용-4820)가 적는다. 나머지(G1~G3, G5~G7)는 바뀌지 않는다.
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

- 원본 그림: D3 「정지 입력」 규격(PNG·JPEG·정지 WebP·단일 프레임 GIF, 한 변 ≤4096, ≤16,000,000 px). 바이트 상한은 요청에 실려 오면 디코드 후 ≤4 MiB(base64 ≤5,592,408자, 전체 요청 ≤6 MiB 예산 안), 서버 안에서 옮겨 온 것이면 ≤5 MiB(D3 입력)다. 폰 사진이 눕지 않도록 **EXIF 방향은 조립 입력에서 적용한다**(여백 색·80% 맞춤·sprite 격자는 돌린 그림 기준이다). 방향 값이 없거나 읽을 수 없으면 저장된 그대로 쓴다. D3 정지 렌디션(직접 올리기·링크)에는 적용하지 않는다(이 증보의 범위 밖).
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

**G3.4 출력.** 후보 1~4개(프리셋 수, 또는 sprite 하나). 각 후보는 GIF89a이고 `size`×`size`이며 프레임·지연은 G3.3 표 또는 요청 값이다. **≤1 MiB**(D3 후보 상한). 반복은 총 4회 재생이다(의미는 D3처럼 디코더 시험으로 확인). 주석·응용 확장은 반복 하나뿐이다. 같은 입력과 같은 값이면 같은 바이트가 나온다(sha 핀이 안정적이다). 출력은 D3의 일반 경로를 다시 지난다. 곧 GIF 입력 검사 → 픽셀 재인코딩 → small/large/thumb이다. 조립 결과를 검사 없이 저장하지 않는다. GIF 지연은 10 ms 단위라서 sprite의 `frameMs`는 **10 ms 단위로 내리고**(45 → 40 ms; 스키마에 `multipleOf`는 두지 않는다), 실제 한 번 재생 길이는 결과의 `durationMs`다. 내림이므로 `길이 × frameMs ≤ 10,000` 검사를 요청 값으로 해도 D3의 10초 상한을 넘지 않는다.

**G3.5 실행 환경.** #4676의 격리 디코더·재인코딩 경로 **안에서만** 돈다(전 출처 공통 semaphore 2, 작업당 할당 192 MiB, 벽시계 10초, 프레임 순차 합성, 무제한 `collect_frames` 금지). 네트워크·셸·외부 프로세스는 없다. **ffmpeg를 쓰지 않고** permissive 라이선스 라이브러리만 쓴다(GPL 계열 양자화 라이브러리 등은 제외하며 선택·검증·NOTICE 귀속은 C가 `deny.toml`로 한다). 서버는 이미지를 생성하지 않고 외부를 호출하지 않는다.

**G3.6 보관과 후보 연결.** 조립 결과는 서버가 `assemblyId`(UUID)로 임시 보관한다. 워크스페이스·요청 에이전트에 묶이고 TTL은 1시간이며 `expression_draft`와 같은 회수 규칙·할당·디코더 동시성을 공유한다(에이전트당 동시에 보관하는 후보 ≤12 = 기존 pending 제안 ≤3 × 후보 ≤4). 후보는 `expression.create`의 `image`에 `{source:"assembled", assemblyId, index}`로 들어간다. **에이전트가 GIF 바이트를 다시 나르지 않는다.** 승인 카드가 보이는 그림은 서버가 조립한 바이트 그대로이고(X8-2), prompt와 `sourceAttachmentId`는 조립 요청 때 서버가 받은 값이 후보의 `origin`이 된다. 다른 에이전트·다른 요청자·다른 워크스페이스의 `assemblyId`는 구분 없는 같은 invalid arguments다. 후보는 한 조립 결과의 일부만 제안해도 되고, 5개 이상이나 서로 다른 조립 결과의 섞임은 `AgentAction`의 상한(후보 ≤4)과 같은 규칙으로 거절한다.

**G3.7 입구.** 입구는 둘이고 같은 조립 함수를 부른다. (a) Agent Port의 MCP 도구 `oort_expression_assemble`(인자 `AssembleRequest`, 결과 `AssembleResult`, 필요한 범위는 `oort_action_propose`와 같고 새 범위는 없다)와 (b) 호스팅 실행(공동 Hermes)의 서버 쪽 문이다. 둘의 입력 한도·실패 사유·보관은 같다. (a)의 답은 둘로 나뉜다. 조립에 성공했거나 G3.8의 카드 코드로 거절한 것은 에이전트가 읽고 카드로 이어 가는 결과라 `isError:false`인 도구 결과(`AssembleResult`, 또는 `{code}`·`{code, bytes}`)로 나가고, 호출 오류(`assembly_params_invalid`와 인가·범위 오류)만 오류 응답이다(`isError:true` 쪽이며, Agent Port에서는 닫힌 `ToolFailure`의 JSON-RPC 오류로 나간다). (b)의 입력 경로는 G4가 확인한 사실로 좁혀진다. Hermes API 서버는 클라이언트가 선언한 함수 도구(`tools`·`tool_choice`)를 읽지 않으므로(Hermes `api_server_openai_routes.py:653-656,723,793`, `/v1/responses`는 `:1054-1060`) 워커의 카탈로그 도구 문은 Hermes에서 열리지 않는다. 남는 후보는 모델의 최종 답에서 `AssembleRequest`와 같은 닫힌 스키마로 검증되는 구조만 읽는 문이다(자유 문장·마크다운을 행동으로 해석하지 않는다). Hermes의 `mcp_servers`에 oort MCP를 다는 길은 커넥터 모드라 ADR-0203 I3과 충돌하므로 새 결정 없이는 쓰지 않는다. 구체 표기와 워커 적합성은 아래대로 #4820 C2b 2부(2026-10-31)가 닫았다.

- **(b)의 닫힌 표기와 처리 [#4820 C2b 2부, 2026-10-31].** 호스팅 문은 **공동 Hermes(`operator_env` 핀) 턴이고 환영·재개가 아니며 트리거 메시지에 요청자의 완료 이미지 첨부가 있을 때만** 켠다(첨부 판정은 C2a 주소 발급과 같은 함수다). 켜진 턴만 모델을 **비스트리밍**으로 부르고 스트리밍 펌프를 건너뛴다. 최종 답에서 읽는 것은 둘뿐이다.
  - **그림**: 요청 블록 밖의 `data:image/(png|jpeg|webp|gif);base64,` 주소 **정확히 하나**. 0개는 그림 없음(`generation_failed`), 2개 이상·다른 형식·base64 아님은 쓸 수 없음(`assembly_source_invalid`), 5 MiB 환산 6,990,508자 초과는 너무 큼(`assembly_source_too_large`, 디코드 전에 길이로 자른다). `MEDIA:` 줄·`file://`·경로·http 이미지는 **그림이 아니며 열지 않는다**(로컬 경로 읽기를 열지 않는다).
  - **요청**: 펜스 ```` ```oort-expression ```` 블록 **정확히 하나**, 한 줄 JSON `{"v":1,"motion":…,"size":240|360|480,"prompt":"…","subjectMemberId":null|uuid,"candidates":[{"name","displayName","tags"}…]}`(모든 객체 `deny_unknown_fields`, `subjectMemberId` 키 필수). `motion`은 `{"kind":"preset","presets":[…]}`·`{"kind":"sprite","frames":n,"sequence":[…],"frameMs":n}`(둘은 `AssembleRequest`와 같은 검사)에, 움직임을 입히지 않는 **정지** `{"kind":"still"}`이 더해진다. 후보 개수는 프리셋 수(sprite·정지는 1). **`sourceAttachmentId`는 표기에서 받지 않는다**: 서버가 트리거 첨부를 다시 판정해 넣고(G1), 모델이 그 사진의 주소를 받은 턴(C2a의 한 줄이 실린 턴)에서만 기록한다. 표기가 없거나 하나가 아니거나 닫히지 않았거나 검증에 실패하면 문은 열리지 않고 턴은 일반 답으로 끝난다. **커밋하는 본문은 Hermes가 내는 형태를 기준으로 정리한다**: 한 줄 `data:image/…;base64,…` 주소(마크다운 이미지)는 지우고, `MEDIA:`가 든 줄과 요청 블록은 통째로 지운다(MiB 단위 base64가 `message`·`outbox`·Centrifugo에 실리지 않는다). 모델이 직접 쓴 다른 형태 — 줄바꿈으로 끊겨 이어지는 base64의 뒷줄, 이미지가 아닌 `data:` 주소 — 는 이 정리가 알아보지 못해 본문에 남는다. 이는 평소 턴에서 모델이 쓴 긴 글이 그대로 커밋되는 것과 같은 급이다. 정리는 그림이 실리는 정상 경로를 위한 것이지, 그림 밖의 임의 텍스트를 막는 장치가 아니다.
  - **정지 갈래**: `{"kind":"still"}`은 조립 없이 받은 그림을 D3 정지 경로(격리 디코더, 줄 서기 ≤3초)로 다시 인코딩해 `generated` 후보 **하나**로 만든다. 조립 갈래는 `try_assemble_with_program`의 출력을 **다시 인코딩하지 않고**(조립 때 D3를 이미 지났다) 보관(G3.6의 임시 보관)도 거치지 않고 그대로 후보로 쓴다. 한 후보만 1 MiB·256 KiB 한도를 넘으면 그 자리는 `manual_upload_required` + `assembly_output_too_large`로 카드에 남고, 전부 넘으면 첫 실패의 측정 크기(`props.bytes`)로 실패 카드가 된다.
  - **실패 카드(G3.8)는 요청 고리의 승인형 카드다**: 진짜 `approval` 행(인자 `{"drafts":[]}`)을 만들어 같은 트랜잭션에서 `cancelled`·결정자 없음으로 닫고, 카드 `props`는 닫힌 `status`·`code`(여섯 중 하나)를 싣고 `body`는 코어 골든 `expression-failure-copy.json`의 한 줄이다. 모델의 말은 싣지 않는다. 서버의 거울 시험이 골든의 행(`code`·`line`·순서)을 서버의 코드(`FAILURE_CODES`)와 독립 사본에 행마다 맞춘다. 오류 매핑은 한 함수다. 조립기를 돌릴 수 없는 운영 장애는 그림의 사유가 아니므로 카드 코드를 만들지 않고 턴을 다시 시도하되, 아래 「응답 크기와 시도 수」의 상한까지만이다.
  - **응답 크기와 시도 수 [#4820 C2b 검수 반영, 2026-10-31].** 워커는 비스트리밍 공급자 응답을 **12 MiB까지만** 읽는다(`Content-Length`가 넘으면 본문을 읽기 전에, 길이를 밝히지 않으면 읽다가 누적이 넘는 순간 멈추고 나머지는 끌어오지 않는다). 상한은 그림 한 장의 base64(6,990,508자 ≈ 6.7 MiB)와 글·요청 블록·JSON 봉투에 40 % 이상의 여유를 둔 값이고, 정상 답은 이보다 한참 아래다(Hermes는 `MEDIA:` 줄마다 그림을 따로 치환하므로 한 줄을 N번 쓰면 N × 약 7 MB가 된다). 넘으면 읽던 것을 버리고 재시도 없이 끝낸다: 문 턴은 닫힌 `generation_failed` 카드, 그 밖의 턴은 평소의 공급자 실패다. 시도마다 Hermes가 그림을 새로 만들므로 문 턴은 조립기를 돌릴 수 없는 장애·공급자 시간 초과·제안 트랜잭션 오류에 **최대 2번** 시도하고, 두 번째 실패는 같은 닫힌 카드로 끝난다(런은 전달된 것으로 닫는다). 그 밖의 공급자 장애(연결 거부·5xx·429)는 평소 시도 예산을 쓴다. 다시 시도하기 전에 그 시도의 토큰을 장부에 쓴다(런당 한 행 규칙이라 둘째 시도의 토큰이 따로 더해지지는 않는다).
  - **성공 카드**는 에이전트 포트의 `expression.create` 제안과 같은 부품을 같은 순서로 쓴다(이니셔티브 잠금 → 런 → 요청자 → 해석 → 에이전트당 대기 3 상한 → 런 정지 → 승인·초안·카드). **값싼 거절은 모델을 부르기 전에** 한다(#4829): 운영자 확인은 읽기 없이 맨 먼저(없으면 문이 닫히고 평소 턴), 런 상태·요청자·대기 3 상한이 모델 호출 앞의 읽기 한 번에서 판정되고(상한이면 모델 호출 0), 제안 트랜잭션이 다시 증명한다.
  - **STRICT [#4820 C2b 3부, 2026-10-31]. 둘 다 켜야 문이 열린다.** 로컬 경로 읽기를 열지 않으려면 Hermes가 `HERMES_MEDIA_DELIVERY_STRICT=1`로 돌아야 한다(strict가 아니면 Hermes는 `MEDIA:` 줄이 가리키는, 거부 목록 밖의 읽을 수 있는 아무 파일이나 답에 싣는다. 고정 이미지의 `validate_media_delivery_path`로 측정했다). (1) **Hermes 쪽**: `infra/hermes/lockgate.py`가 그림 도구가 노출될 때 프로세스 환경의 이 값이 정확히 `1`이 아니면 기동을 거절하고, 볼륨 `.env`에 이 이름이 있으면 값과 상관없이 거절하며(`report`가 기동 뒤에도 같은 규칙을 다시 본다), 템플릿·compose는 리터럴 `1`을 싣는다(시작 명령의 체크섬 사슬이 갱신됐다). (2) **워커 쪽**: 워커는 Hermes를 밖에서 알 수 없으므로 운영자가 환경값 `OORT_HOSTED_MEDIA_STRICT`를 **정확히 `1`**로 확인해야 문이 열린다. **없으면 문은 닫히고 사진 턴은 평소 턴이다**: 사진을 찾지도 않고(읽기 0), 실패 카드도 없고, 모델은 스트리밍으로 평소처럼 불린다(기동 때 info 한 줄 「호스팅 문 꺼짐」). 템플릿·compose는 이 값을 비워서 보낸다. 닫힌 코드는 늘리지 않았다. 게이트는 프로세스 환경만 보므로 다중 프로필 턴(Hermes는 이때 설정의 `gateway.strict`를 읽는다)과 형제 변수(`HERMES_MEDIA_ALLOW_DIRS`·`HERMES_MEDIA_TRUST_RECENT_*`)는 미검증이다(`runtime-unverified`, #4886).

**G3.8 실패 사유와 카드.** 닫힌 코드다. 한도 초과와 생성 실패를 **조용히 자르거나 프레임을 버려 통과시키지 않는다**(D3). (a)에서 카드 코드 다섯(`assembly_source_invalid`·`assembly_source_too_large`·`assembly_output_too_large`·`assembly_timeout`·`assembly_busy`)은 `isError:false` 도구 결과로, `assembly_params_invalid`는 호출 오류로 나간다(G3.7). `generation_failed`는 조립 전 단계의 코드라 (a)가 내지 않는다. 호출 오류는 만들어진 것이 없어 카드가 없고, JSON-RPC -32602의 고정 문장에 `error.data {code, params}`로 틀린 인자의 이름만(`presets`·`frames`·`sequence`·`frameMs`·`size` 중에서만, 값은 싣지 않는다) 싣는다.

| 코드 | 언제 | 남는 곳 | 한국어 한 줄(코어 사전) |
|---|---|---|---|
| `assembly_params_invalid` | 모르거나 중복된 프리셋·`presets` 5개 이상·잘못된 격자/순서·`size` 범위 밖 | 호출 오류(어느 인자가 틀렸는지 이름만). 만들어진 것이 없어 카드 없음 | (사람에게 보이지 않음, 에이전트가 고쳐서 다시 요청) |
| `generation_failed` | 그림 도구가 오류·빈 응답·구독 한도로 그림을 주지 못함, 호스팅 실행에서 받을 그림이 없음, 또는 호스팅 문(G3.7 (b))이 시도 상한(2번)이나 응답 상한(12 MiB)에 닿음(조립기를 돌릴 수 없는 장애·공급자 시간 초과·제안 트랜잭션 오류가 시도를 다 쓰거나 응답이 상한을 넘음. 이 사유는 카드에 싣지 않는다) | 실패 카드 | 그림을 만들지 못했어요 |
| `assembly_source_invalid` | 형식 불허(APNG·움직이는 WebP·SVG·HEIC/AVIF)·디코드 실패·치수/픽셀 한도 초과 | 실패 카드 | 이 그림에는 움직임을 입힐 수 없어요 |
| `assembly_source_too_large` | 원본 바이트 상한 초과 | 실패 카드 | 그림이 너무 커서 움직임을 입힐 수 없어요 |
| `assembly_output_too_large` | 결과 GIF가 1 MiB 초과, 또는 1 MiB 안이어도 D3 재통과의 small 렌디션 상한(256 KiB)을 넘는 경우. 코드는 하나이고 `props`의 `bytes`는 **실제로 조립한 GIF의 크기**(숫자)라 1 MiB보다 작을 수 있다 | 실패 카드. 서버는 크기를 **줄여 다시 만들지 않는다**. 안내는 「프레임 수를 줄이거나 더 작은 size로 다시」이고 에이전트가 그렇게 새 요청을 할 수 있다 | 움직이는 그림이 너무 커요 |
| `assembly_timeout` | 벽시계 10초·할당 상한 초과 | 실패 카드 | 움직임을 입히다가 시간이 다 됐어요 |
| `assembly_busy` | 디코더 동시성 한도 때문에 시작하지 못함, 또는 에이전트당 보관 상한(12) | 실패 카드 | 지금 다른 그림을 처리하고 있어요. 잠시 뒤에 다시 해 주세요 |

위 일곱 코드가 닫힌 목록의 전부다. 조립기를 돌릴 수 없는 운영 장애(실행 파일 없음, 한도가 아닌 이유의 비정상 종료)는 이 목록의 코드가 **아니다**: 서버는 내부 오류(5xx)로만 답하고 `props.code`에 넣지 않으며, 요청이 틀린 것처럼 `assembly_source_invalid`·`assembly_timeout`이나 재시도를 권하는 `assembly_busy`로 둔갑시키지 않는다. 한도(시그널로 끝난 자식)는 그대로 `assembly_timeout`이다. **[#4820 C2b 2차 검수 반영, 2026-10-31]** 다만 호스팅 문(G3.7 (b))은 시도 상한(2번)이나 응답 상한(12 MiB)에 닿으면 닫힌 `generation_failed` 카드로 끝난다: 이 카드의 `props.code`는 목록의 `generation_failed`일 뿐 운영 사유를 싣지 않고 새 코드도 만들지 않는다(G3.7 (b) 「응답 크기와 시도 수」).

「실패 카드」는 요청 고리의 카드가 닫힌 코드(`props.code`)와 한국어 한 줄로 끝나는 것이다. 한국어 문장은 클라이언트가 코어 사전에서 읽고 서버는 같은 골든 데이터의 중립문을 `body`에 쓴다. 영어 원문은 쓰지 않으며 에이전트의 문장이 카드 제목이 되지 않는다([ADR-0186 v6 R-d](0186-agent-workspace-actions.md#r-d-영어-원문을-쓰지-않는다--상태-코드--한국어-accepted-전부-권장으로)). 후보 일부만 실패하면 승인 카드의 그 자리가 부록 C의 `manual_upload_required` + 위 코드(그림 없음, 직접 올리기 안내)로 남고 준비된 후보는 계속 고를 수 있다. 에이전트에 그림 도구가 없는 경우는 후보가 만들어진 적이 없으므로 카드가 아니라 에이전트의 답 「이 에이전트는 그림을 만들 수 없어요」(ADR-0203 I4)다. 새 코드는 C가 부록 C의 표와 부록 B의 `Draft.code`에 함께 더한다(`assembly_params_invalid`는 호출 오류라 카드 코드가 아니다).

### G4. 전달 경로와 확인한 한계 [소스, runtime-unverified]

공동 호스팅 Hermes의 잠금 아래에서 그림이 오가는 길은 다음 사실로만 정한다(ADR-0203 I1의 5·4, 고정 commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`).

- **나가는 길(그림 → oort).** `image_generate`는 PNG를 Hermes 볼륨에 저장하고 **경로만** 돌려준다. `file` 묶음이 꺼져 있어 에이전트는 바이트를 읽어 `generated`의 base64로 만들 수 없다. 응답 쪽 유일한 출구는 최종 답의 `MEDIA:<경로>`이며, API 서버가 5 MiB 이하 이미지에 한해 `data:image/…;base64,…` 주소를 담은 마크다운 이미지로 바꾼다. 이 변환은 **비스트리밍 최종 응답**과 Responses에만 적용되고 스트리밍 조각에는 적용되지 않는다. 따라서 호스팅 실행이 그림을 받으려면 비스트리밍 응답(또는 같은 효과를 내는 경로)을 써야 하고, 받은 그림은 G3.2의 입력 한도(≤5 MiB)와 D3 정지 입력 검사를 지난다. 그림이 없으면 `generation_failed`다. gpt-image-2의 PNG가 5 MiB 안에 들어오는지와 지연(이미지 생성은 수십 초 걸릴 수 있다)이 현행 워커의 시간 제한과 맞는지는 확인하지 않았다.
- **나가는 길의 STRICT [#4820 C2b 3부, 2026-10-31].** 이 `MEDIA:` 출구가 로컬 파일을 읽는 문이 되지 않도록 Hermes는 `HERMES_MEDIA_DELIVERY_STRICT=1`로 돌고(`lockgate.py`가 그림 도구가 켜진 Hermes에 정확히 `1`을 요구하고 볼륨 `.env`의 같은 이름을 거절한다), 워커는 운영자의 `OORT_HOSTED_MEDIA_STRICT=1`이 있을 때만 호스팅 문을 연다. **둘 다 켜야 문이 열리고**, 워커 쪽이 비면 문이 닫혀 사진 턴은 평소 턴이다(G3.7 (b)).
- **들어가는 길(원본 → 도구). [owner 10-30 23:34 결정 ①로 고침 — 처음 쓴 「첫 구현은 text-to-image」를 대체한다.]** Hermes API 서버는 비전 입력(`data:image/` 또는 http(s), `api_server.py:470-540`)을 받아 모델이 그림을 **볼 수** 있게 하지만, 도구의 `image_url`·`reference_image_urls`는 모델이 쓰는 문자열이라 모델은 본 그림의 바이트를 `data:` URL로 다시 쓸 수 없다. 그래서 oort가 대신 **요청자가 같은 대화에 올린 완료·미삭제 이미지 첨부 한 장**을 가리키는 **짧게 사는 자기 주소**를 만들어 호스팅 요청 맥락에 한 줄로 싣고(C2a), 그림 도구가 그 주소를 `image_url`로 받아 원본을 편집한다(공급자가 `images/edits`로 보낸다, ADR-0203 I1-4).
  - **주소.** `{origin}/v1/self-media/{workspace}/{token}`. `origin`은 oort 서버의 공개 출처(`MOMO_PUBLIC_BASE_URL`과 같은 값)다. `MOMO_PUBLIC_BASE_URL`은 api 전용이므로(ADR-0205 D1) 워커에는 같은 값을 `OORT_SELF_MEDIA_ORIGIN`으로 따로 준다. 형식은 `https://<소문자 호스트>[:포트]` 하나뿐이다(끝 슬래시·`:443`·사용자 정보·대문자·비ASCII·IP처럼 보이는 호스트 거절). 값이 없거나 형식이 틀리면 주소를 만들지 않는다.
  - **토큰.** 32바이트 난수(추측 불가). DB에는 **SHA-256만** 둔다(migration 160 `self_media_token`, RLS FORCE, 로그·감사·outbox에는 토큰도 Drive id도 없다. 「해시만」은 이 표의 사실이지 토큰이 지나가는 모든 곳의 사실이 아니다: 남는 위험 (b)·(e)·(f)). 수명 **5분**(표의 천장은 10분), **한 번만** 쓴다(소비는 `UPDATE … WHERE used_at IS NULL AND expires_at > now()` 한 문장이라 동시에 둘이 이기지 못한다). 워크스페이스·런·에이전트·요청자·대화·첨부에 묶인다. 풀 때 **런이 아직 진행 중**(queued·running)이어야 하고, 첨부 소유를 다시 재판정한다(`find_requester_attachment_in_tx`의 규칙: 완료 이미지, ≤5 MiB, 요청자가 쓴 살아 있는 메시지, 그 대화). 만들 때는 같은 워크스페이스의 하루 지난 행을 지운다. **표 권한은 흐름이 쓰는 것만 둔다**(`self-media-token-lockdown`, migration 160과 두 bootstrap 파일에 같은 글자): `momo_worker`는 SELECT·INSERT·DELETE(만들기·청소), `momo_app`은 SELECT·UPDATE(풀기), relay·notifier·platform_admin은 없다. BYPASSRLS 역할은 RLS를 건너뛰므로 표 권한이 마지막 문인데, 해시만 담아도 쓰기가 열려 있으면 DB만 뚫린 역할이 임의의 (런·요청자·첨부) 행을 넣어 api의 Drive 자격으로 그 이미지를 읽게 할 수 있기 때문이다(보안 검수 L6 반영).
  - **무엇을 가리키는가.** 요청 메시지(런의 트리거)의 첫 이미지 첨부 하나뿐이다. 첨부 id는 에이전트·모델·호출자 누구도 정하지 못한다(서버가 DB의 사실로만 고른다). 공동 Hermes(`operator_env` 핀) 턴에서만 만들고, 환영·요청자 없는 턴에서는 만들지 않는다. (모델이 읽는 글에 실리는 주소에 대한 말이다. 워커가 **자기** 요청 하나에 쓰는 읽기 주소는 별개이고 첨부 id를 제안 인자에서 받되 같은 소유 술어를 통과해야 하며 어떤 글에도 실리지 않는다: [ADR-0151 증보 3](0151-attachments-v0-drive-contract-port.md#증보-3-2026-10-31-4934-워커의-첨부-읽기---api의-사설-주소로-단일-사용-주소-하나), #4934.)
  - **응답.** 리디렉션이 없다. 바이트는 oort가 직접 내주고 Drive 주소·Drive 헤더·Drive id는 나가지 않는다(`Content-Type`은 첨부 행의 mime이고 바이트가 그 이미지 형식으로 시작해야 한다). 남의 첨부, 없는 id, 다른 워크스페이스, 만료, 재사용, 끝난 런, 지워진 메시지, Drive 오류는 **모두 같은 404**다(주소로는 어느 쪽인지 알 수 없다). 소비 뒤 Drive 오류는 토큰을 태운다(단 한 번의 약속이 우선이다). GET만 받는다. 거절만 예산을 쓰고, 그 예산은 이 라우트의 **자기 한도**(`RATE_LIMIT_SELF_MEDIA_PER_WORKSPACE`, 기본 30)이며 호출자 주소와 **경로의 워크스페이스로 나뉜다**: 한 워크스페이스의 가짜 주소가 같은 Hermes 주소에서 오는 다른 워크스페이스의 정당한 받기를 막지 못한다(보안 검수 L7 반영). 경로의 워크스페이스를 바꿔 가며 예산을 피하지 못하도록 주소 전체의 상한(한도의 10배)이 따로 있고, 예산이 다 쓰인 키는 핸들러 앞에서 같은 429를 받는다. 남는 한계: 다른 워크스페이스의 id를 경로에 넣을 수 있는(그 id를 아는) 호출자는 그 워크스페이스의 한도를 자기 주소에서 쓸 수 있고, 주소 전체의 상한을 넘기는 홍수는 창이 지날 때까지 모든 워크스페이스에 429다.
  - **요청 맥락에는 한 줄만 싣는다.** 「첨부 사진 주소 — 그림 도구의 원본(image_url)으로만 쓰고, 5분 뒤 만료: …」. G6의 나머지 지시문은 이 줄이 아니다(C2b).
  - **도구 쪽 문.** oort-image-guard가 `image_url`에 한해 정확히 이 모양 하나만 통과시킨다(바이트 단위 비교, ADR-0203 I2). `reference_image_urls`는 계속 빈 값·작은 inline 그림만이다. 그 밖의 주소·경로는 지금처럼 모두 도구 실행 전에 거절한다.
  - **남는 위험.** (a) 그 사진의 바이트가 OpenAI의 이미지 처리로 간다(prompt와 같은 급, ADR-0203 I2). 사람 얼굴이 있어도 D6·G2의 당사자 승인은 **등록**만 막고 외부 전송을 막지 않는다. (b) 토큰은 호스팅 요청 맥락에 평문으로 있으므로 모델이 답에 되풀이하면 메시지·outbox에 남을 수 있다. 완화: 5분·1회·런이 끝나면 죽음·요청자 본인의 같은 대화 첨부 한 장(그 대화 사람은 이미 볼 수 있다)이며, 오류 문구에 되풀이된 주소는 `redact_secrets`가 토큰을 지운다. (c) Hermes가 주소를 내려받다 실패하면(예: 사설 주소로 풀리는 환경, Hermes의 SSRF 필터) 토큰은 이미 쓰였거나 쓰이지 않은 채 5분 뒤 죽고, 그림은 `generation_failed`다. (d) 주소는 경로에 토큰이 있어서 oort가 통제하지 못하는 쪽의 기록(Hermes 자신의 로그, 호스팅 플랫폼의 엣지 요청 로그)에 남을 수 있다. oort 쪽은 요청 경로를 로그에 쓰지 않고(저장소의 Caddy 설정도 접근 로그를 켜지 않는다), 남아도 5분·1회·런 종료로 죽은 값이다.
  - (e) **Hermes 쪽 기록(고정 소스를 읽어 확인한 사실, 보안 검수 L3).** 맥락 한 줄은 API 서버가 `ephemeral_system_prompt`로 받아 세션 DB·프롬프트 캐시에 남지 않는다(`turn_context.py:1341-1346`, `system_prompt.py:766`. oort가 세션 헤더를 보내지 않아 세션 id는 시스템 줄과 첫 사용자 메시지로 정해지고, 줄에 토큰이 있어 런마다 새 세션이다). 그러나 모델이 그림 도구를 부르면 **도구 호출 인자(주소 포함)와 도구 결과가 Hermes 세션 DB(`state.db`)에 남고**, `messages_fts`가 `tool_calls`까지 색인한다(`hermes_state_fts.py`). 이 이미지는 `session_search`·`memory`를 켜 두므로(`infra/hermes/config.yaml`의 `platform_toolsets.api_server`) **같은 Hermes를 쓰는 다른 런(다른 요청자·다른 워크스페이스 포함)이 그 주소를 검색해 자기 `image_url`에 넣을 수 있다.** 플러그인은 발급 여부를 모르고 모양만 보므로((g)) 막는 것은 토큰의 창뿐이다: 아직 쓰이지 않았고 그 런이 진행 중인 동안, 곧 **도구가 내려받기 전에 실패한 경우**(예: Hermes의 SSRF 사전 검사 실패)에만 열려 있다. 내려받기가 성공했으면 토큰은 이미 쓰였고, 런이 끝나면 죽는다. 막는 장치는 1회·5분·런 진행 중·풀 때 소유 재판정(요청자가 아직 그 대화의 멤버이고 그 첨부가 아직 요청자의 완료 이미지)이라서, 찾아낸 주소로 얻는 것은 **그 요청자의 그 대화 첨부 한 장을 한 번**이고 그 첨부는 그 대화 사람이 이미 볼 수 있다. `memory`에 주소가 적혀 교차 세션 기억이 되어도 런이 끝나면 죽은 값이다. 이 이미지에서 `session_search`가 꼭 필요한지(끄면 이 창이 닫힌다)는 **후속으로 planner가 정한다**. 이 증보는 코드를 바꾸지 않았고 실제 `session_search`를 실행해 보지 않았다(`runtime-unverified`).
  - (f) **오류 문구가 값을 되풀이한다.** codex 공급자의 오류가 받은 값을 그대로 담는다(`Image URL failed the SSRF safety check: {value}`·`did not return a supported image: {value}`·`exceeds 25MB cap: {value}`, `plugins/image_gen/openai-codex/__init__.py:122-135`). 그 문구는 도구 결과·Hermes 로그·모델의 답으로 갈 수 있다. oort가 받는 오류 문자열은 `redact_secrets`가 토큰을 지우지만 Hermes 자신의 로그와 기록은 oort가 지우지 못한다. 성공한 내려받기의 요청 줄은 Hermes 로그에 찍히지 않는다(httpx 로거를 WARNING으로 눌러 둠, `hermes_logging.py:217-224`).
  - (g) **경로 비트.** 플러그인은 `image_url`이 정확한 출처·접두·소문자 uuid·토큰 43자의 모양인지만 보고 그 값이 발급된 것인지는 모른다. 그래서 모델이 고르는 uuid·토큰 자리(약 380비트)가 설정된 출처로 가는 요청의 경로에 실릴 수 있다. 도착지는 항상 그 출처 하나이고 응답은 발급하지 않은 주소에 대해 상수 404라 되돌아오는 것이 없다. 이 길로 모델이 oort에 줄 수 있는 것은 경로의 문자열뿐이고 oort는 그것을 로그에 쓰지 않는다. 모델이 이 자리에 다른 워크스페이스의 id를 넣을 수 있으므로 예산 한계는 위 응답 항목에 적었다.
- 코드를 실행해 파일을 읽을 수 있는 외부 런타임(Agent Port)은 자기 그림을 `source.from="base64"`(≤4 MiB)로 보내거나 대화 첨부를 `source.from="attachment"`로 쓸 수 있다. 모델이 직접 쓰는 MiB 단위 base64는 현실적이지 않으므로 파일을 읽어 보내는 런타임에 한한다.
- 미검증: 위 비스트리밍 경로가 워커의 응답 처리와 맞는지, 모델이 `MEDIA:` 표시를 실제로 쓰는지, 5 MiB·시간 한도 안에서 실제 그림이 들어오는지, 구독 한도에 걸릴 때의 오류 모양. **들어가는 길(C2a)에서는**: 실제 Hermes가 자기 주소를 공개 도메인에서 내려받는지(Hermes의 SSRF 필터가 그 주소를 사설로 보지 않는지, 리디렉션 없이 받는지), 실제 모델이 주소를 `reference_image_urls`가 아니라 `image_url`에 넣는지, Codex `images/edits`가 이 사진을 받아들이는지, 실제 Railway 기동. 이 증보는 이를 확인했다고 주장하지 않는다(`runtime-unverified`). 서버 쪽(토큰·응답·헤더)과 플러그인·게이트(바이트 비교·카나리)는 실제 PG·고정 이미지 안에서 시험했다. 위 (e)의 Hermes 쪽 기록은 고정 소스를 읽어 확인했을 뿐 실제로 실행해 보지 않았다.

### G5. 비용은 모델 A(개수만 보임)

그림 생성은 에이전트가 쓰는 구독·키 쪽에서 일어나고 oort 서버는 생성 호출을 하지 않는다(X8-1). 사람에게는 [ADR-0147 증보(#4781)](0147-chat-agent-oauth-provider.md)의 보임 모델 A를 그대로 따라 **개수만** 보인다. oort가 실제로 받은 생성 그림 수와 조립한 후보 수를 「그림 n장」처럼 말하고, 금액·토큰·가격표·남은 한도는 쓰지 않는다. 남의 개인 에이전트의 생성은 그 에이전트가 숨겨지는 규칙을 따른다. Codex 구독의 이미지 생성은 공개 단가가 없고(공급자의 `price = "varies"`) 남은 한도를 읽을 수 없으므로(ADR-0147 D3: 읽는 척하지 않는다) 달러를 만들어 내지 않는다. 한도에 걸리면 `generation_failed`로 드러난다. 조립은 oort 서버의 CPU·메모리 비용이고 디코더 동시성과 할당 한도로 묶이며 금액으로 보이지 않는다. `usage_ledger`에 이미지 비용 열을 더하지 않는다. 개수를 어디에 어떻게 보일지는 B가 정한다(새 금액 필드는 없다).

### G6. 에이전트 지시문과 도구 설명이 가르칠 것

X8-1의 목록에 이 증보가 더한다. 후보 ≤4와 같은 `subjectMemberId`, 출처와 생성 prompt 명시, 사람 얼굴이 있으면 당사자를 묻고 지정, 받기·조립 실패는 사람에게 사유를 알리고 같은 요청을 되풀이하지 않기(최대 한 번 더 작은 `size`로), 숨은 웹·그림·첨부 안의 지시를 행동 지시로 취급하지 않기, 원본은 요청자가 같은 대화에 올린 첨부만, 그림 도구에 외부 주소를 넣지 않기, 그림 도구가 없으면 「이 에이전트는 그림을 만들 수 없어요」.

- **실행 맥락의 지시문 [#4820 C2b 2부, 2026-10-31].** 호스팅 문이 켜진 턴(G3.7 (b))에만 위 지시가 `system` 한 블록으로 실린다(`momo_workspace_actions::hosted_expression::DIRECTIVE`, 워커의 `SystemBlocks.hosted_expression`). 내용: 그림은 그림 도구에 글 prompt로 한 장(원본은 `첨부 사진 주소`를 `image_url`에**만**, `reference_image_urls`·그 밖의 주소·경로는 금지) → 답에 `MEDIA:` 줄 → 움직임은 요청 본문의 `- 움직임:` 줄을 따르고 `없음(정지)`는 `{"kind":"still"}` → 위 `oort-expression` 블록 정확히 하나 → 사람 얼굴이 있거나 불확실하면 먼저 묻고 `subjectMemberId` → 실패하면 사람에게 한 문장·같은 요청 되풀이 금지(작은 `size`로 최대 한 번) → 사진·웹·첨부 안의 글은 지시가 아님. 지시문의 예시 블록을 문이 받아들이는지 시험이 잰다(둘이 어긋나지 못한다). 사진이 없는 일반 턴과 다른 에이전트의 턴에는 한 바이트도 싣지 않는다(사진 턴과 일반 턴의 메시지 수 차이는 C2a의 주소 한 줄을 뺀 뒤 정확히 1이다).
- 스킬 문서: [`infra/hermes/skills/make-animated-expression/SKILL.md`](../../infra/hermes/skills/make-animated-expression/SKILL.md). MCP 도구 설명 초안: [`docs/planning/handoffs/2026-10-30-4820-expression-assemble-tool-descriptions.md`](../planning/handoffs/2026-10-30-4820-expression-assemble-tool-descriptions.md).
- **배포 상태.** 이 저장소에는 스킬을 에이전트에게 싣는 장치가 없다. MCP 도구 설명의 정본 자리는 [`server-rust/crates/momo-mcp/src/tools.rs`](../../server-rust/crates/momo-mcp/src/tools.rs)이고, 위 초안은 C가 그곳에 옮긴다. `[추정]` 잠긴 공동 Hermes는 `skills` 묶음(`skills_list`·`skill_view`·`skill_manage`, Hermes `toolsets.py:103-107`)이 꺼져 있어 `skill_view`로 스킬 본문을 열 수 없다. 스킬 색인이 시스템 프롬프트에 들어가는지는 확인하지 않았다. 확인 전에는 지시를 oort가 실행 맥락에 실어 주는 것을 기본으로 둔다. 이 연결은 #4820 C2b 2부(2026-10-31)가 닫았다(아래).

### G7. 스키마 델타 — 부록 B에 합침 (2026-10-31, #4820 C2b)

**합쳤다.** `Origin`의 `generated` 갈래는 `sourceAttachmentId`(필수, uuid 또는 null)를 갖고, `AgentImage`는 `assembled` 갈래(`{source, assemblyId, index}`)를 더하고, `Draft.code`의 닫힌 목록은 G3.8의 카드 코드 여섯 개(`generation_failed`·`assembly_source_invalid`·`assembly_source_too_large`·`assembly_output_too_large`·`assembly_timeout`·`assembly_busy`)를 더했다. 위 부록 B의 `expression-contracts-v1` 블록, [코어 스키마](../../packages/momo-core/src/features/expressions/contracts.schema.json), OpenAPI, migration 161이 같은 값이며 `verify-contract.mjs`가 블록과 코어 스키마의 동치를 잰다. 서버가 내는 모든 `generated` 출력(`Draft`와 `Expression`의 `origin`)은 포인터 키를 **항상** 싣는다(값은 uuid 또는 null, 다른 출처 종류에는 이 키가 없다). JSON Schema로 나타낼 수 없는 규칙(`sequence`의 값이 `frames` 안, 길이 × `frameMs` ≤ 10,000, 첨부·`assemblyId` 소유, 같은 `subjectMemberId`)은 서버가 강제한다. `assembled`의 소유 판정은 읽기 SQL이 직접 한다(`assembly::get_in_tx`가 워크스페이스·에이전트·요청자를 인자로 받아 거른다): 다른 에이전트·다른 사람·다른 워크스페이스·만료·없는 id는 구분 없는 같은 invalid arguments다. 한 제안은 한 조립 결과만 쓰고(서로 다른 `assemblyId`의 섞임·같은 후보 두 번은 거절), 제안 tx가 그 조립 행을 잠가 다시 확인한 뒤 초안을 만들고 같은 tx에서 회수한다(한 조립은 한 제안만 가져간다).

아래 블록에는 MCP 도구 `oort_expression_assemble`의 인자·결과 스키마 넷(`AssembleSource`·`AssembleMotion`·`AssembleRequest`·`AssembleResult`)만 남는다. 도구 인자는 `AssembleRequest`에 리스 `handle`을 더한 것이다(C1b). 이 도구 스키마의 정본은 [`momo-mcp/src/tools.rs`](../../server-rust/crates/momo-mcp/src/tools.rs)이고, `expression.create`의 `image` 스키마는 `momo-agent`와 `momo-mcp`에 같은 복사본이 있어 두 곳을 함께 고친다(드리프트 시험이 동일을 잰다).

<!-- expression-augment-4820:start -->
```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "urn:oort:expressions:v1:augment-4820",
  "$defs": {
    "AssembleSource": {"oneOf":[{"type":"object","additionalProperties":false,"required":["from","attachmentId"],"properties":{"from":{"const":"attachment"},"attachmentId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"}}},{"type":"object","additionalProperties":false,"required":["from","mime","dataBase64"],"properties":{"from":{"const":"base64"},"mime":{"enum":["image/png","image/jpeg","image/gif","image/webp"]},"dataBase64":{"type":"string","minLength":4,"maxLength":5592408,"pattern":"^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"}}}]},
    "AssembleMotion": {"oneOf":[{"type":"object","additionalProperties":false,"required":["kind","presets"],"properties":{"kind":{"const":"preset"},"presets":{"type":"array","minItems":1,"maxItems":4,"uniqueItems":true,"items":{"enum":["bounce","wobble","pulse","sparkle"]}}}},{"type":"object","additionalProperties":false,"required":["kind","frames","sequence","frameMs"],"properties":{"kind":{"const":"sprite"},"frames":{"enum":[2,3,4]},"sequence":{"type":"array","minItems":2,"maxItems":24,"items":{"type":"integer","minimum":0,"maximum":3}},"frameMs":{"type":"integer","minimum":40,"maximum":500}}}]},
    "AssembleRequest": {"type":"object","additionalProperties":false,"required":["source","motion","prompt","sourceAttachmentId"],"properties":{"source":{"$ref":"#/$defs/AssembleSource"},"motion":{"$ref":"#/$defs/AssembleMotion"},"size":{"enum":[240,360,480]},"prompt":{"type":"string","minLength":1,"maxLength":2000},"sourceAttachmentId":{"oneOf":[{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},{"type":"null"}]}}},
    "AssembleResult": {"type":"object","additionalProperties":false,"required":["assemblyId","expiresAtMs","candidates"],"properties":{"assemblyId":{"type":"string","minLength":36,"maxLength":36,"pattern":"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"},"expiresAtMs":{"type":"integer","minimum":0},"candidates":{"type":"array","minItems":1,"maxItems":4,"items":{"type":"object","additionalProperties":false,"required":["index","motion","frames","durationMs","bytes","sha256"],"properties":{"index":{"type":"integer","minimum":0,"maximum":3},"motion":{"enum":["bounce","wobble","pulse","sparkle","sprite"]},"frames":{"type":"integer","minimum":2,"maximum":24},"durationMs":{"type":"integer","minimum":40,"maximum":10000},"bytes":{"type":"integer","minimum":1,"maximum":1048576},"sha256":{"type":"string","minLength":64,"maxLength":64,"pattern":"^[a-f0-9]{64}$"}}}}}}
  }
}
```
<!-- expression-augment-4820:end -->

`oort_expression_assemble`(G3.7 (a))의 호출 인자는 `AssembleRequest`에 문자열 `handle`을 더한 것이다(위 블록에는 넣지 않는다). `handle`은 다른 Agent Port 도구와 같은 봉인된 lease 핸들(`oort_jobs_claim`이 준 값)로 호출한 연결과 그 런에 묶인다. 첨부 출처가 「요청자가 같은 대화에 올린 첨부」(G6)라서, 그 요청자와 대화를 서버가 이 핸들의 런으로 증명해야 하기 때문에 필요하다.

### G8. 열지 않는 것과 구현·검수 인계

- 열지 않는 것: 영상→GIF(#4819), 여러 개를 묶는 세트(팩), 외부 GIF API, 서버의 이미지 생성 호출, ffmpeg, 자동 얼굴 탐지, 그리고 **G4의 자기 주소 하나를 뺀** 모든 원본 전달 길이다. 곧 Drive 주소, 만료 시각을 붙인 서명 주소, 첨부 열람 경로의 주소, 임의 출처의 주소, 로컬 경로, 두 번 이상 쓰이는 주소, 리디렉션하는 주소, 첨부 id를 호출자가 고르게 하는 길은 계속 닫혀 있다(워커가 **자기** 요청 하나에 쓰는 읽기 주소는 G4의 괄호대로 별개다 — [ADR-0151 증보 3](0151-attachments-v0-drive-contract-port.md#증보-3-2026-10-31-4934-워커의-첨부-읽기---api의-사설-주소로-단일-사용-주소-하나), #4934). 원본 픽셀을 `images/edits`로 보내는 길은 **G4의 자기 주소를 `image_url`로 받을 때에 한해** 열린다(owner 10-30 23:34 결정 ①). 이 예외의 보안 검수는 등급 2다(원본 주소가 새는지, 다른 첨부·다른 길로 넓어지는지, 출처 비교의 정규화 우회).
- C(서버): G7의 델타를 부록 B·코어 스키마·fixture·OpenAPI·migration 열과 한 번에 합치고 `verify-contract.mjs`를 같이 고친다. 조립 함수(G3)를 #4676의 격리 경로 안에 두고 MCP 도구와 호스팅 문을 연결하며 G4의 전달 경로를 확인한다. 증거는 실제 비우회 PG 역할로 두 테넌트에서 `sourceAttachmentId`와 `assemblyId`의 소유 판정, 프리셋 네 개와 sprite 세 격자의 프레임 수·지연·≤1 MiB·4회 재생, 한도 초과·형식 불허·시간 초과의 실패 코드(조용한 절단 없음), 얼굴 선언 후보의 당사자 승인, 에이전트당 후보 ≤12 보관과 TTL 회수, 허용하지 않는 라이선스 의존이 없는 것이다. 사보타주는 지키는 줄마다 한다.
- C의 요구사항(보안 검수 10-30): 호스팅 문이 `MEDIA:` 표시를 수확하려면 Hermes를 `HERMES_MEDIA_DELIVERY_STRICT=1`로 띄워야 한다. 기본(비엄격) 모드는 거부 목록에 없는 어떤 로컬 파일 경로도 전달 대상으로 인정한다([`gateway/platforms/base.py:1192-1195`](https://github.com/NousResearch/hermes-agent/blob/d923a5eb487a17c0a68801bba9ef0f56c81040a8/gateway/platforms/base.py#L1192-L1195)). 이 증보는 로컬 경로 읽기를 열지 않으며, 이 값을 시작 명령·게이트에 넣는 일은 C의 몫이었고 #4820 C2b 3부(2026-10-31)가 닫았다(G3.7 (b)·G4; ADR-0203 I2의 훅 가드는 `image_url`·`reference_image_urls`만 본다).
- B(화면): 「AI와 만들기」(원본 그림 → 움직임 → 만들 에이전트), 후보 카드(움직이는 미리보기·4회 재생·동작 줄이기면 정지), 실패 카드의 코드별 한국어 줄, 「원본 사진」 줄, 개수만 보이는 비용 표시.
- 독립 검수는 보안 경계(ADR-0203 증보)와 이 증보를 함께 본다. 실제 Codex 이미지 응답·`MEDIA` 변환·GIF 인코딩 실측·실기기는 **runtime-unverified**다.

## 8. 증보 2026-10-31 — 사진 이모티콘의 「배경 정리」: 뜻과 방식 비교, 권장안 (#4931)

> Status: **Proposed — owner 선택 대기** (2026-10-31). 근거: [#4931](https://github.com/yeomyeonggeori/oort/issues/4931) 본문의 owner 요청 「사진으로 이모티콘만들기(에이전트 활용해서 배경 크롭정도는 되면 좋겠다 생각)까지 다음 승격에 진행할 예정이니까 진행시작해줘.」
> 범위: **설계와 측정 절차만이다.** 이 절은 코드·migration·env·계약을 바꾸지 않았고 Hermes·docker·로그인·그림 생성을 하나도 실행하지 않았다(전부 runtime-unverified). D1~D6과 G0~G8은 그대로다. owner가 H5의 권장안을 고르고 이 절이 Accepted가 될 때에만 G3.2의 한 문장(「누끼·배경 제거 없음」)이 바뀌며, 구현은 S5 이슈가 한다.
> 표기: **[확인]** 고정 소스·공식 문서·이 저장소의 코드를 읽어 확인(출처와 줄 번호, 2026-10-31) · **[추정]** 읽은 사실에서 이은 판단 · **[미확인]** 확인하지 못함. Hermes 소스는 G4와 같은 고정 commit `d923a5eb487a17c0a68801bba9ef0f56c81040a8`이다.
> 같이 읽는 것: 실제 Hermes 리허설 절차 [docs/runbooks/hermes-photo-expression-rehearsal.md](../runbooks/hermes-photo-expression-rehearsal.md)(실행은 owner 승인 뒤 planner).

### H0. 지금 길이 하는 것과 못 하는 것

지금 길은 원본 사진을 자기 주소로 Hermes 그림 도구에 건네고(`images/edits`) **새로 그린 그림**을 받아 서버가 D3 규격으로 다시 인코딩한다(G4·G3). 원본 픽셀은 저장되지 않는다. 그래서 오늘 결과는 **불투명한 사각 그림**이다.

- 서버는 조립 때 가장자리 한 줄의 채널별 중앙값 색으로 여백을 채우고, 가장자리가 이미 투명이면 투명을 유지한다(`server-rust/crates/momo-expressions/src/assemble/render.rs:120-148`). 누끼는 없다(G3.2).
- 그림 도구는 요청으로 투명을 고를 수 없다. Codex 구독 공급자가 모든 요청 본문에 `"background": "opaque"`를 싣고(`plugins/image_gen/openai-codex/__init__.py:183-184`) `generate()`가 받는 인자는 `prompt`·`aspect_ratio`·`image_url`·`reference_image_urls`뿐이다(`:264-268`). [확인]
- 모델은 사진을 **보지 못한다.** 워커가 모델에 보내는 대화 메시지는 `role`과 문자열 `content`뿐이라(`server-rust/bins/momo-agent-worker/src/provider.rs:102-105`) 사진은 「첨부 사진 주소」 한 줄로만 간다. [확인]
- 호스팅 실행 지시문(`hosted_expression::DIRECTIVE`, `server-rust/crates/momo-workspace-actions/src/hosted_expression.rs:62-73`)에는 배경에 대한 말이 없다. 「단색 배경」은 스킬 문서(`infra/hermes/skills/make-animated-expression/SKILL.md` Step 2)에만 있는데, 잠긴 공동 Hermes는 `skills` 묶음이 꺼져 있어 그 본문을 열 수 없다고 G6가 적었다. 그래서 지금은 모델이 배경을 마음대로 정한다. [확인: 지시문에 배경 말이 없다 · 추정: 스킬이 Hermes에 실리지 않는다(G6)]

### H1. 「배경 정리」는 두 축으로 갈린다

| 축 | 갈래 | 뜻 |
|---|---|---|
| 무엇을 남기나 | 잘라내기(크롭) | 피사체를 감싼 사각형만 남긴다. 사각형 안의 배경은 남는다 |
| 무엇을 남기나 | 누끼 따기 | 배경을 투명하게 하고 피사체 윤곽만 남긴다 |
| 언제 하나 | 모델 앞 | 원본 사진을 손질한다. OpenAI로 가는 바이트가 달라진다 |
| 언제 하나 | 모델 뒤 | 에이전트가 새로 그린 그림을 손질한다. 원본 사진은 그대로 간다 |

이모티콘에 필요한 것은 대체로 누끼이고 잘라내기는 피사체를 크게 보이게 하는 보조다. 둘은 합칠 수 있다: 누끼를 한 뒤 남은 픽셀의 사각형으로 자르면 둘 다 된다. 움직이는 결과(GIF)는 투명이 1비트(알파 128 이상이면 불투명, 아니면 완전 투명)라 윤곽이 계단져 보일 수 있고(`render.rs:369-383`) 이는 어느 방식이든 같다. [확인] 어느 방식도 D6·G2의 얼굴 규칙을 면제하지 않는다: 얼굴이 있는 사진은 당사자만 승인하고, 배경을 지워도 같다.

### H2. 확인한 사실

1. **[확인] 투명 출력은 지시문으로 못 얻는다.** H0의 `"background": "opaque"`와 인자 목록. 공급자는 `quality`·`size`를 백엔드가 지키지 않을 수 있다고 적는다(`:13-15`).
2. **[확인] 공식 이미지 생성 가이드(OpenAI, 2026-10-31 읽음)** 는 투명 배경을 `background: "transparent"`와 png 또는 webp 출력으로 요청한다고 적고, 그 문장이 가리키는 모델은 가이드가 이름을 든 `gpt-image-2.5-sunburst`·`gpt-image-2.5-flare`다. 이 공급자가 보내는 `gpt-image-2`의 투명 지원은 가이드에 없다. **[미확인]** 구독(Codex) 백엔드가 `gpt-image-2`에서 투명을 지원하는지, `background` 값을 따르는지.
3. **[확인] 시간·크기 단서**(Hermes 자신의 표기이고 oort 실측이 아니다): 공급자 표의 `~15s`(low)·`~40s`(medium, 기본)·`~2min`(high)(`plugins/image_gen/_common.py:26,32,38`), 결과는 정사각 1024×1024 PNG(`:17-18`), Hermes→Codex 읽기 시간 300초(`__init__.py:211`). 워커의 공급자 호출 마감은 `PROVIDER_REQUEST_TIMEOUT_MS` 기본 120,000 ms(`server-rust/bins/momo-agent-worker/src/config.rs:664`)이고 호스팅 문은 시간 초과에 최대 2번 시도하며(`hosted_door.rs`의 `DOOR_MAX_ATTEMPTS`) 시도마다 새 그림이다. Hermes가 `MEDIA:` 파일을 그림 주소로 바꾸는 것은 5 MiB 이하뿐이다(`gateway/platforms/api_server.py:860-900`).
4. **[확인] 모델에게 사진을 보이려면 전송 형식을 바꿔야 한다.** Hermes API 서버는 `image_url` 내용 조각(`data:image/…` 또는 http(s))을 받는다(`api_server.py:462-545`). 그러나 사진 주소 토큰은 한 번만 쓰이므로(G4) 같은 주소를 비전 입력에도 쓸 수 없고, 보이려면 인라인 `data:`(5 MiB 사진의 base64는 약 6.7 MiB)로 싣는다. [추정] **[미확인]** oort가 쓰는 모델이 사각형 좌표를 얼마나 정확히 내는지.
5. **[확인] 서버 쪽 발판**: 가장자리 중앙값 색, 투명 가장자리 유지, GIF 1비트 마스크(`render.rs`), 정지 렌디션이 RGBA PNG라 알파가 남는다(`media.rs:339-352`), 조립기·디코더는 격리 child의 작업당 192 MiB·10초(G3.5). 이미지 처리는 `image` 0.25(`server-rust/Cargo.toml:60`).
6. **[확인] 기기 안 피사체 들어올리기**: Apple `VNGenerateForegroundInstanceMaskRequest`는 iOS 17.0+·macOS 14.0+이고, `VNInstanceMaskObservation.generateMaskedImage(ofInstances:from:croppedToInstancesExtent:)`는 지정한 인스턴스만 남기고 나머지를 투명하게 한 고해상도 이미지를 만들며 `croppedToInstancesExtent`로 가장 작은 사각형에 자른다(developer.apple.com 문서). 이 저장소의 폰 iOS 배포 대상은 **16.4**(`clients/mobile/ios/MomoMobile.xcodeproj/project.pbxproj`), 데스크탑 macOS 최소는 14.0(`clients/desktop/src-tauri/tauri.conf.json:55`)이다. `objc2-vision` 0.3.2(Zlib OR Apache-2.0 OR MIT)가 이 둘을 노출하고(crates.io·docs.rs), 데스크탑 셸은 이미 `objc2` 계열을 쓰며(`clients/desktop/src-tauri/Cargo.toml` macOS 블록) 폰은 자체 Expo 네이티브 모듈 관례(`clients/mobile/modules/momo-*-native`)가 있다. **[미확인]** 시뮬레이터에서의 동작, 사람·동물 밖 대상의 품질, 브라우저(웹)의 같은 능력.
7. **[확인] 서버 배경 제거 모델의 라이선스**(GitHub License API·Hugging Face API, 2026-10-31): U²-Net·IS-Net(DIS)·MODNet·SAM 2 저장소는 Apache-2.0, BiRefNet은 저장소 MIT·가중치 카드 `license: mit`, rembg(Python 도구)는 MIT, ONNX Runtime은 MIT. **탈락**: BRIA RMBG-2.0(카드 `license_link`가 CC BY-NC 4.0, 비상업), BRIA RMBG-1.4(카드 `license: other`, 약관 링크가 이날 404라 본문을 읽지 못함 — permissive라는 근거가 없다). **[미확인]** U²-Net·IS-Net 사전학습 가중치(저장소 README의 외부 링크로 배포)에 저장소와 다른 조건이 있는지. 가중치 크기: ONNX 변환본 `u2net.onnx` 176.0 MB·`isnet-general-use.onnx` 178.6 MB·`u2netp.onnx` 4.6 MB(rembg 릴리스 자산), BiRefNet `model.safetensors` 444.5 MB·lite 177.6 MB(Hugging Face).
8. **[확인] 서버에는 ONNX 런타임이 이미 있다**: `momo-embed`가 `fastembed` 7.1.0을 `ort-load-dynamic`으로 쓰고 `ort` 2.0.0-rc.13이 `server-rust/Cargo.lock`에 있다(Microsoft MIT 릴리스 라이브러리를 Dockerfile `ort-payload` 단계가 sha256으로 고정). 그래서 서버 모델 방식의 새 비용은 크레이트가 아니라 **가중치(177~445 MB)·새 격리 예산·추론 공격면**이다.

### H3. 방식 비교 — (a)~(d)와 (a)를 보강한 (a′)

| 기준 | (a) 그림 모델에 지시문만 | (b) 에이전트가 사각형 → 서버가 자르기 | (c) 기기 안 피사체 들어올리기 | (d) 서버 배경 제거 모델 | (a′) 단색 배경 지시 + 서버가 가장자리에서 지우기 |
|---|---|---|---|---|---|
| 해결하는 뜻 | 누끼(투명 출력을 바랄 때) | 잘라내기만 | 누끼와 잘라내기, 사진 그대로 | 누끼와 잘라내기, 어느 그림에나 | 누끼와 잘라내기, 새로 그린 그림 한정 |
| 결과 품질 | 투명을 못 얻는다: 공급자가 `opaque`를 고정하고 바꿀 인자가 없다 [확인 1]. 모델이 투명한 척하는 무늬를 그릴 수 있다 [추정] | 사각형 안 배경이 남아 누끼가 아니다. 좌표 정확도 [미확인 4] | 윤곽이 가장 좋을 것 [추정]. 문서는 「눈에 띄는 대상 분리」라고만 적는다 [확인 6] | 모델에 따라 좋을 것 [추정]. 실측 없음 | 배경이 균일한 단색이면 결정적으로 정확하다 [추정]. 모델이 단색으로 그리는지 [미확인, 리허설 B]. 균일하지 않으면 지우지 않는다 |
| 비용(누가 내나) | 그림 한 번 그대로(에이전트 구독, X8-1·모델 A: 개수만 보임). 추가 없음 | 사진을 모델에 싣는 입력 토큰이 늘어난다(에이전트 구독) [추정] | 올리는 사람의 기기(전력·시간). 서버·구독 비용 0 | 서버 CPU·메모리·이미지 용량(인스턴스 운영자). 금액은 안 보인다(모델 A 그대로) [추정] | 서버 CPU 아주 조금 [추정]. 구독 추가 0 |
| 걸리는 시간 | 그림 시간 그대로: Hermes 표기 ~15초/~40초/~2분, 워커 마감 120초 [확인 3] | 그림 시간에 사진 입력 처리가 더해진다 [미확인] | 기기 안에서 수 초 안쪽 [추정, 미측정] | CPU 추론 수 초 이상 [추정, 미측정] | 픽셀 수에 비례, 수십~수백 ms [추정, S5가 잰다] |
| 새로 열리는 보안 면 | 없음. 다만 불가라서 열려면 Hermes 이미지나 공급자를 고쳐야 하고 고정 digest·게이트의 신뢰 사슬이 깨진다(ADR-0203 I1·I2) | 사진 픽셀이 대화 모델 공급자로도 간다(지금은 이미지 편집 한 곳) [추정]. 워커 전송 형식 변경 [확인 4]. 닫힌 표기에 좌표 필드 | 새 네이티브 코드(Swift 모듈, Tauri 명령과 capability). 서버 새 면 없음. 이 단계에서는 사진이 기기를 떠나지 않는다 | 서버에 신경망 추론(신뢰할 수 없는 이미지가 입력), 177~445 MB 모델 파일 공급망, 새 격리 예산 [확인 7·8] | 닫힌 값 하나(`background`)와 같은 격리 child 안의 알고리즘. 새 입력 길 없음. 시간·픽셀 한도는 기존(10초·16 MP) |
| 라이선스·의존성 | 없음 | 없음(`image` 이미 사용) | OS API. `objc2-vision`은 Zlib OR Apache-2.0 OR MIT, Expo 모듈은 자체 코드 [확인 6] | `ort`·ONNX Runtime은 이미 있다(MIT/Apache) [확인 8]. 가중치: BiRefNet MIT, U²-Net·IS-Net Apache(가중치 별도 조건 미확인), BRIA 탈락 [확인 7]. NOTICE에 가중치 귀속 추가 | 없음 |
| 화면 흐름(웹·데스크탑·폰) | 변경 없음(지시문) | 폼 변경 없음. 「사진 그대로」 결과 갈래가 새로 필요하다 | 폰은 iOS 17+, 맥은 14+만. 폰 배포 대상이 16.4라 16.4~16.x는 빠지고 웹 브라우저에는 같은 능력이 없다 [미확인] → 기기마다 흐름이 갈린다(D4 (c)를 기각한 이유와 같다) | 모든 화면이 같은 흐름(서버) | 「AI와 만들기」에 스위치 하나(웹·폰이 같은 코어 `make.ts`). 카드는 투명을 그대로 보인다 |
| 지금 길(편집 방식 ①)과의 관계 | 같은 길 | 같은 길 위에 비전 입력을 더해야 하고, 자르기를 원본에 걸려면 새 갈래(「사진 그대로」)가 필요하다: 지금은 새 그림만 저장된다 | 편집 길 밖: 투명 PNG를 모델에 줘도 모델이 불투명하게 다시 그린다. 「가져오기」 길이나 새 「사진 그대로」 갈래에 붙는다 | 길과 독립이나 새 처리 단계가 길 뒤에 붙는다 | 같은 길 위의 후처리. G3.2의 한 문장만 바뀐다 |
| 판정 | 탈락(지시문만으로는 불가) | 탈락(누끼가 아니고 모델이 사진을 못 본다) | 다음 후보(사진 그대로) | 보류(무겁다) | **권장** |

### H4. 판정의 이유

- (a)는 코드가 가장 적지만 고정 이미지에서는 열리지 않는다. 열려면 Hermes 공급자 설정을 바꿔야 하는데 그 길이 없고(F1), Hermes를 고치는 것은 ADR-0203의 고정 digest·게이트 전제를 깬다.
- (b)는 모델이 사진을 볼 수 없다는 전제가 빠져 있다. 보이게 하는 비용(전송 형식 변경, 사진이 대화 모델 공급자로도 가는 새 수신자)을 치러도 얻는 것은 사각형이다. 누끼가 아니다.
- (c)는 사진 그대로의 누끼로 가장 좋고 서버 비용이 없지만, 세 화면이 서로 다른 흐름이 되고 폰은 배포 대상 상향 없이 일부 기기를 뺀다. 에이전트를 쓰지 않으므로 owner가 말한 「에이전트 활용」과도 다르다. 「사진 그대로 오려 내기」를 정하면 가장 먼저 볼 후보다.
- (d)는 어느 그림에나 통하지만 가중치 177~445 MB와 새 격리 예산이 필요하고 BRIA 계열은 라이선스로 탈락한다.
- (a′)는 지금 길 위에서 에이전트가 단색 배경으로 그리게 하고 서버가 결정적으로 지운다. 새 의존·새 모델·새 외부 호출이 없고 실패하면 오늘과 같은 결과다.

### H5. 권장안 — (a′) 단색 배경으로 그리게 하고 서버가 가장자리에서 지운다 (Proposed)

owner가 고르고 이 절이 Accepted가 되면 S5가 아래를 구현한다. 수치(16·0.98·20%·95%)는 초안이며 리허설 B(`docs/runbooks/hermes-photo-expression-rehearsal.md`)와 S5 시험이 확정한다.

1. **요청 값 `background`**: `remove` 또는 `keep`. 생략은 `keep`이며 결과 바이트가 현행과 같다. 닫힌 표기(G3.7 (b))에 선택 키 `"background"`를 더하고(`deny_unknown_fields`는 유지) Agent Port의 `AssembleRequest`에도 같은 선택 키를 더한다(G7의 스키마 델타처럼 S5가 부록 B·코어 스키마·OpenAPI와 한 번에 합친다). 화면은 「AI와 만들기」에 스위치 하나이고 요청 본문의 한 줄(`- 배경: 지우기`)로 가서 모델이 표기에 옮긴다(`- 움직임:` 줄을 옮기는 것과 같다). 스위치의 기본값은 S5가 owner와 정한다(권장: 켬).
2. **지시문**: 호스팅 지시문(G6)과 스킬 문서에 한 줄을 더한다. 「배경 지우기이면 그림 설명에 `피사체에 쓰이지 않은 한 가지 단색 배경, 피사체는 가운데에 가장자리에서 떨어지게, 얇은 흰 외곽선`을 넣어요」. 모델이 따르는지는 **[미확인]** 이고 리허설 B가 잰다.
3. **서버(격리 child 안, 결정적)**: ① 입력의 EXIF 방향을 적용한다(G3.2). ② 가장자리 폭 3픽셀 띠의 채널별 중앙값 색 `c`를 구한다(`edge_fill`과 같은 정의). ③ 균일도 U = 띠에서 `c`와 모든 채널 차이가 16 이하인 픽셀 비율. U < 0.98이면 아무것도 지우지 않는다. ④ 가장자리의 `c` 근처 픽셀에서 시작해 4방향으로 `c` 근처 픽셀을 투명하게 한다(명시적 큐, 재귀 없음. 가장자리와 이어지지 않는 안쪽의 같은 색은 남는다). ⑤ 경계 한 겹은 거리로 부분 알파를 주고 색을 되돌려 헤일로를 줄인다(GIF 출력은 기존 1비트 문턱). ⑥ 남은 픽셀(알파 > 0)의 사각형으로 잘라 G3.2의 80% 정사각 맞춤을 이 사각형에 적용한다. ⑦ 지워진 비율이 20% 미만이거나 95% 초과이면 지우지 않은 그림을 그대로 쓴다.
4. 정지 갈래(`{"kind":"still"}`)도 같은 함수를 D3 정지 경로 안에서 쓴다. 정지 렌디션은 RGBA PNG라 알파가 남는다(F5). 입력·출력 한도(D3·G3.4)와 child의 192 MiB·10초는 그대로이며 방문 표시(픽셀당 1바이트)를 더한 예산은 S5가 다시 계산한다 [추정].
5. **G3.2 문장 갱신**: 「(누끼·배경 제거 없음)」을 「요청이 `background: remove`일 때만 H5-3의 순서로 지운다」로 바꾼다. 서버는 여전히 그림을 생성하지 않고(X8-1) 닫힌 실패 코드(G3.8)도 늘리지 않는다. 지우지 못한 경우는 지우지 않은 그림이 그대로 후보가 되고 카드가 보이는 그림이 곧 저장될 그림이다(X8-2). 그 사실을 카드에 한 줄로 알릴지는 S5가 정한다.

한계와 위험:

- 모델이 단색으로 그리지 않으면 쓸 수 없다(그때는 오늘과 같은 결과). 피사체가 배경과 같은 색이면 구멍이 난다(대책: 「피사체에 쓰이지 않은 색」과 흰 외곽선을 권한다 [추정]).
- 새로 그린 그림의 배경을 지우는 것이지 **사진 속 모습 그대로의 누끼가 아니다.** 사진 그대로를 원하면 (c)가 다음 후보이고 서버·지시문 쪽은 이 권장안과 겹치지 않는다.
- GIF의 1비트 투명 때문에 움직이는 결과의 윤곽은 계단져 보일 수 있다(H1).
- 얼굴 규칙은 그대로다(D6·G2). 모든 수치는 합성 그림으로만 재며 실제 사람 사진으로 시험하지 않는다.
- 열지 않는 것: 서버 모델((d)), 사진 그대로의 누끼((c)), 모델에게 사진을 보이는 전송 형식((b)), Hermes 공급자·이미지 변경((a)), 새 의존, 영상, 외부 호출.

### H6. owner에게 묻는 한 줄

> 이모티콘 배경은 「에이전트가 새로 그린 그림의 배경을 투명하게 지우기」(권장)부터 시작할까요, 아니면 「내 사진 속 모습을 그대로 오려 내기」까지 이번에 같이 할까요?

- 「새로 그린 그림의 배경 지우기」를 고르면 S5가 H5를 구현하고 이 절을 Accepted로 바꾼다. 리허설 B에서 모델이 단색 배경을 거의 지키지 않는 것으로 나오면 권장안을 다시 논의한다.
- 「사진 그대로 오려 내기」를 고르면 이 절은 Accepted가 되지 않고 (c)(폰 iOS 17+·맥 14+, 웹 제외 여부 결정 필요) 또는 (d)(가중치 라이선스·새 격리 예산·NOTICE)를 다루는 새 증보를 먼저 쓴다.

### H7. 팀 서버에서 호스팅 문을 여는 순서 — 새로 확인한 막힘 둘

코디네이터 전달(2026-10-31 운영 점검, 운영 값은 읽지 않았다): 팀 서버의 공동 Hermes는 `hermes-kwak` 하나이고, 저장소 기본 설정에 모델 선택과 Gmail·캘린더·드라이브 읽기 연결(`mcp_servers`)을 더한 「연결 모드」로 돈다. 새 판 시작 명령은 `config.yaml`을 기본 설정 해시와 맞추라고 해서 그대로 올리면 연결이 지워지므로 v0.1.41에서는 Hermes를 올리지 않았고(STRICT도 아직 없다) 고치는 일은 [#4935](https://github.com/yeomyeonggeori/oort/issues/4935)다.

1. **연결 모드 Hermes에는 그림 도구가 없다. [확인]** `mcp_servers`가 있으면 `agent.disabled_toolsets`에 `image_gen`이 있어야 하고(`infra/hermes/lockgate.py:120,202-204`) 노출된 도구에 `image_generate`가 있으면 설정을 거절한다(`:222-223`, ADR-0203 I3). 그래서 #4935가 끝나도 연결 모드 Hermes는 STRICT와 상관없이 그림을 만들지 못한다. 로컬 리허설(저장소 기본 설정)이 PASS여도 팀 서버의 연결 모드는 같은 구성이 아니다.
2. **문을 열면 사진이 붙은 공동 Hermes 대화 전부가 비스트리밍 「문 턴」이 된다. [확인: 코드를 읽었고 실행하지 않았다]** 조건은 STRICT 확인·사진·사람 요청자·쓸 수 있는 런·대기 카드 상한뿐이고 그림을 만들어 달라는 요청인지는 보지 않는다(`hosted_door.rs`의 `hosted_door_open`). 그림 도구가 없는 연결 모드에서는 얻는 것 없이 스트리밍만 잃는다. 그래서 그림 도구가 없는 Hermes에는 문을 열지 않는다.
3. **#4934는 원본 사진 주소와 상관없다. [확인]** #4934는 api 볼륨이 서비스 하나에만 붙어 agent-worker가 첨부 사진을 못 읽는 문제다. 사진 주소를 내주는 쪽은 api다(`server-rust/bins/momo-server/src/routes/self_media.rs:84-100`, api의 `drive.file_content`). 워커는 토큰 행(DB)을 만들고 글 한 줄을 붙일 뿐 사진 바이트를 읽지 않고, 워커의 `DriveArchive`를 쓰는 곳은 프로필 사진 제안(`team_ai.rs:554`에서 부르는 `momo-workspace-actions/src/profile_avatar.rs`) 하나다. 문의 「사진이 있는가」 판정과 `sourceAttachmentId`도 DB 행만 읽는다. 다만 팀 서버의 api가 그 첨부를 읽을 수 있어야 하는데, 지금 업로드를 받는 저장소를 api가 갖고 있으므로 그렇다.

순서(제안):

1. #4935 착륙(연결 모드 Hermes를 새 판 게이트·STRICT로 올릴 길).
2. **결정(owner)**: 그림 도구를 어느 Hermes가 갖나. (i) 팀 Hermes를 기본 모드로 돌린다(메일·캘린더·드라이브 연결을 포기한다). (ii) 그림 전용 Hermes를 하나 더 둔다(ADR-0203 D1 「선언한 한 호스트」의 변경이 필요하고 #4935의 범위 밖이다). (iii) ADR-0203 I3의 배타 규칙을 바꾼다(메일·드라이브 내용이 그림 설명을 거쳐 OpenAI로 갈 수 있는 길을 받아들이는 보안 경계 변경이라 Accepted ADR과 보안 검수가 필요하다). 이 증보는 고르지 않는다.
3. 고른 구성의 새 판 Hermes 배포(`HERMES_MEDIA_DELIVERY_STRICT=1`, 배포 로그 `LOCKGATE`의 `media_strict: true` 확인).
4. 리허설 PASS(그 구성이 로컬 기본 설정과 다르면 같은 표를 그 구성으로 다시 잰다).
5. `OORT_SELF_MEDIA_ORIGIN`(agent-worker·hermes에 같은 값)을 둔 뒤 **마지막에** agent-worker의 `OORT_HOSTED_MEDIA_STRICT=1`.

> 배포 전 owner에게 묻는 한 줄: 팀 서버의 Hermes는 메일·캘린더·드라이브를 읽는 쪽(지금)과 그림을 그리는 쪽을 한 번에 할 수 없어요. 사진 이모티콘의 그림은 어떻게 둘까요? (i) 그림용으로 바꾸고 연결은 포기 (ii) 그림 전용 Hermes를 하나 더 (iii) 한 Hermes가 둘 다 하도록 안전 규칙을 바꾸기

### H8. 실제 Hermes 리허설 (절차는 runbook)

G4의 미검증 목록(모델이 `MEDIA:`를 실제로 쓰는지, 5 MiB·시간 한도 안에서 그림이 들어오는지, 구독 한도 오류의 모양, 실제 Hermes가 자기 주소를 내려받는지, 모델이 주소를 `image_url`에 넣는지, Codex `images/edits`가 이 사진을 받는지)을 실제로 재는 절차를 [runbook](../runbooks/hermes-photo-expression-rehearsal.md)에 두었다. owner가 2026-10-31 21:06에 실행을 승인했고(코디네이터 전달) 실행은 planner가 이 맥에서 저장소 기본 설정의 Hermes로 한다. 그림은 합성 그림만 쓰고, 켜는 환경값은 이름과 순서만 적었으며(값 없음), 이 문서를 쓰는 동안 로그인·자격 파일은 쓰지 않았다. 이 리허설의 PASS는 **기본 설정 Hermes + 호스팅 문**이 동작한다는 근거이고 연결 모드 Hermes(그림 도구 없음, H7)는 재지 못한다. 리허설 B는 H5의 권장안이 쓸 수 있는지를 미리 잰다. 리허설은 이 절의 어느 결정도 대신하지 않는다.
