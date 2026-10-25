# ADR-0151 — 첨부 v0: Drive 계약 동결 이식 + 클라 최소 표면

- Status: **Accepted** (2026-08-06 성재 승인 — 실행 지시 "작업 진행해줘"와 함께. 방향은 2026-08-04 결정 D로 사전 승인)
- Date: 2026-08-05
- 관련: ADR-0145 증보 1(attachments 3경로=이식 대상 v0 — 본 ADR이 그 "선행 ADR"이다) · 2026-07 재설계 확정(파일 저장=Drive 공유드라이브+SA 멤버) · U1 감사 `docs/planning/research/2026-08-05-chat-ui-audit.md` H-10/U4-f(컴포저에 첨부 진입점 0)

## Context

- **서버 계약은 이미 존재하고 스펙에 성문화돼 있다** — Swift 시대 구현: `POST …/attachments/uploads`(Drive resumable 세션 생성 — 바이트는 서버 우회, PG가 인가·수명 소유), `POST …/attachments/{id}/complete`(Drive 메타데이터로 크기·mime 검증 후 완료 전이), `GET …/attachments/{id}/content`(인가 프록시). `openapi.yaml:2991,3041,3080` · `AttachmentRoutes.swift:33-34`(바이트 우회 원칙) · mime 검증(:66)·pending 행(:101)·검증 불일치 거절(:159,188).
- 메시지 바인딩도 계약 완결: 전송 DTO `attachmentIds` → 업로더 검증 링크(`MessageRoutes.swift:173-183`) → 응답·페이지에 `attachments` 동봉(:205,251).
- **server-rust에는 이 3경로가 없다**(routes/ 실측 — attachment 계열 0). 클라 표면도 양쪽 0(웹 컴포저 버튼 없음·모바일 없음).
- 즉 "첨부"는 신규 설계가 아니라 **이식 갭 + 클라 표면 갭**이다.

## Options

1. **계약 동결 이식(권고)** — 스펙 3경로를 형상 그대로 rust로. 저장 백엔드 Drive 유지.
2. S3 호환(MinIO)로 갈아타며 이식 — OSS 셀프호스트 친화적이나, 커토버 중 계약 정답이 두 곳이 되고 2026-07 Drive 확정을 뒤집는다. **기각(v0에서)**.
3. 클라 표면만 먼저(Swift 서버로) — 죽을 서버에 클라를 배선. **기각**.

## Decision

