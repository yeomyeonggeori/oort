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
- **이 증보가 닫지 않는 것**: 감사 행 `attachment.upload_started`의 detail에 첨부 id와 이름이 남는다(내용은 아니다). 삭제된(soft) 메시지에 묶인 첨부는 `message_id`가 남아 채널 멤버가 계속 읽는다. 메시지를 hard delete하면 `ON DELETE SET NULL`로 첨부가 업로더 전용으로 돌아간다. 완료됐지만 묶이지 않은 첨부를 거두는 청소기는 여전히 없다(ADR-0208 남는 위험 5). 이 셋(지운 메시지의 첨부 읽기 차단, 청소기, 감사 detail의 이름)은 이 증보의 범위 밖이고 후속 #4443이 맡는다. → [증보 2](#증보-2-2026-10-25-4443-첨부의-수명)가 셋을 닫는다(청소기는 Google 백엔드는 notifier가, 로컬 볼륨은 api 프로세스가 돌고, 기본 꺼짐이다).

## 증보 2 (2026-10-25, #4443): 첨부의 수명

지운 메시지의 첨부는 아무도 읽지 못한다. 묶이지 않은 완료 첨부는 30일 뒤 거두되, **켜기 전에 사람이 같은 숫자를 다른 길로 확인하는 점검을 거치고 기본은 꺼짐이다**. 감사 detail에는 파일 이름을 싣지 않고, 이미 쓰인 행의 이름도 지운다.

- Status: **Accepted** (2026-10-25, planner 위임 결정 — owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」). 2026-10-26 owner가 「안전하게 처리 가능한지, 청소하거나 지우더라도 문제없는 녀석들인지 더블체크 후 진행」을 조건으로 세 가지를 승인했다: **A** 「지워도 되는 첨부」의 정의를 참조 전수로 증명한다, **B** 로컬 볼륨 청소기를 만든다(가능하면 새 SECURITY DEFINER 없이), **C** 이미 쓰인 감사 v1 행의 파일 이름을 정정한다(무결성 장치가 있으면 멈춘다). **독립 보안 검수: PASS (Blocker 0 · High 0)** — 2026-10-26, fresh Sonnet 읽기 전용 검수 세 라운드(r1 Medium 3·Low 13을 모두 고치거나 사실대로 문서화했고, r2·r3는 Medium 0). 지적과 처리는 구현 PR 본문에 있다. 결정의 근거는 증보 1이 「닫지 않는 것」으로 남긴 셋과 [ADR-0208](0208-scheduled-messages.md) 「남는 위험 5·8」이다. 새 방향을 정하지 않고 증보 1의 원칙(없는 id와 같은 404, 역할 예외 없음)을 같은 모양으로 잇는다. 구현은 보안 후속 #4443이다.
- **변경 전(증보 1 뒤)**: 메시지를 soft delete해도 첨부 행의 `message_id`는 남는다(`interaction.rs:1183-1186`은 메시지의 `state`·`body`·`deleted_at`만 바꾼다). 그래서 채널 멤버는 지운 메시지의 파일을 content로 계속 읽었고(`attachments.rs:367`), 기록 투영(채널 history·스레드 답)과 보내기 재시도의 echo가 그 파일의 이름·크기·id를 무덤 행에 계속 실었다. 완료됐지만 어떤 메시지에도 묶이지 않은 첨부를 거두는 곳은 없어 보관소는 늘기만 했다. 감사 `attachment.upload_started`의 detail에는 파일 이름이 있었다.

### 결정

- **D1 · 지운 메시지의 첨부 읽기는 404이고 예외가 없다.** content 읽기는 **활성 채널 멤버이면서, 첨부가 살아 있는 메시지에 묶여 있거나(`state <> 'deleted'` 그리고 `deleted_at IS NULL`) 어떤 메시지에도 묶이지 않았고 읽는 사람이 업로더**일 때만 성립한다. 작성자·업로더·워크스페이스 owner·admin의 예외는 없다. 근거: ① 작성자의 삭제가 대화가 그 파일에 가진 몫을 끝낸다. 지운 메시지는 업로더가 아직 쓰고 있는 초안이 아니라서, 증보 1이 업로더에게 준 읽기(보내는 중인 낙관 행)의 이유가 여기에는 없다. ② 파일이 필요한 작성자는 원본을 갖고 있다. 프록시를 보관함으로 쓰게 둘 이유가 없다. ③ 메시지를 지울 수 있는 사람은 작성자뿐이다(`interaction.rs:1164`). admin에게 지운 메시지를 읽는 길은 제품에 없고, 있어야 한다면 준법·신고용 읽기로 따로 결정할 일이다. 거절은 증보 1과 같다: 없는 id와 문장이 같은 404이고 바이트까지 같다(403 아님).
  - **술어의 모양이 결정의 일부다.** `(묶임 AND 살아 있음) OR 업로더`로 쓰면 지운 메시지의 파일이 지운 본인에게 돌아간다. 구현은 `(message_id IS NOT NULL AND 살아 있음) OR (message_id IS NULL AND 업로더)`다(`attachment.rs:364`).
  - **반쪽 무덤도 무덤이다.** `state`와 `deleted_at`은 둘 다 쓰이고 어느 하나만 있는 행이 옛 경로에서 생길 수 있다(`LockedMessage::is_deleted`, `interaction.rs:182`). 둘 다 본다. 에이전트 아바타 원본을 고르는 두 함수(`find_visible_image_attachment_in_tx`·`find_requester_attachment_in_tx`)도 같다(시험 `a_workspace_image_can_be_the_avatar_only_if_the_agent_could_read_it`·`member_avatar_set_a_run_names_its_requester_only_when_that_is_a_live_human`).
  - **soft와 hard의 비대칭을 인정한다.** soft delete는 아무도 못 읽게 하고, 메시지 행 자체를 지우면(`ON DELETE SET NULL`) 파일이 초안으로 돌아가 업로더가 읽는다(증보 1). 코드 경로에는 메시지를 hard delete하는 곳이 없어 운영·CASCADE에서만 생기고, 그렇게 돌아온 파일은 D4 청소기가 거둔다.
