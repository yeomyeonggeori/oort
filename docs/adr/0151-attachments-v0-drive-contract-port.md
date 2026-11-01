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

## 증보 3 (2026-10-31, #4934): 워커의 첨부 읽기 - api의 사설 주소로, 단일 사용 주소 하나

Railway는 api와 agent-worker를 다른 서비스로 띄우고, `local` 저장소는 api 볼륨에만 붙는다(볼륨은 서비스 하나에만 붙는다). 그래서 팀 서버의 워커는 요청자가 대화로 보낸 사진을 읽지 못했고(`UnavailableDriveArchive`, 오류 줄 없음) 「사진으로 프로필 사진 바꾸기」(#4791·#4808)가 열리지 않았다. 이 증보는 워커가 그 사진을 **api의 사설 주소로** 읽게 한다. 새 길을 만들지 않는다. [ADR-0218 증보 G4·G8(C2a)](0218-workspace-expressions.md)이 이미 열고 보안 검수를 마친 「1회용·짧은 만료·소유 재판정」 주소 `GET /v1/self-media/{ws}/{token}`을 워커가 **자기 요청에** 쓴다.

- Status: **Accepted** (2026-11-01 planner — 독립 보안 검수 1회차 Blocker 0·High 0. Medium·Low는 후속 이슈로 남긴다. 2026-10-31 #4934 worker 기안). 새 내부 호출이라 등급 2다(ADR-0100: 보안 경계 변경은 Accepted ADR 참조가 머지 조건). 이슈가 요구한 방식 비교는 아래 표다.
- **변경 전**: 워커의 사진 제안(`profile_avatar::prepare`)은 소유 조회 뒤 `MOMO_DRIVE_*`로 연 **자기 보관소**에서 바이트를 읽었다. api와 같은 볼륨이나 같은 SA 키가 워커에도 있어야 했다(셀프호스트 compose는 `local.override.yml`의 읽기 전용 마운트, Google 백엔드는 키 복제). Railway는 둘 다 안 돼서 읽기가 조용히 닫혔다.

### 결정

- **D1 · 방식 (a).** 워커가 DB에서 토큰을 만들고(`mint_for_attachment_in_tx`, 같은 `self_media_token`, 해시만 저장) **자기가** `{OORT_API_INTERNAL_ORIGIN}/v1/self-media/{워크스페이스}/{토큰}`을 한 번 부른다. api는 이미 있는 라우트로 소유를 다시 재판정하고 바이트를 내준다. **migration은 없다**(160의 표가 이미 런·에이전트·요청자·대화·첨부에 묶는다).
- **D2 · 소유 재판정은 세 번이고 같은 술어다.** ① `prepare`의 조회(`find_requester_attachment_in_tx`, 지금 그대로), ② 발급(같은 함수를 행을 쓰기 **전에** 다시 묻는다. 그 대화에 요청자와 에이전트가 아직 있어야 하는 조건이 더해진다), ③ 풀기(`redeem_in_tx`, 변경 없음: 런 진행 중·두 사람의 멤버십·같은 함수). 남의 첨부, 지운 메시지, 다른 대화, 다른 워크스페이스, 미완료, 이미지가 아닌 것, 크기 초과, 없는 id, 만료, 재사용은 모두 같은 거절이다. 발급에서 거절되면 api에는 요청조차 가지 않는다.
- **D3 · 이 증보가 넓히는 것은 하나뿐이다: 발급이 첨부 id를 받는다.** C2a의 주소(`mint_for_run_in_tx`)는 id를 받지 않는다(서버가 트리거 메시지의 첫 이미지를 고른다). 워커의 읽기 주소는 제안 인자의 `attachmentId`를 받는다. 노출이 넓어지지 않는다: 같은 id가 지금도 직접 읽기 길에서 같은 술어를 통과해야 바이트가 된다. 그리고 이 주소는 **모델이 읽는 어떤 글에도 실리지 않는다**. 워커가 한 요청에 쓰고 버리며, 페이로드·메시지·감사·오류·로그 어디에도 쓰지 않는다. 그래서 모델이 말로 이 라우트에 닿을 방법은 늘지 않는다.
- **D4 · 수명은 60초**(C2a의 5분과 따로: `SELF_MEDIA_INTERNAL_TTL_SECS`). 발급 직후 쓰므로 읽기 마감(10초)에 여유만 둔다. 표의 10분 천장 안이다.
- **D5 · 설정과 선택.** `OORT_API_INTERNAL_ORIGIN`(워커 전용)이 있으면 **api 길 하나**, 없거나 모양이 틀리면 **자기 보관소 길(`MOMO_DRIVE_*`) 하나**로 읽는다. 폴백은 없다: api 길이 실패했을 때 몰래 보관소를 읽으면 끊어진 사설망이 가려진다. 값의 모양은 `http(s)://<소문자 호스트>[:포트]`뿐이다(경로·슬래시·사용자 정보·질의·대문자·비ASCII·IPv6 괄호 거절. `canonical_origin`의 공개 출처 문법과 다른 값이다). 이 값은 요청도 모델도 정하지 않는 배포 설정이다. 그래서 사람이 GUI에 적는 공급자 URL용 egress 가드(`momo-egress`)를 거치지 않는다(사설 주소가 정상이다). 대신 클라이언트가 **리디렉션을 따르지 않고 프록시를 무시한다**. 잘못 적은 값은 기동 때 변수 이름만 경고한다(값은 찍지 않는다).
- **D6 · 읽는 법.** 선언된 크기와 정확히 같은 바이트만, 응답의 `Content-Type`이 png·jpeg·webp이고 바이트가 그 형식으로 시작할 때만 받는다. 200만 사진이고, 404는 api의 하나뿐인 거절(`attachment_not_available`), 그 밖의 상태·전송 오류·모양 불일치는 `drive_unavailable`이다. **전송 오류 문장은 돌려주지 않는다**(감사의 `reason`은 고정 코드다). 조용히 닫히던 것이 이 이슈의 불만이어서 원인 한 줄은 로그에 남기되, 그 원인은 **고정 낱말뿐이다**(#4974가 정정: `timeout`·`connect`·`body`·`request`. reqwest의 오류 문장은 요청 URL, 곧 api의 사설 출처·워크스페이스·토큰을 담으므로 아예 쓰지 않는다. 첫 판은 그 문장을 `redact_self_media_urls`로 가려 남겼는데, 가려도 출처와 워크스페이스가 남았다. 아래 후속 F3).
- **D7 · 기본 배선.** Railway 템플릿의 agent-worker에 `OORT_API_INTERNAL_ORIGIN=http://api.railway.internal:8080`(api의 `privateHostname`+`port`), 셀프호스트 compose에 `${OORT_API_INTERNAL_ORIGIN-http://api:8080}`(빈 값으로 끄고 `MOMO_DRIVE_*` 길로 돌아갈 수 있다), host-network 오버레이는 `127.0.0.1:${MOMO_RUST_API_PORT:-8080}`. 카탈로그 검사가 값을 api의 선언에서 도출해 못 박고(공개 엣지나 다른 포트는 빨강) agent-worker 말고 다른 서비스가 가지면 빨강이다. 운영 값은 배포 때 planner가 넣는다.

### 비교한 방식

| 방식 | 판단 |
|---|---|
| (a) 워커가 api의 자기 주소 길을 쓴다 (**채택**) | 이미 검수한 길(1회용·해시만·짧은 수명·소유 재판정). 새 비밀도 새 라우트도 없고 저장소 종류(local·Google)와 무관하다. 대가: 워커가 처음으로 api를 부른다 |
| (b) 팀 서버 저장소를 Google Drive 백엔드로 | SA 키와 공유 드라이브가 필요해 owner의 손이 들어가고, 기존 첨부 이전이 따라온다(이슈의 범위 밖). 워커에도 SA 키가 들어가 공유 드라이브 전체를 읽는 권한이 생긴다. 이 길이 필요한 배포는 `OORT_API_INTERNAL_ORIGIN`을 비우면 지금처럼 직접 읽는다 |
| (c) 내부 전용 경로 + 서비스 간 비밀 | 새 라우트, 새 비밀(회전·유출 범위), 소유 판정의 두 번째 구현, 1회용이 아니다. (a)에 없는 이점이 없다 |
| (d) 한 볼륨을 두 서비스에 | Railway 볼륨은 서비스 하나에만 붙는다 |

### 바뀌지 않는 것

`GET /v1/self-media/{ws}/{token}`(라우트·헤더·거절·예산), C2a의 호스팅 주소(`mint_for_run_in_tx`, 5분)와 Hermes 가드, `find_requester_attachment_in_tx`, `self_media_token` 표와 권한, `drive_file_id`가 워커 메모리에만 있는 것(조회 tx가 읽는다, 지금과 같다), 사진을 디코드·재인코드하는 `process_avatar_image`와 승인 카드, 자기 보관소로 읽는 길(설정이 없을 때).

### 남는 위험

1. 워커(`momo_worker`, BYPASSRLS)가 **api를 통해** 첨부 바이트를 읽을 수 있게 된다. Railway에서는 처음 생기는 능력이다. 손상된 워커가 `self_media_token` 행을 직접 써도 풀 때의 재판정(진행 중인 런의 요청자가 쓴 완료 이미지, 그 대화)이 막으므로 범위는 migration 160 L6이 이미 수용한 것과 같다(「진행 중인 런이 있어야 하지만 첨부는 고를 수 있다」). 워커는 이미 모든 테넌트의 메시지와 기억을 읽는 역할이다.
2. 사설망에서 토큰이 평문 http로 간다. Railway 사설망(프로젝트·환경 단위로 격리)을 믿는 선택이다. 템플릿 규칙이 공개 엣지로 나가는 값을 막는다.
3. api의 거절 예산은 호출 주소와 경로의 워크스페이스 단위(기본 30/창)다. 워커의 거절이 그것을 다 쓰면 그 창 동안 그 워크스페이스의 사진 제안이 닫힌다(429, `drive_unavailable`). 소유 거절은 발급에서 끝나 api에 가지 않으므로, 워커 자신이 예산을 쓰는 것은 발급 직후의 경쟁(메시지 삭제)과 api 쪽 저장소 오류뿐이다. 다만 api는 `X-Forwarded-For`의 첫 값을 있는 그대로 믿는다(`rate_limit::client_ip`, 문서화된 v0 한계). 워커의 사설 주소를 알아맞힌 외부 호출자는 그 헤더를 위조한 가짜 주소 요청(모양만 맞으면 404)으로 워커 주소의 예산, 곧 주소 전체 상한(한도의 10배)까지 써서 모든 워크스페이스의 사진 제안을 그 창 동안 닫을 수 있다. 가용성만이고 제안은 일반 답으로 떨어진다. C2a가 Hermes의 주소에 대해 이미 적은 한계와 같은 부류이고, 근본 해결(신뢰하는 프록시 목록)은 이 증보의 범위 밖이다.
4. 소비 뒤 api의 저장소 오류는 토큰을 태운다(C2a의 약속). 이 읽기는 한 번만 시도하고 제안은 일반 답으로 떨어진다.
5. 로그: reqwest·hyper의 `log` 기록까지 TRACE로 잡아 토큰이 없음을 쟀지만 현재 의존성 버전에서의 관찰이다. 의존성을 올리면 같은 시험이 다시 잰다.
6. 사설 호스트 해석: 레거시 Railway 환경은 IPv6 전용 사설망이다. 다른 모든 사설 연결(`HERMES_BASE_URL`·`CENT_API_URL`)과 같은 조건이다.
7. 워커와 api의 두 번째 결합이다(첫 번째는 같은 DB). api가 내려가 있으면 사진 제안이 `drive_unavailable`로 닫히고 일반 답으로 떨어진다. 워커의 다른 일은 영향이 없다.

### runtime-unverified

실제 Railway 사설망 위의 호출(`api.railway.internal` 해석·연결), 실제 볼륨과 실제 Google Drive, 실제 배포. 시험은 127.0.0.1 TCP, 실 PG18(두 테넌트, `momo_app`·`momo_worker`), 진짜 라우터로 했다. 또 실제 워커 한 턴과 진짜 라우터를 한 시험에서 잇는 시험은 없다(루프 시험은 `running`으로 심은 런에 읽기를 직접 부르고, 팀 AI 한 턴 시험은 풀지 않는 대역을 쓴다). 읽기 시점에 런이 진행 중이라는 사실(`redeem_in_tx`의 `queued`·`running` 조건)은 시작 전이가 `run_team_ai_turn`보다 먼저라는 코드 읽기로만 확인했고, 스택 검증의 첫 장면이 그 접점이다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 | `attachment_via_api_conformance_pg::a_requesters_picture_goes_worker_to_api_to_worker_and_becomes_the_proposal_image`, `team_ai_conformance_pg::a_picture_request_is_read_through_the_apis_private_address_and_the_model_never_sees_the_token` | `team_ai.rs`가 `attachment_reader()` 대신 `self.drive`를 읽으면(요청이 api에 가지 않고 그림이 쌓이지 않는다) |
| D2 발급 | `self_media_pg::the_workers_read_address_is_refused_for_everything_that_is_not_the_requesters_image_here`, `attachment_via_api_conformance_pg::a_refused_attachment_never_reaches_the_api_and_every_refusal_is_the_same` | `mint_for_attachment_with_ttl_in_tx`에서 `find_requester_attachment_in_tx`를 지우면(남의 첨부가 토큰을 받고 요청이 api에 간다) |
| D2 풀기 | `self_media_pg::the_workers_read_address_stops_working_when_it_expires_is_spent_or_stops_holding` | `redeem_in_tx`에서 소유 재판정을 지우면(지운 메시지·남의 파일 행) |
| D2 1회용·만료 | 같은 시험, `attachment_via_api_conformance_pg::the_address_the_worker_mints_is_single_use_and_short_lived_on_the_wire` | `used_at IS NULL`을 지우면(재사용), `expires_at > clock_timestamp()`를 지우면(만료) |
| D4 | `self_media_pg::the_workers_read_address_names_any_image_the_requester_wrote_in_the_conversation` | `SELF_MEDIA_INTERNAL_TTL_SECS`를 바꾸면(수명을 잰다) |
| D5 | `attachment_via_api_conformance_pg::a_worker_whose_api_is_unreachable_fails_closed_and_does_not_fall_back_to_the_archive`, `…::a_worker_with_no_private_address_keeps_reading_its_own_archive`, `self_media::tests::the_internal_origin_is_a_bare_http_origin_and_nothing_else` | 폴백을 넣으면, 설정을 무시하면, 문법의 한 항을 느슨하게 하면 |
| D6 리디렉션 | `self_media::tests::a_redirect_is_an_answer_not_a_place_to_go` | 클라이언트의 `redirect(Policy::none())`를 지우면 |
| D6 길이 | `self_media::tests::a_body_that_never_ends_is_cut_at_the_declared_length` | 청크 길이 검사를 지우면 |
| D6 로그 | `attachment_via_api_conformance_pg::a_failed_fetch_logs_a_cause_and_never_the_token`, `self_media::tests::a_transport_failure_holds_a_kind_and_nothing_the_transport_said`, `self_media::tests::no_log_line_names_the_address_the_token_or_the_drive_id` | 실패 줄에 reqwest의 문장·출처·워크스페이스·토큰을 쓰면, tracing 호출에 주소·토큰을 쓰면(#4974: 가림에서 고정 낱말로 바뀜) |
| D7 | `scripts/tests/check_railway_catalog.py --prove-mutations`의 5건(`worker-api-internal-dropped`·`-wrong-port`·`-public-edge`, `relay-api-internal-origin`, `readme-row-missing-api-internal`) | 값을 api 선언에서 도출하는 규칙, 다른 서비스 금지, README 행 |

사보타주를 실제로 돌린 결과는 PR 본문이 정본이다.

### 후속 (2026-11-01, #4974): 독립 보안 검수 1회차 Medium 1·Low 4의 처리

결정(D1~D7)은 바뀌지 않는다. 검수가 남긴 것은 시험이 재지 못하던 줄과 운영 위생이고, 아래 다섯으로 닫는다. D6의 「원인은 `redact_self_media_urls`를 지난다」는 F3이 대신한다.

- **F1 · 워커가 실제로 쓰는 읽기 클라이언트의 배선을 잰다(Medium).** 워커의 클라이언트를 `attachment_client()` 대신 기본 클라이언트(리디렉션 10회·프록시 환경변수·시간 한도 없음)로 바꿔도 모든 시험이 초록이었다. 단위 시험은 생성 함수만 재고, 워커가 쓰는 필드는 아무 시험도 건드리지 않았다. 이제 루프 시험이 `attachment_reader()`로 읽는다. 302를 주는 스텁이 진짜 사진을 내주는 둘째 서버를 가리키게 하고, 그 둘째 서버에 요청이 0건임을 잰다. 프록시 무시(`.no_proxy()`)는 이 시험이 재지 않는다. 시험에서 프로세스 환경을 바꾸지 않는 규칙 때문이고, `HTTP(S)_PROXY`를 준 자식 프로세스로 재는 CI 한 줄은 정책 파일이라 별도 결정이다.
- **F2 · 읽기 주소의 수명 60초를 워커가 쓴 행에서 잰다(Low).** D4의 60초는 상수와 도메인 함수만 재고, 워커의 실제 호출이 다른 수명을 줘도 초록이었다. 첫 루프 시험이 이미 읽는 토큰 행에서 `expires_at - created_at`이 60초(이 문서의 숫자이지 상수가 아니다)임을 단정한다.
- **F3 · 실패 로그에는 오류의 종류만 남는다(Low, D6 정정).** 가린 줄에도 api의 사설 출처와 워크스페이스 id가 남았고(`error sending request for url (http://…/v1/self-media/<워크스페이스>/<redacted>)`), reqwest 0.12의 문장은 원인(연결 거절인지 시간 초과인지)을 말하지도 않았다. 이제 전송 실패는 고정 낱말 하나(`timeout`·`connect`·`body`·`request`)만 남기고, reqwest의 문장은 어디에도 쓰지 않는다(가리지도 않는다. 남기지 않으니 샐 것이 없다). 시험은 실제 실패가 쓴 로그 줄을 붙잡아 그 줄에 종류가 있고 출처·워크스페이스·토큰이 없음을 잰다. 한 가지는 그대로다. DEBUG 이하로 켠 reqwest·hyper의 자체 기록(`starting new connection: http://…/`, `connecting to …`)은 접속하는 상대의 출처를 적는다. 경로와 토큰은 적지 않고(전체 캡처에서 토큰이 없음을 잰다, 남는 위험 5), 이 줄들은 라이브러리의 것이며 운영 기본(`info`)에는 나오지 않는다.
- **F4 · 사설망 주소 모양이 아닌 값은 기동 때 한 줄 경고한다(Low, D5 보강).** 문법은 출처의 모양만 판정하고(`http://example.com`도 통과) 어디를 가리키는지는 판정하지 않는다. 이 값은 요청도 모델도 정하지 않는 운영 설정이지만, 1회용 토큰이 그 호스트로 간다. 값이 문법을 통과했는데 사설망 주소처럼 보이지 않으면 기동 로그에 변수 이름만 든 경고 한 줄을 남긴다(값은 찍지 않는다). 사설 모양은 루프백·사설 IPv4(`10/8`·`172.16/12`·`192.168/16`, 공유 주소 `100.64/10`), 한 낱말 이름(compose의 `api`), `.internal`(Railway의 `api.railway.internal`)·`.local`·`.localhost`·`.home.arpa` 접미사다. 공개 이름·공개 IP·링크 로컬 `169.254/16`(클라우드 메타데이터 주소)·해석기가 주소로 읽을 수 있는 숫자 모양(`2130706433`·`0x7f.1`)은 아니다. 스킴은 보지 않는다(`https://`로 공개 호스트를 가리켜도 공개 호스트다). 막지는 않는다. 모양 검사일 뿐이고 이름은 어디로든 풀릴 수 있다.
- **F5 · 셀프호스트 워커의 읽기 전용 마운트는 남기고 이유를 적는다(Low).** 기본(`OORT_API_INTERNAL_ORIGIN` 미설정 = `http://api:8080`)은 이 마운트를 읽지 않는다. 그러나 같은 스위치의 다른 가지가 읽는다. 값을 비우면(또는 출처가 아닌 값이면) 워커는 `MOMO_DRIVE_LOCAL_DIR`의 자기 보관소를 읽고, 마운트가 없으면 조용히 닫힌다(`open_reader` 실패 → `UnavailableDriveArchive`, 로그 없음). #4934가 없앤 침묵이다. 그래서 지우지 않고, 이유와 지워도 되는 조건(그 값을 끄지 않을 스택)을 `local.override.yml` 주석에 적었다. 대가는 워커가 모든 워크스페이스의 첨부를 읽기 전용으로 쥔다는 것이다. 기본 오버레이에서 빼고 끄는 스택 전용 오버레이로 옮기는 길은 canonical compose 파일 집합(생성기·셀프호스트 시험)을 건드려 이 후속에서 하지 않는다. 필요하면 별도 결정이다.

| 후속 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| F1 | `attachment_via_api_conformance_pg::the_client_the_worker_reads_with_follows_no_redirect` | `lib.rs`가 `attachment_client()` 대신 `reqwest::Client::new()`를 쓰면(둘째 서버에 요청이 간다. 이 사보타주에서 단위 시험 `a_redirect_is_an_answer_not_a_place_to_go`는 초록이어서 이 시험이 메운다) |
| F2 | `attachment_via_api_conformance_pg::a_requesters_picture_goes_worker_to_api_to_worker_and_becomes_the_proposal_image` | `SELF_MEDIA_INTERNAL_TTL_SECS`를 바꾸면, 워커의 발급 호출이 다른 수명을 주면 |
| F3 | `attachment_via_api_conformance_pg::a_failed_fetch_logs_a_cause_and_never_the_token`, `self_media::tests::a_transport_failure_holds_a_kind_and_nothing_the_transport_said` | 실패 줄에 출처·워크스페이스를 쓰면, `transport()`가 reqwest의 문장을 남기면, 종류 분기(`timeout`·`connect`·`body`)를 지우면 |
| F4 | `self_media::tests::an_origin_is_private_shaped_only_when_it_names_a_place_on_a_private_network`, `self_media::tests::the_boot_line_for_an_origin_that_is_not_private_names_the_variable_and_never_the_value`, `boot_origin_warning::the_booting_worker_warns_once_by_name_for_an_origin_that_is_not_private_and_never_prints_it` | 판정의 한 항(접미사·사설 범위·숫자 모양)을 지우면, 경고에 값을 쓰면, 경고를 내지 않으면, `main.rs`가 호출하지 않으면 |

F5는 설정 주석이라 시험이 없다. `docker compose config`가 기본 구성·기본+host-network 구성 모두 통과하고, 렌더된 워커의 마운트(`drive-archive` → `/var/lib/oort/drive`, 읽기 전용)가 그대로임을 확인했다. 사보타주를 실제로 돌린 결과는 PR 본문이 정본이다.

## 증보 4 (2026-11-01, #4970): 워커의 첨부 읽기를 글·PDF·그림까지 — 읽기용 발급, 같은 길, 같은 상한

[ADR-0201 증보 v3 B6-1](0201-team-ai-fast-path-for-simple-workspace-requests.md)(Accepted)이 도우미의 읽기 도구 `read_attachment`를 정했고, 바이트는 증보 3의 길(api 사설 주소, 1회용 주소)을 그대로 쓰라고 했다. 그런데 증보 3의 길은 **발급·풀기·라우트·워커 읽기 네 곳 모두가 세 그림(png·jpeg·webp)만** 통과시킨다(D2·D6). 그대로는 글 파일과 PDF가 발급에서 거절되므로, 이 증보가 그 네 곳을 같은 모양으로 넓힌다. 새 길·새 라우트·새 비밀·migration은 없다.

- Status: **Accepted** (2026-11-02, planner — 독립 보안 검수 1회차 High 1·Medium 1·Low 5 → 수리, 2회차 Blocker 0·High 0·Medium 1·Low 4 → R2-1·R2-5 코드 수리·R2-2~R2-4 문서 반영, planner Linux 실측 PASS: 스레드 64개 설정에서도 자식이 PDF를 읽고(`{"ok":true}`·종료 0) N=2·16·64의 `VmSize` 102,968 kB·스레드 2로 같음, `--memory=1g` 자식 시험 15/15, `--memory=300m`에서 커널이 자식을 먼저 끝냄(`oom_kill` 1)). 등급 2: 공개 라우트가 내주는 종류가 늘어난다(ADR-0100).
- **변경 전**: `mint_for_attachment_in_tx`와 `redeem_in_tx`가 `find_requester_attachment_in_tx`(아바타 용도: png·jpeg·webp)로 판정했고, 라우트와 워커의 `fetch`가 `bytes_match_mime`(세 그림)으로 끝에서 한 번 더 걸렀다.

### 결정

- **D1 · 용도 하나가 늘고, 판정 문장은 그대로 하나다.** `RequesterAttachmentUse::Read` = 세 그림 + `text/plain`·`text/markdown`·`text/csv`·`application/json` + `application/pdf`(닫힌 목록 여덟). 소유 판정의 SQL은 용도만 바꿔 같은 한 문장을 쓴다(작성자 본인·이 대화·완료·살아 있는 메시지·보관 안 된 채널·크기). 도구의 **첫 겹(조회)**만 `ReadAnyType`을 쓴다: 종류를 가리지 않고 「누구 것인가」만 묻는다(빈 목록 = 어떤 종류든. 다른 용도가 빈 목록이면 시험이 빨개진다). 그래서 요청자 본인의 파일이 읽지 않는 종류면 「그 종류는 못 읽어요」, 너무 크면 「너무 커요」라고 정직하게 말하고(본인 것이라 새는 것이 없다), **남의 파일은 크기·종류와 무관하게 같은 `not_found`**다. 발급·풀기에는 `ReadAnyType`을 쓰지 않는다.
- **D2 · 발급.** `mint_for_read_in_tx`(60초·1회용·해시만, D4 그대로)는 `Read`로 행을 쓰기 **전에** 판정한다. 기존 `mint_for_attachment_in_tx`(아바타)는 세 그림만 그대로다. 아바타 용도로 PDF·글의 id를 내밀어도 주소를 받지 못한다(시험으로 못 박음).
- **D3 · 풀기.** `redeem_in_tx`는 `Read`로 다시 판정한다. 그림은 지금까지와 같은 질문이고, 글·PDF를 가리키는 토큰은 읽기용 발급만 만든다. 위조한 행이 있어도 풀 때의 같은 술어(진행 중인 런, 두 사람의 멤버십, 요청자가 쓴 완료 파일)가 막는다 — 증보 3 「남는 위험 1」과 같은 범위다.
- **D4 · sniff.** `bytes_match_mime`이 세 그림에 더해 `application/pdf`는 `%PDF-`로 시작할 때, 글 종류는 **비어 있지 않고 NUL 바이트가 없을 때**만 맞다고 한다(글에는 매직이 없다. UTF-8인지 한글 옛 인코딩인지는 읽는 쪽의 몫이다). 목록 밖의 종류는 어떤 바이트여도 내주지 않는다. 라우트의 응답 헤더(`Content-Disposition: attachment`, `nosniff`, `no-store`, 리디렉션 없음)는 그대로다.
- **D5 · 상한은 하나, 5 MiB.** ADR-0201 B6-1의 「10MB」는 **[추정]**이었고, 라우트의 상한은 `SELF_MEDIA_MAX_BYTES`로 아바타 입력 상한과 한 숫자임을 시험이 못 박고 있다. 숫자를 둘로 쪼개면 조회가 받은 파일을 라우트가 거절하는 틈이 생기므로 하나로 둔다. 더 큰 파일은 요청자 본인에게 「너무 커요」다.
- **D6 · 워커의 읽기.** `RequesterAttachment`가 용도를 싣고(`usage`), `ApiAttachmentBytes`가 그 용도로 발급을 고르며, `fetch_as`가 응답의 `Content-Type`이 **그 용도의 종류이고** 바이트가 그 종류일 때만 받는다(아바타는 여전히 세 그림). 어느 읽기 길(api 또는 보관소)이든 워커가 길이와 sniff를 한 번 더 본다. **읽기 용도의 이유 코드가 하나 더 있다**(독립 보안 검수 1회차 수리, 2회차 정정): 발급이 성공한 **뒤** api의 라우트가 내는 404는 `attachment_not_readable`이고, 요청자에게는 「읽을 수 없는 형식이에요」라고 말한다. 발급 자체의 거절(지워진 파일 등)은 그대로 `attachment_not_available`(→ 없는 파일과 같은 `not_found`)이고, 아바타 용도의 코드는 바뀌지 않는다. **이 404가 한 코드로 읽는 원인은 넷이다**(증보 3의 「거절은 한 모양」이라 워커는 가르지 못한다): ① 요청자 본인의 파일이 종류와 달리 읽을 수 없는 모양이다(라우트가 바이트를 sniff한다. 영구 원인이고 이 문구가 맞는 경우다). ② 발급과 읽기 사이 1초 안쪽에 파일이 지워졌다. ③ 라우트 뒤의 보관소(Drive) 읽기가 실패했다. ④ 행이 말한 길이와 보관소의 바이트 길이가 다르다. ②~④는 파일의 영구한 성질이 아니고 다시 해 보면 읽힐 수 있는데도 「다시 만들어 올려 주세요」가 나간다. 본인 파일이라 새는 것은 없고 문구만 틀리다(남는 위험 7). 같은 보관소 실패가 길에 따라 다르게 말해지기도 한다: 워커가 보관소를 직접 읽는 길은 `drive_unavailable`(→ 「잠시 뒤에」)이고, api 길은 라우트가 404로 덮어서 위 문구가 된다.
- **D7 · 글자 뽑기는 이 증보의 길 밖이지만 같은 PR이 한다.** 글 파일은 UTF-8(BOM 제거) 아니면 EUC-KR(오류 0일 때만), PDF는 lopdf(MIT)로 뽑되 **워커 프로세스 안에서 파싱하지 않는다.** 워커 바이너리를 `--attachment-text-child`로 **빈 환경**에서 다시 띄우고(DB 주소·마스터 키·공급자 키를 상속하지 않는다), 표준입력으로 바이트를 주고 표준출력의 JSON 한 줄(≤512KiB)을 읽는다. 마감(8초) 뒤에는 죽이고 거두며, 동시에 둘까지다(`momo-expressions`의 그림 해독 자식과 같은 모양). **메모리는 셋으로 가둔다**(독립 보안 검수 1회차 수리): ① 자식이 파일을 읽기 전에, 그리고 **어떤 스레드 풀도 뜨기 전에**(2회차 수리: 바이너리의 `main`이 동기 함수라 `--attachment-text-child` 갈래가 비동기 런타임을 만들기 앞에 있다) 스스로 주소 공간 상한을 건다(Linux `RLIMIT_AS` 4GiB, `momo-expressions`가 이미 쓰는 안전한 `rlimit` 래퍼라 `unsafe`도 새 crate도 없다). 같은 자리에서 `oom_score_adj`를 1000으로 올리고(권한이 필요 없다. best effort다: 남는 위험 2), 코어 덤프 한도를 0으로 낮춘다(`RLIMIT_CORE`, 소프트·하드 모두, 유닉스 전체). 순서가 설계의 일부인 까닭: 상한은 가상 주소 공간이라 스레드 스택과 할당자 영역(glibc는 스레드마다 가상 영역을 따로 잡는다)도 셈에 들어간다. 런타임이 먼저 떠 있으면 보이는 코어 수만큼의 일꾼이 이미 상한 안에 들어가 있어서, 코어가 많은 호스트에서는 파일을 한 바이트 읽기 전에 상한이 차거나 거의 찬다. 그래서 자식은 스레드 하나(와 자기 워치독)일 때 구속하고, 진짜 바이너리로 그 스레드 수를 재는 시험이 있다. ② 감독자가 50ms마다 자식의 상주 메모리(RSS, Linux `/proc/<pid>/status`, 그 밖은 `ps`)를 읽다가 512MiB를 넘으면 그 PID를 kill하고 회수한 뒤에 슬롯을 돌려준다. ③ 감독자가 사라져도 자식은 자기 마감(10초)에 스스로 끝낸다. 상한·주기는 `attachment_text`의 상수다. 문서 글자는 줄바꿈을 지키고, 제어 문자·보이지 않는 서식 문자(너비 0, 방향, BOM, 유니코드 태그 블록)를 지우고, 코드 울타리를 무력화한 뒤 **20,000자**에서 자른다.
- **D8 · 그림은 다시 인코딩해서 모델에 간다.** 바이트가 정하는 종류(png·jpeg·정지 webp), 헤더 크기를 먼저 보고(4096×4096·1,600만 화소 상한) 디코더 한도 아래에서 해독, EXIF 방향을 반영해 긴 변 1568px로 맞춘 뒤 JPEG(투명하면 PNG)로 새로 인코딩한다. 위치·기기 같은 메타데이터는 남지 않는다. 모델 호출에는 **구조 부품**(Anthropic `image` 블록, Responses `input_image`)으로 실리고, 한 요청에 하나다. chat/completions 와이어는 같은 와이어가 텍스트 전용 게이트웨이와도 이야기하므로 닫아 두고 「이 연결로는 이미지를 못 봐요」라고 말한다.

### 바뀌지 않는 것

라우트의 경로·헤더·거절 한 모양·예산, `self_media_token` 표와 권한, C2a의 호스팅 주소(`mint_for_run_in_tx`, 5분)와 Hermes 가드, 아바타 흐름(세 그림만, `prepare_with`), `OORT_API_INTERNAL_ORIGIN`과 폴백 없음(D5), 토큰이 모델이 읽는 글에 실리지 않는 것(D3). 첨부 내용·추출한 글자·이미지는 감사·로그·행 어디에도 남지 않는다 — 감사에는 도구 이름과 닫힌 결과 코드만 있다(ADR-0201 B13-I6).

### 남는 위험

1. **라우트가 내주는 종류가 늘었다**(글·PDF). 토큰 하나는 첨부 하나·요청자 하나·대화 하나·런 하나에 묶이고, 1회용·60초이며, 풀 때 같은 소유 술어가 다시 걷는다. 그래도 손상된 워커가 위조한 행으로 읽을 수 있는 파일의 범위가 요청자의 그림에서 요청자의 글·PDF까지 넓어졌다(증보 3의 위험 1과 같은 부류).
2. **PDF 파서는 공격자가 쓸 수 있는 형식을 읽는다.** lopdf는 스트림을 상한 없이 풀고(작은 파일이 큰 메모리를 쓰게 할 수 있다), 입력 5 MiB 상한은 그 메모리를 막지 못한다. 자식 프로세스 + 빈 환경 + 마감 뒤 kill·회수 + 동시 2 + 출력 상한에 **메모리 상한 셋**(D7)을 더해 가둔다. 처음 이 항목은 두 문장으로 상한이 없음을 받아들였고, 둘 다 사실이 아니어서 고친다. (가) 「자원 한도를 걸려면 `unsafe`가 필요하다」는 틀렸다 — 안전한 `rlimit` 래퍼로 자식이 자기 프로세스에 건다. (나) 「OOM killer가 받침이고 죽는 쪽은 가장 큰 자식이다」는 배포 한도에 따라 맞기도 틀리기도 했다 — 커널은 **상주 메모리가 가장 큰 프로세스**를 고르는데, 워커가 모델을 올리면 약 0.9GiB가 상주해서(`config.rs`의 측정 주석) 한도가 약 1.5~1.9GiB인 구간에서는 한도가 찼을 때 자식이 워커보다 작아 **워커가 먼저 죽을 수 있다**. 그래서 자식이 `oom_score_adj`를 1000으로 올려 한도가 차면 커널이 자식을 먼저 고르도록 돕는다. **이것은 best effort다**(2회차 수리): 쓰기가 막힌 환경(`/proc`을 쓸 수 없는 컨테이너)에서는 조용히 실패하고, 그 환경에서는 위 한도 약 1.5~1.9GiB 구간의 문제가 그대로 돌아온다. 일부러 구속 실패(종료 상태 2)로 닫지 않았다. 읽기 상한은 이 쓰기에 기대지 않고, 닫으면 그런 환경에서 모든 PDF가 「잠시 뒤에」가 된다. 남는 것: 감독자의 읽기는 표본이라(50ms) 그 사이에 늘린 만큼은 주소 공간 상한만 막고, macOS는 `RLIMIT_AS`가 적용되지 않아 감독자의 읽기만 작동한다(이미지는 Linux). **`env_clear`는 가둠이 아니다**(2회차 수리): 자식은 워커와 같은 사용자 번호·같은 파일 시스템·같은 네트워크·같은 `/proc`으로 돈다. 환경 변수를 넘기지 않을 뿐이라, 파서가 장악되면(lopdf는 `unsafe`를 금지하고 압축 풀기도 안전한 Rust라 가능성은 아주 낮다) 그 자식이 읽을 수 있는 것은 워커 프로세스가 읽을 수 있는 것과 같고, 워커 프로세스의 환경 변수도 거기에 든다. 그 틈을 닫으려면 자식에게 다른 사용자 번호·네임스페이스·시스템 호출 필터가 필요하고, 이는 **후속**이다(이월). **코어 덤프**(2회차 수리): 자식은 `RLIMIT_CORE`를 0으로 건다(소프트·하드, 유닉스 전체). 악성 파일이 자식을 죽이는 일은 흔하고(너무 깊은 중첩의 스택 소진, 할당 실패) 덤프에는 요청자 문서의 글자와 파서 상태가 남기 때문이다. 코어를 파일로 쓰는 호스트는 이것으로 막힌다. `core_pattern`이 호스트의 처리기로 가는 배포에서는 그 한도를 처리기가 따르는지에 달려 있어 코드가 보장하지 못한다. 더 강한 수단(프로세스를 덤프 불가로 표시하는 `PR_SET_DUMPABLE`)은 `unsafe`나 새 의존이 필요해 **후속**이다(이월). 슬롯 둘은 프로세스 공용이라 한 계정이 둘 중 하나를 오래 붙잡을 수 있다 — 워크스페이스·요청자당 슬롯 상한은 **후속**이다. 같은 시각의 요청자 수는 도우미의 일일·10분 상한이 막는다. 한글 PDF의 글자는 글꼴의 ToUnicode에 달려 있어 못 뽑으면 「글자를 뽑지 못했어요」라고 말한다(실측 안 함).
3. **파일 내용·그림이 팀 키 공급자로 간다.** 이것이 ADR-0201 B3의 고지 대상이다. 그림은 다시 인코딩해도 그림 속 글자는 간다.
4. **요청자 규칙은 「본인이 올린 파일, 이 대화」다**(B6-1 문장 그대로). 같은 방 동료가 올린 파일은 `not_found`다. 넓히려면 소유 술어에서 작성자 조건을 빼고 청중 규칙이 일하게 하면 되는 한 줄이며, owner가 정할 일이다.
5. **청중 규칙은 오늘 요청자 규칙 뒤에서 홀로 거절할 일이 없다**(회신 채널이 곧 파일의 채널이다). 파일 찾기(F2)가 생겨 다른 채널의 파일 id를 대는 길이 열리는 날을 위한 줄이고, 손으로 만든 범위로 거절함을 시험이 증명한다.
6. **이미지 입력은 Anthropic Messages·OpenAI Responses 와이어만** 연다. 실제 공급자 호출은 하지 않았다(`runtime-unverified`). 와이어별·모델별 능력표가 생기면 chat/completions도 열 수 있다.
7. **발급 뒤의 404는 네 원인을 한 코드로 읽는다**(D6): ① 본인 파일이 종류와 달리 읽을 수 없는 모양(영구), ② 발급·읽기 사이 1초 안쪽에 지워진 파일, ③ 라우트 뒤 보관소(Drive)의 읽기 실패, ④ 행이 말한 길이와 보관소 바이트 길이의 불일치. 요청자에게는 「읽을 수 없는 형식이에요… 다시 만들어 올려 주세요」로 말하므로 ②~④(보관소가 잠깐 아프거나 행과 보관소가 어긋난 본인 파일)에서는 문구가 틀리다. 본인 파일이라 새는 것은 없고, ②의 창은 아주 좁지만 ③은 보관소 장애가 계속되는 동안 이어질 수 있다. 워커가 직접 읽는 길(`drive_unavailable` → 「잠시 뒤에」)과 같은 보관소 실패가 다르게 말해지는 것도 이 때문이다. **이월(후속 이슈)**: 라우트가 **토큰을 푼 뒤**의 거절만 모양을 나눈다. 보관소 읽기 실패·길이 불일치를 404가 아닌 상태로 답하면, 워커는 이미 404 밖의 상태를 `drive_unavailable`로 읽으므로(증보 3 D6) 워커 쪽은 바꿀 것이 없다. 풀기에 성공한 호출자는 토큰을 이미 증명했으므로 이 신호가 존재·크기 판정을 새게 하지는 않는다. 다만 이것은 증보 3이 Accepted로 못 박은 라우트의 「거절 한 모양·예산」(404만 호출 주소의 거절 예산을 쓴다)을 바꾸고, 적합성 시험 `self_media_conformance_pg::every_refusal_is_one_identical_404_that_never_reads_drive`가 보관소 miss까지 같은 404임을 단정한다. 공개 라우트의 계약 변경이라 이 증보의 범위 밖이다.

### runtime-unverified

실제 공급자(Anthropic·OpenAI)에 그림을 실은 호출, 실제 Railway 사설망 위의 글·PDF 읽기, 한글 글꼴 PDF의 글자 뽑기, 컨테이너 메모리 한도(`docker run --memory`) 아래에서 워커가 사는지 — Linux에서 `/proc`·`RLIMIT_AS`·`oom_score_adj`·`RLIMIT_CORE`(`/proc/<pid>/limits`의 `Max core file size` 행)를 읽는 시험은 CI(Linux)가 처음 돌리고, macOS 개발 기계에서는 감독자의 읽기와 자식의 스레드 수(`ps -M`)와 코어 한도(자기 재실행 프로브)를 진짜 프로세스로 쟀다. **코어가 많은 호스트에서 자식이 실제로 읽히는지**(`TOKIO_WORKER_THREADS`를 크게 준 수동 실행의 종료 상태, `/proc/<pid>/status`의 `VmSize`·`Threads`)는 Linux 컨테이너에서 재지 않았다. 스레드가 둘뿐인 것은 이 Mac에서 쟀고, 그것이 상한 안에 들어온다는 것은 계산이다. 시험은 127.0.0.1 TCP, 실 PG18(두 테넌트, `momo_app`·`momo_worker`·`momo_helper_read`), 진짜 라우터, 진짜 자식 프로세스(워커 바이너리)로 했다.

### red proof

| 결정 | 시험 | 분기를 지우면 빨강 |
|---|---|---|
| D1 소유·한 문장 | `team_ai_files_conformance_pg::every_refusal_of_a_file_that_is_not_the_requesters_is_the_same_not_found_and_reads_no_byte`, `…::a_file_the_requester_owns_but_cannot_have_read_gets_an_honest_sentence`, `…::the_audience_rule_is_a_line_of_its_own`, `…::the_lookup_refuses_to_run_as_anything_but_the_helper_read_role`, `…::a_server_that_cannot_read_the_file_says_so_honestly` | 작성자·대화·살아 있는 메시지·완료 술어 중 하나를 지우면, 크기·종류 갈래를 지우면, 청중 규칙 줄을 지우면, `momo_helper_read` 확인을 지우면, api 실패를 다른 문구로 매기면 |
| D1 용도 | `agent_avatar::read_use_tests::only_the_lookup_use_has_no_type_narrowing` | 다른 용도의 목록을 비우면 |
| D2·D3·D4·D6 | `attachment_via_api_conformance_pg::a_text_file_a_pdf_and_a_picture_come_back_through_the_route_for_a_read`, `…::the_read_use_refuses_what_the_mint_the_route_and_the_worker_must_refuse`, `self_media::tests::the_avatar_read_takes_pictures_only_and_the_helpers_read_takes_its_own_types`, `team_ai_files_conformance_pg::the_archive_path_is_sniffed_too` | 읽기 발급을 아바타 판정으로 하면, 풀기를 아바타로 하면, `%PDF-`·NUL 규칙을 지우면, 워커 fetch가 종류를 안 보면, 워커의 길이·sniff 재확인(보관소 길)을 지우면, 아바타 발급을 넓히면 |
| D4 단위 | `self_media::tests::the_sniff_checks_pdf_and_text_too` | `bytes_match_mime`의 PDF·글 갈래를 지우면 |
| D7 | `team_ai_files_conformance_pg::a_pdf_is_read_by_the_supervised_child_and_a_scan_or_a_broken_one_says_so`, `…::a_pdf_is_never_parsed_in_the_workers_own_process`, `attachment_text_child::*`(진짜 자식 프로세스), `attachment_text::tests::*`, `team_ai_attachments::tests::*`, `team_ai_tools::tests::a_document_renders_to_twenty_thousand_characters_and_cannot_close_the_fence` | 자식을 못 띄울 때 워커 안에서 파싱하면, 자식의 빈 환경·마감 뒤 kill·회수·슬롯 둘 중 하나를 지우면, 문서 글자의 줄바꿈·제어·울타리·20,000자 중 하나를 지우면 |
| D7 메모리 | `attachment_text_child::a_stream_that_inflates_far_past_its_size_is_ended_by_the_memory_watch`(진짜 자식·진짜 스트림), `attachment_text::tests::the_resident_size_is_read_from_what_the_platform_prints`, `…::a_live_process_has_a_resident_size_and_a_gone_one_has_none`, `attachment_text_child::a_child_confines_itself_before_it_reads_a_byte`(Linux: `/proc`에서 `oom_score_adj`·주소 공간 상한을 읽는다), `…::a_child_ends_itself_at_its_own_deadline_when_nothing_ends_it`, `attachment_text::tests::the_watchdog_fires_at_its_deadline_and_not_before` | 감독자의 감시를 경주에서 빼면, 상한 비교를 지우면, 자식의 자기 구속·워치독을 지우면, 읽기 파서를 틀리게 하면 |
| D7 순서(런타임 앞, 2회차) | `attachment_text_child::the_child_confines_itself_before_any_thread_pool_exists_and_still_reads`(진짜 워커 바이너리를 `TOKIO_WORKER_THREADS=64`로 자식으로 띄워, 입력을 기다리는 동안의 스레드 수가 둘이고 평범한 PDF는 읽힌다) | 자식 갈래를 런타임을 만든 뒤로 옮기면(스레드 66) |
| D7 코어 덤프(2회차) | `attachment_text::tests::a_child_leaves_itself_no_core_dump`(자기 재실행 프로브, 소프트·하드 0), Linux: `attachment_text_child::a_child_confines_itself_before_it_reads_a_byte`의 `Max core file size` 행 | `RLIMIT_CORE` 줄을 지우거나 소프트만 낮추면 |
| D7 출력·슬롯 | `attachment_text_child::a_well_formed_answer_over_the_output_cap_is_refused`, `…::both_slots_stay_taken_while_two_real_children_run` | 출력 상한(`take`와 길이 검사)을 지우면, 슬롯을 자식 회수 전에 돌려주면 |
| D8 | `team_ai_files_conformance_pg::a_picture_reaches_the_model_as_a_structural_part_once_and_never_as_text`, `…::a_wire_that_cannot_see_pictures_says_so_and_reads_nothing`, `attachment_image::tests::*`, 와이어 단위 시험 | 부품이 아니라 글로 실으면, 한 요청 한 그림 규칙을 지우면, 다시 인코딩을 지우면(메타데이터 시험), chat/completions를 열면 |

사보타주를 실제로 돌린 결과는 PR 본문이 정본이다.

## 증보 5 (2026-11-02, #4585): 큰 파일·영상 — 개당 300 MiB, 이어 올리기, 구간 읽기(206), 스트림 주소, 포스터

개당 한도를 100 MiB에서 300 MiB로(메시지당 합계 600 MiB) 올리되 **순서를 지켜서** 올린다. 구간 읽기와 스트리밍(C3) → 청크 이어 올리기(C4) → 데스크탑 청크 전송(#4639) → 회수·사용량(C6) → 마지막에 기본값 스위치다. 업로드는 로컬 보관소가 Google 재개 업로드의 모양(8 MiB 청크, `Content-Range`, `308`)을 따라 하고, 읽기는 `Range`·`HEAD`(206·416)를 받으며, 웹·데스크탑의 영상 재생은 10분짜리 스트림 주소(요청마다 읽기 술어를 다시 판정)로 한다. 포스터와 길이는 보내는 기기가 만들어 PG에 두고, 회수는 증보 2의 청소기에 가지 하나(지운 메시지의 파일)를 더한다. **이 증보는 문서뿐이고 구현은 하지 않는다.** 뒤 칸 #4671·#4672·#4673·#4674·#4675가 이것을 계약으로 쓴다. 이슈·계획 본문이 말하는 「증보 3」은 이 증보다(번호는 착륙 순서라 #4934·#4970이 3·4를 먼저 썼다).

- Status: **Proposed** (2026-11-02, #4585 worker 기안. 독립 설계 검토 뒤 planner가 Accepted로 올린다. [ADR-0100](0100-decision-governance.md): Accepted 전에는 C3~C7 어느 것도 머지하지 못한다). 근거: owner 10-22 「결정 부탁드릴 것은 너가 권장으로 진행해봐」와 10-27 「권장대로 해봐」가 **개당 300MB·메시지당 600MB, 만료 없는 보관 + 회수·사용량, 웹 서명 주소, 데스크탑 앱 안 재생**을 정했다. 아래에서 **(owner 결정)**은 그 넷이고 **[권장]**은 그 틀 안에서 이 문서가 고른 세부라 검토에서 뒤집을 수 있다. 등급 2: 공개 API 계약·보안 경계·DB 계약이 바뀐다.
- **변경 전**: 2026-11-02, track/engine `195c304f3`의 코드를 읽어 확인한 사실이다.

  | 항목 | 지금 | 자리 |
  |---|---|---|
  | 한도 | 개당 100 MiB, 메시지당 20개. **합계 한도는 없다**(20×100 MiB가 된다) | `attachment.rs:67,71` |
  | 업로드 | 한 번의 PUT이 한 업로드다. 세션은 1회용·1시간이고 재시작이 `sessions/`·`incoming/`를 지운다 | `momo-drive/lib.rs:91`, `local.rs` 머리말(#2615·#2628), `routes/attachments.rs` `stub_upload` |
  | 엣지 | Railway는 요청 본문이 5분 안에 끝나야 하고 한 요청은 데이터가 흐르면 최대 15분이다(공식 문서, 2026-11-02 확인). 300 MiB 단일 PUT은 지속 약 8.4 Mbit/s가 필요하고, 같은 크기의 응답은 2.8 Mbit/s 아래로 받으면 15분을 넘긴다 | `momo-drive/lib.rs:80-84`의 같은 기록 |
  | 읽기 | content는 200 전체뿐이다. `Range`를 읽지 않고 `HEAD`는 axum 0.8이 GET 핸들러를 돌려 본문만 버린다 | `routes/attachments.rs` `content`, `lib.rs:989` |
  | 로컬 보관소 | `file_content`가 **아카이브 락 안에서** `fs::read`로 파일 전체를 메모리에 올린다. 한도가 300 MiB면 동시 읽기마다 300 MiB다 | `local.rs:511` |
  | Google 보관소 | 메타 호출과 `alt=media`, 상류 호출이 둘이고 `Range`를 넘기지 않는다 | `google.rs:472` |
  | 재생·포스터 | 앱 안 영상 재생이 없고 폰 picker는 사진 전용이며 `expo-video`가 없다. `attachment` 행에는 길이·치수·포스터가 없다 | `clients/mobile/package.json`, `attachment.rs` |
  | CSP | 웹 엣지 Caddyfile 넷은 `default-src 'self'`이고 `media-src`가 없다. 데스크탑은 번들 오리진이라 서버의 영상이 `default-src 'self'`에 막힌다 | `infra/rust/Caddyfile`·`.local`·`.host-network`, `infra/railway/Caddyfile.railway`, `tauri.conf.json:32` |
  | CORS | 허용 요청 헤더는 고정 목록(`content-range` 없음)이고 노출 헤더는 `retry-after` 하나다. 이 층은 `build_app` 맨 바깥이라 업로드 PUT에도 닿는다 | `cors.rs:68,75`, `lib.rs:2471` |
  | 회수 | 묶이지 않은 완료 첨부만 거둔다(30일, 기본 꺼짐). 지운 메시지에 묶인 바이트와 `pending`·`failed`는 안 거둔다 | 증보 2 |
  | 데스크탑 | 다운로드는 IPC 한 덩이 100 MiB이고 64 MiB 한 건에 메모리가 +569 MiB 선다(실측) | [ADR-0133](0133-ui-stack-tauri-react-migration.md) 증보 D7, `downloads.rs:76` |

### 결정

- **D1 · 한도: 천장 300 MiB, 기본값은 마지막에 올린다, 메시지당 합계 600 MiB** (개당 300·합계 600은 owner 결정, 나머지는 [권장]).
  - **천장은 코드·DB·계약의 한 값이다: 300 MiB(314,572,800 B).** DB CHECK `attachment_size_ck`, Rust 상수, openapi `maximum`, TS 상수가 같은 값이다. 화면 표기는 「300MB」다(`model.ts`의 관례: 100 MiB가 「100 MB」로 찍힌다).
  - **기본값(`DEFAULT`)은 스위치 전까지 100 MiB다.** 능력(천장·청크·구간 읽기)과 노출(기본값)을 나눈다. 실효 개당 한도는 `MOMO_ATTACHMENT_MAX_BYTES`(운영자 값, 선택) 또는 `DEFAULT`다. 운영자 값은 [1 MiB, 천장] 안이어야 하고 해석할 수 없거나 범위 밖이면 무시하며 기동 때 변수 **이름**만 경고한다(값은 찍지 않는다. 증보 3 D5와 같은 규칙). 운영자는 스위치 전에도 값을 올려 먼저 켜 보고, 셀프호스터는 낮출 수 있다. **스위치**는 `DEFAULT`를 300 MiB로 바꾸는 한 줄 PR이고 D8의 순서가 끝난 뒤 planner가 올린다.
  - **메시지당 합계 600 MiB(천장의 2배), 개수 20은 그대로다.** 합계는 `link_attachments_in_tx`와 `reserve_attachments_in_tx`가 **둘 다**, 행을 `FOR UPDATE`로 잠근 뒤 같은 함수 하나로 판정하고, 넘으면 어떤 `UPDATE`·`INSERT`도 하기 전에 413으로 거절한다(예약 발송·에이전트 deliver는 같은 척추다). 운영자 값 `MOMO_ATTACHMENT_MAX_MESSAGE_BYTES`(선택)는 [실효 개당 한도, 600 MiB] 안이다. **합계는 스위치 전에도 적용된다**(지금은 20×100 MiB가 된다).
  - **클라이언트가 한도를 아는 길**: `GET /v1/workspaces/{ws}/attachment-limits`(인증된 멤버 누구나. 설정 가방 `getWorkspaceSettings`는 owner·admin 전용이라 못 쓴다)가 `maxFileBytes`·`maxMessageBytes`·`maxFiles`·`chunkBytes`(없으면 `null`)를 준다. 값은 실제 거절에 쓰는 **같은 함수**에서 나온다(광고와 집행이 어긋날 수 없다). 413의 문장도 그 함수가 숫자를 찍는다. 이 응답이 없는 서버에서는 클라이언트가 100 MiB·20개로 돌아간다.
  - **DB CHECK는 천장과 같은 300 MiB로 넓힌다**(새 migration, 번호는 착수 때 planner가 준다). 넓히기만 하므로 기존 행이 모두 통과하고, 마이그레이션이 앱보다 먼저 도는 기존 배포 순서에서 안전하다. 300 MiB 행이 생긴 뒤에는 좁힐 수 없으니 되돌릴 때 CHECK는 그대로 둔다. 다음 상향도 새 ADR과 migration이다(CHECK를 더 크게 두는 안은 비교표).
  - **「팀 설정」은 두지 않는다.** 한도는 인스턴스(운영자) 값이고 워크스페이스별 값은 저장할 자리도 화면도 없다. 필요해지면 `workspace.settings` 키로 **내리는** 값만 더할 수 있다(천장·운영자 값을 못 넘는다). 이월.
  - **TS에는 값이 둘이다.** 천장(300 MiB)과 서버가 알려 주지 않을 때의 기본(100 MiB)이다. 데스크탑 IPC 상한을 TS 상수에 묶는 기존 시험(`downloadsContract.test.ts`)은 **천장** 쪽에 묶여야 한다. 기본 쪽에 묶이면 상향 뒤에도 초록이라 가드가 조용히 사라진다. 천장을 TS에 들이는 PR은 #4639가 IPC를 청크로 바꾸기 전에는 이 시험이 빨개지므로 **#4639 선행이 기계적으로 강제된다.**
  - **한도가 박힌 곳 전수** (상향 때 한 묶음으로 바뀐다):

  | # | 자리 | 값 | 상향 때 |
  |---|---|---|---|
  | 1 | `server/Migrations/017_attachment.sql:23` `attachment_size_ck` | 104857600 | 새 migration으로 300 MiB |
  | 2 | `momo-messaging/src/attachment.rs:67` | 100 MiB | 천장 상수와 실효 한도 함수 |
  | 3 | `momo-drive/src/lib.rs:63`과 사용처(`ReceivedLength`, `local.rs`, `google.rs`, `routes/attachments.rs`) | 100 MiB | 같은 값. 보관소가 상수 대신 실효 한도를 설정으로 받는다 |
  | 4 | `routes/attachments.rs:132`의 문장 「at most 100 MB」와 시험 `attachment_conformance_pg.rs:1674,1679` | 문장 | 한도 함수가 숫자를 찍는다 |
  | 5 | `momo-workspace-actions/src/team_ai_attachments.rs:57` `TABLE_MAX_BYTES` | 104_857_600 | 같은 값. 안 올리면 요청자 본인의 큰 파일이 「너무 커요」 대신 「못 찾아요」가 된다 |
  | 6 | `docs/api/openapi.yaml`: `CreateAttachmentUploadRequest.size`(25947)·`Attachment.size`(26026)·`MessageAttachment.sizeBytes`(26318)의 `maximum`, 413 설명 둘(11442·11495), `size` 설명의 「100 MB」 | 104857600 | 같은 값 |
  | 7 | `packages/momo-core/src/features/attachments/model.ts:52` `MAX_ATTACHMENT_BYTES`와 `:231`의 「100MB를 초과함」 | 100 MiB | 천장과 기본으로 나눈다. 문구는 숫자를 받는다 |
  | 8 | `clients/desktop/src-tauri/src/downloads.rs:76` `MAX_DOWNLOAD_BYTES`(IPC 한 덩이) | 100 MiB | #4639가 청크 전송으로 바꾼 뒤 |
  | 9 | `clients/desktop/src-tauri/src/pdf_viewer.rs:61` `MAX_PDF_BYTES` | 100 MiB | **올리지 않는다.** 뷰어 메모리 한도이지 첨부 계약이 아니다. 더 큰 PDF는 내려받기로 간다. 주석·시험의 「첨부 상한과 같다」를 고친다 |
  | 10 | `clients/web/gates/gate-attachment.mjs:1021` | 시험 값 | 천장 + 1 |

  - **한 시험이 이 자리들을 같이 잰다.** 지금의 `the_ceilings_agree_with_the_check_constraint`는 Rust 상수 둘과 리터럴 하나만 맞추고 SQL·openapi·TS를 읽지 않는다. 새 시험은 마이그레이션 SQL의 CHECK, openapi `maximum` 셋, TS 천장, Rust 상수 둘을 읽어 **같은 천장**임을 단정한다(한 곳만 바꾸면 빨강).
- **D2 · 이어 올리기** (로컬 백엔드, C4) [권장]. Railway는 요청 본문이 5분 안에 끝나야 해서 300 MiB 단일 PUT은 지속 8.4 Mbit/s가 필요하다. 8 MiB 조각은 5분 안에 끝나는 데 0.22 Mbit/s면 된다. 규약은 Google 재개 업로드의 모양이다(상태 조회와 `308`·`Range`). 같은 클라이언트 코드가 두 백엔드를 다루게 하려는 것이다.

  | 업로드 주소로 보내는 `PUT` | 응답 |
  |---|---|
  | `Content-Range` 없음 | 지금과 같다. 한 번의 전체 본문(옛 클라이언트, 아바타·이모지 조립 흐름). 성공은 `200`, 빈 본문 |
  | 올바른 조각: `Content-Range: bytes a-b/N`에서 `a`가 받은 길이, `N`이 선언 크기, 본문이 `b-a+1` 바이트이고, 마지막 조각이 아니면 `b-a+1`이 `chunkBytes`다 | 마지막이 아니면 `308` + `Range: bytes=0-b`. 받은 길이가 `N`이 되면 공개(세션 소진 → 메타 → 객체, 현행 순서) 뒤 `200` |
  | `a`가 받은 길이와 다르다(앞 조각의 응답이 유실된 경우) | 바이트를 쓰지 않고 `308` + 실제로 받은 만큼의 `Range`. 받은 것이 없으면 `Range` 헤더가 없다 |
  | `Content-Range: bytes */N`, 빈 본문(상태 조회) | `308` + 받은 만큼의 `Range` |
  | `Content-Range`의 문법 오류, `b`가 `N` 이상, 본문 길이가 `b-a+1`과 다름, 마지막이 아닌 조각의 크기가 `chunkBytes`가 아님, 선언 크기가 0(모르는 크기)인 세션에 `Content-Range` | `400`, 바이트를 쓰지 않는다(쓰던 조각은 되감는다). 청크는 선언 크기가 있어야 한다 |
  | 모르는·만료된·소진된 세션 | `404`, 현행과 같은 한 모양 |
  | 같은 세션의 동시 둘째 `PUT` | `409`. 앞 조각이 끝나야 한다 |

  - **`chunkBytes`는 8 MiB**(256 KiB × 32. Google의 256 KiB 배수 규칙을 지킨다). 마지막 조각만 더 작을 수 있다. `createAttachmentUpload` 응답의 선택 필드 `chunkBytes`가 있을 때만 클라이언트가 조각으로 올리고, **로컬 백엔드만 이것을 광고한다.** Google·stub은 광고하지 않아 단일 PUT이다. 브라우저가 Google 세션 주소에 `Content-Range` PUT을 보낼 때의 CORS 프리플라이트를 확인하지 못했기 때문이다(Google 청크는 이월).
  - **단일 PUT은 그대로 받는다.** 옛 클라이언트와, `putAttachmentBytes`로 단일 PUT을 보내는 아바타·이모지 조립 흐름(웹 `makeFlow.ts`·`uploadMyAvatar.ts`·`WorkspaceSection.tsx`)이 있다. `chunkBytes`는 첨부 `createAttachmentUpload`의 응답에만 더하고 아바타 업로드 응답은 그대로다. 응답 필드는 가산이라 옛 클라이언트는 모른다.
  - **순서와 되감기.** 조각은 순서대로, 세션당 한 번에 하나다. 조각 하나가 끝까지 도착하지 못하면(연결 끊김·길이 불일치) 파트 파일을 이전 길이로 되돌리고 받은 길이는 늘지 않는다. 응답은 파트에 다 쓴 뒤에만 나간다. 아카이브 락은 세션 상태 전이와 공개에만 쓰고 본문을 쓰는 동안은 쥐지 않는다(현행 `stream_into`와 같다).
  - **세션 수명은 두 마감이다.** 유휴 1시간(조각이 받아질 때마다 미끄러진다. 첫 조각 전에도 만든 뒤 1시간이라 단일 PUT 클라이언트에게는 지금과 같다)과 절대 6시간(만든 때부터. 300 MiB를 지속 0.12 Mbit/s로도 끝낼 수 있는 값이다). 만료·소진·모르는 세션은 모두 같은 404다. 세션 파일은 절대 마감 필드를 더하고, 그 필드가 없는 옛 세션 파일은 조각을 받지 않는다.
  - **308에는 `Location`이 없다.** HTTP에서 308은 영구 리디렉션이라 `Location`이 붙으면 `fetch`·XHR·URLSession이 따라간다. Google의 「308 Resume Incomplete」도 `Location` 없이 `Range`만 싣는다. 308 응답의 헤더 목록을 고정하고 시험이 `Location` 없음을 단정한다.
  - **CORS.** `cors.rs`의 허용 요청 헤더는 의도적으로 고정이라(요청 헤더를 반사하지 않는다) 데스크탑(번들 오리진이 API 오리진과 다르다)의 청크 PUT은 프리플라이트에서 막힌다. 허용 목록에 `content-range`·`range`를, 노출 목록에 `range`·`content-range`·`accept-ranges`를 더한다(지금 노출은 `retry-after`뿐이라 교차 오리진 클라이언트가 308의 `Range`를 읽지 못한다). 고정 목록의 변경이므로 C4의 독립 보안 검수 범위다. 같은 오리진인 웹은 해당 없다.
  - **멤버당 열린 세션 4개.** 보관소가 **살아 있는 세션**을 센다(세션 파일에 만든 멤버를 적고, `create_resumable_upload`가 멤버를 받도록 시그니처가 바뀐다. 로컬만이고 아바타 업로드의 세션도 몫에 든다). 다섯째 세션은 429(`too many open uploads`)이고 행도 파일도 만들지 않는다. 만료·소진·재시작으로 사라진 세션은 세지 않으므로 끊긴 시도가 몫을 쥐지 않는다. `pending` 행으로 세지 않는 까닭: 재시작이 세션을 지워도 행은 남아 정상 사용자를 막고, 행이 오래돼도 조각으로 살려 둔 세션은 상한을 빠져나간다. 지금의 시작 예산(분당 60)과 별개다. 클라이언트는 파일을 하나씩 올리므로 정상 사용은 1~2개다.
  - **디스크 예약(로컬만).** 새 세션은 `여유 − 열린 세션들의 남은 바이트(선언 − 받은) ≥ 선언 + 1 GiB`일 때만 만든다. 아니면 507(`storage is full`, 새 `DriveError`)이고 `attachment` 행도 세션 파일도 만들지 않는다. 조각을 쓰다 `ENOSPC`가 나도 507이고 파트는 되감는다. 여유는 볼륨의 `statvfs`다(D7). 시험이 결정적이도록 여유를 읽는 함수를 주입할 수 있어야 한다.
  - **파트는 요청을 넘어 산다 → 청소가 필요해진다.** 지금의 `PartFile`은 요청이 끝나면 지워진다. 청크의 파트는 세션과 같이 살고 세션이 만료·소진되면 지운다. 접근 때 지우는 현행 방식에 더해 60초 주기 청소가 만료된 세션의 파트와 세션 파일을 지운다(보관소 안의 일이라 DB가 필요 없다).
  - **재시작은 세션과 파트를 지운다(#2628 그대로).** 배포가 업로드를 끊으면 클라이언트는 상태 조회에서 404를 받고 0부터 다시 한다(남는 위험). **이월**: 재시작을 건너는 이어 올리기. 그 모양이라면 세션은 살리지 않고 파트만 살리며, 새 주소는 PG가 첨부를 `pending`으로 확인한 **인증 호출**로만 내준다. 주소가 파트를 새로 만들 수 없으므로 복원된 스냅샷이 이미 `complete`인 파일 id를 채우는 위험(`local.rs` 머리말, #2628)은 다시 열리지 않는다. 이 증보는 이것을 정하지 않는다.
  - **`complete`는 그대로**다(측정 크기·mime 대조). 다만 실효 한도로 다시 잰다. **마지막 조각의 응답이 유실되면** 클라이언트는 상태 조회에서 404를 받는다(세션이 소진됐다). 그때는 `complete`를 부른다. 멱등이라 객체가 있으면 200, 없으면 404 또는 409이고 그러면 처음부터 한다.
  - **바뀌는 불변식**: `momo-drive/lib.rs:80-91`의 「한 요청이 한 업로드」 전제와 「요청이 끝나면 파트를 지운다」는 규칙은 이 절이 **청크에 한해** 바꾼다(단일 PUT은 그대로). 바뀌지 않는 것은 재시작이 세션을 지우는 규칙, 공개된 객체를 어떤 세션으로도 덮어쓰지 않는 규칙, 공개 때 세션이 소진되는 규칙이다. `UPLOAD_SESSION_TTL`의 주석(「이 경로에는 재개 프로토콜이 없다」)은 C4가 고친다.
- **D3 · 구간 읽기와 HEAD** (C3) [권장]. Bearer content 경로가 `Range`와 `HEAD`를 받는다.
  - **판정 순서가 계약이다.** ① 인증 ② 활성 채널 멤버 ③ 읽기 술어(`load_readable_attachment_in_tx`) ④ `status = complete`를 지난 **다음에** `Range`를 해석한다. ①~④가 실패하면 `Range`가 있어도 지금의 응답(비멤버 403, 그 밖은 같은 404)과 상태·본문이 같다. 416은 **읽을 수 있는 파일에만** 나가므로 `Range`가 파일의 존재·크기를 묻는 오라클이 되지 못한다.

  | 요청 | 응답 |
  |---|---|
  | `Range` 없음 | `200`, 전체, `Content-Length`와 `Accept-Ranges: bytes` |
  | 단일 범위 `bytes=a-b`·`bytes=a-`·`bytes=-n`이고 만족할 수 있다 | `206`, `Content-Range: bytes s-e/크기`, `Content-Length: e-s+1`, 그 구간의 바이트만. `e`가 크기를 넘으면 `크기-1`로 줄이고 `-n`의 n이 크기 이상이면 전체 구간이다 |
  | 만족할 수 없다(`a`가 크기 이상, `-0`) | `416`, `Content-Range: bytes */크기`, 본문은 오류 JSON |
  | 다중 범위, 모르는 단위, 문법 오류, `If-Range`가 붙은 요청, 크기 0 | `Range`를 무시하고 `200` 전체. RFC 9110이 무시를 허용한다. 검증자(ETag·Last-Modified)를 내지 않으니 `If-Range`는 맞을 수 없다. 다중 범위를 멀티파트로 풀면 겹치는 범위로 응답이 부풀 수 있어 풀지 않는다 |
  | `HEAD` | 같은 판정 뒤 같은 헤더에 본문 0바이트. 보관소를 읽지 않는다 |
  | 그 밖의 메서드 | `405` |

  - **헤더.** 200·206·416·HEAD 모두 `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff`, `Cache-Control: private, no-store, no-transform`, `Accept-Ranges: bytes`다. **인라인 렌더 금지는 그대로다.** 206도 `attachment`다. 미디어 요소는 보통 disposition을 무시해 재생은 되고 주소창으로 열면 내려받기가 된다(미검증). `no-transform`은 엣지의 압축·변형을 막으려는 새 항목이다(아래 엣지).
  - **헤더의 크기·mime은 DB 행에서 나온다**(`size_bytes`, `mime`). GET·HEAD·206이 한 곳에서 나온다. `complete`가 측정 크기를 기록하고 보관소가 같은 크기를 말해야 완료되므로 행이 곧 보관소의 사실이다. 보관소가 말하는 총 길이가 행과 다르면 502로 닫는다(Google은 상류 `Content-Range`의 총량과 대조한다).
  - **보관소에 구간 읽기를 더한다**(`DriveArchive`, 세 백엔드). 로컬은 파일을 열어 시크한 뒤 구간만 청크 단위(64 KiB~1 MiB)로 흘리고 **스트림 동안 아카이브 락을 쥐지 않는다**(지금은 락 안에서 `fs::read`로 전체를 읽는다). Google은 `Range`를 그대로 넘기고 상류의 206·416을 옮기며, 크기를 DB가 알려 주므로 지금의 선행 메타 호출을 생략한다. stub은 메모리 슬라이스다. 모든 GET이 구간 읽기 하나를 쓴다(구간 없음 = 전체). HEAD는 보관소를 열지 않으므로 HEAD가 200이어도 GET이 보관소 오류일 수 있다(남는 위험). 시그니처는 C3의 몫이고 위의 동작이 계약이다.
  - **메모리는 파일 크기와 무관하다.** 300 MiB 객체 넷을 동시에 읽는 동안 프로세스 RSS 증가가 64 MiB 이하여야 한다(수용기준. Linux `/proc/self/status`, 소비자는 받은 바이트를 버리며 읽는다).
  - **엣지.** Caddyfile 넷이 모두 `encode zstd gzip`을 전역으로 두는데 206·`Content-Range`·영상 mime을 어떻게 다루는지는 확인하지 못했다. `no-transform`으로 막고, C3은 Caddy를 앞에 둔 실제 요청으로 206의 `Content-Range`·`Content-Length`가 그대로이고 `Content-Encoding`이 붙지 않음을 잰다.
  - **요율.** content 읽기에는 멤버별 요율 제한이 없다(`MemberWrite`는 쓰기 예산이다). 영상이 분당 수십 번 보내는 `Range`가 재생을 막지 않는다. 반대로 한 멤버의 큰 반복 읽기를 막는 장치도 없다(남는 위험).
  - **15분.** Railway는 한 응답을 15분 넘게 두지 않는다. 300 MiB를 2.8 Mbit/s 아래로 받는 클라이언트는 구간으로 받아야 한다(#4639·C7). 서버는 구간 응답을 지원한다.
- **D4 · 스트림 주소** (웹·데스크탑 재생, C3b) (웹 서명 주소·데스크탑 앱 안 재생은 owner 결정, 모양은 [권장]). ADR-0151 D3의 「인가 프록시 단일 경로」에 이 증보가 더하는 **유일한 예외**다. D3는 이제 「단일 인가 함수」로 읽는다. Bearer 경로(`content`)와 능력 경로(`stream`)가 같은 두 함수(`is_attachment_channel_member`, `load_readable_attachment_in_tx`)를 부르므로 두 경로의 판정이 어긋날 길이 없다.
  - **왜 필요한가.** `<video src>`는 `Authorization` 헤더를 못 싣는다. blob은 CSP가 `media-src`에 `blob:`을 열지 않고 300 MiB를 메모리에 올려야 해서 못 쓴다. self-media 주소(1회용)는 `<video>`가 `Range` 요청을 되풀이하므로 둘째 요청에서 죽는다.
  - **발급**: `POST /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/stream-url`, 본문 `{kind}`(`play` 또는 `save`). 사람 bearer만이고(좁은 토큰·에이전트는 403) 멤버당 분당 120회다. 읽기 술어를 **발급 때도** 판정하고(안 되면 content와 같은 403·404), `play`는 저장된 mime이 닫힌 목록일 때만 발급한다. 응답은 `{path, expiresAtMs}`이고 `path`는 `/v1/stream/{ws}/{token}`이다. 클라이언트가 자기 API 기준 주소에 붙인다(서버가 오리진을 만들지 않으므로 Host 파생을 믿을 일이 없다).
  - **공개 경로** `GET`·`HEAD /v1/stream/{ws}/{token}`: 능력 주소가 유일한 권한이다(self-media와 Drive 스텁의 전례). 다른 메서드는 405다. 경로의 `{ws}`는 canonical 소문자 id여야 한다(self-media와 같다).
  - **토큰**은 상태 없는 HMAC-SHA256이다. 키는 서버 비밀(JWT 서명 키)에서 도메인 라벨로 **파생한 전용 키**다(서명 키를 그대로 쓰지 않고 새 비밀 변수도 만들지 않는다). MAC은 {버전, 종류, 워크스페이스, 채널, 첨부, 멤버, 만료}를 덮는다(채널이 들어 있어 판정 함수가 content 경로와 인자까지 같고 추가 질의가 없다). **TTL은 10분이고 그 안에서 여러 번** 쓸 수 있다.
  - **요청마다 판정한다.** 서명·만료를 확인하고(DB 앞), 토큰의 멤버·채널로 두 함수와 `status = complete`를 판정하고, 구간 응답(D3과 같은 한 함수)을 낸다. 멤버가 떠나거나 정지·삭제되고, 메시지가 지워지고, 채널이 보관되면 **다음 요청부터** 404다. 이것이 회수 장치이고 TTL은 상한일 뿐이다. **로그아웃·세션 폐기는 이 주소를 끊지 않는다(최대 10분).** 좁은 토큰의 전례(push_fetch·push_action)는 세션 계보에 묶었지만 그 토큰들은 6시간이고, 이 주소는 10분에 파일 한 개 읽기라 행·계보 조회·상한의 비용이 이득보다 크다고 본다(비교표). TTL을 30분 넘게 늘리면 이 판단을 다시 한다.
  - **거절은 한 모양이다.** 모양 틀림·서명 불일치·만료·종류 불일치·비멤버·지운 메시지·남의 초안·없는 파일·허용 목록 밖 mime이 모두 같은 404다(바이트까지 같다. 공개 경로가 멤버십을 말하지 않으므로 403은 없다). 위조 토큰은 DB를 건드리지 않고, 404만 호출 주소(per-IP) 예산을 쓴다. Drive 스텁 게이트(`per_ip_drive_upload`)의 전례를 따라 핸들러가 먼저 판정하고 **살아 있는 주소는 예산이 바닥나도 거절하지 않는다**(엣지 주소 하나가 인스턴스 전체일 수 있어, 가짜 토큰 홍수가 정상 재생을 막으면 안 된다. 핸들러 앞에서 막는 `per_ip_self_media`식은 택하지 않는다).
  - **응답**은 구간 읽기와 같은 함수·같은 헤더에 `Referrer-Policy: no-referrer`가 더해지고 리디렉션은 없다. `play`는 저장된 mime이 `video/mp4`·`video/quicktime`·`video/webm`일 때만 나가고 `Content-Type`은 저장된 mime이다. 이 목록 덕에 주소를 주소창에 열어도 문서가 렌더되지 않는다(`attachment`·`nosniff`에 더한 둘째 겹이다). 목록을 늘리는 것은 이 ADR의 증보 사안이다. `save`(웹의 큰 파일 내려받기: blob 메모리 없이 브라우저 내장 다운로드)는 모든 mime을 받되 `Content-Type: application/octet-stream`으로 고정하고 `Content-Disposition: attachment; filename*=UTF-8''<퍼센트 인코딩한 이름>`을 낸다(이름이 헤더로 쓸 수 없는 값이면 `attachment`만). `save`는 C7이 쓸 때 구현한다.
  - **로그·감사.** 토큰은 어떤 로그·감사·오류에도 없다. API에는 공통 요청 로그 층(`TraceLayer`)이 없고(경로를 찍는 줄은 옛 게이트웨이 비밀 경로의 `auth.rs:718` 하나다) Caddyfile 넷에는 접근 로그 지시어가 없다. Railway 엣지의 HTTP 로그가 경로를 남기는지는 확인하지 못했다(그래서 TTL이 짧다). 발급은 감사하지 않는다(읽기마다 감사하지 않는 현행과 같다).
  - **폰**은 같은 주소를 쓰는 것이 [권장]이다. 헤더로 보내는 길(`expo-video`의 `headers`)은 access 토큰이 15분이라 긴 재생·탐색 중에 만료되고, 네이티브 플레이어는 헤더를 에셋을 만들 때 고정한다(미검증).
  - **CSP.** 웹은 같은 오리진이라 `default-src 'self'`가 `media-src`를 덮으므로 **변경이 없다**(웹 Caddyfile 넷과 `gate-csp-deploy.mjs`는 `media-src` 없이 그대로). 데스크탑은 `tauri.conf.json`에 **`media-src 'self' http: https:`**를 더한다. `connect-src`와 같은 모양이다(서버 주소는 사용자가 정하고 셀프호스트는 http일 수 있다). `blob:`은 택하지 않는다(영상 전체를 메모리에 올려야 한다, 300 MiB). `img-src 'self' data:`는 그대로다. `media-src`가 넓어지는 대가로 **앱이 `<video>`·`<audio>` 요소를 만드는 곳은 재생기 컴포넌트 하나뿐**임을 정적 시험으로 못 박는다(메시지 본문이 원격 미디어를 부르는 길이 없다는 근거다). 이 CSP 변경의 기록은 ADR-0133 증보로 C7이 같은 PR에서 쓴다(값은 여기서 정한다).
  - **공개 보안 문장.** `docs/security/claims.yaml:147`의 「익명 요청은 401」은 스트림 주소가 생기면 그대로는 거짓이다(능력 주소는 Bearer 없이 바이트를 준다). C3b가 문장과 증명을 같은 PR에서 고친다. `claims.yaml`은 정책 파일(`scripts/verify_policy_integrity.sh`의 `policy_path`)이라 그 PR은 지정 owner의 exact-head audit와 승인 라벨을 거친다.
- **D5 · 영상 메타와 포스터** (C5) [권장].
  - **만드는 곳은 보내는 기기다.** 폰이 첫 구현이다. 웹·데스크탑은 로컬 파일을 `<video>`로 읽어야 해서 `media-src blob:`이 필요하므로 이월한다(그때까지 웹·데스크탑이 올린 영상은 포스터 없이 카드로 보인다). **서버는 영상을 파싱하지도 변환하지도 않는다.** ffmpeg는 이미지에 없고 라이선스·공격면·CPU가 문제이며, 증보 4 D7이 파서를 자식 프로세스에 가둔 전례처럼 적대 형식의 파싱은 가둬야 한다. HLS·서버 변환은 아이디어로만 둔다.
  - **저장은 PG다.** 첨부 id에 1:1인 표 `attachment_media`(`ON DELETE CASCADE`, RLS FORCE)에 `duration_ms`(1..86,400,000), `width`·`height`(1..16,384), 포스터 `poster_mime`(`image/jpeg`·`image/webp`), `poster_width`·`poster_height`(1,280 이하), `poster_bytes`(`bytea`, 256 KiB 이하)를 둔다. 보관소에는 서버가 바이트를 쓰는 API가 없고(131 아바타 이미지가 같은 이유로 PG에 둔다), 포스터를 둘째 첨부 행으로 두면 「묶이지 않은 초안은 업로더만 읽고 30일 뒤 청소된다」는 규칙에 걸려 다른 멤버에게 안 보이거나 지워진다.
  - **쓰기**: `PUT /v1/workspaces/{ws}/channels/{ch}/attachments/{id}/media`, JSON `{durationMs, width, height, poster: {mime, dataBase64}}`(본문 상한 512 KiB). **업로더 본인이 `complete`이고 아직 메시지에 묶이지 않은 첨부에만** 쓴다(멱등 교체). 서버 검증: 저장된 mime이 닫힌 영상 목록(`video/mp4`·`video/quicktime`·`video/webm`)이고 `read_prefix`로 읽은 첫 바이트에 `ftyp`(mp4·mov, 오프셋 4) 또는 EBML(`1A 45 DF A3`, webm) 매직이 있다. **새 파서 crate는 쓰지 않는다**(이슈 #4673의 「mp4 헤더 검사」는 이 매직 확인으로 줄인다). 포스터는 `sniff_image_mime`(JPEG·WebP 매직)·`image_dimensions`(헤더 치수)·크기로 바이트를 검증한다. 길이·치수는 **선언값의 범위만** 검증한다(클라이언트가 거짓이면 레이아웃만 틀어진다).
  - **읽기**: `GET …/attachments/{id}/poster`가 content와 같은 인가·같은 헤더 셋·같은 404를 쓴다. 메시지 투영의 `attachments[]`에는 영상일 때만 `media: {kind, durationMs, width, height, hasPoster}`를 **더한다**(가산). 포스터 바이트는 투영·`message.new` 프레임·outbox 페이로드 어디에도 싣지 않고, 목록 질의는 `poster_bytes`를 고르지 않는다.
  - **신뢰**: 포스터가 그 영상의 실제 프레임이라는 보장은 없다(남는 위험). 쓰기는 감사한다(`attachment.media_set`, 종류만이고 내용·이름은 없다). 회수는 행 CASCADE가 따라간다.
- **D6 · 폰 영상 압축 기본값** (구현은 F1 #4586, 값은 여기서 정한다) [권장].
  - 기본은 「일반 화질」이다. `expo-image-picker`의 내보내기 프리셋 `H264_1280x720`(H.264·AAC, 해상도가 정해져 있어 어디서나 재생되고 크기를 가늠할 수 있다. `MediumQuality`는 해상도가 기기에 달렸다). 「원본」은 `Passthrough`이고 **보낼 때마다 직접 고른다**(기억하지 않는다. 셀룰러에서 원본 300 MiB를 실수로 올리지 않게 한다).
  - 줄인 결과도 한도를 넘으면 「너무 커요」로 거절하고, 자동으로 더 줄여 다시 시도하지 않는다. 웹·데스크탑은 영상을 변환하지 않는다. 안드로이드는 이 프리셋이 없어(iOS 옵션) 원본만 올린다.
  - **미검증 셋.** ① 설치된 타입 정의(`expo-image-picker` 57)가 `videoExportPreset`을 deprecated로 표시한다(Apple `UIImagePickerController` 문서를 가리킨다). 라이브러리(PHPicker) 경로에서 프리셋이 실제로 적용되는지 실기로 확인한다. ② **위치 메타가 지워지는지** 모르므로 화면 문구는 위치 제거를 약속하지 않는다. ③ 안 되면 `AVAssetExportSession` 직접 사용이 대안이다(용량 상한·faststart·메타 필터가 정밀하지만 [ADR-0168](0168-mobile-photo-picker-native-dependency.md)급 네이티브 결정이다).
  - **폰 청크 읽기**: `expo-file-system` 57의 `File.slice(start, end)`(Blob)와 `FileHandle.readBytes(length)`·`offset`이 타입에 있다. 8 MiB 단위로 읽을 수는 있다. 실기의 성능·메모리와 Blob을 `fetch`로 PUT할 때의 거동은 미검증이다. 폰 청크 업로드를 맡은 이슈가 아직 없다(남은 것).
  - 폰의 올리기 순서는 고름 → 줄임 → 포스터·길이 뽑기 → create → 조각 → complete → `PUT …/media`(실패해도 보내기는 진행) → 전송이다.
- **D7 · 보관·회수·사용량** (C6) (만료 없는 보관 + 회수·사용량은 owner 결정, 나머지는 [권장]).
  - **살아 있는 메시지에 묶인 파일은 기간으로 지우지 않는다**(owner 결정).
  - **회수**: 증보 2 D4 청소기에 **가지 하나**를 더한다. 지운 메시지에 묶인 완료 첨부 중 `COALESCE(m.deleted_at, a.created_at)`이 30일보다 오래된 것이다(`state`만 또는 `deleted_at`만 쓰인 반쪽 무덤도 포함하고, 시각이 비면 업로드 시각이 기준이라 더 늦게 거둔다). 같은 `NO_OTHER_HOLD_SQL`(huddle 세 열·아바타 두 표), 같은 저장점 순서(행 삭제와 감사를 먼저, 보관소는 나중), `attachment.expired` + `reason: deleted_message`다. 이 가지가 열리면 증보 2의 참조 전수 표 A1(「묶인 행은 후보가 아니다」)이 바뀌므로, A1과 점검 SQL(청소기의 술어와 **글자까지 같다**는 단위 시험)과 새 FK 탐지를 같은 PR에서 고치고 표에 **A6: `attachment_media`(CASCADE)**를 더한다. 기본 꺼짐·건조 실행 줄·점검 SQL 절차는 그대로이고 **켜기는 owner가 새 가지의 건조 실행 숫자를 본 뒤** 한다.
  - **사용량**: 워크스페이스별 `SUM(size_bytes)`(`status = 'complete'`)를 RLS-bound 테넌트 tx로 센다. 이유별(살아 있음, 지운 메시지, 초안, 진행 중)로 나눠 owner·admin 화면에 보인다. **로컬 백엔드는 볼륨 사용률을 `statvfs`로 재어 80%에서 경고**한다(owner·admin 알림과 로그 한 줄, 반복은 억제). 안전한 래퍼로 읽는다. 새 `unsafe`는 금지이고(`unsafe-allowlist.tsv`), `rustix`가 이미 `Cargo.lock`에 있으며 그 라이선스를 `deny.toml`이 허용한다. Google 백엔드에는 볼륨 경고가 없고 사용량(DB 합계)만 있다. **하드 쿼터는 두지 않는다**(작은 팀이고 실제 한도는 디스크이며, 만들기 전 거절은 D2의 디스크 예약이 맡는다).
  - **비용**: 요금표·플랜 한도·볼륨 크기는 운영 값이라 여기 적지 않는다. 읽기가 모두 api를 지나므로 전송 요금이 사용량과 같이 늘 수 있다는 사실과 계산식만 남긴다: 300 MiB × N개, 100개면 약 29 GiB다.
  - 진행 중 업로드의 파트는 D2의 청소가 맡는다. 사용자가 초안 첨부를 지울 때 곧바로 거두는 API(`DELETE …/attachments/{id}`)는 이월한다(30일 청소가 거둔다).
- **D8 · 순서와 스위치** (안전 장치).
  1. C3(읽기)는 독립으로 먼저 선다.
  2. #4639(데스크탑 큰 파일 청크 전송)는 천장을 TS에 들이는 C4의 한도 PR보다 앞이다. `downloadsContract.test.ts`가 기계적으로 강제한다(D1).
  3. C4 1단계(청크 서버·CORS·열린 업로드 상한·디스크 예약·파트 청소) → 2단계(한도 함수·천장·CHECK·`attachment-limits`·메시지 합계).
  4. C3b는 C3 뒤다. C5·C6은 서로도 C3와도 독립이다. C7은 C3·C3b·C4·C5 뒤이고 폰 F1은 C3·C3b·C5 뒤다.
  5. **스위치**는 C3·C4·#4639·C6·C7(웹·코어)이 착륙하고 스택 검증(실기기 포함)이 끝난 뒤 planner가 `DEFAULT`를 300 MiB로 올리는 것이다. 그 전에 owner 인스턴스는 `MOMO_ATTACHMENT_MAX_BYTES`로 먼저 시험할 수 있다.

### 비교한 방식

| 결정 | 방식 | 판단 |
|---|---|---|
| 천장·CHECK | **[권장]** CHECK = 천장 300 MiB, 운영자 값은 [1 MiB, 천장], 기본값은 마지막에 스위치 | 능력과 노출을 나눠 순서를 지킨다. 같은 값이 여러 자리라 한 시험이 읽는다 |
| | CHECK를 1 GiB처럼 더 크게 두고 env 기본만 300 | 기각. CHECK가 계약의 한 자리가 아니게 되어 「의도한 여유」와 어긋남을 시험이 구별하지 못한다. 다음 상향은 어차피 ADR이다(ADR-0100) |
| | 100 MiB 유지, 500 MiB, 1 GiB | owner 결정이 300 MiB다 |
| | 스위치 없이 한 번에 올림 | 기각. 데스크탑 IPC(64 MiB에 +569 MiB), 로컬의 전체 메모리 읽기, Railway 5분이 먼저 풀려야 한다 |
| 업로드 규약 | **[권장]** Google 모양(`Content-Range`·`308`·상태 조회) | 같은 클라이언트 코드가 두 백엔드를 다룬다 |
| | tus(HEAD로 오프셋, PATCH로 잇기) | 기각. 둘째 프로토콜이고 Google 백엔드와 모양이 달라 클라이언트가 둘이 된다 |
| | S3 멀티파트 | 기각. Rust에 S3 백엔드가 없다(ADR-0151 옵션 2) |
| 재시작 | **[권장]** 세션·파트를 지운다(#2628 그대로) | 0부터. 남는 위험으로 둔다 |
| | 세션을 살린다 | 기각. 복원된 스냅샷이 이미 `complete`인 파일 id를 채우는 위험이 돌아온다 |
| | 파트만 살리고 인증 호출로 새 주소를 낸다 | 안전하지만 상태 파일·인증 경로·청소가 는다. 쓰다가 판단한다(이월) |
| 재생 인증 | **[권장]** 상태 없는 서명 주소(10분, 다회) + 요청마다 재판정 | 회수는 재판정이 맡고 TTL은 상한이다 |
| | self-media식 1회용 DB 토큰 | 기각. `<video>`의 둘째 `Range` 요청에서 죽는다 |
| | push_fetch식 세션 계보에 묶은 좁은 토큰 | 로그아웃이 즉시 끊지만 행·계보 조회·상한이 는다. 10분에 파일 하나라 이득이 작다. TTL이 30분을 넘으면 다시 본다 |
| | 쿠키 | 기각. API가 쿠키 인증이 아니고 데스크탑은 교차 사이트라 WKWebView가 막는 것으로 보인다(미검증) |
| | 서비스워커로 헤더 주입 | 기각. 데스크탑 CSP가 `worker-src 'none'`이고 토큰 갱신이 복잡하다 |
| | blob 재생 | 기각. `media-src blob:` CSP 변경에 300 MiB 메모리 |
| TTL | 5분 | 노출은 줄지만 탐색 때마다 갱신이 잦다 |
| | **[권장]** 10분 | `<video>`가 탐색·재연결 때 새 요청을 내는 빈도와 오류 때 다시 받는 경로 사이의 값 |
| | 30분 이상 | 갱신은 줄지만 경로·HTTP 로그에 남은 주소의 값이 커진다 |
| 서명 키 | **[권장]** JWT 서명 키에서 도메인 라벨로 파생 | 새 비밀 변수의 회전·배포 부담이 없다 |
| 포스터 저장 | **[권장]** PG `bytea` 표(131 전례) | 회수가 CASCADE로 따라가고 같은 읽기 술어를 쓴다 |
| | 둘째 첨부 행 | 기각. 초안 규칙·30일 청소와 부딪힌다 |
| | 서버 생성(ffmpeg) | 기각. 이미지에 없고 라이선스·공격면·CPU가 문제다 |
| 영상 검증 | **[권장]** 선언값 범위 + 첫 바이트 매직 | 파서가 없으니 공격면이 늘지 않는다 |
| | `mp4` crate로 헤더 파싱(길이·코덱·faststart) | 기각(v1). 적대 형식 파서와 새 의존의 NOTICE. 필요하면 자식 프로세스에 가두는 별도 결정 |
| 폰 압축 | **[권장]** picker 프리셋 `H264_1280x720` | 새 네이티브 코드가 없다 |
| | `AVAssetExportSession` 직접 | 정밀하지만 ADR-0168급 네이티브 결정이다. 프리셋이 안 통하면 대안이다 |
| 데스크탑 CSP | **[권장]** `media-src 'self' http: https:` | `connect-src`와 같은 모양이고 한 줄이다 |
| | 커스텀 프로토콜 + Rust 프록시(Authorization·Range) | 더 좁지만 새 네이티브 코드와 보안 면이다 |
| 회수 기본값 | **[권장]** 기본 꺼짐 유지, 켜기는 owner | 영상이 쌓인 인스턴스가 업그레이드 직후 한꺼번에 거두는 일을 막는다 |

### C3~C7 슬라이스

등급은 이슈 계약의 등급이다(2 = 보안 경계·공개 API 계약을 바꾼다). migration 번호는 이 증보가 쓰지 않는다(착수 때 planner가 준다).

| 슬라이스 | 이슈 | 일 | 의존 | 크기 | 등급 | migration | 검수 |
|---|---|---|---|---|---|---|---|
| C3 | #4671 | 로컬 스트리밍 읽기, `Range`·`HEAD`, Google 전달, `no-transform`, 모든 GET을 구간 읽기 하나로 | 이 증보 Accepted | M | 2 | 없음 | 독립 보안 검수(인가 경계 불변) |
| C3b | 신규 이슈 필요 | 스트림 주소: 발급·공개 경로·토큰·per-IP 예산·`claims.yaml` 문장과 증명 | C3 | M | 2 | 없음 | 독립 보안 검수 |
| C4 | #4672 | 1단계: 청크 서버·CORS 목록·열린 업로드 상한·디스크 예약·파트 청소. 2단계: 실효 한도 함수·천장·CHECK·`attachment-limits`·메시지 합계·한도 표의 모든 자리(**스위치 제외**) | #4639, C3와 같은 모듈이라 순서는 통합자 | L(2단계) | 2 | 1(CHECK 넓힘) | 독립 보안 검수 B0·H0 |
| C5 | #4673 | `attachment_media` 표, `PUT …/media`, `GET …/poster`, 투영 | 이 증보(C3와 독립) | M | 2 | 1 | 보안 검수 |
| C6 | #4674 | 지운 메시지 가지, 점검 SQL, 사용량, 80% 경고 | #4443 | M | 2 | 없음 | 독립 보안 검수 |
| C7 | #4675(+#4588) | 웹·코어 청크 클라이언트, 스트림 주소 재생(웹·데스크탑), 데스크탑 `media-src`와 ADR-0133 증보, `save` 선택 | C3·C3b·C4·C5 | M | 1 | 없음 | design-review |
| F1 | #4586 | 폰 영상 고르기·줄이기·포스터·재생과 **폰 청크 업로드(맡은 이슈 없음)** | C3·C3b·C5, [ADR-0168](0168-mobile-photo-picker-native-dependency.md) 증보(`expo-video`·저장 문구·마이크) | L | 1 | 없음 | design-review |
| 스위치 | C4의 마지막 줄 또는 소 PR | `DEFAULT` 100 MiB → 300 MiB | D8의 5 | S | 2 | 없음 | planner |
| #4639 | UXUI | 데스크탑 큰 파일 청크 전송(`downloads.rs:76`) | 없음(`Range` 없이도 된다) | M | 1 | 없음 | design-review |

### 바뀌지 않는 것

인가의 두 함수와 그 술어(활성 채널 멤버, 살아 있는 메시지에 묶였거나 묶이지 않은 업로더 본인의 초안, `complete`), Bearer content 경로의 거절 모양(비멤버 403, 그 밖은 404), 인라인 렌더 금지(`attachment`·`nosniff`·`no-store`), Drive 주소 비노출, 에이전트 업로드 제외, 바이러스 스캔 없음, 종류 제한 없음(영상은 표시를 키울 뿐 첨부의 정의를 바꾸지 않는다. 재생이 안 되면 내려받기 카드로 남는다), `complete`·묶기의 업로더 규칙, 증보 2의 회수 안전 규칙(같은 hold·저장점 순서·기본 꺼짐), 워커의 읽기 길(증보 3·4의 `self-media`와 1회용 주소), 단일 PUT 경로(옛 클라이언트·아바타·이모지), 재시작이 세션을 지우는 규칙(#2628).

### 이슈·리서치 문구와 다른 곳

① 이슈 #4585 코멘트와 #4671~#4675 본문의 「증보 3」은 이 증보(5)다. ② 이슈 코멘트의 「Accepted로 써요」는 칸 지시대로 Proposed다(독립 설계 검토 뒤 Accepted). ③ #4673의 「mp4 헤더 검사」는 첫 바이트 매직 확인으로 줄였다(D5). ④ #4672의 「한도 상향 마이그레이션(CHECK)·openapi·상수 한 곳」은 천장을 넓히는 일(C4)과 기본값을 올리는 일(스위치)로 나눴고, 한 시험이 여러 자리를 읽는다(D1). ⑤ #4584의 「앱 플레이어는 인증 헤더로 받아요」는 웹·데스크탑은 주소(헤더를 못 싣는다), 폰도 주소를 권장한다(access 토큰 15분). ⑥ 서버 쪽 스트림 주소(발급·공개 경로)를 맡은 이슈가 없다(C3b 신규 필요). ⑦ 폰 청크 업로드를 맡은 이슈가 없다(#4586에 넣거나 신규).

### 남는 위험

1. **스트림 주소는 Bearer 없이 바이트를 준다.** 10분·파일 하나·요청마다 재판정이지만 로그아웃·세션 폐기는 이 주소를 끊지 않는다.
2. Railway 엣지의 HTTP 로그가 경로(토큰)를 남기는지 확인하지 못했다. 짧은 TTL이 완화책이다.
3. `Content-Disposition: attachment` 아래의 `<video>` 재생과 `Range` 탐색, `no-store`가 재생 캐시에 미치는 영향이 WebKit(Safari·WKWebView)에서 미검증이다.
4. `Location` 없는 308을 `fetch`·XHR·URLSession이 정상 응답으로 돌려주는지, Railway 엣지·Caddy를 그대로 지나는지 미검증이다.
5. 배포가 업로드를 끊으면 0부터 다시 한다(재시작을 건너는 이어 올리기는 이월).
6. Google 백엔드의 브라우저 청크는 CORS 프리플라이트를 확인하지 못해 광고하지 않는다. Google은 단일 PUT 300 MiB다.
7. 클라이언트가 보낸 포스터·길이·치수는 믿지 않고 범위와 바이트만 잰다. 포스터가 그 영상의 프레임이라는 보장은 없다.
8. 메시지당 합계 600 MiB는 스위치 전에도 적용된다(지금의 20×100 MiB가 줄어든다).
9. 한 멤버의 반복 대용량 읽기(전송 요금)를 막는 장치가 없다. 이상 징후가 보이면 멤버별 바이트 예산을 더한다.
10. 데스크탑 `media-src`가 http·https 전체로 넓다. 미디어 요소를 만드는 곳이 하나뿐이라는 정적 시험에 기댄다.
11. HEAD는 보관소를 읽지 않아 200 뒤에 GET이 보관소 오류일 수 있다.
12. 폰 영상 내보내기가 위치 메타를 지우는지 모른다. 문구가 약속하지 않는다.
13. 채널·워크스페이스를 지우는 CASCADE는 보관소 객체를 고아로 남긴다(증보 2의 위험이 큰 파일에서 더 비싸진다).
14. 열린 업로드 4개와 디스크 예약은 정상 사용자를 막을 수 있다. 예약은 보수적이라 60초 청소 주기 사이에 만료된 세션의 남은 바이트가 계산에 남는다.
15. 데스크탑 IPC가 선형으로 늘면 300 MiB 한 건에 메모리가 약 +2.6 GiB다(64 MiB에서 +569 MiB를 잰 값에서 늘린 추정이며 측정이 아니다). #4639 전에는 올리지 않는다(D1의 시험이 강제한다).
16. 웹·데스크탑이 올린 영상은 포스터가 없다(이월).

### runtime-unverified

이 증보는 문서뿐이라 코드를 실행하지 않았다. 읽은 코드 사실은 track/engine `195c304f3` 기준이고, Railway의 5분·15분과 Google 재개 업로드의 규칙(256 KiB 배수, 세션 1주, 상태 조회, 308)은 공식 문서를 2026-11-02에 읽은 값이다. 실행으로 확인하지 못한 것: 실제 Railway 엣지 위의 206·308·`Content-Range`·HTTP 로그, Caddy `encode`의 206 처리, 브라우저·WKWebView의 `attachment` 아래 `<video>` 재생과 `Range` 탐색, `fetch`·XHR·URLSession의 Location 없는 308 처리, 폰 `videoExportPreset`의 실제 적용과 위치 메타, `expo-file-system` 구간 읽기와 Blob PUT, Google 브라우저 청크의 CORS, 300 MiB 동시 읽기의 실제 RSS(수용기준은 C3의 몫).

### red proof

시험 이름은 제안이고 구현 칸이 정한다. 단정은 실제 바이트 수·헤더 값·행 수를 재야 하고(실 PG는 두 테넌트와 비우회 역할), 컴파일 실패는 RED로 세지 않는다.

| 결정 | 시험(제안) | 분기를 지우면 빨강 | 칸 |
|---|---|---|---|
| D1 천장 | `attachment_ceilings_agree`(파일을 읽는 단위 시험) | 마이그레이션 SQL의 CHECK·openapi `maximum` 셋·TS 천장·Rust 상수 둘·`TABLE_MAX_BYTES`가 한 값이다. 한 곳만 300 MiB로 바꾸거나 한 곳만 100 MiB로 남기면 빨강 | C4 |
| D1 실효 한도 | `the_effective_limit_is_one_function` | 운영자 값 120 MiB에서 120 MiB 선언은 통과하고 120 MiB + 1 B는 413이며, 413 문장이 120을 찍고 `GET attachment-limits`가 같은 값을 준다. 한 곳을 상수로 되돌리면 어긋나서 빨강 | C4 |
| D1 범위 | `an_operator_value_outside_its_range_is_ignored` | 0·음수·문자열·천장 초과·1 MiB 미만은 `DEFAULT`로 돌아가고 기동 로그가 변수 이름만 담는다(값 없음). 클램프를 지우면 빨강 | C4 |
| D1 스위치 | `the_default_is_100_until_the_switch` | 기본 설정에서 100 MiB + 1 B 선언은 413이고 운영자 값 300 MiB에서는 통과한다. 스위치가 바꾸는 것은 `DEFAULT` 한 줄이고 CHECK·천장·openapi는 그대로다(위 `attachment_ceilings_agree`가 초록으로 남는다). 스위치가 천장을 건드리면 빨강 | C4·스위치 |
| D1 합계 | `a_message_over_the_total_is_refused_before_any_row_changes`(실 PG) | 300 + 300 MiB는 통과하고 + 1 B는 413이며 어떤 `attachment` 행의 `message_id`도 바뀌지 않고 메시지는 롤백된다. 예약(`reserve`)도 같다. `link`에서 판정을 지우면 보내기가, `reserve`에서 지우면 예약이 통과해 빨강 | C4 |
| D2 왕복 | `a_chunked_upload_round_trips_to_the_same_bytes`(실 라우터·실 소켓) | 64 MiB(8조각)를 올린 객체의 SHA-256이 원본과 같고 마지막 조각 뒤 `200`이며 `complete`가 측정 크기를 기록한다. 오프셋 계산이나 이어붙이기를 틀리게 하면 해시가 달라 빨강 | C4 |
| D2 오프셋·크기 | `a_chunk_at_the_wrong_offset_writes_nothing_and_reports_what_is_held` | 다른 오프셋의 조각은 파트 길이를 바꾸지 않고 `308` + 실제로 받은 만큼의 `Range`다(받은 것이 없으면 `Range` 헤더가 없다). 선언 크기 0인 세션에 `Content-Range`는 400이고 그 세션의 단일 PUT은 지금처럼 통과한다. 검사를 지우면 겹쳐 써서 해시가 달라 빨강 | C4 |
| D2 되감기 | `an_interrupted_chunk_is_rewound` | 조각 본문을 반만 보내고 끊으면 상태 조회가 끊기기 전의 `Range`를 주고, 같은 조각을 다시 보내면 성공해 해시가 같다. 되감기를 지우면 파트가 길어져 다음 오프셋이 어긋나 빨강 | C4 |
| D2 308 | `a_308_never_carries_a_location` | 조각 확인·상태 조회의 모든 308에 `Location`이 없다. 넣으면 빨강(`fetch`·URLSession의 실제 추종은 runtime-unverified) | C4 |
| D2 수명 | `the_session_ends_at_its_idle_and_absolute_deadlines`(시계 주입) | 50분 간격 조각 일곱 개(5시간 50분)는 끝까지 산다. 마지막 조각 뒤 61분은 404, 생성 뒤 6시간 1분은 어느 때든 404다. 소진·만료·모르는 세션은 같은 상태·같은 본문이다. 유휴를 고정으로 바꾸면 앞이, 절대 마감을 지우면 뒤가 빨강 | C4 |
| D2 동시 | `one_chunk_at_a_time_per_session` | 같은 세션의 동시 둘째 PUT은 409이고 파트가 섞이지 않는다(해시 같음). 세션 잠금을 지우면 빨강 | C4 |
| D2 회귀 | 기존 `drive_upload_edge`·`local.rs` 단위 시험·아바타·이모지 업로드 시험 | `Content-Range` 없는 PUT이 그대로 통과한다. 청크 분기가 단일 PUT을 깨면 빨강 | C4 |
| D2 상한·예약 | `the_open_upload_cap_and_the_disk_reservation_refuse_before_any_row` | 멤버당 살아 있는 세션 4개일 때 다섯째가 429이고 행이 없다. 세션 하나가 만료·소진되면 다시 만들 수 있고 재시작 뒤에는 0개다. 주입한 작은 볼륨에서 열린 세션들이 쥔 남은 바이트 때문에 다음 세션이 507이고 `attachment` 행도 세션 파일도 없다. 남은 바이트 항을 빼면 둘째 세션이 통과해, 1 GiB 바닥 항을 지우면 빨강 | C4 |
| D2 청소 | `a_stale_part_is_swept_and_a_live_one_is_not` | 만료 세션의 파트와 세션 파일은 청소 뒤 없고 받는 중인 세션의 파트는 그대로다. 살아 있는 파트를 지우면 받는 중 업로드가 깨져, 만료 파트를 안 지우면 빨강 | C4 |
| D2 재시작 | `a_restart_clears_sessions_and_parts_but_keeps_objects`(기존 `open_clears_pending_sessions_and_partial_writes_but_keeps_objects`의 청크판) | 청크 중간에 아카이브를 다시 열면 세션·파트가 없고 객체는 그대로이며 옛 주소는 404다. 지우는 규칙을 지우면 빨강(스냅샷 재생 위험이 돌아온다) | C4 |
| D2 CORS | `cors_allows_content_range_and_exposes_range` | 허용 목록에 `content-range`·`range`, 노출 목록에 `range`·`content-range`·`accept-ranges`가 있고 요청 헤더를 반사하지 않는다. 반사로 바꾸면 빨강 | C4 |
| D3 오라클 | `a_range_never_asks_whether_a_file_exists`(실 PG) | 남의 초안·지운 메시지(반쪽 무덤 둘)·없는 id·다른 채널·`pending`에 `Range`(만족 가능·불가능·다중)를 보내도 `Range` 없는 요청의 응답과 상태·본문이 같다. `Range` 해석을 인가 앞으로 옮기면 416이 존재를 말해 빨강 | C3 |
| D3 응답표 | `the_range_table` | 표의 줄마다 상태와 `Content-Range`·`Content-Length`·`Accept-Ranges` 값을 단정한다(경계: `a-`, `-n`, n이 크기 이상, `b`가 크기 이상, 마지막 한 바이트, 크기 0, 다중 범위, `If-Range`). 줄 하나를 틀리게 하면 빨강 | C3 |
| D3 HEAD | `head_reads_no_byte_of_the_archive` | 호출·읽은 바이트를 세는 보관소에서 HEAD의 보관소 읽기는 0이고 크기·mime은 DB 행의 값이다. HEAD가 본문 스트림을 열면 빨강 | C3 |
| D3 메모리 | `a_local_read_is_flat_in_memory`(Linux) | 300 MiB 객체(희소 파일) 넷을 동시에 읽는 동안 RSS 증가가 64 MiB 이하다. `fs::read`로 되돌리면 1 GiB를 넘어 빨강 | C3 |
| D3 락 | `a_slow_reader_does_not_hold_the_archive_lock` | 읽기 스트림을 멈춘 채 `file_metadata`와 새 세션 생성이 제때 끝난다. 스트림 동안 락을 쥐면 빨강 | C3 |
| D3 백엔드 | `a_range_read_returns_only_those_bytes_on_every_backend` | 로컬·stub·Google(기록용 대역, 127.0.0.1)이 같은 구간 바이트를 준다. Google 대역이 행과 다른 총량의 `Content-Range`를 주면 502다. `Range` 전달을 지우면(전체를 보내고 206이라 우긴다) 빨강, 총량 대조를 지우면 빨강 | C3 |
| D3 헤더 | `content_responses_keep_the_headers` | 200·206·416·HEAD가 모두 `attachment`·`nosniff`·`no-store, no-transform`·`Accept-Ranges`를 낸다. 206에서 `attachment`를 빼면 빨강(공개 보안 문장 `claims.yaml:147`의 증명) | C3 |
| D3 엣지 | `the_edge_passes_a_206_untouched`(실행 증거) | Caddy(`encode zstd gzip`)를 앞에 둔 요청에서 206의 `Content-Range`·`Content-Length`가 그대로이고 `Content-Encoding`이 없다. `no-transform`을 지우고 영상이 압축되면 빨강 | C3 |
| D4 같은 인가 | `a_stream_address_is_the_same_authorization_as_the_content_route`(실 PG) | 비멤버·나간 멤버·정지·다른 테넌트·지운 메시지(반쪽 무덤 둘)·남의 초안·`pending`·없는 id·보관된 채널의 매트릭스에서 stream이 모두 같은 404를 같은 바이트로 낸다. 술어 하나를 지우면 그 칸이 200이라 빨강 | C3b |
| D4 회수 | `a_revoked_reader_loses_the_address_at_the_next_request` | 발급 뒤 206을 받고 멤버가 채널을 떠나거나 메시지가 지워지면 **같은 주소**의 다음 요청이 만료 전에 404다. 요청마다 판정을 지우고 발급 때만 판정하면 빨강 | C3b |
| D4 다회·만료 | `the_address_serves_many_requests_within_its_ttl_and_none_after` | 같은 주소로 구간 요청 다섯 번이 성공하고 만료 1초 전은 200, 만료 뒤는 404다(시계 주입). 1회용으로 만들면 둘째가, TTL 비교를 지우면 만료 뒤가 빨강 | C3b |
| D4 위조 | `a_forged_or_foreign_address_is_refused_before_the_database` | 서명 한 바이트·다른 첨부 id·다른 채널·다른 워크스페이스 경로·다른 멤버·다른 종류로 바꾼 주소는 같은 404이고 **DB 질의가 0회**이며 per-IP 예산을 쓴다. 예산을 다 쓴 주소에서도 살아 있는 주소는 206이다. MAC이 필드 하나를 안 덮으면 그 치환이 통과해, 서명 확인을 DB 뒤로 옮기면, 게이트를 핸들러 앞으로 옮기면(살아 있는 주소가 429) 빨강 | C3b |
| D4 닫힌 목록 | `play_serves_only_the_closed_video_list` | mime이 `text/html`·`image/svg+xml`·`application/octet-stream`인 첨부(바이트는 HTML)는 `play` 발급이 거절이고 직접 서명한 토큰도 404다. `video/mp4`는 200·206이다. 목록을 와일드카드로 넓히거나 지우면 빨강 | C3b |
| D4 헤더·메서드 | `the_stream_route_has_a_fixed_header_list_and_no_redirect` | `Referrer-Policy: no-referrer`·`attachment`·`nosniff`·`no-store`가 있고 `Location`이 없으며 POST·PUT·DELETE는 405다. 헤더 하나를 지우면 빨강 | C3b |
| D4 로그 | `a_token_is_in_no_log_audit_or_error` | 성공·실패 요청 전후의 모든 로그 줄·감사 행·오류 본문에 토큰 문자열이 없다. 핸들러가 토큰이나 경로를 로그에 쓰면 빨강 | C3b |
| D4 발급 자격 | `only_a_person_mints_an_address` | push-fetch·push-action 좁은 토큰과 에이전트 bearer는 403이고 사람 bearer는 200이다. 사람 확인을 지우면 빨강 | C3b |
| D4 save | `save_forces_octet_stream_and_encodes_the_name`(구현할 때) | 이름에 CR·LF·따옴표·한글이 있어도 헤더가 깨지지 않고 `filename*`로 인코딩되며 `Content-Type`은 `application/octet-stream`이다. 인코딩을 지우면 빨강 | C7 |
| D4 공개 문장 | `check_security_claims.py`(기존 린트) | `claims.yaml`의 첨부 읽기 문장이 스트림 주소를 말하고 증명이 둘(content 401, stream 404)을 가리킨다. 문장만 고치고 증명을 안 달면 빨강 | C3b |
| D4 CSP | `desktopShellContract.test.ts` 확장, `gate-csp-deploy.mjs` | 데스크탑 `media-src`가 `'self' http: https:`이고 `blob:`이 없으며 `img-src 'self' data:`는 그대로다. 웹은 `media-src` 없이 `default-src 'self'`다. `blob:`을 더하면 빨강 | C7 |
| D4 미디어 요소 | `only_the_player_creates_media_elements`(정적) | `<video`·`<audio`·`new Audio(`가 재생기 컴포넌트 하나 밖에 없다. 다른 컴포넌트가 만들면 빨강 | C7 |
| D5 권한 | `the_media_write_is_the_uploaders_before_the_send_only` | 업로더 본인·`complete`·미묶임에서만 200이다. 남의 첨부·묶인 뒤·`pending`·영상 아닌 mime은 같은 404다. 술어 하나를 지우면 빨강 | C5 |
| D5 포스터 검증 | `a_poster_is_validated_by_its_bytes_not_its_label` | `image/jpeg`로 선언한 HTML·PNG·GIF·SVG·잘린 JPEG·256 KiB + 1 B·치수 1,281은 각각 400이고 정상 JPEG·WebP는 200이다. 매직·치수·크기 검사 하나를 지우면 그 케이스가 통과해 빨강 | C5 |
| D5 영상 확인 | `a_non_video_or_a_fake_video_cannot_hold_media` | 저장된 mime이 닫힌 목록 밖이거나 첫 바이트에 `ftyp`·EBML이 없으면 400이다. 길이 0·24시간 + 1 ms·치수 16,385도 400이다. 매직 검사나 범위 검사를 지우면 빨강 | C5 |
| D5 읽기 | `the_poster_route_is_the_content_route_for_everyone_else` | 포스터 GET이 content와 같은 인가 매트릭스를 같은 404로 내고(지운 메시지 포함) 헤더 셋이 같다. 술어를 지우면 빨강 | C5 |
| D5 페이로드 | `a_poster_is_never_in_a_payload` | 메시지 투영·`message.new` 프레임·outbox 페이로드에 `media`(길이·치수·`hasPoster`)만 있고 포스터 바이트·base64가 없으며 `PAGED_ATTACHMENT_JOIN`이 `poster_bytes`를 고르지 않는다. 포스터를 실으면 빨강 | C5 |
| D5 회수 | `media_rows_follow_the_attachment` | 첨부 행이 지워지면 `attachment_media`도 CASCADE로 사라지고 FK 전수 시험이 새 FK를 `(known)`으로 센다. CASCADE를 지우면 빨강 | C5 |
| D6 기본값 | 폰 Jest `the_default_video_choice_is_the_normal_quality` | 기본 선택이 `H264_1280x720`이고 「원본」은 `Passthrough`이며 기억되지 않아 다음 선택은 다시 기본이다. 기본을 `Passthrough`로 바꾸면 빨강 | F1 |
| D6 실기 | 위치 메타가 있는 영상을 내보내 재는 실기 확인(F1이 잰다) | 내보낸 파일에 위치 atom이 없고 크기가 줄었는지 잰다. 안 되면 문구 장부에 위치 제거 문구가 없음을 단정한다 | F1 |
| D7 회수 가지 | `a_deleted_messages_file_is_reclaimed_only_after_the_grace_and_only_when_nothing_holds_it`(실 PG) | 지운 지 29일은 후보가 아니고 31일은 후보다. 반쪽 무덤(상태만·시각만)도 같고(시각이 비면 업로드 시각 기준), huddle 세 열·아바타 두 표가 쥔 파일은 후보가 아니며, 살아 있는 메시지에 묶인 파일은 나이와 무관하게 후보가 아니다. 날짜 항·무덤 반쪽 하나·hold 하나를 지우면 각각 빨강(증보 2의 `a_file_something_else_holds_…`·`old_unbound_complete_…`의 짝) | C6 |
| D7 점검 SQL | `the_operators_check_sql_embeds_the_sweeps_predicate_word_for_word`(갱신) | 점검 SQL의 후보 술어가 새 가지까지 청소기의 것과 글자까지 같다. 한쪽만 바꾸면 빨강 | C6 |
| D7 사용량 | `usage_counts_what_the_sweep_would_count` | 이유별 합이 `SUM(size_bytes)`와 같고 두 테넌트가 섞이지 않는다. 분류 하나를 빼면 합이 어긋나 빨강 | C6 |
| D7 경고 | `the_volume_warning_fires_at_80_and_only_for_the_local_backend` | 주입한 `statvfs` 값에서 79%는 경고 없음, 80%는 한 번(반복 억제), Google 백엔드는 없음이다. 임계값을 바꾸면 빨강 | C6 |
| D7 감사 | `the_reclaim_audit_names_no_file` | `attachment.expired` + `reason: deleted_message`에 이름·Drive id가 없다. 이름을 실으면 빨강 | C6 |
| D8 순서 | `downloadsContract.test.ts`(기존) | 천장을 TS에 들이는 PR이 데스크탑 IPC 상한을 같이 올리지(청크 전송으로 바꾸지) 않으면 빨강. #4639 선행이 이 시험으로 강제된다 | C4·#4639 |

사보타주를 실제로 돌린 결과(어떤 되돌림이 어떤 시험을 빨갛게 했는지)는 각 구현 PR 본문이 정본이다. 이 증보는 문서뿐이라 시험을 돌리지 않았다(`runtime-unverified`).