- **D1 · 계약 동결 이식**: 스펙의 3경로+메시지 바인딩을 와이어 무변경으로 rust 이식(표기는 #1040 camelCase 규율). Drive resumable·검증 로직 동등. 이식 완료 시 ADR-0145 증보 1 판정표의 attachments 행이 닫힌다.
- **D2 · 클라 v0 = 웹 먼저**: 컴포저 첨부 버튼(파일 선택→resumable 업로드→진행률→전송 시 `attachmentIds` 바인딩), 렌더 = 이미지 인라인 프리뷰 + 그 외 파일 카드(이름·크기·다운로드=content proxy 경유, 직링크 금지). 모바일(사진 picker 포함)은 후속 배치.
- **D3 · 경계**: content 접근은 인가 프록시 단일 경로(채널 멤버십·RLS — Drive URL 클라 비노출). 크기·mime 정책은 서버 스펙 값 유지. 바이러스 스캔 없음은 v0 한계로 명시. **에이전트 업로드는 v0 제외**(사람만 — 에이전트 산출물 첨부는 작업 패널/Drive 산출 경로와 함께 v1 결정).

## Slack·업계 비교

Slack 초기 파일 업로드는 서버 경유 단순 POST였고, 이후 외부 공유 링크의 인가 우회 사고(공개 S3 URL 추측 가능)로 프록시·만료 토큰 체계로 회귀했다. momo는 처음부터 "바이트는 우회(업로드), 접근은 프록시(다운로드)" 비대칭을 계약에 고정 — 업로드 대역폭은 Drive에 넘기되 읽기 인가는 PG/RLS가 소유한다. Mattermost는 로컬/S3 저장 옵션을 두는데, 우리의 S3 옵션은 v1 보류로 남긴다(OSS 배포 마찰은 인정하되 v0 범위 밖).

## Consequences

- Drive가 장애 도메인에 추가된다(업로드·다운로드 모두). 헬스 신호는 연결 상태 표면(U3 계열)의 후속.
- OSS 셀프호스트는 당분간 Google SA 필수 — README에 명시할 것. S3 호환 백엔드는 v1 재론(폐기 아님).
- e2e의 minio는 이 계약과 무관한 잔재인지 이식 배치에서 실측·판정(잔재면 제거 티켓).

## 증보 1 (2026-10-25, #4233): 내용 읽기 경계 - 메시지에 묶인 첨부 또는 업로더 본인

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」). 독립 보안 검수 r1 PASS(Blocker 0·High 0). 결정의 근거는 [ADR-0208](0208-scheduled-messages.md)(Accepted) 「남는 위험 8」과 planner 확인 ⑦(2026-10-22 수용)이다. 이 증보는 그 후속을 D3에 옮겨 적는 기록이고 새 방향을 정하지 않는다. 구현은 보안 후속 #4233이다.
- **변경 전(D3)**: content는 채널 멤버십만 본다. 완료된 첨부는 업로더가 아니어도 채널 활성 멤버가 읽었고, 아직 메시지에 묶이지 않은 초안 첨부도 같았다. 예약 메시지(ADR-0208)는 그 기간을 마감 시각까지(최대 120일) 늘린다.
- **결정**: content 읽기는 **활성 채널 멤버이면서, 첨부가 메시지에 묶여 있거나 읽는 사람이 업로더 본인**일 때만 성립한다. 묶이지 않은 첨부는 업로더만 읽고, 묶인 뒤에는 지금처럼 채널 멤버가 읽는다. 업로더도 채널 멤버십이 먼저다(채널을 나간 사람은 자기 초안도 못 읽는다). 워크스페이스 owner·admin의 예외는 없다.
- **거절의 모양**: 남의 초안은 **404이고 문장도 없는 id와 같다**(`completed attachment not found`). 403으로 답하지 않는다. 403이면 남의 초안이 있다는 사실이 새고, 이 경로는 처음부터 pending·failed·다른 채널·다른 테넌트를 한 문장으로 숨겨 왔다.
- **이슈 #4233 문구와 다른 두 곳**: ① 이슈는 「업로더 본인 항상 200」이라 적었지만 업로더도 **활성 채널 멤버일 때만** 200이다. 읽기 경로 전체가 멤버십을 먼저 본다는 현행 계약을 이 한 곳에서만 깨지 않으려는 것이고, 나간 채널의 초안은 읽을 이유가 없다(시험으로 못 박았다: 나간 업로더는 403). ② 이슈는 거절을 404 또는 403으로 열어 뒀고 여기서는 404로 정했다(위).
- **바뀌지 않는 것**: 묶인 뒤 채널 멤버의 읽기, 업로드·완료·묶기 경로, 컴포저 썸네일(서버를 거치지 않는다: 웹 `createImageBitmap(File)`, 폰 로컬 uri), 보낸 사람의 낙관 행(전송 중인 메시지의 첨부 카드는 작성자 = 업로더라 읽힌다), 에이전트 아바타 원본 선택(`find_visible_image_attachment_in_tx`·`find_requester_attachment_in_tx`는 이미 메시지에 묶인 첨부만 쓴다).
- **이 증보가 닫지 않는 것**: 감사 행 `attachment.upload_started`의 detail에 첨부 id와 이름이 남는다(내용은 아니다). 삭제된(soft) 메시지에 묶인 첨부는 `message_id`가 남아 채널 멤버가 계속 읽는다. 메시지를 hard delete하면 `ON DELETE SET NULL`로 첨부가 업로더 전용으로 돌아간다. 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 여전히 없다(ADR-0208 남는 위험 5). 이 셋(지운 메시지의 첨부 읽기 차단, 청소기, 감사 detail의 이름)은 이 증보의 범위 밖이고 후속 #4443이 맡는다. → [증보 2](#증보-2-2026-10-25-4443-첨부의-수명)가 셋을 닫는다(청소기는 Google 백엔드에서만 돈다).