- **D2 · 기록 투영은 지운 메시지의 첨부를 싣지 않는다.** 무덤 행은 그대로 보인다(재접속한 클라이언트가 삭제로 수렴해야 한다). 첨부 키만 없다. 세 곳을 SQL에서 막는다: `PAGED_ATTACHMENT_JOIN`(채널 history·스레드 답, `attachment.rs:636`), `message_attachments_in_tx`(보내기 재시도가 저장된 행을 되돌려줄 때의 echo, `attachment.rs:595`), `image_attachments_for_messages_in_tx`(에이전트 포트 대화 읽기의 이미지 목록, `agent_avatar.rs:851`). 마지막은 핸들러가 이미 삭제 행의 `imageAttachments`를 거르므로(`agent_port_tools.rs:859`) SQL이 둘째가 아니라 첫째 겹이 되고 핸들러 가드는 둘째 겹으로 남는다. 실시간 `message.deleted` 프레임은 처음부터 첨부를 싣지 않는다.
- **D3 · 감사 detail에서 파일 이름을 빼고(schema v2), 이미 쓰인 v1 행의 이름은 마이그레이션 151이 지운다.** `attachment.upload_started`의 detail은 `channel_id`·`mime`·`size_bytes`만 가진다. 이름은 사람의 것일 수 있고, 감사는 파일보다 오래 남는다. D4 청소기가 행을 지우면 감사 detail의 이름이 이름의 마지막 사본이 된다. **해시는 기각한다**: 파일 이름은 짧고 추측하기 쉬워서 키 없는 해시는 사전 대입 한 번이면 이름이 되고, 키 있는 해시는 새 비밀과 회전 문제를 만든다. 조사에는 attachment id(행이 있는 동안 조인 키)·mime·크기·채널이면 된다.
  - **소급 정정(owner 승인 2026-10-26, 조건 C)**: 감사 행을 고치는 일이라 **무결성 장치를 먼저 확인했다.** 해시 체인·이전 행 해시 열: 없다. `UPDATE`/`DELETE`를 막는 트리거·규칙·정책: 없다(사용자 정의 트리거 0, 규칙 0, 정책은 `ws_isolation` 하나; 격리 PG에 모든 마이그레이션을 적용해 `pg_trigger`·`pg_rules`·`pg_policies`·`relacl`로 확인했다). 런타임 역할 `momo_app`은 이 표에 SELECT·INSERT·UPDATE·DELETE를 가진다(`bootstrap_runtime_roles.sql`). 문서에 「추가 전용」 약속이 없다(오히려 `write_audit`는 행동이 롤백되면 감사 행도 함께 사라진다고 적는다, `docs/security/README.ko.md`). 관리자가 감사 행을 읽는 REST 경로가 없고, `detail.name`을 읽는 코드도 없다(서버는 action·target의 존재만 읽는다). **그래서 이 정정은 어떤 보장도 깨지 않는다.**
  - **범위**: `action = 'attachment.upload_started'`이고 detail에 최상위 `name`이 있는 행에서 그 키 하나만 지운다(`151_audit_attachment_name_scrub.sql`). `schema` 문자열은 고치지 않고(v1 행은 v1로 남고 이름만 없다), 옛 서버가 `schema` 키 없이 쓴 행도 지운다. 다른 action의 행은 `name` 키가 있어도(`member.renamed`) 건드리지 않는다. 아바타 업로드 감사(`member/workspace.avatar_upload_started`)의 `name`은 별개 표면(ADR-0161)이라 범위 밖이다. 멱등이고, 감사 행을 수정하는 **유일한** 마이그레이션이다. 앞뒤 행 수는 `RAISE NOTICE`로 남는다(행은 사라지지 않는다).
  - **배포 창**: 배포 중 아직 도는 이전 버전 api가 v1 행을 쓰면 정정 뒤에도 이름 있는 행이 한두 개 생길 수 있다. 그래서 마이그레이션은 「0이어야 한다」고 단정하지 않고(거짓 실패로 배포를 멈추지 않는다) 숫자만 남기며, 점검 SQL(8절)이 남은 수를 센다. 배포가 끝난 뒤에도 0이 아니면 같은 UPDATE 한 문장을 다시 돌린다. 운영 적용은 배포의 사전 덤프 뒤에 일어난다.