## 증보 2 (2026-10-25, #4443): 첨부의 수명

지운 메시지의 첨부는 아무도 읽지 못한다. 묶이지 않은 완료 첨부는 30일 뒤 거둔다. 감사 detail에는 파일 이름을 싣지 않는다.

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」). 독립 보안 검수는 2단계에서 하고, 그 결과는 검수가 끝난 뒤에 이 줄에 적는다. 결정의 근거는 증보 1이 「닫지 않는 것」으로 남긴 셋과 [ADR-0208](0208-scheduled-messages.md) 「남는 위험 5·8」이다. 새 방향을 정하지 않고 증보 1의 원칙(없는 id와 같은 404, 역할 예외 없음)을 같은 모양으로 잇는다. 구현은 보안 후속 #4443이다.
- **변경 전(증보 1 뒤)**: 메시지를 soft delete해도 첨부 행의 `message_id`는 남는다(`interaction.rs:1183-1186`은 메시지의 `state`·`body`·`deleted_at`만 바꾼다). 그래서 채널 멤버는 지운 메시지의 파일을 content로 계속 읽었고(`attachments.rs:367`), 기록 투영(채널 history·스레드 답)과 보내기 재시도의 echo가 그 파일의 이름·크기·id를 무덤 행에 계속 실었다. 완료됐지만 어떤 메시지에도 묶이지 않은 첨부를 거두는 곳은 없어 보관소는 늘기만 했다. 감사 `attachment.upload_started`의 detail에는 파일 이름이 있었다.

### 결정

- **D1 · 지운 메시지의 첨부 읽기는 404이고 예외가 없다.** content 읽기는 **활성 채널 멤버이면서, 첨부가 살아 있는 메시지에 묶여 있거나(`state <> 'deleted'` 그리고 `deleted_at IS NULL`) 어떤 메시지에도 묶이지 않았고 읽는 사람이 업로더**일 때만 성립한다. 작성자·업로더·워크스페이스 owner·admin의 예외는 없다. 근거: ① 작성자의 삭제가 대화가 그 파일에 가진 몫을 끝낸다. 지운 메시지는 업로더가 아직 쓰고 있는 초안이 아니라서, 증보 1이 업로더에게 준 읽기(보내는 중인 낙관 행)의 이유가 여기에는 없다. ② 파일이 필요한 작성자는 원본을 갖고 있다. 프록시를 보관함으로 쓰게 둘 이유가 없다. ③ 메시지를 지울 수 있는 사람은 작성자뿐이다(`interaction.rs:1164`). admin에게 지운 메시지를 읽는 길은 제품에 없고, 있어야 한다면 준법·신고용 읽기로 따로 결정할 일이다. 거절은 증보 1과 같다: 없는 id와 문장이 같은 404이고 바이트까지 같다(403 아님).
  - **술어의 모양이 결정의 일부다.** `(묶임 AND 살아 있음) OR 업로더`로 쓰면 지운 메시지의 파일이 지운 본인에게 돌아간다. 구현은 `(message_id IS NOT NULL AND 살아 있음) OR (message_id IS NULL AND 업로더)`다(`attachment.rs:364`).
  - **반쪽 무덤도 무덤이다.** `state`와 `deleted_at`은 둘 다 쓰이고 어느 하나만 있는 행이 옛 경로에서 생길 수 있다(`LockedMessage::is_deleted`, `interaction.rs:182`). 둘 다 본다.
  - **soft와 hard의 비대칭을 인정한다.** soft delete는 아무도 못 읽게 하고, 메시지 행 자체를 지우면(`ON DELETE SET NULL`) 파일이 초안으로 돌아가 업로더가 읽는다(증보 1). 코드 경로에는 메시지를 hard delete하는 곳이 없어 운영·CASCADE에서만 생기고, 그렇게 돌아온 파일은 D4 청소기가 거둔다.
- **D2 · 기록 투영은 지운 메시지의 첨부를 싣지 않는다.** 무덤 행은 그대로 보인다(재접속한 클라이언트가 삭제로 수렴해야 한다). 첨부 키만 없다. 세 곳을 SQL에서 막는다: `PAGED_ATTACHMENT_JOIN`(채널 history·스레드 답, `attachment.rs:636`), `message_attachments_in_tx`(보내기 재시도가 저장된 행을 되돌려줄 때의 echo, `attachment.rs:595`), `image_attachments_for_messages_in_tx`(에이전트 포트 대화 읽기의 이미지 목록, `agent_avatar.rs:851`). 마지막은 핸들러가 이미 삭제 행의 `imageAttachments`를 거르므로(`agent_port_tools.rs:859`) SQL이 둘째가 아니라 첫째 겹이 되고 핸들러 가드는 둘째 겹으로 남는다. 실시간 `message.deleted` 프레임은 처음부터 첨부를 싣지 않는다.
- **D3 · 감사 detail에서 파일 이름을 뺀다(schema v2).** `attachment.upload_started`의 detail은 `channel_id`·`mime`·`size_bytes`만 가진다. 이름은 사람의 것일 수 있고, 감사는 admin이 읽으며 파일보다 오래 남는다. D4 청소기가 행을 지우면 감사 detail의 이름이 이름의 마지막 사본이 된다. **해시는 기각한다**: 파일 이름은 짧고 추측하기 쉬워서 키 없는 해시는 사전 대입 한 번이면 이름이 되고, 키 있는 해시는 새 비밀과 회전 문제를 만든다. 조사에는 attachment id(행이 있는 동안 조인 키)·mime·크기·채널이면 된다. **이미 쓰인 v1 행의 이름은 고치지 않는다**: 감사 행을 소급 수정하는 것은 증거를 바꾸는 일이라 owner 결정으로 둔다(아래). v1과 v2가 섞여 있으므로 `detail->>'schema'`로 어느 행이 이름을 갖고 있는지 가려낸다.
- **D4 · 묶이지 않은 완료 첨부 청소기.**
  - **대상**: `status = 'complete'`, `message_id IS NULL`, `NOT reserved`, 그리고 `GREATEST(created_at, unreserved_at)`가 30일(`UNBOUND_TTL`) 전보다 오래된 행. 30일은 inbox 읽은 항목·run 이벤트 원장의 보존과 같은 값이다(ADR-0199 D4, ADR-0200 D2). 컴포저에 남은 초안 첨부는 그보다 오래 쓰이지 않는다. 예약이 쥔 파일은 `reserved`로 빠지므로 예약의 120일 한도가 이 숫자를 정하지 않는다. `pending`·`failed` 행은 이 청소기의 대상이 아니다(남는 위험).
  - **시계**: 업로드(`created_at`)와 마지막 점유 해제(`unreserved_at`) 중 늦은 때부터 센다. ADR-0208 D11 「취소하면 점유를 풀고 파일은 남는다(초안과 같은 상태)」를 지키려는 것이다. 100일 묵은 예약을 취소하는 순간 다음 틱에 파일이 사라지면 「초안과 같은 상태」가 아니다.
  - **점유는 attachment 행에 비춘다.** 예약 점유 표 `scheduled_message_attachment`는 작성자 범위 RLS이고 BYPASSRLS 역할에는 봉인돼 있다(ADR-0208 D3, `145_scheduled_message.sql:124-131`). 청소기가 점유를 직접 보려면 남의 `app.member_id`를 묶어야 하는데 그것은 ADR-0208 D14-4가 이름 있는 세 함수로 고정한 예외이고, 새 definer를 만들 수도 없다. 그래서 마이그레이션 150이 `attachment.reserved`·`unreserved_at`을 더하고 **SECURITY INVOKER 트리거**가 점유 행의 INSERT·DELETE를 거기에 비춘다. 예약 생성·취소·발송·정리·CASCADE가 어느 경로로 점유를 만들고 지우든 한 곳에서 맞는다. 청소기는 이 열만 본다. ADR-0208의 점유 표에는 이 트리거 하나만 더하고 표 권한·RLS 정책·봉인은 바꾸지 않는다.
  - **실행 자리와 RLS 경계**: notifier 두-풀 모양이다. notifier의 BYPASSRLS는 「백그라운드 소비자의 문서화된 예외」로 이미 있고(`bootstrap_runtime_roles.sql:40`, 표는 FORCE RLS 그대로, DELETE 없음), 이 증보는 그 읽기에 컬럼을 더할 뿐이다. 후보 읽기는 notifier의 BYPASSRLS 풀에서 컬럼 일곱 개(`id`·`workspace_id`·`status`·`message_id`·`reserved`·`unreserved_at`·`created_at`, `drive_file_id`·이름·mime·업로더는 아님)만 읽고, 쓰기는 `momo_app` RLS-bound 풀의 행별 테넌트 tx다(`ensure_write_pool_rls_bound`가 BYPASSRLS 풀을 거절). 전례: 아바타 회수(`avatar_reclaim.rs:10-23`, ADR-0161 D5 증보 2)와 inbox·share·run event 보존 청소가 같은 모양이고, 컬럼 단위 notifier GRANT는 #3377 블록이 #2862 공유 보존·#3284 아바타 회수·#3553·#4284에서 이미 쓴다(`bootstrap_runtime_roles.sql`). 예약 메시지 틱(`scheduler.rs:1-14`)은 api 프로세스에서 `momo_app`으로 돌며 교차 테넌트 읽기를 id만 돌려주는 definer 두 개로 한다. 같은 방식을 첨부에 쓰면 새 definer가 필요하므로 택하지 않았다. **새 예외는 notifier 컬럼 SELECT 일곱 개뿐이고 전례의 가족 안이다. 새 BYPASSRLS 쓰기 경로·새 SECURITY DEFINER·남의 owner GUC 묶기는 없다.**
  - **순서**: 행을 `FOR UPDATE`로 잠그고 → 새 문장으로 자격을 다시 판정하고 → `SAVEPOINT` 안에서 **행 DELETE와 감사 INSERT를 먼저** 하고 → Drive 객체를 지우고 → 성공이면 COMMIT, 실패면 `ROLLBACK TO SAVEPOINT`다. 행을 먼저 지우는 이유는 `huddle_transcription_*`가 `attachment`를 참조하는 FK(`046_huddle_transcription.sql`) 때문이다. FK가 삭제를 거절하면 바이트를 지우기 전에 tx가 선다. 지금 Rust는 그 열을 채우지 않아 도달할 수 없고, 도달하면 행이 그대로 남은 채 경고 로그를 남기는 독 행이 된다(그 파이프라인을 만드는 쪽이 이 청소기에 제외 조건을 더한다). 잠금이 경쟁도 정리한다: 메시지 묶기(`link_attachments_in_tx`)와 예약 점유(`reserve_attachments_in_tx`)는 둘 다 먼저 같은 행을 `FOR UPDATE`로 잡으므로, 그쪽이 먼저 커밋하면 재판정이 보고 건너뛰고, 나중이면 잠금을 기다렸다가 행이 없는 것을 본다.
  - **실패와 재시도**: Drive 일시 실패는 아무것도 쓰지 않고 다음 틱이 다시 한다(연속 세 번 실패하면 틱이 멈춘다). Drive 404는 성공이다(`delete_file`은 멱등이라 「Drive는 지웠고 COMMIT 전에 죽은」 경우가 다음 틱에 수렴한다). 영구 거절(`AccessDenied`·잘못된 id)은 행도 객체도 건드리지 않고 건수만 센다. 우리 드라이브의 객체가 아니면 우리가 지울 것이 아니고, 행을 지우면 객체가 어디 있는지를 잊는다.
  - **감사**: 지운 행마다 `attachment.expired`(행위자 없음, 대상 attachment id, `reason: unbound_ttl`, mime·크기·채널. 이름·Drive id 없음)를 같은 tx에 쓴다. 로그에는 건수만 남긴다.
  - **Google 백엔드에서만 돈다.** 셀프호스트와 Railway의 기본값인 `local`은 api 프로세스만 볼륨을 쥐고(`infra/railway/README.md:406`) `LocalDriveArchive::open`은 연 프로세스의 보류 세션을 지우므로 다른 프로세스가 열 수 없다(`avatar_reclaim.rs:33-36`의 한계와 같다). 그 백엔드에서는 청소기가 **돌지 않는다. 바이트도 행도 그대로 남는다.** 닫으려면 api 프로세스 러너가 필요한데, 그러려면 교차 테넌트 후보 읽기를 줄 새 SECURITY DEFINER가 있어야 한다. 이것은 **owner 결정이 필요한 일**이라 이 증보는 만들지 않았다.