- **D4 · 묶이지 않은 완료 첨부 청소기.**
  - **대상**: `status = 'complete'`, `message_id IS NULL`, `NOT reserved`, `GREATEST(created_at, unreserved_at)`가 30일(`UNBOUND_TTL`) 전보다 오래된 행, **그리고 아래 「지워도 되는 첨부의 정의」 표의 어떤 참조도 없는 행**. 30일은 inbox 읽은 항목·run 이벤트 원장의 보존과 같은 값이다(ADR-0199 D4, ADR-0200 D2). 컴포저에 남은 초안 첨부는 그보다 오래 쓰이지 않는다. 예약이 쥔 파일은 `reserved`로 빠지므로 예약의 120일 한도가 이 숫자를 정하지 않는다. `pending`·`failed` 행은 이 청소기의 대상이 아니다(남는 위험).
  - **시계**: 업로드(`created_at`)와 마지막 점유 해제(`unreserved_at`) 중 늦은 때부터 센다. ADR-0208 D11 「취소하면 점유를 풀고 파일은 남는다(초안과 같은 상태)」를 지키려는 것이다. 100일 묵은 예약을 취소하는 순간 다음 틱에 파일이 사라지면 「초안과 같은 상태」가 아니다. 한 가지 예외가 있다: **마이그레이션 150보다 앞서 풀린 점유**는 `unreserved_at`이 비어 있어 업로드 시각으로만 판정한다(예약 기능 145가 나온 뒤 150이 배포되기까지의 며칠에 한정되고 청소기는 꺼진 채 나온다). 그런 파일은 점검 SQL의 후보 수에 처음부터 안 풀린 파일과 섞여 구별되지 않는다(켜기 전에 후보 수가 예상과 맞는지로 판단한다).
  - **점유는 attachment 행에 비춘다.** 예약 점유 표 `scheduled_message_attachment`는 작성자 범위 RLS이고 BYPASSRLS 역할에는 봉인돼 있다(ADR-0208 D3, `145_scheduled_message.sql:124-131`). 청소기가 점유를 직접 보려면 남의 `app.member_id`를 묶어야 하는데 그것은 ADR-0208 D14-4가 이름 있는 세 함수로 고정한 예외이고, 새 definer를 만들 수도 없다. 그래서 마이그레이션 150이 `attachment.reserved`·`unreserved_at`을 더하고 **SECURITY INVOKER 트리거**가 점유 행의 INSERT·DELETE를 거기에 비춘다. 예약 생성·취소·발송·정리·CASCADE가 어느 경로로 점유를 만들고 지우든 한 곳에서 맞는다. 청소기는 이 열만 본다. ADR-0208의 점유 표에는 이 트리거 하나만 더하고 표 권한·RLS 정책·봉인은 바꾸지 않는다. 비춘 표시가 실제 점유 행과 어긋나면(트리거를 우회한 복원이나 버그) 점검 SQL의 5절이 센다.
  - **RLS 경계: 교차 테넌트 읽기는 워크스페이스 id뿐이다.** notifier의 BYPASSRLS는 「백그라운드 소비자의 문서화된 예외」로 이미 있고(`bootstrap_runtime_roles.sql:40`, 표는 FORCE RLS 그대로, DELETE 없음), 이 증보는 그 읽기에 **컬럼 여섯 개**(`workspace_id`·`status`·`message_id`·`reserved`·`unreserved_at`·`created_at`)를 더할 뿐이다. 첨부 id·`drive_file_id`·이름·mime·크기·업로더는 주지 않는다. 그 읽기는 `SELECT workspace_id … GROUP BY workspace_id` 하나이고, **후보 목록·참조 재판정·건수와 바이트 집계·삭제는 전부 워크스페이스별 `momo_app` RLS-bound 테넌트 tx**(`SET LOCAL app.workspace_id`)가 한다. `ensure_write_pool_rls_bound`가 BYPASSRLS 풀을 거절한다. 전례: 아바타 회수(`avatar_reclaim.rs:10-23`, ADR-0161 D5 증보 2)와 inbox·share·run event 보존 청소가 같은 모양이고, 컬럼 단위 notifier GRANT는 #3377 블록이 #2862 공유 보존·#3284 아바타 회수·#3553·#4284에서 이미 쓴다(`bootstrap_runtime_roles.sql`). 예약 메시지 틱(`scheduler.rs:1-14`)은 교차 테넌트 읽기를 id만 돌려주는 definer 두 개로 한다. 같은 방식을 첨부에 쓰면 새 definer가 필요하므로 택하지 않았다. **새 예외는 notifier 컬럼 SELECT 여섯 개뿐이고 전례의 가족 안이다. 새 BYPASSRLS 쓰기 경로·새 SECURITY DEFINER·남의 owner GUC 묶기는 없다.**
  - **두 러너, 하나의 결정(owner 승인 B)**: 보관소에 바이트를 쥔 프로세스가 지운다. **Google Drive**는 notifier가 돈다(`momo-notifier` `attachment_reclaim.rs`). **로컬 볼륨**(셀프호스트·Railway의 기본)은 api 프로세스만 볼륨을 쥐고 `LocalDriveArchive::open`이 연 프로세스의 보류 세션을 지우므로 다른 프로세스가 열 수 없다(`avatar_reclaim.rs:33-36`의 한계와 같다). 그래서 **api 프로세스가 같은 두 단계를 돈다**(`momo-server` `attachment_reclaim.rs`, `backend == local`일 때만, 둘 다 돌면 같은 행을 두 프로세스가 보게 되므로). 「무엇을 지워도 되는가」와 「건조 실행이 무엇을 세는가」는 하나의 함수(`momo_messaging::attachment_reclaim::reclaim_pass`)라 두 러너가 다르게 판정할 수 없다. api 러너는 `scheduler`처럼 자기 두 연결 풀(`momo_app`)로 돌고 BYPASSRLS 역할이면 돌지 않는다.
    - **교차 테넌트 읽기가 없다.** `momo_app`은 GUC 없이 `workspace` 행을 하나도 못 본다(`workspace`는 FORCE RLS이고, 격리 DB에서 `SELECT count(*) FROM workspace`가 0임을 확인했다). 워크스페이스를 열거하려면 api 프로세스에 BYPASSRLS 읽기 연결을 두거나(AGENTS.md가 막는다) **새 SECURITY DEFINER**를 만들어야 한다. owner가 새 정의자를 가능하면 피하라고 했고, 새 definer는 149→150에서 이미 겪은 업그레이드 순서 위험(부트스트랩이 마이그레이션 앞에도 돈다)과 세 파일 잠금 동기화를 부른다. **그래서 이번에는 만들지 않는다.**
    - **대신 「이 프로세스가 업로드를 받은 워크스페이스」를 본다.** `create_upload`가 성공하면 principal의 워크스페이스(`workspace_scope`가 검증한 값, 요청 본문이 아니다)를 메모리 집합에 적고(`TouchedWorkspaces`, 최대 10,000개, id만), 틱이 그 집합을 `SET LOCAL app.workspace_id` 테넌트 tx로 하나씩 돈다(틱당 100개 상한). **큰 백로그가 예산을 독점하지 못하게 순서를 돌린다**: 다음 틱은 이번 틱이 **마지막으로 본 워크스페이스 다음**부터 이어 본다(예산이 끊긴 워크스페이스는 줄의 맨 뒤로 가고, 100개를 넘는 집합은 창 단위로 걷는다. 시험: 백로그 4건인 워크스페이스와 1건인 워크스페이스를 예산 2로 두 틱 돌리면 두 번째 틱에 작은 쪽 파일이 사라지고, 150개가 넘는 집합에서 둘째 틱이 둘째 창에 닿는다). 집합의 내용은 어떤 파일도 이름도 멤버도 아니고 「다음에 열 테넌트 tx」를 정하는 데만 쓰인다.
    - **커버리지는 계약이다(각주가 아니다).** 업로드가 계속 오는 워크스페이스는 쓸린다(자격 되는 것을 배치 단위로 전부). **재시작 뒤 업로드가 없던 워크스페이스는 누가 올리기 전까지 보지 않는다**: 거기 묵은 초안은 지금처럼 바이트도 행도 남는다. 업로드가 없는 워크스페이스에서는 보관소가 늘지 않으므로 이 공백은 누수가 아니라 한정된 잔여분이다. 완전 커버리지가 필요하면 id만 돌려주는 최소 definer(ADR-0208 145 모양, 고정 `search_path`·전용 소유 역할·EXECUTE는 청소기 역할만)가 후속이고, owner가 그때 다시 결정한다. 시험이 이 공백을 고정한다(`the_tick_follows_the_workspaces_this_process_served_…`: 이 프로세스가 본 적 없는 워크스페이스의 묵은 파일은 남는다).
  - **순서**: 행을 `FOR UPDATE`로 잠그고 → 새 문장으로 자격을 다시 판정하고 → `SAVEPOINT` 안에서 **행 DELETE와 감사 INSERT를 먼저** 하고 → 보관소 객체를 지우고 → 성공이면 COMMIT, 실패면 `ROLLBACK TO SAVEPOINT`다. 행을 먼저 지우는 이유는 `huddle_transcription_*`가 `attachment`를 참조하는 FK(`046_huddle_transcription.sql`) 때문이다. FK가 삭제를 거절하면 바이트를 지우기 전에 tx가 선다(술어가 그 행을 먼저 거르므로 거절에 기대지는 않는다). 잠금이 경쟁도 정리한다: 메시지 묶기(`link_attachments_in_tx`)와 예약 점유(`reserve_attachments_in_tx`)는 둘 다 먼저 같은 행을 `FOR UPDATE`로 잡으므로, 그쪽이 먼저 커밋하면 재판정이 보고 건너뛰고, 나중이면 잠금을 기다렸다가 행이 없는 것을 본다.
  - **업그레이드 순서**: 운영 역할 파일(`bootstrap_runtime_roles.sql`)은 한 릴리스의 마이그레이션 **앞에도** 돈다(Railway pre-deploy, compose `runtime-roles`; `momo-migrate`는 `ON_ERROR_STOP`으로 파일 전체를 적용한다). 150이 `reserved`·`unreserved_at`을 더하므로 149→150 업그레이드의 첫 패스는 표는 있고 컬럼은 없는 상태에서 notifier GRANT를 만나 `column "reserved" of relation "attachment" does not exist`로 파일 전체와 배포를 멈춘다(149 상태 DB에서 실측했다. 아바타 회수의 `drive_reclaimed_at`은 컬럼(마이그레이션 112, #3284, 2026-10-02)이 GRANT(#3377 수리, 2026-10-03)보다 먼저 배포돼 이 순서 문제를 겪지 않았다). 그래서 부트스트랩의 GRANT는 컬럼이 있을 때만 치고(`pg_attribute` 확인), 마이그레이션 150이 컬럼을 더하면서 같이 grant하며, 둘째 패스가 한 번 더 한다. 새 설치는 첫 패스에 표 자체가 없어 기존 시험이 이 경로를 볼 수 없었으므로 업그레이드 시험을 따로 둔다(아래 red proof). **마이그레이션 151은 데이터만 고치고 컬럼·함수·권한을 더하지 않으므로 이 위험이 없다.**
  - **실패와 재시도**: 보관소 일시 실패는 아무것도 쓰지 않고 다음 틱이 다시 한다(연속 세 번 실패하면 틱이 멈춘다). 보관소 404는 성공이다(`delete_file`은 멱등이라 「보관소는 지웠고 COMMIT 전에 죽은」 경우가 다음 틱에 수렴한다). 영구 거절(`AccessDenied`·잘못된 id)은 행도 객체도 건드리지 않고 건수만 센다. 우리 드라이브의 객체가 아니면 우리가 지울 것이 아니고, 행을 지우면 객체가 어디 있는지를 잊는다.
  - **감사**: 지운 행마다 `attachment.expired`(행위자 없음, 대상 멤버는 업로더(시스템 행의 기존 관례), 대상 attachment id, `reason: unbound_ttl`, mime·크기·채널. 이름·Drive id 없음)를 같은 tx에 쓴다. 로그에는 건수만 남긴다.
  - **기본 꺼짐과 켜는 절차(owner 승인 2026-10-26 + planner 결정 1)**: 이 잡은 파일을 지우므로 **`MOMO_ATTACHMENT_RECLAIM`이 정확히 `1`일 때만 지운다**(`delete_switch_is_on`, 두 러너가 부르는 정의가 하나다. `true`·`yes`·` 1`·`01`·빈 값은 모두 꺼짐). 꺼진 채로도 틱마다 같은 읽기 경로를 돌아 **고정된 한 줄**을 남긴다: `attachment reclaim dry-run: delete_enabled=false scope=<all|touched> looked_at=N workspaces=W candidates=C bytes=B …`. `candidates`·`bytes`는 삭제와 같은 술어로 센 값이고, 꺼진 틱은 보관소 클라이언트를 만들지도 부르지도 않는다. 켜는 것은 owner가 배포 뒤 아래를 확인한 다음이다:
    1. 배포하고(마이그레이션 150·151 적용), 틱 몇 번의 dry-run 줄을 본다.
    2. 슈퍼유저로 `infra/rust/sql/attachment_reclaim_check.sql`을 돌린다(읽기 전용, 한 문장·한 스냅샷). 후보 수·바이트(1절), 이유별 분포(2절), 워크스페이스별 후보(3절), 새 FK 감지(4절), 후보 중 참조 있는 행과 점유 표시 어긋남(5절, 0이어야 함), 후보 id를 글자로 담은 json 열(6절), 같은 보관소 객체를 가리키는 다른 행(7절, 0), 감사에 남은 이름·청소 기록(8절).
    3. 대조: 로그의 `candidates`·`bytes`는 1절의 값 **이하**여야 한다(`scope=touched`는 이 프로세스가 재시작 뒤 업로드를 받은 워크스페이스만 보고, `scope=all`은 한 틱에 100개 워크스페이스까지 본다). 로그가 1절보다 **크면** 청소기가 점검이 모르는 파일을 세는 것이니 켜지 않는다. 4절에 `UNKNOWN`이 있어도 켜지 않는다. 점검 SQL의 술어는 청소기 소스의 것과 글자까지 같다는 것을 단위 시험이, 두 숫자가 같은 파일을 세는지를 PG 시험이 잰다.
    4. 켠 뒤 같은 SQL을 다시 돌려 1절이 줄었는지, 지운 행마다 남는 감사 `attachment.expired` 수가 늘었는지(8절)를 본다. 끄려면 변수를 `1`이 아닌 값으로 돌린다(Drive 값은 건드리지 않는다).
    - 업그레이드 뒤 첫 틱들은 쌓여 있던 묶이지 않은 30일 넘은 완료 첨부를 틱당 `batch`건(기본 50, 10분 간격)씩 거둔다. 그러니 켜기 전 확인이 이 일의 안전 장치다.

### 지워도 되는 첨부의 정의 — 첨부 id를 가리키는 곳 전수 (owner 승인 A)

방법은 둘이다. ① 마이그레이션을 전부 적용한 격리 DB에서 `pg_constraint`(들어오는 FK 4개, `attachment`가 내보내는 FK 4개)와 `information_schema.columns`(`json`·`jsonb` 열 32개, 이름에 `attach`가 든 열, `uuid[]` 열 8개)를 질의했다. ② 코드는 `rg -i attachment server-rust`(Rust 파일 50개)와 `rg attachmentIds|attachment_ids packages clients`, 클라이언트 저장소 키 목록을 훑고 각 쓰기 자리를 읽었다. 청소기 후보 술어는 **구조가 막는 참조(A)가 모두 없음**을 요구하고, 소프트 참조(B)는 「누가 이 id를 읽어 첨부를 찾는가」를 자리마다 적어 읽는 이가 없음을 보였다.

**A. 구조가 막는 참조 — 술어에 들어가고 시험이 하나씩 고정한다**

| # | 참조 | 정의 | 누가 쓰나 | 술어·시험 |
|---|---|---|---|---|
| A1 | 메시지 묶임 | `017_attachment.sql:14` `message_id … ON DELETE SET NULL` | 단 한 곳 `link_attachments_in_tx`(`attachment.rs:515`)가 보내기 척추에서 호출된다. 예약 발송·에이전트 deliver도 같은 척추다. 묶임을 푸는 코드는 없고(`rg 'message_id = NULL'`=0) 메시지 행을 hard delete하는 곳도 없다(`rg 'DELETE FROM message'`=0, 핀·리마인더만) | `message_id IS NULL` — 묶인 행(지운 메시지 포함)은 후보가 아니다. `old_unbound_complete_…`·`a_file_something_else_holds_…`(지운 메시지) |
| A2 | 예약 점유 | `145_scheduled_message.sql:91-99` `attachment_id … ON DELETE CASCADE`, UNIQUE. 표는 작성자 범위 FORCE RLS(`:124-131`), BYPASSRLS에 봉인(ADR-0208 D3) | `reserve_attachments_in_tx`(`scheduled.rs:601`, 행을 `FOR UPDATE`로 잠근 뒤 INSERT) | 점유된 파일을 지우면 CASCADE로 점유가 사라져 예약이 파일 없이 나간다. `NOT reserved` + `GREATEST(…unreserved_at…)`, 트리거가 표시를 맞춘다 — `a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl` |
| A3 | huddle 전사 합본 | `046_huddle_transcription.sql:56,62-63` `merged_transcript_attachment_id` FK `(workspace_id, id)` | 지금 Rust에는 이 열을 채우는 곳이 없다(`rg merged_transcript_attachment_id`는 술어뿐). 이전 서버가 남긴 행·앞으로의 파이프라인 | `NOT EXISTS (… huddle_transcription_job …)` — `a_file_something_else_holds_…` |
| A4 | huddle 전사 트랙 | `046…:79-86` `source_attachment_id`·`transcript_attachment_id` FK | A3과 같다 | A3과 같다(두 열 각각) |

**A5(술어 밖, #4820 C2a 2026-10-31)**: 원본 사진 짧은 주소 `self_media_token.attachment_id`(`160_self_media_token.sql`, `ON DELETE CASCADE`). 쓰는 곳은 agent-worker의 `self_media::mint_for_run_in_tx` 하나이고, 런 요청자가 같은 대화에 올린 완료·미삭제 이미지 첨부만 가리킨다. 그 첨부는 메시지에 묶여 있어(A1) 후보가 아니므로 술어에 넣지 않는다. 묶임이 풀린 뒤 회수되면 5분·1회용 토큰은 CASCADE로 함께 지워지고, Hermes의 받기는 다른 거절과 같은 404다. 점검 SQL 4절은 이 FK를 `(known)`으로 센다.

**B. FK 없는 소프트 참조 — 읽는 이가 있는가**

| # | 자리 | 무엇이 들어가나 | 누가 첨부를 찾는 데 쓰나 | 판정 |
|---|---|---|---|---|
| B1 | `message.props` (jsonb, 열린 객체) | 서버 소유 키와 생산자 임의 키 | **없다.** 읽기 인가는 `attachment.message_id`로 정해지고 props를 첨부로 풀어 주는 코드가 없다. 1급 클라이언트도 props에 첨부 id를 넣지 않는다(`rg attachmentIds packages clients`는 보내기 요청 본문뿐) | 참조 아님 |
| B2 | `approval.payload`·아바타 제안(`member.avatar.set`·`agent.profile.update`) | 제안은 `{attachmentId}`(`action_resolve.rs:1356-1374`) | **제안 때 한 번** 파일을 읽어 바이트를 `agent_avatar_image`에 복사하고, 저장되는 형태에는 id가 없다(`actions.rs:1787` `bytes_and_attachment_ids_never_reach_the_stored_form`). 제안 때의 조회는 항상 묶인 살아 있는 메시지를 요구한다(`agent_avatar.rs`) — 묶이지 않은 행은 애초에 후보가 아니다 | 참조 아님 |
| B3 | `agent_run.input/output`·`agent_run_event` | 실행 입력·도구 호출 | 기록·표시만. 에이전트 문맥에 첨부는 들어가지 않는다(아바타 도구 스키마 설명뿐). 포트 대화 읽기의 이미지는 묶인 살아 있는 메시지의 행에서 나온다(`agent_avatar.rs:851`) | 참조 아님 |
| B4 | `outbox.payload` | `message.new`의 첨부 요약 | 릴레이가 내보낼 뿐 첨부를 찾지 않는다. 담긴 첨부는 이미 묶인 행이다 | 참조 아님 |
| B5 | `audit_log.detail` | 첨부 id(`target_id`)와 mime·크기·채널 | 조사자가 읽는다. 행이 사라진 뒤에도 남는 것이 설계다(`attachment.expired`) | 참조 아님(역사 기록) |
| B6 | agent memory(`mem_*`) | 대화 요약·사실 | 파일을 읽지 않는다(`memory.rs:1169` `NOTICE_NEVER_SENDS`에 `attachments`) | 참조 아님 |
| B7 | Slack 호환 웹훅의 `attachments` | 텍스트로 푼 카드 필드 | 우리 첨부 표와 무관한 같은 이름(`momo-webhook/src/payload.rs`) | 혼동 방지 |
| B8 | 아바타 미디어 `member_avatar_media`·`workspace_avatar_media` | 자기 `drive_file_id` | 아바타 회수가 지운다. attachment의 `drive_file_id`를 복사하는 코드가 없다(두 모듈에 `FROM attachment`가 없다) | 참조 아님이지만 **같은 객체를 두 행이 가리키면** 한쪽 삭제가 다른 쪽을 부수므로 술어가 같은 `drive_file_id`를 가진 아바타 미디어 행이 있으면 거른다(`a_file_something_else_holds_…`, 두 표) |
| B9 | 이름만 비슷한 열 | `cloud_box.last_attached_at`·`work_session.attach_endpoint`, 옛 `file` 표 | 무관 | 혼동 방지 |
| B10 | 보관소 객체 id | `attachment_workspace_drive_file_uniq (workspace_id, drive_file_id)`(044) | 세션 생성이 id를 정한다. 클라이언트가 고르지 못하고 `complete`는 요청 때 저장한 id와 대조한다 | 다른 워크스페이스가 같은 객체를 가리키면 RLS가 청소기 시야를 막는다. 점검 SQL 7절이 0임을 운영 데이터로 보인다 |

**C. 서버가 모르는 참조 — 클라이언트 초안**: 첨부 초안은 **세션 메모리뿐**이고 디스크에 남지 않는다(웹 `features/attachments/draftStore.ts:36-46`은 `File`을 들고 있어 localStorage로 갈 수 없다; 폰 `features/attachments/draftStore.ts`는 모듈 전역 `Map`, 로그아웃은 `clearAllAttachmentDrafts`; 폰 MMKV `composerDrafts`와 웹 localStorage 초안은 **본문 글자만**이고 첨부 id가 없다, 30일 `DRAFT_TTL_MS`). 서버가 모르는 유일한 참조는 열려 있는 컴포저의 메모리다. 업로드 세션은 길어야 일주일이고 `created_at`은 세션 시작이며 `complete`는 그 안에 일어나므로 **완료된 파일은 최소 23일의 유예**를 갖는다. 30일 넘게 같은 컴포저 탭을 열어 둔 채 첨부를 안 보낸 경우에만 보낼 때 「첨부를 찾을 수 없음」을 만나고 다시 올리면 된다. 원본은 올린 사람의 기기에 있으므로 지우는 쪽에서 데이터를 잃는 일은 없다. 30일은 이 위험을 덮는다.

**전수가 계속 맞는지**: 첨부를 가리키는 FK가 새로 생기면 점검 SQL 4절이 `UNKNOWN`을 내고, PG 시험이 FK 다섯 개(A1~A4와 A5)가 전부 `(known)`임을 단정하므로 CI가 빨개진다. 그때 이 표와 술어와 점검 SQL을 함께 고친다.

### 이슈 #4443 문구와 다른 곳

① 이슈는 청소기를 「notifier 스윕」이라 적었다. Google Drive는 그대로 notifier이고, **로컬 볼륨은 api 프로세스가 돈다**(위). ② 이슈의 「감사 detail에서 파일 이름 제거 또는 해시화」는 제거로 정했고 이미 쓰인 행은 소급해 지운다. ③ 이슈는 「작성자·관리자 예외 여부는 ADR 근거」라 적었고 예외 없음으로 정했다. ④ 이슈 코멘트의 「기록 투영의 첨부 메타 비우기」는 무덤 행을 지우지 않고 첨부 키만 뺀다. ⑤ 청소기는 기본 꺼짐이다(이슈에 없던 안전 조건).

### 기각한 대안

- **청소기가 점유 표를 직접 본다**: 남의 owner GUC 묶기는 ADR-0208 D14-4가 고정한 예외를 늘리고, notifier에 점유 표를 GRANT하면 D3의 봉인을 푼다. 새 definer는 이 일의 범위가 아니다. 그래서 점유를 attachment 행에 비췄다.
- **로컬 볼륨을 위해 api 프로세스에 BYPASSRLS 읽기 연결을 둔다**: 인터넷에 면한 프로세스에 교차 테넌트 읽기 권한이 생긴다. AGENTS.md가 쓰기 경로의 BYPASSRLS를 막고, 읽기라 해도 새 경계를 이 일 하나로 여는 것은 과하다.
- **워크스페이스를 열거하는 새 SECURITY DEFINER(`momo_schedule_private` 모양)**: 커버리지는 완전해지지만 새 정의자가 생기고, 149→150에서 겪은 부트스트랩 순서 위험과 세 파일 잠금 동기화를 부른다. owner가 「가능하면 새 정의자 없이」라고 했고 「업로드를 받은 워크스페이스」로 가능했으므로 후속 선택지로 둔다.
- **notifier가 볼륨을 같이 마운트한다**: `LocalDriveArchive::open`이 연 프로세스의 보류 세션을 지우므로 두 프로세스가 열면 업로드 중인 세션을 지운다.
- **기본 켜짐 + 끄기 스위치(1단계 설계)**: 업그레이드 뒤 첫 틱들이 쌓인 첨부를 한꺼번에 거둔다. 운영 데이터(파일)를 지우는 잡이라 켜기 전에 사람이 같은 숫자를 다른 길로 확인하는 편이 맞다. 그래서 기본 꺼짐 + 건조 실행 줄 + 점검 SQL로 바꿨다.
- **TTL을 180일로 늘려 `reserved` 없이 가기**: 170일 묵은 초안을 예약에 쥐면 여전히 말없이 잃는다. 실패한 예약을 다시 걸 수 있어(ADR-0208 D9) 한 파일이 예약에 매이는 기간은 120일로 끝나지 않을 수 있다.
- **아바타 회수처럼 행을 지우지 않고 표시만 하기**: `drive_file_id`가 남아 content 경로가 Drive 404(「Drive attachment was not found」)를 돌려주고, 없는 id의 문장과 달라진다. 행 수도 줄지 않는다.
- **보관소를 먼저 지우고 행을 나중에 지우기**: FK가 행 삭제를 거절하는 때 바이트는 이미 없다.
- **지운 메시지의 파일을 업로더·작성자에게는 열어 두기**: D1의 근거 ①②. 지운 사람이 그 파일을 프록시로 계속 받는 길이 된다.
- **파일 이름을 해시로 남기기·감사 v1 행을 그대로 두기**: D3. 해시는 사전 대입 한 번이고, 그대로 두면 청소기가 파일을 지운 뒤에도 이름이 감사에 마지막 사본으로 남는다.
- **pending·failed 행까지 청소하기**: 이 일의 대상(완료됐지만 묶이지 않은 첨부)이 아니고, `failed`는 보관소 쪽 사정(크기·mime 불일치)이 달라 따로 판단할 일이다.

### 남는 위험

- **로컬 러너의 커버리지**: 재시작 뒤 업로드를 받지 못한 워크스페이스의 묵은 초안은 청소되지 않는다(위 D4). 완전 커버리지는 id만 돌려주는 최소 definer 후속이다. 건조 실행 줄의 `scope=touched`가 이 한계를 이름으로 드러낸다.
- **지운 메시지에 묶인 파일의 바이트**: `message_id`가 남으므로 청소기는 건드리지 않는다. 읽을 수는 없지만(D1) 행과 바이트는 남는다. 점검 SQL 2절의 「bound to a deleted message」가 그 수를 보인다. 거두려면 따로 결정한다.
- **`pending`·`failed` 행과 그 바이트**는 거두지 않는다(`attachment_pending_cleanup_idx`는 쓰는 곳이 없다).
- **영구 거절 행이 후보 창을 차지한다.** 후보는 오래된 순으로 틱당 `batch`(기본 50)건이라, 보관소가 영구 거절하는 행(우리 드라이브에 없는 객체, 잘못된 id)이 그만큼 쌓이면 그 뒤의 새 후보가 처리되지 않는다. 백엔드를 바꾼 인스턴스가 아니면 생기지 않고(읽기도 함께 깨진다), 건수는 로그의 `refused`로 드러난다. 생기면 후보를 돌려가며 읽어서 푼다.
- **다른 워크스페이스가 같은 보관소 객체를 가리키는 경우**는 청소기(테넌트 tx, RLS가 시야를 막는다)가 볼 수 없다. 지금 코드에는 그런 경로가 없고 점검 SQL 7절이 0임을 운영 데이터로 보인다.
- **채널·워크스페이스를 지우면(FK CASCADE) 첨부 행이 사라져 보관소 객체가 고아가 된다.** 행을 따라가는 이 청소기는 못 찾는다.
- **30일을 넘긴 컴포저 초안**은 보낼 때 404(첨부를 못 찾음)를 만나 다시 올려야 한다.
- **배포 중 이전 버전 api가 쓴 감사 v1 행**은 정정 뒤에도 이름을 가질 수 있다(D3). 점검 SQL 8절이 센다.
- **클라이언트**: 코어의 `applyTombstone`(`packages/momo-core/src/features/timeline/model.ts`)은 무덤으로 바꿀 때 메모리의 `attachments`를 남긴다. 웹·모바일 `MessageRow`는 무덤 행에서 첨부 카드를 그리지 않으므로(검수 r3가 읽어서 확인) 메모리의 카드가 404를 맞는 일은 거의 없지만, 메모리 정리는 UXUI 후속이다.
- **아바타 업로드 감사**(`member.avatar_upload_started`·`workspace.avatar_upload_started`)의 `name`도 같은 모양이다. 별개 표면(ADR-0161)이라 이 증보는 건드리지 않았다.
- **빈 볼륨·마운트되지 않은 볼륨**: 로컬 아카이브는 없는 객체의 삭제를 성공으로 치고(`local.rs`의 `delete_file`) 없는 디렉터리는 만들어 준다. 볼륨 마운트가 실패한 채 부팅한 api에서 스위치가 켜져 있으면 묵은 초안의 **행**이 지워지고 실제 바이트는 마운트되지 않은 볼륨에 고아로 남는다(지워질 후보였던 행이라 사용자 데이터의 추가 손실은 없다). 켜기 전에 api 컨테이너 안에서 볼륨에 파일이 실제로 있는지(`oort exec api sh -c 'ls "$MOMO_DRIVE_LOCAL_DIR/objects" | head'`) 직접 확인한다(시작 로그는 마운트 여부를 말해 주지 않는다). 틱 시작 때 볼륨 표식을 확인하는 보강은 후속이다.
- **두 서비스의 백엔드 변수는 같은 값이어야 한다**: api가 `local`인데 notifier에 Google 키·공유드라이브 id가 있고 notifier의 백엔드 변수가 비어 있으면 notifier도 청소기를 구성해 `local-…` id에 Google 삭제를 부르고, 프로브 404를 성공으로 처리해 행만 지워질 수 있다(스위치가 켜진 때만). Railway는 notifier에 Drive 변수를 주지 않아 해당 없다.
- **셀프호스트 compose에서는 Google 백엔드의 청소를 켤 수 없다.** Google Drive는 notifier가 청소하는데, compose의 notifier 서비스(`huddle-notifier`, 푸시 오버레이)는 Drive 변수와 `MOMO_ATTACHMENT_RECLAIM*`를 받지 않고 notifier는 셀프호스트 기본 스택에도 없다(ADR-0208). 그래서 청소도 dry-run 줄도 없고 안전한 쪽으로 실패한다. 지금 켤 수 있는 경로는 `local` 백엔드(api가 청소: Railway 팀 인스턴스와 셀프호스트 compose)다.
- **`complete` 라우트의 응답**은 업로더 범위로 읽고 이미 `complete`이면 그대로 200을 돌려준다. 지운 메시지에 묶였던 파일도 업로더 본인은 이름·mime·크기·`messageId`를 받는다(남에게는 새지 않는 본인 데이터). 「아무도 읽지 못한다」는 파일 내용(content)에 대한 말이다.
- **runtime-unverified**: 한 줄짜리 전달들은 시험이 닿지 않는다 — `main.rs`가 `config.attachment_reclaim`을 `start`에 넘기는 호출과 기동·종료 배선(결정 함수 `runs_in_this_process`는 시험한다), api `AttachmentReclaimSettings::from_env`·`Config::from_env`와 `NotifierConfig::from_env`가 각각 `from_lookup`·`attachment_reclaim_from`을 부르는 줄(그 안의 스위치 읽기는 시험한다), notifier `lib.rs`가 청소 루프를 띄우는 한 번의 `from_config` 호출(`from_config_with`는 시험한다). 틱 한가운데에서의 프로세스 종료와 실제 Google Drive 호출(기록용 대역으로 시험했다)도 시험이 닿지 않는다. api 러너의 타이머 루프는 짧은 주기로 실제 `start`를 돌려 시험한다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 | `attachment_conformance_pg::a_deleted_messages_attachment_is_nobodys_to_read` | 읽기 술어에서 `m.state <> 'deleted'`만 지우면 `state`만 쓰인 반쪽 무덤이 200, `m.deleted_at IS NULL`만 지우면 `deleted_at`만 쓰인 반쪽 무덤이 200, 둘 다 지우면 방·작성자·admin이 200, `OR 업로더`를 괄호 밖으로 빼면 작성자 본인이 200 |
| D2 | `a_deleted_messages_attachments_are_not_listed_anywhere` | `PAGED_ATTACHMENT_JOIN`에서 지우면 채널 history가 카드를 싣고(스레드 답은 같은 상수를 읽는다), `message_attachments_in_tx`에서 지우면 재시도 echo가 싣고, `image_attachments_for_messages_in_tx`에서 지우면 직접 호출이 이미지를 돌려준다 |
| D3 | `the_audit_trail_never_holds_a_file_name` | detail에 `"name": name`을 되돌리면 |
| D3(소급) | `prod_role_conformance_pg::the_audit_scrub_removes_a_file_name_from_old_upload_rows_and_touches_nothing_else` | `action` 조건을 지우면(다른 action의 `name`이 사라진다), 다른 키를 지우면, v1 schema만 고르면(schema 없는 옛 행이 남는다), `detail ? 'name'`을 지우면(둘째 실행이 이름 없는 행의 행 버전을 바꾼다) |
| D4 | `a_held_file_is_never_reclaimed_and_a_released_one_is_a_draft_for_a_full_ttl` | `NOT a.reserved`를 지우면 2단계, `GREATEST`의 `unreserved_at` 항을 지우면 3단계, 트리거 INSERT 가지를 비우면 1단계, DELETE 가지를 비우면 3단계가 빨강 |
| D4 | `attachment_reclaim_conformance_pg`(notifier) | 자격 항 다섯(`status`·`message_id`·`reserved`·`unreserved_at`·나이)을 하나씩, `NO_OTHER_HOLD_SQL`의 `NOT EXISTS` 넷을 하나씩(huddle 세 열·아바타 두 표), 저장점 롤백(실패 팔 / 저장점을 늦게 열기), 404=성공, 거절 시 행 유지, 잠금 뒤 재판정, 잠금 없이 먼저 부른 보관소, 테넌트 술어 셋 모두(RLS 없는 둘째 모드), BYPASSRLS 쓰기 풀 거절, 꺼진 틱이 지우는 것(건조 실행이 삭제 경로에 닿으면) |
| D4 · 점검 SQL | `the_operators_check_sql_agrees_with_the_sweep_and_would_notice_a_reference_it_does_not_know` + 단위 `the_operators_check_sql_embeds_the_sweeps_predicate_word_for_word` | 점검 SQL의 후보 술어 한 항을 바꾸면(청소기의 건수와 어긋난다), 이유 분포가 아바타 공유 객체를 놓치면, FK 목록을 다른 표로 바꾸면(새 FK가 안 보인다), 점유 표시 어긋남 탐침을 막으면, json 열 스캔에서 jsonb를 빼면, 같은 객체 탐침을 막으면 |
| D4 · api 러너 | `attachment_reclaim_local_pg`(6개) + `attachment_reclaim` 단위 시험 | `create_upload`가 워크스페이스를 적지 않으면, 요청을 모양·멤버십 검사 전에 적으면(거절된 요청이 적힌다), `sweep_once`·`start`가 RLS-bound 풀 확인을 빼면, 꺼진 틱에 보관소를 건네면(단위 시험과, 실제 루프를 짧은 주기로 돌리는 시험 둘 다), 커서가 마지막으로 본 워크스페이스 다음으로 가지 않으면(큰 백로그가 예산을 독점하거나 둘째 창에 닿지 못한다), 틱이 예산을 쓰지 않으면, 이미 없는 객체를 실패로 분류하면, `local`이 아닌 백엔드도 도는 것으로 판정하면 |
| D4 · 기본 꺼짐 결선 | api `config` 단위 시험 · notifier `config` 단위 시험 · `from_config_with` 단위 시험 | `MOMO_ATTACHMENT_RECLAIM`이 `delete_enabled`에 닿는 줄(api `from_lookup`, notifier `attachment_reclaim_from`)을 고정값으로 바꾸거나 다른 변수를 읽게 하면 |
| D4 · 마지막 방어선 | `a_hold_that_appears_after_the_listing_is_seen_by_the_recheck_under_the_lock` · `an_unknown_reference_stops_the_delete_before_any_byte_goes` | 재판정을 핵심 항만으로 바꾸면(목록 뒤에 생긴 huddle·아바타 점유를 놓친다), 보관소 호출을 행 삭제 앞으로 옮기면(아직 술어에 없는 FK가 행을 거절해도 바이트가 이미 사라진다) |
| D4 | `prod_role_conformance_pg::every_notifier_job_iteration_runs_as_its_production_role` | notifier 컬럼 GRANT를 지우거나(부트스트랩과 마이그레이션 둘 다) `name`으로 넓히면, 점유 표를 notifier에 열면, 후보 읽기가 GRANT 밖 컬럼(`drive_file_id`)을 부르면(`attachment_reclaim::tests` 단위 시험도 빨강) |
| D4 | `prod_role_conformance_pg::an_upgrade_survives_the_pre_migrate_roles_pass_and_ends_with_the_attachment_grant` | 부트스트랩 GRANT의 컬럼 존재 확인을 지우면(첫 패스가 없는 컬럼을 GRANT) 빨강, 백필이 `false`를 쓰면 실제 점유 행의 플래그 단정이, 점유 행을 놓치면 마이그레이션 자신의 행 수 단정이 빨강 |
| D4 | `scripts/tests/test_notifier_role_grants.sh` | 같은 GRANT의 정적 판정: 표 단위 SELECT·빠진 컬럼·`drive_file_id` 추가가 모두 빨강 |

사보타주를 실제로 돌린 결과(어떤 되돌림이 어떤 시험을 빨갛게 했는지)는 PR 본문이 정본이다.