### 이슈 #4443 문구와 다른 곳

① 이슈는 청소기를 「notifier 스윕」이라 적었고 그대로 했지만 **Google 백엔드 한정**이다(위). ② 이슈의 「감사 detail에서 파일 이름 제거 또는 해시화」는 제거로 정했다. ③ 이슈는 「작성자·관리자 예외 여부는 ADR 근거」라 적었고 예외 없음으로 정했다. ④ 이슈 코멘트의 「기록 투영의 첨부 메타 비우기」는 무덤 행을 지우지 않고 첨부 키만 뺀다.

### 기각한 대안

- **청소기가 점유 표를 직접 본다**: 남의 owner GUC 묶기는 ADR-0208 D14-4가 고정한 예외를 늘리고, notifier에 점유 표를 GRANT하면 D3의 봉인을 푼다. 새 definer는 이 일의 범위가 아니다. 그래서 점유를 attachment 행에 비췄다.
- **TTL을 180일로 늘려 `reserved` 없이 가기**: 170일 묵은 초안을 예약에 쥐면 여전히 말없이 잃는다. 실패한 예약을 다시 걸 수 있어(ADR-0208 D9) 한 파일이 예약에 매이는 기간은 120일로 끝나지 않을 수 있다.
- **아바타 회수처럼 행을 지우지 않고 표시만 하기**: `drive_file_id`가 남아 content 경로가 Drive 404(「Drive attachment was not found」)를 돌려주고, 없는 id의 문장과 달라진다. 행 수도 줄지 않는다.
- **Drive를 먼저 지우고 행을 나중에 지우기**: FK가 행 삭제를 거절하는 때 바이트는 이미 없다.
- **지운 메시지의 파일을 업로더·작성자에게는 열어 두기**: D1의 근거 ①②. 지운 사람이 그 파일을 프록시로 계속 받는 길이 된다.
- **파일 이름을 해시로 남기기**: D3.
- **pending·failed 행까지 청소하기**: 이 일의 대상(완료됐지만 묶이지 않은 첨부)이 아니고, `failed`는 Drive 쪽 사정(크기·mime 불일치)이 달라 따로 판단할 일이다.

### 남는 위험과 owner 결정이 필요한 것

- **owner 결정 필요 ① 로컬 백엔드의 청소기.** 위 D4. 셀프호스트·Railway 팀 인스턴스의 기본값에서 보관소 누적은 그대로다. api 프로세스 러너 + 교차 테넌트 후보를 id만 돌려주는 새 SECURITY DEFINER 함수(`momo_schedule_private`와 같은 모양, #4395의 mem definer 전례처럼 owner 결정)가 필요하다.
- **owner 결정 필요 ② 이미 쓰인 감사 v1 행의 파일 이름.** 소급 정정(`detail - 'name'`)은 한 문장이지만 감사 증거를 고치는 일이다.
- **`pending`·`failed` 행과 그 바이트**는 거두지 않는다(`attachment_pending_cleanup_idx`는 쓰는 곳이 없다).
- **영구 거절 행이 후보 창을 차지한다.** 후보는 오래된 순으로 틱당 `batch`(기본 50)건이라, Drive가 영구 거절하는 행(우리 드라이브에 없는 객체, 잘못된 id)이 그만큼 쌓이면 그 뒤의 새 후보가 처리되지 않는다. 백엔드를 바꾼 인스턴스가 아니면 생기지 않고(읽기도 함께 깨진다), 건수는 로그의 `refused`로 드러난다. 생기면 후보를 돌려가며 읽어서 푼다.
- **에이전트 아바타 원본 선택**(`find_visible_image_attachment_in_tx`·`find_requester_attachment_in_tx`)은 `state <> 'deleted'`만 보고 `deleted_at`은 보지 않는다. 반쪽 무덤은 옛 경로에만 있어 이번에는 건드리지 않았다.
- **채널·워크스페이스를 지우면(FK CASCADE) 첨부 행이 사라져 Drive 객체가 고아가 된다.** 행을 따라가는 이 청소기는 못 찾는다.
- **30일을 넘긴 컴포저 초안**은 보낼 때 404(첨부를 못 찾음)를 만나 다시 올려야 한다.
- **`huddle_transcription_*`의 FK**: D4.
- **클라이언트**: 코어의 `applyTombstone`(`packages/momo-core/src/features/timeline/model.ts:216-232`)은 무덤으로 바꿀 때 메모리의 `attachments`를 남긴다. 서버가 막았으므로 새로고침하면 사라지고 메모리의 카드는 404를 맞을 수 있다. UXUI 후속이다.
- **아바타 업로드 감사**(`member.avatar_upload_started`·`workspace.avatar_upload_started`)의 `name`도 같은 모양이다. 별개 표면(ADR-0161)이라 이 증보는 건드리지 않았다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 | `attachment_conformance_pg::a_deleted_messages_attachment_is_nobodys_to_read` | 읽기 술어에서 `m.state <> 'deleted'`만 지우면 `state`만 쓰인 반쪽 무덤이 200, `m.deleted_at IS NULL`만 지우면 `deleted_at`만 쓰인 반쪽 무덤이 200, 둘 다 지우면 방·작성자·admin이 200, `OR 업로더`를 괄호 밖으로 빼면 작성자 본인이 200 |
| D2 | `a_deleted_messages_attachments_are_not_listed_anywhere` | `PAGED_ATTACHMENT_JOIN`에서 지우면 채널 history가 카드를 싣고(스레드 답은 같은 상수를 읽는다), `message_attachments_in_tx`에서 지우면 재시도 echo가 싣고, `image_attachments_for_messages_in_tx`에서 지우면 직접 호출이 이미지를 돌려준다 |
| D3 | `the_audit_trail_never_holds_a_file_name` | detail에 `"name": name`을 되돌리면 |
| D4 | `attachment_conformance_pg::a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl` | `NOT a.reserved`를 지우면 2단계, `GREATEST`의 `unreserved_at` 항을 지우면 3단계, 트리거 INSERT 가지를 비우면 1단계, DELETE 가지를 비우면 3단계가 빨강 |
| D4 | `attachment_reclaim_conformance_pg`(8개) | 자격 항 다섯(`status`·`message_id`·`reserved`·`unreserved_at`·나이)을 하나씩, 저장점 롤백(실패 팔 / 저장점을 늦게 열기), 404=성공, 거절 시 행 유지, 잠금 뒤 재판정, 잠금 없이 먼저 부른 Drive, 테넌트 술어 셋 모두(RLS 없는 둘째 모드), BYPASSRLS 쓰기 풀 거절 |
| D4 | `prod_role_conformance_pg::every_notifier_job_iteration_runs_as_its_production_role` | notifier 컬럼 GRANT를 지우거나(부트스트랩과 마이그레이션 둘 다) `name`으로 넓히면, 점유 표를 notifier에 열면, 후보 읽기가 GRANT 밖 컬럼(`drive_file_id`)을 부르면(`attachment_reclaim::tests` 단위 시험도 빨강) |
| D4 | `scripts/tests/test_notifier_role_grants.sh` | 같은 GRANT의 정적 판정: 표 단위 SELECT·빠진 컬럼·`drive_file_id` 추가가 모두 빨강 |

사보타주를 실제로 돌린 결과(어떤 되돌림이 어떤 시험을 빨갛게 했는지)는 PR 본문이 정본이다.
